import type { InputInjector } from "../../contracts";
import { log } from "../../log";
import { winHelper } from "../windows/win32";
import { which } from "./exec";
import { createPortalInjector, portalAvailable } from "./portal";
import { createWin32Injector } from "./win32";
import { createWlrootsInjector } from "./wlroots";
import { createX11Injector } from "./x11";

// Synthetic mouse/keyboard input (Computer in Control.swift), picking a backend for the session:
//   X11                          → XTest (xdotool)
//   Wayland with RemoteDesktop   → the portal (GNOME, KDE): one consent dialog, remembered
//   other Wayland (Sway, Hyprland…) → swaymsg / hyprctl / ydotool for the pointer, wtype / ydotool for keys
//   nothing usable               → an injector whose calls fail with what to install
//   Windows                      → SendInput through the vcli-win.exe helper (its events are tagged, like macOS)
//
// Our own events and the hotkey listener: macOS tags CGEvents; Linux can't tag XTest or uinput events. Instead:
//   - isInjecting() is true while an action runs (and 150 ms after), so the hotkeys module can drop what it sees then;
//   - SYNTHETIC_DEVICES names the devices synthetic events come from (XInput2 sourceid / evdev device name), to skip.
//   Portal, swaymsg and wtype events never pass through /dev/input, so the evdev listener doesn't see them at all.

export const SYNTHETIC_DEVICES = ["Virtual core XTEST pointer", "Virtual core XTEST keyboard", "ydotoold virtual device"];

let inFlight = 0;
let lastEnd = 0;
export const isInjecting = () => inFlight > 0 || Date.now() - lastEnd < 150;

function tracked(inner: InputInjector): InputInjector {
  const wrap = <A extends unknown[]>(f: (...a: A) => Promise<void>) => async (...a: A) => {
    inFlight++;
    try { await f(...a); } finally { inFlight--; lastEnd = Date.now(); }
  };
  return {
    backend: inner.backend,
    move: wrap(inner.move), click: wrap(inner.click), type: wrap(inner.type), key: wrap(inner.key),
    scroll: wrap(inner.scroll), drag: wrap(inner.drag),
  };
}

function unavailable(why: string): InputInjector {
  const fail = async () => { throw new Error(why); };
  return { backend: "none", move: fail, click: fail, type: fail, key: fail, scroll: fail, drag: fail };
}

export async function createInjector(): Promise<InputInjector> {
  const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland";
  let inj: InputInjector;
  if (process.platform === "win32") {
    inj = createWin32Injector(winHelper());
  } else if (!wayland) {
    inj = which("xdotool") ? createX11Injector() : unavailable("Computer control needs xdotool: install the xdotool package");
  } else if (await portalAvailable()) {
    inj = createPortalInjector();
  } else {
    inj = createWlrootsInjector()
      // XWayland's XTest only reaches X11 apps, but it's better than nothing.
      ?? (process.env.DISPLAY && which("xdotool") ? createX11Injector() : null)
      ?? unavailable("Computer control on this Wayland desktop needs wtype (typing) and ydotool with ydotoold running (mouse)");
  }
  log(`input: ${inj.backend}`);
  return tracked(inj);
}
