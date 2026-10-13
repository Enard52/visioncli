import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// The macOS app's `shell(…)`: run a program, collect stdout/stderr, never throw.

export interface RunResult { code: number; out: string; err: string }

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, out: "", err: String((e as Error)?.message ?? e) });
      return;
    }
    const timer = opts.timeout ? setTimeout(() => child.kill("SIGKILL"), opts.timeout) : null;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: 127, out, err: err || e.message }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** The user's PATH plus the places CLIs land that a desktop session's PATH often lacks (~/.local/bin, npm, cargo …). */
export function userPath(base = process.env.PATH ?? ""): string {
  const h = homedir();
  const extra = [join(h, ".local/bin"), join(h, ".cargo/bin"), join(h, ".npm-global/bin"), join(h, ".bun/bin"), join(h, ".volta/bin"),
    "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
  const parts = base.split(delimiter).filter(Boolean);
  for (const e of extra) if (!parts.includes(e)) parts.push(e);
  return parts.join(delimiter);
}

/** First executable `name` on `path`, or null. */
export function which(name: string, path = userPath()): string | null {
  if (name.includes("/")) return isExecutable(name) ? name : null;
  for (const dir of path.split(delimiter)) {
    const p = join(dir, name);
    if (dir && isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string) {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
