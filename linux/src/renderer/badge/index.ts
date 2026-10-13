// ActivityBadge (Badge.swift): a small pill at the top of the pointer's screen saying what VisionCLI is doing with it
// (looking, reading a window, using the computer). Click-through. Main sends "badge:show" {icon, text, tint} and
// "badge:hide"; the fades happen here.

import { reportSize, vcli } from "../shared/bridge";
import { icon } from "../shared/icons";

const root = document.getElementById("root")!;
root.innerHTML = `<div class="pill"><span class="mark"><i class="pulse"></i><span class="icon"></span></span><span class="text"></span></div>`;
const pill = root.querySelector<HTMLElement>(".pill")!;

vcli.on("badge:show", (d: { icon?: string; text: string; tint?: string }) => {
  pill.style.setProperty("--tint", d.tint ?? "var(--cyan)");
  root.querySelector(".icon")!.innerHTML = icon(d.icon ?? "eye");
  root.querySelector(".text")!.textContent = d.text;
  document.body.classList.add("on");
});
vcli.on("badge:hide", () => document.body.classList.remove("on"));
reportSize(root, "badge:size");
