import type { On, ProcessRunResult, ToolSpec } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const TOOL = 'mcp__swamp__run_workflow'
const REPO = '/work/project/swamp'

const ok = (stdout: unknown, exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout: JSON.stringify(stdout),
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const SEARCH = {
  results: [{ name: 'branch-protection', description: 'Is the default branch protected?' }],
}
const GET = {
  name: 'branch-protection',
  inputs: {
    type: 'object',
    properties: { url: { type: 'string', description: 'GitHub repository URL' } },
    required: ['url'],
  },
}
const RUN_OK = {
  id: 'run-1',
  workflowName: 'branch-protection',
  status: 'succeeded',
  jobs: [{
    name: 'check',
    steps: [{
      name: 'check',
      status: 'succeeded',
      dataArtifacts: [
        { name: 'result', version: 3, tags: { type: 'resource', modelName: 'branch-protection' } },
        { name: 'report-swamp-method-summary', version: 1, tags: { type: 'report', modelName: 'branch-protection' } },
      ],
    }],
  }],
}
const RUN_FAILED = {
  id: 'run-2',
  workflowName: 'branch-protection',
  status: 'failed',
  jobs: [{
    name: 'check',
    steps: [{ name: 'check', status: 'failed', error: 'Secret GITHUB_TOKEN not found' }],
  }],
}
const RESULT = { content: { repo: 'mesgme/swamp-for-everything', branch: 'main', protected: true } }

/** What a swamp process killed as it starts (exit 137, no output) returns. */
const KILLED: ProcessRunResult = { ...ok(''), exitCode: 137, stdout: '' }

/**
 * Fakes the host: a swamp repo at REPO and the swamp CLI answering by argv.
 * The first `killed` swamp commands matching `killedVerb` are killed as they start.
 */
function fakeHost(
  on: On, runs: string[][], run: unknown = RUN_OK, hasRepo = true,
  killed = 0, killedVerb = 'get',
) {
  on('clock.sleep', () => ({ value: undefined }))
  on('fs.stat', ($, e) => {
    if (hasRepo && e.path === `${REPO}/.swamp.yaml`) return { value: { isFile: true } as never }
    return { deny: 'ENOENT' }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    expect(e.init?.cwd).toBe(REPO)
    const [, noun, verb] = e.argv
    if (verb === killedVerb && killed > 0) {
      killed--
      return { value: KILLED }
    }
    if (noun === 'workflow' && verb === 'search') return { value: ok(SEARCH) }
    if (noun === 'workflow' && verb === 'get') return { value: ok(GET) }
    if (noun === 'workflow' && verb === 'run') {
      return { value: ok(run, (run as { status: string }).status === 'succeeded' ? 0 : 1) }
    }
    if (noun === 'data' && verb === 'get') return { value: ok(RESULT) }
    throw new Error(`unexpected argv ${e.argv.join(' ')}`)
  })
  const registered: ToolSpec[] = []
  on('tool.register', ($, e) => {
    registered.push(e)
    return { value: { tool: `mcp__swamp__${e.name}` } }
  })
  return registered
}

const start = { cwd: '/work/project', surface: null, isInteractive: false }

describe('run_workflow', () => {
  test('registers the tool, listing each workflow and its inputs', async ($, on) => {
    const registered = fakeHost(on, [])
    on('session.start', () => ({ cwd: start.cwd }))

    await $.session.start(start)

    expect(registered.length).toBe(1)
    expect(registered[0]?.name).toBe('run_workflow')
    expect(registered[0]?.description).toContain('branch-protection: Is the default branch protected?')
    expect(registered[0]?.description).toContain('url (string, required): GitHub repository URL')
  })

  test('registers nothing outside a swamp repo', async ($, on) => {
    const registered = fakeHost(on, [], RUN_OK, false)
    on('session.start', () => ({ cwd: start.cwd }))

    await $.session.start(start)

    expect(registered.length).toBe(0)
  })

  test('runs the workflow and returns its output data', async ($, on) => {
    const runs: string[][] = []
    fakeHost(on, runs)
    on('session.start', () => ({ cwd: start.cwd }))
    await $.session.start(start)

    const called = await $.tool.call({
      tool: TOOL,
      workflow: 'branch-protection',
      inputs: { url: 'https://github.com/mesgme/swamp-for-everything' },
    } as never)

    expect(runs).toContainEqual([
      'swamp', 'workflow', 'run', 'branch-protection',
      '--input', '{"url":"https://github.com/mesgme/swamp-for-everything"}',
      '--skip-reports', '--json',
    ])
    expect(runs).toContainEqual(['swamp', 'data', 'get', 'branch-protection', 'result', '--version', '3', '--json'])
    // A plugin tool's result must be text (or content blocks), so the run is sent as JSON.
    expect(typeof called.result).toBe('string')
    expect(JSON.parse(called.result as string)).toEqual({
      workflow: 'branch-protection',
      runId: 'run-1',
      status: 'succeeded',
      outputs: [{
        model: 'branch-protection',
        name: 'result',
        version: 3,
        content: { repo: 'mesgme/swamp-for-everything', branch: 'main', protected: true },
      }],
      errors: [],
    })
  })

  test('reports the failing step instead of output when the run fails', async ($, on) => {
    fakeHost(on, [], RUN_FAILED)
    on('session.start', () => ({ cwd: start.cwd }))
    await $.session.start(start)

    const called = await $.tool.call({ tool: TOOL, workflow: 'branch-protection', inputs: {} } as never)

    expect(JSON.parse(called.result as string)).toEqual({
      workflow: 'branch-protection',
      runId: 'run-2',
      status: 'failed',
      outputs: [],
      errors: [{ job: 'check', step: 'check', error: 'Secret GITHUB_TOKEN not found' }],
    })
  })

  // `swamp update` (run by a SessionStart settings hook) kills swamp commands
  // started while it runs, so the mod's own session start can lose the race.
  test('retries a swamp command killed as it starts', async ($, on) => {
    const runs: string[][] = []
    const registered = fakeHost(on, runs, RUN_OK, true, 1)
    on('session.start', () => ({ cwd: start.cwd }))

    await $.session.start(start)

    expect(registered.length).toBe(1)
    expect(runs.filter(argv => argv[2] === 'get').length).toBe(2)
  })

  test('does not retry a killed workflow run, and says how it exited', async ($, on) => {
    const runs: string[][] = []
    fakeHost(on, runs, RUN_OK, true, 1, 'run')
    on('session.start', () => ({ cwd: start.cwd }))
    await $.session.start(start)

    const called = await $.tool.call({ tool: TOOL, workflow: 'branch-protection', inputs: {} } as never)

    expect((called as { deny?: string }).deny).toContain('exit code 137')
    expect(runs.filter(argv => argv[2] === 'run').length).toBe(1)
  })
})
