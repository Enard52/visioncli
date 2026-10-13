// What the display server lets the overlay do. macOS panels can always float above everything at any position; on
// Linux that depends on the session:
//  - X11: the overlay windows are override-redirect (window.ts): placed exactly, above managed windows, on every
//    workspace (verified with Openbox under Xvfb, also with the app window raised and focused over them).
//  - Wayland, Electron on XWayland (Electron 33's default, ozone x11): the same override-redirect windows are
//    "unmanaged" X11 surfaces that compositors place at their X coordinates and draw on top: verified on Sway
//    (headless, over tiled and full-screen native Wayland windows); Mutter and KWin do the same for X11 menus/tooltips.
//  - Wayland, Electron native (--ozone-platform=wayland): xdg-shell has neither absolute positions nor always-on-top,
//    and Electron has no layer-shell. The bubble would open centred like a normal window. Don't run the overlay that way.

export interface OverlaySupport {
  session: "x11" | "wayland";
  /** Electron's own display backend. */
  backend: "x11" | "wayland";
  desktop: string;
  /** Windows land exactly where they're placed. */
  placement: boolean;
  /** "yes": stays above everything; "floating": above normal windows only; "no": ordinary window. */
  onTop: "yes" | "floating" | "no";
  /** Set when something is reduced, for logs and the setup/doctor screen. */
  note?: string;
}

export function overlaySupport(env: NodeJS.ProcessEnv = process.env, ozoneSwitch = ""): OverlaySupport {
  const session = env.XDG_SESSION_TYPE === "wayland" || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "x11") ? "wayland" : "x11";
  const ozone = (ozoneSwitch || env.ELECTRON_OZONE_PLATFORM_HINT || "x11").toLowerCase();
  const backend = session === "wayland" && (ozone === "wayland" || (ozone === "auto" && !!env.WAYLAND_DISPLAY)) ? "wayland" : "x11";
  const desktop = (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "").toLowerCase();
  if (session === "x11") return { session, backend, desktop, placement: true, onTop: "yes" };
  if (backend === "wayland") {
    return { session, backend, desktop, placement: false, onTop: "no",
      note: "Electron runs as a native Wayland client: overlays can't be positioned or kept on top. Start VisionCLI with --ozone-platform=x11 (XWayland)." };
  }
  // Compositors without XWayland can't show the overlay at all on XWayland; Electron then can't start on X11 either.
  if (!env.DISPLAY) {
    return { session, backend, desktop, placement: false, onTop: "no", note: "No XWayland (DISPLAY unset): install/enable XWayland for the overlay." };
  }
  return { session, backend, desktop, placement: true, onTop: "yes" };
}
