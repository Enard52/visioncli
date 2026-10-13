import "./_env";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Autostart, RUN_KEY, runValue } from "../../src/main/features/autostart";
import { CrashWatcher, decodeText, filetimeToMs, parseWer } from "../../src/main/features/crashwatch";
import { ModelInstaller, uvInstallCommand } from "../../src/main/features/installer";
import type { RunResult } from "../../src/main/features/run";
import { installKind, pickAsset, Updater } from "../../src/main/features/updater";

type Call = { cmd: string; args: string[] };
function fakeRunner(reply: (c: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    const c = { cmd, args };
    calls.push(c);
    return { code: 0, out: "", err: "", ...reply(c) };
  };
  return { calls, runner };
}

// ── Start at Login ──────────────────────────────────────────────────────────────────────────────────────────────

describe("autostart: the HKCU Run key", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\VisionCLI\\VisionCLI.exe";

  test("on: reg add with the quoted exe; off: reg delete", async () => {
    let value: string | null = null;
    const { calls, runner } = fakeRunner(({ args }) => {
      if (args[0] === "add") { value = args[args.indexOf("/d") + 1]; return {}; }
      if (args[0] === "delete") { const had = value != null; value = null; return had ? {} : { code: 1, err: "ERROR: The system was unable to find the specified registry key or value." }; }
      return value == null ? { code: 1, err: "ERROR: The system was unable to find the specified registry key or value." }
        : { out: `\r\n${RUN_KEY}\r\n    VisionCLI    REG_SZ    ${value}\r\n\r\n` };
    });
    const a = new Autostart({ exec: [exe], runner, platform: "win32" });
    assert.equal(await a.isEnabled(), false);
    assert.equal(await a.set(true), "registry");
    assert.deepEqual(calls.find((c) => c.args[0] === "add"), { cmd: "reg.exe", args: ["add", RUN_KEY, "/v", "VisionCLI", "/t", "REG_SZ", "/d", exe, "/f"] });
    assert.equal(await a.isEnabled(), true);
    assert.equal(await a.set(false), "off");
    assert.equal(await a.isEnabled(), false);
    // already off: deleting the missing value isn't an error
    assert.equal(await a.set(false), "off");
    assert.ok(calls.every((c) => c.cmd === "reg.exe"), "no systemctl on Windows");
  });

  test("a failing reg add is reported", async () => {
    const { runner } = fakeRunner(() => ({ code: 1, err: "ERROR: Access is denied." }));
    await assert.rejects(new Autostart({ exec: [exe], runner, platform: "win32" }).set(true), /Access is denied/);
  });

  test("Run value quoting", () => {
    assert.equal(runValue(["C:\\VisionCLI\\VisionCLI.exe"]), "C:\\VisionCLI\\VisionCLI.exe");
    assert.equal(runValue(["C:\\Program Files\\electron.exe", "C:\\src\\app"]), '"C:\\Program Files\\electron.exe" C:\\src\\app');
  });
});

// ── Crashes (Windows Error Reporting) ───────────────────────────────────────────────────────────────────────────

const ticks = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);

/** A Report.wer as WER writes it: UTF-16LE with a BOM, CRLF lines (fields from a real APPCRASH report). */
function werFile(o: { eventType?: string; app?: string; exe: string; time: number }): Buffer {
  const exeName = o.exe.slice(o.exe.lastIndexOf("\\") + 1);
  const text = [
    "Version=1", `EventType=${o.eventType ?? "APPCRASH"}`, `EventTime=${ticks(o.time)}`, "ReportType=2", "Consent=1",
    "ReportStatus=268435456", "ReportIdentifier=3a6f6d1c-6a0e-4c47-9f39-3a2b1e8f7a10", "Wow64Host=34404", `NsAppName=${exeName}`,
    "IsFatal=1", "Response.type=4", "Sig[0].Name=Application Name", `Sig[0].Value=${exeName}`, "Sig[1].Name=Application Version",
    "Sig[1].Value=1.4.2.0", "Sig[3].Name=Fault Module Name", "Sig[3].Value=ntdll.dll", "Sig[6].Name=Exception Code", "Sig[6].Value=c0000005",
    "DynamicSig[1].Name=OS Version", "DynamicSig[1].Value=10.0.22631.2.0.0.256.48", "UI[2]=" + o.exe, "UI[3]=" + (o.app ?? exeName) + " has stopped working",
    "LoadedModule[0]=" + o.exe, "LoadedModule[1]=C:\\WINDOWS\\SYSTEM32\\ntdll.dll", "State[0].Key=Transport.DoneStage1", "State[0].Value=1",
    "FriendlyEventName=Stopped working", "ConsentKey=APPCRASH", ...(o.app ? [`AppName=${o.app}`] : []), `AppPath=${o.exe}`,
    "ReportDescription=Stopped working", "ApplicationIdentity=00000000000000000000000000000000",
  ].join("\r\n") + "\r\n";
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

describe("crashwatch: WER reports", () => {
  test("Report.wer parsing", () => {
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const c = parseWer(werFile({ app: "My App", exe: "C:\\Users\\me\\AppData\\Local\\Programs\\MyApp\\MyApp.exe", time: now }), "wer:x");
    assert.equal(c?.app, "My App");
    assert.equal(c?.exe, "C:\\Users\\me\\AppData\\Local\\Programs\\MyApp\\MyApp.exe");
    assert.equal(c?.time, now);
    assert.equal(c?.eventType, "APPCRASH");
    assert.match(c!.text, /Fault Module Name\r?\nSig\[3\]\.Value=ntdll\.dll/);
    // no AppName: the exe's name; .NET and Store crashes count, hangs don't
    assert.equal(parseWer(werFile({ exe: "C:\\tools\\build.exe", time: now, eventType: "CLR20r3" }), "k")?.app, "build");
    assert.equal(parseWer(werFile({ exe: "C:\\tools\\x.exe", time: now, eventType: "BEX64" }), "k")?.eventType, "BEX64");
    assert.equal(parseWer(werFile({ exe: "C:\\tools\\x.exe", time: now, eventType: "MoAppCrash" }), "k")?.app, "x");
    assert.equal(parseWer(werFile({ exe: "C:\\tools\\x.exe", time: now, eventType: "AppHangB1" }), "k"), null);
    assert.equal(filetimeToMs("133000000000000000"), 1655526400000);
    assert.equal(filetimeToMs("nope"), undefined);
    assert.equal(decodeText(Buffer.from("A=1\r\n", "utf16le")), "A=1\r\n"); // no BOM
    assert.equal(decodeText(Buffer.from("A=1\n", "utf8")), "A=1\n");
  });

  test("watcher: new reports in ReportQueue/ReportArchive, noise filtered, 45-minute window, UTF-8 copy saved", async () => {
    const root = mkdtempSync(join(tmpdir(), "vcli-wer-"));
    const queue = join(root, "ReportQueue"), archive = join(root, "ReportArchive"), reports = join(root, "saved");
    mkdirSync(queue); mkdirSync(archive);
    const write = (dir: string, name: string, buf: Buffer) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "Report.wer"), buf); };
    write(archive, "AppCrash_Old.exe_abc_def_1", werFile({ exe: "C:\\old\\Old.exe", time: Date.now() - 3600_000 }));

    const w = new CrashWatcher({ platform: "win32", werDirs: [queue, archive], reportsDir: reports, interval: 3600_000 });
    const seen: string[] = [];
    w.onCrash = (c) => seen.push(c.app);
    await w.start();
    write(queue, "AppCrash_MyApp.exe_1_2_3", werFile({ app: "MyApp", exe: "C:\\apps\\MyApp.exe", time: Date.now() + 1000 }));
    write(queue, "AppCrash_msedge.exe_1_2_3", werFile({ app: "Microsoft Edge", exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", time: Date.now() + 1000 }));
    mkdirSync(join(queue, "Critical_half_written")); // no Report.wer yet: picked up on a later poll
    await w.poll();
    assert.deepEqual(seen, ["MyApp"], "the old report and Edge are ignored");
    const file = w.last!.file;
    assert.ok(file.startsWith(reports) && existsSync(file));
    assert.match(readFileSync(file, "utf8"), /AppPath=C:\\apps\\MyApp\.exe/);
    assert.match(w.questionTag()!, /^\(If relevant: MyApp crashed 1 min ago; crash report at .*\.txt\.\)$/);
    assert.equal(w.recent(Date.now() + 46 * 60_000), null);
    // the same report moving from the queue to the archive isn't a new crash
    write(archive, "AppCrash_MyApp.exe_1_2_3", werFile({ app: "MyApp", exe: "C:\\apps\\MyApp.exe", time: Date.now() + 1000 }));
    writeFileSync(join(queue, "Critical_half_written", "Report.wer"), werFile({ app: "Late", exe: "C:\\apps\\Late.exe", time: Date.now() + 1000 }));
    await w.poll();
    assert.deepEqual(seen, ["MyApp", "Late"]);
    w.stop();
  });
});

// ── Updates ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("updater: the NSIS installer", () => {
  const release = (v: string) => ({
    tag_name: `v${v}`, html_url: `https://github.com/thethirdsourcers/visioncli/releases/tag/v${v}`,
    assets: ["linux-x86_64.AppImage", "windows-x64.exe", "windows-x64.exe.minisig", "windows-arm64.exe", "windows-arm64.exe.minisig"]
      .map((s) => ({ name: `VisionCLI-${v}-${s}`, browser_download_url: `https://dl/VisionCLI-${v}-${s}` })),
  });

  test("install kind and asset", () => {
    assert.equal(installKind({}, "C:\\Users\\me\\AppData\\Local\\Programs\\VisionCLI\\VisionCLI.exe", "win32"), "nsis");
    assert.equal(installKind({}, "C:\\src\\visioncli\\app\\node_modules\\electron\\dist\\electron.exe", "win32"), "dev");
    assert.equal(installKind({ PORTABLE_EXECUTABLE_FILE: "C:\\x\\VisionCLI.exe" }, "C:\\tmp\\VisionCLI.exe", "win32"), "dev");
    assert.equal(installKind({ APPIMAGE: "/x.AppImage" }, "/tmp/.mount/visioncli", "linux"), "appimage");
    const x64 = pickAsset(release("1.0.0"), "nsis", "x64");
    assert.equal(x64?.name, "VisionCLI-1.0.0-windows-x64.exe");
    assert.equal(x64?.sigUrl, "https://dl/VisionCLI-1.0.0-windows-x64.exe.minisig");
    assert.equal(pickAsset(release("1.0.0"), "nsis", "arm64")?.name, "VisionCLI-1.0.0-windows-arm64.exe");
    assert.equal(pickAsset(release("1.0.0"), "appimage", "x64")?.name, "VisionCLI-1.0.0-linux-x86_64.AppImage");
  });

  function fakeFetch(files: Record<string, Buffer | string | object>) {
    return (async (url: string | URL) => {
      const body = files[String(url)];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  }

  test("downloads, verifies the signature, runs the installer silently and quits", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    const exe = Buffer.from("MZ fake installer");
    const tmp = mkdtempSync(join(tmpdir(), "vcli-upd-"));
    const launched: { file: string; args: string[]; bytes: string }[] = [];
    let quit = 0;
    const u = new Updater({
      currentVersion: "0.9.1", openUrl: () => assert.fail("no release page"), quit: () => quit++, publicKey: raw, arch: "x64", platform: "win32",
      execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\VisionCLI\\VisionCLI.exe", env: {}, tmpDir: tmp,
      launch: (file, args) => launched.push({ file, args, bytes: readFileSync(file, "utf8") }),
      fetch: fakeFetch({
        "https://api.github.com/repos/thethirdsourcers/visioncli/releases/latest": release("1.0.0"),
        "https://dl/VisionCLI-1.0.0-windows-x64.exe": exe,
        "https://dl/VisionCLI-1.0.0-windows-x64.exe.minisig": sign(null, exe, privateKey).toString("base64"),
      }),
    });
    const found = await u.check(true);
    assert.equal(found?.kind, "nsis");
    assert.match(u.installPrompt(found!), /installer/);
    await u.install();
    assert.equal(launched.length, 1);
    assert.deepEqual(launched[0].args, ["--updated", "/S", "--force-run"]);
    assert.equal(launched[0].bytes, "MZ fake installer");
    assert.ok(launched[0].file.startsWith(tmp) && launched[0].file.endsWith(".exe"));
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(quit, 1);
  });

  test("a bad signature is refused and nothing runs", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519").privateKey;
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    const exe = Buffer.from("MZ tampered");
    const errors: string[] = [];
    const u = new Updater({
      currentVersion: "0.9.1", openUrl: () => {}, quit: () => assert.fail("must not quit"), publicKey: raw, arch: "x64", platform: "win32",
      execPath: "C:\\VisionCLI\\VisionCLI.exe", env: {}, tmpDir: mkdtempSync(join(tmpdir(), "vcli-upd-")),
      launch: () => assert.fail("must not run"),
      fetch: fakeFetch({
        "https://api.github.com/repos/thethirdsourcers/visioncli/releases/latest": release("1.0.0"),
        "https://dl/VisionCLI-1.0.0-windows-x64.exe": exe,
        "https://dl/VisionCLI-1.0.0-windows-x64.exe.minisig": sign(null, exe, other).toString("base64"),
      }),
    });
    u.onError = (m) => errors.push(m);
    await u.check(true);
    await u.install();
    assert.deepEqual(errors, ["The update's signature is invalid."]);
  });
});

// ── Kokoro / uv ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("installer on Windows", () => {
  test("uv comes from astral.sh's PowerShell installer", () => {
    assert.deepEqual(uvInstallCommand("win32"), ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"]]);
    assert.equal(uvInstallCommand("linux")[0], "/bin/sh");
  });

  test("Kokoro: installs uv, downloads the models, warms up uv run", async () => {
    const models = mkdtempSync(join(tmpdir(), "vcli-models-"));
    let uv: string | null = null;
    const { calls, runner } = fakeRunner((c) => { if (c.cmd === "powershell.exe") uv = "C:\\Users\\me\\.local\\bin\\uv.exe"; return {}; });
    const fetch = (async () => new Response("model-bytes", { status: 200 })) as typeof globalThis.fetch;
    const inst = new ModelInstaller({ modelsDir: models, runner: runner as never, fetch, platform: "win32", uv: () => uv });
    const finished: [string, string | null][] = [];
    inst.onFinished = (k, e) => finished.push([k, e]);
    await inst.installKokoro();
    assert.deepEqual(finished, [["Kokoro voices", null]]);
    assert.equal(calls[0].cmd, "powershell.exe");
    assert.equal(calls[1].cmd, "C:\\Users\\me\\.local\\bin\\uv.exe");
    assert.deepEqual(calls[1].args.slice(0, 2), ["run", "--quiet"]);
    assert.ok(inst.kokoroInstalled());
  });
});
