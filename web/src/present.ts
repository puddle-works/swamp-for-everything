/**
 * Presentation helpers. The UI must hardcode which step calls out to GitHub
 * because swamp run views carry no notion of step kind (see FINDINGS.md).
 */
const EXTERNAL_STEPS = new Set(["inspect"]);

export type StepKind = "external" | "deterministic";

export const stepKind = (name: string): StepKind =>
  EXTERNAL_STEPS.has(name) ? "external" : "deterministic";

export type Evidence = { branchProtected: boolean; rules: string[] };

export function describeEvidence({ branchProtected, rules }: Evidence): string {
  const parts = [
    ...(branchProtected ? ["branch protection"] : []),
    ...(rules.length ? [`ruleset rules: ${rules.join(", ")}`] : []),
  ];
  return parts.length
    ? parts.join("; ")
    : "no branch protection and no ruleset rules";
}
