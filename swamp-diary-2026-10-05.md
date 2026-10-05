# Giving Claude a swamp tool: what went well and what didn't

We wanted Claude to answer questions such as "is this branch protected?" by
running a swamp workflow, not by working the answer out itself. A Claude Code
mod let us do that with one tool and about 150 lines of TypeScript. Getting it
built was quick. Getting it to work in a real session took three more fixes, and
each problem was invisible to the tests.

## What we built

A Claude Code mod is a plugin made of function hooks. Ours, `mods/swamp/`, does
two things:

1. **When a session starts**, it looks for a swamp repo. If it finds one, it
   lists the repo's workflows and their inputs, and registers a tool called
   `run_workflow` with that list in its description.
2. **When Claude calls the tool**, it runs
   `swamp workflow run <name> --input <json> --json`, fetches the data the run
   wrote, and returns the status, the outputs and any step errors.

So Claude doesn't guess whether a branch is protected. It asks swamp, swamp runs
a deterministic check against GitHub, and Claude reports what came back.

## What went well

**It was small.** The whole mod is one file, `hooks/register.ts`, about 150
lines. There is no server to run and nothing to install. Claude Code loads it
with `claude --plugin-dir mods/swamp`.

**The CLI was enough.** Mods can't open a WebSocket, so `swamp serve` was out.
That turned out not to matter. `swamp` was on `PATH` inside the mod with no
setup, and every command we needed has a `--json` flag. One swamp process per
call is fine for checks that take a second or two.

**It looks like an MCP tool, with no MCP server.** A mod's tool shows up to
Claude as `mcp__swamp__run_workflow`. We got the typed tool Claude would get
from an MCP server, without writing or hosting one.

**The tool describes itself.** Because the mod builds the description from
`swamp workflow search` and `swamp workflow get` at session start, Claude sees
the repo's real workflows and their inputs. Add a workflow, restart the session,
and the tool knows about it.

**Failures explain themselves.** When the GitHub token was missing from the
vault, the tool returned `status: failed` and the step's error. Claude could say
why it had no answer instead of guessing one.

**We never retry a write.** When we added retries (see below), we limited them
to read-only commands. `swamp workflow run` is never retried, so a run can't
happen twice by accident. That was an easy decision to make early, and it kept
the fix from creating a new problem.

**The end result is right.** In the final interactive test we asked "is the main
branch at https://github.com/swamp-club protected?" That's an organisation, not
a repo. Claude listed the six repos with `gh`, called `run_workflow` once for
each, and answered: only `swamp-club/swamp` protects `main`. We checked that
answer against swamp's stored results for those six runs, and it matched.

## What went badly

Four things broke, and none of them showed up in the unit tests. Each one was
found by running the mod for real.

### 1. The tool returned the wrong shape

The first version returned the run summary as an object. The unit tests passed.
The first live run failed: Claude Code requires a plugin tool's result to be
text or content blocks, and it rejected the object.

The test engine doesn't check a tool's output shape, so the tests couldn't have
caught it. The fix was one line, returning `JSON.stringify(summary)`.

**Lesson:** a passing `claude plugin test` doesn't prove the tool works. Do one
live run before calling a mod done.

### 2. Session start raced `swamp update`

Sometimes the tool wasn't there at all. The session log said "session.start hook
skipped … failed:", with nothing after the colon.

The cause was a SessionStart settings hook that runs `swamp update`. While that
runs, for about 1.5 seconds and even when swamp is already up to date, any other
swamp command that starts is killed straight away. The mod's
`swamp workflow get` sometimes started in that window.

The fix was to retry read-only commands up to four times, one second apart. The
first version of that fix didn't work. In a shell, a killed command exits with
137, so we retried on 137. But `$.process.run` reports the same kill as exit
code 1, so the retry never fired. The working version treats "failed with no
output at all" as a kill.

Reproducing it was its own problem. `claude -p` never hit the race, so it looked
fixed when it wasn't. We had to drive a real interactive session under a
pseudo-terminal, read for about 20 seconds, and look for "hook skipped".

**Lessons:** check the exit code you actually get, not the one a shell shows
you. And test session-start code in an interactive session, because `-p` mode
starts up differently.

### 3. Claude ignored the tool

With the tool loading reliably, we asked the organisation-wide question and
Claude answered it with `gh` every time. It never called `run_workflow`.

We rewrote the tool's description to say "use this instead of Bash, `gh` or
`curl`". That changed nothing. The reason: a mod's tool counts as an MCP tool,
and MCP tools are deferred behind ToolSearch. Claude saw only the name
`mcp__swamp__run_workflow`, never the description. We had been improving text
nobody read.

The fix was a `tool.describe` hook that marks the tool as not deferred, so its
full description sits in the prompt. With that, plus the stronger wording,
Claude listed the repos with `gh` once and then called the tool once per repo.

**Lesson:** before tuning what the model reads, check that it reads it at all.

### 4. "tsc: clean" was luck

The pull request said `tsc -p mods/swamp` was clean. Three days later it failed
with TS2322 on the tool's own name.

Nothing in the mod had changed. Claude Code writes type files for the mod,
including one that declares the tools of whichever MCP servers are connected
when the mod is saved. While that file declares none, any `mcp__*` name
type-checks. Once a server was connected (Claude Docs, in this case), the mod's
own tool name no longer did. The fix was to declare the tool's inputs in the mod
itself, which also gave the handler typed arguments and let us drop a cast.

**Lesson:** a type check that depends on generated files can pass or fail
depending on the machine it runs on. Declare what your code relies on.

### Smaller snags

- **Each git worktree has its own swamp vault.** A new worktree needs the GitHub
  token stored again, or the workflow fails with "Secret 'GITHUB_TOKEN' not
  found". Claude couldn't write to the vault in auto mode, so a person had to.
- **`--allowedTools` swallows the prompt.** In
  `claude -p --allowedTools a b "prompt"`, the flag takes a list and eats the
  prompt too. Put the prompt first.

## What we'd do differently

- **Do a live, interactive run on day one.** Every real bug was found that way,
  and none by the unit tests. The unit tests were still useful for locking in
  each fix once we understood it.
- **Check what the model actually receives.** We spent time on a description
  Claude never saw. Counting `tool_use` blocks in
  `--output-format stream-json --verbose`, and checking swamp's run history,
  told us more than reading Claude's answers.
- **Distrust a clean check you didn't break on purpose.** The race and the type
  error both passed at first because of the environment, not the code.

## What's next

The mod does one thing: it lets Claude ask swamp a question. The next useful
step is a **gate**: a hook on Claude's own tool calls that blocks something like
`git push` or `gh pr create` until a swamp check passes. Skills and MCP can't do
that, because neither can stop Claude from running a command. A mod can.
