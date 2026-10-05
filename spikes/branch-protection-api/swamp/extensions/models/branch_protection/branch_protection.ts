/**
 * @mesgme/branch-protection — deterministic "is this repo's default branch
 * protected?" check.
 *
 * The model owns no policy: it parses the GitHub URL, asks the GitHub API, and
 * writes a typed `result` resource. All logic lives in `_lib/check.ts` so it
 * can be tested without swamp or the network.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { checkProtection, parseRepoUrl } from "./_lib/check.ts";

const GlobalArgsSchema = z.object({
  token: z
    .string()
    .describe("GitHub token with repo read access (use vault.get)"),
});

const CheckArgs = z.object({
  url: z.string().describe(
    "GitHub repository URL, e.g. https://github.com/o/r",
  ),
});

const ResultSchema = z.object({
  repo: z.string().describe("Canonical owner/repo slug"),
  branch: z.string().describe("Default branch that was checked"),
  protected: z.boolean().describe("Whether the default branch is protected"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

export const model = {
  type: "@mesgme/branch-protection",
  version: "2026.10.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Branch-protection answer for a repository",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    check: {
      description:
        "Check whether the repository's default branch has protection",
      arguments: CheckArgs,
      execute: async (
        args: z.infer<typeof CheckArgs>,
        context: { globalArgs: GlobalArgs; writeResource: WriteResource },
      ) => {
        const ref = parseRepoUrl(args.url);
        const result = await checkProtection(
          fetch,
          context.globalArgs.token,
          ref,
        );
        const handle = await context.writeResource("result", "result", {
          repo: result.repo,
          branch: result.branch,
          protected: result.protected,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
