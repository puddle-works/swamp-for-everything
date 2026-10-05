/**
 * Branch-protection API: HTTP in, Swamp serve (WebSocket) out.
 *
 *   POST /check  {"url": "https://github.com/owner/repo"} -> {"protected": bool}
 *   GET  /       a tiny static test page
 *
 * The API holds no branch-protection logic. It runs the `branch-protection`
 * workflow and reads the typed `result` artifact the run produced.
 *
 *   SWAMP_URL    swamp serve WebSocket URL  (default ws://127.0.0.1:9797)
 *   SWAMP_TOKEN  server token, if serve runs with --auth-mode token
 *   PORT         listen port                (default 8787)
 *
 * @module
 */
import {
  SwampClient,
  SwampClientError,
  type WorkflowRunPayload,
  type WorkflowRunView,
} from "jsr:@swamp-club/swamp-lib@0.20260928.23";

/** The subset of SwampClient this handler uses (fakeable in tests). */
export interface SwampLike {
  connect(): Promise<void>;
  close(): void;
  workflowRun(payload: WorkflowRunPayload): Promise<WorkflowRunView>;
  request<T>(type: string, payload?: Record<string, unknown>): Promise<T>;
}

export interface ApiDeps {
  /** Returns a connected client; rejects if swamp serve is unreachable. */
  connect: () => Promise<SwampLike>;
  /** Loads the static test page served at GET /. */
  index: () => Promise<string>;
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

  let client: SwampLike;
  try {
    client = await deps.connect();
  } catch (e) {
    return json(503, {
      error: `cannot reach swamp serve: ${(e as Error).message}`,
    });
  }

  try {
    const run = await client.workflowRun({
      workflowIdOrName: WORKFLOW,
      inputs: { url },
      skipAllReports: true,
    });
    const steps = run.jobs.flatMap((j) => j.steps);

    if (run.status !== "succeeded") {
      const failed = steps.find((s) => s.status === "failed");
      return json(502, {
        error: failed?.error ?? `workflow ${run.status}`,
        ...(failed ? { failedStep: failed.name } : {}),
      });
    }

    const artifact = steps
      .flatMap((s) => s.dataArtifacts ?? [])
      .find((a) => a.tags.specName === "result");
    if (!artifact) {
      return json(502, { error: "run produced no result artifact" });
    }

    const got = await client.request<{ data: { content?: string } }>(
      "data.get",
      {
        modelIdOrName: artifact.tags.modelName,
        dataName: artifact.name,
        version: artifact.version,
        includeContent: true,
      },
    );
    const result = JSON.parse(got.data.content ?? "null") as {
      repo?: string;
      branch?: string;
      protected?: unknown;
    } | null;
    if (!result || typeof result.protected !== "boolean") {
      return json(502, { error: "result artifact had no boolean protected" });
    }

    return json(200, {
      protected: result.protected,
      repo: result.repo,
      branch: result.branch,
    });
  } catch (e) {
    if (e instanceof SwampClientError && e.code === "input_validation_failed") {
      return json(400, { error: e.message, details: e.details });
    }
    return json(502, { error: (e as Error).message });
  } finally {
    client.close();
  }
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

  const handler = app({
    // One connection per request: simple, and survives serve restarts.
    connect: async () => {
      const client = new SwampClient(url, token ? { token } : {});
      await client.connect();
      return client;
    },
    index: () => Deno.readTextFile(new URL("./index.html", import.meta.url)),
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
