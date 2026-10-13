import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { win32 as path } from "node:path";
import type { Apps } from "../contracts";
import { log } from "../log";
import { type Editor, type EditorKind, type FocusWindow, JETBRAINS, chooseEditor, editorCommand, projectEditors } from "./apps";
import { type WinHelper, exeId, winHelper } from "./windows/win32";

// The Windows side of apps.ts: installed apps from the Start Menu's shortcuts (.lnk, read with a small Shell Link
// parser) plus Store apps from Get-StartApps, launching/focusing them (Computer.openApp/focusApp/openURL), and opening
// file:line in the right editor (Opener) with the Windows launchers (code.cmd, idea64.exe, notepad++, subl.exe…).
// All paths here are Windows paths (path.win32), so this runs in tests on any OS.

export interface WinEntry {
  id: string;            // the .lnk path relative to its Programs folder, or a Store app's AUMID
  name: string;          // the shortcut's name ("Google Chrome") or the Start menu's
  file?: string;         // the .lnk
  target?: string;       // what it starts ("C:\Program Files\Google\Chrome\Application\chrome.exe")
  args?: string;
  icon?: string;
  aumid?: string;        // Store / packaged apps and system apps without a shortcut: shell:AppsFolder\<AUMID>
  hidden: boolean;       // uninstallers, readmes, help: launchable by name, not listed
}

// ── Shell Link (.lnk, [MS-SHLLINK]) ──

export interface ShellLink {
  target?: string;       // LinkInfo's local (or network) path, else the environment-variable target, else the relative path
  name?: string;         // the description (NAME_STRING)
  relativePath?: string;
  workingDir?: string;
  args?: string;
  iconLocation?: string;
  envTarget?: string;    // EnvironmentVariableDataBlock: "%windir%\system32\notepad.exe" (unexpanded)
}

const LNK_CLSID = "0114020000000000c000000000000046";
const F = { IDLIST: 0x1, LINKINFO: 0x2, NAME: 0x4, RELPATH: 0x8, WORKDIR: 0x10, ARGS: 0x20, ICON: 0x40, UNICODE: 0x80 };

const zAnsi = (b: Buffer, at: number) => { let e = at; while (e < b.length && b[e] !== 0) e++; return b.toString("latin1", at, e); };
const zUtf16 = (b: Buffer, at: number) => { let e = at; while (e + 1 < b.length && (b[e] || b[e + 1])) e += 2; return b.toString("utf16le", at, e); };

/** Parses a .lnk; null when it isn't one. Out-of-range offsets end the parse with what was read so far. */
export function parseShellLink(b: Buffer): ShellLink | null {
  if (b.length < 0x4c || b.readUInt32LE(0) !== 0x4c || b.toString("hex", 4, 20) !== LNK_CLSID) return null;
  const flags = b.readUInt32LE(0x14);
  const out: ShellLink = {};
  let off = 0x4c;
  try {
    if (flags & F.IDLIST) off += 2 + b.readUInt16LE(off);
    if (flags & F.LINKINFO) {
      const size = b.readUInt32LE(off), headerSize = b.readUInt32LE(off + 4), liFlags = b.readUInt32LE(off + 8);
      const localOff = b.readUInt32LE(off + 16), netOff = b.readUInt32LE(off + 20), suffixOff = b.readUInt32LE(off + 24);
      const unicode = headerSize >= 0x24;
      const localU = unicode ? b.readUInt32LE(off + 28) : 0, suffixU = unicode ? b.readUInt32LE(off + 32) : 0;
      const suffix = suffixU ? zUtf16(b, off + suffixU) : suffixOff ? zAnsi(b, off + suffixOff) : "";
      if (liFlags & 1) {
        const base = localU ? zUtf16(b, off + localU) : zAnsi(b, off + localOff);
        out.target = suffix ? path.join(base, suffix) : base;
      } else if (liFlags & 2 && netOff) {
        // CommonNetworkRelativeLink: NetName (\\server\share) at its own NetNameOffset.
        const cnrl = off + netOff;
        const net = zAnsi(b, cnrl + b.readUInt32LE(cnrl + 8));
        out.target = suffix ? `${net}\\${suffix}` : net;
      }
      off += size;
    }
    const str = (): string => {
      const n = b.readUInt16LE(off);
      const bytes = flags & F.UNICODE ? n * 2 : n;
      if (off + 2 + bytes > b.length) throw new RangeError("string past the end");
      const s = b.toString(flags & F.UNICODE ? "utf16le" : "latin1", off + 2, off + 2 + bytes);
      off += 2 + bytes;
      return s;
    };
    if (flags & F.NAME) out.name = str();
    if (flags & F.RELPATH) out.relativePath = str();
    if (flags & F.WORKDIR) out.workingDir = str();
    if (flags & F.ARGS) out.args = str();
    if (flags & F.ICON) out.iconLocation = str();
    // ExtraData blocks until a terminal block (size < 4).
    while (off + 8 <= b.length) {
      const size = b.readUInt32LE(off);
      if (size < 8) break;
      if (b.readUInt32LE(off + 4) === 0xa0000001 && size >= 0x314) {
        out.envTarget = zUtf16(b, off + 268) || zAnsi(b, off + 8);
      }
      off += size;
    }
  } catch { /* truncated: keep what we have */ }
  return out;
}

/** %VAR% → its value (Windows names are case-insensitive); unknown ones stay as they are. */
export function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return s.replace(/%([^%]+)%/g, (m, k: string) => lower.get(k.toLowerCase()) ?? m);
}

/** The program a shortcut starts. */
export function lnkTarget(l: ShellLink, lnkFile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (l.target) return l.target;
  if (l.envTarget) return expandEnv(l.envTarget, env);
  if (l.relativePath) return path.resolve(path.dirname(lnkFile), expandEnv(l.relativePath, env));
  return undefined;
}

// ── Start Menu ──

/** The all-users and the user's Start Menu\Programs. */
export function startMenuDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const e = (k: string) => env[k] ?? Object.entries(env).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];
  const dirs = [e("APPDATA"), e("ProgramData")].filter((d): d is string => !!d);
  return dirs.map((d) => path.join(d, "Microsoft", "Windows", "Start Menu", "Programs"));
}

const NOT_APPS = /\b(uninstall|uninstaller|readme|read me|help|documentation|manual|release notes|license|website|changelog)\b/i;

export interface FsLike {
  readdir(dir: string): { name: string; dir: boolean }[];
  read(file: string): Buffer;
}
const realFs: FsLike = {
  readdir: (d) => readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })),
  read: (f) => readFileSync(f),
};

/** Every shortcut under the Start Menu folders (the user's first: it wins for the same name), up to 4 levels deep. */
export function readShortcuts(dirs = startMenuDirs(), fs: FsLike = realFs, env: NodeJS.ProcessEnv = process.env): WinEntry[] {
  const seen = new Map<string, WinEntry>();
  const walk = (root: string, dir: string, depth: number) => {
    let names: { name: string; dir: boolean }[];
    try { names = fs.readdir(dir); } catch { return; }
    for (const n of names) {
      const file = path.join(dir, n.name);
      if (n.dir) { if (depth < 4) walk(root, file, depth + 1); continue; }
      if (!/\.lnk$/i.test(n.name)) continue;
      const name = n.name.replace(/\.lnk$/i, "");
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      let link: ShellLink | null = null;
      try { link = parseShellLink(fs.read(file)); } catch {}
      if (!link) continue;
      const target = lnkTarget(link, file, env);
      // Shortcuts to documents and web pages aren't apps.
      const doc = !!target && /\.(url|chm|txt|pdf|html?|rtf|md)$/i.test(target);
      seen.set(key, {
        id: path.relative(root, file), name, file, target, args: link.args, icon: link.iconLocation?.split(",")[0] || target,
        hidden: NOT_APPS.test(name) || doc,
      });
    }
  };
  for (const d of dirs) walk(d, d, 0);
  return [...seen.values()];
}

/** `Get-StartApps | ConvertTo-Json` (an object when there is one app). */
export function parseStartApps(json: string): { name: string; aumid: string }[] {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return []; }
  const rows = (Array.isArray(v) ? v : v ? [v] : []) as { Name?: string; AppID?: string }[];
  return rows.filter((r) => r?.Name && r?.AppID).map((r) => ({ name: r.Name!, aumid: r.AppID! }));
}

/** Shortcuts, plus the Start menu's apps that have none (Store apps, Settings, File Explorer…), by AUMID. */
export function mergeEntries(shortcuts: WinEntry[], startApps: { name: string; aumid: string }[]): WinEntry[] {
  const names = new Set(shortcuts.map((e) => e.name.toLowerCase()));
  const extra = startApps.filter((a) => !names.has(a.name.toLowerCase()))
    .map((a) => ({ id: a.aumid, name: a.name, aumid: a.aumid, hidden: NOT_APPS.test(a.name) }));
  return [...shortcuts, ...extra];
}

/** Best match for a spoken/typed app name: exact name/exe/id, then prefix, then contains (listed apps first). */
export function findWinEntry(entries: WinEntry[], name: string): WinEntry | undefined {
  const q = name.trim().toLowerCase().replace(/\.(lnk|exe)$/, "");
  if (!q) return undefined;
  const keys = (e: WinEntry) => [e.name.toLowerCase(), e.target ? exeId(e.target).toLowerCase() : "", (e.aumid ?? "").toLowerCase(),
    (e.aumid ?? "").split("!")[0].split("_")[0].split(".").pop()!.toLowerCase()].filter(Boolean);
  const ordered = [...entries.filter((e) => !e.hidden), ...entries.filter((e) => e.hidden)];
  return ordered.find((e) => keys(e).includes(q))
    ?? ordered.find((e) => e.name.toLowerCase().startsWith(q))
    ?? ordered.find((e) => keys(e).some((k) => k.includes(q)));
}

// ── Launching ──

/** Quotes one argument for cmd.exe's command line (a path with spaces or & ( ) ^ is safe inside quotes). */
export const cmdQuote = (a: string) => (a === "" || /[\s&()^|<>,;=!"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** The argv that starts something on Windows: .cmd/.bat go through cmd.exe (Node refuses to spawn them directly). */
export function launchArgv(cmd: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (/\.(cmd|bat)$/i.test(cmd)) return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${[cmd, ...args].map(cmdQuote).join(" ")}"`], verbatim: true };
  return { file: cmd, args, verbatim: false };
}

/** How each kind of entry is opened: the .lnk through `start` (the shell runs it, admin prompts and all), a packaged
 *  app through its AUMID in shell:AppsFolder. */
export function openArgv(e: WinEntry): { file: string; args: string[]; verbatim: boolean } {
  if (e.file) return { file: "cmd.exe", args: ["/d", "/s", "/c", `"start "" ${cmdQuote(e.file)}"`], verbatim: true };
  return { file: "explorer.exe", args: [`shell:AppsFolder\\${e.aumid}`], verbatim: false };
}

/** URLs and files: rundll32's FileProtocolHandler opens them like `start` does, without cmd.exe expanding %20 etc. */
export const openWithShellArgv = (target: string) => ({ file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target], verbatim: false });

export type Launcher = (a: { file: string; args: string[]; verbatim: boolean }, cwd?: string) => Promise<void>;

const realLaunch: Launcher = (a, cwd) => new Promise((resolve, reject) => {
  const child = spawn(a.file, a.args, { detached: true, stdio: "ignore", cwd, windowsHide: true, windowsVerbatimArguments: a.verbatim });
  child.once("error", reject);
  child.once("spawn", () => { child.unref(); resolve(); });
});

// ── Editors ──

const VSCODE_EXE: Record<string, string> = { "code.exe": "code", "code - insiders.exe": "code-insiders", "cursor.exe": "cursor", "windsurf.exe": "windsurf", "vscodium.exe": "codium" };

/** A command line → argv (Windows rules, enough for finding paths in it). */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

export interface WinProc { pid: number; exe: string; cmdline: string; cwd: string | null }

/** A running process → the editor it is and how to reach it from the command line. */
export function editorFromWinProcess(p: WinProc, exists: (f: string) => boolean = existsSync): Editor | null {
  const argv0 = splitCommandLine(p.cmdline)[0] ?? "";
  const exe = path.isAbsolute(p.exe) ? p.exe : path.isAbsolute(argv0) ? argv0 : p.exe;
  const base = path.basename(exe).toLowerCase(), dir = path.dirname(exe);
  const jb = new RegExp(`^(${JETBRAINS.join("|")})(64)?\\.exe$`).exec(base);
  if (jb) return { kind: "jetbrains", cmd: exe };
  const vs = VSCODE_EXE[base];
  if (vs) {
    // The GUI exe isn't the CLI: bin\code.cmd next to it (Cursor keeps it under resources\app\bin).
    const cli = [path.join(dir, "bin", `${vs}.cmd`), path.join(dir, "resources", "app", "bin", `${vs}.cmd`)].find(exists);
    return cli ? { kind: "vscode", cmd: cli } : null;
  }
  if (base === "zed.exe") return { kind: "zed", cmd: exe };
  if (base === "sublime_text.exe") { const subl = path.join(dir, "subl.exe"); return { kind: "sublime", cmd: exists(subl) ? subl : exe }; }
  if (base === "notepad++.exe") return { kind: "notepadpp", cmd: exe };
  return null;
}

/** Where editors install on Windows, per kind, best first (PATH first, then the per-user and machine installs). */
export function installedWinEditor(kind: EditorKind, env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = existsSync,
  list: (d: string) => string[] = (d) => { try { return readdirSync(d); } catch { return []; } }): Editor | null {
  const local = env.LOCALAPPDATA ?? "", pf = env.ProgramFiles ?? "C:\\Program Files";
  const onPath = (n: string) => whichWin(n, env, exists);
  const first = (c: (string | null | undefined)[]) => c.find((f): f is string => !!f && exists(f)) ?? null;
  let cmd: string | null = null;
  if (kind === "vscode") {
    cmd = onPath("code") ?? first([
      path.join(local, "Programs", "Microsoft VS Code", "bin", "code.cmd"), path.join(pf, "Microsoft VS Code", "bin", "code.cmd"),
      path.join(local, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"), path.join(local, "Programs", "Windsurf", "bin", "windsurf.cmd"),
      path.join(local, "Programs", "VSCodium", "bin", "codium.cmd"),
    ]) ?? onPath("cursor") ?? onPath("windsurf") ?? onPath("codium");
  } else if (kind === "jetbrains") {
    // JetBrains Toolbox's shell scripts (idea.cmd …), then standalone installs (Program Files\JetBrains\<IDE>\bin\idea64.exe).
    cmd = first(JETBRAINS.map((n) => path.join(local, "JetBrains", "Toolbox", "scripts", `${n}.cmd`)));
    if (!cmd) {
      const root = path.join(pf, "JetBrains");
      for (const ide of list(root)) {
        const bin = path.join(root, ide, "bin");
        const exe = list(bin).find((f) => new RegExp(`^(${JETBRAINS.join("|")})64\\.exe$`, "i").test(f));
        if (exe) { cmd = path.join(bin, exe); break; }
      }
    }
  } else if (kind === "sublime") {
    cmd = onPath("subl") ?? first(["Sublime Text", "Sublime Text 4", "Sublime Text 3"].map((d) => path.join(pf, d, "subl.exe")));
  } else if (kind === "zed") {
    cmd = onPath("zed") ?? first([path.join(local, "Programs", "Zed", "Zed.exe")]);
  } else if (kind === "notepadpp") {
    cmd = first([path.join(pf, "Notepad++", "notepad++.exe")]);
  }
  return cmd ? { kind, cmd } : null;
}

/** A program on PATH with one of PATHEXT's extensions (.COM;.EXE;.BAT;.CMD …), or null. */
export function whichWin(name: string, env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = existsSync): string | null {
  const p = env.PATH ?? env.Path ?? "";
  const exts = /\.[a-z0-9]+$/i.test(name) ? [""] : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  for (const dir of p.split(";").filter(Boolean)) {
    for (const e of exts) { const f = path.join(dir, name + e); if (exists(f)) return f; }
  }
  return null;
}

/** path (absolute, project-relative, or a bare file name Claude cited) → an existing file; searched in the project like
 *  `find` on Linux (skipping node_modules, vendor, .git), up to 20 000 entries. */
export function resolveWinFile(file: string, project: string, fs: { exists(f: string): boolean; readdir(d: string): { name: string; dir: boolean }[] } =
  { exists: existsSync, readdir: realFs.readdir }): string | null {
  const candidate = path.isAbsolute(file) ? file : path.join(project, file);
  if (fs.exists(candidate)) return candidate;
  if (!project || !fs.exists(project)) return null;
  const want = path.basename(file).toLowerCase(), tail = path.normalize(file).toLowerCase();
  const hits: string[] = [];
  let budget = 20_000;
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || budget <= 0) return;
    let names: { name: string; dir: boolean }[];
    try { names = fs.readdir(dir); } catch { return; }
    for (const n of names) {
      if (--budget <= 0) return;
      const p = path.join(dir, n.name);
      if (n.dir) { if (!["node_modules", "vendor", ".git"].includes(n.name)) walk(p, depth + 1); }
      else if (n.name.toLowerCase() === want) hits.push(p);
    }
  };
  walk(project, 0);
  return hits.find((h) => h.toLowerCase().endsWith(tail)) ?? hits[0] ?? null;
}

// ── Apps ──

export interface WinAppsDeps {
  helper?: WinHelper;
  launch?: Launcher;
  shortcuts?: () => WinEntry[];
  startApps?: () => Promise<{ name: string; aumid: string }[]>;
  processes?: () => Promise<WinProc[]>;
  resolveFile?: (file: string, project: string) => string | null;
  installed?: (k: EditorKind) => Editor | null;
  exists?: (f: string) => boolean;
}

const getStartApps = () => new Promise<{ name: string; aumid: string }[]>((resolve) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
    { timeout: 20_000, maxBuffer: 8 << 20, windowsHide: true }, (e, out) => resolve(e ? [] : parseStartApps(out)));
});

export function createWinApps(focusWindow?: FocusWindow, deps: WinAppsDeps = {}): Apps {
  const launch = deps.launch ?? realLaunch;
  const shortcuts = deps.shortcuts ?? (() => readShortcuts());
  const startApps = deps.startApps ?? getStartApps;
  const processes = deps.processes ?? (async () => (await (deps.helper ?? winHelper()).call("processes", {})));
  const exists = deps.exists ?? existsSync;
  let cache: { at: number; entries: WinEntry[] } | null = null;
  let store: { at: number; apps: Promise<{ name: string; aumid: string }[]> } | null = null;
  const entries = async () => {
    // Get-StartApps takes a second or two: asked at most every 10 minutes; the shortcuts every 10 s, like Linux.
    if (!store || Date.now() - store.at > 600_000) store = { at: Date.now(), apps: startApps().catch(() => []) };
    if (!cache || Date.now() - cache.at > 10_000) cache = { at: Date.now(), entries: mergeEntries(shortcuts(), await store.apps) };
    return cache.entries;
  };

  const apps: Apps = {
    async list() {
      return (await entries()).filter((e) => !e.hidden)
        .map((e) => ({ id: e.id, name: e.name, exec: e.target ? [e.target, e.args].filter(Boolean).join(" ") : `shell:AppsFolder\\${e.aumid}`, icon: e.icon }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async open(name) {
      const e = findWinEntry(await entries(), name);
      if (e) { await launch(openArgv(e)); return e.name; }
      const bin = whichWin(name.trim(), process.env, exists);
      if (bin) { await launch(launchArgv(bin, []), process.env.USERPROFILE); return name.trim(); }
      throw new Error(`Couldn't open ${name}: no such app`);
    },

    async focus(name) {
      const e = findWinEntry(await entries(), name);
      const names = [...new Set([name, e?.name, e?.target && exeId(e.target)].filter((n): n is string => !!n))];
      for (const n of names) if (focusWindow && await focusWindow(n).catch(() => false)) return e?.name ?? name;
      return apps.open(name); // not running: open it, like Computer.focusApp
    },

    async openUrl(url) {
      const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url;
      await launch(openWithShellArgv(u));
    },

    async openFile(file, line = 1, project = "") {
      const found = (deps.resolveFile ?? resolveWinFile)(file, project);
      if (!found) { log(`open: couldn't find ${file} in ${project}`); throw new Error(`Couldn't find ${file}`); }
      const procs = await processes().catch((e) => { log(`open: processes: ${(e as Error).message}`); return [] as WinProc[]; });
      // Paths compare case-insensitively on Windows.
      const lower = (s: string) => s.toLowerCase();
      const running = procs.flatMap((p) => {
        const ed = editorFromWinProcess(p, exists);
        return ed ? [{ ...ed, cwd: lower(p.cwd ?? ""), argv: splitCommandLine(p.cmdline).map(lower) }] : [];
      });
      const proj = lower(project);
      const unique = running.filter((e, i) => running.findIndex((x) => lower(x.cmd) === lower(e.cmd)) === i || (proj && e.cwd.startsWith(proj)));
      const editor = chooseEditor(unique, proj, project ? projectEditors(project) : [], deps.installed ?? ((k) => installedWinEditor(k)));
      if (editor) {
        const [cmd, ...args] = editorCommand(editor, found, line);
        log(`open: ${cmd} ${args.join(" ")}`);
        return launch(launchArgv(cmd, args), project || undefined);
      }
      return launch(openWithShellArgv(found));
    },
  };
  return apps;
}
