import { spawn } from "node:child_process";
import { accessSync, constants, chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crtQuote, spawnCommand, which as whichCmd } from "../features/run";
import { log } from "../log";
import { CACHE } from "../paths";
import { ACTIVITY_LOG } from "./activity";
import { basename } from "./procs";

// Opens commands in the user's terminal emulator (Activity.swift TerminalLauncher). macOS opens iTerm2 or Terminal;
// Linux has many, so the first installed of the usual ones wins. Windows: Windows Terminal (wt.exe) when installed,
// else WezTerm, else a console window (`cmd /c start`); scripts are .cmd files run with `cmd /k`.

const isWindows = () => process.platform === "win32";

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
  if (isWindows()) return whichCmd(name, path);
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

export const hasDisplay = () => isWindows() || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** How Windows opens a .cmd script in a new terminal window, preferred first. `cwd` is where it starts. */
export function windowsLaunchers(script: string, cwd: string, found: { wt: string | null; wezterm: string | null }, comspec = process.env.ComSpec || "cmd.exe"):
  { name: string; file: string; args: string[]; verbatim?: boolean }[] {
  const out: { name: string; file: string; args: string[]; verbatim?: boolean }[] = [];
  if (found.wt) out.push({ name: "windows-terminal", file: found.wt, args: ["-d", cwd, "cmd", "/k", script] });
  if (found.wezterm) out.push({ name: "wezterm", file: found.wezterm, args: ["start", "--cwd", cwd, "--", "cmd", "/k", script] });
  // `start` opens a new console window; "" is its title argument. Verbatim, so the quoted paths reach cmd as written.
  out.push({ name: "console", file: comspec, args: ["/d", "/s", "/c", `"start "" /D "${cwd}" cmd /k "${script}""`], verbatim: true });
  return out;
}

async function openWindows(script: string, cwd: string): Promise<{ ok: boolean; emulator?: string; problem?: string }> {
  const list = windowsLaunchers(script, cwd, { wt: which("wt"), wezterm: which("wezterm") });
  for (const e of list) {
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const child = spawn(e.file, e.args, { detached: true, stdio: "ignore", windowsVerbatimArguments: e.verbatim, env: { ...process.env } });
        child.on("error", () => done(false));
        child.on("exit", (code) => done(code === 0)); // wt.exe and `start` hand off and exit 0
        child.unref();
        setTimeout(() => done(true), 600);
      } catch {
        done(false);
      }
    });
    if (ok) { log(`terminal: opened ${e.name} running ${script}`); return { ok: true, emulator: e.name }; }
    log(`terminal: ${e.name} failed to open`);
  }
  return { ok: false, problem: "no terminal window could be opened" };
}

/** Opens a terminal window running `script` (an executable file). Tries the next emulator when one fails right away. */
export async function openTerminal(script: string, extraArgs: Partial<Record<string, string[]>> = {}, cwd?: string): Promise<{ ok: boolean; emulator?: string; problem?: string }> {
  if (isWindows()) return openWindows(script, cwd ?? CACHE);
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

// ── Batch files (Windows) ───────────────────────────────────────────────────────────────────────────────────────

/** One argument on a .cmd line: quoted for the program (C runtime rules), %% for the batch parser, and every cmd
 *  metacharacter (including the quotes) caret-escaped, so cmd never enters a quoted state and passes it on intact. */
export const batchArg = (a: string) => crtQuote(a).replace(/%/g, "%%").replace(/([\^&|<>()"])/g, "^$1");

/** A path in a .cmd line, plainly quoted (paths can't contain quotes). */
export const batchPath = (p: string) => `"${p.replace(/%/g, "%%")}"`;

/** A program and its arguments as one .cmd line. npm's .cmd shims are unwrapped to the node script they run (a shim
 *  would pass the arguments through cmd once more); another batch file is `call`ed. */
export function batchCommand(argv: string[]): string {
  const [cmd, ...args] = argv;
  const s = spawnCommand(cmd, args, process.env, "win32");
  if (s.verbatim) return `call ${batchPath(cmd)} ${args.map(batchArg).join(" ")}`.trim();
  return [batchPath(s.file), ...s.args.map(batchArg)].join(" ");
}

/** Writes CACHE/<name>.sh (a .cmd file on Windows, CRLF lines after @echo off) and returns its path. */
export function writeScript(name: string, body: string): string {
  mkdirSync(CACHE, { recursive: true });
  if (isWindows()) {
    const file = join(CACHE, `${name}.cmd`);
    // chcp 65001: the lines after it are read as UTF-8 (project folders and prompts aren't ASCII-only).
    writeFileSync(file, ["@echo off", "chcp 65001 >nul", ...body.split(/\r?\n/)].join("\r\n") + "\r\n");
    return file;
  }
  const file = join(CACHE, `${name}.sh`);
  writeFileSync(file, "#!/bin/sh\n" + body + "\n");
  chmodSync(file, 0o755);
  return file;
}

export const TerminalLauncher = {
  run(script: string, name: string, cwd?: string) {
    if (isWindows()) return openTerminal(writeScript(name, `set "PATH=${searchPath.replace(/%/g, "%%")}"\n${script}`), {}, cwd);
    return openTerminal(writeScript(name, `export PATH=${shellQuote(searchPath)}\n${script}`));
  },

  /** A CLI in `cwd` in a new terminal window (Continue in terminal for agy / gemini). */
  runCli(cwd: string, argv: string[], name = "continue") {
    if (isWindows()) return TerminalLauncher.run(`cd /d ${batchPath(cwd)}\n${batchCommand(argv)}`, name, cwd);
    return TerminalLauncher.run(`cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(" ")}`, name);
  },

  /** "Show live activity". */
  showActivity() {
    if (isWindows()) {
      // PowerShell's Get-Content -Wait is Windows' tail -F; single quotes inside a PowerShell string are doubled.
      const ps = `Get-Content -LiteralPath '${ACTIVITY_LOG.replace(/'/g, "''")}' -Encoding UTF8 -Tail 120 -Wait`;
      return TerminalLauncher.run([
        "title visioncli activity",
        "cls",
        "echo visioncli voice activity: questions, tool calls, commands and answers appear here live (Ctrl+C to close).",
        `if not exist ${batchPath(ACTIVITY_LOG)} type nul > ${batchPath(ACTIVITY_LOG)}`,
        `powershell -NoProfile -ExecutionPolicy Bypass -Command ${batchArg(ps)}`,
      ].join("\n"), "activity");
    }
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
    if (isWindows()) {
      return TerminalLauncher.run([
        "title visioncli -> claude",
        `cd /d ${batchPath(project)}`,
        "echo Continuing your voice conversation (as a copy, so voice mode keeps its own).",
        batchCommand([claude, "--resume", sessionId, "--fork-session"]),
      ].join("\n"), "continue", project);
    }
    return TerminalLauncher.run([
      `printf '\\033]0;visioncli → claude\\007'`,
      `cd ${shellQuote(project)}`,
      `printf '\\033[2mContinuing your voice conversation (as a copy, so voice mode keeps its own).\\033[0m\\n'`,
      `exec ${shellQuote(claude)} --resume ${sessionId} --fork-session`,
    ].join("\n"), "continue");
  },
};
