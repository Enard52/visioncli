import { randomBytes } from "node:crypto";
import type { InputInjector, Point } from "../../contracts";
import { log } from "../../log";
import { settings } from "../../settings";
import { type Bus, Variant, call, connect, getProp, onSignal, unwrap } from "../atspi/dbus";
import { LONG_TEXT, canPaste, pasteText } from "./clipboard";
import { sleep } from "./exec";
import { type Chord, MOD_KEYSYMS, charKeysym, keysym, parseCombo } from "./keys";

// Wayland (GNOME, KDE, any compositor whose xdg-desktop-portal backend has RemoteDesktop): the RemoteDesktop portal,
// combined with ScreenCast so absolute pointer motion has a stream to be relative to. Starting it shows one consent
// dialog; the restore token (persist_mode 2 = until revoked) is kept in settings so later runs don't ask again.
// The session starts on first use, not at launch, so the dialog appears when computer control is first used (as
// macOS's Accessibility prompt does). Portal events go through the compositor, never through /dev/input, so the
// evdev hotkey listener can't see them: nothing to filter.

const DEST = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const RD = "org.freedesktop.portal.RemoteDesktop";
const SC = "org.freedesktop.portal.ScreenCast";
const TOKEN_KEY = "remoteDesktopToken";
const BTN_LEFT = 0x110, BTN_RIGHT = 0x111;

interface Stream { node: number; x: number; y: number; w: number; h: number }

/** True when the portal implements RemoteDesktop (GNOME's and KDE's do; wlroots' and Hyprland's don't). */
export async function portalAvailable(): Promise<boolean> {
  let bus: Bus | undefined;
  try {
    bus = await connect(undefined, 1500);
    const types = await getProp<number>(bus, DEST, PATH, RD, "AvailableDeviceTypes", 1500);
    return (types & 3) === 3;
  } catch { return false; } finally { try { bus?.disconnect(); } catch {} }
}

/** Streams → which one holds a global point, in its own coordinates. */
export function locate(streams: Stream[], p: Point): { stream: Stream; x: number; y: number } | null {
  const s = streams.find((s) => p.x >= s.x && p.y >= s.y && p.x < s.x + s.w && p.y < s.y + s.h) ?? streams[0];
  if (!s) return null;
  return { stream: s, x: Math.min(Math.max(p.x - s.x, 0), s.w - 1), y: Math.min(Math.max(p.y - s.y, 0), s.h - 1) };
}

export function createPortalInjector(): InputInjector {
  let bus: Bus | null = null;
  let session: string | null = null;
  let streams: Stream[] = [];
  let starting: Promise<void> | null = null;

  async function request(iface: string, member: string, signature: string, body: unknown[], ms = 30_000): Promise<Record<string, any>> {
    const token = "vcli" + randomBytes(6).toString("hex");
    const sender = bus!.name!.slice(1).replace(/\./g, "_");
    const path = `${PATH}/request/${sender}/${token}`;
    const opts = body[body.length - 1] as Record<string, Variant>;
    opts.handle_token = new Variant("s", token);
    let resolve!: (v: [number, Record<string, any>]) => void;
    const got = new Promise<[number, Record<string, any>]>((r) => (resolve = r));
    const off = await onSignal(bus!, { path, iface: "org.freedesktop.portal.Request", member: "Response" }, (b) => resolve([b[0], unwrap(b[1]) as any]));
    try {
      await call(bus!, { dest: DEST, path: PATH, iface, member, signature, body }, 10_000);
      let t: NodeJS.Timeout;
      const [code, results] = await Promise.race([got, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${member} timed out`)), ms)))])
        .finally(() => clearTimeout(t));
      if (code !== 0) throw new Error(code === 1 ? "Remote control was declined" : `${member} failed (${code})`);
      return results;
    } finally { off(); }
  }

  async function start() {
    bus = await connect();
    const version = await getProp<number>(bus, DEST, PATH, RD, "version").catch(() => 1);
    const created = await request(RD, "CreateSession", "a{sv}", [{ session_handle_token: new Variant("s", "vcli" + randomBytes(4).toString("hex")) }]);
    const handle = created.session_handle as string;
    const dev: Record<string, Variant> = { types: new Variant("u", 3) }; // keyboard | pointer
    const saved = settings.getStore<string>(TOKEN_KEY);
    if (version >= 2) {
      dev.persist_mode = new Variant("u", 2);
      if (saved) dev.restore_token = new Variant("s", saved);
    }
    await request(RD, "SelectDevices", "oa{sv}", [handle, dev]);
    // Absolute motion needs a stream; without ScreenCast only relative motion would work.
    await request(SC, "SelectSources", "oa{sv}", [handle, { types: new Variant("u", 1), multiple: new Variant("b", true) }])
      .catch((e) => log(`portal: ScreenCast SelectSources: ${e.message}`));
    const res = await request(RD, "Start", "osa{sv}", [handle, "", {}], 180_000); // waits for the user's consent
    if (res.restore_token) settings.setStore(TOKEN_KEY, res.restore_token);
    streams = ((res.streams ?? []) as [number, Record<string, any>][]).map(([node, p]) => ({
      node, x: p.position?.[0] ?? 0, y: p.position?.[1] ?? 0, w: p.size?.[0] ?? 1 << 15, h: p.size?.[1] ?? 1 << 15,
    }));
    session = handle;
    const off = await onSignal(bus, { path: handle, iface: "org.freedesktop.portal.Session", member: "Closed" }, () => {
      log("portal: remote desktop session closed");
      session = null;
      off();
    });
    log(`portal: remote desktop started (devices ${res.devices}, ${streams.length} stream(s))`);
  }

  async function ready(): Promise<string> {
    if (session && bus) return session;
    starting ??= start().finally(() => (starting = null));
    try { await starting; } catch (e) {
      try { bus?.disconnect(); } catch {}
      bus = null;
      throw e;
    }
    if (!session) throw new Error("Remote control session didn't start");
    return session;
  }

  const notify = async (member: string, signature: string, args: unknown[]) => {
    const s = await ready();
    await call(bus!, { dest: DEST, path: PATH, iface: RD, member, signature: "oa{sv}" + signature, body: [s, {}, ...args] }, 3000);
  };

  async function move(p: Point) {
    await ready();
    const at = locate(streams, p);
    if (!at) throw new Error("No screen stream for pointer motion");
    await notify("NotifyPointerMotionAbsolute", "udd", [at.stream.node, at.x, at.y]);
  }
  const button = (b: number, down: boolean) => notify("NotifyPointerButton", "iu", [b, down ? 1 : 0]);
  const sym = (k: number, down: boolean) => notify("NotifyKeyboardKeysym", "iu", [k, down ? 1 : 0]);

  async function chord(c: Chord) {
    const mods = c.mods.map((m) => MOD_KEYSYMS[m]);
    for (const m of mods) await sym(m, true);
    const k = keysym(c.key);
    await sym(k, true);
    await sleep(20);
    await sym(k, false);
    for (const m of mods.reverse()) await sym(m, false);
  }

  return {
    backend: "portal",
    move,
    async click(p, which, count) {
      await move(p);
      await sleep(40);
      const b = which === "right" ? BTN_RIGHT : BTN_LEFT;
      for (let i = 0; i < Math.max(1, count); i++) {
        await button(b, true);
        await sleep(30);
        await button(b, false);
        await sleep(60);
      }
    },
    async type(text) {
      if (text.length > LONG_TEXT && canPaste()) return pasteText(text, () => chord({ mods: ["ctrl"], key: "v" }));
      for (const ch of text) {
        if (ch === "\r") continue;
        const k = charKeysym(ch);
        await sym(k, true);
        await sym(k, false);
        await sleep(8);
      }
    },
    async key(combo) {
      for (const c of parseCombo(combo)) { await chord(c); await sleep(20); }
    },
    async scroll(dx, dy, at) {
      if (at) { await move(at); await sleep(40); }
      // Wayland axes: positive = down/right; ours (CGEvent's): dy > 0 = up, dx > 0 = left.
      if (dy) await notify("NotifyPointerAxisDiscrete", "ui", [0, -Math.round(dy)]);
      if (dx) await notify("NotifyPointerAxisDiscrete", "ui", [1, -Math.round(dx)]);
    },
    async drag(a, b) {
      await move(a);
      await sleep(50);
      await button(BTN_LEFT, true);
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        await move({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        await sleep(12);
      }
      await button(BTN_LEFT, false);
    },
  };
}
