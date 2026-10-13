// Shared plumbing for the desktop backends: running tools, the window filter from Screen.windows(), and the
// PNG → (crop) → downscale → JPEG q85 pipeline from Screen.encode.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopWindow, Jpeg, Point, Rect } from "../../contracts";

export const MAX_IMAGE_DIM = 1568; // Claude downsamples anything bigger anyway (maxImageDim)
export const JPEG_QUALITY = 85;

/** Runs a tool; resolves stdout. `input` is piped to stdin. Rejects on a non-zero exit or a missing tool. */
export function runBytes(cmd: string, args: string[], input?: Buffer, timeout = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 300)}`));
    });
    child.stdin.on("error", () => {}); // the tool may exit before reading everything
    child.stdin.end(input);
  });
}

export function run(cmd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout)));
  });
}

/** Tool runners, injectable so backends can be tested with canned output. */
export interface Tools {
  text(cmd: string, args: string[]): Promise<string>;
  bytes(cmd: string, args: string[], input?: Buffer): Promise<Buffer>;
}
export const realTools: Tools = { text: (c, a) => run(c, a), bytes: (c, a, i) => runBytes(c, a, i) };

/** The first attempt that produces a PNG; the error says what to install when none did. */
export async function firstPng(tools: Tools, attempts: [string, string[]][], install: string): Promise<Buffer> {
  const errors: string[] = [];
  for (const [cmd, args] of attempts) {
    try {
      const png = await tools.bytes(cmd, args);
      if (isPng(png)) return png;
      errors.push(`${cmd}: no image`);
    } catch (e: any) {
      errors.push(e?.code === "ENOENT" ? `${cmd}: not installed` : `${cmd}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`${install} (${errors.join("; ")})`);
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Pids whose windows are VisionCLI's own (the Electron main process owns every BrowserWindow). */
export function ownPids(): Set<number> {
  const pids = new Set([process.pid]);
  if (process.ppid) pids.add(process.ppid); // dev runs under `electron .`: a wrapper process may own the windows
  return pids;
}

/** Same filter as Screen.windows(): not ours, at least 200×150 (skips panels, tooltips, docks). */
export function keepWindow(w: DesktopWindow, own: Set<number>): boolean {
  if (w.pid !== undefined && own.has(w.pid)) return false;
  if (/^visioncli/i.test(w.appId)) return false;
  return w.bounds.width >= 200 && w.bounds.height >= 150;
}

export const contains = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;

/** Bounding box of all displays (the layout a whole-desktop screenshot covers). */
export function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width)), bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** The part of `r` inside `bounds` (at least 1×1 so tools get a valid geometry). */
export function intersect(r: Rect, bounds: Rect): Rect {
  const x = Math.max(r.x, bounds.x), y = Math.max(r.y, bounds.y);
  const right = Math.min(r.x + r.width, bounds.x + bounds.width), bottom = Math.min(r.y + r.height, bounds.y + bounds.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** `r` (layout coordinates) as a crop of a whole-desktop image of `layout`, scaled when the image is in device
 *  pixels (HiDPI on Wayland), clamped to the image. */
export function cropFor(r: Rect, layout: Rect, image: { width: number; height: number }): Rect {
  const sx = layout.width ? image.width / layout.width : 1, sy = layout.height ? image.height / layout.height : 1;
  const x = Math.max(0, Math.round((r.x - layout.x) * sx)), y = Math.max(0, Math.round((r.y - layout.y) * sy));
  const right = Math.min(image.width, Math.round((r.x - layout.x + r.width) * sx));
  const bottom = Math.min(image.height, Math.round((r.y - layout.y + r.height) * sy));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

// ── Images ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** PNG (optionally cropped, in image pixels) → JPEG, longest side ≤ 1568, q85. */
export type Encoder = (png: Buffer, crop?: Rect) => Promise<Jpeg>;

export const isPng = (b: Buffer) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47;

export function pngSize(png: Buffer): { width: number; height: number } {
  if (!isPng(png)) throw new Error("Not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Width/height from a JPEG's SOFn segment. */
export function jpegSize(jpg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpg.length) {
    if (jpg[i] !== 0xff) return null;
    const marker = jpg[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpg.readUInt16BE(i + 5), width: jpg.readUInt16BE(i + 7) };
    }
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  return null;
}

/** The size an image of w×h is sent at (Screen.encode). */
export function fitSize(w: number, h: number, max = MAX_IMAGE_DIM): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

let magick: string | null | undefined;
async function findMagick(tools: Tools): Promise<string | null> {
  if (magick !== undefined) return magick;
  for (const cmd of ["magick", "convert"]) {
    try { await tools.text(cmd, ["-version"]); return (magick = cmd); } catch {}
  }
  return (magick = null);
}

/** ImageMagick when installed (fast, no Electron needed), else Electron's nativeImage. */
export function defaultEncoder(tools: Tools = realTools): Encoder {
  return async (png, crop) => {
    const cmd = await findMagick(tools);
    return cmd ? magickEncode(tools, cmd, png, crop) : electronEncode(png, crop);
  };
}

export async function magickEncode(tools: Tools, cmd: string, png: Buffer, crop?: Rect): Promise<Jpeg> {
  const full = pngSize(png);
  const src = crop ?? { x: 0, y: 0, ...full };
  const size = fitSize(src.width, src.height);
  const args = ["png:-", "-alpha", "off"];
  if (crop) args.push("-crop", `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, "+repage");
  if (size.width !== src.width || size.height !== src.height) args.push("-resize", `${size.width}x${size.height}!`);
  args.push("-strip", "-quality", String(JPEG_QUALITY), "jpg:-");
  const data = await tools.bytes(cmd, args, png);
  return { data, ...(jpegSize(data) ?? size) };
}

export function electronEncode(png: Buffer, crop?: Rect): Jpeg {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { nativeImage } = require("electron") as typeof import("electron");
  let img = nativeImage.createFromBuffer(png);
  if (crop) img = img.crop(crop);
  const src = img.getSize();
  const size = fitSize(src.width, src.height);
  if (size.width !== src.width || size.height !== src.height) img = img.resize({ ...size, quality: "best" });
  return { data: img.toJPEG(JPEG_QUALITY), ...size };
}

// ── Resources ────────────────────────────────────────────────────────────────────────────────────────────────────

/** app/resources at runtime: build/resources next to main.js, or the source tree in tests/dev. */
export function resourcesDir(): string {
  const candidates = [
    process.env.VISIONCLI_RESOURCES,
    join(__dirname, "resources"),
    join(__dirname, "../resources"),
    join(__dirname, "../../resources"),
    join(__dirname, "../../../resources"),
    join(__dirname, "../../../../resources"),
    (process as any).resourcesPath && join((process as any).resourcesPath, "app.asar", "build", "resources"),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "kwin"))) ?? candidates[0];
}

export const readResource = (...parts: string[]) => readFileSync(join(resourcesDir(), ...parts), "utf8");
