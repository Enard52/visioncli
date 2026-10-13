import type { InputInjector, Point } from "../../contracts";
import { log } from "../../log";
import type { WinHelper } from "../windows/win32";
import { LONG_TEXT } from "./clipboard";
import { type Chord, parseCombo } from "./keys";

// Windows: SendInput through the helper. Its events carry the helper's tag (dwExtraInfo), so its own low-level hooks
// drop them, like the macOS app tags its CGEvents. Long text is pasted and the clipboard put back, as on macOS.

const r = Math.round;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** X keysym names (keys.ts) → the helper's key names (Input.cs Keys). Letters, digits and F-keys are the same in lower
 *  case. The helper reads "delete" the macOS way (Backspace), so the Delete key is sent as "del". */
const WIN_KEYS: Record<string, string> = {
  Return: "enter", Tab: "tab", space: "space", BackSpace: "backspace", Delete: "del", Escape: "esc", Insert: "insert",
  Left: "left", Right: "right", Up: "up", Down: "down", Home: "home", End: "end", Prior: "pageup", Next: "pagedown",
  minus: "-", equal: "=", bracketleft: "[", bracketright: "]", semicolon: ";", apostrophe: "'", comma: ",", period: ".",
  slash: "/", backslash: "\\", grave: "`", plus: "plus",
};
const WIN_MODS = { super: "win", alt: "alt", ctrl: "ctrl", shift: "shift" } as const;

/** One chord → the helper's combo ("ctrl+shift+s", "win+d", "alt+f4"); Super is the Windows key, like on Linux. */
export function winCombo(c: Chord): string {
  const key = WIN_KEYS[c.key] ?? c.key.toLowerCase();
  return [...c.mods.map((m) => WIN_MODS[m]), key].join("+");
}

/** Wheel notches as the helper takes them: like CGEvent's values, dy > 0 scrolls up, dx > 0 scrolls left. */
export const winScroll = (dx: number, dy: number) => ({ dx: r(dx), dy: r(dy) });

export function createWin32Injector(helper: WinHelper): InputInjector {
  async function paste(text: string) {
    const saved = await helper.call("getClipboardText", {}).catch(() => null);
    await helper.call("setClipboardText", { text });
    await sleep(50);
    await helper.call("key", { combo: "ctrl+v" });
    setTimeout(() => {
      helper.call("setClipboardText", { text: saved ?? "" }).catch((e) => log(`clipboard restore: ${(e as Error).message}`));
    }, 600);
  }

  return {
    backend: "sendinput",
    move: async (p: Point) => { await helper.call("move", { x: r(p.x), y: r(p.y) }); },
    click: async (p, button, count) => { await helper.call("click", { x: r(p.x), y: r(p.y), button, count: Math.max(1, count) }); },
    async type(text) {
      if (!text) return;
      if (text.length > LONG_TEXT) return paste(text);
      await helper.call("type", { text });
    },
    async key(combo) {
      const chords = parseCombo(combo).map(winCombo); // throws "Unknown key …" before anything is pressed
      for (let i = 0; i < chords.length; i++) {
        if (i) await sleep(20);
        await helper.call("key", { combo: chords[i] });
      }
    },
    async scroll(dx, dy, at) {
      const s = winScroll(dx, dy);
      if (!s.dx && !s.dy) return;
      await helper.call("scroll", at ? { ...s, x: r(at.x), y: r(at.y) } : s);
    },
    drag: async (a, b) => { await helper.call("drag", { x1: r(a.x), y1: r(a.y), x2: r(b.x), y2: r(b.y) }); },
  };
}
