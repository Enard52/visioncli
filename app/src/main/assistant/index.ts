import { EventEmitter } from "node:events";
import type { AnswerHandlers, AssistantSession, Lane, PermissionAnswer, Question, Sessions, TerminalContext } from "../contracts";
import { MenuLabels } from "../core/labels";
import { mcpCommand } from "../features/integrations";
import { log } from "../log";
import { settings } from "../settings";
import { activity as sharedActivity, type BufferedActivity } from "../terminal/activity";
import { setSearchPath, TerminalLauncher } from "../terminal/launcher";
import { assistantName, cliFor, type Cli } from "../terminal/transcripts";
import { AgyModels, AgySession, AgySetup } from "./agy";
import { ClaudeSession } from "./claude";
import { resolveConfig, type AssistantConfig, type BackgroundSession, type ConfigOptions } from "./config";
import { describe, permissionPreview, permissionTitle, type PermissionInfo } from "./describe";
import { GeminiSession } from "./gemini";
import { TerminalSession } from "./terminal";

// The assistant sessions questions go to (App+Sessions.swift): warm background sessions for bubble mode (at most 4,
// per project, lane and assistant), and the user's terminal CLI for terminal mode.
//
// Activity feed: the sessions write tool calls, tool results, streamed text and approvals to it themselves (they
// have the full tool input); the app writes the question (activity.question), the outcome (activity.done / error)
// and notes, as macOS's App+Questions does.

export { AgyModels, AgySetup } from "./agy";
export { ClaudeSession } from "./claude";
export { GeminiSession, geminiAttachable, geminiFriendlyError } from "./gemini";
export { TerminalSession, stableHash } from "./terminal";
export { describe, permissionPreview, permissionTitle } from "./describe";
export { autoAllowedTools, geminiVoicePrompt, terminalPrompt, voiceSystemPrompt } from "./prompts";
export { resolveConfig, type AssistantConfig } from "./config";

/** Wraps a background session in the contract's ask/handlers shape, adding approvals and the activity feed. */
class Bridge implements AssistantSession {
  private h: AnswerHandlers | null = null;
  private cost: number | undefined;

  constructor(readonly s: BackgroundSession, private owner: AssistantSessions) {
    s.events = {
      toolStart: (name) => this.h?.onTool(name), // text before this was narration: drop it, show the loader again
      toolUse: (name, input) => {
        if (!this.h) return;
        this.h.onTool(name, describe(name, input));
        owner.activity.tool(name, input);
      },
      toolResult: (text, isError, tool) => { if (this.h) owner.activity.toolResult(text, isError, tool); },
      delta: (t) => {
        if (!this.h) return;
        this.h.onText(t);
        owner.activity.text(t);
      },
      permission: (req) => this.permission(req),
      cost: (usd) => { this.cost = usd; },
      rateLimit: (info) => this.h?.onRateLimit?.(info),
      done: (result, error) => {
        const h = this.h;
        this.h = null;
        if (!h) return;
        if (error !== null) h.onError(error);
        else h.onDone({ text: result ?? "", costUsd: this.cost, sessionId: this.s.sessionId });
        this.cost = undefined;
      },
    };
  }

  get busy() { return this.s.busy; }
  get cwd() { return this.s.cwd; }
  sessionId() { return this.s.sessionId; }

  ask(q: Question, h: AnswerHandlers) {
    this.h = h;
    this.cost = undefined;
    this.owner.current = this;
    this.s.send(q.text, q.images);
  }

  warm() { this.s.warm(); }
  stop() { this.h = null; if (this.s.busy) this.s.stop(); }
  close() { this.h = null; this.s.stop(); }

  private permission(req: PermissionInfo) {
    const allowed = this.owner.alwaysAllow.get(this.s.cwd);
    if (allowed?.has(req.tool)) { this.s.respond(req, true); return; }
    const h = this.h;
    if (!h) { this.s.respond(req, false); return; } // nobody is looking at this session's bubble
    const title = permissionTitle(req, assistantName(settings.get("assistant")));
    this.owner.activity.permission(title, null);
    h.onPermission({ tool: req.tool, summary: title, preview: permissionPreview(req) }).then(
      (answer: PermissionAnswer) => {
        const allow = answer !== "deny";
        if (answer === "allowAll") {
          const set = this.owner.alwaysAllow.get(this.s.cwd) ?? new Set<string>();
          set.add(req.tool);
          this.owner.alwaysAllow.set(this.s.cwd, set);
        }
        this.s.keepRule = answer === "allowAll";
        this.s.respond(req, allow);
        this.owner.activity.permission(title, allow);
        log(`permission ${req.tool}: ${allow ? "allowed" : "denied"}`);
      },
      () => this.s.respond(req, false),
    );
  }
}

export interface SessionsOptions extends ConfigOptions {
  activity?: BufferedActivity;
}

export class AssistantSessions extends EventEmitter implements Sessions {
  readonly cfg: AssistantConfig;
  readonly activity: BufferedActivity;
  /** project → tools approved for the session ("Allow all"). */
  readonly alwaysAllow = new Map<string, Set<string>>();
  /** The background session asked last (continueInTerminal, eviction). */
  current: Bridge | null = null;
  private sessions = new Map<string, Bridge>();
  private terminals = new Map<string, TerminalSession>();

  constructor(opts: SessionsOptions) {
    super();
    this.cfg = resolveConfig(opts);
    this.activity = opts.activity ?? sharedActivity;
    setSearchPath(this.cfg.path);
  }

  background(project: string, lane: Lane): AssistantSession {
    return this.bridge(project, lane);
  }

  private bridge(project: string, lane: Lane): Bridge {
    const assistant = settings.get("assistant");
    if (assistant === "gemini") lane = "strong"; // Gemini CLI has no fast lane
    const key = `${assistant}:${lane}:${project}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const s: BackgroundSession = assistant === "claude" ? new ClaudeSession(project, this.cfg, lane)
      : assistant === "antigravity" ? new AgySession(project, this.cfg, lane)
      : new GeminiSession(project, this.cfg);
    const b = new Bridge(s, this);
    // Keep at most a few projects warm.
    if (this.sessions.size >= 4) {
      const victim = [...this.sessions].find(([, v]) => v !== this.current && !v.busy);
      if (victim) { victim[1].close(); this.sessions.delete(victim[0]); }
    }
    this.sessions.set(key, b);
    return b;
  }

  /** Start the background session now (at key-down) so it's warm by the time the question is asked. */
  warm(project: string, lane: Lane = "strong") { this.bridge(project, lane).warm(); }

  terminal(project: string, pointedAt?: TerminalContext | null): AssistantSession {
    // The CLI running in the terminal the user pointed at wins; otherwise the chosen assistant.
    const cli = pointedAt?.assistant ?? cliFor(settings.get("assistant"));
    const t = this.terminalFor(project, cli);
    if (pointedAt && pointedAt.assistant === cli) t.attach(pointedAt);
    return t;
  }

  terminalFor(project: string, cli: Cli = cliFor(settings.get("assistant"))): TerminalSession {
    const key = `${cli}:${project}`;
    const existing = this.terminals.get(key);
    if (existing) return existing;
    const t = new TerminalSession(project, cli, this.cfg, {
      activity: this.activity,
      fallback: (q, h, reason) => {
        this.emit("notice", `${reason} Answering in the bubble instead.`);
        this.background(project, q.lane).ask(q, h);
      },
    });
    this.terminals.set(key, t);
    return t;
  }

  /** Send a /model or /effort change to the Claude running in the terminal, so the menu and the terminal agree. */
  async propagate(cmd: string, project: string): Promise<boolean> {
    if (!settings.get("terminalMode") || settings.get("assistant") !== "claude") return false;
    const t = this.terminalFor(project, "claude");
    const ok = await t.command(cmd);
    if (!ok) log(`terminal: no running claude for ${t.project}; ${cmd} applies when one starts`);
    return ok;
  }

  /** The terminal changed its model itself (/model there): follow it in the menu. In bubble mode too: the background
   *  session should use the model the user's terminal Claude is on. */
  async syncModelFromTerminal(project: string): Promise<void> {
    if (settings.get("assistant") !== "claude" || this.cfg.model) return;
    const t = this.terminalFor(project, "claude");
    await t.findRunning();
    const used = t.lastModel();
    const family = used ? MenuLabels.followedModel(used, settings.get("model")) : null;
    if (!used || !family) return;
    log(`model: terminal is on ${used}; menu follows`);
    settings.set("model", family);
  }

  /** "Show live activity". */
  showActivity() { return TerminalLauncher.showActivity(); }

  /** Menu: show the assistant's terminal for this project. */
  showTerminal(project: string) { return this.terminalFor(project).bringToFront(); }

  async continueInTerminal(project: string): Promise<void> {
    const cur = this.current?.cwd === project ? this.current : [...this.sessions.values()].find((b) => b.cwd === project && b.sessionId());
    const sid = cur?.sessionId();
    if (!cur || !sid) return;
    let r;
    if (cur.s.kind === "agy" && this.cfg.agy) r = await TerminalLauncher.runCli(cur.cwd, [this.cfg.agy, "--conversation", sid]);
    else if (cur.s.kind === "gemini" && this.cfg.gemini) r = await TerminalLauncher.runCli(cur.cwd, [this.cfg.gemini, "--resume", sid]);
    else r = await TerminalLauncher.continueSession(cur.cwd, sid, this.cfg.claude);
    if (!r.ok) this.emit("notice", `Couldn't open a terminal: ${r.problem}.`);
  }

  /** Forget the conversations (menu: New Conversation). Like macOS, every project's: the menu item isn't per project. */
  newConversation(_project: string) {
    AgySetup.clearSessionRules();
    for (const b of this.sessions.values()) b.s.reset();
    for (const t of this.terminals.values()) t.reset();
    this.alwaysAllow.clear();
  }

  closeAll() {
    for (const b of this.sessions.values()) b.close();
    for (const t of this.terminals.values()) t.close();
    this.sessions.clear();
    AgySetup.clearSessionRules();
  }

  /** Register visioncli with agy (MCP config + allow rules) and cache its models. */
  setupAgy() {
    if (!this.cfg.agy) return;
    try { const [cmd, ...args] = mcpCommand(this.cfg.node, this.cfg.server || null); AgySetup.install(cmd, args); } catch (e) { log(`agy setup failed: ${e}`); }
    void AgyModels.refresh(this.cfg);
  }
}

export function createSessions(opts: SessionsOptions): AssistantSessions {
  return new AssistantSessions(opts);
}
