import AppKit
import AVFoundation
import Speech

// First-run and maintenance: the setup wizard, connecting the MCP tools to each CLI, permissions and updates.

extension AppDelegate {
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

    /// First launch of a downloaded app: explain the basics and offer the Claude Code setup.
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
}
