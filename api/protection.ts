/**
 * POST /api/protection — the only glue between HTTP and Swamp.
 *
 * Swamp serve has no "run a workflow and return its output" HTTP route, so
 * this adapter speaks its WebSocket API: workflow.run (waits for completion),
 * then data.get for the typed `protection` artifact the run produced.
 * It holds no GitHub logic; all of that lives in the workflow.
 *
 * @module
 */
import {
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

export interface ProtectionDeps {
  /** Returns a connected client; rejects if swamp serve is unreachable. */
  connect: () => Promise<SwampLike>;
}

const WORKFLOW = "branch-protection";
/** A failure here means the caller sent a link we cannot use. */
const INPUT_STEP = "parse";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function parseRequest(body: unknown): { url: string } | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const { url } = body as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim()) {
    return "url is required: a link to a public GitHub repository";
  }
  return { url };
}

function trace(run: WorkflowRunView) {
  const steps = run.jobs.flatMap((j) => j.steps);
  return {
    runId: run.id,
    workflow: run.workflowName,
    status: run.status,
    durationMs: run.duration,
    steps: steps.map((s) => ({
      name: s.name,
      status: s.status,
      durationMs: s.duration,
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

export async function handleProtection(
  req: Request,
  deps: ProtectionDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }
  const parsed = parseRequest(body);
  if (typeof parsed === "string") return json(400, { error: parsed });

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
      inputs: parsed,
      skipAllReports: true,
    });
    const steps = run.jobs.flatMap((j) => j.steps);

    if (run.status !== "succeeded") {
      const failed = steps.find((s) => s.status === "failed");
      return json(failed?.name === INPUT_STEP ? 400 : 502, {
        error: failed?.error ?? `workflow ${run.status}`,
        failedStep: failed?.name,
        run: trace(run),
      });
    }

    const artifact = steps.flatMap((s) => s.dataArtifacts ?? []).find((a) =>
      a.tags.specName === "protection"
    );
    if (!artifact) {
      return json(502, {
        error: "run succeeded but produced no protection artifact",
        run: trace(run),
      });
    }
    const model = artifact.tags.modelName;
    const got = await client.request<{ data: { content?: string } }>(
      "data.get",
      {
        modelIdOrName: model,
        dataName: artifact.name,
        version: artifact.version,
        includeContent: true,
      },
    );
    const result = JSON.parse(got.data.content ?? "null");

    return json(200, {
      url: parsed.url,
      repo: result.fullName,
      defaultBranch: result.defaultBranch,
      protected: result.protected,
      evidence: {
        branchProtected: result.branchProtected,
        rules: result.rules,
      },
      checkedAt: result.checkedAt,
      run: {
        ...trace(run),
        artifact: {
          model,
          name: artifact.name,
          version: artifact.version,
          dataId: artifact.dataId,
        },
      },
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
