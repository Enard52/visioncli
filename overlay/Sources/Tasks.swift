import AppKit
import SwiftUI

// Task mode: while the assistant uses the computer, a small panel in the top-right corner lists its steps with
// Pause and Stop. Recipes: saved multi-step tasks ("run the app on the simulator and check for crashes").
// Watcher: notices app crashes (including simulator apps) and offers to explain them.

// MARK: - Task HUD

final class TaskState: ObservableObject {
    enum StepStatus { case running, done, failed, declined, waiting }
    struct Step: Identifiable { let id = UUID(); var text: String; var status: StepStatus }
    @Published var steps: [Step] = []
    @Published var paused = false
    @Published var title = "Working"
}

final class TaskHUD {
    let state = TaskState()
    var onPause: (Bool) -> Void = { _ in }
    var onStop: () -> Void = {}
    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?

    @discardableResult
    func begin(_ text: String, waiting: Bool = false) -> UUID {
        show()
        let step = TaskState.Step(text: text, status: waiting ? .waiting : .running)
        state.steps.append(step)
        if state.steps.count > 40 { state.steps.removeFirst(state.steps.count - 40) }
        return step.id
    }

    func update(_ id: UUID, _ status: TaskState.StepStatus) {
        guard let i = state.steps.firstIndex(where: { $0.id == id }) else { return }
        state.steps[i].status = status
        scheduleHide()
    }

    func reset(title: String) {
        state.steps = []
        state.paused = false
        state.title = title
    }

    /// Height taken in the top-right corner (the answer bubble goes below it).
    var visibleHeight: CGFloat { panel.map { $0.isVisible ? $0.frame.height + 8 : 0 } ?? 0 }

    func hide() {
        hideWork?.cancel()
        panel?.orderOut(nil)
        state.paused = false
    }

    private func scheduleHide() {
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.state.paused, !self.state.steps.contains(where: { $0.status == .running || $0.status == .waiting }) else { return }
            self.panel?.orderOut(nil)
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
    }

    private func show() {
        hideWork?.cancel()
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 200),
                            styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
            p.isFloatingPanel = true
            p.level = .statusBar
            p.backgroundColor = .clear
            p.isOpaque = false
            p.hasShadow = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.hidesOnDeactivate = false
            let host = NSHostingView(rootView: TaskView(s: state, pause: { [weak self] in
                guard let self else { return }
                self.state.paused.toggle()
                self.onPause(self.state.paused)
            }, stop: { [weak self] in self?.onStop() }))
            host.sizingOptions = [.intrinsicContentSize]
            p.contentView = host
            panel = p
        }
        guard let panel, let screen = NSScreen.main else { return }
        let size = panel.contentView?.fittingSize ?? CGSize(width: 320, height: 160)
        let vf = screen.visibleFrame
        panel.setFrame(NSRect(x: vf.maxX - size.width - 12, y: vf.maxY - size.height - 12, width: size.width, height: size.height), display: true)
        panel.orderFrontRegardless()
        // Keep the corner position as the list grows.
        DispatchQueue.main.async {
            let s = panel.contentView?.fittingSize ?? size
            panel.setFrame(NSRect(x: vf.maxX - s.width - 12, y: vf.maxY - s.height - 12, width: s.width, height: s.height), display: true)
        }
    }
}

struct TaskView: View {
    @ObservedObject var s: TaskState
    let pause: () -> Void
    let stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                if s.paused { Image(systemName: "pause.circle.fill").foregroundStyle(.yellow) } else { Spinner(size: 16) }
                Text(s.paused ? "Paused" : s.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                Spacer()
                Button(action: pause) {
                    Text(s.paused ? "Resume" : "Pause").font(.system(size: 11, weight: .medium)).padding(.horizontal, 9).padding(.vertical, 3)
                        .background(Capsule().stroke(Color.white.opacity(0.25))).foregroundStyle(.white.opacity(0.85))
                }.buttonStyle(.plain)
                Button(action: stop) {
                    Text("Stop  esc").font(.system(size: 11, weight: .semibold)).padding(.horizontal, 9).padding(.vertical, 3)
                        .background(Capsule().fill(Color.red.opacity(0.75))).foregroundStyle(.white)
                }.buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(s.steps.suffix(7)) { step in
                    HStack(alignment: .top, spacing: 6) {
                        icon(step.status).frame(width: 12)
                        Text(step.text).font(.system(size: 11)).foregroundStyle(.white.opacity(step.status == .running ? 0.95 : 0.6))
                            .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 320)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(bubbleFill))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.cyan.opacity(0.3)))
        .padding(4)
        .fixedSize()
    }

    @ViewBuilder func icon(_ status: TaskState.StepStatus) -> some View {
        switch status {
        case .running: Image(systemName: "cursorarrow.rays").font(.system(size: 10)).foregroundStyle(.cyan)
        case .done: Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.green)
        case .failed: Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(.orange)
        case .declined: Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.red.opacity(0.8))
        case .waiting: Image(systemName: "hand.raised.fill").font(.system(size: 10)).foregroundStyle(.yellow)
        }
    }
}

// MARK: - Recipes

struct Recipe: Codable {
    var name: String
    var prompt: String
}

enum Recipes {
    static let file = supportDir.appendingPathComponent("recipes.json")

    static let defaults: [Recipe] = [
        Recipe(name: "Explain this screen", prompt: "Look at what's on my screen and explain what it is, what it's for, and anything that looks wrong."),
        Recipe(name: "Fix this error", prompt: "There's an error on my screen. Read it, find the cause in the project code, and propose the smallest fix (make the edit if it's clear)."),
        Recipe(name: "Run the tests", prompt: "Run this project's test suite with its usual command, then summarize what passed and what failed, with the file:line of each failure."),
        Recipe(name: "Review my changes", prompt: "Review my uncommitted changes (git diff) for bugs, missing edge cases and leftover debug code. List the real problems only."),
        Recipe(name: "Explain the last crash", prompt: "Read the most recent crash report, explain why the app crashed in plain words, and point to the code responsible in this project."),
        Recipe(name: "Run on the simulator", prompt: "Build and run this app on the iOS Simulator (or Android emulator), wait for it to launch, take a screenshot, and tell me if anything looks broken."),
        Recipe(name: "Write a commit message", prompt: "Look at my staged changes (git diff --cached) and write a concise commit message for them. Don't commit."),
    ]

    static func load() -> [Recipe] {
        if let data = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([Recipe].self, from: data), !list.isEmpty { return list }
        save(defaults)
        return defaults
    }

    static func save(_ list: [Recipe]) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? enc.encode(list).write(to: file)
    }

    /// "run the tests" / "recipe review my changes" → that recipe's instructions.
    static func match(_ question: String) -> Recipe? {
        let q = question.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces))
        return load().first { r in
            let n = r.name.lowercased()
            return q == n || q == "recipe \(n)" || q == "run \(n)" || q.hasPrefix("recipe \(n)") || q == "do \(n)"
        }
    }
}

// MARK: - Crash watcher

/// Watches ~/Library/Logs/DiagnosticReports for new crash reports (Mac apps and iOS Simulator apps land here).
final class CrashWatcher {
    struct Crash { let app: String; let file: URL; let date: Date }
    var onCrash: (Crash) -> Void = { _ in }
    private(set) var last: Crash?
    private var seen = Set<String>()
    private var timer: Timer?
    private let dir = home.appendingPathComponent("Library/Logs/DiagnosticReports")
    /// System noise that isn't the user's app.
    private let ignored = ["VisionCLI", "whisper-server", "python", "ReportCrash", "mdworker", "com.apple.", "Safari", "WebKit",
                           "Google Chrome", "Brave", "Slack", "zoom", "Spotify", "Music", "Mail", "Finder", "Dock"]

    func start() {
        seen = Set(files().map(\.lastPathComponent))
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.check() }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// The latest crash if it happened recently (so "why did it crash?" knows which one).
    var recent: Crash? {
        guard let last, Date().timeIntervalSince(last.date) < 45 * 60 else { return nil }
        return last
    }

    private func files() -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey]))?
            .filter { ["ips", "crash"].contains($0.pathExtension) } ?? []
    }

    private func check() {
        for f in files() where !seen.contains(f.lastPathComponent) {
            seen.insert(f.lastPathComponent)
            let name = f.deletingPathExtension().lastPathComponent
            // e.g. "MyApp-2026-10-05-153012" → "MyApp"
            let app = name.replacingOccurrences(of: #"[-_]\d{4}-\d{2}-\d{2}-\d{6}.*$"#, with: "", options: .regularExpression)
            guard !ignored.contains(where: { app.localizedCaseInsensitiveContains($0) }) else { continue }
            let crash = Crash(app: app, file: f, date: Date())
            last = crash
            log("watcher: \(app) crashed (\(f.lastPathComponent))")
            onCrash(crash)
        }
    }
}
