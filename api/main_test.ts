import { assertEquals } from "jsr:@std/assert@1";
import { app } from "./main.ts";

const handler = app({
  connect: () => Promise.reject(new Error("down")),
});

Deno.test("POST /api/protection is routed to the protection handler", async () => {
  const res = await handler(
    new Request("http://x/api/protection", {
      method: "POST",
      body: JSON.stringify({ url: "https://github.com/denoland/deno" }),
    }),
  );
  assertEquals(res.status, 503); // reached handleProtection, swamp is "down"
});

Deno.test("GET /api/protection is 405 and unknown paths are 404", async () => {
  assertEquals(
    (await handler(new Request("http://x/api/protection"))).status,
    405,
  );
  assertEquals((await handler(new Request("http://x/api/decide"))).status, 404);
});
