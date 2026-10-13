// Pure text helpers. Port of overlay/Sources/CoreText.swift.
import { RE_D, RE_END, RE_S, RE_W, characters, isUppercase, trimWS, trimWSNL } from "./swift";

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const ALNUM = /[\p{L}\p{M}\p{N}]/u; // CharacterSet.alphanumerics

// The Swift regexes, with ICU \w, \d, \s and $ spelled out (see swift.ts).
const CODE_BLOCK = new RegExp("```[\\s\\S]*?(```|" + RE_END + ")", "gu");
const BULLET = new RegExp(`^[${RE_S}]*([-*•]|[${RE_D}]+\\.)[${RE_S}]+`, "u");
const FILE_LINE = new RegExp(`(?:[${RE_W}.@-]+/)*([${RE_W}.@-]+\\.[${RE_W}]+):([${RE_D}]+)(?:-[${RE_D}]+)?`, "gu");
const MD_LINK = /\[([^\]]+)\]\([^)]+\)/gu;
const URL = new RegExp(`https?://[^${RE_S}]+`, "gu");

/** Turns answer text into something pleasant to hear. Used by the speaker before every sentence it says. */
export const SpokenText = {
  /** Splits text into speakable sentences (one TTS request each, so the first starts playing quickly). */
  sentences(text: string): string[] {
    const out: string[] = [];
    for (const { segment } of sentenceSegmenter.segment(text)) {
      const s = trimWSNL(segment);
      if (SpokenText.speakable(s)) out.push(s);
    }
    return out.length === 0 && SpokenText.speakable(text) ? [text] : out;
  },

  /** Worth saying out loud: has words, not just punctuation or table borders ("|---|", "|"). */
  speakable(s: string): boolean {
    return ALNUM.test(s);
  },

  /** Make text pleasant to hear: "app/Models/Payment.php:42" → "Payment.php, line 42"; drop markdown. */
  clean(s: string): string {
    // Code blocks and table rows don't read well aloud (and made the voice say "dot", "bar"…): skip them.
    let t = s.replace(CODE_BLOCK, "");
    // Swift splits on the Character "\n", which a CRLF pair is not.
    t = t.split(/(?<!\r)\n/)
      .filter((l) => !trimWS(l).startsWith("|"))
      .map((l) => l.replace(BULLET, ""))
      .join("\n");
    t = t.replace(FILE_LINE, "$1, line $2");
    t = t.replace(MD_LINK, "$1");
    t = t.replace(URL, "a link");
    t = t.split("→").join(" to ").split("≈").join("about ");
    for (const mark of ["**", "__", "`", "#"]) t = t.split(mark).join("");
    return t;
  },
};

/** Words the local speech engines should spell right. The window title and the user's vocabulary file are passed in,
 *  so the choice itself stays testable. */
export const Vocabulary = {
  /** Parakeet's word list: the project, code-like words in the window title (PaymentController.php →
   *  PaymentController), the user's vocabulary file and common developer names. Deduplicated, at most 80. */
  words(project: string, windowTitle: string | null | undefined, custom: string | null | undefined): string[] {
    const words = [project];
    if (windowTitle != null) {
      for (const token of windowTitle.split(/[^\p{L}\p{M}\p{N}]/u)) {
        const chars = characters(token);
        if (chars.length < 4) continue;
        // CamelCase / snake-ish identifiers only; plain words don't need help.
        if (chars.slice(1).some(isUppercase)) words.push(token);
      }
    }
    words.push(...Vocabulary.customWords(custom));
    words.push("VisionCLI", "Laravel", "SwiftUI", "Xcode", "TypeScript", "JavaScript", "GitHub", "kubectl", "Postgres", "MySQL",
               "Redis", "Docker", "Kubernetes", "Next.js", "Node.js", "npm", "PhpStorm", "Tailwind", "GraphQL", "Webpack", "Vite");
    const seen = new Set<string>();
    return words.filter((w) => {
      const k = w.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 80);
  },

  /** Whisper's prompt: the project, the whole window title, the vocabulary file and common dev terms. */
  prompt(project: string, windowTitle: string | null | undefined, custom: string | null | undefined): string {
    const words = [project];
    if (windowTitle) words.push(windowTitle);
    words.push(...Vocabulary.customWords(custom));
    words.push("Claude", "Laravel", "PHP", "Swift", "SwiftUI", "Xcode", "TypeScript", "React", "SQL", "API", "JSON", "migration", "controller");
    return "Vocabulary: " + words.join(", ") + ".";
  },

  /** The vocabulary file's entries: comma- or newline-separated, blanks dropped. */
  customWords(custom: string | null | undefined): string[] {
    if (custom == null) return [];
    return custom.split(/[,\n]/).map(trimWS).filter((w) => w !== "");
  },
};

/** `String(format: "%.1f", x)`: like toFixed(1), but an exact tie rounds to even as printf does. */
function oneDecimal(x: number): string {
  const q = x * 4; // exact: a tie at the second decimal is only possible for odd multiples of 0.25
  if (Number.isInteger(q) && q % 2 !== 0) {
    const tenths = x * 10; // k + 0.5 exactly
    const lo = Math.floor(tenths);
    return ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1);
  }
  return x.toFixed(1);
}

/** One line per executed step of a browser task, for the bubble. */
export const BrowserTaskText = {
  line(step: Record<string, unknown>): string | null {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const label = str(step.label) ?? "";
    switch (str(step.kind)) {
      case "fill": return `Typed “${str(step.text) ?? ""}” into ${label}`;
      case "click": return `Clicked ${label}`;
      case "select": {
        const parts = label.split(" → ");
        return parts.length > 1 ? `Chose ${parts.slice(1).join(" → ")} in ${parts[0]}` : `Chose ${label}`;
      }
      case "scroll": return label;
      case "wait": return "Waited for the page";
      default: return null; // done / blocked: the summary says it
    }
  },

  summary(status: string, message: string, steps: number, ms: number): string {
    const secs = oneDecimal(ms / 1000);
    switch (status) {
      case "done": return `Done in ${secs} s (${steps} step${steps === 1 ? "" : "s"}).`;
      case "stopped": return "Stopped.";
      default: return message === "" ? "I couldn't finish that." : message;
    }
  },

  body(header: string, lines: string[]): string {
    return [header, ...(lines.length === 0 ? [] : ["", ...lines.map((l, i) => `${i + 1}. ${l}`)])].join("\n");
  },
};
