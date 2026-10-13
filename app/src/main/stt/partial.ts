import { statSync } from "node:fs";

// The live-caption fast path shared by the engines. Captions are re-transcriptions of a growing snapshot, so:
// - while one caption is being worked out, another request gets the last caption at once instead of queueing;
// - a snapshot smaller than the last one is a new question, so the previous question's caption is dropped.

export class PartialGate {
  private busy = false;
  private last = "";
  private lastBytes = 0;

  /** The caption to return right away, or null when this request should run. */
  begin(wav: string): string | null {
    let bytes = 0;
    try { bytes = statSync(wav).size; } catch {}
    if (bytes < this.lastBytes) { this.last = ""; this.lastBytes = 0; }
    if (this.busy) return this.last;
    this.busy = true;
    this.lastBytes = bytes;
    return null;
  }

  end(text: string | null) {
    this.busy = false;
    if (text !== null) this.last = text;
    return this.last;
  }

  get current() { return this.last; }
}
