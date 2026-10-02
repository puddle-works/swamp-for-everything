# Swamp for Everything

Experiments testing one hypothesis:

> Swamp can act as the deterministic application/runtime layer around
> non-deterministic components. The Swamp workflow is the application; external
> services, models and agents are components invoked by it.

**Spike 1: Branch protection** is built here. Give it a link to a public GitHub
repository. A small Swamp workflow answers `true` or `false`: is the default
branch protected?

```json
{
  "url": "https://github.com/denoland/deno",
  "repo": "denoland/deno",
  "defaultBranch": "main",
  "protected": true,
  "evidence": { "branchProtected": true, "rules": [] },
  "checkedAt": "2026-10-02T13:35:04.112Z",
  "run": {
    "runId": "...",
    "workflow": "branch-protection",
    "status": "succeeded",
    "steps": [
      { "name": "parse", "status": "succeeded" },
      { "name": "inspect", "status": "succeeded" },
      { "name": "check", "status": "succeeded" }
    ],
    "artifact": {
      "model": "repo-protection",
      "name": "protection",
      "version": 10
    }
  }
}
```

"Protected" means the default branch has classic branch protection **or** at
least one repository ruleset rule applies to it. `evidence` says which.

Read [FINDINGS.md](FINDINGS.md) for what the spike taught us, and
[docs/architecture.md](docs/architecture.md) for where each boundary sits.

![The UI answering true for denoland/deno, with the Swamp run trace](docs/screenshot.jpg)

## Where things are

| Layer               | Path                                                   | What it is                                                                          |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| UI                  | `web/`                                                 | React + Vite, run by Deno. One input. Only knows `POST /api/protection`.            |
| Glue                | `api/`                                                 | ~200 lines of Deno. HTTP in, Swamp serve WebSocket out. No GitHub logic.            |
| **The application** | `protection/workflows/workflow-branch-protection.yaml` | The Swamp workflow: `parse → inspect → check`.                                      |
| Steps               | `protection/extensions/models/branch_protection/`      | `@mesgme/branch-protection` (`parse`, `inspect`); GitHub logic in `_lib/github.ts`. |
| Model instances     | `protection/models/@mesgme/branch-protection/`         | `repo-target` (runs `parse`) and `repo-protection` (runs `inspect`).                |

## Prerequisites

- [swamp](https://swamp.club) (built against `20261002.023954.0`):
  `swamp --version`
- [Deno](https://deno.com) 2.x: `deno --version`
- Network access to `api.github.com`. No GitHub token is needed.

No Node or npm install is needed. Deno fetches the npm packages for Vite and
React. No Swamp extensions need installing: the only extension is local.

## Run it

```bash
git clone https://github.com/mesgme/swamp-for-everything.git
cd swamp-for-everything
```

Then start three terminals from the repo root:

```bash
deno task serve   # 1. Swamp serve on ws://127.0.0.1:9797       (Swamp begins here)
deno task api     # 2. Protection API on http://127.0.0.1:8787  (glue)
deno task web     # 3. UI on http://127.0.0.1:5180              (UI)
```

Open <http://127.0.0.1:5180>, keep the example (or paste another public repo
link) and press **Check**. The result card shows `true` or `false`, the evidence
and a **Produced by Swamp** trace: the workflow run ID, each step tagged as
"GitHub API" or "deterministic", and the versioned Swamp data artifact that
holds the answer.

Without the UI:

```bash
curl -s -XPOST http://127.0.0.1:8787/api/protection \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/octocat/Hello-World"}'
```

Without the API, straight from Swamp:

```bash
cd protection
swamp workflow run branch-protection --input '{"url":"https://github.com/denoland/deno"}'
swamp data get repo-protection protection --json
```

### Responses

| Status | When                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 200    | The run succeeded. `protected` is `true` or `false`; `false` is an answer, not an error.                                       |
| 400    | The body has no string `url`, or the `parse` step rejected it as not a GitHub repository link.                                 |
| 502    | GitHub couldn't answer: repo not found or private, rate limited, or another API error. `failedStep` and `run.steps` say where. |
| 503    | Swamp serve is not reachable.                                                                                                  |

A private repo gets a 502 ("not found (it may be private or not exist)"), never
`false`: without a token GitHub can't tell us.

### GitHub rate limit

Each check makes three unauthenticated GitHub API calls (repo, branch, rules).
GitHub allows 60 unauthenticated calls per hour per IP, so about 20 checks an
hour. Past that, the `inspect` step fails with
`GitHub API rate limit exceeded; resets at <time>` and the API returns 502.

## Configuration

| Env var       | Used by | Default                                          |
| ------------- | ------- | ------------------------------------------------ |
| `SWAMP_URL`   | api     | `ws://127.0.0.1:9797`                            |
| `SWAMP_TOKEN` | api     | none (serve runs `--auth-mode none` on loopback) |
| `PORT`        | api     | `8787`                                           |

## Development

```bash
deno task test    # extension, API and UI helper unit tests (GitHub is faked)
deno task check   # type-check
deno task lint
deno task fmt
(cd protection && swamp workflow validate branch-protection)
```

`deno fmt` is kept away from the Swamp-managed YAML under `protection/`.
