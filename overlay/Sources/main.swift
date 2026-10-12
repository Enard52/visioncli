// visioncli voice overlay: hold Option+Space, ask out loud, read the answer above your mouse pointer.
//
// A menu-bar accessory app. Speech is transcribed on-device, the window under the pointer is captured,
// and the question + screenshots go to a long-lived `claude` session for the project that window belongs to.
// Answers stream into a click-through bubble that follows the cursor; it can be pinned to scroll and click
// file links, can draw highlight boxes on screen, read answers aloud, and asks before Claude edits anything.

import AppKit
import AVFoundation
import Combine
import Carbon.HIToolbox
import Speech
import SwiftUI

// MARK: - Hotkeys (Carbon: no Accessibility permission needed)

enum HotKey: UInt32 { case talk = 1, point, dismiss, pin, open, allow, screen }

final class HotKeys {
    static var handler: (HotKey, Bool) -> Void = { _, _ in }
    private var refs: [HotKey: EventHotKeyRef] = [:]
    private let sig: OSType = 0x5643_4C49 // "VCLI"

    private static let combos: [HotKey: (Int, Int)] = [
        .talk: (kVK_Space, controlKey),
        .point: (kVK_Space, optionKey | shiftKey),
        .screen: (kVK_Space, controlKey | optionKey),
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
        set(.point, true) // ⌥ / ⌥⌘ are held modifiers (ModifierHold); ⌃Space / ⌃⌥Space only without Accessibility
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

/// Hold-to-talk on modifier keys alone, like a dictation app's fn key: hold ⌥ to ask (text only), ⌥⌘ to ask with a
/// screenshot. Needs Accessibility (VisionCLI has it for computer control). Any other key or a click while holding
/// cancels it, so ⌃C, ⌃-click and friends keep working.
final class ModifierHold {
    var onChange: (HotKey, Bool) -> Void = { _, _ in }
    /// ⌘ added while ⌥ is already held: the question becomes a screenshot question.
    var onUpgrade: () -> Void = {}
    /// While listening, a press counts at once (the tap that sends the question).
    var immediate: () -> Bool = { false }
    private var monitors: [Any] = []
    private var pending: DispatchWorkItem?
    private var candidate: HotKey?
    private var active: HotKey?

    func start() {
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.handle(e) }) { monitors.append(g) }
        if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.handle(e); return e }) { monitors.append(l) }
    }

    private func handle(_ e: NSEvent) {
        if e.cgEvent?.getIntegerValueField(.eventSourceUserData) == FlowDictation.tag { return } // our own fake keys
        guard e.type == .flagsChanged else {
            cancel() // a shortcut (⌃C) or a ⌃-click, not a hold
            return
        }
        let flags = e.modifierFlags.intersection([.control, .option, .command, .shift])
        if let held = active {
            if !ModifierHold.keyDown { active = nil; onChange(held, false); return }
            if held == .talk, flags == [.option, .command] { active = .screen; onUpgrade() }
            return
        }
        guard let key: HotKey = flags == [.option] ? .talk : flags == [.option, .command] ? .screen : nil else { cancel(); return }
        candidate = key
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let c = self.candidate else { return }
            self.candidate = nil
            self.active = c
            self.onChange(c, true)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (immediate() ? 0 : 0.3), execute: work)
    }

    private func cancel() {
        pending?.cancel()
        pending = nil
        candidate = nil
    }

    /// The physical Option keys (left or right), unaffected by key events VisionCLI posts.
    static var keyDown: Bool {
        CGEventSource.keyState(.hidSystemState, key: 58) || CGEventSource.keyState(.hidSystemState, key: 61)
    }
}

/// The bubble panel. Click-through while following the pointer; interactive when pinned or asking approval.
final class OverlayPanel: NSPanel {
    var interactive = false
    override var canBecomeKey: Bool { interactive }
}

// MARK: - App

/// Which model answers a bubble-mode question: the small fast one or the chosen (strong) one. See smart routing.
enum Lane: String { case fast, strong }

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, BubbleActions {
    let cfg = Config.load()
    let state = OverlayState()
    var panel: OverlayPanel!
    var hosting: NSHostingView<OverlayView>!
    var hotkeys: HotKeys!
    let modifierHold = ModifierHold()
    var listener: Listener!
    let speaker = Speaker()
    var whisper: WhisperEngine?
    var parakeet: ParakeetEngine?
    let flow = FlowDictation()
    let spotlight = Spotlight()
    let autopilot = Autopilot()
    let mascot = Mascot()
    let setupWizard = SetupWizard()
    var installer: ModelInstaller!
    let updater = Updater()
    var sigterm: DispatchSourceSignal?
    let activity = BufferedActivity()
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
    var withScreen = false // this question gets a screenshot (⌥⇧Space, or the "every question" setting)
    var alwaysAllow: [String: Set<String>] = [:] // project → tools approved for the session
    // Computer control (see Control.swift)
    let controlServer = ControlServer()
    let uiElements = UIElements()
    var controlStopped: Date?          // Esc pressed during a task: refuse actions until the next question
    var controlAllowUntil: Date?       // "Allow all" on an action card: no more cards for a while
    var controlLastAction = Date.distantPast
    var pendingControl: ((Bool) -> Void)?
    var controlQueue: [() -> Void] = [] // actions waiting for an approval card to free up
    var controlTarget: NSRunningApplication? // the app the assistant is working in (keys/typing go there)
    let taskHUD = TaskHUD()
    var pausedActions: [(Bool) -> Void] = [] // held while the task is paused; false = cancelled
    let crashWatcher = CrashWatcher()

    var startShot: Shot?
    var region: CGRect?
    var pressedAt = Date()
    var keyPoll: Timer?
    var followTimer: Timer?
    var hideWork: DispatchWorkItem?
    // Answers don't follow the pointer, so their size is only re-measured when the bubble's content changes.
    var stateChanges: AnyCancellable?
    var layoutDirtyUntil = Date.distantPast
    var lastLayout = Date.distantPast

    override init() {
        currentProject = ""
        super.init()
        HomeProject.ensure()
        // Until a project shows up under the pointer, questions go to Home (a launch folder that is a project wins).
        currentProject = cfg.cwd == home.path ? HomeProject.path : cfg.cwd
    }

    /// The last real project questions went to, and when: a question asked away from any project window shortly after
    /// may still be about it (Jev decides), later ones go to Home.
    var lastRealProject: (path: String, at: Date)?
    /// Set at key-down when the window under the pointer belongs to no project: Jev decides project or Home.
    var scopeProject: String?
    var scopeWindow: WinInfo?

    func applicationDidFinishLaunching(_ n: Notification) {
        MainThreadWatchdog.start()
        // Writes to a helper that just exited (claude's stdin is written on a background queue) must fail with an
        // error, not kill the app with SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
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
        listener.onIssue = { [weak self] issue in
            guard let self, self.state.phase == .listening, self.state.question.isEmpty else { return }
            self.state.status = issue // shown in the pill while no text has arrived
        }

        startVoiceEngines()
        startComputerControl()
        startCrashWatcher()
        updater.onAvailable = { [weak self] release in
            guard let self else { return }
            self.state.question = "visioncli"
            self.flash("VisionCLI \(release.version) is available. Install it from VisionCLI menu → Install Update.", seconds: 10)
        }
        updater.onError = { [weak self] message in
            self?.state.question = "visioncli update"
            self?.flash(message, seconds: 12)
        }
        updater.startAutomaticChecks()
        installer = ModelInstaller(cfg: cfg)
        installer.onFinished = { [weak self] kind, error in
            guard let self else { return }
            self.state.question = "visioncli"
            if let error { self.flash(error, seconds: 12); return }
            switch kind {
            case .whisper:
                Settings.sttEngine = "whisper"
                Settings.whisperModel = "small.en"
                self.restartWhisper()
                self.flash("Whisper is installed. Transcription now runs locally.", seconds: 6)
            case .kokoro:
                Settings.ttsEngine = "kokoro"
                Settings.speak = true
                self.kokoro.start()
                self.flash("Kokoro voices are installed. Answers will be read aloud; pick a voice in VisionCLI menu → Settings → Voice & Audio → Voice.", seconds: 8)
            }
        }
        updateStatusTitle()
        refreshCandidates()
        AgyModels.refresh(cfg: cfg)
        if SetupWizard.shouldShow { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showSetupWizard() } }
        // Gemini (Antigravity) takes ~11 s to start: in bubble mode, have it ready before the first question.
        if Settings.assistant == .antigravity && !Settings.terminalMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                self.session(for: self.currentProject).warm()
                if self.routingOn { self.session(for: self.currentProject, lane: .fast).warm() }
            }
        }
        // Candidates are refreshed when the menu opens (menuNeedsUpdate), not on a timer: each refresh runs `ps` and
        // an `lsof` per running CLI.
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
                    self.listener.start { error in log("listen-test: \(error.localizedDescription)") }
                    log("listen-test: started")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        self.listener.stop(done: { text in
                            let size = (self.listener.recordingURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int }) ?? 0
                            log("listen-test: stopped, wav \(size) bytes, heard \"\(text)\"")
                            round(n - 1)
                        })
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

        // Debug: `--test-download` fetches the small Kokoro voices file through the installer (progress, save, finish).
        if CommandLine.arguments.contains("--test-download") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.installer.onFinished = { kind, error in log("test-download finished: \(kind.rawValue) error=\(error ?? "none")") }
                self.installer.debugDownload([ModelInstaller.kokoroFiles[1]])
                Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { t in
                    if let s = self.installer.status { log("test-download status: \(s)") } else { t.invalidate() }
                }
            }
        }

        // Debug: `--demo-answer` shows a sample answer with a mermaid diagram and screen drawings (rendering check).
        if CommandLine.arguments.contains("--demo-answer") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                if let w = Screen.windowUnderPointer(), let shot = try? Screen.capture(window: w) { self.currentShots = [shot] }
                else if let shot = try? Screen.capture(rect: CGRect(origin: .zero, size: NSScreen.screens[0].frame.size)) { self.currentShots = [shot] }
                log("demo: \(self.currentShots.first?.label ?? "no screenshot")")
                let W = Int(self.currentShots.first?.pixelSize.width ?? 1200), H = Int(self.currentShots.first?.pixelSize.height ?? 800)
                self.state.question = "How are orders and payments related?"
                self.state.project = "demo"
                self.state.raw = """
                Each order can have several payments; a payment always points back to one order through `order_id`.
                ```mermaid
                erDiagram
                  ORDERS ||--o{ PAYMENTS : "paid by"
                  ORDERS { int id  decimal total }
                  PAYMENTS { int id  int order_id  decimal amount }
                ```
                Start at the order [[step:1:\(W/6),\(H/5):1:Order]], follow it [[arrow:1:\(W/6),\(H/5 + 30),\(W/6),\(H*3/4 - 40):order_id]] to the payment [[circle:1:\(W/12),\(H*3/4 - 30),\(W/4 + 40),\(H*3/4 + 40):Payment]] [[step:1:\(W/4 + 70),\(H*3/4):2:Refunds too]] [[box:1:\(W*3/5),\(H/10),\(W*9/10),\(H/10 + 70):Totals]].
                """
                self.set(.thinking)
                self.finish(result: self.state.raw, error: nil)
                self.state.pinned = false
            }
        }

        // Debug: `--test-update` checks GitHub and installs a newer release without dialogs.
        if CommandLine.arguments.contains("--test-update") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.updater.check(manual: true) { release in
                    log("test-update: running \(Updater.currentVersion), latest newer release: \(release?.version ?? "none")")
                    if release != nil { self.updater.install() }
                }
            }
        }

        // Debug: `--ask "question"` runs a question through the normal pipeline (no voice), to test assistants end to end.
        if let i = CommandLine.arguments.firstIndex(of: "--ask"), i + 1 < CommandLine.arguments.count {
            let question = CommandLine.arguments[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                log("debug ask (\(Settings.assistant.binary), \(Settings.terminalMode ? "terminal" : "bubble")): \(question)")
                self.state.question = question
                self.set(.thinking)
                if !Settings.terminalMode { self.session(for: self.currentProject).warm(); if self.routingOn { self.session(for: self.currentProject, lane: .fast).warm() } }
                self.questionReady(question)
            }
        }

        // `visioncli voice` replaces a running instance with SIGTERM; shut the helper processes down too.
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { [weak self] in self?.quit() }
        term.resume()
        sigterm = term

        flow.onText = { [weak self] text in self?.state.question = text }
        mascot.level = { [weak self] in self?.state.level ?? 0 }
        autopilot.claudePath = cfg.claude
        autopilot.isBusy = { [weak self] in self?.state.phase != .hidden }
        if Settings.autopilot { autopilot.start() }
        hotkeys = HotKeys()
        HotKeys.handler = { [weak self] key, pressed in self?.hotkey(key, pressed: pressed) }
        if Computer.isTrusted {
            enableModifierKeys()
        } else {
            // No Accessibility yet: modifier-only keys can't be seen, so use ⌃Space / ⌃⌥Space until it's granted.
            log("hotkeys: no Accessibility permission; using ⌃ and ⌃⌥")
            hotkeys.set(.talk, true)
            hotkeys.set(.screen, true)
        }

        let repaired = repairStalePermissions(force: false)
        if !SetupWizard.shouldShow { // the wizard asks for these one at a time
            SFSpeechRecognizer.requestAuthorization { _ in }
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            if !Screen.hasPermission { CGRequestScreenCaptureAccess() }
        }
        if !repaired.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.state.question = "visioncli"
                self.flash("This version needs you to allow VisionCLI once more (\(repaired.joined(separator: ", "))). Turn it on in the prompt or in System Settings → Privacy & Security; updates keep it from now on.", seconds: 14)
            }
        }

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
        // SwiftUI lays the change out shortly after it's published: keep measuring for a moment after each one.
        stateChanges = state.objectWillChange.sink { [weak self] _ in self?.layoutDirtyUntil = Date().addingTimeInterval(0.3) }
    }

    var frozen: Bool { state.pinned || state.phase == .approval }

    func set(_ phase: Phase) {
        state.phase = phase
        hideWork?.cancel()
        if phase != .listening { spotlight.hide() }
        switch phase {
        case .listening: mascot.show(.listening)
        case .thinking: mascot.show(.thinking)
        default: mascot.hide()
        }
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
        layoutDirtyUntil = Date().addingTimeInterval(0.3)
        lastLayout = .distantPast // place it for the new phase right away
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
        // Only the listening/thinking loader rides the pointer (every frame). Measuring an answer (markdown, diagrams)
        // is the expensive part: do it when its content changed (at most 20 times a second while it streams), else
        // twice a second so it still moves to the screen the pointer is on.
        if frozen || !(state.phase == .listening || state.phase == .thinking) {
            let now = Date(), since = now.timeIntervalSince(lastLayout)
            guard (now < layoutDirtyUntil && since >= 0.05) || since >= 0.5 else { return }
            lastLayout = now
        }
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
            // Answers and approval cards sit in the top-right corner of the pointer's screen (under the task panel
            // if it's showing); only the listening/thinking loader rides the cursor.
            origin = CGPoint(x: vf.maxX - size.width - 12, y: vf.maxY - size.height - 12 - taskHUD.visibleHeight)
            if !state.below { state.below = true } // no tail pointing at the cursor
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
        if key == .talk || key == .point || key == .screen || pressed { log("hotkey \(key) \(pressed ? "down" : "up") in \(state.phase)") }
        switch (key, pressed) {
        case (.talk, true), (.point, true), (.screen, true):
            // Second tap while listening (tap mode) sends the question.
            if state.phase == .listening { finishListening(); return }
            if state.phase == .approval { return }
            startListening(point: key == .point, screen: key == .screen)
        case (.talk, false), (.point, false), (.screen, false):
            keysReleased()
        case (.dismiss, true): dismiss()
        case (.pin, true): togglePin()
        case (.open, true): openFirstReference()
        case (.allow, true): approve(true, always: false)
        default: break
        }
    }

    func startListening(point: Bool, screen: Bool = false) {
        speaker.reset()
        highlight.hide()
        state.pinned = false
        state.question = ""
        state.raw = ""
        state.status = ""
        state.toast = ""
        state.level = 0
        state.regionSelected = false
        state.annotated = []
        startShot = nil
        region = nil
        withScreen = point || screen || Settings.screenshotEveryQuestion
        let external = Settings.sttEngine == "external" // Wispr Flow listens instead of our mic (see FlowDictation)
        // One look at the window list for this press: it decides the project, the spotlight and the screenshot.
        let windows = timed("Screen.windows") { Screen.windows() }
        let window = Screen.windowUnderPointer(in: windows)
        // The bubble and mascot show at once; the microphone opens on the listener's audio queue meanwhile.
        timed("set(.listening)") { set(.listening) }
        pressedAt = Date()
        let started = pressedAt
        listener.start { [weak self] error in
            guard let self else { return }
            if external {
                // Flow only hands over its text when you let go, so Apple's on-device recognizer runs alongside it for
                // the live text near the pointer (and as a fallback if Flow returns nothing).
                log("listener (live preview for Flow) failed: \(error)")
                return
            }
            // Still this press (listening, or already let go and waiting for the transcript).
            guard self.pressedAt == started, self.state.phase == .listening || self.state.phase == .thinking else { return }
            log("listener failed: \(error)")
            self.keyPoll?.invalidate()
            self.keyPoll = nil
            if self.selector.isActive { self.selector.cancel() }
            self.state.question = "Voice"
            // Only blame permissions when macOS actually denied them.
            let micDenied = AVCaptureDevice.authorizationStatus(for: .audio) != .authorized
            let speechDenied = SFSpeechRecognizer.authorizationStatus() != .authorized
            if micDenied || speechDenied {
                self.flash("VisionCLI needs \([micDenied ? "Microphone" : nil, speechDenied ? "Speech Recognition" : nil].compactMap { $0 }.joined(separator: " and ")) access: System Settings → Privacy & Security.", seconds: 10)
            } else {
                self.flash("Couldn't start the microphone (\(error.localizedDescription)). Try again, or pick another mic in VisionCLI menu → Microphone.", seconds: 10)
            }
        }
        timed("warmQuick") { warmQuick() }
        // Screenshot questions: dim everything but the window that will be captured (point mode has its own dimming).
        if withScreen && !point { spotlight.show(window: window) }

        // Work out the project now and warm up its Claude session while the user is still talking.
        terminalContext = nil
        existingClaude = nil
        if let pinned = Settings.pinnedProject { currentProject = pinned }
        else if let raw = Screen.rawWindowUnderPointer(in: windows), raw.isTerminal {
            // Pointing at a terminal: use that tab's folder, and its claude session if one is running there.
            let app = raw.app
            DispatchQueue.global().async {
                let ctx = TerminalProbe.probe(app: app)
                DispatchQueue.main.async {
                    guard let ctx, self.pressedAt == started, self.state.phase == .listening || self.state.phase == .thinking else { return }
                    self.terminalContext = ctx
                    self.currentProject = ctx.project
                    self.lastRealProject = (ctx.project, Date())
                    self.state.project = HomeProject.label(ctx.project)
                    log("terminal context: \(ctx.project)\(ctx.assistant.map { " (\($0.binary) running, session \(ctx.sessionId ?? "?"))" } ?? "")")
                }
            }
        }
        scopeProject = nil
        scopeWindow = window
        if Settings.pinnedProject == nil {
            if let p = timed("project(for:)", { projects.project(for: window) }) {
                currentProject = p
                lastRealProject = (p, Date())
            } else if let last = lastRealProject, Date().timeIntervalSince(last.at) < 600 {
                currentProject = last.path
                scopeProject = last.path // about that project, or general? Jev decides with the question
            } else {
                currentProject = HomeProject.path
            }
        }
        if Settings.terminalMode {
            let project = currentProject
            DispatchQueue.global().async {
                // Also remembered by TerminalProbe, so sending the question moments later doesn't scan again.
                let found = TerminalProbe.find(Settings.assistant, forProject: project)
                DispatchQueue.main.async { if self.pressedAt == started { self.existingClaude = found.map { (project, $0) } } }
            }
        }
        state.project = HomeProject.label(currentProject)
        if !Settings.terminalMode {
            session(for: currentProject).warm()
            if routingOn { session(for: currentProject, lane: .fast).warm() }
            if scopeProject != nil { session(for: HomeProject.path, lane: routingOn ? .fast : .strong).warm() }
        }
        if let window, withScreen {
            DispatchQueue.global().async {
                let shot = try? Screen.capture(window: window)
                DispatchQueue.main.async { if self.state.phase == .listening { self.startShot = shot } }
            }
        }

        if external {
            state.status = "Listening with Wispr Flow…"
            timed("flow.begin") { flow.begin() }
        }

        if point {
            state.status = "Drag around what you mean, or tap ⌥⇧Space for the whole window…"
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
            // ⌥⇧Space holds Space and Option; ⌥ / ⌥⌘ are held on their own (⌃Space without Accessibility).
            let held = point ? space && NSEvent.modifierFlags.contains(.option) : ModifierHold.keyDown
            if !held { self?.keysReleased() }
        }
        RunLoop.main.add(keyPoll!, forMode: .common)
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            guard let self, self.state.phase == .listening, self.pressedAt == started else { return }
            self.finishListening()
        }
    }

    func keysReleased() {
        keyPoll?.invalidate()
        keyPoll = nil
        guard state.phase == .listening else { return }
        // Wispr Flow: letting go always ends the question (Flow has no tap mode here).
        if Settings.sttEngine == "external" {
            if selector.isActive && region == nil { return }
            finishListening()
            return
        }
        // In point mode, keep listening while the user is still dragging.
        if selector.isActive && region == nil { return }
        if Date().timeIntervalSince(pressedAt) < 0.35 {
            // Quick tap: keep listening until the next tap.
            if state.question.isEmpty { state.status = "Listening… tap ⌥ to send" }
            return
        }
        finishListening()
    }

    func finishListening() {
        keyPoll?.invalidate()
        keyPoll = nil
        guard state.phase == .listening else { return }
        if Settings.sttEngine == "external" {
            if selector.isActive { selector.cancel() }
            set(.thinking)
            state.status = "Wispr Flow is transcribing…"
            var preview = state.question.trimmingCharacters(in: .whitespacesAndNewlines)
            listener.stop(done: { final in if !final.isEmpty { preview = final } })
            flow.end { [weak self] text in
                guard let self, self.state.phase == .thinking else { return }
                if !text.isEmpty { log("transcript: apple=\"\(preview)\" flow=\"\(text)\"") }
                let best = text.isEmpty ? preview : text
                if best.isEmpty {
                    self.flash("Wispr Flow didn't type anything. Make sure Flow is running and its push-to-talk key is fn.", seconds: 8)
                    return
                }
                if text.isEmpty { log("flow: no text, using the live preview \"\(preview)\"") }
                self.state.question = best
                self.questionReady(best)
            }
            return
        }
        if selector.isActive { selector.cancel() }
        state.status = "Thinking…"
        set(.thinking)
        let heard = state.question
        let press = pressedAt
        // Local Parakeet/Whisper (better with names and jargon) starts on the WAV as soon as the mic is closed, while
        // Apple's recognizer finishes in parallel; Apple's text is only the fallback when the local engine has nothing.
        let useLocal = (parakeet?.ready ?? false) || (whisper?.ready ?? false)
        var localPending = useLocal       // a local transcription may still come
        var local: (engine: String, text: String?)?
        var apple: String?                // Apple's final, once it's in
        var settled = false
        func decide() {
            guard !settled, state.phase == .thinking, pressedAt == press, !localPending else { return }
            if let local, let text = local.text, !text.isEmpty {
                settled = true
                listener.finishNow() // Apple's late final mustn't replace the question in the bubble
                log("transcript: apple=\"\(apple ?? heard.trimmingCharacters(in: .whitespacesAndNewlines))\" \(local.engine)=\"\(text)\"")
                questionReady(text)
                return
            }
            guard let apple else { return } // the local engine had nothing: wait for Apple's final
            settled = true
            if let local { log("transcript: apple=\"\(apple)\" \(local.engine)=\"\(local.text ?? "nil")\"") } else { log("transcript: \(apple)") }
            questionReady(apple)
        }
        listener.stop(onRecording: { [weak self] wav in
            guard let self, useLocal else { return }
            guard let wav, self.state.phase == .thinking, self.pressedAt == press else { localPending = false; decide(); return }
            if let parakeet = self.parakeet, parakeet.ready {
                self.state.status = "Transcribing…"
                parakeet.transcribe(wav, vocabulary: self.vocabularyWords()) { text in
                    local = ("parakeet", text)
                    localPending = false
                    decide()
                }
            } else if let whisper = self.whisper, whisper.ready {
                self.state.status = "Transcribing…"
                whisper.transcribe(wav, prompt: self.vocabularyPrompt()) { text in
                    local = ("whisper", text)
                    localPending = false
                    decide()
                }
            } else {
                localPending = false
                decide()
            }
        }, done: { final in
            apple = final.isEmpty ? heard.trimmingCharacters(in: .whitespacesAndNewlines) : final
            decide()
        })
    }

    func questionReady(_ text: String) {
        guard !text.isEmpty else {
            highlight.hide()
            state.question = ""
            // Explain *why* nothing was transcribed when we know (permission, Dictation off, …).
            if let issue = listener.lastIssue {
                flash(issue + (whisper == nil ? " Or install Whisper in VisionCLI menu → Settings → Voice & Audio → Speech Recognition." : ""), seconds: 12)
            } else {
                flash("Didn't catch that. Hold ⌥ while you speak.")
            }
            return
        }
        state.question = text
        state.status = withScreen ? "Looking at your screen…" : "Thinking…"
        guard Settings.quickCommands, Self.looksLikeQuickCommand(text) else { routeThenAsk(text); return }
        // Jev first (fast path for simple browser commands); Claude if it isn't a confident quick action.
        let started = Date()
        runQuick(text, timeout: 3) { [weak self] result in
            guard let self, self.state.phase == .thinking, self.state.question == text else { return }
            let handled = result?["handled"] as? Bool ?? false
            log("quick: \(handled ? "handled" : "→ claude") intent=\(result?["intent"] ?? "-") conf=\(result?["confidence"] ?? "-") \(result?["reason"] ?? "") \(Int(Date().timeIntervalSince(started) * 1000))ms")
            guard handled, let message = result?["message"] as? String else { self.captureAndAsk(text); return }
            self.activity.question(text, project: self.currentProject, shots: [])
            self.activity.note("\(message) (Jev, \(Int(Date().timeIntervalSince(started) * 1000))ms)")
            self.state.raw = message
            self.set(.done)
            self.speaker.feed(message, final: true)
            self.history.add(HistoryEntry(date: Date(), project: self.currentProject, question: text, answer: message, screenshots: []))
            self.scheduleHide(after: 4)
        }
    }

    /// Quick (Jev) commands are short browser actions: "open github", "click sign in", "scroll down". Checking that
    /// locally skips a ~1s classifier round trip for everything else, which goes straight to the assistant.
    static func looksLikeQuickCommand(_ text: String) -> Bool {
        var t = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        if text.trimmingCharacters(in: .whitespaces).hasSuffix("?") { return false }
        for prefix in ["hey ", "ok ", "okay ", "please ", "can you ", "could you ", "would you ", "just ", "now "] where t.hasPrefix(prefix) {
            t = String(t.dropFirst(prefix.count))
        }
        let words = t.split(separator: " ")
        guard let first = words.first, words.count <= 12 else { return false }
        let verbs: Set<Substring> = ["open", "go", "search", "google", "find", "click", "press", "tap", "scroll", "type",
                                     "close", "switch", "reload", "refresh", "back", "forward", "play", "pause", "show",
                                     "take", "visit", "launch", "navigate", "select", "choose", "fill", "enter", "submit",
                                     "zoom", "new", "look", "watch", "download", "sign", "log"]
        return verbs.contains(first)
    }

    var quickProc: Process?
    /// Smart routing state: the lane chosen for the next question, and the last question/lane per project (follow-ups).
    var nextLane: Lane = .strong
    var lastLane: [String: (lane: Lane, at: Date, question: String)] = [:]
    var routingOn: Bool { Settings.smartRouting && !Settings.terminalMode && Settings.assistant != .gemini }

    /// Bubble mode: ask Jev (~0.5 s) whether a small fast model can answer, then ask. Terminal mode is unchanged:
    /// questions go to the assistant the user already has open.
    func routeThenAsk(_ text: String) {
        // Away from any project window shortly after using one: is this about that project, or general (Home)?
        let scope = Settings.pinnedProject == nil && terminalContext == nil ? scopeProject : nil
        guard routingOn || scope != nil else { captureAndAsk(text); return }
        var input: [String: Any] = ["question": text]
        if let previous = lastLane[currentProject], Date().timeIntervalSince(previous.at) < 300 {
            input["previous"] = previous.question
            input["previousLane"] = previous.lane.rawValue
        }
        if let scope {
            input["project"] = HomeProject.label(scope)
            if let w = scopeWindow { input["app"] = w.app; input["window"] = w.title }
        }
        guard let json = (try? JSONSerialization.data(withJSONObject: input)).flatMap({ String(data: $0, encoding: .utf8) }) else {
            captureAndAsk(text); return
        }
        let started = Date()
        runQuick(text, timeout: 2.5, args: ["route", json]) { [weak self] result in
            guard let self, self.state.phase == .thinking, self.state.question == text else { return }
            let lane = Lane(rawValue: result?["lane"] as? String ?? "") ?? .strong
            let general = scope != nil && result?["scope"] as? String == "general"
            log("route: \(lane.rawValue)\(scope == nil ? "" : general ? ", general (Home)" : ", project") conf=\(result?["confidence"] ?? "-")\(result?["reason"].map { " (\($0))" } ?? "") \(Int(Date().timeIntervalSince(started) * 1000))ms")
            if general {
                self.currentProject = HomeProject.path
                self.state.project = "Home"
            }
            self.nextLane = lane
            self.captureAndAsk(text)
        }
    }

    /// `visioncli quick <text>` with a hard timeout (killed if slow, so it can't act after Claude took over).
    func runQuick(_ text: String, timeout: Double, args: [String]? = nil, _ done: @escaping ([String: Any]?) -> Void) {
        guard let node = cfg.node, let server = cfg.server else { done(nil); return }
        quickProc?.terminate()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [server] + (args ?? ["quick", text])
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        env["VISIONCLI_FRONT_APP"] = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
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
    /// Terms Parakeet should spell exactly: the project, code-like words in the window title (PaymentController.php →
    /// PaymentController), the user's vocabulary file and common developer names.
    func vocabularyWords() -> [String] {
        var words = [HomeProject.label(currentProject)]
        if let title = Screen.windowUnderPointer()?.title {
            for token in title.components(separatedBy: CharacterSet.alphanumerics.inverted) where token.count >= 4 {
                // CamelCase / snake-ish identifiers only; plain words don't need help.
                if token.dropFirst().contains(where: \.isUppercase) { words.append(token) }
            }
        }
        if let custom = try? String(contentsOf: Settings.vocabularyFile, encoding: .utf8) {
            words += custom.components(separatedBy: CharacterSet(charactersIn: ",\n")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        words += ["VisionCLI", "Laravel", "SwiftUI", "Xcode", "TypeScript", "JavaScript", "GitHub", "kubectl", "Postgres", "MySQL",
                  "Redis", "Docker", "Kubernetes", "Next.js", "Node.js", "npm", "PhpStorm", "Tailwind", "GraphQL", "Webpack", "Vite"]
        var seen = Set<String>()
        return words.filter { seen.insert($0.lowercased()).inserted }.prefix(80).map { $0 }
    }

    func vocabularyPrompt() -> String {
        var words = [HomeProject.label(currentProject)]
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

    func captureAndAsk(_ text: String) {
        let region = self.region, startShot = self.startShot
        // Text only: no image tokens. The window's name goes along so the assistant can decide to `look` itself.
        guard withScreen else {
            highlight.hide()
            ask(text, shots: [], window: Screen.windowUnderPointer())
            return
        }
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

    func session(for project: String, lane: Lane = .strong) -> AssistantSession {
        let lane = Settings.assistant == .gemini ? .strong : lane // Gemini CLI has no fast lane
        let key = "\(Settings.assistant.rawValue):\(lane.rawValue):\(project)"
        if let s = sessions[key] { return s }
        let s: AssistantSession
        switch Settings.assistant {
        case .claude: s = ClaudeSession(cwd: project, cfg: cfg, lane: lane)
        case .antigravity: s = AgySession(cwd: project, cfg: cfg, lane: lane)
        case .gemini: s = GeminiSession(cwd: project, cfg: cfg)
        }
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
            self.speaker.feed(Diagrams.speakable(self.state.answer), final: false)
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
        if sessions.count >= 4, let (victimKey, victim) = sessions.first(where: { $0.value !== current && !$0.value.busy }) {
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

    func ask(_ question: String, shots: [Shot], window: WinInfo? = nil) {
        taskHUD.reset(title: question.count > 40 ? String(question.prefix(40)) + "…" : question)
        var question = question
        if let crash = crashWatcher.recent {
            let mins = max(1, Int(Date().timeIntervalSince(crash.date) / 60))
            question += "\n(If relevant: \(crash.app) crashed \(mins) min ago; crash report at \(crash.file.path).)"
        }
        // A terminal the user pointed at wins; otherwise the window the pointer ended on decides the project.
        if let pinned = Settings.pinnedProject { currentProject = pinned }
        else if let ctx = terminalContext { currentProject = ctx.project }
        else if let p = projects.project(for: shots.last?.window ?? window) { currentProject = p; lastRealProject = (p, Date()) }
        state.project = HomeProject.label(currentProject)
        let saved = history.save(shots)
        currentShots = saved
        writeShotMap(saved)
        history.waitForWrites() // screenshots are written in the background; the assistant reads them next
        controlStopped = nil // a new question re-enables computer control after an Esc stop
        currentWindow = saved.last?.window ?? window ?? currentWindow
        let noShot = "No screenshot attached (to save tokens it's only sent when asked for)" + (window.map { "; the mouse is over \($0.label)" } ?? "")
            + ". If answering needs the screen, call mcp__visioncli__look (or ui_elements / browser_read, cheaper as text)."

        var context = ["Project: \(currentProject)."]
        for (i, shot) in saved.enumerated() {
            var line = "Image \(i + 1): \(shot.label), \(Int(shot.pixelSize.width))x\(Int(shot.pixelSize.height)) px"
            if let p = shot.pointer { line += ", mouse pointer at (\(Int(p.x)), \(Int(p.y)))" } else { line += ", pointer not over it" }
            if let f = shot.file { line += ", saved at \(f.path)" }
            context.append(line + ".")
        }
        if saved.isEmpty { context.append(noShot) }
        let text = "\(question)\n\n[Voice question. \(context.joined(separator: " "))]"

        activity.question(question, project: currentProject, shots: saved)

        if Settings.terminalMode {
            // The CLI running in the tab the user pointed at wins; otherwise the chosen assistant.
            let assistant = terminalContext?.assistant ?? Settings.assistant
            // "slash model haiku" / "/compact": a CLI command, typed as-is so the CLI runs it.
            if let cmd = Self.slashCommand(question) {
                let t = terminal(for: currentProject, assistant: assistant)
                if let ctx = terminalContext, ctx.assistant == assistant, let tab = ctx.itermSession {
                    t.claudeCwd = ctx.cwd
                    t.attach(itermSession: tab, sessionId: ctx.sessionId)
                }
                let asked = state.question
                t.command(cmd) { [weak self] sent in
                    // Esc or a new question while it was being sent: leave the bubble alone.
                    guard let self, self.state.phase == .thinking, self.state.question == asked else { return }
                    if sent {
                        self.state.raw = "Sent \(cmd) to \(assistant.name)."
                        self.set(.done)
                        self.scheduleHide(after: 3)
                    } else {
                        self.finish(result: nil, error: "No \(assistant.name) is running in a terminal for this project, so \(cmd) wasn't sent.")
                    }
                }
                return
            }
            let gemini = assistant == .gemini
            let briefInstructions = assistant != .claude // no system prompt in gemini/agy interactive mode
            let paths = gemini ? geminiAttachable(saved) : saved.compactMap { $0.file?.path }
            // A short tag the user sees in their terminal: the CLI already runs in the project, and VisionCLI's MCP
            // instructions tell it when to `look`, so only what it can't know goes here.
            var parts: [String] = []
            for (i, shot) in saved.enumerated() {
                var p = "screenshot \(i < paths.count ? (gemini ? "@\(paths[i]) " : paths[i]) : shot.label)"
                if let pt = shot.pointer { p += " (mouse at \(Int(pt.x)),\(Int(pt.y)))" }
                parts.append(p)
            }
            // Only when the mouse really is over another app: over the terminal itself there's nothing to point at
            // (the fallback to the front-most other window is for screenshots, not for this hint).
            if saved.isEmpty, let under = Screen.rawWindowUnderPointer(), !under.isTerminal { parts.append("mouse over \(under.label)") }
            // Gemini can't take a system prompt in its interactive mode, so the voice instructions ride along.
            if briefInstructions { parts.append(assistant == .antigravity && !saved.isEmpty ? "View the screenshot file(s) first. " : ""); parts.append("Asked out loud: the reply is also shown in a bubble on screen and read aloud, so answer in plain text, under about 100 words; \"this\" means what's under the pointer; cite files as path:line; for flows or relationships you may add one small ```mermaid diagram; put any [[box/arrow/circle/step]] drawing markers on the last line.") }
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
            t.ask("\(question) [voice\(parts.isEmpty ? "" : " · ")\(parts.joined(separator: " · "))]")
            return
        }
        currentTerminal = nil

        if Settings.autoActivity && !activityShown {
            activityShown = true
            TerminalLauncher.showActivity()
        }

        let lane = routingOn ? nextLane : .strong
        nextLane = .strong
        let s = session(for: currentProject, lane: lane)
        // Switching lanes changes conversations: carry the last couple of exchanges over so follow-ups make sense.
        var sendText = text
        if routingOn, let last = lastLane[currentProject], last.lane != lane, Date().timeIntervalSince(last.at) < 1800 {
            let recent = history.entries.filter { $0.project == currentProject }.prefix(2).reversed()
            if !recent.isEmpty {
                sendText = "Earlier in this conversation (for context):\n"
                    + recent.map { "User: \($0.question.prefix(300))\nAssistant: \($0.answer.prefix(500))" }.joined(separator: "\n")
                    + "\n\n" + text
            }
        }
        lastLane[currentProject] = (lane, Date(), question)
        if lane == .fast { log("route: fast lane (\(Settings.assistant == .claude ? "Haiku" : AgyModels.fastest))") }
        current = s
        state.raw = ""
        state.status = "Thinking…"
        if state.phase != .thinking { set(.thinking) }
        s.send(text: sendText, shots: saved)
    }

    /// A spoken or typed CLI command: "/model haiku", "Slash model haiku." → "/model haiku".
    static func slashCommand(_ question: String) -> String? {
        var q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = q.last, ".?!,".contains(last) { q.removeLast() }
        let lower = q.lowercased()
        if lower.hasPrefix("slash ") { q = "/" + q.dropFirst(6) }
        else if lower.hasPrefix("forward slash ") { q = "/" + q.dropFirst(14) }
        guard q.hasPrefix("/"), q.count > 1, q.count < 60, !q.contains("\n") else { return nil }
        let parts = q.split(separator: " ", maxSplits: 1)
        let name = parts[0].lowercased().replacingOccurrences(of: ",", with: "")
        return parts.count > 1 ? "\(name) \(parts[1].lowercased())" : name
    }

    func finish(result: String?, error: String?) {
        log("answer: \(error.map { "ERROR " + $0 } ?? (result ?? "").replacingOccurrences(of: "\n", with: " ").prefix(300).description)")
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
        speaker.feed(Diagrams.speakable(state.answer), final: true)

        // Drawings go on the real screen, over the thing the answer is about (the answer itself sits in the corner).
        let marks = Markup.marks(in: state.raw)
        if !marks.isEmpty, !currentShots.isEmpty {
            let items: [DrawItem] = marks.map { mark in
                let shot = currentShots[min(max(mark.image, 1), currentShots.count) - 1]
                return DrawItem(kind: mark.kind, a: shot.screenPoint(forImagePoint: mark.a),
                                b: shot.screenPoint(forImagePoint: mark.b), label: mark.label)
            }
            highlight.draw(items, for: 25)
            log("drawing \(marks.count) mark(s) on screen")
        }

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
            speaker.feed(Diagrams.speakable(state.answer), final: true, force: true)
        }
    }

    func showHistory() { historyWindow.show(store: history, project: currentProject) }

    func dismiss() {
        if controlActive {
            stopComputerControl()
            if let s = current, s.busy { s.stop() }
            return
        }
        if state.phase == .approval { approve(false, always: false); return }
        if selector.isActive { selector.cancel() }
        flow.cancel()
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
        if let done = pendingControl { pendingControl = nil; finishControlApproval(allow, always: always, done: done); return }
        guard let req = state.permission, let s = current else { return }
        if always { alwaysAllow[s.cwd, default: []].insert(req.tool) }
        (s as? AgySession)?.keepRule = always
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
        UsageTracker.shared.onChange = { [weak self] in self?.updateStatusTitle() }
        UsageTracker.shared.scanToday()
        // Fresh limits on launch if what we have is old (a tiny Haiku request); replies keep them current after that.
        if Date().timeIntervalSince(UsageTracker.shared.updated ?? .distantPast) > 3 * 3600 { UsageTracker.shared.refresh(claude: cfg.claude) }
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.updateStatusTitle() } // resets roll over
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        syncModelFromTerminal()
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
        submenu("Project: \(HomeProject.label(currentProject))\(Settings.pinnedProject != nil ? " (pinned)" : "")", in: menu) { m in
            item("Auto: follow the window under the pointer", #selector(pickProject(_:)), in: m, on: Settings.pinnedProject == nil)
            item("Home: general questions, no project", #selector(pickProject(_:)), in: m,
                 on: Settings.pinnedProject == HomeProject.path, value: HomeProject.path)
            m.addItem(.separator())
            var seen: Set<String> = [HomeProject.path]
            func add(_ path: String, note: String) {
                guard !path.isEmpty, seen.insert(path).inserted else { return }
                let shortPath = path.replacingOccurrences(of: home.path, with: "~")
                item("\((path as NSString).lastPathComponent)   \(note)\(shortPath)", #selector(pickProject(_:)), in: m,
                     on: Settings.pinnedProject == path, value: path)
            }
            for r in candidates.running { add(r.project, note: "\(r.assistant.binary) running · ") }
            for p in candidates.windows { add(p, note: "open · ") }
            for p in [currentProject] + Array(Set(history.entries.prefix(50).map(\.project))).sorted() + terminals.values.map(\.project).sorted() + sessions.values.map(\.cwd).sorted() {
                add(p, note: "recent · ")
            }
            if seen.isEmpty { item("No projects found yet", nil, in: m) }
            m.addItem(.separator())
            item("Choose Folder…", #selector(chooseProjectFolder), in: m)
        }
        usageItems(in: menu, item: item)
        // Everyday items stay at the top level; everything else is gathered under Settings.
        let settingsMenu = NSMenu()
        submenu(Settings.autopilot ? "Autopilot: On (\(autopilot.calls)/\(Autopilot.hourlyCap) checks this hour)" : "Autopilot: Off", in: settingsMenu) { m in
            item(Settings.autopilot ? "Turn Off" : "Turn On…", #selector(toggleAutopilot), in: m)
            item("Check Now", Settings.autopilot ? #selector(autopilotCheckNow) : nil, in: m)
            m.addItem(.separator())
            item("Watch only these apps:", nil, in: m)
            let mine = Bundle.main.bundleIdentifier
            var apps: [(String, String)] = NSWorkspace.shared.runningApplications.compactMap { a in
                guard a.activationPolicy == .regular, let id = a.bundleIdentifier, id != mine,
                      !Autopilot.skipBundles.contains(id), !terminalApps.contains((a.localizedName ?? "").lowercased()) else { return nil }
                return (a.localizedName ?? id, id)
            }
            for id in Settings.autopilotApps where !apps.contains(where: { $0.1 == id }) { apps.append((id, id)) }
            var seenIds = Set<String>()
            apps = apps.filter { seenIds.insert($0.1).inserted }.sorted { $0.0.localizedCaseInsensitiveCompare($1.0) == .orderedAscending }
            for (name, id) in apps {
                item(name, #selector(toggleAutopilotApp(_:)), in: m, on: Settings.autopilotApps.contains(id), value: id)
            }
        }
        if let status = updater.status { item(status, nil, in: menu) }
        else if let release = updater.available { item("Install Update (\(release.version))…", #selector(installUpdate), in: menu) }
        if !Screen.hasPermission { item("Grant Screen Recording…", #selector(openScreenSettings), in: menu) }
        menu.addItem(.separator())

        submenu("Assistant: \(Settings.assistant.appName)", in: settingsMenu) { m in
            for a in [Assistant.claude, .antigravity] {
                let installed: Bool
                switch a {
                case .claude: installed = FileManager.default.isExecutableFile(atPath: cfg.claude)
                case .antigravity: installed = cfg.agy != nil
                case .gemini: installed = cfg.gemini != nil
                }
                item(a.appName + (installed ? "" : " (not installed)"), installed ? #selector(chooseAssistant(_:)) : nil, in: m,
                     on: Settings.assistant == a, value: a.rawValue)
            }
            m.addItem(.separator())
            item("A terminal running claude or agy is used as-is when you point at it.", nil, in: m)
        }

        // How answers are delivered
        submenu("Answer In", in: settingsMenu) { m in
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

        submenu(Settings.assistant == .antigravity ? "Model" : "Model: \(MenuLabels.claudeModel(cfg.model ?? Settings.model))", in: settingsMenu) { m in
            if Settings.assistant == .antigravity {
                item("Default (from your agy settings)", #selector(chooseAgyModel(_:)), in: m, on: Settings.agyModel == nil)
                m.addItem(.separator())
                let models = AgyModels.cached
                if models.isEmpty { item("Loading models from agy…", nil, in: m) }
                for model in models {
                    item(model.name, #selector(chooseAgyModel(_:)), in: m, on: Settings.agyModel == model.id, value: model.id)
                }
            } else {
                let model = cfg.model ?? Settings.model
                for (alias, label) in MenuLabels.claudeModels {
                    if alias == "opusplan" { m.addItem(.separator()) }
                    item(label, cfg.model == nil ? #selector(chooseClaudeModel(_:)) : nil, in: m, on: model == alias, value: alias)
                }
                if cfg.model != nil { item("(set by VISIONCLI_MODEL)", nil, in: m) }
            }
        }

        submenu("Effort: \(MenuLabels.effort(Settings.effort))", in: settingsMenu) { m in
            for level in [nil, "low", "medium", "high", "xhigh", "max"] as [String?] {
                item(MenuLabels.effort(level) + (level == nil ? " (the CLI's own setting)" : ""), #selector(chooseEffort(_:)), in: m,
                     on: Settings.effort == level, value: level)
            }
            m.addItem(.separator())
            item("Applies to Claude and Gemini; higher is slower but more thorough.", nil, in: m)
        }


        let controlNames = ["ask": "Ask Before Each Action", "auto": "Allow All Actions", "off": "Off"]
        submenu("Computer Control: \(controlNames[Settings.computerControl] ?? "Ask")", in: settingsMenu) { m in
            for mode in ["ask", "auto", "off"] {
                item(controlNames[mode]!, #selector(chooseComputerControl(_:)), in: m, on: Settings.computerControl == mode, value: mode)
            }
            m.addItem(.separator())
            if Computer.isTrusted { item("✓ Accessibility permission granted", nil, in: m) }
            else { item("Grant Accessibility Permission…", #selector(grantAccessibility), in: m) }
            item("Passwords, payments and System Settings always ask. Esc stops it.", nil, in: m)
            m.addItem(.separator())
            item("Watch for App Crashes", #selector(toggleWatchCrashes), in: m, on: Settings.watchCrashes)
        }

        submenu("Voice & Audio", in: settingsMenu) { m in
            if let status = installer?.status { item(status, nil, in: m); m.addItem(.separator()) }
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
                if !ModelInstaller.kokoroInstalled {
                    v.addItem(.separator())
                    item(installer?.isBusy == true ? "Installing…" : "Download Natural Voices (Kokoro, ~350 MB)…",
                         installer?.isBusy == true ? nil : #selector(installKokoro), in: v)
                }
            }
            submenu("Speech Recognition", in: m) { r in
                if ParakeetEngine.binary != nil {
                    item("Parakeet (local, fastest, knows your project's names)" + (parakeet != nil && parakeet?.ready != true ? " · loading…" : ""),
                         #selector(chooseParakeet), in: r, on: parakeet != nil)
                }
                item(FlowDictation.isInstalled ? "Wispr Flow (your Flow account)" : "Wispr Flow (not installed)",
                     FlowDictation.isInstalled ? #selector(chooseExternalDictation) : nil, in: r, on: Settings.sttEngine == "external")
                let models = VoiceModels.whisperModels()
                for (name, _) in models {
                    item("Whisper \(name) (local)", #selector(chooseWhisper(_:)), in: r,
                         on: parakeet == nil && Settings.sttEngine != "apple" && Settings.sttEngine != "external" && (whisper?.modelName ?? Settings.whisperModel) == name, value: name)
                }
                if models.isEmpty || VoiceModels.binary("whisper-server", path: cfg.path) == nil {
                    item(installer?.isBusy == true ? "Installing…" : "Download Whisper (better accuracy, ~490 MB)…",
                         installer?.isBusy == true ? nil : #selector(installWhisper), in: r)
                }
                item("Apple (on-device)", #selector(chooseWhisper(_:)), in: r, on: Settings.sttEngine == "apple" || (whisper == nil && parakeet == nil && Settings.sttEngine != "external"))
                r.addItem(.separator())
                item("Edit Vocabulary…", #selector(editVocabulary), in: r)
            }
            m.addItem(deviceMenu(title: "Microphone", input: true))
            m.addItem(deviceMenu(title: "Speaker", input: false))
        }

        item("History…", #selector(showHistoryMenu), in: menu, key: "y")
        item("New Conversation", #selector(newConversation), in: menu, key: "n")
        item("Copy Last Answer", #selector(copyAnswerMenu), in: menu, key: "c")
        menu.addItem(.separator())

        submenu("Settings", in: menu) { m in
            for i in settingsMenu.items { settingsMenu.removeItem(i); m.addItem(i) }
            m.addItem(.separator())
            item("Setup Wizard…", #selector(showSetupWizard), in: m)
            item("Start at Login", #selector(toggleLogin), in: m, on: LoginItem.isEnabled)
            item("Check for Updates… (v\(Updater.currentVersion))", #selector(checkForUpdates), in: m)
            submenu("More", in: m) { more in
                item("Screenshot Every Question (uses more tokens)", #selector(toggleScreenshotEvery), in: more, on: Settings.screenshotEveryQuestion)
                item("Fast Model for Simple Questions (Bubble Only)", #selector(toggleSmartRouting), in: more, on: Settings.smartRouting)
                item("Check for Updates Automatically", #selector(toggleAutoUpdate), in: more, on: Settings.autoUpdate)
                item("Instant Browser Commands (Jev)", #selector(toggleQuick), in: more, on: Settings.quickCommands)
                item("Show AI Cursor in Browser", #selector(toggleGhost), in: more, on: !FileManager.default.fileExists(atPath: ghostOffFile.path))
                item("API Keys (TypeSafe for Jev, Gemini)…", #selector(openIntegrations), in: more)
                more.addItem(.separator())
                item("Set Up Claude Code (MCP tools)…", #selector(setupClaudeCode as () -> Void), in: more)
                item("Set Up Antigravity CLI (MCP tools)…", cfg.agy == nil ? nil : #selector(setupAgy), in: more)
                item("Fix Permissions…", #selector(fixPermissions), in: more)
                more.addItem(.separator())
                item("Open Log", #selector(openLog), in: more)
                if ((try? FileManager.default.attributesOfItem(atPath: CrashReporter.logURL.path)[.size] as? Int) ?? 0) > 0 {
                    item("Open Crash Log", #selector(openCrashLog), in: more)
                }
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

    /// Project name next to the menu-bar icon.
    /// Claude plan usage at the top of the menu, with a submenu to refresh it or hide it from the menu bar.
    func usageItems(in menu: NSMenu, item: (String, Selector?, NSMenu, String, Bool, Any?) -> NSMenuItem) {
        let u = UsageTracker.shared
        u.scanToday()
        let s = u.percent(u.session), w = u.percent(u.week)
        let sub = NSMenu()
        let card = NSMenuItem()
        let host = NSHostingView(rootView: UsageCard(
            session: s.flatMap { p in u.session.map { (p, $0.resetsAt) } }, week: w.flatMap { p in u.week.map { (p, $0.resetsAt) } },
            today: u.today, updated: u.updated))
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        card.view = host
        sub.addItem(card)
        sub.addItem(.separator())
        item("Refresh Usage", #selector(refreshUsage), sub, "", false, nil).image = UsageArt.symbol("arrow.clockwise")
        item("Show Session in Menu Bar", #selector(toggleUsageInMenuBar), sub, "", Settings.usageInMenuBar, nil).image = UsageArt.symbol("menubar.rectangle")
        item("Show Weekly in Menu Bar", Settings.usageInMenuBar ? #selector(toggleWeeklyInMenuBar) : nil, sub, "", Settings.weeklyInMenuBar, nil).image = UsageArt.symbol("calendar")
        let i = NSMenuItem(title: s != nil && w != nil ? "Claude Usage: \(s!)% session · \(w!)% week" : "Claude Usage", action: nil, keyEquivalent: "")
        i.image = (max(s ?? 0, w ?? 0) >= 80 ? UsageArt.symbol("exclamationmark.triangle.fill") : UsageArt.symbol("gauge.with.dots.needle.33percent", fallback: "gauge"))
        i.submenu = sub
        menu.addItem(i)
    }

    @objc func refreshUsage() { UsageTracker.shared.refresh(claude: cfg.claude) }
    @objc func toggleWeeklyInMenuBar() {
        Settings.weeklyInMenuBar.toggle()
        updateStatusTitle()
    }
    @objc func toggleUsageInMenuBar() {
        Settings.usageInMenuBar.toggle()
        updateStatusTitle()
    }

    func updateStatusTitle() {
        let name = HomeProject.label(currentProject)
        let title = " " + (name.count > 18 ? String(name.prefix(17)) + "…" : name)
        let u = UsageTracker.shared
        if Settings.usageInMenuBar, let sp = u.percent(u.session), let wp = u.percent(u.week) {
            // Colored rings: the current 5-hour session, plus the week when turned on.
            statusItem?.button?.attributedTitle = UsageArt.barTitle(prefix: title, session: sp, week: Settings.weeklyInMenuBar ? wp : nil)
            statusItem?.button?.toolTip = "VisionCLI · Claude usage: \(sp)% of this 5-hour session, \(wp)% of this week"
        } else {
            statusItem?.button?.title = title
            statusItem?.button?.font = NSFont.menuBarFont(ofSize: 0)
            statusItem?.button?.toolTip = "VisionCLI"
        }
    }

    /// Refresh the Project menu's candidates in the background (running claude/gemini sessions, open editor windows).
    /// The process scan and the window list are taken off the main thread; mapping window titles to projects uses
    /// the resolver's index, which belongs to main.
    func refreshCandidates() {
        DispatchQueue.global(qos: .utility).async {
            let running = TerminalProbe.runningProjects()
            let windows = Screen.windows().filter { !$0.isTerminal }
            DispatchQueue.main.async {
                var open: [String] = []
                for w in windows {
                    if let p = self.projects.project(for: w), !open.contains(p) { open.append(p) }
                }
                self.candidates = (running, open)
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

    @objc func toggleAutoUpdate() { Settings.autoUpdate.toggle() }

    /// macOS ties permissions to the code signature. After a signature change (e.g. moving to the permanently
    /// signed releases) the old switch stays "on" in System Settings but no longer applies, and toggling it often
    /// doesn't help. Clearing VisionCLI's own stale entries lets macOS register the current version cleanly.
    /// Runs once per version, only for permissions that aren't actually in effect.
    @discardableResult
    func repairStalePermissions(force: Bool) -> [String] {
        let version = Updater.currentVersion
        guard force || UserDefaults.standard.string(forKey: "permissionRepairVersion") != version else { return [] }
        UserDefaults.standard.set(version, forKey: "permissionRepairVersion")
        var services: [(String, String)] = []
        if force || !Screen.hasPermission { services.append(("ScreenCapture", "Screen Recording")) }
        if force || AVCaptureDevice.authorizationStatus(for: .audio) == .denied { services.append(("Microphone", "Microphone")) }
        if force || SFSpeechRecognizer.authorizationStatus() == .denied { services.append(("SpeechRecognition", "Speech Recognition")) }
        if force { services.append(("AppleEvents", "Automation")) }
        let bundle = Bundle.main.bundleIdentifier ?? "dev.visioncli.overlay"
        for (service, _) in services { shell("/usr/bin/tccutil", ["reset", service, bundle]) }
        if !services.isEmpty { log("permissions: cleared stale \(services.map(\.0)) for \(bundle)") }
        return services.map(\.1)
    }

    @objc func fixPermissions() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Fix VisionCLI's permissions?"
        alert.informativeText = "This clears VisionCLI's Screen Recording, Microphone, Speech Recognition and Automation entries (only VisionCLI's) so macOS asks again for this version. Use it if System Settings shows VisionCLI as allowed but it still asks or can't see the screen."
        alert.addButton(withTitle: "Fix Permissions")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        repairStalePermissions(force: true)
        SFSpeechRecognizer.requestAuthorization { _ in }
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc func checkForUpdates() {
        updater.check(manual: true) { [weak self] release in
            guard let self else { return }
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            if let release {
                alert.messageText = "VisionCLI \(release.version) is available"
                alert.informativeText = "You have \(Updater.currentVersion). Install now? VisionCLI will restart; your permissions and settings are kept."
                alert.addButton(withTitle: "Install Update")
                alert.addButton(withTitle: "Release Notes")
                alert.addButton(withTitle: "Later")
                switch alert.runModal() {
                case .alertFirstButtonReturn: self.updater.install()
                case .alertSecondButtonReturn: NSWorkspace.shared.open(release.page)
                default: break
                }
            } else {
                alert.messageText = "VisionCLI is up to date"
                alert.informativeText = "You have the latest version (\(Updater.currentVersion))."
                alert.runModal()
            }
        }
    }

    @objc func installUpdate() {
        guard let release = updater.available else { return }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Install VisionCLI \(release.version)?"
        alert.informativeText = "VisionCLI will download the update, check its signature, replace itself and restart. Your permissions and settings are kept."
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { updater.install() }
    }

    @objc func installWhisper() { installer.installWhisper() }
    @objc func installKokoro() { installer.installKokoro() }

    @objc func chooseSpeed(_ sender: NSMenuItem) {
        guard let x = sender.representedObject as? Double else { return }
        Settings.speechSpeed = x
        testSpeaker()
    }

    /// Register the bundled MCP server with Claude Code for all projects (`claude mcp add --scope user`).
    /// `then` runs after the result alert is closed (the `claude mcp` commands run in the background first).
    @objc func setupClaudeCode() { setupClaudeCode(then: {}) }

    func setupClaudeCode(then: @escaping () -> Void) {
        let alert = NSAlert()
        if let node = cfg.node, let server = cfg.server, FileManager.default.isExecutableFile(atPath: cfg.claude) {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = cfg.path
            let claude = cfg.claude
            DispatchQueue.global(qos: .userInitiated).async {
                shell(claude, ["mcp", "remove", "visioncli", "-s", "user"], env: env)
                let (status, out, err) = shell(claude, ["mcp", "add", "visioncli", "--scope", "user", "--", node, server], env: env)
                DispatchQueue.main.async {
                    alert.messageText = status == 0 ? "Claude Code is set up" : "Couldn't set up Claude Code"
                    alert.informativeText = status == 0
                        ? "visioncli's tools (look at screen, browser, database…) are now available in every Claude Code project. Restart any running `claude` sessions to load them.\n\nFor screenshots when typing in Claude Code, give your terminal app Screen Recording access too (System Settings → Privacy & Security)."
                        : (err.isEmpty ? out : err)
                    NSApp.activate(ignoringOtherApps: true)
                    alert.runModal()
                    then()
                }
            }
            return
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
        then()
    }

    /// Connects VisionCLI's MCP tools to one CLI without any dialogs (for the setup wizard). Calls back on main with
    /// nil on success, or what went wrong.
    func connectTools(_ a: Assistant, done: @escaping (String?) -> Void) {
        guard let node = cfg.node, let server = cfg.server else { done("Needs Node.js 18 or later (nodejs.org)."); return }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        let claude = cfg.claude, gemini = cfg.gemini, agy = cfg.agy
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: String?
            switch a {
            case .claude:
                shell(claude, ["mcp", "remove", "visioncli", "-s", "user"], env: env)
                let (status, out, err) = shell(claude, ["mcp", "add", "visioncli", "--scope", "user", "--", node, server], env: env)
                if status != 0 { failure = err.isEmpty ? out : err }
            case .gemini:
                guard let gemini else { failure = "Gemini CLI isn't installed."; break }
                shell(gemini, ["mcp", "remove", "-s", "user", "visioncli"], env: env)
                let (status, out, err) = shell(gemini, ["mcp", "add", "-s", "user", "--trust", "visioncli", node, server], env: env)
                if status != 0 { failure = err.isEmpty ? out : err }
            case .antigravity:
                if agy == nil { failure = "Antigravity isn't installed."; break }
                do { try AgySetup.install(node: node, server: server) } catch { failure = error.localizedDescription }
            }
            DispatchQueue.main.async { done(failure?.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }
    }

    /// Are VisionCLI's tools already registered with this CLI? Slow (runs the CLI): call off the main thread.
    func toolsConnected(_ a: Assistant) -> Bool {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        switch a {
        case .claude:
            guard FileManager.default.isExecutableFile(atPath: cfg.claude) else { return false }
            return shell(cfg.claude, ["mcp", "get", "visioncli"], env: env).0 == 0
        case .gemini:
            guard let gemini = cfg.gemini else { return false }
            return shell(gemini, ["mcp", "list"], env: env).1.contains("visioncli")
        case .antigravity:
            let config = home.appendingPathComponent(".gemini/config/mcp_config.json")
            return (try? String(contentsOf: config, encoding: .utf8))?.contains("visioncli") ?? false
        }
    }

    func isInstalled(_ a: Assistant) -> Bool {
        switch a {
        case .claude: return FileManager.default.isExecutableFile(atPath: cfg.claude)
        case .antigravity: return cfg.agy != nil
        case .gemini: return cfg.gemini != nil
        }
    }

    @objc func chooseEffort(_ sender: NSMenuItem) {
        Settings.effort = sender.representedObject as? String
        log("effort: \(Settings.effort ?? "default")")
        if let level = Settings.effort { propagate("/effort \(level)") }
    }

    @objc func chooseAgyModel(_ sender: NSMenuItem) {
        Settings.agyModel = sender.representedObject as? String
        log("agy model: \(Settings.agyModel ?? "default")")
    }

    @objc func chooseAssistant(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let a = Assistant(rawValue: raw) else { return }
        Settings.assistant = a
        log("assistant: \(a.appName)")
    }

    /// Register the MCP server with Antigravity CLI for all workspaces: add it to ~/.gemini/config/mcp_config.json and
    /// allow its read-only/navigation tools (headless agy auto-denies anything not allow-listed).
    @objc func setupAgy() {
        let alert = NSAlert()
        if cfg.agy != nil, let node = cfg.node, let server = cfg.server {
            do {
                try AgySetup.install(node: node, server: server)
                alert.messageText = "Antigravity CLI is set up"
                alert.informativeText = "visioncli's tools are now available in every agy workspace. Restart any running `agy` sessions. To answer voice questions with Gemini through Antigravity, choose VisionCLI menu → Settings → Assistant → Gemini (Antigravity CLI)."
            } catch {
                alert.messageText = "Couldn't set up Antigravity CLI"
                alert.informativeText = error.localizedDescription
            }
        } else {
            alert.messageText = "Antigravity CLI wasn't found"
            alert.informativeText = "Install Antigravity (antigravity.google), sign in with `agy` once, then choose Settings → Set Up Antigravity CLI again."
        }
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    /// Register the MCP server with Gemini CLI for all projects (`gemini mcp add -s user --trust`). Trusted so its
    /// read-only tools also work in headless (bubble-only) mode, which can't ask for confirmation.
    @objc func setupGemini() {
        let alert = NSAlert()
        if let gemini = cfg.gemini, let node = cfg.node, let server = cfg.server {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = cfg.path
            DispatchQueue.global(qos: .userInitiated).async {
                shell(gemini, ["mcp", "remove", "-s", "user", "visioncli"], env: env)
                let (status, out, err) = shell(gemini, ["mcp", "add", "-s", "user", "--trust", "visioncli", node, server], env: env)
                DispatchQueue.main.async {
                    alert.messageText = status == 0 ? "Gemini CLI is set up" : "Couldn't set up Gemini CLI"
                    alert.informativeText = status == 0
                        ? "visioncli's tools are now available in every Gemini CLI project. Restart any running `gemini` sessions. To answer voice questions with Gemini, choose VisionCLI menu → Settings → Assistant → Gemini CLI.\n\nFor screenshots when typing in Gemini CLI, give your terminal app Screen Recording access too."
                        : (err.isEmpty ? out : err)
                    NSApp.activate(ignoringOtherApps: true)
                    alert.runModal()
                }
            }
            return
        } else {
            alert.messageText = "Gemini CLI wasn't found"
            alert.informativeText = "Install it with `npm install -g @google/gemini-cli`, sign in once by running `gemini`, then choose Settings → Set Up Gemini CLI again."
        }
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    /// First launch of a downloaded app: explain the basics and offer the Claude Code setup.
    /// Hold ⌥ / ⌥⌘ (needs Accessibility). Called at launch, or when setup gets the permission.
    private var modifierKeysOn = false
    func enableModifierKeys() {
        guard !modifierKeysOn else { return }
        modifierKeysOn = true
        hotkeys.set(.talk, false)
        hotkeys.set(.screen, false)
        modifierHold.onChange = { [weak self] key, pressed in self?.hotkey(key, pressed: pressed) }
        modifierHold.immediate = { [weak self] in self?.state.phase == .listening }
        modifierHold.onUpgrade = { [weak self] in
            guard let self, self.state.phase == .listening, !self.withScreen else { return }
            log("hotkey: ⌘ added, now with a screenshot")
            self.withScreen = true
            self.spotlight.show()
        }
        modifierHold.start()
    }

    @objc func showSetupWizard() {
        setupWizard.show(hooks: SetupWizard.Hooks(
            chooseSpeech: { [weak self] engine in
                // "whisper:small.en" picks a Whisper model; otherwise "parakeet" | "external" | "apple".
                if engine.hasPrefix("whisper:") { Settings.sttEngine = "whisper"; Settings.whisperModel = String(engine.dropFirst(8)) }
                else { Settings.sttEngine = engine }
                self?.restartWhisper()
            },
            whisperModels: { VoiceModels.whisperModels().map(\.0) },
            whisperReady: { [weak self] in self?.whisper?.ready ?? false },
            installWhisper: { [weak self] in self?.installer.installWhisper() },
            voices: { VoiceModels.kokoroModel != nil ? VoiceModels.kokoroVoiceList.map { ($0.0, $0.1) } : [] },
            selectVoice: { [weak self] id in Settings.speak = true; self?.selectVoice(id) },
            setSpeak: { [weak self] on in Settings.speak = on; if !on { self?.speaker.reset() } },
            setSpeed: { Settings.speechSpeed = $0 },
            parakeetReady: { [weak self] in self?.parakeet?.ready ?? false },
            installKokoro: { [weak self] in self?.installer.installKokoro() },
            installStatus: { [weak self] in self?.installer.status },
            useSystemVoice: { Settings.ttsEngine = "system"; Settings.speak = true },
            isInstalled: { [weak self] in self?.isInstalled($0) ?? false },
            toolsConnected: { [weak self] in self?.toolsConnected($0) ?? false },
            connectTools: { [weak self] a, done in self?.connectTools(a, done: done) },
            chooseAssistant: { a in Settings.assistant = a; log("assistant: \(a.appName)") },
            setTerminalMode: { Settings.terminalMode = $0 },
            accessibilityGranted: { [weak self] in self?.enableModifierKeys() },
            relaunch: { Updater.relaunch() }
        ))
    }

    func showWelcome() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Welcome to VisionCLI"
        alert.informativeText = """
        Ask Claude about anything on your screen, by voice.

        • Hold ⌥, ask, let go: the answer appears in the top-right corner.
        • Hold ⌥ ⌘ to send a screenshot of the window too.
        • Hold ⌥ ⇧ Space to drag a box around what you mean.
        • The VisionCLI menu bar icon has projects, voices, models and settings.
        • Optional: VisionCLI menu → Settings → Voice & Audio can download Whisper (more accurate transcription) and natural Kokoro voices.

        macOS will ask for Microphone, Speech Recognition and Screen Recording access. VisionCLI needs all three.
        To use the tools by typing in Claude Code, also give your terminal app (iTerm, Terminal…) Screen Recording access.

        Set up your AI CLI now so VisionCLI's tools work in every project? (Works with Claude Code and Gemini through Antigravity; pick which one answers voice questions in VisionCLI menu → Settings → Assistant.)
        """
        let hasClaude = FileManager.default.isExecutableFile(atPath: cfg.claude), hasAgy = cfg.agy != nil
        alert.addButton(withTitle: "Set Up \([hasClaude ? "Claude Code" : nil, hasAgy ? "Antigravity" : nil].compactMap { $0 }.joined(separator: " + ").ifEmpty("Claude Code"))")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn {
            if !hasClaude && hasAgy { Settings.assistant = .antigravity }
            // One alert after the other, as before: Antigravity's once Claude Code's result is closed.
            if hasClaude || !hasAgy { setupClaudeCode { if hasAgy { self.setupAgy() } } }
            else if hasAgy { setupAgy() }
        }
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
    @objc func chooseClaudeModel(_ sender: NSMenuItem) {
        guard let alias = sender.representedObject as? String else { return }
        Settings.model = alias
        propagate("/model \(alias)")
    }

    /// Send a /model or /effort change to the Claude running in the terminal, so the menu and the terminal agree.
    func propagate(_ cmd: String) {
        guard Settings.terminalMode, Settings.assistant == .claude else { return }
        let t = terminal(for: currentProject, assistant: .claude)
        t.command(cmd) { ok in
            if !ok { log("terminal: no running claude for \(t.project); \(cmd) applies when one starts") }
        }
    }

    /// The terminal changed its model itself (/model there): follow it in the menu.
    func syncModelFromTerminal() {
        // In bubble mode too: the background session should use the model the user's terminal Claude is on.
        guard Settings.assistant == .claude, cfg.model == nil else { return }
        let t = terminal(for: currentProject, assistant: .claude)
        // Probe and transcript read run in the background; the session's state only changes on main.
        t.findRunning {
            t.lastModel { used in
                guard let used else { return }
                let family = ["fable", "opus", "sonnet", "haiku"].first { used.contains($0) }
                let current = Settings.model.replacingOccurrences(of: "[1m]", with: "")
                if let family, current != family, !(current == "opusplan" && (family == "opus" || family == "sonnet")) {
                    log("model: terminal is on \(used); menu follows")
                    Settings.model = family
                }
            }
        }
    }
    @objc func showHistoryMenu() { showHistory() }
    @objc func showActivityMenu() {
        activityShown = true
        TerminalLauncher.showActivity()
    }
    @objc func toggleAutoActivity() { Settings.autoActivity.toggle() }
    @objc func toggleQuick() { Settings.quickCommands.toggle() }
    @objc func toggleScreenshotEvery() { Settings.screenshotEveryQuestion.toggle() }
    @objc func toggleSmartRouting() { Settings.smartRouting.toggle() }

    @objc func toggleAutopilot() {
        if Settings.autopilot {
            Settings.autopilot = false
            autopilot.stop()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Turn on Autopilot?"
        alert.informativeText = """
        While you work in the apps you tick under Autopilot, VisionCLI reads the front window's text (a small screenshot \
        if there's almost no text) and sends it to Claude Haiku for a suggestion: about 1k tokens a look, at most \
        \(Autopilot.hourlyCap) an hour. Password fields and password managers are skipped; other apps are never read.

        In chat apps it can draft a reply. Nothing is ever sent: you choose Put in reply box or Copy, and press Enter yourself.
        """
        alert.addButton(withTitle: "Turn On")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Settings.autopilot = true
        autopilot.start()
        if Settings.autopilotApps.isEmpty { log("autopilot: on, but no apps picked yet") }
    }

    @objc func autopilotCheckNow() { autopilot.checkNow() }

    @objc func toggleAutopilotApp(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        var apps = Settings.autopilotApps
        if let i = apps.firstIndex(of: id) { apps.remove(at: i) } else { apps.append(id) }
        Settings.autopilotApps = apps
    }


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
        if s is AgySession, let agy = cfg.agy {
            TerminalLauncher.run("cd '\(s.cwd.replacingOccurrences(of: "'", with: "'\\''"))' && exec '\(agy)' --conversation \(sid)", name: "continue")
        } else if s is GeminiSession, let gemini = cfg.gemini {
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
        AgySetup.clearSessionRules()
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

    @objc func chooseComputerControl(_ sender: NSMenuItem) {
        guard let mode = sender.representedObject as? String else { return }
        Settings.computerControl = mode
        controlAllowUntil = nil
        if mode != "off", !Computer.isTrusted { Computer.requestTrust() }
    }

    @objc func toggleWatchCrashes() {
        Settings.watchCrashes.toggle()
        if Settings.watchCrashes { crashWatcher.start() } else { crashWatcher.stop() }
    }

    @objc func grantAccessibility() {
        if !Computer.requestTrust() {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        }
    }

    func applicationWillTerminate(_ notification: Notification) { controlServer.stop(); CrashReporter.markCleanExit() }

    @objc func openCrashLog() { NSWorkspace.shared.open(CrashReporter.logURL) }

    @objc func quit() {
        AgySetup.clearSessionRules()
        CrashReporter.markCleanExit()
        sessions.values.forEach { $0.stop() }
        whisper?.stop()
        parakeet?.stop()
        kokoro.stop()
        log("quit")
        NSApp.terminate(nil)
    }
}

/// The activity feed with streamed answer text batched: ActivityLog opens the log file for every write, and answers
/// stream a token at a time. Text is written a few times a second, and always before any other entry so the feed
/// stays in order. Main thread only.
final class BufferedActivity {
    private let feed = ActivityLog()
    private var pending = ""

    func text(_ delta: String) {
        if pending.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.flush() }
        }
        pending += delta
    }

    private func flush() {
        guard !pending.isEmpty else { return }
        let text = pending
        pending = ""
        feed.text(text)
    }

    func question(_ text: String, project: String, shots: [Shot]) { flush(); feed.question(text, project: project, shots: shots) }
    func tool(_ name: String, _ input: [String: Any]) { flush(); feed.tool(name, input) }
    func toolResult(_ text: String, isError: Bool, tool: String?) { flush(); feed.toolResult(text, isError: isError, tool: tool) }
    func permission(_ title: String, allowed: Bool?) { flush(); feed.permission(title, allowed: allowed) }
    func done(cost: Double?) { flush(); feed.done(cost: cost) }
    func error(_ message: String) { flush(); feed.error(message) }
    func note(_ message: String) { flush(); feed.note(message) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

enum MenuLabels {
    /// Claude Code model aliases (`claude --model <alias>`), so new versions are picked up without an app update.
    static let claudeModels: [(String, String)] = [
        ("default", "Default (your Claude Code setting)"),
        ("fable", "Fable (most capable)"),
        ("opus", "Opus (deep reasoning)"),
        ("sonnet", "Sonnet (fast, balanced)"),
        ("haiku", "Haiku (fastest, cheapest)"),
        ("opusplan", "Opus to plan, Sonnet to do"),
        ("fable[1m]", "Fable, 1M context"),
        ("opus[1m]", "Opus, 1M context"),
        ("sonnet[1m]", "Sonnet, 1M context"),
    ]

    static func claudeModel(_ alias: String) -> String {
        claudeModels.first { $0.0 == alias }.map { $0.1.components(separatedBy: " (").first! } ?? alias
    }

    static func effort(_ level: String?) -> String {
        switch level {
        case "low": return "Low (fastest)"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "Extra High"
        case "max": return "Max (slowest)"
        default: return "Default"
        }
    }
}
