import { kokoroUvArgs } from "../tts/kokoro";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { MODELS } from "../paths";
import { KOKORO_FILES as STT_KOKORO_FILES, WHISPER_MODEL_URL, installWhisperServer } from "../stt/install";
import { VoiceModels } from "../stt/models";
import { run, userPath, which, withPath } from "./run";

// Downloads the optional local voice models, so Whisper (transcription) and Kokoro (spoken answers) work on any
// machine. Models go to MODELS (SUP/models, on the voice code's search path). Port of overlay/Sources/Installer.swift.
// The whisper.cpp server binary, the URLs and uv detection come from the voice module (stt/install.ts, stt/models.ts),
// so both install the same things in the same places; this class adds the macOS flow: confirm, status text, onFinished.

export type InstallKind = "Whisper" | "Kokoro voices";

export const WHISPER_MODEL: [string, string] = ["ggml-small.en.bin", WHISPER_MODEL_URL("small.en")];
export const KOKORO_FILES: [string, string][] = STT_KOKORO_FILES;

/** whisper-server: found on PATH / DATA/bin, else installed by stt/install.ts (prebuilt release, or built with cmake). */
export const sttWhisperBinary: NonNullable<InstallerDeps["whisperBinary"]> = {
  find: () => VoiceModels.binary("whisper-server"),
  async install(onStatus) {
    try {
      await installWhisperServer((label, fraction) => onStatus(fraction == null ? `${label}…` : `Downloading ${label}… ${Math.round(fraction * 100)}%`));
      return null;
    } catch (e) {
      return `Installing whisper.cpp failed: ${(e as Error)?.message ?? e}`;
    }
  },
};

export interface InstallerDeps {
  /** Asks the user (dialog); the default installs without asking (debug / setup wizard that already asked). */
  confirm?(title: string, text: string): Promise<boolean>;
  /** whisper.cpp's server binary: find it, or install it (returns an error message or null). Default: sttWhisperBinary. */
  whisperBinary?: { find(): Promise<string | null> | string | null; install(onStatus: (s: string) => void): Promise<string | null> };
  fetch?: typeof fetch;
  modelsDir?: string;
  /** Runs shell commands (tests); default: real processes. */
  runner?: typeof run;
  platform?: string;
  /** Finds uv (tests); default: uvPath(). */
  uv?: () => string | null;
}

export function uvPath(platform: string = process.platform): string | null {
  if (platform === "win32") return VoiceModels.binary("uv") ?? which("uv", userPath());  // ~\.local\bin, ~\.cargo\bin are on userPath
  return VoiceModels.binary("uv") ?? which("uv", userPath(`${join(homedir(), ".local/bin")}:${join(homedir(), ".cargo/bin")}:${process.env.PATH ?? ""}`));
}

/** The official uv installer for this platform: astral.sh's install.sh (curl, or wget), or install.ps1 on Windows. */
export function uvInstallCommand(platform: string = process.platform): [string, string[]] {
  if (platform === "win32") return ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"]];
  return ["/bin/sh", ["-c", "if command -v curl >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh; else wget -qO- https://astral.sh/uv/install.sh | sh; fi"]];
}

export class ModelInstaller {
  /** Shown in the menu while something installs, e.g. "Downloading Kokoro voices… 42% (147/350 MB)". */
  status: string | null = null;
  onStatus: (s: string | null) => void = () => {};
  onFinished: (kind: InstallKind, error: string | null) => void = () => {};
  private kind: InstallKind = "Whisper";

  constructor(private deps: InstallerDeps = {}) {}

  get isBusy() { return this.status != null; }
  get modelsDir() { return this.deps.modelsDir ?? MODELS; }
  private get runner() { return this.deps.runner ?? run; }

  whisperInstalled() {
    return this.deps.modelsDir ? existsSync(join(this.modelsDir, WHISPER_MODEL[0])) : VoiceModels.whisperModels().length > 0;
  }
  kokoroInstalled() {
    return this.deps.modelsDir ? KOKORO_FILES.every(([f]) => existsSync(join(this.modelsDir, f))) : !!(VoiceModels.kokoroModel() && VoiceModels.kokoroVoices());
  }

  private findUv() { return this.deps.uv ? this.deps.uv() : uvPath(this.deps.platform); }

  private confirm(title: string, text: string) { return this.deps.confirm ? this.deps.confirm(title, text) : Promise.resolve(true); }

  // ── Whisper ───────────────────────────────────────────────────────────────────────────────────────────────────

  async installWhisper() {
    if (this.isBusy) return;
    this.kind = "Whisper";
    const bin = this.deps.whisperBinary ?? sttWhisperBinary;
    const needsBinary = !(await bin.find());
    const text = needsBinary
      ? "This installs whisper.cpp, then downloads the small English model (~490 MB). Transcription then runs locally on this computer."
      : "Downloads the small English model (~490 MB). Transcription then runs locally on this computer.";
    if (!(await this.confirm(needsBinary ? "Install Whisper?" : "Download Whisper?", text))) return;
    if (needsBinary) {
      this.setStatus("Installing whisper.cpp…");
      const err = await bin.install((s) => this.setStatus(s)).catch((e) => String(e?.message ?? e));
      if (err) { this.fail(err); return; }
    }
    await this.download([WHISPER_MODEL]);
  }

  // ── Kokoro ────────────────────────────────────────────────────────────────────────────────────────────────────

  async installKokoro() {
    if (this.isBusy) return;
    this.kind = "Kokoro voices";
    const needsUV = this.findUv() == null;
    const ok = await this.confirm("Download Kokoro voices?", `Downloads the Kokoro voice model (~350 MB)${needsUV ? " and installs uv (a small Python tool runner, from astral.sh)" : ""}. Answers are then read aloud in natural voices, locally on this computer.`);
    if (!ok) return;
    if (needsUV) {
      this.setStatus("Installing uv…");
      // The official installer (to ~/.local/bin, no root or admin).
      const [cmd, args] = uvInstallCommand(this.deps.platform);
      const r = await this.runner(cmd, args, { env: withPath(userPath()), timeout: 300_000 });
      if (r.code !== 0) { this.fail(`Installing uv failed: ${r.err.split("\n").filter(Boolean).slice(-2).join(" ")}`); return; }
    }
    await this.download(KOKORO_FILES);
  }

  /** Debug: download files through the normal pipeline without dialogs (`--test-download`). */
  debugDownload(files: [string, string][]) {
    this.kind = "Kokoro voices";
    return this.download(files);
  }

  // ── Downloads ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async download(files: [string, string][]) {
    mkdirSync(this.modelsDir, { recursive: true });
    const queue = files.filter(([name]) => !existsSync(join(this.modelsDir, name)));
    this.setStatus(`Downloading ${this.kind}…`);
    for (const [name, url] of queue) {
      log(`installer: downloading ${name}`);
      const err = await this.fetchTo(name, url).catch((e) => `Download failed: ${e?.message ?? e}`);
      if (err) { this.fail(err); return; }
    }
    await this.finishDownloads();
  }

  private async fetchTo(name: string, url: string): Promise<string | null> {
    const res = await (this.deps.fetch ?? fetch)(url);
    if (res.status !== 200 || !res.body) return `Download failed (HTTP ${res.status}) for ${name}.`;
    const dest = join(this.modelsDir, name), part = dest + ".part";
    const total = Number(res.headers.get("content-length")) || 0;
    const out = createWriteStream(part);
    let got = 0, lastPct = -1;
    const mb = (b: number) => (b / 1_000_000).toFixed(0);
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        if (total > 0) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct) { lastPct = pct; this.setStatus(`Downloading ${this.kind}… ${pct}% (${mb(got)}/${mb(total)} MB)`); }
        }
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    } catch (e) {
      out.destroy();
      rmSync(part, { force: true });
      throw e;
    }
    try {
      rmSync(dest, { force: true });
      renameSync(part, dest);
    } catch (e) {
      return `Couldn't save ${name}: ${(e as Error).message}`;
    }
    return null;
  }

  private async finishDownloads() {
    if (this.kind === "Kokoro voices") {
      // Fetch the Python packages once now, so the first spoken answer doesn't wait for them.
      this.setStatus("Preparing Kokoro…");
      const uv = this.findUv();
      if (uv) await this.runner(uv, [...kokoroUvArgs(), "-c", "import kokoro_onnx"],
        { env: withPath(userPath()), timeout: 600_000 });
    }
    this.done();
  }

  private done() {
    if (this.status == null) return; // already reported
    log(`installer: ${this.kind} installed`);
    this.setStatus(null);
    this.onFinished(this.kind, null);
  }

  private fail(message: string) {
    log(`installer: ${message}`);
    this.setStatus(null);
    this.onFinished(this.kind, message);
  }

  private setStatus(s: string | null) { this.status = s; this.onStatus(s); }
}
