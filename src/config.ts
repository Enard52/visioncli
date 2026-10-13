import { homedir } from "node:os";
import { join } from "node:path";

/** Per-user config folder, the same one the desktop app uses (its SUP). Platform and env are injectable for tests. */
export function configDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "visioncli");
  // Windows: %APPDATA% (Roaming), where Electron's appData points too.
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "visioncli");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "visioncli"); // same as the Linux app's SUP
}

export const CONFIG_DIR = configDir();

/** Holds the TypeSafe API key for Jev quick commands: {"typesafe": {"apiKey": "..."}}. */
export const INTEGRATIONS_FILE = join(CONFIG_DIR, "integrations.json");
