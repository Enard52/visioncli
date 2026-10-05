import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WindowInfo {
  id: number;
  app: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface Capture {
  data: string; // base64
  mimeType: string;
  width?: number;
  height?: number;
}

// Apps a user is likely running Claude Code in. When picking "the window the
// user is looking at" we skip these, since the terminal itself is always on top.
const TERMINAL_APPS = new Set(
  [
    "Terminal", "iTerm2", "Warp", "Ghostty", "kitty", "Alacritty", "WezTerm",
    "Hyper", "Tabby", "Rio", "Wave",
    ...(process.env.VISIONCLI_IGNORE_APPS ?? "").split(","),
  ]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Claude downsamples anything larger than this on its side anyway.
const MAX_DIM = Number(process.env.VISIONCLI_MAX_DIM ?? 1568);

export const PERMISSION_HELP =
  "macOS blocked the screenshot. Grant Screen Recording permission to the app running Claude Code " +
  "(e.g. iTerm2, Terminal, VS Code): System Settings → Privacy & Security → Screen & System Audio Recording, " +
  "enable it, then fully quit and reopen that app.";

const isMac = process.platform === "darwin";

function requireMac(feature: string) {
  if (!isMac) throw new Error(`${feature} is only supported on macOS right now.`);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "visioncli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string) {
  return stat(path).then((s) => s.size > 0, () => false);
}

async function screencapture(args: string[], out: string) {
  try {
    await run("screencapture", [...args, out]);
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || err);
    if (/could not create image/i.test(msg)) throw new Error(PERMISSION_HELP);
    throw new Error(`screencapture failed: ${msg.trim()}`);
  }
}

// Downscale to MAX_DIM and re-encode as JPEG to keep the payload small.
async function encode(dir: string, src: string): Promise<Capture> {
  if (!isMac) {
    return { data: (await readFile(src)).toString("base64"), mimeType: "image/png" };
  }
  const out = join(dir, "out.jpg");
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", src]);
  const w = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1] ?? 0);
  const h = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1] ?? 0);
  const args = ["-s", "format", "jpeg", "-s", "formatOptions", "85"];
  if (Math.max(w, h) > MAX_DIM) args.push("-Z", String(MAX_DIM));
  await run("sips", [...args, src, "--out", out]);
  const scale = Math.max(w, h) > MAX_DIM ? MAX_DIM / Math.max(w, h) : 1;
  return {
    data: (await readFile(out)).toString("base64"),
    mimeType: "image/jpeg",
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  };
}

const LIST_WINDOWS_JXA = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function run() {
  const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  const all = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  return JSON.stringify(all.filter(w => w.kCGWindowLayer === 0).map(w => ({
    id: w.kCGWindowNumber,
    app: w.kCGWindowOwnerName || '',
    title: w.kCGWindowName || '',
    bounds: { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height },
  })));
}`;

/** On-screen app windows, front-most first. */
export async function listWindows(): Promise<WindowInfo[]> {
  requireMac("Listing windows");
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS_JXA]);
  const windows: WindowInfo[] = JSON.parse(stdout);
  // Drop tiny utility windows (menu-bar helpers, tooltips, etc).
  return windows.filter((w) => w.bounds.width >= 200 && w.bounds.height >= 150);
}

export function isTerminal(w: WindowInfo) {
  return TERMINAL_APPS.has(w.app.toLowerCase());
}

const POINTER_JXA = `
ObjC.import('AppKit');
function run() {
  const p = $.NSEvent.mouseLocation;
  const h = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  return JSON.stringify({ x: p.x, y: h - p.y });
}`;

/** Mouse position in global top-left-origin points (same space as window bounds). */
export async function pointerLocation(): Promise<{ x: number; y: number }> {
  requireMac("Pointer location");
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", POINTER_JXA]);
  return JSON.parse(stdout);
}

function contains(w: WindowInfo, p: { x: number; y: number }) {
  const b = w.bounds;
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

/** Pointer position inside a captured window image, in image pixels; null if it's outside the window. */
export function pointerInImage(w: WindowInfo, p: { x: number; y: number }, img: Capture) {
  if (!contains(w, p) || !img.width || !img.height) return null;
  return {
    x: Math.round(((p.x - w.bounds.x) / w.bounds.width) * img.width),
    y: Math.round(((p.y - w.bounds.y) / w.bounds.height) * img.height),
  };
}

/**
 * Pick the window the user most likely wants: by id, by app name, the window under the pointer
 * (when underCursor), or else the front-most non-terminal window.
 */
export async function findWindow(opts: { app?: string; windowId?: number; underCursor?: boolean }): Promise<WindowInfo> {
  const windows = await listWindows();
  if (opts.windowId !== undefined) {
    const w = windows.find((w) => w.id === opts.windowId);
    if (!w) throw new Error(`No on-screen window with id ${opts.windowId}. Call list_windows to see current ids.`);
    return w;
  }
  if (opts.app) {
    const q = opts.app.toLowerCase();
    const w = windows.find((w) => w.app.toLowerCase().includes(q) || w.title.toLowerCase().includes(q));
    if (!w) {
      const apps = [...new Set(windows.map((w) => w.app))].join(", ");
      throw new Error(`No visible window matching "${opts.app}". Visible apps: ${apps || "none"}.`);
    }
    return w;
  }
  if (opts.underCursor) {
    const p = await pointerLocation();
    const hit = windows.find((w) => contains(w, p));
    if (hit && !isTerminal(hit)) return hit;
  }
  const w = windows.find((w) => !isTerminal(w));
  if (!w) throw new Error("No visible non-terminal window found. Try target \"screen\".");
  return w;
}

export async function captureWindow(w: WindowInfo): Promise<Capture> {
  requireMac("Window capture");
  return withTempDir(async (dir) => {
    const src = join(dir, "win.png");
    // -o: no drop shadow, -x: no shutter sound, -l: capture this window id even if partly covered
    await screencapture(["-x", "-o", "-t", "png", "-l", String(w.id)], src);
    return encode(dir, src);
  });
}

export async function captureScreen(display?: number): Promise<Capture> {
  return withTempDir(async (dir) => {
    const src = join(dir, "screen.png");
    if (isMac) {
      await screencapture(["-x", "-t", "png", ...(display ? ["-D", String(display)] : [])], src);
    } else if (process.platform === "win32") {
      await captureScreenWindows(src);
    } else {
      await captureScreenLinux(src);
    }
    return encode(dir, src);
  });
}

/** Let the user drag a rectangle with the native crosshair. Returns null if they press Esc. */
export async function captureRegion(): Promise<Capture | null> {
  requireMac("Region selection");
  return withTempDir(async (dir) => {
    const src = join(dir, "region.png");
    await screencapture(["-i", "-x", "-o", "-t", "png"], src);
    if (!(await exists(src))) return null;
    return encode(dir, src);
  });
}

/** Image currently on the clipboard (e.g. after Cmd+Ctrl+Shift+4). Returns null if there isn't one. */
export async function captureClipboard(): Promise<Capture | null> {
  requireMac("Clipboard images");
  return withTempDir(async (dir) => {
    const src = join(dir, "clip.png");
    const script = [
      `set f to open for access POSIX file "${src}" with write permission`,
      "try",
      "  write (the clipboard as «class PNGf») to f",
      "end try",
      "close access f",
    ];
    await run("osascript", script.flatMap((line) => ["-e", line]));
    if (!(await exists(src))) return null;
    return encode(dir, src);
  });
}

async function captureScreenLinux(out: string) {
  const attempts: [string, string[]][] = [
    ["grim", [out]],
    ["gnome-screenshot", ["-f", out]],
    ["spectacle", ["-b", "-n", "-o", out]],
    ["import", ["-window", "root", out]],
    ["scrot", ["-o", out]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      await run(cmd, args);
      if (await exists(out)) return;
    } catch {
      // try the next tool
    }
  }
  throw new Error("No screenshot tool found. Install one of: grim, gnome-screenshot, spectacle, imagemagick, scrot.");
}

async function captureScreenWindows(out: string) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  await run("powershell", ["-NoProfile", "-Command", ps]);
}

/** Screenshot of a booted iOS Simulator (via simctl) or a connected Android device/emulator (via adb), without window chrome. */
export async function captureDevice(platform: "ios" | "android"): Promise<Capture> {
  return withTempDir(async (dir) => {
    const src = join(dir, "device.png");
    try {
      if (platform === "ios") {
        await run("xcrun", ["simctl", "io", "booted", "screenshot", "--type=png", src]);
      } else {
        const { stdout } = await run("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
        await writeFile(src, stdout as unknown as Buffer);
      }
    } catch (err: any) {
      const msg = String(err?.stderr || err?.message || err).trim();
      throw new Error(
        platform === "ios"
          ? /unable to find utility "simctl"/.test(msg)
            ? "The iOS Simulator tools need full Xcode (only the Command Line Tools are installed). Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app"
            : `No booted iOS Simulator (${msg}). Boot one in Xcode or with: xcrun simctl boot <device>`
          : `No Android device/emulator reachable over adb (${msg}).`,
      );
    }
    if (!(await exists(src))) throw new Error("Device screenshot came back empty.");
    return encode(dir, src);
  });
}
