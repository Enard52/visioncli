import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync, readdirSync, watch, type FSWatcher } from "node:fs";
import type { HotkeyEvent, Hotkeys } from "../contracts";
import { log } from "../log";
import { BTN_MOUSE_FIRST, BTN_MOUSE_LAST, EV_KEY, EV_REL, REL_HWHEEL, REL_HWHEEL_HI_RES, REL_WHEEL, REL_WHEEL_HI_RES, eventSize, parseEvents, procDevices } from "./evdev";
import { HoldMachine } from "./hold";
import { WinHotkeys } from "./win32";
import { winHelper } from "../desktop/windows/win32";

// Global hold-to-talk without grabbing anything, on X11 and every Wayland compositor:
// - evdev (primary): reads /dev/input/event* directly. Needs the user in the `input` group (one-time setup).
//   Each device is read by a `cat` child: a blocking fs.read per device would pin one of libuv's 4 threadpool threads.
// - XInput2 (X11 fallback without the input group): `xinput test-xi2 --root` raw events, which X sends for every
//   window. On Wayland, XWayland only sees its own windows, so there is no fallback there.
// Linux limitation: Esc / Alt+P / Alt+O / Alt+Enter are observed, not grabbed (no compositor-independent way to
// grab them), so the focused app also receives them. macOS grabs them only while the overlay is up for this reason.

export const SETUP_HINT = "Hold-to-talk needs to read the keyboard: run `sudo usermod -aG input $USER`, then log out and back in.";

export function createHotkeys(): Hotkeys {
  // Windows: the helper's low-level hooks feed the same HoldMachine (input/win32.ts).
  return process.platform === "win32" ? new WinHotkeys(winHelper()) : new LinuxHotkeys();
}

const which = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim() || null;

export function isX11Session(env = process.env): boolean {
  return !!env.DISPLAY && !env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "wayland";
}

class LinuxHotkeys extends EventEmitter implements Hotkeys {
  private machine = new HoldMachine((e) => this.fire(e));
  private devices = new Map<string, { proc: ChildProcess; down: Set<number> }>();
  private watcher: FSWatcher | null = null;
  private rescanTimers: NodeJS.Timeout[] = [];
  private xinput: ChildProcess | null = null;
  private stopped = false;

  private fire(e: HotkeyEvent) {
    log(`hotkey ${e.type}${e.type === "overlayKey" ? " " + e.key : ""}`);
    this.emit("hotkey", e);
  }

  async start(): Promise<{ backend: string; problem?: string }> {
    this.stopped = false;
    const scan = this.scan();
    if (scan.opened > 0) {
      this.watch();
      log(`hotkeys: evdev (${scan.opened} devices)`);
      return { backend: "evdev" };
    }
    if (isX11Session() && which("xinput")) {
      this.startXInput();
      log(`hotkeys: XInput2 (evdev ${scan.denied ? "not permitted" : "unavailable"})`);
      return { backend: "xinput2" };
    }
    if (scan.dirOk) this.watch(); // a keyboard plugged in later (or a seat ACL) still gets picked up
    log(`hotkeys: no readable keyboard (${scan.denied} denied)`);
    if (scan.dirOk && scan.denied === 0) return { backend: "evdev", problem: "No keyboard found yet. Plug one in and hold-to-talk starts working." };
    return { backend: scan.dirOk ? "evdev" : "none", problem: isX11Session() ? SETUP_HINT + " (Or install `xinput`.)" : SETUP_HINT };
  }

  setOverlayKeys(on: boolean) { this.machine.overlayKeys = on; }

  /** Optional (not in the contract): the app's phase is listening, so the next Alt press counts at once. */
  setListening(on: boolean) { this.machine.listening = on; }

  stop() {
    this.stopped = true;
    this.machine.stop();
    this.watcher?.close();
    this.watcher = null;
    this.rescanTimers.forEach(clearTimeout);
    for (const d of this.devices.values()) d.proc.kill();
    this.devices.clear();
    this.xinput?.kill();
    this.xinput = null;
  }

  // ── evdev ────────────────────────────────────────────────────────────────────────────────────────────────────

  private scan(): { opened: number; denied: number; dirOk: boolean } {
    let names: string[];
    try { names = readdirSync("/dev/input").filter((n) => /^event\d+$/.test(n)); } catch { return { opened: 0, denied: 0, dirOk: false }; }
    const proc = procDevices();
    const relevant = proc ? new Map(proc.filter((d) => !/visioncli/i.test(d.name)).map((d) => [d.event, d])) : null;
    let denied = 0;
    for (const n of names) {
      if (this.devices.has(n) || (relevant && !relevant.has(n))) continue;
      const path = `/dev/input/${n}`;
      try { closeSync(openSync(path, "r")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EACCES") denied++; continue; }
      this.open(n, path, relevant?.get(n)?.name ?? n);
    }
    return { opened: this.devices.size, denied, dirOk: true };
  }

  private open(id: string, path: string, name: string) {
    const proc = spawn("cat", [path], { stdio: ["ignore", "pipe", "ignore"] });
    const dev = { proc, down: new Set<number>() };
    this.devices.set(id, dev);
    const size = eventSize();
    let rest = Buffer.alloc(0);
    proc.stdout!.on("data", (chunk: Buffer) => {
      const parsed = parseEvents(rest.length ? Buffer.concat([rest, chunk]) : chunk, size);
      rest = Buffer.from(parsed.rest);
      for (const e of parsed.events) this.handle(dev.down, e.type, e.code, e.value);
    });
    proc.on("exit", () => {
      if (this.devices.get(id) !== dev) return;
      this.devices.delete(id);
      for (const code of dev.down) this.machine.key(code, false); // unplugged while held
      log(`hotkeys: ${name} gone`);
    });
    log(`hotkeys: reading ${name} (${id})`);
  }

  private handle(down: Set<number>, type: number, code: number, value: number) {
    if (isMotion(type, code)) this.lastMotion = Date.now();
    feedEvent(this.machine, down, type, code, value);
  }

  /** When the pointer last moved (ms), so the overlay reads its position only after it did. */
  lastMotion = 0;
  get seesMotion() { return !!this.xinput || this.devices.size > 0; }

  private watch() {
    if (this.watcher) return;
    try {
      this.watcher = watch("/dev/input", () => {
        // udev applies the group/ACL a moment after the node appears: look now and again shortly after.
        this.rescanTimers.forEach(clearTimeout);
        this.rescanTimers = [300, 1500].map((ms) => setTimeout(() => { if (!this.stopped) this.scan(); }, ms));
      });
    } catch (e) { log(`hotkeys: can't watch /dev/input: ${e}`); }
  }

  // ── XInput2 ──────────────────────────────────────────────────────────────────────────────────────────────────

  private startXInput() {
    const xtest = xtestDevices();
    this.xremap = modifierRemap(spawnSync("xmodmap", ["-pke"], { encoding: "utf8" }).stdout ?? "");
    if (this.xremap.size) log(`hotkeys: extra modifier keycodes ${[...this.xremap].map(([x, e]) => `${x}→${e === LEFTMETA ? "Super" : "Alt"}`).join(", ")}`);
    // xinput's stdout is block-buffered into a pipe; stdbuf makes it line-buffered so presses arrive at once.
    const cmd = which("stdbuf") ? ["stdbuf", "-oL", "xinput", "test-xi2", "--root"] : ["xinput", "test-xi2", "--root"];
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    this.xinput = p;
    const parser = new XI2Parser((ev) => {
      if (ev.type === "motion") { this.lastMotion = Date.now(); return; } // injected moves count too: the pill follows them
      if (xtest.has(ev.device) || xtest.has(ev.source)) return; // our own injected keys (xdotool/XTest)
      this.handleXI2(ev);
    });
    p.stdout!.setEncoding("utf8");
    p.stdout!.on("data", (s: string) => parser.feed(s));
    p.on("exit", (code) => {
      if (this.xinput !== p) return;
      this.xinput = null;
      this.machine.releaseAll();
      log(`hotkeys: xinput exited (${code})`);
      if (!this.stopped) setTimeout(() => { if (!this.stopped && !this.xinput) this.startXInput(); }, 2000);
    });
  }

  private xdown = new Set<number>();
  private xremap = new Map<number, number>();
  private handleXI2(ev: XI2Event) {
    if (ev.type === "button") {
      // 4–7 are the wheel; 1–3 and 8+ are buttons.
      if (ev.detail >= 4 && ev.detail <= 7) this.machine.scroll(); else this.machine.button();
      return;
    }
    // X keycodes are evdev codes + 8. The same key can arrive from the slave and the master device: dedupe.
    this.handle(this.xdown, EV_KEY, this.xremap.get(ev.detail) ?? ev.detail - 8, ev.type === "press" ? 1 : 0);
  }
}

const LEFTALT = 56, LEFTMETA = 125;

/**
 * X keycodes outside the usual evdev+8 layout that carry Alt or Super, from `xmodmap -pke`. VNC/RDP servers add
 * virtual keys for modifiers (TigerVNC: 204 Alt_L, 205 Meta_L, 206 Super_L) and a Mac's Command arrives as Meta or
 * Super through them. Meta on its own key (not Alt's shifted level) is the Command/Windows key: Super here.
 */
export function modifierRemap(xmodmap: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of xmodmap.split("\n")) {
    const m = /^keycode\s+(\d+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const x = +m[1], syms = m[2].split(/\s+/);
    const has = (...names: string[]) => names.some((n) => syms.includes(n));
    // Mode_switch on its own virtual key (Xorg's 203): noVNC sends a Mac's Command there.
    const code = has("Super_L", "Super_R", "Hyper_L", "Hyper_R") || (has("Meta_L", "Meta_R") && !has("Alt_L", "Alt_R"))
      || (has("Mode_switch") && x >= 200) ? LEFTMETA
      : has("Alt_L", "Alt_R") ? LEFTALT : 0;
    // The standard keys (Alt 64/108, Super 133/134) already map by keycode − 8.
    if (code && ![64, 108, 133, 134].includes(x)) map.set(x, code);
  }
  return map;
}

/** Mouse or touchpad movement (EV_REL X/Y, EV_ABS X/Y or multitouch X/Y). */
export const isMotion = (type: number, code: number) => (type === EV_REL && (code === 0 || code === 1)) || (type === 3 && (code === 0 || code === 1 || code === 53 || code === 54));

/** One evdev event from one device into the machine; `down` is that device's pressed keys (repeats and duplicates dropped). */
export function feedEvent(machine: HoldMachine, down: Set<number>, type: number, code: number, value: number) {
  if (type === EV_KEY) {
    if (value === 2) return; // key repeat
    if (code >= BTN_MOUSE_FIRST && code <= BTN_MOUSE_LAST) { if (value === 1) machine.button(); return; }
    if (code >= 0x100) return; // touch, stylus, joystick buttons
    if (value === 1) { if (down.has(code)) return; down.add(code); machine.key(code, true); }
    else if (value === 0) { if (!down.delete(code)) return; machine.key(code, false); }
  } else if (type === EV_REL && value !== 0 && (code === REL_WHEEL || code === REL_HWHEEL || code === REL_WHEEL_HI_RES || code === REL_HWHEEL_HI_RES)) {
    machine.scroll();
  }
}

export interface XI2Event { type: "press" | "release" | "button" | "motion"; device: number; source: number; detail: number }

/** Parses `xinput test-xi2 --root` output: "EVENT type 13 (RawKeyPress)" blocks with "device: 3 (11)" and "detail: 64". */
export class XI2Parser {
  private buf = "";
  private cur: { type: XI2Event["type"]; device?: number; source?: number; detail?: number } | null = null;
  constructor(private onEvent: (e: XI2Event) => void) {}

  feed(text: string) {
    this.buf += text;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string) {
    const ev = /^EVENT type \d+ \((\w+)\)/.exec(line);
    if (ev) {
      this.flush();
      if (ev[1] === "RawMotion") { this.onEvent({ type: "motion", device: -1, source: -1, detail: 0 }); this.cur = null; return; }
      const t = ev[1] === "RawKeyPress" ? "press" : ev[1] === "RawKeyRelease" ? "release" : ev[1] === "RawButtonPress" ? "button" : null;
      this.cur = t ? { type: t } : null;
      return;
    }
    if (!this.cur) return;
    const dev = /^\s+device:\s*(\d+)(?:\s*\((\d+)\))?/.exec(line);
    if (dev) { this.cur.device = +dev[1]; this.cur.source = dev[2] ? +dev[2] : +dev[1]; return; }
    const det = /^\s+detail:\s*(\d+)/.exec(line);
    if (det) { this.cur.detail = +det[1]; this.flush(); }
  }

  private flush() {
    const c = this.cur;
    this.cur = null;
    if (c && c.detail !== undefined) this.onEvent({ type: c.type, device: c.device ?? -1, source: c.source ?? -1, detail: c.detail });
  }
}

/** The XTEST devices' ids (what xdotool and XTest injection type through), from `xinput list`. */
function xtestDevices(): Set<number> {
  const out = spawnSync("xinput", ["list"], { encoding: "utf8" }).stdout ?? "";
  return parseXTestIds(out, process.env.VISIONCLI_XTEST_KEYS === "1");
}

export function parseXTestIds(list: string, keep = false): Set<number> {
  const ids = new Set<number>();
  if (keep) return ids;
  for (const line of list.split("\n")) {
    const m = /XTEST.*\bid=(\d+)/.exec(line);
    if (m) ids.add(+m[1]);
  }
  return ids;
}
