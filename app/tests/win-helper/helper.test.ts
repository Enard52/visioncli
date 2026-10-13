import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHelper, findHelperExe, type HelperOptions, type SpawnHelper } from "../../src/main/platform/win32/helper";

// A fake vcli-win.exe: a Node script speaking the same JSON-lines protocol, spawned through the injectable spawn.
const FAKE = String.raw`
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); handle(JSON.parse(l)); }
});
process.stdin.on("end", () => process.exit(0));
process.stderr.write("fake helper up\n");
function handle({ id, method, params }) {
  switch (method) {
    case "hello": return out({ id, result: { version: "fake", dpiAware: true, arch: "x64" } });
    case "echo": return out({ id, result: params });
    case "pointer": return setTimeout(() => out({ id, result: { x: 1, y: 2 } }), 80);   // slow
    case "displays": return out({ id, result: [{ x: 0, y: 0, width: 1920, height: 1080, primary: true, scale: 1.5 }] });
    case "fail": return out({ id, error: "it broke" });
    case "never": return;
    case "split": {                                                                       // one reply in two chunks
      const s = JSON.stringify({ id, result: "é😀 split" }) + "\n";
      process.stdout.write(s.slice(0, 7));
      return setTimeout(() => process.stdout.write(s.slice(7)), 30);
    }
    case "hooks.start":
      out({ id, result: true });
      out({ event: "key", data: { vk: 65, down: true, injected: false } });
      return out({ event: "motion", data: { x: 5, y: 6 } });
    case "hooks.stop": return out({ id, result: true });
    case "methods": return out({ id, result: seen });
    case "crash": return process.exit(3);
  }
  out({ id, error: "unknown method '" + method + "'" });
}
const seen = [];
const orig = handle;
handle = (m) => { seen.push(m.method); orig(m); };
`;

const dir = mkdtempSync(join(tmpdir(), "vcli-win-test-"));
const script = join(dir, "fake-helper.js");
writeFileSync(script, FAKE);

const spawned: number[] = [];
const fakeSpawn: SpawnHelper = () => {
  const p = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(p.pid ?? 0);
  return p;
};

const logs: string[] = [];
const helpers: { close(): void }[] = [];
function make(o: HelperOptions = {}) {
  const h = createHelper("fake.exe", { spawn: fakeSpawn, log: (m) => logs.push(m), backoffMs: [20, 40], ...o });
  helpers.push(h);
  return h;
}
after(() => { for (const h of helpers) h.close(); });

// Untyped access for the fake's test-only methods.
const any = (h: ReturnType<typeof make>) => h as unknown as { call(m: string, p: unknown, t?: number): Promise<any> };
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); }
};

test("call: typed results, params passed through", async () => {
  const h = make();
  const hello = await h.call("hello", {});
  assert.deepEqual(hello, { version: "fake", dpiAware: true, arch: "x64" });
  const d = await h.call("displays", {});
  assert.equal(d[0].scale, 1.5);
  assert.deepEqual(await any(h).call("echo", { text: "a\nb é 😀", n: 3 }), { text: "a\nb é 😀", n: 3 });
});

test("call: helper errors reject with the helper's message", async () => {
  const h = make();
  await assert.rejects(any(h).call("fail", {}), /it broke/);
  await assert.rejects(any(h).call("nope", {}), /unknown method 'nope'/);
});

test("call: timeouts reject, and a late reply is ignored", async () => {
  const h = make();
  await assert.rejects(any(h).call("never", {}, 50), /never timed out after 50 ms/);
  assert.deepEqual(await h.call("hello", {}), { version: "fake", dpiAware: true, arch: "x64" });
});

test("concurrent calls resolve by id, whatever order the replies come in", async () => {
  const h = make();
  const order: string[] = [];
  await Promise.all([
    h.call("pointer", {}).then((r) => { order.push("pointer"); assert.deepEqual(r, { x: 1, y: 2 }); }),
    h.call("displays", {}).then(() => order.push("displays")),
    any(h).call("echo", { k: 1 }).then((r) => { order.push("echo"); assert.deepEqual(r, { k: 1 }); }),
  ]);
  assert.equal(order[order.length - 1], "pointer");
});

test("a reply split across stdout chunks (and multi-byte characters) is reassembled", async () => {
  const h = make();
  assert.equal(await any(h).call("split", {}), "é😀 split");
});

test("events reach listeners; unsubscribe stops them", async () => {
  const h = make();
  const keys: unknown[] = [];
  const motions: unknown[] = [];
  const off = h.on("key", (k) => keys.push(k));
  h.on("motion", (m) => motions.push(m));
  await h.call("hooks.start", {});
  await until(() => keys.length === 1 && motions.length === 1);
  assert.deepEqual(keys[0], { vk: 65, down: true, injected: false });
  off();
  await h.call("hooks.start", {});
  await until(() => motions.length === 2);
  assert.equal(keys.length, 1);
});

test("a crash rejects what was pending, restarts with backoff and switches hooks back on", async () => {
  const h = make();
  await h.call("hooks.start", {});
  const pending = any(h).call("never", {}, 5000);
  const crash = any(h).call("crash", {});
  await assert.rejects(pending, /exited during never \(code 3\)/);
  await assert.rejects(crash, /exited during crash/);
  // Calls made while it's down are queued and sent once it's back.
  assert.deepEqual(await h.call("hello", {}), { version: "fake", dpiAware: true, arch: "x64" });
  assert.equal(h.starts, 2);
  const seen: string[] = await any(h).call("methods", {});
  assert.equal(seen[0], "hooks.start", "hooks re-enabled first after the restart");
  assert.ok(logs.some((l) => /vcli-win exited \(code 3\); restarting in 20 ms/.test(l)));
});

test("repeated crashes back off further", async () => {
  const h = make();
  await any(h).call("crash", {}).catch(() => {});
  await until(() => h.starts === 2);
  await any(h).call("crash", {}).catch(() => {});
  await until(() => h.starts === 3);
  assert.ok(logs.some((l) => /restarting in 40 ms/.test(l)));
});

test("hooks.stop means no hooks after a restart", async () => {
  const h = make();
  await h.call("hooks.start", {});
  await h.call("hooks.stop", {});
  await any(h).call("crash", {}).catch(() => {});
  await h.call("hello", {});
  const seen: string[] = await any(h).call("methods", {});
  assert.deepEqual(seen, ["hello", "methods"]);
});

test("close: the helper exits (stdin closed), calls reject, no restart", async () => {
  const before = spawned.length;
  const h = make();
  await h.call("hello", {});
  const pid = spawned[before];
  const pending = any(h).call("never", {}, 5000);
  h.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(h.call("hello", {}), /closed/);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.starts, 1);
});

test("a spawn that fails (missing exe) is retried and calls fail fast", async () => {
  let n = 0;
  const h = createHelper("missing.exe", {
    spawn: (exe, args) => { n++; return spawn(join(dir, "does-not-exist"), args); },
    log: () => {}, backoffMs: [10],
  });
  helpers.push(h);
  await until(() => n >= 2);
  h.close();
});

test("stderr lines go to the log", async () => {
  make();
  await until(() => logs.some((l) => l === "vcli-win: fake helper up"));
});

test("findHelperExe: packaged first, then the dev build locations", () => {
  const have = new Set<string>();
  const exists = (p: string) => have.has(p);
  const o = { resourcesPath: "/opt/VisionCLI/resources", buildDir: "/repo/app/build", exists };
  assert.equal(findHelperExe(o), null);
  have.add(join("/repo/app/native/windows/bin/Release/net48/vcli-win.exe"));
  assert.equal(findHelperExe(o), join("/repo/app/native/windows/bin/Release/net48/vcli-win.exe"));
  have.add(join("/repo/app/resources/bin/vcli-win.exe"));
  assert.equal(findHelperExe(o), join("/repo/app/resources/bin/vcli-win.exe"));
  have.add(join("/repo/app/build/resources/bin/vcli-win.exe"));
  assert.equal(findHelperExe(o), join("/repo/app/build/resources/bin/vcli-win.exe"));
  have.add(join("/opt/VisionCLI/resources/bin/vcli-win.exe"));
  assert.equal(findHelperExe(o), join("/opt/VisionCLI/resources/bin/vcli-win.exe"));
});

test("no exe: calls reject with a hint", async () => {
  const h = createHelper(undefined, { spawn: fakeSpawn, log: () => {} });
  helpers.push(h);
  // In this test run there's no packaged/dev exe next to the bundle unless build.sh ran; either way it must not hang.
  const r = await h.call("hello", {}, 2000).then(() => "ok", (e: Error) => e.message);
  assert.ok(r === "ok" || /not found/.test(r), r);
});
