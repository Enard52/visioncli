// Ported from overlay/Tests/main.swift: LineSplitter, JSONLines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSONLines, LineSplitter } from "../../src/main/core/transcript";

const b = (s: string) => Buffer.from(s, "utf8");

test("LineSplitter", () => {
  const s = new LineSplitter();
  const lines: string[] = [];
  const collect = (l: Buffer) => { lines.push(l.toString("utf8")); };
  s.feed(b("one\ntw"), collect);
  assert.deepEqual(lines, ["one"], "partial line held back");
  s.feed(b("o\nthree\n"), collect);
  assert.deepEqual(lines, ["one", "two", "three"], "partial line completed by the next chunk");
  s.feed(Buffer.alloc(0), collect);
  assert.equal(lines.length, 3, "empty chunk does nothing");
  s.feed(b("\n"), collect);
  assert.equal(lines.at(-1), "", "empty line delivered");
  s.feed(b("dropped"), collect);
  s.reset();
  s.feed(b("fresh\n"), collect);
  assert.equal(lines.at(-1), "fresh", "reset drops the partial line");
  const many = new LineSplitter();
  let count = 0;
  many.feed(b("x\n".repeat(10_000)), () => { count += 1; });
  assert.equal(count, 10_000, "many lines in one chunk");
});

test("JSONLines", () => {
  const splitter = new LineSplitter();
  let objs = JSONLines.objects(b("{\"type\":\"user\"}\nnot json\n[1,2]\n{\"type\":\"assist"), splitter);
  assert.equal(objs.length, 1, "only complete JSON objects");
  assert.equal(objs[0]?.type, "user", "first object parsed");
  objs = JSONLines.objects(b("ant\"}\n"), splitter);
  assert.equal(objs[0]?.type, "assistant", "object split across chunks");
  assert.equal(JSONLines.object(b("")), null, "blank line is not an object");
  assert.equal(JSONLines.object(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), null, "invalid UTF-8 rejected");
});
