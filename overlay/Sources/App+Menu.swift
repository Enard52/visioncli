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
        if let status = updater.status { item(status, nil, in: menu) }
        else if let release = updater.available { item("Install Update (\(release.version))…", #selector(installUpdate), in: menu) }
        if !Screen.hasPermission { item("Grant Screen Recording…", #selector(openScreenSettings), in: menu) }
        menu.addItem(.separator())

        item("History…", #selector(showHistoryMenu), in: menu, key: "y")
        item("New Conversation", #selector(newConversation), in: menu, key: "n")
        item("Copy Last Answer", #selector(copyAnswerMenu), in: menu, key: "c")
        // Actions, not settings, so they stay in the menu (where answers appear is chosen in Settings → Assistant).
        if Settings.terminalMode {
            item("Show \(Settings.assistant.name) Terminal", #selector(showClaudeTerminal), in: menu, key: "t")
        } else {
            item("Show Live Activity in Terminal", #selector(showActivityMenu), in: menu, key: "t")
            item("Continue Conversation in Terminal", current?.sessionId == nil ? nil : #selector(continueInTerminal), in: menu)
        }
        menu.addItem(.separator())

        // Every option lives in the Settings window.
        item("Settings…", #selector(showSettings), in: menu, key: ",")
        item("Quit visioncli", #selector(quit), in: menu, key: "q")
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
