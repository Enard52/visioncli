import { execFile } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import type { TerminalContext } from "../contracts";
import { spawnCommand } from "../features/run";
import { log } from "../log";
import { environ, type Proc } from "./procs";

// Typing into a running CLI and reading its screen, through the terminal multiplexer or emulator it runs in.
// This is the Linux side of the macOS app's iTerm2 AppleScript (write text / contents of session):
//   tmux     send-keys -l, then Enter          capture-pane -p
//   kitty    kitty @ send-text                  kitty @ get-text        (needs allow_remote_control)
//   wezterm  wezterm cli send-text --no-paste   wezterm cli get-text
//   keyboard any other emulator (gnome-terminal, konsole, alacritty…): the app focuses the emulator's window and types
//            with synthetic input (like macOS typing into Terminal.app); answers still come from the transcript.

export type Delivery = TerminalContext["delivery"];

export interface Run { code: number; out: string; err: string }

/** Runs a command; never throws (a missing binary is code 127). */
export function run(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const s = spawnCommand(cmd, args, opts.env ?? process.env); // Windows: npm .cmd shims (agy, gemini)
    const child = execFile(s.file, s.args, { env: opts.env ?? process.env, timeout: opts.timeout ?? 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: s.verbatim }, (e, out, err) => {
      const c = (e as { code?: unknown } | null)?.code;
      const code = !e ? 0 : typeof c === "number" ? c : c === "ENOENT" ? 127 : 1;
      resolve({ code, out: String(out ?? ""), err: String(err ?? "") });
    });
    child.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// tmux: a pane id ("%3"). A server on another socket than the default is written "<socket>::%3".
function tmuxArgs(target: string): { pre: string[]; pane: string } {
  const i = target.lastIndexOf("::");
  return i < 0 ? { pre: [], pane: target } : { pre: ["-S", target.slice(0, i)], pane: target.slice(i + 2) };
}

/** Typing by keyboard into an emulator window (the app provides it: it needs the desktop and input modules). Every
 *  call names the CLI's pid; the implementation finds the window of the emulator it runs in. */
export interface KeyboardDelivery {
  /** Is there a window of an emulator this CLI runs in? */
  locate(pid: number): Promise<boolean>;
  /** Focus that window, then type `text` (false when it's gone). */
  type(pid: number, text: string): Promise<boolean>;
  enter(pid: number): Promise<boolean>;
  focus(pid: number): Promise<void>;
}
let keyboard: KeyboardDelivery | null = null;
export function setKeyboardDelivery(k: KeyboardDelivery | null) { keyboard = k; }
export const hasKeyboardDelivery = () => keyboard !== null;

/** kitty: "unix:/path" from KITTY_LISTEN_ON; without one, remote control only works from inside kitty (see sendKittyTty). */
const kittyTo = (socket?: string) => (socket ? ["--to", socket] : []);

/** Where `p` (a CLI on a terminal) can be typed into: its environment names the pane, else match by tty. */
export async function deliveryFor(p: Proc): Promise<Delivery> {
  const env = environ(p.pid);
  if (env.TMUX && env.TMUX_PANE) {
    const socket = env.TMUX.split(",")[0];
    return { kind: "tmux", target: socket && !socket.endsWith("/default") ? `${socket}::${env.TMUX_PANE}` : env.TMUX_PANE };
  }
  if (env.KITTY_WINDOW_ID) return { kind: "kitty", socket: env.KITTY_LISTEN_ON || undefined, id: +env.KITTY_WINDOW_ID };
  if (env.WEZTERM_PANE) return { kind: "wezterm", pane: +env.WEZTERM_PANE };
  if (!p.tty) return { kind: "none" };
  // The environment isn't readable (or was scrubbed): ask the multiplexers which pane owns this tty.
  const panes = await run("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_tty} #{session_name}:#{window_index}.#{pane_index} #{pane_id}"]);
  for (const line of panes.code === 0 ? panes.out.split("\n") : []) {
    const [, tty, , id] = line.split(" ");
    if (tty === `/dev/${p.tty}` && id) return { kind: "tmux", target: id };
  }
  const wez = await run("wezterm", ["cli", "list", "--format", "json"]);
  if (wez.code === 0) {
    try {
      for (const pane of JSON.parse(wez.out) as { pane_id: number; tty_name?: string }[]) {
        if (pane.tty_name === `/dev/${p.tty}`) return { kind: "wezterm", pane: pane.pane_id };
      }
    } catch {}
  }
  if (keyboard && (await keyboard.locate(p.pid).catch(() => false))) return { kind: "keyboard", pid: p.pid };
  return { kind: "none" };
}

/** Why a CLI can't be typed into, for the log and the bubble. */
export const undeliverableReason = process.platform === "win32"
  ? "VisionCLI can't find the terminal window it runs in. Run it in Windows Terminal, WezTerm or a console window"
  : "it runs in a terminal VisionCLI can't type into. Run it inside tmux, or in kitty (allow_remote_control yes, listen_on unix:…) or WezTerm";

/** Types `text` (no newline) into the pane; false when the pane is gone. */
export async function typeText(d: Delivery, text: string, tty?: string): Promise<boolean> {
  switch (d.kind) {
    case "tmux": {
      const { pre, pane } = tmuxArgs(d.target);
      return (await run("tmux", [...pre, "send-keys", "-t", pane, "-l", "--", text])).code === 0;
    }
    case "kitty":
      if (!d.socket && tty) return sendKittyTty(tty, d.id, text);
      // --stdin: sent as is (the argument form interprets backslash escapes).
      return (await run("kitty", ["@", ...kittyTo(d.socket), "send-text", "--match", `id:${d.id}`, "--stdin"], { input: text })).code === 0;
    case "wezterm":
      return (await run("wezterm", ["cli", "send-text", "--pane-id", String(d.pane), "--no-paste"], { input: text })).code === 0;
    case "keyboard":
      return !!keyboard && (await keyboard.type(d.pid, text).catch(() => false));
    default:
      return false;
  }
}

/** Presses Return: claude's input needs a real carriage return to submit. */
export async function pressEnter(d: Delivery, tty?: string): Promise<boolean> {
  if (d.kind === "tmux") {
    const { pre, pane } = tmuxArgs(d.target);
    return (await run("tmux", [...pre, "send-keys", "-t", pane, "Enter"])).code === 0;
  }
  if (d.kind === "keyboard") return !!keyboard && (await keyboard.enter(d.pid).catch(() => false));
  return typeText(d, "\r", tty);
}

/** Type a line, then press Return (as the iTerm script: write text, delay 0.15, carriage return). */
export async function sendLine(d: Delivery, line: string, tty?: string): Promise<boolean> {
  if (!(await typeText(d, line, tty))) return false;
  await sleep(150);
  return pressEnter(d, tty);
}

/** The visible screen of the pane ("" if it can't be read). */
export async function screenText(d: Delivery): Promise<string> {
  let r: Run | null = null;
  if (d.kind === "tmux") {
    const { pre, pane } = tmuxArgs(d.target);
    r = await run("tmux", [...pre, "capture-pane", "-p", "-t", pane]);
  } else if (d.kind === "kitty" && d.socket) {
    r = await run("kitty", ["@", ...kittyTo(d.socket), "get-text", "--match", `id:${d.id}`]);
  } else if (d.kind === "wezterm") {
    r = await run("wezterm", ["cli", "get-text", "--pane-id", String(d.pane)]);
  }
  return r && r.code === 0 ? r.out : "";
}

/** Does the pane still exist? */
export async function alive(d: Delivery): Promise<boolean> {
  if (d.kind === "tmux") {
    const { pre, pane } = tmuxArgs(d.target);
    return (await run("tmux", [...pre, "display-message", "-p", "-t", pane, "#{pane_id}"])).code === 0;
  }
  if (d.kind === "kitty" && d.socket) {
    const r = await run("kitty", ["@", ...kittyTo(d.socket), "ls", "--match", `id:${d.id}`]);
    return r.code === 0;
  }
  if (d.kind === "wezterm") {
    const r = await run("wezterm", ["cli", "list", "--format", "json"]);
    try { return r.code === 0 && (JSON.parse(r.out) as { pane_id: number }[]).some((p) => p.pane_id === d.pane); } catch { return false; }
  }
  if (d.kind === "keyboard") return !!keyboard && (await keyboard.locate(d.pid).catch(() => false));
  return d.kind === "kitty"; // kitty without a socket: can't tell; sending will
}

/** Brings the pane to the front inside its multiplexer (selecting the window/tab). Raising the emulator's own window
 *  is the desktop module's job. */
export async function selectPane(d: Delivery): Promise<void> {
  if (d.kind === "tmux") {
    const { pre, pane } = tmuxArgs(d.target);
    await run("tmux", [...pre, "select-window", "-t", pane]);
    await run("tmux", [...pre, "select-pane", "-t", pane]);
  } else if (d.kind === "kitty" && d.socket) {
    await run("kitty", ["@", ...kittyTo(d.socket), "focus-window", "--match", `id:${d.id}`]);
  } else if (d.kind === "wezterm") {
    await run("wezterm", ["cli", "activate-pane", "--pane-id", String(d.pane)]);
  } else if (d.kind === "keyboard") {
    await keyboard?.focus(d.pid).catch(() => {});
  }
}

/** kitty with remote control on but no listen_on socket: `kitty @` only works through the window's own tty. Writing
 *  the remote-control escape sequence to the pty makes kitty run it (no_response, so nothing is echoed back into the
 *  CLI's input). Needs allow_remote_control yes in kitty.conf. */
export function sendKittyTty(tty: string, windowId: number, text: string): boolean {
  const cmd = { cmd: "send-text", version: [0, 26, 0], no_response: true, payload: { match: `id:${windowId}`, data: `base64:${Buffer.from(text).toString("base64")}` } };
  try {
    const fd = openSync(`/dev/${tty}`, "w");
    writeSync(fd, `\x1bP@kitty-cmd${JSON.stringify(cmd)}\x1b\\`);
    closeSync(fd);
    return true;
  } catch (e) {
    log(`terminal: kitty tty send failed: ${e}`);
    return false;
  }
}

/** Is tmux installed? (Cached: checked when opening a terminal.) */
let tmuxOk: boolean | null = null;
export async function hasTmux(): Promise<boolean> {
  if (tmuxOk === null) tmuxOk = (await run("tmux", ["-V"])).code === 0;
  return tmuxOk;
}
