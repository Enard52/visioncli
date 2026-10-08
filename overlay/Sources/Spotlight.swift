import AppKit

/// While a question will include a screenshot, dims the display the pointer is on except the window that's going to be
/// captured, so it's obvious what the assistant will see. Follows the pointer (and the window under it) across displays.
/// Click-through, and never in the screenshot itself (window captures only include that window).
final class Spotlight {
    private var panels: [NSPanel] = []
    private var timer: Timer?
    private var lastHole: CGRect?
    private var screenFrame: CGRect?

    func show() {
        hide()
        guard let screen = Self.pointerScreen else { return }
        screenFrame = screen.frame
        do {
            let p = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.level = .floating
            p.isOpaque = false
            p.backgroundColor = .clear
            p.ignoresMouseEvents = true
            p.hasShadow = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            p.contentView = DimView(frame: NSRect(origin: .zero, size: screen.frame.size))
            p.setFrame(screen.frame, display: false)
            p.alphaValue = 0
            p.orderFrontRegardless()
            panels.append(p)
        }
        update()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panels.forEach { $0.animator().alphaValue = 1 }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.update() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    private static var pointerScreen: NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        lastHole = nil
        screenFrame = nil
        panels.forEach { $0.orderOut(nil) }
        panels = []
    }

    var isShown: Bool { !panels.isEmpty }

    private func update() {
        // Pointer moved to another display: dim that one instead.
        if let screen = Self.pointerScreen, screen.frame != screenFrame, let p = panels.first {
            screenFrame = screen.frame
            p.setFrame(screen.frame, display: false)
            p.contentView?.frame = NSRect(origin: .zero, size: screen.frame.size)
            lastHole = nil
        }
        let hole = Screen.windowUnderPointer().map { Geometry.toAppKit($0.bounds) }
        guard hole != lastHole else { return }
        lastHole = hole
        for p in panels {
            guard let view = p.contentView as? DimView else { continue }
            // Global AppKit coordinates → this panel's view.
            view.hole = hole.map { $0.offsetBy(dx: -p.frame.minX, dy: -p.frame.minY) }
            view.needsDisplay = true
        }
    }
}

private final class DimView: NSView {
    var hole: CGRect?

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(rect: bounds)
        if let hole, hole.intersects(bounds) {
            path.append(NSBezierPath(roundedRect: hole, xRadius: 10, yRadius: 10))
            path.windingRule = .evenOdd
        }
        NSColor.black.withAlphaComponent(0.35).setFill()
        path.fill()
        if let hole, hole.intersects(bounds) {
            let ring = NSBezierPath(roundedRect: hole.insetBy(dx: -1.5, dy: -1.5), xRadius: 11, yRadius: 11)
            ring.lineWidth = 2
            NSColor.systemCyan.withAlphaComponent(0.8).setStroke()
            ring.stroke()
        }
    }
}
