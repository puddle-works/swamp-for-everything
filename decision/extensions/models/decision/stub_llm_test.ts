import { assert, assertEquals } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0";
import { model } from "./stub_llm.ts";
import { frameDecision } from "./_lib/logic.ts";

Deno.test("stub-llm mirrors the @keeb/anthropic/claude contract", () => {
  assertEquals(model.type, "@mesgme/stub-llm");
  assertEquals(Object.keys(model.methods), ["generate"]);
  assertEquals(Object.keys(model.resources), ["result"]);
});

Deno.test("generate writes result {response, model, timestamp}", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "generate",
    globalArgs: { model: "stub-heuristic-v1" },
  });
  const { prompt } = frameDecision({
    question: "Tea or coffee?",
    context: "Coffee keeps me awake.",
    options: ["Tea", "Coffee"],
  });
  await model.methods.generate.execute({ prompt }, context);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "result");
  assertEquals(written.name, "result");
  assertEquals(written.data.model, "stub-heuristic-v1");
  assert(String(written.data.response).includes('"decision": "Coffee"'));
  assert(!Number.isNaN(Date.parse(String(written.data.timestamp))));
});
