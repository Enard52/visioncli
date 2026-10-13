import type { HistoryView } from "../../main/ui/windows/types";
import { button, h, icon, select } from "../settings/ui";
import { filterEntries, projectsOf } from "./model";

// The History window (History.swift HistoryView): search, a project filter, Clear, and every question with its
// answer, a Copy link and the first screenshot (click to open it).

let entries: HistoryView[] = [];
let project = "";
let query = "";
const thumbs = new Map<string, string | null>();

function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const f = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (s < 60) return "just now";
  if (s < 3600) return f.format(-Math.round(s / 60), "minute");
  if (s < 86400) return f.format(-Math.round(s / 3600), "hour");
  if (s < 30 * 86400) return f.format(-Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString();
}

async function load() {
  const r = await window.vcli.invoke("history:get");
  entries = r.entries;
  project = r.project && entries.some((e) => e.project === r.project) ? r.project : project && entries.some((e) => e.project === project) ? project : "";
  render();
}

const searchInput = h("input.search", {
  type: "search", placeholder: "Search questions and answers", spellcheck: false,
  oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; renderList(); },
});
const projectSlot = h("span");
const clearSlot = h("span");
const list = h("div.list");

function render() {
  const app = document.getElementById("app")!;
  if (!app.firstChild) {
    app.append(h("div.toolbar", null, h("label.searchbox", null, icon("search", 14), searchInput), h("span.spacer"), projectSlot, clearSlot), list);
  }
  projectSlot.replaceChildren(select(project, [
    { value: "", label: "All Projects" },
    ...projectsOf(entries).map((p) => ({ value: p.path, label: p.label })),
  ], (v) => { project = v; void window.vcli.invoke("history:filter", v); render(); }));
  renderList();
}

function renderList() {
  const shown = filterEntries(entries, project, query);
  clearSlot.replaceChildren(button(project ? "Clear Project" : "Clear History", async () => {
    const r = await window.vcli.invoke("history:clear", project || null);
    entries = r.entries;
    project = "";
    render();
  }, { disabled: !shown.length }));
  if (!shown.length) {
    list.replaceChildren(h("div.empty", null, entries.length ? "No matches" : "No questions yet. Hold Alt and ask about your screen."));
    return;
  }
  const scroll = list.scrollTop;
  list.replaceChildren(...shown.map((e) => entryRow(e)));
  list.scrollTop = scroll;
}

function entryRow(e: HistoryView): HTMLElement {
  const first = e.shots[0];
  const thumb = first ? thumbnail(first) : null;
  return h("article.entry", null,
    thumb,
    h("div.entry-body", null,
      h("div.entry-head", null, h("div.question", null, e.question), h("time", { title: new Date(e.date).toLocaleString() }, ago(e.date))),
      !project && h("div.project", null, e.projectLabel),
      h("div.answer.selectable", null, e.answer),
      h("div.entry-actions", null,
        h("button.link", { onclick: () => window.vcli.invoke("history:copy", e.answer) }, "Copy"),
        h("button.link.danger", { onclick: async () => { const r = await window.vcli.invoke("history:remove", e.key); entries = r.entries; render(); } }, "Delete"))));
}

/** A row's screenshot, decoded small by main and cached; hidden when the file is gone. */
function thumbnail(path: string): HTMLElement {
  const box = h("div.thumb", { title: "Open screenshot", onclick: () => window.vcli.invoke("history:open", path) });
  const put = (url: string | null) => {
    if (url) box.replaceChildren(h("img", { src: url, alt: "" }));
    else box.remove();
  };
  if (thumbs.has(path)) put(thumbs.get(path)!);
  else void window.vcli.invoke("history:thumb", path).then((url: string | null) => { thumbs.set(path, url); put(url); });
  return box;
}

if (typeof window !== "undefined" && (window as any).vcli) {
  window.vcli.on("history:changed", () => void load());
  window.addEventListener("focus", () => void load());
  void load();
}
