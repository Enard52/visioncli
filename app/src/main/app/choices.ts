import type { DesktopWindow } from "../contracts";
import { isSkipped } from "../features/autopilot";
import { isTerminal } from "../features/projects";
import type { Item } from "../ui/windows/types";

// Autopilot's app list in Settings (App+MenuActions.swift autopilotAppChoices).

/** Apps Autopilot can be allowed to read: open windows' apps (minus never-read apps and terminals) plus the ones
 *  already chosen, by name. */
export function appChoices(windows: Pick<DesktopWindow, "app" | "appId" | "pid">[], chosen: string[], ownPid = process.pid): Item[] {
  const out: Item[] = [];
  for (const w of windows) {
    const id = w.appId || w.app;
    if (!id || w.pid === ownPid || isSkipped(w) || isTerminal(w) || out.some((x) => x.id === id)) continue;
    out.push({ id, name: w.app || id });
  }
  for (const id of chosen) if (!out.some((x) => x.id === id)) out.push({ id, name: id });
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

