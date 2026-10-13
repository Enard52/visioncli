import assert from "node:assert/strict";
import { test } from "node:test";
import { answerSegments, diffLines, hasFileRef, linkOutsideCode, renderText } from "../../src/renderer/shared/markdown";

test("file:line references become visioncli://open links", () => {
  const html = renderText("See `src/app.ts:42` for the bug.");
  assert.match(html, /<a href="visioncli:\/\/open\?path=src\/app\.ts&amp;line=42">src\/app\.ts:42<\/a>/);
});

test("references inside fenced code stay plain", () => {
  const md = "Look at a.ts:3\n```ts\nconst x = 'b.ts:9'\n```";
  const out = linkOutsideCode(md);
  assert.match(out, /\[a\.ts:3\]\(visioncli:/);
  assert.match(out, /'b\.ts:9'/);
});

test("raw HTML is shown, not interpreted; unsafe links are dropped", () => {
  const html = renderText("<img src=x onerror=alert(1)> [x](javascript:alert(1)) ![p](file:///etc/passwd)");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /file:\/\//);
});

test("markdown: bold, lists, code blocks, line breaks", () => {
  const html = renderText("**Fix**: two steps\n- one\n- two\n\n```js\nlet a = 1\n```\nline\nbreak");
  assert.match(html, /<strong>Fix<\/strong>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<pre><code class="language-js">let a = 1/);
  assert.match(html, /line<br>break/);
});

test("segments: markers removed, diagrams split, a streaming diagram is pending", () => {
  const { answer, segments } = answerSegments("Here [[box:1:10,10,50,50:btn]] it is.\n```mermaid\ngraph TD; A-->B\n```\nDone");
  assert.equal(answer.includes("[["), false);
  assert.deepEqual(segments.map((s) => s.type), ["text", "mermaid", "text"]);
  assert.deepEqual(answerSegments("Wait\n```mermaid\ngraph TD; A").segments.map((s) => s.type), ["text", "pendingDiagram"]);
  assert.equal(hasFileRef("in main.swift:12"), true);
  assert.equal(hasFileRef("no refs"), false);
});

test("approval diff lines", () => {
  const lines = diffLines("- old line\n+ new line\n  same\n+++ header");
  assert.deepEqual(lines, [
    { text: "old line", kind: "removed" }, { text: "new line", kind: "added" }, { text: "same", kind: "context" },
    { text: "+++ header", kind: "context" },
  ]);
  const long = diffLines(Array.from({ length: 20 }, (_, i) => `+${i}`).join("\n"), 5);
  assert.equal(long.length, 6);
  assert.deepEqual(long[5], { text: "… 15 more lines", kind: "context" });
  assert.equal(diffLines("$ " + "x".repeat(200))[0].text.length, 111);
});
