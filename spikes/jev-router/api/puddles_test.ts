import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";
import {
  type CommandResult,
  puddleName,
  PuddleRaiser,
  retryOn137,
  sourceRef,
} from "./puddles.ts";

const QUESTION = {
  type: "noul" as const,
  instructions: "Does this repo have a LICENSE file?",
};
const CANDIDATE = {
  question: QUESTION,
  state: "https://github.com/o/r",
  probability: 0.92,
};

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: "",
  stderr,
});

/** A swamp CLI fake: `model get` says "not found" unless `exists`. */
function fakeSwamp(opts: { exists?: boolean; failOn?: string } = {}) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run = (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    if (opts.failOn && args.includes(opts.failOn)) {
      return Promise.resolve(fail(`${opts.failOn} broke`));
    }
    if (args[0] === "model" && args[1] === "get") {
      return Promise.resolve(opts.exists ? ok("{}") : fail("Model not found"));
    }
    return Promise.resolve(ok());
  };
  return { run, calls };
}

const config = { requester: "owner@example.com" };

Deno.test("sourceRef is stable across case and whitespace, and differs by type", async () => {
  const a = await sourceRef(QUESTION);
  assertEquals(a.startsWith("jev-router:"), true);
  assertEquals(
    await sourceRef({
      type: "noul",
      instructions: "  does this repo have a   LICENSE file? ",
    }),
    a,
  );
  assertNotEquals(
    await sourceRef({
      type: "choice",
      instructions: QUESTION.instructions,
      criteria: { yes: null, no: null },
    }),
    a,
  );
});

Deno.test("puddleName is a kebab-case name from the sourceRef", () => {
  assertEquals(puddleName("jev-router:0123abcd"), "jev-router-0123abcd");
});

Deno.test("raise creates, drafts and submits a puddle named from the sourceRef", async () => {
  const swamp = fakeSwamp();
  const raiser = new PuddleRaiser(swamp.run, config, () => {});
  assertEquals(await raiser.raise(CANDIDATE), "raised");

  const ref = await sourceRef(QUESTION);
  const name = puddleName(ref);
  assertEquals(swamp.calls.map((c) => c.args.slice(0, 4)), [
    ["model", "get", name, "--json"],
    ["model", "create", "@mesgme/puddle/request", name],
    ["model", "method", "run", name],
    ["model", "method", "run", name],
  ]);

  const create = swamp.calls[1].args;
  const arg = (k: string) =>
    create.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
  assertEquals(
    arg("title"),
    "Deterministic check: Does this repo have a LICENSE file?",
  );
  assertEquals(arg("requester"), "owner@example.com");
  assertEquals(arg("acceptanceUser"), "owner@example.com");
  assertEquals(arg("sourceRef"), ref);

  assertEquals(swamp.calls[2].args[4], "draft");
  assertEquals(swamp.calls[3].args[4], "submit");
  const inputs = JSON.parse(swamp.calls[3].stdin!);
  assertEquals(inputs.frequency, "event_triggered");
  assertEquals(inputs.problemDescription.includes(QUESTION.instructions), true);
  assertEquals(
    inputs.problemDescription.includes("https://github.com/o/r"),
    true,
  );
  assertEquals(inputs.currentProcess.includes("0.92"), true);
  assertEquals(
    inputs.problemDescription.includes("spikes/jev-router/api/registry.ts"),
    true,
  );
});

Deno.test("raise only raises once per sourceRef, then counts repeats", async () => {
  const swamp = fakeSwamp();
  const raiser = new PuddleRaiser(swamp.run, config, () => {});
  await raiser.raise(CANDIDATE);
  const after = swamp.calls.length;
  assertEquals(await raiser.raise(CANDIDATE), "repeat");
  assertEquals(swamp.calls.length, after);
  assertEquals(raiser.count(await sourceRef(QUESTION)), 2);
});

Deno.test("raise skips a puddle that already exists in the puddle repo", async () => {
  const swamp = fakeSwamp({ exists: true });
  const raiser = new PuddleRaiser(swamp.run, config, () => {});
  assertEquals(await raiser.raise(CANDIDATE), "exists");
  assertEquals(swamp.calls.length, 1);
});

Deno.test("a failed create throws, and the next request tries again", async () => {
  const swamp = fakeSwamp({ failOn: "create" });
  const raiser = new PuddleRaiser(swamp.run, config, () => {});
  await assertRejects(() => raiser.raise(CANDIDATE), Error, "create broke");
  const before = swamp.calls.length;
  await assertRejects(() => raiser.raise(CANDIDATE));
  assertEquals(swamp.calls.length > before, true);
});

Deno.test("retryOn137 retries a command swamp killed during its own update", async () => {
  const results = [fail("", 137), ok("done")];
  const waits: number[] = [];
  const run = retryOn137(
    () => Promise.resolve(results.shift()!),
    (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  );
  assertEquals((await run(["--version"])).stdout, "done");
  assertEquals(waits.length, 1);
});
