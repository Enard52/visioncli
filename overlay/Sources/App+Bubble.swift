import AppKit

// BubbleActions: the buttons and keys on the answer bubble.

extension AppDelegate {
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
}
