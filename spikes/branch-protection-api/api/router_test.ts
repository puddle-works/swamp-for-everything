import { assertEquals } from "jsr:@std/assert@1";
import type { SystemOneRequest, SystemOneResponse } from "./jev/client.ts";
import { TypeSafeApiError } from "./jev/client.ts";
import { router, type RouterDeps } from "./router.ts";

interface Fake {
  deps: RouterDeps;
  jevCalls: { request: SystemOneRequest; apiKey: string }[];
}

/** Jev fake: answers every noul question with `noul`, unless overridden. */
function fake(opts: {
  jev?: (r: SystemOneRequest) => SystemOneResponse;
} = {}): Fake {
  const jevCalls: Fake["jevCalls"] = [];
  const deps: RouterDeps = {
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
  return { deps, jevCalls };
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
