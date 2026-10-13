import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { Apps } from "../contracts";
import { log } from "../log";
import { launch, run, which } from "./input/exec";
import { createWinApps } from "./winapps";

// Installed apps from .desktop files, launching/focusing them (Computer.openApp/focusApp/openURL in Control.swift),
// and opening file:line in the right editor (Opener in Overlays.swift). Windows: Start Menu shortcuts and Store apps,
// in winapps.ts.

export interface DesktopEntry {
  id: string;            // desktop file id: path under applications/ with "/" → "-" ("org.gnome.gedit.desktop")
  file: string;
  name: string;
  exec: string;
  icon?: string;
  hidden: boolean;       // NoDisplay / Hidden: launchable by name, not listed
  terminal: boolean;
  wmClass?: string;
}

// ── .desktop parsing (Desktop Entry Specification) ──

/** The [Desktop Entry] group's keys, with value escapes (\s \n \t \r \\) undone. Localized keys keep their [xx]. */
export function parseDesktopFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { inMain = line === "[Desktop Entry]"; continue; }
    if (!inMain) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in out)) out[key] = line.slice(eq + 1).trim().replace(/\\([sntr\\])/g, (_, c) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c as "s"]);
  }
  return out;
}

/** Exec= → argv: quoted arguments, \" \` \$ \\ escapes inside quotes, field codes (%f %U …) dropped, %% → %. */
export function parseExec(exec: string): string[] {
  const args: string[] = [];
  let cur = "", quoted = false, any = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (quoted) {
      if (c === "\\" && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1])) cur += exec[++i];
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') { quoted = true; any = true; }
    else if (c === " " || c === "\t") { if (cur || any) args.push(cur); cur = ""; any = false; }
    else cur += c;
  }
  if (cur || any) args.push(cur);
  return args
    .map((a) => (/^%[fFuUdDnNickvm]$/.test(a) ? null : a.replace(/%[fFuUdDnNickvm]/g, "").replace(/%%/g, "%")))
    .filter((a): a is string => a !== null);
}

/** Where .desktop files live, most important first: the user's, XDG_DATA_DIRS, Flatpak and Snap exports. */
export function applicationDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dataHome = env.XDG_DATA_HOME || join(home, ".local/share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const dirs = [dataHome, ...dataDirs, join(home, ".local/share/flatpak/exports/share"), "/var/lib/flatpak/exports/share"]
    .map((d) => join(d, "applications"));
  dirs.push("/var/lib/snapd/desktop/applications");
  return [...new Set(dirs)];
}

export function readEntries(dirs = applicationDirs()): DesktopEntry[] {
  const seen = new Map<string, DesktopEntry | null>();
  const walk = (root: string, dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const file = join(dir, n);
      if (n.endsWith(".desktop")) {
        const id = relative(root, file).split(/[\\/]/).join("-");
        if (seen.has(id)) continue; // an earlier dir overrides (or hides) the same id
        let kv: Record<string, string>;
        try { kv = parseDesktopFile(readFileSync(file, "utf8")); } catch { continue; }
        if ((kv.Type ?? "Application") !== "Application" || !kv.Name || !kv.Exec || kv.Hidden === "true") { seen.set(id, null); continue; }
        if (kv.TryExec && !which(kv.TryExec)) { seen.set(id, null); continue; }
        seen.set(id, {
          id, file, name: kv.Name, exec: kv.Exec, icon: kv.Icon, hidden: kv.NoDisplay === "true", terminal: kv.Terminal === "true",
          wmClass: kv.StartupWMClass,
        });
      } else if (depth < 3) {
        try { if (statSync(file).isDirectory()) walk(root, file, depth + 1); } catch {}
      }
    }
  };
  for (const d of dirs) walk(d, d, 0);
  return [...seen.values()].filter((e): e is DesktopEntry => !!e);
}

/** Best match for a spoken/typed app name: exact name/id/command, then prefix, then contains (listed apps first). */
export function findEntry(entries: DesktopEntry[], name: string): DesktopEntry | undefined {
  const q = name.trim().toLowerCase().replace(/\.desktop$/, "");
  if (!q) return undefined;
  const keys = (e: DesktopEntry) => [e.name.toLowerCase(), e.id.toLowerCase().replace(/\.desktop$/, ""),
    basename(parseExec(e.exec)[0] ?? "").toLowerCase(), (e.wmClass ?? "").toLowerCase(),
    e.id.toLowerCase().replace(/\.desktop$/, "").split(".").pop()!];
  const ordered = [...entries.filter((e) => !e.hidden), ...entries.filter((e) => e.hidden)];
  return ordered.find((e) => keys(e).includes(q))
    ?? ordered.find((e) => e.name.toLowerCase().startsWith(q))
    ?? ordered.find((e) => keys(e).some((k) => k.includes(q)));
}

// ── Opener: file:line in the right editor ──

export type EditorKind = "jetbrains" | "vscode" | "zed" | "sublime" | "notepadpp"; // notepadpp: Windows only
export interface Editor { kind: EditorKind; cmd: string; cwd?: string }

export const JETBRAINS = ["idea", "webstorm", "pycharm", "phpstorm", "goland", "rider", "clion", "rubymine", "datagrip", "rustrover",
  "studio", "dataspell", "aqua", "fleet", "pycharm-community", "idea-community", "idea-ultimate"];
const VSCODE: Record<string, string> = { code: "code", "code-insiders": "code-insiders", cursor: "cursor", windsurf: "windsurf", codium: "codium", vscodium: "codium" };
const ZED = ["zed", "zeditor", "zedit", "zed-editor"];

/** The command that opens file:line in this editor. */
export function editorCommand(e: Editor, file: string, line: number): string[] {
  switch (e.kind) {
    case "jetbrains": return [e.cmd, "--line", String(line), file];
    case "vscode": return [e.cmd, "--goto", `${file}:${line}`];
    case "zed": case "sublime": return [e.cmd, `${file}:${line}`];
    case "notepadpp": return [e.cmd, `-n${line}`, file];
  }
}

/** Terminal editors take +line (helix and kakoune differ); the terminal runs them. */
export function terminalEditorCommand(editor: string, file: string, line: number): string[] | null {
  const name = basename(editor.split(/\s+/)[0]);
  if (["vim", "nvim", "vi", "nano", "emacs", "micro", "joe", "mg", "kak"].includes(name)) return [editor.split(/\s+/)[0], `+${line}`, file];
  if (name === "hx" || name === "helix") return [editor.split(/\s+/)[0], `${file}:${line}`];
  return null;
}

interface Proc { pid: number; comm: string; exe: string; argv: string[]; cwd: string }

function processes(): Proc[] {
  const out: Proc[] = [];
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const p of pids) {
    try {
      const comm = readFileSync(`/proc/${p}/comm`, "utf8").trim();
      const argv = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean);
      let exe = "", cwd = "";
      try { exe = readlinkSync(`/proc/${p}/exe`); } catch {}
      try { cwd = readlinkSync(`/proc/${p}/cwd`); } catch {}
      out.push({ pid: Number(p), comm, exe, argv, cwd });
    } catch {}
  }
  return out;
}

/** A running process → the editor it is and how to reach it from the command line. */
export function editorFromProcess(p: { comm: string; exe: string; argv: string[] }): Editor | null {
  const exeName = basename(p.exe || p.argv[0] || "");
  // JetBrains: the native launcher is the process (bin/idea), or java runs com.intellij.idea.Main from <root>/jbr.
  const jb = JETBRAINS.find((n) => exeName === n || exeName === `${n}.sh` || p.comm === n);
  if (jb && p.exe) return { kind: "jetbrains", cmd: p.exe };
  if (p.argv.some((a) => a === "com.intellij.idea.Main")) {
    const root = (p.argv[0] || p.exe).split("/jbr/")[0];
    try {
      const sh = readdirSync(join(root, "bin")).find((f) => JETBRAINS.some((n) => f === n || f === `${n}.sh`));
      if (sh) return { kind: "jetbrains", cmd: join(root, "bin", sh) };
    } catch {}
  }
  const vs = VSCODE[p.comm] ?? VSCODE[exeName];
  if (vs) {
    // The GUI binary isn't the CLI; the CLI is on PATH or in <app>/bin/.
    const local = p.exe ? join(dirname(p.exe), "bin", vs) : "";
    const cmd = which(vs) ?? (local && existsSync(local) ? local : null);
    if (cmd) return { kind: "vscode", cmd };
  }
  if (ZED.includes(p.comm) || ZED.includes(exeName)) {
    const cmd = ZED.map((z) => which(z)).find(Boolean) ?? null;
    if (cmd) return { kind: "zed", cmd };
  }
  if (p.comm === "sublime_text" || exeName === "sublime_text") return { kind: "sublime", cmd: which("subl") ?? p.exe };
  return null;
}

function installedEditor(kind: EditorKind): Editor | null {
  if (kind === "jetbrains") {
    const scripts = join(homedir(), ".local/share/JetBrains/Toolbox/scripts");
    for (const n of JETBRAINS) {
      const hit = which(n) ?? which(`${n}.sh`) ?? (existsSync(join(scripts, n)) ? join(scripts, n) : null);
      if (hit) return { kind, cmd: hit };
    }
    return null;
  }
  const names = kind === "vscode" ? Object.values(VSCODE) : kind === "zed" ? ZED : kind === "sublime" ? ["subl"] : [];
  const cmd = names.map((n) => which(n)).find(Boolean);
  return cmd ? { kind, cmd } : null;
}

/** Which editor a project is set up for, from its files. */
export function projectEditors(project: string): EditorKind[] {
  const kinds: EditorKind[] = [];
  const has = (f: string) => existsSync(join(project, f));
  if (has(".idea")) kinds.push("jetbrains");
  if (has(".vscode")) kinds.push("vscode");
  if (has(".zed")) kinds.push("zed");
  try { if (readdirSync(project).some((f) => f.endsWith(".sublime-project"))) kinds.push("sublime"); } catch {}
  return kinds;
}

/**
 * The editor to open a project's file in, like Opener prefers the editor the question came from: a running editor whose
 * working directory or arguments are in the project, then a running editor the project is set up for, then any running
 * editor, then an installed one the project is set up for.
 */
export function chooseEditor(running: (Editor & { cwd?: string; argv?: string[] })[], project: string, markers: EditorKind[],
  installed: (k: EditorKind) => Editor | null): Editor | null {
  const inProject = (e: { cwd?: string; argv?: string[] }) =>
    !!project && ((e.cwd ?? "").startsWith(project) || (e.argv ?? []).some((a) => a.startsWith(project)));
  return running.find(inProject)
    ?? running.find((e) => markers.includes(e.kind))
    ?? running[0]
    ?? markers.map(installed).find(Boolean)
    ?? null;
}

/** path (absolute, project-relative, or a bare file name Claude cited) → an existing file. */
export async function resolveFile(path: string, project: string): Promise<string | null> {
  const candidate = path.startsWith("/") ? path : join(project, path);
  if (existsSync(candidate)) return candidate;
  if (!project || !existsSync(project)) return null;
  try {
    const out = await run("find", [project, "-name", basename(path), "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/vendor/*", "-not", "-path", "*/.git/*"], { timeout: 10_000 });
    const hits = out.split("\n").filter(Boolean);
    return hits.find((h) => h.endsWith(path)) ?? hits[0] ?? null;
  } catch { return null; }
}

const TERMINALS: [string, string[]][] = [
  ["x-terminal-emulator", ["-e"]], ["kitty", []], ["alacritty", ["-e"]], ["foot", []], ["wezterm", ["start", "--"]],
  ["gnome-terminal", ["--"]], ["konsole", ["-e"]], ["xfce4-terminal", ["-x"]], ["xterm", ["-e"]],
];

export type FocusWindow = (name: string) => Promise<boolean>;

/** `focusWindow` comes from the desktop-windows module: raise an app's window by name; false when it has none. */
export function createApps(focusWindow?: FocusWindow): Apps {
  if (process.platform === "win32") return createWinApps(focusWindow);
  let cache: { at: number; entries: DesktopEntry[] } | null = null;
  const entries = () => {
    if (!cache || Date.now() - cache.at > 10_000) cache = { at: Date.now(), entries: readEntries() };
    return cache.entries;
  };

  async function start(e: DesktopEntry) {
    const id = e.id.replace(/\.desktop$/, "");
    // gtk-launch and gio do it the desktop's way (startup notification, Terminal=true, D-Bus activation).
    if (which("gtk-launch")) { try { await run("gtk-launch", [id], { timeout: 10_000 }); return; } catch (err) { log(`gtk-launch ${id}: ${(err as Error).message}`); } }
    if (which("gio")) { try { await run("gio", ["launch", e.file], { timeout: 10_000 }); return; } catch (err) { log(`gio launch ${id}: ${(err as Error).message}`); } }
    const argv = parseExec(e.exec);
    if (!argv.length) throw new Error(`Couldn't open ${e.name}: empty Exec`);
    await launch(argv[0], argv.slice(1), homedir());
  }

  const apps: Apps = {
    async list() {
      return entries().filter((e) => !e.hidden).map((e) => ({ id: e.id, name: e.name, exec: e.exec, icon: e.icon }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async open(name) {
      const e = findEntry(entries(), name);
      if (e) { await start(e); return e.name; }
      const bin = which(name.trim().toLowerCase()) ?? which(name.trim());
      if (bin) { await launch(bin, [], homedir()); return name.trim(); }
      throw new Error(`Couldn't open ${name}: no such app`);
    },

    async focus(name) {
      const e = findEntry(entries(), name);
      const names = [...new Set([name, e?.name, e?.wmClass].filter((n): n is string => !!n))];
      for (const n of names) {
        if (focusWindow) { if (await focusWindow(n).catch(() => false)) return e?.name ?? name; }
        else if (process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && which("wmctrl")) {
          try { await run("wmctrl", ["-x", "-a", n]); return e?.name ?? name; } catch {}
        }
      }
      return apps.open(name); // not running: open it, like Computer.focusApp
    },

    async openUrl(url) {
      const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url;
      await launch(which("xdg-open") ? "xdg-open" : "gio", which("xdg-open") ? [u] : ["open", u]);
    },

    async openFile(path, line = 1, project = "") {
      const file = await resolveFile(path, project);
      if (!file) { log(`open: couldn't find ${path} in ${project}`); throw new Error(`Couldn't find ${path}`); }
      const running = processes().flatMap((p) => {
        const e = editorFromProcess(p);
        return e ? [{ ...e, cwd: p.cwd, argv: p.argv }] : [];
      });
      // One entry per editor (Electron and JetBrains run many processes).
      const unique = running.filter((e, i) => running.findIndex((x) => x.cmd === e.cmd) === i || (project && (e.cwd ?? "").startsWith(project)));
      const editor = chooseEditor(unique, project, project ? projectEditors(project) : [], installedEditor);
      if (editor) {
        const [cmd, ...args] = editorCommand(editor, file, line);
        log(`open: ${cmd} ${args.join(" ")}`);
        return launch(cmd, args, project || undefined);
      }
      // A terminal editor the user chose ($VISUAL/$EDITOR), in a terminal.
      const ed = process.env.VISUAL || process.env.EDITOR;
      const argv = ed ? terminalEditorCommand(ed, file, line) : null;
      const term = TERMINALS.find(([t]) => which(t));
      if (argv && term) return launch(term[0], [...term[1], ...argv], project || undefined);
      return launch(which("xdg-open") ? "xdg-open" : "gio", which("xdg-open") ? [file] : ["open", file]);
    },
  };
  return apps;
}
