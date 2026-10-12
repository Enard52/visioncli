import AppKit
import Foundation

/// Keeps crashes from being a mystery and from being fatal:
/// - writes uncaught exceptions and fatal signals (with stack + recent log lines) to visioncli-crashes.log;
/// - on the next launch, adds macOS's symbolicated crash report summary and tells the user it recovered;
/// - stops relaunch loops (launchd restarts the app after a crash; see LoginItem / `visioncli voice`).
enum CrashReporter {
    static let logURL = home.appendingPathComponent("Library/Logs/visioncli-crashes.log")
    private static let historyURL = supportDir.appendingPathComponent("crash-history.txt")
    private static let markerURL = supportDir.appendingPathComponent("running.marker")

    // Recent log lines, written out with a crash so the log shows what led up to it.
    private static var breadcrumbs: [String] = []
    private static let lock = NSLock()
    private static var fd: Int32 = -1

    static func breadcrumb(_ line: String) {
        lock.lock()
        breadcrumbs.append(line)
        if breadcrumbs.count > 40 { breadcrumbs.removeFirst(breadcrumbs.count - 40) }
        lock.unlock()
    }

    /// Call first thing at launch. Returns a message if the previous run crashed.
    @discardableResult
    static func install() -> String? {
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        fd = open(logURL.path, O_WRONLY | O_APPEND)

        NSSetUncaughtExceptionHandler { e in
            CrashReporter.record(title: "Uncaught exception \(e.name.rawValue): \(e.reason ?? "")", stack: e.callStackSymbols)
        }
        for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP] {
            signal(sig, crashSignalHandler)
        }

        let crashedLastTime = FileManager.default.fileExists(atPath: markerURL.path)
        FileManager.default.createFile(atPath: markerURL.path, contents: nil)
        guard crashedLastTime else { return nil }
        appendSystemReport()
        return "VisionCLI restarted after a crash. Details: VisionCLI menu → Settings… → Advanced → Open Crash Log."
    }

    /// Clean shutdown: no crash next launch.
    static func markCleanExit() { try? FileManager.default.removeItem(at: markerURL) }

    /// True if it's crashing over and over; the app then exits normally so launchd stops restarting it.
    static func isCrashLooping() -> Bool {
        let now = Date().timeIntervalSince1970
        var stamps = ((try? String(contentsOf: historyURL, encoding: .utf8)) ?? "")
            .split(separator: "\n").compactMap { Double($0) }.filter { now - $0 < 180 }
        if FileManager.default.fileExists(atPath: markerURL.path) { stamps.append(now) }
        try? stamps.map { String($0) }.joined(separator: "\n").write(to: historyURL, atomically: true, encoding: .utf8)
        return stamps.count >= 4
    }

    fileprivate static func record(title: String, stack: [String]) {
        guard fd >= 0 else { return }
        var text = "\n==== CRASH \(ISO8601DateFormatter().string(from: Date())) (VisionCLI \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?"))\n"
        text += title + "\n\nStack:\n" + stack.prefix(40).joined(separator: "\n")
        text += "\n\nLast log lines:\n" + breadcrumbs.joined(separator: "\n") + "\n"
        text.withCString { _ = write(fd, $0, strlen($0)) }
    }

    /// Pull the summary of macOS's own (symbolicated) crash report for the last crash into our log.
    private static func appendSystemReport() {
        let dir = home.appendingPathComponent("Library/Logs/DiagnosticReports")
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("VisionCLI") && $0.pathExtension == "ips" }
            .sorted { ($0.modificationDate ?? .distantPast) > ($1.modificationDate ?? .distantPast) }
        guard let latest = files.first, Date().timeIntervalSince(latest.modificationDate ?? .distantPast) < 600,
              let raw = try? String(contentsOf: latest, encoding: .utf8),
              let bodyStart = raw.firstIndex(of: "\n"),
              let json = try? JSONSerialization.jsonObject(with: Data(raw[bodyStart...].utf8)) as? [String: Any] else { return }
        let exception = json["exception"] as? [String: Any] ?? [:]
        let images = json["usedImages"] as? [[String: Any]] ?? []
        let threads = json["threads"] as? [[String: Any]] ?? []
        let faulting = json["faultingThread"] as? Int ?? 0
        var lines = ["\n---- macOS crash report \(latest.lastPathComponent)",
                     "exception: \(exception["type"] ?? "?") \(exception["signal"] ?? "") \(exception["subtype"] ?? "")"]
        if faulting < threads.count, let frames = threads[faulting]["frames"] as? [[String: Any]] {
            for f in frames.prefix(20) {
                let image = (f["imageIndex"] as? Int).flatMap { $0 < images.count ? images[$0]["name"] as? String : nil } ?? "?"
                lines.append("  \(image)  \(f["symbol"] as? String ?? "?")")
            }
        }
        lines.append("full report: \(latest.path)\n")
        if let data = lines.joined(separator: "\n").data(using: .utf8), let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        }
    }
}

private extension URL {
    var modificationDate: Date? { (try? resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }
}

/// Fatal signal: write what we can, then let the default action produce macOS's crash report.
private func crashSignalHandler(_ sig: Int32) {
    alarm(2) // never hang in here (the handler isn't strictly async-signal-safe)
    let name = [SIGABRT: "SIGABRT", SIGSEGV: "SIGSEGV", SIGBUS: "SIGBUS", SIGILL: "SIGILL", SIGFPE: "SIGFPE", SIGTRAP: "SIGTRAP"][sig] ?? "signal \(sig)"
    CrashReporter.record(title: "Fatal signal \(name)", stack: Thread.callStackSymbols)
    signal(sig, SIG_DFL)
    raise(sig)
}
