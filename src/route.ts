import { apiKey } from "./quick.js";

// Smart routing: one Jev (TypeSafe System One) request decides whether a spoken question needs the strong model
// or a small fast one (Haiku / Gemini Flash), so light questions ("what is this?", "how are you") answer in a few
// seconds and heavy ones (code changes, debugging, planning) still get the best model.

export interface RouteInput {
  question: string;
  previous?: string;        // the previous question, if recent (follow-up detection)
  previousLane?: string;
  project?: string;         // ask whether the question is about this recently used project, or general
  app?: string;             // front app / window under the pointer, for the project-or-general judgment
  window?: string;
}

export interface RouteResult {
  lane: "fast" | "strong";
  scope?: "project" | "general"; // only when `project` was given
  confidence?: number;
  followup?: number; // probability it continues the previous question
  ms?: number;
  reason?: string;
}

export const MIN_FAST = 0.6;     // below this the strong model answers (a wrong "fast" costs more than a slower answer)
export const MIN_FOLLOWUP = 0.6;
export const MIN_GENERAL = 0.6;  // scope confidence needed to leave the project for "general"

/** Jev's answers as the route questions come back. */
export type RouteAnswers = Record<string, { choice?: string; confidence?: number; noul?: number } | undefined>;

/** The Jev request for an input: the scope question only with a project, the follow-up one only with a previous question. */
export function routeRequest(input: RouteInput): { state: Record<string, unknown>; questions: Record<string, unknown> } {
  const { question: utterance, previous, project } = input;
  const state: Record<string, unknown> = {
    spoken_request: utterance,
    note: "Spoken aloud to a software developer's AI assistant while looking at their screen; speech-to-text may mishear words.",
  };
  if (previous) state.previous_request = previous;
  if (project) {
    state.recent_project = project;
    if (input.app) state.app_under_pointer = input.app;
    if (input.window) state.window_under_pointer = input.window.slice(0, 120);
  }

  const questions: Record<string, unknown> = {
    lane: {
      type: "choice",
      instructions: "How much capability does answering `spoken_request` need?",
      criteria: {
        fast:
          "Light: small talk, a status or yes/no check, a short factual or definitional answer, or briefly explaining or " +
          "reading something visible on the screen. Answerable in a few sentences without changing anything.",
        strong:
          "Heavy: reading or changing project code, finding the cause of an error, running commands or using apps on the " +
          "computer, planning or comparing approaches, reviewing work, writing longer text, or any multi-step task.",
      },
    },
  };
  if (project) {
    questions.scope = {
      type: "choice",
      instructions: "Is `spoken_request` about the software project `recent_project`, or a general request?",
      criteria: {
        project:
          "About that project: its code, the app being built, its errors, tests, data or deployment, or development work on it.",
        general:
          "Anything else: general knowledge, everyday tasks, emails, chats, web pages or other apps, or work unrelated to that project.",
      },
    };
  }
  if (previous) {
    questions.followup = {
      type: "noul",
      instructions: "Does `spoken_request` continue or refer back to `previous_request` (for example \"do it\", \"and that one?\", \"why?\")?",
      criteria: { true: "It continues the previous request or depends on it to make sense", false: "It is a new, self-contained request" },
    };
  }
  return { state, questions };
}

/** The lane (and scope) from Jev's answers. */
export function decide(answers: RouteAnswers, input: Pick<RouteInput, "project" | "previousLane">): RouteResult {
  const followup = answers.followup?.noul;
  // Unsure about the scope: stay with the project (its assistant can still answer general questions).
  const scope: RouteResult["scope"] = input.project
    ? (answers.scope?.choice === "general" && (answers.scope?.confidence ?? 0) >= MIN_GENERAL ? "general" : "project")
    : undefined;
  const confidence = answers.lane?.confidence ?? 0;
  // A follow-up to a heavy question stays with the strong model (it has that conversation's context and tools).
  if (input.previousLane === "strong" && (followup ?? 0) >= MIN_FOLLOWUP) return { lane: "strong", scope, confidence, followup, reason: "follow-up" };
  if (answers.lane?.choice === "fast" && confidence >= MIN_FAST) return { lane: "fast", scope, confidence, followup };
  return { lane: "strong", scope, confidence, followup };
}

export async function route(input: RouteInput): Promise<RouteResult> {
  const { project } = input;
  const started = Date.now();
  const key = apiKey();
  if (!key) return { lane: "strong", scope: project ? "project" : undefined, reason: "no TypeSafe API key" };

  const { state, questions } = routeRequest(input);
  let answers: RouteAnswers;
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    answers = (await res.json()).answers;
  } catch (err) {
    return { lane: "strong", scope: project ? "project" : undefined, reason: String((err as Error).message ?? err), ms: Date.now() - started };
  }
  const ms = Date.now() - started;
  return { ...decide(answers, input), ms };
}
