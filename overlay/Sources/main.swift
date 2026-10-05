// visioncli voice overlay: hold Option+Space, ask out loud, read the answer above your mouse pointer.
//
// A menu-bar accessory app. Speech is transcribed on-device, the window under the pointer is captured,
// and the question + screenshots go to a long-lived `claude` session for the project that window belongs to.
// Answers stream into a click-through bubble that follows the cursor; it can be pinned to scroll and click
// file links, can draw highlight boxes on screen, read answers aloud, and asks before Claude edits anything.

import AppKit
import AVFoundation
import Carbon.HIToolbox
import Speech
import SwiftUI

// MARK: - Hotkeys (Carbon: no Accessibility permission needed)

enum HotKey: UInt32 { case talk = 1, point, dismiss, pin, open, allow }

final class HotKeys {
    static var handler: (HotKey, Bool) -> Void = { _, _ in }
    private var refs: [HotKey: EventHotKeyRef] = [:]
    private let sig: OSType = 0x5643_4C49 // "VCLI"

    private static let combos: [HotKey: (Int, Int)] = [
        .talk: (kVK_Space, optionKey),
        .point: (kVK_Space, optionKey | shiftKey),
        .dismiss: (kVK_Escape, 0),
        .pin: (kVK_ANSI_P, optionKey),
        .open: (kVK_ANSI_O, optionKey),
        .allow: (kVK_Return, optionKey),
    ]

    init() {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            if let key = HotKey(rawValue: id.id) {
                DispatchQueue.main.async { HotKeys.handler(key, pressed) }
            }
            return noErr
        }, types.count, &types, nil, nil)
        set(.talk, true)
        set(.point, true)
    }

    /// Esc, ⌥P, ⌥O and ⌥↩ are only grabbed while the overlay is visible, so they keep working in other apps otherwise.
    func set(_ key: HotKey, _ on: Bool) {
        if on, refs[key] == nil, let (code, mods) = HotKeys.combos[key] {
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(UInt32(code), UInt32(mods), EventHotKeyID(signature: sig, id: key.rawValue),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs[key] = ref } else { log("couldn't register hotkey \(key): \(status)") }
        } else if !on, let ref = refs.removeValue(forKey: key) {
            UnregisterEventHotKey(ref)
        }
    }
}

/// The bubble panel. Click-through while following the pointer; interactive when pinned or asking approval.
final class OverlayPanel: NSPanel {
    var interactive = false
    override var canBecomeKey: Bool { interactive }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, BubbleActions {
    let cfg = Config.load()
    let state = OverlayState()
    var panel: OverlayPanel!
    var hosting: NSHostingView<OverlayView>!
    var hotkeys: HotKeys!
    var listener: Listener!
    let speaker = Speaker()
    var whisper: WhisperEngine?
    var sigterm: DispatchSourceSignal?
    let activity = ActivityLog()
    var activityShown = false
    var lastCost: Double?
    var kokoro: KokoroEngine!
    let projects = ProjectResolver()
    let history = HistoryStore()
    let historyWindow = HistoryWindow()
    let highlight = HighlightOverlay()
    let selector = RegionSelector()
    var statusItem: NSStatusItem!

    var sessions: [String: AssistantSession] = [:]   // key: "<assistant>:<project>"
    var terminals: [String: TerminalSession] = [:]
    var currentTerminal: TerminalSession?
    var terminalContext: TerminalContext?
    var existingClaude: (project: String, context: TerminalContext)?
    var current: AssistantSession?
    var currentProject: String {
        didSet { if currentProject != oldValue { updateStatusTitle() } }
    }
    var candidates: (running: [(project: String, assistant: Assistant)], windows: [String]) = ([], [])
    var currentShots: [Shot] = []
    var currentWindow: WinInfo?
    var alwaysAllow: [String: Set<String>] = [:] // project → tools approved for the session

    var startShot: Shot?
    var region: CGRect?
    var pressedAt = Date()
    var keyPoll: Timer?
    var followTimer: Timer?
    var hideWork: DispatchWorkItem?

    override init() {
        currentProject = ""
        super.init()
        currentProject = cfg.cwd
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        if CrashReporter.isCrashLooping() {
            log("crash loop detected; not restarting")
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "VisionCLI keeps crashing"
            alert.informativeText = "It crashed several times in the last few minutes, so it won't restart automatically. Details are in \(CrashReporter.logURL.path). Run `visioncli voice` to start it again."
            alert.runModal()
            CrashReporter.markCleanExit()
            exit(0) // a clean exit, so launchd stops relaunching it
        }
        let recovered = CrashReporter.install()
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildMenu()
        projects.refreshIfStale()

        listener = Listener(locale: cfg.locale)
        listener.onText = { [weak self] t in self?.state.question = t }
        listener.onLevel = { [weak self] l in self?.state.level = l }

        startVoiceEngines()
        updateStatusTitle()
        refreshCandidates()
        if Config.isFirstRun { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showWelcome() } }
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refreshCandidates() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            log("project candidates: running=\(self.candidates.running.map { "\($0.assistant.binary):\($0.project)" }) windows=\(self.candidates.windows)")
        }
        if let recovered {
            log("recovered from a crash")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.state.question = "visioncli"; self.flash(recovered, seconds: 8) }
        }

        // Debug: `open VisionCLI.app --args --say "text"` speaks text on launch (tests the voice output path).
        if let i = CommandLine.arguments.firstIndex(of: "--say"), i + 1 < CommandLine.arguments.count {
            let text = CommandLine.arguments[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.speaker.feed(text, final: true, force: true) }
        }

        // Debug: `--listen-test` opens the mic for 2s, three times in a row (checks the audio path without the hotkey).
        if CommandLine.arguments.contains("--listen-test") {
            func round(_ n: Int) {
                guard n > 0 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    do { try self.listener.start(); log("listen-test: started") } catch { log("listen-test: \(error.localizedDescription)"); return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        self.listener.stop { text in
                            let size = (self.listener.recordingURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int }) ?? 0
                            log("listen-test: stopped, wav \(size) bytes, heard \"\(text)\"")
                            round(n - 1)
                        }
                    }
                }
            }
            round(3)
        }

        // Debug: `--probe-terminal` logs what the front terminal tab is running (project, claude session).
        if CommandLine.arguments.contains("--probe-terminal") {
            DispatchQueue.global().async {
                for project in [self.cfg.cwd] {
                    let started = Date()
                    let c = TerminalProbe.find(Settings.assistant, forProject: project)
                    log("find \(Settings.assistant.binary) for \(project): \(c.map { "tab=\($0.itermSession ?? "-") session=\($0.sessionId ?? "-") cwd=\($0.cwd)" } ?? "none") (\(Int(Date().timeIntervalSince(started) * 1000))ms)")
                }
                for app in ["iTerm2", "Terminal"] {
                    let c = TerminalProbe.probe(app: app)
                    log("probe \(app): \(c.map { "project=\($0.project) cwd=\($0.cwd) assistant=\($0.assistant?.binary ?? "-") session=\($0.sessionId ?? "-") tab=\($0.itermSession ?? "-")" } ?? "nothing")")
                }
            }
        }

        // `visioncli voice` replaces a running instance with SIGTERM; shut the helper processes down too.
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { [weak self] in self?.quit() }
        term.resume()
        sigterm = term

        hotkeys = HotKeys()
        HotKeys.handler = { [weak self] key, pressed in self?.hotkey(key, pressed: pressed) }

        SFSpeechRecognizer.requestAuthorization { _ in }
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        if !Screen.hasPermission { CGRequestScreenCaptureAccess() }

    }

    // MARK: Panel

    func buildPanel() {
        panel = OverlayPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        hosting = NSHostingView(rootView: OverlayView(s: state, actions: self))
        hosting.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hosting
    }

    var frozen: Bool { state.pinned || state.phase == .approval }

    func set(_ phase: Phase) {
        state.phase = phase
        hideWork?.cancel()
        if phase == .hidden {
            followTimer?.invalidate()
            followTimer = nil
            panel.orderOut(nil)
            state.pinned = false
            state.toast = ""
            for k in [HotKey.dismiss, .pin, .open, .allow] { hotkeys.set(k, false) }
            return
        }
        hotkeys.set(.dismiss, true)
        hotkeys.set(.pin, [.answering, .done, .error].contains(phase))
        hotkeys.set(.open, phase == .done)
        hotkeys.set(.allow, phase == .approval)
        panel.interactive = frozen
        panel.ignoresMouseEvents = !frozen
        if followTimer == nil {
            followTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.follow() }
            RunLoop.main.add(followTimer!, forMode: .common)
        }
        follow()
        panel.orderFrontRegardless()
    }

    /// Keep the overlay glued to the pointer: the loader rides at the cursor, the answer floats above it.
    /// When pinned (or asking approval) it stays put and only resizes.
    func follow() {
        if state.speaking != speaker.isSpeaking { state.speaking = speaker.isSpeaking }
        let size = hosting.fittingSize
        guard size.width > 2 else { return }
        if frozen {
            let f = panel.frame
            guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(f) }) ?? NSScreen.main else { return }
            let vf = screen.visibleFrame
            var origin = CGPoint(x: f.minX, y: f.maxY - size.height)
            origin.x = min(max(origin.x, vf.minX + 4), vf.maxX - size.width - 4)
            origin.y = min(max(origin.y, vf.minY + 4), vf.maxY - size.height - 4)
            let frame = NSRect(origin: origin, size: size).integral
            if f != frame { panel.setFrame(frame, display: true) }
            return
        }
        let m = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(m, $0.frame, false) }) ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        var origin: CGPoint
        switch state.phase {
        case .listening, .thinking:
            origin = CGPoint(x: m.x + 14, y: m.y - 22 - size.height / 2)
        default:
            origin = CGPoint(x: m.x - size.width / 2, y: m.y + 14)
            let below = origin.y + size.height > vf.maxY
            if below { origin.y = m.y - 30 - size.height }
            if state.below != below { state.below = below }
        }
        origin.x = min(max(origin.x, vf.minX + 4), vf.maxX - size.width - 4)
        origin.y = min(max(origin.y, vf.minY + 4), vf.maxY - size.height - 4)
        let frame = NSRect(origin: origin, size: size).integral
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    func scheduleHide(after seconds: Double) {
        hideWork?.cancel()
        guard !state.pinned else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.state.pinned else { return }
            self.set(.hidden)
            self.highlight.hide()
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func flash(_ message: String, seconds: Double = 5) {
        state.raw = message
        set(.error)
        scheduleHide(after: seconds)
    }

    // MARK: Hotkeys

    func hotkey(_ key: HotKey, pressed: Bool) {
        if key == .talk || key == .point || pressed { log("hotkey \(key) \(pressed ? "down" : "up") in \(state.phase)") }
        switch (key, pressed) {
        case (.talk, true), (.point, true):
            // Second tap while listening (tap mode) sends the question.
            if state.phase == .listening { finishListening(); return }
            if state.phase == .approval { return }
            startListening(point: key == .point)
        case (.talk, false), (.point, false):
            keysReleased()
        case (.dismiss, true): dismiss()
        case (.pin, true): togglePin()
        case (.open, true): openFirstReference()
        case (.allow, true): approve(true, always: false)
        default: break
        }
    }

    func startListening(point: Bool) {
        speaker.reset()
        highlight.hide()
        state.pinned = false
        state.question = ""
        state.raw = ""
        state.status = ""
        state.toast = ""
        state.level = 0
        state.regionSelected = false
        startShot = nil
        region = nil
        do {
            try listener.start()
        } catch {
            log("listener failed: \(error)")
            state.question = "Voice"
            // Only blame permissions when macOS actually denied them.
            let micDenied = AVCaptureDevice.authorizationStatus(for: .audio) != .authorized
            let speechDenied = SFSpeechRecognizer.authorizationStatus() != .authorized
            if micDenied || speechDenied {
                flash("VisionCLI needs \([micDenied ? "Microphone" : nil, speechDenied ? "Speech Recognition" : nil].compactMap { $0 }.joined(separator: " and ")) access: System Settings → Privacy & Security.", seconds: 10)
            } else {
                flash("Couldn't start the microphone (\(error.localizedDescription)). Try again, or pick another mic in 👁 → Microphone.", seconds: 10)
            }
            return
        }
        set(.listening)
        pressedAt = Date()
        warmQuick()

        // Work out the project now and warm up its Claude session while the user is still talking.
        let window = Screen.windowUnderPointer()
        terminalContext = nil
        existingClaude = nil
        if let pinned = Settings.pinnedProject { currentProject = pinned }
        else if let raw = Screen.rawWindowUnderPointer(), raw.isTerminal {
            // Pointing at a terminal: use that tab's folder, and its claude session if one is running there.
            let app = raw.app
            DispatchQueue.global().async {
                let ctx = TerminalProbe.probe(app: app)
                DispatchQueue.main.async {
                    guard let ctx, self.state.phase == .listening || self.state.phase == .thinking else { return }
                    self.terminalContext = ctx
                    self.currentProject = ctx.project
                    self.state.project = (ctx.project as NSString).lastPathComponent
                    log("terminal context: \(ctx.project)\(ctx.assistant.map { " (\($0.binary) running, session \(ctx.sessionId ?? "?"))" } ?? "")")
                }
            }
        }
        if Settings.pinnedProject == nil { currentProject = projects.project(for: window) ?? currentProject }
        if Settings.terminalMode {
            let project = currentProject
            DispatchQueue.global().async {
                let found = TerminalProbe.find(Settings.assistant, forProject: project)
                DispatchQueue.main.async { self.existingClaude = found.map { (project, $0) } }
            }
        }
        state.project = (currentProject as NSString).lastPathComponent
        if !Settings.terminalMode { session(for: currentProject).warm() }
        if let window {
            DispatchQueue.global().async {
                let shot = try? Screen.capture(window: window)
                DispatchQueue.main.async { if self.state.phase == .listening { self.startShot = shot } }
            }
        }

        if point {
            state.status = "Drag around what you mean…"
            selector.begin { [weak self] rect in
                guard let self, let rect else { return }
                self.region = rect
                self.state.regionSelected = true
                self.state.status = ""
                self.highlight.show([(Geometry.toAppKit(rect), "")], persistent: true)
                // Keys already released while dragging (hold mode): send now.
                let held = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_Space))
                if !held && Date().timeIntervalSince(self.pressedAt) >= 0.35 && self.state.phase == .listening { self.finishListening() }
            }
        }

        // Carbon doesn't always deliver the key-up (e.g. when Option is let go first), so also watch the keys directly.
        keyPoll?.invalidate()
        keyPoll = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
            let space = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(kVK_Space))
            let option = NSEvent.modifierFlags.contains(.option)
            if !(space && option) { self?.keysReleased() }
        }
        RunLoop.main.add(keyPoll!, forMode: .common)
        let started = pressedAt
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            guard let self, self.state.phase == .listening, self.pressedAt == started else { return }
            self.finishListening()
        }
    }

    func keysReleased() {
        keyPoll?.invalidate()
        keyPoll = nil
        guard state.phase == .listening else { return }
        // In point mode, keep listening while the user is still dragging.
        if selector.isActive && region == nil { return }
        if Date().timeIntervalSince(pressedAt) < 0.35 {
            // Quick tap: keep listening until the next tap.
            if state.question.isEmpty { state.status = "Listening… tap ⌥ Space to send" }
            return
        }
        finishListening()
    }

    func finishListening() {
        keyPoll?.invalidate()
        keyPoll = nil
        guard state.phase == .listening else { return }
        if selector.isActive { selector.cancel() }
        state.status = "Thinking…"
        set(.thinking)
        let heard = state.question
        listener.stop { [weak self] final in
            guard let self, self.state.phase == .thinking else { return }
            let apple = final.isEmpty ? heard.trimmingCharacters(in: .whitespacesAndNewlines) : final
            // Re-transcribe the recording with local Whisper (better with names and jargon); fall back to Apple's text.
            if let whisper = self.whisper, whisper.ready, let wav = self.listener.recordingURL {
                self.state.status = "Transcribing…"
                whisper.transcribe(wav, prompt: self.vocabularyPrompt()) { [weak self] text in
                    guard let self, self.state.phase == .thinking else { return }
                    let best = (text?.isEmpty == false) ? text! : apple
                    log("transcript: apple=\"\(apple)\" whisper=\"\(text ?? "nil")\"")
                    self.questionReady(best)
                }
            } else {
                log("transcript: \(apple)")
                self.questionReady(apple)
            }
        }
    }

    func questionReady(_ text: String) {
        guard !text.isEmpty else {
            highlight.hide()
            state.question = ""
            flash("Didn't catch that. Hold ⌥ Space while you speak.")
            return
        }
        state.question = text
        state.status = "Looking at your screen…"
        guard Settings.quickCommands else { captureAndAsk(text); return }
        // Jev first (fast path for simple browser commands); Claude if it isn't a confident quick action.
        let started = Date()
        runQuick(text, timeout: 3) { [weak self] result in
            guard let self, self.state.phase == .thinking, self.state.question == text else { return }
            let handled = result?["handled"] as? Bool ?? false
            log("quick: \(handled ? "handled" : "→ claude") intent=\(result?["intent"] ?? "-") conf=\(result?["confidence"] ?? "-") \(result?["reason"] ?? "") \(Int(Date().timeIntervalSince(started) * 1000))ms")
            guard handled, let message = result?["message"] as? String else { self.captureAndAsk(text); return }
            self.activity.question(text, project: self.currentProject, shots: [])
            self.activity.note("⚡ \(message) (Jev, \(Int(Date().timeIntervalSince(started) * 1000))ms)")
            self.state.raw = "⚡ " + message
            self.set(.done)
            self.speaker.feed(message, final: true)
            self.history.add(HistoryEntry(date: Date(), project: self.currentProject, question: text, answer: "⚡ " + message, screenshots: []))
            self.scheduleHide(after: 4)
        }
    }

    var quickProc: Process?

    /// `visioncli quick <text>` with a hard timeout (killed if slow, so it can't act after Claude took over).
    func runQuick(_ text: String, timeout: Double, _ done: @escaping ([String: Any]?) -> Void) {
        guard let node = cfg.node, let server = cfg.server else { done(nil); return }
        quickProc?.terminate()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [server, "quick", text]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        var finished = false
        p.terminationHandler = { proc in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            DispatchQueue.main.async {
                guard !finished else { return }
                finished = true
                done(proc.terminationReason == .exit ? json : nil)
            }
        }
        do { try p.run() } catch { done(nil); return }
        quickProc = p
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            guard !finished else { return }
            finished = true
            p.terminate()
            log("quick: timed out after \(timeout)s")
            done(nil)
        }
    }

    var lastWarm = Date.distantPast

    /// Wake the Jev service while the user is still talking.
    func warmQuick() {
        guard Settings.quickCommands, Date().timeIntervalSince(lastWarm) > 120 else { return }
        lastWarm = Date()
        DispatchQueue.global().async { [cfg] in
            let (_, out, _) = cfg.visioncli(["warm"])
            log("quick: \(out.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    /// Words Whisper should spell right: project, window title, the user's vocabulary file, common dev terms.
    func vocabularyPrompt() -> String {
        var words = [(currentProject as NSString).lastPathComponent]
        if let title = Screen.windowUnderPointer()?.title, !title.isEmpty { words.append(title) }
        if let custom = try? String(contentsOf: Settings.vocabularyFile, encoding: .utf8) {
            words += custom.components(separatedBy: CharacterSet(charactersIn: ",\n")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        words += ["Claude", "Laravel", "PHP", "Swift", "SwiftUI", "Xcode", "TypeScript", "React", "SQL", "API", "JSON", "migration", "controller"]
        return "Vocabulary: " + words.joined(separator: ", ") + "."
    }

    // MARK: Voice engines

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
        guard Settings.sttEngine == "whisper" else { return }
        whisper = WhisperEngine(cfg: cfg, model: Settings.whisperModel)
        if whisper == nil { log("whisper unavailable: install whisper-cpp and a ggml model; using Apple speech recognition") }
        whisper?.start()
    }

    func captureAndAsk(_ text: String) {
        let region = self.region, startShot = self.startShot
        DispatchQueue.global().async {
            var shots: [Shot] = []
            var failure: Error?
            do {
                if let region {
                    shots = [try Screen.capture(rect: region)]
                } else if let endWindow = Screen.windowUnderPointer() {
                    let end = try Screen.capture(window: endWindow)
                    // Pointer moved to another window while talking: send both ("compare this with that").
                    if let s = startShot, s.window?.id != end.window?.id { shots = [s, end] } else { shots = [end] }
                } else if let s = startShot {
                    shots = [s]
                }
            } catch {
                failure = error
            }
            DispatchQueue.main.async {
                self.highlight.hide()
                if let failure, shots.isEmpty {
                    log("capture failed: \(failure)")
                    if case CaptureError.permission = failure { CGRequestScreenCaptureAccess() }
                    self.flash(failure.localizedDescription, seconds: 15)
                    return
                }
                self.ask(text, shots: shots)
            }
        }
    }

    // MARK: Claude

    func session(for project: String) -> AssistantSession {
        let key = "\(Settings.assistant.rawValue):\(project)"
        if let s = sessions[key] { return s }
        let s: AssistantSession = Settings.assistant == .gemini ? GeminiSession(cwd: project, cfg: cfg) : ClaudeSession(cwd: project, cfg: cfg)
        s.onStatus = { [weak self, weak s] text in
            guard let self, s === self.current else { return }
            self.state.status = text
        }
        s.onToolStart = { [weak self, weak s] in
            // Text before a tool call is narration ("Let me look…"); drop it and show the loader again.
            guard let self, s === self.current, self.state.phase == .answering else { return }
            self.state.raw = ""
            self.speaker.reset()
            self.set(.thinking)
        }
        s.onDelta = { [weak self, weak s] t in
            guard let self, s === self.current, self.state.phase != .hidden else { return }
            if self.state.phase == .thinking { self.set(.answering) }
            self.state.raw += t
            self.speaker.feed(self.state.answer, final: false)
            self.activity.text(t)
        }
        s.onToolUse = { [weak self, weak s] name, input in
            guard let self, s === self.current else { return }
            self.activity.tool(name, input)
        }
        s.onToolResult = { [weak self, weak s] text, isError, tool in
            guard let self, s === self.current else { return }
            self.activity.toolResult(text, isError: isError, tool: tool)
        }
        s.onCost = { [weak self] cost in self?.lastCost = cost }
        s.onPermission = { [weak self, weak s] req in
            guard let self, let s else { return }
            if self.alwaysAllow[s.cwd]?.contains(req.tool) == true { s.respond(to: req, allow: true); return }
            guard s === self.current, self.state.phase != .hidden else { s.respond(to: req, allow: false); return }
            self.state.permission = req
            self.activity.permission(req.title, allowed: nil)
            self.speaker.reset()
            self.set(.approval)
            self.panel.makeKey()
        }
        s.onDone = { [weak self, weak s] result, error in
            guard let self, s === self.current else { return }
            self.finish(result: result, error: error)
        }
        // Keep at most a few projects warm.
        if sessions.count >= 3, let (victimKey, victim) = sessions.first(where: { $0.value !== current && !$0.value.busy }) {
            victim.stop()
            sessions[victimKey] = nil
        }
        sessions[key] = s
        return s
    }

    func terminal(for project: String, assistant: Assistant = Settings.assistant) -> TerminalSession {
        let key = "\(assistant.rawValue):\(project)"
        if let t = terminals[key] { return t }
        let t = TerminalSession(project: project, cfg: cfg, assistant: assistant)
        t.onStatus = { [weak self, weak t] text in
            guard let self, t === self.currentTerminal else { return }
            self.state.status = text
        }
        t.onToolUse = { [weak self, weak t] name, input in
            guard let self, t === self.currentTerminal else { return }
            self.state.status = ClaudeSession.describe(tool: name, input: input)
            self.activity.tool(name, input)
        }
        t.onToolResult = { [weak self, weak t] text, isError in
            guard let self, t === self.currentTerminal else { return }
            self.activity.toolResult(text, isError: isError, tool: nil)
        }
        t.onDone = { [weak self, weak t] result, error in
            guard let self, t === self.currentTerminal else { return }
            self.finish(result: result, error: error)
        }
        terminals[key] = t
        return t
    }

    func ask(_ question: String, shots: [Shot]) {
        // A terminal the user pointed at wins; otherwise the window the pointer ended on decides the project.
        if let pinned = Settings.pinnedProject { currentProject = pinned }
        else if let ctx = terminalContext { currentProject = ctx.project }
        else if let p = projects.project(for: shots.last?.window) { currentProject = p }
        state.project = (currentProject as NSString).lastPathComponent
        let saved = history.save(shots)
        currentShots = saved
        currentWindow = saved.last?.window ?? currentWindow

        var context = ["Project: \(currentProject)."]
        for (i, shot) in saved.enumerated() {
            var line = "Image \(i + 1): \(shot.label), \(Int(shot.pixelSize.width))x\(Int(shot.pixelSize.height)) px"
            if let p = shot.pointer { line += ", mouse pointer at (\(Int(p.x)), \(Int(p.y)))" } else { line += ", pointer not over it" }
            if let f = shot.file { line += ", saved at \(f.path)" }
            context.append(line + ".")
        }
        if saved.isEmpty { context.append("No screenshot is available; use mcp__visioncli__look if you need one.") }
        let text = "\(question)\n\n[Voice question. \(context.joined(separator: " "))]"

        activity.question(question, project: currentProject, shots: saved)

        if Settings.terminalMode {
            // The CLI running in the tab the user pointed at wins; otherwise the chosen assistant.
            let assistant = terminalContext?.assistant ?? Settings.assistant
            let gemini = assistant == .gemini
            let paths = gemini ? geminiAttachable(saved) : saved.compactMap { $0.file?.path }
            var parts = ["Project: \(currentProject)."]
            for (i, shot) in saved.enumerated() {
                var p = "Screenshot \(i + 1): \(shot.label), \(Int(shot.pixelSize.width))x\(Int(shot.pixelSize.height)) px"
                if let pt = shot.pointer { p += ", mouse pointer at (\(Int(pt.x)), \(Int(pt.y)))" }
                if i < paths.count { p += gemini ? ", @\(paths[i]) " : ", file \(paths[i])" }
                parts.append(p + ".")
            }
            // Gemini can't take a system prompt in its interactive mode, so the voice instructions ride along.
            if gemini { parts.append("Asked out loud: the reply is also shown in a bubble above the mouse and read aloud, so answer in plain text, under about 100 words; \"this\" means what's under the pointer; cite files as path:line.") }
            let t = terminal(for: currentProject, assistant: assistant)
            // Prefer one the user already runs: the tab they pointed at, else any tab for this project.
            if let ctx = terminalContext, ctx.assistant == assistant, let tab = ctx.itermSession {
                t.claudeCwd = ctx.cwd
                t.attach(itermSession: tab, sessionId: ctx.sessionId)
            } else if let found = existingClaude, found.project == currentProject, found.context.assistant == assistant,
                      let tab = found.context.itermSession {
                t.claudeCwd = found.context.cwd
                t.attach(itermSession: tab, sessionId: found.context.sessionId)
            }
            currentTerminal = t
            current = nil
            state.raw = ""
            state.status = "Sending to \(assistant.name) in the terminal…"
            if state.phase != .thinking { set(.thinking) }
            t.ask("\(question) [Voice question. \(parts.joined(separator: " "))]")
            return
        }
        currentTerminal = nil

        if Settings.autoActivity && !activityShown {
            activityShown = true
            TerminalLauncher.showActivity()
        }

        let s = session(for: currentProject)
        current = s
        state.raw = ""
        state.status = "Thinking…"
        if state.phase != .thinking { set(.thinking) }
        s.send(text: text, shots: saved)
    }

    func finish(result: String?, error: String?) {
        if let error { activity.error(error) } else { activity.done(cost: lastCost) }
        lastCost = nil
        if let error {
            state.raw = error
            set(.error)
            scheduleHide(after: 15)
            return
        }
        if let result, !result.isEmpty { state.raw = result }
        set(.done)
        speaker.feed(state.answer, final: true)

        // Draw any boxes Claude pointed at.
        let marks = Markup.boxes(in: state.raw).compactMap { box -> (CGRect, String)? in
            guard !currentShots.isEmpty else { return nil }
            let shot = currentShots[min(max(box.image, 1), currentShots.count) - 1]
            return (shot.screenRect(forImageRect: box.rect), box.label)
        }
        if !marks.isEmpty { highlight.show(marks, for: 20) }

        history.add(HistoryEntry(date: Date(), project: currentProject, question: state.question, answer: state.raw,
                                 screenshots: currentShots.compactMap { $0.file?.path }))
        scheduleHide(after: 90)
    }

    // MARK: BubbleActions

    func copyAnswer() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(state.answer, forType: .string)
        state.toast = "Copied"
    }

    func toggleSpeak() {
        if Settings.ttsEngine == "kokoro" && !kokoro.isRunning { kokoro.start() }
        if speaker.isSpeaking { speaker.reset() } else {
            speaker.reset()
            speaker.feed(state.answer, final: true, force: true)
        }
    }

    func showHistory() { historyWindow.show(store: history) }

    func dismiss() {
        if state.phase == .approval { approve(false, always: false); return }
        if selector.isActive { selector.cancel() }
        keyPoll?.invalidate()
        listener.cancel()
        if let s = current, s.busy { s.stop() } // stop the turn; the next question resumes the conversation
        speaker.reset()
        highlight.hide()
        set(.hidden)
    }

    func togglePin() {
        guard [.answering, .done, .error].contains(state.phase) else { return }
        state.pinned.toggle()
        panel.interactive = frozen
        panel.ignoresMouseEvents = !frozen
        if state.pinned {
            hideWork?.cancel()
            panel.makeKey()
        } else if state.phase == .done {
            scheduleHide(after: 60)
        }
    }

    func approve(_ allow: Bool, always: Bool) {
        guard let req = state.permission, let s = current else { return }
        if always { alwaysAllow[s.cwd, default: []].insert(req.tool) }
        s.respond(to: req, allow: allow)
        activity.permission(req.title, allowed: allow)
        log("permission \(req.tool): \(allow ? "allowed" : "denied")")
        state.permission = nil
        state.status = allow ? "Making the change…" : "OK, skipping that…"
        set(.thinking)
    }

    func openLink(_ url: URL) {
        guard url.scheme == "visioncli", let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = comps.queryItems?.first(where: { $0.name == "path" })?.value else {
            NSWorkspace.shared.open(url)
            return
        }
        let line = Int(comps.queryItems?.first(where: { $0.name == "line" })?.value ?? "") ?? 1
        Opener.open(path: path, line: line, project: currentProject, preferredApp: currentWindow)
    }

    func openFirstReference() {
        guard let (path, line) = Markup.firstFileRef(state.answer) else { state.toast = "No file reference in this answer"; return }
        Opener.open(path: path, line: line, project: currentProject, preferredApp: currentWindow)
        state.toast = "Opening \((path as NSString).lastPathComponent):\(line)…"
    }

    // MARK: Menu bar

    func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = MenuIcon.make()
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.toolTip = "visioncli"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        @discardableResult func item(_ title: String, _ action: Selector?, in m: NSMenu, key: String = "", on: Bool = false, value: Any? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.target = self
            i.state = on ? .on : .off
            i.representedObject = value
            if action == nil { i.isEnabled = false }
            m.addItem(i)
            return i
        }
        func submenu(_ title: String, in m: NSMenu, _ build: (NSMenu) -> Void) {
            let sub = NSMenu()
            build(sub)
            let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            i.submenu = sub
            m.addItem(i)
        }

        // Project: Auto, or pick one (candidates refreshed in the background each time the menu opens)
        refreshCandidates()
        submenu("Project: \((currentProject as NSString).lastPathComponent)\(Settings.pinnedProject != nil ? " 📌" : "")", in: menu) { m in
            item("Auto: follow the window under the pointer", #selector(pickProject(_:)), in: m, on: Settings.pinnedProject == nil)
            m.addItem(.separator())
            var seen = Set<String>()
            func add(_ path: String, note: String) {
                guard !path.isEmpty, seen.insert(path).inserted else { return }
                let shortPath = path.replacingOccurrences(of: home.path, with: "~")
                item("\((path as NSString).lastPathComponent)   \(note)\(shortPath)", #selector(pickProject(_:)), in: m,
                     on: Settings.pinnedProject == path, value: path)
            }
            for r in candidates.running { add(r.project, note: "⚡ \(r.assistant.binary) running · ") }
            for p in candidates.windows { add(p, note: "open · ") }
            for p in [currentProject] + Array(Set(history.entries.prefix(50).map(\.project))).sorted() + terminals.values.map(\.project).sorted() + sessions.values.map(\.cwd).sorted() {
                add(p, note: "recent · ")
            }
            if seen.isEmpty { item("No projects found yet", nil, in: m) }
            m.addItem(.separator())
            item("Choose Folder…", #selector(chooseProjectFolder), in: m)
        }
        item("Hold ⌥Space to ask · ⌥⇧Space to point at an area", nil, in: menu)
        if !Screen.hasPermission { item("⚠︎ Grant Screen Recording…", #selector(openScreenSettings), in: menu) }
        menu.addItem(.separator())

        submenu("Assistant: \(Settings.assistant.appName)", in: menu) { m in
            for a in Assistant.allCases {
                let installed = a == .claude ? FileManager.default.isExecutableFile(atPath: cfg.claude) : cfg.gemini != nil
                item(a.appName + (installed ? "" : " (not installed)"), installed ? #selector(chooseAssistant(_:)) : nil, in: m,
                     on: Settings.assistant == a, value: a.rawValue)
            }
            m.addItem(.separator())
            item("A terminal running claude or gemini is used as-is when you point at it.", nil, in: m)
        }

        // How answers are delivered
        submenu("Answer In", in: menu) { m in
            item("\(Settings.assistant.name) Terminal: type or talk, same conversation", #selector(useTerminalMode), in: m, on: Settings.terminalMode)
            item("Bubble Only: background, leaner", #selector(useBackgroundMode), in: m, on: !Settings.terminalMode)
            m.addItem(.separator())
            if Settings.terminalMode {
                item("Show \(Settings.assistant.name) Terminal", #selector(showClaudeTerminal), in: m, key: "t")
            } else {
                item("Show Live Activity in Terminal", #selector(showActivityMenu), in: m, key: "t")
                item("Continue Conversation in Terminal", current?.sessionId == nil ? nil : #selector(continueInTerminal), in: m)
                item("Open Activity Terminal Automatically", #selector(toggleAutoActivity), in: m, on: Settings.autoActivity)
            }
        }

        if Settings.assistant == .claude { submenu("Model", in: menu) { m in
            let model = cfg.model ?? Settings.model
            item("Fast (Sonnet)", #selector(useSonnet), in: m, on: model == "sonnet")
            item("Deeper (Opus)", #selector(useOpus), in: m, on: model == "opus")
            if cfg.model != nil { item("(set by VISIONCLI_MODEL)", nil, in: m) }
        } }

        submenu("Voice & Audio", in: menu) { m in
            item("Speak Answers", #selector(toggleSpeakSetting), in: m, on: Settings.speak)
            submenu("Speech Speed", in: m) { sp in
                for x in [1.0, 1.25, 1.5, 1.75, 2.0] {
                    item(x == 1 ? "1× (normal)" : "\(x.formatted())×", #selector(chooseSpeed(_:)), in: sp, on: abs(Settings.speechSpeed - x) < 0.01, value: x)
                }
            }
            m.addItem(.separator())
            submenu("Voice", in: m) { v in
                if VoiceModels.kokoroModel != nil {
                    for (id, label) in VoiceModels.kokoroVoiceList {
                        item("Kokoro: \(label)", #selector(chooseVoice(_:)), in: v, on: Settings.ttsEngine == "kokoro" && Settings.kokoroVoice == id, value: id)
                    }
                }
                item("System voice", #selector(chooseVoice(_:)), in: v, on: Settings.ttsEngine == "system" || VoiceModels.kokoroModel == nil)
            }
            submenu("Speech Recognition", in: m) { r in
                let models = VoiceModels.whisperModels()
                for (name, _) in models {
                    item("Whisper \(name) (local)", #selector(chooseWhisper(_:)), in: r,
                         on: Settings.sttEngine == "whisper" && (whisper?.modelName ?? Settings.whisperModel) == name, value: name)
                }
                if models.isEmpty { item("Whisper: install whisper-cpp + a ggml model", nil, in: r) }
                item("Apple (on-device)", #selector(chooseWhisper(_:)), in: r, on: Settings.sttEngine == "apple" || whisper == nil)
                r.addItem(.separator())
                item("Edit Vocabulary…", #selector(editVocabulary), in: r)
            }
            m.addItem(deviceMenu(title: "Microphone", input: true))
            m.addItem(deviceMenu(title: "Speaker", input: false))
        }
        menu.addItem(.separator())

        item("History…", #selector(showHistoryMenu), in: menu, key: "y")
        item("Copy Last Answer", #selector(copyAnswerMenu), in: menu, key: "c")
        item("New Conversation", #selector(newConversation), in: menu, key: "n")
        menu.addItem(.separator())

        submenu("Settings", in: menu) { m in
            item("Set Up Claude Code (MCP tools)…", #selector(setupClaudeCode), in: m)
            item("Set Up Gemini CLI (MCP tools)…", cfg.gemini == nil ? nil : #selector(setupGemini), in: m)
            item("Start at Login", #selector(toggleLogin), in: m, on: LoginItem.isEnabled)
            item("Instant Browser Commands (Jev)", #selector(toggleQuick), in: m, on: Settings.quickCommands)
            item("Show AI Cursor in Browser", #selector(toggleGhost), in: m, on: !FileManager.default.fileExists(atPath: ghostOffFile.path))
            item("API Keys (TypeSafe for Jev, Gemini)…", #selector(openIntegrations), in: m)
            m.addItem(.separator())
            item("Open Log", #selector(openLog), in: m)
            if ((try? FileManager.default.attributesOfItem(atPath: CrashReporter.logURL.path)[.size] as? Int) ?? 0) > 0 {
                item("Open Crash Log", #selector(openCrashLog), in: m)
            }
        }
        item("Quit visioncli", #selector(quit), in: menu, key: "q")
    }

    /// Submenu listing audio devices; the choice applies to VisionCLI only.
    func deviceMenu(title: String, input: Bool) -> NSMenuItem {
        let sub = NSMenu()
        let chosen = input ? Settings.inputDeviceUID : Settings.outputDeviceUID
        let devices = input ? AudioDevices.inputs : AudioDevices.outputs
        let missing = chosen != nil && !devices.contains { $0.uid == chosen }
        let def = AudioDevices.defaultDevice(input: input)?.name ?? "none"
        let system = NSMenuItem(title: "System Default (\(def))", action: #selector(chooseDevice(_:)), keyEquivalent: "")
        system.target = self
        system.representedObject = ["input": input]
        system.state = chosen == nil || missing ? .on : .off
        sub.addItem(system)
        sub.addItem(.separator())
        for d in devices {
            let i = NSMenuItem(title: d.name, action: #selector(chooseDevice(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = ["input": input, "uid": d.uid]
            i.state = d.uid == chosen ? .on : .off
            sub.addItem(i)
        }
        if missing { sub.addItem(withTitle: "(chosen device disconnected, using default)", action: nil, keyEquivalent: "") }
        if !input {
            sub.addItem(.separator())
            let test = NSMenuItem(title: "Play Test Sound", action: #selector(testSpeaker), keyEquivalent: "")
            test.target = self
            sub.addItem(test)
        }
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = sub
        return item
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

    /// Project name next to the menu-bar icon (📌 when chosen manually).
    func updateStatusTitle() {
        let name = (currentProject as NSString).lastPathComponent
        statusItem?.button?.title = " " + (Settings.pinnedProject != nil ? "📌 " : "") + (name.count > 18 ? String(name.prefix(17)) + "…" : name)
        statusItem?.button?.font = NSFont.menuBarFont(ofSize: 0)
    }

    /// Refresh the Project menu's candidates in the background (running claude/gemini sessions, open editor windows).
    func refreshCandidates() {
        DispatchQueue.global(qos: .utility).async {
            let running = TerminalProbe.runningProjects()
            DispatchQueue.main.async {
                self.candidates = (running, self.projects.openWindowProjects())
            }
        }
    }

    @objc func pickProject(_ sender: NSMenuItem) {
        Settings.pinnedProject = sender.representedObject as? String
        if let p = Settings.pinnedProject { currentProject = p }
        updateStatusTitle()
        log("project: \(Settings.pinnedProject ?? "auto")")
    }

    @objc func chooseProjectFolder() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Use This Project"
        panel.directoryURL = URL(fileURLWithPath: currentProject)
        if panel.runModal() == .OK, let url = panel.url {
            Settings.pinnedProject = url.path
            currentProject = url.path
            updateStatusTitle()
        }
    }

    @objc func chooseSpeed(_ sender: NSMenuItem) {
        guard let x = sender.representedObject as? Double else { return }
        Settings.speechSpeed = x
        testSpeaker()
    }

    /// Register the bundled MCP server with Claude Code for all projects (`claude mcp add --scope user`).
    @objc func setupClaudeCode() {
        let alert = NSAlert()
        if let node = cfg.node, let server = cfg.server, FileManager.default.isExecutableFile(atPath: cfg.claude) {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = cfg.path
            shell(cfg.claude, ["mcp", "remove", "visioncli", "-s", "user"], env: env)
            let (status, out, err) = shell(cfg.claude, ["mcp", "add", "visioncli", "--scope", "user", "--", node, server], env: env)
            alert.messageText = status == 0 ? "Claude Code is set up" : "Couldn't set up Claude Code"
            alert.informativeText = status == 0
                ? "visioncli's tools (look at screen, browser, database…) are now available in every Claude Code project. Restart any running `claude` sessions to load them.\n\nFor screenshots when typing in Claude Code, give your terminal app Screen Recording access too (System Settings → Privacy & Security)."
                : (err.isEmpty ? out : err)
        } else {
            alert.messageText = "Missing requirements"
            alert.informativeText = [
                cfg.node == nil ? "• Node.js 18 or later (https://nodejs.org). An older Node was ignored if present." : nil,
                FileManager.default.isExecutableFile(atPath: cfg.claude) ? nil : "• Claude Code CLI (https://claude.com/claude-code)",
                cfg.server == nil ? "• The visioncli server (use the release build of VisionCLI.app)" : nil,
            ].compactMap { $0 }.joined(separator: "\n") + "\n\nInstall them, then choose Settings → Set Up Claude Code again."
        }
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc func chooseAssistant(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let a = Assistant(rawValue: raw) else { return }
        Settings.assistant = a
        log("assistant: \(a.appName)")
    }

    /// Register the MCP server with Gemini CLI for all projects (`gemini mcp add -s user --trust`). Trusted so its
    /// read-only tools also work in headless (bubble-only) mode, which can't ask for confirmation.
    @objc func setupGemini() {
        let alert = NSAlert()
        if let gemini = cfg.gemini, let node = cfg.node, let server = cfg.server {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = cfg.path
            shell(gemini, ["mcp", "remove", "-s", "user", "visioncli"], env: env)
            let (status, out, err) = shell(gemini, ["mcp", "add", "-s", "user", "--trust", "visioncli", node, server], env: env)
            alert.messageText = status == 0 ? "Gemini CLI is set up" : "Couldn't set up Gemini CLI"
            alert.informativeText = status == 0
                ? "visioncli's tools are now available in every Gemini CLI project. Restart any running `gemini` sessions. To answer voice questions with Gemini, choose 👁 → Assistant → Gemini CLI.\n\nFor screenshots when typing in Gemini CLI, give your terminal app Screen Recording access too."
                : (err.isEmpty ? out : err)
        } else {
            alert.messageText = "Gemini CLI wasn't found"
            alert.informativeText = "Install it with `npm install -g @google/gemini-cli`, sign in once by running `gemini`, then choose Settings → Set Up Gemini CLI again."
        }
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    /// First launch of a downloaded app: explain the basics and offer the Claude Code setup.
    func showWelcome() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Welcome to VisionCLI"
        alert.informativeText = """
        Ask Claude about anything on your screen, by voice.

        • Hold ⌥ Space, ask, let go: the answer appears above your mouse.
        • Hold ⌥ ⇧ Space to drag a box around what you mean.
        • The 👁 menu bar icon has projects, voices, models and settings.

        macOS will ask for Microphone, Speech Recognition and Screen Recording access. VisionCLI needs all three.
        To use the tools by typing in Claude Code, also give your terminal app (iTerm, Terminal…) Screen Recording access.

        Set up your AI CLI now so VisionCLI's tools work in every project? (Works with Claude Code and Gemini CLI; pick which one answers voice questions in 👁 → Assistant.)
        """
        let hasClaude = FileManager.default.isExecutableFile(atPath: cfg.claude), hasGemini = cfg.gemini != nil
        alert.addButton(withTitle: hasClaude && hasGemini ? "Set Up Both" : hasGemini ? "Set Up Gemini CLI" : "Set Up Claude Code")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn {
            if hasClaude || !hasGemini { setupClaudeCode() }
            if hasGemini { setupGemini() }
            if hasGemini && !hasClaude { Settings.assistant = .gemini }
        }
    }

    @objc func toggleSpeakSetting() {
        Settings.speak.toggle()
        if !Settings.speak { speaker.reset() }
        if Settings.speak && Settings.ttsEngine == "kokoro" { kokoro.start() }
    }
    @objc func chooseWhisper(_ sender: NSMenuItem) {
        if let model = sender.representedObject as? String { Settings.sttEngine = "whisper"; Settings.whisperModel = model }
        else { Settings.sttEngine = "apple" }
        restartWhisper()
    }
    @objc func chooseVoice(_ sender: NSMenuItem) {
        speaker.reset()
        if let voice = sender.representedObject as? String {
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
    @objc func useSonnet() { Settings.model = "sonnet" }
    @objc func useOpus() { Settings.model = "opus" }
    @objc func showHistoryMenu() { showHistory() }
    @objc func showActivityMenu() {
        activityShown = true
        TerminalLauncher.showActivity()
    }
    @objc func toggleAutoActivity() { Settings.autoActivity.toggle() }
    @objc func toggleQuick() { Settings.quickCommands.toggle() }

    /// The node browser layer checks this file before animating its ghost cursor.
    let ghostOffFile = supportDir.appendingPathComponent("ghost-off")
    @objc func toggleGhost() {
        if FileManager.default.fileExists(atPath: ghostOffFile.path) { try? FileManager.default.removeItem(at: ghostOffFile) }
        else { FileManager.default.createFile(atPath: ghostOffFile.path, contents: nil) }
    }
    @objc func useTerminalMode() { Settings.terminalMode = true }
    @objc func useBackgroundMode() { Settings.terminalMode = false }
    @objc func showClaudeTerminal() { terminal(for: currentProject).bringToFront() }
    @objc func continueInTerminal() {
        guard let s = current, let sid = s.sessionId else { return }
        if s is GeminiSession, let gemini = cfg.gemini {
            TerminalLauncher.run("cd '\(s.cwd.replacingOccurrences(of: "'", with: "'\\''"))' && exec '\(gemini)' --resume \(sid)", name: "continue")
        } else {
            TerminalLauncher.continueSession(project: s.cwd, sessionId: sid, claude: cfg.claude)
        }
    }
    @objc func copyAnswerMenu() {
        let last = history.entries.first.map { Markup.display($0.answer) } ?? state.answer
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(last, forType: .string)
    }
    @objc func newConversation() {
        sessions.values.forEach { $0.reset() }
        terminals.values.forEach { $0.reset() }
        alwaysAllow = [:]
    }
    @objc func openScreenSettings() {
        CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }
    @objc func openLog() { NSWorkspace.shared.open(logURL) }

    /// integrations.json holds API keys: TypeSafe (Jev instant browser commands) and Gemini (Gemini CLI via API key).
    @objc func openIntegrations() {
        let file = supportDir.appendingPathComponent("integrations.json")
        if !FileManager.default.fileExists(atPath: file.path) {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
            try? "{\n  \"typesafe\": { \"apiKey\": \"\" },\n  \"gemini\": { \"apiKey\": \"\" }\n}\n".write(to: file, atomically: true, encoding: .utf8)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        NSWorkspace.shared.open(file)
    }

    @objc func toggleLogin() {
        do {
            try LoginItem.set(!LoginItem.isEnabled)
        } catch {
            log("login item: \(error)")
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Couldn't change Start at Login"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    func applicationWillTerminate(_ notification: Notification) { CrashReporter.markCleanExit() }

    @objc func openCrashLog() { NSWorkspace.shared.open(CrashReporter.logURL) }

    @objc func quit() {
        CrashReporter.markCleanExit()
        sessions.values.forEach { $0.stop() }
        whisper?.stop()
        kokoro.stop()
        log("quit")
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
