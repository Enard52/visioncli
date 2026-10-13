import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { LineSplitter } from "../core/transcript";
import { log } from "../log";
import { TMP } from "../paths";
import { VoiceModels } from "../stt/models";

// KokoroEngine (Voice.swift): kokoro-onnx through `uv`, with overlay/Resources/kokoro_server.py unchanged. JSON lines
// {"id","text","voice","speed"} in; {"id","path"} or {"id","error"} out; {"ready": true} once the model is loaded.

/** kokoro_server.py: next to the bundle (build/assets), in the packaged app, or in the repo (dev, tests). */
export function kokoroScript(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env.VISIONCLI_KOKORO_SCRIPT,
    join(__dirname, "assets/kokoro_server.py"),
    resources && join(resources, "app/build/assets/kokoro_server.py"),
    resources && join(resources, "assets/kokoro_server.py"),
    join(__dirname, "../../overlay/Resources/kokoro_server.py"),
    join(__dirname, "../../../overlay/Resources/kokoro_server.py"),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export class KokoroEngine {
  private proc: ChildProcess | null = null;
  private callbacks = new Map<number, (path: string | null) => void>();
  private nextId = 0;
  ready = false;

  static available(): boolean { return !!VoiceModels.kokoroModel() && !!VoiceModels.kokoroVoices() && !!VoiceModels.binary("uv") && !!kokoroScript(); }

  get isRunning() { return !!this.proc; }

  start() {
    if (this.proc) return;
    const uv = VoiceModels.binary("uv"), model = VoiceModels.kokoroModel(), voices = VoiceModels.kokoroVoices(), script = kokoroScript();
    if (!uv || !model || !voices || !script) { log("kokoro unavailable (needs uv, kokoro-v1.0.onnx, voices-v1.0.bin)"); return; }
    const outDir = join(TMP, "visioncli-tts");
    mkdirSync(outDir, { recursive: true });
    const env = { ...process.env, PATH: [process.env.PATH, join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin")].filter(Boolean).join(delimiter) };
    const p = VoiceModels.spawnHelper(uv, ["run", "--quiet", "--with", "kokoro-onnx", "--with", "soundfile", "python", script, model, voices, outDir],
      { stdio: ["pipe", "pipe", "ignore"], env });
    this.proc = p;
    const lines = new LineSplitter();
    p.stdout!.on("data", (d: Buffer) => lines.feed(d, (line) => {
      try { this.handle(JSON.parse(line.toString("utf8"))); } catch {}
    }));
    p.stdin!.on("error", () => {});
    p.on("error", (e) => log(`kokoro failed to start: ${e.message}`));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      log(`kokoro exited (${code})`);
      this.proc = null;
      this.ready = false;
      this.failAll();
    });
    log("kokoro starting");
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    VoiceModels.hardStop(p);
    this.ready = false;
    this.failAll();
  }

  private failAll() {
    const cbs = [...this.callbacks.values()];
    this.callbacks.clear();
    cbs.forEach((cb) => cb(null));
  }

  /** Queues text for synthesis; resolves with a WAV file, or null. */
  synth(text: string, voice: string, speed: number): Promise<string | null> {
    if (!this.proc) this.start();
    const p = this.proc;
    if (!p?.stdin?.writable) return Promise.resolve(null);
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.callbacks.set(id, resolve);
      p.stdin!.write(JSON.stringify({ id, text, voice, speed }) + "\n");
    });
  }

  private handle(obj: { ready?: boolean; id?: number; path?: string; error?: string }) {
    if (obj.ready) { this.ready = true; log("kokoro ready"); return; }
    const cb = obj.id !== undefined ? this.callbacks.get(obj.id) : undefined;
    if (!cb) return;
    this.callbacks.delete(obj.id!);
    if (obj.error) log(`kokoro error: ${obj.error}`);
    cb(obj.path ?? null);
  }
}
