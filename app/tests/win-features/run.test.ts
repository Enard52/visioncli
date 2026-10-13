import "./_env";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cmdEscapeArg, cmdShell, crtQuote, npmShimTarget, pathExts, spawnCommand, userPath, which, windowsExtraPath, withPath } from "../../src/main/features/run";
import { appPaths } from "../../src/main/paths";
import { splitCommandLine } from "../../src/main/terminal/win";

const ENV = { PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" };
const HOME = "C:\\Users\\me";

// npm's cmd-shim output for @anthropic-ai/claude-code (npm 10).
const CLAUDE_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r
`;
// A package that ships a native binary (the shim calls it directly).
const NATIVE_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@google\\agy\\bin\\agy.exe"   %*\r\n`;

describe("which on Windows", () => {
  const files = new Set(["C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe"]);
  const exists = (p: string) => files.has(p);
  const path = userPath("C:\\WINDOWS\\system32;C:\\Users\\me\\AppData\\Roaming\\npm", "win32", ENV, HOME);

  test("PATHEXT order, ; separated PATH, the usual folders added", () => {
    assert.deepEqual(pathExts(ENV).slice(0, 4), [".com", ".exe", ".bat", ".cmd"]);
    assert.ok(path.split(";").includes("C:\\Users\\me\\.local\\bin"));
    assert.ok(path.split(";").includes("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps"));
    // npm's folder was already there (any case): not added twice
    assert.equal(path.split(";").filter((p) => p.toLowerCase() === "c:\\users\\me\\appdata\\roaming\\npm").length, 1);
    assert.equal(which("claude", path, "win32", ENV, exists), "C:\\Users\\me\\.local\\bin\\claude.exe");
    // the extensionless npm file (a sh script for Git Bash) is skipped: gemini.cmd wins
    assert.equal(which("gemini", path, "win32", ENV, exists), "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd");
    assert.equal(which("wt", path, "win32", ENV, exists), "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe");
    assert.equal(which("agy", path, "win32", ENV, exists), null);
    assert.equal(which("C:\\Users\\me\\.local\\bin\\claude", path, "win32", ENV, exists), "C:\\Users\\me\\.local\\bin\\claude.exe");
    assert.equal(which("claude.exe", path, "win32", ENV, exists), "C:\\Users\\me\\.local\\bin\\claude.exe");
  });

  test("extra folders include npm, Node.js, Volta, Scoop and nvm's symlink", () => {
    const dirs = windowsExtraPath({ ...ENV, NVM_SYMLINK: "C:\\nvm4w\\nodejs" }, HOME);
    for (const d of ["C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Program Files\\nodejs", "C:\\Users\\me\\AppData\\Local\\Volta\\bin", "C:\\Users\\me\\scoop\\shims", "C:\\nvm4w\\nodejs"]) {
      assert.ok(dirs.includes(d), d);
    }
  });

  test("withPath replaces every spelling of PATH on Windows only", () => {
    const env = withPath("X", { Path: "a", PATH: "b", path: "c", HOME: "h" }, "win32");
    assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === "PATH"), ["PATH"]);
    assert.equal(env.PATH, "X");
    assert.equal(withPath("X", { Path: "a" }, "linux").Path, "a");
  });
});

describe("spawning npm shims and batch files", () => {
  const reads: Record<string, string> = {
    "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd": CLAUDE_SHIM,
    "C:\\Users\\me\\AppData\\Roaming\\npm\\agy.cmd": NATIVE_SHIM,
    "C:\\tools\\other.cmd": "@echo off\r\necho hi %1\r\n",
  };
  const read = (f: string) => reads[f] ?? null;

  test("cmd-shim → node + the package's cli.js", () => {
    const t = npmShimTarget("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", read, () => false);
    assert.deepEqual(t, { target: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", node: null });
    // node.exe next to the shim is preferred, as the shim does
    const withNode = npmShimTarget("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", read, (p) => p.endsWith("npm\\node.exe"));
    assert.equal(withNode?.node, "C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe");
    const s = spawnCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", ["-p", 'say "hi" & exit'], { ...ENV, PATH: "C:\\nodejs" }, "win32", read,
      (p) => p === "C:\\nodejs\\node.exe");
    assert.deepEqual(s, { file: "C:\\nodejs\\node.exe", args: ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "-p", 'say "hi" & exit'] });
  });

  test("a shim around a native .exe runs the .exe", () => {
    const s = spawnCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\agy.cmd", ["models"], ENV, "win32", read, () => false);
    assert.deepEqual(s, { file: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@google\\agy\\bin\\agy.exe", args: ["models"] });
  });

  test("any other batch file goes through cmd.exe, escaped for cmd and the C runtime", () => {
    const s = spawnCommand("C:\\tools\\other.cmd", ["a b", 'q"x', "50%", "x&y"], ENV, "win32", read, () => false);
    assert.equal(s.file, "C:\\WINDOWS\\system32\\cmd.exe");
    assert.equal(s.verbatim, true);
    assert.deepEqual(s.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(s.args[3], '"C:\\tools\\other.cmd ^"a^ b^" ^"q\\^"x^" ^"50^%^" ^"x^&y^""');
    // .exe files and other platforms are spawned as they are
    assert.deepEqual(spawnCommand("C:\\x\\claude.exe", ["a"], ENV, "win32", read), { file: "C:\\x\\claude.exe", args: ["a"] });
    assert.deepEqual(spawnCommand("/usr/bin/claude.cmd", ["a"], ENV, "linux", read), { file: "/usr/bin/claude.cmd", args: ["a"] });
    // npm's .bin shims re-parse %*: escaped twice
    assert.match(cmdShell("C:\\p\\node_modules\\.bin\\x.cmd", ["&"]).args[3], /\^\^\^"\^\^\^&\^\^\^"/);
  });

  test("C runtime quoting round-trips through CommandLineToArgvW", () => {
    const args = ["plain", "two words", 'say "hi"', "C:\\dir with space\\", 'trailing\\"q', "", "a\\\\b"];
    const line = ["prog.exe", ...args.map(crtQuote)].join(" ");
    assert.deepEqual(splitCommandLine(line).slice(1), args);
    assert.equal(cmdEscapeArg("a"), '^"a^"');
  });
});

describe("app folders", () => {
  test("Windows: roaming settings, local logs and caches", () => {
    const p = appPaths("win32", ENV, HOME);
    assert.equal(p.SUP, "C:\\Users\\me\\AppData\\Roaming\\visioncli");
    assert.equal(p.LOGS, "C:\\Users\\me\\AppData\\Local\\visioncli\\logs");
    assert.equal(p.CACHE, "C:\\Users\\me\\AppData\\Local\\visioncli\\cache");
    assert.equal(p.DATA, "C:\\Users\\me\\AppData\\Local\\visioncli");
    assert.equal(p.MODELS, "C:\\Users\\me\\AppData\\Roaming\\visioncli\\models");
    assert.equal(p.HOME_PROJECT, "C:\\Users\\me\\VisionCLI");
    // without the variables (a stripped environment): the profile's defaults
    assert.equal(appPaths("win32", {}, HOME).SUP, "C:\\Users\\me\\AppData\\Roaming\\visioncli");
  });
  test("Linux unchanged (XDG)", () => {
    const p = appPaths("linux", { XDG_CONFIG_HOME: "/x/cfg" }, "/home/me");
    assert.equal(p.SUP, "/x/cfg/visioncli");
    assert.equal(p.LOGS, "/home/me/.local/state/visioncli");
    assert.equal(p.CACHE, "/home/me/.cache/visioncli");
    assert.equal(p.DATA, "/home/me/.local/share/visioncli");
  });
});
