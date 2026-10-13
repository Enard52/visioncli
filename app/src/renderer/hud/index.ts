// TaskHUD (Tasks.swift TaskView): while the assistant uses the computer, its steps in the top-right corner with Pause /
// Resume and Stop. Main sends "hud:state" {title, steps, paused}; the buttons send "hud:action".

import type { TaskStep } from "../../main/contracts";
import { reportSize, vcli } from "../shared/bridge";
import { esc } from "../shared/markdown";
import { icons } from "../shared/icons";
import { spinner } from "../shared/spinner";

const root = document.getElementById("root")!;
const STEP_ICON: Record<TaskStep["state"], string> = {
  running: `<span class="si running">${icons.cursor}</span>`,
  done: `<span class="si done">${icons.check}</span>`,
  failed: `<span class="si failed">${icons.warning}</span>`,
  declined: `<span class="si declined">${icons.close}</span>`,
  waiting: `<span class="si waiting">${icons.hand}</span>`,
};

let paused = false;

vcli.on("hud:state", (d: { title: string; steps: TaskStep[]; paused: boolean }) => {
  paused = d.paused;
  root.innerHTML = `<div class="hud">
    <div class="head">${d.paused ? `<span class="paused-icon">${icons.pause}</span>` : spinner(16)}
      <span class="title">${esc(d.paused ? "Paused" : d.title)}</span><span class="spacer"></span>
      <button class="cbtn outline" data-a="pause">${d.paused ? "Resume" : "Pause"}</button>
      <button class="cbtn stop" data-a="stop">Stop&nbsp;&nbsp;esc</button></div>
    <div class="steps">${d.steps.slice(-7).map((s) =>
      `<div class="step ${s.state}">${STEP_ICON[s.state]}<span class="t">${esc(s.text)}</span></div>`).join("")}</div></div>`;
});

root.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
  if (!b) return;
  vcli.send("hud:action", b.dataset.a === "stop" ? "stop" : paused ? "resume" : "pause");
});
reportSize(root, "hud:size");
