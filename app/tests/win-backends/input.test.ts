import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCombo } from "../../src/main/desktop/input/keys";
import { createWin32Injector, winCombo, winScroll } from "../../src/main/desktop/input/win32";
import { Uia } from "../../src/main/desktop/uia";
import { fakeHelper, tick } from "./fake";

const combos = (s: string) => parseCombo(s).map(winCombo);

test("winCombo: macOS/Linux names → the helper's (Super is the Windows key)", () => {
  assert.deepEqual(combos("cmd+shift+s"), ["win+shift+s"]);
  assert.deepEqual(combos("ctrl+c"), ["ctrl+c"]);
  assert.deepEqual(combos("option+left"), ["alt+left"]);
  assert.deepEqual(combos("return"), ["enter"]);
  assert.deepEqual(combos("escape tab space backspace forwarddelete"), ["esc", "tab", "space", "backspace", "del"]);
  assert.deepEqual(combos("pageup pagedown home end insert"), ["pageup", "pagedown", "home", "end", "insert"]);
  assert.deepEqual(combos("alt+F4 f12"), ["alt+f4", "f12"]);
  assert.deepEqual(combos("ctrl+- ctrl+= ctrl+[ ctrl+/ ctrl+\\ ctrl+`"), ["ctrl+-", "ctrl+=", "ctrl+[", "ctrl+/", "ctrl+\\", "ctrl+`"]);
  assert.deepEqual(combos("ctrl++"), ["ctrl+plus"]);
  assert.deepEqual(combos("win+d"), ["win+d"]);
});

test("winScroll: whole notches, signs kept (dy > 0 up, dx > 0 left)", () => {
  assert.deepEqual(winScroll(0, 3.4), { dx: 0, dy: 3 });
  assert.deepEqual(winScroll(-1.6, -2), { dx: -2, dy: -2 });
});

function injector() {
  let clip: string | null = "saved";
  const h = fakeHelper({
    move: () => true, click: () => true, type: () => true, key: () => true, scroll: () => true, drag: () => true,
    getClipboardText: () => clip ?? "", setClipboardText: (p) => { clip = p.text; return true; },
  });
  return { h, inj: createWin32Injector(h), clip: () => clip };
}

test("move / click / drag: rounded pixels to the helper", async () => {
  const { h, inj } = injector();
  assert.equal(inj.backend, "sendinput");
  await inj.move({ x: 10.6, y: 20.2 });
  await inj.click({ x: 1.5, y: 2.4 }, "right", 2);
  await inj.click({ x: 0, y: 0 }, "left", 0);
  await inj.drag({ x: 1.2, y: 2 }, { x: 300.7, y: 400 });
  assert.deepEqual(h.of("move"), [{ x: 11, y: 20 }]);
  assert.deepEqual(h.of("click"), [{ x: 2, y: 2, button: "right", count: 2 }, { x: 0, y: 0, button: "left", count: 1 }]);
  assert.deepEqual(h.of("drag"), [{ x1: 1, y1: 2, x2: 301, y2: 400 }]);
});

test("scroll: at a point or where the pointer is; nothing for zero", async () => {
  const { h, inj } = injector();
  await inj.scroll(0, -3, { x: 100.2, y: 50 });
  await inj.scroll(2, 0);
  await inj.scroll(0.2, 0.1);
  assert.deepEqual(h.of("scroll"), [{ dx: 0, dy: -3, x: 100, y: 50 }, { dx: 2, dy: 0 }]);
});

test("key: one helper call per chord, in order; an unknown key presses nothing", async () => {
  const { h, inj } = injector();
  await inj.key("ctrl+a delete");
  assert.deepEqual(h.of("key"), [{ combo: "ctrl+a" }, { combo: "backspace" }]); // macOS "delete" is Backspace
  await assert.rejects(inj.key("ctrl+a bogus"), /Unknown key "bogus"/);
  assert.equal(h.of("key").length, 2);
});

test("type: short text is typed; long text is pasted and the clipboard put back after 0.6 s", async () => {
  const { h, inj, clip } = injector();
  await inj.type("");
  await inj.type("héllo 👋");
  assert.deepEqual(h.of("type"), [{ text: "héllo 👋" }]);
  const long = "x".repeat(301);
  await inj.type(long);
  assert.equal(h.of("type").length, 1);
  assert.deepEqual(h.of("setClipboardText")[0], { text: long });
  assert.deepEqual(h.of("key"), [{ combo: "ctrl+v" }]);
  assert.equal(clip(), long);
  await tick(700);
  assert.equal(clip(), "saved");
});

test("Uia: elements/press/setValue/isSecure/windowText go to the helper; failures are false/null", async () => {
  const h = fakeHelper({
    hello: () => ({ version: "1", dpiAware: true, arch: "x64" }),
    elements: () => ({ app: "Notepad", elements: [{ id: 1, role: "Button", label: "  Save\n now ", x: 1, y: 2, w: 3, h: 4 }] }),
    press: (p) => p.id === 1,
    setValue: () => true,
    isSecure: (p) => p.id === 2 || p.x === 9 || !!p.focused,
    windowText: (p) => ({ app: "Notepad", title: "a.txt", text: "y".repeat(p.max + 10) }),
  });
  const ax = new Uia(h, 4242);
  assert.equal(await ax.available(), true);
  assert.deepEqual(await ax.elements(), { app: "Notepad", elements: [{ id: 1, role: "Button", label: "Save now", x: 1, y: 2, w: 3, h: 4 }] });
  await ax.elements("Chrome");
  assert.deepEqual(h.of("elements"), [{ excludePid: 4242 }, { app: "Chrome", excludePid: 4242 }]);
  assert.equal(await ax.press(1), true);
  assert.equal(await ax.press(5), false);
  assert.equal(await ax.setValue(1, "hi"), true);
  assert.deepEqual(h.of("setValue"), [{ id: 1, text: "hi" }]);
  assert.equal(await ax.isSecure({ id: 2 }), true);
  assert.equal(await ax.isSecure({ at: { x: 9.2, y: 1 } }), true);
  assert.deepEqual(h.of("isSecure")[1], { x: 9, y: 1 });
  assert.equal(await ax.isSecure({ focused: true }), true);
  assert.equal(await ax.isSecure({}), false);
  const t = await ax.windowText(50);
  assert.equal(t?.text.length, 50);
  assert.deepEqual(h.of("windowText"), [{ max: 50, excludePid: 4242 }]);

  const dead = new Uia(fakeHelper({}), 1);
  assert.equal(await dead.available(), false);
  assert.equal(await dead.press(1), false);
  assert.equal(await dead.setValue(1, "x"), false);
  assert.equal(await dead.isSecure({ focused: true }), false);
  assert.equal(await dead.windowText(10), null);
  await assert.rejects(dead.elements());
});
