# Swamp for Everything

A place to test different ways of using [Swamp](https://swamp.club).

## Spike 1: branch-protection check

A fully deterministic API — no LLM anywhere. It accepts a GitHub repo URL and
returns whether that repo's default branch has branch protection (classic
protection or a repository ruleset). The HTTP layer is thin glue; the answer is
produced by the Swamp model/workflow under `swamp/`.

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

The model reads its GitHub token from the `github` vault
(`vault.get(github, GITHUB_TOKEN)`). Populate it once from your `gh` login:

```bash
gh auth token | (cd swamp && swamp vault put github GITHUB_TOKEN \
  --refresh-from "gh auth token" --refresh-ttl 1h)
```
