import { test } from "node:test";
import assert from "node:assert/strict";
import { charKeysym, keysym, parseCombo, wtypeArgs, xdotoolChord, ydotoolKeys } from "../../src/main/desktop/input/keys";
import { scrollButtons } from "../../src/main/desktop/input/x11";
import { locate } from "../../src/main/desktop/input/portal";
import { hasState } from "../../src/main/desktop/atspi/index";

test("macOS modifier names map to Linux ones", () => {
  assert.deepEqual(parseCombo("cmd+shift+s"), [{ mods: ["super", "shift"], key: "s" }]);
  assert.deepEqual(parseCombo("option+left"), [{ mods: ["alt"], key: "Left" }]);
  assert.deepEqual(parseCombo("opt+f4")[0].mods, ["alt"]);
  assert.deepEqual(parseCombo("⌘⌃".length ? "⌘+⌃+q" : "")[0], { mods: ["super", "ctrl"], key: "q" });
  assert.deepEqual(parseCombo("Control+A"), [{ mods: ["ctrl"], key: "a" }]);
});

test("named keys", () => {
  const k = (s: string) => parseCombo(s)[0].key;
  assert.equal(k("return"), "Return");
  assert.equal(k("enter"), "Return");
  assert.equal(k("esc"), "Escape");
  assert.equal(k("escape"), "Escape");
  assert.equal(k("tab"), "Tab");
  assert.equal(k("space"), "space");
  assert.equal(k("delete"), "BackSpace");
  assert.equal(k("backspace"), "BackSpace");
  assert.equal(k("forwarddelete"), "Delete");
  assert.equal(k("pageup"), "Prior");
  assert.equal(k("f12"), "F12");
  assert.equal(k("["), "bracketleft");
  assert.equal(k("ctrl++"), "plus");
});

test("sequences, spacing and errors", () => {
  assert.deepEqual(parseCombo("ctrl+shift+s enter").map(xdotoolChord), ["ctrl+shift+s", "Return"]);
  assert.deepEqual(parseCombo("cmd + v").map(xdotoolChord), ["super+v"]);
  assert.throws(() => parseCombo("ctrl+banana"), /Unknown key "banana"/);
  assert.throws(() => parseCombo("ctrl+shift"), /No key/);
  assert.throws(() => parseCombo("  "), /No key/);
});

test("keysyms are unicode-safe", () => {
  assert.equal(charKeysym("a"), 0x61);
  assert.equal(charKeysym("é"), 0xe9);
  assert.equal(charKeysym("€"), 0x010020ac);
  assert.equal(charKeysym("😀"), 0x0101f600);
  assert.equal(charKeysym("\n"), 0xff0d);
  assert.equal(keysym("Return"), 0xff0d);
  assert.equal(keysym("F1"), 0xffbe);
  assert.equal(keysym("F12"), 0xffc9);
  assert.equal(keysym("Delete"), 0xffff);
});

test("ydotool and wtype arguments", () => {
  assert.deepEqual(ydotoolKeys(parseCombo("ctrl+c")[0]), ["29:1", "46:1", "46:0", "29:0"]);
  assert.deepEqual(ydotoolKeys(parseCombo("cmd+shift+t")[0]), ["125:1", "42:1", "20:1", "20:0", "42:0", "125:0"]);
  assert.deepEqual(ydotoolKeys(parseCombo("return")[0]), ["28:1", "28:0"]);
  assert.deepEqual(wtypeArgs(parseCombo("cmd+alt+t")[0]), ["-M", "logo", "-M", "alt", "-k", "t", "-m", "alt", "-m", "logo"]);
});

test("scroll direction matches CGEvent (dy > 0 = up, dx > 0 = left)", () => {
  assert.deepEqual(scrollButtons(0, 3), [{ button: 4, count: 3 }]);
  assert.deepEqual(scrollButtons(0, -2), [{ button: 5, count: 2 }]);
  assert.deepEqual(scrollButtons(1, 0), [{ button: 6, count: 1 }]);
  assert.deepEqual(scrollButtons(-1, 0), [{ button: 7, count: 1 }]);
  assert.deepEqual(scrollButtons(0, 0), []);
});

test("portal streams: global point → stream-local", () => {
  const streams = [{ node: 1, x: 0, y: 0, w: 1920, h: 1080 }, { node: 2, x: 1920, y: 0, w: 1280, h: 1024 }];
  assert.deepEqual(locate(streams, { x: 2000, y: 10 }), { stream: streams[1], x: 80, y: 10 });
  assert.equal(locate(streams, { x: 5, y: 5 })!.stream.node, 1);
  assert.equal(locate([], { x: 5, y: 5 }), null);
});

test("AT-SPI state bits span two words", () => {
  assert.equal(hasState([1 << 1, 0], 1), true);   // ACTIVE
  assert.equal(hasState([1 << 25, 0], 25), true); // SHOWING
  assert.equal(hasState([0, 1 << 3], 35), true);
  assert.equal(hasState([0, 0], 12), false);
});
