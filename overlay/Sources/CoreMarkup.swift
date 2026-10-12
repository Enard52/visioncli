import Foundation

// Answer markup: drawing markers, file references and diagram blocks (Foundation only, tested in overlay/Tests).

/// Something Claude draws on the screen to explain: [[box|circle|arrow:IMAGE:x1,y1,x2,y2:label]], [[step:IMAGE:x,y:N:label]].
struct Mark {
    enum Kind { case box, circle, arrow, step(Int) }
    let kind: Kind
    let image: Int
    let a: CGPoint   // image pixels: box/circle corner, arrow start, step position
    let b: CGPoint   // box/circle opposite corner, arrow end (== a for steps)
    let label: String
}

enum Markup {
    static let boxPattern = #"\[\[box:(\d+):\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*))?\]\]"#
    static let anyMarker = #"\[\[(?:box|circle|arrow|step):[^\]]*\]\]"#
    // x1,y1,x2,y2 (also tolerates "x1,y1:x2,y2", which models sometimes write)
    private static let shapePattern = #"\[\[(box|circle|arrow):(\d+):\s*(\d+)\s*,\s*(\d+)\s*[,:]\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*))?\]\]"#
    private static let stepPattern = #"\[\[step:(\d+):\s*(\d+)\s*,\s*(\d+)\s*:\s*(\d+)\s*(?::([^\]]*))?\]\]"#

    /// All drawing markers in the answer, in the order they appear (so walkthroughs animate in sequence).
    static func marks(in text: String) -> [Mark] {
        var found: [(Int, Mark)] = []
        let range = NSRange(text.startIndex..., in: text)
        func str(_ m: NSTextCheckingResult, _ i: Int) -> String? { Range(m.range(at: i), in: text).map { String(text[$0]) } }
        func num(_ m: NSTextCheckingResult, _ i: Int) -> CGFloat? { str(m, i).flatMap(Double.init).map { CGFloat($0) } }
        for m in try! NSRegularExpression(pattern: shapePattern).matches(in: text, range: range) {
            guard let kind = str(m, 1), let img = num(m, 2), let x1 = num(m, 3), let y1 = num(m, 4), let x2 = num(m, 5), let y2 = num(m, 6) else { continue }
            let k: Mark.Kind = kind == "arrow" ? .arrow : kind == "circle" ? .circle : .box
            found.append((m.range.location, Mark(kind: k, image: Int(img), a: CGPoint(x: x1, y: y1), b: CGPoint(x: x2, y: y2),
                                                 label: (str(m, 7) ?? "").trimmingCharacters(in: .whitespaces))))
        }
        for m in try! NSRegularExpression(pattern: stepPattern).matches(in: text, range: range) {
            guard let img = num(m, 1), let x = num(m, 2), let y = num(m, 3), let n = num(m, 4) else { continue }
            let p = CGPoint(x: x, y: y)
            found.append((m.range.location, Mark(kind: .step(Int(n)), image: Int(img), a: p, b: p,
                                                 label: (str(m, 5) ?? "").trimmingCharacters(in: .whitespaces))))
        }
        return found.sorted { $0.0 < $1.0 }.map(\.1)
    }

    /// Text to show: markers removed (including a half-streamed one at the end).
    static func display(_ text: String) -> String {
        var t = text.replacingOccurrences(of: anyMarker, with: "", options: .regularExpression)
        if let open = t.range(of: "[[", options: .backwards), !t[open.lowerBound...].contains("]]") {
            t = String(t[..<open.lowerBound])
        }
        return t.replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"[ \t]+([,.;:!?])"#, with: "$1", options: .regularExpression) // gap left by a removed marker
            .replacingOccurrences(of: #"  +"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static let fileRefPattern = #"`?((?:[\w.@-]+/)*[\w.@-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-\d+)?`?"#

    /// Markdown with file:line references turned into visioncli://open links.
    static func linked(_ text: String) -> String {
        let re = try! NSRegularExpression(pattern: fileRefPattern)
        var out = text
        for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let whole = Range(m.range, in: text), let p = Range(m.range(at: 1), in: text), let l = Range(m.range(at: 2), in: text),
                  let outRange = Range(m.range, in: out) else { continue }
            let path = String(text[p]), line = String(text[l])
            var comps = URLComponents()
            comps.scheme = "visioncli"
            comps.host = "open"
            comps.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "line", value: line)]
            let shown = text[whole].trimmingCharacters(in: CharacterSet(charactersIn: "`"))
            out.replaceSubrange(outRange, with: "[\(shown)](\(comps.url?.absoluteString ?? ""))")
        }
        return out
    }

    /// The first file:line reference in an answer.
    static func firstFileRef(_ text: String) -> (String, Int)? {
        let re = try! NSRegularExpression(pattern: fileRefPattern)
        guard let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let p = Range(m.range(at: 1), in: text), let l = Range(m.range(at: 2), in: text) else { return nil }
        return (String(text[p]), Int(text[l]) ?? 1)
    }
}

// MARK: - Diagram blocks

enum AnswerSegment: Hashable {
    case text(String)
    case mermaid(String)
    case pendingDiagram // a ```mermaid block that is still streaming in
}

/// Answer text with ```mermaid blocks split out; the views render them, the speaker skips them.
enum DiagramText {
    private static var lastSplit: (answer: String, segments: [AnswerSegment])?
    private static let lastSplitLock = NSLock()

    /// Split an answer into text and mermaid blocks. Remembers the last answer: while streaming, the bubble and the
    /// speaker both ask for the same text.
    static func segments(_ answer: String) -> [AnswerSegment] {
        lastSplitLock.lock()
        let last = lastSplit
        lastSplitLock.unlock()
        if let last, last.answer == answer { return last.segments }
        let out = split(answer)
        lastSplitLock.lock()
        lastSplit = (answer, out)
        lastSplitLock.unlock()
        return out
    }

    private static func split(_ answer: String) -> [AnswerSegment] {
        var out: [AnswerSegment] = []
        var rest = Substring(answer)
        while let open = rest.range(of: "```mermaid") {
            let before = rest[..<open.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            if !before.isEmpty { out.append(.text(before)) }
            let afterOpen = rest[open.upperBound...]
            guard let close = afterOpen.range(of: "```") else { out.append(.pendingDiagram); return out }
            let code = afterOpen[..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            if !code.isEmpty { out.append(.mermaid(code)) }
            rest = afterOpen[close.upperBound...]
        }
        let tail = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { out.append(.text(tail)) }
        return out
    }

    /// Text to read aloud: diagrams become a short mention; an unfinished one cuts the text off (so the spoken
    /// prefix only ever grows while streaming).
    static func speakable(_ answer: String) -> String {
        segments(answer).map {
            switch $0 {
            case .text(let t): return t
            case .mermaid: return "(See the diagram.)"
            case .pendingDiagram: return ""
            }
        }.joined(separator: "\n")
    }
}
