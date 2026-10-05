import AppKit
import SwiftUI

// MARK: - Answer markup

struct Box: Identifiable {
    let id = UUID()
    let image: Int
    let rect: CGRect // image pixels
    let label: String
}

enum Markup {
    static let boxPattern = #"\[\[box:(\d+):\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?::([^\]]*))?\]\]"#

    /// Highlight markers in the answer.
    static func boxes(in text: String) -> [Box] {
        let re = try! NSRegularExpression(pattern: boxPattern)
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
            func n(_ i: Int) -> CGFloat? { Range(m.range(at: i), in: text).flatMap { Double(text[$0]) }.map { CGFloat($0) } }
            guard let img = n(1), let x1 = n(2), let y1 = n(3), let x2 = n(4), let y2 = n(5) else { return nil }
            let label = Range(m.range(at: 6), in: text).map { String(text[$0]).trimmingCharacters(in: .whitespaces) } ?? ""
            return Box(image: Int(img), rect: CGRect(x: min(x1, x2), y: min(y1, y2), width: abs(x2 - x1), height: abs(y2 - y1)), label: label)
        }
    }

    /// Text to show: markers removed (including a half-streamed one at the end).
    static func display(_ text: String) -> String {
        var t = text.replacingOccurrences(of: boxPattern, with: "", options: .regularExpression)
        if let open = t.range(of: "[[", options: .backwards), !t[open.lowerBound...].contains("]]") {
            t = String(t[..<open.lowerBound])
        }
        return t.replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
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

// MARK: - Highlights drawn on the real screen

final class HighlightOverlay {
    private var panels: [NSPanel] = []
    private var hideWork: DispatchWorkItem?

    /// rects are AppKit global coordinates.
    func show(_ items: [(CGRect, String)], for seconds: Double = 12, persistent: Bool = false) {
        hide()
        for screen in NSScreen.screens {
            let local = items.filter { $0.0.intersects(screen.frame) }.map { item -> (CGRect, String) in
                // AppKit global → SwiftUI top-left local to this screen
                let r = item.0
                return (CGRect(x: r.minX - screen.frame.minX, y: screen.frame.maxY - r.maxY, width: r.width, height: r.height), item.1)
            }
            guard !local.isEmpty else { continue }
            let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.ignoresMouseEvents = true
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.contentView = NSHostingView(rootView: HighlightView(items: local, dashed: persistent))
            panel.setFrame(screen.frame, display: true)
            panel.orderFrontRegardless()
            panels.append(panel)
        }
        if !persistent {
            let work = DispatchWorkItem { [weak self] in self?.hide() }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        }
    }

    func hide() {
        hideWork?.cancel()
        panels.forEach { $0.orderOut(nil) }
        panels = []
    }
}

struct HighlightView: View {
    let items: [(CGRect, String)]
    var dashed = false
    @State private var shown = false
    @State private var pulse = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(items.indices, id: \.self) { i in
                let r = items[i].0.insetBy(dx: -4, dy: -4)
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(accent, style: StrokeStyle(lineWidth: 3, dash: dashed ? [8, 5] : []))
                    .shadow(color: .cyan.opacity(pulse ? 0.9 : 0.4), radius: pulse ? 12 : 5)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
                    .scaleEffect(shown ? 1 : 1.08)
                    .opacity(shown ? 1 : 0)
                if !items[i].1.isEmpty {
                    Text(items[i].1)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Capsule().fill(bubbleFill))
                        .overlay(Capsule().stroke(bubbleStroke))
                        .fixedSize()
                        .offset(x: r.minX, y: max(0, r.minY - 28))
                        .opacity(shown ? 1 : 0)
                }
            }
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { shown = true }
            withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true }
        }
    }
}

// MARK: - Drag to select a region

final class SelectionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class SelectionView: NSView {
    var onDone: (CGRect?) -> Void = { _ in }
    private var start: NSPoint?
    private var current: NSPoint?

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    override func mouseDown(with e: NSEvent) { start = convert(e.locationInWindow, from: nil); current = start; needsDisplay = true }
    override func mouseDragged(with e: NSEvent) { current = convert(e.locationInWindow, from: nil); needsDisplay = true }
    override func mouseUp(with e: NSEvent) {
        current = convert(e.locationInWindow, from: nil)
        guard let r = selection, r.width > 8, r.height > 8, let window else { onDone(nil); return }
        onDone(window.convertToScreen(r)) // AppKit global
    }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { onDone(nil) } }

    private var selection: NSRect? {
        guard let s = start, let c = current else { return nil }
        return NSRect(x: min(s.x, c.x), y: min(s.y, c.y), width: abs(s.x - c.x), height: abs(s.y - c.y))
    }

    override func draw(_ dirty: NSRect) {
        let path = NSBezierPath(rect: bounds)
        if let r = selection { path.append(NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4)) }
        path.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.28).setFill()
        path.fill()
        if let r = selection {
            let border = NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4)
            border.lineWidth = 2
            NSColor.systemCyan.setStroke()
            border.stroke()
        } else {
            let hint = "Drag around what you mean · keep talking · esc to cancel" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.white]
            let size = hint.size(withAttributes: attrs)
            hint.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.maxY - 90), withAttributes: attrs)
        }
    }
}

final class RegionSelector {
    private var panels: [SelectionPanel] = []
    private var completion: ((CGRect?) -> Void)?
    var isActive: Bool { !panels.isEmpty }

    /// Calls back with the selected rect in top-left points, or nil if cancelled.
    func begin(_ done: @escaping (CGRect?) -> Void) {
        cancel()
        completion = done
        for screen in NSScreen.screens {
            let panel = SelectionPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = SelectionView(frame: NSRect(origin: .zero, size: screen.frame.size))
            view.onDone = { [weak self] rect in self?.finish(rect.map(Geometry.toTopLeft)) }
            panel.contentView = view
            panel.setFrame(screen.frame, display: true)
            panel.orderFrontRegardless()
            panels.append(panel)
        }
        let p = NSEvent.mouseLocation
        if let under = panels.first(where: { NSMouseInRect(p, $0.frame, false) }) {
            under.makeKey()
            under.makeFirstResponder(under.contentView)
        }
    }

    func cancel() { finish(nil) }

    private func finish(_ rect: CGRect?) {
        panels.forEach { $0.orderOut(nil) }
        panels = []
        let done = completion
        completion = nil
        done?(rect)
    }
}

// MARK: - Open a file:line in the right editor

enum Opener {
    static let jetbrains = ["phpstorm", "intellij idea", "idea", "webstorm", "pycharm", "goland", "rider", "clion", "rubymine", "datagrip", "android studio", "rustrover", "fleet"]

    /// Open path:line, preferring the editor the question was asked from.
    static func open(path: String, line: Int, project: String, preferredApp: WinInfo?) {
        DispatchQueue.global().async {
            guard let file = resolve(path, in: project) else {
                log("open: couldn't find \(path) in \(project)")
                return
            }
            let app = preferredApp?.app.lowercased() ?? ""
            if jetbrains.contains(where: { app.contains($0) }), let pid = preferredApp?.pid,
               let exe = NSRunningApplication(processIdentifier: pid)?.executableURL {
                shell(exe.path, ["--line", String(line), file])
            } else if app == "xcode" {
                shell("/usr/bin/xed", ["--line", String(line), file])
            } else if let scheme = ["code": "vscode", "visual studio code": "vscode", "cursor": "cursor", "windsurf": "windsurf"][app],
                      let url = URL(string: "\(scheme)://file\(file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file):\(line)") {
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            } else {
                DispatchQueue.main.async { NSWorkspace.shared.open(URL(fileURLWithPath: file)) }
            }
        }
    }

    private static func resolve(_ path: String, in project: String) -> String? {
        let fm = FileManager.default
        let candidates = path.hasPrefix("/") ? [path] : ["\(project)/\(path)"]
        if let hit = candidates.first(where: { fm.fileExists(atPath: $0) }) { return hit }
        // Claude sometimes cites just the file name; find it in the project.
        let (_, out, _) = shell("/usr/bin/find", [project, "-name", (path as NSString).lastPathComponent, "-not", "-path", "*/node_modules/*",
                                                  "-not", "-path", "*/vendor/*", "-not", "-path", "*/.git/*"])
        return out.split(separator: "\n").map(String.init).first { $0.hasSuffix(path) } ?? out.split(separator: "\n").first.map(String.init)
    }
}

// MARK: - Menu-bar icon

/// The logo as a monochrome template image: an eye whose pupil is a mouse pointer.
enum MenuIcon {
    static func make() -> NSImage {
        let img = NSImage(size: NSSize(width: 20, height: 18), flipped: true) { r in
            NSColor.black.set()
            // Almond eye outline.
            let eye = NSBezierPath()
            eye.move(to: NSPoint(x: 2.3, y: 9))
            eye.curve(to: NSPoint(x: 17.7, y: 9), controlPoint1: NSPoint(x: 6, y: 2.4), controlPoint2: NSPoint(x: 14, y: 2.4))
            eye.curve(to: NSPoint(x: 2.3, y: 9), controlPoint1: NSPoint(x: 14, y: 15.6), controlPoint2: NSPoint(x: 6, y: 15.6))
            eye.lineWidth = 1.5
            eye.lineJoinStyle = .round
            eye.stroke()
            // Iris ring.
            let iris = NSBezierPath(ovalIn: NSRect(x: 6.25, y: 4.75, width: 8.5, height: 8.5))
            iris.lineWidth = 1.3
            iris.stroke()
            // Pointer arrow as the pupil.
            let arrow = NSBezierPath()
            arrow.move(to: NSPoint(x: 9.1, y: 5.9))
            arrow.line(to: NSPoint(x: 9.1, y: 11.6))
            arrow.line(to: NSPoint(x: 10.5, y: 10.3))
            arrow.line(to: NSPoint(x: 11.6, y: 12.4))
            arrow.line(to: NSPoint(x: 12.4, y: 12.0))
            arrow.line(to: NSPoint(x: 11.3, y: 9.9))
            arrow.line(to: NSPoint(x: 13.1, y: 9.8))
            arrow.close()
            arrow.fill()
            return true
        }
        img.isTemplate = true
        return img
    }
}
