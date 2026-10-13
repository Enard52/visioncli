// One overlay window: transparent, frameless, on top of everything (including full-screen apps where the window
// manager allows it), on every workspace, out of the taskbar and alt-tab, never taking focus unless asked to
// (the NSPanel .nonactivatingPanel + .canJoinAllSpaces + .fullScreenAuxiliary setup of the macOS overlays).

import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { join } from "node:path";
import type { Rect } from "../../contracts";
import { log } from "../../log";

export interface OverlayWindowOptions {
  page: "bubble" | "mascot" | "marks" | "region" | "badge" | "hud" | "suggestion";
  query?: Record<string, string>;
  /** Region selection needs the keyboard (esc); everything else never takes focus. */
  focusable?: boolean;
  /** Clicks go to the windows underneath. */
  clickThrough?: boolean;
  bounds?: Rect;
}

// On X11 (and XWayland) Electron maps a non-focusable window as override-redirect: the window manager doesn't manage
// it at all, so it has no frame, no taskbar or alt-tab entry, shows on every workspace and stays above managed
// windows; compositors (Mutter, KWin, Sway, Hyprland) draw such windows on top. That is exactly an NSPanel overlay, so
// every overlay window is non-focusable except the region selector (it wants esc). VCLI_OVERLAY_WINDOW_TYPE can
// still set a _NET_WM_WINDOW_TYPE for that one (e.g. "dock" on WMs that keep docks above full-screen windows).
const windowType = process.env.VCLI_OVERLAY_WINDOW_TYPE;

// ipcMain is shared with the other UI windows: one listener per channel, dispatched by the sending webContents.
const handlers = new Map<string, Map<number, (data: any) => void>>();
function listen(channel: string, id: number, cb: (data: any) => void) {
  let byWindow = handlers.get(channel);
  if (!byWindow) {
    byWindow = new Map();
    handlers.set(channel, byWindow);
    const map = byWindow;
    ipcMain.on(channel, (e: IpcMainEvent, data: unknown) => map.get(e.sender.id)?.(data));
  }
  byWindow.set(id, cb);
}

export class OverlayWindow {
  readonly win: BrowserWindow;
  private loaded = false;
  /** The last message per channel, replayed whenever the page (re)loads. */
  private last = new Map<string, unknown>();
  private readonly wcId: number;
  private clickThrough: boolean;
  private lastBounds = "";

  constructor(readonly opts: OverlayWindowOptions) {
    const b = opts.bounds ?? { x: 0, y: 0, width: 10, height: 10 };
    this.win = new BrowserWindow({
      ...b, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: !!opts.focusable, alwaysOnTop: true, enableLargerThanScreen: true,
      ...(opts.focusable && windowType ? { type: windowType } : {}),
      webPreferences: {
        preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, spellcheck: false,
      },
    });
    this.wcId = this.win.webContents.id;
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.clickThrough = opts.clickThrough ?? true;
    this.win.setIgnoreMouseEvents(this.clickThrough, { forward: true });
    // An answer's links never navigate the overlay itself; the page reports them as actions.
    this.win.webContents.on("will-navigate", (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("did-finish-load", () => {
      this.loaded = true;
      for (const [c, d] of this.last) this.win.webContents.send(c, d);
    });
    // A crashed page comes back with its last state rather than leaving a dead window on screen.
    this.win.webContents.on("render-process-gone", (_e, details) => {
      log(`overlay: ${opts.page} renderer gone (${details.reason}, exit ${details.exitCode}); reloading`);
      this.loaded = false;
      if (details.reason !== "clean-exit" && this.alive) setTimeout(() => { if (this.alive) this.win.webContents.reload(); }, 300);
    });
    const file = join(__dirname, "renderer", opts.page, "index.html");
    void this.win.loadFile(file, { query: opts.query });
  }

  get alive() { return !this.win.isDestroyed(); }
  get visible() { return this.alive && this.win.isVisible(); }
  get bounds(): Rect { return this.win.getBounds(); }

  send(channel: string, data?: unknown) {
    if (!this.alive) return;
    this.last.delete(channel); // keep replay order = send order
    this.last.set(channel, data);
    if (this.loaded) this.win.webContents.send(channel, data);
  }

  on(channel: string, cb: (data: any) => void) { listen(channel, this.wcId, cb); }

  setBounds(r: Rect) {
    const key = `${r.x},${r.y},${r.width},${r.height}`;
    if (!this.alive || key === this.lastBounds) return;
    this.lastBounds = key;
    this.win.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
  }

  setClickThrough(on: boolean) {
    if (!this.alive || on === this.clickThrough) return;
    this.clickThrough = on;
    this.win.setIgnoreMouseEvents(on, { forward: true });
  }

  show() {
    if (!this.alive) return;
    if (!this.win.isVisible()) {
      if (this.opts.focusable) this.win.show(); else this.win.showInactive();
      // Some window managers drop the above-state of unmapped windows; assert it again on every map.
      this.win.setAlwaysOnTop(true, "screen-saver");
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
  }

  raise() { if (this.visible) this.win.moveTop(); }

  hide() { if (this.alive && this.win.isVisible()) this.win.hide(); }

  destroy() {
    for (const m of handlers.values()) m.delete(this.wcId);
    if (this.alive) this.win.destroy();
  }
}
