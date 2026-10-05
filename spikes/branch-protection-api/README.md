# Spike 1: branch-protection check

A fully deterministic API — no LLM anywhere. It accepts a GitHub repo URL and
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
