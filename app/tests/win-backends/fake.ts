import type { WinHelper } from "../../src/main/desktop/windows/win32";
import type { Event, Events, Method, Methods } from "../../src/main/platform/win32/protocol";

export type Handlers = { [M in Method]?: (params: Methods[M]["params"]) => Methods[M]["result"] | Promise<Methods[M]["result"]> };

/** A helper that answers from `handlers` (a missing one rejects like an unknown method) and records every call. */
export function fakeHelper(handlers: Handlers = {}) {
  const calls: { method: Method; params: any; timeout?: number }[] = [];
  const listeners = new Map<string, ((d: any) => void)[]>();
  const helper: WinHelper & { calls: typeof calls; emit<E extends Event>(e: E, d: Events[E]): void; of(m: Method): any[] } = {
    calls,
    async call(method, params, timeoutMs) {
      calls.push({ method, params, timeout: timeoutMs });
      const h = handlers[method] as ((p: unknown) => unknown) | undefined;
      if (!h) throw new Error(`unknown method ${method}`);
      return (await h(params)) as never;
    },
    on(event, cb) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb as (d: any) => void]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== cb));
    },
    close() {},
    emit(e, d) { for (const cb of listeners.get(e) ?? []) cb(d); },
    of(m) { return calls.filter((c) => c.method === m).map((c) => c.params); },
  };
  return helper;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
