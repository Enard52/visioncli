import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DesktopWindow } from "../contracts";
import { log } from "../log";

// Maps the window under the pointer to a project folder, so voice mode follows you between projects.
// Known projects come from JetBrains "recent projects" (PhpStorm, IntelliJ, …), VS Code/Cursor/Windsurf/VSCodium
// recents, and the usual code folders (~/projects, ~/PhpstormProjects, ~/dev, …). Window titles are split into
// tokens (e.g. PhpStorm "myshop – payments", VS Code "file.ts - myapp - Visual Studio Code") and matched by folder
// name. Port of overlay/Sources/Projects.swift with Linux config paths.

export const PROJECT_ROOTS = ["projects", "Projects", "PhpstormProjects", "IdeaProjects", "WebstormProjects", "PycharmProjects",
  "GolandProjects", "RiderProjects", "AndroidStudioProjects", "Developer", "dev", "code", "Code", "src", "workspace", "repos",
  "Sites", "Documents/GitHub", "Documents/Projects", "Desktop", "git", "work"];

const MARKERS = [".git", "package.json", "composer.json", "Package.swift", "Podfile", "build.gradle", "pubspec.yaml", "Cargo.toml",
  "go.mod", "pyproject.toml"];

/** Terminal emulators (their windows aren't projects; Autopilot never reads them). macOS list + Linux terminals. */
export const TERMINAL_APPS = new Set(["terminal", "iterm2", "warp", "ghostty", "kitty", "alacritty", "wezterm", "hyper", "tabby", "rio",
  "wave", "gnome-terminal", "gnome-terminal-server", "org.gnome.terminal", "console", "kgx", "org.gnome.console", "ptyxis",
  "org.gnome.ptyxis", "konsole", "org.kde.konsole", "xterm", "uxterm", "urxvt", "rxvt", "st", "st-256color", "foot", "footclient",
  "tilix", "terminator", "xfce4-terminal", "lxterminal", "mate-terminal", "qterminal", "sakura", "terminology", "guake", "tilda",
  "yakuake", "blackbox", "com.raggesilver.blackbox", "contour", "cool-retro-term", "deepin-terminal", "termite", "org.wezfurlong.wezterm",
  "com.mitchellh.ghostty"]);

export const isTerminal = (w: { app?: string; appId?: string }) =>
  TERMINAL_APPS.has((w.app ?? "").toLowerCase()) || TERMINAL_APPS.has((w.appId ?? "").toLowerCase());

export class ProjectResolver {
  private byName = new Map<string, string>(); // lowercased folder name → path (first source wins)
  private lastRefresh = 0;
  private building = false;

  constructor(private home = homedir(), private config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")) {}

  /** Rebuilds the index in the background (scanning folders takes a while); lookups use the last index meanwhile. */
  refreshIfStale(now = Date.now()) {
    if (now - this.lastRefresh <= 300_000 || this.building) return;
    this.lastRefresh = now;
    this.building = true;
    this.buildIndex().then((map) => {
      this.byName = map;
      log(`projects indexed: ${map.size}`);
    }).finally(() => (this.building = false));
  }

  /** Builds and installs the index now (tests, first launch). */
  async refresh() {
    this.lastRefresh = Date.now();
    this.byName = await this.buildIndex();
    return this.byName;
  }

  async buildIndex(): Promise<Map<string, string>> {
    const found: string[] = [...this.jetbrainsRecents(), ...this.vscodeRecents()];
    for (const root of PROJECT_ROOTS) {
      const dir = join(this.home, root);
      const kids = await dirs(dir);
      for (const kid of kids) {
        found.push(kid);
        // One level deeper for grouped layouts like ~/projects/ios/MyApp.
        const grand = await dirs(kid);
        if (grand.length < 60) found.push(...grand.filter((g) => this.isProject(g)));
      }
    }
    const map = new Map<string, string>();
    for (const path of found) {
      const key = basename(path).toLowerCase();
      if (!map.has(key) && existsSync(path)) map.set(key, path);
    }
    return map;
  }

  project(window: Pick<DesktopWindow, "title"> | null | undefined): string | null {
    if (!window?.title) return null;
    this.refreshIfStale();
    for (const token of tokens(window.title)) {
      // Some IDEs show the path itself, e.g. "myshop [~/PhpstormProjects/myshop]".
      if (token.startsWith("/") || token.startsWith("~")) {
        const path = token.startsWith("~") ? join(this.home, token.slice(1)) : token;
        try {
          const st = statSync(path);
          return this.gitRoot(st.isDirectory() ? path : dirname(path));
        } catch {}
      }
      const hit = this.byName.get(token.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  /** Projects of the windows currently on screen (editors etc.), front-most first. */
  openWindowProjects(windows: DesktopWindow[]): string[] {
    const out: string[] = [];
    for (const w of windows) {
      if (isTerminal(w)) continue;
      const p = this.project(w);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  isProject(path: string): boolean {
    if (MARKERS.some((m) => existsSync(join(path, m)))) return true;
    try { return readdirSync(path).some((k) => k.endsWith(".xcodeproj") || k.endsWith(".xcworkspace")); } catch { return false; }
  }

  gitRoot(path: string): string {
    let dir = path;
    while (dir !== "/" && dir !== this.home && dir !== ".") {
      if (existsSync(join(dir, ".git"))) return dir;
      dir = dirname(dir);
    }
    return path;
  }

  /** ~/.config/JetBrains/<Product><version>/options/recentProjects.xml (newest versions first). */
  jetbrainsRecents(): string[] {
    const base = join(this.config, "JetBrains");
    let products: string[] = [];
    try { products = readdirSync(base).sort().reverse(); } catch {}
    const paths: string[] = [];
    for (const product of products) {
      let xml: string;
      try { xml = readFileSync(join(base, product, "options", "recentProjects.xml"), "utf8"); } catch { continue; }
      for (const m of xml.matchAll(/<entry key="([^"]+)"/g)) paths.push(m[1].replaceAll("$USER_HOME$", this.home));
    }
    return paths;
  }

  /** VS Code family: ~/.config/<Editor>/User/globalStorage/storage.json (and the Flatpak copies). */
  vscodeRecents(): string[] {
    const editors = ["Code", "Cursor", "Windsurf", "VSCodium", "Code - OSS"];
    const files = editors.map((e) => join(this.config, e, "User/globalStorage/storage.json"));
    files.push(join(this.home, ".var/app/com.visualstudio.code/config/Code/User/globalStorage/storage.json"));
    files.push(join(this.home, ".var/app/com.vscodium.codium/config/VSCodium/User/globalStorage/storage.json"));
    const paths: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const m of text.matchAll(/file:\/\/(\/[^"]+)/g)) {
        try { paths.push(decodeURIComponent(m[1])); } catch {}
      }
    }
    return paths;
  }
}

/** Title → candidate names: a bracketed path first, then the parts between –, —, |, and " - ". */
export function tokens(title: string): string[] {
  const out: string[] = [];
  const bracket = /\[([^\]]+)\]/.exec(title);
  if (bracket) out.push(bracket[1]);
  const cleaned = title.replace(/\[[^\]]*\]/g, "");
  for (const part of cleaned.split(/[–—|]/).flatMap((p) => p.split(" - "))) {
    const t = part.trim().replace(/^[●•*]+|[●•*]+$/g, "").trim();
    if (t) out.push(t);
  }
  return out;
}

async function dirs(dir: string): Promise<string[]> {
  try {
    const kids = await readdir(dir, { withFileTypes: true });
    return kids.filter((k) => !k.name.startsWith(".") && (k.isDirectory() || (k.isSymbolicLink() && isDir(join(dir, k.name))))).map((k) => join(dir, k.name));
  } catch {
    return [];
  }
}

function isDir(p: string) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
