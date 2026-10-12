import { existsSync, readFileSync } from "node:fs";
import * as browser from "./browser.js";
import { INTEGRATIONS_FILE } from "./config.js";

// Instant voice commands: one Jev (TypeSafe System One) request routes the spoken command and picks its
// target from candidates code collected (open tabs, clickable elements); code then performs the action.
// Anything that isn't a confident, simple browser action falls through to Claude.

export interface QuickResult {
  handled: boolean;
  message?: string;       // shown in the bubble when handled
  intent?: string;
  confidence?: number;
  ms?: number;
  reason?: string;        // why it fell through to Claude
}

const INTENTS: Record<string, string> = {
  switch_tab: "Go to, show or switch to one of the browser tabs that is already open.",
  open_site: "Open a website that is not already open, e.g. 'open github' or 'go to laravel.com'.",
  web_search: "Search the web for something, e.g. 'search for laravel queues' or 'google stripe webhooks'.",
  click: "Click, press, select or follow a specific button, link or tab on the current web page.",
  scroll_down: "Scroll the current page down / show more below.",
  scroll_up: "Scroll the current page up.",
  scroll_top: "Go to the top of the current page.",
  scroll_bottom: "Go to the bottom of the current page.",
  play_pause: "Play, pause or resume the video or audio on the current page (e.g. 'pause the video', 'play it').",
  mute: "Mute or unmute the video or audio on the current page.",
  back: "Go back to the previous page.",
  forward: "Go forward to the next page.",
  reload: "Reload / refresh the current page.",
  close_tab: "Close the current browser tab.",
  new_tab: "Open a new empty browser tab.",
  ask_claude:
    "Anything else: a question about what is on screen or in the code, an explanation, a code change, typing or filling in text, " +
    "running commands, or a multi-step task. Also any request that is not clearly one simple browser action.",
};

export function apiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    if (existsSync(INTEGRATIONS_FILE)) return JSON.parse(readFileSync(INTEGRATIONS_FILE, "utf8"))?.typesafe?.apiKey || undefined;
  } catch {}
  return undefined;
}

interface Answer { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }

async function jev(state: unknown, questions: Record<string, unknown>, key: string): Promise<Record<string, Answer>> {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).answers;
}

/** Words after the command verb, e.g. "search for laravel queues" → "laravel queues". */
function phrase(utterance: string): string {
  return utterance
    .replace(/[.?!]+$/, "")
    .replace(/^(hey |ok |okay |please |can you |could you |would you |i want to |let'?s )+/i, "")
    .replace(/^(search( the web)?( for)?|google|look up|find|open( up)?|go to|navigate to|show me|take me to|visit|launch)\s+/i, "")
    .replace(/\s+(on|in|with|using) (google|the web|the browser|brave|chrome|a new tab)$/i, "")
    .replace(/^(the )?(website|site|page) /i, "")
    .trim();
}

function siteUrl(name: string): string {
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(name.replace(/\s+/g, ""))) return name.replace(/\s+/g, "");
  // Not a domain: let Google pick the site ("I'm Feeling Lucky").
  return `https://www.google.com/search?btnI=1&q=${encodeURIComponent(name)}`;
}

const MIN_INTENT = 0.7;
const MIN_TARGET = 0.55;
const MAX_ELEMENTS = 60; // page elements offered to Jev (in page order): enough for a screenful, keeps the request fast

export async function quick(utterance: string): Promise<QuickResult> {
  const started = Date.now();
  const key = apiKey();
  if (!key) return { handled: false, reason: "no TypeSafe API key" };
  if (utterance.split(/\s+/).length > 25) return { handled: false, reason: "too long for a quick command" };

  let b: browser.BrowserName;
  let inFront: boolean;
  try {
    ({ browser: b, front: inFront } = await browser.pickWithFront());
  } catch {
    return { handled: false, reason: "no supported browser running" };
  }

  // Candidates the answers can point at. Page elements only when the browser is in front (it's what "this page" means).
  const [tabList, allEls] = await Promise.all([
    browser.tabs(b).catch(() => [] as browser.Tab[]),
    inFront ? browser.elements(b).catch(() => [] as browser.Element[]) : ([] as browser.Element[]),
  ]);
  const els = allEls.slice(0, MAX_ELEMENTS);
  const active = tabList.find((t) => t.active);

  // The candidates go to Jev once, as the choice criteria (not repeated in the state), to keep the request small.
  const state = {
    spoken_command: utterance,
    note: "The command came from speech-to-text, so words may be misheard.",
    browser: b,
    browser_is_front_app: inFront,
    current_tab: active ? { title: active.title.slice(0, 80), url: active.url.slice(0, 100) } : null,
  };

  const questions: Record<string, unknown> = {
    intent: {
      type: "choice",
      instructions: "What does the user want done with `spoken_command`? Pick the single matching action.",
      criteria: INTENTS,
    },
  };
  if (tabList.length) {
    questions.tab = {
      type: "choice",
      instructions: "Suppose the user wants to switch to an already-open browser tab: which of these open tabs do they mean (by title, site or topic)?",
      criteria: { ...Object.fromEntries(tabList.map((t) => [t.id, `${t.title.slice(0, 80)} (${t.url.slice(0, 80)})`])), none: "None of the open tabs matches." },
    };
  }
  if (els.length) {
    questions.element = {
      type: "choice",
      instructions: "Suppose the user wants to click something on the current web page: which of these page elements do they mean?",
      criteria: { ...Object.fromEntries(els.map((e) => [e.id, `${e.kind}: ${e.text}${e.href ? ` (${e.href})` : ""}`])), none: "None of these elements matches." },
    };
  }

  let a: Record<string, Answer>;
  try {
    a = await jev(state, questions, key);
  } catch (err) {
    return { handled: false, reason: String((err as Error).message ?? err), ms: Date.now() - started };
  }
  const intent = a.intent?.choice ?? "ask_claude";
  const conf = a.intent?.confidence ?? 0;
  const base = { intent, confidence: conf, ms: 0 };
  const fallthrough = (reason: string): QuickResult => ({ handled: false, ...base, reason, ms: Date.now() - started });
  if (intent === "ask_claude") return fallthrough("needs Claude");
  if (conf < MIN_INTENT) return fallthrough(`unsure (${conf.toFixed(2)})`);
  if (process.env.VISIONCLI_QUICK_DRY === "1") {
    const target = intent === "switch_tab" ? a.tab : intent === "click" ? a.element : undefined;
    const label = target?.choice && target.choice !== "none"
      ? (tabList.find((t) => t.id === target.choice)?.title ?? els.find((e) => e.id === target.choice)?.text ?? target.choice)
      : "";
    return { handled: true, ...base, message: `[dry run] ${intent}${label ? ` → ${label} (${(target?.confidence ?? 0).toFixed(2)})` : ""}${["open_site", "web_search"].includes(intent) ? ` → "${phrase(utterance)}"` : ""}`, ms: Date.now() - started };
  }

  try {
    let message = "";
    switch (intent) {
      case "switch_tab": {
        const t = a.tab;
        if (!t?.choice || t.choice === "none" || (t.confidence ?? 0) < MIN_TARGET) {
          // Not open yet: treat as opening the site.
          await browser.open(siteUrl(phrase(utterance)), true, b, tabList);
          message = `Opened ${phrase(utterance)}`;
          break;
        }
        await browser.switchTo(t.choice, b);
        message = `Switched to “${tabList.find((x) => x.id === t.choice)?.title ?? t.choice}”`;
        break;
      }
      case "open_site":
        await browser.open(siteUrl(phrase(utterance)), true, b, tabList);
        message = `Opened ${phrase(utterance)}`;
        break;
      case "web_search": {
        const query = phrase(utterance);
        await browser.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, true, b, tabList);
        message = `Searching for “${query}”`;
        break;
      }
      case "click": {
        const e = a.element;
        if (!e?.choice || e.choice === "none" || (e.confidence ?? 0) < MIN_TARGET) return fallthrough("couldn't tell which element");
        const clicked = await browser.click(e.choice, b);
        message = `Clicked “${clicked}”`;
        break;
      }
      case "scroll_down": case "scroll_up": case "scroll_top": case "scroll_bottom":
        await browser.scroll(intent.replace("scroll_", "") as "down" | "up" | "top" | "bottom", b);
        message = { scroll_down: "Scrolled down", scroll_up: "Scrolled up", scroll_top: "Top of page", scroll_bottom: "Bottom of page" }[intent]!;
        break;
      case "play_pause": {
        const r = await browser.js(`(() => { const m = [...document.querySelectorAll('video, audio')].sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
          if (!m) return 'none'; if (m.paused) { m.play(); return 'Playing'; } m.pause(); return 'Paused'; })()`, b);
        if (r === "none") return fallthrough("no video or audio on the page");
        message = r;
        break;
      }
      case "mute": {
        const r = await browser.js(`(() => { const m = document.querySelector('video, audio'); if (!m) return 'none'; m.muted = !m.muted; return m.muted ? 'Muted' : 'Unmuted'; })()`, b);
        if (r === "none") return fallthrough("no video or audio on the page");
        message = r;
        break;
      }
      case "back": case "forward": case "reload":
        await browser.navigate(intent, b);
        message = { back: "Back", forward: "Forward", reload: "Reloaded" }[intent]!;
        break;
      case "close_tab":
        await browser.navigate("close", b);
        message = "Closed the tab";
        break;
      case "new_tab":
        await browser.navigate("new", b);
        message = "New tab";
        break;
      default:
        return fallthrough(`unhandled intent ${intent}`);
    }
    return { handled: true, ...base, message, ms: Date.now() - started };
  } catch (err) {
    // The action itself failed (e.g. JavaScript from Apple Events is off): report it rather than silently asking Claude.
    return { handled: true, ...base, message: String((err as Error).message ?? err), ms: Date.now() - started };
  }
}

/** Tiny request to wake the service up (the first call after idle can take a few seconds). */
export async function warm(): Promise<string> {
  const key = apiKey();
  if (!key) return "no key";
  const t = Date.now();
  await jev({ spoken_command: "scroll down" }, { intent: { type: "choice", instructions: "Which action?", criteria: { scroll: "Scroll", other: "Other" } } }, key);
  return `warm in ${Date.now() - t}ms`;
}
