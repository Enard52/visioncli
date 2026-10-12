import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { MIN_FAST, MIN_FOLLOWUP, MIN_GENERAL, type RouteAnswers, decide, route, routeRequest } from "../src/route.js";

const lane = (choice: string, confidence: number) => ({ lane: { choice, confidence } });

describe("routeRequest", () => {
  test("asks only the lane question for a bare question", () => {
    const { state, questions } = routeRequest({ question: "how are you" });
    assert.deepEqual(Object.keys(questions), ["lane"]);
    assert.equal(state.spoken_request, "how are you");
    assert.equal("previous_request" in state, false);
    assert.equal("recent_project" in state, false);
  });

  test("asks the scope question only when a project is given, with pointer context", () => {
    const { state, questions } = routeRequest({ question: "fix it", project: "visioncli", app: "Xcode", window: "w".repeat(300) });
    assert.deepEqual(Object.keys(questions), ["lane", "scope"]);
    assert.equal(state.recent_project, "visioncli");
    assert.equal(state.app_under_pointer, "Xcode");
    assert.equal((state.window_under_pointer as string).length, 120); // capped
  });

  test("app/window are dropped without a project (they only serve the scope judgment)", () => {
    const { state } = routeRequest({ question: "q", app: "Xcode", window: "main.swift" });
    assert.equal("app_under_pointer" in state, false);
    assert.equal("window_under_pointer" in state, false);
  });

  test("asks the follow-up question only when a previous question is given", () => {
    const { state, questions } = routeRequest({ question: "and why?", previous: "what does this do" });
    assert.deepEqual(Object.keys(questions), ["lane", "followup"]);
    assert.equal(state.previous_request, "what does this do");
    assert.equal((questions.followup as { type: string }).type, "noul");
  });

  test("an empty previous/project counts as absent", () => {
    assert.deepEqual(Object.keys(routeRequest({ question: "q", previous: "", project: "" }).questions), ["lane"]);
  });
});

describe("decide", () => {
  test("fast only at or above MIN_FAST", () => {
    assert.equal(decide(lane("fast", MIN_FAST), {}).lane, "fast");
    assert.equal(decide(lane("fast", MIN_FAST - 0.01), {}).lane, "strong");
    assert.equal(decide(lane("strong", 0.99), {}).lane, "strong");
  });

  test("missing answers mean strong with confidence 0", () => {
    assert.deepEqual(decide({}, {}), { lane: "strong", scope: undefined, confidence: 0, followup: undefined });
  });

  test("a follow-up to a strong question stays strong even when the lane says fast", () => {
    const a: RouteAnswers = { ...lane("fast", 0.95), followup: { noul: MIN_FOLLOWUP } };
    const r = decide(a, { previousLane: "strong" });
    assert.equal(r.lane, "strong");
    assert.equal(r.reason, "follow-up");
    assert.equal(r.followup, MIN_FOLLOWUP);
  });

  test("follow-up stickiness needs the previous lane to be strong and the probability to reach the threshold", () => {
    const a: RouteAnswers = { ...lane("fast", 0.95), followup: { noul: 0.9 } };
    assert.equal(decide(a, { previousLane: "fast" }).lane, "fast");
    assert.equal(decide(a, {}).lane, "fast");
    const weak: RouteAnswers = { ...lane("fast", 0.95), followup: { noul: MIN_FOLLOWUP - 0.01 } };
    assert.equal(decide(weak, { previousLane: "strong" }).lane, "fast");
  });

  test("scope: general only when confident, otherwise the project", () => {
    const at = (choice: string, confidence?: number) => decide({ ...lane("fast", 0.9), scope: { choice, confidence } }, { project: "p" }).scope;
    assert.equal(at("general", MIN_GENERAL), "general");
    assert.equal(at("general", MIN_GENERAL - 0.01), "project");
    assert.equal(at("general"), "project"); // no confidence reported
    assert.equal(at("project", 0.99), "project");
  });

  test("no scope without a project, even if Jev answered one", () => {
    assert.equal(decide({ ...lane("fast", 0.9), scope: { choice: "general", confidence: 1 } }, {}).scope, undefined);
  });

  test("a project with no scope answer stays with the project", () => {
    assert.equal(decide(lane("fast", 0.9), { project: "p" }).scope, "project");
  });
});

describe("route (network)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TYPESAFE_API_KEY;
  });

  test("no API key: strong without calling the service", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("unexpected"); }) as typeof fetch;
    assert.deepEqual(await route({ question: "hi", project: "p" }), { lane: "strong", scope: "project", reason: "no TypeSafe API key" });
    assert.deepEqual(await route({ question: "hi" }), { lane: "strong", scope: undefined, reason: "no TypeSafe API key" });
    assert.equal(called, false);
  });

  test("a failed request falls back to strong (keeping the project scope)", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    const r = await route({ question: "hi", project: "p" });
    assert.equal(r.lane, "strong");
    assert.equal(r.scope, "project");
    assert.equal(r.reason, "network down");
    assert.equal(typeof r.ms, "number");
  });

  test("an HTTP error falls back to strong with the status in the reason", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    globalThis.fetch = (async () => new Response("x".repeat(500), { status: 503 })) as typeof fetch;
    const r = await route({ question: "hi" });
    assert.equal(r.lane, "strong");
    assert.equal(r.reason, `TypeSafe 503: ${"x".repeat(200)}`); // body capped
  });

  test("sends the built request and decides from the answers", async () => {
    process.env.TYPESAFE_API_KEY = "secret";
    let sent: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return Response.json({ answers: { lane: { choice: "fast", confidence: 0.8 }, scope: { choice: "general", confidence: 0.7 } } });
    }) as typeof fetch;
    const r = await route({ question: "what's the weather", project: "p" });
    assert.equal(r.lane, "fast");
    assert.equal(r.scope, "general");
    assert.equal(r.confidence, 0.8);
    assert.equal(typeof r.ms, "number");
    assert.equal(sent?.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal((sent?.init.headers as Record<string, string>).Authorization, "Bearer secret");
    const body = JSON.parse(String(sent?.init.body));
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(Object.keys(body.questions), ["lane", "scope"]);
  });
});
