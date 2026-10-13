// Ported from overlay/Tests/main.swift: MenuLabels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MenuLabels } from "../../src/main/core/labels";

test("MenuLabels", () => {
  assert.equal(MenuLabels.claudeModel("opus"), "Opus", "model label");
  assert.equal(MenuLabels.claudeModel("opus[1m]"), "Opus, 1M context", "1M model label");
  assert.equal(MenuLabels.claudeModel("custom-model"), "custom-model", "unknown alias shown as is");
  assert.equal(MenuLabels.effort(null), "Default", "default effort");
  assert.equal(MenuLabels.effort("xhigh"), "Extra High", "xhigh effort");
  assert.equal(MenuLabels.followedModel("claude-sonnet-4-5", "opus"), "sonnet", "follows a new family");
  assert.equal(MenuLabels.followedModel("claude-opus-4-1", "opus[1m]"), null, "1M choice counts as its family");
  assert.equal(MenuLabels.followedModel("claude-opus-4-1", "opusplan"), null, "opusplan covers opus");
  assert.equal(MenuLabels.followedModel("claude-haiku-4-5", "opusplan"), "haiku", "opusplan to haiku");
  assert.equal(MenuLabels.followedModel("gpt-whatever", "opus"), null, "unknown model ignored");
});
