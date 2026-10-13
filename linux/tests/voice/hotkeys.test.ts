import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HotkeyEvent } from "../../src/main/contracts";
import { EV_KEY, EV_REL, EV_SYN, KEY, REL_WHEEL, encodeEvents, eventSize, hasBit, parseEvents, parseProcDevices, type InputEvent } from "../../src/main/input/evdev";
import { HoldMachine, type Clock } from "../../src/main/input/hold";
import { XI2Parser, feedEvent, parseXTestIds } from "../../src/main/input/index";

/** A manual clock: timers fire as time is advanced. */
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

function setup() {
  const clock = new FakeClock();
  const events: HotkeyEvent[] = [];
  const m = new HoldMachine((e) => events.push(e), clock);
  const down = new Set<number>();
  const press = (code: number) => feedEvent(m, down, EV_KEY, code, 1);
  const release = (code: number) => feedEvent(m, down, EV_KEY, code, 0);
  const types = () => events.map((e) => e.type);
  return { clock, events, m, press, release, types, down };
}

describe("evdev parsing", () => {
  it("reads 24-byte events (64-bit time)", () => {
    const buf = encodeEvents([{ sec: 1700000000, usec: 123456, type: EV_KEY, code: KEY.LEFTALT, value: 1 }, { type: EV_SYN }], 24);
    assert.equal(buf.length, 48);
    const { events, rest } = parseEvents(buf, 24);
    assert.equal(rest.length, 0);
    assert.deepEqual(events[0], { sec: 1700000000, usec: 123456, type: EV_KEY, code: 56, value: 1 });
    assert.equal(events[1].type, EV_SYN);
  });

  it("reads 16-byte events (32-bit time) and negative values", () => {
    const buf = encodeEvents([{ sec: 5, usec: 6, type: EV_REL, code: REL_WHEEL, value: -1 }], 16);
    assert.deepEqual(parseEvents(buf, 16).events, [{ sec: 5, usec: 6, type: EV_REL, code: REL_WHEEL, value: -1 }]);
  });

  it("keeps a partial event for the next read", () => {
    const buf = encodeEvents([{ type: EV_KEY, code: 30, value: 1 }, { type: EV_KEY, code: 30, value: 0 }], 24);
    const a = parseEvents(buf.subarray(0, 30), 24);
    assert.equal(a.events.length, 1);
    assert.equal(a.rest.length, 6);
    const b = parseEvents(Buffer.concat([a.rest, buf.subarray(30)]), 24);
    assert.deepEqual(b.events.map((e) => e.value), [0]);
  });

  it("picks the event size from the architecture", () => {
    assert.equal(eventSize("x64"), 24);
    assert.equal(eventSize("arm64"), 24);
    assert.equal(eventSize("arm"), 16);
    assert.equal(eventSize("ia32"), 16);
  });

  it("finds keyboards and pointers in /proc/bus/input/devices", () => {
    const proc = `I: Bus=0011 Vendor=0001 Product=0001 Version=ab41
N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd event3 leds
B: EV=120013
B: KEY=402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe

I: Bus=0003 Vendor=046d Product=c52b Version=0111
N: Name="Logitech USB Receiver Mouse"
H: Handlers=mouse0 event5
B: EV=17
B: KEY=ffff0000 0 0 0 0

I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
H: Handlers=kbd event0
B: EV=3
B: KEY=10000000000000 0
`;
    const devs = parseProcDevices(proc, 64);
    assert.deepEqual(devs.map((d) => [d.event, d.keyboard, d.pointer]), [["event3", true, false], ["event5", false, true]]);
    assert.equal(hasBit("ffff0000 0 0 0 0", 0x110, 64), true);
    assert.equal(hasBit("1", 0, 32), true);
  });
});

describe("hold-to-talk (ModifierHold semantics)", () => {
  it("Alt held 0.3 s starts listening; letting go after 0.35 s ends it", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.clock.advance(299);
    assert.deepEqual(s.types(), []);
    s.clock.advance(1);
    assert.deepEqual(s.events, [{ type: "holdStart", screenshot: false }]);
    s.clock.advance(1000);
    s.release(KEY.LEFTALT);
    assert.deepEqual(s.types(), ["holdStart", "holdEnd"]);
  });

  it("a quick Alt tap (under 0.3 s) does nothing", () => {
    const s = setup();
    s.press(KEY.RIGHTALT);
    s.clock.advance(150);
    s.release(KEY.RIGHTALT);
    s.clock.advance(1000);
    assert.deepEqual(s.types(), []);
  });

  it("released within 0.35 s of starting is a tap; the next press then counts at once", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.clock.advance(400);
    s.release(KEY.LEFTALT);
    assert.deepEqual(s.types(), ["holdStart", "tap"]);
    s.clock.advance(5000);
    s.press(KEY.LEFTALT); // no 0.3 s wait in tap mode
    assert.deepEqual(s.types(), ["holdStart", "tap", "holdStart"]);
    s.clock.advance(80);
    s.release(KEY.LEFTALT); // the sending press is never a new tap
    assert.deepEqual(s.types(), ["holdStart", "tap", "holdStart", "holdEnd"]);
    s.press(KEY.LEFTALT);
    assert.deepEqual(s.types().length, 4); // back to the 0.3 s wait
  });

  it("the app's listening state overrides the tap-mode guess", () => {
    const s = setup();
    s.m.listening = true;
    s.press(KEY.LEFTALT);
    assert.deepEqual(s.types(), ["holdStart"]);
  });

  it("Alt+Super asks with a screenshot; Super added later upgrades", () => {
    const s = setup();
    s.press(KEY.LEFTMETA);
    s.press(KEY.LEFTALT);
    s.clock.advance(300);
    assert.deepEqual(s.events, [{ type: "holdStart", screenshot: true }]);
    s.release(KEY.LEFTMETA);
    s.clock.advance(500);
    assert.equal(s.events.length, 1); // letting go of Super alone doesn't end it
    s.release(KEY.LEFTALT);
    assert.deepEqual(s.types(), ["holdStart", "holdEnd"]);

    const t = setup();
    t.press(KEY.LEFTALT);
    t.clock.advance(300);
    t.press(KEY.RIGHTMETA);
    assert.deepEqual(t.types(), ["holdStart", "screenshot"]);
  });

  it("Alt+Tab before 0.3 s is just a shortcut; after it, it cancels", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.clock.advance(100);
    s.press(15); // Tab
    s.clock.advance(1000);
    assert.deepEqual(s.types(), []);
    s.release(15);
    s.release(KEY.LEFTALT);

    const t = setup();
    t.press(KEY.LEFTALT);
    t.clock.advance(500);
    t.press(15);
    t.release(15);
    t.release(KEY.LEFTALT);
    assert.deepEqual(t.types(), ["holdStart", "holdCancel"]);
  });

  it("a click while holding cancels; a scroll only stops a pending hold", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.clock.advance(500);
    feedEvent(s.m, s.down, EV_REL, REL_WHEEL, 1);
    assert.deepEqual(s.types(), ["holdStart"]);
    feedEvent(s.m, s.down, EV_KEY, 0x110, 1); // BTN_LEFT
    assert.deepEqual(s.types(), ["holdStart", "holdCancel"]);

    const t = setup();
    t.press(KEY.LEFTALT);
    feedEvent(t.m, t.down, EV_REL, REL_WHEEL, -1);
    t.clock.advance(500);
    assert.deepEqual(t.types(), []);
  });

  it("Ctrl or Shift with Alt isn't a hold", () => {
    const s = setup();
    s.press(KEY.LEFTCTRL);
    s.press(KEY.LEFTALT);
    s.clock.advance(1000);
    assert.deepEqual(s.types(), []);
  });

  it("Alt+Shift+Space is point mode; clicks are the drag; letting go of Space ends it", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.press(KEY.LEFTSHIFT);
    s.press(KEY.SPACE);
    assert.deepEqual(s.types(), ["pointMode"]);
    feedEvent(s.m, s.down, EV_KEY, 0x110, 1);
    s.clock.advance(2000);
    s.release(KEY.SPACE);
    assert.deepEqual(s.types(), ["pointMode", "holdEnd"]);
    s.release(KEY.LEFTSHIFT);
    s.release(KEY.LEFTALT);
    assert.deepEqual(s.types(), ["pointMode", "holdEnd"]);
  });

  it("overlay keys only while they're on", () => {
    const s = setup();
    s.press(KEY.ESC); s.release(KEY.ESC);
    assert.deepEqual(s.types(), []);
    s.m.overlayKeys = true;
    s.press(KEY.ESC); s.release(KEY.ESC);
    s.press(KEY.LEFTALT);
    s.press(KEY.P); s.release(KEY.P);
    s.press(KEY.O); s.release(KEY.O);
    s.press(KEY.ENTER); s.release(KEY.ENTER);
    s.release(KEY.LEFTALT);
    s.clock.advance(1000);
    assert.deepEqual(s.events, [
      { type: "overlayKey", key: "esc" }, { type: "overlayKey", key: "pin" }, { type: "overlayKey", key: "open" }, { type: "overlayKey", key: "allow" },
    ]);
  });

  it("key repeats and a second keyboard's duplicate presses are ignored", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.clock.advance(400);
    feedEvent(s.m, s.down, EV_KEY, KEY.LEFTALT, 2);
    feedEvent(s.m, s.down, EV_KEY, KEY.LEFTALT, 2);
    s.clock.advance(400);
    s.release(KEY.LEFTALT);
    assert.deepEqual(s.types(), ["holdStart", "holdEnd"]);
  });
});

describe("replay", () => {
  it("a recorded evdev byte stream, cut into odd reads, drives the same events", () => {
    const s = setup();
    // Alt down; 0.5 s later Super down (upgrade); 1.5 s Alt up. Repeats and SYN reports in between, as the kernel sends.
    const timeline: [number, Partial<InputEvent>[]][] = [
      [0, [{ type: 4, code: 4, value: 56 }, { type: EV_KEY, code: KEY.LEFTALT, value: 1 }, { type: EV_SYN }]],
      [500, [{ type: EV_KEY, code: KEY.LEFTALT, value: 2 }, { type: EV_SYN }]],
      [520, [{ type: EV_KEY, code: KEY.LEFTMETA, value: 1 }, { type: EV_SYN }]],
      [1500, [{ type: EV_KEY, code: KEY.LEFTALT, value: 0 }, { type: EV_SYN }, { type: EV_KEY, code: KEY.LEFTMETA, value: 0 }, { type: EV_SYN }]],
    ];
    let rest = Buffer.alloc(0);
    for (const [at, evs] of timeline) {
      s.clock.advance(at - s.clock.t);
      const bytes = encodeEvents(evs, 24);
      for (let i = 0; i < bytes.length; i += 17) { // reads cut mid-event
        const parsed = parseEvents(Buffer.concat([rest, bytes.subarray(i, i + 17)]), 24);
        rest = Buffer.from(parsed.rest);
        for (const e of parsed.events) feedEvent(s.m, s.down, e.type, e.code, e.value);
      }
    }
    assert.deepEqual(s.types(), ["holdStart", "screenshot", "holdEnd"]);
  });
});

describe("XInput2 fallback", () => {
  it("parses xinput test-xi2 raw events", () => {
    const got: unknown[] = [];
    const p = new XI2Parser((e) => got.push(e));
    p.feed("EVENT type 13 (RawKeyPress)\n    device: 11 (11)\n    detail: 64\n    flags: \n    valuators:\n\nEVENT type 14 (RawKeyRel");
    p.feed("ease)\n    device: 11 (11)\n    detail: 64\n\nEVENT type 17 (RawMotion)\n    device: 2 (10)\n    detail: 0\n");
    p.feed("EVENT type 15 (RawButtonPress)\n    device: 10 (10)\n    detail: 1\n");
    assert.deepEqual(got, [
      { type: "press", device: 11, source: 11, detail: 64 },
      { type: "release", device: 11, source: 11, detail: 64 },
      { type: "button", device: 10, source: 10, detail: 1 },
    ]);
  });

  it("finds the XTest devices to ignore", () => {
    const list = "⎡ Virtual core pointer                    \tid=2\t[master pointer  (3)]\n⎜   ↳ Virtual core XTEST pointer              \tid=4\t[slave  pointer  (2)]\n⎣ Virtual core keyboard                   \tid=3\t[master keyboard (2)]\n    ↳ Virtual core XTEST keyboard             \tid=5\t[slave  keyboard (3)]\n    ↳ AT keyboard \tid=11\t[slave  keyboard (3)]";
    assert.deepEqual([...parseXTestIds(list)], [4, 5]);
  });
});

describe("Alt as part of a shortcut", () => {
  it("Alt+Shift+Tab, then letting go of Shift while Alt is still down, doesn't start listening", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.press(KEY.LEFTSHIFT);
    s.press(15); s.release(15);
    s.release(KEY.LEFTSHIFT);
    s.clock.advance(2000);
    assert.deepEqual(s.types(), []);
    s.release(KEY.LEFTALT);
    s.press(KEY.LEFTALT); // a fresh press works again
    s.clock.advance(300);
    assert.deepEqual(s.types(), ["holdStart"]);
  });

  it("after a cancelled hold or a quick point mode, the Alt still held isn't a new hold", () => {
    const s = setup();
    s.press(KEY.LEFTALT);
    s.clock.advance(500);
    s.press(15); s.release(15);
    s.press(KEY.LEFTSHIFT); s.release(KEY.LEFTSHIFT);
    s.clock.advance(1000);
    assert.deepEqual(s.types(), ["holdStart", "holdCancel"]);

    const t = setup();
    t.press(KEY.LEFTALT); t.press(KEY.LEFTSHIFT); t.press(KEY.SPACE);
    t.clock.advance(100);
    t.release(KEY.SPACE); t.release(KEY.LEFTSHIFT);
    t.clock.advance(1000);
    t.release(KEY.LEFTALT);
    assert.deepEqual(t.types(), ["pointMode", "tap"]);
  });
});
