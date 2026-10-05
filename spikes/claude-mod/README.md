# Swamp as a tool for Claude (#17)

`plugin/` is a Claude Code mod that gives Claude one tool, `run_workflow`, which
runs a swamp workflow and returns its result. It uses the swamp repo in
`swamp/`, which has its own copy of the branch-protection model and workflow.

The workflow reads its GitHub token from this folder's `github` vault. Populate
it once from your `gh` login:

```bash
gh auth token | (cd swamp && swamp vault put github GITHUB_TOKEN \
  --refresh-from "gh auth token" --refresh-ttl 1h)
```

Start Claude Code from this folder with the mod loaded:

```bash
claude --plugin-dir plugin
```

Then ask, for example, "Is the default branch of
https://github.com/puddle-works/swamp-for-everything protected?". Claude calls
`mcp__swamp__run_workflow` and answers from the workflow's result.

```bash
deno task plugin:test       # the mod's tests
deno task plugin:validate   # checks the mod as Claude Code will load it
deno task test              # the swamp model's tests
deno task check             # type-check the swamp model
```

- Findings: [claude-mods.md](claude-mods.md)
- What went well and badly:
  [swamp-diary-2026-10-05.md](swamp-diary-2026-10-05.md)
