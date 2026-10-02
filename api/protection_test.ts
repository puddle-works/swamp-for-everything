import { assert, assertEquals } from "jsr:@std/assert@1";
import { SwampClientError } from "jsr:@swamp-club/swamp-lib@0.20260928.23";
import {
  handleProtection,
  type ProtectionDeps,
  type SwampLike,
} from "./protection.ts";

const URL_IN = "https://github.com/denoland/deno";

const PROTECTION = {
  fullName: "denoland/deno",
  defaultBranch: "main",
  protected: true,
  branchProtected: true,
  rules: ["pull_request"],
  checkedAt: "2026-10-02T00:00:00.000Z",
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
  workflowName: "branch-protection",
  status: "succeeded",
  duration: 42,
  jobs: [{
    name: "answer",
    status: "succeeded",
    steps: [
      step("parse"),
      step("inspect", "succeeded", {
        dataArtifacts: [
          {
            dataId: "d-report",
            name: "report-swamp-method-summary",
            version: 1,
            tags: { type: "report" },
          },
          {
            dataId: "d-1",
            name: "protection",
            version: 7,
            tags: {
              type: "resource",
              specName: "protection",
              modelName: "repo-protection",
            },
          },
        ],
      }),
      step("check"),
    ],
  }],
};

const failedRun = (failedStep: string, error: string) => ({
  ...SUCCEEDED_RUN,
  status: "failed",
  jobs: [{
    name: "answer",
    status: "failed",
    steps: ["parse", "inspect", "check"].map((name, i, all) => {
      const at = all.indexOf(failedStep);
      if (i < at) return step(name);
      if (i === at) return step(name, "failed", { error });
      return step(name, "skipped");
    }),
  }],
});

type Call = { type: string; payload: unknown };

function fakeClient(opts: { run?: unknown; runError?: Error } = {}) {
  const calls: Call[] = [];
  let closed = false;
  const client: SwampLike = {
    connect: () => Promise.resolve(),
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
        { data: { content: JSON.stringify(PROTECTION) } } as T,
      );
    },
  };
  return { client, calls, isClosed: () => closed };
}

const deps = (client: SwampLike): ProtectionDeps => ({
  connect: () => Promise.resolve(client),
});

const post = (body: unknown) =>
  new Request("http://x/api/protection", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

Deno.test("400 for a body that is not JSON", async () => {
  const { client } = fakeClient();
  const res = await handleProtection(post("{nope"), deps(client));
  assertEquals(res.status, 400);
});

Deno.test("400 for a missing or non-string url, without calling swamp", async () => {
  for (const body of [{}, { url: "" }, { url: 42 }, ["x"]]) {
    const { client, calls } = fakeClient();
    const res = await handleProtection(post(body), deps(client));
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(calls.length, 0);
  }
});

Deno.test("success runs the workflow and answers true or false with the run trace", async () => {
  const { client, calls, isClosed } = fakeClient();
  const res = await handleProtection(post({ url: URL_IN }), deps(client));
  assertEquals(res.status, 200);
  const json = await res.json();

  assertEquals(calls[0], {
    type: "workflow.run",
    payload: {
      workflowIdOrName: "branch-protection",
      inputs: { url: URL_IN },
      skipAllReports: true,
    },
  });
  assertEquals(calls[1], {
    type: "data.get",
    payload: {
      modelIdOrName: "repo-protection",
      dataName: "protection",
      version: 7,
      includeContent: true,
    },
  });

  assertEquals(json.protected, true);
  assertEquals(json.url, URL_IN);
  assertEquals(json.repo, "denoland/deno");
  assertEquals(json.defaultBranch, "main");
  assertEquals(json.evidence, {
    branchProtected: true,
    rules: ["pull_request"],
  });
  assertEquals(json.checkedAt, PROTECTION.checkedAt);
  assertEquals(json.run.runId, "run-1");
  assertEquals(json.run.workflow, "branch-protection");
  assertEquals(json.run.steps.map((s: { name: string }) => s.name), [
    "parse",
    "inspect",
    "check",
  ]);
  assertEquals(json.run.artifact, {
    model: "repo-protection",
    name: "protection",
    version: 7,
    dataId: "d-1",
  });
  assert(isClosed(), "client should be closed after the request");
});

Deno.test("false is a successful answer, not an error", async () => {
  const { client } = fakeClient();
  client.request = <T>() =>
    Promise.resolve(
      {
        data: {
          content: JSON.stringify({
            ...PROTECTION,
            protected: false,
            branchProtected: false,
            rules: [],
          }),
        },
      } as T,
    );
  const res = await handleProtection(post({ url: URL_IN }), deps(client));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).protected, false);
});

Deno.test("400 when the parse step rejects the link", async () => {
  const { client, calls } = fakeClient({
    run: failedRun("parse", 'not a GitHub repository link: "x"'),
  });
  const res = await handleProtection(post({ url: "x" }), deps(client));
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.failedStep, "parse");
  assertEquals(json.error, 'not a GitHub repository link: "x"');
  assertEquals(calls.length, 1, "no data.get after a failed run");
});

Deno.test("502 with the failing step and its error when GitHub cannot answer", async () => {
  const { client, calls, isClosed } = fakeClient({
    run: failedRun("inspect", "repository a/b not found"),
  });
  const res = await handleProtection(post({ url: URL_IN }), deps(client));
  assertEquals(res.status, 502);
  const json = await res.json();
  assertEquals(json.failedStep, "inspect");
  assertEquals(json.error, "repository a/b not found");
  assertEquals(json.run.runId, "run-1");
  assertEquals(calls.length, 1);
  assert(isClosed());
});

Deno.test("400 when swamp rejects the workflow inputs", async () => {
  const { client } = fakeClient({
    runError: new SwampClientError(
      "input_validation_failed",
      "Input validation failed",
      [{ path: "url", message: "url is required" }],
    ),
  });
  const res = await handleProtection(post({ url: URL_IN }), deps(client));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).details, [{
    path: "url",
    message: "url is required",
  }]);
});

Deno.test("503 when swamp serve is unreachable", async () => {
  const res = await handleProtection(post({ url: URL_IN }), {
    connect: () => Promise.reject(new Error("tcp connect error")),
  });
  assertEquals(res.status, 503);
  assert((await res.json()).error.includes("swamp serve"));
});
