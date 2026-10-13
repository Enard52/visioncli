import assert from "node:assert/strict";
import { test } from "node:test";
import { overlaySupport } from "../../src/main/ui/overlay/platform";

test("X11 sessions get everything", () => {
  const s = overlaySupport({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE" });
  assert.equal(s.placement, true);
  assert.equal(s.onTop, "yes");
  assert.equal(s.note, undefined);
});

test("Wayland via XWayland: placed and on top everywhere", () => {
  for (const desktop of ["GNOME", "KDE", "sway", "Hyprland"]) {
    const s = overlaySupport({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: desktop });
    assert.equal(s.backend, "x11");
    assert.equal(s.placement, true);
    assert.equal(s.onTop, "yes");
  }
});

test("Wayland without XWayland", () => {
  const s = overlaySupport({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
  assert.equal(s.placement, false);
  assert.match(s.note!, /XWayland/);
});

test("native Wayland Electron can't place overlays", () => {
  const s = overlaySupport({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, "wayland");
  assert.equal(s.backend, "wayland");
  assert.equal(s.placement, false);
  assert.match(s.note!, /ozone-platform=x11/);
});
