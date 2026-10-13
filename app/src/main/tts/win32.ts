import type { WinHelper } from "../desktop/windows/win32";
import { log } from "../log";

// The Windows system voice: SAPI 5 (System.Speech in the helper) renders a WAV, which is played on the chosen speaker
// like the Linux espeak-ng path (Speaker.renderSystem on macOS).

/** Settings.speechSpeed (1 = normal) → SAPI's rate (−10…10, where ±10 is about 3× faster/slower). Same speed factor
 *  as the Linux tools: 1 + (speed − 1) × 0.4. */
export function sapiRate(speed: number): number {
  const factor = Math.max(0.5, 1 + (speed - 1) * 0.4);
  return Math.max(-10, Math.min(10, Math.round((10 * Math.log(factor)) / Math.log(3))));
}

/** Installed voice names, English ones first (they come as "Microsoft Zira Desktop - English (United States)"). */
export function englishFirst(voices: string[]): string[] {
  const en = voices.filter((v) => /english/i.test(v));
  return [...new Set([...en, ...voices.filter((v) => !/english/i.test(v))])];
}

export class WinVoice {
  cached: string[] = [];          // the last list, for synchronous callers
  constructor(private helper: WinHelper) {}

  async voices(): Promise<string[]> {
    try { this.cached = englishFirst(await this.helper.call("voices", {})); } catch (e) { log(`tts: SAPI voices: ${(e as Error).message}`); }
    return this.cached;
  }

  /** Renders `text` to `out` (WAV); null when SAPI couldn't. A voice SAPI doesn't know falls back to its default. */
  async render(text: string, out: string, speed: number, voice: string | null): Promise<string | null> {
    const rate = sapiRate(speed);
    try {
      await this.helper.call("speak", { text, voice, rate, file: out });
      return out;
    } catch (e) {
      if (!voice) { log(`tts: SAPI: ${(e as Error).message}`); return null; }
      try { await this.helper.call("speak", { text, voice: null, rate, file: out }); return out; } catch { return null; }
    }
  }
}
