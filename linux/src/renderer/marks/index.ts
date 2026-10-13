// Full-screen, click-through drawings over the real screen, one window per display. `?mode=` picks the role:
//   marks     – HighlightOverlay (Overlays.swift): boxes, circles, arrows and numbered steps appearing one after
//               another (0.35 s apart, like someone explaining with a pen), pulsing; dashed for a selected area.
//   spotlight – Spotlight.swift: dims the display except the window that will be captured, with a cyan ring.
//   glow      – Badge.swift GlowEdges: the screen's edges glow while VisionCLI uses the computer.

import type { Point, Rect } from "../../main/contracts";
import type { DipMark } from "../../main/ui/overlay/geometry";
import { params, vcli } from "../shared/bridge";

const root = document.getElementById("root")!;
const mode = params.get("mode") ?? "marks";
document.body.dataset.mode = mode;
const NS = "http://www.w3.org/2000/svg";
let uid = 0;

// ── marks ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function norm(a: Point, b: Point, inset: number): Rect {
  return { x: Math.min(a.x, b.x) - inset, y: Math.min(a.y, b.y) - inset, width: Math.abs(b.x - a.x) + 2 * inset, height: Math.abs(b.y - a.y) + 2 * inset };
}

function gradient(svg: SVGSVGElement, colors: string[], from?: Point, to?: Point): string {
  const id = `g${++uid}`;
  const g = document.createElementNS(NS, "linearGradient");
  g.id = id;
  if (from && to) {
    g.setAttribute("gradientUnits", "userSpaceOnUse");
    g.setAttribute("x1", `${from.x}`); g.setAttribute("y1", `${from.y}`);
    g.setAttribute("x2", `${to.x}`); g.setAttribute("y2", `${to.y}`);
  } else { g.setAttribute("x1", "0"); g.setAttribute("y1", "0"); g.setAttribute("x2", "1"); g.setAttribute("y2", "1"); }
  colors.forEach((c, i) => {
    const s = document.createElementNS(NS, "stop");
    s.setAttribute("offset", `${i / (colors.length - 1)}`);
    s.setAttribute("stop-color", c);
    g.appendChild(s);
  });
  let defs = svg.querySelector("defs");
  if (!defs) { defs = document.createElementNS(NS, "defs"); svg.prepend(defs); }
  defs.appendChild(g);
  return `url(#${id})`;
}

function label(text: string, at: Point, delay: number) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "label";
  el.textContent = text;
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  el.style.animationDelay = `${delay}s`;
  root.appendChild(el);
}

function drawMarks(items: DipMark[], dashed: boolean) {
  root.innerHTML = "";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "canvas");
  root.appendChild(svg);
  const accent = ["#64d2ff", "#0a84ff", "#bf5af2", "#ff375f", "#64d2ff"];
  items.forEach((item, i) => {
    const delay = i * 0.35;
    const style = `animation-delay: ${delay}s, ${delay + 0.55}s`;
    if (item.kind === "box") {
      const r = norm(item.a, item.b, 4);
      if (dashed) {
        const rect = document.createElementNS(NS, "rect");
        Object.entries({ x: r.x, y: r.y, width: r.width, height: r.height, rx: 8 }).forEach(([k, v]) => rect.setAttribute(k, `${v}`));
        rect.setAttribute("stroke", gradient(svg, accent, { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height }));
        rect.setAttribute("class", "box-svg dashed");
        rect.setAttribute("style", style);
        svg.appendChild(rect);
      } else {
        // The angular gradient stroke: a conic-gradient plate masked down to its 3 px border.
        const el = document.createElement("div");
        el.className = "box";
        el.innerHTML = `<div class="plate"></div>`;
        Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
        el.setAttribute("style", el.getAttribute("style") + ";" + style);
        root.appendChild(el);
      }
      label(item.label, { x: r.x, y: Math.max(0, r.y - 28) }, delay);
    } else if (item.kind === "circle") {
      const r = norm(item.a, item.b, 0);
      const e = document.createElementNS(NS, "ellipse");
      const rr = { x: r.x - 12, y: r.y - 10, width: r.width + 24, height: r.height + 20 };
      e.setAttribute("cx", `${rr.x + rr.width / 2}`); e.setAttribute("cy", `${rr.y + rr.height / 2}`);
      e.setAttribute("rx", `${rr.width / 2}`); e.setAttribute("ry", `${rr.height / 2}`);
      e.setAttribute("pathLength", "1");
      e.setAttribute("stroke", gradient(svg, accent, { x: rr.x, y: rr.y }, { x: rr.x + rr.width, y: rr.y + rr.height }));
      e.setAttribute("class", "trim circle");
      e.setAttribute("style", style);
      svg.appendChild(e);
      label(item.label, { x: rr.x, y: Math.max(0, rr.y - 28) }, delay);
    } else if (item.kind === "arrow") {
      const { a, b } = item;
      const angle = Math.atan2(b.y - a.y, b.x - a.x), head = 16, spread = Math.PI / 7;
      const p = (t: number) => `${b.x - head * Math.cos(angle + t)},${b.y - head * Math.sin(angle + t)}`;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", `M${a.x},${a.y} L${b.x},${b.y} M${b.x},${b.y} L${p(-spread)} M${b.x},${b.y} L${p(spread)}`);
      path.setAttribute("pathLength", "1");
      path.setAttribute("stroke", gradient(svg, ["#64d2ff", "#bf5af2", "#ff375f"], a, b.x === a.x && b.y === a.y ? { x: a.x + 1, y: a.y } : b));
      path.setAttribute("class", "trim arrow");
      path.setAttribute("style", style);
      svg.appendChild(path);
      // Label beside the middle of the arrow (its start often has a step badge).
      label(item.label, { x: (a.x + b.x) / 2 + 12, y: Math.max(0, (a.y + b.y) / 2 - 12) }, delay);
    } else {
      const el = document.createElement("div");
      el.className = "step";
      el.textContent = String(item.n ?? i + 1);
      el.style.left = `${item.a.x - 15}px`;
      el.style.top = `${item.a.y - 15}px`;
      el.setAttribute("style", el.getAttribute("style") + ";" + style);
      root.appendChild(el);
      label(item.label, { x: item.a.x + 20, y: item.a.y - 12 }, delay);
    }
  });
}

// ── spotlight ──────────────────────────────────────────────────────────────────────────────────────────────────────

function drawSpotlight(hole: Rect | null) {
  const w = innerWidth, h = innerHeight;
  const rr = (r: Rect, rad: number) =>
    `M${r.x + rad},${r.y} h${r.width - 2 * rad} a${rad},${rad} 0 0 1 ${rad},${rad} v${r.height - 2 * rad} a${rad},${rad} 0 0 1 -${rad},${rad} ` +
    `h-${r.width - 2 * rad} a${rad},${rad} 0 0 1 -${rad},-${rad} v-${r.height - 2 * rad} a${rad},${rad} 0 0 1 ${rad},-${rad} Z`;
  const visible = hole && hole.x < w && hole.y < h && hole.x + hole.width > 0 && hole.y + hole.height > 0;
  const ring = visible ? { x: hole.x - 1.5, y: hole.y - 1.5, width: hole.width + 3, height: hole.height + 3 } : null;
  root.innerHTML = `<svg class="canvas" width="${w}" height="${h}">
    <path fill="rgba(0,0,0,0.35)" fill-rule="evenodd" d="M0,0 H${w} V${h} H0 Z ${visible ? rr(hole!, 10) : ""}"/>
    ${ring ? `<path fill="none" stroke="rgba(100,210,255,0.8)" stroke-width="2" d="${rr(ring, 11)}"/>` : ""}</svg>`;
}

// ── glow ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function glow(on: boolean) {
  if (!root.firstElementChild) root.innerHTML = `<div class="edges"><div class="ring"></div></div>`;
  document.body.classList.toggle("on", on);
}

if (mode === "marks") vcli.on("marks:draw", (d: { items: DipMark[]; dashed: boolean }) => drawMarks(d.items, d.dashed));
let lastHole: Rect | null = null;
if (mode === "spotlight") {
  // null = hidden (main hides the window too); the next hole fades in again.
  vcli.on("spotlight:hole", (hole: Rect | null) => {
    lastHole = hole;
    if (!hole) { document.body.classList.remove("on"); return; }
    drawSpotlight(hole);
    requestAnimationFrame(() => document.body.classList.add("on"));
  });
  addEventListener("resize", () => drawSpotlight(lastHole));
}
if (mode === "glow") vcli.on("glow:set", (on: boolean) => glow(on));
