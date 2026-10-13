import { BrowserTaskText } from "../core/text";
import { log } from "../log";
import { App } from "./core";
import { runStream } from "./node";

// Multi-step browser tasks (App+BrowserTask.swift): Jev routed the command as a browser task, so `visioncli browse`
// runs the Jev agent on the page in front and streams its steps into the bubble. Esc stops it (dismiss kills it).

declare module "./core" {
  interface App {
    runBrowserTask(text: string): void;
  }
}

App.prototype.runBrowserTask = function (this: App, text: string) {
  if (!this.cfg.node) { void this.captureAndAsk(text); return; }
  this.browseProc?.kill("SIGTERM");
  const started = Date.now();
  const lines: string[] = [];
  let header = "Working on it in the browser…";
  let finished = false;
  let proc: ReturnType<typeof runStream> = null;
  this.sessions.activity.question(text, this.currentProject, []);
  this.state.raw = BrowserTaskText.body(header, lines);
  this.set("answering");

  const finish = (status: string, message: string, steps: number, ms: number) => {
    if (finished) return;
    finished = true;
    if (this.browseProc === proc) this.browseProc = null;
    const summary = BrowserTaskText.summary(status, message, steps, ms);
    log(`browse: ${status} ${steps} steps ${ms}ms ${message}`);
    this.sessions.activity.note(`${summary} (Jev agent)`);
    const answer = BrowserTaskText.body(summary, lines);
    this.history.add({ date: new Date().toISOString(), project: this.currentProject, question: text, answer, screenshots: [] });
    if (this.state.question !== text || this.state.phase !== "answering") return; // dismissed or replaced
    this.state.raw = answer;
    this.set(status === "done" ? "done" : "error");
    this.speaker.feed(summary, true);
    this.scheduleHide(status === "done" ? 8 : 15);
  };

  void this.frontApp().then((front) => {
    const p = runStream(this.nodeCli, ["browse", text], front, (e) => {
      if (finished) return;
      switch (e.type) {
        case "status": header = typeof e.message === "string" ? e.message : header; break;
        case "step": {
          const l = e.step && typeof e.step === "object" ? BrowserTaskText.line(e.step as Record<string, unknown>) : null;
          if (l) lines.push(l);
          header = "Working on it in the browser…";
          break;
        }
        case "end":
          finish(typeof e.status === "string" ? e.status : "error", typeof e.message === "string" ? e.message : "",
            typeof e.steps === "number" ? e.steps : lines.length, typeof e.ms === "number" ? e.ms : Date.now() - started);
          return;
        default: return;
      }
      if (this.state.question === text && this.state.phase === "answering") this.state.raw = BrowserTaskText.body(header, lines);
    }, (signaled) => {
      // The last stdout lines (the "end" event) may still be on their way: let them land first.
      setTimeout(() => finish(signaled ? "stopped" : "error", "The browser agent stopped unexpectedly.", lines.length, Date.now() - started), 300);
    });
    proc = p;
    if (!p) { finish("error", "Couldn't start the browser agent.", 0, 0); return; }
    this.browseProc = p;
  });
};
