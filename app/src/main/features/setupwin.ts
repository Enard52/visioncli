import type { SetupChecks } from "../ui/windows/types";

// The setup wizard's checks on Windows (app/setup.ts): there are no groups, portals or accessibility switches to turn
// on. The keyboard hook, screen capture (GDI / PrintWindow) and UI Automation work for any signed-in user without
// admin rights, so those steps only report what the helper found; the microphone may be blocked by the privacy
// setting "Let desktop apps access your microphone".

export interface WindowsProbe {
  inputs: { name: string; isDefault: boolean }[];
  keyboard: { backend: string; problem?: string };
  desktopProblem: string | null;
  inputBackend: string | null;
  uia: boolean;
  /** wt.exe / wezterm.exe on PATH */
  windowsTerminal: boolean;
  wezterm: boolean;
  busy: Partial<Record<"keyboard" | "screen" | "control", string>>;
}

export function windowsChecks(p: WindowsProbe): SetupChecks {
  const checks: SetupChecks = {};
  const def = p.inputs.find((d) => d.isDefault) ?? p.inputs[0];
  checks.microphone = def
    ? { state: "done", detail: `${p.inputs.length} microphone${p.inputs.length === 1 ? "" : "s"} · ${def.name}` }
    : { state: "pending", detail: "No microphone found",
        note: "Plug one in. If one is connected, turn on Settings → Privacy & security → Microphone → \"Let desktop apps access your microphone\"." };
  checks.keyboard = !p.keyboard.problem && p.keyboard.backend !== "none"
    ? { state: "done", detail: "Reading the keyboard (Windows keyboard hook)" }
    : { state: "pending", detail: p.keyboard.problem ?? "Hold-to-talk can't read the keyboard yet", fix: "Try Again", busy: !!p.busy.keyboard,
        note: "VisionCLI's helper (vcli-win.exe) reads the keyboard; security software may block it." };
  checks.screen = !p.desktopProblem
    ? { state: "done", detail: "Windows: windows, pointer and capture work" }
    : { state: "pending", detail: p.desktopProblem, fix: "Try a screenshot", busy: !!p.busy.screen };
  const inputOk = !!p.inputBackend && p.inputBackend !== "none";
  checks.control = inputOk && p.uia
    ? { state: "done", detail: `Input: ${p.inputBackend} · UI Automation on` }
    : { state: "pending", detail: [inputOk ? `Input: ${p.inputBackend}` : "Can't click or type yet", p.uia ? "UI Automation on" : "UI Automation unavailable"].join(" · "),
        fix: "Set Up Computer Control", busy: !!p.busy.control,
        note: "Apps running as administrator can't be controlled from a normal app (Windows' UIPI)." };
  checks.terminal = p.wezterm || p.windowsTerminal
    ? { state: "done", detail: p.wezterm ? "WezTerm found: VisionCLI can type into the CLI's pane" : "Windows Terminal found: VisionCLI types into it with the keyboard" }
    : { state: "optional", detail: "VisionCLI types into console windows with the keyboard. Windows Terminal or WezTerm work best." };
  return checks;
}
