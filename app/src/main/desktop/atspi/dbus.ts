import { Message, sessionBus, Variant, type MessageBus } from "dbus-next";

// Raw D-Bus calls (no introspection): AT-SPI trees have thousands of objects and the portal's Request objects are
// short-lived, so building proxy objects for each would be slow or racy.

export { Variant };
/** dbus-next sets `name` (the unique name) after Hello; its typings leave it out. */
export type Bus = MessageBus & { name: string | null };

export interface Call {
  dest: string;
  path: string;
  iface: string;
  member: string;
  signature?: string;
  body?: unknown[];
}

/** A bus whose unique name is known (after Hello); rejects if it can't connect within `ms`. */
export async function connect(busAddress?: string, ms = 3000): Promise<Bus> {
  const bus = sessionBus(busAddress ? { busAddress } : undefined) as Bus; // a new connection each time
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { bus.disconnect(); } catch {} reject(new Error("D-Bus connect timed out")); }, ms);
    const ok = () => { clearTimeout(t); resolve(bus); };
    if (bus.name) return ok();
    bus.once("connect", ok);
    bus.once("error", (e: Error) => { clearTimeout(t); reject(e); });
  });
}

/** One method call; `ms` = 0 waits forever (a press that opens a dialog may take a while to return). */
export async function call<T = any>(bus: Bus, c: Call, ms = 1000): Promise<T> {
  const p = bus.call(new Message({
    destination: c.dest, path: c.path, interface: c.iface, member: c.member, signature: c.signature ?? "", body: c.body ?? [],
  }));
  const reply = ms > 0 ? await withTimeout(p, ms, `${c.iface}.${c.member}`) : await p;
  const body = reply?.body ?? [];
  return (body.length === 1 ? body[0] : body) as T;
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]);
}

export async function getProp<T = any>(bus: Bus, dest: string, path: string, iface: string, name: string, ms = 1000): Promise<T> {
  const v = await call<Variant>(bus, { dest, path, iface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss", body: [iface, name] }, ms);
  return unwrap(v) as T;
}

export function setProp(bus: Bus, dest: string, path: string, iface: string, name: string, value: Variant, ms = 1000) {
  return call(bus, { dest, path, iface: "org.freedesktop.DBus.Properties", member: "Set", signature: "ssv", body: [iface, name, value] }, ms);
}

/** Variants (and a{sv} dicts of them) → plain values. */
export function unwrap(v: unknown): unknown {
  if (v instanceof Variant) return unwrap(v.value);
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, unwrap(x)]));
  }
  return v;
}

/** Subscribes to one signal (match rule + filter); returns an unsubscribe function. */
export async function onSignal(bus: Bus, rule: { path?: string; iface: string; member: string }, fn: (body: any[]) => void) {
  const match = [`type='signal'`, `interface='${rule.iface}'`, `member='${rule.member}'`, rule.path ? `path='${rule.path}'` : ""]
    .filter(Boolean).join(",");
  const handler = (m: Message) => {
    if (m.type === 4 /* SIGNAL */ && m.interface === rule.iface && m.member === rule.member && (!rule.path || m.path === rule.path)) fn(m.body);
  };
  bus.on("message", handler);
  await call(bus, { dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "AddMatch", signature: "s", body: [match] });
  return () => {
    bus.removeListener("message", handler);
    call(bus, { dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "RemoveMatch", signature: "s", body: [match] }).catch(() => {});
  };
}
