# Changelog

## 0.4.1

- First-run setup picks the newest Node.js 18+ on the machine instead of the first `node` on the path (an old Node 16 in /usr/local/bin was being chosen).
- Welcome screen, setup dialog and README now explain that typing in Claude Code needs Screen Recording for your terminal app.
- Removed the `share` tool and the Slack, Linear, Jira and markdown-report integrations. `integrations.json` now only holds the TypeSafe key for Jev.

## 0.4.0

First public release.

- **MCP server for Claude Code**: `look`, `select_region`, `list_windows`, `clipboard_image`, `device_screenshot` (iOS Simulator / Android), read-only `db_schema` / `db_query`, `share` (file, Slack, Linear, Jira), browser tools (`browser_tabs`, `browser_read`, `browser_click`, …).
- **VisionCLI.app voice overlay** (macOS): hold ⌥Space to ask about what's under the mouse; answers in a bubble above the pointer, read aloud.
  - Project auto-detection from the window under the pointer, or pick one in the menu.
  - Claude in your terminal (type or talk, same conversation; attaches to an existing `claude` for the project) or background mode.
  - Local Whisper transcription and Kokoro voices when installed; speech speed up to 2×.
  - Instant browser commands via TypeSafe Jev with a visible AI cursor.
  - Highlight boxes on screen, drag-to-select, pin & scroll, file links, approvals for edits and commands, history.
  - Microphone / speaker selection, crash logging and automatic restart.
