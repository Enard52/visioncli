import AppKit

// The assistant sessions questions go to: background (bubble mode) and the user's terminal (terminal mode).

extension AppDelegate {
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
                guard let used, let family = MenuLabels.followedModel(used: used, menu: Settings.model) else { return }
                log("model: terminal is on \(used); menu follows")
                Settings.model = family
            }
        }
    }

    @objc func showActivityMenu() {
        activityShown = true
        TerminalLauncher.showActivity()
    }

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

    @objc func newConversation() {
        instructed.removeAll()
        AgySetup.clearSessionRules()
        sessions.values.forEach { $0.reset() }
        terminals.values.forEach { $0.reset() }
        alwaysAllow = [:]
    }
}
