// Autopilot's SuggestionCard (Autopilot.swift): bottom-right, a suggestion for the chat you're in, with
// "Put in reply box" / Copy when it drafted a reply. Main sends "suggestion:show"; the card answers on
// "suggestion:action" (insert | copy | dismiss) and reports hovering on "suggestion:hover" (auto-hide waits for it).

import { reportSize, vcli } from "../shared/bridge";
import { esc } from "../shared/markdown";
import { icons } from "../shared/icons";

const root = document.getElementById("root")!;

vcli.on("suggestion:show", (s: { title: string; detail: string; draft?: string; app?: string }) => {
  root.innerHTML = `<div class="card">
    <div class="head"><span class="spark">${icons.sparkles}</span><span class="app">Autopilot${s.app ? ` · ${esc(s.app)}` : ""}</span>
      <span class="spacer"></span><button class="x" data-a="dismiss" title="Dismiss">${icons.close}</button></div>
    <div class="title">${esc(s.title)}</div>
    ${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ""}
    ${s.draft ? `<div class="draft">${esc(s.draft)}</div>
      <div class="buttons"><button class="cbtn primary" data-a="insert">${icons.textCursor}Put in reply box</button>
        <button class="cbtn outline" data-a="copy">${icons.copy}Copy</button></div>` : ""}</div>`;
});

root.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
  if (b) vcli.send("suggestion:action", b.dataset.a);
});
root.addEventListener("mouseenter", () => vcli.send("suggestion:hover", true));
root.addEventListener("mouseleave", () => vcli.send("suggestion:hover", false));
reportSize(root, "suggestion:size");
