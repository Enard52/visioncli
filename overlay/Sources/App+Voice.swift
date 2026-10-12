import AppKit

// Speech in and out: the local transcription engines, vocabulary hints, voices, audio devices.

extension AppDelegate {
    /// Terms Parakeet should spell exactly (see Vocabulary.words).
    func vocabularyWords() -> [String] {
        Vocabulary.words(project: HomeProject.label(currentProject), windowTitle: Screen.windowUnderPointer()?.title,
                         custom: try? String(contentsOf: Settings.vocabularyFile, encoding: .utf8))
    }

    /// Whisper's prompt (see Vocabulary.prompt).
    func vocabularyPrompt() -> String {
        Vocabulary.prompt(project: HomeProject.label(currentProject), windowTitle: Screen.windowUnderPointer()?.title,
                          custom: try? String(contentsOf: Settings.vocabularyFile, encoding: .utf8))
    }

    func startVoiceEngines() {
        VoiceModels.killStrays()
        let logDevices = { log("audio inputs: \(AudioDevices.inputs.map(\.name).joined(separator: ", ")) | outputs: \(AudioDevices.outputs.map(\.name).joined(separator: ", "))") }
        logDevices()
        var pending: DispatchWorkItem?
        AudioDevices.startMonitoring {
            // Devices often announce themselves in bursts; log once things settle.
            pending?.cancel()
            let work = DispatchWorkItem { logDevices() }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
        }
        kokoro = KokoroEngine(cfg: cfg)
        speaker.kokoro = kokoro
        if Settings.speak && Settings.ttsEngine == "kokoro" { kokoro.start() }
        restartWhisper()
    }

    func restartWhisper() {
        whisper?.stop()
        whisper = nil
        parakeet?.stop()
        parakeet = nil
        if Settings.sttEngine == "parakeet" {
            if ParakeetEngine.binary != nil { parakeet = ParakeetEngine(); parakeet?.start(); return }
            log("parakeet helper missing; using Whisper")
        }
        guard Settings.sttEngine == "whisper" || Settings.sttEngine == "parakeet" else { return }
        whisper = WhisperEngine(cfg: cfg, model: Settings.whisperModel)
        if whisper == nil { log("whisper unavailable: install whisper-cpp and a ggml model; using Apple speech recognition") }
        whisper?.start()
    }

    /// VisionCLI's own microphone or speaker (CoreAudio UID); nil = follow the Mac's default. A new speaker plays a test.
    func setAudioDevice(input: Bool, uid: String?) {
        if input { Settings.inputDeviceUID = uid } else { Settings.outputDeviceUID = uid }
        log("\(input ? "microphone" : "speaker"): \(uid.flatMap { AudioDevices.device(uid: $0)?.name } ?? "system default")")
        if !input { testSpeaker() }
    }

    @objc func testSpeaker() {
        if Settings.ttsEngine == "kokoro" && !kokoro.isRunning { kokoro.start() }
        speaker.reset()
        speaker.feed("This is the VisionCLI speaker test.", final: true, force: true)
    }

    /// Plays a short sample at the new speed.
    func setSpeechSpeed(_ x: Double) {
        Settings.speechSpeed = x
        testSpeaker()
    }

    func setSpeak(_ on: Bool) {
        Settings.speak = on
        if !on { speaker.reset() }
        if on && Settings.ttsEngine == "kokoro" { kokoro.start() }
    }

    /// "parakeet" | "external" (Wispr Flow) | "apple" | "whisper:<model>". Restarting stops whichever engine ran before.
    func chooseSpeechEngine(_ engine: String) {
        if engine.hasPrefix("whisper:") { Settings.sttEngine = "whisper"; Settings.whisperModel = String(engine.dropFirst(8)) }
        else { Settings.sttEngine = engine }
        restartWhisper()
    }

    /// The engine actually in use, in chooseSpeechEngine's terms (Whisper falls back to Apple when it can't start).
    var currentSpeechEngine: String {
        if parakeet != nil { return "parakeet" }
        if Settings.sttEngine == "external" { return "external" }
        if Settings.sttEngine != "apple", let whisper { return "whisper:\(whisper.modelName)" }
        return "apple"
    }

    /// A Kokoro voice id, or nil for the macOS voice; plays a short preview.
    func selectVoice(_ id: String?) {
        speaker.reset()
        if let voice = id {
            Settings.ttsEngine = "kokoro"
            Settings.kokoroVoice = voice
            kokoro.start()
        } else {
            Settings.ttsEngine = "system"
            kokoro.stop()
        }
        // Preview the voice.
        speaker.feed("Hi, this is how I'll sound.", final: true, force: true)
    }

    @objc func editVocabulary() {
        if !FileManager.default.fileExists(atPath: Settings.vocabularyFile.path) {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
            try? "# Words Whisper should spell right, one per line (names, products, libraries)\nLaravel\nKubernetes\n"
                .write(to: Settings.vocabularyFile, atomically: true, encoding: .utf8)
        }
        NSWorkspace.shared.open(Settings.vocabularyFile)
    }
}
