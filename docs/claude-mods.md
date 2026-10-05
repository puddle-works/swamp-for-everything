# Swamp as a tool for Claude, through Claude Code mods (#17)

## In short

A Claude Code mod can give Claude a typed tool that runs a swamp workflow and
returns the answer. We built one, `mods/swamp/`, with a single tool,
`run_workflow`. Asked "is the default branch of mesgme/swamp-for-everything
protected?", Claude called the tool, swamp ran the branch-protection workflow,
and Claude answered from the workflow's result (`protected: true`) instead of
working it out itself.

The mod reaches swamp through the swamp CLI. Mods have no WebSocket client, so
they can't use `swamp serve`.

**Recommendation: keep the mod and grow it only when a need shows up.** The next
most useful addition is a **gate**: a `tool.call` hook that blocks a command,
such as `git push` or `gh pr create`, until a swamp check passes. That is
something skills and MCP can't do, and it ties in with #20 (validation and
quality service).

---

## 1. What a mod can do

A mod is a Claude Code plugin made of function hooks (`hooks/register.ts`). The
parts that matter for swamp:

| Mod feature                                 | Use for swamp                                        |
| ------------------------------------------- | ---------------------------------------------------- |
| `$.tool.register` + `tool.call` hook        | A tool Claude can call: run a workflow, get the data |
| `tool.call` hook on any tool (deny/rewrite) | Gates: block a push until a swamp check passes       |
| `$.process.run` / `$.process.spawn`         | Run the swamp CLI (`--json` output)                  |
| `$.http.fetch`                              | Call swamp over HTTP, if #18 adds a REST route       |
| Pane, band above the prompt                 | Show swamp state live (runs, failing checks)         |
| Status line, toast                          | "branch-protection: passing", "workflow finished"    |
| Slash commands                              | `/swamp run <workflow>` typed by the person          |
| `session.start`                             | Find the swamp repo, list its workflows              |

It can't open a WebSocket, and it has no Node or DOM. Everything outside goes
through `$`.

## 2. Which way the calls go

- **Claude calls swamp** (built): Claude asks a question, and a workflow answers
  it deterministically. This is the most useful direction, because it is the
  same idea as spike 1 (#15) and the Jev router (#16): use a check when one
  exists, instead of the model's guess.
- **Swamp shows its state in Claude** (not built): a pane or status line showing
  recent runs or failing checks. This would be nice, but nothing needs it yet.
- **Swamp gates Claude** (not built, recommended next): a hook on Claude's own
  tool calls that refuses an action until a swamp check passes.

## 3. CLI or `swamp serve`

The CLI.
`$.process.run(['swamp', 'workflow', 'run', name, '--input', json,
'--json'])`
runs in the repo's `swamp/` folder and returns JSON. A run can take up to 10
minutes (the mod's limit for `$.process.run`).

`swamp serve` speaks WebSocket only, and mods can't open a WebSocket. If #18
adds a REST route to swamp, the mod could use `$.http.fetch` instead, which
would avoid starting a swamp process for each call.

## 4. Compared with swamp skills and MCP

- **Swamp skills** (already installed in `~/.claude/skills/swamp`) teach Claude
  how to use the swamp CLI through Bash. That works, but Claude has to compose
  shell commands and parse the output, and each command needs Bash permission.
  The mod gives a single typed tool, `mcp__swamp__run_workflow`, whose
  description lists the repo's workflows and their inputs. Claude doesn't need
  to discover them first.
- **MCP**: swamp has no MCP server. A mod tool appears to Claude just like an
  MCP tool (`mcp__swamp__…`), with nothing extra to run. An MCP server would be
  the better choice only if other agents, not just Claude Code, need the same
  tool.
- **What only a mod can do**: gates on Claude's tool calls, and panes or status
  lines inside Claude Code.

## 5. What happened when Claude used the tool

The run was `claude -p --plugin-dir mods/swamp` from the repo root, with the
prompt "Is the default branch of https://github.com/mesgme/swamp-for-everything
protected? Use the swamp tool."

1. **First attempt failed.** The tool returned an object, and Claude Code
   rejected it: a plugin tool's result must be text or content blocks. Unit
   tests didn't catch this because the test engine doesn't check a tool's output
   shape. The fix was to return the result as JSON text, with a test for it.
2. **Second attempt worked.** Claude found the tool, called it with
   `{"workflow": "branch-protection", "inputs": {"url": "…"}}`, and got back:

   ```json
   {
     "workflow": "branch-protection",
     "status": "succeeded",
     "outputs": [{
       "model": "branch-protection",
       "name": "result",
       "content": {
         "repo": "mesgme/swamp-for-everything",
         "branch": "main",
         "protected": true
       }
     }],
     "errors": []
   }
   ```

   Claude answered: "Yes, `main` is protected: the swamp `branch-protection`
   workflow returned `protected: true`."

Other notes:

- Without a GitHub token in the `github` vault, the workflow fails. The tool
  returns `status: failed` and the step's error, so Claude can say why.
- `swamp` was found on `PATH` from inside the mod with no extra setup.
- The tool is only registered when the session starts in a swamp repo (the
  folder, or its `swamp/` folder, has a `.swamp.yaml`).
- **Session start can race `swamp update`.** A SessionStart settings hook runs
  `swamp update`, and for about 1.5 s it kills any other swamp command as it
  starts (exit 137, no output), even when swamp is already up to date. The
  mod's `swamp workflow get` sometimes landed in that window, and the tool
  wasn't registered ("session.start hook skipped … failed:"). The mod now
  retries read-only swamp commands killed this way, up to 4 tries 1 s apart.
  It never retries `swamp workflow run`, which could repeat a run.

## 6. How the mod works

`mods/swamp/hooks/register.ts`:

1. On `session.start`, find the swamp repo. If there is one, list its workflows
   (`swamp workflow search --json`, then `swamp workflow get <name> --json` for
   each one's inputs) and register `run_workflow` with that list in its
   description.
2. On a call, run
   `swamp workflow run <name> --input <json> --skip-reports
   --json`. For each
   `resource` the steps wrote, fetch it with `swamp data get`. Return the
   status, the outputs and any step errors as JSON text.

Tests (`mods/swamp/tests/`) fake the swamp CLI. Run them with
`claude plugin test mods/swamp`.
