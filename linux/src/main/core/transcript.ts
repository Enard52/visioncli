// Line-oriented stream parsing for CLI output and JSONL transcripts. Port of overlay/Sources/CoreTranscript.swift.

/** Splits a byte stream (a child process's 'data' chunks) into lines in one pass per chunk. Removing each line from
 *  the front of the buffer re-copied the rest every time, which is quadratic when a big chunk holds many lines.
 *  A partial last line waits in the buffer for the rest of it. Use one per stream. */
export class LineSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  /** Lines are passed without their "\n" and are views into the buffer: copy one to keep it past the callback. */
  feed(chunk: Buffer | Uint8Array, line: (line: Buffer) => void): void {
    if (chunk.length === 0) return;
    const owned = this.buffer.length > 0; // concat made a fresh copy
    const buf = owned ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) >= 0) {
      line(buf.subarray(start, nl));
      start = nl + 1;
    }
    // Copy the partial line so a big chunk isn't kept alive by it (and the caller may reuse its chunk).
    this.buffer = start === 0 && owned ? buf : Buffer.from(buf.subarray(start));
  }

  /** Drops a partial line (the stream restarted, or earlier output is being skipped). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** JSONL: one JSON object per line. Lines that aren't a JSON object (blank, truncated, arrays) are skipped. */
export const JSONLines = {
  object(line: Buffer | Uint8Array): Record<string, unknown> | null {
    try {
      const v: unknown = JSON.parse(utf8.decode(line)); // fatal: invalid UTF-8 is rejected, as JSONSerialization does
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },

  /** The objects in the complete lines of `chunk`; a partial last line is kept in `splitter` for the next chunk. */
  objects(chunk: Buffer | Uint8Array, splitter: LineSplitter): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    splitter.feed(chunk, (l) => {
      const obj = JSONLines.object(l);
      if (obj) out.push(obj);
    });
    return out;
  },
};
