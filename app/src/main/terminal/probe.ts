import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { TerminalContext } from "../contracts";
import { log } from "../log";
import { deliveryFor, run } from "./mux";
import { basename, descendants, environ, listProcs, workingDirectory, type Proc } from "./procs";
import { CLIS, gitRoot, isHeadless, matches, newestSession, sessionMtime, type Cli } from "./transcripts";
import { winFind, winProbeTerminals, winProbeWindow, winRunningProjects } from "./win";

// Which CLI runs where (TerminalProbe.swift): the terminal the user points at, and the CLI they already run for a
// project. Processes come from /proc; panes from the environment (TMUX_PANE, KITTY_WINDOW_ID, WEZTERM_PANE) or from
// tmux/kitty/wezterm themselves. Windows: win.ts (the helper's process list, WezTerm or keyboard delivery).

const isWindows = () => process.platform === "win32";

/** The terminal under the pointer: its folder, and the CLI running there if any. */
export interface PointedTerminal {
  project: string;               // git root of cwd
  cwd: string;
  context: TerminalContext | null;
}

/** CLIs in terminals (with a tty), not VisionCLI's own headless runs. */
function cliProcs(procs: Proc[], cli?: Cli): { p: Proc; cli: Cli }[] {
  const out: { p: Proc; cli: Cli }[] = [];
  for (const p of procs) {
    if (!p.tty || isHeadless(p.args)) continue;
    const c = (cli ? [cli] : CLIS).find((c) => matches(c, p.args));
    if (c) out.push({ p, cli: c });
  }
  return out;
}

async function contextFor(p: Proc, cli: Cli, cwd: string): Promise<TerminalContext> {
  return { assistant: cli, pid: p.pid, cwd, tty: p.tty ?? undefined, sessionId: newestSession(cli, cwd), delivery: await deliveryFor(p) };
}

// MARK: Recent finds

/** find() reads /proc and may ask tmux/wezterm; one question used to run it two or three times (key-down, then
 *  sending). Panes found in the last few seconds are reused; one that has closed since shows up as a failed send,
 *  and the caller then calls forget() and looks again. Only found panes are remembered. */
const cache = new Map<string, { context: TerminalContext; at: number }>();
const TTL = 6000;
const key = (cli: Cli, project: string) => `${cli}:${project}`;

export function recent(cli: Cli, project: string): TerminalContext | null {
  const hit = cache.get(key(cli, project));
  return hit && Date.now() - hit.at < TTL ? hit.context : null;
}

export function forget(cli: Cli, project: string) { cache.delete(key(cli, project)); }

/** A CLI the user already runs for this project in a terminal VisionCLI can type into. The most recently active wins.
 *  Always looks afresh (and remembers what it found for recent()). */
export async function find(cli: Cli, project: string): Promise<TerminalContext | null> {
  const found = await scan(cli, project);
  if (found) cache.set(key(cli, project), { context: found, at: Date.now() }); else cache.delete(key(cli, project));
  return found;
}

async function scan(cli: Cli, project: string): Promise<TerminalContext | null> {
  if (isWindows()) return winFind(cli, project);
  const candidates: { c: TerminalContext; active: number }[] = [];
  for (const { p } of cliProcs(listProcs(), cli)) {
    const cwd = workingDirectory(p.pid);
    if (!cwd || !(gitRoot(cwd) === project || cwd === project || cwd.startsWith(project + "/"))) continue;
    const c = await contextFor(p, cli, cwd);
    if (c.delivery.kind === "none") { log(`terminal probe: ${cli} (pid ${p.pid}) in ${cwd} skipped: can't type into ${p.tty}`); continue; }
    candidates.push({ c, active: sessionMtime(cli, cwd, c.sessionId) });
  }
  candidates.sort((a, b) => b.active - a.active);
  return candidates[0]?.c ?? null;
}

/** Every CLI running in a terminal, with how to type into it. */
export async function probeTerminals(): Promise<TerminalContext[]> {
  if (isWindows()) return winProbeTerminals();
  const out: TerminalContext[] = [];
  for (const { p, cli } of cliProcs(listProcs())) {
    const cwd = workingDirectory(p.pid);
    if (cwd) out.push(await contextFor(p, cli, cwd));
  }
  return out;
}

/** Project folders with an interactive CLI running in some terminal (no multiplexer queries). */
export function runningProjects(): { project: string; assistant: Cli }[] {
  if (isWindows()) return winRunningProjects();
  const out: { project: string; assistant: Cli }[] = [];
  for (const { p, cli } of cliProcs(listProcs())) {
    const cwd = workingDirectory(p.pid);
    if (!cwd || cwd === homedir()) continue;
    const root = gitRoot(cwd);
    if (!out.some((o) => o.project === root && o.assistant === cli)) out.push({ project: root, assistant: cli });
  }
  return out;
}

// MARK: The terminal under the pointer

/** Probe the terminal window owned by `emulatorPid` (the window under the pointer): which of its tabs is in front,
 *  and what runs there. Prefers a CLI on that tty, else its foreground process. */
export async function probeWindow(emulatorPid: number): Promise<PointedTerminal | null> {
  if (isWindows()) return winProbeWindow(emulatorPid);
  const procs = listProcs();
  const below = descendants(emulatorPid, procs).filter((p) => p.tty);
  if (!below.length) return null;
  const tty = await focusedTty(below);
  if (!tty) return null;
  return probeTty(tty, procs);
}

/** What runs on one terminal (`pts/3`). */
export async function probeTty(tty: string, procs: Proc[] = listProcs()): Promise<PointedTerminal | null> {
  const on = procs.filter((p) => p.tty === tty);
  let found: { p: Proc; cli: Cli } | undefined;
  for (const cli of CLIS) {
    const p = on.filter((p) => !isHeadless(p.args) && matches(cli, p.args)).pop();
    if (p) { found = { p, cli }; break; }
  }
  const pick = found?.p ?? on.filter((p) => p.pgrp === p.tpgid).pop() ?? on[on.length - 1];
  const cwd = pick ? workingDirectory(pick.pid) : null;
  if (!pick || !cwd || cwd === homedir()) return null;
  return { project: gitRoot(cwd), cwd, context: found ? await contextFor(found.p, found.cli, cwd) : null };
}

/** The tty of the emulator's front tab. Asks kitty / wezterm / tmux where they can tell; otherwise the tty with the
 *  latest activity (the kernel stamps a pty when it's read or written), which is the tab being typed in or watched. */
async function focusedTty(below: Proc[]): Promise<string | null> {
  let tty: string | null = null;

  const kittySocket = below.map((p) => environ(p.pid).KITTY_LISTEN_ON).find(Boolean);
  if (kittySocket) {
    const r = await run("kitty", ["@", "--to", kittySocket, "ls"]);
    try {
      type W = { id: number; is_focused: boolean };
      const osw = (JSON.parse(r.out) as { is_focused: boolean; tabs: { is_focused: boolean; windows: W[] }[] }[]);
      const win = (osw.find((o) => o.is_focused) ?? osw[0])?.tabs.find((t) => t.is_focused)?.windows.find((w) => w.is_focused);
      if (win) tty = below.find((p) => environ(p.pid).KITTY_WINDOW_ID === String(win.id))?.tty ?? null;
    } catch {}
  }
  if (!tty && below.some((p) => environ(p.pid).WEZTERM_PANE)) {
    const r = await run("wezterm", ["cli", "list-clients", "--format", "json"]);
    try {
      const focused = (JSON.parse(r.out) as { focused_pane_id?: number }[]).map((c) => c.focused_pane_id).find((id) => id !== undefined);
      if (focused !== undefined) tty = below.find((p) => environ(p.pid).WEZTERM_PANE === String(focused))?.tty ?? null;
    } catch {}
  }
  if (!tty) {
    const ttys = [...new Set(below.map((p) => p.tty!))];
    const stamp = (t: string) => { try { const s = statSync(`/dev/${t}`); return Math.max(s.atimeMs, s.mtimeMs); } catch { return 0; } };
    tty = ttys.sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
  }
  // A tmux client in that tab: follow it to the active pane of the session it shows.
  const client = below.find((p) => p.tty === tty && basename(p.args[0] ?? "") === "tmux");
  if (tty && client) {
    const clients = await run("tmux", ["list-clients", "-F", "#{client_tty} #{session_name}"]);
    const session = clients.out.split("\n").map((l) => l.split(" ")).find(([t]) => t === `/dev/${tty}`)?.[1];
    if (session) {
      const pane = await run("tmux", ["display-message", "-p", "-t", session, "#{pane_tty}"]);
      if (pane.code === 0 && pane.out.trim().startsWith("/dev/")) tty = pane.out.trim().slice(5);
    }
  }
  return tty;
}
