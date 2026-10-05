import AppKit

/// A human-readable, colored live feed of what the voice session is doing, written to
/// ~/Library/Logs/visioncli-activity.log and shown with `tail -f` in a terminal window.
final class ActivityLog {
    static let url = home.appendingPathComponent("Library/Logs/visioncli-activity.log")

    private let esc = "\u{1B}["
    private var midText = false // currently streaming answer text (no trailing newline yet)

    private func c(_ code: String, _ s: String) -> String { "\(esc)\(code)m\(s)\(esc)0m" }

    private func write(_ s: String) {
        guard let data = s.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: ActivityLog.url) {
            h.seekToEndOfFile()
            h.write(data)
            try? h.close()
        } else {
            try? data.write(to: ActivityLog.url)
        }
    }

    private func line(_ s: String) {
        if midText { write("\n"); midText = false }
        write(s + "\n")
    }

    func question(_ text: String, project: String, shots: [Shot]) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)
        line("")
        line(c("2", "━━━ \(time) · \((project as NSString).lastPathComponent) " + String(repeating: "━", count: 40)))
        line(c("1;36", "🎤 You: ") + c("1", text))
        for (i, s) in shots.enumerated() {
            let pointer = s.pointer.map { ", pointer at \(Int($0.x)),\(Int($0.y))" } ?? ""
            line(c("2", "   📸 \(shots.count > 1 ? "\(i + 1). " : "")\(s.label) (\(Int(s.pixelSize.width))×\(Int(s.pixelSize.height))\(pointer))"))
        }
    }

    func tool(_ name: String, _ input: [String: Any]) {
        let short = name.replacingOccurrences(of: "mcp__visioncli__", with: "")
        var detail: String
        switch name {
        case "Bash": detail = c("33", "$ " + (input["command"] as? String ?? ""))
        case "Read": detail = input["file_path"] as? String ?? ""
        case "Grep": detail = "\"\(input["pattern"] as? String ?? "")\"" + ((input["path"] as? String).map { " in \($0)" } ?? "")
        case "Glob": detail = input["pattern"] as? String ?? ""
        case "Edit", "MultiEdit", "Write": detail = input["file_path"] as? String ?? ""
        case "mcp__visioncli__db_query": detail = c("33", input["sql"] as? String ?? "")
        default:
            let json = (try? JSONSerialization.data(withJSONObject: input)).map { String(decoding: $0, as: UTF8.self) } ?? ""
            detail = json == "{}" ? "" : String(json.prefix(160))
        }
        line(c("35", "🔧 \(short) ") + detail)
    }

    func toolResult(_ text: String, isError: Bool, tool: String?) {
        let lines = text.components(separatedBy: "\n")
        // Show command / query output; just summarize file reads and searches.
        let verbose = isError || tool == "Bash" || tool == "mcp__visioncli__db_query"
        if verbose {
            for l in lines.prefix(15) { line(c(isError ? "31" : "2", "   │ " + String(l.prefix(200)))) }
            if lines.count > 15 { line(c("2", "   │ … \(lines.count - 15) more lines")) }
        } else {
            line(c("2", "   └ \(lines.count) lines"))
        }
    }

    func permission(_ title: String, allowed: Bool?) {
        switch allowed {
        case nil: line(c("1;33", "✋ \(title)? (waiting for you in the bubble)"))
        case true?: line(c("32", "   ✓ allowed"))
        case false?: line(c("31", "   ✗ denied"))
        }
    }

    func text(_ delta: String) {
        if !midText {
            write(c("1;32", "💬 Claude: "))
            midText = true
        }
        write(delta)
    }

    func done(cost: Double?) {
        if midText { write("\n"); midText = false }
        if let cost { line(c("2", String(format: "   ($%.4f)", cost))) }
    }

    func error(_ message: String) { line(c("31", "⚠️  " + message)) }

    func note(_ message: String) { line(c("2", "   " + message)) }
}

/// Opens commands in the user's terminal (iTerm2 if installed, else Terminal).
enum TerminalLauncher {
    static func run(_ script: String, name: String) {
        let file = supportDir.appendingPathComponent("\(name).command")
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? ("#!/bin/zsh\n" + script + "\n").write(to: file, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let iterm = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2")
        let terminal = iterm ?? URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.open([file], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
    }

    static func showActivity() {
        let path = ActivityLog.url.path
        run("""
        printf '\\e]0;visioncli activity\\a'
        clear
        echo "\\e[1mvisioncli voice activity\\e[0m: questions, tool calls, commands and answers appear here live (Ctrl+C to close)."
        touch '\(path)'
        tail -n 120 -F '\(path)'
        """, name: "activity")
    }

    static func continueSession(project: String, sessionId: String, claude: String) {
        run("""
        printf '\\e]0;visioncli → claude\\a'
        cd '\(project.replacingOccurrences(of: "'", with: "'\\''"))'
        echo "\\e[2mContinuing your voice conversation (as a copy, so voice mode keeps its own).\\e[0m"
        exec '\(claude)' --resume \(sessionId) --fork-session
        """, name: "continue")
    }
}
