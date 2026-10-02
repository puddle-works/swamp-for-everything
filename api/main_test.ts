import { assertEquals } from "jsr:@std/assert@1";
import { app } from "./main.ts";

const handler = app({
  connect: () => Promise.reject(new Error("down")),
  defaultLlm: "stub",
});

Deno.test("POST /api/decide is routed to the decide handler", async () => {
  const res = await handler(
    new Request("http://x/api/decide", {
      method: "POST",
      body: JSON.stringify({ question: "Q", options: ["a", "b"] }),
    }),
  );
  assertEquals(res.status, 503); // reached handleDecide, swamp is "down"
});

Deno.test("GET /api/decide is 405 and unknown paths are 404", async () => {
  assertEquals((await handler(new Request("http://x/api/decide"))).status, 405);
  assertEquals((await handler(new Request("http://x/nope"))).status, 404);
});
