import AppKit
import CryptoKit

/// The CLI that answers: Claude Code (`claude`), Antigravity CLI (`agy`, Gemini on a Google account), or Gemini CLI.
enum Assistant: String, CaseIterable {
    case claude, antigravity, gemini

    var name: String { self == .claude ? "Claude" : "Gemini" }
    var appName: String {
        switch self {
        case .claude: return "Claude Code"
        case .antigravity: return "Gemini (Antigravity)"
        case .gemini: return "Gemini CLI"
        }
    }
    var binary: String { self == .antigravity ? "agy" : rawValue }

    /// Is this `ps` args line one of this assistant's interactive processes?
    func matches(args: String) -> Bool {
        let tokens = args.split(separator: " ").prefix(2).map { ($0 as NSString).lastPathComponent }
        guard let first = tokens.first else { return false }
        switch self {
        case .claude: return first == "claude"
        case .antigravity: return first == "agy"
        case .gemini: return first == "gemini" || (first.hasPrefix("node") && tokens.count > 1 && tokens[1] == "gemini")
        }
    }
}

/// What's running in the terminal the user is pointing at: its project folder, and whether it's a `claude` or
/// `gemini` session VisionCLI can attach to (type into, and follow through its session file).
struct TerminalContext {
    let project: String
    let cwd: String             // the process's own working directory (session files are keyed by it)
    let itermSession: String?   // iTerm session unique id, for typing into it
    let assistant: Assistant?   // which CLI runs there, if any
    let sessionId: String?
}

enum TerminalProbe {
    /// Probe the front tab of iTerm2 / Terminal (the one the user is in). Slow-ish (~100–200ms): call off the main thread.
    static func probe(app: String) -> TerminalContext? {
        let lower = app.lowercased()
        var tty = "", tabId: String?
        if lower == "iterm2" {
            guard let r = applescript("tell application \"iTerm2\" to tell current session of current window to return (tty) & \"|\" & (unique id)"),
                  case let parts = r.split(separator: "|").map(String.init), parts.count == 2 else { return nil }
            tty = parts[0]
            tabId = parts[1]
        } else if lower == "terminal" {
            guard let r = applescript("tell application \"Terminal\" to return tty of selected tab of front window") else { return nil }
            tty = r
        } else {
            return nil // Warp, Ghostty, … don't expose their tabs; fall back to the usual project detection
        }
        let ttyName = tty.replacingOccurrences(of: "/dev/", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ttyName.isEmpty else { return nil }

        // Processes on that tty: prefer an assistant process, else the foreground one (stat contains "+").
        let procs = processes(["-t", ttyName], withStat: true)
        var found: (pid: String, assistant: Assistant)?
        for a in Assistant.allCases { if let p = procs.last(where: { a.matches(args: $0.args) }) { found = (p.pid, a); break } }
        guard let pid = found?.pid ?? procs.last(where: { $0.stat.contains("+") })?.pid ?? procs.last?.pid,
              let cwd = workingDirectory(pid), cwd != home.path else { return nil }
        return TerminalContext(project: gitRoot(cwd), cwd: cwd, itermSession: tabId, assistant: found?.assistant,
                               sessionId: found.flatMap { newestSession($0.assistant, cwd: cwd) })
    }

    /// An assistant the user already has running in iTerm for this project (any tab). The most recently active wins.
    /// One `ps` for all processes, `lsof` only on matching ones, one AppleScript call for iTerm's tabs.
    static func find(_ assistant: Assistant, forProject project: String) -> TerminalContext? {
        let running = processes(["-A"]).filter { $0.tty != "??" && assistant.matches(args: $0.args) }
        var matches: [(cwd: String, tty: String)] = []
        for p in running {
            guard let cwd = workingDirectory(p.pid) else { continue }
            if gitRoot(cwd) == project || cwd == project || cwd.hasPrefix(project + "/") { matches.append((cwd, p.tty)) }
        }
        guard !matches.isEmpty, NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.googlecode.iterm2" }),
              let list = applescript("""
              set out to ""
              tell application "iTerm2"
                repeat with w in windows
                  repeat with t in tabs of w
                    repeat with s in sessions of t
                      set out to out & (tty of s) & "|" & (unique id of s) & (character id 10)
                    end repeat
                  end repeat
                end repeat
              end tell
              return out
              """) else { return nil }
        var tabs: [String: String] = [:]
        for line in list.split(separator: "\n") {
            let parts = line.split(separator: "|").map(String.init)
            if parts.count == 2 { tabs[parts[0].replacingOccurrences(of: "/dev/", with: "")] = parts[1] }
        }
        let candidates = matches.compactMap { m -> (TerminalContext, Date)? in
            guard let tab = tabs[m.tty] else { return nil }
            let session = newestSession(assistant, cwd: m.cwd)
            let active = session.flatMap { sessionFile(assistant, cwd: m.cwd, sessionId: $0) }.flatMap(mtime) ?? .distantPast
            return (TerminalContext(project: project, cwd: m.cwd, itermSession: tab, assistant: assistant, sessionId: session), active)
        }
        return candidates.max { $0.1 < $1.1 }?.0
    }

    /// Project folders with an interactive `claude` or `gemini` running in some terminal (no AppleScript).
    static func runningProjects() -> [(project: String, assistant: Assistant)] {
        var out: [(String, Assistant)] = []
        for p in processes(["-A"]) where p.tty != "??" {
            guard let a = Assistant.allCases.first(where: { $0.matches(args: p.args) }),
                  let cwd = workingDirectory(p.pid), cwd != home.path else { continue }
            let root = gitRoot(cwd)
            if !out.contains(where: { $0.0 == root && $0.1 == a }) { out.append((root, a)) }
        }
        return out
    }

    // MARK: Session files

    /// The session the assistant is writing to right now in this folder: its most recently modified session file.
    static func newestSession(_ assistant: Assistant, cwd: String) -> String? {
        switch assistant {
        case .claude:
            let files = jsonl(in: claudeDir(cwd))
            return files.max { (mtime($0) ?? .distantPast) < (mtime($1) ?? .distantPast) }?.deletingPathExtension().lastPathComponent
        case .gemini:
            let hash = sha256(cwd)
            let files = geminiChatDirs(cwd).flatMap(jsonl).sorted { (mtime($0) ?? .distantPast) > (mtime($1) ?? .distantPast) }
            for f in files.prefix(10) {
                if let header = geminiHeader(f), header["projectHash"] as? String == hash { return header["sessionId"] as? String }
            }
            return nil
        case .antigravity:
            return nil // agy conversations aren't indexed by folder; the terminal session finds its transcript by the question text
        }
    }

    /// agy keeps a JSONL transcript per conversation.
    static func agyTranscript(_ conversationId: String) -> URL {
        home.appendingPathComponent(".gemini/antigravity-cli/brain/\(conversationId)/.system_generated/logs/transcript.jsonl")
    }

    /// The agy conversation whose transcript contains `marker` (the question VisionCLI just typed), written recently.
    static func agyConversation(containing marker: String, within seconds: TimeInterval = 180) -> String? {
        let brain = home.appendingPathComponent(".gemini/antigravity-cli/brain")
        let dirs = (try? FileManager.default.contentsOfDirectory(at: brain, includingPropertiesForKeys: nil)) ?? []
        let recent = dirs.compactMap { dir -> (String, URL, Date)? in
            let t = agyTranscript(dir.lastPathComponent)
            guard let m = mtime(t), Date().timeIntervalSince(m) < seconds else { return nil }
            return (dir.lastPathComponent, t, m)
        }.sorted { $0.2 > $1.2 }
        for (id, t, _) in recent {
            if let text = try? String(contentsOf: t, encoding: .utf8), text.contains(marker) { return id }
        }
        return nil
    }

    /// The session file for a session id (Claude: <id>.jsonl; Gemini: session-<date>-<id prefix>.jsonl).
    static func sessionFile(_ assistant: Assistant, cwd: String, sessionId: String) -> URL? {
        switch assistant {
        case .claude:
            let url = claudeDir(cwd).appendingPathComponent("\(sessionId).jsonl")
            return FileManager.default.fileExists(atPath: url.path) ? url : nil
        case .gemini:
            let prefix = String(sessionId.prefix(8))
            for dir in geminiChatDirs(cwd) {
                for f in jsonl(in: dir) where f.lastPathComponent.hasSuffix("-\(prefix).jsonl") {
                    if geminiHeader(f)?["sessionId"] as? String == sessionId { return f }
                }
            }
            return nil
        case .antigravity:
            let t = agyTranscript(sessionId)
            return FileManager.default.fileExists(atPath: t.path) ? t : nil
        }
    }

    private static func claudeDir(_ cwd: String) -> URL {
        home.appendingPathComponent(".claude/projects/" + cwd.replacingOccurrences(of: #"[^A-Za-z0-9]"#, with: "-", options: .regularExpression))
    }

    /// ~/.gemini/tmp/<project id>/chats, where the id is the name in ~/.gemini/projects.json or the path's SHA-256.
    private static func geminiChatDirs(_ cwd: String) -> [URL] {
        let tmp = home.appendingPathComponent(".gemini/tmp")
        var names: [String] = []
        if let data = try? Data(contentsOf: home.appendingPathComponent(".gemini/projects.json")),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let name = (json["projects"] as? [String: String])?[cwd] { names.append(name) }
        names.append(sha256(cwd))
        return names.map { tmp.appendingPathComponent("\($0)/chats") }.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func geminiHeader(_ file: URL) -> [String: Any]? {
        guard let h = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? h.close() }
        let data = h.readData(ofLength: 4096)
        guard let line = data.split(separator: 0x0A).first else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
    }

    private static func jsonl(in dir: URL) -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.pathExtension == "jsonl" }
    }

    static func sha256(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

    private static func mtime(_ url: URL) -> Date? { (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }

    // MARK: Processes

    private static func processes(_ selector: [String], withStat: Bool = false) -> [(pid: String, tty: String, stat: String, args: String)] {
        let (_, ps, _) = shell("/bin/ps", selector + ["-o", "pid=,tty=,stat=,args="])
        return ps.split(separator: "\n").compactMap { line in
            // ps right-aligns the pid column; trim first or the leading spaces eat the split.
            let f = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            return f.count == 4 ? (f[0], f[1], f[2], f[3]) : nil
        }
    }

    private static func workingDirectory(_ pid: String) -> String? {
        let (_, lsof, _) = shell("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])
        return lsof.split(separator: "\n").first(where: { $0.hasPrefix("n") }).map { String($0.dropFirst()) }
    }

    static func gitRoot(_ path: String) -> String {
        var dir = path
        while dir != "/" && dir != home.path {
            if FileManager.default.fileExists(atPath: "\(dir)/.git") { return dir }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return path
    }

    /// osascript (not NSAppleScript, which isn't safe off the main thread); runs under VisionCLI's Automation permission.
    private static func applescript(_ source: String) -> String? {
        let (status, out, err) = shell("/usr/bin/osascript", ["-e", source])
        if status != 0 { log("terminal probe: \(err.trimmingCharacters(in: .whitespacesAndNewlines))"); return nil }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
