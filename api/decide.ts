/**
 * POST /api/decide — the only glue between HTTP and Swamp.
 *
 * Swamp serve has no "run a workflow and return its output" HTTP route, so
 * this adapter speaks its WebSocket API: workflow.run (waits for completion),
 * then data.get for the typed `decision` artifact the run produced.
 * It holds no decision logic; all of that lives in the workflow.
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

export interface DecideDeps {
  /** Returns a connected client; rejects if swamp serve is unreachable. */
  connect: () => Promise<SwampLike>;
  defaultLlm: string;
}

const WORKFLOW = "decide";
const LLMS = ["stub", "claude"];

type DecideRequest = {
  question: string;
  context: string;
  options: string[];
  llm: string;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function parseRequest(
  body: unknown,
  defaultLlm: string,
): DecideRequest | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.question !== "string" || !b.question.trim()) {
    return "question is required";
  }
  if (
    !Array.isArray(b.options) ||
    !b.options.every((o) => typeof o === "string") ||
    b.options.filter((o) => o.trim()).length < 2
  ) {
    return "options must be an array of at least two strings";
  }
  if (b.context !== undefined && typeof b.context !== "string") {
    return "context must be a string";
  }
  const llm = b.llm ?? defaultLlm;
  if (typeof llm !== "string" || !LLMS.includes(llm)) {
    return `llm must be one of ${LLMS.join(", ")}`;
  }
  return {
    question: b.question,
    context: (b.context as string | undefined) ?? "",
    options: b.options as string[],
    llm,
  };
}

function trace(run: WorkflowRunView, llm: string) {
  const steps = run.jobs.flatMap((j) => j.steps);
  return {
    runId: run.id,
    workflow: run.workflowName,
    status: run.status,
    durationMs: run.duration,
    llm,
    steps: steps.map((s) => ({
      name: s.name,
      status: s.status,
      durationMs: s.duration,
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

export async function handleDecide(
  req: Request,
  deps: DecideDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }
  const parsed = parseRequest(body, deps.defaultLlm);
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
      return json(502, {
        error: failed?.error ?? `workflow ${run.status}`,
        failedStep: failed?.name,
        run: trace(run, parsed.llm),
      });
    }

    const artifact = steps.flatMap((s) => s.dataArtifacts ?? []).find((a) =>
      a.tags.specName === "decision"
    );
    if (!artifact) {
      return json(502, {
        error: "run succeeded but produced no decision artifact",
        run: trace(run, parsed.llm),
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
    const decision = JSON.parse(got.data.content ?? "null");
    const { llmModel, rawResponse, resolvedAt: _, ...result } = decision;

    return json(200, {
      ...result,
      ai: { model: llmModel, rawResponse },
      run: {
        ...trace(run, parsed.llm),
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
