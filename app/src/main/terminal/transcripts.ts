import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import type { Assistant } from "../settings";
import { basename } from "./procs";

// The CLIs VisionCLI drives, and where each keeps its conversation (TerminalProbe.swift's session-file half).

/** The CLI binary for each assistant setting (contracts.ts names them claude / agy / gemini). */
export type Cli = "claude" | "agy" | "gemini";
export const CLIS: Cli[] = ["claude", "agy", "gemini"];
export const cliFor = (a: Assistant): Cli => (a === "antigravity" ? "agy" : a);
export const assistantFor = (c: Cli): Assistant => (c === "agy" ? "antigravity" : c);
/** What the bubble calls it (Assistant.name). */
export const assistantName = (c: Cli | Assistant) => (c === "claude" ? "Claude" : "Gemini");

const INTERPRETERS = /^(node|nodejs|bun|deno|python3?(\.\d+)?|bash|sh|zsh|dash)$/;

/** Is this command line one of this CLI's processes (Assistant.matches)? On Linux the CLI may show up behind its
 *  interpreter (`node …/gemini`, or a wrapper script), so the script name counts too. */
export function matches(cli: Cli, args: string[]): boolean {
  const first = args[0] ? basename(args[0]) : "";
  if (!first) return false;
  let name = first;
  if (INTERPRETERS.test(first)) {
    const script = args.slice(1).find((a) => !a.startsWith("-"));
    name = script ? basename(script) : first;
  }
  return name === cli;
}

/** VisionCLI's own background runs (`claude -p --output-format stream-json`, `agy -p ""`, `gemini -p …`) aren't
 *  sessions in a terminal, even when the app was started from one and they inherit its tty. */
export function isHeadless(args: string[]): boolean {
  return args.includes("-p") || args.includes("--print") || args.includes("--output-format") || args.includes("-o");
}

const home = () => homedir();
const mtime = (f: string): number => { try { return statSync(f).mtimeMs; } catch { return 0; } };

function jsonl(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)); } catch { return []; }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Claude Code's folder name for a project: every non-alphanumeric character → "-" (C:\Users\me\proj →
 *  C--Users-me-proj); past 200 characters it's cut and suffixed with a hash of the path (Claude Code's own rule). */
export function claudeProjectKey(cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= 200) return key;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${key.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

export function claudeDir(cwd: string): string {
  const wsl = parseWslPath(cwd);
  if (wsl) return wslClaudeDir(wsl.root, wsl.linux);
  const projects = join(home(), ".claude", "projects");
  const key = claudeProjectKey(cwd);
  const dir = join(projects, key);
  // Windows paths are case-insensitive and Claude Code matches folders that way ("c:\…" vs "C:\…").
  if (process.platform === "win32" && !existsSync(dir)) {
    try {
      const hit = readdirSync(projects).find((d) => d.toLowerCase() === key.toLowerCase());
      if (hit) return join(projects, hit);
    } catch {}
  }
  return dir;
}

// ── Claude Code inside WSL ──────────────────────────────────────────────────────────────────────────────────────
// A `wsl.exe … claude` runs Linux's claude: its transcripts are inside the distro, reachable from Windows through
// \\wsl.localhost\<distro>\home\<user>\.claude\projects\<linux cwd with "-">. Such a CLI's cwd is written as that
// UNC path (\\wsl.localhost\Ubuntu\home\me\proj), which carries both the distro and the Linux folder.

/** \\wsl.localhost\<distro>\x\y (or \\wsl$\…) → the distro's root and the Linux path /x/y. */
export function parseWslPath(p: string): { distro: string; root: string; linux: string } | null {
  const m = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/i.exec(p);
  if (!m) return null;
  const linux = (m[3] ?? "/").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return { distro: m[2], root: `\\\\${m[1]}\\${m[2]}`, linux };
}

/** A Linux path in a distro, as Windows reaches it. */
export const wslUncPath = (distro: string, linux: string) => `\\\\wsl.localhost\\${distro}${linux.replace(/\//g, "\\")}`.replace(/\\$/, "");

/** The claude projects folder for `linux` (a cwd inside the distro at `root`): the home that has a transcript folder
 *  for it, else the first home with a ~/.claude (/home/*, then /root). */
export function wslClaudeDir(root: string, linux: string): string {
  const key = claudeProjectKey(linux);
  let users: string[] = [];
  try { users = readdirSync(join(root, "home")); } catch {}
  const homes = [...users.map((u) => join(root, "home", u)), join(root, "root")];
  const dirs = homes.map((h) => join(h, ".claude", "projects", key));
  return dirs.find((d) => existsSync(d)) ?? dirs[homes.findIndex((h) => existsSync(join(h, ".claude")))] ?? dirs[0];
}

/** ~/.gemini/tmp/<project id>/chats, where the id is the name in ~/.gemini/projects.json or the path's SHA-256. */
function geminiChatDirs(cwd: string): string[] {
  const names: string[] = [];
  try {
    const json = JSON.parse(readFileSync(join(home(), ".gemini/projects.json"), "utf8"));
    const name = json?.projects?.[cwd];
    if (typeof name === "string") names.push(name);
  } catch {}
  names.push(sha256(cwd));
  return names.map((n) => join(home(), ".gemini/tmp", n, "chats")).filter((d) => existsSync(d));
}

function geminiHeader(file: string): Record<string, unknown> | null {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
    return JSON.parse(first);
  } catch {
    return null;
  }
}

/** The session the CLI is writing to right now in this folder: its most recently modified session file. */
export function newestSession(cli: Cli, cwd: string): string | undefined {
  if (cli === "claude") {
    const files = jsonl(claudeDir(cwd)).sort((a, b) => mtime(b) - mtime(a));
    return files[0] ? basename(files[0]).replace(/\.jsonl$/, "") : undefined;
  }
  if (cli === "gemini") {
    const hash = sha256(cwd);
    const files = geminiChatDirs(cwd).flatMap(jsonl).sort((a, b) => mtime(b) - mtime(a));
    for (const f of files.slice(0, 10)) {
      const h = geminiHeader(f);
      if (h?.projectHash === hash && typeof h.sessionId === "string") return h.sessionId;
    }
    return undefined;
  }
  return undefined; // agy conversations aren't indexed by folder; the terminal session finds its transcript by the question text
}

/** agy keeps a JSONL transcript per conversation. */
export function agyTranscript(conversationId: string): string {
  return join(home(), ".gemini/antigravity-cli/brain", conversationId, ".system_generated/logs/transcript.jsonl");
}

/** The agy conversation whose transcript contains `marker` (the question VisionCLI just typed), written recently. */
export function agyConversation(marker: string, withinSeconds = 180): string | undefined {
  const brain = join(home(), ".gemini/antigravity-cli/brain");
  let dirs: string[] = [];
  try { dirs = readdirSync(brain); } catch { return undefined; }
  const now = Date.now();
  const recent = dirs
    .map((id) => ({ id, t: agyTranscript(id) }))
    .map((r) => ({ ...r, m: mtime(r.t) }))
    .filter((r) => r.m > 0 && now - r.m < withinSeconds * 1000)
    .sort((a, b) => b.m - a.m);
  for (const r of recent) {
    try { if (readFileSync(r.t, "utf8").includes(marker)) return r.id; } catch {}
  }
  return undefined;
}

/** The session file for a session id (Claude: <id>.jsonl; Gemini: session-<date>-<id prefix>.jsonl; agy: its transcript). */
export function sessionFile(cli: Cli, cwd: string, sessionId: string): string | undefined {
  if (cli === "claude") {
    const f = join(claudeDir(cwd), `${sessionId}.jsonl`);
    return existsSync(f) ? f : undefined;
  }
  if (cli === "gemini") {
    const prefix = sessionId.slice(0, 8);
    for (const dir of geminiChatDirs(cwd)) {
      for (const f of jsonl(dir)) if (f.endsWith(`-${prefix}.jsonl`) && geminiHeader(f)?.sessionId === sessionId) return f;
    }
    return undefined;
  }
  const t = agyTranscript(sessionId);
  return existsSync(t) ? t : undefined;
}

export const sessionMtime = (cli: Cli, cwd: string, sessionId?: string) => {
  const f = sessionId ? sessionFile(cli, cwd, sessionId) : undefined;
  return f ? mtime(f) : 0;
};

/** The enclosing git repository's root (or the folder itself), stopping at $HOME. */
export function gitRoot(path: string): string {
  let dir = path;
  // A root's dirname is itself ("/", "C:\\", "\\\\wsl.localhost\\Ubuntu\\").
  while (dir !== home() && dir !== "." && dirname(dir) !== dir) {
    if (existsSync(join(dir, ".git"))) return dir;
    dir = dirname(dir);
  }
  return path;
}

/** The model the CLI used for its latest reply (e.g. "claude-haiku-5-5"), from the last 200 KB of its transcript. */
export function lastModel(file: string): string | null {
  try {
    const size = statSync(file).size;
    const start = size > 200_000 ? size - 200_000 : 0;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
      try {
        const model = JSON.parse(line)?.message?.model;
        if (typeof model === "string" && model.startsWith("claude")) return model;
      } catch {}
    }
  } catch {}
  return null;
}
