import AppKit

/// Terminal mode: the conversation lives in a real interactive `claude` running in iTerm2 (or Terminal),
/// so the user can type to it like `claude -c`. Voice questions are typed into that session for them, and
/// the bubble follows the session's transcript (~/.claude/projects/<project>/<session>.jsonl).
final class TerminalSession {
    let project: String
    private let cfg: Config
    private(set) var sessionId: String
    private var termId: String?          // iTerm session unique id, or Terminal tab reference
    private var usesITerm: Bool
    private var offset: UInt64 = 0
    private var buffer = Data()
    private var timer: Timer?
    private var awaiting: String?        // marker of the voice question we're waiting on
    private var seenQuestion = false
    private var finalText = ""
    private var lastTool: String?
    private var lastToolAt = Date()

    var onStatus: (String) -> Void = { _ in }
    var onToolUse: (_ name: String, _ input: [String: Any]) -> Void = { _, _ in }
    var onToolResult: (_ text: String, _ isError: Bool) -> Void = { _, _ in }
    var onDone: (_ result: String?, _ error: String?) -> Void = { _, _ in }

    static let scriptsDir = home.appendingPathComponent("Library/Caches/visioncli") // no spaces: iTerm runs the path as a command
    static let terminalPrompt = """
    Some messages end with a "[Voice question …]" block: the user asked those out loud while looking at their screen, and your reply is also shown in a small bubble above their mouse pointer and may be read aloud. For those, first Read the screenshot file(s) listed in the block (the pointer position is given in image pixels; "this/here/that" means what's under the pointer), then follow the rest of these instructions.
    """ + "\n" + voiceSystemPrompt

    init(project: String, cfg: Config) {
        self.project = project
        self.cfg = cfg
        self.usesITerm = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil
        // Reuse this project's terminal conversation across app restarts.
        let key = "terminalSession:\(project)"
        if let saved = UserDefaults.standard.string(forKey: key) { sessionId = saved } else {
            sessionId = UUID().uuidString.lowercased()
            UserDefaults.standard.set(sessionId, forKey: key)
        }
    }

    /// Folder claude runs in (its transcripts live under it); usually the project root.
    var claudeCwd: String?

    var transcript: URL {
        let encoded = (claudeCwd ?? project).replacingOccurrences(of: #"[^A-Za-z0-9]"#, with: "-", options: .regularExpression)
        return home.appendingPathComponent(".claude/projects/\(encoded)/\(sessionId).jsonl")
    }

    var isBusy: Bool { awaiting != nil }

    /// Use a `claude` the user started themselves (in iTerm): type into that tab and follow its transcript.
    func attach(itermSession: String, sessionId: String?) {
        guard usesITerm, termId != itermSession || (sessionId != nil && sessionId != self.sessionId) else { return }
        termId = itermSession
        if let sessionId, sessionId != self.sessionId {
            self.sessionId = sessionId
            UserDefaults.standard.set(sessionId, forKey: "terminalSession:\(project)")
            offset = (try? FileManager.default.attributesOfItem(atPath: transcript.path)[.size] as? UInt64) ?? 0
            buffer = Data()
        }
        log("terminal: attached to your claude in iTerm (session \(self.sessionId)) for \(project)")
    }

    /// Start a fresh conversation next time (menu: New Conversation).
    func reset() {
        sessionId = UUID().uuidString.lowercased()
        UserDefaults.standard.set(sessionId, forKey: "terminalSession:\(project)")
        termId = nil
        offset = 0
    }

    // MARK: Asking

    func ask(_ text: String) {
        // One line: a newline would submit early. The marker lets us find this turn in the transcript.
        let line = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "  ", with: " ")
        awaiting = String(line.prefix(60))
        seenQuestion = false
        finalText = ""
        lastTool = nil
        startWatching()
        if let id = termId, send(line, to: id) {
            log("terminal: typed voice question into \(usesITerm ? "iTerm" : "Terminal") session")
            return
        }
        // No live tab: use a claude the user already runs for this project before opening a new terminal.
        if let found = TerminalProbe.findClaude(forProject: project), let tab = found.itermSession {
            claudeCwd = found.cwd
            attach(itermSession: tab, sessionId: found.claudeSessionId)
            if send(line, to: tab) {
                log("terminal: typed voice question into your existing claude")
                return
            }
        }
        // None running: open one, wait for claude's prompt, then type.
        onStatus("Opening Claude in the terminal…")
        guard let id = open() else {
            awaiting = nil
            onDone(nil, "Couldn't open a terminal. Allow VisionCLI to control \(usesITerm ? "iTerm" : "Terminal") in System Settings → Privacy & Security → Automation.")
            return
        }
        termId = id
        waitForPrompt(id, tries: 40) { [weak self] in
            guard let self else { return }
            if !self.send(line, to: id) { self.awaiting = nil; self.onDone(nil, "Couldn't type into the terminal session.") }
        }
    }

    func bringToFront() {
        guard let id = termId else { _ = open().map { termId = $0 }; return }
        if usesITerm {
            _ = applescript("""
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if unique id of s is "\(id)" then
                      select w
                      tell t to select
                      activate
                      return "ok"
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            """)
        } else {
            _ = applescript("tell application \"Terminal\"\nset frontmost of (first window whose tabs contains \(id)) to true\nactivate\nend tell")
        }
    }

    // MARK: Terminal control

    private func open() -> String? {
        let fm = FileManager.default
        try? fm.createDirectory(at: TerminalSession.scriptsDir, withIntermediateDirectories: true)
        let promptFile = TerminalSession.scriptsDir.appendingPathComponent("voice-prompt.txt")
        try? TerminalSession.terminalPrompt.write(to: promptFile, atomically: true, encoding: .utf8)
        let resume = fm.fileExists(atPath: transcript.path)
        let quote = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let script = """
        #!/bin/zsh -l
        printf '\\e]0;claude · \((project as NSString).lastPathComponent) (visioncli)\\a'
        cd \(quote(project))
        \(quote(cfg.claude)) --append-system-prompt "$(cat \(quote(promptFile.path)))" \\
          --allowedTools \(autoAllowedTools.joined(separator: " ")) \\
          \(resume ? "--resume" : "--session-id") \(sessionId)
        echo; echo "claude exited. Press Enter to close."; read
        """
        let stable = project.utf8.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1) }
        let file = TerminalSession.scriptsDir.appendingPathComponent("claude-\(stable).sh")
        try? script.write(to: file, atomically: true, encoding: .utf8)
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        offset = (try? fm.attributesOfItem(atPath: transcript.path)[.size] as? UInt64) ?? 0
        buffer = Data()
        log("terminal: opening claude (\(resume ? "resume" : "new") \(sessionId)) in \(project)")
        if usesITerm {
            return applescript("""
            tell application "iTerm2"
              set w to (create window with default profile command "\(file.path)")
              return unique id of current session of w
            end tell
            """)
        }
        return applescript("tell application \"Terminal\"\nset t to do script \"exec \(file.path)\"\nactivate\nreturn t as text\nend tell")
            .map { _ in "selected tab of front window" }
    }

    /// Type a line into the session; false if the session no longer exists.
    private func send(_ line: String, to id: String) -> Bool {
        let text = line.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        if usesITerm {
            return applescript("""
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if unique id of s is "\(id)" then
                      -- Type the text, then press Return: claude's input needs a real carriage return to submit.
                      tell s to write text "\(text)" newline NO
                      delay 0.25
                      tell s to write text (character id 13) newline NO
                      return "ok"
                    end if
                  end repeat
                end repeat
              end repeat
              return "missing"
            end tell
            """) == "ok"
        }
        return applescript("tell application \"Terminal\" to do script \"\(text)\" in \(id)") != nil
    }

    /// Wait until claude's input prompt is on screen (so typed text isn't lost), up to ~12s.
    private func waitForPrompt(_ id: String, tries: Int, then: @escaping () -> Void) {
        var screen = ""
        if usesITerm {
            screen = applescript("""
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if unique id of s is "\(id)" then return contents of s
                  end repeat
                end repeat
              end repeat
            end tell
            """) ?? ""
        } else {
            screen = applescript("tell application \"Terminal\" to return contents of \(id)") ?? ""
        }
        let ready = screen.contains("shortcuts") || screen.contains("? for") || screen.contains("❯") || screen.contains("│ >")
        if ready || tries <= 0 {
            // Let startup output (hooks, banners) settle so typed characters aren't eaten.
            DispatchQueue.main.asyncAfter(deadline: .now() + (ready ? 1.5 : 0)) { then() }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.waitForPrompt(id, tries: tries - 1, then: then) }
        }
    }

    private func applescript(_ source: String) -> String? {
        var error: NSDictionary?
        let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
        if let error { log("applescript error: \(error[NSAppleScript.errorMessage] ?? error)"); return nil }
        return result?.stringValue ?? ""
    }

    // MARK: Transcript watching

    private func startWatching() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        guard let h = try? FileHandle(forReadingFrom: transcript) else { return }
        defer { try? h.close() }
        let size = h.seekToEndOfFile()
        if size < offset { offset = 0 } // file replaced
        guard size > offset else { checkApprovalWait(); return }
        h.seek(toFileOffset: offset)
        buffer.append(h.readDataToEndOfFile())
        offset = size
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { handle(obj) }
        }
    }

    private func handle(_ obj: [String: Any]) {
        guard let marker = awaiting, obj["isSidechain"] as? Bool != true else { return }
        let message = obj["message"] as? [String: Any] ?? [:]
        switch obj["type"] as? String {
        case "user":
            if let text = message["content"] as? String, text.contains(marker) { seenQuestion = true; return }
            let content = message["content"] as? [[String: Any]] ?? []
            if content.contains(where: { ($0["text"] as? String)?.contains(marker) == true }) { seenQuestion = true; return }
            guard seenQuestion else { return }
            for block in content where block["type"] as? String == "tool_result" {
                lastTool = nil
                var text = block["content"] as? String ?? ""
                if let parts = block["content"] as? [[String: Any]] { text = parts.compactMap { $0["text"] as? String }.joined(separator: "\n") }
                onToolResult(text, block["is_error"] as? Bool ?? false)
            }
        case "assistant":
            guard seenQuestion else { return }
            let content = message["content"] as? [[String: Any]] ?? []
            for block in content {
                if block["type"] as? String == "tool_use" {
                    let name = block["name"] as? String ?? "", input = block["input"] as? [String: Any] ?? [:]
                    lastTool = name
                    lastToolAt = Date()
                    onToolUse(name, input)
                    finalText = "" // text before a tool call was narration, not the answer
                } else if block["type"] as? String == "text", let t = block["text"] as? String, !t.isEmpty {
                    finalText += (finalText.isEmpty ? "" : "\n\n") + t
                }
            }
            // Claude Code writes the end of a turn as separate entries (thinking, then the text), so don't stop at
            // the first "end_turn": finish when the turn-summary entries arrive, or shortly after the answer text.
            if message["stop_reason"] as? String == "end_turn", !finalText.isEmpty { scheduleFinish(after: 1.0) }
        case "system":
            let subtype = obj["subtype"] as? String ?? ""
            if seenQuestion, subtype == "turn_duration" || subtype == "stop_hook_summary" { finishTurn() }
        default:
            break
        }
    }

    private var finishWork: DispatchWorkItem?

    private func scheduleFinish(after seconds: Double) {
        finishWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.finishTurn() }
        finishWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Hand the answer to the bubble (the same text that's in the terminal).
    private func finishTurn() {
        finishWork?.cancel()
        guard awaiting != nil else { return }
        awaiting = nil
        let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        onDone(text.isEmpty ? nil : text, text.isEmpty ? "Claude finished without a text reply; see the terminal." : nil)
    }

    /// Edits and commands may be waiting for approval in the terminal; say so in the bubble.
    private func checkApprovalWait() {
        guard awaiting != nil, let tool = lastTool, ["Edit", "MultiEdit", "Write", "Bash", "NotebookEdit"].contains(tool),
              Date().timeIntervalSince(lastToolAt) > 1.5 else { return }
        onStatus("Running \(tool)… approve in the Claude terminal if asked")
        lastTool = nil
    }
}
