// Imported first by every win-features test: a throwaway HOME and XDG folders, so settings, logs and the synthetic
// transcripts never touch the real ones. (The Windows code paths under test take their platform and paths as
// arguments, so they run on any OS.)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = mkdtempSync(join(tmpdir(), "vcli-winfeat-"));
process.env.HOME = TEST_HOME;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");
process.env.XDG_STATE_HOME = join(TEST_HOME, ".local/state");
process.env.XDG_CACHE_HOME = join(TEST_HOME, ".cache");
process.env.XDG_DATA_HOME = join(TEST_HOME, ".local/share");
