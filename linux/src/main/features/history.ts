import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry } from "../contracts";
import { log } from "../log";
import { SUP } from "../paths";

// Questions and answers, newest first: SUP/history.jsonl (one JSON object per line, oldest first on disk) and the
// screenshots in SUP/screenshots. Port of overlay/Sources/History.swift HistoryStore.

export interface StoredEntry extends HistoryEntry { id: string }

export class HistoryStore extends EventEmitter {
  entries: StoredEntry[] = [];
  readonly file: string;
  readonly shotsDir: string;
  readonly keep = 200;                         // per project, so a busy project doesn't push out the others
  /** Screenshots of all projects together: older than this, or past this total size (oldest go first), are deleted. */
  readonly shotsMaxAge = 30 * 24 * 3600 * 1000;
  readonly shotsMaxBytes = 300 * 1024 * 1024;
  /** Disk writes and deletes, in order, in the background. */
  private io: Promise<unknown> = Promise.resolve();

  constructor(dir = SUP) {
    super();
    this.file = join(dir, "history.jsonl");
    this.shotsDir = join(dir, "screenshots");
    mkdirSync(this.shotsDir, { recursive: true });
    this.load();
    this.pruneShots();
  }

  private queue(work: () => Promise<unknown>) {
    this.io = this.io.then(work).catch((e) => log(`history: ${e?.message ?? e}`));
    return this.io;
  }

  /** Saves screenshots for an entry and returns their paths right away; the files are written in the background
   *  (`waitForWrites()` waits for them). */
  save(jpegs: Buffer[]): string[] {
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
    return jpegs.map((jpeg, i) => {
      const path = join(this.shotsDir, `${stamp}-${i + 1}.jpg`);
      this.queue(() => writeFile(path, jpeg).catch((e) => log(`history: can't save ${path}: ${e.message}`)));
      return path;
    });
  }

  /** Resolves once the screenshots (and history) queued so far are on disk. */
  waitForWrites(): Promise<void> { return this.io.then(() => {}); }

  add(e: HistoryEntry) {
    const entry: StoredEntry = { id: randomUUID(), ...e };
    this.entries.unshift(entry);
    const same = this.entries.filter((x) => x.project === e.project);
    if (same.length > this.keep) {
      const dropped = new Set(same.slice(this.keep).map((x) => x.id));
      this.remove(same.slice(this.keep).flatMap((x) => x.screenshots));
      this.entries = this.entries.filter((x) => !dropped.has(x.id));
      this.persistAll();
    } else {
      const line = JSON.stringify(entry) + "\n";
      this.queue(() => appendFile(this.file, line));
    }
    this.pruneShots();
    this.emit("change");
  }

  /** Deletes one entry (History window) and its screenshots. */
  removeEntry(id: string) {
    const gone = this.entries.find((x) => x.id === id);
    if (!gone) return;
    this.remove(gone.screenshots);
    this.entries = this.entries.filter((x) => x !== gone);
    this.persistAll();
    this.emit("change");
  }

  /** Clears everything, or one project's history. */
  clear(project?: string) {
    const gone = this.entries.filter((x) => project == null || x.project === project);
    this.remove(gone.flatMap((x) => x.screenshots));
    if (project != null) {
      this.entries = this.entries.filter((x) => x.project !== project);
      this.persistAll();
    } else {
      this.entries = [];
      this.queue(() => rm(this.file, { force: true }));
    }
    this.emit("change");
  }

  /** Projects with history, most recently used first. */
  projects(): string[] {
    const seen = new Set<string>();
    return [...this.entries].sort((a, b) => b.date.localeCompare(a.date)).map((e) => e.project).filter((p) => !seen.has(p) && !!seen.add(p));
  }

  /** The History window's list: one project ("" = all) and a case-insensitive search. */
  filtered(project: string, query: string): StoredEntry[] {
    const q = query.toLowerCase();
    return this.entries.filter((e) => (!project || e.project === project)
      && (!q || `${e.question} ${e.answer} ${e.project}`.toLowerCase().includes(q)));
  }

  private remove(paths: string[]) {
    if (!paths.length) return;
    this.queue(() => Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {}))));
  }

  /** Deletes screenshots past the age or total-size cap, oldest first, in the background. */
  pruneShots(now = Date.now()) {
    return this.queue(async () => {
      let names: string[];
      try { names = await readdir(this.shotsDir); } catch { return; }
      const shots: { path: string; date: number; size: number }[] = [];
      for (const n of names) {
        const path = join(this.shotsDir, n);
        const s = await stat(path).catch(() => null);
        if (s?.isFile()) shots.push({ path, date: s.mtimeMs, size: s.size });
      }
      shots.sort((a, b) => a.date - b.date);
      let total = shots.reduce((t, s) => t + s.size, 0);
      const cutoff = now - this.shotsMaxAge;
      let removed = 0;
      for (const s of shots) {
        if (!(s.date < cutoff || total > this.shotsMaxBytes)) continue;
        try { await rm(s.path); } catch { continue; }
        total -= s.size;
        removed++;
      }
      if (removed > 0) log(`history: pruned ${removed} old screenshot(s)`);
    });
  }

  private load() {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    const out: StoredEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.question !== "string" || typeof e.project !== "string") continue;
        // macOS writes `date` as ISO 8601 too; accept the epoch seconds older builds may have used.
        const date = typeof e.date === "number" ? new Date(e.date * 1000).toISOString() : String(e.date);
        out.push({ id: e.id ?? randomUUID(), date, project: e.project, question: e.question, answer: e.answer ?? "", screenshots: e.screenshots ?? [] });
      } catch {}
    }
    this.entries = out.reverse();
  }

  private persistAll() {
    const data = [...this.entries].reverse().map((e) => JSON.stringify(e) + "\n").join("");
    this.queue(() => writeFile(this.file, data));
  }
}
