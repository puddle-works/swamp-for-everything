import { assertEquals } from "jsr:@std/assert@1";
import { app } from "./main.ts";

const handler = app({
  systemOne: () => Promise.resolve(new Response("routed", { status: 200 })),
});

Deno.test("POST /v1/systemone goes to the Jev router; other methods 405", async () => {
  const res = await handler(
    new Request("http://localhost/v1/systemone", { method: "POST" }),
  );
  assertEquals(await res.text(), "routed");
  assertEquals(
    (await handler(new Request("http://localhost/v1/systemone"))).status,
    405,
  );
});

Deno.test("GET /openapi.json serves the router's spec", async () => {
  const res = await handler(new Request("http://localhost/openapi.json"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  const spec = await res.json();
  assertEquals(spec.openapi, "3.1.0");
  assertEquals(spec.servers, [{ url: "http://127.0.0.1:8788" }]);
  assertEquals(Object.keys(spec.paths).sort(), [
    "/openapi.json",
    "/v1/systemone",
  ]);
  assertEquals(
    Object.keys(spec.paths["/v1/systemone"].post.responses).sort(),
    ["200", "400", "405", "422", "502", "default"],
  );
  assertEquals(
    (await handler(
      new Request("http://localhost/openapi.json", { method: "POST" }),
    )).status,
    405,
  );
});

Deno.test("other paths 404, including spike 1's /check", async () => {
  for (const path of ["/", "/check", "/nope"]) {
    const res = await handler(
      new Request(`http://localhost${path}`, { method: "POST" }),
    );
    assertEquals(res.status, 404, path);
  }
});
