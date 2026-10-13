import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// Child-process helpers shared by input injection and apps.

export function run(cmd: string, args: string[], opts: { input?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: opts.timeout ?? 10_000, maxBuffer: 16 << 20, env: opts.env ?? process.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${(stderr || err.message).toString().trim()}`));
      else resolve(stdout.toString());
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Starts a long-lived program detached from VisionCLI (it must outlive us). */
export function launch(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", cwd });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

const found = new Map<string, string | null>();
/** Full path of a program on PATH, or null. */
export function which(name: string): string | null {
  if (name.includes("/")) { try { accessSync(name, constants.X_OK); return name; } catch { return null; } }
  if (found.has(name)) return found.get(name)!;
  let hit: string | null = null;
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    try { accessSync(join(dir, name), constants.X_OK); hit = join(dir, name); break; } catch {}
  }
  found.set(name, hit);
  return hit;
}

// Text tools (xdotool, wtype, ydotool) decode argv with mbstowcs: under a C/POSIX locale (services, containers)
// anything non-ASCII fails, so give them a UTF-8 one.
export const UTF8_ENV: NodeJS.ProcessEnv = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "")
  ? process.env : { ...process.env, LC_ALL: "C.UTF-8" };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
