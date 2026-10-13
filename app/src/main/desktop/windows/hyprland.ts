// Hyprland: hyprctl's JSON gives clients, the active window, monitors and the cursor; capture through grim.

import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { type Encoder, type Tools, defaultEncoder, firstPng, keepWindow, ownPids, realTools } from "./common";
import { grimGeometry, prettyApp } from "./sway";

export interface HyprClient {
  address: string;
  mapped?: boolean;
  hidden?: boolean;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name?: string };
  floating?: boolean;
  pinned?: boolean;
  fullscreen?: boolean | number;
  class?: string;
  initialClass?: string;
  title?: string;
  pid?: number;
  focusHistoryID?: number;
}

export interface HyprMonitor {
  x: number; y: number; width: number; height: number; scale?: number; transform?: number;
  activeWorkspace?: { id: number }; specialWorkspace?: { id: number };
}

export function hyprWindow(c: HyprClient): DesktopWindow {
  const appId = c.class || c.initialClass || "";
  return {
    id: c.address,
    app: prettyApp(appId),
    appId,
    title: c.title ?? "",
    pid: c.pid && c.pid > 0 ? c.pid : undefined,
    bounds: { x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1] },
  };
}

/** Clients on the monitors' visible workspaces, front-most first: fullscreen, then pinned/floating (drawn above
 *  tiled), each group by focus recency (focusHistoryID 0 = last focused). */
export function parseHyprClients(clients: HyprClient[], monitors: HyprMonitor[]): DesktopWindow[] {
  const visible = new Set(monitors.flatMap((m) => [m.activeWorkspace?.id, m.specialWorkspace?.id]).filter((id) => id));
  const layer = (c: HyprClient) => (c.fullscreen ? 0 : c.pinned || c.floating ? 1 : 2);
  return clients
    .filter((c) => c.mapped !== false && !c.hidden && (c.pinned || visible.has(c.workspace?.id)))
    .sort((a, b) => layer(a) - layer(b) || (a.focusHistoryID ?? 99) - (b.focusHistoryID ?? 99))
    .map(hyprWindow);
}

/** Monitors in layout (logical) coordinates: Hyprland reports device pixels plus the scale; 90°/270° swap sides. */
export function parseHyprMonitors(monitors: HyprMonitor[]): Rect[] {
  return monitors.map((m) => {
    const s = m.scale || 1, rotated = (m.transform ?? 0) % 2 === 1;
    const w = Math.round((rotated ? m.height : m.width) / s), h = Math.round((rotated ? m.width : m.height) / s);
    return { x: m.x, y: m.y, width: w, height: h };
  });
}

/** `hyprctl cursorpos`: "1234, 567". */
export function parseHyprCursor(out: string): Point | null {
  const m = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(out);
  return m ? { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) } : null;
}

export class HyprlandDesktop implements Desktop {
  readonly backend = "hyprland" as const;
  constructor(private tools: Tools = realTools, private encode: Encoder = defaultEncoder(tools)) {}

  private async j<T>(...args: string[]): Promise<T> {
    return JSON.parse(await this.tools.text("hyprctl", ["-j", ...args]));
  }

  async problem(): Promise<string | null> {
    try { await this.tools.text("grim", ["-h"]); } catch (e: any) {
      if (e?.code === "ENOENT") return "VisionCLI needs grim to take screenshots on Hyprland. Install it (grim package).";
    }
    return null;
  }

  async displays(): Promise<Rect[]> {
    return parseHyprMonitors(await this.j("monitors"));
  }

  async pointer(): Promise<Point | null> {
    try { return parseHyprCursor(await this.tools.text("hyprctl", ["cursorpos"])); } catch { return null; }
  }

  async windows(): Promise<DesktopWindow[]> {
    const own = ownPids();
    const [clients, monitors] = await Promise.all([this.j<HyprClient[]>("clients"), this.j<HyprMonitor[]>("monitors")]);
    return parseHyprClients(clients, monitors).filter((w) => keepWindow(w, own));
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    const own = ownPids();
    const c = await this.j<HyprClient | Record<string, never>>("activewindow").catch(() => ({}));
    if ("address" in c && c.address && !(c.pid && own.has(c.pid))) return hyprWindow(c as HyprClient);
    return (await this.windows())[0] ?? null;
  }

  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.captureRect(w.bounds);
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    const png = await firstPng(this.tools, [["grim", ["-t", "png", "-g", grimGeometry(r), "-"]]],
      "Taking screenshots on Hyprland needs grim");
    return this.encode(png);
  }

  async focus(w: DesktopWindow): Promise<void> {
    await this.tools.text("hyprctl", ["dispatch", "focuswindow", `address:${w.id}`]);
  }
}
