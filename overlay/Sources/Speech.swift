import AppKit
import AudioToolbox
import AVFoundation
import Speech

/// On-device speech-to-text while the hotkey is held.
final class Listener {
    // Recreated for every question: a long-lived engine keeps a stale input format after the mic changes
    // (AirPods connect, Teams/Zoom grab the device, sample-rate switch), and installTap then aborts the app.
    private var engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer: SFSpeechRecognizer?
    private var latest = ""
    private var finish: ((String) -> Void)?
    let recorder = WavRecorder()

    var onText: (String) -> Void = { _ in }
    var onLevel: (CGFloat) -> Void = { _ in }

    init(locale: String?) {
        if let locale { recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) }
        else { recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) }
    }

    func start() throws {
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "visioncli", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech recognition isn't available"])
        }
        cancel()
        latest = ""
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req

        // A specific mic picked in the menu is captured input-only (AVCaptureSession). AVAudioEngine drives input
        // and output as one unit, so it can't use e.g. the built-in mic, which is a separate device from the speakers.
        if let uid = Settings.inputDeviceUID, let device = AudioDevices.device(uid: uid) {
            if let mic = CaptureMic(uid: uid) {
                recorder.begin()
                mic.onBuffer = handler(for: req)
                if mic.start() {
                    capture = mic
                    log("listener: capturing from \(device.name)")
                } else {
                    _ = recorder.finish()
                    log("listener: \(device.name) didn't start; using the system default mic")
                }
            } else {
                log("listener: can't open \(device.name); using the system default mic")
            }
        }
        if capture == nil { try startEngine(req: req) }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                // The final result after endAudio() is sometimes empty; never let it wipe what we heard.
                if let text = result?.bestTranscription.formattedString, !text.isEmpty {
                    self.latest = text
                    self.onText(text)
                }
                if result?.isFinal == true || error != nil { self.complete() }
            }
        }
    }

    private var capture: CaptureMic?

    /// What to do with each microphone buffer: feed speech recognition, the WAV for Whisper, and the level meter.
    private func handler(for req: SFSpeechAudioBufferRecognitionRequest) -> (AVAudioPCMBuffer) -> Void {
        let recorder = self.recorder
        return { [weak self] buf in
            req.append(buf)
            recorder.append(buf)
            guard let ch = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
            var sum: Float = 0
            for i in 0..<Int(buf.frameLength) { sum += ch[i] * ch[i] }
            let level = CGFloat(min(1, sqrt(sum / Float(buf.frameLength)) * 12))
            DispatchQueue.main.async { self?.onLevel(level) }
        }
    }

    /// The system default mic through AVAudioEngine.
    private func startEngine(req: SFSpeechAudioBufferRecognitionRequest) throws {
        if engine.isRunning { engine.stop() }
        engine = AVAudioEngine()
        let input = engine.inputNode
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
            log("listener: no usable input (\(hardware))")
            throw NSError(domain: "visioncli", code: 2, userInfo: [NSLocalizedDescriptionKey:
                "No microphone input right now (the audio device may be switching, or another app is using it). Try again in a moment"])
        }
        recorder.begin()
        let onBuffer = handler(for: req)
        // format: nil = the node's own output format; an explicit format that disagrees with it aborts the app.
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in onBuffer(buf) }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            _ = recorder.finish()
            throw error
        }
    }

    /// Stop recording and hand back the final transcript (or whatever we have after a short grace period).
    func stop(_ done: @escaping (String) -> Void) {
        finish = done
        stopAudio()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.complete() }
    }

    func cancel() {
        finish = nil
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    private func stopAudio() {
        capture?.stop()
        capture = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        recordingURL = recorder.finish()
    }

    /// The WAV of the last question (for Whisper), available after stop().
    private(set) var recordingURL: URL?

    private func complete() {
        guard let done = finish else { return }
        finish = nil
        task?.cancel()
        task = nil
        done(latest.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// Input-only capture from one specific microphone, delivered as PCM buffers.
final class CaptureMic: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "visioncli.mic")
    var onBuffer: (AVAudioPCMBuffer) -> Void = { _ in }

    init?(uid: String) {
        guard let device = AVCaptureDevice(uniqueID: uid), let input = try? AVCaptureDeviceInput(device: device) else { return nil }
        super.init()
        guard session.canAddInput(input), session.canAddOutput(output) else { return nil }
        session.addInput(input)
        // Float32, non-interleaved: the layout speech recognition and the level meter expect.
        output.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32,
                                AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: true]
        session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: queue)
    }

    func start() -> Bool {
        session.startRunning()
        return session.isRunning
    }

    func stop() {
        output.setSampleBufferDelegate(nil, queue: nil)
        session.stopRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let desc = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        pcm.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr else { return }
        onBuffer(pcm)
    }
}

/// Reads answers aloud sentence by sentence as they stream in, with Kokoro when available
/// (synthesized ahead, played in order) and the system voice otherwise.
final class Speaker: NSObject, AVAudioPlayerDelegate {
    private let synth = AVSpeechSynthesizer()
    var kokoro: KokoroEngine?
    private var spokenUpTo = 0
    private var generation = 0
    private var nextId = 0
    private var nextToPlay = 0
    private var ready: [Int: URL?] = [:]
    private var player: AVAudioPlayer?

    func reset() {
        if nextToPlay < nextId { log("tts: reset with \(nextId - nextToPlay) sentences pending") }
        generation += 1
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        ready = [:]
        nextId = 0
        nextToPlay = 0
        spokenUpTo = 0
    }

    var isSpeaking: Bool { synth.isSpeaking || player?.isPlaying == true || nextToPlay < nextId }

    /// Feed the full display text so far; speaks any newly completed sentences (or everything when final).
    func feed(_ text: String, final: Bool, force: Bool = false) {
        guard Settings.speak || force, text.count > spokenUpTo else { return }
        let rest = String(text.dropFirst(spokenUpTo))
        var cut = rest.endIndex
        if !final {
            // Speak up to the last sentence boundary only.
            guard let r = rest.range(of: #"[.!?](\s|$)|\n"#, options: [.regularExpression, .backwards]) else { return }
            cut = r.upperBound
        }
        let chunk = String(rest[..<cut])
        spokenUpTo += chunk.count
        let spoken = Speaker.clean(chunk).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        if Settings.ttsEngine == "kokoro", let kokoro {
            // One request per sentence so the first one starts playing quickly.
            for sentence in Speaker.sentences(spoken) { enqueueKokoro(sentence, kokoro) }
        } else {
            speakSystem(spoken)
        }
    }

    private func enqueueKokoro(_ text: String, _ kokoro: KokoroEngine) {
        let id = nextId, gen = generation
        nextId += 1
        // Kokoro tops out at 2×.
        kokoro.synth(text, voice: Settings.kokoroVoice, speed: min(2.0, 1.08 * Settings.speechSpeed)) { [weak self] url in
            guard let self else { return }
            guard gen == self.generation else { log("tts: dropped stale sentence \(id)"); return }
            log("tts: sentence \(id) ready (\(url == nil ? "failed" : "ok"))")
            if url == nil { self.speakSystem(text) } // keep talking even if a sentence failed
            self.ready[id] = .some(url)
            self.pump()
        }
    }

    private func pump() {
        guard player?.isPlaying != true, let entry = ready.removeValue(forKey: nextToPlay) else { return }
        nextToPlay += 1
        guard let url = entry else { pump(); return }
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            // The speaker picked in the menu (app-only), if it's still connected.
            if let uid = Settings.outputDeviceUID, AudioDevices.device(uid: uid) != nil { p.currentDevice = uid }
            player = p
            p.delegate = self
            let ok = p.play()
            log("tts: playing sentence \(nextToPlay - 1) (\(String(format: "%.1f", p.duration))s) started=\(ok)")
        } catch {
            log("tts: can't play \(url.lastPathComponent): \(error)")
            pump()
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        try? FileManager.default.removeItem(at: player.url!)
        DispatchQueue.main.async { self.pump() }
    }

    private func speakSystem(_ text: String) {
        if let uid = Settings.outputDeviceUID, AudioDevices.device(uid: uid) != nil {
            // AVSpeechSynthesizer can't pick a device, so render to a file and play it through the queue.
            let id = nextId, gen = generation
            nextId += 1
            renderSystem(text) { [weak self] url in
                guard let self, gen == self.generation else { return }
                self.ready[id] = .some(url)
                self.pump()
            }
            return
        }
        synth.speak(utterance(text))
    }

    private let renderer = AVSpeechSynthesizer()

    private func renderSystem(_ text: String, _ done: @escaping (URL?) -> Void) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("visioncli-say-\(UUID().uuidString).caf")
        var file: AVAudioFile?
        var finished = false
        renderer.write(utterance(text)) { buffer in
            guard !finished else { return }
            guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                finished = true
                file = nil // closes the file
                DispatchQueue.main.async { done(FileManager.default.fileExists(atPath: url.path) ? url : nil) }
                return
            }
            if file == nil { file = try? AVAudioFile(forWriting: url, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved) }
            try? file?.write(from: pcm)
        }
    }

    private func utterance(_ text: String) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text)
        u.rate = Float(min(Double(AVSpeechUtteranceMaximumSpeechRate), 0.52 + (Settings.speechSpeed - 1) * 0.2))
        if let name = Settings.voiceName, let v = AVSpeechSynthesisVoice(identifier: name) { u.voice = v }
        else { u.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier.hasPrefix("en") ? Locale.current.identifier.replacingOccurrences(of: "_", with: "-") : "en-US") }
        return u
    }

    static func sentences(_ text: String) -> [String] {
        var out: [String] = []
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { sub, _, _, _ in
            if let s = sub?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { out.append(s) }
        }
        return out.isEmpty ? [text] : out
    }

    /// Make text pleasant to hear: "app/Models/Payment.php:42" → "Payment.php, line 42"; drop markdown.
    static func clean(_ s: String) -> String {
        var t = s.replacingOccurrences(of: #"(?:[\w.@-]+/)*([\w.@-]+\.\w+):(\d+)(?:-\d+)?"#, with: "$1, line $2", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        for mark in ["**", "__", "`", "#"] { t = t.replacingOccurrences(of: mark, with: "") }
        return t
    }
}
