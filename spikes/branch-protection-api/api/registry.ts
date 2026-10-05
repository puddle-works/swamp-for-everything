/**
 * The checks the Jev router can answer itself, from a swamp workflow.
 *
 * A question matches a check only on its exact `type` and normalised
 * `instructions` text, and only when the check's inputs can be found in
 * `state`. Anything unclear falls through to Jev: a wrong match must never
 * produce a confident wrong answer.
 *
 * @module
 */
import type { Answer, Entry, Question } from "./jev/client.ts";

export interface Check {
  type: Question["type"];
  /** The question text, as callers ask it. */
  instructions: string;
  /** The swamp workflow that answers it. */
  workflow: string;
  /** The workflow's inputs taken from `state`, or undefined if not there. */
  inputs(state: Entry): Record<string, unknown> | undefined;
  /** The workflow's `result` as a Jev answer, or undefined if unusable. */
  answer(result: Record<string, unknown>): Answer | undefined;
}

export const REGISTRY: Check[] = [{
  type: "noul",
  instructions: "Is the default branch of this repository protected?",
  workflow: "branch-protection",
  inputs: (state) => {
    const url = githubRepoUrl(state);
    return url ? { url } : undefined;
  },
  answer: (result) =>
    typeof result.protected === "boolean"
      ? { type: "noul", noul: result.protected ? 1 : 0 }
      : undefined,
}];

export function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findCheck(
  question: Question,
  registry: Check[] = REGISTRY,
): Check | undefined {
  if (typeof question.instructions !== "string") return undefined;
  const wanted = normalise(question.instructions);
  return registry.find((c) =>
    c.type === question.type && normalise(c.instructions) === wanted
  );
}

const GITHUB_REPO =
  /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g;

/**
 * The one GitHub repository URL mentioned in `state` (text, or any string
 * inside an object or array). Undefined if there is none, or more than one.
 */
export function githubRepoUrl(state: Entry): string | undefined {
  const found = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const [, owner, raw] of value.matchAll(GITHUB_REPO)) {
        // Drop a sentence's full stop, then a `.git` suffix.
        const repo = raw.replace(/\.+$/, "").replace(/\.git$/, "");
        if (!repo) continue;
        const key = `${owner}/${repo}`.toLowerCase();
        if (!found.has(key)) {
          found.set(key, `https://github.com/${owner}/${repo}`);
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(state);
  return found.size === 1 ? [...found.values()][0] : undefined;
}
