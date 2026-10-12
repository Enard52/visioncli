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
  snapshot,
} from "./capture.js";
import * as browser from "./browser.js";
import * as computer from "./control.js";
import { describeConnection, query, schema } from "./db.js";
import { startVoice } from "./voice.js";

const INSTRUCTIONS = `visioncli lets you see the user's screen so they don't have to paste screenshots.
Use it whenever the user refers to something they are looking at: "this file", "this screen", "what's this error",
"why is this code like this", "look at my simulator", etc.
- Default to \`look\` (captures the window under the mouse, or the front-most non-terminal window if the mouse is on the terminal; target \"screen\" = the display the mouse is on).
- Pass \`app\` when the user names an app ("look at Xcode", "check the simulator").
- Use \`select_region\` when the user wants to point at a specific part of the screen.
- After capturing code, use the window title and visible code to locate the real file in the project, read it,
  and answer with file_path:line references rather than relying only on the pixels.
- For iOS Simulator / Android emulator questions, \`device_screenshot\` gives a clean full-resolution screen; find the view
  in code by grepping for visible strings.
- For database questions ("how are payments and orders related"), use \`db_schema\` / \`db_query\` (read-only, uses the
  project's .env) together with the models/migrations in the code.
- Using the computer (any app): \`ui_elements\` lists the front app's controls with ids → \`click\` / \`type_text\` by id;
  or \`look\` then \`click\` at pixel x/y in that screenshot. \`press_keys\` for Enter/shortcuts, \`scroll\`, \`drag\`, \`open_app\`,
  \`open_url\`. In Chrome/Brave use the browser_* tools instead (never ⌘L/⌘T or typing URLs): they're exact, see into frames
  and reuse tabs; pixel clicks there only for canvas, cross-origin frames or browser dialogs. Work step by step and verify
  with \`look_after: true\` or \`look\`. The user approves actions in a bubble; if they
  decline or press Esc, stop and ask.
- Browser (Brave/Chrome): \`browser_tabs\`, \`browser_open\`, \`browser_switch_tab\`, \`browser_navigate\`, \`browser_read\`,
  \`browser_elements\` → \`browser_click\` / \`browser_type\` / \`browser_select\` (dropdowns) by element id, \`browser_scroll\`. Prefer these over screenshots for
  web pages: they're fast and exact.`;

export const server = new McpServer({ name: "visioncli", version: "0.3.0" }, { instructions: INSTRUCTIONS });

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
      const snap = isMac && target === "window" ? await snapshot() : undefined;
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
        const d = snap ?? (isMac ? await computer.displaysAndPointer() : null);
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

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const wrap = <A,>(fn: (args: A) => Promise<string>) => async (args: A) => {
  try {
    return text(await browser.serial(() => fn(args))); // one browser call at a time (element ids, "window 1")
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
    description:
      "Open a URL in Chrome/Brave. Always use this (never ⌘L/⌘T + typing) to go to a page: it switches to a tab already showing it, " +
      "otherwise reuses your own working tab, and only opens one new tab the first time. new_tab: false loads it in the user's current tab.",
    inputSchema: { url: z.string(), new_tab: z.boolean().default(true) },
  },
  wrap(async ({ url, new_tab }) => browser.open(url, new_tab)),
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
    inputSchema: { max_chars: z.number().int().min(500).max(50000).default(6000).describe("Raise it (up to 50000) only if the text you need was cut off") },
    annotations: { readOnlyHint: true },
  },
  wrap(async ({ max_chars }) => browser.read(max_chars)),
);

server.registerTool(
  "browser_elements",
  {
    title: "List clickable elements",
    description: "Visible links, buttons, fields, dropdowns (with options) and toggles (with on/off state) on the active page, with ids (e1, e2, …) for browser_click / browser_type / browser_select.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(async () =>
    (await browser.elements())
      .map((e) =>
        [e.id, e.kind, e.text, e.state && `[${e.state}]`, e.expanded !== undefined && (e.expanded ? "[open]" : "[closed]"),
          e.value !== undefined && `value: ${e.value}`, e.options && `options: ${e.options.join(" | ")}`, e.href]
          .filter(Boolean).join("\t"))
      .join("\n") || "(none)"),
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
  "browser_select",
  {
    title: "Choose a dropdown option",
    description:
      "Pick an option in a dropdown (native <select> or custom combobox/menu) by its visible text. Use this instead of browser_click for dropdowns. " +
      "Toggles/switches/checkboxes: use browser_click (browser_elements shows their on/off state).",
    inputSchema: { target: z.string().describe("Dropdown id from browser_elements"), option: z.string().describe("Option text") },
  },
  wrap(async ({ target, option }) => browser.select(target, option)),
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

// ---- Computer control (performed by VisionCLI.app; the user approves actions unless they chose "Allow all") ----

const coords = {
  image: z.number().int().min(1).optional().describe("x/y are pixels in this attached voice-question image (1-based)"),
  screen: z.boolean().default(false).describe("x/y are screen points (e.g. from ui_elements) rather than screenshot pixels"),
};
const lookAfter = z.boolean().default(false).describe("Return a fresh screenshot of the front window after the action, to check the result");

function act(fn: (args: any) => Promise<string>) {
  return async (args: any) => {
    try {
      const text = await fn(args);
      if (args.look_after) {
        const seq = computer.beginLook();
        await new Promise((r) => setTimeout(r, 200)); // the app already waits ~0.35 s for the UI before replying
        const w = await findWindow({});
        const img = await captureWindow(w);
        if (img.width) computer.rememberLook({ ...w.bounds, imageWidth: img.width, imageHeight: img.height ?? img.width }, seq);
        return imageResult(img, `${text}\\nNow showing ${describe(w)}.`);
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResult(err);
    }
  };
}

const done = (r: any) => `Done: ${r.done}. Front app: ${r.frontApp}.`;

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
      const lines = r.elements.map((e: any) => `[${e.id}] ${e.role}${e.label ? ` "${e.label}"` : ""} @${e.x},${e.y}`);
      return { content: [{ type: "text" as const, text: `${r.app}:\\n${lines.join("\\n")}` }] };
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
    if (element === undefined && (x === undefined || y === undefined)) throw new Error("Give an element id or x and y.");
    const p = element === undefined ? computer.toScreen(x, y, { image, screen }) : {};
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

export async function start() {
  await server.connect(new StdioServerTransport());
}
