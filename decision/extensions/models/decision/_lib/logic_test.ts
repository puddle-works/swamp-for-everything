import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  extractJson,
  frameDecision,
  parseFramedPrompt,
  resolveDecision,
  stubDecide,
} from "./logic.ts";

const OPTIONS = ["PostgreSQL", "MongoDB"];

// --- frameDecision ----------------------------------------------------------

Deno.test("frameDecision trims and de-duplicates options", () => {
  const framed = frameDecision({
    question: "  Which database? ",
    context: "We need joins.",
    options: [" PostgreSQL ", "MongoDB", "postgresql", ""],
  });
  assertEquals(framed.question, "Which database?");
  assertEquals(framed.options, ["PostgreSQL", "MongoDB"]);
});

Deno.test("frameDecision rejects fewer than two distinct options", () => {
  assertThrows(
    () =>
      frameDecision({ question: "Q?", context: "", options: ["A", " a ", ""] }),
    Error,
    "at least two distinct options",
  );
});

Deno.test("frameDecision rejects an empty question", () => {
  assertThrows(
    () => frameDecision({ question: "  ", context: "", options: OPTIONS }),
    Error,
    "question",
  );
});

Deno.test("frameDecision prompt carries a machine-readable request block and the JSON contract", () => {
  const framed = frameDecision({
    question: "Which database?",
    context: "We need joins.",
    options: OPTIONS,
  });
  assert(framed.prompt.includes("<decision-request>"));
  assert(framed.prompt.includes('"decision"'));
  assertEquals(parseFramedPrompt(framed.prompt), {
    question: "Which database?",
    context: "We need joins.",
    options: OPTIONS,
  });
});

// --- extractJson ------------------------------------------------------------

Deno.test("extractJson parses bare JSON", () => {
  assertEquals(extractJson('{"a":1}'), { a: 1 });
});

Deno.test("extractJson parses a fenced block surrounded by prose", () => {
  const text = 'Sure! Here you go:\n```json\n{"a": 2}\n```\nHope that helps.';
  assertEquals(extractJson(text), { a: 2 });
});

Deno.test("extractJson falls back to the outermost braces", () => {
  assertEquals(extractJson('Answer: {"a": {"b": 3}} done'), { a: { b: 3 } });
});

Deno.test("extractJson throws when there is no JSON object", () => {
  assertThrows(() => extractJson("I cannot decide."), Error, "no JSON object");
});

// --- resolveDecision --------------------------------------------------------

const good = {
  decision: "postgresql",
  reasoning: "Joins and transactions.",
  evidence: ["needs joins"],
  confidence: 0.8,
  rejected: [{ option: "MongoDB", reason: "Weak joins." }],
};

Deno.test("resolveDecision canonicalises the decision to the option's spelling", () => {
  const r = resolveDecision({
    response: JSON.stringify(good),
    options: OPTIONS,
  });
  assertEquals(r.decision, "PostgreSQL");
  assertEquals(r.confidence, 0.8);
  assertEquals(r.rejected, [{ option: "MongoDB", reason: "Weak joins." }]);
  assert(r.checks.every((c) => c.passed), JSON.stringify(r.checks));
});

Deno.test("resolveDecision fails when the decision is not one of the options", () => {
  assertThrows(
    () =>
      resolveDecision({
        response: JSON.stringify({ ...good, decision: "SQLite" }),
        options: OPTIONS,
      }),
    Error,
    "not one of the options",
  );
});

Deno.test("resolveDecision fails on a response that does not match the schema", () => {
  assertThrows(
    () =>
      resolveDecision({
        response: JSON.stringify({ decision: "MongoDB" }),
        options: OPTIONS,
      }),
    Error,
    "schema",
  );
});

Deno.test("resolveDecision clamps confidence and records a failed check", () => {
  const r = resolveDecision({
    response: JSON.stringify({ ...good, confidence: 1.7 }),
    options: OPTIONS,
  });
  assertEquals(r.confidence, 1);
  const check = r.checks.find((c) => c.name === "confidence-in-range");
  assertEquals(check?.passed, false);
});

Deno.test("resolveDecision treats 1..100 confidence as a percentage", () => {
  const r = resolveDecision({
    response: JSON.stringify({ ...good, confidence: 85 }),
    options: OPTIONS,
  });
  assertEquals(r.confidence, 0.85);
});

Deno.test("resolveDecision fills in missing rejected options and drops unknown ones", () => {
  const r = resolveDecision({
    response: JSON.stringify({
      ...good,
      rejected: [{ option: "Redis", reason: "?" }],
    }),
    options: ["PostgreSQL", "MongoDB", "DynamoDB"],
  });
  assertEquals(r.rejected.map((x) => x.option), ["MongoDB", "DynamoDB"]);
  const check = r.checks.find((c) => c.name === "rejected-complete");
  assertEquals(check?.passed, false);
});

Deno.test("resolveDecision drops a rejected entry for the chosen option", () => {
  const r = resolveDecision({
    response: JSON.stringify({
      ...good,
      rejected: [
        { option: "PostgreSQL", reason: "contradiction" },
        { option: "mongodb", reason: "Weak joins." },
      ],
    }),
    options: OPTIONS,
  });
  assertEquals(r.rejected, [{ option: "MongoDB", reason: "Weak joins." }]);
});

// --- stubDecide -------------------------------------------------------------

Deno.test("stubDecide picks the option the context mentions most, as fenced JSON", () => {
  const { prompt } = frameDecision({
    question: "Which database?",
    context:
      "The team knows PostgreSQL well. PostgreSQL gives us joins. MongoDB was suggested once.",
    options: ["MongoDB", "PostgreSQL"],
  });
  const text = stubDecide(prompt);
  assert(text.startsWith("```json"), text);
  const r = resolveDecision({
    response: text,
    options: ["MongoDB", "PostgreSQL"],
  });
  assertEquals(r.decision, "PostgreSQL");
  assert(r.confidence > 0.5 && r.confidence <= 1);
  assertEquals(r.rejected.map((x) => x.option), ["MongoDB"]);
  assert(r.evidence.length > 0);
});

Deno.test("stubDecide is deterministic and falls back to the first option on a tie", () => {
  const { prompt } = frameDecision({
    question: "Tea or coffee?",
    context: "No preference.",
    options: ["Tea", "Coffee"],
  });
  assertEquals(stubDecide(prompt), stubDecide(prompt));
  const r = resolveDecision({
    response: stubDecide(prompt),
    options: ["Tea", "Coffee"],
  });
  assertEquals(r.decision, "Tea");
  assertEquals(r.confidence, 0.5);
});

Deno.test("stubDecide throws when the prompt has no decision-request block", () => {
  assertThrows(() => stubDecide("hello"), Error, "decision-request");
});
