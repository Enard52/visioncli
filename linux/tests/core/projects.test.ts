// Ported from overlay/Tests/main.swift: ProjectSelector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectSelector } from "../../src/main/core/projects";

test("ProjectSelector", () => {
  const now = Date.now();
  const home = "/Users/me/VisionCLI";
  const recent = { path: "/p/recent", at: now - 60_000 };
  const stale = { path: "/p/recent", at: now - 601_000 };

  let d = ProjectSelector.decide("/p/pinned", "/p/win", recent, now, home);
  assert.deepEqual(d, { project: "/p/pinned", askScope: false, fromWindow: false }, "pinned wins");
  d = ProjectSelector.decide(null, "/p/win", recent, now, home);
  assert.deepEqual(d, { project: "/p/win", askScope: false, fromWindow: true }, "window project next");
  d = ProjectSelector.decide(null, null, recent, now, home);
  assert.deepEqual(d, { project: "/p/recent", askScope: true, fromWindow: false }, "recent project, Jev decides");
  d = ProjectSelector.decide(null, null, stale, now, home);
  assert.deepEqual(d, { project: home, askScope: false, fromWindow: false }, "older than 10 minutes goes Home");
  d = ProjectSelector.decide(null, null, { path: recent.path, at: now - 599_900 }, now, home);
  assert.ok(d.askScope, "just inside the 10 minute window");
  d = ProjectSelector.decide(null, null, { path: recent.path, at: now - 600_000 }, now, home);
  assert.equal(d.project, home, "exactly 10 minutes is Home");
  d = ProjectSelector.decide(null, null, null, now, home);
  assert.equal(d.project, home, "nothing known goes Home");

  let c = ProjectSelector.confirm("/p/cur", "/p/pinned", "/p/term", "/p/win");
  assert.deepEqual(c, { project: "/p/pinned", askScope: false, fromWindow: false }, "confirm: pinned wins");
  c = ProjectSelector.confirm("/p/cur", null, "/p/term", "/p/win");
  assert.deepEqual(c, { project: "/p/term", askScope: false, fromWindow: false }, "confirm: terminal before window");
  c = ProjectSelector.confirm("/p/cur", null, null, "/p/win");
  assert.deepEqual(c, { project: "/p/win", askScope: false, fromWindow: true }, "confirm: window project");
  c = ProjectSelector.confirm("/p/cur", null, null, null);
  assert.deepEqual(c, { project: "/p/cur", askScope: false, fromWindow: false }, "confirm: keeps the current project");

  assert.equal(ProjectSelector.label(home, home), "Home", "Home label");
  assert.equal(ProjectSelector.label("/Users/me/code/shop", home), "shop", "folder name label");
  assert.equal(ProjectSelector.label("/Users/me/code/shop/", home), "shop", "trailing slash, like lastPathComponent");
});
