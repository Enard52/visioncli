import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createAudioDevices } from "../audio";
import type { AudioDevices, Speaker } from "../contracts";
import { DiagramText } from "../core/markup";
import { SpokenText } from "../core/text";
import { log } from "../log";
import { TMP } from "../paths";
import { settings } from "../settings";
import { VoiceModels } from "../stt/models";
import { KokoroEngine } from "./kokoro";
import { SystemVoice } from "./system";

// Speaker (Speech.swift): reads answers aloud sentence by sentence as they stream in, with Kokoro when available
// (synthesized ahead, played in order) and the system voice otherwise. Events: "speaking" (boolean) on changes.

export { KokoroEngine } from "./kokoro";
export { SystemVoice } from "./system";

export function createSpeaker(audio: AudioDevices = createAudioDevices()): Speaker & LinuxSpeaker { return new LinuxSpeaker(audio); }

/** Something to play, in order: a rendered file, or text speech-dispatcher speaks itself. */
type Job = { file: string } | { spd: string; voice: string | null };

/**
 * Where the next spoken chunk of `text` (from `from`) ends: the last sentence boundary, or everything when final;
 * -1 = nothing to say yet. Linux addition: never inside a ``` block that hasn't closed yet. macOS cut at the newline
 * after "```js" and then read the code lines out one by one while the answer streamed.
 */
export function speakCut(text: string, from: number, final: boolean): number {
  if (final) return text.length;
  let cut = -1;
  for (const m of text.slice(from).matchAll(/[.!?](\s|$)|\n/g)) cut = from + m.index! + m[0].length;
  if (cut < 0) return -1;
  const fences = text.slice(0, cut).split("```").length - 1;
  if (fences % 2 === 1) cut = text.lastIndexOf("```", cut - 1);
  return cut > from ? cut : -1;
}

export class LinuxSpeaker extends EventEmitter implements Speaker {
  readonly kokoro = new KokoroEngine();
  private spokenUpTo = 0;
  private fed = "";               // the text the last feed saw (a new answer doesn't continue it)
  private generation = 0;
  private nextId = 0;
  private nextToPlay = 0;
  private ready = new Map<number, Job | null>();
  private playing: AbortController | null = null;
  private wasSpeaking = false;
  private renders = 0;

  constructor(private audio: AudioDevices) { super(); }

  get speaking() { return !!this.playing || this.nextToPlay < this.nextId; }

  private changed() {
    const now = this.speaking;
    if (now !== this.wasSpeaking) { this.wasSpeaking = now; this.emit("speaking", now); }
  }

  /** Starts Kokoro ahead of the first answer (the app calls this when speaking is turned on, like macOS). */
  warm() { if (settings.get("tts") === "kokoro" && KokoroEngine.available()) this.kokoro.start(); }

  /** Feed the full answer so far; speaks newly completed sentences (everything when final). */
  feed(text: string, final: boolean, force = false, voice?: string) {
    if (!settings.get("speak") && !force) return;
    const spoken = DiagramText.speakable(text);
    // A different answer than the one being spoken (the app didn't stop() in between): start over.
    if (this.spokenUpTo && !spoken.startsWith(this.fed.slice(0, this.spokenUpTo))) this.stop();
    this.fed = spoken;
    if (spoken.length <= this.spokenUpTo) return;
    const end = speakCut(spoken, this.spokenUpTo, final);
    if (end < 0) return;
    const chunk = spoken.slice(this.spokenUpTo, end);
    this.spokenUpTo = end;
    const clean = SpokenText.clean(chunk).trim();
    if (!SpokenText.speakable(clean)) return;
    const kokoroVoice = voice && isKokoroVoice(voice) ? voice : null;
    const useKokoro = (kokoroVoice || (!voice && settings.get("tts") === "kokoro")) && KokoroEngine.available();
    if (useKokoro) {
      // One request per sentence so the first one starts playing quickly.
      for (const s of SpokenText.sentences(clean)) this.enqueueKokoro(s, kokoroVoice ?? settings.get("kokoroVoice"));
    } else {
      this.enqueueSystem(clean, voice && !kokoroVoice ? voice : settings.get("voice"));
    }
  }

  say(text: string) {
    this.stop();
    this.feed(text, true, true);
  }

  preview(voice: string) {
    this.stop();
    this.feed("Hi, this is how I'll sound.", true, true, voice);
  }

  stop() {
    if (this.nextToPlay < this.nextId) log(`tts: reset with ${this.nextId - this.nextToPlay} sentences pending`);
    this.generation++;
    this.playing?.abort();
    this.playing = null;
    for (const job of this.ready.values()) if (job && "file" in job) void rm(job.file, { force: true });
    this.ready.clear();
    this.nextId = 0;
    this.nextToPlay = 0;
    this.spokenUpTo = 0;
    this.fed = "";
    this.changed();
  }

  async voices(): Promise<{ kokoro: string[]; system: string[] }> {
    return { kokoro: KokoroEngine.available() ? VoiceModels.kokoroVoiceList.map((v) => v[0]) : [], system: await SystemVoice.voicesAsync() };
  }

  private enqueue(make: () => Promise<Job | null>) {
    const id = this.nextId++, gen = this.generation;
    this.changed();
    make().then((job) => {
      if (gen !== this.generation) { log(`tts: dropped stale sentence ${id}`); if (job && "file" in job) void rm(job.file, { force: true }); return; }
      // A failed sentence is skipped: switching to the system voice mid-answer talked over Kokoro.
      this.ready.set(id, job);
      this.pump();
    });
  }

  private enqueueKokoro(text: string, voice: string) {
    // Kokoro tops out at 2×.
    const speed = Math.min(2, 1.08 * settings.get("speechSpeed"));
    this.enqueue(async () => {
      const file = await this.kokoro.synth(text, voice, speed);
      log(`tts: sentence ready (${file ? "ok" : "failed"})`);
      if (file) return { file };
      // Kokoro never came up (broken install): the system voice says it instead of silence. A sentence that fails
      // while Kokoro runs is still skipped, so two voices never talk over each other.
      return this.kokoro.ready ? null : this.systemJob(text, settings.get("voice"));
    });
  }

  private enqueueSystem(text: string, voice: string | null) {
    if (!SystemVoice.backend()) { log("tts: no system voice (install speech-dispatcher or espeak-ng)"); return; }
    this.enqueue(() => this.systemJob(text, voice));
  }

  private async systemJob(text: string, voice: string | null): Promise<Job | null> {
    const backend = SystemVoice.backend();
    if (!backend) return null;
    // speech-dispatcher can't pick a device: with a chosen speaker, render a WAV and play it there instead.
    if (backend === "spd-say" && !settings.get("outputDevice")) return { spd: text, voice };
    const out = join(TMP, `visioncli-say-${process.pid}-${++this.renders}.wav`);
    const file = await SystemVoice.render(text, out, settings.get("speechSpeed"), voice);
    return file ? { file } : null;
  }

  private pump() {
    if (this.playing) return;
    if (!this.ready.has(this.nextToPlay)) { this.changed(); return; }
    const job = this.ready.get(this.nextToPlay)!;
    this.ready.delete(this.nextToPlay);
    const index = this.nextToPlay++;
    if (!job) { this.pump(); return; }
    const ctl = new AbortController();
    this.playing = ctl;
    this.changed();
    const done = () => {
      if ("file" in job) void rm(job.file, { force: true });
      if (this.playing !== ctl) return; // stopped meanwhile
      this.playing = null;
      this.pump();
    };
    if ("file" in job) {
      log(`tts: playing sentence ${index}`);
      this.audio.play(job.file, settings.get("outputDevice"), ctl.signal).catch((e) => log(`tts: can't play: ${e}`)).finally(done);
    } else {
      SystemVoice.speak(job.spd, settings.get("speechSpeed"), job.voice, ctl.signal).finally(done);
    }
  }
}

/** Kokoro voice ids look like "af_heart", "bm_george". */
export function isKokoroVoice(v: string) {
  return VoiceModels.kokoroVoiceList.some((x) => x[0] === v) || /^[a-z][fm]_[a-z]+$/.test(v);
}
