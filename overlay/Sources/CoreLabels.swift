import Foundation

// Labels and choices shown in the menu-bar menu (Foundation only, tested in overlay/Tests).

enum MenuLabels {
    /// Claude Code model aliases (`claude --model <alias>`), so new versions are picked up without an app update.
    static let claudeModels: [(String, String)] = [
        ("default", "Default (your Claude Code setting)"),
        ("fable", "Fable (most capable)"),
        ("opus", "Opus (deep reasoning)"),
        ("sonnet", "Sonnet (fast, balanced)"),
        ("haiku", "Haiku (fastest, cheapest)"),
        ("opusplan", "Opus to plan, Sonnet to do"),
        ("fable[1m]", "Fable, 1M context"),
        ("opus[1m]", "Opus, 1M context"),
        ("sonnet[1m]", "Sonnet, 1M context"),
    ]

    static func claudeModel(_ alias: String) -> String {
        claudeModels.first { $0.0 == alias }.map { $0.1.components(separatedBy: " (").first! } ?? alias
    }

    static func effort(_ level: String?) -> String {
        switch level {
        case "low": return "Low (fastest)"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "Extra High"
        case "max": return "Max (slowest)"
        default: return "Default"
        }
    }

    /// The terminal's Claude switched models itself (/model there): the menu alias to follow, or nil to keep the
    /// menu as is. `used` is the full model id from the transcript ("claude-opus-4-…"); a 1M-context menu choice
    /// counts as its family, and "opusplan" already covers Opus and Sonnet.
    static func followedModel(used: String, menu: String) -> String? {
        let family = ["fable", "opus", "sonnet", "haiku"].first { used.contains($0) }
        let current = menu.replacingOccurrences(of: "[1m]", with: "")
        guard let family, current != family, !(current == "opusplan" && (family == "opus" || family == "sonnet")) else { return nil }
        return family
    }
}
