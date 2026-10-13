import { clipboard, shell } from "electron";
import type { BubbleAction, PermissionAnswer } from "../contracts";
import { Markup } from "../core/markup";
import { log } from "../log";
import { settings } from "../settings";
import { App } from "./core";
import { parseOpenLink } from "./text";

// The buttons and keys on the answer bubble (App+Bubble.swift BubbleActions).

declare module "./core" {
  interface App {
    bubbleAction(a: BubbleAction): void;
    copyAnswer(): void;
    toggleSpeak(): void;
    showHistory(): void;
    dismiss(): void;
    togglePin(): void;
    approve(answer: PermissionAnswer): void;
    openLink(url: string): Promise<void>;
    openFirstReference(): Promise<void>;
    readonly answer: string;
  }
}

Object.defineProperty(App.prototype, "answer", { get(this: App) { return Markup.display(this.state.raw); } });

App.prototype.bubbleAction = function (this: App, a: BubbleAction) {
  switch (a.type) {
    case "copy": this.copyAnswer(); break;
    case "speak": this.toggleSpeak(); break;
    case "history": this.showHistory(); break;
    case "openFirst": void this.openFirstReference(); break;
    case "pin": this.togglePin(); break;
    case "close": this.dismiss(); break;
    case "approve": this.approve(a.answer); break;
    case "link": void this.openLink(a.url); break;
    case "hover": break; // scheduleHide asks the overlay whether the pointer is on the bubble
  }
};

App.prototype.copyAnswer = function (this: App) {
  clipboard.writeText(this.answer);
  this.state.toast = "Copied";
};

App.prototype.toggleSpeak = function (this: App) {
  if (settings.get("tts") === "kokoro") this.speaker.warm();
  if (this.speaker.speaking) { this.speaker.stop(); return; }
  this.speaker.stop();
  this.speaker.feed(this.answer, true, true);
};

App.prototype.showHistory = function (this: App) { this.windows.openHistory(this.currentProject); };

App.prototype.dismiss = function (this: App) {
  if (this.control.active) {
    this.control.stopComputerControl();
    if (this.current?.busy) this.current.stop();
    return;
  }
  if (this.state.phase === "approval") { this.approve("deny"); return; }
  this.browseProc?.kill("SIGTERM"); // stops a browser task (browserd stops when this client goes away)
  this.browseProc = null;
  this.quick?.cancel();
  this.ui.cancelRegion();
  this.stopRecording();
  if (this.current?.busy) this.current.stop(); // stop the turn; the next question resumes the conversation
  this.speaker.stop();
  this.ui.hideMarks();
  this.set("idle");
};

App.prototype.togglePin = function (this: App) {
  if (!["answering", "done", "error"].includes(this.state.phase)) return;
  this.state.pinned = !this.state.pinned;
  if (this.state.pinned) {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  } else if (this.state.phase === "done") {
    this.scheduleHide(60);
  }
};

App.prototype.approve = function (this: App, answer: PermissionAnswer) {
  const control = this.pendingControl;
  if (control) { control.resolve(answer); return; } // clears pendingControl itself
  const p = this.pendingPermission;
  if (!p || this.state.phase !== "approval") return;
  this.pendingPermission = null;
  const allow = answer !== "deny";
  this.state.approval = undefined;
  this.state.status = allow ? "Making the change…" : "OK, skipping that…";
  this.set("thinking");
  p.resolve(answer);
  // A computer-control card that waited for this one.
  const next = this.controlWaiting.shift();
  if (next) setImmediate(next);
};

App.prototype.openLink = async function (this: App, url: string) {
  const ref = parseOpenLink(url);
  if (!ref) {
    if (/^(https?|mailto|file):/i.test(url)) void shell.openExternal(url);
    else log(`link ignored: ${url}`);
    return;
  }
  try { await this.apps.openFile(ref.path, ref.line, this.currentProject); }
  catch (e) { this.state.toast = String((e as Error)?.message ?? e); }
};

App.prototype.openFirstReference = async function (this: App) {
  const ref = Markup.firstFileRef(this.answer);
  if (!ref) { this.state.toast = "No file reference in this answer"; return; }
  const [path, line] = ref;
  this.state.toast = `Opening ${path.split("/").pop()}:${line}…`;
  try { await this.apps.openFile(path, line, this.currentProject); }
  catch (e) { this.state.toast = String((e as Error)?.message ?? e); }
};
