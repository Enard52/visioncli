# Changelog

## 0.7.2

- **New keys, no Space:** hold **⌃** to ask as text only (no screenshot, far fewer tokens; the assistant takes its own look if it needs to), hold **⌃⌥** to ask with a screenshot of the window under the mouse (adding ⌥ while holding ⌃ also works). ⌥⇧Space still lets you drag an area. Other ⌃ shortcuts (⌃C, ⌃-click) keep working. Without the Accessibility permission the keys fall back to ⌃Space / ⌃⌥Space. 👁 → Settings → *Screenshot Every Question* brings back the old behaviour.
- **See what it sees:** while a screenshot question is held, the display under the mouse dims except the window that will be captured (cyan outline).
- **Parakeet speech recognition:** NVIDIA Parakeet TDT runs locally on the Neural Engine (Apple Silicon), about 0.2–0.3 s per question, and gets your project's names right (class names from the window title, your vocabulary list, common tools). Choose it in 👁 → Voice & Audio → Speech Recognition; the model (~600 MB) downloads on first use.
- **Wispr Flow:** use your own Wispr Flow account as the speech engine. Hold ⌃ and speak as usual; VisionCLI holds Flow's push-to-talk key for you and takes Flow's text as the question.
- **Claude usage in the menu bar:** a coloured ring with your current 5-hour session usage (optionally the week too), and a usage card in 👁 → Claude Usage with session and weekly limits, reset times and today's tokens across all Claude Code sessions.
- **All Claude models:** Fable, Opus, Sonnet, Haiku, Opus-plan and the 1M-context variants. Changing Model or Effort in the menu is sent to the Claude running in your terminal (`/model`, `/effort`), and the menu follows a model you pick in the terminal. Saying "slash compact" (or any "slash …") runs it as a real command.
- **History per project:** History opens on the current project, with a project picker, *Clear Project*, and 200 questions kept per project.
- Fixes: Bluetooth headsets (AirPods, Sony…) no longer record silence when they switch to their call mode mid-question; the crash watcher ignores Xcode's background services.

## 0.7.1

- **Fix: browser tasks opened lots of tabs and windows.** `browser_open` now switches to a tab already showing the page, otherwise reuses the assistant's own working tab, and opens at most one new tab. In Chrome/Brave, keyboard navigation (⌘L/⌘T/⌘N) from computer control is refused in favour of the browser tools, so keys can't land in the wrong window.
- **Browser tools see inside frames.** Portals and admin panels that put their UI in iframes/frames (government and bank sites, Ext JS apps) now work with `browser_elements`, `browser_click`, `browser_type`, `browser_select` and `browser_read`, instead of falling back to pixel clicks.
- **No more races.** Clicks and typing in the browser happen immediately (the AI cursor just shows where), so the next step never runs before a field is filled, even when Chrome is in the background.
- **Answers in the top-right corner.** The answer bubble and approval cards sit in the corner (under the task panel); only the listening/thinking loader follows the cursor. Pointing markers are drawn on the real screen again, over the thing being explained.

## 0.7.0

- **Computer control: VisionCLI can use your Mac.** Claude or Gemini can click, double/right-click, drag, scroll, type, press shortcuts, open apps and URLs, in any app, from voice or from the terminal. It reads each app's real buttons, fields and menus through Accessibility (`ui_elements`) so it clicks "Save" by id instead of guessing pixels; pixel positions on a screenshot work too. Keys and typing go to the app it's working in, never by accident to your terminal.
  - **Approvals:** 👁 → Computer Control → *Ask Before Each Action* (default), *Allow All Actions*, or *Off*. Password fields, System Settings, Keychain and password managers always ask.
  - **Task panel** (top-right) lists each step with ✓/✗, plus **Pause** and **Stop**. **Esc** stops the assistant from touching the computer until your next question.
  - Needs the Accessibility permission (👁 → Computer Control → Grant Accessibility Permission…).
- **Recipes:** saved routines (*Explain this screen*, *Fix this error*, *Run the tests*, *Review my changes*, *Explain the last crash*, *Run on the simulator*, *Write a commit message*) in 👁 → Recipes, or say the name ("run the tests"). Edit or add your own in `recipes.json`.
- **Crash watcher:** when one of your apps (Mac or iOS Simulator) crashes, VisionCLI offers to explain it, and your next question includes the crash report's path.
- **Browser dropdowns and toggles work.** Clicks now send the full pointer sequence (custom React/Radix/MUI widgets respond), new `browser_select` picks options in native and custom dropdowns, and `browser_elements` shows toggles' on/off state and dropdowns' options. Fixed stale element ids after listing a page twice.
- **Drawings are shown on the screenshot inside the bubble**, not on your real screen.

- **Two assistants:** Claude Code or Gemini (Antigravity). Gemini CLI is no longer offered (it doesn't work on personal Google accounts); anyone who had it selected moves to Antigravity.
- **Model menu for Gemini:** every model your `agy` account offers (Gemini 3.8/3.7/3.6 Flash, 3.1 Pro, …), or agy's default. Claude keeps Sonnet / Opus.
- **Effort menu** (Default, Low, Medium, High, Extra High, Max) for both Claude and Gemini, in bubble and terminal mode (`--effort`).
- **Gemini can run commands in Bubble Only mode.** Read-only commands (grep, rg, ls, cat, find, git status/log/diff…) run without asking. Any other command shows the approval card, as with Claude: Allow runs it and Gemini continues, Allow all keeps it for the session (removed on New Conversation or quit), Deny makes Gemini answer without it.

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
