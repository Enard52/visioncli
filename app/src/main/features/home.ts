import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectSelector } from "../core/projects";
import { HOME_PROJECT } from "../paths";

// VisionCLI Home (~/VisionCLI): the workspace for questions that aren't about a software project. Port of
// HomeProject in overlay/Sources/Support.swift ("this Mac" → "this computer").

export const HOME_NOTE = `# VisionCLI Home

This is VisionCLI's general workspace: questions asked here are not about a specific software project.
Treat them like a general assistant would: everyday questions, writing and replying to messages, explaining
what is on the screen, web research, small tasks on this computer. Save any notes, drafts or files you make for the
user in this folder unless they say otherwise.`;

export const HomeProject = {
  path: HOME_PROJECT,

  /** Creates the folder (and the note telling the assistant what it is for) if it's missing. */
  ensure(path = HOME_PROJECT) {
    try { mkdirSync(path, { recursive: true }); } catch {}
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const file = join(path, name);
      if (!existsSync(file)) { try { writeFileSync(file, HOME_NOTE); } catch {} }
    }
  },

  label(project: string): string {
    return ProjectSelector.label(project, HOME_PROJECT);
  },
};
