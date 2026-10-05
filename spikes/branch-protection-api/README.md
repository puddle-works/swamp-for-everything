# Spike 1: branch-protection check

A fully deterministic API — no LLM anywhere (except the Jev router below, which
forwards to Jev what swamp can't answer). It accepts a GitHub repo URL and
returns whether that repo's default branch has branch protection (classic
protection or a repository ruleset). The HTTP layer is thin glue; the answer is
produced by the Swamp model/workflow under `swamp/`.

Run everything from this folder:

```bash
deno task test    # unit tests for the logic and the API
deno task check   # type-check

# terminal 1
deno task serve   # swamp serve on ws://127.0.0.1:9797
# terminal 2
deno task api     # HTTP API on http://127.0.0.1:8787

curl -X POST localhost:8787/check \
  -d '{"url":"https://github.com/owner/repo"}'   # -> {"protected":true,...}
```

Open <http://127.0.0.1:8787/> for a small test page.

## API

The full contract is an OpenAPI 3.1 document at
[`api/openapi.json`](api/openapi.json), also served at `GET /openapi.json`.

### `POST /check`

Request body (JSON; the `Content-Type` header is not enforced):

```json
{ "url": "https://github.com/owner/repo" }
```

`url` must be an http(s) `github.com` repository URL. A trailing `.git` or `/`,
a query string, a fragment and extra path segments (`/tree/main/src`) are
ignored — only `owner/repo` is used. Other hosts (including GitHub Enterprise),
SSH URLs (`git@github.com:owner/repo.git`) and URLs without an `owner/repo` path
are rejected.

Success (200) — always about the repo's **default** branch; `protected` is true
for classic branch protection or a repository ruleset:

```json
{ "protected": true, "repo": "owner/repo", "branch": "main" }
```

Errors return `{"error": "..."}`:

| Status | When                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| 400    | Body isn't JSON, `url` missing or empty, or swamp rejected the workflow inputs                                |
| 405    | Method other than POST                                                                                        |
| 502    | Workflow failed: URL rejected, repo not found, GitHub error, or no token in the vault. Also has `failedStep`. |
| 503    | swamp serve is unreachable                                                                                    |

A rejected URL is a 502, not a 400: the URL is validated inside the swamp model,
not by the HTTP layer. A GitHub error is never reported as `protected: false`.

### `POST /v1/systemone` — the Jev router

Same request and response as Jev (TypeSafe's System One model), so a Jev caller
only changes its base URL to `http://127.0.0.1:8787`. Design:
[docs/jev-router.md](../../docs/jev-router.md).

For each question in a request:

1. **A swamp check exists** (exact match on type and instructions, and its
   inputs are in `state`): answered by the swamp workflow, with certainty. Today
   there is one: `noul` "Is the default branch of this repository protected?",
   answered by `branch-protection` for the one GitHub repo URL in `state`. If
   the check can't run or fails, the question goes to Jev.
2. **Otherwise** it goes to Jev, in one call, with the caller's `Authorization`
   header. Jev is also asked whether each question could be answered exactly by
   code. If it says ≥ 0.8, a submitted puddle asking for the check is raised in
   the puddle repo after the reply: once per question, repeats are counted.

Raising puddles needs the puddle repo and the router owner's email. Without them
the router still works and just logs that puddles are off:

```bash
PUDDLE_REPO=~/dev/puddle PUDDLE_REQUESTER=you@example.com deno task api
```

Jev's base URL defaults to the OpenCode Zen route; set `JEV_URL` to change it.

### Other routes

- `GET /` — the test page
- `GET /openapi.json` — the OpenAPI document
- anything else — 404 (405 for the wrong method on a known path)

The model reads its GitHub token from the `github` vault
(`vault.get(github, GITHUB_TOKEN)`). Populate it once from your `gh` login:

```bash
gh auth token | (cd swamp && swamp vault put github GITHUB_TOKEN \
  --refresh-from "gh auth token" --refresh-ttl 1h)
```
