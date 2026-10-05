import { assertEquals } from "jsr:@std/assert@1";
import type { SystemOneRequest, SystemOneResponse } from "./jev/client.ts";
import { TypeSafeApiError } from "./jev/client.ts";
import { router, type RouterDeps } from "./router.ts";
import type { WorkflowOutcome } from "./swamp.ts";
import type { PuddleCandidate } from "./puddles.ts";

interface Fake {
  deps: RouterDeps;
  jevCalls: { request: SystemOneRequest; apiKey: string }[];
  workflowCalls: { workflow: string; inputs: Record<string, unknown> }[];
  logs: string[];
  /** Work the router scheduled for after the reply. */
  later: (() => Promise<void>)[];
  puddles: PuddleCandidate[];
}

/**
 * Jev fake: answers every noul question with 0.5, unless overridden.
 * Swamp fake: every workflow says `protected: true`, unless overridden.
 */
function fake(opts: {
  jev?: (r: SystemOneRequest) => SystemOneResponse;
  workflow?: WorkflowOutcome;
  puddleFails?: boolean;
} = {}): Fake {
  const later: Fake["later"] = [];
  const puddles: PuddleCandidate[] = [];
  const jevCalls: Fake["jevCalls"] = [];
  const workflowCalls: Fake["workflowCalls"] = [];
  const logs: string[] = [];
  const deps: RouterDeps = {
    runWorkflow: (workflow, inputs) => {
      workflowCalls.push({ workflow, inputs });
      return Promise.resolve(
        opts.workflow ?? { ok: true, result: { protected: true } },
      );
    },
    log: (message) => logs.push(message),
    later: (task) => later.push(task),
    raisePuddle: (candidate) => {
      puddles.push(candidate);
      return opts.puddleFails
        ? Promise.reject(new Error("swamp exited 1"))
        : Promise.resolve();
    },
    jev: (request, apiKey) => {
      jevCalls.push({ request, apiKey });
      return Promise.resolve(
        opts.jev ? opts.jev(request) : {
          model: "jev-1.13-free",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((
              id,
            ) => [id, { type: "noul" as const, noul: 0.5 }]),
          ),
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      );
    },
  };
  return { deps, jevCalls, workflowCalls, logs, later, puddles };
}

function post(body: unknown, auth = "Bearer sk-test"): Request {
  return new Request("http://localhost/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const JUDGEMENT = {
  type: "noul" as const,
  instructions: "Is this README friendly to newcomers?",
};

Deno.test("systemone: bad JSON is a 400", async () => {
  const res = await router(fake().deps)(post("{"));
  assertEquals(res.status, 400);
});

Deno.test("systemone: a request without questions is a 422", async () => {
  const res = await router(fake().deps)(
    post({ state: "s", model: "jev-latest", questions: {} }),
  );
  assertEquals(res.status, 422);
  assertEquals(typeof (await res.json()).error, "string");
});

Deno.test("systemone: an unknown question type is a 422", async () => {
  const res = await router(fake().deps)(
    post({
      state: "s",
      model: "jev-latest",
      questions: { q: { type: "essay", instructions: "Write one" } },
    }),
  );
  assertEquals(res.status, 422);
});

Deno.test("systemone: passes a valid request to Jev with the caller's key", async () => {
  const f = fake();
  const res = await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    model: "jev-1.13-free",
    answers: { q: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 100, output_tokens: 10 },
  });
  assertEquals(f.jevCalls.length, 1);
  assertEquals(f.jevCalls[0].apiKey, "sk-test");
  assertEquals(f.jevCalls[0].request.state, "s");
  assertEquals(f.jevCalls[0].request.model, "jev-latest");
  assertEquals(f.jevCalls[0].request.questions.q, JUDGEMENT);
});

Deno.test("systemone: a Jev error goes back to the caller unchanged", async () => {
  const f = fake({
    jev: () => {
      throw new TypeSafeApiError("evaluation", 401, { error: "bad key" });
    },
  });
  const res = await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "bad key" });
});

Deno.test("systemone: Jev unreachable is a 502", async () => {
  const f = fake({
    jev: () => {
      throw new Error("could not reach");
    },
  });
  const res = await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  assertEquals(res.status, 502);
});

const PROTECTED = {
  type: "noul" as const,
  instructions: "Is the default branch of this repository protected?",
};
const REPO_STATE = "The repository is https://github.com/o/r.";

Deno.test("systemone: answers the branch-protection question from swamp, not Jev", async () => {
  const f = fake();
  const res = await router(f.deps)(
    post({
      state: REPO_STATE,
      model: "jev-latest",
      questions: { p: PROTECTED },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    model: "jev-latest",
    answers: { p: { type: "noul", noul: 1 } },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  assertEquals(f.jevCalls.length, 0);
  assertEquals(f.workflowCalls, [{
    workflow: "branch-protection",
    inputs: { url: "https://github.com/o/r" },
  }]);
});

Deno.test("systemone: an unprotected branch is noul 0", async () => {
  const f = fake({ workflow: { ok: true, result: { protected: false } } });
  const res = await router(f.deps)(
    post({
      state: REPO_STATE,
      model: "jev-latest",
      questions: { p: PROTECTED },
    }),
  );
  assertEquals((await res.json()).answers.p, { type: "noul", noul: 0 });
});

Deno.test("systemone: a failed check falls through to Jev and is logged", async () => {
  const f = fake({ workflow: { ok: false, status: 502, error: "GitHub 500" } });
  const res = await router(f.deps)(
    post({
      state: REPO_STATE,
      model: "jev-latest",
      questions: { p: PROTECTED },
    }),
  );
  assertEquals((await res.json()).answers.p, { type: "noul", noul: 0.5 });
  assertEquals(f.jevCalls[0].request.questions.p, PROTECTED);
  assertEquals(f.logs.some((l) => l.includes("GitHub 500")), true);
});

Deno.test("systemone: no repo in state falls through to Jev without running swamp", async () => {
  const f = fake();
  const res = await router(f.deps)(
    post({
      state: "no repo",
      model: "jev-latest",
      questions: { p: PROTECTED },
    }),
  );
  assertEquals((await res.json()).answers.p, { type: "noul", noul: 0.5 });
  assertEquals(f.workflowCalls.length, 0);
});

Deno.test("systemone: asks Jev if each unchecked question could be code, then strips it", async () => {
  const f = fake();
  const res = await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  const sent = f.jevCalls[0].request.questions;
  const extra = Object.keys(sent).filter((id) => id !== "q");
  assertEquals(extra.length, 1);
  assertEquals(sent[extra[0]].type, "noul");
  assertEquals(
    JSON.stringify(sent[extra[0]].instructions).includes(
      JUDGEMENT.instructions,
    ),
    true,
  );
  assertEquals(Object.keys((await res.json()).answers), ["q"]);
});

Deno.test("systemone: a question with a failed check is not asked about as code", async () => {
  const f = fake({ workflow: { ok: false, status: 503, error: "down" } });
  await router(f.deps)(
    post({
      state: REPO_STATE,
      model: "jev-latest",
      questions: { p: PROTECTED },
    }),
  );
  assertEquals(Object.keys(f.jevCalls[0].request.questions), ["p"]);
});

Deno.test("systemone: a mixed request merges swamp and Jev answers in the caller's order", async () => {
  const f = fake();
  const res = await router(f.deps)(
    post({
      state: REPO_STATE,
      model: "jev-latest",
      questions: { q: JUDGEMENT, p: PROTECTED },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, {
    model: "jev-1.13-free",
    answers: {
      q: { type: "noul", noul: 0.5 },
      p: { type: "noul", noul: 1 },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  });
  assertEquals(Object.keys(body.answers), ["q", "p"]);
  assertEquals("p" in f.jevCalls[0].request.questions, false);
});

Deno.test("systemone: a Jev error wins even when some questions were answered locally", async () => {
  const f = fake({
    jev: () => {
      throw new TypeSafeApiError("evaluation", 429, { error: "slow down" });
    },
  });
  const res = await router(f.deps)(
    post({
      state: REPO_STATE,
      model: "jev-latest",
      questions: { q: JUDGEMENT, p: PROTECTED },
    }),
  );
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { error: "slow down" });
});

/** Jev fake that rates every "could be code" question at `p`. */
function ratesCode(p: number) {
  return (r: SystemOneRequest): SystemOneResponse => ({
    model: "jev-1.13-free",
    answers: Object.fromEntries(
      Object.keys(r.questions).map((id) => [
        id,
        { type: "noul" as const, noul: id.includes("could_be_code") ? p : 0.5 },
      ]),
    ),
    usage: { input_tokens: 100, output_tokens: 10 },
  });
}

Deno.test("systemone: raises a puddle after replying when Jev rates it ≥ 0.8 code", async () => {
  const f = fake({ jev: ratesCode(0.9) });
  const res = await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  assertEquals(res.status, 200);
  assertEquals(f.puddles.length, 0, "not before the reply");
  await Promise.all(f.later.map((t) => t()));
  assertEquals(f.puddles, [{
    question: JUDGEMENT,
    state: "s",
    probability: 0.9,
  }]);
});

Deno.test("systemone: no puddle below 0.8", async () => {
  const f = fake({ jev: ratesCode(0.79) });
  await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  await Promise.all(f.later.map((t) => t()));
  assertEquals(f.puddles.length, 0);
});

Deno.test("systemone: a failed puddle is logged and never reaches the caller", async () => {
  const f = fake({ jev: ratesCode(0.95), puddleFails: true });
  const res = await router(f.deps)(
    post({ state: "s", model: "jev-latest", questions: { q: JUDGEMENT } }),
  );
  assertEquals(res.status, 200);
  await Promise.all(f.later.map((t) => t()));
  assertEquals(f.logs.some((l) => l.includes("swamp exited 1")), true);
});
