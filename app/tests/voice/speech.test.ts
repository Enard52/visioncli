import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, it, test } from "node:test";
import { kokoroUvArgs } from "../../src/main/tts/kokoro";
import { sherpaRequest, sherpaText } from "../../src/main/stt/parakeet";
import { termParts, applyVocabulary } from "../../src/main/stt/vocab";
import { whisperPrompt, whisperText } from "../../src/main/stt/whisper";
import { decodeFrames, encodeFrame, wsRequest } from "../../src/main/stt/ws";
import { speakCut, isKokoroVoice } from "../../src/main/tts/index";
import { parseEspeakVoices, parseSpdVoices, rates } from "../../src/main/tts/system";

describe("whisper", () => {
  it("cleans the transcript like macOS", () => {
    assert.equal(whisperText(JSON.stringify({ text: " Open the La\nravel controller.\n" })), "Open the Laravel controller.");
    assert.equal(whisperText(JSON.stringify({ text: " [BLANK_AUDIO]" })), "");
    assert.equal(whisperText(JSON.stringify({ text: "(wind blowing)" })), "");
    assert.equal(whisperText("not json"), null);
  });
  it("builds the vocabulary prompt", () => {
    assert.equal(whisperPrompt(["VisionCLI", "Laravel"]), "Vocabulary: VisionCLI, Laravel.");
    assert.equal(whisperPrompt([]), "");
  });
});

describe("parakeet", () => {
  it("encodes sherpa-onnx's request", () => {
    const b = sherpaRequest(new Float32Array([0.5, -1]), 16000);
    assert.equal(b.readInt32LE(0), 16000);
    assert.equal(b.readInt32LE(4), 8);
    assert.equal(b.readFloatLE(8), 0.5);
    assert.equal(b.readFloatLE(12), -1);
  });
  it("reads JSON or plain replies", () => {
    assert.equal(sherpaText('{"text": " hello world", "tokens": []}'), "hello world");
    assert.equal(sherpaText(" hello "), "hello");
  });
  it("spells the vocabulary as given", () => {
    assert.deepEqual(termParts("TypeScript"), ["Type", "Script"]);
    assert.deepEqual(termParts("VisionCLI"), ["Vision", "CLI"]);
    assert.deepEqual(termParts("Next.js"), ["Next", "js"]);
    const v = ["VisionCLI", "TypeScript", "Next.js", "kubectl", "PaymentController"];
    assert.equal(applyVocabulary("open vision cli and the typescript file", v), "open VisionCLI and the TypeScript file");
    assert.equal(applyVocabulary("Type script with next js and Kubectl", v), "TypeScript with Next.js and kubectl");
    assert.equal(applyVocabulary("the payment controller", v), "the PaymentController");
    assert.equal(applyVocabulary("prototypescript stays", v), "prototypescript stays");
  });
});

describe("websocket client", () => {
  it("frames round-trip (masked out, unmasked in)", () => {
    const payload = Buffer.alloc(70000, 7);
    const f = encodeFrame(2, payload, Buffer.from([1, 2, 3, 4]));
    const { frames, rest } = decodeFrames(f);
    assert.equal(rest.length, 0);
    assert.equal(frames[0].opcode, 2);
    assert.deepEqual(frames[0].payload, payload);
    const partial = decodeFrames(f.subarray(0, 100));
    assert.equal(partial.frames.length, 0);
  });

  it("talks to a sherpa-like server", async () => {
    // A tiny WebSocket server: answers the binary request with the sample count as JSON text.
    const server = createServer((sock) => {
      let buf = Buffer.alloc(0), up = false;
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (!up) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const key = /Sec-WebSocket-Key: (.*)\r\n/.exec(buf.toString())![1];
          const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          buf = buf.subarray(end + 4);
          up = true;
        }
        const { frames, rest } = decodeFrames(buf);
        buf = Buffer.from(rest);
        for (const fr of frames) {
          if (fr.opcode === 2) {
            const reply = Buffer.from(JSON.stringify({ text: `got ${fr.payload.readInt32LE(4) / 4} samples at ${fr.payload.readInt32LE(0)}` }));
            sock.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
          }
          if (fr.opcode === 8) sock.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const reply = await wsRequest(port, sherpaRequest(new Float32Array(48000), 16000), 3000);
    assert.equal(sherpaText(reply), "got 48000 samples at 16000");
    server.close();
  });
});

describe("speaker", () => {
  it("cuts at the last sentence boundary while streaming", () => {
    assert.equal(speakCut("Hello there. How are", 0, false), "Hello there. ".length);
    assert.equal(speakCut("No boundary yet", 0, false), -1);
    assert.equal(speakCut("Line one\nline", 0, false), "Line one\n".length);
    assert.equal(speakCut("Ends here.", 0, false), "Ends here.".length);
    assert.equal(speakCut("Anything", 3, true), 8);
    assert.equal(speakCut("Version 1.2 is out", 0, false), -1); // "1.2" isn't a sentence end
    assert.equal(speakCut("Done. More", 6, false), -1);
  });
  it("doesn't cut inside a code block that is still streaming", () => {
    const t = "The bug is here. ```js\nconst x = 1;\n";
    assert.equal(speakCut(t, 0, false), t.indexOf("```"));
    assert.equal(speakCut(t, t.indexOf("```"), false), -1);
    const closed = t + "```\nIt retries. Then";
    assert.equal(speakCut(closed, t.indexOf("```"), false), closed.indexOf("Then"));
  });
  it("tells Kokoro voices from system ones", () => {
    assert.ok(isKokoroVoice("af_heart"));
    assert.ok(isKokoroVoice("bm_lewis"));
    assert.ok(!isKokoroVoice("English (America)+Adam"));
  });
  it("maps the speed setting to each tool", () => {
    assert.deepEqual(rates(1), { spd: 0, espeakWpm: 175, piperLengthScale: 1 });
    assert.deepEqual(rates(2), { spd: 40, espeakWpm: 245, piperLengthScale: 0.71 });
  });
  it("parses voice lists", () => {
    const spd = "                     NAME                 LANGUAGE                  VARIANT\n                Afrikaans                       af                     none\n   English (America)+Adam                    en-US                     Adam\n";
    assert.deepEqual(parseSpdVoices(spd), [{ name: "Afrikaans", lang: "af" }, { name: "English (America)+Adam", lang: "en-US" }]);
    const esp = "Pty Language       Age/Gender VoiceName          File                 Other Languages\n 5  af              --/M      Afrikaans          gmw/af               \n";
    assert.deepEqual(parseEspeakVoices(esp), [{ name: "Afrikaans", lang: "af" }]);
  });
});

test("Kokoro runs on x64 Python on Windows on Arm (no win_arm64 wheels for onnxruntime/soundfile)", () => {
  assert.ok(kokoroUvArgs("win32", "arm64").includes("cpython-3.12-windows-x86_64-none"));
  assert.ok(!kokoroUvArgs("win32", "x64").includes("--python"));
  assert.ok(!kokoroUvArgs("linux", "arm64").includes("--python"));
  assert.deepEqual(kokoroUvArgs("darwin", "arm64").slice(-1), ["python"]);
});
