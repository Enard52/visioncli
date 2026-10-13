import { readFileSync } from "node:fs";

// 16 kHz mono 16-bit PCM WAV, the format whisper.cpp and sherpa-onnx want (WavRecorder's outFormat).

export const RATE = 16000;

export function wavHeader(dataBytes: number, rate = RATE, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);              // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function wavFile(pcm: Buffer, rate = RATE): Buffer { return Buffer.concat([wavHeader(pcm.length, rate), pcm]); }

/** 0…1 like the macOS meter: RMS × 12 of samples in −1…1. */
export function level(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = pcm.readInt16LE(i * 2) / 32768; sum += s * s; }
  return Math.min(1, Math.sqrt(sum / n) * 12);
}

/**
 * Strips a WAV header from the start of a capture stream (some recorders write one even to a pipe, with bogus sizes).
 * Returns the header length once known, 0 for a raw stream, or -1 while more bytes are needed.
 */
export function streamHeaderLength(head: Buffer): number {
  if (head.length < 4) return -1;
  if (head.toString("latin1", 0, 4) !== "RIFF") return 0;
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.toString("latin1", off, off + 4);
    if (id === "data") return off + 8;
    off += 8 + head.readUInt32LE(off + 4);
  }
  return head.length > 4096 ? 0 : -1;
}

/** Reads a 16-bit PCM WAV as float samples (mono: channels averaged). */
export function readWav(file: string): { samples: Float32Array; rate: number } {
  const b = readFileSync(file);
  let off = 12, rate = RATE, channels = 1, bits = 16;
  let data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("latin1", off, off + 4);
    let size = b.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === "data") { if (off + 8 + size > b.length || size === 0) size = b.length - off - 8; data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) return { samples: new Float32Array(0), rate };
  const frames = Math.floor(data.length / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2);
    out[i] = s / channels / 32768;
  }
  return { samples: out, rate };
}
