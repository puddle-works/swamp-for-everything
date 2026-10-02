import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0";
import { model } from "./decision.ts";

const request = {
  question: "Which database?",
  context: "PostgreSQL has joins. PostgreSQL is familiar.",
  options: ["PostgreSQL", "MongoDB"],
};

Deno.test("decision type declares frame and resolve with framed/decision resources", () => {
  assertEquals(model.type, "@mesgme/decision");
  assertEquals(Object.keys(model.methods).sort(), ["frame", "resolve"]);
  assertEquals(Object.keys(model.resources).sort(), ["decision", "framed"]);
});

Deno.test("frame writes a framed resource carrying the prompt", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "frame",
  });
  const result = await model.methods.frame.execute(request, context);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "framed");
  assertEquals(written.data.options, request.options);
  assert(String(written.data.prompt).includes("<decision-request>"));
  assertEquals(result.dataHandles.length, 1);
});

Deno.test("frame throws and writes nothing for an invalid request", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "frame",
  });
  await assertRejects(
    () =>
      model.methods.frame.execute({ ...request, options: ["Only"] }, context),
    Error,
    "two distinct options",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("resolve writes a typed decision resource with provenance", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "resolve",
  });
  const response = JSON.stringify({
    decision: "mongodb",
    reasoning: "r",
    evidence: ["e"],
    confidence: 0.6,
    rejected: [],
  });
  await model.methods.resolve.execute({
    question: request.question,
    options: request.options,
    response,
    llmModel: "stub-heuristic-v1",
  }, context);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "decision");
  assertEquals(written.data.decision, "MongoDB");
  assertEquals(written.data.question, request.question);
  assertEquals(written.data.llmModel, "stub-heuristic-v1");
  assertEquals(written.data.rawResponse, response);
  assertEquals(
    (written.data.rejected as Array<{ option: string }>)[0].option,
    "PostgreSQL",
  );
});

Deno.test("resolve throws and writes nothing when the model picked a non-option", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "resolve",
  });
  await assertRejects(() =>
    model.methods.resolve.execute({
      question: request.question,
      options: request.options,
      response: '{"decision":"SQLite","reasoning":"r","confidence":1}',
      llmModel: "x",
    }, context)
  );
  assertEquals(getWrittenResources().length, 0);
});
