import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOGS } from "./paths";

// LOGS/visioncli.log, rotated to .1 at 5 MB (same as the macOS app).
export const LOG_FILE = join(LOGS, "visioncli.log");
const MAX = 5 * 1024 * 1024;

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if ((statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0) > MAX) renameSync(LOG_FILE, LOG_FILE + ".1");
    appendFileSync(LOG_FILE, line);
  } catch {}
  if (process.env.VISIONCLI_DEBUG) process.stderr.write(line);
}
