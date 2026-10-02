/**
 * @mesgme/stub-llm — a deterministic stand-in for @keeb/anthropic/claude.
 *
 * Same contract: `generate({prompt})` writes resource `result`
 * `{response, model, timestamp}`, so the workflow can swap one for the other
 * by changing only which model definition the `ask` step targets.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { stubDecide } from "./_lib/logic.ts";

const GlobalArgs = z.object({
  model: z.string().default("stub-heuristic-v1"),
});

const GenerateArgs = z.object({
  prompt: z.string().describe("The prompt to send"),
});

export const model = {
  type: "@mesgme/stub-llm",
  version: "2026.10.02.1",
  globalArguments: GlobalArgs,
  resources: {
    result: {
      description: "Stub LLM response",
      schema: z.object({
        response: z.string(),
        model: z.string(),
        timestamp: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    generate: {
      description: "Answer a framed decision prompt deterministically",
      arguments: GenerateArgs,
      execute: async (
        args: z.infer<typeof GenerateArgs>,
        context: {
          globalArgs: Partial<z.infer<typeof GlobalArgs>>;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const handle = await context.writeResource("result", "result", {
          response: stubDecide(args.prompt),
          model: context.globalArgs.model ?? "stub-heuristic-v1",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
