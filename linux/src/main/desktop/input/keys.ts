// Key combos in the macOS app's names ("cmd+shift+s", "option+left", "return") → the names each Linux backend wants:
// X keysym names (xdotool), keysym numbers (RemoteDesktop portal), evdev key codes (ydotool), wtype names.
// Same vocabulary as Computer.press in Control.swift; ⌘ Command → Super, ⌥ Option → Alt, ⌃ Control → Ctrl.

export type Mod = "super" | "alt" | "ctrl" | "shift";
export interface Chord { mods: Mod[]; key: string }  // key: an X keysym name ("Return", "a", "F5", "bracketleft")

const MODS: Record<string, Mod> = {
  cmd: "super", command: "super", "⌘": "super", super: "super", win: "super", meta: "super",
  alt: "alt", option: "alt", opt: "alt", "⌥": "alt",
  ctrl: "ctrl", control: "ctrl", "⌃": "ctrl",
  shift: "shift", "⇧": "shift",
};

const NAMED: Record<string, string> = {
  return: "Return", enter: "Return", tab: "Tab", space: "space", delete: "BackSpace", backspace: "BackSpace",
  forwarddelete: "Delete", del: "Delete", escape: "Escape", esc: "Escape", insert: "Insert",
  left: "Left", right: "Right", up: "Up", down: "Down", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", ";": "semicolon", "'": "apostrophe", ",": "comma",
  ".": "period", "/": "slash", "\\": "backslash", "`": "grave",
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = `F${i}`;
for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") NAMED[c] = c;

/** "ctrl+shift+s enter" → one Chord per space-separated combo. Throws "Unknown key …" / "No key in …" like Computer.press. */
export function parseCombo(combo: string): Chord[] {
  const s = combo.trim().toLowerCase().replace(/\s*\+\s*/g, "+");
  if (!s) throw new Error(`No key in "${combo}"`);
  return s.split(/\s+/).map((part) => {
    const mods: Mod[] = [];
    let key: string | undefined;
    // "+" alone or as the last part means the plus key ("ctrl++").
    const parts = part === "+" ? ["plus"] : part.endsWith("++") ? [...part.slice(0, -2).split("+"), "plus"] : part.split("+");
    for (const p of parts) {
      if (MODS[p]) { if (!mods.includes(MODS[p])) mods.push(MODS[p]); continue; }
      if (p === "fn") continue; // no Linux equivalent; the key itself still works
      const k = p === "plus" ? "plus" : NAMED[p];
      if (!k) throw new Error(`Unknown key "${p}"`);
      key = k;
    }
    if (!key) throw new Error(`No key in "${combo}"`);
    return { mods, key };
  });
}

// ── xdotool ──
export const xdotoolChord = (c: Chord) => [...c.mods, c.key].join("+");

// ── keysyms (portal NotifyKeyboardKeysym) ──
const KEYSYMS: Record<string, number> = {
  Return: 0xff0d, Tab: 0xff09, space: 0x20, BackSpace: 0xff08, Delete: 0xffff, Escape: 0xff1b, Insert: 0xff63,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Home: 0xff50, End: 0xff57, Prior: 0xff55, Next: 0xff56,
  minus: 0x2d, equal: 0x3d, bracketleft: 0x5b, bracketright: 0x5d, semicolon: 0x3b, apostrophe: 0x27, comma: 0x2c,
  period: 0x2e, slash: 0x2f, backslash: 0x5c, grave: 0x60, plus: 0x2b,
};
for (let i = 1; i <= 12; i++) KEYSYMS[`F${i}`] = 0xffbe + i - 1;
export const MOD_KEYSYMS: Record<Mod, number> = { super: 0xffeb, alt: 0xffe9, ctrl: 0xffe3, shift: 0xffe1 };

export function keysym(name: string): number {
  if (KEYSYMS[name] !== undefined) return KEYSYMS[name];
  if (name.length === 1) return charKeysym(name);
  throw new Error(`Unknown key "${name}"`);
}

/** The keysym for one character: Latin-1 maps directly, everything else is 0x01000000 + code point (X11 rule). */
export function charKeysym(ch: string): number {
  if (ch === "\n" || ch === "\r") return 0xff0d;
  if (ch === "\t") return 0xff09;
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x01000000 + cp;
}

// ── evdev codes (ydotool key) ──
const EVDEV: Record<string, number> = {
  Escape: 1, minus: 12, equal: 13, BackSpace: 14, Tab: 15, bracketleft: 26, bracketright: 27, Return: 28, semicolon: 39,
  apostrophe: 40, grave: 41, backslash: 43, comma: 51, period: 52, slash: 53, space: 57,
  Home: 102, Up: 103, Prior: 104, Left: 105, Right: 106, End: 107, Down: 108, Next: 109, Insert: 110, Delete: 111,
  F11: 87, F12: 88,
};
"1234567890".split("").forEach((c, i) => (EVDEV[c] = 2 + i));
"qwertyuiop".split("").forEach((c, i) => (EVDEV[c] = 16 + i));
"asdfghjkl".split("").forEach((c, i) => (EVDEV[c] = 30 + i));
"zxcvbnm".split("").forEach((c, i) => (EVDEV[c] = 44 + i));
for (let i = 1; i <= 10; i++) EVDEV[`F${i}`] = 58 + i;
export const MOD_EVDEV: Record<Mod, number> = { super: 125, alt: 56, ctrl: 29, shift: 42 };

/** ydotool key arguments: "29:1 46:1 46:0 29:0". Keycodes are layout-independent positions (US layout assumed). */
export function ydotoolKeys(c: Chord): string[] {
  const code = c.key === "plus" ? EVDEV.equal : EVDEV[c.key];
  if (code === undefined) throw new Error(`Unknown key "${c.key}"`);
  const mods = c.key === "plus" && !c.mods.includes("shift") ? [...c.mods, "shift" as Mod] : c.mods;
  const m = mods.map((x) => MOD_EVDEV[x]);
  return [...m.map((k) => `${k}:1`), `${code}:1`, `${code}:0`, ...m.reverse().map((k) => `${k}:0`)];
}

// ── wtype ──
const WTYPE_MOD: Record<Mod, string> = { super: "logo", alt: "alt", ctrl: "ctrl", shift: "shift" };
/** wtype arguments: -M ctrl -k c -m ctrl. */
export function wtypeArgs(c: Chord): string[] {
  const args: string[] = [];
  for (const m of c.mods) args.push("-M", WTYPE_MOD[m]);
  args.push("-k", c.key);
  for (const m of [...c.mods].reverse()) args.push("-m", WTYPE_MOD[m]);
  return args;
}
