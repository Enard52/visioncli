import { homedir } from "node:os";
import { win32 } from "node:path";
import type { Desktop, DesktopWindow, InputInjector, TerminalContext } from "../contracts";
import { log } from "../log";
import type { Methods } from "../platform/win32/protocol";
import type { KeyboardDelivery } from "./mux";
import { run, type Delivery } from "./mux";
import { CLIS, gitRoot, isHeadless, newestSession, parseWslPath, sessionMtime, wslUncPath, type Cli } from "./transcripts";

// Terminal mode on Windows (the /proc half of probe.ts and mux.ts). Windows has no ttys and no way to read another
// process's environment, so:
//   - processes (pid, ppid, exe, command line, cwd) come from the helper's `processes` method;
//   - a CLI's terminal is the window of its nearest ancestor that owns one: WindowsTerminal.exe, wezterm-gui.exe,
//     alacritty.exe, or a classic console (whose window Windows reports as owned by the shell in it);
//   - typing goes through WezTerm's `wezterm cli send-text` when the CLI runs in WezTerm, otherwise through the
//     keyboard (focus that window, type, Enter). Windows Terminal has no API to send text to a tab.
// Limits: with several tabs in one Windows Terminal window, the tab in front gets the text (as with Linux's keyboard
// delivery), and the tab under the pointer is a guess (the CLI with the latest transcript activity).

export type WinProc = Methods["processes"]["result"][number];

/** The helper's process list (injected by the app: helper.call("processes", {})). */
export type WinProcessSource = () => Promise<WinProc[]>;
let source: WinProcessSource | null = null;
export function setWinProcessSource(s: WinProcessSource | null) { source = s; }

/** Convenience for the app: the helper client from platform/win32/helper.ts. */
export function useWinHelper(helper: { call(method: "processes", params: Methods["processes"]["params"]): Promise<WinProc[]> }) {
  setWinProcessSource(() => helper.call("processes", {}));
}

export async function winProcs(): Promise<WinProc[]> {
  if (!source) return [];
  try { return (await source()).map(normalizeProc); } catch (e) { log(`terminal: process list failed: ${e}`); return []; }
}

/** The PEB's current directory ends in a backslash ("C:\proj\"); everything else here compares paths without it. */
export const trimDir = (p: string) => (/^[A-Za-z]:\\$/.test(p) ? p : p.replace(/[\\/]+$/, "")) || p;
const normalizeProc = (p: WinProc): WinProc => ({ ...p, cwd: p.cwd ? trimDir(p.cwd) : p.cwd });

// MARK: Command lines

/** A Windows command line → argv, by CommandLineToArgvW's rules (the program name ends at the next space outside
 *  quotes; then 2n backslashes + " → n backslashes and a quote toggle, 2n+1 → n and a literal ", "" inside quotes → "). */
export function splitCommandLine(cmdline: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = cmdline;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return out;
  // argv[0]: no escapes
  let a0 = "", q = false;
  for (; i < s.length && (q || !/\s/.test(s[i])); i++) { if (s[i] === '"') q = !q; else a0 += s[i]; }
  out.push(a0);
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let arg = "", quoted = false;
    while (i < s.length && (quoted || !/\s/.test(s[i]))) {
      if (s[i] === "\\") {
        let n = 0;
        while (s[i] === "\\") { n++; i++; }
        if (s[i] === '"') {
          arg += "\\".repeat(Math.floor(n / 2));
          if (n % 2) { arg += '"'; i++; }
        } else {
          arg += "\\".repeat(n);
        }
      } else if (s[i] === '"') {
        if (quoted && s[i + 1] === '"') { arg += '"'; i += 2; continue; }
        quoted = !quoted;
        i++;
      } else {
        arg += s[i++];
      }
    }
    out.push(arg);
  }
  return out;
}

/** "C:\Program Files\nodejs\node.exe" → "node". */
export const exeName = (p: string) => win32.basename(p.replace(/\//g, "\\")).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1|js|mjs|cjs)$/, "");

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "pythonw", "py"]);

/** Where the npm packages put each CLI's entry script (npm shims run `node <that script>`). */
const PACKAGES: Record<Cli, RegExp> = {
  claude: /[\\/]@anthropic-ai[\\/]claude-code[\\/]/i,
  gemini: /[\\/]@google[\\/]gemini-cli[\\/]/i,
  agy: /[\\/](@google[\\/])?antigravity(-cli)?[\\/]/i,
};

/** Is this Windows command line one of this CLI's processes? claude.exe, `node …\@anthropic-ai\claude-code\cli.js`,
 *  `node …\gemini.js`, agy.exe… */
export function matchesWin(cli: Cli, args: string[]): boolean {
  const first = args[0] ? exeName(args[0]) : "";
  if (!first) return false;
  if (first === cli) return true;
  if (!INTERPRETERS.has(first)) return false;
  const script = args.slice(1).find((a) => !a.startsWith("-"));
  return !!script && (exeName(script) === cli || PACKAGES[cli].test(script));
}

// MARK: WSL

/** A `wsl.exe` running claude: which distro and which Linux folder (null when the command isn't claude). The folder
 *  is from --cd, else wsl.exe's own folder (\\wsl.localhost\<distro>\… or a Windows folder under /mnt), or null when
 *  it starts in the Linux home (~), which can't be seen from here. */
export function wslClaude(args: string[], cwd: string | null): { distro: string | null; linux: string | null } | null {
  if (exeName(args[0] ?? "") !== "wsl") return null;
  let distro: string | null = null, cd: string | null = null, home = false;
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-d" || a === "--distribution") distro = args[++i] ?? null;
    else if (a === "-u" || a === "--user") i++;
    else if (a === "--cd") cd = args[++i] ?? null;
    else if (a === "~") home = true;
    else if (a === "-e" || a === "--exec" || a === "--") { i++; break; }
    else if (a.startsWith("-")) continue;
    else break;
  }
  const command = args.slice(i);
  // `wsl claude …`, `wsl -e claude`, `wsl -- bash -lc "claude --resume …"`
  const words = command.flatMap((c) => c.split(/\s+/)).filter(Boolean);
  const runsClaude = words.some((w) => w === "claude" || w.endsWith("/claude"));
  if (!runsClaude || isHeadless(words)) return null;
  let linux: string | null = null;
  const fromWindows = (p: string): string | null => {
    const unc = parseWslPath(p);
    if (unc) { distro ??= unc.distro; return unc.linux; }
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`.replace(/\/+$/, "") : null;
  };
  if (cd) linux = cd === "~" ? null : cd.startsWith("/") ? cd.replace(/\/+$/, "") || "/" : fromWindows(cd);
  else if (!home && cwd) linux = fromWindows(cwd);
  return { distro, linux };
}

/** `wsl.exe -l -v` (UTF-16LE text): the distro marked with "*" is the default. */
export function parseWslList(text: string): { name: string; isDefault: boolean }[] {
  const out: { name: string; isDefault: boolean }[] = [];
  for (const raw of text.replace(/\0/g, "").split(/\r?\n/).slice(1)) {
    const m = /^\s*(\*)?\s*(\S+)\s+\S+\s+\d+\s*$/.exec(raw);
    if (m) out.push({ name: m[2], isDefault: !!m[1] });
  }
  return out;
}

let defaultDistro: string | null | undefined;
async function wslDefault(runner = run): Promise<string | null> {
  if (defaultDistro !== undefined) return defaultDistro;
  const r = await runner("wsl.exe", ["-l", "-v"], { timeout: 5000 });
  const list = parseWslList(r.out);
  defaultDistro = (list.find((d) => d.isDefault) ?? list[0])?.name ?? null;
  return defaultDistro;
}
/** Tests: forget (or set) the default distro. */
export function setWslDefault(name: string | null | undefined) { defaultDistro = name; }

// MARK: Finding CLIs

export interface WinCli { p: WinProc; cli: Cli; cwd: string; wsl: boolean }

/** CLIs the user runs (not VisionCLI's headless runs, not a CLI's own child processes), with the folder each runs in.
 *  A claude inside WSL gets its Linux folder as a \\wsl.localhost\… path (see transcripts.ts). */
export async function winCliProcs(procs: WinProc[], cli?: Cli, runner = run): Promise<WinCli[]> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: WinCli[] = [];
  for (const p of procs) {
    const args = splitCommandLine(p.cmdline || `"${p.exe}"`);
    if (isHeadless(args)) continue;
    const c = (cli ? [cli] : CLIS).find((c) => matchesWin(c, args));
    if (c) {
      const parent = byPid.get(p.ppid);
      if (parent && matchesWin(c, splitCommandLine(parent.cmdline || `"${parent.exe}"`))) continue; // a helper process of the CLI
      if (p.cwd) out.push({ p, cli: c, cwd: p.cwd, wsl: false });
      continue;
    }
    if (cli && cli !== "claude") continue;
    const w = wslClaude(args, p.cwd);
    if (!w?.linux) continue;
    const distro = w.distro ?? (await wslDefault(runner));
    if (distro) out.push({ p, cli: "claude", cwd: wslUncPath(distro, w.linux), wsl: true });
  }
  return out;
}

const normPath = (s: string) => trimDir(s.replace(/\//g, "\\")).toLowerCase();
export const samePath = (a: string, b: string) => normPath(a) === normPath(b);

/** Same folder (or inside it), as Windows compares paths: case-insensitive, either slash. */
export function underProject(cwd: string, project: string): boolean {
  const c = normPath(cwd), p = normPath(project);
  return c === p || c.startsWith(p.endsWith("\\") ? p : p + "\\");
}

// MARK: The terminal a CLI runs in

/** Processes that own terminal windows. */
export const TERMINAL_HOSTS = new Set(["windowsterminal", "openconsole", "conhost", "wezterm-gui", "alacritty", "mintty", "conemu64", "conemu"]);

/** The pid's chain of ancestors, nearest first (from a snapshot). */
export function winAncestors(pid: number, byPid: Map<number, WinProc>): WinProc[] {
  const out: WinProc[] = [];
  const seen = new Set<number>();
  for (let p = byPid.get(pid); p && !seen.has(p.pid) && out.length < 64; p = byPid.get(p.ppid)) {
    seen.add(p.pid);
    out.push(p);
  }
  return out;
}

/** The terminal program a process runs in: an ancestor host (Windows Terminal, WezTerm, Alacritty…), else the
 *  console host attached to its console (conhost.exe is a child of the first process in the console). */
export function terminalHost(pid: number, procs: WinProc[]): { host: WinProc | null; kind: "wt" | "wezterm" | "console" | "other" | null; chain: WinProc[] } {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = winAncestors(pid, byPid);
  const kindOf = (p: WinProc) => {
    const n = exeName(p.exe);
    return n === "windowsterminal" ? "wt" : n === "wezterm-gui" ? "wezterm" : n === "conhost" || n === "openconsole" ? "console" : "other";
  };
  const host = chain.find((p) => TERMINAL_HOSTS.has(exeName(p.exe)));
  if (host) return { host, kind: kindOf(host), chain };
  const pids = new Set(chain.map((p) => p.pid));
  const con = procs.find((p) => pids.has(p.ppid) && (exeName(p.exe) === "conhost" || exeName(p.exe) === "openconsole"));
  return { host: con ?? null, kind: con ? "console" : null, chain };
}

/** The window of the terminal `pid` runs in: one owned by the nearest ancestor (a classic console's window is
 *  reported as owned by the shell in it). With Windows Terminal as the default terminal, a console app started from
 *  elsewhere is handed to an existing Windows Terminal process; then its only window, if there's just one. */
export function terminalWindow(windows: DesktopWindow[], pid: number, procs: WinProc[]): DesktopWindow | null {
  const { chain, host } = terminalHost(pid, procs);
  // A console host's window may also be reported as conhost's own.
  for (const p of host && !chain.includes(host) ? [...chain, host] : chain) {
    const w = windows.find((x) => x.pid === p.pid);
    if (w) return w;
  }
  if (!chain.length) return null; // the process is gone
  const wt = windows.filter((w) => exeName(w.appId) === "windowsterminal" || exeName(w.app) === "windowsterminal");
  return wt.length === 1 ? wt[0] : null;
}

// MARK: Delivery

let keyboard: KeyboardDelivery | null = null;
/** The keyboard delivery Windows uses (also passed to setKeyboardDelivery). */
export function setWinKeyboard(k: KeyboardDelivery | null) { keyboard = k; }

/** WezTerm's panes (`wezterm cli list`): on Windows there's no tty or pid, so a CLI's pane is the one in its folder. */
export function weztermPaneFor(listJson: string, cwd: string): number | null {
  let panes: { pane_id: number; cwd?: string }[];
  try { panes = JSON.parse(listJson); } catch { return null; }
  const norm = (u: string) => {
    let p = u;
    try { if (p.startsWith("file://")) p = decodeURIComponent(new URL(p).pathname); } catch {}
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return trimDir(p.replace(/\//g, "\\")).toLowerCase();
  };
  const hits = panes.filter((p) => typeof p.cwd === "string" && norm(p.cwd) === norm(cwd));
  return hits.length === 1 ? hits[0].pane_id : null;
}

/** How to type into a CLI on Windows. */
export async function winDeliveryFor(c: WinCli, procs: WinProc[], runner = run): Promise<Delivery> {
  const { kind } = terminalHost(c.p.pid, procs);
  if (kind === "wezterm" && !c.wsl) {
    const r = await runner("wezterm", ["cli", "list", "--format", "json"]);
    const pane = r.code === 0 ? weztermPaneFor(r.out, c.cwd) : null;
    if (pane != null) return { kind: "wezterm", pane };
  }
  if (keyboard && (await keyboard.locate(c.p.pid).catch(() => false))) return { kind: "keyboard", pid: c.p.pid };
  return { kind: "none" };
}

async function contextFor(c: WinCli, procs: WinProc[]): Promise<TerminalContext> {
  return { assistant: c.cli, pid: c.p.pid, cwd: c.cwd, sessionId: newestSession(c.cli, c.cwd), delivery: await winDeliveryFor(c, procs) };
}

// MARK: The probe.ts functions, for Windows

/** A CLI the user already runs for this project that VisionCLI can type into; the most recently active wins. */
export async function winFind(cli: Cli, project: string): Promise<TerminalContext | null> {
  const procs = await winProcs();
  const candidates: { c: TerminalContext; active: number }[] = [];
  for (const w of await winCliProcs(procs, cli)) {
    if (!(underProject(w.cwd, project) || underProject(gitRoot(w.cwd), project))) continue;
    const c = await contextFor(w, procs);
    if (c.delivery.kind === "none") { log(`terminal probe: ${cli} (pid ${w.p.pid}) in ${w.cwd} skipped: no window to type into`); continue; }
    candidates.push({ c, active: sessionMtime(cli, w.cwd, c.sessionId) });
  }
  candidates.sort((a, b) => b.active - a.active);
  return candidates[0]?.c ?? null;
}

export async function winProbeTerminals(): Promise<TerminalContext[]> {
  const procs = await winProcs();
  const out: TerminalContext[] = [];
  for (const w of await winCliProcs(procs)) out.push(await contextFor(w, procs));
  return out;
}

/** runningProjects() is synchronous (the menu builds from it): on Windows it returns the last snapshot and refreshes
 *  it in the background. */
let running: { project: string; assistant: Cli }[] = [];
let refreshing = false;
export function winRunningProjects(): { project: string; assistant: Cli }[] {
  if (!refreshing) {
    refreshing = true;
    void (async () => {
      const out: { project: string; assistant: Cli }[] = [];
      for (const w of await winCliProcs(await winProcs())) {
        if (samePath(w.cwd, homedir())) continue;
        const root = gitRoot(w.cwd);
        if (!out.some((o) => o.project === root && o.assistant === w.cli)) out.push({ project: root, assistant: w.cli });
      }
      running = out;
    })().catch(() => {}).finally(() => { refreshing = false; });
  }
  return running;
}

/** The terminal window owned by `emulatorPid` (under the pointer): the CLI running in it (the most recently active
 *  one when it has several tabs), else the folder of its newest shell. */
export async function winProbeWindow(emulatorPid: number): Promise<{ project: string; cwd: string; context: TerminalContext | null } | null> {
  const procs = await winProcs();
  const below = new Set<number>([emulatorPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (!below.has(p.pid) && below.has(p.ppid)) { below.add(p.pid); grew = true; }
  }
  const clis = (await winCliProcs(procs.filter((p) => below.has(p.pid)))).map((w) => ({ w, active: sessionMtime(w.cli, w.cwd, newestSession(w.cli, w.cwd)) }));
  clis.sort((a, b) => b.active - a.active);
  const hit = clis[0]?.w;
  if (hit) return { project: gitRoot(hit.cwd), cwd: hit.cwd, context: await contextFor(hit, procs) };
  const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "nu", "fish", "zsh"]);
  const shell = procs.filter((p) => below.has(p.pid) && SHELLS.has(exeName(p.exe)) && p.cwd && !samePath(p.cwd, homedir())).pop();
  if (!shell?.cwd) return null;
  return { project: gitRoot(shell.cwd), cwd: shell.cwd, context: null };
}

// MARK: Keyboard delivery

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Typing into a CLI's terminal window by keyboard (focus it, then InputInjector.type + Enter): the app's
 *  app/keyboard.ts for Windows, with the window found through the helper's process list. */
export function createWinKeyboardDelivery(desktop: Desktop, input: () => Promise<InputInjector>, procs: () => Promise<WinProc[]> = winProcs): KeyboardDelivery {
  const windowOf = async (pid: number) => terminalWindow(await desktop.windows().catch(() => []), pid, await procs());

  async function focus(pid: number): Promise<DesktopWindow | null> {
    const w = await windowOf(pid);
    if (!w) return null;
    const front = await desktop.activeWindow().catch(() => null);
    if (front?.id === w.id) return w;
    await desktop.focus(w).catch((e) => log(`terminal: can't focus ${w.app}: ${e}`));
    for (let i = 0; i < 20 && (await desktop.activeWindow().catch(() => null))?.id !== w.id; i++) await sleep(50);
    await sleep(120);
    return w;
  }

  const k: KeyboardDelivery = {
    async locate(pid) { return !!(await windowOf(pid)); },
    async type(pid, text) {
      const w = await focus(pid);
      if (!w) return false;
      await (await input()).type(text);
      log(`terminal: typed into ${w.app} by keyboard`);
      return true;
    },
    async enter(pid) {
      if (!(await focus(pid))) return false;
      await (await input()).key("enter");
      return true;
    },
    async focus(pid) { await focus(pid); },
  };
  setWinKeyboard(k);
  return k;
}
