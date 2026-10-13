import type { AnswerHandlers, AssistantSession, PermissionAnswer } from "../contracts";
import { Markup } from "../core/markup";
import { log } from "../log";
import { settings } from "../settings";
import { App } from "./core";

// The assistant sessions questions go to (App+Sessions.swift): what their answers do to the bubble. The sessions
// themselves (warm background CLIs, the user's terminal CLI) are the assistant module's.

declare module "./core" {
  interface App {
    answerHandlers(s: AssistantSession): AnswerHandlers;
    setEffort(level: string | null): void;
    setClaudeModel(alias: string): void;
    setAgyModel(id: string | null): void;
    setAssistant(a: "claude" | "antigravity" | "gemini"): void;
    newConversation(): void;
    continueInTerminal(): void;
    showActivityMenu(): void;
    showAssistantTerminal(): void;
  }
}

App.prototype.answerHandlers = function (this: App, s: AssistantSession): AnswerHandlers {
  const mine = () => this.current === s;
  return {
    onText: (delta) => {
      if (!mine() || this.state.phase === "idle") return;
      if (this.state.phase === "thinking") this.set("answering");
      this.state.raw += delta;
      this.speaker.feed(Markup.display(this.state.raw), false);
    },
    onTool: (_name, detail) => {
      if (!mine()) return;
      if (detail === undefined) {
        // Text before a tool call is narration ("Let me look…"): drop it and show the loader again.
        if (this.state.phase !== "answering") return;
        this.state.raw = "";
        this.speaker.stop();
        this.set("thinking");
        return;
      }
      if (this.state.phase === "thinking" || this.state.phase === "listening") this.state.status = detail;
    },
    onPermission: (req) => new Promise<PermissionAnswer>((resolve) => {
      if (!mine() || this.state.phase === "idle") { resolve("deny"); return; }
      this.pendingPermission = { resolve };
      this.state.approval = { tool: req.tool, summary: req.summary, preview: req.preview, queue: 0 };
      this.speaker.stop();
      this.set("approval");
    }),
    onDone: (r) => {
      if (!mine()) return;
      this.lastCost = r.costUsd;
      this.finish(r.text, null);
    },
    onError: (message) => {
      if (!mine()) return;
      this.finish(null, message);
    },
    onRateLimit: (info) => this.usage.record(info),
    onWaitingInTerminal: () => {
      if (mine() && this.state.phase === "thinking") this.state.status = "Waiting for your approval in the terminal…";
    },
  };
};

/** null = the CLI's own setting. A running terminal Claude switches too. */
App.prototype.setEffort = function (this: App, level: string | null) {
  settings.set("effort", level);
  log(`effort: ${level ?? "default"}`);
  if (level) void this.sessions.propagate(`/effort ${level}`, this.currentProject);
};

/** A Claude Code alias (MenuLabels.claudeModels). A running terminal Claude switches too. */
App.prototype.setClaudeModel = function (this: App, alias: string) {
  settings.set("model", alias);
  void this.sessions.propagate(`/model ${alias}`, this.currentProject);
};

App.prototype.setAgyModel = function (this: App, id: string | null) {
  settings.set("agyModel", id);
  log(`agy model: ${id ?? "default"}`);
};

App.prototype.setAssistant = function (this: App, a) {
  settings.set("assistant", a);
  this.state.assistantName = a === "claude" ? "Claude" : "Gemini";
  log(`assistant: ${a}`);
  this.windows.refreshMenu(); // the Claude usage item and tray rings only show with Claude
};

App.prototype.newConversation = function (this: App) {
  this.sessions.newConversation(this.currentProject);
  this.instructed.clear();
};

App.prototype.continueInTerminal = function (this: App) {
  void this.sessions.continueInTerminal(this.sessions.current?.cwd ?? this.currentProject);
};

App.prototype.showActivityMenu = function (this: App) {
  this.activityShown = true;
  void this.sessions.showActivity();
};

App.prototype.showAssistantTerminal = function (this: App) {
  void this.sessions.showTerminal(this.currentProject);
};
