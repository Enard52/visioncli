import assert from "node:assert/strict";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  CONTROL_ACTIONS,
  beginLook,
  displayAt,
  displaysAndPointer,
  rememberLook,
  send,
  timeoutFor,
  toScreen,
} from "../src/control.js";
import { CONFIG_DIR } from "../src/config.js";

// tests/run.mjs points HOME at a temp dir, so this is a scratch copy of the app's support folder.
const SUPPORT = CONFIG_DIR;
mkdirSync(SUPPORT, { recursive: true });
assert.match(homedir(), /vcli-test-home-/, "run through `npm test` (it isolates HOME)");

describe("displayAt", () => {
  const displays = [
    { x: 0, y: 0, width: 1512, height: 982 },
    { x: 1512, y: -200, width: 2560, height: 1440 }, // to the right, raised
    { x: -1920, y: 0, width: 1920, height: 1080 }, // to the left
  ];
  test("1-based display containing the point", () => {
    assert.equal(displayAt(displays, { x: 10, y: 10 }), 1);
    assert.equal(displayAt(displays, { x: 1512, y: -200 }), 2);
    assert.equal(displayAt(displays, { x: -1, y: 500 }), 3);
  });
  test("the right/bottom edge belongs to the next display (or none)", () => {
    assert.equal(displayAt(displays, { x: 1511.9, y: 0 }), 1);
    assert.equal(displayAt(displays, { x: 1512, y: 0 }), 2);
    assert.equal(displayAt(displays, { x: 100, y: 982 }), undefined);
  });
  test("unknown pointer or no displays", () => {
    assert.equal(displayAt(displays, undefined), undefined);
    assert.equal(displayAt([], { x: 0, y: 0 }), undefined);
  });
});

describe("toScreen", () => {
  test("screen: true passes points through", () => assert.deepEqual(toScreen(12.4, 7, { screen: true }), { x: 12.4, y: 7 }));

  test("maps pixels in the last look, and a look started later wins over one that finished later", () => {
    const first = beginLook();
    const second = beginLook();
    rememberLook({ x: 100, y: 200, width: 800, height: 600, imageWidth: 1600, imageHeight: 1200 }, second);
    rememberLook({ x: 0, y: 0, width: 10, height: 10, imageWidth: 10, imageHeight: 10 }, first); // stale: ignored
    assert.deepEqual(toScreen(800, 600, {}), { x: 500, y: 500 });
    assert.deepEqual(toScreen(1, 1, {}), { x: 101, y: 201 }); // rounded
  });

  test("attached voice-question images come from shots.json (1-based)", () => {
    writeFileSync(join(SUPPORT, "shots.json"), JSON.stringify({
      shots: [
        { x: 0, y: 0, width: 100, height: 100, imageWidth: 200, imageHeight: 200 },
        { x: -1920, y: 0, width: 1920, height: 1080, imageWidth: 1568, imageHeight: 882 },
      ],
    }));
    assert.deepEqual(toScreen(100, 100, { image: 1 }), { x: 50, y: 50 });
    assert.deepEqual(toScreen(784, 441, { image: 2 }), { x: -960, y: 540 });
    assert.throws(() => toScreen(1, 1, { image: 3 }), /no attached image 3/);
  });

  test("a missing shots.json is a clear error", () => {
    rmSync(join(SUPPORT, "shots.json"), { force: true });
    assert.throws(() => toScreen(1, 1, { image: 1 }), /no attached image 1.*look/);
  });
});

describe("timeouts", () => {
  test("read-only actions are quick, everything else waits for approval", () => {
    assert.equal(timeoutFor("status"), 3000);
    assert.equal(timeoutFor("capture"), 5000);
    assert.equal(timeoutFor("elements"), 8000);
    assert.equal(timeoutFor("click"), 5 * 60_000);
    assert.equal(timeoutFor("not_an_action"), 5 * 60_000);
  });
  test("every action has a timeout", () => {
    for (const a of CONTROL_ACTIONS) assert.ok(timeoutFor(a) > 0, a);
  });
});

// A fake VisionCLI.app control server: checks the token like the app does (401 when it doesn't match).
interface Fake { server: Server; port: number; token: string; requests: { headers: IncomingMessage["headers"]; body: unknown }[]; reply: (body: any) => unknown }
async function fake(token: string, reply: Fake["reply"] = () => ({ ok: true })): Promise<Fake> {
  const f = { token, requests: [], reply } as unknown as Fake;
  f.server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      f.requests.push({ headers: req.headers, body });
      if (req.headers["x-visioncli-token"] !== f.token) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(f.reply(body)));
    });
  });
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.port = (f.server.address() as AddressInfo).port;
  return f;
}
// Then a beat for the client's keep-alive socket to see the close (a real restart takes seconds).
const stop = (f: Fake) => new Promise<void>((r) => { f.server.closeAllConnections(); f.server.close(() => setTimeout(r, 50)); });
const point = (port: number, token: string) => writeFileSync(join(SUPPORT, "control.json"), JSON.stringify({ port, token }));

describe("send (control.json cache)", { skip: process.platform !== "darwin" && "computer control is macOS-only" }, () => {
  const servers: Fake[] = [];
  after(async () => { await Promise.all(servers.map(stop)); });

  test("app not running: no control.json", async () => {
    rmSync(join(SUPPORT, "control.json"), { force: true });
    await assert.rejects(send({ action: "status" }), /VisionCLI isn't running/);
    assert.equal(await displaysAndPointer(), null); // swallowed for the screenshot fallbacks
  });

  test("posts the JSON request with the token, returns the reply", async () => {
    const a = await fake("tok-a", (b) => (b.action === "displays" ? { displays: [{ x: 0, y: 0, width: 10, height: 10 }], pointer: { x: 1, y: 2 } } : { ok: true }));
    servers.push(a);
    point(a.port, "tok-a");
    const d = await send({ action: "displays", windows: true });
    assert.deepEqual(d.pointer, { x: 1, y: 2 });
    assert.deepEqual(a.requests.at(-1)?.body, { action: "displays", windows: true });
    assert.equal(a.requests.at(-1)?.headers["x-visioncli-token"], "tok-a");
  });

  test("an { error } reply throws it", async () => {
    servers[0].reply = () => ({ error: "The user declined: click. Don't retry it." });
    await assert.rejects(send({ action: "click", x: 1, y: 2 }), /The user declined: click/);
    servers[0].reply = () => ({ ok: true });
  });

  test("control.json is cached: not re-read while the app answers", async () => {
    point(1, "bogus"); // would fail if read
    await send({ action: "status" });
    assert.equal(servers[0].requests.at(-1)?.headers["x-visioncli-token"], "tok-a");
  });

  test("app restarted on a new port (connection refused): re-reads control.json once", async () => {
    const b = await fake("tok-b");
    servers.push(b);
    await stop(servers[0]);
    point(b.port, "tok-b");
    await send({ action: "announce", text: "done" });
    assert.deepEqual(b.requests.at(-1)?.body, { action: "announce", text: "done" });
  });

  test("new token on the same port (401): re-reads and retries", async () => {
    const b = servers[1];
    b.token = "tok-b2";
    point(b.port, "tok-b2");
    const before = b.requests.length;
    await send({ action: "status" });
    assert.deepEqual(b.requests.slice(before).map((r) => r.headers["x-visioncli-token"]), ["tok-b", "tok-b2"]);
  });

  test("still stale after re-reading: a clear error", async () => {
    point(servers[1].port, "wrong");
    servers[1].token = "other";
    await assert.rejects(send({ action: "status" }), /Couldn't reach VisionCLI/);
  });
});
