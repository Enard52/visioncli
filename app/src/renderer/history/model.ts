import type { HistoryView } from "../../main/ui/windows/types";

// The History window's filtering (HistoryView.projects / filtered), kept DOM-free for tests.

/** Projects with history, most recently used first. */
export function projectsOf(list: HistoryView[]): { path: string; label: string }[] {
  const seen = new Set<string>();
  return [...list].sort((a, b) => b.date.localeCompare(a.date))
    .filter((e) => !seen.has(e.project) && seen.add(e.project))
    .map((e) => ({ path: e.project, label: e.projectLabel }));
}

export function filterEntries(list: HistoryView[], project: string, query: string): HistoryView[] {
  const q = query.trim().toLowerCase();
  return list.filter((e) => (!project || e.project === project) && (!q || `${e.question} ${e.answer} ${e.project}`.toLowerCase().includes(q)));
}
