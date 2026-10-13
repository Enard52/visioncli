import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Accessibility, Desktop, DesktopWindow, InputInjector } from "../contracts";
import { log } from "../log";
import { SUP } from "../paths";
import { settings } from "../settings";
import { SENSITIVE_APPS } from "../control/actions";
import { isTerminal } from "./projects";
import { run } from "./run";

// Autopilot: while you work, VisionCLI glances at the front app when something changes (you switch apps or windows,
// or pause for a while) and, if it has something genuinely useful, shows a small suggestion card in the bottom-right
// corner. In chat apps (Telegram, WhatsApp, Slack, Fiverr…) it drafts a reply; nothing is ever sent without a click.
//
// Cheap by design: it reads the window's text through accessibility (a screenshot only when there's almost no text),
// asks Claude Haiku with a tiny prompt and no tools (~1k tokens), stays quiet most of the time, and has an hourly cap.
// Port of overlay/Sources/Autopilot.swift; the card itself (SuggestionCard) is the UI's, injected.

export interface Suggestion { app: string; title: string; detail: string; draft: string | null; pid: number; windowId: string }

export interface AutopilotDeps {
  desktop: Desktop;
  ax: Accessibility;
  input?: InputInjector;
  card: { show(s: Suggestion): void; hide(): void };
  /** VisionCLI is answering a question: don't interrupt. */
  isBusy?(): boolean;
  claudePath?(): string;
  /** The activity badge ("Autopilot is reading Firefox…"). */
  badge?(text: string, tint?: "yellow" | "green"): void;
  /** Seconds since the last keyboard/mouse input (default: defaultIdleSeconds); null when the session can't tell. */
  idleSeconds?(): Promise<number | null>;
  /** The app ids picked in Settings (default: settings.autopilotApps). */
  apps?(): string[];
  runner?: typeof run;
  dir?: string;
}

export const HOURLY_CAP = 30;

/** Apps that can never be watched, even if picked: settings, password managers, keyrings, lock screens. */
export const SKIP_APPS = [...SENSITIVE_APPS, "screensaver", "lockscreen", "kscreenlocker", "gdm", "lightdm", "sddm"];

export const CHAT_HINTS = ["viber", "whatsapp", "slack", "telegram", "messages", "discord", "messenger", "teams", "fiverr", "upwork",
  "gmail", "outlook", "signal", "skype", "line", "element", "thunderbird", "geary"];

export function isSkipped(w: { app?: string; appId?: string; pid?: number }): boolean {
  const id = (w.appId ?? "").toLowerCase(), name = (w.app ?? "").toLowerCase();
  if (w.pid === process.pid || id.includes("visioncli") || name === "visioncli") return true; // never ourselves
  return SKIP_APPS.some((s) => id.includes(s) || name.includes(s));
}

export const PROMPT = "You are a helpful co-pilot glancing at the user's screen while they work (they are a developer and freelancer). "
  + "You get the front app, its window title and the window's text (or a screenshot). Give ONE specific, useful "
  + "suggestion about what is on screen right now: a bug or mistake you can see, a better or faster way to do what "
  + "they're doing, a shortcut, something they probably missed, or the obvious next step. Be concrete: name the "
  + "thing on screen. If it's a chat or inbox with a message waiting for their reply, write a short reply draft in "
  + "the same language and tone as the conversation. Say nothing (suggest false) only when the screen is empty, "
  + "a loading screen, or you truly have nothing specific to add.\n"
  + "Reply with only JSON, no prose: {\"suggest\": true|false, \"title\": \"under 8 words\", \"detail\": \"1-2 short sentences\", "
  + "\"draft\": \"reply text or null\"}";

export const CLAUDE_ARGS = ["-p", "--model", "haiku", "--effort", "low", "--setting-sources", "project", "--system-prompt", PROMPT,
  "--tools", "", "--strict-mcp-config", "--no-session-persistence",
  "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

/** The user message (one stream-json line). */
export function buildMessage(a: { app: string; title: string; text: string; image: string | null; isChat: boolean; manual: boolean }): string {
  const content: Record<string, unknown>[] = [{
    type: "text",
    text: `App: ${a.app}\nWindow: ${a.title}${a.isChat ? "\n(This looks like a chat or inbox.)" : ""}${a.manual ? "\n(The user pressed Check Now: always give your best suggestion, suggest true.)" : ""}\nWindow text:\n${a.text || "(none, see screenshot)"}`,
  }];
  if (a.image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: a.image } });
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

/** The stream-json output → the suggestion, or null ("suggest": false, no title, unparsable). Tolerates ```json fences. */
export function parseResult(out: string): { title: string; detail: string; draft: string | null } | null {
  for (const l of out.split("\n")) {
    if (!l.includes('"type":"result"')) continue;
    let obj;
    try { obj = JSON.parse(l); } catch { continue; }
    let result = obj?.result;
    if (typeof result !== "string") continue;
    const a = result.indexOf("{"), b = result.lastIndexOf("}");
    if (a >= 0 && b > a) result = result.slice(a, b + 1);
    let j;
    try { j = JSON.parse(result); } catch { return null; }
    if (j?.suggest !== true || typeof j.title !== "string" || !j.title) return null;
    const draft = typeof j.draft === "string" && j.draft ? j.draft : null;
    return { title: j.title, detail: typeof j.detail === "string" ? j.detail : "", draft };
  }
  return null;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export class Autopilot {
  private timer: NodeJS.Timeout | null = null;
  private lastKey = "";
  private keyChangedAt = Date.now();
  private checkedKeys = new Map<string, number>();
  private lastCheckAt = 0;
  private lastTextHash = 0;
  private running = false;
  private recentTitles: string[] = [];
  callsThisHour: number[] = [];

  constructor(private deps: AutopilotDeps) {}

  get calls() {
    const now = Date.now();
    this.callsThisHour = this.callsThisHour.filter((t) => now - t <= 3600_000);
    return this.callsThisHour.length;
  }

  start() {
    if (this.timer) return;
    this.lastKey = "";
    this.timer = setInterval(() => void this.tick(), 2000);
    log("autopilot: on");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.card.hide();
    log("autopilot: off");
  }

  // ── When to look ────────────────────────────────────────────────────────────────────────────────────────────

  async tick(now = Date.now()) {
    if (this.running || this.deps.isBusy?.()) return;
    const w = await this.deps.desktop.activeWindow().catch(() => null);
    const picked = this.deps.apps?.() ?? settings.get("autopilotApps");
    if (!w || !picked.includes(w.appId) || isSkipped(w) || isTerminal(w)) return;
    const key = `${w.appId || w.app}|${w.title}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.keyChangedAt = now;
      return;
    }
    const stable = (now - this.keyChangedAt) / 1000;
    // Without an idle source (some Wayland compositors), staying put on the same window counts as a pause.
    const idle = (await (this.deps.idleSeconds ?? defaultIdleSeconds)().catch(() => null)) ?? stable;
    const checked = this.checkedKeys.get(key);
    const newPlace = stable >= 5 && (checked == null || now - checked > 600_000);
    const pausedHere = idle >= 20 && now - this.lastCheckAt >= 120_000;
    if (!(newPlace || pausedHere) || now - this.lastCheckAt < 30_000 || this.calls >= HOURLY_CAP) return;
    this.checkedKeys.set(key, now);
    this.lastCheckAt = now;
    await this.look(w);
  }

  /** Looks right now at the front window (or the top-most one that isn't VisionCLI or a terminal), ignoring
   *  cooldowns and the app list: the user asked. Password managers etc. are still skipped. */
  async checkNow() {
    let w = await this.deps.desktop.activeWindow().catch(() => null);
    if (!w || w.pid === process.pid || /visioncli/i.test(w.appId) || isTerminal(w)) {
      const wins = await this.deps.desktop.windows().catch(() => [] as DesktopWindow[]);
      w = wins.find((x) => !isTerminal(x) && x.pid !== process.pid) ?? null;
    }
    if (!w || isSkipped(w)) {
      this.deps.badge?.("Autopilot: nothing to look at");
      return;
    }
    if (this.running) return;
    this.lastTextHash = 0;
    this.recentTitles = [];
    this.lastCheckAt = Date.now();
    await this.look(w, true);
  }

  // ── Looking ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async look(w: DesktopWindow, manual = false) {
    this.running = true;
    const name = w.app || "this app";
    const title = w.title;
    const isChat = CHAT_HINTS.some((h) => name.toLowerCase().includes(h) || title.toLowerCase().includes(h));
    this.deps.badge?.(`Autopilot is reading ${name}…`);
    let suggestion: Suggestion | null = null;
    try {
      const read = await this.deps.ax.windowText(6000).catch(() => null);
      // windowText reads the front window; for another window (Check Now from a terminal) the screenshot does.
      const text = read && (read.app === w.app || read.title === title) ? read.text : "";
      // Same screen as last time (nothing new happened): skip.
      const h = hash(name + title + text);
      if (h === this.lastTextHash) return;
      this.lastTextHash = h;
      let image: string | null = null;
      if (text.length < 150) {
        // Too little text to go on: send a small screenshot instead.
        image = await this.deps.desktop.captureWindow(w).then((j) => j.data.toString("base64"), () => null);
      }
      log(`autopilot: reading ${name} (${text.length} chars${image ? ", screenshot" : ""})`);
      suggestion = await this.ask(w, title, text, image, isChat, manual);
      this.callsThisHour.push(Date.now());
    } finally {
      this.running = false;
    }
    if (!suggestion || this.recentTitles.includes(suggestion.title)) {
      if (manual) this.deps.badge?.(`Autopilot: nothing to suggest in ${name}`, "green");
      return;
    }
    this.recentTitles = [...this.recentTitles, suggestion.title].slice(-20);
    log(`autopilot: ${name}: ${suggestion.title}`);
    this.deps.badge?.(`Autopilot: ${suggestion.title}`, "yellow");
    this.deps.card.show(suggestion);
  }

  private async ask(w: DesktopWindow, title: string, text: string, image: string | null, isChat: boolean, manual: boolean): Promise<Suggestion | null> {
    const dir = this.deps.dir ?? join(SUP, "autopilot");
    mkdirSync(dir, { recursive: true });
    const started = Date.now();
    const line = buildMessage({ app: w.app || "this app", title, text, image, isChat, manual });
    const r = await (this.deps.runner ?? run)(this.deps.claudePath?.() ?? "claude", CLAUDE_ARGS, { cwd: dir, input: line + "\n", timeout: 120_000 });
    if (r.code !== 0) { log(`autopilot: claude failed ${r.err.slice(0, 200)}`); return null; }
    const resultLine = r.out.split("\n").find((l) => l.includes('"type":"result"'));
    if (resultLine) {
      try {
        const obj = JSON.parse(resultLine);
        const u = obj.usage;
        if (u) log(`autopilot: ${Date.now() - started}ms, ${u.input_tokens ?? 0}+${u.cache_creation_input_tokens ?? 0} in, ${u.output_tokens ?? 0} out`);
        if (typeof obj.result === "string") log(`autopilot: result ${obj.result.slice(0, 300).replace(/\n/g, " ")}`);
      } catch {}
    }
    const s = parseResult(r.out);
    return s ? { app: w.app || "this app", ...s, pid: w.pid ?? 0, windowId: w.id } : null;
  }

  /** The card's "Put in reply box": brings the chat back and types the draft. It is NOT sent: the user presses Enter. */
  async insert(s: Suggestion) {
    if (!s.draft || !this.deps.input) return;
    this.deps.card.hide();
    const w = (await this.deps.desktop.windows().catch(() => [] as DesktopWindow[])).find((x) => x.id === s.windowId);
    if (w) await this.deps.desktop.focus(w).catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    await this.deps.input.type(s.draft.replace(/\n/g, " "));
  }

  /** What the card's "Copy" puts on the clipboard. */
  static copyText(s: Suggestion) { return s.draft ?? `${s.title}. ${s.detail}`; }

  /** The card hides after 20 s (45 s with a draft); hovering keeps it 5 s longer each time. */
  static hideAfter(s: Suggestion) { return s.draft == null ? 20 : 45; }
}

/** Seconds since the last input: GNOME's IdleMonitor (X11 and Wayland), else xprintidle on X11; null if neither works. */
export async function defaultIdleSeconds(): Promise<number | null> {
  const g = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Mutter.IdleMonitor", "--object-path",
    "/org/gnome/Mutter/IdleMonitor/Core", "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime"], { timeout: 2000 });
  const m = /uint64 (\d+)/.exec(g.out);
  if (g.code === 0 && m) return Number(m[1]) / 1000;
  if (process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    const x = await run("xprintidle", [], { timeout: 2000 });
    if (x.code === 0 && /^\d+/.test(x.out.trim())) return Number(x.out.trim()) / 1000;
  }
  return null;
}
