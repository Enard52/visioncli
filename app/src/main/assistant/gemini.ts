import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LineSplitter, JSONLines } from "../core/transcript";
import { log } from "../log";
import { CACHE } from "../paths";
import { settings } from "../settings";
import { sessionFile } from "../terminal/transcripts";
import { geminiEnvironment, lastLines, noEvents, type AssistantConfig, type BackgroundSession } from "./config";
import { geminiVoicePrompt } from "./prompts";
import { spawnCommand } from "../features/run";

// Background (bubble-only) Gemini CLI (Gemini.swift): one `gemini -p … -o stream-json` run per question, resuming the
// same session. Headless Gemini can't ask for approval, so only read-only tools and the (trusted) visioncli tools run.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** Copies screenshots somewhere without spaces so they can be passed as `@path` (Gemini's file-include syntax). */
export function geminiAttachable(images: string[]): string[] {
  const dir = join(CACHE, "shots");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return images.flatMap((f) => {
    const dest = join(dir, (basename(f) || `shot-${randomUUID().slice(0, 8)}.jpg`).replace(/\s/g, "-"));
    try { if (dest !== f) copyFileSync(f, dest); return [dest]; } catch { return []; }
  });
}

/** Turn Gemini's auth failures into something actionable. */
export function geminiFriendlyError(raw: string): string {
  if (raw.includes("API_KEY_INVALID") || raw.includes("API key not valid")) {
    return "Gemini rejected the API key in VisionCLI menu → Settings… → Integrations → API keys. Fix or remove it (without it, VisionCLI uses your normal `gemini` sign-in).";
  }
  if (raw.includes("IneligibleTierError") || raw.includes("no longer supported for Gemini Code Assist")) {
    return "Google refused this Gemini CLI sign-in (\"no longer supported for Code Assist for individuals\"). Run `gemini` in a terminal and use /auth to sign in with an account that has Gemini CLI access, or switch VisionCLI menu → Settings… → Assistant back to Claude Code.";
  }
  return raw.slice(-400);
}

export class GeminiSession implements BackgroundSession {
  readonly kind = "gemini";
  readonly lane = "strong" as const; // Gemini CLI has no fast lane
  events = noEvents();
  private proc: ChildProcess | null = null;
  private _busy = false;
  private _sessionId: string | undefined;
  private answer = "";

  constructor(readonly cwd: string, private cfg: AssistantConfig) {
    this._sessionId = settings.getStore<string>(`geminiBackground:${cwd}`) ?? undefined;
  }

  get busy() { return this._busy; }
  get sessionId() { return this._sessionId; }
  private set sessionId(v: string | undefined) {
    if (v === this._sessionId) return;
    this._sessionId = v;
    settings.setStore(`geminiBackground:${this.cwd}`, v);
  }

  warm() {} // nothing to keep running between questions
  respond() {}

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

  /** The command line for one question (for tests). */
  args(text: string, images: string[]): { args: string[]; sid: string; resume: boolean } {
    const resume = !!this._sessionId && !!sessionFile("gemini", this.cwd, this._sessionId);
    const sid = resume ? this._sessionId! : randomUUID().toLowerCase();
    let prompt = resume ? "" : geminiVoicePrompt;
    prompt += text;
    for (const path of geminiAttachable(images)) prompt += `\n@${path}`;
    return {
      args: ["-p", prompt, "-o", "stream-json", "--approval-mode", "default", "--allowed-mcp-server-names", "visioncli", resume ? "--resume" : "--session-id", sid],
      sid, resume,
    };
  }

  send(text: string, images: string[]) {
    this.stop();
    const gemini = this.cfg.gemini;
    if (!gemini) { this.events.done(null, "Gemini CLI wasn't found. Install it (npm install -g @google/gemini-cli) and reopen VisionCLI."); return; }
    const { args, sid, resume } = this.args(text, images);
    let p: ChildProcess;
    try {
      const env = geminiEnvironment(this.cfg), s = spawnCommand(gemini, args, env);
      p = spawn(s.file, s.args, { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: s.verbatim });
    } catch (e) {
      this.events.done(null, `Couldn't start gemini: ${e}`);
      return;
    }
    this.proc = p;
    this._busy = true;
    this.answer = "";
    let gotResult = false, errText = "";
    const lines = new LineSplitter();
    p.stdout!.on("data", (chunk: Buffer) => lines.feed(chunk, (line) => {
      const o = JSONLines.object(line);
      if (!o || this.proc !== p) return;
      if (o.type === "result") gotResult = true;
      this.handle(o);
    }));
    p.stderr!.on("data", (d: Buffer) => { errText += d.toString("utf8"); if (errText.length > 4000) errText = errText.slice(-2000); });
    p.on("error", (e) => {
      if (this.proc !== p) return;
      this.proc = null;
      this._busy = false;
      this.events.done(null, `Couldn't start gemini: ${e.message}`);
    });
    p.on("close", (code, signal) => {
      log(`gemini exited ${code ?? signal}${errText ? ": " + errText.slice(-300) : ""}`);
      setTimeout(() => {
        if (this.proc !== p) return;
        this.proc = null;
        if (this._busy && !gotResult) {
          this._busy = false;
          const tail = lastLines(errText, 3);
          this.events.done(null, tail ? geminiFriendlyError(errText) : `Gemini stopped unexpectedly (exit ${code ?? signal}).`);
        }
      }, 100);
    });
    log(`ask gemini (${this.cwd}, ${resume ? "resume" : "new"} ${sid}): ${text.slice(0, 200)}`);
  }

  /** One stream-json event from gemini. */
  handle(o: Obj) {
    switch (o.type) {
      case "init":
        if (typeof o.session_id === "string") this.sessionId = o.session_id;
        break;
      case "message":
        if (o.role !== "assistant" || typeof o.content !== "string") return;
        this.answer += o.content;
        this.events.delta(o.content);
        break;
      case "tool_use": {
        const name = typeof o.tool_name === "string" ? o.tool_name : "";
        this.answer = ""; // text before a tool call was narration
        this.events.toolStart(name);
        this.events.toolUse(name, obj(o.parameters));
        break;
      }
      case "tool_result": {
        const output = typeof o.output === "string" ? o.output : typeof obj(o.error).message === "string" ? (obj(o.error).message as string) : "";
        this.events.toolResult(output, o.status === "error", null);
        break;
      }
      case "result":
        this._busy = false;
        if (o.status === "success") this.events.done(this.answer.trim(), null);
        else this.events.done(null, geminiFriendlyError(typeof obj(o.error).message === "string" ? (obj(o.error).message as string) : "Gemini reported an error."));
        break;
    }
  }
}
