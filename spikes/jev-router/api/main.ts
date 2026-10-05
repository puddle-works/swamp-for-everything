/**
 * Jev router: Jev's API, answered by swamp where a check exists.
 *
 *   POST /v1/systemone  same request and response as Jev (see router.ts,
 *                       docs/jev-router.md)
 *   GET  /openapi.json  the request/response contract (api/openapi.json)
 *
 * Checks run as workflows on spike 1's swamp serve (spikes/branch-protection-api).
 *
 *   SWAMP_URL    swamp serve WebSocket URL  (default ws://127.0.0.1:9797)
 *   SWAMP_TOKEN  server token, if serve runs with --auth-mode token
 *   PORT         listen port                (default 8788)
 *   JEV_URL      Jev API root               (default https://opencode.ai/zen)
 *   PUDDLE_REPO       the puddle swamp repo (e.g. ~/dev/puddle); with
 *   PUDDLE_REQUESTER  the router owner's email, turns on raising puddles
 *
 * @module
 */
import { SwampClient } from "jsr:@swamp-club/swamp-lib@0.20260928.23";
import { systemOne } from "./jev/client.ts";
import openapi from "./openapi.json" with { type: "json" };
import { PuddleRaiser, retryOn137, swampCli } from "./puddles.ts";
import { router } from "./router.ts";
import { type Connect, runWorkflow } from "./swamp.ts";

export interface AppDeps {
  /** Handles POST /v1/systemone (the Jev router). */
  systemOne: (req: Request) => Promise<Response>;
}

/** Puddle global arguments beyond title/requester, as on existing puddles. */
const PUDDLE_GLOBAL_ARGS = {
  internalEmailDomains: "mesg.solutions,ravegraph.io",
  notifyUrl: "http://localhost:3000/api/v1/swamp_events",
  notifyToken: '${{ vault.get("puddle", "RAILS_INGEST_TOKEN") }}',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function app(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/v1/systemone") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      return await deps.systemOne(req);
    }
    if (pathname === "/openapi.json") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      return json(200, openapi);
    }
    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const url = Deno.env.get("SWAMP_URL") ?? "ws://127.0.0.1:9797";
  const token = Deno.env.get("SWAMP_TOKEN");
  const port = Number(Deno.env.get("PORT") ?? 8788);
  const jevUrl = Deno.env.get("JEV_URL") ?? "https://opencode.ai/zen";

  // One connection per request: simple, and survives serve restarts.
  const connect: Connect = async () => {
    const client = new SwampClient(url, token ? { token } : {});
    await client.connect();
    return client;
  };

  const log = (message: string) => console.log(`[jev-router] ${message}`);
  const puddleRepo = Deno.env.get("PUDDLE_REPO");
  const requester = Deno.env.get("PUDDLE_REQUESTER");
  const puddles = puddleRepo && requester
    ? new PuddleRaiser(
      retryOn137(swampCli(puddleRepo)),
      { requester, globalArgs: PUDDLE_GLOBAL_ARGS },
      log,
    )
    : undefined;

  const handler = app({
    systemOne: router({
      runWorkflow: (workflow, inputs) => runWorkflow(connect, workflow, inputs),
      log,
      later: (task) => setTimeout(task, 0),
      raisePuddle: (candidate) => {
        if (puddles) return puddles.raise(candidate);
        log("puddles off (set PUDDLE_REPO and PUDDLE_REQUESTER)");
        return Promise.resolve();
      },
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
  console.log(`jev router → swamp serve at ${url}, Jev at ${jevUrl}`);
  if (puddles) console.log(`puddles → ${puddleRepo} as ${requester}`);
}
