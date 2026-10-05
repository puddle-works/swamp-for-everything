/**
 * Jev router: `POST /v1/systemone`, with the same request and response as Jev.
 *
 * See docs/jev-router.md.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  type Answer,
  type Entry,
  EntrySchema,
  type Question,
  QuestionsSchema,
  type SystemOneRequest,
  type SystemOneResponse,
  TypeSafeApiError,
} from "./jev/client.ts";
import { findCheck } from "./registry.ts";
import type { WorkflowOutcome } from "./swamp.ts";

export interface RouterDeps {
  /** Calls Jev with the caller's API key. */
  jev(request: SystemOneRequest, apiKey: string): Promise<SystemOneResponse>;
  /** Runs a swamp workflow and returns its `result`. */
  runWorkflow(
    workflow: string,
    inputs: Record<string, unknown>,
  ): Promise<WorkflowOutcome>;
  log(message: string): void;
}

const RequestSchema = z.object({
  state: EntrySchema,
  model: z.string(),
  questions: QuestionsSchema,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.replace(/^Bearer\s+/i, "");
}

/**
 * Answer `question` from its swamp check, if it has one and the check works.
 * Returns undefined for anything that should go to Jev instead.
 */
async function answerLocally(
  deps: RouterDeps,
  id: string,
  question: Question,
  state: Entry,
): Promise<Answer | undefined> {
  const check = findCheck(question);
  if (!check) return undefined;
  const inputs = check.inputs(state);
  if (!inputs) {
    deps.log(`${id}: matches ${check.workflow} but state has no inputs → Jev`);
    return undefined;
  }
  const outcome = await deps.runWorkflow(check.workflow, inputs);
  if (!outcome.ok) {
    deps.log(`${id}: ${check.workflow} failed (${outcome.error}) → Jev`);
    return undefined;
  }
  const answer = check.answer(outcome.result);
  if (!answer) {
    deps.log(`${id}: ${check.workflow} result unusable → Jev`);
    return undefined;
  }
  deps.log(`${id}: answered by ${check.workflow}`);
  return answer;
}

export function router(
  deps: RouterDeps,
): (req: Request) => Promise<Response> {
  return async (req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "body is not valid JSON" });
    }
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(422, {
        error: z.prettifyError(parsed.error),
        issues: parsed.error.issues,
      });
    }

    const { state, model, questions } = parsed.data;

    const ids = Object.keys(questions);
    const local = await Promise.all(
      ids.map((id) => answerLocally(deps, id, questions[id], state)),
    );
    const answers: Record<string, Answer> = {};
    const forward: Record<string, Question> = {};
    ids.forEach((id, i) => {
      if (local[i]) answers[id] = local[i];
      else forward[id] = questions[id];
    });

    if (Object.keys(forward).length === 0) {
      return json(200, {
        model,
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }

    let jev: SystemOneResponse;
    try {
      jev = await deps.jev({ state, model, questions: forward }, bearer(req));
    } catch (e) {
      if (e instanceof TypeSafeApiError) return json(e.status, e.body);
      return json(502, { error: (e as Error).message });
    }
    for (const id of Object.keys(forward)) answers[id] = jev.answers[id];

    return json(200, {
      model: jev.model,
      // In the caller's order.
      answers: Object.fromEntries(ids.map((id) => [id, answers[id]])),
      usage: jev.usage,
    });
  };
}
