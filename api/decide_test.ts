import { assert, assertEquals } from "jsr:@std/assert@1";
import { SwampClientError } from "jsr:@swamp-club/swamp-lib@0.20260928.23";
import { type DecideDeps, handleDecide, type SwampLike } from "./decide.ts";

const BODY = {
  question: "Which database?",
  context: "PostgreSQL twice. PostgreSQL.",
  options: ["MongoDB", "PostgreSQL"],
};

const DECISION = {
  question: "Which database?",
  options: ["MongoDB", "PostgreSQL"],
  decision: "PostgreSQL",
  reasoning: "r",
  evidence: ["e"],
  confidence: 0.75,
  rejected: [{ option: "MongoDB", reason: "x" }],
  checks: [{ name: "schema-valid", passed: true }],
  llmModel: "stub-heuristic-v1",
  rawResponse: "```json\n{}\n```",
  resolvedAt: "2026-10-02T00:00:00.000Z",
};

const step = (name: string, status = "succeeded", extra = {}) => ({
  name,
  status,
  duration: 5,
  ...extra,
});

const SUCCEEDED_RUN = {
  id: "run-1",
  workflowId: "wf",
  workflowName: "decide",
  status: "succeeded",
  duration: 42,
  jobs: [{
    name: "decide",
    status: "succeeded",
    steps: [
      step("frame"),
      step("ask"),
      step("resolve", "succeeded", {
        dataArtifacts: [
          {
            dataId: "d-report",
            name: "report-swamp-method-summary",
            version: 1,
            tags: { type: "report" },
          },
          {
            dataId: "d-1",
            name: "decision",
            version: 7,
            tags: {
              type: "resource",
              specName: "decision",
              modelName: "decision-resolver",
            },
          },
        ],
      }),
      step("check"),
    ],
  }],
};

type Call = { type: string; payload: unknown };

function fakeClient(
  opts: {
    run?: unknown;
    runError?: Error;
    connectError?: Error;
    content?: unknown;
  } = {},
) {
  const calls: Call[] = [];
  let closed = false;
  const client: SwampLike = {
    connect: () =>
      opts.connectError ? Promise.reject(opts.connectError) : Promise.resolve(),
    close: () => {
      closed = true;
    },
    workflowRun: (payload) => {
      calls.push({ type: "workflow.run", payload });
      return opts.runError
        ? Promise.reject(opts.runError)
        : Promise.resolve((opts.run ?? SUCCEEDED_RUN) as never);
    },
    request: <T>(type: string, payload?: Record<string, unknown>) => {
      calls.push({ type, payload });
      return Promise.resolve(
        { data: { content: JSON.stringify(opts.content ?? DECISION) } } as T,
      );
    },
  };
  return { client, calls, isClosed: () => closed };
}

function deps(client: SwampLike, defaultLlm = "stub"): DecideDeps {
  return { connect: () => Promise.resolve(client), defaultLlm };
}

const post = (body: unknown) =>
  new Request("http://x/api/decide", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("400 for a body that is not JSON", async () => {
  const { client } = fakeClient();
  const res = await handleDecide(post("{nope"), deps(client));
  assertEquals(res.status, 400);
});

Deno.test("400 for missing question or fewer than two options, without calling swamp", async () => {
  for (
    const body of [{ options: ["a", "b"] }, { question: "Q", options: ["a"] }]
  ) {
    const { client, calls } = fakeClient();
    const res = await handleDecide(post(body), deps(client));
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(calls.length, 0);
  }
});

Deno.test("400 for an llm that is not stub or claude", async () => {
  const { client } = fakeClient();
  const res = await handleDecide(post({ ...BODY, llm: "gpt" }), deps(client));
  assertEquals(res.status, 400);
});

Deno.test("success runs the decide workflow and returns the typed decision plus run trace", async () => {
  const { client, calls, isClosed } = fakeClient();
  const res = await handleDecide(post(BODY), deps(client, "stub"));
  assertEquals(res.status, 200);
  const json = await res.json();

  assertEquals(calls[0].type, "workflow.run");
  assertEquals(
    (calls[0].payload as { workflowIdOrName: string }).workflowIdOrName,
    "decide",
  );
  assertEquals(
    (calls[0].payload as { inputs: Record<string, unknown> }).inputs,
    { ...BODY, llm: "stub" },
  );
  assertEquals(calls[1], {
    type: "data.get",
    payload: {
      modelIdOrName: "decision-resolver",
      dataName: "decision",
      version: 7,
      includeContent: true,
    },
  });

  assertEquals(json.decision, "PostgreSQL");
  assertEquals(json.confidence, 0.75);
  assertEquals(json.rejected, DECISION.rejected);
  assertEquals(json.ai, {
    model: "stub-heuristic-v1",
    rawResponse: DECISION.rawResponse,
  });
  assertEquals(json.run.runId, "run-1");
  assertEquals(json.run.status, "succeeded");
  assertEquals(json.run.llm, "stub");
  assertEquals(json.run.steps.map((s: { name: string }) => s.name), [
    "frame",
    "ask",
    "resolve",
    "check",
  ]);
  assertEquals(json.run.artifact, {
    model: "decision-resolver",
    name: "decision",
    version: 7,
    dataId: "d-1",
  });
  assert(isClosed(), "client should be closed after the request");
});

Deno.test("request llm overrides the default", async () => {
  const { client, calls } = fakeClient();
  await handleDecide(post({ ...BODY, llm: "claude" }), deps(client, "stub"));
  assertEquals(
    (calls[0].payload as { inputs: { llm: string } }).inputs.llm,
    "claude",
  );
});

Deno.test("502 with the failing step and its error when the run fails", async () => {
  const failed = {
    ...SUCCEEDED_RUN,
    status: "failed",
    jobs: [{
      name: "decide",
      status: "failed",
      steps: [
        step("frame"),
        step("ask", "failed", { error: "Anthropic API error (401)" }),
        step("resolve", "skipped"),
        step("check", "skipped"),
      ],
    }],
  };
  const { client, calls, isClosed } = fakeClient({ run: failed });
  const res = await handleDecide(post(BODY), deps(client));
  assertEquals(res.status, 502);
  const json = await res.json();
  assertEquals(json.failedStep, "ask");
  assertEquals(json.error, "Anthropic API error (401)");
  assertEquals(json.run.runId, "run-1");
  assertEquals(calls.length, 1, "no data.get after a failed run");
  assert(isClosed());
});

Deno.test("400 when swamp rejects the workflow inputs", async () => {
  const { client } = fakeClient({
    runError: new SwampClientError(
      "input_validation_failed",
      "Input validation failed",
      [{ path: "options", message: "too few" }],
    ),
  });
  const res = await handleDecide(post(BODY), deps(client));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).details, [{
    path: "options",
    message: "too few",
  }]);
});

Deno.test("503 when swamp serve is unreachable", async () => {
  const res = await handleDecide(post(BODY), {
    connect: () => Promise.reject(new Error("tcp connect error")),
    defaultLlm: "stub",
  });
  assertEquals(res.status, 503);
  assert((await res.json()).error.includes("swamp serve"));
});
