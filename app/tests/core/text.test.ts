// Ported from overlay/Tests/main.swift: SpokenText, Vocabulary, BrowserTaskText.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserTaskText, SpokenText, Vocabulary } from "../../src/main/core/text";

test("SpokenText.clean", () => {
  const clean = SpokenText.clean;
  assert.equal(clean("| a | b |\n|---|---|\n| 1 | 2 |\nAfter the table."), "After the table.", "table rows dropped");
  assert.equal(clean("Before.\n```swift\nlet x = 1\n```\nAfter."), "Before.\n\nAfter.", "closed code fence dropped");
  assert.equal(clean("Look:\n```\nunfinished code"), "Look:\n", "unclosed code fence dropped to the end");
  assert.equal(clean("- first\n* second\n• third\n1. fourth"), "first\nsecond\nthird\nfourth", "bullets and numbers dropped");
  assert.equal(clean("See app/Models/File.swift:42 now"), "See File.swift, line 42 now", "path:line becomes file, line");
  assert.equal(clean("a/b/File.swift:42"), "File.swift, line 42", "relative path:line");
  assert.equal(clean("Lines File.swift:10-20 matter"), "Lines File.swift, line 10 matter", "line ranges keep the start");
  assert.equal(clean("A → B"), "A  to  B", "arrow read as to");
  assert.equal(clean("≈5 ms"), "about 5 ms", "approx read as about");
  assert.equal(clean("Go to https://example.com/x?y=1 now"), "Go to a link now", "URLs become a link");
  assert.equal(clean("Read [the docs](https://example.com)"), "Read the docs", "markdown links keep their text");
  assert.equal(clean("**bold** __under__ `code` # Title"), "bold under code  Title", "emphasis marks dropped");
  assert.equal(clean("plain text"), "plain text", "plain text untouched");
});

test("SpokenText.speakable", () => {
  assert.ok(SpokenText.speakable("Hello"), "words are speakable");
  assert.ok(SpokenText.speakable("42"), "numbers are speakable");
  assert.ok(!SpokenText.speakable("|---|"), "table border is not speakable");
  assert.ok(!SpokenText.speakable("... !?"), "punctuation is not speakable");
  assert.ok(!SpokenText.speakable(""), "empty is not speakable");
});

test("SpokenText.sentences", () => {
  assert.deepEqual(SpokenText.sentences("First one. Second one! Third?"), ["First one.", "Second one!", "Third?"], "splits sentences");
  assert.deepEqual(SpokenText.sentences("Words.\n...\nDone."), ["Words.", "Done."], "punctuation-only sentence skipped");
  assert.deepEqual(SpokenText.sentences("no punctuation"), ["no punctuation"], "single sentence without a stop");
  assert.deepEqual(SpokenText.sentences("--- ..."), [], "nothing speakable gives nothing");
});

test("Vocabulary", () => {
  const words = Vocabulary.words("shop", "PaymentController.php — shop", "Acme, Zed\n\n  Foo  \n");
  assert.equal(words[0], "shop", "project first");
  assert.ok(words.includes("PaymentController"), "CamelCase title token kept");
  assert.ok(!words.includes("php"), "short title tokens skipped");
  assert.ok(words.includes("Acme") && words.includes("Zed") && words.includes("Foo"), "custom words trimmed and kept");
  assert.ok(!words.includes(""), "no blank words");
  const dup = Vocabulary.words("github", null, null);
  assert.equal(dup.filter((w) => w.toLowerCase() === "github").length, 1, "deduplicated case-insensitively");
  assert.equal(Vocabulary.words("p", null, Array.from({ length: 200 }, (_, i) => `w${i}`).join(",")).length, 80, "capped at 80");
  assert.ok(!Vocabulary.words("p", "plain words only here", null).includes("plain"), "plain title words skipped");

  const prompt = Vocabulary.prompt("shop", "Main.swift", "Acme");
  assert.ok(prompt.startsWith("Vocabulary: shop, Main.swift, Acme, Claude"), "prompt order: project, title, custom, terms");
  assert.ok(prompt.endsWith("controller."), "prompt ends with a period");
  assert.ok(!Vocabulary.prompt("p", "", null).includes(", ,"), "empty title skipped");
  assert.deepEqual(Vocabulary.customWords(null), [], "no vocabulary file");
});

test("BrowserTaskText", () => {
  assert.equal(BrowserTaskText.line({ kind: "fill", label: "Destination", text: "Lisbon" }), "Typed “Lisbon” into Destination", "typing");
  assert.equal(BrowserTaskText.line({ kind: "click", label: "Search" }), "Clicked Search", "click");
  assert.equal(BrowserTaskText.line({ kind: "select", label: "Nights → 3 nights" }), "Chose 3 nights in Nights", "dropdown");
  assert.equal(BrowserTaskText.line({ kind: "scroll", label: "Scroll down" }), "Scroll down", "scroll");
  assert.equal(BrowserTaskText.line({ kind: "done", label: "Done" }), null, "done has no step line");
  assert.equal(BrowserTaskText.summary("done", "Done.", 7, 3955), "Done in 4.0 s (7 steps).", "done summary");
  assert.equal(BrowserTaskText.summary("done", "", 1, 900), "Done in 0.9 s (1 step).", "one step");
  assert.equal(BrowserTaskText.summary("blocked", "I don't know what to type into \"Email\".", 2, 1),
    "I don't know what to type into \"Email\".", "blocked shows the reason");
  assert.equal(BrowserTaskText.body("Done.", ["Clicked A", "Clicked B"]), "Done.\n\n1. Clicked A\n2. Clicked B", "numbered steps");
  assert.equal(BrowserTaskText.body("Working…", []), "Working…", "no steps yet");
});

// Beyond the Swift suite: the places where JS and ICU/Foundation differ.
test("ICU parity", () => {
  assert.equal(SpokenText.clean("See src/Café.swift:3"), "See Café.swift, line 3", "Unicode \\w in paths");
  assert.equal(SpokenText.clean("Look:\n```\ncode\n"), "Look:\n\n", "ICU $ stops before a final newline");
  assert.equal(BrowserTaskText.summary("done", "", 2, 250), "Done in 0.2 s (2 steps).", "printf rounds exact ties to even");
  assert.equal(BrowserTaskText.summary("done", "", 2, 150), "Done in 0.1 s (2 steps).", "0.15 is below the tie in binary");
  assert.equal(SpokenText.clean("a\r\n| t |\nb"), "a\r\n| t |\nb", "CRLF is one Character in Swift, so no line split there");
});
