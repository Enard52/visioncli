import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type WindowInfo,
  captureClipboard,
  captureDevice,
  captureRegion,
  captureScreen,
  captureWindow,
  findWindow,
  isTerminal,
  listWindows,
  pointerInImage,
  pointerLocation,
  snapshot,
} from "../capture.js";
import * as computer from "../control.js";
import { canListWindows } from "../linux.js";
import { describe, errorResult, imageResult } from "./common.js";

/** Screenshots: look, list_windows, select_region, clipboard_image, device_screenshot. */
export function register(server: McpServer) {
  server.registerTool(
    "look",
    {
      title: "Look at the screen",
      description:
        "Take a screenshot of what the user is looking at and return it as an image. " +
        'By default captures the window under the mouse pointer (or, if that is the terminal, the front-most other window). ' +
        'Use target "screen" for the whole display the mouse is on. Optionally pick a window by app name/title or window id, or a display number.',
      inputSchema: {
        target: z.enum(["window", "screen"]).default("window").describe("Capture a single window or an entire display"),
        app: z.string().optional().describe('App name or window-title substring, e.g. "Xcode", "Simulator", "Chrome"'),
        window_id: z.number().int().optional().describe("Exact window id from list_windows"),
        display: z.number().int().min(1).optional().describe("Display number for target screen (1 = main; default: the one the mouse is on)"),
        under_cursor: z
          .boolean()
          .default(true)
          .describe("Capture the window under the mouse pointer (default; falls back if it's the terminal). false = front-most window"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, app, window_id, display, under_cursor }) => {
      try {
        const seq = computer.beginLook();
        const isMac = process.platform === "darwin";
        // One snapshot (windows + pointer + displays, from the app when it's running) serves the whole call.
        // Linux: X11 lists windows; on Wayland that's not allowed, so "window" falls back to the whole screen.
        const isLinux = process.platform === "linux";
        const snap = target !== "window" ? undefined : isMac || canListWindows() || isLinux ? await snapshot().catch((e) => { if (isMac) throw e; return undefined; }) : undefined;
        let w: WindowInfo | undefined;
        if (snap) {
          try {
            w = await findWindow({ app, windowId: window_id, underCursor: under_cursor }, snap);
          } catch (err) {
            if (app || window_id !== undefined) throw err;
            // Only terminals on screen: the whole display the mouse is on is the next best thing.
          }
        }
        if (!w) {
          const d = snap ?? (isMac || isLinux ? await computer.displaysAndPointer() : null);
          const which = display ?? (d?.displays ? computer.displayAt(d.displays, d.pointer) : undefined) ?? 1;
          const b = d?.displays?.[which - 1] ?? null;
          const img = await captureScreen(which, b);
          if (b && img.width) computer.rememberLook({ ...b, imageWidth: img.width, imageHeight: img.height ?? img.width }, seq);
          return imageResult(img, `Captured display ${which}${display ? "" : " (the one the mouse is on)"}.`);
        }
        const img = await captureWindow(w);
        if (img.width) computer.rememberLook({ ...w.bounds, imageWidth: img.width, imageHeight: img.height ?? img.width }, seq);
        const p = pointerInImage(w, await pointerLocation(snap), img);
        const pointer = p ? ` The mouse pointer is at (${p.x}, ${p.y}) in this image.` : "";
        return imageResult(img, `Captured ${describe(w)}.${pointer}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_windows",
    {
      title: "List visible windows",
      description: "List on-screen app windows (front-most first) with ids, app names and titles. Use before `look` when unsure which window the user means.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const windows = await listWindows();
        const lines = windows.map(
          (w) => `${w.id}\t${w.app}\t${w.title || "(no title)"}\t${w.bounds.width}x${w.bounds.height}${isTerminal(w) ? "\t[terminal]" : ""}`,
        );
        return { content: [{ type: "text" as const, text: ["id\tapp\ttitle\tsize", ...lines].join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "select_region",
    {
      title: "Let the user select a region",
      description:
        "Show the native crosshair so the user can drag a rectangle around the exact part of the screen they mean " +
        "(press Space to pick a window instead, Esc to cancel). Blocks until they finish. Tell the user to make the selection.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const img = await captureRegion();
        if (!img) return { content: [{ type: "text" as const, text: "User cancelled the selection." }] };
        return imageResult(img, "Captured the region the user selected.");
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "clipboard_image",
    {
      title: "Read image from clipboard",
      description: "Return the image currently on the user's clipboard (e.g. a screenshot taken with Cmd+Ctrl+Shift+4).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const img = await captureClipboard();
        if (!img) return { content: [{ type: "text" as const, text: "There is no image on the clipboard." }] };
        return imageResult(img, "Image from clipboard.");
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "device_screenshot",
    {
      title: "Screenshot a simulator or device",
      description:
        "Full-resolution screenshot of the booted iOS Simulator (platform ios) or a connected Android device/emulator " +
        "(platform android), without window chrome. Use it to explain or debug app UI, then find the view in code.",
      inputSchema: { platform: z.enum(["ios", "android"]).default("ios") },
      annotations: { readOnlyHint: true },
    },
    async ({ platform }) => {
      try {
        const img = await captureDevice(platform);
        return imageResult(img, platform === "ios" ? "Booted iOS Simulator screen." : "Android device screen.");
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
