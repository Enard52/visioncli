import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { hostCommand } from "./flatpak.js";

const exec = promisify(execFile);
// Every desktop tool below is the host's: inside the Flatpak it goes through flatpak-spawn (flatpak.ts).
const run = ((cmd: string, args: string[], opts?: object) => {
  const h = hostCommand(cmd, args);
  return exec(h.file, h.args, opts as never);
}) as typeof exec;

// Linux backends for capture.ts, built on the usual desktop tools (no native code):
// - X11: wmctrl + xprop list windows front-most first, xdotool reads the pointer, maim/ImageMagick capture.
// - Wayland: compositors don't let clients list other apps' windows or read the pointer, so only whole-screen and
//   region capture work there (grim + slurp on wlroots, gnome-screenshot / spectacle elsewhere).

export interface Rect { x: number; y: number; width: number; height: number }
export interface LinuxWindow { id: number; app: string; title: string; bounds: Rect }

export const isWayland = () =>
  process.platform === "linux" && (!!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");

/** Window listing and pointer position need X11 (Xwayland apps aren't enough to know what's under the mouse). */
export const canListWindows = () => process.platform === "linux" && !isWayland() && !!process.env.DISPLAY;

const MISSING = (tools: string, pkg: string) => `${tools} not found. Install it, e.g. sudo apt install ${pkg}`;

async function exists(path: string) {
  return stat(path).then((s) => s.size > 0, () => false);
}

/** Runs the first command that works and produces `out`; the error lists what to install if none did. */
async function firstWorking(attempts: [string, string[]][], out: string, install: string): Promise<void> {
  for (const [cmd, args] of attempts) {
    try {
      await run(cmd, args, { timeout: 120_000 });
      if (await exists(out)) return;
    } catch {
      // try the next tool
    }
  }
  throw new Error(install);
}

/** `wmctrl -lpGx` rows: id desktop pid x y w h wm_class host title… */
export function parseWmctrl(out: string): (LinuxWindow & { desktop: number })[] {
  return out.split("\n").flatMap((line) => {
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+\d+\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s?(.*)$/i.exec(line.trim());
    if (!m) return [];
    const [, id, desktop, x, y, w, h, wmClass, title] = m;
    return [{
      id: parseInt(id, 16),
      desktop: Number(desktop),
      app: appName(wmClass),
      title: title.trim(),
      bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
    }];
  });
}

/** "google-chrome.Google-chrome" → "Google-chrome"; the class part is the app's display-ish name. */
export function appName(wmClass: string): string {
  const parts = wmClass.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : wmClass;
}

/** Window ids from `xprop -root _NET_CLIENT_LIST_STACKING` (bottom → top), returned front-most first. */
export function parseStacking(out: string): number[] {
  const ids = /#\s*(.*)$/.exec(out.trim())?.[1] ?? ""; // xprop ends with a newline
  return ids.split(",").map((s) => parseInt(s.trim(), 16)).filter((n) => !Number.isNaN(n)).reverse();
}

/** `xdotool getmouselocation --shell` → {x, y}. */
export function parseMouse(out: string): { x: number; y: number } | null {
  const x = /^X=(-?\d+)/m.exec(out)?.[1];
  const y = /^Y=(-?\d+)/m.exec(out)?.[1];
  return x !== undefined && y !== undefined ? { x: Number(x), y: Number(y) } : null;
}

/** On-screen windows of the current desktop, front-most first (X11). */
export async function listWindows(): Promise<LinuxWindow[]> {
  if (!canListWindows()) {
    throw new Error("Listing windows needs an X11 session; on Wayland, use target \"screen\" or select_region.");
  }
  const [list, stacking, desk] = await Promise.all([
    run("wmctrl", ["-lpGx"]).then((r) => r.stdout, () => { throw new Error(MISSING("wmctrl", "wmctrl x11-utils xdotool")); }),
    run("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"]).then((r) => r.stdout, () => ""),
    run("wmctrl", ["-d"]).then((r) => r.stdout, () => ""),
  ]);
  const current = Number(/^(\d+)\s+\*/m.exec(desk)?.[1] ?? -2);
  const order = parseStacking(stacking);
  const rank = (id: number) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return parseWmctrl(list)
    .filter((w) => w.desktop === -1 || current === -2 || w.desktop === current)
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map(({ desktop: _, ...w }) => w);
}

export async function pointer(): Promise<{ x: number; y: number } | null> {
  if (!canListWindows()) return null;
  try {
    return parseMouse((await run("xdotool", ["getmouselocation", "--shell"])).stdout);
  } catch {
    return null;
  }
}

/** WM_CLASS of the focused window ("google-chrome.Google-chrome"); "" when unknown (Wayland without a helper). */
export async function activeWindowClass(): Promise<string> {
  if (!canListWindows()) return "";
  try {
    const id = (await run("xdotool", ["getactivewindow"])).stdout.trim();
    const { stdout } = await run("xprop", ["-id", id, "WM_CLASS"]);
    const m = /=\s*"([^"]*)",\s*"([^"]*)"/.exec(stdout);
    return m ? `${m[1]}.${m[2]}` : "";
  } catch {
    return "";
  }
}

/** Captures one window (X11): maim, else ImageMagick. Falls back to cropping the screen at its bounds. */
export async function captureWindow(w: LinuxWindow, out: string): Promise<void> {
  const { x, y, width, height } = w.bounds;
  await firstWorking([
    ["maim", ["-u", "-i", String(w.id), out]],
    ["import", ["-silent", "-window", String(w.id), out]],
    ["import", ["-silent", "-window", "root", "-crop", `${width}x${height}+${x}+${y}`, "+repage", out]],
  ], out, MISSING("maim or ImageMagick", "maim"));
}

export async function captureScreen(out: string): Promise<void> {
  await firstWorking([
    ...(isWayland() ? [["grim", [out]] as [string, string[]]] : [["maim", ["-u", out]] as [string, string[]]]),
    ["gnome-screenshot", ["-f", out]],
    ["spectacle", ["-b", "-n", "-f", "-o", out]],
    ["import", ["-silent", "-window", "root", out]],
    ["scrot", ["-o", out]],
  ], out, `No screenshot tool worked. Install one of: ${isWayland() ? "grim (wlroots), gnome-screenshot, spectacle" : "maim, imagemagick, scrot"}.`);
}

/** Lets the user drag a rectangle. Resolves false when they cancel (Esc). */
export async function captureRegion(out: string): Promise<boolean> {
  if (isWayland()) {
    try {
      const geometry = (await run("slurp", [], { timeout: 120_000 })).stdout.trim();
      if (!geometry) return false;
      await run("grim", ["-g", geometry, out]);
      return exists(out);
    } catch (err: any) {
      if (err?.code !== "ENOENT") return false; // slurp exits non-zero on Esc
    }
  }
  const attempts: [string, string[]][] = isWayland()
    ? [["gnome-screenshot", ["-a", "-f", out]], ["spectacle", ["-b", "-n", "-r", "-o", out]]]
    : [["maim", ["-u", "-s", out]], ["gnome-screenshot", ["-a", "-f", out]], ["spectacle", ["-b", "-n", "-r", "-o", out]], ["import", [out]]];
  for (const [cmd, args] of attempts) {
    try {
      await run(cmd, args, { timeout: 120_000 });
      return exists(out);
    } catch (err: any) {
      if (err?.code !== "ENOENT") return false; // the tool ran: the user cancelled
    }
  }
  throw new Error(MISSING(isWayland() ? "slurp + grim" : "maim", isWayland() ? "slurp grim" : "maim"));
}

/** Writes the clipboard's PNG to `out`; false if the clipboard holds no image. */
export async function captureClipboard(out: string): Promise<boolean> {
  const [cmd, args] = isWayland()
    ? ["wl-paste", ["--no-newline", "--type", "image/png"]]
    : ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]];
  try {
    const { stdout } = await run(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return false;
    await writeFile(out, buf);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(MISSING(cmd, isWayland() ? "wl-clipboard" : "xclip"));
    return false; // no image on the clipboard
  }
}

/** Downscale + JPEG with ImageMagick when it's installed; false if it isn't (the caller sends the PNG as is). */
export async function toJpeg(src: string, out: string, maxDim: number): Promise<boolean> {
  const args = [src, "-resize", `${maxDim}x${maxDim}>`, "-quality", "85", out];
  for (const cmd of ["magick", "convert"]) {
    try {
      await run(cmd, args);
      if (await exists(out)) return true;
    } catch {
      // try the next name (ImageMagick 7 vs 6)
    }
  }
  return false;
}
