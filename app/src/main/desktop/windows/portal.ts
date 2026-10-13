// The session bus (dbus-next, loaded lazily so nothing touches D-Bus until a Wayland backend needs it) and the
// xdg-desktop-portal Screenshot portal: a whole-desktop PNG without a dialog (interactive=false).

import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { MessageBus } from "dbus-next";

let bus: MessageBus | null = null;

export async function dbusNext(): Promise<typeof import("dbus-next")> {
  return require("dbus-next");
}

export async function sessionBus(): Promise<MessageBus> {
  if (bus) return bus;
  const dbus = await dbusNext();
  const b = dbus.sessionBus();
  b.on("error", () => { if (bus === b) bus = null; });
  // No session bus (a bare TTY, a container) must fail fast rather than hang every caller.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      busCall(b, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId", "", []),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No D-Bus session bus.")), 3000); }),
    ]);
  } catch (e) {
    try { b.disconnect(); } catch {}
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return (bus = b);
}

/** A raw method call (no introspection round-trip). Resolves the reply body. */
export async function busCall(b: MessageBus, destination: string, path: string, iface: string, member: string,
  signature: string, body: any[]): Promise<any[]> {
  const { Message, MessageType } = await dbusNext();
  const reply = await b.call(new Message({ destination, path, interface: iface, member, signature, body }));
  if (reply?.type === MessageType.ERROR) throw new Error(`${reply.errorName}: ${reply.body?.[0] ?? ""}`);
  return reply?.body ?? [];
}

export async function nameHasOwner(name: string): Promise<boolean> {
  try {
    const b = await sessionBus();
    return !!(await busCall(b, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", "s", [name]))[0];
  } catch {
    return false;
  }
}

/** The Request object path a portal call with `token` will use (lets us subscribe before calling). */
export function requestPath(uniqueName: string, token: string): string {
  return `/org/freedesktop/portal/desktop/request/${uniqueName.replace(/^:/, "").replace(/\./g, "_")}/${token}`;
}

/** Response codes: 0 ok, 1 cancelled / denied by the user, 2 other. */
export function portalError(code: number): string {
  return code === 1
    ? "The screenshot was refused. Allow VisionCLI to take screenshots when your desktop asks (Settings → Privacy → Screenshots)."
    : "The desktop's screenshot portal failed. Make sure xdg-desktop-portal and its backend (-gnome, -kde, -wlr, -hyprland) are installed.";
}

/** Whole-desktop screenshot through org.freedesktop.portal.Screenshot. Deletes the portal's file after reading. */
export async function portalScreenshot(timeoutMs = 30_000): Promise<Buffer> {
  const dbus = await dbusNext();
  const b = await sessionBus();
  const token = `visioncli${process.pid}_${Date.now()}`;
  const handle = requestPath((b as any).name as string, token);
  const match = `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${handle}'`;
  await busCall(b, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", [match]);
  let onMessage: (m: any) => void = () => {};
  try {
    const response = new Promise<[number, Record<string, any>]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The screenshot portal didn't answer.")), timeoutMs);
      onMessage = (m) => {
        if (m.type === dbus.MessageType.SIGNAL && m.path === handle && m.member === "Response") {
          clearTimeout(timer);
          resolve(m.body as [number, Record<string, any>]);
        }
      };
      b.on("message", onMessage);
    });
    await busCall(b, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot",
      "Screenshot", "sa{sv}", ["", {
        handle_token: new dbus.Variant("s", token),
        interactive: new dbus.Variant("b", false),
        modal: new dbus.Variant("b", false),
      }]);
    const [code, results] = await response;
    if (code !== 0) throw new Error(portalError(code));
    const uri = results?.uri?.value as string | undefined;
    if (!uri) throw new Error(portalError(2));
    const file = fileURLToPath(uri);
    const png = await readFile(file);
    await unlink(file).catch(() => {}); // the portal saved it to ~/Pictures; it's ours, don't leave it behind
    return png;
  } finally {
    b.removeListener("message", onMessage);
    busCall(b, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RemoveMatch", "s", [match]).catch(() => {});
  }
}
