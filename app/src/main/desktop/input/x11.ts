import type { InputInjector, Point } from "../../contracts";
import { LONG_TEXT, canPaste, pasteText } from "./clipboard";
import { UTF8_ENV, run } from "./exec";
import { parseCombo, xdotoolChord } from "./keys";

// X11: XTest through xdotool (one process per action; its commands chain, so a whole drag is one call).
// XTest events can't carry a tag. They do arrive from the "Virtual core XTEST pointer/keyboard" slave devices, which
// an XInput2 listener can see in the event's sourceid (see SYNTHETIC_DEVICES in index.ts).

const xdo = (args: (string | number)[]) => run("xdotool", args.map(String), { env: UTF8_ENV }).then(() => {});
const r = Math.round;

// Scroll: buttons 4 up, 5 down, 6 left, 7 right. Like CGEvent's wheel values: dy > 0 = up, dx > 0 = left.
export function scrollButtons(dx: number, dy: number): { button: number; count: number }[] {
  const out: { button: number; count: number }[] = [];
  if (dy) out.push({ button: dy > 0 ? 4 : 5, count: Math.abs(r(dy)) });
  if (dx) out.push({ button: dx > 0 ? 6 : 7, count: Math.abs(r(dx)) });
  return out.filter((b) => b.count > 0);
}

export function createX11Injector(): InputInjector {
  return {
    backend: "xtest",
    move: (p: Point) => xdo(["mousemove", r(p.x), r(p.y)]),
    click: (p, button, count) =>
      xdo(["mousemove", r(p.x), r(p.y), "sleep", 0.04, "click", "--repeat", Math.max(1, count), "--delay", 90, button === "right" ? 3 : 1]),
    async type(text) {
      if (!text) return;
      if (text.length > LONG_TEXT && canPaste()) return pasteText(text, () => xdo(["key", "--clearmodifiers", "ctrl+v"]));
      // xdotool maps each character to a keysym (remapping a spare keycode for ones the layout lacks): any layout, any script.
      await xdo(["type", "--clearmodifiers", "--delay", 8, "--", text]);
    },
    async key(combo) {
      const chords = parseCombo(combo).map(xdotoolChord);
      await xdo(["key", "--clearmodifiers", "--delay", 20, ...chords]);
    },
    async scroll(dx, dy, at) {
      const args: (string | number)[] = at ? ["mousemove", r(at.x), r(at.y), "sleep", 0.04] : [];
      for (const b of scrollButtons(dx, dy)) args.push("click", "--repeat", b.count, "--delay", 10, b.button);
      if (args.length) await xdo(args);
    },
    async drag(a, b) {
      const args: (string | number)[] = ["mousemove", r(a.x), r(a.y), "sleep", 0.05, "mousedown", 1];
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        args.push("mousemove", r(a.x + (b.x - a.x) * t), r(a.y + (b.y - a.y) * t), "sleep", 0.012);
      }
      args.push("mouseup", 1);
      await xdo(args);
    },
  };
}
