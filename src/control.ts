import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// Computer control goes through VisionCLI.app, which holds the Accessibility permission. It listens on 127.0.0.1
// with a per-launch token written to control.json (readable only by the user).

const SUPPORT = join(homedir(), "Library", "Application Support", "visioncli");

/** Where the last screenshot sits on screen (top-left global points), to turn image pixels into screen points. */
export interface ShotMap {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}

// Concurrent looks: the one started last wins, not the one that happened to finish last.
let lastLook: ShotMap | null = null;
let lookSeq = 0;
let lastLookSeq = 0;
/** Call when a screenshot starts; pass the number to rememberLook. */
export const beginLook = () => ++lookSeq;
export const rememberLook = (m: ShotMap, seq = ++lookSeq) => {
  if (seq < lastLookSeq) return;
  lastLookSeq = seq;
  lastLook = m;
};

// Answered instantly by the app (no approval), so a short timeout; anything else may wait for the user to approve.
const QUICK_ACTIONS: Record<string, number> = { status: 3000, displays: 3000, announce: 3000, windows: 3000, capture: 5000, elements: 8000 };
const APPROVAL_TIMEOUT = 5 * 60_000;

// control.json is re-read only when the app restarted (new port/token): connection refused or a bad token.
let info: { port: number; token: string } | null = null;
function readInfo() {
  try {
    info = JSON.parse(readFileSync(join(SUPPORT, "control.json"), "utf8"));
  } catch {
    info = null;
    throw new Error("VisionCLI isn't running. Start it with `visioncli voice` (or the start_voice tool), then try again.");
  }
  return info!;
}

class Stale extends Error {}

function post(conn: { port: number; token: string }, body: string, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: conn.port,
        method: "POST",
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-VisionCLI-Token": conn.token },
        timeout,
      },
      (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => (r.statusCode === 401 || r.statusCode === 403 ? reject(new Stale()) : resolve(data)));
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) =>
      reject(err instanceof Stale ? err : err?.code === "ECONNREFUSED" ? new Stale() :
        new Error(/answer/.test(err?.message ?? "") ? err.message : "Couldn't reach VisionCLI. Is it running? Start it with `visioncli voice`.")));
    req.on("timeout", () =>
      req.destroy(new Error(timeout >= APPROVAL_TIMEOUT ? "VisionCLI didn't answer (the approval may have timed out)." : "VisionCLI didn't answer in time.")));
    req.end(body);
  });
}

export async function send(action: Record<string, unknown>): Promise<any> {
  if (process.platform !== "darwin") throw new Error("Computer control is only supported on macOS.");
  const body = JSON.stringify(action);
  const timeout = QUICK_ACTIONS[String(action.action)] ?? APPROVAL_TIMEOUT;
  let res: string;
  try {
    res = await post(info ?? readInfo(), body, timeout);
  } catch (err) {
    if (!(err instanceof Stale)) throw err;
    try {
      res = await post(readInfo(), body, timeout); // the app restarted since we cached its port/token
    } catch (err2) {
      if (err2 instanceof Stale) throw new Error("Couldn't reach VisionCLI. Is it running? Start it with `visioncli voice`.");
      throw err2;
    }
  }
  const out = JSON.parse(res || "{}");
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Turn coordinates into screen points.
 * - `image` N: pixel coordinates in the N-th screenshot attached to the current voice question.
 * - otherwise: pixel coordinates in the last `look` screenshot (falls back to screen points if there is none).
 * - `screen: true`: already screen points (e.g. from ui_elements).
 */
export function toScreen(x: number, y: number, opts: { image?: number; screen?: boolean }): { x: number; y: number } {
  if (opts.screen) return { x, y };
  let m: ShotMap | null = lastLook;
  if (opts.image) {
    try {
      const shots: ShotMap[] = JSON.parse(readFileSync(join(SUPPORT, "shots.json"), "utf8")).shots;
      m = shots[opts.image - 1] ?? null;
    } catch {}
    if (!m) throw new Error(`There's no attached image ${opts.image}. Take a new screenshot with look.`);
  }
  if (!m) return { x, y };
  return {
    x: Math.round(m.x + (x * m.width) / m.imageWidth),
    y: Math.round(m.y + (y * m.height) / m.imageHeight),
  };
}

type Rect = { x: number; y: number; width: number; height: number };

/** An on-screen window as the app reports it (front-most first). */
export interface AppWindow { id: number; app: string; title: string; pid?: number; bounds: Rect }

/**
 * Displays (top-left points) and the mouse position, from the running app; null if it isn't running.
 * `windows: true` also asks for the on-screen windows (newer app versions; older ones just leave them out).
 */
export async function displaysAndPointer(opts: { windows?: boolean } = {}): Promise<{
  displays: Rect[];
  pointer?: { x: number; y: number };
  windows?: AppWindow[];
} | null> {
  try {
    return await send(opts.windows ? { action: "displays", windows: true } : { action: "displays" });
  } catch {
    return null;
  }
}

/** The display (1-based) containing p, or undefined. */
export function displayAt(displays: Rect[], p?: { x: number; y: number }): number | undefined {
  if (!p) return undefined;
  const i = displays.findIndex((b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height);
  return i >= 0 ? i + 1 : undefined;
}

/** The display (1-based) the mouse is on, or undefined if unknown. */
export async function pointerDisplay(): Promise<number | undefined> {
  const d = await displaysAndPointer();
  return d ? displayAt(d.displays, d.pointer) : undefined;
}

/** Screen bounds (top-left points) of display N (1 = main), for mapping whole-screen screenshots. */
export async function displayBounds(display = 1): Promise<Rect | null> {
  const d = await displaysAndPointer();
  return d?.displays[display - 1] ?? null;
}
