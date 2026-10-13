// Windows: windows, pointer, displays and capture through the native helper (vcli-win.exe: EnumWindows in z-order,
// DWM frame bounds, PrintWindow/BitBlt → JPEG). Same behaviour as the X11 backend: front-most first, VisionCLI's own
// windows left out, images at most 1568 px on the longest side, q85.

import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { log } from "../../log";
import { TMP } from "../../paths";
import { type WinHelper as HelperClient, createHelper } from "../../platform/win32/helper";
import type { WinWindow } from "../../platform/win32/protocol";
import { MAX_IMAGE_DIM, intersect, jpegSize, keepWindow, ownPids, union } from "./common";

/** The helper client as the backends use it (platform/win32/helper.ts); tests pass a fake. */
export type WinHelper = Pick<HelperClient, "call" | "on" | "close">;

let shared: WinHelper | null = null;
/** The one helper process every Windows backend talks to (started on first use). */
export function winHelper(): WinHelper {
  shared ??= createHelper();
  return shared;
}

/** "chrome.exe" → "chrome": the closest thing Windows has to a WM_CLASS / app id. */
export const exeId = (exe: string) => exe.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

export function toDesktopWindow(w: WinWindow): DesktopWindow {
  return { id: w.hwnd, app: w.app || exeId(w.exe), appId: exeId(w.exe), title: w.title, pid: w.pid, bounds: { ...w.bounds } };
}

export class Win32Desktop implements Desktop {
  readonly backend = "win32" as const;
  constructor(private helper: WinHelper, private own: Set<number> = ownPids(), private tmp = TMP) {}

  async problem(): Promise<string | null> { return null; }

  async displays(): Promise<Rect[]> {
    try {
      return (await this.helper.call("displays", {})).map(({ x, y, width, height }) => ({ x, y, width, height }));
    } catch (e) { log(`win32 displays: ${(e as Error).message}`); return []; }
  }

  async pointer(): Promise<Point | null> {
    try { const p = await this.helper.call("pointer", {}); return { x: p.x, y: p.y }; } catch { return null; }
  }

  async windows(): Promise<DesktopWindow[]> {
    const rows = await this.helper.call("windows", { excludePid: process.pid });
    return rows.filter((w) => !w.cloaked).map(toDesktopWindow).filter((w) => keepWindow(w, this.own));
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    const active = await this.helper.call("activeWindow", { excludePid: process.pid }).catch(() => null);
    // Our overlay may hold focus; like macOS (non-activating panels) the user's app is the one behind it.
    if (active && !active.cloaked && !this.own.has(active.pid)) return toDesktopWindow(active);
    return (await this.windows())[0] ?? null;
  }

  /** The window's own pixels (PrintWindow: right even when covered), at w.bounds for pointer/click mapping. */
  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.capture({ hwnd: w.id });
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    const screen = union(await this.displays());
    const c = screen.width ? intersect(r, screen) : r;
    return this.capture({ rect: { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: Math.round(c.height) } });
  }

  private async capture(target: { hwnd?: string; rect?: Rect }): Promise<Jpeg> {
    const file = join(this.tmp, `visioncli-cap-${process.pid}-${randomBytes(4).toString("hex")}.jpg`);
    try {
      const size = await this.helper.call("capture", { ...target, maxDim: MAX_IMAGE_DIM, file });
      const data = await readFile(file);
      return { data, ...(jpegSize(data) ?? size) };
    } finally { await rm(file, { force: true }).catch(() => {}); }
  }

  async focus(w: DesktopWindow): Promise<void> {
    if (!(await this.helper.call("focus", { hwnd: w.id }))) throw new Error(`Couldn't bring ${w.app || w.title} to the front`);
  }
}
