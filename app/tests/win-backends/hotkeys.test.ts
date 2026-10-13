import assert from "node:assert/strict";
import { test } from "node:test";
import type { HotkeyEvent } from "../../src/main/contracts";
import { KEY } from "../../src/main/input/evdev";
import type { Clock } from "../../src/main/input/hold";
import { MASK_KEY, VK, WinHotkeys, vkToCode } from "../../src/main/input/win32";
import { fakeHelper, tick } from "./fake";

class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private ids = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.ids; this.timers.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(id: unknown) { this.timers = this.timers.filter((t) => t.id !== id); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

test("vkToCode: VK codes → the evdev codes HoldMachine expects", () => {
  assert.equal(vkToCode(VK.MENU), KEY.LEFTALT);
  assert.equal(vkToCode(VK.LMENU), KEY.LEFTALT);
  assert.equal(vkToCode(VK.RMENU), KEY.RIGHTALT);
  assert.equal(vkToCode(VK.LWIN), KEY.LEFTMETA);
  assert.equal(vkToCode(VK.RWIN), KEY.RIGHTMETA);
  assert.equal(vkToCode(VK.SHIFT), KEY.LEFTSHIFT);
  assert.equal(vkToCode(VK.LSHIFT), KEY.LEFTSHIFT);
  assert.equal(vkToCode(VK.RSHIFT), KEY.RIGHTSHIFT);
  assert.equal(vkToCode(VK.CONTROL), KEY.LEFTCTRL);
  assert.equal(vkToCode(VK.LCONTROL), KEY.LEFTCTRL);
  assert.equal(vkToCode(VK.RCONTROL), KEY.RIGHTCTRL);
  assert.equal(vkToCode(VK.SPACE), KEY.SPACE);
  assert.equal(vkToCode(VK.ESCAPE), KEY.ESC);
  assert.equal(vkToCode(VK.P), KEY.P);
  assert.equal(vkToCode(VK.O), KEY.O);
  assert.equal(vkToCode(VK.RETURN), KEY.ENTER);
  // Others (Tab, F4, letters) never collide with a code the machine knows.
  const known = new Set<number>(Object.values(KEY));
  for (const vk of [0x09, 0x73, 0x41, 0x1b + 1, 0xe8]) assert.ok(!known.has(vkToCode(vk)), `vk ${vk}`);
});

async function started(opts: { fail?: boolean } = {}) {
  const clock = new FakeClock();
  const h = fakeHelper({ "hooks.start": () => { if (opts.fail) throw new Error("SetWindowsHookEx failed"); return true; }, "hooks.stop": () => true, key: () => true });
  const hk = new WinHotkeys(h, clock);
  const events: HotkeyEvent[] = [];
  hk.on("hotkey", (e) => events.push(e));
  const info = await hk.start();
  const key = (vk: number, down: boolean) => h.emit("key", { vk, down, injected: false });
  return { clock, h, hk, events, info, key, types: () => events.map((e) => e.type) };
}

test("start: hooks.start → backend hook; a failure reports a problem", async () => {
  const ok = await started();
  assert.deepEqual(ok.info, { backend: "hook" });
  assert.equal(ok.hk.seesMotion, true);
  const bad = await started({ fail: true });
  assert.equal(bad.info.backend, "none");
  assert.match(bad.info.problem!, /SetWindowsHookEx/);
  assert.equal(bad.hk.seesMotion, false);
});

test("hold Alt: holdStart after 0.3 s, the menu mask is pressed while Alt is down, release → holdEnd", async () => {
  const s = await started();
  s.key(VK.LMENU, true);
  s.clock.advance(299);
  assert.deepEqual(s.types(), []);
  assert.equal(s.h.of("key").length, 0);
  s.clock.advance(1);
  assert.deepEqual(s.events, [{ type: "holdStart", screenshot: false }]);
  assert.deepEqual(s.h.of("key"), [{ combo: MASK_KEY }]);
  assert.equal(MASK_KEY, "vk:0xE8");
  s.key(VK.LMENU, true); // auto-repeat: ignored
  s.clock.advance(1000);
  s.key(VK.LMENU, false);
  assert.deepEqual(s.types(), ["holdStart", "holdEnd"]);
});

test("Alt+Win: screenshot hold; Win added later upgrades it and masks again (Start menu)", async () => {
  const a = await started();
  a.key(VK.LMENU, true); a.key(VK.LWIN, true);
  a.clock.advance(300);
  assert.deepEqual(a.events, [{ type: "holdStart", screenshot: true }]);
  const b = await started();
  b.key(VK.RMENU, true);
  b.clock.advance(300);
  b.key(VK.RWIN, true);
  assert.deepEqual(b.types(), ["holdStart", "screenshot"]);
  assert.equal(b.h.of("key").length, 2);
});

test("Alt+Tab: not a hold (no mask, so Windows' own Alt+Tab is untouched); a click while holding cancels", async () => {
  const s = await started();
  s.key(VK.LMENU, true); s.key(0x09, true); s.key(0x09, false);
  s.clock.advance(1000);
  s.key(VK.LMENU, false);
  assert.deepEqual(s.types(), []);
  assert.equal(s.h.of("key").length, 0);
  s.key(VK.LMENU, true);
  s.clock.advance(300);
  s.h.emit("button", { button: "left", down: true });
  assert.deepEqual(s.types(), ["holdStart", "holdCancel"]);
});

test("a quick hold is a tap; Alt+Shift+Space is point mode; Esc / Alt+P are overlay keys while on", async () => {
  const s = await started();
  s.key(VK.LMENU, true); s.clock.advance(320); s.key(VK.LMENU, false);
  assert.deepEqual(s.types(), ["holdStart", "tap"]);
  // Tap mode: the next Alt press counts at once.
  s.events.length = 0;
  s.key(VK.LMENU, true);
  assert.deepEqual(s.types(), ["holdStart"]);
  s.key(VK.LMENU, false);
  s.events.length = 0;
  s.key(VK.LSHIFT, true); s.key(VK.LMENU, true); s.key(VK.SPACE, true);
  assert.deepEqual(s.types(), ["pointMode"]);
  const o = await started();
  o.hk.setOverlayKeys(true);
  o.key(VK.ESCAPE, true); o.key(VK.ESCAPE, false);
  o.key(VK.LMENU, true); o.key(VK.P, true);
  assert.deepEqual(o.events, [{ type: "overlayKey", key: "esc" }, { type: "overlayKey", key: "pin" }]);
});

test("Ctrl+Alt (AltGr) never starts a hold", async () => {
  const s = await started();
  s.key(VK.LCONTROL, true); s.key(VK.RMENU, true);
  s.clock.advance(1000);
  assert.deepEqual(s.types(), []);
});

test("motion events set lastMotion; after stop() keys are ignored and hooks.stop is sent", async () => {
  const s = await started();
  assert.equal(s.hk.lastMotion, 0);
  s.h.emit("motion", { x: 1, y: 2 });
  assert.ok(Date.now() - s.hk.lastMotion < 1000);
  s.hk.stop();
  await tick();
  assert.equal(s.h.of("hooks.stop").length, 1);
  s.key(VK.LMENU, true);
  s.clock.advance(1000);
  assert.deepEqual(s.types(), []);
  // start again (Setup restarts the hotkeys): one subscription, events flow again.
  await s.hk.start();
  s.key(VK.LMENU, true);
  s.clock.advance(300);
  assert.deepEqual(s.types(), ["holdStart"]);
});
