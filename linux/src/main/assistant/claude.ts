import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Lane } from "../contracts";
import { LineSplitter, JSONLines } from "../core/transcript";
import { log } from "../log";
import { settings } from "../settings";
import { cliEnvironment, lastLines, noEvents, TailText, type AssistantConfig, type BackgroundSession } from "./config";
import type { PermissionInfo } from "./describe";
import { autoAllowedTools, voiceSystemPrompt } from "./prompts";

// One long-lived `claude` process per project, driven over stream-json so follow-ups don't pay startup cost
// (Claude.swift ClaudeSession). Permission prompts come back as control_request messages (--permission-prompt-tool stdio).

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

export class ClaudeSession implements BackgroundSession {
  readonly kind = "claude";
  events = noEvents();
  private proc: ChildProcess | null = null;
  private _busy = false;
  private model: string;
  private effort: string | null;
  private toolNames = new Map<string, string>();
  private _sessionId: string | undefined;
  /** Writes to stdin in order: building a screenshot message reads files, which is async. */
  private writes: Promise<void> = Promise.resolve();

  /** The fast lane (smart routing) answers light questions with Haiku at low effort, in its own conversation. */
  constructor(readonly cwd: string, private cfg: AssistantConfig, readonly lane: Lane = "strong") {
    this.model = this.wantedModel;
    this.effort = this.wantedEffort;
    this._sessionId = settings.getStore<string>(this.storeKey) ?? undefined;
  }

  private get storeKey() { return this.lane === "fast" ? `backgroundSession:fast:${this.cwd}` : `backgroundSession:${this.cwd}`; }
  private get wantedModel() { return this.lane === "fast" ? "haiku" : (this.cfg.model ?? settings.get("model")); }
  private get wantedEffort() { return this.lane === "fast" ? "low" : settings.get("effort"); }

  get busy() { return this._busy; }
  // Persisted so a restart (e.g. after a crash) resumes the same conversation.
  get sessionId() { return this._sessionId; }
  private set sessionId(v: string | undefined) {
    if (v === this._sessionId) return;
    this._sessionId = v;
    settings.setStore(this.storeKey, v);
  }

  get isRunning() { return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null; }

  /** Start the process ahead of time (when the hotkey goes down) so it's warm by the time we ask. */
  warm() { if (!this.isRunning) this.start(); }

  send(text: string, images: string[]) {
    if (this._busy) this.restart(); // a new question interrupts the old one; --resume keeps the conversation
    const wanted = this.wantedModel;
    if (wanted !== this.model || this.wantedEffort !== this.effort) { this.model = wanted; this.effort = this.wantedEffort; this.restart(); }
    if (!this.isRunning) this.start();
    this._busy = true;
    // base64 of the screenshots is a megabyte or more: read them without blocking the main process.
    this.write(async () => {
      const content: Obj[] = [];
      for (const f of images) {
        try { content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(f)).toString("base64") } }); }
        catch (e) { log(`claude: couldn't read screenshot ${f}: ${e}`); }
      }
      content.push({ type: "text", text });
      return { type: "user", message: { role: "user", content } };
    });
    log(`ask (${this.cwd}): ${text.slice(0, 300)}`);
  }

  respond(req: PermissionInfo, allow: boolean) {
    const response = allow
      ? { behavior: "allow", updatedInput: req.input }
      : { behavior: "deny", message: "The user declined this. Don't retry it; tell them what you would have done instead." };
    this.write(async () => ({ type: "control_response", response: { subtype: "success", request_id: req.id, response } }));
  }

  /** Forget the conversation (menu: New Conversation). */
  reset() {
    this.stop();
    this.sessionId = undefined;
  }

  stop() {
    this._busy = false;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) p.kill("SIGTERM");
  }

  private restart() {
    this.stop();
    this.start();
  }

  /** The command line (exported for tests: the flags matter). */
  args(): string[] {
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", "stdio", "--permission-mode", "default",
      "--append-system-prompt", voiceSystemPrompt,
      ...(this.model === "default" ? [] : ["--model", this.model]), // "default": the user's own Claude Code default
      ...(this.effort ? ["--effort", this.effort] : []),
      // Lean session: only the built-in tools voice mode uses (about half the input tokens of the full set),
      // and no plugin hooks (their per-session output also defeats prompt caching).
      "--tools", "Read,Grep,Glob,Edit,Write,Bash",
      "--settings", `{"disableAllHooks": true}`,
      "--allowedTools", ...autoAllowedTools,
    ];
    // No server: `node` is the packaged app's visioncli-mcp wrapper, which runs the bundled server itself.
    if (this.cfg.node) {
      const mcp = { mcpServers: { visioncli: { command: this.cfg.node, args: this.cfg.server ? [this.cfg.server] : [] } } };
      args.push("--mcp-config", JSON.stringify(mcp), "--strict-mcp-config");
    }
    if (this._sessionId) args.push("--resume", this._sessionId);
    return args;
  }

  private start() {
    let p: ChildProcess;
    try {
      p = spawn(this.cfg.claude, this.args(), { cwd: this.cwd, env: cliEnvironment(this.cfg), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      log(`failed to start claude: ${e}`);
      this.events.done(null, `Couldn't start claude at ${this.cfg.claude}: ${e}`);
      return;
    }
    this.proc = p;
    this.writes = Promise.resolve();
    const lines = new LineSplitter();
    const stderrTail = new TailText();
    p.stdout!.on("data", (chunk: Buffer) => {
      lines.feed(chunk, (line) => {
        const o = JSONLines.object(line);
        if (o && this.proc === p) this.handle(o);
      });
    });
    p.stderr!.on("data", (d: Buffer) => stderrTail.append(d.toString("utf8")));
    p.stdin!.on("error", (e) => log(`write to claude failed: ${e}`));
    p.on("error", (e) => {
      log(`failed to start claude: ${e}`);
      if (this.proc !== p) return;
      this.proc = null;
      this._busy = false;
      this.events.done(null, `Couldn't start claude at ${this.cfg.claude}: ${e.message}`);
    });
    p.on("close", (code, signal) => {
      const errText = stderrTail.value;
      log(`claude exited ${code ?? signal}${errText ? ": " + errText.slice(-400) : ""}`);
      if (this.proc !== p) return;
      this.proc = null;
      if (this._busy) {
        this._busy = false;
        const tail = lastLines(errText, 3);
        this.events.done(null, tail || `Claude stopped unexpectedly (exit ${code ?? signal}).`);
      }
    });
    log(`claude started in ${this.cwd} (model ${this.model}${this._sessionId ? `, resume ${this._sessionId}` : ""})`);
  }

  /** Writes to claude's stdin happen in order: a screenshot message is far bigger than the pipe buffer. */
  private write(make: () => Promise<Obj>) {
    const p = this.proc;
    if (!p?.stdin) return;
    this.writes = this.writes.then(async () => {
      const msg = await make();
      if (p.stdin!.writable) p.stdin!.write(JSON.stringify(msg) + "\n");
    }).catch((e) => log(`write to claude failed: ${e}`));
  }

  /** One stream-json line from claude (exported via the class for tests). */
  handle(o: Obj) {
    if (typeof o.session_id === "string") this.sessionId = o.session_id;
    switch (o.type) {
      case "rate_limit_event":
        if (o.rate_limit_info && typeof o.rate_limit_info === "object") this.events.rateLimit(o.rate_limit_info);
        break;
      case "stream_event": {
        if (o.parent_tool_use_id != null) return; // a subagent's stream
        const ev = obj(o.event);
        if (ev.type === "content_block_start" && obj(ev.content_block).type === "tool_use") {
          this.events.toolStart(String(obj(ev.content_block).name ?? ""));
        }
        const d = obj(ev.delta);
        if (ev.type === "content_block_delta" && d.type === "text_delta" && typeof d.text === "string") this.events.delta(d.text);
        break;
      }
      case "assistant":
        for (const block of arr(obj(o.message).content)) {
          if (block.type !== "tool_use") continue;
          const name = typeof block.name === "string" ? block.name : "";
          if (typeof block.id === "string") this.toolNames.set(block.id, name);
          this.events.toolUse(name, obj(block.input));
        }
        break;
      case "user":
        for (const block of arr(obj(o.message).content)) {
          if (block.type !== "tool_result") continue;
          let text = "";
          if (typeof block.content === "string") text = block.content;
          else if (Array.isArray(block.content)) {
            text = arr(block.content).map((p) => (typeof p.text === "string" ? p.text : p.type === "image" ? "[image]" : "")).join("\n");
          }
          const tool = typeof block.tool_use_id === "string" ? this.toolNames.get(block.tool_use_id) ?? null : null;
          this.events.toolResult(text, block.is_error === true, tool);
        }
        break;
      case "control_request": {
        const id = o.request_id, req = obj(o.request);
        if (typeof id !== "string" || !o.request) return;
        if (req.subtype === "can_use_tool") {
          const r: PermissionInfo = { id, tool: typeof req.tool_name === "string" ? req.tool_name : "", input: obj(req.input) };
          log(`permission requested: ${r.tool}`);
          this.events.permission(r);
        } else {
          this.write(async () => ({ type: "control_response", response: { subtype: "error", request_id: id, error: "unsupported" } }));
        }
        break;
      }
      case "result": {
        this._busy = false;
        if (typeof o.total_cost_usd === "number") this.events.cost(o.total_cost_usd);
        const isError = o.is_error === true;
        const result = typeof o.result === "string" ? o.result : null;
        log(`result: ${(result ?? "").slice(0, 200)}`);
        this.events.done(isError ? null : result, isError ? (result ?? "Something went wrong") : null);
        break;
      }
    }
  }
}
