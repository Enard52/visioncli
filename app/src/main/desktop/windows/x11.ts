// X11 (and GNOME/KDE/Xfce/… on Xorg): EWMH through wmctrl + xprop, the pointer through xdotool, displays through
// xrandr, capture through maim or ImageMagick. Same tools as ../../../../../src/linux.ts (the MCP server's backend).

import { appName, parseMouse, parseStacking } from "../../../../../src/linux";
import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { type Encoder, type Tools, defaultEncoder, firstPng, intersect, keepWindow, ownPids, realTools, union } from "./common";

interface X11Row extends DesktopWindow { desktop: number }

/** `wmctrl -lpGx` rows: id desktop pid x y w h wm_class host title… (keeps the pid and the raw WM_CLASS). */
export function parseWmctrlRows(out: string): X11Row[] {
  return out.split("\n").flatMap((line) => {
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s?(.*)$/i.exec(line.trim());
    if (!m) return [];
    const [, id, desktop, pid, x, y, w, h, wmClass, title] = m;
    return [{
      id: String(parseInt(id, 16)),
      desktop: Number(desktop),
      pid: Number(pid) || undefined,
      app: wmClass === "N/A" ? "" : appName(wmClass),
      appId: wmClass === "N/A" ? "" : wmClass,
      title: title.trim(),
      bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
    }];
  });
}

/** `xrandr --listmonitors`: " 0: +*DP-1 2560/597x1440/336+0+0  DP-1". */
export function parseXrandrMonitors(out: string): Rect[] {
  return [...out.matchAll(/^\s*\d+:\s+\S+\s+(\d+)\/\d+x(\d+)\/\d+\+?(-?\d+)\+?(-?\d+)/gm)]
    .map((m) => ({ x: Number(m[3]), y: Number(m[4]), width: Number(m[1]), height: Number(m[2]) }));
}

/** `xdpyinfo` / `xwininfo -root`: the root window size, when xrandr isn't there. */
export function parseRootSize(out: string): Rect | null {
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(out) ?? /Width:\s+(\d+)[\s\S]*?Height:\s+(\d+)/.exec(out);
  return m ? { x: 0, y: 0, width: Number(m[1]), height: Number(m[2]) } : null;
}

/** `xprop -root _NET_ACTIVE_WINDOW` → decimal id ("0x0" / missing → null). */
export function parseActiveWindow(out: string): string | null {
  const id = parseInt(/#\s*(0x[0-9a-f]+)/i.exec(out)?.[1] ?? "0", 16);
  return id ? String(id) : null;
}

/** From `xprop -id W _NET_WM_WINDOW_TYPE _NET_WM_STATE`: false for minimized, docks, desktops, menus, … */
export function isRegularWindow(xprop: string): boolean {
  if (/_NET_WM_STATE_HIDDEN/.test(xprop)) return false;
  const type = /_NET_WM_WINDOW_TYPE\(ATOM\)\s*=\s*(.*)/.exec(xprop)?.[1] ?? "";
  return !type || /_NET_WM_WINDOW_TYPE_(NORMAL|DIALOG|UTILITY)/.test(type);
}

/** `xwininfo -root -tree`: every window's absolute client rect, by decimal id. (wmctrl -G adds the client's offset
 *  inside its frame a second time under reparenting WMs, so its positions can't be used.) */
export function parseWinTree(out: string): Map<string, Rect> {
  const map = new Map<string, Rect>();
  for (const m of out.matchAll(/^\s*(0x[0-9a-f]+)\s.*?\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+?(-?\d+)\+?(-?\d+)\s*$/gim)) {
    map.set(String(parseInt(m[1], 16)), { x: Number(m[4]), y: Number(m[5]), width: Number(m[2]), height: Number(m[3]) });
  }
  return map;
}

/** Window bounds as the user sees them (Screen.swift's kCGWindowBounds): the WM's frame (_NET_FRAME_EXTENTS: title bar
 *  and borders) added, GTK client-side shadows (_GTK_FRAME_EXTENTS) removed. Extents are left, right, top, bottom. */
export function frameBounds(client: Rect, xprop: string): Rect {
  const ext = (name: string) => {
    const m = new RegExp(`${name}\\(CARDINAL\\)\\s*=\\s*(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)`).exec(xprop);
    return m ? m.slice(1, 5).map(Number) : [0, 0, 0, 0];
  };
  const [fl, fr, ft, fb] = ext("_NET_FRAME_EXTENTS");
  const [gl, gr, gt, gb] = ext("_GTK_FRAME_EXTENTS");
  return {
    x: client.x - fl + gl, y: client.y - ft + gt,
    width: client.width + fl + fr - gl - gr, height: client.height + ft + fb - gt - gb,
  };
}

const hex = (id: string) => "0x" + Number(id).toString(16).padStart(8, "0");

export class X11Desktop implements Desktop {
  readonly backend = "x11" as const;
  constructor(private tools: Tools = realTools, private encode: Encoder = defaultEncoder(tools)) {}

  async problem(): Promise<string | null> {
    const missing: string[] = [];
    for (const [cmd, args] of [["wmctrl", ["-m"]], ["xdotool", ["version"]], ["xprop", ["-version"]]] as const) {
      try { await this.tools.text(cmd, [...args]); } catch (e: any) { if (e?.code === "ENOENT") missing.push(cmd); }
    }
    let capture = false;
    for (const cmd of ["maim", "import"]) {
      try { await this.tools.text(cmd, ["--version"]); capture = true; break; } catch (e: any) { if (e?.code !== "ENOENT") { capture = true; break; } }
    }
    if (!capture) missing.push("maim (or imagemagick)");
    return missing.length
      ? `VisionCLI needs ${missing.join(", ")} to see windows on X11. Install them, e.g. sudo apt install wmctrl xdotool x11-utils maim`
      : null;
  }

  async displays(): Promise<Rect[]> {
    try {
      const r = parseXrandrMonitors(await this.tools.text("xrandr", ["--listmonitors"]));
      if (r.length) return r;
    } catch {}
    for (const [cmd, args] of [["xdpyinfo", []], ["xwininfo", ["-root"]]] as [string, string[]][]) {
      try { const r = parseRootSize(await this.tools.text(cmd, args)); if (r) return [r]; } catch {}
    }
    return [];
  }

  async pointer(): Promise<Point | null> {
    try { return parseMouse(await this.tools.text("xdotool", ["getmouselocation", "--shell"])); } catch { return null; }
  }

  /** Every managed, mapped, normal window on the current desktop, front-most first (ours included). */
  private async all(): Promise<DesktopWindow[]> {
    const [list, stacking, desk, tree] = await Promise.all([
      this.tools.text("wmctrl", ["-lpGx"]),
      this.tools.text("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"]).catch(() => ""),
      this.tools.text("wmctrl", ["-d"]).catch(() => ""),
      this.tools.text("xwininfo", ["-root", "-tree"]).then(parseWinTree, () => new Map<string, Rect>()),
    ]);
    const current = Number(/^(\d+)\s+\*/m.exec(desk)?.[1] ?? -2);
    // trim(): parseStacking only matches when the output has no trailing newline
    const order = parseStacking(stacking.trim()).map(String);
    const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    const rows = parseWmctrlRows(list).filter((w) => w.desktop === -1 || current === -2 || w.desktop === current);
    // One xprop per window, in parallel: drops minimized windows and panels/desktops (Screen.windows: layer 0, on
    // screen) and gives the frame extents for the bounds.
    const props = await Promise.all(rows.map((w) => this.tools.text("xprop",
      ["-id", w.id, "_NET_WM_WINDOW_TYPE", "_NET_WM_STATE", "_NET_FRAME_EXTENTS", "_GTK_FRAME_EXTENTS"]).catch(() => "")));
    return rows
      .map((w, i) => ({ w, p: props[i] }))
      .filter(({ p }) => isRegularWindow(p))
      .map(({ w: { desktop: _, ...w }, p }) => ({ ...w, bounds: frameBounds(tree.get(w.id) ?? w.bounds, p) }))
      .sort((a, b) => rank(a.id) - rank(b.id));
  }

  async windows(): Promise<DesktopWindow[]> {
    const own = ownPids();
    return (await this.all()).filter((w) => keepWindow(w, own));
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    const [id, all] = await Promise.all([
      this.tools.text("xprop", ["-root", "_NET_ACTIVE_WINDOW"]).then(parseActiveWindow, () => null),
      this.all(),
    ]);
    const own = ownPids();
    const active = all.find((w) => w.id === id);
    // Our overlay may hold focus; like macOS (non-activating panels) the user's app is the one behind it.
    if (active && !(active.pid !== undefined && own.has(active.pid))) return active;
    return all.find((w) => keepWindow(w, own)) ?? null;
  }

  /** The window as it looks on screen, title bar included (a rect grab: on X11 a covered window can't be read
   *  anyway, and this keeps the image exactly at w.bounds for pointer/click mapping). */
  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.captureRect(w.bounds);
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    const screen = union(await this.displays());
    const c = screen.width ? intersect(r, screen) : r;
    const g = `${Math.round(c.width)}x${Math.round(c.height)}+${Math.round(c.x)}+${Math.round(c.y)}`;
    const png = await firstPng(this.tools, [
      ["maim", ["-u", "-f", "png", "-g", g]],
      ["import", ["-silent", "-window", "root", "-crop", g, "+repage", "png:-"]],
    ], "Capturing the screen needs maim or ImageMagick, e.g. sudo apt install maim");
    return this.encode(png);
  }

  async focus(w: DesktopWindow): Promise<void> {
    try {
      await this.tools.text("wmctrl", ["-ia", hex(w.id)]);
    } catch {
      await this.tools.text("xdotool", ["windowactivate", "--sync", w.id]);
    }
  }
}
