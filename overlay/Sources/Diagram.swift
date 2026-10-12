import SwiftUI
import WebKit

// Mermaid diagrams in the answer bubble: ```mermaid blocks are rendered with the bundled mermaid.js (offline).

enum AnswerSegment: Hashable {
    case text(String)
    case mermaid(String)
    case pendingDiagram // a ```mermaid block that is still streaming in
}

enum Diagrams {
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

    /// Fallback when the cache dir can't be set up: the bundled mermaid.js inlined into the page.
    static let script: String = {
        guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return js.replacingOccurrences(of: "</script", with: "<\\/script")
    }()

    /// A folder holding a copy of the bundled mermaid.js, where each diagram's page is written and loaded from, so
    /// the 3.5 MB script isn't pasted into every page (read access is granted to just this folder). nil if unavailable.
    static let pageDir: URL? = {
        guard let js = Bundle.main.url(forResource: "mermaid.min", withExtension: "js") else { return nil }
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("visioncli-diagrams", isDirectory: true)
        let copy = dir.appendingPathComponent("mermaid.min.js")
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            // Old pages from earlier runs.
            for f in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "html" {
                try? fm.removeItem(at: f)
            }
            let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
            let src = try js.resourceValues(forKeys: keys)
            let dst = try? copy.resourceValues(forKeys: keys)
            if dst?.fileSize != src.fileSize || dst?.contentModificationDate != src.contentModificationDate {
                try? fm.removeItem(at: copy)
                try fm.copyItem(at: js, to: copy) // a copy, not a symlink: WebKit's sandbox checks the real path
            }
            return dir
        } catch {
            log("diagram: can't set up \(dir.path): \(error.localizedDescription); inlining mermaid.js")
            return nil
        }
    }()

    /// Writes the page for `code` next to the mermaid.js copy; nil if that isn't possible.
    static func pageFile(for code: String) -> URL? {
        guard let dir = pageDir else { return nil }
        let url = dir.appendingPathComponent("d-\(String(UInt(bitPattern: code.hashValue), radix: 36)).html")
        do { try Data(page(for: code, inline: false).utf8).write(to: url, options: .atomic) } catch { return nil }
        return url
    }

    /// Shows `code` in `web`: from a file next to mermaid.js when possible, else with the script inlined.
    static func load(_ code: String, in web: WKWebView) {
        if let file = pageFile(for: code) {
            web.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        } else {
            web.loadHTMLString(page(for: code, inline: true), baseURL: nil)
        }
    }

    static func page(for code: String, inline: Bool = true) -> String {
        let json = (try? JSONSerialization.data(withJSONObject: [code], options: [])).map { String(decoding: $0, as: UTF8.self) } ?? "[\"\"]"
        let mermaid = inline ? "<script>\(script)</script>" : "<script src=\"mermaid.min.js\"></script>"
        return """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;color:#e6e6ea;font:13px -apple-system,system-ui}
        #d{display:flex;justify-content:center;padding:4px 0}
        #d svg{max-width:100%;height:auto}
        .err{color:#ff9b8a;font:12px ui-monospace,Menlo}
        </style>\(mermaid)</head><body><div id="d"></div><script>
        const d = document.getElementById('d');
        const report = () => requestAnimationFrame(() => window.webkit.messageHandlers.size.postMessage(Math.ceil(d.getBoundingClientRect().height)));
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict',
          themeVariables: { background: 'transparent', fontFamily: '-apple-system, system-ui', primaryColor: '#1f2937',
            primaryBorderColor: '#22d3ee', lineColor: '#a855f7', primaryTextColor: '#e6e6ea' } });
        mermaid.render('g', \(json)[0]).then(({ svg }) => { d.innerHTML = svg; report(); })
          .catch(e => { d.innerHTML = '<div class="err">Diagram couldn\\'t be drawn: ' + String(e.message || e).slice(0, 160) + '</div>'; report(); });
        </script></body></html>
        """
    }
}

/// Renders one mermaid diagram and reports its height so the bubble can size itself.
struct MermaidView: NSViewRepresentable {
    let code: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "size")
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: height), configuration: config)
        web.setValue(false, forKey: "drawsBackground") // transparent, the bubble shows through
        context.coordinator.loaded = code
        Diagrams.load(code, in: web)
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.loaded != code else { return }
        context.coordinator.loaded = code
        Diagrams.load(code, in: web)
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var parent: MermaidView
        var loaded = ""
        init(_ parent: MermaidView) { self.parent = parent }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let h = message.body as? Double ?? (message.body as? Int).map(Double.init), h > 0 else { return }
            DispatchQueue.main.async { self.parent.height = min(CGFloat(h), 520) }
        }
    }
}

struct DiagramBlock: View {
    let code: String
    @State private var height: CGFloat = 140
    var body: some View {
        MermaidView(code: code, height: $height)
            .frame(width: 420, height: height)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.03)))
    }
}

struct PendingDiagram: View {
    var body: some View {
        HStack(spacing: 8) {
            Spinner(size: 14)
            Text("Drawing diagram…").font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
        }
        .frame(width: 420, height: 40, alignment: .leading)
    }
}

/// A screenshot with the answer's drawings (boxes, circles, arrows, steps) on it, shown inside the bubble.
struct AnnotatedShot: Identifiable {
    let id = UUID()
    let image: NSImage
    let size: CGSize        // image pixels
    let items: [DrawItem]   // image-pixel coordinates, top-left origin
}

struct AnnotatedShotView: View {
    let shot: AnnotatedShot
    private let width: CGFloat = 420

    var body: some View {
        let scale = width / max(shot.size.width, 1)
        let height = shot.size.height * scale
        ZStack(alignment: .topLeading) {
            Image(nsImage: shot.image)
                .resizable()
                .frame(width: width, height: height)
                .opacity(0.9)
            ForEach(shot.items.indices, id: \.self) { i in
                let item = shot.items[i]
                DrawingView(item: DrawItem(kind: item.kind,
                                           a: CGPoint(x: item.a.x * scale, y: item.a.y * scale),
                                           b: CGPoint(x: item.b.x * scale, y: item.b.y * scale),
                                           label: item.label),
                            delay: Double(i) * 0.35)
            }
        }
        .frame(width: width, height: height, alignment: .topLeading)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.white.opacity(0.12)))
    }
}
