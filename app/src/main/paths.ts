import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

// Linux equivalents of the macOS app's folders (XDG base directories).
//   SUP   ~/Library/Application Support/visioncli  →  $XDG_CONFIG_HOME/visioncli (same as the MCP server's CONFIG_DIR)
//   LOGS  ~/Library/Logs                          →  $XDG_STATE_HOME/visioncli
//   CACHE ~/Library/Caches/visioncli              →  $XDG_CACHE_HOME/visioncli
// Windows: settings roam with the profile, logs and caches stay on this machine.
//   SUP   %APPDATA%\visioncli (the MCP server's CONFIG_DIR)    LOGS  %LOCALAPPDATA%\visioncli\logs
//   CACHE %LOCALAPPDATA%\visioncli\cache                       DATA  %LOCALAPPDATA%\visioncli
const home = homedir();

export interface AppPaths { SUP: string; LOGS: string; CACHE: string; DATA: string; MODELS: string; HOME_PROJECT: string }

export function appPaths(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, h = home): AppPaths {
  if (platform === "win32") {
    const j = win32.join;
    const roaming = env.APPDATA || j(h, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || j(h, "AppData", "Local");
    const SUP = j(roaming, "visioncli"), DATA = j(local, "visioncli");
    return { SUP, LOGS: j(DATA, "logs"), CACHE: j(DATA, "cache"), DATA, MODELS: j(SUP, "models"), HOME_PROJECT: j(h, "VisionCLI") };
  }
  const xdg = (v: string, fallback: string) => env[v] || posix.join(h, fallback);
  const SUP = posix.join(xdg("XDG_CONFIG_HOME", ".config"), "visioncli");
  return {
    SUP, LOGS: posix.join(xdg("XDG_STATE_HOME", ".local/state"), "visioncli"), CACHE: posix.join(xdg("XDG_CACHE_HOME", ".cache"), "visioncli"),
    DATA: posix.join(xdg("XDG_DATA_HOME", ".local/share"), "visioncli"), MODELS: posix.join(SUP, "models"), HOME_PROJECT: posix.join(h, "VisionCLI"),
  };
}

const P = appPaths();
export const SUP = P.SUP;
export const LOGS = P.LOGS;
export const CACHE = P.CACHE;
export const DATA = P.DATA;
export const TMP = tmpdir();
export const MODELS = P.MODELS;
export const HOME_PROJECT = P.HOME_PROJECT;

for (const d of [SUP, LOGS, CACHE, DATA, MODELS]) mkdirSync(d, { recursive: true });
