import { AnnounceQueue } from "../features/announce";
import { App } from "./core";

// Updates the assistant reports back on its own (App+Announce.swift, the `announce` tool): shown in the bubble and
// spoken even with Speak Answers off; queued while the user is in the middle of a question.

declare module "./core" {
  interface App {
    makeAnnouncer(): AnnounceQueue;
  }
}

App.prototype.makeAnnouncer = function (this: App) {
  return new AnnounceQueue({
    phase: () => this.state.phase,
    show: (text, seconds) => {
      this.sessions.activity.note(`Update: ${text}`);
      this.state.pinned = false;
      this.state.question = "Update";
      this.state.status = "";
      this.state.toast = "";
      this.state.raw = text;
      this.set("done");
      this.speaker.stop();
      this.speaker.feed(text, true, true);
      this.history.add({ date: new Date().toISOString(), project: this.currentProject, question: "Update", answer: text, screenshots: [] });
      this.scheduleHide(seconds);
    },
  });
};
