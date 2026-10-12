import AppKit
import SwiftUI

// The bubble panel: showing it for a phase, following the pointer, hiding it later.

extension AppDelegate {
    func buildPanel() {
        panel = OverlayPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        hosting = NSHostingView(rootView: OverlayView(s: state, actions: self))
        hosting.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hosting
        // SwiftUI lays the change out shortly after it's published: keep measuring for a moment after each one.
        stateChanges = state.objectWillChange.sink { [weak self] _ in self?.layoutDirtyUntil = Date().addingTimeInterval(0.3) }
    }

    var frozen: Bool { state.pinned || state.phase == .approval }

    func set(_ phase: Phase) {
        state.phase = phase
        hideWork?.cancel()
        if phase != .listening { spotlight.hide() }
        switch phase {
        case .listening: mascot.show(.listening)
        case .thinking: mascot.show(.thinking)
        default: mascot.hide()
        }
        if phase == .hidden {
            if !pendingAnnouncements.isEmpty {
                let next = pendingAnnouncements.removeFirst()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.announce(next) }
            }
            followTimer?.invalidate()
            followTimer = nil
            panel.orderOut(nil)
            state.pinned = false
            state.toast = ""
            for k in [HotKey.dismiss, .pin, .open, .allow] { hotkeys.set(k, false) }
            return
        }
        hotkeys.set(.dismiss, true)
        hotkeys.set(.pin, [.answering, .done, .error].contains(phase))
        hotkeys.set(.open, phase == .done)
        hotkeys.set(.allow, phase == .approval)
        panel.interactive = frozen
        panel.ignoresMouseEvents = !frozen
        layoutDirtyUntil = Date().addingTimeInterval(0.3)
        lastLayout = .distantPast // place it for the new phase right away
        if followTimer == nil {
            followTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.follow() }
            RunLoop.main.add(followTimer!, forMode: .common)
        }
        follow()
        panel.orderFrontRegardless()
    }

    /// Keep the overlay glued to the pointer: the loader rides at the cursor, the answer floats above it.
    /// When pinned (or asking approval) it stays put and only resizes.
    func follow() {
        if state.speaking != speaker.isSpeaking { state.speaking = speaker.isSpeaking }
        // Only the listening/thinking loader rides the pointer (every frame). Measuring an answer (markdown, diagrams)
        // is the expensive part: do it when its content changed (at most 20 times a second while it streams), else
        // twice a second so it still moves to the screen the pointer is on.
        if frozen || !(state.phase == .listening || state.phase == .thinking) {
            let now = Date(), since = now.timeIntervalSince(lastLayout)
            guard (now < layoutDirtyUntil && since >= 0.05) || since >= 0.5 else { return }
            lastLayout = now
        }
        let size = hosting.fittingSize
        guard size.width > 2 else { return }
        if frozen {
            let f = panel.frame
            guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(f) }) ?? NSScreen.main else { return }
            let vf = screen.visibleFrame
            var origin = CGPoint(x: f.minX, y: f.maxY - size.height)
            origin.x = min(max(origin.x, vf.minX + 4), vf.maxX - size.width - 4)
            origin.y = min(max(origin.y, vf.minY + 4), vf.maxY - size.height - 4)
            let frame = NSRect(origin: origin, size: size).integral
            if f != frame { panel.setFrame(frame, display: true) }
            return
        }
        let m = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(m, $0.frame, false) }) ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        var origin: CGPoint
        switch state.phase {
        case .listening, .thinking:
            origin = CGPoint(x: m.x + 14, y: m.y - 22 - size.height / 2)
        default:
            // Answers and approval cards sit in the top-right corner of the pointer's screen (under the task panel
            // if it's showing); only the listening/thinking loader rides the cursor.
            origin = CGPoint(x: vf.maxX - size.width - 12, y: vf.maxY - size.height - 12 - taskHUD.visibleHeight)
            if !state.below { state.below = true } // no tail pointing at the cursor
        }
        origin.x = min(max(origin.x, vf.minX + 4), vf.maxX - size.width - 4)
        origin.y = min(max(origin.y, vf.minY + 4), vf.maxY - size.height - 4)
        let frame = NSRect(origin: origin, size: size).integral
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    func scheduleHide(after seconds: Double) {
        hideWork?.cancel()
        guard !state.pinned else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.state.pinned else { return }
            self.set(.hidden)
            self.highlight.hide()
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func flash(_ message: String, seconds: Double = 5) {
        state.raw = message
        set(.error)
        scheduleHide(after: seconds)
    }
}
