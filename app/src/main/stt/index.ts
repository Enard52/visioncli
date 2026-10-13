import type { SpeechEngine, SpeechEngines } from "../contracts";
import { log } from "../log";
import { settings } from "../settings";
import { VoiceModels } from "./models";
import { ParakeetEngine } from "./parakeet";
import { WhisperEngine } from "./whisper";

// App+Voice.restartWhisper / chooseSpeechEngine: one engine runs at a time, falling back parakeet → whisper → system.
//
// "system": Linux has no OS speech recognizer (no SFSpeechRecognizer equivalent that every distro ships), so the
// always-available engine is whisper.cpp with the smallest English model (base.en, ~140 MB), which setup downloads
// (stt/install.ts installSystemSpeech). Without whisper-server at all, "system" can't transcribe: ready() stays false
// and transcribe() returns "", and the app should point the user at Settings → Voice to install it.

export { VoiceModels } from "./models";

const SYSTEM_MODELS = ["base.en", "tiny.en", "base", "small.en", "small"];

class NoEngine implements SpeechEngine {
  readonly name = "system";
  async ready() { return false; }
  async transcribe() { return ""; }
  stop() {}
}

export function createSpeechEngines(): SpeechEngines {
  let current: (SpeechEngine & { start?: () => Promise<boolean> }) | null = null;

  function make(setting: string): SpeechEngine & { start?: () => Promise<boolean> } {
    if (setting === "parakeet") {
      if (ParakeetEngine.available()) return new ParakeetEngine();
      log("parakeet helper missing; using Whisper");
      setting = "whisper";
    }
    if (setting === "whisper" || setting.startsWith("whisper:")) {
      const model = setting.startsWith("whisper:") ? setting.slice(8) : settings.get("whisperModel");
      const w = WhisperEngine.create(model);
      if (w) return w;
      log("whisper unavailable: install whisper-server and a ggml model; using the system engine");
    }
    return WhisperEngine.create(null, "system", SYSTEM_MODELS) ?? new NoEngine();
  }

  return {
    async choose(setting: string) {
      const next = make(setting);
      // Same engine (and model) already running: keep it warm.
      if (current && current.name === next.name && current.constructor === next.constructor) return current;
      current?.stop();
      current = next;
      void current.start?.();
      log(`speech engine: ${current.name}`);
      return current;
    },
    async available() {
      const whisper = VoiceModels.binary("whisper-server") ? VoiceModels.whisperModels().map((m) => m[0]) : [];
      return { parakeet: ParakeetEngine.available(), whisper, system: whisper.length > 0 };
    },
  };
}
