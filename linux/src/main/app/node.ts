import { spawn, type ChildProcess } from "node:child_process";
import { LineSplitter, JSONLines } from "../core/transcript";
import { log } from "../log";

// Running the MCP server's CLI as a child process, exactly as macOS does (App+Questions runQuick / warmQuick,
// App+BrowserTask): `<node> <server> quick|route|warm|browse …` with the user's PATH and VISIONCLI_FRONT_APP.

export interface NodeCli { node: string | null; args: (a: string[]) => string[]; path: string }

function env(cli: NodeCli, frontApp: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, PATH: cli.path, VISIONCLI_FRONT_APP: frontApp };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

/** Runs one command with a hard timeout (killed when slow, so it can't act after the assistant took over). Resolves
 *  with the JSON it printed, or null (failed, timed out, or `cancel` was called). */
export function runJson(cli: NodeCli, args: string[], timeoutMs: number, frontApp = ""): { done: Promise<Record<string, unknown> | null>; cancel(): void } {
  if (!cli.node) return { done: Promise.resolve(null), cancel() {} };
  let child: ChildProcess;
  let settle: (v: Record<string, unknown> | null) => void = () => {};
  const done = new Promise<Record<string, unknown> | null>((resolve) => {
    let finished = false;
    settle = (v) => { if (!finished) { finished = true; resolve(v); } };
    let out = "";
    try {
      child = spawn(cli.node!, cli.args(args), { env: env(cli, frontApp), stdio: ["ignore", "pipe", "ignore"] });
    } catch { settle(null); return; }
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (s: string) => { out += s; });
    child.on("error", () => settle(null));
    child.on("close", (code) => {
      if (code !== 0) return settle(null);
      try { const j = JSON.parse(out.trim()); settle(j && typeof j === "object" ? j : null); } catch { settle(null); }
    });
    const t = setTimeout(() => {
      if (child.exitCode === null) { child.kill("SIGTERM"); log(`quick: timed out after ${timeoutMs / 1000}s`); }
      settle(null);
    }, timeoutMs);
    t.unref?.();
  });
  return { done, cancel() { try { child?.kill("SIGTERM"); } catch {} settle(null); } };
}

/** Runs a command and returns its stdout (warm). */
export function runText(cli: NodeCli, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    if (!cli.node) return resolve("");
    let out = "";
    let child: ChildProcess;
    try { child = spawn(cli.node, cli.args(args), { env: env(cli, ""), stdio: ["ignore", "pipe", "ignore"] }); } catch { return resolve(""); }
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (s: string) => { out += s; });
    child.on("error", () => resolve(out));
    child.on("close", () => resolve(out));
    setTimeout(() => { child.kill("SIGTERM"); resolve(out); }, timeoutMs).unref?.();
  });
}

/** A streaming command (browse): one JSON object per stdout line; `onExit` gets whether it was killed by a signal. */
export function runStream(cli: NodeCli, args: string[], frontApp: string, onEvent: (e: Record<string, unknown>) => void,
                          onExit: (signaled: boolean) => void): ChildProcess | null {
  if (!cli.node) return null;
  let child: ChildProcess;
  try { child = spawn(cli.node, cli.args(args), { env: env(cli, frontApp), stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  const lines = new LineSplitter();
  child.stdout!.on("data", (chunk: Buffer) => { for (const o of JSONLines.objects(chunk, lines)) onEvent(o); });
  child.on("error", () => onExit(false));
  child.on("close", (_code, signal) => onExit(signal !== null));
  return child;
}
