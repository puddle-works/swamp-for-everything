/**
 * @mesgme/branch-protection — does a public GitHub repo protect its default
 * branch?
 *
 *   parse:   turn a repo link into owner/repo              (deterministic)
 *   inspect: ask the GitHub REST API, unauthenticated       (external call)
 *
 * Both throw before writing anything when they cannot answer, so the workflow
 * step fails and no misleading `false` is persisted.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { inspectProtection, parseRepoUrl } from "./_lib/github.ts";

const ParseArgs = z.object({
  url: z.string().describe("Link to a public GitHub repository"),
});

const InspectArgs = z.object({
  owner: z.string().describe("Repository owner (user or organisation)"),
  repo: z.string().describe("Repository name"),
});

const TargetSchema = z.object({
  url: z.string(),
  owner: z.string(),
  repo: z.string(),
});

const ProtectionSchema = z.object({
  fullName: z.string(),
  defaultBranch: z.string(),
  protected: z.boolean(),
  branchProtected: z.boolean(),
  rules: z.array(z.string()),
  checkedAt: z.string(),
});

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

export const model = {
  type: "@mesgme/branch-protection",
  version: "2026.10.02.1",
  globalArguments: z.object({}),
  resources: {
    target: {
      description: "The repository a link points at",
      schema: TargetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    protection: {
      description: "Whether the repository's default branch is protected",
      schema: ProtectionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    parse: {
      description: "Parse a GitHub repository link into owner and repo",
      arguments: ParseArgs,
      execute: async (
        args: z.infer<typeof ParseArgs>,
        context: { writeResource: WriteResource },
      ) => {
        const ref = parseRepoUrl(args.url);
        const handle = await context.writeResource("target", "target", {
          url: args.url,
          ...ref,
        });
        return { dataHandles: [handle] };
      },
    },
    inspect: {
      description:
        "Check the default branch for branch protection or ruleset rules",
      arguments: InspectArgs,
      execute: async (
        args: z.infer<typeof InspectArgs>,
        context: { writeResource: WriteResource },
      ) => {
        const result = await inspectProtection(args);
        const handle = await context.writeResource("protection", "protection", {
          ...result,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
