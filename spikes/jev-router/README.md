# Jev router

THIS IS A SPIKE

The same API as Jev (TypeSafe's System One model), `POST /v1/systemone`, at its
own URL. A Jev caller only changes its base URL to `http://127.0.0.1:8788`.
Design: [docs/jev-router.md](../../docs/jev-router.md).

For each question in a request:

1. **A swamp check exists** (exact match on type and instructions, and its
   inputs are in `state`): answered by the swamp workflow, with certainty. Today
   there is one: `noul` "Is the default branch of this repository protected?",
   answered by the `branch-protection` workflow for the one GitHub repo URL in
   `state`. If the check can't run or fails, the question goes to Jev.
2. **Otherwise** it goes to Jev, in one call, with the caller's `Authorization`
   header. Jev is also asked whether each question could be answered exactly by
   code. If it says ≥ 0.8, a submitted puddle asking for the check is raised in
   the puddle repo after the reply: once per question, repeats are counted.

This spike has no swamp repo of its own. Its checks run on spike 1's
`swamp serve` ([branch-protection-api](../branch-protection-api/)), which must
be running, with its `github` vault set up.

```bash
deno task test    # unit tests, with Jev and swamp faked
deno task check   # type-check

# terminal 1: spike 1's swamp serve on ws://127.0.0.1:9797
(cd ../branch-protection-api && deno task serve)
# terminal 2: the router on http://127.0.0.1:8788
deno task api

curl -X POST localhost:8788/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -d '{"state":"https://github.com/owner/repo","model":"jev-1.13-free",
       "questions":{"protected":{"type":"noul",
       "instructions":"Is the default branch of this repository protected?"}}}'
```

Raising puddles needs the puddle repo and the router owner's email. Without them
the router still works and just logs that puddles are off:

```bash
PUDDLE_REPO=~/dev/puddle PUDDLE_REQUESTER=you@example.com deno task api
```

Other settings: `JEV_URL` (Jev's base URL, default the OpenCode Zen route),
`SWAMP_URL` and `SWAMP_TOKEN` (spike 1's serve), `PORT` (default 8788).

## API

The full contract is an OpenAPI 3.1 document at
[`api/openapi.json`](api/openapi.json), also served at `GET /openapi.json`.
Anything else is a 404 (405 for the wrong method on a known path).

What went well and badly building it:
[swamp-diary-2026-10-05.md](swamp-diary-2026-10-05.md)
