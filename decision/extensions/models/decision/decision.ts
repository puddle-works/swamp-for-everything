/**
 * @mesgme/decision — the deterministic steps either side of the AI call.
 *
 *   frame:   validate the request and build the prompt          (before AI)
 *   resolve: parse, validate and normalise the model's free text (after AI)
 *
 * Both throw before writing anything when their input is invalid, so the
 * workflow step fails and no misleading data is persisted.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { frameDecision, resolveDecision } from "./_lib/logic.ts";

const FrameArgs = z.object({
  question: z.string().describe("The decision to make"),
  context: z.string().default("").describe("Facts and constraints"),
  options: z.array(z.string()).describe("Candidate answers (2 or more)"),
});

const ResolveArgs = z.object({
  question: z.string(),
  options: z.array(z.string()).describe("Framed (canonical) options"),
  response: z.string().describe("Raw text returned by the LLM step"),
  llmModel: z.string().default("unknown").describe("Which model answered"),
});

const FramedSchema = z.object({
  question: z.string(),
  context: z.string(),
  options: z.array(z.string()),
  prompt: z.string(),
});

const DecisionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  decision: z.string(),
  reasoning: z.string(),
  evidence: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rejected: z.array(z.object({ option: z.string(), reason: z.string() })),
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  llmModel: z.string(),
  rawResponse: z.string(),
  resolvedAt: z.string(),
});

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

export const model = {
  type: "@mesgme/decision",
  version: "2026.10.02.1",
  globalArguments: z.object({}),
  resources: {
    framed: {
      description: "Validated decision request and the prompt sent to the LLM",
      schema: FramedSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    decision: {
      description: "Typed decision produced from the LLM response",
      schema: DecisionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    frame: {
      description: "Validate a decision request and build the LLM prompt",
      arguments: FrameArgs,
      execute: async (
        args: z.infer<typeof FrameArgs>,
        context: { writeResource: WriteResource },
      ) => {
        const framed = frameDecision(args);
        const handle = await context.writeResource("framed", "framed", framed);
        return { dataHandles: [handle] };
      },
    },
    resolve: {
      description:
        "Parse and validate the LLM response into a typed decision resource",
      arguments: ResolveArgs,
      execute: async (
        args: z.infer<typeof ResolveArgs>,
        context: { writeResource: WriteResource },
      ) => {
        const resolved = resolveDecision(args);
        const handle = await context.writeResource("decision", "decision", {
          question: args.question,
          options: args.options,
          ...resolved,
          llmModel: args.llmModel,
          rawResponse: args.response,
          resolvedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
