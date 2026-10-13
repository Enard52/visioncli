import assert from "node:assert/strict";
import { test } from "node:test";
import { WinAudioDevices, WinRecorder } from "../../src/main/audio/win32";
import {
  SHERPA_VERSION, VC_RUNTIME, sherpaUrl, sherpaWinFiles, tarBin, whisperAssetName, whisperFilesToKeep,
} from "../../src/main/stt/install";
import { exeNames, isHelperImage } from "../../src/main/stt/models";
import { WinVoice, englishFirst, sapiRate } from "../../src/main/tts/win32";
import { fakeHelper, tick } from "./fake";

// ── audio ──

test("WinRecorder: record.start with the device, level events forwarded only while recording, stop returns the WAV", async () => {
  const h = fakeHelper({ "record.start": () => true, "record.stop": () => ({ file: "C:\\t\\a.wav", seconds: 2.5 }), "record.snapshot": () => true, "record.cancel": () => true });
  const rec = new WinRecorder(h);
  const levels: number[] = [];
  h.emit("level", { level: 0.9 }); // before start: dropped
  await rec.start("C:\\t\\a.wav", "{mic-1}", (l) => levels.push(l));
  h.emit("level", { level: 0.25 });
  h.emit("level", { level: 0.5 });
  assert.equal(await rec.snapshot("C:\\t\\s.wav"), true);
  assert.deepEqual(await rec.stop(), { file: "C:\\t\\a.wav", seconds: 2.5 });
  h.emit("level", { level: 0.7 }); // after stop: dropped
  assert.deepEqual(levels, [0.25, 0.5]);
  assert.deepEqual(h.of("record.start"), [{ file: "C:\\t\\a.wav", device: "{mic-1}" }]);
  assert.deepEqual(h.of("record.snapshot"), [{ file: "C:\\t\\s.wav" }]);
  assert.equal(await rec.snapshot("x.wav"), false); // nothing recording
});

test("WinRecorder: a missing microphone falls back to the default; no microphone at all is an error", async () => {
  const h = fakeHelper({ "record.start": (p) => { if (p.device) throw new Error("no such device"); return true; }, "record.cancel": () => true });
  const rec = new WinRecorder(h);
  await rec.start("a.wav", "gone");
  assert.deepEqual(h.of("record.start").map((p) => p.device), ["gone", null]);
  rec.cancel();
  await tick();
  assert.equal(h.of("record.cancel").length, 1);
  rec.cancel(); // not recording: nothing sent
  await tick();
  assert.equal(h.of("record.cancel").length, 1);
  const none = new WinRecorder(fakeHelper({ "record.start": () => { throw new Error("no device"); } }));
  await assert.rejects(none.start("a.wav", null), /Couldn't open the microphone \(no device\)/);
});

test("WinAudioDevices: inputs/outputs from audioDevices ([] when the helper fails)", async () => {
  const lists = { inputs: [{ id: "i1", name: "Mic", isDefault: true }], outputs: [{ id: "o1", name: "Speakers", isDefault: true }] };
  const d = new WinAudioDevices(fakeHelper({ audioDevices: () => lists }));
  assert.deepEqual(await d.inputs(), lists.inputs);
  assert.deepEqual(await d.outputs(), lists.outputs);
  assert.deepEqual(await new WinAudioDevices(fakeHelper({})).inputs(), []);
});

test("WinAudioDevices.play: waits for play; abort sends play.stop with the same token; a gone speaker → default", async () => {
  let finish: (() => void) | null = null;
  const h = fakeHelper({
    play: (p) => new Promise<true>((res, rej) => { if (p.device === "gone") rej(new Error("bad device")); else finish = () => res(true); }),
    "play.stop": () => { finish?.(); return true; },
  });
  const d = new WinAudioDevices(h);
  const ctl = new AbortController();
  const done = d.play("C:\\t\\s.wav", "gone", ctl.signal);
  await tick(5);
  assert.deepEqual(h.of("play").map((p) => p.device), ["gone", null]);
  ctl.abort();
  await done;
  const [, second] = h.of("play");
  assert.deepEqual(h.of("play.stop"), [{ token: second.token }]);
  assert.match(second.token, /^[0-9a-f]{12}$/);
  // Already aborted: nothing played.
  const pre = new AbortController(); pre.abort();
  await d.play("x.wav", null, pre.signal);
  assert.equal(h.of("play").length, 2);
});

// ── system voice ──

test("sapiRate: speed 1 is SAPI 0; faster/slower map on SAPI's ×3-per-10 scale, clamped", () => {
  assert.equal(sapiRate(1), 0);
  assert.equal(sapiRate(1.5), 2);   // factor 1.2
  assert.equal(sapiRate(2), 3);     // factor 1.4
  assert.equal(sapiRate(0.5), -2);  // factor 0.8
  assert.equal(sapiRate(-5), -6);   // factor floor 0.5
  assert.equal(sapiRate(100), 10);
});

test("englishFirst / WinVoice: English voices first; render via speak, unknown voice → default voice", async () => {
  assert.deepEqual(englishFirst(["Microsoft Hedda Desktop - German", "Microsoft Zira Desktop - English (United States)", "Microsoft David Desktop - English (United States)"]),
    ["Microsoft Zira Desktop - English (United States)", "Microsoft David Desktop - English (United States)", "Microsoft Hedda Desktop - German"]);
  const h = fakeHelper({
    voices: () => ["Microsoft Hedda Desktop - German", "Microsoft Zira Desktop - English (United States)"],
    speak: (p) => { if (p.voice === "Nope") throw new Error("voice not installed"); return true; },
  });
  const v = new WinVoice(h);
  assert.deepEqual(await v.voices(), ["Microsoft Zira Desktop - English (United States)", "Microsoft Hedda Desktop - German"]);
  assert.deepEqual(v.cached, await v.voices());
  assert.equal(await v.render("Hello.", "C:\\t\\o.wav", 2, "Microsoft Zira Desktop - English (United States)"), "C:\\t\\o.wav");
  assert.deepEqual(h.of("speak")[0], { text: "Hello.", voice: "Microsoft Zira Desktop - English (United States)", rate: 3, file: "C:\\t\\o.wav" });
  assert.equal(await v.render("Hi", "o.wav", 1, "Nope"), "o.wav");
  assert.deepEqual(h.of("speak").slice(1).map((p) => p.voice), ["Nope", null]);
  assert.equal(await new WinVoice(fakeHelper({})).render("Hi", "o.wav", 1, null), null);
  assert.deepEqual(await new WinVoice(fakeHelper({})).voices(), []);
});

// ── speech-to-text binaries ──

test("whisperAssetName: the CPU builds whisper.cpp publishes per system", () => {
  assert.equal(whisperAssetName("x64", "win32"), "whisper-bin-x64.zip");
  assert.equal(whisperAssetName("arm64", "win32"), "whisper-bin-win-cpu-arm64.zip");
  assert.equal(whisperAssetName("x64", "linux"), "whisper-bin-ubuntu-x64.tar.gz");
  assert.equal(whisperAssetName("arm64", "linux"), "whisper-bin-ubuntu-arm64.tar.gz");
});

test("sherpaUrl: Windows gets the static-CRT shared build without TTS; Linux unchanged", () => {
  const base = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-`;
  assert.equal(sherpaUrl("x64", "win32"), `${base}win-x64-shared-MT-Release-no-tts.tar.bz2`);
  assert.equal(sherpaUrl("arm64", "win32"), `${base}win-arm64-shared-MT-Release-no-tts.tar.bz2`);
  assert.equal(sherpaUrl("x64", "linux"), `${base}linux-x64-shared.tar.bz2`);
  assert.equal(sherpaUrl("arm64", "linux"), `${base}linux-aarch64-shared-cpu.tar.bz2`);
});

test("whisperFilesToKeep / sherpaWinFiles: the server and its DLLs, not the other tools (real archive listings)", () => {
  const winZip = ["bench.exe", "ggml-base.dll", "ggml-cpu-haswell.dll", "ggml-cpu-x64.dll", "ggml.dll", "llama.dll", "main.exe", "SDL2.dll",
    "whisper-cli.exe", "whisper-server.exe", "whisper.dll", "libomp140.aarch64.dll", "parakeet.dll"];
  assert.deepEqual(whisperFilesToKeep(winZip, "win32"),
    ["ggml-base.dll", "ggml-cpu-haswell.dll", "ggml-cpu-x64.dll", "ggml.dll", "llama.dll", "whisper-server.exe", "whisper.dll", "libomp140.aarch64.dll", "parakeet.dll"]);
  assert.deepEqual(whisperFilesToKeep(["whisper-server", "whisper-cli", "libwhisper.so.1", "libggml.so", "README"], "linux"),
    ["whisper-server", "libwhisper.so.1", "libggml.so"]);
  assert.deepEqual(sherpaWinFiles(["onnxruntime.dll", "onnxruntime_providers_shared.dll", "sherpa-onnx-offline-websocket-server.exe",
    "sherpa-onnx-online-websocket-client.exe", "sherpa-onnx-online-websocket-server.exe"]),
  ["onnxruntime.dll", "onnxruntime_providers_shared.dll", "sherpa-onnx-offline-websocket-server.exe"]);
  assert.deepEqual(VC_RUNTIME, ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);
});

test("tarBin: System32's bsdtar on Windows (not Git's tar), plain tar elsewhere", () => {
  assert.equal(tarBin("win32", { SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\tar.exe");
  assert.equal(tarBin("win32", {}), "C:\\Windows\\System32\\tar.exe");
  assert.equal(tarBin("linux", {}), "tar");
});

test("exeNames / isHelperImage: .exe on Windows; only our helpers' tasklist rows count as strays", () => {
  assert.deepEqual(exeNames("whisper-server", "win32"), ["whisper-server.exe"]);
  assert.deepEqual(exeNames("code.cmd", "win32"), ["code.cmd"]);
  assert.deepEqual(exeNames("whisper-server", "linux"), ["whisper-server"]);
  assert.equal(isHelperImage('"whisper-server.exe","1234","Console","1","120,000 K"\r\n'), true);
  assert.equal(isHelperImage('"sherpa-onnx-offline-websocket-server.exe","9","Console","1","1 K"'), true);
  assert.equal(isHelperImage('"uv.exe","9","Console","1","1 K"'), true);
  assert.equal(isHelperImage('"chrome.exe","1234","Console","1","1 K"'), false);
  assert.equal(isHelperImage("INFO: No tasks are running which match the specified criteria."), false);
});
