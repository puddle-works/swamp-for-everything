/**
 * Run a swamp workflow over swamp serve and read back its `result` artifact.
 *
 * The same steps as spike 1's `POST /check`, so the router gets the same
 * answer from the same workflow.
 *
 * @module
 */
import {
  SwampClientError,
  type WorkflowRunPayload,
  type WorkflowRunView,
} from "jsr:@swamp-club/swamp-lib@0.20260928.23";

/** The subset of SwampClient this API uses (fakeable in tests). */
export interface SwampLike {
  connect(): Promise<void>;
  close(): void;
  workflowRun(payload: WorkflowRunPayload): Promise<WorkflowRunView>;
  request<T>(type: string, payload?: Record<string, unknown>): Promise<T>;
}

/** Returns a connected client; rejects if swamp serve is unreachable. */
export type Connect = () => Promise<SwampLike>;

export type WorkflowOutcome =
  | { ok: true; result: Record<string, unknown> }
  | {
    ok: false;
    /** 400 bad inputs, 502 run failed, 503 serve unreachable. */
    status: 400 | 502 | 503;
    error: string;
    failedStep?: string;
    details?: unknown;
  };

/** Run `workflow` with `inputs` and return the content of its `result`. */
export async function runWorkflow(
  connect: Connect,
  workflow: string,
  inputs: Record<string, unknown>,
): Promise<WorkflowOutcome> {
  let client: SwampLike;
  try {
    client = await connect();
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: `cannot reach swamp serve: ${(e as Error).message}`,
    };
  }

  try {
    const run = await client.workflowRun({
      workflowIdOrName: workflow,
      inputs,
      skipAllReports: true,
    });
    const steps = run.jobs.flatMap((j) => j.steps);

    if (run.status !== "succeeded") {
      const failed = steps.find((s) => s.status === "failed");
      return {
        ok: false,
        status: 502,
        error: failed?.error ?? `workflow ${run.status}`,
        ...(failed ? { failedStep: failed.name } : {}),
      };
    }

    const artifact = steps
      .flatMap((s) => s.dataArtifacts ?? [])
      .find((a) => a.tags.specName === "result");
    if (!artifact) {
      return {
        ok: false,
        status: 502,
        error: "run produced no result artifact",
      };
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
    const result = JSON.parse(got.data.content ?? "null");
    if (!result || typeof result !== "object") {
      return { ok: false, status: 502, error: "result artifact was empty" };
    }
    return { ok: true, result };
  } catch (e) {
    if (e instanceof SwampClientError && e.code === "input_validation_failed") {
      return { ok: false, status: 400, error: e.message, details: e.details };
    }
    return { ok: false, status: 502, error: (e as Error).message };
  } finally {
    client.close();
  }
}
