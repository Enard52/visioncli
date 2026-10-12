import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CONTROL_ACTIONS } from "../src/control.js";

const root = process.env.VISIONCLI_REPO ?? process.cwd();

/**
 * Raw values of `enum ControlAction: String, CaseIterable { … }` in Swift source: `case openApp = "open_app"` is
 * "open_app", a plain `case status` is "status"; several cases may share a line. Comments and nested blocks
 * (computed properties, methods) are skipped. null when there's no such enum.
 */
export function swiftControlActions(source: string): string[] | null {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const head = /\benum\s+ControlAction\s*:\s*String\b[^{]*\{/.exec(code);
  if (!head) return null;
  let depth = 1;
  let body = "";
  for (let i = head.index + head[0].length; i < code.length && depth > 0; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 1) body += ch; // only the enum's own level
  }
  const raw: string[] = [];
  for (const m of body.matchAll(/\bcase\s+([^\n;]+)/g)) {
    for (const item of m[1].split(",")) {
      const c = /^\s*`?(\w+)`?\s*(?:=\s*"([^"]*)")?\s*$/.exec(item);
      if (c) raw.push(c[2] ?? c[1]);
    }
  }
  return raw;
}

describe("Swift parser", () => {
  test("raw values, defaults, one-line lists, comments and nested members", () => {
    const src = `
      import Foundation
      /// The actions.
      enum ControlAction: String, CaseIterable, Codable {
          case status, displays // read-only
          case autopilotCheck = "autopilot_check"
          /* case old = "old" */
          case openApp = "open_app", focusApp = "focus_app"
          case \`type\`
          var needsApproval: Bool {
              switch self { case .status, .displays: return false; default: return true }
          }
      }
      enum Other: String { case nope }`;
    assert.deepEqual(swiftControlActions(src), ["status", "displays", "autopilot_check", "open_app", "focus_app", "type"]);
  });

  test("no enum", () => assert.equal(swiftControlActions("enum Foo: String { case a }"), null));
});

describe("control protocol parity", () => {
  test("Swift ControlAction (overlay/Sources/Control.swift) has exactly the TypeScript ControlAction actions", () => {
    const swift = swiftControlActions(readFileSync(join(root, "overlay", "Sources", "Control.swift"), "utf8"));
    assert.ok(swift, "enum ControlAction: String, CaseIterable not found in overlay/Sources/Control.swift");
    assert.deepEqual([...swift].sort(), [...CONTROL_ACTIONS].sort());
  });
});
