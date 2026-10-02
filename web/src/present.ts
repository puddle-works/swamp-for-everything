/**
 * Presentation helpers. The UI must hardcode which step is AI because swamp
 * run views carry no notion of step kind (see FINDINGS.md).
 */
const AI_STEPS = new Set(["ask"]);

export type StepKind = "ai" | "deterministic";

export const stepKind = (name: string): StepKind =>
  AI_STEPS.has(name) ? "ai" : "deterministic";

export const parseOptions = (text: string): string[] =>
  text.split("\n").map((l) => l.trim()).filter(Boolean);

export const percent = (confidence: number): string =>
  `${Math.round(confidence * 100)}%`;
