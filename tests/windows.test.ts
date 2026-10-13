import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { socketPath } from "../src/agent/browserd.js";
import { browserFromClass, browserFromWin, BROWSERS, SUPPORTED, WIN_EXES } from "../src/browser.js";
import { profileDirs } from "../src/cdp.js";
import { configDir } from "../src/config.js";
import { cmdLine, findOnPathWin, windowsApp, windowsAppPids, windowsPaths, winServerCommand } from "../src/voice.js";
import { encodeCommand, parseSize, parseTasklist, parseWindows, psQuote } from "../src/win32.js";

// Windows logic that runs anywhere: paths, parsers and decisions, with the platform and environment injected.

describe("windows paths", () => {
  const env = { APPDATA: "C:\\Users\\ann\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\ann\\AppData\\Local" };

  test("config dir is %APPDATA%\\visioncli (the app's SUP); other platforms unchanged", () => {
    assert.equal(configDir("win32", env, "C:\\Users\\ann"), join(env.APPDATA, "visioncli"));
    assert.equal(configDir("win32", {}, "/h"), join("/h", "AppData", "Roaming", "visioncli"));
    assert.equal(configDir("darwin", env, "/h"), join("/h", "Library", "Application Support", "visioncli"));
    assert.equal(configDir("linux", { XDG_CONFIG_HOME: "/x" }, "/h"), join("/x", "visioncli"));
    assert.equal(configDir("linux", {}, "/h"), join("/h", ".config", "visioncli"));
  });

  test("DevToolsActivePort folders: the User Data dirs under %LOCALAPPDATA%, Edge included", () => {
    const p = profileDirs("win32", env, "C:\\Users\\ann");
    assert.deepEqual(p["Google Chrome"], [join(env.LOCALAPPDATA, "Google", "Chrome", "User Data")]);
    assert.deepEqual(p["Brave Browser"], [join(env.LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data")]);
    assert.deepEqual(p.Chromium, [join(env.LOCALAPPDATA, "Chromium", "User Data")]);
    assert.deepEqual(p["Microsoft Edge"], [join(env.LOCALAPPDATA, "Microsoft", "Edge", "User Data")]);
    assert.deepEqual(profileDirs("win32", {}, "/h").Chromium, [join("/h", "AppData", "Local", "Chromium", "User Data")]);
    // macOS keeps its three browsers (AppleScript); Linux gains Edge too.
    assert.deepEqual(Object.keys(profileDirs("darwin", {}, "/h")).sort(), ["Brave Browser", "Chromium", "Google Chrome"]);
    assert.ok(profileDirs("linux", {}, "/h")["Microsoft Edge"].includes(join("/h", ".config/microsoft-edge")));
  });

  test("browserd: a per-user named pipe on Windows, the socket file elsewhere", () => {
    assert.equal(socketPath("win32", "C:\\cfg", "ann"), "\\\\.\\pipe\\visioncli-browserd-ann");
    assert.equal(socketPath("win32", "C:\\cfg", "Ann Lee (work)"), "\\\\.\\pipe\\visioncli-browserd-Ann_Lee__work_");
    assert.equal(socketPath("linux", "/cfg", "ann"), join("/cfg", "browserd.sock"));
  });

  test("installed app and MCP wrapper (NSIS per-user default)", () => {
    const p = windowsPaths(env);
    assert.equal(p.installed, join(env.LOCALAPPDATA, "Programs", "VisionCLI", "VisionCLI.exe"));
    assert.equal(p.mcpWrapper, join(env.LOCALAPPDATA, "visioncli", "bin", "visioncli-mcp.cmd"));
  });

  test("which app to start: VISIONCLI_APP, then the installed one", () => {
    const has = (...files: string[]) => (f: string) => files.includes(f);
    const installed = windowsPaths(env).installed;
    assert.deepEqual(windowsApp({ ...env, VISIONCLI_APP: "D:\\V.exe" }, has("D:\\V.exe", installed)), { exe: "D:\\V.exe", args: [] });
    assert.deepEqual(windowsApp({ ...env, VISIONCLI_APP: "D:\\gone.exe" }, has(installed)), { exe: installed, args: [] });
    assert.equal(windowsApp(env, has()), null);
  });
});

describe("windows commands", () => {
  test("claude mcp add: the app's .cmd wrapper and npx go through cmd /c", () => {
    assert.deepEqual(winServerCommand(["C:\\VisionCLI.exe", "x"], true, "C:\\w.cmd"), ["cmd", "/c", "C:\\w.cmd"]);
    assert.deepEqual(winServerCommand(["npx", "-y", "visioncli@latest"], false), ["cmd", "/c", "npx", "-y", "visioncli@latest"]);
    assert.deepEqual(winServerCommand(["C:\\node.exe", "C:\\v\\index.js"], false), ["C:\\node.exe", "C:\\v\\index.js"]);
  });

  test("PATH lookup tries PATHEXT, first directory wins", () => {
    const files = new Set([join("C:\\npm", "claude.cmd"), join("C:\\bin", "claude.exe")]);
    const env = { PATH: "C:\\none;C:\\bin;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    assert.equal(findOnPathWin("claude", env, (f) => files.has(f)), join("C:\\bin", "claude.exe"));
    assert.equal(findOnPathWin("claude", { ...env, PATH: "C:\\npm" }, (f) => files.has(f)), join("C:\\npm", "claude.cmd"));
    assert.equal(findOnPathWin("claude.cmd", { ...env, PATH: "C:\\npm" }, (f) => files.has(f)), join("C:\\npm", "claude.cmd"));
    assert.equal(findOnPathWin("agy", env, (f) => files.has(f)), null);
  });

  test("cmd.exe command lines quote spaces and specials", () => {
    assert.equal(cmdLine(["C:\\Program Files\\claude.cmd", "mcp", "add", "--", "a&b", ""]), '"C:\\Program Files\\claude.cmd" mcp add -- "a&b" ""');
  });

  test("stopping the app: main processes only (not helpers, MCP servers, browserd or this process)", () => {
    const dev = "C:\\src\\visioncli\\app";
    const procs = [
      { pid: 10, name: "VisionCLI.exe", cmd: '"C:\\Programs\\VisionCLI\\VisionCLI.exe"' },
      { pid: 11, name: "VisionCLI.exe", cmd: '"C:\\Programs\\VisionCLI\\VisionCLI.exe" --type=renderer --foo' },
      { pid: 12, name: "VisionCLI.exe", cmd: '"C:\\Programs\\VisionCLI\\VisionCLI.exe" "C:\\Programs\\VisionCLI\\resources\\win\\visioncli-mcp.cjs"' },
      { pid: 13, name: "VisionCLI.exe", cmd: '"C:\\Programs\\VisionCLI\\VisionCLI.exe" C:\\Programs\\VisionCLI\\resources\\server\\index.mjs browserd' },
      { pid: 14, name: "electron.exe", cmd: `"${dev}\\node_modules\\electron\\dist\\electron.exe" ${dev}` },
      { pid: 15, name: "electron.exe", cmd: '"C:\\other\\electron.exe" C:\\other' },
      { pid: 16, name: "VisionCLI.exe", cmd: null },
      { pid: 17, name: "VisionCLI.exe", cmd: "VisionCLI.exe" },
    ];
    assert.deepEqual(windowsAppPids(procs, new Set([17]), dev), [10, 14, 16]);
  });
});

describe("windows browsers", () => {
  test("exe and product names map to browsers", () => {
    assert.equal(browserFromWin("msedge.exe"), "Microsoft Edge");
    assert.equal(browserFromWin("Microsoft Edge"), "Microsoft Edge");
    assert.equal(browserFromWin("chrome.exe"), "Google Chrome");
    assert.equal(browserFromWin("Google Chrome"), "Google Chrome");
    assert.equal(browserFromWin("brave.exe"), "Brave Browser");
    assert.equal(browserFromWin("Brave Browser"), "Brave Browser");
    assert.equal(browserFromWin("chromium.exe"), "Chromium");
    assert.equal(browserFromWin("Code"), undefined);
    assert.equal(browserFromWin("chrome_proxy.exe"), undefined);
    assert.equal(browserFromClass("microsoft-edge.Microsoft-edge"), "Microsoft Edge");
  });

  test("every browser has a Windows image name; Edge only off macOS", () => {
    for (const b of BROWSERS) assert.match(WIN_EXES[b], /^[a-z]+\.exe$/);
    assert.equal(SUPPORTED.includes("Microsoft Edge"), process.platform !== "darwin");
  });

  test("tasklist CSV: image names, lower-case", () => {
    const out = [
      '"System Idle Process","0","Services","0","8 K"',
      '"chrome.exe","4120","Console","1","210,332 K"',
      '"MSEdge.exe","5000","Console","1","90,000 K"',
      "",
      "INFO: No tasks are running which match the specified criteria.",
    ].join("\r\n");
    const names = parseTasklist(out);
    assert.ok(names.has("chrome.exe") && names.has("msedge.exe") && names.has("system idle process"));
    assert.equal(names.size, 3);
  });
});

describe("windows powershell fallbacks", () => {
  test("window list JSON: front-most first, bounds, pointer; a single row unwrapped by PowerShell 5", () => {
    const many = parseWindows(JSON.stringify({
      windows: [
        { id: 132456, title: "README.md - visioncli - Visual Studio Code", app: "Visual Studio Code", x: -8, y: 0, w: 1936, h: 1048 },
        { id: 65800, title: "Windows PowerShell", app: "powershell", x: 100, y: 100, w: 800, h: 600 },
      ],
      pointer: { x: 500, y: 400 },
    }));
    assert.equal(many.windows.length, 2);
    assert.deepEqual(many.windows[0], {
      id: 132456, app: "Visual Studio Code", title: "README.md - visioncli - Visual Studio Code",
      bounds: { x: -8, y: 0, width: 1936, height: 1048 },
    });
    assert.deepEqual(many.pointer, { x: 500, y: 400 });
    const one = parseWindows('{"windows":{"id":1,"title":"t","app":"a","x":0,"y":0,"w":10,"h":20},"pointer":{"x":1,"y":2}}');
    assert.equal(one.windows.length, 1);
    assert.deepEqual(parseWindows('{"windows":null}').windows, []);
    assert.deepEqual(parseWindows("").windows, []);
  });

  test("Save-Jpeg's size line, after any other output", () => {
    assert.deepEqual(parseSize("1568 882"), { width: 1568, height: 882 });
    assert.deepEqual(parseSize("warning\r\n1200 800\r\n"), { width: 1200, height: 800 });
    assert.equal(parseSize(""), null);
  });

  test("quoting: single-quoted literals and UTF-16LE base64 for -EncodedCommand", () => {
    assert.equal(psQuote("C:\\Users\\O'Neil\\out.jpg"), "'C:\\Users\\O''Neil\\out.jpg'");
    assert.equal(Buffer.from(encodeCommand("ü 'x'"), "base64").toString("utf16le"), "ü 'x'");
  });
});
