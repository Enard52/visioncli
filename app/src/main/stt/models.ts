import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { hostCommand } from "../../../../src/flatpak";
import { log } from "../log";
import { DATA, MODELS, SUP } from "../paths";

// VoiceModels (Voice.swift): where models and helper binaries are found, and the helper processes' bookkeeping.

const home = homedir();
let strays = false; // the previous run's helpers were dealt with

export const VoiceModels = {
  searchDirs: [
    MODELS,
    join(home, ".cache/hyperframes/whisper/models"),
    join(home, ".cache/whisper"),
    join(home, ".cache/hyperframes/tts/models"),
    join(home, ".cache/hyperframes/tts/voices"),
    join(home, ".local/share/whisper.cpp"),
    "/usr/share/whisper.cpp",
    "/usr/share/whisper-cpp",
    "/usr/local/share/whisper.cpp",
    "/usr/local/share/whisper-cpp",
  ],

  /** Whisper ggml models found on disk: name ("small.en") → path, most useful first. */
  whisperModels(): [string, string][] {
    const preferred = ["small.en", "small", "base.en", "medium.en", "medium", "large-v3-turbo", "large-v3", "base", "tiny.en"];
    const found = new Map<string, string>();
    for (const dir of VoiceModels.searchDirs) {
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith("ggml-") || !f.endsWith(".bin")) continue;
        const name = f.slice(5, -4);
        if (!name.includes("for-tests") && !found.has(name)) found.set(name, join(dir, f));
      }
    }
    const rank = (n: string) => { const i = preferred.indexOf(n); return i < 0 ? 99 : i; };
    return [...found].sort((a, b) => rank(a[0]) - rank(b[0]));
  },

  find(file: string): string | null {
    return VoiceModels.searchDirs.map((d) => join(d, file)).find((p) => existsSync(p)) ?? null;
  },

  /** An executable on PATH or in the usual per-user folders (Electron apps started from a menu get a short PATH). */
  binary(name: string, extra: string[] = []): string | null {
    // XDG_BIN_HOME / $XDG_DATA_HOME/../bin: where uv's installer puts uv when those are set.
    const xdgBin = [process.env.XDG_BIN_HOME, process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, "../bin")].filter((d): d is string => !!d);
    const win = process.platform === "win32";
    // Windows: PATH, then DATA\bin (whisper-server.exe and its DLLs) and uv's %USERPROFILE%\.local\bin.
    const dirs = win
      ? [...extra, ...(process.env.PATH ?? process.env.Path ?? "").split(delimiter), join(DATA, "bin"), join(home, ".local/bin"), join(home, ".cargo/bin")]
      : [...extra, ...(process.env.PATH ?? "").split(delimiter), join(DATA, "bin"), ...xdgBin, join(home, ".local/bin"), join(home, ".cargo/bin"), "/usr/local/bin", "/usr/bin"];
    for (const d of dirs) {
      if (!d) continue;
      for (const n of exeNames(name)) {
        const p = join(d, n);
        try { accessSync(p, constants.X_OK); return p; } catch {}
      }
    }
    return null;
  },

  kokoroModel(): string | null { return VoiceModels.find("kokoro-v1.0.onnx"); },
  kokoroVoices(): string | null { return VoiceModels.find("voices-v1.0.bin"); },

  /** Curated Kokoro voices for the menu: id → label. */
  kokoroVoiceList: [
    ["af_heart", "Heart (US, warm)"], ["af_bella", "Bella (US)"], ["af_nicole", "Nicole (US, soft)"],
    ["am_michael", "Michael (US)"], ["am_adam", "Adam (US)"], ["bf_emma", "Emma (UK)"], ["bm_george", "George (UK)"],
  ] as [string, string][],

  // Helper PIDs are recorded so a later launch can clean up after a crash or hard kill.
  pidFile: join(SUP, "helpers.pid"),

  remember(pid: number | undefined) {
    if (!pid) return;
    let pids = "";
    try { pids = readFileSync(VoiceModels.pidFile, "utf8"); } catch {}
    try { writeFileSync(VoiceModels.pidFile, pids + `${pid}\n`); } catch {}
  },

  /** Kill helpers left over from a previous run (only if they're still whisper-server / sherpa / kokoro processes). */
  killStrays() {
    if (strays) return;
    strays = true;
    let text = "";
    try { text = readFileSync(VoiceModels.pidFile, "utf8"); rmSync(VoiceModels.pidFile); } catch { return; }
    for (const pid of text.split("\n").map(Number).filter((n) => n > 1)) {
      if (process.platform === "win32") {
        // No /proc: the image name from tasklist, so a reused pid of an unrelated program is never killed.
        const image = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).stdout ?? "";
        if (isHelperImage(image)) { killTree(pid); log(`killed stray helper ${pid}`); }
        continue;
      }
      let cmd = "";
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (/whisper-server|sherpa-onnx|kokoro_server|kokoro-onnx/.test(cmd)) {
        try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
        log(`killed stray helper ${pid}`);
      }
    }
  },

  /** Starts a helper in its own process group, so stopping it also stops its children (`uv run` → python). */
  spawnHelper(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
    VoiceModels.killStrays(); // first helper of this run: the pid file still lists the previous run's
    // windowsHide: a detached console program would otherwise open a console window on Windows.
    // Flatpak: host tools (uv, a downloaded whisper-server) run on the host and stop with the app (--watch-bus).
    const h = hostCommand(cmd, args, { env: opts.env, watch: true });
    const p = spawn(h.file, h.args, { stdio: "ignore", windowsHide: true, ...opts, detached: true });
    VoiceModels.remember(p.pid);
    return p;
  },

  /** Stop a helper for sure: SIGKILL its whole process group right away. */
  hardStop(p: ChildProcess | null | undefined) {
    if (!p?.pid || p.exitCode !== null || p.signalCode !== null) return;
    if (process.platform === "win32") { killTree(p.pid); return; } // no process groups: taskkill /T takes the children
    try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); }
  },
};

/** Names an executable has on disk: "whisper-server" is whisper-server.exe on Windows. */
export function exeNames(name: string, platform: string = process.platform): string[] {
  return platform === "win32" && !/\.(exe|cmd|bat)$/i.test(name) ? [`${name}.exe`] : [name];
}

/** A tasklist CSV row of one of our helpers (whisper-server.exe, sherpa-onnx-….exe, uv.exe running Kokoro). */
export const isHelperImage = (row: string) => /^"(whisper-server|sherpa-onnx[^"]*|uv)\.exe"/i.test(row.trim());

/** Windows: the process and everything it started (uv → python). */
function killTree(pid: number) {
  spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, timeout: 5000 });
}

// sherpa-onnx (Parakeet on Linux): the runtime goes to DATA/sherpa-onnx, the model to MODELS.
export const SHERPA_DIR = join(DATA, "sherpa-onnx");
export const PARAKEET_MODEL = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

export function parakeetFiles(): { encoder: string; decoder: string; joiner: string; tokens: string } | null {
  for (const dir of [MODELS, ...VoiceModels.searchDirs.slice(1)]) {
    const d = join(dir, PARAKEET_MODEL);
    const f = { encoder: join(d, "encoder.int8.onnx"), decoder: join(d, "decoder.int8.onnx"), joiner: join(d, "joiner.int8.onnx"), tokens: join(d, "tokens.txt") };
    if (Object.values(f).every((p) => existsSync(p))) return f;
  }
  return null;
}

export function sherpaServer(): string | null {
  return VoiceModels.binary("sherpa-onnx-offline-websocket-server", [join(SHERPA_DIR, "bin")]);
}
