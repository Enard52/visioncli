import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CrashWatcher, isIgnored, parseApportName, parseCoredumpctl, parseJournal, type RawCrash } from "../../src/main/features/crashwatch";
import { CrashReporter, lastLines } from "../../src/main/features/crashreporter";
import type { RunResult } from "../../src/main/features/run";

// systemd 252 (Debian bookworm) `coredumpctl --json=short list` output.
const COREDUMPCTL = `[{"time":1760351234567890,"pid":4321,"uid":1000,"gid":1000,"sig":11,"corefile":"present","exe":"/home/me/projects/myapp/target/debug/myapp","size":1234567},
{"time":1760351239000000,"pid":999,"uid":0,"gid":0,"sig":6,"corefile":"present","exe":"/usr/lib/systemd/systemd-udevd","size":1000},
{"time":1760351240000000,"pid":5555,"uid":1000,"gid":1000,"sig":11,"corefile":"inaccessible","exe":"/usr/bin/gnome-shell","size":null}]`;

// `journalctl -t systemd-coredump -o json` lines (real field names; trimmed).
const JOURNAL = [
  JSON.stringify({ __REALTIME_TIMESTAMP: "1760351234567890", SYSLOG_IDENTIFIER: "systemd-coredump", COREDUMP_PID: "4321", COREDUMP_UID: "1000", COREDUMP_SIGNAL: "11", COREDUMP_EXE: "/usr/local/bin/myapp", COREDUMP_COMM: "myapp", COREDUMP_TIMESTAMP: "1760351234000000", MESSAGE: "Process 4321 (myapp) of user 1000 dumped core.\n\nStack trace of thread 4321:\n#0  0x0000 main (myapp + 0x1139)" }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1760351300000000", SYSLOG_IDENTIFIER: "systemd-coredump", MESSAGE: "Process 777 (node) of user 1000 dumped core." }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1760351300000001", SYSLOG_IDENTIFIER: "systemd-coredump", MESSAGE: "Removed old coredump core.x.zst." }),
  "not json",
].join("\n");

describe("crash sources", () => {
  test("coredumpctl --json=short", () => {
    const c = parseCoredumpctl(COREDUMPCTL);
    assert.equal(c.length, 3);
    assert.deepEqual(c[0], { key: "core:4321:1760351234567890", app: "myapp", pid: 4321, uid: 1000, exe: "/home/me/projects/myapp/target/debug/myapp", signal: 11, time: 1760351234567 });
    assert.deepEqual(parseCoredumpctl("No coredumps found."), []);
  });
  test("journalctl -o json", () => {
    const c = parseJournal(JOURNAL);
    assert.equal(c.length, 2);
    assert.equal(c[0].app, "myapp");
    assert.equal(c[0].uid, 1000);
    assert.equal(c[0].signal, 11);
    assert.equal(c[1].app, "node");
    assert.equal(c[1].pid, 777);
  });
  test("apport names", () => {
    assert.deepEqual(parseApportName("_usr_bin_myapp.1000.crash"), { app: "myapp", uid: 1000 });
    assert.deepEqual(parseApportName("_opt_tool_bin_tool.crash"), { app: "tool", uid: undefined });
    assert.equal(parseApportName("foo.txt"), null);
  });
  test("noise filter", () => {
    for (const a of ["gnome-shell", "VisionCLI", "chrome", "python3", "systemd-udevd", "tracker-miner-fs-3", "xdg-desktop-portal-gnome"]) assert.ok(isIgnored(a), a);
    assert.ok(!isIgnored("myapp"));
  });
});

describe("CrashWatcher", () => {
  test("new coredumps of this user's apps, 45 min window, question tag with a saved report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcli-crash-"));
    const calls: string[][] = [];
    const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push([cmd, ...args]);
      if (cmd === "coredumpctl" && args[0] === "info") return { code: 0, out: `PID: ${args[2]}\nSignal: 11 (SEGV)\nStack trace…`, err: "" };
      if (cmd === "coredumpctl") return { code: 0, out: COREDUMPCTL, err: "" };
      return { code: 127, out: "", err: "" };
    };
    const w = new CrashWatcher({ crashDir: join(dir, "crash"), reportsDir: join(dir, "reports"), uid: 1000, runner, interval: 60_000, platform: "linux" });
    const seen: string[] = [];
    w.onCrash = (c) => seen.push(c.app);
    await w.start();
    (w as any).since = 1760351230000; // the fixture's crashes are after the watcher started
    await w.poll();
    await w.poll(); // seen once only
    w.stop();
    assert.deepEqual(seen, ["myapp"]); // uid 0 (udevd) and gnome-shell (noise) skipped
    assert.ok(calls.some((c) => c.join(" ").startsWith("coredumpctl --json=short --no-pager list --since=@")));
    const recent = w.recent()!;
    assert.match(readFileSync(recent.file, "utf8"), /PID: 4321/);
    const tag = w.questionTag(recent.date + 3 * 60_000)!;
    assert.equal(tag, `(If relevant: myapp crashed 3 min ago; crash report at ${recent.file}.)`);
    assert.equal(w.recent(recent.date + 46 * 60_000), null);
  });

  test("falls back to the journal, then reads Apport files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcli-crash-"));
    mkdirSync(join(dir, "crash"));
    writeFileSync(join(dir, "crash", "_usr_bin_old.1000.crash"), "old");
    const runner = async (cmd: string): Promise<RunResult> =>
      cmd === "journalctl" ? { code: 0, out: JOURNAL, err: "" } : cmd === "coredumpctl" ? { code: 127, out: "", err: "not found" } : { code: 0, out: "", err: "" };
    const w = new CrashWatcher({ crashDir: join(dir, "crash"), reportsDir: join(dir, "r"), uid: 1000, runner, interval: 60_000, platform: "linux" });
    const seen: string[] = [];
    w.onCrash = (c) => seen.push(`${c.app}:${c.file.endsWith(".crash") ? "apport" : "core"}`);
    await w.start();
    (w as any).since = 1760351230000;
    writeFileSync(join(dir, "crash", "_usr_bin_fresh.1000.crash"), "ProblemType: Crash");
    writeFileSync(join(dir, "crash", "_usr_bin_other.1001.crash"), "someone else");
    await w.poll();
    w.stop();
    assert.deepEqual(seen.sort(), ["fresh:apport", "myapp:core", "node:core"]); // not "old" (already there) nor uid 1001
  });
});

describe("CrashReporter", () => {
  test("marker → crashed-last-time message, loop guard (4 in 180 s), crash log with the last log lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcli-cr-"));
    const appLog = join(dir, "visioncli.log");
    writeFileSync(appLog, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const cr = new CrashReporter({ sup: dir, logs: dir, appLog, version: "9.9.9", dumpsDir: () => null });
    assert.equal(cr.install(), null);
    assert.match(cr.install()!, /restarted after a crash/);
    const now = 1_000_000;
    assert.equal(cr.isCrashLooping(now), false);
    assert.equal(cr.isCrashLooping(now + 1), false);
    assert.equal(cr.isCrashLooping(now + 2), false);
    assert.equal(cr.isCrashLooping(now + 3), true);
    assert.equal(cr.isCrashLooping(now + 500), false); // old stamps expire
    cr.markCleanExit();
    assert.equal(existsSync(join(dir, "running.marker")), false);
    cr.record("Uncaught exception TypeError: x is undefined", "TypeError: x\n    at a.js:1");
    const log = readFileSync(join(dir, "visioncli-crashes.log"), "utf8");
    assert.match(log, /==== CRASH .* \(VisionCLI 9\.9\.9\)\nUncaught exception TypeError/);
    assert.match(log, /Last log lines:\nline 20\n[\s\S]*line 59\n$/);
    assert.equal(lastLines(appLog, 2).join(","), "line 58,line 59");
  });

  test("notes a fresh minidump", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcli-cr-"));
    const dumps = join(dir, "dumps", "completed");
    mkdirSync(dumps, { recursive: true });
    writeFileSync(join(dumps, "abc.dmp"), "x");
    writeFileSync(join(dumps, "old.dmp"), "x");
    utimesSync(join(dumps, "old.dmp"), new Date(0), new Date(0));
    const cr = new CrashReporter({ sup: dir, logs: dir, dumpsDir: () => join(dir, "dumps") });
    writeFileSync(join(dir, "running.marker"), "");
    assert.ok(cr.install());
    assert.match(readFileSync(join(dir, "visioncli-crashes.log"), "utf8"), /full report: .*abc\.dmp/);
  });
});

export type { RawCrash };
