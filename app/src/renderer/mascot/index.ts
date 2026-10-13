// Visi, the mascot (Mascot.swift): leans in from the right edge of the pointer's screen while you talk and while the
// answer is on its way. Blinks, flaps its mouth with the mic level, pulls a face now and then, glows its antenna, and
// waves bye before snapping back behind the edge. Main sends "mascot:show" {mood}, "mascot:level", "mascot:hide";
// once it's out of sight this page sends "mascot:gone" so main can hide the window.

import { vcli } from "../shared/bridge";

type Mood = "listening" | "thinking";
const NAMES = ["peek", "blink", "talk", "think", "wink", "surprised", "laugh", "wave"];
const MOMENTS: [string, number][] = [["wink", 0.7], ["surprised", 0.8], ["laugh", 1.0], ["wave", 1.4]];
const H = 130, W = H * 285 / 360, SIDEROOM = 28, HEADROOM = 32;

const root = document.getElementById("root")!;
root.innerHTML = `<div class="figure"><img class="frame" alt=""><div class="glow"><i class="halo"></i><i class="dot"></i></div></div>`;
const figure = root.querySelector<HTMLElement>(".figure")!;
const img = root.querySelector<HTMLImageElement>(".frame")!;
const halo = root.querySelector<HTMLElement>(".halo")!;
const dot = root.querySelector<HTMLElement>(".dot")!;
figure.style.width = `${W}px`;
figure.style.top = `${HEADROOM}px`;
const glow = root.querySelector<HTMLElement>(".glow")!;
glow.style.left = `${W * 85 / 285 - 30}px`;
glow.style.top = `${H * 17 / 360 - 30}px`;

// Only frames that actually load are used (like `model.frames[...] != nil`).
const frames = new Set<string>();
for (const n of NAMES) {
  const pre = new Image();
  pre.onload = () => frames.add(n);
  pre.src = `../../assets/mascot/${n}.png`;
}

let mood: Mood = "listening";
let level = 0;
let visible = false;
let leaving: number | null = null;
let frame = "";
let talkFlip = 0;
let nextBlink = Date.now() + 2000, blinkUntil = 0;
let moment: { frame: string; until: number } | null = null;
let nextMoment = 0, lastMoment = "";
let tickTimer: number | null = null;
let hideTimers: number[] = [];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function setPeek(peek: boolean, easing: string, seconds: number) {
  figure.style.transition = `left ${seconds}s ${easing}, transform ${seconds}s ${easing}`;
  figure.style.left = `${SIDEROOM + (peek ? 0 : W)}px`;
  figure.style.transform = `rotate(${peek ? -3 : 14}deg)`;
}

function setFrame(f: string) {
  if (f === frame) return;
  frame = f;
  img.src = `../../assets/mascot/${frames.has(f) ? f : "peek"}.png`;
}

function show(m: Mood) {
  hideTimers.forEach(clearTimeout);
  hideTimers = [];
  leaving = null;
  mood = m;
  if (!visible) {
    visible = true;
    setPeek(false, "linear", 0);
    // Sometimes it waves hello as it peeks in; the first random face comes a few seconds later.
    const now = Date.now();
    moment = Math.random() < 0.35 && frames.has("wave") ? { frame: "wave", until: now + 1300 } : null;
    nextMoment = now + rand(3000, 6000);
    tick();
    // Snappy peek: pops out from behind the edge with a tilt, overshoots a touch and settles (spring 0.24 / 0.58).
    requestAnimationFrame(() => requestAnimationFrame(() => setPeek(true, "cubic-bezier(0.3, 1.55, 0.55, 1)", 0.42)));
    requestAnimationFrame(animateGlow);
  }
  tickTimer ??= window.setInterval(tick, 50);
}

/** A quick wave, then it snaps back behind the screen edge. */
function hide() {
  if (!visible || leaving !== null) return;
  leaving = Date.now();
  tick();
  hideTimers.push(window.setTimeout(() => {
    setPeek(false, "ease-in", 0.14);
    hideTimers.push(window.setTimeout(() => {
      visible = false;
      leaving = null;
      if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
      vcli.send("mascot:gone");
    }, 160));
  }, 250));
}

function tick() {
  const now = Date.now();
  if (now >= nextBlink) { blinkUntil = now + 140; nextBlink = now + rand(2500, 5000); }
  if (moment && now >= moment.until) moment = null;
  if (!moment && leaving === null && now >= nextMoment && level < 0.1) {
    const choices = MOMENTS.filter(([f]) => f !== lastMoment && frames.has(f));
    if (choices.length) {
      const [f, s] = choices[Math.floor(Math.random() * choices.length)];
      moment = { frame: f, until: now + s * 1000 };
      lastMoment = f;
    }
    nextMoment = now + rand(4000, 8000);
  }
  let f: string;
  if (leaving !== null) f = frames.has("wave") ? "wave" : "talk"; // bye!
  else if (moment && level < 0.1) f = moment.frame;
  else if (now < blinkUntil) f = "blink";
  else if (level > 0.1) {
    // Mouth flaps while you speak, faster when louder.
    talkFlip += 1;
    f = Math.floor(talkFlip / Math.max(1, Math.trunc(4 - level * 3))) % 2 === 0 ? "talk" : "peek";
  } else f = mood === "thinking" && frames.has("think") ? "think" : "peek";
  setFrame(f);
}

/** The antenna: cyan, breathing with your voice while listening; a faster yellow pulse while thinking. */
function animateGlow(ts: number) {
  if (!visible) return;
  const t = ts / 1000;
  const thinking = mood === "thinking" && leaving === null;
  const pulse = thinking ? (Math.sin(t * 5) + 1) / 2 : Math.max(level * 1.5, (Math.sin(t * 2.4) + 1) / 4);
  const size = 14 + pulse * (thinking ? 16 : 8);
  halo.style.width = halo.style.height = `${size}px`;
  halo.style.filter = `blur(${5 + pulse * 4}px)`;
  halo.style.background = thinking ? `rgba(255, 217, 51, ${0.25 + pulse * 0.5})` : `rgba(100, 210, 255, ${0.2 + pulse * 0.3})`;
  dot.style.background = `rgba(255, 255, 255, ${thinking ? 0.55 + pulse * 0.45 : 0.25 + pulse * 0.3})`;
  requestAnimationFrame(animateGlow);
}

vcli.on("mascot:show", (d: { mood: Mood }) => show(d.mood));
vcli.on("mascot:level", (l: number) => { level = l; });
vcli.on("mascot:hide", () => hide());
