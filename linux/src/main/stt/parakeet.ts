import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { cpus } from "node:os";
import type { SpeechEngine } from "../contracts";
import { readWav } from "../audio/wav";
import { log } from "../log";
import { VoiceModels, parakeetFiles, sherpaServer } from "./models";
import { PartialGate } from "./partial";
import { applyVocabulary } from "./vocab";
import { wsRequest } from "./ws";

// ParakeetEngine on Linux: NVIDIA Parakeet TDT 0.6B v2 (int8 ONNX, the model the macOS helper runs on the Neural
// Engine) through sherpa-onnx's prebuilt `sherpa-onnx-offline-websocket-server`, kept running so the ~650 MB model
// loads once. One WebSocket request per transcription: int32 sample rate, int32 byte count, float32 samples.

/** sherpa-onnx's request: sample rate and byte count (int32 LE), then the float32 samples. */
export function sherpaRequest(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(8 + samples.length * 4);
  b.writeInt32LE(rate, 0);
  b.writeInt32LE(samples.length * 4, 4);
  for (let i = 0; i < samples.length; i++) b.writeFloatLE(samples[i], 8 + i * 4);
  return b;
}

/** The reply is JSON ({"text": …}) in current sherpa-onnx, plain text in old builds. */
export function sherpaText(reply: string): string {
  try { const o = JSON.parse(reply) as { text?: string }; if (typeof o.text === "string") return o.text.trim(); } catch {}
  return reply.trim();
}

export class ParakeetEngine implements SpeechEngine {
  readonly name = "parakeet";
  private proc: ChildProcess | null = null;
  private port = 0;
  private isReady = false;
  private starting: Promise<boolean> | null = null;
  private captions = new PartialGate();

  static available(): boolean { return !!sherpaServer() && !!parakeetFiles(); }

  start(attempt = 0): Promise<boolean> {
    if (this.proc) return this.starting ?? Promise.resolve(this.isReady);
    const bin = sherpaServer(), f = parakeetFiles();
    if (!bin || !f) { log("parakeet unavailable (needs sherpa-onnx and the parakeet model)"); return Promise.resolve(false); }
    this.isReady = false;
    this.port = 18100 + Math.floor(Math.random() * 900);
    const threads = String(Math.max(1, Math.min(4, cpus().length)));
    const p = VoiceModels.spawnHelper(bin, [
      `--port=${this.port}`, `--encoder=${f.encoder}`, `--decoder=${f.decoder}`, `--joiner=${f.joiner}`, `--tokens=${f.tokens}`,
      "--model-type=nemo_transducer", `--num-threads=${threads}`, "--num-work-threads=1", "--num-io-threads=1", "--max-batch-size=1",
    ]);
    this.proc = p;
    p.on("error", (e) => log(`parakeet failed to start: ${e.message}`));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.isReady = false;
      log(`parakeet exited (${code})`);
      if (attempt < 2) this.start(attempt + 1);
    });
    log(`parakeet starting on port ${this.port}`);
    this.starting = this.waitUntilReady(p).finally(() => { this.starting = null; });
    return this.starting;
  }

  /** The server only listens once the model is loaded, so a TCP connect means ready. */
  private async waitUntilReady(p: ChildProcess): Promise<boolean> {
    for (let i = 0; i < 240 && this.proc === p; i++) {
      const ok = await new Promise<boolean>((res) => {
        const s = connect(this.port, "127.0.0.1");
        s.once("connect", () => { s.destroy(); res(true); });
        s.once("error", () => res(false));
      });
      if (ok && this.proc === p) { this.isReady = true; log("parakeet ready"); return true; }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async ready(): Promise<boolean> { return this.isReady; }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.isReady = false;
    VoiceModels.hardStop(p);
  }

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
      if (partial) return null;
      const ok = await Promise.race([this.starting ?? Promise.resolve(false), new Promise<boolean>((r) => setTimeout(() => r(false), 15000))]);
      if (!ok) return null;
    }
    const started = Date.now();
    try {
      const { samples, rate } = readWav(wav);
      if (samples.length < rate / 10) return ""; // < 0.1 s is nothing
      const reply = await wsRequest(this.port, sherpaRequest(samples, rate), partial ? 4000 : Math.round(Math.max(6000, (samples.length / rate) * 1000)));
      const text = applyVocabulary(sherpaText(reply), vocabulary);
      if (!partial) log(`parakeet: ${Date.now() - started}ms`);
      return text;
    } catch (e) {
      log(`parakeet: ${Date.now() - started}ms error ${(e as Error).message}`);
      return null;
    }
  }
}
