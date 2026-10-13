import type { TaskStep } from "../contracts";
import type { ControlTasks } from "../control";

// The task panel's model (Tasks.swift TaskState/TaskHUD): a step per computer-control action, paused or not. The
// overlay draws it (ui.hud) and hides it by itself 12 s after the last step finished.

export class TaskModel implements ControlTasks {
  steps: TaskStep[] = [];
  title = "Working";
  paused = false;
  private n = 0;

  constructor(private show: (steps: TaskStep[], paused: boolean, title: string) => void, private hideHud: () => void = () => {}) {}

  begin(text: string, waiting = false): string {
    const id = `s${++this.n}`;
    this.steps.push({ id, text, state: waiting ? "waiting" : "running" });
    if (this.steps.length > 40) this.steps.splice(0, this.steps.length - 40);
    this.draw();
    return id;
  }

  update(id: string, state: TaskStep["state"]) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    s.state = state;
    this.draw();
  }

  /** A new question: a fresh list (drawn with its first step). */
  reset(title: string) {
    this.steps = [];
    this.paused = false;
    this.title = title;
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.draw();
  }

  hide() {
    this.paused = false;
    this.hideHud();
  }

  private draw() { this.show(this.steps.map((s) => ({ ...s })), this.paused, this.title); }
}
