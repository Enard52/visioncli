import { deflateSync } from "node:zlib";

// A tiny RGBA painter for the tray icon and the usage rings (UsageArt / MenuIcon on macOS). No canvas in the main
// process, so shapes are rasterized here with 4×4 supersampling and encoded as PNG for nativeImage.createFromBuffer.
// Coordinates are in "points"; `scale` maps them to pixels (2 for HiDPI).

export type RGBA = [number, number, number, number]; // 0…255

type Inside = (x: number, y: number) => boolean;

const SS = 4; // subsamples per axis

export class Painter {
  readonly px: Uint8ClampedArray;
  readonly w: number;
  readonly h: number;

  constructor(width: number, height: number, readonly scale = 1) {
    this.w = Math.round(width * scale);
    this.h = Math.round(height * scale);
    this.px = new Uint8ClampedArray(this.w * this.h * 4);
  }

  /** Paints `color` wherever `inside` (in points) holds, weighted by coverage; `bounds` limits the scan. */
  private cover(color: RGBA, inside: Inside, bounds?: { x0: number; y0: number; x1: number; y1: number }) {
    const s = this.scale;
    const x0 = Math.max(0, Math.floor((bounds?.x0 ?? 0) * s)), y0 = Math.max(0, Math.floor((bounds?.y0 ?? 0) * s));
    const x1 = Math.min(this.w, Math.ceil((bounds?.x1 ?? this.w / s) * s)), y1 = Math.min(this.h, Math.ceil((bounds?.y1 ?? this.h / s) * s));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
          if (inside((px + (sx + 0.5) / SS) / s, (py + (sy + 0.5) / SS) / s)) hits++;
        }
        if (hits) this.blend(px, py, color, hits / (SS * SS));
      }
    }
  }

  /** Source-over blending (straight alpha). */
  private blend(x: number, y: number, [r, g, b, a]: RGBA, coverage: number) {
    const i = (y * this.w + x) * 4;
    const sa = (a / 255) * coverage;
    const da = this.px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    const mix = (src: number, dst: number) => (src * sa + dst * da * (1 - sa)) / oa;
    this.px[i] = mix(r, this.px[i]);
    this.px[i + 1] = mix(g, this.px[i + 1]);
    this.px[i + 2] = mix(b, this.px[i + 2]);
    this.px[i + 3] = oa * 255;
  }

  /** A stroked arc: center, radius, line width; angles in degrees, 0 = 12 o'clock, clockwise. Round caps. */
  arc(cx: number, cy: number, r: number, width: number, from: number, to: number, color: RGBA) {
    const half = width / 2;
    const sweep = to - from;
    if (sweep <= 0) return;
    const full = sweep >= 360;
    const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
    const cap = (deg: number) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
    const [ax, ay] = cap(from), [bx, by] = cap(to);
    this.cover(color, (x, y) => {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (Math.abs(d - r) <= half) {
        if (full) return true;
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 0 at 12 o'clock, clockwise
        deg = (((deg - from) % 360) + 360) % 360;
        if (deg <= sweep) return true;
      }
      return Math.hypot(x - ax, y - ay) <= half || Math.hypot(x - bx, y - by) <= half;
    }, { x0: cx - r - width, y0: cy - r - width, x1: cx + r + width, y1: cy + r + width });
  }

  ring(cx: number, cy: number, r: number, width: number, color: RGBA) { this.arc(cx, cy, r, width, 0, 360, color); }

  disc(cx: number, cy: number, r: number, color: RGBA) {
    this.cover(color, (x, y) => Math.hypot(x - cx, y - cy) <= r, { x0: cx - r - 1, y0: cy - r - 1, x1: cx + r + 1, y1: cy + r + 1 });
  }

  /** A stroked polyline (round joins and caps). */
  polyline(points: [number, number][], width: number, color: RGBA, closed = false) {
    const half = width / 2;
    const pts = closed ? [...points, points[0]] : points;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    this.cover(color, (x, y) => {
      for (let i = 0; i + 1 < pts.length; i++) if (segDist(x, y, pts[i], pts[i + 1]) <= half) return true;
      return pts.length === 1 && Math.hypot(x - pts[0][0], y - pts[0][1]) <= half;
    }, { x0: Math.min(...xs) - width, y0: Math.min(...ys) - width, x1: Math.max(...xs) + width, y1: Math.max(...ys) + width });
  }

  /** A filled polygon (even-odd). */
  polygon(points: [number, number][], color: RGBA) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    this.cover(color, (x, y) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, { x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 });
  }

  png(): Buffer { return encodePNG(this.w, this.h, this.px); }
}

/** Points along a cubic Bézier (for polyline). */
export function bezier(p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number], steps = 16): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

function segDist(x: number, y: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA, no filtering (icons are tiny). */
export function encodePNG(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
