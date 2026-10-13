// Which project a question goes to. Port of overlay/Sources/CoreProjects.swift.

/** The project chosen for a question, and whether Jev should still decide between it and Home. */
export interface ProjectDecision {
  project: string;
  /** Away from any project window shortly after using one: about that project, or general? Jev decides with the
   *  question (see routeThenAsk). */
  askScope: boolean;
  /** The project came from the window under the pointer: remember it as the last real project. */
  fromWindow: boolean;
}

export const ProjectSelector = {
  /** Seconds. A question asked away from any project window this soon after the last one may still be about it. */
  recentWindow: 600,

  /** At key-down: a pinned project wins, then the project of the window under the pointer, then the last real
   *  project if it was used within `recentWindow` (Jev decides), else Home. A terminal under the pointer is
   *  probed in the background and overrides this when it answers.
   *  `lastReal.at` and `now` are epoch milliseconds (Date.now()). */
  decide(pinned: string | null | undefined, windowProject: string | null | undefined,
         lastReal: { path: string; at: number } | null | undefined, now: number, home: string): ProjectDecision {
    if (pinned != null) return { project: pinned, askScope: false, fromWindow: false };
    if (windowProject != null) return { project: windowProject, askScope: false, fromWindow: true };
    if (lastReal && (now - lastReal.at) / 1000 < ProjectSelector.recentWindow) {
      return { project: lastReal.path, askScope: true, fromWindow: false };
    }
    return { project: home, askScope: false, fromWindow: false };
  },

  /** When the question is sent: a pinned project, then a terminal the user pointed at, then the window the
   *  pointer ended on; otherwise the project chosen at key-down stays. */
  confirm(current: string, pinned: string | null | undefined, terminalProject: string | null | undefined,
          windowProject: string | null | undefined): ProjectDecision {
    if (pinned != null) return { project: pinned, askScope: false, fromWindow: false };
    if (terminalProject != null) return { project: terminalProject, askScope: false, fromWindow: false };
    if (windowProject != null) return { project: windowProject, askScope: false, fromWindow: true };
    return { project: current, askScope: false, fromWindow: false };
  },

  /** The name shown for a project: "Home" for VisionCLI Home, else the folder name. */
  label(project: string, home: string): string {
    return project === home ? "Home" : lastPathComponent(project);
  },
};

/** NSString.lastPathComponent: trailing slashes ignored, "/" stays "/". */
function lastPathComponent(p: string): string {
  const t = p.replace(/\/+$/, "");
  if (!t) return p ? "/" : "";
  return t.slice(t.lastIndexOf("/") + 1);
}
