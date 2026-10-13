import { dialog } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AudioDevice } from "../contracts";
import { installGnomeExtension } from "../desktop/windows";
import { connectTools as connect, findTools, isInstalled as installed, toolsConnected, type Tools } from "../features/integrations";
import { run } from "../features/run";
import { log } from "../log";
import type { Assistant } from "../settings";
import { settings } from "../settings";
import { installSystemSpeech } from "../stt/install";
import { hasTmux } from "../terminal/mux";
import { which } from "../terminal/launcher";
import type { AssistantId, SetupCheck, SetupChecks, SetupStepId, ToolsStatus } from "../ui/windows";
import { App } from "./core";

// First run and maintenance (App+Setup.swift + Setup.swift's checks, with Linux's one-time steps): the setup
// wizard's checks and fixes, connecting VisionCLI's MCP tools to each CLI, and the system bits behind them.
// The Settings window and the wizard poll often, so the slow facts (devices, buses, CLIs) are cached here and
// refreshed in the background.

export interface Probe {
  at: number;
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  startAtLogin: boolean;
  atspi: boolean;
  desktopProblem: string | null;
  speech: { parakeet: boolean; whisper: string[]; system: boolean };
  tmux: boolean;
  tools: Record<AssistantId, ToolsStatus>;
}

declare module "./core" {
  interface App {
    probe: Probe;
    refreshProbe(force?: boolean): Promise<void>;
    setupChecks(): SetupChecks;
    setupFix(step: SetupStepId): Promise<void>;
    toolsFor(): Promise<Tools>;
    checkTools(): Promise<void>;
    connectToolsFor(a: AssistantId): Promise<void>;
    isInstalled(a: AssistantId): boolean;
    grantKeyboardAccess(): Promise<void>;
    enableAtspi(): Promise<void>;
    setupInput(): Promise<void>;
    fixPermissions(): Promise<void>;
    retryHotkeys(): Promise<void>;
    setupBusy: Partial<Record<SetupStepId, string>>;
    installCommand(): string;
  }
}

const noTools = (): Record<AssistantId, ToolsStatus> => ({
  claude: { connected: null, connecting: false, error: null },
  antigravity: { connected: null, connecting: false, error: null },
  gemini: { connected: null, connecting: false, error: null },
});

App.prototype.probe = {
  at: 0, inputs: [], outputs: [], startAtLogin: false, atspi: false, desktopProblem: null,
  speech: { parakeet: false, whisper: [], system: false }, tmux: false, tools: noTools(),
};
App.prototype.setupBusy = {};

let probing: Promise<void> | null = null;

App.prototype.refreshProbe = function (this: App, force = false) {
  if (!force && Date.now() - this.probe.at < 1400) return probing ?? Promise.resolve();
  probing ??= (async () => {
    const [inputs, outputs, startAtLogin, atspi, desktopProblem, speech, tmux] = await Promise.all([
      this.audio.inputs().catch(() => []), this.audio.outputs().catch(() => []), this.autostart.isEnabled().catch(() => false),
      this.ax.available().catch(() => false), this.desktop.problem().catch(() => null),
      this.engines.available().catch(() => ({ parakeet: false, whisper: [], system: false })), hasTmux(),
    ]);
    // A copy: probe starts out as the prototype's shared default.
    this.probe = { ...this.probe, at: Date.now(), inputs, outputs, startAtLogin, atspi, desktopProblem, speech, tmux };
    this.screenProblem = desktopProblem ? "Set Up Screen Capture…" : null;
  })().finally(() => { probing = null; });
  return probing;
};

App.prototype.installCommand = function (this: App) {
  const packaged = process.resourcesPath && existsSync(join(process.resourcesPath, "bin", "install-deps.sh"));
  return packaged ? `sh ${join(process.resourcesPath, "bin", "install-deps.sh")}` : "sh linux/scripts/install-deps.sh";
};

App.prototype.setupChecks = function (this: App): SetupChecks {
  void this.refreshProbe();
  if (this.hotkeyInfo.problem) void this.retryHotkeys();
  const p = this.probe, busy = this.setupBusy;
  const def = p.inputs.find((d) => d.isDefault) ?? p.inputs[0];
  const checks: SetupChecks = {};
  checks.microphone = def
    ? { state: "done", detail: `${p.inputs.length} microphone${p.inputs.length === 1 ? "" : "s"} · ${def.name}` }
    : { state: "pending", detail: "No microphone found", note: "Plug one in, or install PipeWire / PulseAudio's tools (pactl).", command: this.installCommand() };
  const kb = this.hotkeyInfo;
  checks.keyboard = !kb.problem && kb.backend !== "none"
    ? { state: "done", detail: kb.backend === "xinput2" ? "Reading the keyboard through X11 (XInput2)" : "Reading the keyboard (input group)" }
    : { state: "pending", detail: kb.problem ?? "Hold-to-talk can't read the keyboard yet", fix: "Join the input group…",
        note: "Log out and back in once afterwards.", command: "sudo usermod -aG input $USER", busy: !!busy.keyboard };
  checks.screen = !p.desktopProblem
    ? { state: "done", detail: `${this.desktopLabel()}: windows, pointer and capture work` }
    : { state: "pending", detail: p.desktopProblem, fix: this.desktop.backend === "gnome" ? "Install the GNOME extension" : "Try a screenshot",
        command: this.desktop.backend === "x11" ? this.installCommand() : undefined, busy: !!busy.screen };
  const inputOk = !!this.inputBackend && this.inputBackend !== "none";
  checks.control = inputOk && p.atspi
    ? { state: "done", detail: `Input: ${this.inputBackend} · accessibility on` }
    : { state: "pending", detail: [inputOk ? `Input: ${this.inputBackend}` : "Can't click or type yet", p.atspi ? "accessibility on" : "accessibility (AT-SPI) off"].join(" · "),
        fix: "Set Up Computer Control", note: "The desktop may ask once to allow remote control of this computer.",
        command: inputOk ? "gsettings set org.gnome.desktop.interface toolkit-accessibility true" : this.installCommand(), busy: !!busy.control };
  checks.terminal = p.tmux || which("kitty") || which("wezterm")
    ? { state: "done", detail: p.tmux ? "tmux found: VisionCLI can type into the CLI's terminal" : "kitty / WezTerm found" }
    : { state: "optional", detail: "No tmux: VisionCLI types into your terminal window with the keyboard instead", command: this.installCommand() };
  if (!p.speech.parakeet && !p.speech.whisper.length) {
    checks.transcription = { state: "pending", detail: busy.transcription ?? "No speech model on this computer yet",
      fix: "Download the speech model (~150 MB)", busy: !!busy.transcription };
  }
  return checks;
};

App.prototype.retryHotkeys = async function (this: App) {
  const self = this as App & { lastHotkeyRetry?: number };
  if (Date.now() - (self.lastHotkeyRetry ?? 0) < 5000) return;
  self.lastHotkeyRetry = Date.now();
  this.hotkeys.stop();
  this.hotkeyInfo = await this.hotkeys.start();
  if (!this.hotkeyInfo.problem) { log(`hotkeys: now working (${this.hotkeyInfo.backend})`); this.windows.refreshWindows(); }
};

App.prototype.setupFix = async function (this: App, step: SetupStepId) {
  const busy = (label: string | null) => { if (label) this.setupBusy[step] = label; else delete this.setupBusy[step]; this.windows.refreshWindows(); };
  try {
    switch (step) {
      case "keyboard": busy("Working…"); await this.grantKeyboardAccess(); break;
      case "screen": {
        busy("Working…");
        if (this.desktop.backend === "gnome") {
          const r = await installGnomeExtension();
          await dialog.showMessageBox({ type: r.ok ? "info" : "warning", message: r.ok ? "GNOME extension" : "Couldn't set up the GNOME extension", detail: r.message, buttons: ["OK"] });
        } else {
          // A test capture: on Wayland the screenshot portal asks the user once here.
          const d = (await this.desktop.displays())[0] ?? { x: 0, y: 0, width: 64, height: 64 };
          await this.ui.hiddenDuring(() => this.desktop.captureRect({ x: d.x, y: d.y, width: Math.min(64, d.width), height: Math.min(64, d.height) }))
            .then(() => log("setup: test capture ok"), (e) => log(`setup: test capture failed: ${e?.message ?? e}`));
        }
        break;
      }
      case "control": busy("Working…"); await this.setupInput(); await this.enableAtspi(); break;
      case "transcription":
        busy("Starting…");
        await installSystemSpeech((label, f) => busy(f == null ? `${label}…` : `Downloading ${label}… ${Math.round(f * 100)}%`))
          .then(async () => { settings.set("stt", "system"); await this.restartSpeechEngine(); })
          .catch((e) => dialog.showMessageBox({ type: "warning", message: "Couldn't install speech recognition", detail: String(e?.message ?? e), buttons: ["OK"] }));
        break;
      default: break;
    }
  } finally {
    busy(null);
    await this.refreshProbe(true);
  }
};

App.prototype.toolsFor = async function (this: App) {
  const t = await findTools(this.cfg.server);
  // The node and server the app itself runs (the packaged wrapper when there's no Node.js).
  return { ...t, node: this.cfg.node ?? t.node, server: this.cfg.server, claude: existsSync(this.cfg.claude) ? this.cfg.claude : t.claude, path: this.cfg.path };
};

/** Which CLIs have VisionCLI's tools (slow: runs each CLI). */
App.prototype.checkTools = async function (this: App) {
  const t = await this.toolsFor();
  const tools = { ...this.probe.tools };
  await Promise.all((["claude", "antigravity", "gemini"] as const).map(async (a) => {
    tools[a] = { ...tools[a], connected: installed(a, t) ? await toolsConnected(a, t).catch(() => false) : false };
  }));
  this.probe = { ...this.probe, tools };
  this.windows.refreshWindows();
};

App.prototype.connectToolsFor = async function (this: App, a: AssistantId) {
  this.probe = { ...this.probe, tools: { ...this.probe.tools, [a]: { connected: this.probe.tools[a].connected, connecting: true, error: null } } };
  this.windows.refreshWindows();
  const err = await connect(a as Assistant, await this.toolsFor()).catch((e) => String(e?.message ?? e));
  log(`tools: ${a} ${err ? "failed: " + err : "connected"}`);
  this.probe = { ...this.probe, tools: { ...this.probe.tools, [a]: { connected: !err, connecting: false, error: err?.trim() || null } } };
  this.windows.refreshWindows();
};

App.prototype.isInstalled = function (this: App, a: AssistantId) {
  if (a === "claude") return existsSync(this.cfg.claude);
  return a === "antigravity" ? !!this.cfg.agy : !!this.cfg.gemini;
};

/** Hold-to-talk on Wayland (and X11 without xinput) reads /dev/input: the user joins the `input` group once. */
App.prototype.grantKeyboardAccess = async function (this: App) {
  const user = process.env.USER || process.env.LOGNAME || "";
  if (this.hotkeyInfo.backend === "xinput2" && !this.hotkeyInfo.problem) {
    await dialog.showMessageBox({ type: "info", message: "Hold-to-talk already works", detail: "On this X11 session VisionCLI reads the keyboard through XInput2. Joining the input group is only needed on Wayland.", buttons: ["OK"] });
    return;
  }
  if (!which("pkexec") || !user) {
    await dialog.showMessageBox({ type: "info", message: "Join the input group", detail: "Run this in a terminal, then log out and back in:\n\nsudo usermod -aG input $USER", buttons: ["OK"] });
    return;
  }
  const r = await run("pkexec", ["usermod", "-aG", "input", user], { timeout: 120_000 });
  await dialog.showMessageBox(r.code === 0
    ? { type: "info", message: "You're in the input group", detail: "Log out and back in once so hold-to-talk can read the keyboard.", buttons: ["OK"] }
    : { type: "warning", message: "Couldn't join the input group", detail: (r.err || r.out || `pkexec exited ${r.code}`).trim() + "\n\nRun it yourself: sudo usermod -aG input $USER", buttons: ["OK"] });
};

/** Accessibility (AT-SPI): GNOME's toolkit switch, and the bus's IsEnabled (set by connecting). */
App.prototype.enableAtspi = async function (this: App) {
  if (which("gsettings")) await run("gsettings", ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], { timeout: 5000 });
  const ok = await this.ax.available().catch(() => false);
  log(`setup: accessibility ${ok ? "on" : "unavailable"}`);
};

/** Mouse and keyboard input: creating the injector asks for the RemoteDesktop portal's consent on GNOME / KDE. */
App.prototype.setupInput = async function (this: App) {
  try {
    const i = await this.input();
    this.inputBackend = i.backend;
    if (i.backend === "none") throw new Error("no input backend");
    log(`setup: input ${i.backend}`);
  } catch (e) {
    await dialog.showMessageBox({ type: "warning", message: "Computer control can't send input yet", detail: `${(e as Error)?.message ?? e}\n\nInstall the tools for your desktop:\n${this.installCommand()}`, buttons: ["OK"] });
  }
};

/** Linux's "Fix Permissions": forget the saved remote-control consent so the desktop asks again. */
App.prototype.fixPermissions = async function (this: App) {
  const r = await dialog.showMessageBox({
    type: "question", message: "Fix VisionCLI's permissions?",
    detail: "This forgets VisionCLI's saved remote-control consent so your desktop asks again, and re-checks keyboard, screen and accessibility access. Use it if computer control stopped working after a desktop update.",
    buttons: ["Fix Permissions", "Cancel"], defaultId: 0, cancelId: 1,
  });
  if (r.response !== 0) return;
  settings.setStore("remoteDesktopToken", undefined);
  this.inputBackend = null;
  this.injector = null;
  await this.setupInput();
  await this.enableAtspi();
  await this.retryHotkeys();
  await this.refreshProbe(true);
};
