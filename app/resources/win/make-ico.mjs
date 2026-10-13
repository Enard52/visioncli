// Writes icon.ico (the Windows app, installer and shortcut icon) from docs/logo.png, pure Node: an ICO may hold PNGs
// as they are (Windows Vista+), so no image library is needed. 256 px is the logo itself; the smaller sizes are the
// Linux icons (resources/icons, downscaled from the same logo), since Windows picks the closest size per use.
//   node resources/win/make-ico.mjs        (from app/; commit the result)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..", "..");
const sources = [
  ...[16, 24, 32, 48, 64, 128].map((s) => join(app, "resources", "icons", `${s}x${s}.png`)),
  join(app, "..", "docs", "logo.png"),
];

/** Width and height from the PNG IHDR chunk. */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("not a PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const images = sources.map((f) => {
  const data = readFileSync(f);
  const [w, h] = pngSize(data);
  if (w !== h || w > 256) throw new Error(`${f}: icons must be square and at most 256 px (got ${w}x${h})`);
  return { w, data };
});

// ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, then the PNGs.
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ w, data }, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(w === 256 ? 0 : w, e); // 0 means 256
  header.writeUInt8(w === 256 ? 0 : w, e + 1);
  header.writeUInt8(0, e + 2); // no palette
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); // color planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
const out = join(here, "icon.ico");
writeFileSync(out, Buffer.concat([header, ...images.map((i) => i.data)]));
console.log(`${out}: ${images.map((i) => i.w).join(", ")} px`);
