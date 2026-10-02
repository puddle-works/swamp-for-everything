/**
 * Decision API server: HTTP in, Swamp serve (WebSocket) out.
 *
 *   SWAMP_URL     swamp serve WebSocket URL   (default ws://127.0.0.1:9797)
 *   SWAMP_TOKEN   server token, if serve runs with --auth-mode token
 *   DECISION_LLM  default LLM component: stub | claude (default stub)
 *   PORT          listen port                 (default 8787)
 *
 * @module
 */
import { SwampClient } from "jsr:@swamp-club/swamp-lib@0.20260928.23";
import { type DecideDeps, handleDecide } from "./decide.ts";

export function app(deps: DecideDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname !== "/api/decide") {
      return new Response("not found", { status: 404 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    return await handleDecide(req, deps);
  };
}

if (import.meta.main) {
  const url = Deno.env.get("SWAMP_URL") ?? "ws://127.0.0.1:9797";
  const token = Deno.env.get("SWAMP_TOKEN");
  const port = Number(Deno.env.get("PORT") ?? 8787);

  const handler = app({
    // One connection per request: simple, and survives serve restarts.
    connect: async () => {
      const client = new SwampClient(url, token ? { token } : {});
      await client.connect();
      return client;
    },
    defaultLlm: Deno.env.get("DECISION_LLM") ?? "stub",
  });

  Deno.serve({ hostname: "127.0.0.1", port }, async (req) => {
    const started = performance.now();
    const res = await handler(req);
    console.log(
      `${req.method} ${new URL(req.url).pathname} ${res.status} ${
        Math.round(performance.now() - started)
      }ms`,
    );
    return res;
  });
  console.log(`decision api → swamp serve at ${url}`);
}
