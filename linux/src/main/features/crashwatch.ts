import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { log } from "../log";
import { CACHE } from "../paths";
import { run } from "./run";

// Watches for new crashes of the user's apps, so "why did it crash?" knows which one. Port of CrashWatcher
// (overlay/Sources/Tasks.swift), which watches ~/Library/Logs/DiagnosticReports. On Linux crashes land in:
//   - systemd-coredump: `coredumpctl --json=short list --since=…` (or the journal: `journalctl -t systemd-coredump -o json`)
//   - Apport (Ubuntu): /var/crash/*.crash
// The coredump's `coredumpctl info` text is saved to CACHE/crashes so the question can point at a file, like macOS.

export interface Crash {
  app: string;
  /** The crash report: an Apport .crash file, or the saved `coredumpctl info` text. */
  file: string;
  date: number;      // when we noticed it (epoch ms)
  pid?: number;
  exe?: string;
  signal?: number;
}

/** System noise that isn't the user's app (macOS list, with the Linux desktop's own processes). */
export const IGNORED = ["visioncli", "electron", "whisper", "python", "chrome", "chromium", "brave", "firefox", "slack", "zoom",
  "spotify", "gnome-shell", "plasmashell", "kwin", "xwayland", "mutter", "nautilus", "dolphin", "tracker", "evolution", "gvfs",
  "pipewire", "wireplumber", "pulseaudio", "xdg-desktop-portal", "ibus", "fcitx", "systemd", "dbus", "polkit", "gsd-", "kded",
  "baloo", "packagekit", "snapd", "apport", "service", "agent", "daemon", "helper"];

export const isIgnored = (app: string) => IGNORED.some((i) => app.toLowerCase().includes(i));

/** A crash a source reports, before the noise filter. */
export interface RawCrash { key: string; app: string; pid?: number; uid?: number; exe?: string; signal?: number; time?: number; file?: string }

/** `coredumpctl --json=short list` output: [{time (µs), pid, uid, gid, sig, corefile, exe, size}, …]. */
export function parseCoredumpctl(json: string): RawCrash[] {
  let list: unknown;
  try { list = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: RawCrash[] = [];
  for (const e of list as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const exe = typeof e.exe === "string" ? e.exe : "";
    const pid = Number(e.pid);
    const time = Number(e.time);
    if (!exe && !pid) continue;
    out.push({ key: `core:${pid}:${time}`, app: basename(exe) || `pid ${pid}`, pid, uid: e.uid != null ? Number(e.uid) : undefined, exe,
      signal: e.sig != null ? Number(e.sig) : undefined, time: Number.isFinite(time) ? Math.floor(time / 1000) : undefined });
  }
  return out;
}

/** `journalctl -t systemd-coredump -o json` lines: COREDUMP_* fields, else "Process 1234 (app) of user 1000 dumped core." */
export function parseJournal(text: string): RawCrash[] {
  const out: RawCrash[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = typeof e.MESSAGE === "string" ? e.MESSAGE : "";
    const m = /Process (\d+) \(([^)]*)\) of user (\d+) (?:dumped core|terminated abnormally)/.exec(msg);
    const pid = Number(e.COREDUMP_PID ?? m?.[1]);
    if (!pid) continue;
    const exe = typeof e.COREDUMP_EXE === "string" ? e.COREDUMP_EXE : "";
    const comm = typeof e.COREDUMP_COMM === "string" ? e.COREDUMP_COMM : m?.[2] ?? "";
    const uid = e.COREDUMP_UID != null ? Number(e.COREDUMP_UID) : m ? Number(m[3]) : undefined;
    const time = Number(e.__REALTIME_TIMESTAMP);
    const ts = e.COREDUMP_TIMESTAMP ?? e.__REALTIME_TIMESTAMP;
    out.push({ key: `core:${pid}:${ts}`, app: (exe && basename(exe)) || comm || `pid ${pid}`, pid, uid, exe: exe || undefined,
      signal: e.COREDUMP_SIGNAL != null ? Number(e.COREDUMP_SIGNAL) : undefined, time: Number.isFinite(time) ? Math.floor(time / 1000) : undefined });
  }
  return out;
}

/** Apport file names: "_usr_bin_myapp.1000.crash" → app "myapp", uid 1000. */
export function parseApportName(name: string): { app: string; uid?: number } | null {
  const m = /^(.*?)(?:\.(\d+))?\.crash$/.exec(name);
  if (!m) return null;
  const exe = m[1].replace(/_/g, "/");
  return { app: basename(exe) || m[1], uid: m[2] != null ? Number(m[2]) : undefined };
}

type Runner = typeof run;

export class CrashWatcher {
  onCrash: (c: Crash) => void = () => {};
  last: Crash | null = null;
  private seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private since = 0;
  private primed = false;
  private polling = false;
  private source: "coredumpctl" | "journalctl" | "none" | null = null;

  constructor(private opts: { crashDir?: string; reportsDir?: string; uid?: number; runner?: Runner; interval?: number } = {}) {}

  private get crashDir() { return this.opts.crashDir ?? "/var/crash"; }
  private get reportsDir() { return this.opts.reportsDir ?? join(CACHE, "crashes"); }
  private get uid() { return this.opts.uid ?? process.getuid?.() ?? 0; }
  private get runner() { return this.opts.runner ?? run; }

  async start() {
    if (this.timer) return;
    this.primed = false;
    this.since = Date.now();
    // Crashes that happened before we started aren't news.
    for (const c of this.apportCrashes()) this.seen.add(c.key);
    this.primed = true;
    this.timer = setInterval(() => void this.poll(), this.opts.interval ?? 5000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The latest crash if it happened recently (45 minutes). */
  recent(now = Date.now()): Crash | null {
    return this.last && now - this.last.date < 45 * 60_000 ? this.last : null;
  }

  /** The note added to a question: "(If relevant: myapp crashed 3 min ago; crash report at /…/myapp.txt.)" */
  questionTag(now = Date.now()): string | null {
    const c = this.recent(now);
    if (!c) return null;
    const mins = Math.max(1, Math.floor((now - c.date) / 60_000));
    return `(If relevant: ${c.app} crashed ${mins} min ago; crash report at ${c.file}.)`;
  }

  async poll() {
    if (!this.primed || this.polling) return;
    this.polling = true;
    try {
      const found = [...await this.coredumps(), ...this.apportCrashes()];
      if (!this.timer) return; // stopped meanwhile
      for (const raw of found) await this.consider(raw);
    } finally {
      this.polling = false;
    }
  }

  /** Applies the seen/user/noise filters and reports the crash (exposed for tests). */
  async consider(raw: RawCrash) {
    if (this.seen.has(raw.key)) return;
    this.seen.add(raw.key);
    if (raw.uid != null && raw.uid !== this.uid) return;   // another user's (or a system service's) crash
    if (raw.time != null && raw.time < this.since - 1000) return;
    if (isIgnored(raw.app)) return;
    const file = raw.file ?? await this.saveReport(raw);
    const crash: Crash = { app: raw.app, file, date: Date.now(), pid: raw.pid, exe: raw.exe, signal: raw.signal };
    this.last = crash;
    log(`watcher: ${crash.app} crashed (${basename(file)})`);
    this.onCrash(crash);
  }

  private async coredumps(): Promise<RawCrash[]> {
    const since = `--since=@${Math.floor(this.since / 1000)}`;
    if (this.source !== "journalctl" && this.source !== "none") {
      const r = await this.runner("coredumpctl", ["--json=short", "--no-pager", "list", since], { timeout: 10_000 });
      if (r.code === 0) { this.source = "coredumpctl"; return parseCoredumpctl(r.out); }
      if (/no coredumps found/i.test(r.err + r.out)) { this.source = "coredumpctl"; return []; }
      if (this.source == null && r.code === 127) this.source = "journalctl"; // not installed: read the journal
      else if (this.source == null) this.source = "journalctl";             // e.g. an old coredumpctl without --json
    }
    if (this.source === "journalctl") {
      const r = await this.runner("journalctl", ["-t", "systemd-coredump", "-o", "json", "--no-pager", since], { timeout: 10_000 });
      if (r.code === 127) { this.source = "none"; return []; }
      return parseJournal(r.out);
    }
    return [];
  }

  private apportFiles(): string[] {
    try { return readdirSync(this.crashDir).filter((f) => f.endsWith(".crash")); } catch { return []; }
  }

  private apportCrashes(): RawCrash[] {
    const out: RawCrash[] = [];
    for (const f of this.apportFiles()) {
      const p = parseApportName(f);
      if (!p) continue;
      const file = join(this.crashDir, f);
      let mtime = 0;
      try { mtime = statSync(file).mtimeMs; } catch {}
      // Apport rewrites the same file name for a repeat crash: the mtime makes it new again.
      out.push({ key: `apport:${f}:${mtime}`, app: p.app, uid: p.uid, file, time: mtime || undefined });
    }
    return out;
  }

  private async saveReport(raw: RawCrash): Promise<string> {
    const dir = this.reportsDir;
    const name = `${raw.app.replace(/[^\w.-]+/g, "_")}-${new Date(raw.time ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.txt`;
    const file = join(dir, name);
    let text = "";
    if (raw.pid) {
      const r = await this.runner("coredumpctl", ["info", "--no-pager", String(raw.pid)], { timeout: 15_000 });
      text = r.out || r.err;
    }
    if (!text) text = `${raw.app} (pid ${raw.pid ?? "?"}, ${raw.exe ?? "unknown executable"}) crashed${raw.signal ? ` with signal ${raw.signal}` : ""}.\n`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text.slice(0, 200_000));
    } catch {}
    return file;
  }
}
