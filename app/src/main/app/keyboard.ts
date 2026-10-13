import type { Desktop, DesktopWindow, InputInjector } from "../contracts";
import { log } from "../log";
import type { KeyboardDelivery } from "../terminal";
import { readProc } from "../terminal/procs";

// Typing into a CLI that runs in an emulator VisionCLI can't drive remotely (gnome-terminal, konsole, alacritty,
// xterm, foot…): focus the emulator's window and type with synthetic input, like macOS types into Terminal.app.
// The window is the one whose process is an ancestor of the CLI (the emulator spawned its shell).
// Limit: with several tabs in one window, the tab in front gets the text.

/** The pid and its ancestors, nearest first (stops at init). */
export function ancestorPids(pid: number, parent: (pid: number) => number | null = (p) => readProc(p)?.ppid ?? null): number[] {
  const out: number[] = [];
  for (let p: number | null = pid; p && p > 1 && out.length < 64 && !out.includes(p); p = parent(p)) out.push(p);
  return out;
}

/** The front-most window owned by the nearest ancestor that has one. */
export function emulatorWindow(windows: DesktopWindow[], ancestors: number[]): DesktopWindow | null {
  for (const pid of ancestors) {
    const w = windows.find((x) => x.pid === pid);
    if (w) return w;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createKeyboardDelivery(desktop: Desktop, input: () => Promise<InputInjector>): KeyboardDelivery {
  const windowOf = async (pid: number) => emulatorWindow(await desktop.windows().catch(() => []), ancestorPids(pid));

  async function focus(pid: number): Promise<DesktopWindow | null> {
    const w = await windowOf(pid);
    if (!w) return null;
    const front = await desktop.activeWindow().catch(() => null);
    if (front?.id === w.id) return w;
    await desktop.focus(w).catch((e) => log(`terminal: can't focus ${w.app}: ${e}`));
    for (let i = 0; i < 20 && (await desktop.activeWindow().catch(() => null))?.id !== w.id; i++) await sleep(50);
    await sleep(120);
    return w;
  }

  return {
    async locate(pid) { return !!(await windowOf(pid)); },
    async type(pid, text) {
      const w = await focus(pid);
      if (!w) return false;
      await (await input()).type(text);
      log(`terminal: typed into ${w.app} by keyboard`);
      return true;
    },
    async enter(pid) {
      if (!(await focus(pid))) return false;
      await (await input()).key("enter");
      return true;
    },
    async focus(pid) { await focus(pid); },
  };
}
