import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUP } from "../paths";
import { which } from "../terminal/launcher";
import type { Lane } from "../contracts";
import type { PermissionInfo } from "./describe";

// What the sessions need from the app (Support.swift Config), and the shape every background session shares.

export interface AssistantConfig {
  node: string;                  // Node.js 18+ for the visioncli MCP server
  server: string;                // the MCP server's entry (build/server/index.mjs)
  path: string;                  // PATH for the CLIs (the app's search path, incl. ~/.local/bin, nvm…)
  claude: string;
  agy: string | null;
  gemini: string | null;
  model: string | null;          // a --model launch flag overrides the menu
}

export type ConfigOptions = Pick<AssistantConfig, "node" | "server" | "path"> & Partial<AssistantConfig>;

/** Fills in the CLIs from PATH when the app didn't name them. */
export function resolveConfig(o: ConfigOptions): AssistantConfig {
  return {
    node: o.node, server: o.server, path: o.path, model: o.model ?? null,
    claude: o.claude ?? which("claude", o.path) ?? "claude",
    agy: o.agy !== undefined ? o.agy : which("agy", o.path),
    gemini: o.gemini !== undefined ? o.gemini : which("gemini", o.path),
  };
}

export function cliEnvironment(cfg: AssistantConfig): NodeJS.ProcessEnv {
  return { ...process.env, PATH: cfg.path };
}

/** Environment for `gemini` processes. By default `gemini` uses its own sign-in, exactly like running it yourself.
 *  Only if the user deliberately adds "gemini": {"apiKey": …} to integrations.json do VisionCLI's runs switch to
 *  API-key auth (via a system-settings override, leaving the user's Gemini settings alone). */
export function geminiEnvironment(cfg: AssistantConfig): NodeJS.ProcessEnv {
  const env = cliEnvironment(cfg);
  let key: unknown;
  try { key = JSON.parse(readFileSync(join(SUP, "integrations.json"), "utf8"))?.gemini?.apiKey; } catch {}
  if (typeof key === "string" && key) {
    env.GEMINI_API_KEY = key;
    const override = join(SUP, "gemini-system-settings.json");
    try { writeFileSync(override, `{"security":{"auth":{"selectedType":"gemini-api-key"}}}`); } catch {}
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = override;
  }
  return env;
}

/** What a background session reports (the callbacks of AssistantSession in Claude.swift). */
export interface SessionEvents {
  toolStart(name: string): void;                       // text before this was narration
  toolUse(name: string, input: Record<string, unknown>): void;
  toolResult(text: string, isError: boolean, tool: string | null): void;
  delta(text: string): void;
  permission(req: PermissionInfo): void;
  done(result: string | null, error: string | null): void;
  cost(usd: number): void;
  rateLimit(info: unknown): void;
}

export const noEvents = (): SessionEvents => ({
  toolStart() {}, toolUse() {}, toolResult() {}, delta() {}, permission() {}, done() {}, cost() {}, rateLimit() {},
});

/** A bubble-mode session: one CLI process (or one per question) for a project and lane. */
export interface BackgroundSession {
  readonly kind: "claude" | "agy" | "gemini";
  readonly cwd: string;
  readonly lane: Lane;
  readonly busy: boolean;
  readonly sessionId: string | undefined;
  events: SessionEvents;
  /** agy: keep the allow rule for an approved command ("Allow all") instead of removing it after the turn. */
  keepRule?: boolean;
  warm(): void;
  send(text: string, images: string[]): void;
  respond(req: PermissionInfo, allow: boolean): void;
  reset(): void;
  stop(): void;
}

/** The tail of a process's stderr. */
export class TailText {
  private text = "";
  append(s: string) {
    this.text += s;
    if (this.text.length > 4000) this.text = this.text.slice(-2000);
  }
  get value() { return this.text; }
}

/** The last `n` non-empty lines (Swift's split(separator:"\n").suffix(n)). */
export const lastLines = (s: string, n: number, sep = "\n") => s.split("\n").filter(Boolean).slice(-n).join(sep);
