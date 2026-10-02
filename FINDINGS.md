# Findings: Spike 1, Decision API

The hypothesis: Swamp can act as the deterministic application/runtime layer
around non-deterministic AI components. The Swamp workflow is the application,
and models and agents are components it invokes.

**Verdict for this spike: it holds, with one structural gap.** The decision
logic, the AI call, validation, guardrails, secrets and the stored result all
live in Swamp, as a 4-step workflow plus one small extension. Getting HTTP in
and a result out took a ~230-line adapter (`api/`). Swamp serve has no
synchronous "run a workflow and return its output" HTTP route. No Swamp core
changes were needed.

Everything below was observed in this spike, with swamp `20261002.023954.0` and
`jsr:@swamp-club/swamp-lib@0.20260928.23`, unless marked as read from source or
docs.

## What Swamp already gave us

- **The application as a declarative DAG.** `workflow-decide.yaml` is the whole
  control flow: `frame → ask → resolve → check`. The "[AI]" / "[deterministic]"
  boundary is visible in one file.
- **Run-scoped data passing.** `${{ steps.frame.outputs.prompt }}` chains step
  outputs within one run. Four concurrent API requests (two different questions,
  interleaved) all returned the correct decision for their own input. That means
  we didn't need `data.latest()`, which would race.
- **Swappable AI components with no code.**
  `modelIdOrName:
  decision-llm-${{ inputs.llm }}` resolves the target model
  from a workflow input. The stub and Claude share the contract
  `generate(prompt) →
  result.response`, so switching is a request field.
- **Input validation at the boundary.** The workflow's `inputs` JSON Schema
  (`minItems: 2`, `enum`, `required`) is enforced by Swamp before any step runs.
  Through serve, a violation comes back as `SwampClientError` with code
  `input_validation_failed` and `[{path, message}]` details. The API maps it to
  400 directly.
- **A declarative guardrail.** An `assert` task with a CEL expression
  (`decision in options && 0 ≤ confidence ≤ 1`) fails the run if the
  deterministic layer ever lets a bad answer through.
- **Typed, versioned, queryable results.** The `decision` resource is zod-typed.
  Every run writes a new version (`decision-resolver/decision v1…vN`), and
  `swamp data get` reads it back without the API.
- **Secrets that never touch the repo.**
  `apiKey: ${{ vault.get(decision-secrets,
  ANTHROPIC_API_KEY) }}`. With a
  dummy key, `llm=claude` failed at `ask` with
  `Anthropic API error (401) authentication_error`. That proves the vault →
  model → HTTP path end to end. With no key, the run failed at `ask` with a
  clear "Secret not found".
- **A ready-made AI component.** `@keeb/anthropic/claude` from the registry,
  pinned in a lockfile (`extensions/models/upstream_extensions.json`), restored
  with `swamp extension install`.
- **Failure semantics the API can pass through.** A failed step makes
  `workflowRun` resolve (not throw) with `status: "failed"`, the failing step's
  `error`, and later steps `skipped`. The API forwards that as 502 with
  `failedStep`.
- **A typed client.** `SwampClient.workflowRun()` waits for completion and
  returns the run view with per-step status, duration and data artifact refs.
- **Speed.** A run through serve took 53–131 ms across the requests in this
  spike, against ~1.1 s for a cold `swamp workflow run` CLI invocation. Four
  concurrent requests finished in 180 ms wall time.
- **A testing kit.** `jsr:@swamp-club/swamp-testing` (`createModelTestContext`)
  let the extension methods be tested without a repo.
- **Clone-and-run works.** A fresh clone of the branch, with only
  `swamp extension install`, validated the workflow, loaded all three model
  types, served, and returned a decision through the API.

## Glue we needed

| Glue                                | Size       | Why                                                                                                                                |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `api/decide.ts` + `api/main.ts`     | ~230 lines | No HTTP "run and return" route. Speaks serve's WebSocket API: `workflow.run`, then `data.get` for the artifact content.            |
| Finding the result artifact         | ~5 lines   | The run view lists artifact refs only. We pick the one with `tags.specName === "decision"`, then a second request fetches content. |
| `JSON.parse(data.content)`          | 1 line     | `data.get` returns content as a JSON _string_, and the client types it as `unknown`.                                               |
| `skipAllReports: true`              | 1 flag     | Otherwise every step adds report artifacts to the run view, which we would have to filter out.                                     |
| `@mesgme/decision` extension        | ~390 lines | The deterministic `frame` / `resolve` logic. This is application code, not glue, but it is TypeScript, not YAML.                   |
| `@mesgme/stub-llm`                  | ~60 lines  | A free, deterministic stand-in with the same contract as `@keeb/anthropic/claude`.                                                 |
| UI step-kind mapping (`present.ts`) | 1 set      | The run view has no "this step is AI" marker, so the UI hardcodes `ask`.                                                           |

## What Swamp was missing

1. **No synchronous HTTP workflow route.** Serve's HTTP surface is health,
   cancel, auth and webhooks. Webhooks queue a run and reply
   `{"status":"queued"}`. Their `respond` hook runs _before_ the run starts
   (read from `design/primitives/serve.md`), so it can't return a result. Every
   HTTP-shaped consumer will need a WebSocket adapter like `api/`.
2. **No "workflow output".** A workflow has typed inputs but no declared output.
   The caller has to know which step's which resource is "the answer" and fetch
   it separately.
3. **No step metadata in run views.** There's nowhere to say "this step is
   non-deterministic" or to attach a free-form label that comes back in the run
   view. We put it in step descriptions (`[AI]`), which run views don't include.
4. **Untyped data content.** `data.get` returns `content` as a string even for
   zod-typed resources. The schema exists on the model type but doesn't reach
   the client.
5. **Text-only LLM component.** `@keeb/anthropic/claude` returns text, with no
   structured-output or tool-use mode and no token usage. That's why `resolve`
   has to extract and repair JSON itself, and why the trace can't show cost.
6. **Loopback dev auth is deprecated.** Serve warns that `--auth-mode none` is
   deprecated. Under it, runs show `initiatedBy: "ghost"`. `token`/`oauth`
   require serve to be logged in to swamp-club. So there's no supported
   zero-account way to run a local demo.

## Where we fought the abstraction

- **The application's answer lives in "data", not in the run.** Conceptually, a
  decision is the return value of `decide(...)`. In Swamp it's version N of a
  resource on the `decision-resolver` model, and concurrent callers keep adding
  versions. That's fine for audit, but awkward for request/response.
- **Model instances as singletons.** `decision-framer`, `decision-resolver` and
  `decision-llm-*` are named model _instances_ whose methods are really pure
  functions. Swamp takes per-model locks to serialise runs on one instance (read
  from source). The concurrent requests in this spike were all correct, and
  their run durations rose from 60 to 131 ms, which fits queueing on those
  locks. For a stateless decision step, that lock is overhead with no benefit.
- **The extension loader's conventions.** Every `.ts` under `extensions/models/`
  must export `model`, except files in `_`-prefixed directories and `*_test.ts`
  files. That's how pure logic ended up in `_lib/`. It works, but you find it by
  trial and error.
- **Repo hygiene friction:**
  - `swamp vault create` wrote an absolute `base_dir` into the committed vault
    YAML. We removed it, and Swamp falls back to the repo dir.
  - `swamp extension pull` added a `.claude/` skill directory despite
    `--tool none`.
  - Pulled extensions live in the gitignored `.swamp/`, so a fresh clone needs
    `swamp extension install` before anything works.
  - `deno fmt` rewrites Swamp-generated YAML (quote style), so the repo has to
    exclude it.
  - Serve's default port (9090) collided with another local serve. This repo
    pins 9797.
- **Telemetry under auth `none`.** Serve still flushes telemetry to swamp-club
  in this mode. That's surprising for a "local, unauthenticated" demo.

## Emerging reusable primitives

Recorded here for later experiments. None were built in this spike.

1. **Synchronous workflow endpoint.** `POST /workflows/{name}/run` → wait →
   return `{run, output}`. This would replace `api/` entirely (see question 4).
2. **Declared workflow output.** `output: ${{ steps.resolve.outputs }}` in the
   workflow YAML, returned in the run view.
3. **The LLM component contract.** `generate(prompt) → {response, model}`,
   ideally plus structured output (a JSON Schema in, a validated object out) and
   usage. The stub and Claude already share the minimal version.
4. **The "frame → ask → resolve → check" pattern.** A deterministic sandwich
   around one AI call: prepare the input, call the model, coerce the output into
   a type with recorded repairs (`checks[]`), then guard it with an assert. It
   looks reusable for the validation-service and agent experiments.
5. **Step kind labels.** `kind: ai | deterministic` (or plain free-form labels)
   on a step, carried through to run views and traces.
6. **Stateless methods.** A way to mark a model method as pure, so runs skip the
   per-model lock and don't write versioned data unless asked to.

## The five questions

### 1. What was surprising?

- How little Swamp-side work the switchable AI component took. One expression in
  `modelIdOrName`, and the vault-backed Claude path worked on the first try
  (verified up to the 401 with a dummy key).
- Serve is fast: about 50–130 ms per run against ~1.1 s for the CLI. Most CLI
  time is startup, not the workflow.
- The gap is at the edge, not the core. Workflows, data, vaults and asserts all
  did what the application needed. What was missing was a way to call the
  application over plain HTTP and get its answer back.
- Failed runs _resolve_ with a failed status rather than throwing, while bad
  inputs _throw_. Both shapes are useful, but the client has to handle each.

### 2. What needed custom glue?

The HTTP ⇄ WebSocket adapter (`api/`, ~230 lines), finding the result artifact
and making a second `data.get` call, parsing stringly-typed content, suppressing
report artifacts, and hardcoding which step is AI in the UI. See
[Glue we needed](#glue-we-needed). The decision logic itself is a Swamp
extension, which is the intended extension point, not glue.

### 3. Were Swamp core changes needed?

**No.** Everything runs on released Swamp, registry extensions and the published
`swamp-lib` client. The gaps above were each worked around outside core.

### 4. If this became a common pattern, what should change in Swamp Serve?

In priority order:

1. **A synchronous HTTP run route.** Something like
   `POST
   /api/workflows/{name}/run` with a JSON body of inputs. It would wait
   (with a timeout), use serve's existing auth and grants, and return the run
   view. This alone removes the whole `api/` layer.
2. **Workflow outputs.** Let a workflow declare its output, and return it inline
   in the run view and in that HTTP response. That removes the artifact-hunting
   and the second `data.get`.
3. **Typed data content.** Return `content` as JSON, not a string, when the
   resource has a schema. Publish the schema too, so clients can generate types.
4. **Step labels in run views**, so a UI can show "AI here, deterministic there"
   without hardcoding step names.
5. **A supported, non-deprecated loopback dev mode** that needs no swamp-club
   login and sends no telemetry, for local demos and tests.
6. **Optional streaming of step events over HTTP (SSE)**, for long LLM steps.

### 5. Based only on this spike's evidence, can the architecture support the next experiments?

- **Swamp as a REST-backed microservice: yes, with the adapter.** This spike
  _is_ one. The adapter is small, and its overhead plus a full run stayed under
  ~150 ms. Without the sync route from question 4, every service would carry its
  own copy of `api/`.
- **Swamp as an AI validation/quality service: yes, and most directly.**
  `resolve` + `checks[]` + the `assert` step is already a validation pipeline
  around an untrusted output. Recording repairs as checks gave useful, auditable
  signal.
- **Swamp as a Claude/agent tool: probably.** The WebSocket client and typed
  workflow inputs are what a tool wrapper needs, and input-validation errors
  come back structured. Not tested here: tool schemas, auth for an agent caller.
- **Swamp as an agent workflow/orchestration runtime: open.** This spike ran one
  AI call in a fixed DAG. It didn't test loops, branching on AI output,
  long-running steps, human approval (`manual_approval`, seen in the docs only)
  or real concurrency limits. The per-model locking observed here is the first
  thing to measure there.

**Caveat:** the live AI path was the stub. Claude was verified only up to an
authenticated HTTP call (401 with a dummy key). Non-deterministic output
quality, latency (seconds, not milliseconds) and token cost through this
architecture are still unmeasured.
