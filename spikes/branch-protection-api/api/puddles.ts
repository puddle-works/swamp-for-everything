/**
 * Raise a puddle (a Puddleworks App Request) asking for a missing check.
 *
 * There's no API for creating puddles yet (puddle-works/puddleworks#132), so
 * this runs the swamp CLI in the puddle repo: `model create`, then `draft`,
 * then `submit`. The puddle is named from its `sourceRef`, so the puddle repo
 * itself records which questions already have one.
 *
 * @module
 */
import type { Entry, Question } from "./jev/client.ts";
import { normalise } from "./registry.ts";

/** A forwarded question Jev rated likely to be answerable by code. */
export interface PuddleCandidate {
  question: Question;
  state: Entry;
  /** Jev's probability that it could be answered by code. */
  probability: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `swamp <args>` in the puddle repo. */
export type Runner = (args: string[], stdin?: string) => Promise<CommandResult>;

export interface PuddleConfig {
  /** Owner of the router: the puddle's requester and acceptance user. */
  requester: string;
  /** Further global arguments for the puddle, e.g. notifyUrl. */
  globalArgs?: Record<string, string>;
}

const STATE_EXAMPLE_LIMIT = 2000;

function instructionsText(question: Question): string {
  return typeof question.instructions === "string"
    ? question.instructions
    : JSON.stringify(question.instructions);
}

/** `jev-router:<hash>`, the same for the same type and normalised text. */
export async function sourceRef(question: Question): Promise<string> {
  const key = `${question.type}\n${normalise(instructionsText(question))}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `jev-router:${hex.slice(0, 16)}`;
}

export function puddleName(ref: string): string {
  return ref.replace(":", "-");
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describe(c: PuddleCandidate): string {
  const state = typeof c.state === "string"
    ? c.state
    : JSON.stringify(c.state, null, 2);
  return [
    "Callers ask Jev (TypeSafe's System One model) this question through the " +
    "Jev router, and Jev thinks it could be answered exactly by code. Build a " +
    "deterministic swamp check for it and add it to the router's registry " +
    "(spikes/branch-protection-api/api/registry.ts in " +
    "puddle-works/swamp-for-everything).",
    "",
    `Question type: ${c.question.type}`,
    `Instructions: ${instructionsText(c.question)}`,
    `Criteria: ${JSON.stringify(c.question.criteria ?? null)}`,
    "",
    "Example state:",
    shorten(state, STATE_EXAMPLE_LIMIT),
  ].join("\n");
}

export class PuddleRaiser {
  #seen = new Map<string, number>();

  constructor(
    private run: Runner,
    private config: PuddleConfig,
    private log: (message: string) => void,
  ) {}

  /** How many times this sourceRef has been seen since the router started. */
  count(ref: string): number {
    return this.#seen.get(ref) ?? 0;
  }

  async raise(c: PuddleCandidate): Promise<"raised" | "exists" | "repeat"> {
    const ref = await sourceRef(c.question);
    const seen = this.#seen.get(ref);
    if (seen !== undefined) {
      this.#seen.set(ref, seen + 1);
      this.log(`puddle ${ref}: repeat ${seen + 1}`);
      return "repeat";
    }
    // Mark it before any await, so concurrent requests raise it once.
    this.#seen.set(ref, 1);
    try {
      return await this.#create(ref, c);
    } catch (e) {
      this.#seen.delete(ref);
      throw e;
    }
  }

  async #create(
    ref: string,
    c: PuddleCandidate,
  ): Promise<"raised" | "exists"> {
    const name = puddleName(ref);
    if ((await this.run(["model", "get", name, "--json"])).code === 0) {
      this.log(`puddle ${ref}: already exists as ${name}`);
      return "exists";
    }

    const globalArgs: Record<string, string> = {
      ...this.config.globalArgs,
      title: `Deterministic check: ${
        shorten(instructionsText(c.question), 80)
      }`,
      requester: this.config.requester,
      acceptanceUser: this.config.requester,
      sourceRef: ref,
    };
    await this.#step([
      "model",
      "create",
      "@mesgme/puddle/request",
      name,
      "--json",
      ...Object.entries(globalArgs).flatMap(([k, v]) => [
        "--global-arg",
        `${k}=${v}`,
      ]),
    ]);
    await this.#step(["model", "method", "run", name, "draft", "--json"]);
    await this.#step(
      ["model", "method", "run", name, "submit", "--stdin", "--json"],
      JSON.stringify({
        problemDescription: describe(c),
        currentProcess:
          "Answered by Jev (an LLM) via the Jev router. Jev rated it " +
          `${c.probability} likely to be answerable by code.`,
        frequency: "event_triggered",
      }),
    );
    this.log(`puddle ${ref}: raised and submitted as ${name}`);
    return "raised";
  }

  async #step(args: string[], stdin?: string): Promise<void> {
    const res = await this.run(args, stdin);
    if (res.code !== 0) {
      throw new Error(
        `swamp ${args.slice(0, 5).join(" ")} exited ${res.code}: ${
          (res.stderr || res.stdout).trim()
        }`,
      );
    }
  }
}

/**
 * Retry once when swamp exits 137 with no output: it is killed if it starts
 * while `swamp update` is running, which the session hook does at start-up.
 */
export function retryOn137(
  run: Runner,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Runner {
  return async (args, stdin) => {
    const first = await run(args, stdin);
    if (first.code !== 137) return first;
    await sleep(2000);
    return await run(args, stdin);
  };
}

/** Runs the real swamp CLI in `repoDir`. */
export function swampCli(repoDir: string): Runner {
  return async (args, stdin) => {
    const child = new Deno.Command("swamp", {
      args,
      cwd: repoDir,
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
    }
    const out = await child.output();
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    return {
      code: out.code,
      stdout: text(out.stdout),
      stderr: text(out.stderr),
    };
  };
}
