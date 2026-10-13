import type { HistoryEntry } from "../contracts";

// The words wrapped around a question (App+Questions.swift ask): what the assistant is told about the project and
// the screenshots, the short tag typed into a terminal CLI, and the context carried over when the lane changes.
// Pure, so they're tested as is.

export interface ShotInfo { label: string; width: number; height: number; pointer?: { x: number; y: number }; file?: string }

/** Bubble mode: the question plus "[Voice question. Project: … Image 1: … ]". */
export function voiceQuestion(question: string, project: string, shots: ShotInfo[], mouseOver: string | null): string {
  const context = [`Project: ${project}.`];
  shots.forEach((s, i) => {
    let line = `Image ${i + 1}: ${s.label}, ${Math.trunc(s.width)}x${Math.trunc(s.height)} px`;
    line += s.pointer ? `, mouse pointer at (${Math.trunc(s.pointer.x)}, ${Math.trunc(s.pointer.y)})` : ", pointer not over it";
    if (s.file) line += `, saved at ${s.file}`;
    context.push(line + ".");
  });
  if (!shots.length) {
    context.push("No screenshot attached (to save tokens it's only sent when asked for)" + (mouseOver ? `; the mouse is over ${mouseOver}` : "")
      + ". If answering needs the screen, call mcp__visioncli__look (or ui_elements / browser_read, cheaper as text).");
  }
  return `${question}\n\n[Voice question. ${context.join(" ")}]`;
}

export const BRIEF_INSTRUCTIONS = "Asked out loud: the reply is also shown in a bubble on screen and read aloud, so answer in plain text, under about 100 words; \"this\" means what's under the pointer; cite files as path:line; for flows or relationships you may add one small ```mermaid diagram; put any [[box/arrow/circle/step]] drawing markers on the last line.";

/** Terminal mode: the question with a short tag the user sees in their terminal ("[voice · screenshot /…/1.jpg …]"). */
export function terminalQuestion(question: string, o: {
  assistant: "claude" | "antigravity" | "gemini";
  shots: ShotInfo[];
  /** Paths the CLI can attach (Gemini: only those it accepts), in shot order. */
  paths: string[];
  /** The app under the mouse when there's no screenshot and it isn't the terminal itself. */
  mouseOver: string | null;
}): string {
  const gemini = o.assistant === "gemini";
  const parts: string[] = [];
  o.shots.forEach((s, i) => {
    let p = `screenshot ${i < o.paths.length ? (gemini ? `@${o.paths[i]} ` : o.paths[i]) : s.label}`;
    if (s.pointer) p += ` (mouse at ${Math.trunc(s.pointer.x)},${Math.trunc(s.pointer.y)})`;
    parts.push(p);
  });
  if (!o.shots.length && o.mouseOver) parts.push(`mouse over ${o.mouseOver}`);
  // No system prompt in gemini/agy interactive mode: the voice instructions ride along.
  if (o.assistant !== "claude") {
    parts.push(o.assistant === "antigravity" && o.shots.length ? "View the screenshot file(s) first. " : "");
    parts.push(BRIEF_INSTRUCTIONS);
  }
  return `${question} [voice${parts.length ? " · " : ""}${parts.join(" · ")}]`;
}

/** Switching lanes changes conversations: the last couple of exchanges in this project, oldest first. */
export function carryOver(entries: HistoryEntry[], project: string, text: string): string {
  const recent = entries.filter((e) => e.project === project).slice(0, 2).reverse();
  if (!recent.length) return text;
  return "Earlier in this conversation (for context):\n"
    + recent.map((e) => `User: ${[...e.question].slice(0, 300).join("")}\nAssistant: ${[...e.answer].slice(0, 500).join("")}`).join("\n")
    + "\n\n" + text;
}

/** visioncli://open?path=…&line=… → the file and line (1 when missing); null for any other link. */
export function parseOpenLink(url: string): { path: string; line: number } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "visioncli:") return null;
  const path = u.searchParams.get("path");
  if (!path) return null;
  const line = parseInt(u.searchParams.get("line") ?? "", 10);
  return { path, line: Number.isFinite(line) && line > 0 ? line : 1 };
}

/** The HUD title for a question (TaskHUD.reset): at most 40 characters. */
export const hudTitle = (q: string) => ([...q].length > 40 ? [...q].slice(0, 40).join("") + "…" : q);

/** How long an answer the user may still be reading stays: Swift's flash/scheduleHide seconds, unchanged. */
export const HIDE = { answer: 90, error: 15, quick: 4, command: 3, flash: 5 } as const;
