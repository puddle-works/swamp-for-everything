# Architecture: Spike 1, Decision API

## The boundaries

```
Browser
┌───────────────────────────────────────────────┐
│ web/ (React)                                  │  UI: collects input, renders output.
│ question · context · options → POST /api/decide│  No decision logic.
└───────────────────────┬───────────────────────┘
                        │ HTTP (Vite dev proxy)
┌───────────────────────▼───────────────────────┐
│ api/ (Deno.serve + @swamp-club/swamp-lib)     │  GLUE: HTTP ⇄ serve's WebSocket API.
│ validate → workflow.run → data.get            │  No decision logic.
└───────────────────────┬───────────────────────┘
                        │ WebSocket (swamp serve, :9797)
═════════════════════════╪═════════════════════════  SWAMP BEGINS
┌───────────────────────▼───────────────────────┐
│ workflow "decide"  (decision/workflows/)      │  THE APPLICATION
│                                               │
│  frame    @mesgme/decision.frame     [det.]   │  validate, dedupe options, build prompt
│    │ steps.frame.outputs.prompt               │
│  ask      decision-llm-${{inputs.llm}} [AI]   │  stub or @keeb/anthropic/claude, free text
│    │ steps.ask.outputs.response               │  ── AI ENDS HERE ──
│  resolve  @mesgme/decision.resolve   [det.]   │  extract JSON, schema-validate, map to an
│    │                                          │  option, clamp confidence, fill rejected
│  check    assert (CEL)               [det.]   │  guardrail: decision ∈ options, 0 ≤ c ≤ 1
└───────────────────────┬───────────────────────┘
                        │
             versioned data: decision-resolver/decision vN
```

## Request lifecycle

1. The UI posts `{question, context, options}` to `/api/decide`. Vite proxies it
   to the API on :8787.
2. The API checks the request's shape and returns 400 if it's wrong. It opens a
   WebSocket to swamp serve and calls `workflow.run` for `decide` with
   `skipAllReports: true`. The call returns when the run finishes.
3. Swamp checks the inputs against the workflow's JSON Schema (for example
   `minItems: 2`) and runs the four steps in one job. Each step reads earlier
   step outputs through `steps.<name>.outputs.*`, which are scoped to the run,
   so concurrent runs never see each other's data.
4. `ask` is the only non-deterministic step. Its target model is picked by the
   workflow input `llm`. Both components share one contract,
   `generate(prompt) → result.response`, so the workflow doesn't care which one
   answered.
5. `resolve` turns the free text into the typed `decision` resource and records
   which checks needed repair. `check` is a declarative assert. If either one
   fails, the run fails.
6. The API reads the run view. On failure it returns 502 with the failing step.
   On success it finds the `decision` data artifact in the run, fetches its
   content with `data.get`, and returns it together with the run trace.

## Why the API exists

`swamp serve` has no HTTP route that runs a workflow and returns its output.
Webhooks queue a run and answer before it starts. The whole serve API is
WebSocket. The API in `api/` is the thinnest adapter that closes that gap. See
FINDINGS.md.

## Determinism

Everything except `ask` is deterministic. With the stub component, `ask` is
deterministic too, so the whole pipeline is repeatable. The same input always
gives the same decision, which is what the tests rely on. With Claude, only
`ask` varies, and `resolve` and `check` bound what can come out of it.
