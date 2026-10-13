import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Lane } from "../contracts";
import { LineSplitter, JSONLines } from "../core/transcript";
import { log } from "../log";
import { settings } from "../settings";
import { run } from "../terminal/mux";
import { agyTranscript } from "../terminal/transcripts";
import { basename } from "../terminal/procs";
import { cliEnvironment, lastLines, noEvents, TailText, type AssistantConfig, type BackgroundSession } from "./config";
import type { PermissionInfo } from "./describe";
import { geminiVoicePrompt } from "./prompts";

// Background (bubble-only) Gemini through Antigravity CLI (Agy.swift). One `agy` process per project stays running
// (`--input-format stream-json`): each question is a line on its stdin, so only the first one pays agy's ~10–20 s
// startup. Continues the same conversation (`--conversation <id>`) across restarts. Uses the user's own agy sign-in.
// Headless agy auto-denies tools that would need approval, so only reads and the allow-listed visioncli tools run;
// a denied command is asked for in the bubble, allowed with an agy permission rule, and the turn continues.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

const IDLE_STOP_MS = 3600_000; // an idle agy is shut down after an hour (it takes ~11 s to start)

export class AgySession implements BackgroundSession {
  readonly kind = "agy";
  events = noEvents();
  keepRule = false;
  private proc: ChildProcess | null = null;
  private launchArgs: string[] = [];    // model/effort the running process was started with
  private primed = false;               // the voice instructions went into this conversation
  private gotResult = false;
  private idleStop: NodeJS.Timeout | null = null;
  private _busy = false;
  private _sessionId: string | undefined;
  private answer = "";
  private lastStderr = "";
  /** The last tool agy started (to explain a denial), and a rule added for an approved command. */
  private lastTool: { name: string; params: Obj } | null = null;
  private pendingCommand: string | null = null;
  private tempRule: string | null = null;

  /** The fast lane (smart routing) answers light questions with Gemini Flash (Low), in its own conversation. */
  constructor(readonly cwd: string, private cfg: AssistantConfig, readonly lane: Lane = "strong") {
    this._sessionId = settings.getStore<string>(this.storeKey) ?? undefined;
  }

  private get storeKey() { return this.lane === "fast" ? `agyBackground:fast:${this.cwd}` : `agyBackground:${this.cwd}`; }
  get busy() { return this._busy; }
  get sessionId() { return this._sessionId; }
  private set sessionId(v: string | undefined) {
    if (v === this._sessionId) return;
    this._sessionId = v;
    settings.setStore(this.storeKey, v);
  }
  private get running() { return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null; }

  /** Start agy now (at key-down) so the question doesn't wait for its startup. */
  warm() {
    if (this.idleStop) clearTimeout(this.idleStop);
    if (!this.running) this.start();
    this.scheduleIdleStop();
  }

  private scheduleIdleStop() {
    if (this.idleStop) clearTimeout(this.idleStop);
    this.idleStop = setTimeout(() => {
      if (this._busy || !this.proc) return;
      log("agy: idle, stopping");
      this.stop();
    }, IDLE_STOP_MS);
    this.idleStop.unref?.();
  }

  /** Headless agy can't ask for approval, so a denied command ends its turn. When the user approves it in the
   *  bubble, allow that command (an agy permission rule) and let Gemini continue the same conversation. */
  respond(_req: PermissionInfo, allow: boolean) {
    const command = this.pendingCommand;
    if (!command) return;
    this.pendingCommand = null;
    if (allow) {
      const rule = `command(${AgySetup.rulePrefix(command)})`;
      AgySetup.addAllowRule(rule);
      if (this.keepRule) AgySetup.sessionRules.add(rule); else this.tempRule = rule;
      log(`agy: allowed ${rule}${this.keepRule ? " (kept)" : " (this time)"}`);
      this.stop(); // a running agy doesn't reread its permission rules: restart into the same conversation
      this.send(`The user approved running \`${command}\`. Run it now and continue answering the original question.`, []);
    } else {
      this.send(`The user declined running \`${command}\`. Answer as well as you can without running commands.`, []);
    }
    this.keepRule = false;
  }

  reset() {
    this.stop();
    this.sessionId = undefined;
  }

  stop() {
    this._busy = false;
    const p = this.proc;
    this.proc = null;
    try { p?.stdin?.end(); } catch {}
    if (p && p.exitCode === null) p.kill("SIGTERM");
  }

  private get modelArgs(): string[] {
    if (this.lane === "fast") return ["--model", AgyModels.fastest()];
    const m = settings.get("agyModel"), e = settings.get("effort");
    return [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])];
  }

  send(text: string, images: string[]) {
    if (!this.cfg.agy) { this.events.done(null, "Antigravity CLI (agy) wasn't found. Install Antigravity, sign in, and reopen VisionCLI."); return; }
    // A question while one is still running, or a model/effort change: start over (same conversation).
    if (this._busy || (this.running && this.launchArgs.join("\0") !== this.modelArgs.join("\0"))) this.stop();
    if (!this.running) this.start();
    const p = this.proc;
    if (!p?.stdin) return; // start() already reported why
    let prompt = this.primed ? "" : geminiVoicePrompt;
    this.primed = true;
    prompt += text;
    if (images.length) prompt += "\nScreenshot file(s) to view first: " + images.join(", ");
    this.answer = "";
    this.lastStderr = "";
    this.gotResult = false;
    if (this.idleStop) clearTimeout(this.idleStop);
    if (!p.stdin.writable) { this.stop(); this.events.done(null, "Antigravity stopped unexpectedly. Ask again."); return; }
    p.stdin.write(JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + "\n");
    this._busy = true;
    log(`ask agy (${this.cwd}, ${this._sessionId ? `conversation ${this._sessionId}` : "new"}): ${text.slice(0, 200)}`);
  }

  /** The command line (for tests). */
  args(resume: boolean): string[] {
    return ["-p", "", "--input-format", "stream-json", "--output-format", "stream-json", ...(resume ? ["--conversation", this._sessionId!] : []), ...this.launchArgs];
  }

  private start() {
    const agy = this.cfg.agy;
    if (!agy) return;
    const resume = !!this._sessionId && existsSync(agyTranscript(this._sessionId));
    this.primed = resume; // a resumed conversation already has the voice instructions
    this.launchArgs = this.modelArgs;
    let p: ChildProcess;
    try {
      p = spawn(agy, this.args(resume), { cwd: this.cwd, env: cliEnvironment(this.cfg), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.events.done(null, `Couldn't start agy: ${e}`);
      return;
    }
    this.proc = p;
    const lines = new LineSplitter(), stderrTail = new TailText();
    p.stdout!.on("data", (chunk: Buffer) => lines.feed(chunk, (line) => {
      const o = JSONLines.object(line);
      if (!o || this.proc !== p) return;
      if (o.event === "result") this.gotResult = true;
      this.handle(o);
    }));
    p.stderr!.on("data", (d: Buffer) => { stderrTail.append(d.toString("utf8")); this.lastStderr = stderrTail.value; });
    p.stdin!.on("error", (e) => log(`write to agy failed: ${e}`));
    p.on("error", (e) => {
      if (this.proc !== p) return;
      this.proc = null;
      this._busy = false;
      this.events.done(null, `Couldn't start agy: ${e.message}`);
    });
    p.on("close", (code, signal) => {
      const errText = stderrTail.value;
      log(`agy exited ${code ?? signal}${errText ? ": " + errText.slice(-300) : ""}`);
      setTimeout(() => {
        if (this.proc !== p) return;
        this.proc = null;
        if (this._busy && !this.gotResult) {
          this._busy = false;
          const tail = lastLines(errText, 3);
          this.events.done(null, tail || `Antigravity stopped unexpectedly (exit ${code ?? signal}).`);
        }
      }, 100);
    });
    log(`agy started for ${this.cwd} (${resume ? `conversation ${this._sessionId}` : "new conversation"})`);
  }

  /** One stream-json event from agy. */
  handle(o: Obj) {
    switch (o.event) {
      case "init":
        if (typeof o.conversation_id === "string") this.sessionId = o.conversation_id;
        break;
      case "step_update": {
        const su = obj(o.step_update);
        if (su.step_type === "agent_response") {
          if (typeof su.text_delta === "string" && su.text_delta) {
            this.answer += su.text_delta;
            this.events.delta(su.text_delta);
          }
        } else if (su.step_type === "tool") {
          if (su.state !== "ACTIVE" || !su.tool_info || typeof su.tool_info !== "object") return;
          const info = obj(su.tool_info);
          let name = typeof info.name === "string" ? info.name : typeof su.tool_name === "string" ? su.tool_name : "";
          const params = obj(info.parameters);
          if (name === "call_mcp_tool" && typeof params.ToolName === "string") name = params.ToolName;
          this.lastTool = { name, params };
          this.answer = ""; // text before a tool call was narration
          this.events.toolStart(name);
          this.events.toolUse(name, params);
        }
        break;
      }
      case "result": {
        this._busy = false;
        this.scheduleIdleStop();
        if (this.tempRule) { AgySetup.removeAllowRule(this.tempRule); this.tempRule = null; } // "allow once" is over
        if (!o.result || typeof o.result !== "object") return;
        const r = obj(o.result);
        const response = ((typeof r.response === "string" && r.response) || this.answer).trim();
        if (r.status === "SUCCESS" && response) {
          this.events.done(response, null);
        } else if (!response) {
          // Headless agy ends a turn silently when a tool needs permission it can't ask for.
          const denied = this.lastStderr.includes("auto-denied") || this.lastStderr.includes("cannot prompt");
          // A denied shell command: ask the user in the bubble, like Claude's approvals.
          const command = typeof this.lastTool?.params.CommandLine === "string" ? this.lastTool.params.CommandLine.trim() : "";
          if (denied && this.lastTool?.name === "run_command" && command) {
            this.pendingCommand = command;
            log(`agy: needs approval for \`${command}\``);
            this.events.permission({ id: randomUUID(), tool: "Bash", input: { command } });
            return;
          }
          this.events.done(null, denied
            ? "Gemini tried a step that needs your approval (like running a command), which Bubble Only mode can't ask for. Ask again, or switch VisionCLI menu → Settings… → Assistant → Answers appear to the terminal for commands and edits."
            : (lastLines(this.lastStderr, 2, " ") || "Gemini finished without a reply."));
        } else {
          this.events.done(null, typeof r.error === "string" ? r.error : typeof r.status === "string" ? `Antigravity: ${r.status}` : "Antigravity reported an error.");
        }
        break;
      }
    }
  }
}

/** Registers visioncli with Antigravity CLI (global MCP config + allow rules for headless runs). */
export const AgySetup = {
  mcpConfig: () => join(homedir(), ".gemini/config/mcp_config.json"),
  settings: () => join(homedir(), ".gemini/antigravity-cli/settings.json"),
  allowedTools: ["look", "list_windows", "select_region", "clipboard_image", "device_screenshot", "db_schema", "db_query",
    "browser_tabs", "browser_read", "browser_elements", "browser_open", "browser_switch_tab",
    "browser_navigate", "browser_scroll",
    // Computer control: VisionCLI's own approval card gates these.
    "ui_elements", "click", "type_text", "press_keys", "scroll", "drag", "open_app", "open_url"],

  /** Read-only commands Gemini may run without asking (headless agy can't ask). */
  safeCommands: ["grep", "rg", "ls", "cat", "head", "tail", "find", "wc", "pwd", "file", "stat", "tree",
    "git status", "git log", "git diff", "git show", "git branch", "git blame"],

  /** The part of a command an allow rule names: the program, plus its subcommand for tools like git/npm/php. */
  rulePrefix(command: string): string {
    const words = command.split(" ").filter(Boolean);
    const first = words[0];
    if (!first) return command;
    const twoWord = new Set(["git", "npm", "pnpm", "yarn", "npx", "php", "python", "python3", "node", "bun", "cargo", "go",
      "make", "composer", "docker", "kubectl", "swift", "xcodebuild", "bundle", "rails", "./mvnw", "gradle"]);
    return twoWord.has(basename(first)) && words.length > 1 ? `${first} ${words[1]}` : first;
  },

  /** Rules approved with "Allow all this session": removed on New Conversation and when VisionCLI quits. */
  sessionRules: new Set<string>(),

  clearSessionRules() {
    if (!AgySetup.sessionRules.size) return;
    const rules = AgySetup.sessionRules;
    editRules((allow) => allow.filter((r) => !rules.has(r)));
    log(`agy: removed session rules ${[...rules].sort()}`);
    AgySetup.sessionRules = new Set();
  },

  addAllowRule(rule: string) { editRules((a) => (a.includes(rule) ? a : [...a, rule])); },
  removeAllowRule(rule: string) { editRules((a) => a.filter((r) => r !== rule)); },

  install(node: string, server: string) {
    const config = readJson(AgySetup.mcpConfig());
    config.mcpServers = { ...obj(config.mcpServers), visioncli: { command: node, args: server ? [server] : [] } };
    writeJson(AgySetup.mcpConfig(), config);
    editRules((allow) => {
      for (const t of AgySetup.allowedTools) if (!allow.includes(`mcp(visioncli/${t})`)) allow.push(`mcp(visioncli/${t})`);
      for (const c of AgySetup.safeCommands) if (!allow.includes(`command(${c})`)) allow.push(`command(${c})`);
      return allow;
    });
    log(`agy: registered visioncli MCP and ${AgySetup.allowedTools.length} allow rules`);
  },
};

function readJson(file: string): Obj {
  try { return obj(JSON.parse(readFileSync(file, "utf8"))); } catch { return {}; }
}

/** Pretty JSON with sorted keys, as JSONSerialization [.prettyPrinted, .sortedKeys] writes it. */
function writeJson(file: string, value: Obj) {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, sort((v as Obj)[k])])) : v;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sort(value), null, 2));
}

function editRules(change: (allow: string[]) => string[]) {
  const s = readJson(AgySetup.settings());
  const permissions = obj(s.permissions);
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]).filter((r): r is string => typeof r === "string") : [];
  permissions.allow = change(allow);
  s.permissions = permissions;
  try { writeJson(AgySetup.settings(), s); } catch (e) { log(`agy: couldn't write rules: ${e}`); }
}

/** The models agy offers (`agy models`), cached so the menu opens instantly. */
export const AgyModels = {
  /** The quickest model for the fast lane: the newest "Flash (Low)" agy lists. */
  fastest(): string {
    return AgyModels.cached().map((m) => m.id).find((id) => id.includes("flash-low")) ?? "gemini-3.8-flash-low";
  },

  cached(): { id: string; name: string }[] {
    const raw = settings.getStore<unknown[]>("agyModels") ?? [];
    return raw.flatMap((m) => (Array.isArray(m) && m.length === 2 ? [{ id: String(m[0]), name: String(m[1]) }] : []));
  },

  /** `agy models`: "<id>\t<name>" per line. */
  parse(out: string): [string, string][] {
    return out.split("\n").flatMap((line) => {
      const i = line.indexOf("\t");
      if (i < 0) return [];
      const id = line.slice(0, i).trim(), name = line.slice(i + 1).trim();
      return id ? [[id, name] as [string, string]] : [];
    });
  },

  async refresh(cfg: AssistantConfig) {
    if (!cfg.agy) return;
    const r = await run(cfg.agy, ["models"], { env: cliEnvironment(cfg), timeout: 30000 });
    if (r.code !== 0) return;
    const models = AgyModels.parse(r.out);
    if (models.length) settings.setStore("agyModels", models);
  },
};
