import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { LOGS } from "../paths";
import { run } from "./run";

// Start at Login (port of LoginItem in overlay/Sources/Support.swift, a launchd agent with KeepAlive on crash).
// Preferred: a systemd user service tied to the graphical session, restarted after a crash (Restart=on-failure),
// with the same loop guard as launchd + CrashReporter (4 starts in 180 s). Fallback where there's no systemd user
// session or the desktop doesn't start graphical-session.target (some plain WMs): an XDG autostart entry.
// Windows: the per-user Run key (HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value "VisionCLI") through
// reg.exe, which needs no admin rights. Windows has no supervisor that restarts a crashed login item, so the crash
// reporter relaunches the app itself (crashreporter.ts), with the same loop guard.

export const UNIT_NAME = "visioncli.service";

export interface AutostartOptions {
  /** The command that starts VisionCLI: $APPIMAGE, or the Electron binary (+ app folder in a dev checkout). */
  exec: string[];
  config?: string;   // $XDG_CONFIG_HOME
  logs?: string;
  runner?: typeof run;
  platform?: string;
}

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE = "VisionCLI";

/** The Run value's data: the command line Windows starts at login (each part quoted as the C runtime reads it). */
export const runValue = (exec: string[]) => exec.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");

/** systemd's quoting for ExecStart: double quotes with backslash escapes. */
export const systemdQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
/** Desktop Entry Exec quoting (the spec's reserved characters inside double quotes). */
const desktopQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s.replace(/%/g, "%%") : `"${s.replace(/([\\"`$])/g, "\\$1").replace(/%/g, "%%")}"`);

export function unitFile(exec: string[], logs = LOGS): string {
  return `[Unit]
Description=VisionCLI voice overlay
PartOf=graphical-session.target
After=graphical-session.target
StartLimitIntervalSec=180
StartLimitBurst=4

[Service]
ExecStart=${exec.map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=10
StandardError=append:${join(logs, "visioncli-stderr.log")}

[Install]
WantedBy=graphical-session.target
`;
}

export function desktopEntry(exec: string[]): string {
  return `[Desktop Entry]
Type=Application
Name=VisionCLI
Comment=Ask your AI about your screen
Exec=${exec.map(desktopQuote).join(" ")}
Icon=visioncli
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=true
`;
}

export class Autostart {
  constructor(private opts: AutostartOptions) {}

  private get config() { return this.opts.config ?? (process.env.XDG_CONFIG_HOME || join(homedir(), ".config")); }
  get unitPath() { return join(this.config, "systemd/user", UNIT_NAME); }
  get desktopPath() { return join(this.config, "autostart/visioncli.desktop"); }
  private get runner() { return this.opts.runner ?? run; }
  private systemctl(...args: string[]) { return this.runner("systemctl", ["--user", ...args], { timeout: 10_000 }); }
  private get windows() { return (this.opts.platform ?? process.platform) === "win32"; }
  private reg(...args: string[]) { return this.runner("reg.exe", args, { timeout: 10_000 }); }

  /** A systemd user manager that starts graphical-session.target (GNOME, KDE, and most systemd distros). */
  async systemdUsable(): Promise<boolean> {
    const r = await this.systemctl("is-active", "graphical-session.target");
    return r.code === 0 && r.out.trim() === "active";
  }

  async isEnabled(): Promise<boolean> {
    if (this.windows) {
      const r = await this.reg("query", RUN_KEY, "/v", RUN_VALUE);
      return r.code === 0 && r.out.includes(RUN_VALUE);
    }
    if (existsSync(this.unitPath) && (await this.systemctl("is-enabled", UNIT_NAME)).out.trim() === "enabled") return true;
    try { return !/^Hidden=true/m.test(readFileSync(this.desktopPath, "utf8")); } catch { return false; }
  }

  /** Turns Start at Login on or off; returns which mechanism is used ("systemd" | "xdg") or throws. */
  async set(on: boolean): Promise<"systemd" | "xdg" | "registry" | "off"> {
    if (this.windows) return this.setWindows(on);
    if (!on) {
      if (existsSync(this.unitPath)) {
        await this.systemctl("disable", UNIT_NAME);
        rmSync(this.unitPath, { force: true });
        await this.systemctl("daemon-reload");
      }
      rmSync(this.desktopPath, { force: true });
      log("start at login: false");
      return "off";
    }
    if (await this.systemdUsable()) {
      mkdirSync(join(this.unitPath, ".."), { recursive: true });
      mkdirSync(this.opts.logs ?? LOGS, { recursive: true });
      writeFileSync(this.unitPath, unitFile(this.opts.exec, this.opts.logs));
      await this.systemctl("daemon-reload");
      const r = await this.systemctl("enable", UNIT_NAME);
      if (r.code === 0) {
        rmSync(this.desktopPath, { force: true }); // one mechanism only, or it would start twice
        log("start at login: true (systemd user service)");
        return "systemd";
      }
      log(`start at login: systemctl enable failed (${r.err.trim()}); using XDG autostart`);
      rmSync(this.unitPath, { force: true });
    }
    mkdirSync(join(this.desktopPath, ".."), { recursive: true });
    writeFileSync(this.desktopPath, desktopEntry(this.opts.exec));
    log("start at login: true (XDG autostart)");
    return "xdg";
  }

  private async setWindows(on: boolean): Promise<"registry" | "off"> {
    if (!on) {
      const r = await this.reg("delete", RUN_KEY, "/v", RUN_VALUE, "/f");
      // Deleting a value that isn't there fails too; only a failure while it's still there is an error.
      if (r.code !== 0 && (await this.isEnabled())) throw new Error(`reg delete failed: ${(r.err || r.out).trim()}`);
      log("start at login: false");
      return "off";
    }
    const r = await this.reg("add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", runValue(this.opts.exec), "/f");
    if (r.code !== 0) throw new Error(`reg add failed: ${(r.err || r.out).trim()}`);
    log("start at login: true (Run key)");
    return "registry";
  }
}

/** The command that starts this copy: the AppImage, the installed binary, or electron + the app folder. */
export function launchCommand(appPath?: string): string[] {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  // electron-builder's portable .exe unpacks to a temp folder on each run; start the .exe itself.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return [process.env.PORTABLE_EXECUTABLE_FILE];
  return appPath && process.defaultApp ? [process.execPath, appPath] : [process.execPath];
}
