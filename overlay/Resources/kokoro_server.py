"""Long-lived Kokoro TTS worker for the visioncli overlay.

Reads JSON lines {"id", "text", "voice", "speed"} on stdin and answers {"id", "path"} (a WAV file)
or {"id", "error"} on stdout. Prints {"ready": true} once the model is loaded.
Run: uv run --with kokoro-onnx --with soundfile python kokoro_server.py MODEL VOICES OUT_DIR
"""
import json
import os
import re
import sys

import kokoro_onnx
import soundfile as sf

model_path, voices_path, out_dir = sys.argv[1:4]
model = kokoro_onnx.Kokoro(model_path, voices_path)
voices = set(model.get_voices())
print(json.dumps({"ready": True}), flush=True)


def synth(text, voice, speed):
    try:
        return model.create(text, voice=voice, speed=speed)
    except IndexError as e:  # phoneme overflow on long input: split and retry
        if not re.search(r"out of bounds", str(e)) or len(text) < 2:
            raise
        mid = len(text) // 2
        cut = text.rfind(" ", 0, mid) + 1 or mid
        a, rate = synth(text[:cut], voice, speed)
        b, _ = synth(text[cut:], voice, speed)
        return list(a) + list(b), rate


for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid = req.get("id")
    try:
        voice = req.get("voice") if req.get("voice") in voices else "af_heart"
        samples, rate = synth(req["text"], voice, float(req.get("speed", 1.0)))
        path = os.path.join(out_dir, f"tts-{os.getpid()}-{rid}.wav")
        sf.write(path, samples, rate)
        print(json.dumps({"id": rid, "path": path}), flush=True)
    except Exception as e:  # keep serving
        print(json.dumps({"id": rid, "error": str(e)}), flush=True)
