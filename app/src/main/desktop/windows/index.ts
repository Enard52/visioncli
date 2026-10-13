// Windows, pointer, displays and capture (the Linux side of Screen.swift). One Desktop per session type:
//   x11       any desktop on Xorg (EWMH tools)              full parity
//   gnome     GNOME on Wayland (our Shell extension)         full parity once the extension is on (one re-login)
//   kde       Plasma on Wayland (a KWin script per query)    full parity
//   sway      Sway / i3-IPC (swaymsg + grim)                 no pointer: Sway's IPC has none
//   hyprland  Hyprland (hyprctl + grim)                      full parity
//   wayland   anything else                                  no windows, no pointer: whole screen / regions only
//   win32     Windows 10/11 (the vcli-win.exe helper)        full parity
// VISIONCLI_DESKTOP=<backend> overrides the detection.

import type { Desktop, Rect } from "../../contracts";
import { log } from "../../log";
import { type Encoder, type Tools, defaultEncoder, realTools } from "./common";
import { GnomeDesktop } from "./gnome";
import { HyprlandDesktop } from "./hyprland";
import { KdeDesktop } from "./kde";
import { SwayDesktop } from "./sway";
import { type DisplaySource, WaylandDesktop, electronDisplays } from "./wayland";
import { X11Desktop } from "./x11";
import { Win32Desktop, winHelper } from "./win32";

export { installGnomeExtension, GnomeDesktop } from "./gnome";
export { X11Desktop } from "./x11";
export { SwayDesktop } from "./sway";
export { HyprlandDesktop } from "./hyprland";
export { KdeDesktop } from "./kde";
export { WaylandDesktop } from "./wayland";
export { Win32Desktop } from "./win32";

export type Backend = Desktop["backend"];

export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  const forced = env.VISIONCLI_DESKTOP as Backend | undefined;
  if (forced && ["x11", "gnome", "kde", "sway", "hyprland", "wayland"].includes(forced)) return forced;
  const wayland = !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland";
  if (!wayland) return "x11";
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.XDG_SESSION_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`.toLowerCase();
  if (env.HYPRLAND_INSTANCE_SIGNATURE || desktop.includes("hyprland")) return "hyprland";
  if (env.SWAYSOCK || /(^|:)sway/.test(desktop)) return "sway";
  if (/gnome|ubuntu|unity|pop:/.test(desktop)) return "gnome";
  if (env.KDE_FULL_SESSION || /kde|plasma/.test(desktop)) return "kde";
  return "wayland";
}

export interface DesktopOptions {
  env?: NodeJS.ProcessEnv;
  /** PNG (+crop) → JPEG; defaults to ImageMagick, else Electron's nativeImage. */
  encode?: Encoder;
  /** Displays when the compositor can't say (generic Wayland); defaults to Electron's screen. */
  screen?: () => Rect[] | Promise<Rect[]>;
  tools?: Tools;
}

export async function createDesktop(opts: DesktopOptions = {}): Promise<Desktop> {
  if (process.platform === "win32") {
    log("desktop: backend win32");
    return new Win32Desktop(winHelper());
  }
  const tools = opts.tools ?? realTools;
  const encode = opts.encode ?? defaultEncoder(tools);
  const screen: DisplaySource = opts.screen ?? electronDisplays;
  const backend = detectBackend(opts.env);
  const desktop: Desktop =
    backend === "x11" ? new X11Desktop(tools, encode)
    : backend === "gnome" ? new GnomeDesktop(screen, tools, encode)
    : backend === "kde" ? new KdeDesktop(tools, encode)
    : backend === "sway" ? new SwayDesktop(tools, encode)
    : backend === "hyprland" ? new HyprlandDesktop(tools, encode)
    : new WaylandDesktop(screen, tools, encode);
  log(`desktop: backend ${backend}`);
  return desktop;
}
