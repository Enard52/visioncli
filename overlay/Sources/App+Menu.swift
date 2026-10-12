import AppKit
import SwiftUI

// The menu-bar item and its menu, rebuilt each time it opens (menuNeedsUpdate).

extension AppDelegate {
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

    /// Project name next to the menu-bar icon.
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
}
