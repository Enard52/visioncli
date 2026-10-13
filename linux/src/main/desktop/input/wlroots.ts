import { existsSync } from "node:fs";
import type { InputInjector, Point } from "../../contracts";
import { LONG_TEXT, canPaste, pasteText } from "./clipboard";
import { UTF8_ENV, run, sleep, which } from "./exec";
import { type Chord, parseCombo, wtypeArgs, ydotoolKeys } from "./keys";

// Wayland compositors without a RemoteDesktop portal (Sway, Hyprland, other wlroots ones), from what's installed:
//   pointer:  Sway's own `swaymsg seat - cursor …` (no setup) · Hyprland `hyprctl dispatch movecursor` + ydotool
//             buttons · ydotool (needs ydotoold running and access to /dev/uinput, i.e. the `input` group)
//   keyboard: wtype (virtual-keyboard protocol: Unicode-safe, any layout) · else ydotool (US layout, ASCII only)
// ydotool's events come from a uinput device named "ydotoold virtual device": the evdev hotkey listener must skip it
// (SYNTHETIC_DEVICES in index.ts). swaymsg and wtype events never reach /dev/input.

const r = Math.round;

export function ydotoolSocket(): string | null {
  const uid = process.getuid?.() ?? 0;
  for (const p of [process.env.YDOTOOL_SOCKET, `/run/user/${uid}/.ydotool_socket`, "/tmp/.ydotool_socket"]) if (p && existsSync(p)) return p;
  return null;
}

interface Pointer {
  name: string;
  move(p: Point): Promise<void>;
  button(b: "left" | "right", down: boolean): Promise<void>;
  wheel(dx: number, dy: number): Promise<void>;   // CGEvent sense: dy > 0 = up, dx > 0 = left
}
interface Keyboard { name: string; text(s: string): Promise<void>; chord(c: Chord): Promise<void>; paste: boolean }

const sway = (...args: (string | number)[]) => run("swaymsg", ["seat", "-", "cursor", ...args.map(String)]).then(() => {});
const ydo = (...args: (string | number)[]) => run("ydotool", args.map(String), { env: UTF8_ENV }).then(() => {});

function swayPointer(): Pointer {
  return {
    name: "swaymsg",
    move: (p) => sway("set", r(p.x), r(p.y)),
    button: (b, down) => sway(down ? "press" : "release", b === "right" ? "button3" : "button1"),
    async wheel(dx, dy) {
      // Sway turns buttons 4–7 into axis events: 4 up, 5 down, 6 left, 7 right.
      const presses = [...Array(Math.abs(r(dy))).fill(dy > 0 ? "button4" : "button5"), ...Array(Math.abs(r(dx))).fill(dx > 0 ? "button6" : "button7")];
      for (const b of presses) { await sway("press", b); await sway("release", b); }
    },
  };
}

function ydotoolPointer(moveWith?: (p: Point) => Promise<void>): Pointer {
  return {
    name: moveWith ? "hyprctl+ydotool" : "ydotool",
    // --absolute warps to 0,0 then moves; works when pointer acceleration doesn't apply to uinput (the libinput default for
    // absolute moves on most setups).
    move: moveWith ?? ((p) => ydo("mousemove", "--absolute", "-x", r(p.x), "-y", r(p.y))),
    button: (b, down) => ydo("click", "0x" + ((b === "right" ? 0x01 : 0x00) | (down ? 0x40 : 0x80)).toString(16)),
    // REL_WHEEL > 0 = up, REL_HWHEEL > 0 = right.
    wheel: (dx, dy) => ydo("mousemove", "--wheel", "-x", -r(dx), "-y", r(dy)),
  };
}

// wtype sends its own keymap with every run. Text always lands, but GTK 3 matches key *bindings* (BackSpace, Ctrl+A,
// Ctrl+V) against the keymap it had before, so wtype's chords are unreliable there (terminals, Qt, Chromium are fine).
// So: chords through ydotool when its daemon runs (real keycodes, the user's keymap), and long text typed by wtype
// instead of pasted with a Ctrl+V that GTK 3 might miss.
function wtypeKeyboard(ydotool: boolean): Keyboard {
  return {
    name: ydotool ? "wtype+ydotool" : "wtype",
    // libxkbcommon turns "\n" into Linefeed, which apps ignore; "\r" is Return.
    text: (s) => run("wtype", ["-d", s.length > LONG_TEXT ? "2" : "8", "--", s.replace(/\r?\n/g, "\r")], { env: UTF8_ENV, timeout: 60_000 }).then(() => {}),
    chord: (c) => (ydotool ? ydo("key", ...ydotoolKeys(c)) : run("wtype", wtypeArgs(c)).then(() => {})),
    paste: false,
  };
}

// ydotool types by US-layout keycodes, so only ASCII; anything else goes through the clipboard and Ctrl+V.
function ydotoolKeyboard(): Keyboard {
  return {
    name: "ydotool",
    text: (s) => ydo("type", "--key-delay", 8, "--", s),
    chord: (c) => ydo("key", ...ydotoolKeys(c)),
    paste: true,
  };
}

/** The best pointer + keyboard this Wayland session offers without the portal, or null when there's nothing. */
export function createWlrootsInjector(): InputInjector | null {
  const ydotool = !!which("ydotool") && !!ydotoolSocket();
  let pointer: Pointer | null = null;
  if (process.env.SWAYSOCK && which("swaymsg")) pointer = swayPointer();
  else if (process.env.HYPRLAND_INSTANCE_SIGNATURE && which("hyprctl") && ydotool)
    pointer = ydotoolPointer((p) => run("hyprctl", ["dispatch", "movecursor", String(r(p.x)), String(r(p.y))]).then(() => {}));
  else if (ydotool) pointer = ydotoolPointer();
  const keyboard = which("wtype") ? wtypeKeyboard(ydotool) : ydotool ? ydotoolKeyboard() : null;
  if (!pointer && !keyboard) return null;

  const needPointer = () => { if (!pointer) throw new Error("No way to move the pointer here: install ydotool and start ydotoold"); return pointer; };
  const needKeyboard = () => { if (!keyboard) throw new Error("No way to type here: install wtype (or ydotool)"); return keyboard; };

  return {
    backend: [pointer?.name, keyboard?.name].filter(Boolean).join("+"),
    move: (p) => needPointer().move(p),
    async click(p, button, count) {
      const ptr = needPointer();
      await ptr.move(p);
      await sleep(40);
      for (let i = 0; i < Math.max(1, count); i++) {
        await ptr.button(button, true);
        await sleep(30);
        await ptr.button(button, false);
        await sleep(60);
      }
    },
    async type(text) {
      const kb = needKeyboard();
      if (kb.paste && (text.length > LONG_TEXT || /[^\x00-\x7f]/.test(text)) && canPaste()) return pasteText(text, () => kb.chord({ mods: ["ctrl"], key: "v" }));
      if (text) await kb.text(text);
    },
    async key(combo) {
      const kb = needKeyboard();
      for (const c of parseCombo(combo)) { await kb.chord(c); await sleep(20); }
    },
    async scroll(dx, dy, at) {
      const ptr = needPointer();
      if (at) { await ptr.move(at); await sleep(40); }
      await ptr.wheel(dx, dy);
    },
    async drag(a, b) {
      const ptr = needPointer();
      await ptr.move(a);
      await sleep(50);
      await ptr.button("left", true);
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        await ptr.move({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        await sleep(12);
      }
      await ptr.button("left", false);
    },
  };
}
