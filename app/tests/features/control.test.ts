import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CONTROL_ACTIONS } from "../../../src/control";
import { CONTROL_ACTION_NAMES, isBrowserNavShortcut, isSensitiveApp, normalizeCombo, describeAction } from "../../src/main/control/actions";
import { createControlServer, type ApprovalCard, type ControlServer } from "../../src/main/control/server";
import type { PermissionAnswer } from "../../src/main/contracts";
import { fakes, win } from "./fakes";

// Windows has no POSIX file modes (the profile folder's ACL keeps these files private), so the 0600 checks are POSIX-only.
const POSIX_MODES = process.platform !== "win32";

describe("control protocol parity", () => {
  test("the Linux action list is exactly src/control.ts CONTROL_ACTIONS", () => {
    assert.deepEqual([...CONTROL_ACTION_NAMES].sort(), [...CONTROL_ACTIONS].sort());
  });
});

describe("control rules", () => {
  test("browser guard: ctrl/super + L/T/N, exact combos", () => {
    for (const k of ["ctrl+l", "Ctrl+T", "super+n", "cmd+l", "ctrl+shift+n", "shift+ctrl+N", "enter ctrl+t"]) assert.ok(isBrowserNavShortcut(k), k);
    for (const k of ["ctrl+tab", "ctrl+a", "enter", "ctrl+shift+t", "alt+l", "ctrl+f"]) assert.ok(!isBrowserNavShortcut(k), k);
    assert.equal(normalizeCombo("Shift+Cmd+S"), "super+shift+s");
  });
  test("sensitive apps", () => {
    for (const a of [{ appId: "gnome-control-center" }, { appId: "org.keepassxc.KeePassXC" }, { app: "Bitwarden" }, { appId: "polkit-gnome-authentication-agent-1" }, { appId: "systemsettings" }, { appId: "seahorse" }, { app: "1Password" }])
      assert.ok(isSensitiveApp(a), JSON.stringify(a));
    assert.ok(!isSensitiveApp({ appId: "org.gnome.gedit", app: "gedit" }));
  });
  test("descriptions", () => {
    assert.equal(describeAction("click", { count: 2 }, { appName: "gedit", target: { x: 1.7, y: 2 } }), "double-click (1, 2) in gedit");
    assert.equal(describeAction("type", { text: "x".repeat(70) }, { appName: "gedit" }), `type "${"x".repeat(60)}…" in gedit`);
    assert.equal(describeAction("open_url", { url: "a.com" }, { appName: "" }), "open a.com");
  });
});

describe("control server over HTTP", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcli-control-"));
  const infoFile = join(dir, "control.json");
  const f = fakes();
  let mode: "ask" | "auto" | "off" = "ask";
  let answer: PermissionAnswer = "allow";
  const cards: ApprovalCard[] = [];
  let paused = false;
  let stops = 0;
  let server: ControlServer;
  let info: { port: number; token: string; pid: number };

  before(async () => {
    server = createControlServer({
      desktop: f.desktop, input: f.input, ax: f.ax, apps: f.apps, infoFile, shotsFile: join(dir, "shots.json"),
      mode: () => mode, assistantName: () => "Claude",
      approve: async (card) => { cards.push(card); return answer; },
      tasks: { begin: (t) => t, update: () => {}, get paused() { return paused; } },
      onStopped: () => stops++,
    });
    await server.start();
    info = JSON.parse(readFileSync(infoFile, "utf8"));
  });
  after(async () => { await server.stop(); });

  const post = (body: unknown, token = info.token) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port: info.port, method: "POST", path: "/", headers: { "X-VisionCLI-Token": token, "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(s) }));
    });
    req.on("error", reject);
    req.end(data);
  });

  test("control.json: port, token, pid, mode 0600", () => {
    assert.equal(info.port, server.port);
    assert.equal(info.pid, process.pid);
    assert.ok(info.token.length >= 64);
    if (POSIX_MODES) assert.equal(statSync(infoFile).mode & 0o777, 0o600);
  });

  test("bad token → 403, bad json → 400", async () => {
    assert.deepEqual(await post({ action: "status" }, "nope"), { status: 403, json: { error: "bad token" } });
    assert.deepEqual(await post("{nope"), { status: 400, json: { error: "bad json" } });
  });

  test("read-only: status, displays (+windows), capture", async () => {
    const s = await post({ action: "status" });
    assert.deepEqual(s.json, { trusted: true, mode: "ask", frontApp: "gedit", stopped: false });
    const d = await post({ action: "displays", windows: true });
    assert.equal(d.json.displays.length, 2);
    assert.deepEqual(d.json.pointer, { x: 5, y: 6 });
    assert.equal(d.json.windows[0].id, 100);
    assert.equal(d.json.windows[0].app, "gedit");
    const c = await post({ action: "capture", window_id: 100 });
    assert.equal(Buffer.from(c.json.data, "base64").toString(), "jpeg-100");
    const r = await post({ action: "capture", x: 0, y: 0, width: 1920, height: 1080 });
    assert.equal(r.json.width, 1920);
    assert.deepEqual((await post({ action: "capture" })).json, { error: "capture unavailable" });
  });

  test("ask mode: approval card, then the action; decline", async () => {
    cards.length = 0;
    answer = "allow";
    const ok = await post({ action: "click", x: 300, y: 400 });
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.done, "click (300, 400) in gedit");
    assert.equal(cards[0].title, "Claude wants to click (300, 400) in gedit");
    assert.ok(f.calls.includes("click 300,400 left 1"));
    answer = "deny";
    const no = await post({ action: "type", text: "hello\nworld" });
    assert.match(no.json.error, /^The user declined: type "hello\nworld" in gedit/);
    assert.deepEqual(cards[1].detail.map((d) => d.kind), ["added", "added", "context"]);
  });

  test("elements, then click by element uses an accessibility press; type with replace sets the value", async () => {
    const e = await post({ action: "elements" });
    assert.equal(e.json.app, "gedit");
    assert.equal(e.json.elements.length, 3);
    answer = "allow";
    f.calls.length = 0;
    const c = await post({ action: "click", element: 1 });
    assert.equal(c.json.done, 'click "Save" push button in gedit');
    assert.deepEqual(f.calls.filter((x) => !x.startsWith("focus")), ["press 1"]);
    const t = await post({ action: "type", element: 2, text: "Bob", replace: true });
    assert.equal(t.json.ok, true);
    assert.ok(f.calls.includes("setValue 2 Bob"));
    assert.match((await post({ action: "click", element: 99 })).json.error, /element is gone/);
  });

  test("Allow all for 15 minutes, except sensitive targets", async () => {
    cards.length = 0;
    answer = "allowAll";
    await post({ action: "key", keys: "ctrl+s" });
    assert.equal(cards.length, 1);
    await post({ action: "scroll", dy: -3 });
    assert.equal(cards.length, 1, "no card while allowed");
    // A password field still asks.
    answer = "allow";
    const pw = await post({ action: "type", element: 3, text: "secret" });
    assert.equal(pw.json.ok, true);
    assert.equal(cards.length, 2);
    assert.equal(cards[1].sensitive, true);
    // A sensitive app (settings) still asks.
    f.state.active = win("300", "Settings", "gnome-control-center");
    await post({ action: "click", x: 1, y: 1 });
    assert.equal(cards.length, 3);
    f.state.active = f.state.windows[0];
  });

  test("browser guard refuses navigation shortcuts in Chrome", async () => {
    const chrome = win("400", "Google Chrome", "google-chrome");
    f.state.windows = [chrome, ...f.state.windows];
    f.state.active = chrome;
    const r = await post({ action: "key", keys: "ctrl+l", app: "Google Chrome" });
    assert.match(r.json.error, /^Don't use keyboard shortcuts to open or navigate pages in Google Chrome/);
    f.state.windows = f.state.windows.slice(1);
    f.state.active = f.state.windows[0];
  });

  test("keys go to the target app (focused first); unknown keys report", async () => {
    mode = "auto";
    f.calls.length = 0;
    const r = await post({ action: "key", keys: "ctrl+a enter", app: "Terminal" });
    assert.equal(r.json.ok, true);
    assert.deepEqual(f.calls, ["focus 200", "key ctrl+a", "key enter"]);
    assert.equal(r.json.frontApp, "Terminal");
    f.state.active = f.state.windows[0];
    assert.match((await post({ action: "key", keys: "bogus" })).json.error, /Unknown key/);
  });

  test("open_url adds https://, open_app errors, drag/scroll", async () => {
    f.calls.length = 0;
    await post({ action: "open_url", url: "example.com" });
    assert.ok(f.calls.includes("openUrl https://example.com"));
    assert.match((await post({ action: "open_app", name: "nope" })).json.error, /^Couldn't open nope: no such app/);
    await post({ action: "drag", x1: 1, y1: 2, x2: 3, y2: 4 });
    assert.ok(f.calls.includes("drag 1,2->3,4"));
    assert.equal((await post({ action: "drag", x1: 1 })).json.error, "Missing x1/y1/x2/y2.");
    assert.equal((await post({ action: "nonsense" })).json.error, "Unknown action nonsense.");
  });

  test("pause holds actions until resume", async () => {
    paused = true;
    f.calls.length = 0;
    const p = post({ action: "click", x: 9, y: 9 });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(f.calls, []);
    paused = false;
    server.resume();
    assert.equal((await p).json.ok, true);
  });

  test("Esc stop: pending card declined, held actions dropped, refused for 120 s; a new question re-enables", async () => {
    mode = "ask";
    let release!: (a: PermissionAnswer) => void;
    let aborted = false;
    // Swap in a card that waits for the user.
    const s2 = createControlServer({
      desktop: f.desktop, input: f.input, ax: f.ax, apps: f.apps, infoFile: join(dir, "c2.json"), mode: () => mode,
      approve: (_card, signal) => new Promise((res) => { release = res; signal.addEventListener("abort", () => (aborted = true)); }),
      onStopped: () => stops++,
    });
    const pending = s2.handle({ action: "click", x: 1, y: 1 });
    const queued = s2.handle({ action: "click", x: 2, y: 2 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s2.active, true);
    s2.stopComputerControl();
    assert.equal(aborted, true);
    assert.match(String((await pending).error), /declined/);
    assert.match(String((await queued).error), /declined/);
    release("allow"); // too late: ignored
    assert.equal((await s2.handle({ action: "click", x: 1, y: 1 })).error, "The user pressed Esc to stop you using the computer. Stop and ask them how to continue.");
    assert.equal((await s2.handle({ action: "status" })).stopped, true);
    s2.newQuestion();
    mode = "auto";
    assert.equal((await s2.handle({ action: "click", x: 1, y: 1 })).ok, true);
    assert.ok(stops >= 1);
  });

  test("off mode refuses actions but answers read-only requests", async () => {
    mode = "off";
    assert.match((await post({ action: "click", x: 1, y: 1 })).json.error, /^Computer control is turned off/);
    assert.equal((await post({ action: "status" })).json.mode, "off");
    mode = "ask";
  });

  test("writeShotMap and stop() deletes control.json", async () => {
    server.writeShotMap([{ screenRect: { x: 1, y: 2, width: 3, height: 4 }, pixelSize: { width: 6, height: 8 }, label: "gedit" }]);
    const m = JSON.parse(readFileSync(join(dir, "shots.json"), "utf8"));
    assert.deepEqual(m.shots[0], { x: 1, y: 2, width: 3, height: 4, imageWidth: 6, imageHeight: 8, label: "gedit" });
    const s3 = createControlServer({ desktop: f.desktop, input: f.input, ax: f.ax, apps: f.apps, infoFile: join(dir, "c3.json"), approve: async () => "allow" });
    await s3.start();
    assert.ok(existsSync(join(dir, "c3.json")));
    await s3.stop();
    assert.ok(!existsSync(join(dir, "c3.json")));
  });
});
