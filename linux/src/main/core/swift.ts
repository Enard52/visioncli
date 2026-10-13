// Foundation/ICU semantics the Core ports rely on, so they behave exactly like the Swift originals.

/** NSRegularExpression (ICU) classes. JS `\w`, `\d`, `\s` are ASCII or differ slightly; ICU's are Unicode. */
export const RE_W = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍`; // ICU \w (inside [...])
export const RE_D = String.raw`\p{Nd}`; // ICU \d
export const RE_S = String.raw`\t\n\f\r\p{Z}`; // ICU \s (inside [...])
/** ICU `$` without multiline: end of input, or before a line terminator that ends the input. */
export const RE_END = String.raw`(?=(?:\r\n|[\n\v\f\r\u0085  ])?$)`;

/** CharacterSet.whitespaces: Zs and tab. */
const WS = String.raw`\p{Zs}\t`;
/** CharacterSet.whitespacesAndNewlines: Z*, U+000A–U+000D, U+0085. */
const WSNL = String.raw`\p{Z}\t\n\v\f\r\u0085`;
/** CharacterSet.punctuationCharacters: P*. */
const PUNCT = String.raw`\p{P}`;

const trimmer = (set: string) => {
  const re = new RegExp(`^[${set}]+|[${set}]+$`, "gu");
  return (s: string) => s.replace(re, "");
};
/** trimmingCharacters(in: .whitespaces) */
export const trimWS = trimmer(WS);
/** trimmingCharacters(in: .whitespacesAndNewlines) */
export const trimWSNL = trimmer(WSNL);
/** trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters)) */
export const trimWSNLPunct = trimmer(WSNL + PUNCT);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** A Swift String as its Characters (extended grapheme clusters). */
export function characters(s: string): string[] {
  return Array.from(graphemeSegmenter.segment(s), (x) => x.segment);
}

/** Character.isUppercase */
export function isUppercase(c: string): boolean {
  if ([...c].length === 1) return /\p{Uppercase}/u.test(c);
  return c.toUpperCase() === c && c.toLowerCase() !== c;
}

/** Int(String): ASCII digits with an optional sign, within Int64; else null. */
export function parseInt64(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = BigInt(s);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return null;
  return Number(n);
}
