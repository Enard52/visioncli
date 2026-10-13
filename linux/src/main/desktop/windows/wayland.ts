// Any other Wayland compositor (Cosmic, Weston, river, labwc without wlr tools…): the protocol lets clients see
// neither other apps' windows nor the pointer, so windows() is empty and pointer() is null. Displays come from
// Electron's screen (injected), capture from the Screenshot portal (cropped for regions), else grim when present.
// This reduction is a Wayland rule, not a VisionCLI choice: target "screen" and select_region keep working.

import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { type Encoder, type Tools, cropFor, defaultEncoder, firstPng, pngSize, realTools, union } from "./common";
import { portalScreenshot } from "./portal";
import { grimGeometry } from "./sway";

export type DisplaySource = () => Rect[] | Promise<Rect[]>;
export type PngSource = () => Promise<Buffer>;

/** Electron's displays in layout coordinates (DIPs, which is what Wayland compositors lay out in). */
export function electronDisplays(): Rect[] {
  try {
    const { screen } = require("electron") as typeof import("electron");
    return screen.getAllDisplays().map((d) => ({ ...d.bounds }));
  } catch {
    return [];
  }
}

export class WaylandDesktop implements Desktop {
  readonly backend = "wayland" as const;
  constructor(
    private screen: DisplaySource = electronDisplays,
    private tools: Tools = realTools,
    private encode: Encoder = defaultEncoder(tools),
    private shot: PngSource = portalScreenshot,
  ) {}

  async problem(): Promise<string | null> {
    return "This Wayland desktop doesn't let apps list windows or read the mouse position, so VisionCLI captures the whole screen or a region you select instead of the window under the mouse.";
  }

  async displays(): Promise<Rect[]> {
    return this.screen();
  }

  async pointer(): Promise<Point | null> {
    return null;
  }

  async windows(): Promise<DesktopWindow[]> {
    return [];
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    return null;
  }

  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.captureRect(w.bounds);
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    let png: Buffer;
    try {
      png = await this.shot();
    } catch (portalErr: any) {
      // wlroots compositors without xdg-desktop-portal-wlr still speak screencopy to grim
      try {
        return this.encode(await firstPng(this.tools, [["grim", ["-t", "png", "-g", grimGeometry(r), "-"]]], "grim failed"));
      } catch {
        throw portalErr;
      }
    }
    const layout = union(await this.displays());
    return this.encode(png, layout.width ? cropFor(r, layout, pngSize(png)) : undefined);
  }

  async focus(_w: DesktopWindow): Promise<void> {
    throw new Error("This Wayland desktop doesn't let apps switch windows.");
  }
}
