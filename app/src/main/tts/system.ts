import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { VoiceModels } from "../stt/models";
import { winHelper } from "../desktop/windows/win32";
import { WinVoice } from "./win32";

// The system voice (AVSpeechSynthesizer on macOS): speech-dispatcher's `spd-say` (the desktop's configured voice),
// else `espeak-ng`, else `piper` with an installed voice model. spd-say can't render to a file, so when the user picked
// a speaker for VisionCLI, espeak-ng / piper render a WAV that is played on it (like Speaker.renderSystem).
// Windows: SAPI through the helper renders a WAV (tts/win32.ts).

/** The speech rate for each tool from Settings.speechSpeed (1 = normal; macOS: 0.52 + (x − 1) × 0.2 of AVSpeech's 0…1). */
export function rates(speed: number) {
  const factor = Math.max(0.5, 1 + (speed - 1) * 0.4);
  return {
    spd: Math.max(-100, Math.min(100, Math.round((speed - 1) * 40))),
    espeakWpm: Math.round(175 * factor),
    piperLengthScale: +(1 / factor).toFixed(2),
  };
}

const has = (bin: string) => !!VoiceModels.binary(bin);

/** An installed piper voice (.onnx with its .onnx.json); `voice` may name one or be a path. */
export function piperModel(voice: string | null): string | null {
  if (voice?.endsWith(".onnx") && existsSync(voice)) return voice;
  const dirs = [join(homedir(), ".local/share/piper"), join(homedir(), ".local/share/piper-voices"), "/usr/share/piper-voices", "/usr/share/piper", "/usr/local/share/piper"];
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.name.endsWith(".onnx") && existsSync(p + ".json")) found.push(p);
    }
  };
  dirs.forEach((d) => walk(d, 0));
  return found.find((p) => voice && p.includes(voice)) ?? found.find((p) => /\/en_/.test(p)) ?? found[0] ?? null;
}

let win: WinVoice | null = null;
const winVoice = () => (win ??= new WinVoice(winHelper()));

export const SystemVoice = {
  /** Which tool speaks: spd-say speaks directly; the others render WAVs. */
  backend(): "spd-say" | "espeak-ng" | "piper" | "sapi" | null {
    if (process.platform === "win32") return "sapi";
    if (has("spd-say")) return "spd-say";
    if (has("espeak-ng")) return "espeak-ng";
    if (has("piper") && piperModel(null)) return "piper";
    return null;
  },

  /** Renders `text` to a WAV (espeak-ng, else piper); null when neither can. */
  render(text: string, out: string, speed: number, voice: string | null): Promise<string | null> {
    if (process.platform === "win32") return winVoice().render(text, out, speed, voice);
    const r = rates(speed);
    return new Promise((resolve) => {
      const done = (ok: boolean) => resolve(ok && existsSync(out) ? out : null);
      if (has("espeak-ng")) {
        const args = (v: string | null) => ["-s", String(r.espeakWpm), "-w", out, ...(v ? ["-v", v] : []), "--", text];
        const v = voice && !voice.endsWith(".onnx") ? voice : null;
        // A voice name espeak-ng doesn't know (e.g. one from another synthesizer): its default voice beats silence.
        execFile("espeak-ng", args(v), (e) => (e && v ? execFile("espeak-ng", args(null), (e2) => done(!e2)) : done(!e)));
        return;
      }
      const model = has("piper") ? piperModel(voice) : null;
      if (!model) return resolve(null);
      const p = spawn("piper", ["--model", model, "--length_scale", String(r.piperLengthScale), "--output_file", out], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => done(false));
      p.on("exit", (code) => done(code === 0));
      p.stdin!.end(text);
    });
  },

  /** Speaks through speech-dispatcher and resolves when it's done (or stopped). */
  speak(text: string, speed: number, voice: string | null, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const p = spawn("spd-say", ["-w", "-N", "visioncli", "-r", String(rates(speed).spd), ...(voice ? ["-y", voice] : []), text.replace(/^-+/, "")], { stdio: "ignore" });
      const abort = () => {
        // Killing spd-say doesn't stop the speech it queued: cancel it in speech-dispatcher too.
        spawn("spd-say", ["-N", "visioncli", "-C"], { stdio: "ignore" }).on("error", () => {});
        p.kill();
      };
      signal.addEventListener("abort", abort, { once: true });
      p.on("error", (e) => { log(`tts: spd-say: ${e.message}`); resolve(); });
      p.on("exit", () => { signal.removeEventListener("abort", abort); resolve(); });
    });
  },

  /** Voice names for the menu: speech-dispatcher's synthesis voices, else espeak-ng's, else piper models. English first. */
  voices(): string[] {
    const b = SystemVoice.backend();
    if (b === "sapi") { void winVoice().voices(); return winVoice().cached; } // async on Windows: see voicesAsync
    if (b === "spd-say") {
      const out = spawnSync("spd-say", ["-L"], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
      return englishFirst(parseSpdVoices(out));
    }
    if (b === "espeak-ng") {
      const out = spawnSync("espeak-ng", ["--voices"], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
      return englishFirst(parseEspeakVoices(out));
    }
    const m = piperModel(null);
    return m ? [m] : [];
  },

  /** voices(), but asks SAPI on Windows (the helper answers asynchronously). */
  voicesAsync(): Promise<string[]> {
    return process.platform === "win32" ? winVoice().voices() : Promise.resolve(SystemVoice.voices());
  },
};

/** `spd-say -L`: a header, then right-aligned NAME LANGUAGE VARIANT columns. */
export function parseSpdVoices(out: string): { name: string; lang: string }[] {
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s{2,}/)).filter((f) => f.length >= 2 && f[0]).map((f) => ({ name: f[0], lang: f[1] }));
}

/** `espeak-ng --voices`: "Pty Language Age/Gender VoiceName File Other Languages". */
export function parseEspeakVoices(out: string): { name: string; lang: string }[] {
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 5).map((f) => ({ name: f[3], lang: f[1] }));
}

function englishFirst(v: { name: string; lang: string }[]): string[] {
  const en = v.filter((x) => x.lang.startsWith("en"));
  return [...new Set([...en, ...v.filter((x) => !x.lang.startsWith("en"))].map((x) => x.name))];
}
