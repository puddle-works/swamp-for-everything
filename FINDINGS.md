# Findings: Spike 1, Branch protection

The hypothesis: Swamp can act as the deterministic application/runtime layer
around non-deterministic components. The Swamp workflow is the application, and
the things it calls are components.

This spike tests that with a deliberately small application. Given a link to a
public GitHub repo, a Swamp workflow answers `true` or `false`: is the default
branch protected? The non-deterministic component is **an external HTTP API
(GitHub), not an LLM**. Its output varies over time and it can fail (rate
limits, private repos, network). It is structured JSON, though, so this spike
says nothing about coercing free-text model output. An earlier version of this
spike (PR #9) used an LLM-shaped component; see its FINDINGS.md for that side.

**Verdict for this spike: it holds, with the same structural gap.** Link
parsing, the GitHub calls, the guardrail and the stored answer all live in
Swamp, as a 3-step workflow plus one ~210-line extension. Getting HTTP in and an
answer out still took a ~200-line adapter (`api/`), because Swamp serve has no
synchronous "run a workflow and return its output" HTTP route. No Swamp core
changes were needed. No secrets or vault were needed either.

Everything below was observed in this spike, with swamp `20261002.023954.0` and
`jsr:@swamp-club/swamp-lib@0.20260928.23`, unless marked as read from source or
docs.

## What Swamp already gave us

- **The application as a declarative DAG.** `workflow-branch-protection.yaml` is
  the whole control flow: `parse → inspect → check`. Which step leaves the
  machine is visible in one file.
- **Run-scoped data passing.** `${{ steps.parse.outputs.owner }}` chains step
  outputs within one run. Four concurrent API requests (two protected repos, two
  unprotected, interleaved) all returned the right answer for their own link.
- **Failure that can't be mistaken for an answer.** `inspect` throws before
  writing anything when GitHub can't answer. The run fails at that step, later
  steps are `skipped`, and no `protection` version is written. So "unknown"
  (private repo, rate limit) never gets stored as `false`. Through serve,
  `workflowRun` _resolves_ with `status: "failed"` and the step's error, and the
  API forwards it as 502 with `failedStep`.
- **A declarative guardrail.** An `assert` step with CEL
  (`protected == (branchProtected || size(rules) > 0)`) fails the run if the
  answer ever disagrees with its own evidence.
- **Typed, versioned, queryable results.** The `protection` resource is
  zod-typed. Every run writes a new version
  (`repo-protection/protection v1…vN`), and `swamp data get` reads it back
  without the API. That gives an audit trail of every check for free.
- **A typed client.** `SwampClient.workflowRun()` waits for completion and
  returns the run view with per-step status, duration and data artifact refs.
- **Speed through serve.** Full runs took 523–673 ms through serve, of which
  `inspect` (GitHub) was 0.2–0.65 s; `parse` was 8–19 ms and `check` 3–7 ms. A
  CLI run takes 1.6–1.7 s, and a CLI run that fails at `parse` takes ~1.0 s, so
  ~1 s of every CLI call is startup.
- **A testing kit.** `jsr:@swamp-club/swamp-testing` (`createModelTestContext`)
  let the extension methods be tested without a repo. GitHub is faked by
  stubbing `fetch`; 27 tests run offline.
- **Clone-and-run works with no setup.** A fresh clone of the branch validated
  the workflow (11 checks passed), loaded the local extension, rejected a GitLab
  link at `parse` and answered `false` for `octocat/Hello-World`. No
  `swamp extension install`, vault or token was needed.

## What we observed live

| Input                                    | Result                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `https://github.com/denoland/deno`       | 200, `true` (classic branch protection), run 671 ms                                                               |
| `https://github.com/octocat/Hello-World` | 200, `false`, run 523 ms                                                                                          |
| `https://github.com/facebook/react`      | 200, `true`, repo resolved to `react/react`; protection plus rules `deletion`, `non_fast_forward`, `pull_request` |
| `https://gitlab.com/...`                 | 400, failed at `parse` in 18 ms; no GitHub call                                                                   |
| a private repo                           | 502, failed at `inspect`: "not found (it may be private or not exist)", 214 ms                                    |
| `{}` and `{"url":42}`                    | 400 from the API without calling Swamp                                                                            |
| 4 concurrent requests                    | all correct; run durations 142, 223, 272, 462 ms; 0.52 s wall                                                     |

## Glue we needed

| Glue                                  | Size       | Why                                                                                                                                  |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `api/protection.ts` + `api/main.ts`   | ~200 lines | No HTTP "run and return" route. Speaks serve's WebSocket API: `workflow.run`, then `data.get` for the artifact content.              |
| Finding the result artifact           | ~5 lines   | The run view lists artifact refs only. We pick the one with `tags.specName === "protection"`, then a second request fetches content. |
| `JSON.parse(data.content)`            | 1 line     | `data.get` returns content as a JSON _string_, and the client types it as `unknown`.                                                 |
| `skipAllReports: true`                | 1 flag     | Otherwise every step adds report artifacts to the run view, which we would have to filter out.                                       |
| Mapping a `parse` failure to 400      | 1 line     | A failed run doesn't say whether the caller or the dependency was at fault, so the API hardcodes "`parse` failed ⇒ bad input".       |
| `@mesgme/branch-protection` extension | ~210 lines | `parse` and `inspect`, with the GitHub logic in `_lib/github.ts`. Application code, not glue, but TypeScript, not YAML.              |
| UI step-kind mapping (`present.ts`)   | 1 line     | The run view has no "this step is external" marker, so the UI hardcodes `inspect`.                                                   |

We checked the registry before writing the extension. None of the GitHub
extensions there answer this question: `@goodcraft/github` (sync, ensureRepo,
ensureRelease, openPr) needs a token; `@webframp/github` shells out to the `gh`
CLI and has no protection method; `@dataverket/github` ships no models.

## What Swamp was missing

1. **No synchronous HTTP workflow route.** Serve's HTTP surface is health,
   cancel, auth and webhooks. Webhooks queue a run and reply
   `{"status":"queued"}`, and their `respond` hook runs _before_ the run starts
   (read from `design/primitives/serve.md`). Every HTTP-shaped consumer needs a
   WebSocket adapter like `api/`.
2. **No "workflow output".** A workflow has typed inputs but no declared output.
   The caller has to know which step's which resource is "the answer" and fetch
   it separately.
3. **Input JSON Schema `pattern` is silently ignored.** `type` and `required`
   are enforced ("url must be a string", "url is required"). A
   `pattern: ^https?://(www\.)?github\.com/...` on `url` was accepted by
   `swamp workflow validate`, kept in the stored schema, and not enforced: a
   GitLab link went straight through to the first step. This isn't documented.
   We dropped the pattern and let `parse` do the validation.
4. **No way to tell input errors from dependency errors in a failed run.** Both
   are just "step X failed". The API maps by step name.
5. **No step metadata in run views.** There's nowhere to say "this step calls
   out" that comes back in the run view. We put it in step descriptions
   (`[external]`), which run views don't include.
6. **Untyped data content.** `data.get` returns `content` as a string even for
   zod-typed resources.
7. **Loopback dev auth is deprecated, and still sends telemetry.** Serve warns
   that `--auth-mode none` is deprecated, runs show `initiatedBy: "ghost"`, and
   serve still flushes telemetry to swamp-club in this mode.

## Where we fought the abstraction

- **The answer lives in "data", not in the run.** Conceptually the answer is the
  return value of `isProtected(url)`. In Swamp it's version N of a resource on
  the `repo-protection` model, and concurrent callers keep adding versions. Good
  for audit, awkward for request/response.
- **Model instances as singletons.** `repo-target` and `repo-protection` are
  named model _instances_ whose methods are really functions of their inputs.
  Swamp takes per-model locks to serialise runs on one instance (read from
  source). The four concurrent runs took 142 → 462 ms, rising, which fits
  queueing on those locks. For a stateless lookup, that lock is overhead.
- **The extension loader's conventions.** Every `.ts` under `extensions/models/`
  must export `model`, except files in `_`-prefixed directories and `*_test.ts`
  files. That's how the GitHub logic ended up in `_lib/`.
- **`deno fmt` rewrites Swamp-generated YAML**, so the repo excludes it.

## New operational constraint: the GitHub rate limit

Unauthenticated GitHub allows 60 requests per hour per IP. Each check makes 3
(repo, branch, rules), so about 20 checks an hour. During this spike's
development and testing the budget fell to ~10 remaining. When it runs out,
`inspect` fails with `GitHub API rate limit exceeded; resets at <ISO time>` and
the API returns 502. A token in a Swamp vault (`vault.get(...)`) would raise the
limit to 5,000/hour and let private repos be checked. That is the obvious next
step if this were real, and it would bring back the vault path the LLM version
exercised.

## Emerging reusable primitives

Recorded here for later experiments. None were built in this spike.

1. **Synchronous workflow endpoint.** `POST /workflows/{name}/run` → wait →
   return `{run, output}`. This would replace `api/` entirely.
2. **Declared workflow output.** `output: ${{ steps.inspect.outputs }}` in the
   workflow YAML, returned in the run view.
3. **Enforced input schemas**, including `pattern`, `format` and friends, so the
   boundary check can live in the workflow's YAML rather than a step.
4. **Error classes on step failures** (`input` vs `dependency` vs `internal`),
   carried into the run view, so callers can pick 4xx vs 5xx without hardcoding
   step names.
5. **The "parse → call → check" pattern.** A deterministic sandwich around one
   external call: normalise the input, call the dependency, write a typed result
   with its evidence, and guard it with an assert. It is the same shape as the
   LLM version's "frame → ask → resolve → check", minus the output repair.
6. **Step kind labels** (`kind: external | ai | deterministic`) carried through
   to run views and traces.
7. **Stateless methods.** A way to mark a model method as pure, so runs skip the
   per-model lock.

## The five questions

### 1. What was surprising?

- Swamp quietly accepts and ignores a JSON Schema `pattern` on workflow inputs.
  That was the one place a Swamp feature looked like it did something it didn't.
- How little the workflow cares what the component is. Swapping an LLM for a
  REST API changed the extension and the step names. The workflow shape, the API
  adapter's structure, the trace and the UI pattern all carried over.
- With a real network dependency, Swamp's overhead stops mattering. Through
  serve, Swamp-side steps took tens of milliseconds and GitHub took hundreds.
- The run-fails-and-writes-nothing behaviour is exactly right for a
  true/false/unknown question. It needed no extra design.

### 2. What needed custom glue?

The HTTP ⇄ WebSocket adapter (`api/`, ~200 lines), finding the result artifact
and making a second `data.get` call, parsing stringly-typed content, suppressing
report artifacts, mapping "which step failed" to an HTTP status, and hardcoding
which step is external in the UI. See [Glue we needed](#glue-we-needed). The
GitHub logic itself is a Swamp extension, which is the intended extension point,
not glue.

### 3. Were Swamp core changes needed?

**No.** Everything runs on released Swamp and the published `swamp-lib` client.
We worked around the ignored `pattern` instead of needing it fixed.

### 4. What would make this a first-class Swamp pattern?

In priority order:

1. **A synchronous run route on serve** that waits and returns the run view.
   That alone removes the whole `api/` layer.
2. **Workflow outputs**, returned inline, removing the artifact hunt and the
   second `data.get`.
3. **Enforced input schemas** (or a validation error at `workflow validate` when
   a keyword won't be enforced).
4. **Error classes on step failures**, so the HTTP status follows from the run.
5. **Typed data content**: return `content` as JSON when the resource has a
   schema.
6. **Step labels in run views**, so a UI can show "external here, deterministic
   there" without hardcoding step names.

### 5. Based only on this spike's evidence, can the architecture support the next experiments?

- **Swamp as a REST-backed microservice: yes, with the adapter.** This spike
  _is_ one, and a more realistic one than an all-local pipeline: it depends on a
  live, rate-limited third party and handles its failures correctly. Without a
  sync route, every service carries its own copy of `api/`.
- **Swamp as a compliance/validation service: yes, directly.** "Is this repo's
  default branch protected?" is a compliance check. The pattern (typed evidence,
  an assert over it, a versioned record of every check) generalises to other
  repo or account policies.
- **Swamp as a Claude/agent tool: probably.** A one-input, boolean-output
  workflow is the shape of a tool call, and input errors come back structured.
  Not tested here: tool schemas, auth for an agent caller.
- **Swamp as an agent workflow/orchestration runtime: open.** This spike ran one
  external call in a fixed DAG. It didn't test loops, branching on outputs,
  long-running steps or real concurrency limits. The per-model locking seen here
  is the first thing to measure there.

**Caveat:** this version doesn't exercise an LLM at all. What it tests is the
"deterministic layer around an unreliable dependency" half of the hypothesis,
against a live service. Coercing free-text model output, token cost and
multi-second latency are untested here.
