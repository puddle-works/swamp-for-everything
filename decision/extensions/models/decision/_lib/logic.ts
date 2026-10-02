/**
 * Pure decision logic shared by the @mesgme/decision and @mesgme/stub-llm
 * model types. No swamp, no I/O — everything here is deterministic.
 *
 * @module
 */
import { z } from "npm:zod@4";

// =============================================================================
// Shared shapes
// =============================================================================

export const DecisionRequestSchema = z.object({
  question: z.string(),
  context: z.string(),
  options: z.array(z.string()),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export type Check = { name: string; passed: boolean; detail?: string };

export type ResolvedDecision = {
  decision: string;
  reasoning: string;
  evidence: string[];
  confidence: number;
  rejected: Array<{ option: string; reason: string }>;
  checks: Check[];
};

const norm = (s: string) => s.trim().toLowerCase();

// =============================================================================
// frame: validate the request and build the prompt (deterministic, pre-AI)
// =============================================================================

const REQUEST_OPEN = "<decision-request>";
const REQUEST_CLOSE = "</decision-request>";

export function frameDecision(
  input: DecisionRequest,
): DecisionRequest & { prompt: string } {
  const question = input.question.trim();
  if (!question) throw new Error("question must not be empty");
  const context = input.context.trim();

  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of input.options) {
    const option = raw.trim();
    if (!option || seen.has(norm(option))) continue;
    seen.add(norm(option));
    options.push(option);
  }
  if (options.length < 2) {
    throw new Error(
      `need at least two distinct options, got ${options.length}`,
    );
  }

  const request: DecisionRequest = { question, context, options };
  const prompt = [
    "Make a decision. Choose exactly one of the options.",
    "",
    REQUEST_OPEN,
    JSON.stringify(request, null, 2),
    REQUEST_CLOSE,
    "",
    "Respond with ONLY a JSON object of this shape:",
    "{",
    '  "decision": "<one option, copied exactly>",',
    '  "reasoning": "<why, 1-3 sentences>",',
    '  "evidence": ["<fact from the context that supports the decision>"],',
    '  "confidence": <number between 0 and 1>,',
    '  "rejected": [{ "option": "<each other option>", "reason": "<why not>" }]',
    "}",
  ].join("\n");

  return { ...request, prompt };
}

/** Recover the structured request that `frameDecision` embedded in a prompt. */
export function parseFramedPrompt(prompt: string): DecisionRequest {
  const start = prompt.indexOf(REQUEST_OPEN);
  const end = prompt.indexOf(REQUEST_CLOSE);
  if (start < 0 || end < start) {
    throw new Error("prompt has no <decision-request> block");
  }
  const body = prompt.slice(start + REQUEST_OPEN.length, end);
  return DecisionRequestSchema.parse(JSON.parse(body));
}

// =============================================================================
// resolve: turn free-form model text into a typed decision (deterministic, post-AI)
// =============================================================================

export function extractJson(text: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }
  throw new Error("model response contains no JSON object");
}

const RawDecisionSchema = z.object({
  decision: z.string(),
  reasoning: z.string(),
  evidence: z.array(z.string()).default([]),
  confidence: z.coerce.number(),
  rejected: z.array(z.object({ option: z.string(), reason: z.string() }))
    .default([]),
});

export function resolveDecision(
  input: { response: string; options: string[] },
): ResolvedDecision {
  const checks: Check[] = [];

  const json = extractJson(input.response);
  checks.push({ name: "json-extracted", passed: true });

  const parsed = RawDecisionSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `model response does not match the decision schema: ${
        z.prettifyError(parsed.error)
      }`,
    );
  }
  checks.push({ name: "schema-valid", passed: true });
  const raw = parsed.data;

  const byNorm = new Map(input.options.map((o) => [norm(o), o]));
  const decision = byNorm.get(norm(raw.decision));
  if (!decision) {
    throw new Error(
      `decision "${raw.decision}" is not one of the options: ${
        input.options.join(", ")
      }`,
    );
  }
  checks.push({
    name: "decision-in-options",
    passed: true,
    ...(decision !== raw.decision
      ? { detail: `normalised "${raw.decision}" to "${decision}"` }
      : {}),
  });

  let confidence = raw.confidence;
  if (!Number.isFinite(confidence)) {
    throw new Error("confidence is not a number");
  }
  const scaled = confidence > 1 && confidence <= 100 &&
    Number.isInteger(confidence);
  if (scaled) confidence = confidence / 100;
  const clamped = Math.min(1, Math.max(0, confidence));
  checks.push({
    name: "confidence-in-range",
    passed: !scaled && clamped === raw.confidence,
    ...(scaled
      ? { detail: `read ${raw.confidence} as a percentage` }
      : clamped !== raw.confidence
      ? { detail: `clamped ${raw.confidence} to ${clamped}` }
      : {}),
  });

  const reasons = new Map<string, string>();
  for (const r of raw.rejected) {
    const option = byNorm.get(norm(r.option));
    if (option && option !== decision && !reasons.has(option)) {
      reasons.set(option, r.reason);
    }
  }
  const others = input.options.filter((o) => o !== decision);
  const missing = others.filter((o) => !reasons.has(o));
  const rejected = others.map((option) => ({
    option,
    reason: reasons.get(option) ?? "No reason given by the model.",
  }));
  const dropped = raw.rejected.length - reasons.size;
  checks.push({
    name: "rejected-complete",
    passed: missing.length === 0 && dropped === 0,
    ...(missing.length || dropped
      ? {
        detail: [
          missing.length ? `filled in ${missing.join(", ")}` : "",
          dropped ? `dropped ${dropped} unknown or duplicate entries` : "",
        ].filter(Boolean).join("; "),
      }
      : {}),
  });

  return {
    decision,
    reasoning: raw.reasoning.trim(),
    evidence: raw.evidence.map((e) => e.trim()).filter(Boolean),
    confidence: clamped,
    rejected,
    checks,
  };
}

// =============================================================================
// stub: a deterministic stand-in for the LLM (same text-in/text-out contract)
// =============================================================================

function countMentions(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + n.length)) count++;
  return count;
}

/**
 * Picks the option the context mentions most often (first option on a tie)
 * and answers in the same fenced-JSON style a real model tends to use.
 * Not intelligent — it exists so the pipeline runs without an API key.
 */
export function stubDecide(prompt: string): string {
  const { context, options } = parseFramedPrompt(prompt);
  const scores = options.map((o) => countMentions(context, o));
  const best = scores.indexOf(Math.max(...scores));
  const decision = options[best];
  const total = scores.reduce((a, b) => a + b, 0);
  const runnerUp = Math.max(...scores.filter((_, i) => i !== best));
  // No mentions: uniform. Otherwise 0.5 plus a share of the winning margin.
  const confidence = total === 0
    ? Math.round((1 / options.length) * 100) / 100
    : Math.round((0.5 + 0.5 * ((scores[best] - runnerUp) / total)) * 100) /
      100;

  const sentences = context.split(/(?<=[.!?])\s+/).filter((s) =>
    countMentions(s, decision) > 0
  );
  const evidence = sentences.length
    ? sentences
    : ["No option is mentioned in the context; defaulted to the first."];

  const body = {
    decision,
    reasoning: `[stub] "${decision}" is mentioned ${
      scores[best]
    } time(s) in the context, more than any other option.`,
    evidence,
    confidence,
    rejected: options.filter((_, i) => i !== best).map((option) => ({
      option,
      reason: `[stub] mentioned ${
        scores[options.indexOf(option)]
      } time(s) in the context.`,
    })),
  };
  return "```json\n" + JSON.stringify(body, null, 2) + "\n```";
}
