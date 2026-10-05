import SwiftUI
import WebKit

// Mermaid diagrams in the answer bubble: ```mermaid blocks are rendered with the bundled mermaid.js (offline).

enum AnswerSegment: Hashable {
    case text(String)
    case mermaid(String)
    case pendingDiagram // a ```mermaid block that is still streaming in
}

enum Diagrams {
    /// Split an answer into text and mermaid blocks.
    static func segments(_ answer: String) -> [AnswerSegment] {
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

    /// The bundled mermaid.js, inlined into each diagram page (no network, no file-access rules to fight).
    static let script: String = {
        guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return js.replacingOccurrences(of: "</script", with: "<\\/script")
    }()

    static func page(for code: String) -> String {
        let json = (try? JSONSerialization.data(withJSONObject: [code], options: [])).map { String(decoding: $0, as: UTF8.self) } ?? "[\"\"]"
        return """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;color:#e6e6ea;font:13px -apple-system,system-ui}
        #d{display:flex;justify-content:center;padding:4px 0}
        #d svg{max-width:100%;height:auto}
        .err{color:#ff9b8a;font:12px ui-monospace,Menlo}
        </style><script>\(script)</script></head><body><div id="d"></div><script>
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
        web.loadHTMLString(Diagrams.page(for: code), baseURL: nil)
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.loaded != code else { return }
        context.coordinator.loaded = code
        web.loadHTMLString(Diagrams.page(for: code), baseURL: nil)
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
