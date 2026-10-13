import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { log as appLog } from "../../log";
import type { Event, Events, Method, Methods } from "./protocol";

// The client for vcli-win.exe (app/native/windows): one long-running helper, JSON lines over stdin/stdout
// (protocol.ts). Requests run concurrently in the helper and are matched by id; events go to `on` listeners.
// If the helper dies it's restarted with backoff, and hooks that were on are switched back on.

/** The part of a ChildProcess the client uses, so tests can hand in a fake. */
export interface HelperProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr?: Readable | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

export type SpawnHelper = (exe: string, args: string[]) => HelperProcess;

export interface HelperOptions {
  /** Defaults to child_process.spawn (hidden console window on Windows). */
  spawn?: SpawnHelper;
  log?: (msg: string) => void;
  /** Restart delays after successive crashes; the last one repeats. Reset once a helper has lived `stableMs`. */
  backoffMs?: number[];
  stableMs?: number;
  /** Default per-call timeout (ms); 0 = none. */
  timeoutMs?: number;
}

export interface WinHelper {
  call<M extends Method>(method: M, params: Methods[M]["params"], timeoutMs?: number): Promise<Methods[M]["result"]>;
  /** Subscribes to an event; returns the unsubscribe function. */
  on<E extends Event>(event: E, cb: (data: Events[E]) => void): () => void;
  close(): void;
  /** Number of times the helper has been (re)started; for logs and tests. */
  readonly starts: number;
}

// Methods that legitimately take long: no timeout for playback (it lasts as long as the audio), more for the rest.
const METHOD_TIMEOUTS: Partial<Record<Method, number>> = {
  play: 0, speak: 120_000, elements: 20_000, windowText: 20_000, press: 15_000, setValue: 15_000, type: 60_000,
  processes: 20_000, capture: 20_000, focus: 5_000,
};

const defaultSpawn: SpawnHelper = (exe, args) => nodeSpawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

interface Pending { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }

export function createHelper(exePath?: string, opts: HelperOptions = {}): WinHelper {
  const exe = exePath ?? findHelperExe();
  const spawnFn = opts.spawn ?? defaultSpawn;
  const log = opts.log ?? appLog;
  const backoff = opts.backoffMs ?? [250, 500, 1000, 2000, 5000, 10_000];
  const stableMs = opts.stableMs ?? 30_000;
  const defaultTimeout = opts.timeoutMs ?? 10_000;

  let proc: HelperProcess | null = null;
  let closed = false;
  let starts = 0;
  let crashes = 0;
  let startedAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let nextId = 1;
  let hooksOn = false;
  const pending = new Map<number, Pending>();
  const queued: string[] = [];   // lines written while the helper is down (restarting)
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  function emit(event: string, data: unknown) {
    for (const cb of listeners.get(event) ?? []) {
      try { cb(data); } catch (e) { log(`vcli-win: ${event} listener: ${(e as Error).message}`); }
    }
  }

  function onLine(line: string) {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: string; event?: string; data?: unknown };
    try { msg = JSON.parse(line); } catch { log(`vcli-win: bad line: ${line.slice(0, 200)}`); return; }
    if (typeof msg.event === "string") { emit(msg.event, msg.data); return; }
    if (typeof msg.id !== "number") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  function write(line: string) {
    if (proc?.stdin && !proc.stdin.destroyed) proc.stdin.write(line + "\n");
    else queued.push(line);
  }

  function start() {
    if (closed) return;
    if (!exe) { log("vcli-win: helper exe not found"); return; }
    restartTimer = null;
    let p: HelperProcess;
    try { p = spawnFn(exe, []); } catch (e) { onExit(null, `spawn failed: ${(e as Error).message}`); return; }
    proc = p;
    starts++;
    startedAt = Date.now();
    let buf = "";
    p.stdout?.setEncoding("utf8");
    p.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        onLine(line);
      }
    });
    p.stderr?.setEncoding("utf8");
    p.stderr?.on("data", (chunk: string) => { for (const l of chunk.split(/\r?\n/)) if (l.trim()) log(l.startsWith("vcli-win") ? l : `vcli-win: ${l}`); });
    p.stdin?.on("error", () => {}); // EPIPE when it dies mid-write: the exit handler deals with it
    let gone = false;
    const done = (code: number | null, why: string) => { if (!gone) { gone = true; if (proc === p) onExit(code, why); } };
    p.on("exit", (code, signal) => done(code, signal ? `signal ${signal}` : `code ${code}`));
    p.on("error", (err) => done(null, err.message));
    // Requests made while it was down, then state the app expects to survive a restart.
    const backlog = queued.splice(0);
    if (hooksOn) backlog.unshift(JSON.stringify({ id: nextId++, method: "hooks.start", params: {} }));
    for (const l of backlog) write(l);
  }

  function onExit(code: number | null, why: string) {
    proc = null;
    for (const [id, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`vcli-win exited during ${p.method} (${why})`));
      pending.delete(id);
    }
    if (closed) return;
    if (startedAt && Date.now() - startedAt >= stableMs) crashes = 0;
    const delay = backoff[Math.min(crashes, backoff.length - 1)];
    crashes++;
    log(`vcli-win exited (${why}); restarting in ${delay} ms`);
    restartTimer = setTimeout(start, delay);
  }

  start();

  return {
    get starts() { return starts; },

    call<M extends Method>(method: M, params: Methods[M]["params"], timeoutMs?: number): Promise<Methods[M]["result"]> {
      if (closed) return Promise.reject(new Error("vcli-win helper is closed"));
      if (!exe) return Promise.reject(new Error("vcli-win.exe not found (run app/native/windows/build.sh)"));
      const id = nextId++;
      const ms = timeoutMs ?? METHOD_TIMEOUTS[method] ?? defaultTimeout;
      return new Promise<Methods[M]["result"]>((resolve, reject) => {
        const p: Pending = {
          method,
          resolve: (v) => {
            if (method === "hooks.start") hooksOn = true;
            if (method === "hooks.stop") hooksOn = false;
            resolve(v as Methods[M]["result"]);
          },
          reject,
        };
        if (ms > 0) p.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`vcli-win: ${method} timed out after ${ms} ms`));
        }, ms);
        pending.set(id, p);
        write(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },

    on<E extends Event>(event: E, cb: (data: Events[E]) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      const f = cb as (data: unknown) => void;
      set.add(f);
      return () => { set!.delete(f); };
    },

    close() {
      if (closed) return;
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      for (const [, p] of pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("vcli-win helper is closed")); }
      pending.clear();
      queued.length = 0;
      const p = proc;
      proc = null;
      if (!p) return;
      // Closing stdin is the helper's signal to exit; kill it if it doesn't.
      try { p.stdin?.end(); } catch {}
      const t = setTimeout(() => { try { p.kill(); } catch {} }, 1000);
      t.unref?.();
      p.on("exit", () => clearTimeout(t));
    },
  };
}

/** The helper exe: packaged at resources/bin/vcli-win.exe, in a dev build at build/resources/bin (build.mjs copies
 *  app/resources) or app/resources/bin (build.sh), else the dotnet output. Null when there's none. */
export function findHelperExe(o: { resourcesPath?: string; buildDir?: string; exists?: (p: string) => boolean } = {}): string | null {
  const exists = o.exists ?? existsSync;
  const resourcesPath = o.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath;
  const buildDir = o.buildDir ?? __dirname;
  const candidates = [
    resourcesPath && join(resourcesPath, "bin", "vcli-win.exe"),
    join(buildDir, "resources", "bin", "vcli-win.exe"),
    join(buildDir, "..", "resources", "bin", "vcli-win.exe"),
    join(buildDir, "..", "native", "windows", "bin", "Release", "net48", "vcli-win.exe"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => exists(p)) ?? null;
}
