import Foundation

/// Gemini CLI has no system-prompt flag; the first message of a background session carries these instructions.
let geminiVoicePrompt = """
[Instructions for this conversation] The user asks questions out loud; your reply appears in a small bubble above their mouse pointer and may be read aloud.
Screenshots of what they're looking at are attached with each question (as @file references), with the mouse pointer position in image pixels. "This", "here" and "that" mean what is under the pointer.
- If code is visible, find the file in the project and read the relevant lines before answering. Cite files as path:line relative to the project root.
- The visioncli tools are available: look (fresh screenshot, use under_cursor true), db_schema / db_query (read-only database), device_screenshot (iOS Simulator / Android), and browser_* (read and control Chrome/Brave pages).
- To explain visually, point at things with markers (pixel coordinates in that attached image; IMAGE is 1-based; never mention the markers themselves). They are drawn on the user's real screen, right over the thing you mean. Put all markers together on the LAST line of your reply so the text stays readable: [[box:IMAGE:x1,y1,x2,y2:label]] outlines an area, [[circle:IMAGE:x1,y1,x2,y2:label]] circles it, [[arrow:IMAGE:x1,y1,x2,y2:label]] points from (x1,y1) to (x2,y2), [[step:IMAGE:x,y:N:label]] places a numbered step N (use 1, 2, 3… to walk through a flow). They animate in the order you write them.
- For flows, relationships, data models or architecture, you may add one small ```mermaid diagram (flowchart, sequence or erDiagram, at most ~12 nodes). It is rendered as a picture in the bubble; keep the text around it short.
- Prefer reading files and the visioncli tools. Read-only shell commands (grep, rg, ls, cat, find, git status/log/diff) are allowed; other commands need the user's approval first, so only run them when really needed. Don't edit or write files here; if the user asks for a change, describe it briefly and suggest switching VisionCLI to terminal mode.
- Reply in plain conversational text, under about 100 words unless they ask for detail. No headings or tables; code snippets of 3 lines at most. The question came from speech-to-text, so words may be misheard; infer intent.

"""

/// Copies screenshots somewhere without spaces so they can be passed as `@path` (Gemini's file-include syntax).
func geminiAttachable(_ shots: [Shot]) -> [String] {
    let dir = home.appendingPathComponent("Library/Caches/visioncli/shots")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return shots.compactMap { shot in
        let url = dir.appendingPathComponent(shot.file?.lastPathComponent ?? "shot-\(UUID().uuidString.prefix(8)).jpg")
        return (try? shot.jpeg.write(to: url)) != nil ? url.path : nil
    }
}

/// Background (bubble-only) Gemini: one `gemini -p … -o stream-json` run per question, resuming the same session.
/// Headless Gemini can't ask for approval, so only read-only tools and the (trusted) visioncli tools run.
final class GeminiSession: AssistantSession {
    let cwd: String
    private let cfg: Config
    private var proc: Process?
    private(set) var busy = false
    private(set) var sessionId: String? {
        didSet { UserDefaults.standard.set(sessionId, forKey: "geminiBackground:\(cwd)") }
    }
    private var answer = ""

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
        self.sessionId = UserDefaults.standard.string(forKey: "geminiBackground:\(cwd)")
    }

    func warm() {} // nothing to keep running between questions
    func respond(to req: PermissionRequest, allow: Bool) {}

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
        guard let gemini = cfg.gemini else { onDone(nil, "Gemini CLI wasn't found. Install it (npm install -g @google/gemini-cli) and reopen VisionCLI."); return }
        let resume = sessionId != nil && TerminalProbe.sessionFile(.gemini, cwd: cwd, sessionId: sessionId!) != nil
        let sid = resume ? sessionId! : UUID().uuidString.lowercased()
        var prompt = resume ? "" : geminiVoicePrompt
        prompt += text
        for path in geminiAttachable(shots) { prompt += "\n@\(path)" }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: gemini)
        p.arguments = ["-p", prompt, "-o", "stream-json", "--approval-mode", "default",
                       "--allowed-mcp-server-names", "visioncli", resume ? "--resume" : "--session-id", sid]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.environment = cfg.geminiEnvironment()
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice

        var buffer = Data(), errText = "", gotResult = false
        answer = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            buffer.append(h.availableData)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    guard let self, self.proc === p else { return }
                    if obj["type"] as? String == "result" { gotResult = true }
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
            log("gemini exited \(proc.terminationStatus)\(errText.isEmpty ? "" : ": " + errText.suffix(300))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                guard let self, self.proc === proc else { return }
                self.proc = nil
                if self.busy && !gotResult {
                    self.busy = false
                    let tail = errText.split(separator: "\n").suffix(3).joined(separator: "\n")
                    self.onDone(nil, tail.isEmpty ? "Gemini stopped unexpectedly (exit \(proc.terminationStatus))." : geminiFriendlyError(errText))
                }
            }
        }
        do {
            try p.run()
            proc = p
            busy = true
            log("ask gemini (\(cwd), \(resume ? "resume" : "new") \(sid)): \(text.prefix(200))")
        } catch {
            onDone(nil, "Couldn't start gemini: \(error.localizedDescription)")
        }
    }

    private func handle(_ obj: [String: Any]) {
        switch obj["type"] as? String {
        case "init":
            if let sid = obj["session_id"] as? String { sessionId = sid }
        case "message":
            guard obj["role"] as? String == "assistant", let chunk = obj["content"] as? String else { return }
            answer += chunk
            onDelta(chunk)
        case "tool_use":
            let name = obj["tool_name"] as? String ?? "", input = obj["parameters"] as? [String: Any] ?? [:]
            answer = "" // text before a tool call was narration
            onToolStart()
            onStatus(ClaudeSession.describe(tool: name, input: input))
            onToolUse(name, input)
        case "tool_result":
            let output = (obj["output"] as? String) ?? (obj["error"] as? [String: Any])?["message"] as? String ?? ""
            onToolResult(output, obj["status"] as? String == "error", nil)
        case "result":
            busy = false
            if obj["status"] as? String == "success" {
                onDone(answer.trimmingCharacters(in: .whitespacesAndNewlines), nil)
            } else {
                onDone(nil, geminiFriendlyError(((obj["error"] as? [String: Any])?["message"] as? String) ?? "Gemini reported an error."))
            }
        default:
            break
        }
    }
}

/// Turn Gemini's auth failures into something actionable.
func geminiFriendlyError(_ raw: String) -> String {
    if raw.contains("API_KEY_INVALID") || raw.contains("API key not valid") {
        return "Gemini rejected the API key in 👁 → Settings → API Keys. Fix or remove it (without it, VisionCLI uses your normal `gemini` sign-in)."
    }
    if raw.contains("IneligibleTierError") || raw.contains("no longer supported for Gemini Code Assist") {
        return "Google refused this Gemini CLI sign-in (\"no longer supported for Code Assist for individuals\"). Run `gemini` in a terminal and use /auth to sign in with an account that has Gemini CLI access, or switch 👁 → Assistant back to Claude Code."
    }
    return String(raw.suffix(400))
}
