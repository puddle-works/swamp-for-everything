import { assertEquals } from "jsr:@std/assert@1";
import type { WorkflowRunView } from "jsr:@swamp-club/swamp-lib@0.20260928.23";
import { type ApiDeps, app, type SwampLike } from "./main.ts";

interface FakeOpts {
  status?: string;
  stepError?: string;
  artifact?: boolean;
  content?: string;
  connectFails?: boolean;
}

function runView(opts: FakeOpts): WorkflowRunView {
  const dataArtifacts = opts.artifact === false ? [] : [{
    name: "result",
    version: 1,
    dataId: "d1",
    tags: { specName: "result", modelName: "branch-protection" },
  }];
  return {
    id: "run-1",
    workflowName: "branch-protection",
    status: opts.status ?? "succeeded",
    duration: 1,
    jobs: [{
      name: "check",
      steps: [{
        name: "check",
        status: opts.status ?? "succeeded",
        duration: 1,
        ...(opts.stepError ? { error: opts.stepError } : {}),
        dataArtifacts,
      }],
    }],
  } as unknown as WorkflowRunView;
}

function fakeClient(
  opts: FakeOpts,
): { client: SwampLike; requested: unknown[] } {
  const requested: unknown[] = [];
  const client: SwampLike = {
    connect: () =>
      opts.connectFails
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve(),
    close: () => {},
    workflowRun: () => Promise.resolve(runView(opts)),
    request: <T>(_type: string, payload?: Record<string, unknown>) => {
      requested.push(payload);
      return Promise.resolve(
        { data: { content: opts.content } } as unknown as T,
      );
    },
  };
  return { client, requested };
}

function deps(opts: FakeOpts): ApiDeps {
  const { client } = fakeClient(opts);
  return {
    connect: () =>
      opts.connectFails
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve(client),
    index: () => Promise.resolve("<html></html>"),
    systemOne: () => Promise.resolve(new Response("unused", { status: 500 })),
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("POST /check returns protected:true for a protected repo", async () => {
  const handler = app(
    deps({ content: '{"repo":"o/r","branch":"main","protected":true}' }),
  );
  const res = await handler(post({ url: "https://github.com/o/r" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    protected: true,
    repo: "o/r",
    branch: "main",
  });
});

Deno.test("POST /check returns protected:false for an unprotected repo", async () => {
  const handler = app(
    deps({ content: '{"repo":"o/r","branch":"main","protected":false}' }),
  );
  const res = await handler(post({ url: "https://github.com/o/r" }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).protected, false);
});

Deno.test("POST /check returns 502 with the step error when the run fails", async () => {
  const handler = app(
    deps({ status: "failed", stepError: "not a github.com URL" }),
  );
  const res = await handler(post({ url: "https://gitlab.com/o/r" }));
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, "not a github.com URL");
  assertEquals(body.failedStep, "check");
});

Deno.test("POST /check returns 502 when the run produced no result artifact", async () => {
  const handler = app(deps({ artifact: false }));
  const res = await handler(post({ url: "https://github.com/o/r" }));
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "run produced no result artifact");
});

Deno.test("POST /check returns 400 when url is missing", async () => {
  const handler = app(deps({}));
  const res = await handler(post({}));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "url is required");
});

Deno.test("POST /check returns 400 on invalid JSON", async () => {
  const handler = app(deps({}));
  const req = new Request("http://localhost/check", {
    method: "POST",
    body: "{",
  });
  const res = await handler(req);
  assertEquals(res.status, 400);
});

Deno.test("POST /check returns 503 when swamp serve is unreachable", async () => {
  const handler = app(deps({ connectFails: true }));
  const res = await handler(post({ url: "https://github.com/o/r" }));
  assertEquals(res.status, 503);
});

Deno.test("GET / serves the test page", async () => {
  const handler = app(deps({}));
  const res = await handler(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("unknown paths 404 and non-POST /check 405", async () => {
  const handler = app(deps({}));
  assertEquals(
    (await handler(new Request("http://localhost/nope"))).status,
    404,
  );
  assertEquals(
    (await handler(new Request("http://localhost/check", { method: "GET" })))
      .status,
    405,
  );
});

Deno.test("GET /openapi.json serves the API spec", async () => {
  const handler = app(deps({}));
  const res = await handler(new Request("http://localhost/openapi.json"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  const spec = await res.json();
  assertEquals(spec.openapi, "3.1.0");
  assertEquals(Object.keys(spec.paths).sort(), [
    "/",
    "/check",
    "/openapi.json",
  ]);
  const ref: string =
    spec.paths["/check"].post.requestBody.content["application/json"].schema
      .$ref;
  const name = ref.replace("#/components/schemas/", "");
  assertEquals(spec.components.schemas[name].required, ["url"]);
  assertEquals(
    Object.keys(spec.paths["/check"].post.responses).sort(),
    ["200", "400", "405", "502", "503"],
  );
});

Deno.test("non-GET /openapi.json is 405", async () => {
  const handler = app(deps({}));
  const res = await handler(
    new Request("http://localhost/openapi.json", { method: "POST" }),
  );
  assertEquals(res.status, 405);
});

Deno.test("POST /v1/systemone goes to the Jev router; other methods 405", async () => {
  const handler = app({
    ...deps({}),
    systemOne: () => Promise.resolve(new Response("routed", { status: 200 })),
  });
  const res = await handler(
    new Request("http://localhost/v1/systemone", { method: "POST" }),
  );
  assertEquals(await res.text(), "routed");
  assertEquals(
    (await handler(new Request("http://localhost/v1/systemone"))).status,
    405,
  );
});
