# Changelog

## 0.5.0

- **Gemini via Antigravity CLI (`agy`)**, using your Google sign-in: 👁 → Assistant → *Gemini (Antigravity CLI)*. Terminal mode opens or attaches to `agy` and follows its transcript (`~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl`). Bubble Only mode runs `agy -p --output-format stream-json --conversation <id>`. *Set Up Antigravity CLI* registers the MCP tools globally with allow rules. Verified end to end in both modes, including attaching to a running `agy`.
- Clear message when headless Gemini ends a turn because a step needed approval.

- **Gemini CLI support**: *Set Up Gemini CLI* registers the MCP tools (`gemini mcp add -s user --trust`); 👁 → Assistant → Gemini CLI answers voice questions in Gemini Terminal mode (types into your running `gemini`, reads its session file) or Bubble Only mode (`gemini -p -o stream-json`, resumed per project). Pointing at a terminal that runs `gemini` uses it automatically, and the Project menu marks running `gemini` sessions.
- Gemini uses your normal `gemini` sign-in, like Claude uses your `claude` login. Optionally, a `gemini.apiKey` in integrations.json switches VisionCLI's runs to API-key auth. Auth errors show actionable messages.
- `visioncli install` also registers with Gemini CLI when it's installed.

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
