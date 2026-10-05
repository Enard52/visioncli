#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type Capture,
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
} from "./capture.js";
import * as browser from "./browser.js";
import { describeConnection, query, schema } from "./db.js";
import { quick, warm } from "./quick.js";
import { type Destination, configuredDestinations, share } from "./share.js";
import { install, startVoice } from "./voice.js";

const INSTRUCTIONS = `visioncli lets you see the user's screen so they don't have to paste screenshots.
Use it whenever the user refers to something they are looking at: "this file", "this screen", "what's this error",
"why is this code like this", "look at my simulator", etc.
- Default to \`look\` (captures the front-most window that isn't the terminal, e.g. Xcode, an IDE, a browser, a simulator).
- Pass \`app\` when the user names an app ("look at Xcode", "check the simulator").
- Use \`select_region\` when the user wants to point at a specific part of the screen.
- After capturing code, use the window title and visible code to locate the real file in the project, read it,
  and answer with file_path:line references rather than relying only on the pixels.
- For iOS Simulator / Android emulator questions, \`device_screenshot\` gives a clean full-resolution screen; find the view
  in code by grepping for visible strings.
- For database questions ("how are payments and orders related"), use \`db_schema\` / \`db_query\` (read-only, uses the
  project's .env) together with the models/migrations in the code.
- \`share\` sends a report to a file, Slack, Linear or Jira when the user asks.
- Browser (Brave/Chrome): \`browser_tabs\`, \`browser_open\`, \`browser_switch_tab\`, \`browser_navigate\`, \`browser_read\`,
  \`browser_elements\` → \`browser_click\` / \`browser_type\` (by element id), \`browser_scroll\`. Prefer these over screenshots for
  web pages: they're fast and exact.`;

const server = new McpServer({ name: "visioncli", version: "0.3.0" }, { instructions: INSTRUCTIONS });

function describe(w: WindowInfo) {
  return `${w.app}${w.title ? ` — "${w.title}"` : ""} (window ${w.id})`;
}

function imageResult(img: Capture, caption: string) {
  const size = img.width ? ` [${img.width}x${img.height}]` : "";
  return {
    content: [
      { type: "text" as const, text: caption + size },
      { type: "image" as const, data: img.data, mimeType: img.mimeType },
    ],
  };
}

function errorResult(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: String((err as Error)?.message ?? err) }] };
}

server.registerTool(
  "look",
  {
    title: "Look at the screen",
    description:
      "Take a screenshot of what the user is looking at and return it as an image. " +
      'By default captures the front-most window that is not the terminal (target "window"). ' +
      'Use target "screen" for a whole display. Optionally pick a window by app name/title or window id.',
    inputSchema: {
      target: z.enum(["window", "screen"]).default("window").describe("Capture a single window or an entire display"),
      app: z.string().optional().describe('App name or window-title substring, e.g. "Xcode", "Simulator", "Chrome"'),
      window_id: z.number().int().optional().describe("Exact window id from list_windows"),
      display: z.number().int().min(1).optional().describe("Display number for target screen (1 = main)"),
      under_cursor: z
        .boolean()
        .default(false)
        .describe("Capture the window under the mouse pointer instead of the front-most one (falls back if it's the terminal)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ target, app, window_id, display, under_cursor }) => {
    try {
      if (target === "screen" || process.platform !== "darwin") {
        const img = await captureScreen(display);
        return imageResult(img, `Captured display ${display ?? 1}.`);
      }
      const w = await findWindow({ app, windowId: window_id, underCursor: under_cursor });
      const img = await captureWindow(w);
      const p = pointerInImage(w, await pointerLocation(), img);
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

server.registerTool(
  "db_schema",
  {
    title: "Database schema",
    description:
      "Tables, columns and foreign keys of the project's database (connection read from the project's .env: Laravel DB_* " +
      "or DATABASE_URL; MySQL, Postgres, SQLite). Pass a table to narrow it. Read-only.",
    inputSchema: { table: z.string().optional().describe("Only this table") },
    annotations: { readOnlyHint: true },
  },
  async ({ table }) => {
    try {
      return { content: [{ type: "text" as const, text: `${describeConnection()}\n\n${await schema(table)}` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "db_query",
  {
    title: "Run a read-only SQL query",
    description:
      "Run one SELECT/SHOW/DESCRIBE/EXPLAIN/WITH query against the project's database inside a read-only transaction. " +
      "Results are capped at 50 rows; use LIMIT.",
    inputSchema: { sql: z.string().describe("A single read-only SQL statement") },
    annotations: { readOnlyHint: true },
  },
  async ({ sql }) => {
    try {
      return { content: [{ type: "text" as const, text: await query(sql) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "share",
  {
    title: "Share a report",
    description:
      "Send a short report (e.g. the question, your answer, and file references) to a destination the user has set up: " +
      '"file" (markdown in ~/Documents/visioncli-reports, always available), "slack", "linear" or "jira". ' +
      "Only call this when the user asks to share/send/file something.",
    inputSchema: {
      destination: z.enum(["file", "slack", "linear", "jira"]),
      title: z.string().describe("Short title / issue summary"),
      body: z.string().describe("Markdown body"),
      image_path: z.string().optional().describe("Path to a screenshot to attach (saved with file reports)"),
    },
  },
  async ({ destination, title, body, image_path }) => {
    try {
      return { content: [{ type: "text" as const, text: await share(destination, title, body, image_path) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const wrap = <A,>(fn: (args: A) => Promise<string>) => async (args: A) => {
  try {
    return text(await fn(args));
  } catch (err) {
    return errorResult(err);
  }
};

server.registerTool(
  "browser_tabs",
  {
    title: "List browser tabs",
    description: "Open tabs in the front-most Brave/Chrome (ids like t1.3 = window 1, tab 3), marking the active one.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => {
    const b = await browser.pick();
    return `${b}\n` + (await browser.tabs(b)).map((t) => `${t.id}${t.active ? " (active)" : ""}\t${t.title}\t${t.url}`).join("\n");
  }),
);

server.registerTool(
  "browser_open",
  {
    title: "Open a URL",
    description: "Open a URL in the browser, in a new tab (default) or the current one.",
    inputSchema: { url: z.string(), new_tab: z.boolean().default(true) },
  },
  wrap(async ({ url, new_tab }) => {
    await browser.open(url, new_tab);
    return `Opened ${url}`;
  }),
);

server.registerTool(
  "browser_switch_tab",
  {
    title: "Switch tab",
    description: "Bring a tab (id from browser_tabs) to the front.",
    inputSchema: { tab_id: z.string() },
  },
  wrap(async ({ tab_id }) => {
    await browser.switchTo(tab_id);
    return `Switched to ${tab_id}`;
  }),
);

server.registerTool(
  "browser_navigate",
  {
    title: "Back / forward / reload / close tab / new tab",
    description: "Navigate the active tab.",
    inputSchema: { action: z.enum(["back", "forward", "reload", "close", "new"]) },
  },
  wrap(async ({ action }) => {
    await browser.navigate(action);
    return `Done: ${action}`;
  }),
);

server.registerTool(
  "browser_read",
  {
    title: "Read the current page",
    description: "Title, URL, selected text and readable text of the active tab (capped). Faster and more exact than a screenshot.",
    inputSchema: { max_chars: z.number().int().min(500).max(50000).default(12000) },
    annotations: { readOnlyHint: true },
  },
  wrap(async ({ max_chars }) => browser.read(max_chars)),
);

server.registerTool(
  "browser_elements",
  {
    title: "List clickable elements",
    description: "Visible links, buttons and form fields on the active page with ids (e1, e2, …) for browser_click / browser_type.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () => (await browser.elements()).map((e) => `${e.id}\t${e.kind}\t${e.text}${e.href ? `\t${e.href}` : ""}`).join("\n") || "(none)"),
);

server.registerTool(
  "browser_click",
  {
    title: "Click an element",
    description: "Click an element by id from browser_elements (or by its visible text).",
    inputSchema: { target: z.string().describe("Element id like e12, or visible text") },
  },
  wrap(async ({ target }) => `Clicked “${await browser.click(target)}”`),
);

server.registerTool(
  "browser_type",
  {
    title: "Type into a field",
    description: "Set the value of a form field (id from browser_elements), optionally submitting the form.",
    inputSchema: { target: z.string(), text: z.string(), submit: z.boolean().default(false) },
  },
  wrap(async ({ target, text: value, submit }) => {
    await browser.type(target, value, submit);
    return `Typed into ${target}${submit ? " and submitted" : ""}`;
  }),
);

server.registerTool(
  "browser_scroll",
  {
    title: "Scroll the page",
    description: "Scroll the active page.",
    inputSchema: { where: z.enum(["down", "up", "top", "bottom"]) },
  },
  wrap(async ({ where }) => {
    await browser.scroll(where);
    return `Scrolled ${where}`;
  }),
);

server.registerTool(
  "start_voice",
  {
    title: "Start voice mode",
    description:
      "Launch the voice overlay for this project: the user holds Option+Space, asks a question out loud, " +
      "and the answer appears in a bubble above their mouse pointer.",
    inputSchema: {},
  },
  async () => {
    try {
      return { content: [{ type: "text" as const, text: await startVoice(process.cwd()) }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerPrompt(
  "see",
  {
    title: "Look at my screen",
    description: "Capture what you're looking at and ask about it",
    argsSchema: { question: z.string().optional().describe("What you want to know about what's on screen") },
  },
  ({ question }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Use the visioncli `look` tool to capture the window I'm looking at. " +
            `Then answer: ${question?.trim() || "What is this, and what is it for?"}\n` +
            "If it shows code, find the matching file in this project, read it, and cite file_path:line.",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "point",
  {
    title: "Point at part of my screen",
    description: "Drag a box around something on screen and ask about it",
    argsSchema: { question: z.string().optional().describe("What you want to know about the selected area") },
  },
  ({ question }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Use the visioncli `select_region` tool (I'll drag a box around what I mean). " +
            `Then answer: ${question?.trim() || "Explain what this is."}\n` +
            "If it shows code, find the matching file in this project, read it, and cite file_path:line.",
        },
      },
    ],
  }),
);

// CLI: `visioncli voice [dir]`, `visioncli install`, `visioncli share <dest> <title> [image] < body`, `visioncli destinations`
const [cmd, ...rest] = process.argv.slice(2);
if (cmd) {
  try {
    if (cmd === "voice") console.log(await startVoice(rest[0] ?? process.cwd()));
    else if (cmd === "install") console.log(await install());
    else if (cmd === "destinations") console.log(JSON.stringify(await configuredDestinations()));
    else if (cmd === "quick") console.log(JSON.stringify(await quick(rest.join(" "))));
    else if (cmd === "warm") console.log(await warm());
    else if (cmd === "browser") {
      // Debug helper: visioncli browser tabs|elements|read|click <t>|open <url>|scroll <dir>|nav <action>
      const [sub, ...a] = rest;
      const out =
        sub === "tabs" ? await browser.tabs() :
        sub === "elements" ? await browser.elements() :
        sub === "read" ? await browser.read(2000) :
        sub === "click" ? await browser.click(a.join(" ")) :
        sub === "open" ? await browser.open(a[0]) :
        sub === "scroll" ? await browser.scroll(a[0] as "down") :
        sub === "nav" ? await browser.navigate(a[0] as "back") : `unknown: ${sub}`;
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    }
    else if (cmd === "share") {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      console.log(await share(rest[0] as Destination, rest[1] ?? "visioncli report", Buffer.concat(chunks).toString(), rest[2]));
    } else {
      console.error("Usage: visioncli [voice [dir] | install | share <file|slack|linear|jira> <title> [image] | destinations | quick <command> | browser <sub>]");
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    console.error(String((err as Error)?.message ?? err));
    process.exit(1);
  }
}

await server.connect(new StdioServerTransport());
