import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_FILE } from "../log";
import { LOGS, SUP } from "../paths";

// Keeps crashes from being a mystery and from being fatal (port of overlay/Sources/CrashReporter.swift):
// - writes uncaught exceptions (with stack + the last 40 log lines) to LOGS/visioncli-crashes.log;
// - native crashes: Electron's crashReporter keeps minidumps locally (nothing is uploaded); on the next launch the
//   newest dump is noted in the crash log and the user is told it recovered;
// - stops restart loops (systemd restarts the app after a crash; see autostart.ts): 4 crashes in 180 s.

export class CrashReporter {
  readonly logFile: string;
  private readonly historyFile: string;
  private readonly markerFile: string;
  private installed = false;

  constructor(private opts: { sup?: string; logs?: string; appLog?: string; version?: string; dumpsDir?: () => string | null } = {}) {
    this.logFile = join(opts.logs ?? LOGS, "visioncli-crashes.log");
    this.historyFile = join(opts.sup ?? SUP, "crash-history.txt");
    this.markerFile = join(opts.sup ?? SUP, "running.marker");
  }

  /** Call first thing at launch. Returns a message if the previous run crashed. */
  install(): string | null {
    mkdirSync(join(this.markerFile, ".."), { recursive: true });
    mkdirSync(join(this.logFile, ".."), { recursive: true });
    if (!this.installed) {
      this.installed = true;
      process.on("uncaughtException", (e) => {
        this.record(`Uncaught exception ${e?.name ?? "Error"}: ${e?.message ?? e}`, e?.stack);
        // Like an uncaught NSException: the process is in an unknown state. Exit non-zero so systemd restarts it.
        this.exitAfterCrash();
      });
      process.on("unhandledRejection", (reason) => {
        const e = reason as Error;
        this.record(`Unhandled promise rejection: ${e?.message ?? reason}`, e?.stack);
      });
      startNativeCrashReporter();
    }
    const crashedLastTime = existsSync(this.markerFile);
    writeFileSync(this.markerFile, "");
    if (!crashedLastTime) return null;
    this.appendSystemReport();
    return "VisionCLI restarted after a crash. Details: VisionCLI menu → Settings… → Advanced → Open Crash Log.";
  }

  /** Clean shutdown: no crash next launch. */
  markCleanExit() { rmSync(this.markerFile, { force: true }); }

  /** True if it's crashing over and over; the app then exits normally (code 0) so systemd stops restarting it. */
  isCrashLooping(now = Date.now() / 1000): boolean {
    let stamps: number[] = [];
    try { stamps = readFileSync(this.historyFile, "utf8").split("\n").map(Number).filter((n) => n && now - n < 180); } catch {}
    if (existsSync(this.markerFile)) stamps.push(now);
    try { writeFileSync(this.historyFile, stamps.map(String).join("\n")); } catch {}
    return stamps.length >= 4;
  }

  record(title: string, stack?: string) {
    const version = this.opts.version ?? process.env.npm_package_version ?? "?";
    let text = `\n==== CRASH ${new Date().toISOString()} (VisionCLI ${version})\n`;
    text += `${title}\n\nStack:\n${(stack ?? "").split("\n").slice(0, 40).join("\n")}`;
    text += `\n\nLast log lines:\n${lastLines(this.opts.appLog ?? LOG_FILE, 40).join("\n")}\n`;
    try { appendFileSync(this.logFile, text); } catch {}
  }

  private exitAfterCrash() {
    setTimeout(() => process.exit(1), 50).unref?.();
  }

  /** Notes the newest local minidump (from the last ten minutes) in the crash log. */
  private appendSystemReport() {
    const dir = this.opts.dumpsDir ? this.opts.dumpsDir() : electronDumpsDir();
    if (!dir) return;
    const dumps: { path: string; mtime: number }[] = [];
    const walk = (d: string, depth: number) => {
      let kids;
      try { kids = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const k of kids) {
        const p = join(d, k.name);
        if (k.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (k.name.endsWith(".dmp")) { try { dumps.push({ path: p, mtime: statSync(p).mtimeMs }); } catch {} }
      }
    };
    walk(dir, 0);
    dumps.sort((a, b) => b.mtime - a.mtime);
    const latest = dumps[0];
    if (!latest || Date.now() - latest.mtime > 600_000) return;
    try { appendFileSync(this.logFile, `\n---- native crash (minidump)\nfull report: ${latest.path}\n`); } catch {}
  }
}

/** The last `n` lines of a file, reading at most its last 64 KB. */
export function lastLines(file: string, n: number): string[] {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return []; }
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function electron(): typeof import("electron") | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const e = require("electron");
    return typeof e === "object" && e?.app ? e : null;
  } catch {
    return null;
  }
}

function startNativeCrashReporter() {
  const e = electron();
  try { e?.crashReporter.start({ uploadToServer: false, compress: false }); } catch {}
}

function electronDumpsDir(): string | null {
  try { return electron()?.app.getPath("crashDumps") ?? null; } catch { return null; }
}
