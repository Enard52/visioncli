import { app, dialog } from "electron";
import { CrashReporter } from "./features/crashreporter";
import { log } from "./log";
import type { App } from "./app/core";

// Entry point of the Linux app: the process side of main.swift (crash-loop guard, crash reporting, one instance,
// SIGTERM = clean quit, visioncli:// links), then app.ts builds and wires every module.

// Electron's native Wayland backend can't place or raise overlay windows (no global coordinates, no always-on-top):
// run under X11 / XWayland everywhere. Must be set before the app is ready.
app.commandLine.appendSwitch("ozone-platform", "x11");
app.commandLine.appendSwitch("disable-features", "WaylandWindowDecorations");

const crash = new CrashReporter({ version: app.getVersion() });
// Checked before install() marks this run as started: four unclean starts in three minutes is a crash loop.
const looping = crash.isCrashLooping();
const recovered = looping ? null : crash.install();
let running: App | null = null;
let shuttingDown = false;
const linkArg = (argv: string[]) => argv.find((a) => a.startsWith("visioncli://"));

if (!app.requestSingleInstanceLock()) {
  // Another VisionCLI is running: it handles any link we were started with (second-instance) and this copy leaves.
  log("another instance is running; exiting");
  crash.markCleanExit();
  app.exit(0);
} else {
  app.on("second-instance", (_e, argv) => {
    const url = linkArg(argv);
    void import("./app").then(({ handleLink }) => {
      if (url && handleLink(running, url)) return;
      running?.windows.openSettings();
    });
  });
  app.on("open-url", (e, url) => { e.preventDefault(); void import("./app").then(({ handleLink }) => handleLink(running, url)); });
  // A tray app: closing Settings / History doesn't quit it.
  app.on("window-all-closed", () => {});
  app.on("before-quit", (e) => {
    if (shuttingDown || !running) { crash.markCleanExit(); return; }
    e.preventDefault();
    shuttingDown = true;
    void running.shutdown(crash).finally(() => app.exit(0));
  });
  // `visioncli voice` replaces a running instance with SIGTERM: shut the helper processes down too.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => { log(`${sig}: quitting`); app.quit(); });
  // Writes to a helper that just exited must fail with an error, not kill the app.
  process.on("SIGPIPE", () => {});

  void app.whenReady().then(async () => {
    if (looping) {
      log("crash loop detected; not restarting");
      await dialog.showMessageBox({
        type: "error", message: "VisionCLI keeps crashing",
        detail: `It crashed several times in the last few minutes, so it won't restart automatically. Details are in ${crash.logFile}. Run \`visioncli voice\` to start it again.`,
        buttons: ["OK"],
      });
      crash.markCleanExit();
      app.exit(0); // a clean exit, so systemd stops restarting it
      return;
    }
    try { app.setAsDefaultProtocolClient("visioncli"); } catch {}
    // Windows groups taskbar entries and notifications by this id (the installer's shortcut uses the same).
    if (process.platform === "win32") app.setAppUserModelId("dev.visioncli.overlay");
    const { launch, handleLink } = await import("./app");
    try {
      running = await launch({ argv: process.argv.slice(1), crash, recovered });
    } catch (e) {
      crash.record(`Launch failed: ${(e as Error)?.message ?? e}`, (e as Error)?.stack);
      log(`launch failed: ${(e as Error)?.stack ?? e}`);
      throw e;
    }
    const url = linkArg(process.argv);
    if (url) handleLink(running, url);
    log(`VisionCLI ${app.getVersion()} running (${running.desktop.backend}, ${running.hotkeyInfo.backend})`);
  });
}
