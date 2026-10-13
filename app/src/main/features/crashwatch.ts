import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, win32 } from "node:path";
import { log } from "../log";
import { CACHE } from "../paths";
import { run } from "./run";

// Watches for new crashes of the user's apps, so "why did it crash?" knows which one. Port of CrashWatcher
// (overlay/Sources/Tasks.swift), which watches ~/Library/Logs/DiagnosticReports. On Linux crashes land in:
//   - systemd-coredump: `coredumpctl --json=short list --since=…` (or the journal: `journalctl -t systemd-coredump -o json`)
//   - Apport (Ubuntu): /var/crash/*.crash
// The coredump's `coredumpctl info` text is saved to CACHE/crashes so the question can point at a file, like macOS.
// On Windows, Windows Error Reporting writes a folder per crash with a Report.wer (UTF-16 INI) under
// %LOCALAPPDATA%\Microsoft\Windows\WER\ReportQueue (pending) and ReportArchive (sent); the user's own apps only.
// Its text is saved as UTF-8 to CACHE/crashes, so the assistant can read it.

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
  "baloo", "packagekit", "snapd", "apport", "service", "agent", "daemon", "helper",
  // Windows' own processes and the usual background apps
  "vcli-win", "explorer.exe", "msedge", "msedgewebview2", "searchhost", "searchapp", "searchui", "startmenuexperiencehost",
  "shellexperiencehost", "textinputhost", "runtimebroker", "svchost", "dllhost", "werfault", "backgroundtaskhost",
  "applicationframehost", "systemsettings", "widgets", "phoneexperiencehost", "onedrive", "teams", "msteams", "ctfmon",
  "sihost", "taskhostw", "smartscreen", "securityhealth", "lockapp", "gamebar", "yourphone", "crossdevice", "nvcontainer",
  "nvidia", "igfx", "realtek", "ms-teams", "widgetservice"];

export const isIgnored = (app: string) => IGNORED.some((i) => app.toLowerCase().includes(i));

/** A crash a source reports, before the noise filter. */
export interface RawCrash { key: string; app: string; pid?: number; uid?: number; exe?: string; signal?: number; time?: number; file?: string; text?: string }

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

/** Text of a report file: UTF-16LE (with or without its BOM, as WER writes it) or UTF-8. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  // No BOM: mostly-zero odd bytes mean UTF-16LE text.
  let zeros = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++;
  return n > 8 && zeros > n / 4 ? buf.toString("utf16le") : buf.toString("utf8");
}

/** Crash event types (not hangs, not WER's own reports): native crashes, buffer overruns, .NET and Store app crashes. */
export const WER_CRASH_TYPES = new Set(["appcrash", "bex", "bex64", "clr20r3", "moappcrash", "mobex", "moappcrashex"]);

/** FILETIME (100 ns ticks since 1601) → epoch ms. */
export const filetimeToMs = (ticks: string): number | undefined => {
  if (!/^\d+$/.test(ticks)) return undefined;
  return Number(BigInt(ticks) / 10_000n) - 11_644_473_600_000;
};

/** A Report.wer: `Key=Value` lines (EventType, EventTime, AppName, AppPath, Sig[0].Value…). Null when it isn't a crash. */
export function parseWer(buf: Buffer | string, key: string): (RawCrash & { eventType: string; text: string }) | null {
  const text = typeof buf === "string" ? buf : decodeText(buf);
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !kv.has(line.slice(0, i))) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const eventType = kv.get("EventType") ?? "";
  if (!WER_CRASH_TYPES.has(eventType.toLowerCase())) return null;
  const exe = kv.get("AppPath") || undefined;
  const exeName = exe ? win32.basename(exe) : kv.get("Sig[0].Value") || kv.get("OriginalFilename") || kv.get("NsAppName") || "";
  const app = kv.get("AppName") || exeName.replace(/\.exe$/i, "");
  if (!app) return null;
  return { key, app, exe: exe ?? (exeName || undefined), time: filetimeToMs(kv.get("EventTime") ?? ""), eventType, text };
}

/** The per-user WER folders. */
export function werDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return ["ReportQueue", "ReportArchive"].map((d) => win32.join(local, "Microsoft", "Windows", "WER", d));
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

  constructor(private opts: { crashDir?: string; reportsDir?: string; uid?: number; runner?: Runner; interval?: number; platform?: string; werDirs?: string[] } = {}) {}

  private get windows() { return (this.opts.platform ?? process.platform) === "win32"; }
  private get crashDir() { return this.opts.crashDir ?? "/var/crash"; }
  private get reportsDir() { return this.opts.reportsDir ?? join(CACHE, "crashes"); }
  private get uid() { return this.opts.uid ?? process.getuid?.() ?? 0; }
  private get runner() { return this.opts.runner ?? run; }

  async start() {
    if (this.timer) return;
    this.primed = false;
    this.since = Date.now();
    // Crashes that happened before we started aren't news.
    for (const c of this.windows ? this.werCrashes() : this.apportCrashes()) this.seen.add(c.key);
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
      const found = this.windows ? this.werCrashes() : [...await this.coredumps(), ...this.apportCrashes()];
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
    if (isIgnored(raw.app) || (this.windows && raw.exe && isIgnored(win32.basename(raw.exe)))) return;
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

  /** WER report folders (one per crash), newest reports included as soon as their Report.wer is readable. */
  private werCrashes(): RawCrash[] {
    const out: RawCrash[] = [];
    for (const dir of this.opts.werDirs ?? werDirs()) {
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const key = `wer:${name}`;
        if (this.seen.has(key)) continue;
        let buf: Buffer;
        try { buf = readFileSync(join(dir, name, "Report.wer")); } catch { continue; } // still being written
        const c = parseWer(buf, key);
        if (c) out.push(c); else this.seen.add(key);
      }
    }
    return out;
  }

  private async saveReport(raw: RawCrash): Promise<string> {
    const dir = this.reportsDir;
    const name = `${raw.app.replace(/[^\w.-]+/g, "_")}-${new Date(raw.time ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.txt`;
    const file = join(dir, name);
    let text = raw.text ?? "";
    if (!text && raw.pid) {
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
