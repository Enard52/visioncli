import AppKit

// Updates the assistant reports back on its own (the `announce` tool): shown in the bubble and spoken.

extension AppDelegate {
    /// Shows and speaks an update (even with Speak Answers off); queued in `pendingAnnouncements` while the user is
    /// in the middle of a question, and shown when the bubble hides.
    func announce(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard state.phase == .hidden || state.phase == .done || state.phase == .error else {
            pendingAnnouncements.append(text)
            log("announce: queued (\(state.phase))")
            return
        }
        log("announce: \(text.prefix(200))")
        activity.note("Update: \(text)")
        state.pinned = false
        state.question = "Update"
        state.status = ""
        state.toast = ""
        state.raw = text
        set(.done)
        speaker.reset()
        speaker.feed(text, final: true, force: true)
        history.add(HistoryEntry(date: Date(), project: currentProject, question: "Update", answer: text, screenshots: []))
        scheduleHide(after: max(6, min(20, Double(text.count) / 12)))
    }
}
