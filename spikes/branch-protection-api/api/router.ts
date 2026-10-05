/**
 * Jev router: `POST /v1/systemone`, with the same request and response as Jev.
 *
 * See docs/jev-router.md.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";
import {
  EntrySchema,
  QuestionsSchema,
  type SystemOneRequest,
  type SystemOneResponse,
  TypeSafeApiError,
} from "./jev/client.ts";

export interface RouterDeps {
  /** Calls Jev with the caller's API key. */
  jev(request: SystemOneRequest, apiKey: string): Promise<SystemOneResponse>;
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

    try {
      return json(200, await deps.jev(parsed.data, bearer(req)));
    } catch (e) {
      if (e instanceof TypeSafeApiError) return json(e.status, e.body);
      return json(502, { error: (e as Error).message });
    }
  };
}
