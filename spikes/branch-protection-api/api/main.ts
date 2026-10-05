/**
 * Branch-protection API: HTTP in, Swamp serve (WebSocket) out.
 *
 *   POST /check  {"url": "https://github.com/owner/repo"} -> {"protected": bool}
 *   POST /v1/systemone  the Jev router: Jev's API, answered by swamp where a
 *                       check exists (see router.ts, docs/jev-router.md)
 *   GET  /              a tiny static test page
 *   GET  /openapi.json  the full request/response contract (api/openapi.json)
 *
 * The API holds no branch-protection logic. It runs the `branch-protection`
 * workflow and reads the typed `result` artifact the run produced.
 *
 *   SWAMP_URL    swamp serve WebSocket URL  (default ws://127.0.0.1:9797)
 *   SWAMP_TOKEN  server token, if serve runs with --auth-mode token
 *   PORT         listen port                (default 8787)
 *   JEV_URL      Jev API root               (default https://opencode.ai/zen)
 *
 * @module
 */
import { SwampClient } from "jsr:@swamp-club/swamp-lib@0.20260928.23";
import { systemOne } from "./jev/client.ts";
import openapi from "./openapi.json" with { type: "json" };
import { router } from "./router.ts";
import { type Connect, runWorkflow } from "./swamp.ts";

export type { SwampLike } from "./swamp.ts";

export interface ApiDeps {
  /** Returns a connected client; rejects if swamp serve is unreachable. */
  connect: Connect;
  /** Loads the static test page served at GET /. */
  index: () => Promise<string>;
  /** Handles POST /v1/systemone (the Jev router). */
  systemOne: (req: Request) => Promise<Response>;
}

const WORKFLOW = "branch-protection";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function handleCheck(req: Request, deps: ApiDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }
  const url = body && typeof body === "object"
    ? (body as { url?: unknown }).url
    : undefined;
  if (typeof url !== "string" || !url.trim()) {
    return json(400, { error: "url is required" });
  }

  const outcome = await runWorkflow(deps.connect, WORKFLOW, { url });
  if (!outcome.ok) {
    const { status, ok: _, ...error } = outcome;
    return json(status, error);
  }
  const result = outcome.result as {
    repo?: string;
    branch?: string;
    protected?: unknown;
  };
  if (typeof result.protected !== "boolean") {
    return json(502, { error: "result artifact had no boolean protected" });
  }
  return json(200, {
    protected: result.protected,
    repo: result.repo,
    branch: result.branch,
  });
}

export function app(deps: ApiDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      return new Response(await deps.index(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/openapi.json") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      return json(200, openapi);
    }
    if (pathname === "/v1/systemone") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      return await deps.systemOne(req);
    }
    if (pathname !== "/check") {
      return new Response("not found", { status: 404 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    return await handleCheck(req, deps);
  };
}

if (import.meta.main) {
  const url = Deno.env.get("SWAMP_URL") ?? "ws://127.0.0.1:9797";
  const token = Deno.env.get("SWAMP_TOKEN");
  const port = Number(Deno.env.get("PORT") ?? 8787);
  const jevUrl = Deno.env.get("JEV_URL") ?? "https://opencode.ai/zen";

  // One connection per request: simple, and survives serve restarts.
  const connect: Connect = async () => {
    const client = new SwampClient(url, token ? { token } : {});
    await client.connect();
    return client;
  };

  const handler = app({
    connect,
    index: () => Deno.readTextFile(new URL("./index.html", import.meta.url)),
    systemOne: router({
      runWorkflow: (workflow, inputs) => runWorkflow(connect, workflow, inputs),
      log: (message) => console.log(`[jev-router] ${message}`),
      jev: (request, apiKey) =>
        systemOne(
          { apiKey, baseUrl: jevUrl, timeoutMs: 30_000, maxRetries: 2 },
          request,
        ),
    }),
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
  console.log(`branch-protection api → swamp serve at ${url}`);
}
