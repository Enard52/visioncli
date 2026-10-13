import Foundation

// Pure text helpers (Foundation only, so overlay/Tests can compile them without the app).

/// Turns answer text into something pleasant to hear. Used by Speaker before every sentence it says.
enum SpokenText {
    /// Splits text into speakable sentences (one TTS request each, so the first starts playing quickly).
    static func sentences(_ text: String) -> [String] {
        var out: [String] = []
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { sub, _, _, _ in
            if let s = sub?.trimmingCharacters(in: .whitespacesAndNewlines), speakable(s) { out.append(s) }
        }
        return out.isEmpty && speakable(text) ? [text] : out
    }

    /// Worth saying out loud: has words, not just punctuation or table borders ("|---|", "|").
    static func speakable(_ s: String) -> Bool {
        s.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
    }

    /// Make text pleasant to hear: "app/Models/Payment.php:42" → "Payment.php, line 42"; drop markdown.
    static func clean(_ s: String) -> String {
        // Code blocks and table rows don't read well aloud (and made the voice say "dot", "bar"…): skip them.
        var t = s.replacingOccurrences(of: #"```[\s\S]*?(```|$)"#, with: "", options: .regularExpression)
        t = t.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("|") }
            .map { $0.replacingOccurrences(of: #"^\s*([-*•]|\d+\.)\s+"#, with: "", options: .regularExpression) }
            .joined(separator: "\n")
        t = t.replacingOccurrences(of: #"(?:[\w.@-]+/)*([\w.@-]+\.\w+):(\d+)(?:-\d+)?"#, with: "$1, line $2", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"https?://\S+"#, with: "a link", options: .regularExpression)
        t = t.replacingOccurrences(of: "→", with: " to ").replacingOccurrences(of: "≈", with: "about ")
        for mark in ["**", "__", "`", "#"] { t = t.replacingOccurrences(of: mark, with: "") }
        return t
    }
}

/// Words the local speech engines should spell right. The window title and the user's vocabulary file are passed in,
/// so the choice itself stays testable.
enum Vocabulary {
    /// Parakeet's word list: the project, code-like words in the window title (PaymentController.php →
    /// PaymentController), the user's vocabulary file and common developer names. Deduplicated, at most 80.
    static func words(project: String, windowTitle: String?, custom: String?) -> [String] {
        var words = [project]
        if let title = windowTitle {
            for token in title.components(separatedBy: CharacterSet.alphanumerics.inverted) where token.count >= 4 {
                // CamelCase / snake-ish identifiers only; plain words don't need help.
                if token.dropFirst().contains(where: \.isUppercase) { words.append(token) }
            }
        }
        words += customWords(custom)
        words += ["VisionCLI", "Laravel", "SwiftUI", "Xcode", "TypeScript", "JavaScript", "GitHub", "kubectl", "Postgres", "MySQL",
                  "Redis", "Docker", "Kubernetes", "Next.js", "Node.js", "npm", "PhpStorm", "Tailwind", "GraphQL", "Webpack", "Vite"]
        var seen = Set<String>()
        return words.filter { seen.insert($0.lowercased()).inserted }.prefix(80).map { $0 }
    }

    /// Whisper's prompt: the project, the whole window title, the vocabulary file and common dev terms.
    static func prompt(project: String, windowTitle: String?, custom: String?) -> String {
        var words = [project]
        if let title = windowTitle, !title.isEmpty { words.append(title) }
        words += customWords(custom)
        words += ["Claude", "Laravel", "PHP", "Swift", "SwiftUI", "Xcode", "TypeScript", "React", "SQL", "API", "JSON", "migration", "controller"]
        return "Vocabulary: " + words.joined(separator: ", ") + "."
    }

    /// The vocabulary file's entries: comma- or newline-separated, blanks dropped.
    static func customWords(_ custom: String?) -> [String] {
        guard let custom else { return [] }
        return custom.components(separatedBy: CharacterSet(charactersIn: ",\n")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// One line per executed step of a browser task, for the bubble.
enum BrowserTaskText {
    static func line(_ step: [String: Any]) -> String? {
        let label = step["label"] as? String ?? ""
        switch step["kind"] as? String {
        case "fill": return "Typed “\(step["text"] as? String ?? "")” into \(label)"
        case "click": return "Clicked \(label)"
        case "select":
            let parts = label.components(separatedBy: " → ")
            return parts.count > 1 ? "Chose \(parts.dropFirst().joined(separator: " → ")) in \(parts[0])" : "Chose \(label)"
        case "scroll": return label
        case "wait": return "Waited for the page"
        default: return nil // done / blocked: the summary says it
        }
    }

    static func summary(status: String, message: String, steps: Int, ms: Int) -> String {
        let secs = String(format: "%.1f", Double(ms) / 1000)
        switch status {
        case "done": return "Done in \(secs) s (\(steps) step\(steps == 1 ? "" : "s"))."
        case "stopped": return "Stopped."
        default: return message.isEmpty ? "I couldn't finish that." : message
        }
    }

    static func body(header: String, lines: [String]) -> String {
        ([header] + (lines.isEmpty ? [] : [""] + lines.enumerated().map { "\($0.offset + 1). \($0.element)" })).joined(separator: "\n")
    }
}
