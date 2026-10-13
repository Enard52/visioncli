import "./_env";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { commonPath, electronNodeWrapper, findNode } from "../../src/main/app/config";
import { isBrowserApp, isBrowserNavShortcut, isSensitiveApp } from "../../src/main/control/actions";
import { mcpCommand } from "../../src/main/features/integrations";
import { defaultConfigDir, isPathToken, isTerminal, jetbrainsPaths, tokens, vscodePaths } from "../../src/main/features/projects";
import { windowsChecks, type WindowsProbe } from "../../src/main/features/setupwin";

describe("projects on Windows", () => {
  test("JetBrains recents (%APPDATA%\\JetBrains\\<Product>\\options\\recentProjects.xml)", () => {
    const xml = `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
      <entry key="$USER_HOME$/PhpstormProjects/myshop"><value><RecentProjectMetaInfo frameTitle="myshop"/></value></entry>
      <entry key="D:/work/payments"><value><RecentProjectMetaInfo/></value></entry></map></option></component></application>`;
    assert.deepEqual(jetbrainsPaths(xml, "C:\\Users\\me", "win32"), ["C:\\Users\\me\\PhpstormProjects\\myshop", "D:\\work\\payments"]);
    assert.deepEqual(jetbrainsPaths(xml, "/home/me", "linux"), ["/home/me/PhpstormProjects/myshop", "D:/work/payments"]);
  });

  test("VS Code family recents: file:///c%3A/… URIs", () => {
    const json = `{"windowsState":{"lastActiveWindow":{"folder":"file:///c%3A/Users/me/projects/my%20app"}},
      "backupWorkspaces":{"folders":[{"folderUri":"file:///d%3A/src/api"},{"folderUri":"vscode-remote://wsl%2Bubuntu/home/me/x"}]}}`;
    assert.deepEqual(vscodePaths(json, "win32"), ["C:\\Users\\me\\projects\\my app", "D:\\src\\api"]);
    assert.deepEqual(vscodePaths(`"file:///home/me/app"`, "linux"), ["/home/me/app"]);
    assert.equal(defaultConfigDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }), "C:\\Users\\me\\AppData\\Roaming");
  });

  test("window titles with Windows paths, terminals by exe name", () => {
    assert.ok(isPathToken("C:\\Users\\me\\shop"));
    assert.ok(isPathToken("d:/src/api"));
    assert.ok(isPathToken("\\\\server\\share\\x"));
    assert.ok(!isPathToken("myshop"));
    assert.deepEqual(tokens("myshop [C:\\Users\\me\\PhpstormProjects\\myshop] – Cart.php"), ["C:\\Users\\me\\PhpstormProjects\\myshop", "myshop", "Cart.php"]);
    for (const w of [{ app: "Windows Terminal", appId: "WindowsTerminal.exe" }, { app: "Windows PowerShell", appId: "powershell.exe" },
      { app: "Windows Command Processor", appId: "cmd.exe" }, { app: "WezTerm", appId: "wezterm-gui.exe" }, { app: "", appId: "OpenConsole.exe" }]) {
      assert.ok(isTerminal(w), w.appId);
    }
    assert.ok(!isTerminal({ app: "Visual Studio Code", appId: "Code.exe" }));
  });
});

describe("computer control guards on Windows", () => {
  test("sensitive apps ask every time", () => {
    for (const appId of ["SystemSettings.exe", "mmc.exe", "regedit.exe", "KeePass.exe", "KeePassXC.exe", "1Password.exe", "Bitwarden.exe",
      "CredentialUIBroker.exe", "consent.exe", "SecHealthUI.exe"]) {
      assert.ok(isSensitiveApp({ appId, app: "" }), appId);
    }
    assert.ok(isSensitiveApp({ appId: "", app: "Registry Editor" }));
    // short exe names match exactly, not inside other names
    assert.ok(!isSensitiveApp({ appId: "CommCenter.exe", app: "CommCenter" }));
    assert.ok(!isSensitiveApp({ appId: "notepad.exe", app: "Notepad" }));
  });

  test("browser keyboard navigation (Ctrl+L/T/N) is refused in Chrome, Brave and Edge", () => {
    assert.ok(isBrowserApp({ appId: "msedge.exe", app: "Microsoft Edge" }));
    assert.ok(isBrowserApp({ appId: "chrome.exe", app: "Google Chrome" }));
    assert.ok(isBrowserNavShortcut("ctrl+l"));
    assert.ok(isBrowserNavShortcut("Ctrl+Shift+N"));
    assert.ok(isBrowserNavShortcut("win+t"));
    assert.ok(!isBrowserNavShortcut("ctrl+c"));
  });
});

describe("integrations and launch config on Windows", () => {
  test("the MCP server command: node + server, or cmd /c for a .cmd wrapper", () => {
    assert.deepEqual(mcpCommand("C:\\nodejs\\node.exe", "C:\\VisionCLI\\resources\\server\\index.mjs", "win32"), ["C:\\nodejs\\node.exe", "C:\\VisionCLI\\resources\\server\\index.mjs"]);
    assert.deepEqual(mcpCommand("C:\\x\\electron-node.cmd", "C:\\s.mjs", "win32"), ["cmd", "/c", "C:\\x\\electron-node.cmd", "C:\\s.mjs"]);
    assert.deepEqual(mcpCommand("/usr/bin/node", null, "linux"), ["/usr/bin/node"]);
  });

  test("common PATH and the newest Node.js", () => {
    const env = { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", SystemRoot: "C:\\WINDOWS" };
    const path = commonPath("C:\\Users\\me", "win32", env).split(";");
    assert.ok(path.includes("C:\\Users\\me\\AppData\\Roaming\\npm"));
    assert.ok(path.includes("C:\\WINDOWS\\System32"));
    const versions: Record<string, string> = { "C:\\old\\node.exe": "v16.20.0", "C:\\new\\node.exe": "v22.1.0", "C:\\mid\\node.exe": "v20.0.0" };
    assert.equal(findNode("C:\\old;C:\\mid;C:\\new;C:\\none", (b) => versions[b] ?? null, "win32", (p) => p in versions), "C:\\new\\node.exe");
  });

  test("Electron-as-Node wrapper is a .cmd on Windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcli-wrap-"));
    const f = electronNodeWrapper("C:\\Program Files\\VisionCLI\\VisionCLI.exe", dir, "win32");
    assert.ok(f.endsWith("electron-node.cmd"));
    assert.equal(readFileSync(f, "utf8"), '@set ELECTRON_RUN_AS_NODE=1\r\n@"C:\\Program Files\\VisionCLI\\VisionCLI.exe" %*\r\n');
  });
});

describe("setup checks on Windows", () => {
  const base: WindowsProbe = { inputs: [{ name: "Microphone (Realtek)", isDefault: true }], keyboard: { backend: "hooks" }, desktopProblem: null,
    inputBackend: "sendinput", uia: true, windowsTerminal: true, wezterm: false, busy: {} };

  test("everything there", () => {
    const c = windowsChecks(base);
    for (const k of ["microphone", "keyboard", "screen", "control", "terminal"] as const) assert.equal(c[k]?.state, "done", k);
    assert.match(c.terminal!.detail!, /Windows Terminal/);
    assert.equal(c.keyboard!.command, undefined, "no group to join on Windows");
  });

  test("what's missing", () => {
    const c = windowsChecks({ ...base, inputs: [], keyboard: { backend: "none", problem: "The keyboard hook didn't start" }, uia: false, windowsTerminal: false });
    assert.equal(c.microphone?.state, "pending");
    assert.match(c.microphone!.note!, /Privacy & security/);
    assert.equal(c.keyboard?.state, "pending");
    assert.equal(c.keyboard?.fix, "Try Again");
    assert.equal(c.control?.state, "pending");
    assert.match(c.control!.detail!, /UI Automation unavailable/);
    assert.equal(c.terminal?.state, "optional");
  });
});
