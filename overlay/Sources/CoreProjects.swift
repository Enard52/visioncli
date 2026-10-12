import Foundation

// Which project a question goes to (Foundation only, tested in overlay/Tests).

/// The project chosen for a question, and whether Jev should still decide between it and Home.
struct ProjectDecision: Equatable {
    let project: String
    /// Away from any project window shortly after using one: about that project, or general? Jev decides with the
    /// question (see routeThenAsk).
    let askScope: Bool
    /// The project came from the window under the pointer: remember it as the last real project.
    let fromWindow: Bool
}

enum ProjectSelector {
    /// A question asked away from any project window this soon after the last one may still be about it.
    static let recentWindow: TimeInterval = 600

    /// At key-down: a pinned project wins, then the project of the window under the pointer, then the last real
    /// project if it was used within `recentWindow` (Jev decides), else Home. A terminal under the pointer is
    /// probed in the background and overrides this when it answers.
    static func decide(pinned: String?, windowProject: String?, lastReal: (path: String, at: Date)?,
                       now: Date, home: String) -> ProjectDecision {
        if let pinned { return ProjectDecision(project: pinned, askScope: false, fromWindow: false) }
        if let windowProject { return ProjectDecision(project: windowProject, askScope: false, fromWindow: true) }
        if let last = lastReal, now.timeIntervalSince(last.at) < recentWindow {
            return ProjectDecision(project: last.path, askScope: true, fromWindow: false)
        }
        return ProjectDecision(project: home, askScope: false, fromWindow: false)
    }

    /// When the question is sent: a pinned project, then a terminal the user pointed at, then the window the
    /// pointer ended on; otherwise the project chosen at key-down stays.
    static func confirm(current: String, pinned: String?, terminalProject: String?, windowProject: String?) -> ProjectDecision {
        if let pinned { return ProjectDecision(project: pinned, askScope: false, fromWindow: false) }
        if let terminalProject { return ProjectDecision(project: terminalProject, askScope: false, fromWindow: false) }
        if let windowProject { return ProjectDecision(project: windowProject, askScope: false, fromWindow: true) }
        return ProjectDecision(project: current, askScope: false, fromWindow: false)
    }

    /// The name shown for a project: "Home" for VisionCLI Home, else the folder name.
    static func label(_ project: String, home: String) -> String {
        project == home ? "Home" : (project as NSString).lastPathComponent
    }
}
