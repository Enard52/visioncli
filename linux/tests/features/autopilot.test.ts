import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Autopilot, CLAUDE_ARGS, HOURLY_CAP, PROMPT, buildMessage, isSkipped, parseResult, type Suggestion } from "../../src/main/features/autopilot";
import type { RunResult } from "../../src/main/features/run";
import { fakes, win } from "./fakes";

const result = (r: string) => JSON.stringify({ type: "result", result: r, usage: { input_tokens: 900, output_tokens: 40 } });

describe("Autopilot parsing", () => {
  test("result JSON, fences, suggest false", () => {
    assert.deepEqual(parseResult(`{"type":"system"}\n${result('```json\n{"suggest": true, "title": "Fix the typo", "detail": "Line 3.", "draft": null}\n```')}`),
      { title: "Fix the typo", detail: "Line 3.", draft: null });
    assert.deepEqual(parseResult(result('{"suggest":true,"title":"Reply","detail":"","draft":"Sure, tomorrow works."}'))?.draft, "Sure, tomorrow works.");
    assert.equal(parseResult(result('{"suggest":false}')), null);
    assert.equal(parseResult(result("no json")), null);
    assert.equal(parseResult(""), null);
  });

  test("message and flags as on macOS", () => {
    const m = JSON.parse(buildMessage({ app: "Telegram", title: "Bob", text: "", image: "AAAA", isChat: true, manual: true }));
    assert.equal(m.type, "user");
    assert.equal(m.message.content[0].text, "App: Telegram\nWindow: Bob\n(This looks like a chat or inbox.)\n(The user pressed Check Now: always give your best suggestion, suggest true.)\nWindow text:\n(none, see screenshot)");
    assert.deepEqual(m.message.content[1].source, { type: "base64", media_type: "image/jpeg", data: "AAAA" });
    assert.deepEqual(CLAUDE_ARGS.slice(0, 9), ["-p", "--model", "haiku", "--effort", "low", "--setting-sources", "project", "--system-prompt", PROMPT]);
    assert.ok(PROMPT.startsWith("You are a helpful co-pilot"));
  });

  test("never-read list", () => {
    for (const w of [{ appId: "org.keepassxc.KeePassXC" }, { appId: "gnome-control-center" }, { app: "VisionCLI" }, { pid: process.pid }]) assert.ok(isSkipped(w), JSON.stringify(w));
    assert.ok(!isSkipped({ appId: "org.telegram.desktop", app: "Telegram" }));
  });
});

describe("Autopilot timing", () => {
  test("looks after 5 s on a picked app; text via accessibility, screenshot when there's little; card shown; cooldowns", async () => {
    const f = fakes();
    const tg = win("500", "Telegram", "org.telegram.desktop", "Bob");
    f.state.windows = [tg, ...f.state.windows];
    f.state.active = tg;
    f.state.text = { app: "Telegram", title: "Bob", text: "Bob: are we still on for tomorrow? ".repeat(6) };
    const runs: { args: string[]; input: string }[] = [];
    const runner = async (_c: string, args: string[], o: { input?: string | Buffer } = {}): Promise<RunResult> => {
      runs.push({ args, input: String(o.input) });
      return { code: 0, out: result('{"suggest":true,"title":"Reply to Bob","detail":"He asked about tomorrow.","draft":"Yes!"}'), err: "" };
    };
    const shown: Suggestion[] = [];
    const ap = new Autopilot({ desktop: f.desktop, ax: f.ax, input: f.input, card: { show: (s) => shown.push(s), hide: () => {} },
      apps: () => ["org.telegram.desktop"], runner, idleSeconds: async () => 0, dir: mkdtempSync(join(tmpdir(), "vcli-ap-")) });
    const t0 = 1_000_000_000_000;
    await ap.tick(t0);          // new key: remember it
    await ap.tick(t0 + 2000);   // not stable for 5 s yet
    assert.equal(runs.length, 0);
    await ap.tick(t0 + 6000);
    assert.equal(runs.length, 1);
    const msg = JSON.parse(runs[0].input);
    assert.match(msg.message.content[0].text, /\(This looks like a chat or inbox\.\)/);
    assert.equal(msg.message.content.length, 1, "enough text: no screenshot");
    assert.deepEqual(shown.map((s) => [s.title, s.draft, s.windowId]), [["Reply to Bob", "Yes!", "500"]]);
    await ap.tick(t0 + 20_000); // same place, checked < 10 min ago, not idle
    assert.equal(runs.length, 1);

    // A different app that wasn't picked: never.
    f.state.active = f.state.windows[1];
    await ap.tick(t0 + 40_000); await ap.tick(t0 + 50_000);
    assert.equal(runs.length, 1);

    // Check Now: ignores the list and cooldowns; little text → screenshot; same suggestion title isn't shown twice…
    f.state.text = { app: "gedit", title: "notes.txt - gedit", text: "" };
    await ap.checkNow();
    assert.equal(runs.length, 2);
    assert.equal(JSON.parse(runs[1].input).message.content[1].type, "image");
    assert.equal(shown.length, 2, "checkNow clears recent titles");

    // Insert: focuses the chat window and types the draft (not sent).
    f.calls.length = 0;
    await ap.insert(shown[0]);
    assert.deepEqual(f.calls, ["focus 500", "type Yes!"]);
    assert.equal(Autopilot.copyText({ ...shown[0], draft: null }), "Reply to Bob. He asked about tomorrow.");
    assert.equal(HOURLY_CAP, 30);
  });

  test("hourly cap and skipped terminals", async () => {
    const f = fakes();
    const ap = new Autopilot({ desktop: f.desktop, ax: f.ax, card: { show: () => {}, hide: () => {} }, apps: () => ["gnome-terminal", "org.gnome.gedit"],
      runner: async () => ({ code: 0, out: "", err: "" }), idleSeconds: async () => 100 });
    f.state.active = f.state.windows[1]; // gnome-terminal: never read
    await ap.tick(1); await ap.tick(10_000);
    assert.equal(ap.calls, 0);
    f.state.active = f.state.windows[0];
    ap.callsThisHour = Array.from({ length: 30 }, () => Date.now());
    await ap.tick(Date.now()); await ap.tick(Date.now() + 10_000);
    assert.equal(ap.calls, 30);
  });
});
