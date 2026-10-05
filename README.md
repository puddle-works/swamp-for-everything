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

## Swamp as a tool for Claude (#17)

`mods/swamp/` is a Claude Code mod that gives Claude one tool, `run_workflow`,
which runs a swamp workflow and returns its result. Start Claude Code from the
repo root with the mod loaded:

```bash
claude --plugin-dir mods/swamp
```

Then ask, for example, "Is the default branch of
https://github.com/puddle-works/swamp-for-everything protected?". Claude calls
`mcp__swamp__run_workflow` and answers from the workflow's result. It needs the
`github` vault token above.

```bash
claude plugin test mods/swamp       # tests
claude plugin validate mods/swamp   # checks the mod as Claude Code will load it
```

Findings: [docs/claude-mods.md](docs/claude-mods.md).
