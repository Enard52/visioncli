// Answer text → HTML for the bubble (OverlayState.rendered in Views.swift): markers stripped (Markup.display),
// file:line references turned into visioncli://open links (Markup.linked), ```mermaid blocks split out
// (DiagramText.segments). Raw HTML in the answer is shown as text, never interpreted; only safe link schemes survive.
// Block markdown (lists, headings, code blocks) is rendered too, styled to sit close to the macOS bubble's look.

import { Marked, type Tokens } from "marked";
import { DiagramText, Markup, type AnswerSegment } from "../../main/core/markup";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const SAFE_LINK = /^(https?:|mailto:|visioncli:)/i;

const marked = new Marked({
  gfm: true,
  breaks: true, // the macOS bubble preserves the answer's line breaks
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) { return esc(text); },
    link(this: any, { href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_LINK.test(href)) return inner;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>`;
    },
    // No remote loads from an answer: an image becomes its alt text (a link when it's an http(s) URL).
    image({ href, text }: Tokens.Image) {
      return /^https?:/i.test(href) ? `<a href="${esc(href)}">${esc(text || href)}</a>` : esc(text);
    },
  },
});

/** Markup.linked outside fenced code blocks (a path:line inside a code block stays plain code). */
export function linkOutsideCode(text: string): string {
  return text.split(/(```[\s\S]*?(?:```|$))/).map((part, i) => i % 2 ? part : Markup.linked(part)).join("");
}

const cache = new Map<string, string>();

/** One text segment as HTML; cached per text since only the last segment changes while an answer streams. */
export function renderText(text: string): string {
  let html = cache.get(text);
  if (html === undefined) {
    html = marked.parse(linkOutsideCode(text), { async: false }) as string;
    cache.set(text, html);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return html;
}

/** The answer to show, split into segments (what AnswerBubble iterates over). */
export function answerSegments(raw: string): { answer: string; segments: AnswerSegment[] } {
  const answer = Markup.display(raw);
  return { answer, segments: DiagramText.segments(answer) };
}

/** Whether the toolbar shows "Open file". */
export const hasFileRef = (answer: string) => Markup.firstFileRef(answer) !== null;

export type DiffKind = "added" | "removed" | "context";

/**
 * The approval card's preview as diff lines (PermissionRequest.detail): "+"/"-" prefixed lines are added/removed,
 * everything else context; at most `max` lines, each cut at 110 characters, then "… N more lines".
 */
export function diffLines(preview: string | undefined, max = 14): { text: string; kind: DiffKind }[] {
  if (!preview) return [];
  const all = preview.replace(/\n+$/, "").split("\n");
  const out = all.slice(0, max).map((line) => {
    const kind: DiffKind = /^\+(?!\+\+ )/.test(line) ? "added" : /^-(?!-- )/.test(line) ? "removed" : "context";
    let text = kind === "context" ? line.replace(/^ {2}/, "") : line.slice(1).replace(/^ /, "");
    if ([...text].length > 110) text = [...text].slice(0, 110).join("") + "…";
    return { text, kind };
  });
  if (all.length > max) out.push({ text: `… ${all.length - max} more lines`, kind: "context" });
  return out;
}
