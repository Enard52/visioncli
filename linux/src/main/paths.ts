import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Linux equivalents of the macOS app's folders (XDG base directories).
//   SUP   ~/Library/Application Support/visioncli  →  $XDG_CONFIG_HOME/visioncli (same as the MCP server's CONFIG_DIR)
//   LOGS  ~/Library/Logs                          →  $XDG_STATE_HOME/visioncli
//   CACHE ~/Library/Caches/visioncli              →  $XDG_CACHE_HOME/visioncli
const home = homedir();
const xdg = (v: string, fallback: string) => process.env[v] || join(home, fallback);

export const SUP = join(xdg("XDG_CONFIG_HOME", ".config"), "visioncli");
export const LOGS = join(xdg("XDG_STATE_HOME", ".local/state"), "visioncli");
export const CACHE = join(xdg("XDG_CACHE_HOME", ".cache"), "visioncli");
export const DATA = join(xdg("XDG_DATA_HOME", ".local/share"), "visioncli");
export const TMP = tmpdir();
export const MODELS = join(SUP, "models");
export const HOME_PROJECT = join(home, "VisionCLI");

for (const d of [SUP, LOGS, CACHE, DATA, MODELS]) mkdirSync(d, { recursive: true });
