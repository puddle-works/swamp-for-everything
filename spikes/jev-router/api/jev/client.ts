// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

// Copied unchanged from the @swamp/typesafe-ai extension (version
// 2026.09.15.1, models/_lib/client.ts) for the Jev router.

/**
 * Minimal HTTP client for the TypeSafe System One API.
 *
 * Wraps `POST /v1/systemone` and `GET /v1/models` with typed request and
 * response schemas, per-attempt timeouts, and retry with exponential backoff
 * that honours `Retry-After`. Used by the `@swamp/typesafe-ai` model; import it
 * directly when you need the raw API without swamp data output.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";

/** Default API root for TypeSafe. */
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** TypeSafe's flagship System One model. */
export const DEFAULT_MODEL = "jev-latest";

/** Environment variable consulted when no API key is configured. */
export const API_KEY_ENV = "TYPESAFE_API_KEY";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Text, a JSON object, or a JSON array — accepted for state and instructions. */
export const EntrySchema: z.ZodType<Entry> = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

/** Resolved type of {@link EntrySchema}. */
export type Entry = string | Record<string, unknown> | unknown[];

/** A criterion description; `null` leaves the label undescribed. */
export const DescriptionSchema: z.ZodType<Description> = EntrySchema.nullable();

/** Resolved type of {@link DescriptionSchema}. */
export type Description = Entry | null;

/** Optional yes/no descriptions for a Noul question. */
export const NoulCriteriaSchema = z.object({
  true: DescriptionSchema.optional().describe(
    "What a yes (value near 1) means.",
  ),
  false: DescriptionSchema.optional().describe(
    "What a no (value near 0) means.",
  ),
});

/** A yes/no question; the answer is the probability of yes. */
export const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: EntrySchema.describe("The yes/no question to evaluate."),
  criteria: NoulCriteriaSchema.optional(),
});

/** Option labels mapped to descriptions (or null). */
export const ChoiceCriteriaSchema = z.record(z.string(), DescriptionSchema)
  .refine((c) => Object.keys(c).length >= 2, {
    message: "choice criteria must define at least two options",
  });

/** A question that selects one option from a defined set. */
export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: EntrySchema.describe("What the model should decide."),
  criteria: ChoiceCriteriaSchema,
});

/** An ordered list of at least two level descriptions. */
export const ScoreCriteriaSchema = z.array(DescriptionSchema).min(2, {
  message: "score criteria must define at least two ordered levels",
});

/** A question that rates the state along an ordered rubric. */
export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: EntrySchema.describe("What the model should rate."),
  criteria: ScoreCriteriaSchema,
});

/** Any of the three System One question types. */
export const QuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);

/** Resolved type of {@link QuestionSchema}. */
export type Question = z.infer<typeof QuestionSchema>;

/** A non-empty map of question id to question. */
export const QuestionsSchema = z.record(z.string(), QuestionSchema)
  .refine((q) => Object.keys(q).length >= 1, {
    message: "at least one question is required",
  });

/** Resolved type of {@link QuestionsSchema}. */
export type Questions = z.infer<typeof QuestionsSchema>;

/** Body of a `POST /v1/systemone` request. */
export interface SystemOneRequest {
  state: Entry;
  model: string;
  questions: Questions;
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/** Answer to a Noul question. */
export const NoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().describe("Probability of yes, from 0 to 1."),
});

/** Answer to a Choice question. */
export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().describe("The highest-probability option."),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().describe(
    "Certainty derived from the distribution, 0 to 1.",
  ),
});

/** Answer to a Score question. */
export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number().describe(
    "Probability-weighted level; may fall between levels.",
  ),
  legend: z.record(z.string(), DescriptionSchema),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().describe(
    "Certainty derived from the distribution, 0 to 1.",
  ),
});

/** Any of the three answer types. */
export const AnswerSchema = z.discriminatedUnion("type", [
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);

/** Resolved type of {@link AnswerSchema}. */
export type Answer = z.infer<typeof AnswerSchema>;

/** Token usage reported for one request. */
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

/** Resolved type of {@link UsageSchema}. */
export type Usage = z.infer<typeof UsageSchema>;

/** Body of a successful `POST /v1/systemone` response. */
export const SystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: UsageSchema,
});

/** Resolved type of {@link SystemOneResponseSchema}. */
export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

/** Metadata for one model available to the account. */
export const ModelCardSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  release_date: z.string().optional(),
});

/** Resolved type of {@link ModelCardSchema}. */
export type ModelCard = z.infer<typeof ModelCardSchema>;

/** Body of a successful `GET /v1/models` response. */
export const ModelsResponseSchema = z.object({
  models: z.array(ModelCardSchema),
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Structured logger subset used by the client (compatible with LogTape). */
export interface ClientLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
}

/** Connection settings for the TypeSafe API. */
export interface ClientConfig {
  /** Bearer token. Never logged. */
  apiKey: string;
  /** API root without a trailing slash. */
  baseUrl: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Retries after the first attempt for retryable failures. */
  maxRetries: number;
  /** Cancellation signal; aborting stops retries immediately. */
  signal?: AbortSignal;
  /** Optional logger for request summaries. */
  logger?: ClientLogger;
  /** Fetch override, mainly for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Sleep override, mainly for tests. Defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** HTTP status codes that are retried with backoff. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
  529,
]);

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const MAX_RETRY_AFTER_MS = 60_000;
const ERROR_BODY_PREVIEW = 500;

/** Error raised when the TypeSafe API returns a non-2xx response. */
export class TypeSafeApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Parsed (or raw text) response body. */
  readonly body: unknown;

  constructor(operation: string, status: number, body: unknown) {
    super(
      `TypeSafe ${operation} failed with HTTP ${status}: ${previewBody(body)}`,
    );
    this.name = "TypeSafeApiError";
    this.status = status;
    this.body = body;
  }
}

/** Render a response body as a short single-line string for error messages. */
export function previewBody(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(empty body)";
  return flat.length > ERROR_BODY_PREVIEW
    ? `${flat.slice(0, ERROR_BODY_PREVIEW)}…`
    : flat;
}

/**
 * Parse `retry-after-ms` or `Retry-After` into milliseconds.
 * Returns undefined when neither header carries a usable delay.
 */
export function parseRetryAfter(
  headers: Headers,
  now: number = Date.now(),
): number | undefined {
  const rawMs = headers.get("retry-after-ms");
  if (rawMs !== null) {
    const ms = Number(rawMs);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : undefined;
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Delay before the given zero-based retry attempt: a server-provided
 * `Retry-After` when present and reasonable, otherwise capped exponential
 * backoff with up to 25% jitter.
 */
export function retryDelayMs(
  attempt: number,
  headers?: Headers,
  random: () => number = Math.random,
): number {
  if (headers !== undefined) {
    const retryAfter = parseRetryAfter(headers);
    if (retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_MS) {
      return retryAfter;
    }
  }
  const exponential = Math.min(
    BACKOFF_INITIAL_MS * 2 ** attempt,
    BACKOFF_MAX_MS,
  );
  return Math.round(exponential * (1 - random() * 0.25));
}

/** Wait `ms` milliseconds, rejecting with the signal's reason on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read a response body as JSON when possible, otherwise as text. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Whether a thrown fetch error is a network failure or timeout worth retrying. */
function isTransientFetchError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "TimeoutError";
  return err instanceof TypeError;
}

/**
 * Perform one JSON request against the API with retry.
 *
 * Retries on {@link RETRYABLE_STATUSES}, connection failures, and per-attempt
 * timeouts, up to `config.maxRetries` extra attempts. A user abort via
 * `config.signal` is never retried.
 */
export async function requestJson(
  config: ClientConfig,
  method: "GET" | "POST",
  path: string,
  operation: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const doFetch = config.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const wait = config.sleep ?? sleep;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
    "User-Agent": "swamp-typesafe-ai/1",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);

  for (let attempt = 0;; attempt++) {
    const retriesLeft = config.maxRetries - attempt;
    config.signal?.throwIfAborted();

    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = config.signal
      ? AbortSignal.any([config.signal, timeout])
      : timeout;

    const started = Date.now();
    let response: Response;
    try {
      response = await doFetch(url, { method, headers, body: payload, signal });
    } catch (err) {
      if (config.signal?.aborted) throw config.signal.reason;
      if (retriesLeft <= 0 || !isTransientFetchError(err)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `TypeSafe ${operation} failed: could not reach ${url} (${detail})`,
        );
      }
      const delay = retryDelayMs(attempt);
      config.logger?.warning(
        "TypeSafe {operation} attempt {attempt} failed to connect; retrying in {delayMs}ms",
        { operation, attempt: attempt + 1, delayMs: delay },
      );
      await wait(delay, config.signal);
      continue;
    }

    const parsed = await readBody(response);
    config.logger?.debug("TypeSafe {operation} responded {status} in {ms}ms", {
      operation,
      status: response.status,
      ms: Date.now() - started,
    });
    if (response.ok) return parsed;

    if (retriesLeft <= 0 || !RETRYABLE_STATUSES.has(response.status)) {
      throw new TypeSafeApiError(operation, response.status, parsed);
    }
    const delay = retryDelayMs(attempt, response.headers);
    config.logger?.warning(
      "TypeSafe {operation} returned {status}; retrying in {delayMs}ms",
      { operation, status: response.status, delayMs: delay },
    );
    await wait(delay, config.signal);
  }
}

/**
 * Evaluate `state` against `questions` with a System One model.
 *
 * @returns The validated response with one answer per question id.
 * @throws {TypeSafeApiError} On a non-2xx response after retries.
 */
export async function systemOne(
  config: ClientConfig,
  request: SystemOneRequest,
): Promise<SystemOneResponse> {
  const raw = await requestJson(
    config,
    "POST",
    "/v1/systemone",
    "evaluation",
    request,
  );
  const parsed = SystemOneResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `TypeSafe evaluation returned an unexpected response shape: ${parsed.error.message}. Body: ${
        previewBody(raw)
      }`,
    );
  }
  const missing = Object.keys(request.questions).filter((id) =>
    !(id in parsed.data.answers)
  );
  if (missing.length > 0) {
    throw new Error(
      `TypeSafe evaluation response is missing answers for: ${
        missing.join(", ")
      }`,
    );
  }
  return parsed.data;
}

/**
 * List the models available to the account.
 *
 * @throws {TypeSafeApiError} On a non-2xx response after retries.
 */
export async function listModels(config: ClientConfig): Promise<ModelCard[]> {
  const raw = await requestJson(config, "GET", "/v1/models", "model listing");
  const parsed = ModelsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `TypeSafe model listing returned an unexpected response shape: ${parsed.error.message}. Body: ${
        previewBody(raw)
      }`,
    );
  }
  return parsed.data.models;
}
