// Spelling the vocabulary as given (what Parakeet's word boosting does on macOS). sherpa-onnx only takes hotwords
// for its whole server at startup, and not for NeMo TDT models with greedy search, so the words are applied to the
// transcript instead: "type script", "typescript" → "TypeScript"; "vision cli" → "VisionCLI"; "next js" → "Next.js".

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "TypeScript" → ["Type", "Script"], "Next.js" → ["Next", "js"], "VisionCLI" → ["Vision", "CLI"]. */
export function termParts(term: string): string[] {
  return term.split(/[^A-Za-z0-9]+/).flatMap((w) => w.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).filter(Boolean);
}

export function applyVocabulary(text: string, vocabulary: string[]): string {
  let out = text;
  // Longer terms first, so "Next.js" wins over a shorter "Next".
  for (const term of [...new Set(vocabulary)].sort((a, b) => b.length - a.length)) {
    const parts = termParts(term);
    if (parts.join("").length < 3 || term.length > 40) continue;
    const re = new RegExp(`(?<![\\w.])${parts.map(escape).join("[\\s.\\-]?")}(?![\\w])`, "gi");
    out = out.replace(re, term);
  }
  return out;
}
