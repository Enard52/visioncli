import AppKit

// "Wispr Flow" speech engine. It works like the built-in engines: hold ⌥, speak, let go. While ⌥ is held VisionCLI
// holds Flow's own push-to-talk key (fn) for it; when you let go, Flow transcribes with your account, dictionary and
// formatting and types the text, which lands in a hidden field in VisionCLI and goes out as the question.
// Nothing of Flow is accessed directly: it only sees a key held down and a text field to type into.

final class FlowDictation: NSObject, NSTextFieldDelegate {
    private var panel: NSPanel?
    private var field: NSTextField!
    private var previousApp: NSRunningApplication?
    private var fnDown = false
    private var began = Date()
    private var waiting: ((String) -> Void)?
    private var settle: DispatchWorkItem?
    private var timeout: DispatchWorkItem?
    /// Text as Flow types it (for the bubble).
    var onText: (String) -> Void = { _ in }

    static var isInstalled: Bool { FileManager.default.fileExists(atPath: "/Applications/Wispr Flow.app") }

    /// Focus the hidden field and hold fn so Flow starts listening.
    func begin() {
        began = Date()
        previousApp = NSWorkspace.shared.frontmostApplication
        if panel == nil { build() }
        field.stringValue = ""
        waiting = nil
        // Flow types into the focused field of the front app, so VisionCLI has to be in front (invisibly).
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
        panel?.makeFirstResponder(field)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in self?.setFn(true) }
    }

    /// Let go of fn; Flow transcribes and types. `done` gets the text ("" if Flow typed nothing in time).
    func end(_ done: @escaping (String) -> Void) {
        setFn(false)
        waiting = done
        pollHistory(tries: 16)
        let t = DispatchWorkItem { [weak self] in
            log("flow: no text from Wispr Flow")
            self?.finish()
        }
        timeout = t
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: t)
        if !text.isEmpty { scheduleFinish() }
    }

    /// Stop without a question (esc).
    func cancel() {
        setFn(false)
        waiting = nil
        close()
    }

    private var text: String { field?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }

    /// Tag on the key events we post, so VisionCLI's own ⌃ watcher ignores them.
    static let tag: Int64 = 0x5643_4C49

    private func setFn(_ down: Bool) {
        guard down != fnDown else { return }
        fnDown = down
        // Private state: our fake keys don't change the real keyboard state VisionCLI reads to see ⌃ is still held.
        let source = CGEventSource(stateID: .privateState)
        func post(_ key: CGKeyCode, _ keyDown: Bool, _ flags: CGEventFlags) {
            guard let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: keyDown) else { return }
            e.type = .flagsChanged
            e.flags = flags
            e.setIntegerValueField(.eventSourceUserData, value: Self.tag)
            e.post(tap: .cghidEventTap)
        }
        if down {
            // Flow maps ⌃+fn, ⌘+fn (and other combos) to other actions, so first tell it ⌃, ⌥ and ⌘ are up: it then
            // sees fn alone, its push-to-talk. (Left/right Control 59/62, Option 58/61, Command 55/54.)
            for key: CGKeyCode in [59, 62, 58, 61, 55, 54] { post(key, false, []) }
            post(63, true, .maskSecondaryFn)
        } else {
            post(63, false, [])
        }
        log("flow: fn \(down ? "down" : "up")")
    }

    /// Backup for a missed paste: Flow records each dictation, with the app it was for, in its local database. Only the
    /// row for this question (made for VisionCLI after it started) is read.
    private func pollHistory(tries: Int) {
        guard tries > 0, waiting != nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.waiting != nil else { return }
            if !self.text.isEmpty { return } // the paste arrived
            let since = self.began.addingTimeInterval(-1)
            DispatchQueue.global(qos: .userInitiated).async {
                let found = FlowDictation.historyText(since: since)
                DispatchQueue.main.async {
                    guard self.waiting != nil, self.text.isEmpty else { return }
                    if let found, !found.isEmpty {
                        log("flow: text from Flow history")
                        self.field.stringValue = found
                        self.onText(found)
                        self.finish()
                    } else {
                        self.pollHistory(tries: tries - 1)
                    }
                }
            }
        }
    }

    static func historyText(since: Date) -> String? {
        let db = home.appendingPathComponent("Library/Application Support/Wispr Flow/flow.sqlite").path
        guard FileManager.default.fileExists(atPath: db) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        let sql = "SELECT COALESCE(NULLIF(formattedText,''), NULLIF(asrText,''), '') FROM History WHERE app = '\(Bundle.main.bundleIdentifier ?? "dev.visioncli.overlay")' AND timestamp >= '\(f.string(from: since))' AND status = 'formatted' ORDER BY timestamp DESC LIMIT 1;"
        let (code, out, _) = shell("/usr/bin/sqlite3", ["-readonly", "file:\(db)?mode=ro", sql])
        let text = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return code == 0 && !text.isEmpty ? text : nil
    }

    private func scheduleFinish() {
        settle?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.finish() }
        settle = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: w) // Flow may type in a few chunks
    }

    private func finish() {
        settle?.cancel()
        timeout?.cancel()
        let result = text
        let done = waiting
        waiting = nil
        close()
        done?(result)
    }

    private func close() {
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
        if let app = previousApp, !app.isTerminated, app.bundleIdentifier != Bundle.main.bundleIdentifier { app.activate() }
    }

    private func build() {
        // Invisible but able to take keyboard focus.
        let p = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 30), styleMask: [.borderless], backing: .buffered, defer: false)
        p.alphaValue = 0
        p.isOpaque = false
        p.backgroundColor = .clear
        p.ignoresMouseEvents = true
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.hidesOnDeactivate = false
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 400, height: 30))
        f.delegate = self
        p.contentView?.addSubview(f)
        field = f
        panel = p
    }

    func controlTextDidChange(_ obj: Notification) {
        onText(text)
        if waiting != nil { scheduleFinish() }
    }
}

/// A borderless panel that can still take keyboard focus. VisionCLI has no Edit menu, so ⌘V (how Flow delivers its
/// text) has to be routed to the field by hand.
private final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command),
              let key = event.charactersIgnoringModifiers?.lowercased() else { return super.performKeyEquivalent(with: event) }
        let action: Selector? = switch key {
        case "v": #selector(NSText.paste(_:))
        case "c": #selector(NSText.copy(_:))
        case "x": #selector(NSText.cut(_:))
        case "a": #selector(NSText.selectAll(_:))
        default: nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }
}
