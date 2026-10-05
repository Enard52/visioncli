import Foundation

/// Background (bubble-only) Gemini through Antigravity CLI: one `agy -p … --output-format stream-json` run per
/// question, continuing the same conversation (`--conversation <id>`). Uses the user's own agy (Google) sign-in.
/// Headless agy auto-denies tools that would need approval, so only reads and the allow-listed visioncli tools run.
final class AgySession: AssistantSession {
    let cwd: String
    private let cfg: Config
    private var proc: Process?
    private(set) var busy = false
    private(set) var sessionId: String? {
        didSet { UserDefaults.standard.set(sessionId, forKey: "agyBackground:\(cwd)") }
    }
    private var answer = ""
    private var lastStderr = ""
    /// The last tool agy started (to explain a denial), and a rule added for an approved command.
    private var lastTool: (name: String, params: [String: Any])?
    private var pendingCommand: String?
    private var tempRule: String?
    /// Set by the app before respond(): keep the allow rule ("Allow all this session") instead of removing it.
    var keepRule = false

    var onStatus: (String) -> Void = { _ in }
    var onToolStart: () -> Void = {}
    var onDelta: (String) -> Void = { _ in }
    var onPermission: (PermissionRequest) -> Void = { _ in }
    var onDone: (_ result: String?, _ error: String?) -> Void = { _, _ in }
    var onToolUse: (_ name: String, _ input: [String: Any]) -> Void = { _, _ in }
    var onToolResult: (_ text: String, _ isError: Bool, _ tool: String?) -> Void = { _, _, _ in }
    var onCost: (Double) -> Void = { _ in }

    init(cwd: String, cfg: Config) {
        self.cwd = cwd
        self.cfg = cfg
        self.sessionId = UserDefaults.standard.string(forKey: "agyBackground:\(cwd)")
    }

    func warm() {}

    /// Headless agy can't ask for approval, so a denied command ends its turn. When the user approves it in the
    /// bubble, allow that command (an agy permission rule) and let Gemini continue the same conversation.
    func respond(to req: PermissionRequest, allow: Bool) {
        guard let command = pendingCommand else { return }
        pendingCommand = nil
        if allow {
            let rule = "command(\(AgySetup.rulePrefix(for: command)))"
            AgySetup.addAllowRule(rule)
            if keepRule { AgySetup.sessionRules.insert(rule) } else { tempRule = rule }
            log("agy: allowed \(rule)\(keepRule ? " (kept)" : " (this time)")")
            send(text: "The user approved running `\(command)`. Run it now and continue answering the original question.", shots: [])
        } else {
            send(text: "The user declined running `\(command)`. Answer as well as you can without running commands.", shots: [])
        }
        keepRule = false
    }

    func reset() {
        stop()
        sessionId = nil
    }

    func stop() {
        busy = false
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
    }

    func send(text: String, shots: [Shot]) {
        stop()
        guard let agy = cfg.agy else { onDone(nil, "Antigravity CLI (agy) wasn't found. Install Antigravity, sign in, and reopen VisionCLI."); return }
        let resume = sessionId.map { FileManager.default.fileExists(atPath: TerminalProbe.agyTranscript($0).path) } ?? false
        var prompt = resume ? "" : geminiVoicePrompt
        prompt += text
        let paths = shots.compactMap { $0.file?.path }
        if !paths.isEmpty { prompt += "\nScreenshot file(s) to view first: " + paths.joined(separator: ", ") }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: agy)
        p.arguments = ["-p", prompt, "--output-format", "stream-json"] + (resume ? ["--conversation", sessionId!] : [])
            + (Settings.agyModel.map { ["--model", $0] } ?? [])
            + (Settings.effort.map { ["--effort", $0] } ?? [])
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice

        var buffer = Data(), errText = "", gotResult = false
        answer = ""
        lastStderr = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            buffer.append(h.availableData)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    guard let self, self.proc === p else { return }
                    if obj["event"] as? String == "result" { gotResult = true }
                    self.handle(obj)
                }
            }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            errText += String(decoding: h.availableData, as: UTF8.self)
            if errText.count > 4000 { errText = String(errText.suffix(2000)) }
            let snapshot = errText
            DispatchQueue.main.async { self?.lastStderr = snapshot }
        }
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            log("agy exited \(proc.terminationStatus)\(errText.isEmpty ? "" : ": " + errText.suffix(300))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                guard let self, self.proc === proc else { return }
                self.proc = nil
                if self.busy && !gotResult {
                    self.busy = false
                    let tail = errText.split(separator: "\n").suffix(3).joined(separator: "\n")
                    self.onDone(nil, tail.isEmpty ? "Antigravity stopped unexpectedly (exit \(proc.terminationStatus))." : tail)
                }
            }
        }
        do {
            try p.run()
            proc = p
            busy = true
            log("ask agy (\(cwd), \(resume ? "conversation \(sessionId!)" : "new")): \(text.prefix(200))")
        } catch {
            onDone(nil, "Couldn't start agy: \(error.localizedDescription)")
        }
    }

    private func handle(_ obj: [String: Any]) {
        switch obj["event"] as? String {
        case "init":
            if let id = obj["conversation_id"] as? String { sessionId = id }
        case "step_update":
            guard let su = obj["step_update"] as? [String: Any] else { return }
            switch su["step_type"] as? String {
            case "agent_response":
                if let chunk = su["text_delta"] as? String, !chunk.isEmpty {
                    answer += chunk
                    onDelta(chunk)
                }
            case "tool":
                guard su["state"] as? String == "ACTIVE", let info = su["tool_info"] as? [String: Any] else { return }
                var name = info["name"] as? String ?? (su["tool_name"] as? String ?? "")
                let params = info["parameters"] as? [String: Any] ?? [:]
                if name == "call_mcp_tool", let tool = params["ToolName"] as? String { name = tool }
                lastTool = (name, params)
                answer = "" // text before a tool call was narration
                onToolStart()
                onStatus(ClaudeSession.describe(tool: name, input: params))
                onToolUse(name, params)
            default:
                break
            }
        case "result":
            busy = false
            if let rule = tempRule { AgySetup.removeAllowRule(rule); tempRule = nil } // "allow once" is over
            guard let r = obj["result"] as? [String: Any] else { return }
            let response = ((r["response"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? answer).trimmingCharacters(in: .whitespacesAndNewlines)
            if r["status"] as? String == "SUCCESS", !response.isEmpty {
                onDone(response, nil)
            } else if response.isEmpty {
                // Headless agy ends a turn silently when a tool needs permission it can't ask for.
                let denied = lastStderr.contains("auto-denied") || lastStderr.contains("cannot prompt")
                // A denied shell command: ask the user in the bubble, like Claude's approvals.
                if denied, let tool = lastTool, tool.name == "run_command",
                   let command = (tool.params["CommandLine"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty {
                    pendingCommand = command
                    log("agy: needs approval for `\(command)`")
                    onPermission(PermissionRequest(id: UUID().uuidString, tool: "Bash", input: ["command": command]))
                    return
                }
                onDone(nil, denied
                    ? "Gemini tried a step that needs your approval (like running a command), which Bubble Only mode can't ask for. Ask again, or switch 👁 → Answer In to the terminal for commands and edits."
                    : (lastStderr.split(separator: "\n").suffix(2).joined(separator: " ").ifEmpty("Gemini finished without a reply.")))
            } else {
                onDone(nil, (r["error"] as? String) ?? (r["status"] as? String).map { "Antigravity: \($0)" } ?? "Antigravity reported an error.")
            }
        default:
            break
        }
    }
}

/// Registers visioncli with Antigravity CLI (global MCP config + allow rules for headless runs).
enum AgySetup {
    static let mcpConfig = home.appendingPathComponent(".gemini/config/mcp_config.json")
    static let settings = home.appendingPathComponent(".gemini/antigravity-cli/settings.json")
    static let allowedTools = ["look", "list_windows", "select_region", "clipboard_image", "device_screenshot", "db_schema", "db_query",
                               "browser_tabs", "browser_read", "browser_elements", "browser_open", "browser_switch_tab",
                               "browser_navigate", "browser_scroll"]

    /// Read-only commands Gemini may run without asking (headless agy can't ask).
    static let safeCommands = ["grep", "rg", "ls", "cat", "head", "tail", "find", "wc", "pwd", "file", "stat", "tree",
                               "git status", "git log", "git diff", "git show", "git branch", "git blame"]

    /// The part of a command an allow rule names: the program, plus its subcommand for tools like git/npm/php.
    static func rulePrefix(for command: String) -> String {
        let words = command.split(separator: " ").map(String.init)
        guard let first = words.first else { return command }
        let twoWord: Set<String> = ["git", "npm", "pnpm", "yarn", "npx", "php", "python", "python3", "node", "bun", "cargo", "go",
                                    "make", "composer", "docker", "kubectl", "swift", "xcodebuild", "bundle", "rails", "./mvnw", "gradle"]
        return twoWord.contains((first as NSString).lastPathComponent) && words.count > 1 ? "\(first) \(words[1])" : first
    }

    private static func editRules(_ change: (inout [String]) -> Void) {
        var s = (try? Data(contentsOf: settings)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var permissions = s["permissions"] as? [String: Any] ?? [:]
        var allow = permissions["allow"] as? [String] ?? []
        change(&allow)
        permissions["allow"] = allow
        s["permissions"] = permissions
        try? FileManager.default.createDirectory(at: settings.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONSerialization.data(withJSONObject: s, options: [.prettyPrinted, .sortedKeys]).write(to: settings)
    }

    /// Rules approved with "Allow all this session": removed on New Conversation and when VisionCLI quits.
    static var sessionRules = Set<String>()

    static func clearSessionRules() {
        guard !sessionRules.isEmpty else { return }
        let rules = sessionRules
        editRules { allow in allow.removeAll { rules.contains($0) } }
        log("agy: removed session rules \(rules.sorted())")
        sessionRules = []
    }

    static func addAllowRule(_ rule: String) { editRules { if !$0.contains(rule) { $0.append(rule) } } }
    static func removeAllowRule(_ rule: String) { editRules { $0.removeAll { $0 == rule } } }

    static func install(node: String, server: String) throws {
        try FileManager.default.createDirectory(at: mcpConfig.deletingLastPathComponent(), withIntermediateDirectories: true)
        var config = (try? Data(contentsOf: mcpConfig)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var servers = config["mcpServers"] as? [String: Any] ?? [:]
        servers["visioncli"] = ["command": node, "args": [server]]
        config["mcpServers"] = servers
        try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]).write(to: mcpConfig)

        var s = (try? Data(contentsOf: settings)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var permissions = s["permissions"] as? [String: Any] ?? [:]
        var allow = permissions["allow"] as? [String] ?? []
        for tool in allowedTools where !allow.contains("mcp(visioncli/\(tool))") { allow.append("mcp(visioncli/\(tool))") }
        for cmd in safeCommands where !allow.contains("command(\(cmd))") { allow.append("command(\(cmd))") }
        permissions["allow"] = allow
        s["permissions"] = permissions
        try FileManager.default.createDirectory(at: settings.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: s, options: [.prettyPrinted, .sortedKeys]).write(to: settings)
        log("agy: registered visioncli MCP and \(allowedTools.count) allow rules")
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

/// The models agy offers (`agy models`), cached so the menu opens instantly.
enum AgyModels {
    static var cached: [(id: String, name: String)] {
        (UserDefaults.standard.array(forKey: "agyModels") as? [[String]] ?? []).compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
    }

    static func refresh(cfg: Config) {
        guard let agy = cfg.agy else { return }
        DispatchQueue.global(qos: .utility).async {
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = cfg.path
            let (status, out, _) = shell(agy, ["models"], env: env)
            guard status == 0 else { return }
            let models = out.split(separator: "\n").compactMap { line -> [String]? in
                let parts = line.split(separator: "\t", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                return parts.count == 2 && !parts[0].isEmpty ? parts : nil
            }
            if !models.isEmpty { UserDefaults.standard.set(models, forKey: "agyModels") }
        }
    }
}
