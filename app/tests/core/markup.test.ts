// Ported from overlay/Tests/main.swift: Markup, DiagramText.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagramText, Markup } from "../../src/main/core/markup";

test("Markup", () => {
  const text = "Here [[step:1:10,20:2:Two]] and [[box:1:1,2,3,4:Box]] then [[arrow:2:5,6:7,8]].";
  const marks = Markup.marks(text);
  assert.equal(marks.length, 3, "three marks");
  assert.deepEqual(marks[0].kind, { type: "step", n: 2 }, "first mark is step 2");
  assert.equal(marks[0].label, "Two", "step label");
  assert.ok(marks[0].a.x === marks[0].b.x && marks[0].a.y === marks[0].b.y && marks[0].a.x === 10, "step a == b");
  assert.equal(marks[1].kind.type, "box", "second mark is the box");
  assert.ok(marks[1].b.x === 3 && marks[1].b.y === 4, "box corner");
  assert.equal(marks[2].kind.type, "arrow", "third mark is the arrow");
  assert.equal(marks[2].image, 2, "arrow image");
  assert.equal(marks[2].label, "", "no label");

  assert.equal(Markup.display(text), "Here and then.", "markers removed from display");
  assert.equal(Markup.display("Answer [[box:1:1,2"), "Answer", "half-streamed marker hidden");
  const ref = Markup.firstFileRef("See `src/app/Payment.php:42-50` and other.swift:3");
  assert.equal(ref?.[0], "src/app/Payment.php", "first file ref path");
  assert.equal(ref?.[1], 42, "first file ref line");
  assert.equal(Markup.firstFileRef("no refs here"), null, "no file ref");
  assert.ok(Markup.linked("at a.swift:7").includes("visioncli://open?path=a.swift&line=7"), "file refs linked");
  assert.equal(Markup.linked("x `a/b.ts:1` y c.py:2"),
    "x [a/b.ts:1](visioncli://open?path=a/b.ts&line=1) y [c.py:2](visioncli://open?path=c.py&line=2)", "all refs linked, backticks dropped");
});

test("DiagramText", () => {
  const answer = "Intro\n```mermaid\ngraph TD\nA-->B\n```\nOutro";
  assert.deepEqual(DiagramText.segments(answer),
    [{ type: "text", text: "Intro" }, { type: "mermaid", code: "graph TD\nA-->B" }, { type: "text", text: "Outro" }], "segments split");
  assert.deepEqual(DiagramText.segments("Intro ```mermaid\ngraph"), [{ type: "text", text: "Intro" }, { type: "pendingDiagram" }], "streaming diagram pending");
  assert.equal(DiagramText.speakable(answer), "Intro\n(See the diagram.)\nOutro", "diagram mentioned aloud");
  assert.equal(DiagramText.speakable("Intro ```mermaid\ngraph"), "Intro\n", "pending diagram cuts speech");
  assert.deepEqual(DiagramText.segments(""), [], "empty answer");
});
