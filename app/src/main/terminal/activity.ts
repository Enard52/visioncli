import { appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LOGS } from "../paths";

// A human-readable, coloured live feed of what the voice session is doing, written to LOGS/visioncli-activity.log
// and shown with `tail -F` in a terminal window (Activity.swift ActivityLog + BufferedActivity).

export const ACTIVITY_LOG = join(LOGS, "visioncli-activity.log");

export interface ActivityShot { label: string; width: number; height: number; pointer?: { x: number; y: number } | null }

const c = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;

export class ActivityLog {
  private midText = false; // streaming answer text (no trailing newline yet)
  constructor(readonly file = ACTIVITY_LOG) {}

  private write(s: string) { try { appendFileSync(this.file, s); } catch {} }

  private line(s: string) {
    if (this.midText) { this.write("\n"); this.midText = false; }
    this.write(s + "\n");
  }

  question(text: string, project: string, shots: ActivityShot[] = []) {
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    this.line("");
    this.line(c("2", `━━━ ${time} · ${basename(project)} ` + "━".repeat(40)));
    this.line(c("1;36", "You: ") + c("1", text));
    shots.forEach((s, i) => {
      const pointer = s.pointer ? `, pointer at ${Math.trunc(s.pointer.x)},${Math.trunc(s.pointer.y)}` : "";
      this.line(c("2", `   screenshot: ${shots.length > 1 ? `${i + 1}. ` : ""}${s.label} (${Math.trunc(s.width)}×${Math.trunc(s.height)}${pointer})`));
    });
  }

  tool(name: string, input: Record<string, unknown>) {
    const short = name.replace("mcp__visioncli__", "");
    const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
    let detail: string;
    switch (name) {
      case "Bash": detail = c("33", "$ " + str("command")); break;
      case "Read": detail = str("file_path"); break;
      case "Grep": detail = `"${str("pattern")}"` + (typeof input.path === "string" ? ` in ${input.path}` : ""); break;
      case "Glob": detail = str("pattern"); break;
      case "Edit": case "MultiEdit": case "Write": detail = str("file_path"); break;
      case "mcp__visioncli__db_query": detail = c("33", str("sql")); break;
      default: {
        let json = "";
        try { json = JSON.stringify(input) ?? ""; } catch {}
        detail = json === "{}" ? "" : json.slice(0, 160);
      }
    }
    this.line(c("35", `tool ${short} `) + detail);
  }

  toolResult(text: string, isError: boolean, tool?: string | null) {
    const lines = text.split("\n");
    // Show command / query output; just summarize file reads and searches.
    if (isError || tool === "Bash" || tool === "mcp__visioncli__db_query") {
      for (const l of lines.slice(0, 15)) this.line(c(isError ? "31" : "2", "   │ " + l.slice(0, 200)));
      if (lines.length > 15) this.line(c("2", `   │ … ${lines.length - 15} more lines`));
    } else {
      this.line(c("2", `   └ ${lines.length} lines`));
    }
  }

  permission(title: string, allowed: boolean | null) {
    if (allowed === null) this.line(c("1;33", `Waiting for you: ${title}? (in the bubble)`));
    else this.line(allowed ? c("32", "   ✓ allowed") : c("31", "   ✗ denied"));
  }

  text(delta: string) {
    if (!this.midText) { this.write(c("1;32", "Claude: ")); this.midText = true; }
    this.write(delta);
  }

  done(cost?: number | null) {
    if (this.midText) { this.write("\n"); this.midText = false; }
    if (cost != null) this.line(c("2", `   ($${cost.toFixed(4)})`));
  }

  error(message: string) { this.line(c("31", "Error: " + message)); }
  note(message: string) { this.line(c("2", "   " + message)); }
}

/** The feed with streamed answer text batched (answers stream a token at a time): text is written a few times a
 *  second, and always before any other entry so the feed stays in order. */
export class BufferedActivity {
  private pending = "";
  private timer: NodeJS.Timeout | null = null;
  constructor(private feed = new ActivityLog()) {}

  text(delta: string) {
    if (!this.pending && !this.timer) this.timer = setTimeout(() => this.flush(), 250);
    this.pending += delta;
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    this.feed.text(text);
  }

  question(text: string, project: string, shots: ActivityShot[] = []) { this.flush(); this.feed.question(text, project, shots); }
  tool(name: string, input: Record<string, unknown>) { this.flush(); this.feed.tool(name, input); }
  toolResult(text: string, isError: boolean, tool?: string | null) { this.flush(); this.feed.toolResult(text, isError, tool); }
  permission(title: string, allowed: boolean | null) { this.flush(); this.feed.permission(title, allowed); }
  done(cost?: number | null) { this.flush(); this.feed.done(cost); }
  error(message: string) { this.flush(); this.feed.error(message); }
  note(message: string) { this.flush(); this.feed.note(message); }
}

/** The app's one feed. */
export const activity = new BufferedActivity();
