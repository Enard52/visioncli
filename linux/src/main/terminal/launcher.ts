import { spawn } from "node:child_process";
import { accessSync, constants, chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log";
import { CACHE } from "../paths";
import { ACTIVITY_LOG } from "./activity";
import { basename } from "./procs";

// Opens commands in the user's terminal emulator (Activity.swift TerminalLauncher). macOS opens iTerm2 or Terminal;
// Linux has many, so the first installed of the usual ones wins.

/** How each emulator is told to run one program (no arguments: everything goes through a script). */
const ARGV: Record<string, (script: string) => string[]> = {
  "gnome-terminal": (s) => ["--", s],
  "gnome-terminal.wrapper": (s) => ["-e", s],
  "ptyxis": (s) => ["--", s],
  "kgx": (s) => ["-e", s],
  "konsole": (s) => ["-e", s],
  "kitty": (s) => [s],
  "wezterm": (s) => ["start", "--", s],
  "alacritty": (s) => ["-e", s],
  "foot": (s) => [s],
  "footclient": (s) => [s],
  "xterm": (s) => ["-e", s],
  "uxterm": (s) => ["-e", s],
  "xfce4-terminal": (s) => ["-x", s],
  "terminator": (s) => ["-x", s],
  "tilix": (s) => ["-e", s],
  "lxterminal": (s) => ["-e", s],
  "mate-terminal": (s) => ["-x", s],
  "urxvt": (s) => ["-e", s],
  "st": (s) => ["-e", s],
  "ghostty": (s) => ["-e", s],
};
const ORDER = ["gnome-terminal", "konsole", "kitty", "wezterm", "alacritty", "foot", "xterm", "ptyxis", "kgx", "xfce4-terminal", "tilix", "terminator", "mate-terminal", "lxterminal", "ghostty", "urxvt", "st"];

let searchPath = process.env.PATH ?? "/usr/bin:/bin";
/** The PATH to look for terminals (and the CLIs) in; the app sets its full one. */
export function setSearchPath(path: string) { searchPath = path; }

export function which(name: string, path = searchPath): string | null {
  if (name.includes("/")) { try { accessSync(name, constants.X_OK); return name; } catch { return null; } }
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch {}
  }
  return null;
}

/** Installed terminal emulators, preferred first: x-terminal-emulator (Debian's choice), $TERMINAL, then the usual ones. */
export function emulators(): { name: string; bin: string; argv: (s: string) => string[] }[] {
  const out: { name: string; bin: string; argv: (s: string) => string[] }[] = [];
  const add = (bin: string | null, as?: string) => {
    if (!bin || out.some((e) => e.bin === bin)) return;
    let real = bin;
    try { real = realpathSync(bin); } catch {}
    const name = as ?? basename(real);
    out.push({ name, bin, argv: ARGV[name] ?? ARGV[basename(bin)] ?? ((s) => ["-e", s]) });
  };
  add(which("x-terminal-emulator"));
  if (process.env.TERMINAL) add(which(process.env.TERMINAL.split(" ")[0]));
  for (const n of ORDER) add(which(n), n);
  return out;
}

export const hasDisplay = () => !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** Opens a terminal window running `script` (an executable file). Tries the next emulator when one fails right away. */
export async function openTerminal(script: string, extraArgs: Partial<Record<string, string[]>> = {}): Promise<{ ok: boolean; emulator?: string; problem?: string }> {
  if (!hasDisplay()) return { ok: false, problem: "no graphical session (DISPLAY / WAYLAND_DISPLAY unset)" };
  const list = emulators();
  if (!list.length) return { ok: false, problem: "no terminal emulator found (install one, or set $TERMINAL)" };
  for (const e of list) {
    const args = [...(extraArgs[e.name] ?? []), ...e.argv(script)];
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const child = spawn(e.bin, args, { detached: true, stdio: "ignore", env: { ...process.env, PATH: searchPath } });
        child.on("error", () => done(false));
        child.on("exit", (code) => done(code === 0)); // gnome-terminal hands off to its server and exits 0
        child.unref();
        setTimeout(() => done(true), 600);
      } catch {
        done(false);
      }
    });
    if (ok) { log(`terminal: opened ${e.name} running ${script}`); return { ok: true, emulator: e.name }; }
    log(`terminal: ${e.name} failed to open`);
  }
  return { ok: false, problem: "no terminal emulator could be opened" };
}

export const shellQuote = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";

/** Writes CACHE/<name>.sh and returns its path. */
export function writeScript(name: string, body: string): string {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${name}.sh`);
  writeFileSync(file, "#!/bin/sh\n" + body + "\n");
  chmodSync(file, 0o755);
  return file;
}

export const TerminalLauncher = {
  run(script: string, name: string) {
    return openTerminal(writeScript(name, `export PATH=${shellQuote(searchPath)}\n${script}`));
  },

  /** "Show live activity". */
  showActivity() {
    const path = shellQuote(ACTIVITY_LOG);
    return TerminalLauncher.run([
      `printf '\\033]0;visioncli activity\\007'`,
      "clear",
      `printf '\\033[1mvisioncli voice activity\\033[0m: questions, tool calls, commands and answers appear here live (Ctrl+C to close).\\n'`,
      `touch ${path}`,
      `tail -n 120 -F ${path}`,
    ].join("\n"), "activity");
  },

  /** "Continue in terminal": a copy of the bubble's Claude conversation, so voice mode keeps its own. */
  continueSession(project: string, sessionId: string, claude: string) {
    return TerminalLauncher.run([
      `printf '\\033]0;visioncli → claude\\007'`,
      `cd ${shellQuote(project)}`,
      `printf '\\033[2mContinuing your voice conversation (as a copy, so voice mode keeps its own).\\033[0m\\n'`,
      `exec ${shellQuote(claude)} --resume ${sessionId} --fork-session`,
    ].join("\n"), "continue");
  },
};
