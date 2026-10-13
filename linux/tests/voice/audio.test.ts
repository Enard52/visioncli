import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { captureCommands, parseAlsaList, parsePactlJson, parsePactlText, playCommands } from "../../src/main/audio/index";
import { level, readWav, streamHeaderLength, wavFile, wavHeader } from "../../src/main/audio/wav";

describe("wav", () => {
  it("writes a 16 kHz mono s16 header and reads it back", () => {
    const pcm = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i % 2 ? 16384 : -16384, i * 2);
    const dir = mkdtempSync(join(tmpdir(), "vcli-wav-"));
    writeFileSync(join(dir, "a.wav"), wavFile(pcm));
    const { samples, rate } = readWav(join(dir, "a.wav"));
    assert.equal(rate, 16000);
    assert.equal(samples.length, 1600);
    assert.equal(samples[1], 0.5);
    const h = wavHeader(3200);
    assert.equal(h.readUInt32LE(4), 3236);
    assert.equal(h.readUInt32LE(28), 32000);
  });

  it("meters like macOS (RMS × 12, capped at 1)", () => {
    assert.equal(level(Buffer.alloc(100)), 0);
    const quiet = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) quiet.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);
    assert.ok(Math.abs(level(quiet) - (1000 / 32768) * 12) < 1e-6);
    const loud = Buffer.alloc(200, 0x7f);
    assert.equal(level(loud), 1);
  });

  it("finds the PCM after a WAV header in a capture stream, or none in a raw one", () => {
    assert.equal(streamHeaderLength(Buffer.from("RI")), -1);
    assert.equal(streamHeaderLength(Buffer.from([1, 2, 3, 4, 5])), 0);
    assert.equal(streamHeaderLength(wavHeader(0xffffffff - 36)), 44);
    // A LIST chunk before data (libsndfile writes some).
    const list = Buffer.concat([wavHeader(0).subarray(0, 36), Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO"), Buffer.from("data"), Buffer.alloc(4)]);
    assert.equal(streamHeaderLength(list), 56);
  });
});

describe("devices", () => {
  it("parses pactl JSON, dropping monitors from inputs", () => {
    const json = JSON.stringify([
      { name: "alsa_input.pci-0000_00_1f.3.analog-stereo", description: "Built-in Audio Analog Stereo", monitor_of_sink: "n/a", properties: { "device.class": "sound" } },
      { name: "alsa_output.pci.monitor", description: "Monitor of Built-in Audio", monitor_of_sink: "alsa_output.pci", properties: { "device.class": "monitor" } },
      { name: "bluez_input.AA", description: "AirPods", properties: {} },
    ]);
    assert.deepEqual(parsePactlJson(json, "sources", "bluez_input.AA"), [
      { id: "alsa_input.pci-0000_00_1f.3.analog-stereo", name: "Built-in Audio Analog Stereo", isDefault: false },
      { id: "bluez_input.AA", name: "AirPods", isDefault: true },
    ]);
  });

  it("parses pactl's text listing", () => {
    const text = `Source #0
\tState: SUSPENDED
\tName: auto_null.monitor
\tDescription: Monitor of Dummy Output
\tMonitor of Sink: auto_null
Source #1
\tState: RUNNING
\tName: alsa_input.usb-mic
\tDescription: USB Microphone
\tMonitor of Sink: n/a
`;
    assert.deepEqual(parsePactlText(text, "sources", "alsa_input.usb-mic"), [{ id: "alsa_input.usb-mic", name: "USB Microphone", isDefault: true }]);
    assert.equal(parsePactlText(text, "sinks", null).length, 2);
  });

  it("parses arecord -L", () => {
    const text = "null\n    Discard all samples\ndefault\n    Default ALSA Output\nhw:CARD=PCH,DEV=0\n    HDA Intel PCH, ALC3246 Analog\n    Direct hardware device\n";
    assert.deepEqual(parseAlsaList(text), [
      { id: "default", name: "Default", isDefault: true },
      { id: "hw:CARD=PCH,DEV=0", name: "HDA Intel PCH, ALC3246 Analog", isDefault: false },
    ]);
  });

  it("tries pw-record, parecord, arecord with the device, then the default", () => {
    const all = () => true;
    const cmds = captureCommands("mic1", all, () => true);
    assert.deepEqual(cmds.map((c) => c.cmd), ["pw-record", "parecord", "pw-record", "parecord", "arecord"]);
    assert.ok(cmds[0].args.includes("--raw") && cmds[0].args.includes("mic1"));
    assert.ok(cmds[1].args.includes("--device=mic1"));
    assert.ok(!cmds[4].args.includes("-D"));
    // Without pw-record --raw, PipeWire comes last (its stream gets a WAV header stripped).
    assert.deepEqual(captureCommands(null, all, () => false).map((c) => c.cmd), ["parecord", "arecord", "pw-record"]);
    assert.deepEqual(captureCommands(null, (b) => b === "arecord").map((c) => c.cmd), ["arecord"]);
  });

  it("plays on the picked device, or the default when no player can", () => {
    assert.deepEqual(playCommands("/t/a.wav", "sink1", () => true).map((c) => [c.cmd, ...c.args]), [
      ["pw-play", "--target", "sink1", "/t/a.wav"], ["paplay", "--device=sink1", "/t/a.wav"],
    ]);
    assert.deepEqual(playCommands("/t/a.wav", "sink1", (b) => b === "aplay").map((c) => c.args), [["-q", "/t/a.wav"]]);
  });
});
