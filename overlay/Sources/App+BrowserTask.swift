import AppKit

// Multi-step browser tasks ("find a stay in Lisbon with a pool and open it"): Jev routed the command as a browser
// task, so `visioncli browse` runs the Jev agent on the page in front and streams its steps, shown live in the bubble.
// Esc stops it (dismiss() terminates the process; browserd stops when the client goes away).

extension AppDelegate {
    func runBrowserTask(_ text: String) {
        guard let node = cfg.node, let server = cfg.server else { captureAndAsk(text); return }
        browseProc?.terminate()
        let started = Date()
        var lines: [String] = []
        var header = "Working on it in the browser…"
        var finished = false
        activity.question(text, project: currentProject, shots: [])
        state.raw = BrowserTaskText.body(header: header, lines: lines)
        set(.answering)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [server, "browse", text]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        env["VISIONCLI_FRONT_APP"] = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice

        let finish: (String, String, Int, Int) -> Void = { [weak self] status, message, steps, ms in
            guard let self, !finished else { return }
            finished = true
            if self.browseProc === p { self.browseProc = nil }
            let summary = BrowserTaskText.summary(status: status, message: message, steps: steps, ms: ms)
            log("browse: \(status) \(steps) steps \(ms)ms \(message)")
            self.activity.note("\(summary) (Jev agent)")
            let answer = BrowserTaskText.body(header: summary, lines: lines)
            self.history.add(HistoryEntry(date: Date(), project: self.currentProject, question: text, answer: answer, screenshots: []))
            guard self.state.question == text, self.state.phase == .answering else { return } // dismissed or replaced
            self.state.raw = answer
            self.set(status == "done" ? .done : .error)
            self.speaker.feed(summary, final: true)
            self.scheduleHide(after: status == "done" ? 8 : 15)
        }

        var buffer = Data()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty else { h.readabilityHandler = nil; return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let e = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                DispatchQueue.main.async {
                    guard let self, !finished else { return }
                    switch e["type"] as? String {
                    case "status": header = e["message"] as? String ?? header
                    case "step":
                        if let step = e["step"] as? [String: Any], let l = BrowserTaskText.line(step) { lines.append(l) }
                        header = "Working on it in the browser…"
                    case "end":
                        finish(e["status"] as? String ?? "error", e["message"] as? String ?? "", e["steps"] as? Int ?? lines.count,
                               e["ms"] as? Int ?? Int(Date().timeIntervalSince(started) * 1000))
                        return
                    default: return
                    }
                    if self.state.question == text, self.state.phase == .answering {
                        self.state.raw = BrowserTaskText.body(header: header, lines: lines)
                    }
                }
            }
        }
        p.terminationHandler = { proc in
            // The last stdout lines (the "end" event) may still be on their way: let them land first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                finish(proc.terminationReason == .uncaughtSignal ? "stopped" : "error", "The browser agent stopped unexpectedly.",
                       lines.count, Int(Date().timeIntervalSince(started) * 1000))
            }
        }
        do { try p.run() } catch { finish("error", "Couldn't start the browser agent.", 0, 0); return }
        browseProc = p
    }
}
