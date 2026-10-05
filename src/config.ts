import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "visioncli")
    : join(homedir(), ".config", "visioncli");

/** Holds the TypeSafe API key for Jev quick commands: {"typesafe": {"apiKey": "..."}}. */
export const INTEGRATIONS_FILE = join(CONFIG_DIR, "integrations.json");
