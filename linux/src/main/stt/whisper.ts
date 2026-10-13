import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename } from "node:path";
import type { SpeechEngine } from "../contracts";
import { log } from "../log";
import { VoiceModels } from "./models";
import { PartialGate } from "./partial";

// WhisperEngine (Voice.swift): whisper.cpp's `whisper-server` as a long-lived process on 127.0.0.1:18100–18999, so
// each question only pays inference time. The vocabulary goes in as Whisper's prompt.

export function whisperPrompt(vocabulary: string[]): string {
  return vocabulary.length ? "Vocabulary: " + vocabulary.join(", ") + "." : "";
}

/** whisper-server's JSON reply → the transcript ("[BLANK_AUDIO]" and other non-speech tags → ""). */
export function whisperText(json: string): string | null {
  let t: unknown;
  try { t = (JSON.parse(json) as { text?: unknown }).text; } catch { return null; }
  if (typeof t !== "string") return null;
  // Segments are separated by newlines that can fall mid-word ("La\nravel"); words carry their own spaces.
  const text = t.replace(/\n/g, "").trim();
  return /^\[.*\]$|^\(.*\)$/.test(text) ? "" : text;
}

export class WhisperEngine implements SpeechEngine {
  readonly name: string;
  readonly modelName: string;
  private proc: ChildProcess | null = null;
  private port = 0;
  private isReady = false;
  private starting: Promise<boolean> | null = null;
  private captions = new PartialGate();

  /** Nil (null) when whisper-server or a ggml model is missing. `label` replaces the name (the "system" engine). */
  static create(model: string | null, label?: string, prefer?: string[]): WhisperEngine | null {
    const bin = VoiceModels.binary("whisper-server");
    const models = VoiceModels.whisperModels();
    const pick = (model && models.find((m) => m[0] === model)) || (prefer ?? []).map((p) => models.find((m) => m[0] === p)).find(Boolean) || models[0];
    if (!bin || !pick) return null;
    return new WhisperEngine(bin, pick[1], label);
  }

  constructor(private binary: string, private modelPath: string, label?: string) {
    this.modelName = basename(modelPath).replace(/\.bin$/, "").replace(/^ggml-/, "");
    this.name = label ?? `whisper:${this.modelName}`;
  }

  start(attempt = 0): Promise<boolean> {
    if (this.proc) return this.starting ?? Promise.resolve(this.isReady);
    this.isReady = false;
    this.port = 18100 + Math.floor(Math.random() * 900);
    // Linux runs Whisper on the CPU (no Metal): use most cores, leaving one for the UI.
    const threads = String(Math.max(1, Math.min(8, cpus().length - 1)));
    const p = VoiceModels.spawnHelper(this.binary, ["-m", this.modelPath, "--host", "127.0.0.1", "--port", String(this.port), "-t", threads]);
    this.proc = p;
    p.on("error", (e) => log(`whisper-server failed to start: ${e.message}`));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.isReady = false;
      log(`whisper-server exited (${code})`);
      if (attempt < 2) this.start(attempt + 1); // port clash or crash: try again
    });
    log(`whisper-server starting (${this.modelName}) on port ${this.port}`);
    this.starting = this.waitUntilReady(p, 120).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async waitUntilReady(p: ChildProcess, tries: number): Promise<boolean> {
    for (let i = 0; i < tries && this.proc === p; i++) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
        this.isReady = true;
        log("whisper-server ready");
        return true;
      } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    return false;
  }

  async ready(): Promise<boolean> { return this.isReady; }
  get isRunning() { return !!this.proc; }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.isReady = false;
    VoiceModels.hardStop(p);
  }

  /**
   * Transcribes a 16 kHz mono WAV; "" when nothing was heard or on failure (the app falls back like macOS on nil).
   * Partial (live captions): never queues behind another caption request, and skips Whisper's temperature fallback.
   */
  async transcribe(wav: string, vocabulary: string[], partial = false): Promise<string> {
    if (partial) {
      const now = this.captions.begin(wav);
      if (now !== null) return now;
      return this.captions.end(await this.run(wav, vocabulary, true));
    }
    return (await this.run(wav, vocabulary, false)) ?? "";
  }

  private async run(wav: string, vocabulary: string[], partial: boolean): Promise<string | null> {
    if (!this.isReady) {
      if (!this.proc) this.start();
      // Still loading the model: worth waiting for a final transcript, not for a caption.
      if (partial) return null;
      const ok = await Promise.race([this.starting ?? Promise.resolve(false), new Promise<boolean>((r) => setTimeout(() => r(false), 15000))]);
      if (!ok) return null;
    }
    const started = Date.now();
    try {
      const audio = await readFile(wav);
      const form = new FormData();
      form.append("response_format", "json");
      form.append("temperature", "0");
      const seconds = Math.max(0, audio.length - 44) / 32000;
      // No timestamps needed: fewer tokens to decode.
      form.append("no_timestamps", "true");
      if (partial) {
        // Captions: no temperature fallback, and an encoder context sized to the audio instead of Whisper's fixed
        // 30 s window (50 positions a second), most of the cost of a short snippet on a CPU (4–8× faster). Not for the
        // final text: a shrunken context garbles longer clips ("what is this is this is"). At least 256: a context
        // barely longer than a 1 s snippet made it return junk.
        form.append("temperature_inc", "0");
        form.append("audio_ctx", String(Math.min(1500, Math.max(256, Math.ceil(seconds * 50) + 128))));
      }
      const prompt = whisperPrompt(vocabulary);
      if (prompt) form.append("prompt", prompt);
      form.append("file", new Blob([audio], { type: "audio/wav" }), "q.wav");
      // CPUs vary far more than Macs do: allow the longer of 10 s and twice the audio's length.
      const timeout = partial ? 4000 : Math.round(Math.max(10_000, seconds * 2000));
      const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(timeout) });
      const text = whisperText(await res.text());
      if (!partial) log(`whisper: ${((Date.now() - started) / 1000).toFixed(2)}s`);
      return text;
    } catch (e) {
      log(`whisper: ${((Date.now() - started) / 1000).toFixed(2)}s error ${(e as Error).message}`);
      return null;
    }
  }
}
