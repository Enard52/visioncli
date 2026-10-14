import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { hostCommand, hostWhich, inFlatpak } from "../../../../src/flatpak";

// The macOS app's `shell(…)`: run a program, collect stdout/stderr, never throw.
// Everything started through spawnCommand (run, the assistants, the terminal launcher…) runs on the host when the
// app is a Flatpak (../../../../src/flatpak.ts).

export interface RunResult { code: number; out: string; err: string }

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try {
      const s = spawnCommand(cmd, args, opts.env);
      child = spawn(s.file, s.args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: s.verbatim });
    } catch (e) {
      resolve({ code: 127, out: "", err: String((e as Error)?.message ?? e) });
      return;
    }
    const timer = opts.timeout ? setTimeout(() => child.kill("SIGKILL"), opts.timeout) : null;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: 127, out, err: err || e.message }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

const isWin = (platform: string) => platform === "win32";

/** The user's PATH plus the places CLIs land that a desktop session's PATH often lacks (~/.local/bin, npm, cargo …). */
export function userPath(base = process.env.PATH ?? "", platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, h = homedir()): string {
  const sep = isWin(platform) ? ";" : delimiter;
  const extra = isWin(platform) ? windowsExtraPath(env, h)
    : [join(h, ".local/bin"), join(h, ".cargo/bin"), join(h, ".npm-global/bin"), join(h, ".bun/bin"), join(h, ".volta/bin"),
      "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
  const parts = base.split(sep).filter(Boolean);
  const has = (e: string) => parts.some((p) => (isWin(platform) ? p.toLowerCase() === e.toLowerCase() : p === e));
  for (const e of extra) if (!has(e)) parts.push(e);
  return parts.join(sep);
}

/** Where Windows installs put the CLIs: the native Claude Code and uv installers (~\.local\bin), npm's global
 *  folder (%APPDATA%\npm), Node.js, Volta, Scoop, Bun, Cargo, and the App Execution Aliases (wt.exe). */
export function windowsExtraPath(env: NodeJS.ProcessEnv = process.env, h = homedir()): string[] {
  const j = win32.join;
  const appData = env.APPDATA || j(h, "AppData", "Roaming");
  const local = env.LOCALAPPDATA || j(h, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const out = [j(h, ".local", "bin"), j(appData, "npm"), j(programFiles, "nodejs"), j(local, "Programs", "nodejs"),
    j(local, "Volta", "bin"), j(h, "scoop", "shims"), j(h, ".bun", "bin"), j(h, ".cargo", "bin"), j(local, "Microsoft", "WindowsApps"),
    j(programFiles, "WezTerm"),
    // Antigravity's installer (antigravity.google/cli/install.cmd) puts agy.exe here
    j(local, "agy", "bin")];
  if (env.NVM_SYMLINK) out.push(env.NVM_SYMLINK);
  return out;
}

/** An environment with PATH set. On Windows the variable is "Path" and keys are case-insensitive: a copy with both
 *  "Path" and "PATH" would leave the child with either, so every spelling is replaced. */
export function withPath(path: string, base: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (isWin(platform)) for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
  env.PATH = path;
  return env;
}

/** Extensions Windows tries for a bare command name (PATHEXT), lowercased. */
export function pathExts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter(Boolean).map((e) => e.toLowerCase());
}

/** First executable `name` on `path`, or null. On Windows: `;`-separated PATH, PATHEXT extensions (claude.exe, an npm
 *  claude.cmd shim…), and App Execution Aliases (0-byte reparse points that stat() refuses but lstat() sees). */
export function which(name: string, path = userPath(), platform: string = process.platform, env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = isWin(platform) ? existsWin : isExecutable): string | null {
  if (!isWin(platform)) {
    if (name.includes("/")) return exists(name) ? name : hostFallback(name, path, exists);
    for (const dir of path.split(delimiter)) {
      const p = posix.join(dir, name);
      if (dir && exists(p)) return p;
    }
    return hostFallback(name, path, exists);
  }
  const exts = pathExts(env);
  const hasExt = exts.includes(win32.extname(name).toLowerCase());
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(name)) return candidates(name).find(exists) ?? null;
  for (const dir of path.split(";")) {
    if (!dir) continue;
    const hit = candidates(win32.join(dir.replace(/^"|"$/g, ""), name)).find(exists);
    if (hit) return hit;
  }
  return null;
}

/** Flatpak: the host's /usr isn't visible from the sandbox, so ask the host (only for the real filesystem check). */
const hostFallback = (name: string, path: string, exists: (p: string) => boolean) =>
  exists === isExecutable && inFlatpak() ? hostWhich(name, path) : null;

function isExecutable(p: string) {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

function existsWin(p: string) {
  try { return !lstatSync(p).isDirectory(); } catch { return false; }
}

// ── Spawning on Windows ─────────────────────────────────────────────────────────────────────────────────────────
// Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980), and the CLIs installed with npm are .cmd
// shims (claude.cmd, gemini.cmd). A shell would re-parse the arguments (prompts with quotes, &, |), so an npm shim is
// unwrapped to the `node <script>` (or .exe) it runs; any other batch file goes through cmd.exe with every argument
// escaped for both cmd and the program (cross-spawn's rules).

export interface SpawnTarget { file: string; args: string[]; verbatim?: boolean }

/** How to start `cmd args` without a shell, on this platform. */
export function spawnCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: string = process.platform,
  read: (f: string) => string | null = readText, exists: (p: string) => boolean = existsWin): SpawnTarget {
  if (!isWin(platform)) return hostCommand(cmd, args, { env, flatpak: platform === "linux" && inFlatpak() });
  if (!/\.(cmd|bat)$/i.test(cmd)) return { file: cmd, args };
  const shim = npmShimTarget(cmd, read, exists);
  if (shim) {
    if (/\.exe$/i.test(shim.target) || !/\.[cm]?js$/i.test(shim.target)) return { file: shim.target, args };
    const node = shim.node ?? which("node", envPath(env), platform, env, exists) ?? "node";
    return { file: node, args: [shim.target, ...args] };
  }
  return cmdShell(cmd, args, env);
}

/** `cmd.exe /d /s /c "<escaped command line>"` for a batch file that isn't an npm shim. */
export function cmdShell(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnTarget {
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(cmd) || /[\\/]npm[\\/][^\\/]+\.cmd$/i.test(cmd);
  const line = [cmdEscapeCommand(cmd), ...args.map((a) => cmdEscapeArg(a, shim))].join(" ");
  return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

const envPath = (env: NodeJS.ProcessEnv) => Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";

/** An argument as the C runtime (CommandLineToArgvW) reads it back: quoted, inner quotes and the backslashes before
 *  them escaped. */
export function crtQuote(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** For a command line cmd.exe parses: CRT-quoted, then every cmd metacharacter caret-escaped (so cmd never enters
 *  a quoted state and passes the text on as is). `twice` for a batch file that passes %* on to another program. */
export function cmdEscapeArg(arg: string, twice = false): string {
  let s = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`.replace(CMD_META, "^$1");
  if (twice) s = s.replace(CMD_META, "^$1");
  return s;
}
export const cmdEscapeCommand = (cmd: string) => cmd.replace(CMD_META, "^$1");

/** The program an npm/pnpm/yarn .cmd shim runs: `"%dp0%\node_modules\@scope\pkg\cli.js" %*`, or a native .exe.
 *  `node` is the node.exe next to the shim when the shim prefers it. Null for any other batch file. */
export function npmShimTarget(cmd: string, read: (f: string) => string | null = readText, exists: (p: string) => boolean = existsWin): { target: string; node: string | null } | null {
  const text = read(cmd);
  if (!text) return null;
  const dir = win32.dirname(cmd);
  // cmd-shim: "%_prog%"  "%dp0%\node_modules\…\cli.js" %*      older: "%~dp0\node.exe"  "%~dp0\..\pkg\cli.js" %*
  // pnpm:     "%~dp0\..\.pnpm\…\bin\cli.js" %*                 native: "%dp0%\node_modules\…\claude.exe" %*
  const refs = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"/gi)].map((m) => m[1]).filter((r) => !/^node(\.exe)?$/i.test(r));
  const target = refs.find((r) => /\.([cm]?js|exe)$/i.test(r)) ?? refs[refs.length - 1];
  if (!target || !/%\*/.test(text)) return null;
  const nodeHere = win32.join(dir, "node.exe");
  return { target: win32.resolve(dir, target), node: /dp0%?\\node\.exe/i.test(text) && exists(nodeHere) ? nodeHere : null };
}

function readText(f: string): string | null {
  try { return readFileSync(f, "utf8"); } catch { return null; }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
