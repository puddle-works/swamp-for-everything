/**
 * Gives Claude one tool, `run_workflow`, that runs a swamp workflow through
 * the swamp CLI and returns the run's status and the data it produced.
 *
 * The swamp repo is the session's directory, or its `swamp/` folder, whichever
 * holds a `.swamp.yaml`. Outside a swamp repo the tool is not registered.
 */
import type { EngineInterface, Hook, Register } from 'claude-code'

const TOOL = 'run_workflow'
const RUN_TIMEOUT_MS = 10 * 60_000

type Schema = {
  properties?: Record<string, { type?: string; description?: string }>
  required?: string[]
}
type Artifact = { name: string; version: number; tags?: { type?: string; modelName?: string } }
type Step = { name: string; status: string; error?: string; dataArtifacts?: Artifact[] }
type Run = { id: string; workflowName: string; status: string; jobs?: { name: string; steps?: Step[] }[] }

async function findRepo($: EngineInterface, cwd: string): Promise<string | undefined> {
  for (const dir of [cwd, `${cwd}/swamp`]) {
    const found = await $.fs.stat(`${dir}/.swamp.yaml`).catch(() => undefined)
    if (found) return dir
  }
  return undefined
}

// `swamp update` kills swamp commands started while it runs. It runs from a
// SessionStart settings hook, so read-only commands at session start retry
// until it has finished (about 1.5 s). The shell shows a killed command as exit
// 137, but `$.process.run` reports exit code 1, so a kill is a failure with no
// output at all.
const READ_TRIES = 4
const RETRY_DELAY_MS = 1_000

async function swamp(
  $: EngineInterface, repo: string, args: string[], { timeoutMs, retry = true }: { timeoutMs?: number; retry?: boolean } = {},
) {
  let ran = await $.process.run(['swamp', ...args], { cwd: repo, timeoutMs })
  const killed = () => ran.exitCode !== 0 && ran.stdout === '' && ran.stderr === ''
  for (let tries = 1; retry && killed() && tries < READ_TRIES; tries++) {
    await $.clock.sleep(RETRY_DELAY_MS)
    ran = await $.process.run(['swamp', ...args], { cwd: repo, timeoutMs })
  }
  try {
    return JSON.parse(ran.stdout) as unknown
  } catch {
    const output = (ran.stderr || ran.stdout).trim().slice(0, 500)
    throw new Error(`swamp ${args.join(' ')} failed with exit code ${ran.exitCode}: ${output || '(no output)'}`)
  }
}

function describeInputs(schema: Schema | undefined): string {
  const props = Object.entries(schema?.properties ?? {})
  if (props.length === 0) return '  Inputs: none'
  return props
    .map(([name, p]) => {
      const required = schema?.required?.includes(name) ? ', required' : ''
      return `  - ${name} (${p.type ?? 'any'}${required}): ${p.description ?? ''}`.trimEnd()
    })
    .join('\n')
}

async function describeWorkflows($: EngineInterface, repo: string): Promise<string> {
  const found = await swamp($, repo, ['workflow', 'search', '--json']) as {
    results: { name: string; description?: string }[]
  }
  const lines = await Promise.all(found.results.map(async wf => {
    const got = await swamp($, repo, ['workflow', 'get', wf.name, '--json']) as { inputs?: Schema }
    return `- ${wf.name}: ${wf.description ?? ''}\n${describeInputs(got.inputs)}`
  }))
  return lines.join('\n')
}

/**
 * Engine rule: an MCP tool waits behind ToolSearch, so Claude sees only its
 * name, not the description that says when to use it. Keep it in the prompt.
 */
export const keepInPrompt: Hook<'tool.describe'> = async ($, e, next) => ({ ...(await next(e)), isDeferred: false })

export const register: Register = on => {
  let repo: string | undefined

  on('session.start', async ($, e, next) => {
    repo = await findRepo($, e.cwd)
    if (repo !== undefined) {
      await $.tool.register({
        name: TOOL,
        description:
          `Run a swamp workflow in ${repo} and return its status and output data.\n\n` +
          `Use this tool instead of Bash, gh, curl or the swamp CLI whenever a workflow below can ` +
          `answer the question, or part of it. Workflow answers are deterministic and recorded in ` +
          `swamp's run history, so they are the answer the user wants. If the question covers ` +
          `several items a workflow takes one at a time (e.g. every repository in a GitHub ` +
          `organisation), list the items with whatever tool fits, then call it once for each, ` +
          `and answer from the workflow results, not your own checks.\n\n` +
          `Workflows:\n${await describeWorkflows($, repo)}`,
        inputSchema: {
          type: 'object',
          properties: {
            workflow: { type: 'string', description: 'The workflow name' },
            inputs: { type: 'object', description: "The workflow's inputs" },
          },
          required: ['workflow'],
        },
      })
    }
    return next(e)
  })

  on('tool.describe', { tool: 'mcp__swamp__run_workflow' }, keepInPrompt)

  on('tool.call', { tool: 'mcp__swamp__run_workflow' }, async ($, e) => {
    if (repo === undefined) return { deny: 'Not in a swamp repo.' }
    const { workflow, inputs } = e

    let run: Run
    try {
      run = await swamp($, repo, [
        'workflow', 'run', workflow,
        '--input', JSON.stringify(inputs ?? {}),
        '--skip-reports', '--json',
      ], { timeoutMs: RUN_TIMEOUT_MS, retry: false }) as Run
    } catch (err) {
      return { deny: (err as Error).message }
    }

    const steps = (run.jobs ?? []).flatMap(job => (job.steps ?? []).map(step => ({ job: job.name, step })))
    const errors = steps
      .filter(({ step }) => step.error !== undefined)
      .map(({ job, step }) => ({ job, step: step.name, error: step.error }))
    const artifacts = steps.flatMap(({ step }) =>
      (step.dataArtifacts ?? []).filter(a => a.tags?.type === 'resource' && a.tags.modelName)
    )
    const outputs = await Promise.all(artifacts.map(async a => {
      const model = a.tags!.modelName!
      const data = await swamp($, repo!, ['data', 'get', model, a.name, '--version', String(a.version), '--json']) as {
        content: unknown
      }
      return { model, name: a.name, version: a.version, content: data.content }
    }))

    // A plugin tool's result must be text (or content blocks), so send the run as JSON.
    const summary = { workflow: run.workflowName, runId: run.id, status: run.status, outputs, errors }
    return { result: JSON.stringify(summary, null, 2) }
  })
}
