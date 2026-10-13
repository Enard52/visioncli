// Sway (and other i3-IPC wlroots compositors): the tree, outputs and focus come from swaymsg; capture through grim.
// Sway's IPC has no pointer position at all, so pointer() is null: callers fall back to the front-most window
// (Screen.windowUnderPointer does the same when nothing is under the pointer). That's a Sway limitation.

import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { type Encoder, type Tools, defaultEncoder, firstPng, keepWindow, ownPids, realTools } from "./common";

interface SwayNode {
  id: number;
  type: string;
  name?: string | null;
  app_id?: string | null;
  pid?: number;
  focused?: boolean;
  visible?: boolean;
  rect: Rect;
  deco_rect?: Rect;
  border?: string;
  layout?: string;
  focus?: number[];
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
  window_properties?: { class?: string; instance?: string; title?: string };
}

export interface SwayWindow extends DesktopWindow { focused: boolean }

/** Display name for an app id: "org.gnome.gedit" → "Gedit", "firefox" → "Firefox", X11 class kept as is. */
export function prettyApp(appId: string): string {
  const last = appId.split(".").filter(Boolean).pop() ?? appId;
  return last ? last[0].toUpperCase() + last.slice(1) : "";
}

/** Visible views of `get_tree`, front-most first: per workspace floating above tiled, each by focus recency
 *  (every container's `focus` lists its children most-recent first). The focused output comes first. */
export function parseSwayTree(tree: SwayNode): SwayWindow[] {
  const out: SwayWindow[] = [];
  const byFocus = (n: SwayNode, kids: SwayNode[]) => {
    const order = n.focus ?? [];
    const rank = (k: SwayNode) => { const i = order.indexOf(k.id); return i < 0 ? order.length : i; };
    return [...kids].sort((a, b) => rank(a) - rank(b));
  };
  const visit = (n: SwayNode, parentLayout = "") => {
    const isView = (n.type === "con" || n.type === "floating_con") && (n.pid !== undefined || n.app_id || n.window_properties);
    if (isView && !(n.nodes?.length) && !(n.floating_nodes?.length)) {
      if (n.visible === false) return;
      const appId = n.app_id || n.window_properties?.class || "";
      out.push({
        id: String(n.id),
        app: n.app_id ? prettyApp(n.app_id) : appId,
        appId,
        title: n.name ?? "",
        pid: n.pid,
        bounds: withTitle(n, parentLayout),
        focused: !!n.focused,
      });
      return;
    }
    if (n.type === "workspace") {
      for (const k of byFocus(n, n.floating_nodes ?? [])) visit(k);
      for (const k of byFocus(n, n.nodes ?? [])) visit(k, n.layout);
      return;
    }
    for (const k of byFocus(n, [...(n.floating_nodes ?? []), ...(n.nodes ?? [])])) visit(k, n.layout);
  };
  visit(tree);
  return out.filter((w) => w.bounds.width > 0 && w.bounds.height > 0);
}

/** A view's rect plus its title bar when the bar sits right above it (split layouts and floating; tabs and stacks
 *  draw theirs elsewhere), so bounds include the title like Screen.swift's. */
function withTitle(n: SwayNode, parentLayout: string): Rect {
  const deco = n.deco_rect?.height ?? 0;
  const above = n.border === "normal" && deco > 0 && (n.type === "floating_con" || /^split/.test(parentLayout));
  return above ? { ...n.rect, y: n.rect.y - deco, height: n.rect.height + deco } : { ...n.rect };
}

/** `get_outputs`: active outputs' logical rects (the layout grim -g uses). */
export function parseSwayOutputs(outputs: { active?: boolean; rect: Rect }[]): Rect[] {
  return outputs.filter((o) => o.active !== false).map((o) => ({ ...o.rect }));
}

const strip = ({ focused: _, ...w }: SwayWindow): DesktopWindow => w;
export const grimGeometry = (r: Rect) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;

export class SwayDesktop implements Desktop {
  readonly backend = "sway" as const;
  constructor(private tools: Tools = realTools, private encode: Encoder = defaultEncoder(tools)) {}

  private async msg<T>(type: string): Promise<T> {
    return JSON.parse(await this.tools.text("swaymsg", ["-r", "-t", type]));
  }

  async problem(): Promise<string | null> {
    try { await this.tools.text("grim", ["-h"]); } catch (e: any) {
      if (e?.code === "ENOENT") return "VisionCLI needs grim to take screenshots on Sway. Install it, e.g. sudo apt install grim";
    }
    return null;
  }

  async displays(): Promise<Rect[]> {
    return parseSwayOutputs(await this.msg("get_outputs"));
  }

  /** Sway's IPC never reports the pointer (see the note at the top). */
  async pointer(): Promise<Point | null> {
    return null;
  }

  async windows(): Promise<DesktopWindow[]> {
    const own = ownPids();
    return parseSwayTree(await this.msg("get_tree")).filter((w) => keepWindow(w, own)).map(strip);
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    const all = parseSwayTree(await this.msg("get_tree"));
    const own = ownPids();
    // Our overlay may hold focus; like macOS the user's app is the one behind it.
    const f = all.find((w) => w.focused && !(w.pid !== undefined && own.has(w.pid))) ?? all.find((w) => keepWindow(w, own));
    return f ? strip(f) : null;
  }

  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.captureRect(w.bounds);
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    const png = await firstPng(this.tools, [["grim", ["-t", "png", "-g", grimGeometry(r), "-"]]],
      "Taking screenshots on Sway needs grim, e.g. sudo apt install grim");
    return this.encode(png);
  }

  async focus(w: DesktopWindow): Promise<void> {
    await this.tools.text("swaymsg", [`[con_id=${Number(w.id)}]`, "focus"]);
  }
}
