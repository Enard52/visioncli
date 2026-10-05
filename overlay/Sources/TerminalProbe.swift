import AppKit

/// What's running in the terminal the user is pointing at: its project folder, and whether it's a `claude`
/// session VisionCLI can attach to (type into, and follow through its transcript).
struct TerminalContext {
    let project: String
    let cwd: String             // the process's own working directory (claude's transcripts are keyed by it)
    let itermSession: String?   // iTerm session unique id, for typing into it
    let runsClaude: Bool
    let claudeSessionId: String?
}

enum TerminalProbe {
    /// Probe the front tab of iTerm2 / Terminal (the one the user is in). Slow-ish (~100–200ms): call off the main thread.
    static func probe(app: String) -> TerminalContext? {
        let lower = app.lowercased()
        var tty = "", sessionId: String?
        if lower == "iterm2" {
            guard let r = applescript("tell application \"iTerm2\" to tell current session of current window to return (tty) & \"|\" & (unique id)"),
                  case let parts = r.split(separator: "|").map(String.init), parts.count == 2 else { return nil }
            tty = parts[0]
            sessionId = parts[1]
        } else if lower == "terminal" {
            guard let r = applescript("tell application \"Terminal\" to return tty of selected tab of front window") else { return nil }
            tty = r
        } else {
            return nil // Warp, Ghostty, … don't expose their tabs; fall back to the usual project detection
        }
        let ttyName = tty.replacingOccurrences(of: "/dev/", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ttyName.isEmpty else { return nil }

        // Processes on that tty: prefer a claude process, else the foreground one (stat contains "+").
        let (_, ps, _) = shell("/bin/ps", ["-t", ttyName, "-o", "pid=,stat=,comm="])
        let procs = ps.split(separator: "\n").compactMap { line -> (pid: String, stat: String, comm: String)? in
            // ps right-aligns the pid column; trim first or the leading spaces eat the split.
            let f = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            return f.count == 3 ? (f[0], f[1], f[2]) : nil
        }
        let claude = procs.last { ($0.comm as NSString).lastPathComponent == "claude" || $0.comm.hasSuffix("/claude") }
        guard let target = claude ?? procs.last(where: { $0.stat.contains("+") }) ?? procs.last else { return nil }

        let (_, lsof, _) = shell("/usr/sbin/lsof", ["-a", "-p", target.pid, "-d", "cwd", "-Fn"])
        guard let cwd = lsof.split(separator: "\n").first(where: { $0.hasPrefix("n") }).map({ String($0.dropFirst()) }), cwd != home.path else { return nil }

        return TerminalContext(project: gitRoot(cwd), cwd: cwd, itermSession: sessionId, runsClaude: claude != nil,
                               claudeSessionId: claude != nil ? newestTranscript(for: cwd) : nil)
    }

    /// A `claude` the user already has running in iTerm for this project (any tab). The most recently active wins.
    /// One `ps` for all processes, `lsof` only on claude ones, one AppleScript call for iTerm's tabs.
    static func findClaude(forProject project: String) -> TerminalContext? {
        let (_, ps, _) = shell("/bin/ps", ["-A", "-o", "pid=,tty=,comm="])
        let claudes = ps.split(separator: "\n").compactMap { line -> (pid: String, tty: String)? in
            let f = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard f.count == 3, f[1] != "??", (f[2] as NSString).lastPathComponent == "claude" || f[2].hasSuffix("/claude") else { return nil }
            return (f[0], f[1])
        }
        guard !claudes.isEmpty else { return nil }
        var matches: [(cwd: String, tty: String)] = []
        for c in claudes {
            let (_, lsof, _) = shell("/usr/sbin/lsof", ["-a", "-p", c.pid, "-d", "cwd", "-Fn"])
            guard let cwd = lsof.split(separator: "\n").first(where: { $0.hasPrefix("n") }).map({ String($0.dropFirst()) }) else { continue }
            if gitRoot(cwd) == project || cwd == project || cwd.hasPrefix(project + "/") { matches.append((cwd, c.tty)) }
        }
        guard !matches.isEmpty else { return nil }
        // tty → iTerm session id for every tab.
        let script = """
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
        """
        guard NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.googlecode.iterm2" }),
              let list = applescript(script) else { return nil }
        var tabs: [String: String] = [:]
        for line in list.split(separator: "\n") {
            let parts = line.split(separator: "|").map(String.init)
            if parts.count == 2 { tabs[parts[0].replacingOccurrences(of: "/dev/", with: "")] = parts[1] }
        }
        let candidates = matches.compactMap { m -> (TerminalContext, Date)? in
            guard let tab = tabs[m.tty] else { return nil }
            let session = newestTranscript(for: m.cwd)
            let encoded = m.cwd.replacingOccurrences(of: #"[^A-Za-z0-9]"#, with: "-", options: .regularExpression)
            let active = session.flatMap { mtime(home.appendingPathComponent(".claude/projects/\(encoded)/\($0).jsonl")) } ?? .distantPast
            return (TerminalContext(project: project, cwd: m.cwd, itermSession: tab, runsClaude: true, claudeSessionId: session), active)
        }
        return candidates.max { $0.1 < $1.1 }?.0
    }

    /// Project folders that have an interactive `claude` running in some terminal (no AppleScript; ~50–150ms).
    static func runningClaudeProjects() -> [String] {
        let (_, ps, _) = shell("/bin/ps", ["-A", "-o", "pid=,tty=,comm="])
        var projects: [String] = []
        for line in ps.split(separator: "\n") {
            let f = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard f.count == 3, f[1] != "??", (f[2] as NSString).lastPathComponent == "claude" else { continue }
            let (_, lsof, _) = shell("/usr/sbin/lsof", ["-a", "-p", f[0], "-d", "cwd", "-Fn"])
            if let cwd = lsof.split(separator: "\n").first(where: { $0.hasPrefix("n") }).map({ String($0.dropFirst()) }), cwd != home.path {
                let root = gitRoot(cwd)
                if !projects.contains(root) { projects.append(root) }
            }
        }
        return projects
    }

    /// The session claude is writing to right now: the most recently modified transcript for that folder.
    static func newestTranscript(for cwd: String) -> String? {
        let encoded = cwd.replacingOccurrences(of: #"[^A-Za-z0-9]"#, with: "-", options: .regularExpression)
        let dir = home.appendingPathComponent(".claude/projects/\(encoded)")
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.filter { $0.pathExtension == "jsonl" }
            .max { (mtime($0) ?? .distantPast) < (mtime($1) ?? .distantPast) }?
            .deletingPathExtension().lastPathComponent
    }

    private static func mtime(_ url: URL) -> Date? { (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }

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
