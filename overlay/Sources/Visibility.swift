import AppKit
import SwiftUI

// SwiftUI keeps running repeatForever / TimelineView animations in windows that are only ordered out, which costs CPU
// while nothing is on screen. Views that animate forever check whether their window is actually visible.

extension View {
    /// Keeps `visible` in sync with whether the view's window is on screen (ordered in and not fully covered).
    func trackingWindowVisibility(_ visible: Binding<Bool>) -> some View {
        background(WindowVisibilityReader(visible: visible).frame(width: 0, height: 0))
    }
}

private struct WindowVisibilityReader: NSViewRepresentable {
    @Binding var visible: Bool

    func makeNSView(context: Context) -> ProbeView {
        let v = ProbeView()
        v.onChange = { visible = $0 }
        return v
    }

    func updateNSView(_ v: ProbeView, context: Context) {
        v.onChange = { visible = $0 }
    }

    final class ProbeView: NSView {
        var onChange: (Bool) -> Void = { _ in }
        private var observer: NSObjectProtocol?
        private var last: Bool?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { report(false); return }
            observer = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification,
                                                              object: window, queue: .main) { [weak self] _ in self?.check() }
            check()
        }

        private func check() {
            guard let window else { report(false); return }
            report(window.isVisible && window.occlusionState.contains(.visible))
        }

        /// Deferred: this can run while SwiftUI is updating views, where state mustn't change.
        private func report(_ on: Bool) {
            guard on != last else { return }
            last = on
            DispatchQueue.main.async { [weak self] in
                guard let self, self.last == on else { return }
                self.onChange(on)
            }
        }

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
}
