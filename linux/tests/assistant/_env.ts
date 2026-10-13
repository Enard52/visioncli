// Imported first by every assistant test: a throwaway HOME and XDG folders, so settings, logs and the synthetic
// ~/.claude / ~/.gemini transcripts never touch the real ones.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = mkdtempSync(join(tmpdir(), "vcli-assistant-"));
process.env.HOME = TEST_HOME;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");
process.env.XDG_STATE_HOME = join(TEST_HOME, ".local/state");
process.env.XDG_CACHE_HOME = join(TEST_HOME, ".cache");
process.env.XDG_DATA_HOME = join(TEST_HOME, ".local/share");
