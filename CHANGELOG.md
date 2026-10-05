# Changelog

## 0.6.0

- **Mermaid diagrams in the answer bubble.** For flows, relationships, data models or architecture, the answer can include a ```mermaid diagram (flowchart, sequence, ER…). It's rendered as a picture in the bubble with the bundled Mermaid (works offline), sized to fit, with a "Drawing diagram…" placeholder while it streams; the read-aloud voice skips the code.
- **Drawing on the screen to explain.** Besides boxes, answers can draw **arrows** (from one thing to another), **circles**, and **numbered steps** (①②③) on your real screen. They animate in the order written, like someone explaining with a pen. Works with Claude, Gemini (Antigravity) and Gemini CLI.

## 0.5.5

- **Self-repairing permissions.** After a signature change (moving to the permanently signed releases), System Settings can show VisionCLI as allowed while macOS still asks, and toggling doesn't help. On the first launch of a new version, VisionCLI now clears its own stale entries (only for permissions not actually in effect), so macOS shows a fresh prompt and one click fixes it. 👁 → Settings → *Fix Permissions…* does the same on demand.

## 0.5.4

- Fix: *Install Update* refused updates that were correctly signed (the signature check read an extra line from `codesign`). Verified end to end: a 0.5.2 build updated itself from GitHub, kept the same certificate, and relaunched. **If you have 0.5.3, download 0.5.4 manually once**; automatic updates work from 0.5.4 on.

## 0.5.3

- **Permissions survive upgrades.** Releases are now signed with VisionCLI's permanent certificate instead of an ad-hoc signature (which changed every build, so macOS asked for Screen Recording / Microphone again after each update). You'll be asked one last time when moving to 0.5.3.
- **Check for updates.** VisionCLI checks GitHub at launch and every 6 hours, then offers *Install Update*: it downloads, verifies the signature matches, replaces itself and restarts. Manual check and an on/off switch are in 👁 → Settings.

## 0.5.2

- **Fix: level bars move but no text appears** (seen on some Macs). Live captions no longer fail silently. VisionCLI checks Speech Recognition permission, retries with Apple's online recognition when on-device recognition isn't available for the language, and shows the reason and fix in the pill (permission, Dictation off, …). Audio keeps recording, so Whisper can still transcribe; if nothing could, the bubble says why instead of "Didn't catch that".

## 0.5.1

- **Whisper and Kokoro on any Mac**: when they aren't installed, 👁 → Voice & Audio offers *Download Whisper* (installs whisper-cpp via Homebrew + the small.en model) and *Download Natural Voices* (installs uv if needed + the Kokoro model), with progress in the menu. Each switches itself on when done. Previously they only appeared on Macs that already had the models.

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
