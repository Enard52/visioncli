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

let lastLook: ShotMap | null = null;
export const rememberLook = (m: ShotMap) => {
  lastLook = m;
};

export async function send(action: Record<string, unknown>): Promise<any> {
  if (process.platform !== "darwin") throw new Error("Computer control is only supported on macOS.");
  let info: { port: number; token: string };
  try {
    info = JSON.parse(readFileSync(join(SUPPORT, "control.json"), "utf8"));
  } catch {
    throw new Error("VisionCLI isn't running. Start it with `visioncli voice` (or the start_voice tool), then try again.");
  }
  const body = JSON.stringify(action);
  const res = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: info.port,
        method: "POST",
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-VisionCLI-Token": info.token },
        timeout: 5 * 60_000, // approvals wait for the user
      },
      (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => resolve(data));
      },
    );
    req.on("error", () => reject(new Error("Couldn't reach VisionCLI. Is it running? Start it with `visioncli voice`.")));
    req.on("timeout", () => req.destroy(new Error("VisionCLI didn't answer (the approval may have timed out).")));
    req.end(body);
  });
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

/** Screen bounds (top-left points) of display N (1 = main), for mapping whole-screen screenshots. */
export async function displayBounds(display = 1): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const { displays } = await send({ action: "displays" });
    return displays[display - 1] ?? null;
  } catch {
    return null;
  }
}
