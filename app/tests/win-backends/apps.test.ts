import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editorCommand } from "../../src/main/desktop/apps";
import {
  type FsLike, type WinEntry, cmdQuote, createWinApps, editorFromWinProcess, expandEnv, findWinEntry, installedWinEditor, launchArgv,
  lnkTarget, mergeEntries, openArgv, openWithShellArgv, parseShellLink, parseStartApps, readShortcuts, resolveWinFile, splitCommandLine,
  startMenuDirs, whichWin,
} from "../../src/main/desktop/winapps";

// ── a .lnk built byte by byte from [MS-SHLLINK] (independent of the parser) ──

interface LnkSpec {
  idList?: number[];                 // raw ItemIDList bytes
  local?: string; suffix?: string;   // LinkInfo, VolumeIDAndLocalBasePath
  unicodeInfo?: boolean;             // LinkInfo header 0x24 with the Unicode offsets
  net?: string;                      // LinkInfo, CommonNetworkRelativeLink only
  unicode?: boolean;                 // IsUnicode for StringData
  name?: string; rel?: string; work?: string; args?: string; icon?: string;
  env?: string;                      // EnvironmentVariableDataBlock target
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const ansiZ = (s: string) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])]);
const utf16Z = (s: string) => Buffer.concat([Buffer.from(s, "utf16le"), Buffer.from([0, 0])]);

function buildLnk(s: LnkSpec): Buffer {
  let flags = 0;
  const parts: Buffer[] = [];
  if (s.idList) { flags |= 0x1; parts.push(u16(s.idList.length), Buffer.from(s.idList)); }
  if (s.local !== undefined || s.net !== undefined) {
    flags |= 0x2;
    const headerSize = s.unicodeInfo ? 0x24 : 0x1c;
    const body: Buffer[] = [];
    let at = headerSize;
    const place = (b: Buffer) => { const o = at; body.push(b); at += b.length; return o; };
    let volOff = 0, localOff = 0, netOff = 0, suffixOff = 0, localU = 0, suffixU = 0, liFlags = 0;
    if (s.local !== undefined) {
      liFlags |= 1;
      volOff = place(Buffer.concat([u32(0x11), u32(3), u32(0x1234abcd), u32(0x10), Buffer.from([0])])); // VolumeID, empty label
      localOff = place(ansiZ(s.unicodeInfo ? "?" : s.local));
    } else {
      liFlags |= 2;
      const net = ansiZ(s.net!);
      netOff = place(Buffer.concat([u32(0x14 + net.length), u32(0), u32(0x14), u32(0), u32(0), net]));
    }
    suffixOff = place(ansiZ(s.unicodeInfo ? "" : s.suffix ?? ""));
    if (s.unicodeInfo) { localU = place(utf16Z(s.local!)); suffixU = place(utf16Z(s.suffix ?? "")); }
    const header = Buffer.concat([u32(0), u32(headerSize), u32(liFlags), u32(volOff), u32(localOff), u32(netOff), u32(suffixOff),
      ...(s.unicodeInfo ? [u32(localU), u32(suffixU)] : [])]);
    const info = Buffer.concat([header, ...body]);
    info.writeUInt32LE(info.length, 0);
    parts.push(info);
  }
  if (s.unicode) flags |= 0x80;
  const str = (v: string) => Buffer.concat([u16(v.length), Buffer.from(v, s.unicode ? "utf16le" : "latin1")]);
  for (const [bit, v] of [[0x4, s.name], [0x8, s.rel], [0x10, s.work], [0x20, s.args], [0x40, s.icon]] as const) {
    if (v !== undefined) { flags |= bit; parts.push(str(v)); }
  }
  if (s.env !== undefined) {
    const block = Buffer.alloc(0x314);
    block.writeUInt32LE(0x314, 0); block.writeUInt32LE(0xa0000001, 4);
    Buffer.from(s.env, "latin1").copy(block, 8);
    Buffer.from(s.env, "utf16le").copy(block, 268);
    parts.push(block);
  }
  parts.push(u32(0)); // TerminalBlock
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  header.writeUInt32LE(flags, 0x14);
  header.writeUInt32LE(1, 0x3c); // SW_SHOWNORMAL
  return Buffer.concat([header, ...parts]);
}

test("parseShellLink: LinkInfo local path (ANSI) + Unicode strings, after an IDList", () => {
  const l = parseShellLink(buildLnk({
    idList: [0x14, 0, 0x1f, 0x50, ...Array(16).fill(7), 0, 0], local: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    unicode: true, name: "Access the Internet", work: "C:\\Program Files\\Google\\Chrome\\Application", args: "--profile-directory=Default",
    icon: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  }));
  assert.deepEqual(l, {
    target: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", name: "Access the Internet",
    workingDir: "C:\\Program Files\\Google\\Chrome\\Application", args: "--profile-directory=Default",
    iconLocation: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
});

test("parseShellLink: Unicode LinkInfo (non-Latin path) with a common path suffix; ANSI strings", () => {
  const l = parseShellLink(buildLnk({ local: "D:\\Програмы\\", suffix: "редактор.exe", unicodeInfo: true, rel: "..\\x.exe", args: "-a" }));
  assert.equal(l?.target, "D:\\Програмы\\редактор.exe");
  assert.equal(l?.relativePath, "..\\x.exe");
  assert.equal(l?.args, "-a");
});

test("parseShellLink: network share target; environment-variable block; not a .lnk; truncated", () => {
  assert.equal(parseShellLink(buildLnk({ net: "\\\\server\\tools", suffix: "app.exe" }))?.target, "\\\\server\\tools\\app.exe");
  const env = parseShellLink(buildLnk({ unicode: true, name: "Notepad", env: "%windir%\\system32\\notepad.exe" }));
  assert.equal(env?.target, undefined);
  assert.equal(env?.envTarget, "%windir%\\system32\\notepad.exe");
  assert.equal(parseShellLink(Buffer.from("[InternetShortcut]\r\nURL=https://x\r\n".padEnd(100))), null);
  const full = buildLnk({ local: "C:\\a.exe", unicode: true, name: "abcdef", args: "zzz" });
  const cut = parseShellLink(full.subarray(0, full.length - 10));
  assert.equal(cut?.target, "C:\\a.exe");
  assert.equal(cut?.name, "abcdef");
  assert.equal(cut?.args, undefined);
});

test("expandEnv / lnkTarget: %VARS% case-insensitively; env block, then relative path", () => {
  const env = { WINDIR: "C:\\Windows", ProgramFiles: "C:\\Program Files" };
  assert.equal(expandEnv("%windir%\\system32\\notepad.exe", env), "C:\\Windows\\system32\\notepad.exe");
  assert.equal(expandEnv("%nope%\\x", env), "%nope%\\x");
  assert.equal(lnkTarget({ target: "C:\\a.exe", envTarget: "%windir%\\b.exe" }, "C:\\l.lnk", env), "C:\\a.exe");
  assert.equal(lnkTarget({ envTarget: "%windir%\\b.exe" }, "C:\\l.lnk", env), "C:\\Windows\\b.exe");
  assert.equal(lnkTarget({ relativePath: "..\\App\\app.exe" }, "C:\\Users\\me\\Start\\App.lnk", env), "C:\\Users\\me\\App\\app.exe");
  assert.equal(lnkTarget({}, "C:\\x.lnk", env), undefined);
});

test("startMenuDirs: the user's Programs folder first, then all users'", () => {
  assert.deepEqual(startMenuDirs({ APPDATA: "C:\\Users\\me\\AppData\\Roaming", PROGRAMDATA: "C:\\ProgramData" }), [
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs", "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  ]);
});

function fakeFs(files: Record<string, Buffer>): FsLike & { exists(f: string): boolean } {
  const norm = (p: string) => p.toLowerCase();
  const all = Object.keys(files);
  return {
    readdir(dir) {
      const pre = norm(dir).replace(/\\$/, "") + "\\";
      const kids = new Map<string, boolean>();
      for (const f of all) {
        if (!norm(f).startsWith(pre)) continue;
        const rest = f.slice(pre.length).split("\\");
        kids.set(rest[0], rest.length > 1);
      }
      if (!kids.size) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...kids].map(([name, dir]) => ({ name, dir }));
    },
    read(f) { const k = all.find((x) => norm(x) === norm(f)); if (!k) throw new Error("ENOENT"); return files[k]; },
    exists(f) { const n = norm(f).replace(/\\$/, ""); return all.some((x) => norm(x) === n || norm(x).startsWith(n + "\\")); },
  };
}

const USER = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
const ALL = "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs";
const lnkTo = (target: string) => buildLnk({ local: target, unicode: true });
const SHORTCUTS = {
  [`${ALL}\\Google Chrome.lnk`]: lnkTo("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
  [`${ALL}\\Visual Studio Code\\Visual Studio Code.lnk`]: lnkTo("C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"),
  [`${ALL}\\7-Zip\\7-Zip Help.lnk`]: lnkTo("C:\\Program Files\\7-Zip\\7-zip.chm"),
  [`${ALL}\\Tool\\Uninstall Tool.lnk`]: lnkTo("C:\\Program Files\\Tool\\unins000.exe"),
  [`${ALL}\\Accessories\\Notepad.lnk`]: buildLnk({ unicode: true, env: "%windir%\\system32\\notepad.exe" }),
  [`${ALL}\\desktop.ini`]: Buffer.from("x"),
  [`${ALL}\\broken.lnk`]: Buffer.from("not a link"),
  [`${USER}\\Google Chrome.lnk`]: lnkTo("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
};

test("readShortcuts: walks both folders, the user's wins, docs/uninstallers hidden, junk skipped", () => {
  const entries = readShortcuts([USER, ALL], fakeFs(SHORTCUTS), { windir: "C:\\Windows" });
  const by = new Map(entries.map((e) => [e.name, e]));
  assert.deepEqual([...by.keys()].sort(), ["7-Zip Help", "Google Chrome", "Notepad", "Uninstall Tool", "Visual Studio Code"]);
  assert.equal(by.get("Google Chrome")!.target, "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(by.get("Google Chrome")!.file, `${USER}\\Google Chrome.lnk`);
  assert.equal(by.get("Notepad")!.target, "C:\\Windows\\system32\\notepad.exe");
  assert.equal(by.get("Visual Studio Code")!.id, "Visual Studio Code\\Visual Studio Code.lnk");
  assert.equal(by.get("7-Zip Help")!.hidden, true);
  assert.equal(by.get("Uninstall Tool")!.hidden, true);
  assert.equal(by.get("Notepad")!.hidden, false);
});

test("parseStartApps / mergeEntries: Store apps without a shortcut are added by AUMID", () => {
  assert.deepEqual(parseStartApps('{"Name":"Calculator","AppID":"Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"}'),
    [{ name: "Calculator", aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }]);
  assert.deepEqual(parseStartApps("garbage"), []);
  const apps = parseStartApps(JSON.stringify([
    { Name: "Calculator", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
    { Name: "Google Chrome", AppID: "Chrome" }, { Name: "File Explorer", AppID: "Microsoft.Windows.Explorer" }, { Name: "", AppID: "x" },
  ]));
  const merged = mergeEntries([{ id: "a", name: "Google Chrome", file: "C:\\c.lnk", target: "C:\\chrome.exe", hidden: false }], apps);
  assert.deepEqual(merged.map((e) => [e.name, e.aumid ?? e.file]), [
    ["Google Chrome", "C:\\c.lnk"], ["Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"], ["File Explorer", "Microsoft.Windows.Explorer"],
  ]);
});

const ENTRIES: WinEntry[] = [
  { id: "1", name: "Google Chrome", file: "C:\\sm\\Google Chrome.lnk", target: "C:\\pf\\chrome.exe", hidden: false },
  { id: "2", name: "Visual Studio Code", file: "C:\\sm\\VSC.lnk", target: "C:\\pf\\Code.exe", hidden: false },
  { id: "3", name: "Uninstall Code", file: "C:\\sm\\u.lnk", target: "C:\\pf\\unins.exe", hidden: true },
  { id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "Calculator", aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", hidden: false },
  { id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", name: "Terminal", aumid: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", hidden: false },
];

test("findWinEntry: name, exe, AUMID; then prefix, then contains; listed apps before hidden ones", () => {
  assert.equal(findWinEntry(ENTRIES, "google chrome")?.id, "1");
  assert.equal(findWinEntry(ENTRIES, "chrome.exe")?.id, "1");
  assert.equal(findWinEntry(ENTRIES, "code")?.id, "2");
  assert.equal(findWinEntry(ENTRIES, "Visual")?.id, "2");
  assert.equal(findWinEntry(ENTRIES, "windowscalculator")?.name, "Calculator");
  assert.equal(findWinEntry(ENTRIES, "calc")?.name, "Calculator");
  assert.equal(findWinEntry(ENTRIES, "uninstall")?.id, "3");
  assert.equal(findWinEntry(ENTRIES, "  "), undefined);
  assert.equal(findWinEntry(ENTRIES, "photoshop"), undefined);
});

test("cmdQuote / launchArgv / openArgv / openWithShellArgv", () => {
  assert.equal(cmdQuote("C:\\a.exe"), "C:\\a.exe");
  assert.equal(cmdQuote("C:\\Program Files\\x & y.lnk"), '"C:\\Program Files\\x & y.lnk"');
  assert.equal(cmdQuote(""), '""');
  assert.deepEqual(launchArgv("C:\\p\\idea64.exe", ["--line", "3", "C:\\a b.ts"]), { file: "C:\\p\\idea64.exe", args: ["--line", "3", "C:\\a b.ts"], verbatim: false });
  assert.deepEqual(launchArgv("C:\\Users\\me\\VS Code\\bin\\code.cmd", ["--goto", "C:\\p\\a.ts:3"]),
    { file: "cmd.exe", args: ["/d", "/s", "/c", '""C:\\Users\\me\\VS Code\\bin\\code.cmd" --goto C:\\p\\a.ts:3"'], verbatim: true });
  assert.deepEqual(openArgv(ENTRIES[0]), { file: "cmd.exe", args: ["/d", "/s", "/c", '"start "" "C:\\sm\\Google Chrome.lnk""'], verbatim: true });
  assert.deepEqual(openArgv(ENTRIES[3]), { file: "explorer.exe", args: ["shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"], verbatim: false });
  assert.deepEqual(openWithShellArgv("https://x.dev/a%20b?q=1&r=2"), { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://x.dev/a%20b?q=1&r=2"], verbatim: false });
});

test("editorCommand: Notepad++ takes -n<line>", () => {
  assert.deepEqual(editorCommand({ kind: "notepadpp", cmd: "C:\\npp\\notepad++.exe" }, "C:\\p\\a.ts", 7), ["C:\\npp\\notepad++.exe", "-n7", "C:\\p\\a.ts"]);
});

test("splitCommandLine / editorFromWinProcess: each editor's CLI from its running exe", () => {
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\x.exe" --a "C:\\my proj"'), ["C:\\Program Files\\x.exe", "--a", "C:\\my proj"]);
  const exists = (f: string) => /\\bin\\code\.cmd$|resources\\app\\bin\\cursor\.cmd$|\\subl\.exe$/i.test(f);
  const p = (exe: string, cmdline = `"${exe}"`) => editorFromWinProcess({ pid: 1, exe, cmdline, cwd: null }, exists);
  assert.deepEqual(p("C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"),
    { kind: "vscode", cmd: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd" });
  assert.deepEqual(p("C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe"),
    { kind: "vscode", cmd: "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd" });
  assert.deepEqual(p("C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe"),
    { kind: "jetbrains", cmd: "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe" });
  assert.equal(p("C:\\x\\pycharm64.exe")?.kind, "jetbrains");
  assert.deepEqual(p("C:\\Program Files\\Notepad++\\notepad++.exe"), { kind: "notepadpp", cmd: "C:\\Program Files\\Notepad++\\notepad++.exe" });
  assert.deepEqual(p("C:\\Program Files\\Sublime Text\\sublime_text.exe"), { kind: "sublime", cmd: "C:\\Program Files\\Sublime Text\\subl.exe" });
  assert.deepEqual(p("C:\\Users\\me\\AppData\\Local\\Programs\\Zed\\Zed.exe"), { kind: "zed", cmd: "C:\\Users\\me\\AppData\\Local\\Programs\\Zed\\Zed.exe" });
  // Only the exe name from the helper: the full path comes from the command line.
  assert.equal(editorFromWinProcess({ pid: 1, exe: "Code.exe", cmdline: '"C:\\VS Code\\Code.exe" --type=renderer', cwd: null }, exists)?.cmd, "C:\\VS Code\\bin\\code.cmd");
  assert.equal(p("C:\\Windows\\notepad.exe"), null);
  assert.equal(editorFromWinProcess({ pid: 1, exe: "C:\\x\\Code.exe", cmdline: "", cwd: null }, () => false), null);
});

test("whichWin / installedWinEditor: PATH with PATHEXT, then the usual install folders", () => {
  const env = { PATH: "C:\\Windows;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
  const files = new Set(["c:\\tools\\code.cmd", "c:\\users\\me\\appdata\\local\\jetbrains\\toolbox\\scripts\\webstorm.cmd", "c:\\program files\\sublime text\\subl.exe"]);
  const exists = (f: string) => files.has(f.toLowerCase());
  assert.equal(whichWin("code", env, exists), "C:\\tools\\code.cmd");
  assert.equal(whichWin("code.cmd", env, exists), "C:\\tools\\code.cmd");
  assert.equal(whichWin("nope", env, exists), null);
  assert.deepEqual(installedWinEditor("vscode", env, exists, () => []), { kind: "vscode", cmd: "C:\\tools\\code.cmd" });
  assert.deepEqual(installedWinEditor("jetbrains", env, exists, () => []), { kind: "jetbrains", cmd: "C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\webstorm.cmd" });
  assert.deepEqual(installedWinEditor("sublime", env, exists, () => []), { kind: "sublime", cmd: "C:\\Program Files\\Sublime Text\\subl.exe" });
  assert.equal(installedWinEditor("zed", env, exists, () => []), null);
  // A standalone JetBrains install.
  const list = (d: string) => d === "C:\\Program Files\\JetBrains" ? ["PyCharm 2025.1"] : d.endsWith("PyCharm 2025.1\\bin") ? ["pycharm.bat", "pycharm64.exe"] : [];
  assert.deepEqual(installedWinEditor("jetbrains", env, () => false, list), { kind: "jetbrains", cmd: "C:\\Program Files\\JetBrains\\PyCharm 2025.1\\bin\\pycharm64.exe" });
});

test("resolveWinFile: absolute, project-relative, else searched (skipping node_modules), best suffix match", () => {
  const fs = fakeFs({
    "C:\\p\\src\\app\\main.ts": Buffer.alloc(0), "C:\\p\\test\\main.ts": Buffer.alloc(0), "C:\\p\\node_modules\\x\\util.ts": Buffer.alloc(0),
    "C:\\p\\README.md": Buffer.alloc(0),
  });
  assert.equal(resolveWinFile("C:\\p\\README.md", "C:\\other", fs), "C:\\p\\README.md");
  assert.equal(resolveWinFile("src\\app\\main.ts", "C:\\p", fs), "C:\\p\\src\\app\\main.ts");
  assert.equal(resolveWinFile("app/main.ts", "C:\\p", fs), "C:\\p\\src\\app\\main.ts");
  assert.equal(resolveWinFile("util.ts", "C:\\p", fs), null);
  assert.equal(resolveWinFile("x.ts", "", fs), null);
});

function apps(over: Parameters<typeof createWinApps>[1] = {}, focusable: string[] = []) {
  const launched: { file: string; args: string[]; verbatim: boolean; cwd?: string }[] = [];
  const focused: string[] = [];
  const a = createWinApps(async (n) => { focused.push(n); return focusable.includes(n); }, {
    launch: async (x, cwd) => { launched.push({ ...x, cwd }); },
    shortcuts: () => ENTRIES.filter((e) => e.file),
    startApps: async () => ENTRIES.filter((e) => e.aumid).map((e) => ({ name: e.name, aumid: e.aumid! })),
    processes: async () => [],
    exists: () => false,
    ...over,
  });
  return { a, launched, focused };
}

test("createWinApps: list (sorted, hidden left out), open by shortcut or AUMID, unknown app errors", async () => {
  const { a, launched } = apps();
  assert.deepEqual((await a.list()).map((x) => [x.name, x.exec]), [
    ["Calculator", "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"], ["Google Chrome", "C:\\pf\\chrome.exe"],
    ["Terminal", "shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"], ["Visual Studio Code", "C:\\pf\\Code.exe"],
  ]);
  assert.equal(await a.open("chrome"), "Google Chrome");
  assert.equal(await a.open("calculator"), "Calculator");
  assert.equal(launched[0].file, "cmd.exe");
  assert.equal(launched[1].args[0], "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
  await assert.rejects(a.open("photoshop"), /no such app/);
});

test("createWinApps: focus tries the name, the entry's name and its exe; not running → opens it", async () => {
  const { a, launched, focused } = apps({}, ["chrome"]);
  assert.equal(await a.focus("google"), "Google Chrome");
  assert.deepEqual(focused, ["google", "Google Chrome", "chrome"]);
  assert.equal(launched.length, 0);
  assert.equal(await a.focus("terminal"), "Terminal");
  assert.equal(launched.length, 1);
});

test("createWinApps: openUrl adds https:// and goes through the shell handler", async () => {
  const { a, launched } = apps();
  await a.openUrl("example.com/x");
  await a.openUrl("mailto:a@b.c");
  assert.deepEqual(launched.map((l) => l.args[1]), ["https://example.com/x", "mailto:a@b.c"]);
});

test("createWinApps.openFile: the running editor with the project open wins; else installed by marker; else the shell", async () => {
  const procs = [
    { pid: 1, ppid: 0, exe: "C:\\npp\\notepad++.exe", cmdline: '"C:\\npp\\notepad++.exe"', cwd: "C:\\" },
    { pid: 2, ppid: 0, exe: "C:\\JB\\bin\\idea64.exe", cmdline: '"C:\\JB\\bin\\idea64.exe" C:\\Proj', cwd: "C:\\JB\\bin" },
  ];
  const one = apps({ processes: async () => procs, resolveFile: () => "C:\\Proj\\src\\a.ts" });
  await one.a.openFile("src/a.ts", 12, "c:\\proj");
  assert.deepEqual(one.launched, [{ file: "C:\\JB\\bin\\idea64.exe", args: ["--line", "12", "C:\\Proj\\src\\a.ts"], verbatim: false, cwd: "c:\\proj" }]);

  const two = apps({ resolveFile: () => "C:\\q\\a.ts", installed: (k) => (k === "vscode" ? { kind: "vscode", cmd: "C:\\VS\\bin\\code.cmd" } : null) });
  // projectEditors() looks at the real disk: a folder with .vscode makes VS Code the project's editor.
  const proj = mkdtempSync(join(tmpdir(), "vcli-wproj-"));
  mkdirSync(join(proj, ".vscode"));
  await two.a.openFile("a.ts", 3, proj);
  assert.deepEqual(two.launched[0].args, ["/d", "/s", "/c", '"C:\\VS\\bin\\code.cmd --goto C:\\q\\a.ts:3"']);

  const three = apps({ resolveFile: () => "C:\\q\\a.ts", installed: () => null });
  await three.a.openFile("a.ts", 3, "");
  assert.deepEqual(three.launched[0], { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "C:\\q\\a.ts"], verbatim: false, cwd: undefined });

  const missing = apps({ resolveFile: () => null });
  await assert.rejects(missing.a.openFile("nope.ts", 1, "C:\\p"), /Couldn't find nope.ts/);
});
