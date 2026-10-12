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

    @objc func chooseDevice(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any], let input = info["input"] as? Bool else { return }
        let uid = info["uid"] as? String
        if input { Settings.inputDeviceUID = uid } else { Settings.outputDeviceUID = uid }
        log("\(input ? "microphone" : "speaker"): \(sender.title)")
        if !input { testSpeaker() }
    }

    @objc func testSpeaker() {
        if Settings.ttsEngine == "kokoro" && !kokoro.isRunning { kokoro.start() }
        speaker.reset()
        speaker.feed("This is the VisionCLI speaker test.", final: true, force: true)
    }

    @objc func installWhisper() { installer.installWhisper() }

    @objc func installKokoro() { installer.installKokoro() }

    @objc func chooseSpeed(_ sender: NSMenuItem) {
        guard let x = sender.representedObject as? Double else { return }
        Settings.speechSpeed = x
        testSpeaker()
    }

    @objc func toggleSpeakSetting() {
        Settings.speak.toggle()
        if !Settings.speak { speaker.reset() }
        if Settings.speak && Settings.ttsEngine == "kokoro" { kokoro.start() }
    }

    @objc func chooseExternalDictation() {
        Settings.sttEngine = "external"
        restartWhisper() // stops the local engines; the box needs none
    }

    @objc func chooseParakeet() {
        Settings.sttEngine = "parakeet"
        restartWhisper()
    }

    @objc func chooseWhisper(_ sender: NSMenuItem) {
        if let model = sender.representedObject as? String { Settings.sttEngine = "whisper"; Settings.whisperModel = model }
        else { Settings.sttEngine = "apple" }
        restartWhisper()
    }

    @objc func chooseVoice(_ sender: NSMenuItem) { selectVoice(sender.representedObject as? String) }

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
