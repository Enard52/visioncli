// Answer markup: drawing markers, file references and diagram blocks. Port of overlay/Sources/CoreMarkup.swift.
import { RE_D, RE_W, parseInt64, trimWS, trimWSNL } from "./swift";

export interface Point { x: number; y: number }

/** Mark.Kind: box, circle, arrow, or step(n). */
export type MarkKind = { type: "box" } | { type: "circle" } | { type: "arrow" } | { type: "step"; n: number };

/** Something Claude draws on the screen to explain: [[box|circle|arrow:IMAGE:x1,y1,x2,y2:label]], [[step:IMAGE:x,y:N:label]]. */
export interface Mark {
  kind: MarkKind;
  image: number;
  a: Point; // image pixels: box/circle corner, arrow start, step position
  b: Point; // box/circle opposite corner, arrow end (== a for steps)
  label: string;
}

const D = `[${RE_D}]`; // ICU \d is any Unicode decimal digit (Double()/Int() then reject non-ASCII ones)
const S = `[\\t\\n\\f\\r\\p{Z}]`; // ICU \s
const SHAPE = new RegExp(String.raw`\[\[(box|circle|arrow):(${D}+):${S}*(${D}+)${S}*,${S}*(${D}+)${S}*[,:]${S}*(${D}+)${S}*,${S}*(${D}+)${S}*(?::([^\]]*))?\]\]`, "gu");
const STEP = new RegExp(String.raw`\[\[step:(${D}+):${S}*(${D}+)${S}*,${S}*(${D}+)${S}*:${S}*(${D}+)${S}*(?::([^\]]*))?\]\]`, "gu");
const ANY_MARKER = /\[\[(?:box|circle|arrow|step):[^\]]*\]\]/gu;
const FILE_REF = new RegExp("`?" + String.raw`((?:[${RE_W}.@-]+/)*[${RE_W}.@-]+\.[A-Za-z0-9]{1,8}):(${D}+)(?:-${D}+)?` + "`?", "gu");

/** Double(String) for a run of digits: only ASCII digits parse. */
function num(s: string | undefined): number | null {
  return s !== undefined && /^[0-9]+$/.test(s) ? Number(s) : null;
}

/** Swift `Int(CGFloat)`. */
const int = Math.trunc;

/** URLComponents query value: urlQueryAllowed keeps / and @; everything else non-unreserved is percent-encoded. */
function queryValue(v: string): string {
  return encodeURIComponent(v).replace(/%2F/g, "/").replace(/%40/g, "@");
}

export const Markup = {
  boxPattern: String.raw`\[\[box:(\d+):\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*))?\]\]`, // ICU syntax, as in Swift
  anyMarker: String.raw`\[\[(?:box|circle|arrow|step):[^\]]*\]\]`,
  fileRefPattern: "`?" + String.raw`((?:[\w.@-]+/)*[\w.@-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-\d+)?` + "`?", // ICU syntax, as in Swift

  /** All drawing markers in the answer, in the order they appear (so walkthroughs animate in sequence). */
  marks(text: string): Mark[] {
    const found: [number, Mark][] = [];
    for (const m of text.matchAll(SHAPE)) {
      const img = num(m[2]), x1 = num(m[3]), y1 = num(m[4]), x2 = num(m[5]), y2 = num(m[6]);
      if (img === null || x1 === null || y1 === null || x2 === null || y2 === null) continue;
      const kind: MarkKind = m[1] === "arrow" ? { type: "arrow" } : m[1] === "circle" ? { type: "circle" } : { type: "box" };
      found.push([m.index!, { kind, image: int(img), a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, label: trimWS(m[7] ?? "") }]);
    }
    for (const m of text.matchAll(STEP)) {
      const img = num(m[1]), x = num(m[2]), y = num(m[3]), n = num(m[4]);
      if (img === null || x === null || y === null || n === null) continue;
      found.push([m.index!, { kind: { type: "step", n: int(n) }, image: int(img), a: { x, y }, b: { x, y }, label: trimWS(m[5] ?? "") }]);
    }
    return found.sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  },

  /** Text to show: markers removed (including a half-streamed one at the end). */
  display(text: string): string {
    let t = text.replace(ANY_MARKER, "");
    const open = t.lastIndexOf("[[");
    if (open >= 0 && !t.slice(open).includes("]]")) t = t.slice(0, open);
    return trimWSNL(t.replace(/[ \t]+\n/gu, "\n")
      .replace(/[ \t]+([,.;:!?])/gu, "$1") // gap left by a removed marker
      .replace(/  +/gu, " "));
  },

  /** Markdown with file:line references turned into visioncli://open links. */
  linked(text: string): string {
    let out = text;
    for (const m of [...text.matchAll(FILE_REF)].reverse()) {
      const shown = m[0].replace(/^`+|`+$/g, "");
      const url = `visioncli://open?path=${queryValue(m[1])}&line=${queryValue(m[2])}`;
      out = out.slice(0, m.index!) + `[${shown}](${url})` + out.slice(m.index! + m[0].length);
    }
    return out;
  },

  /** The first file:line reference in an answer: [path, line]. */
  firstFileRef(text: string): [string, number] | null {
    FILE_REF.lastIndex = 0;
    const m = FILE_REF.exec(text);
    FILE_REF.lastIndex = 0;
    if (!m) return null;
    return [m[1], parseInt64(m[2]) ?? 1];
  },
};

// MARK: - Diagram blocks

export type AnswerSegment = { type: "text"; text: string } | { type: "mermaid"; code: string } | { type: "pendingDiagram" }; // pendingDiagram: a ```mermaid block that is still streaming in

let lastSplit: { answer: string; segments: AnswerSegment[] } | null = null;

function split(answer: string): AnswerSegment[] {
  const out: AnswerSegment[] = [];
  let rest = answer;
  let open: number;
  while ((open = rest.indexOf("```mermaid")) >= 0) {
    const before = trimWSNL(rest.slice(0, open));
    if (before) out.push({ type: "text", text: before });
    const afterOpen = rest.slice(open + "```mermaid".length);
    const close = afterOpen.indexOf("```");
    if (close < 0) { out.push({ type: "pendingDiagram" }); return out; }
    const code = trimWSNL(afterOpen.slice(0, close));
    if (code) out.push({ type: "mermaid", code });
    rest = afterOpen.slice(close + 3);
  }
  const tail = trimWSNL(rest);
  if (tail) out.push({ type: "text", text: tail });
  return out;
}

/** Answer text with ```mermaid blocks split out; the views render them, the speaker skips them. */
export const DiagramText = {
  /** Split an answer into text and mermaid blocks. Remembers the last answer: while streaming, the bubble and the
   *  speaker both ask for the same text. Treat the result as read-only (it is shared with the cache). */
  segments(answer: string): AnswerSegment[] {
    if (lastSplit && lastSplit.answer === answer) return lastSplit.segments;
    const segments = split(answer);
    lastSplit = { answer, segments };
    return segments;
  },

  /** Text to read aloud: diagrams become a short mention; an unfinished one cuts the text off (so the spoken
   *  prefix only ever grows while streaming). */
  speakable(answer: string): string {
    return DiagramText.segments(answer).map((s) => {
      switch (s.type) {
        case "text": return s.text;
        case "mermaid": return "(See the diagram.)";
        case "pendingDiagram": return "";
      }
    }).join("\n");
  },
};
