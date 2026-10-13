import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./config.js";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_APP = join(root, "overlay", "build", "VisionCLI.app");
const INSTALLED_APP = "/Applications/VisionCLI.app"; // the build script installs here
const appPath = () => (existsSync(join(INSTALLED_APP, "Contents", "MacOS", "VisionCLI")) ? INSTALLED_APP : BUILT_APP);
const LABEL = "dev.visioncli.overlay";
const AGENT = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const SUPPORT = CONFIG_DIR;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** launchd agent: restarts VisionCLI after a crash (not after a normal quit); RunAtLoad = start at login. */
function writeAgent(exe: string) {
  let runAtLoad = false;
  try {
    runAtLoad = /<key>RunAtLoad<\/key>\s*<true\/>/.test(readFileSync(AGENT, "utf8"));
  } catch {}
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(
    AGENT,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(exe)}</string></array>
  <key>RunAtLoad</key><${runAtLoad}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), "Library", "Logs", "visioncli-stderr.log"))}</string>
</dict>
</plist>
`,
  );
}

async function which(cmd: string) {
  try {
    return (await run("/usr/bin/which", [cmd])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Build (if needed) and launch the voice overlay for a project. Replaces any running instance. */
export async function startVoice(cwd: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Voice mode is only supported on macOS.");

  if (!existsSync(join(appPath(), "Contents", "MacOS", "VisionCLI"))) {
    await run(join(root, "scripts", "build-overlay.sh"), { cwd: root });
  }
  const APP = appPath();

  const claude = process.env.VISIONCLI_CLAUDE ?? (await which("claude"));
  if (!claude) throw new Error("Couldn't find the `claude` CLI on PATH. Set VISIONCLI_CLAUDE to its full path.");

  // The overlay runs `claude` with only this server attached (node + script below), so it starts fast and
  // doesn't depend on how visioncli was installed. `--cwd` is the fallback project when it can't tell
  // the project from the window under the pointer.
  // Settings the app reads at launch (it's started by launchd without arguments).
  const config: Record<string, string> = {
    cwd: resolve(cwd),
    claude,
    path: process.env.PATH ?? "",
    node: process.execPath,
    server: join(root, "dist", "index.js"),
  };
  if (process.env.VISIONCLI_MODEL) config.model = process.env.VISIONCLI_MODEL;
  if (process.env.VISIONCLI_LOCALE) config.locale = process.env.VISIONCLI_LOCALE;
  mkdirSync(SUPPORT, { recursive: true });
  writeFileSync(join(SUPPORT, "overlay.json"), JSON.stringify(config));

  // The app runs under launchd without your shell's environment: keep the TypeSafe key (for Jev quick
  // commands) in integrations.json, readable only by you.
  // (Gemini uses your normal `gemini` sign-in; a Gemini API key is only used if you add one to integrations.json yourself.)
  const keys: Record<string, string | undefined> = { typesafe: process.env.TYPESAFE_API_KEY };
  if (Object.values(keys).some(Boolean)) {
    const file = join(SUPPORT, "integrations.json");
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch {}
    let changed = false;
    for (const [name, key] of Object.entries(keys)) {
      if (key && !cfg[name]?.apiKey) { cfg[name] = { ...(cfg[name] ?? {}), apiKey: key }; changed = true; }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  }

  // Stop any running instance (launchd-managed or not), then start it under launchd so a crash gets
  // an automatic restart. Launched this way the app is still its own process for macOS permissions.
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => {});
  await run("/usr/bin/pkill", ["-x", "VisionCLI"]).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  writeAgent(join(APP, "Contents", "MacOS", "VisionCLI"));
  await run("/bin/launchctl", ["bootstrap", domain, AGENT]).catch(() => {});
  await run("/bin/launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);

  return (
    `Voice mode is on (default project ${resolve(cwd)}; it follows the project of the window under your pointer). Hold Option+Space, ask your question, then let go. ` +
    `The answer appears above your mouse pointer (Esc dismisses it). The eye icon in the menu bar has Quit. ` +
    `The first time, macOS asks for Microphone and Speech Recognition access. VisionCLI also needs ` +
    `Screen Recording permission (System Settings → Privacy & Security).`
  );
}

/** Register visioncli as a user-scope MCP server in Claude Code and Antigravity CLI (and build the voice overlay on macOS). */
export async function install(): Promise<string> {
  const claude = process.env.VISIONCLI_CLAUDE ?? (await which("claude"));
  if (!claude) throw new Error("Couldn't find the `claude` CLI on PATH.");
  const script = join(root, "dist", "index.js");
  // Installed via `npx visioncli install`: the npx cache path is temporary, so register through npx instead.
  const server = script.includes("/_npx/") ? ["npx", "-y", "visioncli@latest"] : [process.execPath, script];
  await run(claude, ["mcp", "remove", "visioncli", "-s", "user"]).catch(() => {});
  await run(claude, ["mcp", "add", "visioncli", "--scope", "user", "--", ...server]);
  const lines = [`Registered the visioncli MCP server with Claude Code for all projects (${server.join(" ")}).`];
  // Antigravity CLI (agy, Gemini on a Google account), if installed: global MCP config + allow rules for headless runs.
  if (await which("agy") || existsSync(join(homedir(), ".local", "bin", "agy"))) {
    const mcpFile = join(homedir(), ".gemini", "config", "mcp_config.json");
    const settingsFile = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
    const read = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };
    const mcp = read(mcpFile);
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), visioncli: { command: server[0], args: server.slice(1) } };
    mkdirSync(dirname(mcpFile), { recursive: true });
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
    const settings = read(settingsFile);
    const allow: string[] = settings.permissions?.allow ?? [];
    for (const t of ["look", "list_windows", "select_region", "clipboard_image", "device_screenshot", "db_schema", "db_query",
      "browser_tabs", "browser_read", "browser_elements", "browser_open", "browser_switch_tab", "browser_navigate", "browser_scroll",
      "ui_elements", "click", "type_text", "press_keys", "scroll", "drag", "open_app", "open_url"]) {
      if (!allow.includes(`mcp(visioncli/${t})`)) allow.push(`mcp(visioncli/${t})`);
    }
    // Read-only commands Gemini may run without asking (headless agy can't prompt).
    for (const c of ["grep", "rg", "ls", "cat", "head", "tail", "find", "wc", "pwd", "file", "stat", "tree",
      "git status", "git log", "git diff", "git show", "git branch", "git blame"]) {
      if (!allow.includes(`command(${c})`)) allow.push(`command(${c})`);
    }
    settings.permissions = { ...(settings.permissions ?? {}), allow };
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    lines.push("Registered it with Antigravity CLI (agy) as well.");
  }
  if (process.platform === "darwin") {
    if (!existsSync(join(appPath(), "Contents", "MacOS", "VisionCLI"))) await run(join(root, "scripts", "build-overlay.sh"), { cwd: root });
    lines.push("Voice overlay built. Start it with: visioncli voice  (or ask Claude to \"start voice mode\").");
    lines.push("Grant Screen Recording to your terminal (and to VisionCLI for voice mode) in System Settings → Privacy & Security.");
  }
  lines.push("Restart Claude Code to load it.");
  return lines.join("\n");
}
