// Finding the CLIs in terminals, typing into them, and opening terminals (TerminalProbe.swift, Activity.swift,
// the terminal-control half of Terminal.swift).

export { find, forget, recent, probeTerminals, probeTty, probeWindow, runningProjects, type PointedTerminal } from "./probe";
export { alive, deliveryFor, hasTmux, pressEnter, screenText, selectPane, sendLine, setKeyboardDelivery, hasKeyboardDelivery, typeText, undeliverableReason, type Delivery, type KeyboardDelivery } from "./mux";
export { emulators, hasDisplay, openTerminal, setSearchPath, shellQuote, TerminalLauncher, which, writeScript } from "./launcher";
export { activity, ActivityLog, BufferedActivity, ACTIVITY_LOG, type ActivityShot } from "./activity";
export {
  agyConversation, agyTranscript, assistantFor, assistantName, claudeDir, cliFor, CLIS, gitRoot, lastModel, matches, newestSession,
  sessionFile, sha256, type Cli,
} from "./transcripts";
export { listProcs, readProc, workingDirectory, ttyName, parseStat, parseCmdline } from "./procs";
