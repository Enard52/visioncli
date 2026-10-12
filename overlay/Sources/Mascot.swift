import AppKit
import SwiftUI

/// Visi, the mascot: while you hold ⌥ (and while it thinks) a little robot leans in from the right edge of the screen
/// the pointer is on, as if peeking around the screen's frame. It blinks, its mouth moves while you talk, and it makes
/// a thinking face while the answer is on its way; it slides back out when the answer arrives. Click-through.
/// Frames are Resources/mascot/{peek,blink,talk,think}.png, all the same size and pose; the body's cut-off edge sits at
/// `cutX` of the image width and is placed exactly on the screen edge.
final class Mascot {
    enum Mood { case listening, thinking }

    var level: () -> CGFloat = { 0 }
    private let model = MascotModel()
    private var panel: NSPanel?
    private var timer: Timer?
    private var hideWork: DispatchWorkItem?

    static let height: CGFloat = 130
    static let headroom: CGFloat = 32 // room above and left of the antenna so its glow isn't cut off
    static let sideroom: CGFloat = 28
    static let cutX: CGFloat = 264.0 / 285.0
    static var imageWidth: CGFloat { height * MascotModel.aspect }
    private static var size: CGSize { CGSize(width: sideroom + imageWidth * cutX, height: height + headroom) }

    func show(_ mood: Mood) {
        guard model.frames["peek"] != nil else { return }
        hideWork?.cancel()
        hideWork = nil
        model.leaving = nil
        model.mood = mood
        let p = panel ?? makePanel()
        panel = p
        if !p.isVisible {
            place(p)
            model.peek = false
            model.visible = true
            // Sometimes it waves hello as it peeks in; the first random face comes a few seconds later.
            let now = Date()
            moment = Double.random(in: 0...1) < 0.35 && model.frames["wave"] != nil ? ("wave", now.addingTimeInterval(1.3)) : nil
            nextMoment = now.addingTimeInterval(.random(in: 3...6))
            p.orderFrontRegardless()
            DispatchQueue.main.async { withAnimation(.spring(response: 0.24, dampingFraction: 0.58)) { self.model.peek = true } }
        }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(timer!, forMode: .common)
        }
    }

    /// A quick happy face, then it snaps back behind the screen edge.
    func hide() {
        guard let p = panel, p.isVisible, hideWork == nil else { return }
        model.leaving = Date()
        let w = DispatchWorkItem { [weak self] in
            withAnimation(.easeIn(duration: 0.14)) { self?.model.peek = false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
                guard self?.hideWork != nil else { return } // shown again meanwhile
                p.orderOut(nil)
                self?.model.visible = false
                self?.timer?.invalidate()
                self?.timer = nil
                self?.hideWork = nil
                self?.model.leaving = nil
            }
        }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: w)
    }

    private var talkFlip = 0
    private var nextBlink = Date().addingTimeInterval(2)
    private var blinkUntil = Date.distantPast
    /// Now and then Visi pulls a face for a moment (a wink, a laugh, a wave…), never while you're talking.
    private var moment: (frame: String, until: Date)?
    private var nextMoment = Date()
    private var lastMoment = ""
    private static let moments: [(frame: String, seconds: Double)] = [("wink", 0.7), ("surprised", 0.8), ("laugh", 1.0), ("wave", 1.4)]

    private func tick() {
        guard let p = panel else { return }
        place(p)
        let now = Date()
        if now >= nextBlink {
            blinkUntil = now.addingTimeInterval(0.14)
            nextBlink = now.addingTimeInterval(.random(in: 2.5...5))
        }
        model.level = level()
        if let m = moment, now >= m.until { moment = nil }
        if moment == nil, model.leaving == nil, now >= nextMoment, level() < 0.1 {
            let pick = Self.moments.filter { $0.frame != lastMoment && model.frames[$0.frame] != nil }.randomElement()
            if let pick {
                moment = (pick.frame, now.addingTimeInterval(pick.seconds))
                lastMoment = pick.frame
            }
            nextMoment = now.addingTimeInterval(.random(in: 4...8))
        }
        let frame: String
        if model.leaving != nil {
            frame = model.frames["wave"] != nil ? "wave" : "talk" // bye!
        } else if let m = moment, level() < 0.1 {
            frame = m.frame
        } else if now < blinkUntil {
            frame = "blink"
        } else if level() > 0.1 {
            // Mouth flaps while you speak, faster when louder.
            talkFlip += 1
            frame = (talkFlip / max(1, Int(4 - level() * 3))) % 2 == 0 ? "talk" : "peek"
        } else {
            frame = "peek"
        }
        if model.frame != frame { model.frame = frame }
    }

    /// Right edge of the pointer's screen, a bit above the bottom.
    private func place(_ p: NSPanel) {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        let frame = NSRect(x: screen.frame.maxX - Self.size.width, y: vf.minY + vf.height * 0.12,
                           width: Self.size.width, height: Self.size.height)
        if p.frame != frame { p.setFrame(frame, display: false) }
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: Self.size), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .screenSaver
        p.isOpaque = false
        p.backgroundColor = .clear
        p.ignoresMouseEvents = true
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.contentView = NSHostingView(rootView: MascotView(m: model))
        return p
    }
}

final class MascotModel: ObservableObject {
    @Published var peek = false
    @Published var mood: Mascot.Mood = .listening
    @Published var frame = "peek"
    /// False while the panel is ordered out, so the antenna glow stops redrawing (SwiftUI keeps animating hidden windows).
    @Published var visible = false
    var level: CGFloat = 0
    var leaving: Date?

    let frames: [String: NSImage] = {
        var out: [String: NSImage] = [:]
        for name in ["peek", "blink", "talk", "think", "wink", "surprised", "laugh", "wave"] {
            if let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "mascot"),
               let img = NSImage(contentsOf: url) { out[name] = img }
        }
        return out
    }()

    static var aspect: CGFloat {
        guard let s = Bundle.main.url(forResource: "peek", withExtension: "png", subdirectory: "mascot")
            .flatMap(NSImage.init(contentsOf:))?.size, s.height > 0 else { return 285.0 / 360.0 }
        return s.width / s.height
    }
}

private struct MascotView: View {
    @ObservedObject var m: MascotModel

    var body: some View {
        let w = Mascot.imageWidth, h = Mascot.height
        ZStack(alignment: .topLeading) {
            if let img = m.frames[m.frame] ?? m.frames["peek"] {
                ZStack(alignment: .topLeading) {
                    Image(nsImage: img).resizable().interpolation(.high).frame(width: w, height: h)
                    TimelineView(.animation(minimumInterval: nil, paused: !m.visible)) { ctx in
                        antennaGlow(t: ctx.date.timeIntervalSinceReferenceDate)
                    }
                    .frame(width: 60, height: 60)
                    .position(x: w * 85 / 285, y: h * 17 / 360)
                }
                .frame(width: w, height: h)
                // Snappy peek: pops out from behind the edge with a tilt, overshoots a touch and settles.
                .rotationEffect(.degrees(m.peek ? -3 : 14), anchor: .trailing)
                .offset(x: Mascot.sideroom + (m.peek ? 0 : w), y: Mascot.headroom)
            }
        }
        .frame(width: Mascot.sideroom + w * Mascot.cutX, height: h + Mascot.headroom, alignment: .topLeading)
        .clipped() // the screen edge hides the rest of the body
    }

    private func antennaGlow(t: Double) -> some View {
        let thinking = m.mood == .thinking && m.leaving == nil
        let pulse = thinking ? (sin(t * 5) + 1) / 2 : max(Double(m.level) * 1.5, (sin(t * 2.4) + 1) / 4)
        let color = thinking ? Color(red: 1, green: 0.85, blue: 0.2) : Color.cyan
        return ZStack {
            Circle().fill(color.opacity(thinking ? 0.25 + pulse * 0.5 : 0.2 + pulse * 0.3))
                .frame(width: 14 + pulse * (thinking ? 16 : 8), height: 14 + pulse * (thinking ? 16 : 8))
                .blur(radius: 5 + pulse * 4)
            Circle().fill(Color.white.opacity(thinking ? 0.55 + pulse * 0.45 : 0.25 + pulse * 0.3))
                .frame(width: 5, height: 5)
                .blur(radius: 1)
        }
        .blendMode(.screen)
    }
}
