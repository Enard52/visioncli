import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { log } from "../log";
import { SUP } from "../paths";

// Launch configuration (Support.swift Config): the default project, the CLIs, PATH, and how to run the MCP server.
// `visioncli voice` writes SUP/overlay.json (or passes --cwd … flags); a downloaded app configures itself.

export interface AppConfig {
  cwd: string;              // fallback project when the window under the pointer doesn't map to one
  claude: string;
  path: string;
  /** Node.js 18+ (or the packaged app's visioncli-mcp wrapper, or a wrapper running Electron as Node). */
  node: string | null;
  /** The MCP server's entry; null when `node` is the visioncli-mcp wrapper (it runs the bundled server itself). */
  server: string | null;
  model: string | null;
  locale: string | null;
  gemini: string | null;
  agy: string | null;
}

export const OVERLAY_JSON = join(SUP, "overlay.json");
const home = homedir();

const isExec = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** Launch flags (`--cwd … --claude … --path … --node … --server … --model … --locale …`); null without --cwd. */
export function parseArgs(argv: string[]): Partial<AppConfig> | null {
  if (!argv.includes("--cwd")) return null;
  const c: Partial<AppConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--cwd": if (v) c.cwd = v; i++; break;
      case "--claude": if (v) c.claude = v; i++; break;
      case "--path": if (v) c.path = v; i++; break;
      case "--node": c.node = v ?? null; i++; break;
      case "--server": c.server = v ?? null; i++; break;
      case "--model": c.model = v ?? null; i++; break;
      case "--locale": c.locale = v ?? null; i++; break;
    }
  }
  return c;
}

/** Where Node, claude, uv and whisper usually live; apps started from a menu or systemd get a minimal PATH. */
export function commonPath(h = home): string {
  const dirs = [join(h, ".local/bin"), "/usr/local/bin", join(h, ".volta/bin"), join(h, ".asdf/shims"), join(h, ".bun/bin"),
    join(h, ".claude/local"), join(h, ".npm-global/bin"), join(h, ".cargo/bin")];
  // nvm / fnm installs: newest version first
  for (const base of [join(h, ".nvm/versions/node"), join(h, ".local/share/fnm/node-versions")]) {
    let versions: string[] = [];
    try { versions = readdirSync(base); } catch {}
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    dirs.push(...versions.map((v) => base.endsWith("fnm/node-versions") ? join(base, v, "installation/bin") : join(base, v, "bin")));
  }
  return [...dirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/snap/bin"].join(":");
}

/** The newest Node.js 18+ on `path` (an old system node often shadows nvm installs). */
export function findNode(path: string, version: (bin: string) => string | null = nodeVersion): string | null {
  let best: { p: string; v: number[] } | null = null;
  for (const dir of path.split(":")) {
    const p = join(dir, "node");
    if (!dir || !isExec(p)) continue;
    const v = (version(p) ?? "").trim().replace(/^v/, "").split(".").map(Number);
    if (!(v[0] >= 18)) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { p, v };
  }
  return best?.p ?? null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function nodeVersion(bin: string): string | null {
  const r = spawnSync(bin, ["-v"], { encoding: "utf8", timeout: 4000 });
  return r.status === 0 ? r.stdout : null;
}

export const find = (name: string, path: string) => path.split(":").filter(Boolean).map((d) => join(d, name)).find(isExec) ?? null;

export function findClaude(path: string): string | null {
  const dirs = [...path.split(":"), join(home, ".local/bin"), join(home, ".claude/local"), "/usr/local/bin"];
  return dirs.filter(Boolean).map((d) => join(d, "claude")).find(isExec) ?? null;
}

/** A tiny script that runs this Electron as Node (no Node.js installed, unpackaged): `ELECTRON_RUN_AS_NODE=1 electron …`. */
export function electronNodeWrapper(execPath: string, dir = SUP): string {
  const file = join(dir, "electron-node");
  const body = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${execPath.replace(/'/g, "'\\''")}' "$@"\n`;
  let old = "";
  try { old = readFileSync(file, "utf8"); } catch {}
  if (old !== body) { mkdirSync(dir, { recursive: true }); writeFileSync(file, body); chmodSync(file, 0o755); }
  return file;
}

export interface LoadOptions {
  argv: string[];
  packaged: boolean;
  /** Electron's process.resourcesPath (packaged) */
  resourcesPath?: string;
  /** build/ (where main.js is): the dev build has the server at build/server/index.mjs */
  buildDir: string;
  execPath: string;
  file?: string;
}

/** Launch arguments win and are remembered; otherwise overlay.json; anything missing is found on this computer. */
export function loadConfig(o: LoadOptions): AppConfig {
  const file = o.file ?? OVERLAY_JSON;
  let c: Partial<AppConfig> = {};
  let firstRun = false;
  const args = parseArgs(o.argv);
  if (args) {
    c = args;
  } else {
    try { c = JSON.parse(readFileSync(file, "utf8")); } catch { firstRun = true; }
  }
  const cfg: AppConfig = {
    cwd: c.cwd || home, claude: c.claude || "claude", path: c.path || process.env.PATH || "/usr/bin:/bin",
    node: c.node ?? null, server: c.server ?? null, model: c.model ?? null, locale: c.locale ?? null,
    gemini: c.gemini ?? null, agy: c.agy ?? null,
  };
  if (!cfg.path.includes(".local/bin")) cfg.path = cfg.path + ":" + commonPath();
  const wrapper = !!cfg.node && basename(cfg.node) === "visioncli-mcp" && isExec(cfg.node);
  const bundled = o.packaged && o.resourcesPath ? join(o.resourcesPath, "server", "index.mjs") : join(o.buildDir, "server", "index.mjs");
  if (!wrapper && (!cfg.server || !existsSync(cfg.server))) cfg.server = existsSync(bundled) ? bundled : cfg.server;
  if (!wrapper && (!cfg.node || !isExec(cfg.node))) {
    cfg.node = findNode(cfg.path);
    if (!cfg.node) {
      const mcp = join(home, ".local/bin/visioncli-mcp");
      if (o.packaged && isExec(mcp)) { cfg.node = mcp; cfg.server = null; }
      else cfg.node = electronNodeWrapper(o.execPath);
    }
  }
  if (!cfg.claude.startsWith("/") || !isExec(cfg.claude)) cfg.claude = findClaude(cfg.path) ?? cfg.claude;
  if (!cfg.gemini || !isExec(cfg.gemini)) cfg.gemini = find("gemini", cfg.path);
  if (!cfg.agy || !isExec(cfg.agy)) cfg.agy = find("agy", cfg.path);
  if (args || firstRun) {
    try { mkdirSync(SUP, { recursive: true }); writeFileSync(file, JSON.stringify(cfg)); } catch {}
  }
  log(`launch: default project ${cfg.cwd}, claude ${cfg.claude}, node ${cfg.node}, server ${cfg.server ?? "(wrapper)"}`);
  return cfg;
}

/** Arguments to run the server's CLI (`quick`, `route`, `warm`, `browse`): [server, ...args] or just args (wrapper). */
export const serverArgs = (cfg: Pick<AppConfig, "server">, args: string[]) => (cfg.server ? [cfg.server, ...args] : args);
