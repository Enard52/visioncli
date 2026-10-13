import { TEST_HOME } from "./_env";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Desktop, DesktopWindow, InputInjector } from "../../src/main/contracts";
import { resolveConfig } from "../../src/main/assistant/config";
import { SUP } from "../../src/main/paths";
import { terminalPrompt } from "../../src/main/assistant/prompts";
import { TerminalSession } from "../../src/main/assistant/terminal";
import { batchArg, batchCommand, windowsLaunchers } from "../../src/main/terminal/launcher";
import { ActivityLog, BufferedActivity } from "../../src/main/terminal/activity";
import { claudeDir, claudeProjectKey, parseWslPath, wslClaudeDir, wslUncPath } from "../../src/main/terminal/transcripts";
import {
  createWinKeyboardDelivery, matchesWin, parseWslList, setWinKeyboard, setWinProcessSource, setWslDefault, splitCommandLine, terminalHost,
  terminalWindow, trimDir, underProject, weztermPaneFor, winCliProcs, winDeliveryFor, winFind, winProbeWindow, wslClaude, type WinProc,
} from "../../src/main/terminal/win";

const P = (pid: number, ppid: number, exe: string, cmdline: string, cwd: string | null = null): WinProc => ({ pid, ppid, exe, cmdline, cwd });
const PROJECTS = "C:\\Users\\me\\projects";

/** A snapshot like the helper's `processes`: Windows Terminal with three tabs, a classic console, WSL and WezTerm. */
const PROCS: WinProc[] = [
  P(1000, 900, "explorer.exe", "C:\\WINDOWS\\Explorer.EXE", "C:\\WINDOWS\\system32\\"),
  P(2000, 1000, "WindowsTerminal.exe", '"C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\WindowsTerminal.exe"'),
  P(2001, 2000, "OpenConsole.exe", '"C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21\\OpenConsole.exe" --headless --width 120'),
  P(2100, 2000, "pwsh.exe", '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', `${PROJECTS}\\shop\\`),
  P(2200, 2100, "claude.exe", '"C:\\Users\\me\\.local\\bin\\claude.exe" --resume abc', `${PROJECTS}\\shop\\`),
  P(2201, 2200, "claude.exe", '"C:\\Users\\me\\.local\\bin\\claude.exe" --ripgrep -n foo', `${PROJECTS}\\shop\\`),
  P(2300, 2000, "cmd.exe", "C:\\WINDOWS\\system32\\cmd.exe", `${PROJECTS}\\api\\`),
  P(2301, 2300, "cmd.exe", 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd""', `${PROJECTS}\\api\\`),
  P(2302, 2301, "node.exe", '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"', `${PROJECTS}\\api\\`),
  // VisionCLI's own background run: not a terminal session
  P(2400, 1000, "node.exe", '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js -p --output-format stream-json', `${PROJECTS}\\shop`),
  // A classic console: conhost.exe is a child of the shell
  P(3000, 1000, "cmd.exe", "\"C:\\WINDOWS\\system32\\cmd.exe\"", "C:\\work\\legacy\\"),
  P(3001, 3000, "conhost.exe", "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4"),
  P(3002, 3000, "node.exe", "node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "C:\\work\\legacy\\"),
  // WSL
  P(4000, 2000, "wsl.exe", "C:\\WINDOWS\\system32\\wsl.exe -d Ubuntu --cd /home/me/src/app -- claude", "C:\\Users\\me\\"),
  P(4001, 2000, "wsl.exe", "wsl claude --resume 1234", `${PROJECTS}\\shop\\`),
  P(4002, 2000, "wsl.exe", "C:\\WINDOWS\\system32\\wsl.exe -d Ubuntu", "C:\\Users\\me\\"),
  // WezTerm
  P(5000, 1000, "wezterm-gui.exe", '"C:\\Program Files\\WezTerm\\wezterm-gui.exe"'),
  P(5001, 5000, "pwsh.exe", "pwsh", `${PROJECTS}\\web\\`),
  P(5002, 5001, "claude.exe", "claude", `${PROJECTS}\\web\\`),
];

const runnerFor = (out: Record<string, string>) => async (cmd: string, args: string[]) => {
  const key = [cmd, ...args].join(" ");
  return key in out ? { code: 0, out: out[key], err: "" } : { code: 127, out: "", err: "not found" };
};
const WSL_LIST = Buffer.from("  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n  Debian    Stopped         2\r\n", "utf16le").toString("latin1");

describe("Windows command lines", () => {
  test("CommandLineToArgvW rules", () => {
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\cli.js" --x'), ["C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\cli.js", "--x"]);
    assert.deepEqual(splitCommandLine('a.exe "x \\"y\\" z" b\\\\"c d" e\\f'), ["a.exe", 'x "y" z', "b\\c d", "e\\f"]);
    assert.deepEqual(splitCommandLine('C:\\dir\\a.exe "say ""hi"""'), ["C:\\dir\\a.exe", 'say "hi"']);
    assert.deepEqual(splitCommandLine("   "), []);
    assert.equal(trimDir("C:\\x\\"), "C:\\x");
    assert.equal(trimDir("C:\\"), "C:\\");
  });

  test("which processes are the CLIs", () => {
    const a = (s: string) => splitCommandLine(s);
    assert.ok(matchesWin("claude", a('"C:\\Users\\me\\.local\\bin\\claude.exe" --resume x')));
    assert.ok(matchesWin("claude", a("node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js")));
    assert.ok(matchesWin("gemini", a('"C:\\nodejs\\node.exe" "C:\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"')));
    assert.ok(matchesWin("agy", a("C:\\tools\\agy.exe")));
    assert.ok(!matchesWin("claude", a('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\npm\\claude.cmd""')));
    assert.ok(!matchesWin("claude", a("node C:\\x\\server\\index.mjs")));
  });
});

describe("WSL", () => {
  test("wsl.exe running claude: distro and Linux folder", () => {
    const a = (s: string) => splitCommandLine(s);
    assert.deepEqual(wslClaude(a("wsl.exe -d Ubuntu --cd /home/me/src/app -- claude"), "C:\\Users\\me"), { distro: "Ubuntu", linux: "/home/me/src/app" });
    assert.deepEqual(wslClaude(a("wsl claude --resume 1"), "C:\\Users\\me\\projects\\shop"), { distro: null, linux: "/mnt/c/Users/me/projects/shop" });
    assert.deepEqual(wslClaude(a("wsl -e claude"), "\\\\wsl.localhost\\Debian\\home\\me\\x"), { distro: "Debian", linux: "/home/me/x" });
    assert.deepEqual(wslClaude(a('wsl -- bash -lc "cd ~/x && claude"'), null), { distro: null, linux: null });
    assert.deepEqual(wslClaude(a("wsl ~ claude"), "C:\\x"), { distro: null, linux: null });
    assert.equal(wslClaude(a("wsl.exe -d Ubuntu"), "C:\\x"), null);
    assert.equal(wslClaude(a("wsl claude -p hi"), "C:\\x"), null);
    assert.deepEqual(parseWslList(WSL_LIST), [{ name: "Ubuntu", isDefault: true }, { name: "Debian", isDefault: false }]);
  });

  test("UNC paths and the transcripts folder inside the distro", () => {
    assert.deepEqual(parseWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj"), { distro: "Ubuntu", root: "\\\\wsl.localhost\\Ubuntu", linux: "/home/me/proj" });
    assert.deepEqual(parseWslPath("\\\\wsl$\\Debian"), { distro: "Debian", root: "\\\\wsl$\\Debian", linux: "/" });
    assert.equal(parseWslPath("C:\\Users\\me"), null);
    assert.equal(wslUncPath("Ubuntu", "/home/me/proj"), "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj");
    // A fake distro root: /home/me has a transcript folder for the project, /home/other doesn't
    const root = mkdtempSync(join(tmpdir(), "vcli-wsl-"));
    mkdirSync(join(root, "home", "alice"), { recursive: true }); // no ~/.claude
    mkdirSync(join(root, "home", "other", ".claude", "projects"), { recursive: true });
    mkdirSync(join(root, "home", "me", ".claude", "projects", "-home-me-src-app"), { recursive: true });
    assert.equal(wslClaudeDir(root, "/home/me/src/app"), join(root, "home", "me", ".claude", "projects", "-home-me-src-app"));
    // none yet: the first home with a ~/.claude
    assert.equal(wslClaudeDir(root, "/srv/x"), join(root, "home", "me", ".claude", "projects", "-srv-x"));
  });
});

describe("Claude Code's transcript folders", () => {
  test("every non-alphanumeric character becomes -, long paths get a hash", () => {
    assert.equal(claudeProjectKey("C:\\Users\\me\\proj"), "C--Users-me-proj");
    assert.equal(claudeProjectKey("/home/me/my.app"), "-home-me-my-app");
    const long = "C:\\Users\\me\\" + "very-long-folder-name\\".repeat(12) + "proj";
    const key = claudeProjectKey(long);
    assert.equal(key, long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200) + "-4g59jc");
    assert.equal(claudeDir("/home/me/proj"), join(TEST_HOME, ".claude", "projects", "-home-me-proj"));
  });
});

describe("finding CLIs and their terminals", () => {
  test("CLIs with their folders (helpers and headless runs skipped, WSL claude as a UNC folder)", async () => {
    setWslDefault(undefined);
    const found = await winCliProcs(PROCS.map((p) => ({ ...p, cwd: p.cwd ? trimDir(p.cwd) : p.cwd })), undefined, runnerFor({ "wsl.exe -l -v": WSL_LIST }) as never);
    assert.deepEqual(found.map((f) => [f.p.pid, f.cli, f.cwd, f.wsl]), [
      [2200, "claude", `${PROJECTS}\\shop`, false],
      [2302, "gemini", `${PROJECTS}\\api`, false],
      [3002, "claude", "C:\\work\\legacy", false],
      [4000, "claude", "\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app", true],
      [4001, "claude", "\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\projects\\shop", true],
      [5002, "claude", `${PROJECTS}\\web`, false],
    ]);
  });

  test("terminal hosts: Windows Terminal, a console (conhost under the shell), WezTerm", () => {
    assert.deepEqual([terminalHost(2200, PROCS).kind, terminalHost(2200, PROCS).host?.pid], ["wt", 2000]);
    assert.deepEqual([terminalHost(3002, PROCS).kind, terminalHost(3002, PROCS).host?.pid], ["console", 3001]);
    assert.deepEqual([terminalHost(5002, PROCS).kind, terminalHost(5002, PROCS).host?.pid], ["wezterm", 5000]);
    assert.equal(terminalHost(4001, PROCS).kind, "wt");
  });

  const win = (id: string, pid: number, appId: string, app: string): DesktopWindow => ({ id, pid, appId, app, title: "", bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const WINDOWS = [win("11", 1000, "explorer.exe", "File Explorer"), win("22", 2000, "WindowsTerminal.exe", "Windows Terminal"),
    win("33", 3000, "cmd.exe", "Windows Command Processor"), win("55", 5000, "wezterm-gui.exe", "WezTerm")];

  test("the window to type into", () => {
    assert.equal(terminalWindow(WINDOWS, 2200, PROCS)?.id, "22");
    assert.equal(terminalWindow(WINDOWS, 4000, PROCS)?.id, "22");
    assert.equal(terminalWindow(WINDOWS, 3002, PROCS)?.id, "33");
    assert.equal(terminalWindow(WINDOWS, 5002, PROCS)?.id, "55");
    // console window reported as conhost's own
    assert.equal(terminalWindow([win("44", 3001, "conhost.exe", "Console Window Host")], 3002, PROCS)?.id, "44");
    // handed off to Windows Terminal (default terminal): its one window
    const handoff = [...PROCS, P(6000, 6999, "node.exe", "node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "C:\\x")];
    assert.equal(terminalWindow(WINDOWS, 6000, handoff)?.id, "22");
    assert.equal(terminalWindow(WINDOWS, 999999, PROCS), null);
  });

  test("WezTerm: the pane in the CLI's folder, typed into with send-text", async () => {
    const list = JSON.stringify([{ pane_id: 0, cwd: "file:///C:/Users/me/" }, { pane_id: 3, cwd: "file:///C:/Users/me/projects/web/" }]);
    assert.equal(weztermPaneFor(list, `${PROJECTS}\\web`), 3);
    assert.equal(weztermPaneFor(list, `${PROJECTS}\\none`), null);
    const c = { p: PROCS.find((p) => p.pid === 5002)!, cli: "claude" as const, cwd: `${PROJECTS}\\web`, wsl: false };
    assert.deepEqual(await winDeliveryFor(c, PROCS, runnerFor({ "wezterm cli list --format json": list }) as never), { kind: "wezterm", pane: 3 });
  });

  test("underProject is case-insensitive and slash-agnostic", () => {
    assert.ok(underProject("c:/users/ME/projects/shop/src", `${PROJECTS}\\shop`));
    assert.ok(underProject(`${PROJECTS}\\shop`, `${PROJECTS}\\shop\\`));
    assert.ok(!underProject(`${PROJECTS}\\shopping`, `${PROJECTS}\\shop`));
  });

  test("winFind / winProbeWindow with a fake helper and keyboard delivery", async () => {
    setWinProcessSource(async () => PROCS);
    const typed: string[] = [];
    const desktop = { windows: async () => WINDOWS, activeWindow: async () => WINDOWS[1], focus: async () => {} } as unknown as Desktop;
    const input = { type: async (t: string) => { typed.push(t); }, key: async (k: string) => { typed.push(`<${k}>`); } } as unknown as InputInjector;
    const k = createWinKeyboardDelivery(desktop, async () => input);
    const found = await winFind("claude", `${PROJECTS}\\shop`);
    assert.equal(found?.pid, 2200);
    assert.deepEqual(found?.delivery, { kind: "keyboard", pid: 2200 });
    assert.equal(found?.cwd, `${PROJECTS}\\shop`);
    assert.ok(await k.type(2200, "hello"));
    assert.ok(await k.enter(2200));
    assert.deepEqual(typed, ["hello", "<enter>"]);
    assert.equal(await winFind("claude", `${PROJECTS}\\nothing`), null);
    // the console window under the pointer (owned by cmd.exe 3000): the claude in it
    const pointed = await winProbeWindow(3000);
    assert.equal(pointed?.context?.pid, 3002);
    assert.equal(pointed?.project, "C:\\work\\legacy");
    setWinKeyboard(null);
    setWinProcessSource(null);
  });
});

describe("launching on Windows", () => {
  test("Windows Terminal, then WezTerm, then a console window", () => {
    const l = windowsLaunchers("C:\\c\\claude-1.cmd", "C:\\p", { wt: "C:\\WindowsApps\\wt.exe", wezterm: "C:\\WezTerm\\wezterm.exe" }, "C:\\WINDOWS\\system32\\cmd.exe");
    assert.deepEqual(l.map((x) => x.name), ["windows-terminal", "wezterm", "console"]);
    assert.deepEqual(l[0].args, ["-d", "C:\\p", "cmd", "/k", "C:\\c\\claude-1.cmd"]);
    assert.deepEqual(l[1].args, ["start", "--cwd", "C:\\p", "--", "cmd", "/k", "C:\\c\\claude-1.cmd"]);
    assert.deepEqual(l[2].args, ["/d", "/s", "/c", '"start "" /D "C:\\p" cmd /k "C:\\c\\claude-1.cmd""']);
    assert.equal(l[2].verbatim, true);
    assert.deepEqual(windowsLaunchers("s.cmd", "C:\\p", { wt: null, wezterm: null }).map((x) => x.name), ["console"]);
  });

  /** cmd's batch-file parsing of one line (phase 1 %%, phase 2 carets and quotes), then the C runtime's argv. */
  const asProgramSees = (line: string) => {
    const s = line.replace(/%%/g, "%");
    let out = "", q = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '"') { q = !q; out += s[i]; } else if (s[i] === "^" && !q) out += s[++i] ?? ""; else out += s[i];
    }
    return splitCommandLine(out);
  };

  test("batch arguments reach the program intact", () => {
    const nasty = ['say "hi" & exit', "50% | more", "C:\\dir\\", "(x) <y> ^z", "", "plain"];
    assert.deepEqual(asProgramSees(batchCommand(["C:\\Program Files\\x\\claude.exe", ...nasty])), ["C:\\Program Files\\x\\claude.exe", ...nasty]);
    assert.equal(batchArg("plain"), "plain");
  });

  test("the claude launch script: one line under cmd's limit, the prompt intact", () => {
    const cfg = resolveConfig({ node: "C:\\nodejs\\node.exe", server: "C:\\app\\server\\index.mjs", path: "C:\\nodejs;C:\\Users\\me\\.local\\bin",
      claude: "C:\\Users\\me\\.local\\bin\\claude.exe", agy: null, gemini: null });
    const t = new TerminalSession("C:\\Users\\me\\projects\\shop & co", "claude", cfg, { activity: new BufferedActivity(new ActivityLog(join(TEST_HOME, "a.log"))) });
    const body = t.windowsScript("C:\\cache\\claude-1.where", false);
    const lines = body.split("\n");
    assert.ok(lines.includes('cd /d "C:\\Users\\me\\projects\\shop & co"'));
    assert.ok(lines.includes('>"C:\\cache\\claude-1.where" echo(- - %WEZTERM_PANE%'));
    const cmd = lines.find((l) => l.startsWith('"C:\\Users\\me\\.local\\bin\\claude.exe"'))!;
    assert.ok(cmd.length < 8191, `${cmd.length} characters`);
    const argv = asProgramSees(cmd);
    assert.equal(argv[1], "--append-system-prompt");
    assert.equal(argv[2], terminalPrompt.replace(/\s*\n\s*/g, " "));
    assert.equal(argv[3], "--allowedTools");
    assert.deepEqual(argv.slice(-2), ["--session-id", t.sessionId()]);
  });

  test("the gemini launch script reads the API key at launch, never into the script", () => {
    mkdirSync(SUP, { recursive: true });
    writeFileSync(join(SUP, "integrations.json"), JSON.stringify({ gemini: { apiKey: "test-key-not-real" } }));
    const cfg = resolveConfig({ node: "C:\\nodejs\\node.exe", server: "s", path: "C:\\nodejs", claude: "claude", agy: null, gemini: "C:\\tools\\gemini.exe" });
    const t = new TerminalSession("C:\\p", "gemini", cfg, { activity: new BufferedActivity(new ActivityLog(join(TEST_HOME, "a.log"))) });
    const body = t.windowsScript("C:\\cache\\g.where", true);
    assert.ok(!body.includes("test-key-not-real"));
    assert.match(body, /^set "GEMINI_CLI_SYSTEM_SETTINGS_PATH=.*gemini-system-settings\.json"$/m);
    assert.match(body, /^for \/f "usebackq delims=" %%K in \(`call "C:\\nodejs\\node\.exe" ".*gemini-key\.js" ".*integrations\.json"`\) do set "GEMINI_API_KEY=%%K"$/m);
    assert.deepEqual(asProgramSees(body.split("\n").find((l) => l.startsWith('"C:\\tools'))!), ["C:\\tools\\gemini.exe", "--resume", t.sessionId()]);
  });
});
