import AppKit
import ApplicationServices
import SwiftUI

// Autopilot: while you work, VisionCLI glances at the front app when something changes (you switch apps or windows,
// or pause for a while) and, if it has something genuinely useful, shows a small suggestion card in the bottom-right
// corner. In chat apps (Viber, WhatsApp, Slack, Fiverr…) it drafts a reply; nothing is ever sent without your click.
//
// Cheap by design: it reads the window's text through Accessibility (a screenshot only when there's almost no text),
// asks Claude Haiku with a tiny prompt and no tools (~1k tokens), stays quiet most of the time, and has an hourly cap.

final class Autopilot {
    struct Suggestion: Equatable {
        var app: String
        var title: String
        var detail: String
        var draft: String?
        var pid: pid_t
    }

    var isBusy: () -> Bool = { false }          // VisionCLI is answering a question: don't interrupt
    var claudePath = "claude"
    private let card = SuggestionCard()
    private var timer: Timer?
    private var lastKey = ""
    private var keyChangedAt = Date()
    private var checkedKeys: [String: Date] = [:]
    private var lastCheckAt = Date.distantPast
    private var lastTextHash = 0
    private var running = false
    private var recentTitles: [String] = []
    private(set) var callsThisHour: [Date] = []
    static let hourlyCap = 30

    /// Apps that can never be watched, even if picked.
    static let skipBundles: Set<String> = [
        "com.apple.systempreferences", "com.apple.SystemSettings", "com.apple.keychainaccess", "com.apple.Passwords",
        "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
        "com.apple.loginwindow", "com.apple.ScreenSaver.Engine",
    ]
    private let chatHints = ["viber", "whatsapp", "slack", "telegram", "messages", "discord", "messenger", "teams",
                             "fiverr", "upwork", "gmail", "outlook", "signal", "skype", "line"]

    var calls: Int {
        callsThisHour.removeAll { Date().timeIntervalSince($0) > 3600 }
        return callsThisHour.count
    }

    func start() {
        guard timer == nil else { return }
        lastKey = ""
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
        log("autopilot: on")
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        card.hide()
        log("autopilot: off")
    }

    // MARK: When to look

    private func tick() {
        guard !running, !isBusy(), let app = NSWorkspace.shared.frontmostApplication,
              Settings.autopilotApps.contains(app.bundleIdentifier ?? ""),
              app.bundleIdentifier != Bundle.main.bundleIdentifier,
              !Self.skipBundles.contains(app.bundleIdentifier ?? ""),
              !terminalApps.contains((app.localizedName ?? "").lowercased()) else { return }
        let title = Screen.windows().first { $0.pid == app.processIdentifier }?.title ?? ""
        let key = "\(app.bundleIdentifier ?? app.localizedName ?? "?")|\(title)"
        let now = Date()
        if key != lastKey {
            lastKey = key
            keyChangedAt = now
            return
        }
        let stable = now.timeIntervalSince(keyChangedAt)
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        let newPlace = stable >= 5 && (checkedKeys[key].map { now.timeIntervalSince($0) > 600 } ?? true)
        let pausedHere = idle >= 20 && now.timeIntervalSince(lastCheckAt) >= 120
        guard newPlace || pausedHere, now.timeIntervalSince(lastCheckAt) >= 30, calls < Self.hourlyCap else { return }
        checkedKeys[key] = now
        lastCheckAt = now
        look(app: app, title: title)
    }

    /// Looks right now at the front app (or the top-most window that isn't VisionCLI), ignoring cooldowns and the app
    /// list: you asked. Password managers etc. are still skipped.
    func checkNow() {
        let mine = Bundle.main.bundleIdentifier
        var app = NSWorkspace.shared.frontmostApplication
        if app == nil || app?.bundleIdentifier == mine || terminalApps.contains((app?.localizedName ?? "").lowercased()) {
            app = Screen.windows().lazy.compactMap { NSRunningApplication(processIdentifier: $0.pid) }
                .first { !terminalApps.contains(($0.localizedName ?? "").lowercased()) }
        }
        guard let app, !Self.skipBundles.contains(app.bundleIdentifier ?? "") else {
            ActivityBadge.shared.show("sparkles", "Autopilot: nothing to look at", seconds: 2)
            return
        }
        guard !running else { return }
        lastTextHash = 0
        recentTitles = []
        let title = Screen.windows().first { $0.pid == app.processIdentifier }?.title ?? ""
        lastCheckAt = Date()
        look(app: app, title: title, manual: true)
    }

    // MARK: Looking

    private func look(app: NSRunningApplication, title: String, manual: Bool = false) {
        running = true
        let name = app.localizedName ?? "this app"
        let pid = app.processIdentifier
        let isChat = chatHints.contains { name.lowercased().contains($0) || title.lowercased().contains($0) }
        ActivityBadge.shared.show("sparkles", "Autopilot is reading \(name)…", seconds: 3)
        let previousHash = lastTextHash // lastTextHash belongs to the main thread; `running` keeps looks one at a time
        DispatchQueue.global(qos: .utility).async { [self] in
            let text = Self.visibleText(pid: pid)
            // Same screen as last time (nothing new happened): skip.
            let hash = (name + title + text).hashValue
            if hash == previousHash { DispatchQueue.main.async { self.running = false }; return }
            DispatchQueue.main.async { self.lastTextHash = hash }
            var image: String?
            if text.count < 150, let w = Screen.windows().first(where: { $0.pid == pid }),
               let cg = FastCapture.window(w.id, bounds: w.bounds), let jpeg = Screen.jpeg(cg) {
                image = jpeg.0.base64EncodedString() // too little text to go on: send a small screenshot instead
            }
            log("autopilot: reading \(name) (\(text.count) chars\(image == nil ? "" : ", screenshot"))")
            let suggestion = ask(app: name, title: title, text: text, image: image, isChat: isChat, pid: pid, manual: manual)
            DispatchQueue.main.async {
                self.running = false
                self.callsThisHour.append(Date())
                guard let suggestion, !self.recentTitles.contains(suggestion.title) else {
                    if manual { ActivityBadge.shared.show("checkmark", "Autopilot: nothing to suggest in \(name)", tint: .green, seconds: 3) }
                    return
                }
                self.recentTitles = Array((self.recentTitles + [suggestion.title]).suffix(20))
                log("autopilot: \(name): \(suggestion.title)")
                ActivityBadge.shared.show("lightbulb.fill", "Autopilot: \(suggestion.title)", tint: .yellow, seconds: 4)
                self.card.show(suggestion)
            }
        }
    }

    /// Text in the app's focused window, through Accessibility (password fields skipped).
    static func visibleText(pid: pid_t, limit: Int = 6000) -> String {
        let app = AXUIElementCreateApplication(pid)
        // A hung app would otherwise stall each call for the default ~6s.
        AXUIElementSetMessagingTimeout(app, 0.5)
        // Chrome and Electron apps only build their accessibility tree when asked.
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var win: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &win) == .success, let window = win else { return "" }
        var out: [String] = []
        var total = 0
        var visited = 0
        let deadline = Date().addingTimeInterval(3)
        func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
            var v: CFTypeRef?
            return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
        }
        func walk(_ e: AXUIElement, depth: Int) {
            guard depth < 45, visited < 4000, total < limit, visited % 64 != 0 || Date() < deadline else { return }
            visited += 1
            AXUIElementSetMessagingTimeout(e, 0.5)
            let role = attr(e, kAXRoleAttribute) as? String ?? ""
            if role == "AXSecureTextField" { return }
            for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                if let s = attr(e, name) as? String {
                    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if t.count > 1, out.last != t { out.append(t); total += t.count }
                }
            }
            for child in attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child, depth: depth + 1) }
        }
        walk(window as! AXUIElement, depth: 0)
        return String(out.joined(separator: "\n").prefix(limit))
    }

    private static let prompt = """
    You are a helpful co-pilot glancing at the user's screen while they work (they are a developer and freelancer). \
    You get the front app, its window title and the window's text (or a screenshot). Give ONE specific, useful \
    suggestion about what is on screen right now: a bug or mistake you can see, a better or faster way to do what \
    they're doing, a shortcut, something they probably missed, or the obvious next step. Be concrete: name the \
    thing on screen. If it's a chat or inbox with a message waiting for their reply, write a short reply draft in \
    the same language and tone as the conversation. Say nothing (suggest false) only when the screen is empty, \
    a loading screen, or you truly have nothing specific to add.
    Reply with only JSON, no prose: {"suggest": true|false, "title": "under 8 words", "detail": "1-2 short sentences", \
    "draft": "reply text or null"}
    """

    private func ask(app: String, title: String, text: String, image: String?, isChat: Bool, pid: pid_t, manual: Bool = false) -> Suggestion? {
        var content: [[String: Any]] = [[
            "type": "text",
            "text": "App: \(app)\nWindow: \(title)\(isChat ? "\n(This looks like a chat or inbox.)" : "")\(manual ? "\n(The user pressed Check Now: always give your best suggestion, suggest true.)" : "")\nWindow text:\n\(text.isEmpty ? "(none, see screenshot)" : text)",
        ]]
        if let image { content.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": image]]) }
        let msg: [String: Any] = ["type": "user", "message": ["role": "user", "content": content]]
        guard let line = try? JSONSerialization.data(withJSONObject: msg) else { return nil }
        let dir = supportDir.appendingPathComponent("autopilot")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let started = Date()
        let (code, out, err) = shell(claudePath, [
            "-p", "--model", "haiku", "--effort", "low", "--setting-sources", "project", "--system-prompt", Self.prompt,
            "--tools", "", "--strict-mcp-config", "--no-session-persistence",
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        ], cwd: dir.path, stdin: line + Data([0x0A]))
        guard code == 0 else { log("autopilot: claude failed \(err.prefix(200))"); return nil }
        for l in out.split(separator: "\n") where l.contains("\"type\":\"result\"") {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
                  var result = obj["result"] as? String else { continue }
            if let usage = obj["usage"] as? [String: Any] {
                log("autopilot: \(Int(Date().timeIntervalSince(started) * 1000))ms, \(usage["input_tokens"] ?? 0)+\(usage["cache_creation_input_tokens"] ?? 0) in, \(usage["output_tokens"] ?? 0) out")
            }
            log("autopilot: result \(result.prefix(300).replacingOccurrences(of: "\n", with: " "))")
            // Tolerate ```json fences.
            if let a = result.firstIndex(of: "{"), let b = result.lastIndex(of: "}") { result = String(result[a...b]) }
            guard let j = try? JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any],
                  j["suggest"] as? Bool == true, let t = j["title"] as? String, !t.isEmpty else { return nil }
            let draft = (j["draft"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            return Suggestion(app: app, title: t, detail: j["detail"] as? String ?? "", draft: draft, pid: pid)
        }
        return nil
    }
}

// MARK: - Suggestion card

final class SuggestionModel: ObservableObject {
    @Published var s: Autopilot.Suggestion?
    @Published var hovering = false
}

final class SuggestionCard {
    private var panel: NSPanel?
    private let model = SuggestionModel()
    private var hideWork: DispatchWorkItem?

    func show(_ s: Autopilot.Suggestion) {
        model.s = s
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 120), styleMask: [.nonactivatingPanel, .borderless],
                            backing: .buffered, defer: false)
            p.isFloatingPanel = true
            p.level = .statusBar
            p.backgroundColor = .clear
            p.isOpaque = false
            p.hasShadow = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.hidesOnDeactivate = false
            let view = SuggestionView(m: model, insert: { [weak self] in self?.insert() }, copy: { [weak self] in self?.copy() },
                                      close: { [weak self] in self?.hide() })
            let host = NSHostingView(rootView: view)
            host.sizingOptions = [.intrinsicContentSize]
            p.contentView = host
            panel = p
        }
        guard let panel else { return }
        DispatchQueue.main.async { [self] in
            let size = panel.contentView?.fittingSize ?? CGSize(width: 340, height: 120)
            let mouse = NSEvent.mouseLocation
            let vf = (NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            panel.setFrame(NSRect(x: vf.maxX - size.width - 12, y: vf.minY + 12, width: size.width, height: size.height), display: true)
            panel.orderFrontRegardless()
        }
        scheduleHide(after: s.draft == nil ? 20 : 45)
    }

    func hide() {
        hideWork?.cancel()
        panel?.orderOut(nil)
    }

    private func scheduleHide(after seconds: Double) {
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.model.hovering { self.scheduleHide(after: 5); return }
            self.hide()
        }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
    }

    /// Types the draft into the chat's message box (the app is brought back first). It is NOT sent: you press Enter.
    private func insert() {
        guard let s = model.s, let draft = s.draft, let app = NSRunningApplication(processIdentifier: s.pid) else { return }
        hide()
        app.activate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { Computer.type(draft.replacingOccurrences(of: "\n", with: " ")) }
    }

    private func copy() {
        guard let s = model.s else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s.draft ?? "\(s.title). \(s.detail)", forType: .string)
        hide()
    }
}

struct SuggestionView: View {
    @ObservedObject var m: SuggestionModel
    let insert: () -> Void
    let copy: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let s = m.s {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles").foregroundStyle(.cyan)
                    Text("Autopilot · \(s.app)").font(.system(size: 10.5, weight: .medium)).foregroundStyle(.white.opacity(0.55))
                    Spacer()
                    Button(action: close) { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.5)) }
                        .buttonStyle(.plain)
                }
                Text(s.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                if !s.detail.isEmpty {
                    Text(s.detail).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
                }
                if let draft = s.draft {
                    Text(draft).font(.system(size: 12)).foregroundStyle(.white).padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.08)))
                    HStack(spacing: 8) {
                        Button(action: insert) {
                            Label("Put in reply box", systemImage: "text.cursor").font(.system(size: 11, weight: .semibold))
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Capsule().fill(Color.cyan.opacity(0.8))).foregroundStyle(.black)
                        }.buttonStyle(.plain)
                        Button(action: copy) {
                            Label("Copy", systemImage: "doc.on.doc").font(.system(size: 11))
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Capsule().stroke(Color.white.opacity(0.25))).foregroundStyle(.white.opacity(0.85))
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 340, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(bubbleFill))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.cyan.opacity(0.3)))
        .padding(4)
        .fixedSize()
        .onHover { m.hovering = $0 }
    }
}
