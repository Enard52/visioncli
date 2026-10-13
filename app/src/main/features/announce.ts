import type { Phase } from "../contracts";
import { log } from "../log";

// Updates the assistant reports back on its own (the `announce` tool): shown in the bubble and spoken, even with
// Speak Answers off. Queued while the user is in the middle of a question and shown once the bubble hides.
// Port of overlay/Sources/App+Announce.swift (+ the queue drain in App+Panel.swift `set(.hidden)`).

export interface AnnounceDeps {
  phase(): Phase;
  /** Show it: question "Update", the text as the answer (done phase), speak it (forced), add it to history, and hide
   *  the bubble after `seconds`. */
  show(text: string, seconds: number): void;
}

/** How long an update stays up: 6–20 s, longer for longer text. */
export const announceSeconds = (text: string) => Math.max(6, Math.min(20, [...text].length / 12));

export class AnnounceQueue {
  pending: string[] = [];
  constructor(private deps: AnnounceDeps) {}

  announce(text: string) {
    const t = text.trim();
    if (!t) return;
    const phase = this.deps.phase();
    if (phase !== "idle" && phase !== "done" && phase !== "error") {
      this.pending.push(t);
      log(`announce: queued (${phase})`);
      return;
    }
    log(`announce: ${t.slice(0, 200)}`);
    this.deps.show(t, announceSeconds(t));
  }

  /** Call when the bubble hides: the next queued update follows shortly after. */
  bubbleHidden() {
    const next = this.pending.shift();
    if (next != null) setTimeout(() => this.announce(next), 600);
  }
}
