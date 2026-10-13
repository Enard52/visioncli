// Mermaid diagrams in the bubble (Diagram.swift): the bundled mermaid.min.js (build/assets, offline) is loaded once,
// on the first diagram, and each ```mermaid block renders to an inline SVG on a transparent background.

let loading: Promise<any> | null = null;
let seq = 0;

function load(): Promise<any> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "../../assets/mermaid.min.js";
    s.onload = () => {
      const m = (window as any).mermaid;
      m.initialize({
        startOnLoad: false, theme: "dark", securityLevel: "strict",
        themeVariables: {
          background: "transparent", fontFamily: "Inter, Cantarell, Ubuntu, system-ui, sans-serif", primaryColor: "#1f2937",
          primaryBorderColor: "#22d3ee", lineColor: "#a855f7", primaryTextColor: "#e6e6ea",
        },
      });
      resolve(m);
    };
    s.onerror = () => reject(new Error("mermaid.js is missing"));
    document.head.appendChild(s);
  });
  return loading;
}

/** A DiagramBlock element for `code`: 420 wide, its height following the drawing (max 520, like the macOS view). */
export function diagramBlock(code: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "diagram";
  el.dataset.key = "m:" + code;
  el.style.minHeight = "140px";
  load()
    .then(async (m) => {
      const { svg } = await m.render(`vcli-mmd-${++seq}`, code);
      el.innerHTML = svg;
    })
    .catch((e) => {
      el.innerHTML = "";
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = "Diagram couldn't be drawn: " + String(e?.message ?? e).slice(0, 160);
      el.appendChild(err);
    })
    .finally(() => { el.style.minHeight = ""; });
  return el;
}
