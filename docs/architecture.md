# Architecture: Spike 1, Branch protection

## The boundaries

```
Browser
┌────────────────────────────────────────────────┐
│ web/ (React)                                   │  UI: collects input, renders output.
│ url → POST /api/protection                     │  No GitHub logic.
└───────────────────────┬────────────────────────┘
                        │ HTTP (Vite dev proxy)
┌───────────────────────▼────────────────────────┐
│ api/ (Deno.serve + @swamp-club/swamp-lib)      │  GLUE: HTTP ⇄ serve's WebSocket API.
│ validate → workflow.run → data.get             │  No GitHub logic.
└───────────────────────┬────────────────────────┘
                        │ WebSocket (swamp serve, :9797)
════════════════════════╪═════════════════════════  SWAMP BEGINS
┌───────────────────────▼────────────────────────┐
│ workflow "branch-protection"                   │  THE APPLICATION
│                        (protection/workflows/) │
│  parse    repo-target.parse        [det.]      │  link → {owner, repo}, or fail
│    │ steps.parse.outputs.owner / .repo         │
│  inspect  repo-protection.inspect  [external]  │  3 GitHub REST calls (no token):
│    │                                           │  repo, branch, rules/branches
│    │ steps.inspect.outputs.*                   │  ── EXTERNAL ENDS HERE ──
│  check    assert (CEL)             [det.]      │  guardrail: protected ⇔ evidence
└───────────────────────┬────────────────────────┘
                        │
            versioned data: repo-protection/protection vN
```

## Request lifecycle

1. The UI posts `{url}` to `/api/protection`. Vite proxies it to the API on
   :8787.
2. The API checks that `url` is a non-empty string and returns 400 if not. It
   opens a WebSocket to swamp serve and calls `workflow.run` for
   `branch-protection` with `skipAllReports: true`. The call returns when the
   run finishes.
3. Swamp checks the inputs against the workflow's JSON Schema (`url` is a
   required string) and runs the three steps in one job. Each step reads earlier
   step outputs through `steps.<name>.outputs.*`, which are scoped to the run,
   so concurrent runs never see each other's data.
4. `parse` accepts only `http(s)://(www.)github.com/<owner>/<repo>[...]` and
   writes a `target` resource. Anything else fails the step. The URL check lives
   here, not in the input schema, because Swamp doesn't enforce JSON Schema
   `pattern` (see FINDINGS.md).
5. `inspect` is the only step that leaves the machine. It asks GitHub for the
   repo (to get the canonical name and default branch), then, in parallel, for
   that branch's `protected` flag and the ruleset rules that apply to it. It
   writes a `protection` resource with the answer and its evidence. If GitHub
   can't answer (404, rate limit, other error) the step throws and nothing is
   written, so an unknown is never stored as `false`.
6. `check` is a declarative assert: `protected` must equal
   `branchProtected || size(rules) > 0`. If the step code ever disagreed with
   its own evidence, the run would fail.
7. The API reads the run view. If `parse` failed it returns 400, any other
   failure 502, both with the failing step. On success it finds the `protection`
   data artifact in the run, fetches its content with `data.get`, and returns it
   together with the run trace.

## Why the API exists

`swamp serve` has no HTTP route that runs a workflow and returns its output.
Webhooks queue a run and answer before it starts. The whole serve API is
WebSocket. The API in `api/` is the thinnest adapter that closes that gap. See
FINDINGS.md.

## Determinism

`parse` and `check` are pure. `inspect` depends on GitHub: the answer changes
when a repo's settings change, and the call can fail (rate limit, network,
private repo). The tests fake `fetch`, so the whole pipeline is repeatable in
CI. The live runs recorded in FINDINGS.md are the only places GitHub was
actually called.
