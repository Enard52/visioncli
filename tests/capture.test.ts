import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type WindowInfo, contains, findWindow, fitSize, fromApp, isTerminal, pngHeaderSize, pointerInImage } from "../src/capture.js";

const win = (id: number, app: string, x: number, y: number, width: number, height: number, title = ""): WindowInfo =>
  ({ id, app, title, bounds: { x, y, width, height } });

describe("pointerInImage", () => {
  const w = win(1, "Xcode", 100, 50, 800, 600);

  test("scales window points to image pixels (Retina 2x)", () => {
    assert.deepEqual(pointerInImage(w, { x: 500, y: 350 }, { data: "", mimeType: "image/jpeg", width: 1600, height: 1200 }), { x: 800, y: 600 });
  });

  test("downscaled image", () => {
    assert.deepEqual(pointerInImage(w, { x: 100, y: 50 }, { data: "", mimeType: "image/jpeg", width: 400, height: 300 }), { x: 0, y: 0 });
    assert.deepEqual(pointerInImage(w, { x: 899, y: 649 }, { data: "", mimeType: "image/jpeg", width: 400, height: 300 }), { x: 400, y: 300 });
  });

  test("edges: left/top inclusive, right/bottom exclusive", () => {
    const img = { data: "", mimeType: "image/jpeg", width: 800, height: 600 };
    assert.ok(pointerInImage(w, { x: 100, y: 50 }, img));
    assert.equal(pointerInImage(w, { x: 900, y: 300 }, img), null);
    assert.equal(pointerInImage(w, { x: 300, y: 650 }, img), null);
    assert.equal(pointerInImage(w, { x: 99.5, y: 300 }, img), null);
  });

  test("negative coordinates (a display left of / above the main one)", () => {
    const left = win(2, "Safari", -1440, -200, 1440, 900);
    assert.deepEqual(pointerInImage(left, { x: -720, y: 250 }, { data: "", mimeType: "image/jpeg", width: 1440, height: 900 }), { x: 720, y: 450 });
  });

  test("no image size: unknown", () => {
    assert.equal(pointerInImage(w, { x: 500, y: 350 }, { data: "", mimeType: "image/png" }), null);
  });
});

describe("fitSize", () => {
  test("never upscales", () => assert.deepEqual(fitSize(800, 600, 1568), { width: 800, height: 600, downscale: false }));
  test("exactly the limit is not a downscale", () => assert.equal(fitSize(1568, 1000, 1568).downscale, false));
  test("fits the longer side (landscape and portrait)", () => {
    assert.deepEqual(fitSize(3136, 1960, 1568), { width: 1568, height: 980, downscale: true });
    assert.deepEqual(fitSize(1179, 2556, 1568), { width: 723, height: 1568, downscale: true });
  });
});

describe("pngHeaderSize", () => {
  const header = (w: number, h: number) => {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  test("reads width and height", () => assert.deepEqual(pngHeaderSize(header(2880, 1800)), { w: 2880, h: 1800 }));
  test("not a PNG (JPEG magic)", () => {
    const b = header(1, 1);
    b.writeUInt32BE(0xffd8ffe0, 0);
    assert.equal(pngHeaderSize(b), null);
  });
  test("truncated file", () => assert.equal(pngHeaderSize(header(1, 1).subarray(0, 20)), null));
});

describe("fromApp", () => {
  test("nested bounds", () => {
    const w = fromApp({ id: 7, app: "Slack", title: "general", bounds: { x: 1, y: 2, width: 3, height: 4 } });
    assert.deepEqual(w, { id: 7, app: "Slack", title: "general", bounds: { x: 1, y: 2, width: 3, height: 4 } });
  });
  test("flat x/y/width/height and missing names (older app versions)", () => {
    const w = fromApp({ id: "9" as unknown as number, x: 5, y: 6, width: 7, height: 8 } as never);
    assert.deepEqual(w, { id: 9, app: "", title: "", bounds: { x: 5, y: 6, width: 7, height: 8 } });
  });
});

describe("findWindow (with a snapshot)", () => {
  const term = win(1, "iTerm2", 0, 0, 1000, 800, "zsh");
  const code = win(2, "Code", 0, 0, 1200, 900, "server.ts — visioncli");
  const sim = win(3, "Simulator", 1300, 0, 400, 800, "iPhone 16");
  const snap = (pointer?: { x: number; y: number }) => ({ windows: [term, code, sim], pointer });

  test("isTerminal is case-insensitive", () => {
    assert.ok(isTerminal(win(0, "ITERM2", 0, 0, 1, 1)));
    assert.ok(!isTerminal(code));
  });

  test("contains", () => {
    assert.ok(contains(sim, { x: 1300, y: 0 }));
    assert.ok(!contains(sim, { x: 1700, y: 0 }));
  });

  test("by window id", async () => assert.equal((await findWindow({ windowId: 3 }, snap())).id, 3));

  test("unknown window id names list_windows", async () => {
    await assert.rejects(findWindow({ windowId: 42 }, snap()), /No on-screen window with id 42.*list_windows/);
  });

  test("by app name or title substring, case-insensitive", async () => {
    assert.equal((await findWindow({ app: "simul" }, snap())).id, 3);
    assert.equal((await findWindow({ app: "VISIONCLI" }, snap())).id, 2); // title match
  });

  test("no app match lists the visible apps", async () => {
    await assert.rejects(findWindow({ app: "Figma" }, snap()), /Visible apps: iTerm2, Code, Simulator\./);
  });

  test("under the cursor", { skip: process.platform !== "darwin" }, async () => {
    assert.equal((await findWindow({ underCursor: true }, snap({ x: 1500, y: 100 }))).id, 3);
  });

  test("the terminal under the cursor is skipped for the front-most other window", { skip: process.platform !== "darwin" }, async () => {
    assert.equal((await findWindow({ underCursor: true }, snap({ x: 10, y: 10 }))).id, 2);
  });

  test("default: front-most non-terminal window", async () => assert.equal((await findWindow({}, snap())).id, 2));

  test("only terminals", async () => {
    await assert.rejects(findWindow({}, { windows: [term] }), /No visible non-terminal window/);
  });
});
