import AppKit

// Menu actions that flip a setting or open something (the voice, setup and project ones live with their features).

extension AppDelegate {
    @objc func toggleAutoUpdate() { Settings.autoUpdate.toggle() }

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

    @objc func chooseClaudeModel(_ sender: NSMenuItem) {
        guard let alias = sender.representedObject as? String else { return }
        Settings.model = alias
        propagate("/model \(alias)")
    }

    @objc func showHistoryMenu() { showHistory() }

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

    @objc func toggleGhost() {
        if FileManager.default.fileExists(atPath: ghostOffFile.path) { try? FileManager.default.removeItem(at: ghostOffFile) }
        else { FileManager.default.createFile(atPath: ghostOffFile.path, contents: nil) }
    }

    @objc func useTerminalMode() { Settings.terminalMode = true }

    @objc func useBackgroundMode() { Settings.terminalMode = false }

    @objc func copyAnswerMenu() {
        let last = history.entries.first.map { Markup.display($0.answer) } ?? state.answer
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(last, forType: .string)
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

    @objc func openCrashLog() { NSWorkspace.shared.open(CrashReporter.logURL) }
}
