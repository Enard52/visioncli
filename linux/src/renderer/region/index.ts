// Drag to select a region (Overlays.swift SelectionView): the display dims, a crosshair drags out a cyan box that
// cuts through the dim; release sends the rect (DIPs local to this display) on "region:done", esc sends null.

import type { Point, Rect } from "../../main/contracts";
import { vcli } from "../shared/bridge";

const root = document.getElementById("root")!;
root.innerHTML = `<svg class="canvas"><path class="dim" fill-rule="evenodd"/><rect class="sel" rx="4"/></svg>
  <div class="hint">Drag around what you mean · keep talking · esc to cancel</div>`;
const dim = root.querySelector<SVGPathElement>(".dim")!;
const sel = root.querySelector<SVGRectElement>(".sel")!;
const hint = root.querySelector<HTMLElement>(".hint")!;
let start: Point | null = null, current: Point | null = null;
let finished = false;

function selection(): Rect | null {
  if (!start || !current) return null;
  return { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(start.x - current.x), height: Math.abs(start.y - current.y) };
}

function draw() {
  const w = innerWidth, h = innerHeight, r = selection();
  const hole = r ? `M${r.x + 4},${r.y} h${r.width - 8} a4,4 0 0 1 4,4 v${r.height - 8} a4,4 0 0 1 -4,4 h-${r.width - 8} a4,4 0 0 1 -4,-4 v-${r.height - 8} a4,4 0 0 1 4,-4 Z` : "";
  dim.setAttribute("d", `M0,0 H${w} V${h} H0 Z ${r && r.width > 8 && r.height > 8 ? hole : ""}`);
  sel.style.display = r ? "" : "none";
  if (r) for (const [k, v] of Object.entries(r)) sel.setAttribute(k, `${v}`);
  hint.hidden = !!r;
}

function done(rect: Rect | null) {
  if (finished) return;
  finished = true;
  vcli.send("region:done", rect);
}

addEventListener("mousedown", (e) => { if (e.button !== 0) return; start = current = { x: e.clientX, y: e.clientY }; draw(); });
addEventListener("mousemove", (e) => { if (!start) return; current = { x: e.clientX, y: e.clientY }; draw(); });
addEventListener("mouseup", (e) => {
  if (!start) return;
  current = { x: e.clientX, y: e.clientY };
  const r = selection();
  done(r && r.width > 8 && r.height > 8 ? r : null);
});
addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
addEventListener("contextmenu", (e) => { e.preventDefault(); done(null); });
addEventListener("resize", draw);
// Main reuses the window: a new selection starts clean.
vcli.on("region:reset", () => { start = current = null; finished = false; draw(); });
draw();
