import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../log";
import { SUP } from "../paths";
import type { Assistant } from "../settings";
import { run, userPath, which, withPath } from "./run";

// Connecting VisionCLI's MCP tools (look, click, browser…) to the AI CLIs, and integrations.json (API keys).
// Port of connectTools / toolsConnected / setupClaudeCode / setupGemini (App+Setup.swift), AgySetup (Agy.swift) and
// openIntegrations (App+MenuActions.swift). integrations.json holds secrets: it's created and opened, never read here.

export const INTEGRATIONS_FILE = join(SUP, "integrations.json");

export interface Tools { node: string | null; server: string | null; claude: string | null; gemini: string | null; agy: string | null; path: string }

/** Finds the CLIs on the user's PATH (+ the usual install folders). `server` is the bundled MCP server (build/server/index.mjs).
 *  On Windows they're claude.exe (native installer) or npm's claude.cmd / gemini.cmd shims: `which` follows PATHEXT and
 *  `run` unwraps the shims, so the arguments reach the CLI unchanged (no shell). */
export async function findTools(server: string | null): Promise<Tools> {
  const path = userPath();
  const claude = which("claude", path) ?? (existsSync(join(homedir(), ".claude/local/claude")) ? join(homedir(), ".claude/local/claude") : null);
  let node = which("node", path);
  if (node) {
    // Node 18 or later (an older one is ignored, like the macOS app).
    const v = await run(node, ["--version"], { timeout: 5000 });
    const major = Number(/^v(\d+)/.exec(v.out.trim())?.[1] ?? 0);
    if (major < 18) node = null;
  }
  return { node, server: server && existsSync(server) ? server : null, claude, gemini: which("gemini", path), agy: which("agy", path), path };
}

const envWith = (path: string) => withPath(path);
const firstError = (r: { out: string; err: string }) => (r.err.trim() ? r.err : r.out).trim();

/** The command line the CLIs start the MCP server with. No server: `node` is the packaged app's visioncli-mcp wrapper
 *  (it runs the bundled server). On Windows a .cmd wrapper can't be started without a shell, which the CLIs don't use
 *  for MCP servers, so it goes through `cmd /c` (what Claude Code's docs ask for on Windows). */
export function mcpCommand(node: string, server: string | null, platform: string = process.platform): string[] {
  const command = [node, ...(server ? [server] : [])];
  return platform === "win32" && /\.(cmd|bat)$/i.test(node) ? ["cmd", "/c", ...command] : command;
}

/** Connects VisionCLI's MCP tools to one CLI, for all projects. Resolves with null on success, or what went wrong. */
export async function connectTools(a: Assistant, t: Tools): Promise<string | null> {
  if (!t.node) return "Needs Node.js 18 or later (nodejs.org).";
  const command = mcpCommand(t.node, t.server);
  const env = envWith(t.path);
  switch (a) {
    case "claude": {
      if (!t.claude) return "Claude Code CLI isn't installed (https://claude.com/claude-code).";
      await run(t.claude, ["mcp", "remove", "visioncli", "-s", "user"], { env });
      const r = await run(t.claude, ["mcp", "add", "visioncli", "--scope", "user", "--", ...command], { env });
      return r.code === 0 ? null : firstError(r);
    }
    case "gemini": {
      if (!t.gemini) return "Gemini CLI isn't installed.";
      await run(t.gemini, ["mcp", "remove", "-s", "user", "visioncli"], { env });
      // Trusted so its read-only tools also work in headless (bubble-only) mode, which can't ask for confirmation.
      const r = await run(t.gemini, ["mcp", "add", "-s", "user", "--trust", "visioncli", ...command], { env });
      return r.code === 0 ? null : firstError(r);
    }
    case "antigravity":
      if (!t.agy) return "Antigravity isn't installed.";
      try { const [cmd, ...args] = mcpCommand(t.node, t.server); AgySetup.install(cmd, args); return null; } catch (e) { return (e as Error).message; }
  }
}

/** Are VisionCLI's tools already registered with this CLI? (Runs the CLI: slow.) */
export async function toolsConnected(a: Assistant, t: Tools): Promise<boolean> {
  const env = envWith(t.path);
  switch (a) {
    case "claude": return !!t.claude && (await run(t.claude, ["mcp", "get", "visioncli"], { env, timeout: 30_000 })).code === 0;
    case "gemini": return !!t.gemini && (await run(t.gemini, ["mcp", "list"], { env, timeout: 30_000 })).out.includes("visioncli");
    case "antigravity":
      try { return readFileSync(AgySetup.mcpConfig(), "utf8").includes("visioncli"); } catch { return false; }
  }
}

export function isInstalled(a: Assistant, t: Tools): boolean {
  return a === "claude" ? !!t.claude : a === "antigravity" ? !!t.agy : !!t.gemini;
}

/** The result dialog's text after connecting (setupClaudeCode / setupGemini / setupAgy). */
export function connectedMessage(a: Assistant): string {
  switch (a) {
    case "claude": return "visioncli's tools (look at screen, browser, database…) are now available in every Claude Code project. Restart any running `claude` sessions to load them.";
    case "gemini": return "visioncli's tools are now available in every Gemini CLI project. Restart any running `gemini` sessions. To answer voice questions with Gemini, choose VisionCLI menu → Settings… → Assistant → Gemini (Antigravity).";
    case "antigravity": return "visioncli's tools are now available in every agy workspace. Restart any running `agy` sessions. To answer voice questions with Gemini through Antigravity, choose VisionCLI menu → Settings… → Assistant → Gemini (Antigravity).";
  }
}

/** Creates integrations.json (0600, empty keys) if it's missing and opens it in the editor. Its contents are never read. */
export async function openIntegrations(openFile: (path: string) => Promise<void> | void, file = INTEGRATIONS_FILE) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{\n  "typesafe": { "apiKey": "" },\n  "gemini": { "apiKey": "" }\n}\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
  }
  await openFile(file);
}

// ── Antigravity CLI (Agy.swift AgySetup) ───────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const readJson = (file: string): Json => {
  try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};
/** Pretty JSON with sorted keys (JSONSerialization .prettyPrinted + .sortedKeys). */
const sortedJson = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x, 2);

export const AgySetup = {
  home: homedir(),
  mcpConfig() { return join(AgySetup.home, ".gemini/config/mcp_config.json"); },
  settings() { return join(AgySetup.home, ".gemini/antigravity-cli/settings.json"); },

  allowedTools: ["look", "list_windows", "select_region", "clipboard_image", "device_screenshot", "db_schema", "db_query",
    "browser_tabs", "browser_read", "browser_elements", "browser_open", "browser_switch_tab", "browser_navigate", "browser_scroll",
    // Computer control: VisionCLI's own approval card gates these.
    "ui_elements", "click", "type_text", "press_keys", "scroll", "drag", "open_app", "open_url"],

  /** Read-only commands Gemini may run without asking (headless agy can't ask). */
  safeCommands: ["grep", "rg", "ls", "cat", "head", "tail", "find", "wc", "pwd", "file", "stat", "tree",
    "git status", "git log", "git diff", "git show", "git branch", "git blame"],

  /** The part of a command an allow rule names: the program, plus its subcommand for tools like git/npm/php. */
  rulePrefix(command: string): string {
    const words = command.split(" ").filter(Boolean);
    if (!words.length) return command;
    const twoWord = new Set(["git", "npm", "pnpm", "yarn", "npx", "php", "python", "python3", "node", "bun", "cargo", "go", "make",
      "composer", "docker", "kubectl", "swift", "xcodebuild", "bundle", "rails", "./mvnw", "gradle"]);
    const base = words[0].slice(words[0].lastIndexOf("/") + 1);
    return twoWord.has(base) && words.length > 1 ? `${words[0]} ${words[1]}` : words[0];
  },

  editRules(change: (allow: string[]) => string[]) {
    const s = readJson(AgySetup.settings());
    const permissions = (s.permissions && typeof s.permissions === "object" ? s.permissions : {}) as Json;
    const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
    permissions.allow = change(allow);
    s.permissions = permissions;
    mkdirSync(dirname(AgySetup.settings()), { recursive: true });
    writeFileSync(AgySetup.settings(), sortedJson(s));
  },

  /** Rules approved with "Allow all this session": removed on New Conversation and when VisionCLI quits. */
  sessionRules: new Set<string>(),

  clearSessionRules() {
    if (!AgySetup.sessionRules.size) return;
    const rules = AgySetup.sessionRules;
    try { AgySetup.editRules((allow) => allow.filter((r) => !rules.has(r))); } catch {}
    log(`agy: removed session rules ${[...rules].sort().join(", ")}`);
    AgySetup.sessionRules = new Set();
  },

  addAllowRule(rule: string) { try { AgySetup.editRules((a) => (a.includes(rule) ? a : [...a, rule])); } catch {} },
  removeAllowRule(rule: string) { try { AgySetup.editRules((a) => a.filter((r) => r !== rule)); } catch {} },

  /** Registers the MCP server in ~/.gemini/config/mcp_config.json and allows its tools + safe commands. Throws on failure. */
  install(node: string, server: string | string[]) {
    const cfgFile = AgySetup.mcpConfig();
    mkdirSync(dirname(cfgFile), { recursive: true });
    const config = readJson(cfgFile);
    const servers = (config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}) as Json;
    servers.visioncli = { command: node, args: Array.isArray(server) ? server : server ? [server] : [] };
    config.mcpServers = servers;
    writeFileSync(cfgFile, sortedJson(config));
    AgySetup.editRules((allow) => {
      const out = [...allow];
      for (const tool of AgySetup.allowedTools) if (!out.includes(`mcp(visioncli/${tool})`)) out.push(`mcp(visioncli/${tool})`);
      for (const cmd of AgySetup.safeCommands) if (!out.includes(`command(${cmd})`)) out.push(`command(${cmd})`);
      return out;
    });
    log(`agy: registered visioncli MCP and ${AgySetup.allowedTools.length} allow rules`);
  },
};
