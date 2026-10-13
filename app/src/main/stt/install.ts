import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join, win32 as win32Path } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "../log";
import { resourcesDir } from "../desktop/windows/common";
import { CACHE, DATA, MODELS } from "../paths";
import { PARAKEET_MODEL, SHERPA_DIR, VoiceModels } from "./models";

// ModelInstaller (Installer.swift) for Linux: downloads the local voice helpers and models, no root, no compiling
// (unless there's no prebuilt for this machine and cmake is there).
//
// whisper-server — the official ggml-org/whisper.cpp GitHub releases. The vX.Y.Z tags carry no files, but the
// rolling "bNNNN" releases attach `whisper-bin-ubuntu-x64.tar.gz` and `whisper-bin-ubuntu-arm64.tar.gz`, built by
// whisper.cpp's own CI: whisper-server plus its shared ggml/whisper libraries, linked with RUNPATH=$ORIGIN, so they
// run from any folder. Built on Ubuntu 22.04 (glibc 2.35): runs on Debian 12, Fedora 36+, Arch, openSUSE…; needs
// libgomp (part of every GCC runtime install). Rejected: pywhispercpp's wheels (a Python binding, no server binary),
// distro packages (missing on most distros), Homebrew-on-Linux bottles (need /home/linuxbrew). Fallback when the
// prebuilt can't run (old glibc, musl, other CPUs): build that release's source with cmake, if cmake and a C++
// compiler are installed.
//
// Windows (x64, arm64): whisper.cpp's own CPU builds, `whisper-bin-x64.zip` and `whisper-bin-win-cpu-arm64.zip`
// (whisper-server.exe + ggml/whisper DLLs, MSVC-built: they need the Visual C++ 2015-2022 runtime, which is copied in
// next to them from the app's resources when Windows doesn't have it). sherpa-onnx's
// `win-<arch>-shared-MT-Release-no-tts` build (static CRT: no runtime needed; the .exe and onnxruntime DLLs in bin/).
// Archives are unpacked with Windows' own tar.exe (bsdtar, Windows 10 1803+: .zip and .tar.bz2), no npm dependency.
// No source-build fallback on Windows (no compiler on users' machines).
//
// Models: the same huggingface ggml files as macOS. Parakeet: sherpa-onnx's prebuilt Linux runtime (CPU, shared
// libs with RUNPATH) and k2-fsa's int8 ONNX export of parakeet-tdt-0.6b-v2. Kokoro: the same files as macOS + uv.

export type Progress = (label: string, fraction: number | null) => void;

export const WHISPER_MODEL_URL = (name: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
export const WHISPER_RELEASES = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30";
/** Used when the GitHub API is unreachable or rate-limited (60 requests/hour without a token). */
export const WHISPER_FALLBACK_TAG = "b5454";

export const SHERPA_VERSION = "1.13.8";
export const sherpaUrl = (arch = process.arch, platform = process.platform) =>
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-` + (platform === "win32"
    ? `win-${arch === "arm64" ? "arm64" : "x64"}-shared-MT-Release-no-tts.tar.bz2`
    : `linux-${arch === "arm64" ? "aarch64-shared-cpu" : "x64-shared"}.tar.bz2`);
export const PARAKEET_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_MODEL}.tar.bz2`;

export const KOKORO_FILES: [string, string][] = [
  ["kokoro-v1.0.onnx", "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"],
  ["voices-v1.0.bin", "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"],
];

const BIN = join(DATA, "bin");
const WIN = process.platform === "win32";

/** The whisper.cpp release asset with a CPU build for this system. */
export function whisperAssetName(arch = process.arch, platform = process.platform): string {
  if (platform === "win32") return arch === "arm64" ? "whisper-bin-win-cpu-arm64.zip" : "whisper-bin-x64.zip";
  return `whisper-bin-ubuntu-${arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
}

/** The files of whisper.cpp's archive folder that whisper-server needs (not the tests and other tools). */
export function whisperFilesToKeep(names: string[], platform = process.platform): string[] {
  return platform === "win32"
    ? names.filter((f) => /^whisper-server\.exe$/i.test(f) || (/\.dll$/i.test(f) && !/^SDL2\.dll$/i.test(f)))
    : names.filter((f) => f === "whisper-server" || /^lib.*\.so/.test(f));
}

/** The files of sherpa-onnx's Windows bin/ folder the server needs: itself and the onnxruntime DLLs. */
export const sherpaWinFiles = (names: string[]) =>
  names.filter((f) => /^sherpa-onnx-offline-websocket-server\.exe$/i.test(f) || /\.dll$/i.test(f));

/** tar: on Windows the system's bsdtar (unpacks .zip too), not a GNU tar from Git or MSYS earlier on PATH. */
export function tarBin(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === "win32" ? win32Path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe") : "tar";
}

/** The Visual C++ runtime DLLs the app ships for whisper.cpp's MSVC build (resources/win32/vcruntime/<arch>). */
export const VC_RUNTIME = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

const sh = (cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) => new Promise<{ ok: boolean; out: string }>((res) => {
  execFile(cmd, args, { maxBuffer: 32 << 20, timeout: opts.timeout ?? 0, cwd: opts.cwd, windowsHide: true }, (e, stdout, stderr) =>
    res({ ok: !e, out: (stdout + stderr).trim() }));
});

/** Downloads `url` to `dest` (via dest.part, so a cut-off download never looks finished). */
export async function download(url: string, dest: string, label: string, progress?: Progress): Promise<void> {
  await mkdir(join(dest, ".."), { recursive: true });
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "visioncli", "Accept-Encoding": "identity" } });
  if (!res.ok || !res.body) throw new Error(`${label}: download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, shown = -1;
  // Counted in a Transform: a 'data' listener would start the flow before the file is attached and lose the start.
  const count = new Transform({
    transform(c: Buffer, _enc, next) {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== shown) { shown = pct; progress?.(label, total ? got / total : null); }
      next(null, c);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(dest + ".part"));
  if (total && got !== total) throw new Error(`${label}: download cut off (${got} of ${total} bytes)`);
  await rename(dest + ".part", dest);
  log(`installer: ${label} → ${dest} (${(got / 1e6).toFixed(0)} MB)`);
}

/** The newest whisper.cpp release with a prebuilt Linux build for this CPU. */
export async function whisperServerAsset(arch = process.arch, platform = process.platform): Promise<{ tag: string; url: string }> {
  const name = whisperAssetName(arch, platform);
  try {
    const res = await fetch(WHISPER_RELEASES, { headers: { "User-Agent": "visioncli", Accept: "application/vnd.github+json" } });
    const releases = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }[];
    for (const r of releases) {
      const a = r.assets?.find((x) => x.name === name);
      if (a) return { tag: r.tag_name, url: a.browser_download_url };
    }
  } catch (e) { log(`installer: GitHub API: ${e}`); }
  return { tag: WHISPER_FALLBACK_TAG, url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_FALLBACK_TAG}/${name}` };
}

/** Whether a binary loads and runs here (its libraries resolve, glibc is new enough). */
async function runs(bin: string): Promise<boolean> {
  return (await sh(bin, ["--help"], { timeout: 15000 })).ok;
}

/** Installs whisper-server into DATA/bin (prebuilt, else built with cmake). Resolves with its path. */
export async function installWhisperServer(progress?: Progress): Promise<string> {
  const existing = VoiceModels.binary("whisper-server");
  if (existing && await runs(existing)) return existing;
  if (WIN) return installWhisperServerWindows(progress);
  if (process.arch !== "x64" && process.arch !== "arm64") return buildWhisperServer(progress);
  const { tag, url } = await whisperServerAsset();
  const tmp = await mkdtemp(join(CACHE, "whisper-"));
  try {
    await download(url, join(tmp, "whisper.tar.gz"), "whisper.cpp", progress);
    const x = await sh("tar", ["-xf", join(tmp, "whisper.tar.gz"), "-C", tmp]);
    if (!x.ok) throw new Error(`unpacking whisper.cpp failed: ${x.out}`);
    const dir = (await readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory())?.name;
    if (!dir) throw new Error("unexpected whisper.cpp archive");
    await mkdir(BIN, { recursive: true });
    // The server and the libraries it loads from its own folder ($ORIGIN); not the tests and tools.
    for (const f of await readdir(join(tmp, dir))) {
      if (f === "whisper-server" || /^lib.*\.so/.test(f)) await copyFile(join(tmp, dir, f), join(BIN, f));
    }
    const bin = join(BIN, "whisper-server");
    await chmod(bin, 0o755);
    if (await runs(bin)) { log(`installer: whisper-server ${tag} (prebuilt)`); return bin; }
    log("installer: the prebuilt whisper-server doesn't run here; building from source");
    return buildWhisperServer(progress, tag);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Windows: whisper.cpp's CPU zip into DATA\bin (whisper-server.exe and its DLLs side by side). */
async function installWhisperServerWindows(progress?: Progress): Promise<string> {
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("Whisper needs 64-bit Windows (x64 or ARM64).");
  const { tag, url } = await whisperServerAsset();
  const tmp = await mkdtemp(join(CACHE, "whisper-"));
  try {
    await download(url, join(tmp, "whisper.zip"), "whisper.cpp", progress);
    const x = await sh(tarBin(), ["-xf", join(tmp, "whisper.zip"), "-C", tmp]);
    if (!x.ok) throw new Error(`unpacking whisper.cpp failed: ${x.out}`);
    const dir = (await readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory())?.name;
    if (!dir) throw new Error("unexpected whisper.cpp archive");
    await mkdir(BIN, { recursive: true });
    for (const f of whisperFilesToKeep(await readdir(join(tmp, dir)), "win32")) await copyFile(join(tmp, dir, f), join(BIN, f));
    const bin = join(BIN, "whisper-server.exe");
    if (await runs(bin)) { log(`installer: whisper-server ${tag} (prebuilt)`); return bin; }
    // Most likely the Visual C++ runtime is missing: put the app's copy next to the server (app-local, no admin).
    // Packaged: resources/win32/vcruntime/<arch> next to app.asar (real files); dev: app/resources.
    const vc = [(process as { resourcesPath?: string }).resourcesPath, resourcesDir()].filter(Boolean)
      .map((r) => join(r!, "win32", "vcruntime", process.arch)).find((d) => VC_RUNTIME.every((f) => existsSync(join(d, f))));
    if (vc) {
      for (const f of VC_RUNTIME) await copyFile(join(vc, f), join(BIN, f));
      if (await runs(bin)) { log(`installer: whisper-server ${tag} (prebuilt, app-local VC++ runtime)`); return bin; }
    }
    throw new Error("whisper-server doesn't start: it needs the Microsoft Visual C++ Redistributable (https://aka.ms/vs/17/release/vc_redist."
      + `${process.arch === "arm64" ? "arm64" : "x64"}.exe).`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Builds whisper-server from the release's source (needs cmake and a C++ compiler; a few minutes). */
export async function buildWhisperServer(progress?: Progress, tag?: string): Promise<string> {
  if (!VoiceModels.binary("cmake") || !(VoiceModels.binary("c++") || VoiceModels.binary("g++") || VoiceModels.binary("clang++")))
    throw new Error("No prebuilt whisper.cpp for this system. Install whisper.cpp from your distribution, or install cmake and a C++ compiler and try again.");
  tag ??= (await whisperServerAsset()).tag;
  const tmp = await mkdtemp(join(CACHE, "whisper-src-"));
  try {
    await download(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${tag}.tar.gz`, join(tmp, "src.tar.gz"), "whisper.cpp source", progress);
    await sh("tar", ["-xf", join(tmp, "src.tar.gz"), "-C", tmp]);
    const src = join(tmp, (await readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory())!.name);
    progress?.("Building whisper.cpp", null);
    const cfg = await sh("cmake", ["-S", src, "-B", join(src, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF"]);
    if (!cfg.ok) throw new Error(`cmake failed: ${cfg.out.slice(-300)}`);
    const b = await sh("cmake", ["--build", join(src, "build"), "--config", "Release", "--target", "whisper-server", "-j"]);
    if (!b.ok) throw new Error(`building whisper.cpp failed: ${b.out.slice(-300)}`);
    await mkdir(BIN, { recursive: true });
    const bin = join(BIN, "whisper-server");
    await copyFile(join(src, "build", "bin", "whisper-server"), bin);
    await chmod(bin, 0o755);
    log(`installer: whisper-server ${tag} (built)`);
    return bin;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** A ggml model into MODELS ("small.en" ≈ 490 MB, "base.en" ≈ 150 MB). */
export async function installWhisperModel(name = "small.en", progress?: Progress): Promise<string> {
  const dest = join(MODELS, `ggml-${name}.bin`);
  if (!existsSync(dest)) await download(WHISPER_MODEL_URL(name), dest, `Whisper ${name}`, progress);
  return dest;
}

/** Setup's always-on transcription ("system" on Linux): whisper-server + base.en. */
export async function installSystemSpeech(progress?: Progress): Promise<void> {
  await installWhisperServer(progress);
  await installWhisperModel("base.en", progress);
}

/** Whisper as the Settings menu installs it: whisper-server + small.en (the default model, like macOS). */
export async function installWhisper(progress?: Progress, model = "small.en"): Promise<void> {
  await installWhisperServer(progress);
  await installWhisperModel(model, progress);
}

async function untarBz2(file: string, dir: string) {
  await mkdir(dir, { recursive: true });
  const x = await sh(tarBin(), ["-xf", file, "-C", dir]);
  if (!x.ok && WIN) throw new Error(`unpacking failed: ${x.out.slice(-300)}`);
  if (!x.ok) throw new Error(!VoiceModels.binary("bzip2") ? "Unpacking needs bzip2: install it with your package manager." : `unpacking failed: ${x.out.slice(-300)}`);
}

/** sherpa-onnx (~30 MB) into DATA/sherpa-onnx and the Parakeet model (~640 MB) into MODELS. */
export async function installParakeet(progress?: Progress): Promise<void> {
  const server = join(SHERPA_DIR, "bin", WIN ? "sherpa-onnx-offline-websocket-server.exe" : "sherpa-onnx-offline-websocket-server");
  if (!existsSync(server)) {
    if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("Parakeet needs a 64-bit Intel/AMD or ARM computer.");
    const tmp = await mkdtemp(join(CACHE, "sherpa-"));
    try {
      await download(sherpaUrl(), join(tmp, "sherpa.tar.bz2"), "sherpa-onnx", progress);
      await untarBz2(join(tmp, "sherpa.tar.bz2"), tmp);
      const dir = (await readdir(tmp, { withFileTypes: true })).find((d) => d.isDirectory())!.name;
      await rm(SHERPA_DIR, { recursive: true, force: true });
      await mkdir(join(SHERPA_DIR, "bin"), { recursive: true });
      if (WIN) {
        // Windows finds DLLs next to the .exe: the server and onnxruntime*.dll stay together in bin\.
        for (const f of sherpaWinFiles(await readdir(join(tmp, dir, "bin")))) await rename(join(tmp, dir, "bin", f), join(SHERPA_DIR, "bin", f));
      } else {
        await rename(join(tmp, dir, "lib"), join(SHERPA_DIR, "lib"));
        await rename(join(tmp, dir, "bin", "sherpa-onnx-offline-websocket-server"), server);
      }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }
  if (!existsSync(join(MODELS, PARAKEET_MODEL, "tokens.txt"))) {
    const archive = join(CACHE, `${PARAKEET_MODEL}.tar.bz2`);
    await download(PARAKEET_URL, archive, "Parakeet model", progress);
    progress?.("Unpacking the Parakeet model", null);
    try { await untarBz2(archive, MODELS); } finally { await rm(archive, { force: true }); }
  }
}

/** Kokoro's model files (~350 MB) into MODELS, and uv (astral.sh's installer, into ~/.local/bin) if it's missing. */
export async function installKokoro(progress?: Progress): Promise<void> {
  if (!VoiceModels.binary("uv")) {
    progress?.("Installing uv", null);
    // astral.sh's official installer, as on Linux; on Windows its PowerShell form (into %USERPROFILE%\.local\bin).
    const r = WIN
      ? await sh("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"])
      : await sh("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh || wget -qO- https://astral.sh/uv/install.sh | sh"]);
    if (!r.ok || !VoiceModels.binary("uv")) throw new Error(`Installing uv failed: ${r.out.split("\n").slice(-2).join(" ")}`);
  }
  for (const [name, url] of KOKORO_FILES) {
    if (!VoiceModels.find(name)) await download(url, join(MODELS, name), "Kokoro voices", progress);
  }
}
