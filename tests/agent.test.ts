import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Action, actionSpace, type AgentEvent, type Answer, type Driver, goalPhrases, type Jev, runTask, type Snapshot,
  stepQuestions, textQuestion, validChoice,
} from "../src/agent/agent.js";
import { MARKER_JS, SNAPSHOT_JS } from "../src/agent/snapshot.js";
import { quickQuestions } from "../src/quick.js";

const field: Action = { id: "e1", kind: "fill", node: 1, role: "textbox", label: "Destination", value: "" };
const fieldClick: Action = { id: "e2", kind: "click", node: 1, role: "textbox", label: "Open Destination", value: "" };
const search: Action = { id: "e3", kind: "click", node: 2, role: "button", label: "Search", value: "" };
const nights2: Action = { id: "e4", kind: "select", node: 3, role: "combobox", label: "Nights → 2 nights", value: "2", current_value: "1 night" };
const nights3: Action = { id: "e5", kind: "select", node: 3, role: "combobox", label: "Nights → 3 nights", value: "3", current_value: "1 night" };
const scroll: Action = { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 500 };
const wait: Action = { id: "wait", kind: "wait", label: "Wait for the page to update" };

const snap = (actions: Action[], extra: Partial<Snapshot> = {}): Snapshot => ({
  url: "file:///t.html", title: "T", text: "Find a stay", actions, marker: "m0", page_key: "k0",
  guards: Object.fromEntries(actions.filter((a) => a.node !== undefined).map((a) => [String(a.node), `g${a.node}`])), omitted: 0, ...extra,
});

describe("actionSpace", () => {
  const { elements, targets, controls } = actionSpace([field, fieldClick, search, nights2, nights3, scroll, wait]);

  test("one index per node, listing every operation it supports", () => {
    assert.equal(elements.length, 3);
    assert.deepEqual(elements[0].operations, ["TYPE_TEXT", "CLICK"]);
    assert.equal(elements[0].label, "Destination");
  });

  test("each operation's targets are only compatible elements", () => {
    assert.deepEqual(Object.keys(targets.TYPE_TEXT), ["1"]);
    assert.deepEqual(Object.keys(targets.CLICK), ["1", "2"]);
    assert.deepEqual(Object.keys(targets.SELECT), ["3:1", "3:2"]);
    assert.equal(targets.SELECT["3:2"], nights3);
  });

  test("dropdown options are listed under their element, with the current value", () => {
    assert.equal(elements[2].value, "1 night");
    assert.deepEqual(elements[2].options, [{ index: "3:1", label: "2 nights", value: "2" }, { index: "3:2", label: "3 nights", value: "3" }]);
  });

  test("scroll and wait are operations of their own", () => assert.deepEqual(Object.keys(controls), ["SCROLL_DOWN", "WAIT"]));
});

describe("stepQuestions", () => {
  const q = stepQuestions(snap([field, search, scroll, wait]), "find a stay in Lisbon", [{ action: "Search", kind: "click", changed: false }]);

  test("operations: the available ones plus DONE and BLOCKED, never an operation with no targets", () => {
    assert.deepEqual(Object.keys(q.operations), ["TYPE_TEXT", "CLICK", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
    assert.equal(q.operations.SELECT, undefined);
  });

  test("one speculative target head per targeted operation, in the same request", () => {
    assert.deepEqual(Object.keys(q.questions), ["operation", "type_text_target", "click_target"]);
  });

  test("recent actions carry whether the page changed", () => {
    assert.deepEqual(q.state.recent_actions, [{ action: "Search", kind: "click", text: undefined, page_changed: false }]);
  });
});

describe("goalPhrases", () => {
  const p = goalPhrases("Find a stay in Lisbon, for 3 nights.");

  test("single words and longer runs, punctuation trimmed", () => {
    for (const want of ["Lisbon", "3 nights", "stay in Lisbon", "Find a stay in Lisbon, for 3 nights"]) assert.ok(p.includes(want), want);
    assert.ok(!p.includes("Lisbon,"));
    assert.ok(!p.includes("nights."));
  });

  test("quoted text is offered whole", () => assert.ok(goalPhrases('type "hello there, world" into the box').includes("hello there, world")));

  test("no duplicates, bounded", () => {
    assert.equal(new Set(p).size, p.length);
    assert.ok(goalPhrases(Array(100).fill("word").map((w, i) => w + i).join(" ")).length <= 240);
  });

  test("the text question offers the phrases and none", () => {
    const tq = textQuestion("search for Lisbon", field, snap([field]), []);
    const criteria = (tq.questions.text as { criteria: Record<string, string> }).criteria;
    assert.equal(criteria.none, "The goal does not contain the value for this field.");
    assert.ok(Object.values(criteria).includes("Lisbon"));
  });
});

describe("validChoice", () => {
  test("accepts an offered id", () => assert.equal(validChoice({ choice: "a", probabilities: { a: 0.9, b: 0.1 } }, ["a", "b"]), "a"));
  test("rejects a missing, unknown or malformed answer", () => {
    assert.throws(() => validChoice(undefined, ["a"]));
    assert.throws(() => validChoice({ choice: "z" }, ["a"]));
    assert.throws(() => validChoice({ choice: "a", probabilities: { a: 2 } }, ["a"]));
  });
});

describe("quickQuestions", () => {
  const criteria = (pageTasks: boolean) => Object.keys((quickQuestions([], [], pageTasks).intent as { criteria: object }).criteria);
  test("browser tasks are only offered with the browser in front", () => {
    assert.ok(criteria(true).includes("browser_task"));
    assert.ok(!criteria(false).includes("browser_task"));
  });
});

// ── The loop, against a fake page and a scripted Jev ─────────────────────────────────────────────────────────────

/** A page whose snapshot changes when `apply` says so; records what the driver did. */
function fakePage(pages: Snapshot[], opts: { staleOnce?: boolean } = {}) {
  let i = 0;
  let staleOnce = opts.staleOnce ?? false;
  const did: string[] = [];
  const driver: Driver = {
    async evaluate(expr: string): Promise<any> {
      if (expr === SNAPSHOT_JS) return pages[i];
      if (expr === MARKER_JS) return pages[i].marker;
      const guard = /c\.guard\(c\.nodes\.get\((\d+)\)\)/.exec(expr);
      if (guard) {
        if (staleOnce) { staleOnce = false; return ["changed", "changed"]; }
        return [pages[i].page_key, pages[i].guards[guard[1]]];
      }
      if (expr.includes("elementFromPoint")) return { x: 10, y: 20 };
      return true; // settle
    },
    async click(x, y) { did.push(`click ${x},${y}`); i = Math.min(i + 1, pages.length - 1); },
    async replaceText(text) { did.push(`type ${text}`); },
    async wheel(d) { did.push(`wheel ${d}`); i = Math.min(i + 1, pages.length - 1); },
  };
  return { driver, did };
}

/** Jev that answers from a script, one entry per request; target/text heads are matched by name. */
function scripted(answers: Record<string, string>[]): { jev: Jev; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let n = 0;
  return {
    calls,
    jev: async (_state, questions) => {
      calls.push(questions);
      const a = answers[n++] ?? { operation: "BLOCKED" };
      return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { choice: v, confidence: 0.9 } satisfies Answer]));
    },
  };
}

async function run(goal: string, d: Driver, jev: Jev, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  await runTask(goal, d, jev, (e) => events.push(e), signal);
  return { events, end: events.at(-1) as Extract<AgentEvent, { type: "end" }> };
}

describe("runTask", () => {
  test("types a phrase from the goal, clicks, and finishes on DONE", async () => {
    const p0 = snap([field, search]);
    const p1 = snap([field, search], { marker: "m1", page_key: "k1" });
    const p2 = snap([search], { marker: "m2", page_key: "k2", text: "3 stays in Lisbon" });
    const { driver, did } = fakePage([p0, p1, p2]);
    const { jev } = scripted([
      { operation: "TYPE_TEXT", type_text_target: "1", click_target: "2" },
      { text: "p" + (goalPhrases("search for Lisbon").indexOf("Lisbon") + 1) },
      { operation: "CLICK", type_text_target: "1", click_target: "2" },
      { operation: "DONE" },
    ]);
    const { events, end } = await run("search for Lisbon", driver, jev);
    assert.deepEqual(did, ["click 10,20", "type Lisbon", "click 10,20"]);
    assert.equal(end.status, "done");
    assert.equal(end.steps, 2);
    assert.equal(end.decisions, 4);
    const steps = events.flatMap((e) => (e.type === "step" ? [e.step] : []));
    assert.deepEqual(steps.map((s) => [s.op, s.label, s.text]), [["TYPE_TEXT", "Destination", "Lisbon"], ["CLICK", "Search", undefined], ["DONE", "Done", undefined]]);
  });

  test("only the target head of the chosen operation is used", async () => {
    const { driver, did } = fakePage([snap([field, search]), snap([search], { marker: "m1" })]);
    const { jev } = scripted([{ operation: "CLICK", type_text_target: "1", click_target: "2" }, { operation: "DONE" }]);
    const { events } = await run("press search", driver, jev);
    assert.deepEqual(did, ["click 10,20"]);
    assert.equal((events.find((e) => e.type === "step") as { step: { label: string } }).step.label, "Search");
  });

  test("a stale decision is not executed: it observes and decides again", async () => {
    const { driver, did } = fakePage([snap([search]), snap([search], { marker: "m1" })], { staleOnce: true });
    const { jev, calls } = scripted([{ operation: "CLICK", click_target: "1" }, { operation: "CLICK", click_target: "1" }, { operation: "DONE" }]);
    const { end } = await run("press search", driver, jev);
    assert.deepEqual(did, ["click 10,20"]); // once, after the retry
    assert.equal(calls.length, 3);
    assert.equal(end.status, "done");
  });

  test("no value for a field in the goal: blocked, nothing typed", async () => {
    const { driver, did } = fakePage([snap([field])]);
    const { jev } = scripted([{ operation: "TYPE_TEXT", type_text_target: "1" }, { text: "none" }]);
    const { end } = await run("sign me up", driver, jev);
    assert.deepEqual(did, []);
    assert.equal(end.status, "blocked");
    assert.match(end.message, /Destination/);
  });

  test("a malformed answer stops with an error and no action", async () => {
    const { driver, did } = fakePage([snap([search])]);
    const { jev } = scripted([{ operation: "CLICK", click_target: "99" }]);
    const { end } = await run("press search", driver, jev);
    assert.deepEqual(did, []);
    assert.equal(end.status, "error");
  });

  test("three steps that change nothing: blocked", async () => {
    const p = snap([search]);
    const { driver } = fakePage([p]); // clicking never changes the page
    const { jev } = scripted(Array(5).fill({ operation: "CLICK", click_target: "1" }));
    const { end } = await run("press search", driver, jev);
    assert.equal(end.status, "blocked");
    assert.equal(end.steps, 3);
  });

  test("aborting stops before the next step", async () => {
    const ctl = new AbortController();
    const { driver, did } = fakePage([snap([search]), snap([search], { marker: "m1" })]);
    const jev: Jev = async () => { ctl.abort(); return { operation: { choice: "CLICK" }, click_target: { choice: "1" } }; };
    const { end } = await run("press search", driver, jev, ctl.signal);
    assert.deepEqual(did, []);
    assert.equal(end.status, "stopped");
  });
});
