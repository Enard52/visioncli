import { TEST_HOME } from "./_env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ClaudeSession } from "../../src/main/assistant/claude";
import { AgyModels, AgySession, AgySetup } from "../../src/main/assistant/agy";
import { GeminiSession, geminiFriendlyError } from "../../src/main/assistant/gemini";
import { resolveConfig, type SessionEvents } from "../../src/main/assistant/config";
import { autoAllowedTools, voiceSystemPrompt } from "../../src/main/assistant/prompts";
import { settings } from "../../src/main/settings";

// Recorded-style stream-json lines, shaped like what the Swift handlers read.

const cfg = resolveConfig({ node: "/usr/bin/node", server: "/opt/vcli/server/index.mjs", path: "/usr/bin:/bin", claude: "/nonexistent/claude", agy: "/nonexistent/agy", gemini: "/nonexistent/gemini" });

function recorder() {
  const log: [string, ...unknown[]][] = [];
  const events: SessionEvents = {
    toolStart: (n) => log.push(["toolStart", n]),
    toolUse: (n, i) => log.push(["toolUse", n, i]),
    toolResult: (t, e, tool) => log.push(["toolResult", t, e, tool]),
    delta: (t) => log.push(["delta", t]),
    permission: (r) => log.push(["permission", r]),
    done: (r, e) => log.push(["done", r, e]),
    cost: (c) => log.push(["cost", c]),
    rateLimit: (i) => log.push(["rateLimit", i]),
  };
  return { log, events };
}

const CLAUDE_FIXTURE = [
  `{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555","tools":["Read"]}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1760000000},"session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me look"}},"parent_tool_use_id":null,"session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}},"parent_tool_use_id":null,"session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/p/src/app.ts"}}]},"session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"line1\\nline2"},{"type":"image"}]}]},"session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sub"}},"parent_tool_use_id":"toolu_9","session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"control_request","request_id":"req_7","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{"file_path":"/p/a.ts","old_string":"a","new_string":"b"}}}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It's the router."}},"parent_tool_use_id":null,"session_id":"11111111-2222-3333-4444-555555555555"}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"It's the router.","total_cost_usd":0.0123,"session_id":"11111111-2222-3333-4444-555555555555"}`,
];

test("claude: stream-json lines become deltas, tools, approvals and the result", () => {
  const s = new ClaudeSession("/p", cfg, "strong");
  const r = recorder();
  s.events = r.events;
  for (const line of CLAUDE_FIXTURE) s.handle(JSON.parse(line));
  assert.deepEqual(r.log, [
    ["rateLimit", { status: "allowed", resetsAt: 1760000000 }],
    ["delta", "Let me look"],
    ["toolStart", "Read"],
    ["toolUse", "Read", { file_path: "/p/src/app.ts" }],
    ["toolResult", "line1\nline2\n[image]", false, "Read"],
    ["permission", { id: "req_7", tool: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } }],
    ["delta", "It's the router."],
    ["cost", 0.0123],
    ["done", "It's the router.", null],
  ]);
  // The session id is remembered under the macOS key, so a restart resumes the conversation.
  assert.equal(s.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(settings.getStore("backgroundSession:/p"), "11111111-2222-3333-4444-555555555555");
  assert.equal(s.busy, false);
});

test("claude: error results, fast-lane key", () => {
  const s = new ClaudeSession("/q", cfg, "fast");
  const r = recorder();
  s.events = r.events;
  s.handle({ type: "result", is_error: true, result: "Prompt is too long", session_id: "abc" });
  s.handle({ type: "result", is_error: true });
  assert.deepEqual(r.log, [["done", null, "Prompt is too long"], ["done", null, "Something went wrong"]]);
  assert.equal(settings.getStore("backgroundSession:fast:/q"), "abc");
});

test("claude: command line flags match the macOS app", () => {
  settings.set("model", "sonnet");
  settings.set("effort", "high");
  const s = new ClaudeSession("/r", cfg, "strong");
  s.handle({ type: "system", session_id: "sid-r" });
  const a = s.args();
  assert.deepEqual(a.slice(0, 11), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-prompt-tool", "stdio", "--permission-mode", "default"]);
  assert.equal(a[a.indexOf("--append-system-prompt") + 1], voiceSystemPrompt);
  assert.equal(a[a.indexOf("--model") + 1], "sonnet");
  assert.equal(a[a.indexOf("--effort") + 1], "high");
  assert.equal(a[a.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write,Bash");
  assert.equal(a[a.indexOf("--settings") + 1], `{"disableAllHooks": true}`);
  const allowed = a.indexOf("--allowedTools");
  assert.deepEqual(a.slice(allowed + 1, allowed + 1 + autoAllowedTools.length), autoAllowedTools);
  assert.deepEqual(JSON.parse(a[a.indexOf("--mcp-config") + 1]), { mcpServers: { visioncli: { command: "/usr/bin/node", args: ["/opt/vcli/server/index.mjs"] } } });
  assert.ok(a.includes("--strict-mcp-config"));
  assert.deepEqual(a.slice(-2), ["--resume", "sid-r"]);
  // Fast lane: Haiku at low effort, whatever the menu says; "default" model: no --model.
  const fast = new ClaudeSession("/r", cfg, "fast");
  assert.equal(fast.args()[fast.args().indexOf("--model") + 1], "haiku");
  assert.equal(fast.args()[fast.args().indexOf("--effort") + 1], "low");
  settings.set("model", "default");
  settings.set("effort", null);
  const def = new ClaudeSession("/r2", cfg, "strong").args();
  assert.ok(!def.includes("--model") && !def.includes("--effort") && !def.includes("--resume"));
});

test("claude: a missing binary reports instead of hanging", async () => {
  const s = new ClaudeSession("/", cfg, "strong");
  const r = recorder();
  s.events = r.events;
  s.send("hi", []);
  await new Promise((res) => setTimeout(res, 300));
  const done = r.log.find((e) => e[0] === "done");
  assert.ok(done && typeof done[2] === "string" && (done[2] as string).includes("Couldn't start claude"), JSON.stringify(r.log));
  assert.equal(s.busy, false);
});

test("agy: init, streamed answer, tool steps and the result", () => {
  const s = new AgySession("/a", cfg, "strong");
  const r = recorder();
  s.events = r.events;
  const lines = [
    { event: "init", conversation_id: "conv-1" },
    { event: "step_update", step_update: { step_type: "agent_response", text_delta: "Checking" } },
    { event: "step_update", step_update: { step_type: "tool", state: "PENDING", tool_info: { name: "view_file" } } },
    { event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_info: { name: "call_mcp_tool", parameters: { ToolName: "look", ServerName: "visioncli" } } } },
    { event: "step_update", step_update: { step_type: "agent_response", text_delta: "Done." } },
    { event: "result", result: { status: "SUCCESS", response: "" } },
  ];
  for (const l of lines) s.handle(l);
  assert.deepEqual(r.log, [
    ["delta", "Checking"],
    ["toolStart", "look"],
    ["toolUse", "look", { ToolName: "look", ServerName: "visioncli" }],
    ["delta", "Done."],
    ["done", "Done.", null], // the narration before the tool was dropped
  ]);
  assert.equal(settings.getStore("agyBackground:/a"), "conv-1");
});

test("agy: an auto-denied command is asked for in the bubble, then allowed with a rule", () => {
  const s = new AgySession("/a2", { ...cfg, agy: null }, "strong");
  const r = recorder();
  s.events = r.events;
  s.handle({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_info: { name: "run_command", parameters: { CommandLine: " npm test -- --watch=false " } } } });
  (s as unknown as { lastStderr: string }).lastStderr = "tool run_command auto-denied: cannot prompt in headless mode";
  s.handle({ event: "result", result: { status: "SUCCESS", response: "" } });
  const perm = r.log.find((e) => e[0] === "permission")?.[1] as { tool: string; input: { command: string } };
  assert.equal(perm.tool, "Bash");
  assert.equal(perm.input.command, "npm test -- --watch=false");
  assert.ok(!r.log.some((e) => e[0] === "done"));
  // Allow: the rule is written to agy's settings and the turn continues (agy is missing here, so it reports that).
  s.respond(perm as never, true);
  const rules = JSON.parse(readFileSync(AgySetup.settings(), "utf8")).permissions.allow;
  assert.ok(rules.includes("command(npm test)"));
  assert.match(String(r.log.at(-1)?.[2]), /agy\) wasn't found/);
  // The "allow once" rule goes when the turn ends.
  s.handle({ event: "result", result: { status: "SUCCESS", response: "ok" } });
  assert.ok(!JSON.parse(readFileSync(AgySetup.settings(), "utf8")).permissions.allow.includes("command(npm test)"));
});

test("agy: errors and silent denials", () => {
  const s = new AgySession("/a3", cfg, "strong");
  const r = recorder();
  s.events = r.events;
  s.handle({ event: "result", result: { status: "ERROR", response: "partial", error: "quota exceeded" } });
  (s as unknown as { lastStderr: string }).lastStderr = "x\nauto-denied write_to_file";
  s.handle({ event: "result", result: { status: "SUCCESS", response: "" } });
  (s as unknown as { lastStderr: string }).lastStderr = "";
  s.handle({ event: "result", result: { status: "SUCCESS" } });
  assert.equal(r.log[0][2], "quota exceeded");
  assert.match(String(r.log[1][2]), /needs your approval/);
  assert.equal(r.log[2][2], "Gemini finished without a reply.");
});

test("agy: setup, rule prefixes, models", () => {
  AgySetup.install("/usr/bin/node", "/srv/index.mjs");
  const mcp = JSON.parse(readFileSync(AgySetup.mcpConfig(), "utf8"));
  assert.deepEqual(mcp.mcpServers.visioncli, { command: "/usr/bin/node", args: ["/srv/index.mjs"] });
  const allow: string[] = JSON.parse(readFileSync(AgySetup.settings(), "utf8")).permissions.allow;
  assert.ok(allow.includes("mcp(visioncli/look)") && allow.includes("command(git status)"));
  assert.equal(AgySetup.rulePrefix("git push origin main"), "git push");
  assert.equal(AgySetup.rulePrefix("/usr/bin/python3 manage.py migrate"), "/usr/bin/python3 manage.py");
  assert.equal(AgySetup.rulePrefix("ls -la"), "ls");
  AgySetup.sessionRules.add("command(make test)");
  AgySetup.addAllowRule("command(make test)");
  AgySetup.clearSessionRules();
  assert.ok(!JSON.parse(readFileSync(AgySetup.settings(), "utf8")).permissions.allow.includes("command(make test)"));
  assert.deepEqual(AgyModels.parse("gemini-3.8-pro\tGemini 3.8 Pro\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\nbad line\n"),
    [["gemini-3.8-pro", "Gemini 3.8 Pro"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"]]);
  settings.setStore("agyModels", [["gemini-4-flash-low", "Flash"], ["x", "y"]]);
  assert.equal(AgyModels.fastest(), "gemini-4-flash-low");
  const fast = new AgySession("/f", cfg, "fast");
  assert.deepEqual(fast.args(false).slice(0, 6), ["-p", "", "--input-format", "stream-json", "--output-format", "stream-json"]);
});

test("gemini: stream-json events", () => {
  const s = new GeminiSession("/g", cfg);
  const r = recorder();
  s.events = r.events;
  const lines = [
    { type: "init", session_id: "gem-1", model: "gemini-2.5-pro" },
    { type: "message", role: "user", content: "hi" },
    { type: "message", role: "assistant", content: "Let me check", delta: true },
    { type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { absolute_path: "/g/x.ts" } },
    { type: "tool_result", tool_id: "t1", status: "success", output: "abc" },
    { type: "tool_result", tool_id: "t2", status: "error", error: { type: "x", message: "nope" } },
    { type: "message", role: "assistant", content: "It's fine.", delta: true },
    { type: "result", status: "success", stats: {} },
  ];
  for (const l of lines) s.handle(l);
  assert.deepEqual(r.log, [
    ["delta", "Let me check"],
    ["toolStart", "read_file"],
    ["toolUse", "read_file", { absolute_path: "/g/x.ts" }],
    ["toolResult", "abc", false, null],
    ["toolResult", "nope", true, null],
    ["delta", "It's fine."],
    ["done", "It's fine.", null],
  ]);
  assert.equal(settings.getStore("geminiBackground:/g"), "gem-1");
  s.handle({ type: "result", status: "error", error: { message: "API key not valid. Please pass a valid API key." } });
  assert.match(String(r.log.at(-1)?.[2]), /rejected the API key/);
  assert.equal(geminiFriendlyError("x".repeat(500)).length, 400);
});

test("gemini: new sessions carry the instructions and @screenshots; resumed ones don't", () => {
  const shot = join(TEST_HOME, "shot 1.jpg");
  writeFileSync(shot, "jpeg");
  const s = new GeminiSession("/gem/proj", cfg);
  const a = s.args("what is this", [shot]);
  assert.equal(a.resume, false);
  assert.ok(a.args[1].startsWith("[Instructions for this conversation]"));
  assert.match(a.args[1], /what is this\n@\S+shot-1\.jpg$/);
  assert.deepEqual(a.args.slice(2, 8), ["-o", "stream-json", "--approval-mode", "default", "--allowed-mcp-server-names", "visioncli"]);
  assert.equal(a.args.at(-2), "--session-id");
  // A session file for the remembered id: resume without the instructions.
  s.handle({ type: "init", session_id: "abcdef12-0000-0000-0000-000000000000" });
  const dir = join(TEST_HOME, ".gemini/tmp", createHash("sha256").update("/gem/proj").digest("hex"), "chats");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-2026-10-13T10-00-abcdef12.jsonl"), JSON.stringify({ sessionId: "abcdef12-0000-0000-0000-000000000000", projectHash: "x" }) + "\n");
  const b = s.args("and that?", []);
  assert.equal(b.resume, true);
  assert.equal(b.args[1], "and that?");
  assert.deepEqual(b.args.slice(-2), ["--resume", "abcdef12-0000-0000-0000-000000000000"]);
});
