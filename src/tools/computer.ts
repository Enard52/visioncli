import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureWindow, findWindow } from "../capture.js";
import * as computer from "../control.js";
import { describe, errorResult, imageResult } from "./common.js";

// ---- Computer control (performed by VisionCLI.app; the user approves actions unless they chose "Allow all") ----

const coords = {
  image: z.number().int().min(1).optional().describe("x/y are pixels in this attached voice-question image (1-based)"),
  screen: z.boolean().default(false).describe("x/y are screen points (e.g. from ui_elements) rather than screenshot pixels"),
};
const lookAfter = z.boolean().default(false).describe("Return a fresh screenshot of the front window after the action, to check the result");

function act<A extends { look_after?: boolean }>(fn: (args: A) => Promise<string>) {
  return async (args: A) => {
    try {
      const text = await fn(args);
      if (args.look_after) {
        const seq = computer.beginLook();
        await new Promise((r) => setTimeout(r, 200)); // the app already waits ~0.35 s for the UI before replying
        const w = await findWindow({});
        const img = await captureWindow(w);
        if (img.width) computer.rememberLook({ ...w.bounds, imageWidth: img.width, imageHeight: img.height ?? img.width }, seq);
        return imageResult(img, `${text}\nNow showing ${describe(w)}.`);
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResult(err);
    }
  };
}

const done = (r: computer.ActionDone) => `Done: ${r.done}. Front app: ${r.frontApp}.`;

/** Using the computer through VisionCLI.app: ui_elements, click, type_text, press_keys, scroll, drag, open_app, open_url, announce. */
export function register(server: McpServer) {
  server.registerTool(
    "ui_elements",
    {
      title: "List UI elements",
      description:
        "List the buttons, fields, menus, links, tabs and text of the front app's focused window (or a named app) via Accessibility, " +
        "each with an id and its center in screen points. Use the id with click/type_text: it's far more reliable than pixel guessing.",
      inputSchema: { app: z.string().optional().describe("App name; default is the front app") },
      annotations: { readOnlyHint: true },
    },
    async ({ app }) => {
      try {
        const r = await computer.send({ action: "elements", app });
        if (!r.elements.length) return { content: [{ type: "text" as const, text: `No accessible elements found in ${r.app || "the front app"}. Use look and click by coordinates instead.` }] };
        const lines = r.elements.map((e) => `[${e.id}] ${e.role}${e.label ? ` "${e.label}"` : ""} @${e.x},${e.y}`);
        return { content: [{ type: "text" as const, text: `${r.app}:\n${lines.join("\n")}` }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "click",
    {
      title: "Click",
      description:
        "Click on the screen: by `element` id from ui_elements (preferred), or at x/y pixels in the last screenshot (from look, or `image` N of the voice question). " +
        "Supports right-click and double-click.",
      inputSchema: {
        element: z.number().int().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        ...coords,
        button: z.enum(["left", "right"]).default("left"),
        count: z.number().int().min(1).max(3).default(1).describe("2 = double-click"),
        look_after: lookAfter,
      },
    },
    act(async ({ element, x, y, image, screen, button, count }) => {
      let p = {};
      if (element === undefined) {
        if (x === undefined || y === undefined) throw new Error("Give an element id or x and y.");
        p = computer.toScreen(x, y, { image, screen });
      }
      return done(await computer.send({ action: "click", element, ...p, button, count }));
    }),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description:
        "Type text with the keyboard into the focused field, or into `element` (clicked first). `replace: true` sets the field's whole value instead of typing. " +
        "Use press_keys for Enter, Tab, shortcuts.",
      inputSchema: {
        text: z.string(),
        element: z.number().int().optional(),
        replace: z.boolean().default(false),
        app: z.string().optional().describe("App to type into (brought to the front first); default: the app you last worked in"),
        look_after: lookAfter,
      },
    },
    act(async ({ text, element, replace, app }) => done(await computer.send({ action: "type", text, element, replace, app }))),
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press keys",
      description: 'Press a key or shortcut (not for browser navigation: use browser_open/browser_navigate), e.g. "enter", "cmd+s", "cmd+shift+p", "tab", "esc", "down". Several separated by spaces run in order: "cmd+a delete".',
      inputSchema: {
        keys: z.string(),
        app: z.string().optional().describe("App to send the keys to (brought to the front first); default: the app you last worked in"),
        look_after: lookAfter,
      },
    },
    act(async ({ keys, app }) => done(await computer.send({ action: "key", keys, app }))),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description: "Scroll at x/y (default: where the mouse is). dy negative = down, positive = up (lines); dx for sideways.",
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        ...coords,
        dy: z.number().int().default(-5),
        dx: z.number().int().default(0),
        look_after: lookAfter,
      },
    },
    act(async ({ x, y, image, screen, dx, dy }) => {
      const p = x !== undefined && y !== undefined ? computer.toScreen(x, y, { image, screen }) : {};
      return done(await computer.send({ action: "scroll", ...p, dx, dy }));
    }),
  );

  server.registerTool(
    "drag",
    {
      title: "Drag",
      description: "Drag with the left mouse button from (x1,y1) to (x2,y2): move files, select text, resize, reorder.",
      inputSchema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), ...coords, look_after: lookAfter },
    },
    act(async ({ x1, y1, x2, y2, image, screen }) => {
      const a = computer.toScreen(x1, y1, { image, screen });
      const b = computer.toScreen(x2, y2, { image, screen });
      return done(await computer.send({ action: "drag", x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    }),
  );

  server.registerTool(
    "open_app",
    {
      title: "Open or switch to an app",
      description: 'Open an app, or bring it to the front if it\'s running, e.g. "Xcode", "Slack", "Simulator", "Android Studio", "Figma".',
      inputSchema: { name: z.string(), look_after: lookAfter },
    },
    act(async ({ name }) => done(await computer.send({ action: "focus_app", name }))),
  );

  server.registerTool(
    "open_url",
    {
      title: "Open a URL",
      description: "Open a link or file URL with its default app (browser, Figma, Slack deep links, vscode://, etc.).",
      inputSchema: { url: z.string(), look_after: lookAfter },
    },
    act(async ({ url }) => done(await computer.send({ action: "open_url", url }))),
  );

  server.registerTool(
    "announce",
    {
      title: "Tell the user out loud",
      description:
        "Show a short update in VisionCLI's bubble and say it out loud, e.g. when background work you promised to report on " +
        "has finished (\"The v0.7.6 release is live.\"). One or two short spoken sentences, plain text, no markdown.",
      inputSchema: { text: z.string().describe("What to tell the user, as it should be spoken") },
    },
    async ({ text }) => {
      try {
        await computer.send({ action: "announce", text });
        return { content: [{ type: "text" as const, text: "Announced." }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
