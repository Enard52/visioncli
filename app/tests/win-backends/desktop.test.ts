import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Win32Desktop, exeId, toDesktopWindow } from "../../src/main/desktop/windows/win32";
import type { WinWindow } from "../../src/main/platform/win32/protocol";
import { fakeHelper } from "./fake";

const win = (o: Partial<WinWindow>): WinWindow => ({
  hwnd: "100", title: "t", pid: 50, exe: "chrome.exe", app: "Google Chrome", bounds: { x: 0, y: 0, width: 800, height: 600 }, ...o,
});

/** A JPEG with just an SOF0 segment (what jpegSize reads). */
function jpeg(w: number, h: number): Buffer {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9);
  return b;
}

test("exeId / toDesktopWindow: exe without .exe is the app id; the product name is the app", () => {
  assert.equal(exeId("C:\\Program Files\\Google\\chrome.exe"), "chrome");
  assert.equal(exeId("Code.EXE"), "Code");
  assert.deepEqual(toDesktopWindow(win({ hwnd: "42", title: "x", pid: 7 })),
    { id: "42", app: "Google Chrome", appId: "chrome", title: "x", pid: 7, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  assert.equal(toDesktopWindow(win({ app: "" })).app, "chrome");
});

test("windows(): helper order kept, own pid / VisionCLI / cloaked / tiny windows dropped, excludePid passed", async () => {
  const h = fakeHelper({
    windows: () => [
      win({ hwnd: "1", pid: 10 }), win({ hwnd: "2", pid: 999 }), win({ hwnd: "3", exe: "VisionCLI.exe", pid: 11 }),
      win({ hwnd: "4", cloaked: true, pid: 12 }), win({ hwnd: "5", pid: 13, bounds: { x: 0, y: 0, width: 150, height: 100 } }),
      win({ hwnd: "6", pid: 14, exe: "code.exe", app: "Visual Studio Code" }),
    ],
  });
  const d = new Win32Desktop(h, new Set([999]));
  assert.deepEqual((await d.windows()).map((w) => w.id), ["1", "6"]);
  assert.deepEqual(h.of("windows"), [{ excludePid: process.pid }]);
  assert.equal(d.backend, "win32");
  assert.equal(await d.problem(), null);
});

test("activeWindow(): the helper's, unless it's ours: then the front-most other window", async () => {
  let active: WinWindow | null = win({ hwnd: "9", pid: 20 });
  const h = fakeHelper({ activeWindow: () => active, windows: () => [win({ hwnd: "1", pid: 21 })] });
  const d = new Win32Desktop(h, new Set([999]));
  assert.equal((await d.activeWindow())?.id, "9");
  active = win({ hwnd: "8", pid: 999 });
  assert.equal((await d.activeWindow())?.id, "1");
  active = null;
  assert.equal((await d.activeWindow())?.id, "1");
});

test("displays / pointer: mapped; failures give [] and null", async () => {
  const d = new Win32Desktop(fakeHelper({
    displays: () => [{ x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1.5 }, { x: 1920, y: 0, width: 1280, height: 1024, primary: false, scale: 1 }],
    pointer: () => ({ x: 5, y: 6 }),
  }), new Set());
  assert.deepEqual(await d.displays(), [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1280, height: 1024 }]);
  assert.deepEqual(await d.pointer(), { x: 5, y: 6 });
  const broken = new Win32Desktop(fakeHelper({}), new Set());
  assert.deepEqual(await broken.displays(), []);
  assert.equal(await broken.pointer(), null);
});

test("captureWindow / captureRect: the helper writes a JPEG ≤ 1568 into a temp file, read back and removed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "vcli-wcap-"));
  const h = fakeHelper({
    displays: () => [{ x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1 }],
    capture: (p) => { writeFileSync(p.file, jpeg(1568, 882)); return { width: 1568, height: 882 }; },
  });
  const d = new Win32Desktop(h, new Set(), tmp);
  const shot = await d.captureWindow({ id: "77", app: "a", appId: "a", title: "", bounds: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(shot.width, 1568);
  assert.equal(shot.height, 882);
  assert.equal(shot.data[0], 0xff);
  const p = h.of("capture")[0];
  assert.equal(p.hwnd, "77");
  assert.equal(p.maxDim, 1568);
  assert.ok(p.file.startsWith(tmp) && p.file.endsWith(".jpg"));
  assert.equal(existsSync(p.file), false);
  // A rect half off-screen is clipped to the desktop, in whole pixels.
  await d.captureRect({ x: 1800.4, y: -20, width: 400, height: 100 });
  assert.deepEqual(h.of("capture")[1].rect, { x: 1800, y: 0, width: 120, height: 80 });
  assert.deepEqual(readdirSync(tmp), []);
});

test("capture failure: the temp file is still cleaned up and the error surfaces", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "vcli-wcap-"));
  const h = fakeHelper({ displays: () => [], capture: (p) => { writeFileSync(p.file, "x"); throw new Error("PrintWindow failed"); } });
  await assert.rejects(new Win32Desktop(h, new Set(), tmp).captureRect({ x: 0, y: 0, width: 5, height: 5 }), /PrintWindow/);
  assert.deepEqual(readdirSync(tmp), []);
});

test("focus: helper focus by hwnd; false → an error", async () => {
  let ok = true;
  const h = fakeHelper({ focus: () => ok });
  const d = new Win32Desktop(h, new Set());
  const w = { id: "5", app: "Notepad", appId: "notepad", title: "a.txt", bounds: { x: 0, y: 0, width: 1, height: 1 } };
  await d.focus(w);
  assert.deepEqual(h.of("focus"), [{ hwnd: "5" }]);
  ok = false;
  await assert.rejects(d.focus(w), /Notepad/);
});
