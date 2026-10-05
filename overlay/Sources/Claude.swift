import Foundation

let voiceSystemPrompt = """
You are answering a question the user asked out loud. Your reply appears in a small bubble above their mouse pointer (and may be read aloud).

Screenshots of what they are looking at are attached to each question, with the mouse pointer position in image pixels. "This", "here" and "that" mean what is under the pointer. If two images are attached, image 1 is where the pointer was when they started speaking and image 2 is where it ended, so "compare this with that" means 1 versus 2.

- If code is visible, find the file in the project (Glob/Grep) and Read the relevant lines before answering. Cite files as path:line, with the path relative to the project root.
- For questions about database tables or data, use mcp__visioncli__db_schema and mcp__visioncli__db_query (read-only), together with the models and migrations in the code.
- For the iOS Simulator or an Android emulator, mcp__visioncli__device_screenshot gives a sharper image. Grep for the visible strings to find the view's code.
- If you need a fresh look (for example "now look at this"), call mcp__visioncli__look with under_cursor: true.
- To point at something on screen, add a marker [[box:IMAGE:x1,y1,x2,y2:short label]] using pixel coordinates in that attached image (IMAGE is 1-based). It is drawn on the user's real screen. Use it when you refer to a specific spot, and never mention the marker itself.
- If the user asks you to change code, make the edit with Edit/Write. The user approves each change from the bubble, so keep edits small and focused.
- To run tests, builds, artisan/npm/git commands etc., use Bash. The user approves each command from the bubble, so run one focused command at a time and summarize the output briefly.
- For web pages in Brave/Chrome, prefer the mcp__visioncli__browser_* tools over screenshots: browser_read for the page text, browser_elements then browser_click/browser_type to act, browser_tabs/browser_open/browser_switch_tab/browser_navigate to move around. Clicks and typing ask the user first.
- If you can't tell what they mean, call mcp__visioncli__select_region so they can drag a box around it. If they say they copied a screenshot, use mcp__visioncli__clipboard_image.
- Reply in plain conversational text, under about 100 words unless they ask for detail. No headings or tables, and code snippets of 3 lines at most.
- The question came from speech-to-text, so technical words may be misheard; infer what they meant.
"""

/// Tools that run without asking. Everything else (Edit, Write, Bash, …) asks the user in the bubble.
let autoAllowedTools = [
    "Read", "Grep", "Glob",
    "mcp__visioncli__look", "mcp__visioncli__list_windows", "mcp__visioncli__device_screenshot",
    "mcp__visioncli__db_schema", "mcp__visioncli__db_query",
    "mcp__visioncli__select_region", "mcp__visioncli__clipboard_image",
    // Browser: reading and navigating are automatic; clicking and typing in pages ask first.
    "mcp__visioncli__browser_tabs", "mcp__visioncli__browser_read", "mcp__visioncli__browser_elements",
    "mcp__visioncli__browser_open", "mcp__visioncli__browser_switch_tab", "mcp__visioncli__browser_navigate",
    "mcp__visioncli__browser_scroll",
]

struct PermissionRequest {
    let id: String
    let tool: String
    let input: [String: Any]

    var file: String? { (input["file_path"] as? String) ?? (input["notebook_path"] as? String) }

    var title: String {
        let name = file.map { ($0 as NSString).lastPathComponent } ?? ""
        switch tool {
        case "Edit", "MultiEdit": return "Claude wants to edit \(name)"
        case "Write": return FileManager.default.fileExists(atPath: file ?? "") ? "Claude wants to overwrite \(name)" : "Claude wants to create \(name)"
        case "Bash": return "Claude wants to run a command"
        default: return "Claude wants to use \(tool.replacingOccurrences(of: "mcp__visioncli__", with: ""))"
        }
    }

    /// A short preview: a diff for edits, the command for Bash, etc.
    var detail: [(String, DiffKind)] {
        func lines(_ s: String?, _ kind: DiffKind, max: Int = 8) -> [(String, DiffKind)] {
            let all = (s ?? "").components(separatedBy: "\n")
            var out = all.prefix(max).map { (($0.count > 110 ? String($0.prefix(110)) + "…" : $0), kind) }
            if all.count > max { out.append(("… \(all.count - max) more lines", .context)) }
            return out
        }
        switch tool {
        case "Edit":
            return lines(input["old_string"] as? String, .removed, max: 6) + lines(input["new_string"] as? String, .added, max: 8)
        case "MultiEdit":
            let edits = input["edits"] as? [[String: Any]] ?? []
            return edits.prefix(3).flatMap { lines($0["old_string"] as? String, .removed, max: 3) + lines($0["new_string"] as? String, .added, max: 4) }
        case "Write": return lines(input["content"] as? String, .added, max: 10)
        case "Bash": return [("$ " + (input["command"] as? String ?? ""), .context)]
        default:
            let json = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted])).map { String(decoding: $0, as: UTF8.self) }
            return lines(json, .context, max: 8)
        }
    }
}

enum DiffKind { case added, removed, context }

/// One long-lived `claude` process per project, driven over stream-json so follow-ups don't pay startup cost.
final class ClaudeSession {
    let cwd: String
    private let cfg: Config
    private var proc: Process?
    private var stdin: FileHandle?
    // Persisted so a restart (e.g. after a crash) resumes the same conversation.
    private(set) var sessionId: String? {
        didSet { UserDefaults.standard.set(sessionId, forKey: "backgroundSession:\(cwd)") }
    }
    private(set) var busy = false
    private var model: String

    var onStatus: (String) -> Void = { _ in }
    var onToolStart: () -> Void = {}
    var onDelta: (String) -> Void = { _ in }
    var onPermission: (PermissionRequest) -> Void = { _ in }
    var onDone: (_ result: String?, _ error: String?) -> Void = { _, _ in }
    // Activity feed (terminal mirror)
    var onToolUse: (_ name: String, _ input: [String: Any]) -> Void = { _, _ in }
    var onToolResult: (_ text: String, _ isError: Bool, _ tool: String?) -> Void = { _, _, _ in }
    var onCost: (Double) -> Void = { _ in }
    private var toolNames: [String: String] = [:]

    init(cwd: String, cfg: Config) {
        self.cwd = cwd
        self.cfg = cfg
        self.model = cfg.model ?? Settings.model
        self.sessionId = UserDefaults.standard.string(forKey: "backgroundSession:\(cwd)")
    }

    var isRunning: Bool { proc?.isRunning == true }

    /// Start the process ahead of time (called when the hotkey goes down) so it's warm by the time we ask.
    func warm() { if !isRunning { start() } }

    func send(text: String, shots: [Shot]) {
        if busy { restart() } // a new question interrupts the old one; --resume keeps the conversation
        let wanted = cfg.model ?? Settings.model
        if wanted != model { model = wanted; restart() }
        if !isRunning { start() }
        var content: [[String: Any]] = shots.map {
            ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": $0.jpeg.base64EncodedString()]]
        }
        content.append(["type": "text", "text": text])
        busy = true
        write(["type": "user", "message": ["role": "user", "content": content]])
        log("ask (\(cwd)): \(text.prefix(300))")
    }

    func respond(to req: PermissionRequest, allow: Bool) {
        let response: [String: Any] = allow
            ? ["behavior": "allow", "updatedInput": req.input]
            : ["behavior": "deny", "message": "The user declined this. Don't retry it; tell them what you would have done instead."]
        write(["type": "control_response", "response": ["subtype": "success", "request_id": req.id, "response": response]])
    }

    /// Forget the conversation (menu: New Conversation).
    func reset() {
        stop()
        sessionId = nil
    }

    func stop() {
        busy = false
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
        stdin = nil
    }

    private func restart() {
        stop()
        start()
    }

    private func start() {
        var args = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--permission-prompt-tool", "stdio", "--permission-mode", "default",
            "--append-system-prompt", voiceSystemPrompt,
            "--model", model,
            // Lean session: only the built-in tools voice mode uses (about half the input tokens of the full set),
            // and no plugin hooks (their per-session output also defeats prompt caching).
            "--tools", "Read,Grep,Glob,Edit,Write,Bash",
            "--settings", #"{"disableAllHooks": true}"#,
            "--allowedTools",
        ] + autoAllowedTools
        if let node = cfg.node, let server = cfg.server {
            let mcp: [String: Any] = ["mcpServers": ["visioncli": ["command": node, "args": [server]]]]
            if let data = try? JSONSerialization.data(withJSONObject: mcp) {
                args += ["--mcp-config", String(decoding: data, as: UTF8.self), "--strict-mcp-config"]
            }
        }
        if let sid = sessionId { args += ["--resume", sid] }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: cfg.claude)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        p.environment = env

        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp

        var buffer = Data()
        var errText = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty else { return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    guard let self, self.proc === p else { return }
                    self.handle(obj)
                }
            }
        }
        err.fileHandleForReading.readabilityHandler = { h in
            errText += String(decoding: h.availableData, as: UTF8.self)
            if errText.count > 4000 { errText = String(errText.suffix(2000)) }
        }
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            log("claude exited \(proc.terminationStatus)\(errText.isEmpty ? "" : ": " + errText.suffix(400))")
            DispatchQueue.main.async {
                guard let self, self.proc === proc else { return }
                self.proc = nil
                self.stdin = nil
                if self.busy {
                    self.busy = false
                    let tail = errText.split(separator: "\n").suffix(3).joined(separator: "\n")
                    self.onDone(nil, tail.isEmpty ? "Claude stopped unexpectedly (exit \(proc.terminationStatus))." : tail)
                }
            }
        }
        do {
            try p.run()
            proc = p
            stdin = inp.fileHandleForWriting
            log("claude started in \(cwd) (model \(model)\(sessionId.map { ", resume \($0)" } ?? ""))")
        } catch {
            log("failed to start claude: \(error)")
            onDone(nil, "Couldn't start claude at \(cfg.claude): \(error.localizedDescription)")
        }
    }

    private func write(_ obj: [String: Any]) {
        guard let stdin, var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        data.append(0x0A)
        do { try stdin.write(contentsOf: data) } catch { log("write to claude failed: \(error)") }
    }

    private func handle(_ obj: [String: Any]) {
        if let sid = obj["session_id"] as? String { sessionId = sid }
        switch obj["type"] as? String {
        case "stream_event":
            guard obj["parent_tool_use_id"] == nil || obj["parent_tool_use_id"] is NSNull,
                  let ev = obj["event"] as? [String: Any] else { return }
            if ev["type"] as? String == "content_block_start",
               (ev["content_block"] as? [String: Any])?["type"] as? String == "tool_use" {
                onToolStart()
            }
            if ev["type"] as? String == "content_block_delta",
               let d = ev["delta"] as? [String: Any], d["type"] as? String == "text_delta",
               let text = d["text"] as? String {
                onDelta(text)
            }
        case "assistant":
            let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in content where block["type"] as? String == "tool_use" {
                let name = block["name"] as? String ?? "", input = block["input"] as? [String: Any] ?? [:]
                if let id = block["id"] as? String { toolNames[id] = name }
                onStatus(ClaudeSession.describe(tool: name, input: input))
                onToolUse(name, input)
            }
        case "user":
            let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in content where block["type"] as? String == "tool_result" {
                var text = ""
                if let s = block["content"] as? String { text = s }
                else if let parts = block["content"] as? [[String: Any]] {
                    text = parts.map { ($0["text"] as? String) ?? ($0["type"] as? String == "image" ? "[image]" : "") }.joined(separator: "\n")
                }
                onToolResult(text, block["is_error"] as? Bool ?? false, (block["tool_use_id"] as? String).flatMap { toolNames[$0] })
            }
        case "control_request":
            guard let id = obj["request_id"] as? String, let req = obj["request"] as? [String: Any] else { return }
            if req["subtype"] as? String == "can_use_tool" {
                let r = PermissionRequest(id: id, tool: req["tool_name"] as? String ?? "", input: req["input"] as? [String: Any] ?? [:])
                log("permission requested: \(r.tool)")
                onPermission(r)
            } else {
                write(["type": "control_response", "response": ["subtype": "error", "request_id": id, "error": "unsupported"]])
            }
        case "result":
            busy = false
            if let cost = obj["total_cost_usd"] as? Double { onCost(cost) }
            let isError = obj["is_error"] as? Bool ?? false
            let result = obj["result"] as? String
            log("result: \((result ?? "").prefix(200))")
            onDone(isError ? nil : result, isError ? (result ?? "Something went wrong") : nil)
        default:
            break
        }
    }

    static func describe(tool: String, input: [String: Any]) -> String {
        func base(_ key: String) -> String { ((input[key] as? String) ?? "").split(separator: "/").last.map(String.init) ?? "" }
        switch tool {
        case "mcp__visioncli__look": return "Taking another look…"
        case "mcp__visioncli__list_windows": return "Checking open windows…"
        case "mcp__visioncli__device_screenshot": return "Looking at the simulator…"
        case "mcp__visioncli__db_schema": return "Reading the database schema…"
        case "mcp__visioncli__db_query": return "Querying the database…"
        case "Read": return "Reading \(base("file_path"))…"
        case "Grep": return "Searching for “\((input["pattern"] as? String ?? "").prefix(40))”…"
        case "Glob": return "Finding files…"
        case "Edit", "MultiEdit", "Write": return "Editing \(base("file_path"))…"
        case "Bash": return "Running a command…"
        case "ToolSearch": return "Getting ready…"
        default: return "Working…"
        }
    }
}
