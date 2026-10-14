import { Painter, type RGBA } from "./painter";

// The tray icon (MenuIcon: the aperture mark) and the usage rings (UsageArt.ring), as PNG buffers.
// macOS draws the rings as text attachments next to the icon; a StatusNotifier icon is a square with no text, so the
// session ring goes around the eye and the week ring just inside it. The numbers are in the tooltip and the menu.

export const GREEN: RGBA = [52, 199, 89, 255];
export const ORANGE: RGBA = [255, 149, 0, 255];
export const RED: RGBA = [255, 59, 48, 255];

/** UsageArt.color */
export function usageColor(percent: number): RGBA {
  return percent >= 80 ? RED : percent >= 50 ? ORANGE : GREEN;
}

const clamp = (p: number) => Math.min(Math.max(p, 0), 100);

/** The VisionCLI mark (docs/brand/mark.svg, macOS MenuIcon): six aperture segments around a pupil, `size` points
 *  across, centred on (cx, cy). */
function mark(p: Painter, cx: number, cy: number, size: number, color: RGBA) {
  const r = size * 0.335, width = size * 0.125;
  // Segments start where the SVG's dash pattern does (rotated −70° from 3 o'clock = 20° on the clock); the round caps
  // eat into each gap, so the arcs are a little shorter than the dash.
  for (let i = 0; i < 6; i++) p.arc(cx, cy, r, width, 20 + i * 60, 20 + i * 60 + 24, color);
  p.disc(cx, cy, size * 0.12, color);
}

/** A progress ring: faint track, colored arc from 12 o'clock clockwise (UsageArt.ring). */
function meter(p: Painter, cx: number, cy: number, r: number, width: number, percent: number, track: RGBA) {
  p.ring(cx, cy, r, width, track);
  const pc = clamp(percent);
  if (pc > 0) p.arc(cx, cy, r, width, 0, (360 * pc) / 100, usageColor(pc));
}

/**
 * The tray icon, 22×22 points at `scale`. `light` = a light glyph for dark panels (GNOME's top bar, dark themes).
 * `rings`: the session (and optionally the week) usage to draw around the mark.
 */
export function trayIcon(opts: { light: boolean; rings?: { session: number; week: number | null } | null; scale?: number }): Buffer {
  const S = 22;
  const p = new Painter(S, S, opts.scale ?? 1);
  const glyph: RGBA = opts.light ? [242, 242, 242, 255] : [30, 30, 30, 255];
  const track: RGBA = [glyph[0], glyph[1], glyph[2], 64];
  const r = opts.rings;
  if (!r) {
    mark(p, 11, 11, 20, glyph);
  } else if (r.week === null) {
    meter(p, 11, 11, 9.9, 2.2, r.session, track);
    mark(p, 11, 11, 13.5, glyph);
  } else {
    meter(p, 11, 11, 9.9, 2.2, r.session, track);
    meter(p, 11, 11, 6.9, 2.0, r.week, track);
    mark(p, 11, 11, 9, glyph);
  }
  return p.png();
}

/** A small ring for menu rows (UsageCard meters), 16×16 points. */
export function ringIcon(percent: number, light: boolean, scale = 1): Buffer {
  const p = new Painter(16, 16, scale);
  meter(p, 8, 8, 6, 2.2, percent, light ? [255, 255, 255, 64] : [0, 0, 0, 64]);
  return p.png();
}

/** exclamationmark.triangle.fill, orange, 16×16 points. */
export function warningIcon(scale = 1): Buffer {
  const p = new Painter(16, 16, scale);
  p.polygon([[8, 1.5], [15, 14], [1, 14]], ORANGE);
  p.polyline([[8, 6], [8, 9.6]], 1.8, [255, 255, 255, 255]);
  p.disc(8, 11.9, 1, [255, 255, 255, 255]);
  return p.png();
}

/** gauge.with.dots.needle.33percent, in the menu's text color, 16×16 points. */
export function gaugeIcon(light: boolean, scale = 1): Buffer {
  const p = new Painter(16, 16, scale);
  const c: RGBA = light ? [235, 235, 235, 255] : [40, 40, 40, 255];
  p.arc(8, 9, 6, 1.6, -120, 120, c);
  p.polyline([[8, 9], [5.2, 6.4]], 1.6, c);
  p.disc(8, 9, 1.4, c);
  return p.png();
}
