import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(() => 'deadbeef\n'),
}))

import { spawnSync } from 'node:child_process'
import { buildBrain, buildExplorerPrompt } from './build'

const mockSpawnSync = vi.mocked(spawnSync)

let repo: string

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brains-build-test-'))
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1', 'utf-8')
  mockSpawnSync.mockReset()
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

function cliSuccess(sessionId: string): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout: JSON.stringify({
      session_id: sessionId,
      result: 'summary text',
      usage: { input_tokens: 1000, output_tokens: 500 },
    }),
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>
}

describe('buildExplorerPrompt', () => {
  it('names the brain, lists files, and demands first-person economical exploration', () => {
    const prompt = buildExplorerPrompt('core', ['src/'], ['src/a.ts', 'src/b.ts'])
    expect(prompt).toContain('"core"')
    expect(prompt).toContain('- src/a.ts')
    expect(prompt).toContain('- src/b.ts')
    expect(prompt).toContain('WITHOUT re-reading')
    expect(prompt).toContain('File map')
    expect(prompt).not.toContain('codegraph_explore')
  })

  it('adds codegraph-primary guidance when the repo has an index', () => {
    const prompt = buildExplorerPrompt('core', ['src/'], ['src/a.ts'], true)
    expect(prompt).toContain('codegraph_explore')
    expect(prompt).toContain('PRIMARY')
  })
})

describe('buildBrain', () => {
  it('fails when the scope matches nothing', () => {
    const result = buildBrain({ repo, name: 'b', scope: ['nope/'], model: 'sonnet' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('matched no files')
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('invokes claude headlessly with read-only tools and json output', () => {
    mockSpawnSync.mockReturnValue(cliSuccess('sess-42'))

    const result = buildBrain({ repo, name: 'core', scope: ['src/'], model: 'haiku' })
    expect(result.ok).toBe(true)

    const call = mockSpawnSync.mock.calls[0] ?? []
    const cmd = call[0]
    const args = (call[1] ?? []) as string[]
    const opts = (call[2] ?? {}) as { cwd?: string; env?: Record<string, string> }
    expect(cmd).toBe('claude')
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep')
    expect(args).not.toContain('--fork-session')
    expect(opts.cwd).toBe(repo)
    expect(opts.env?.['TOM_SWE_INTERNAL']).toBe('1')
  })

  it('allows codegraph MCP tools when the repo has a .codegraph index', () => {
    fs.mkdirSync(path.join(repo, '.codegraph'))
    mockSpawnSync.mockReturnValue(cliSuccess('sess-cg'))

    const result = buildBrain({ repo, name: 'core', scope: ['src/'], model: 'haiku' })
    expect(result.ok).toBe(true)

    const call = mockSpawnSync.mock.calls[0] ?? []
    const args = (call[1] ?? []) as string[]
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,mcp__codegraph')
    const prompt = args[args.indexOf('-p') + 1] ?? ''
    expect(prompt).toContain('codegraph_explore')
  })

  it('pins manifest provenance: session, hashes, commit, model', () => {
    mockSpawnSync.mockReturnValue(cliSuccess('sess-42'))

    const result = buildBrain({ repo, name: 'core', scope: ['src/'], model: 'haiku' })
    expect(result.ok).toBe(true)
    const m = result.manifest
    expect(m?.sessionId).toBe('sess-42')
    expect(m?.model).toBe('haiku')
    expect(m?.commit).toBe('deadbeef')
    expect(Object.keys(m?.fileHashes ?? {})).toEqual(['src/a.ts'])
    expect(m?.buildTokens).toBe(1500)
  })

  it('reports spawn errors and non-zero exits as typed failures', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'boom',
      pid: 1,
      output: [],
      signal: null,
      error: undefined,
    } as unknown as ReturnType<typeof spawnSync>)

    const result = buildBrain({ repo, name: 'core', scope: ['src/'], model: 'haiku' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exited 1')
  })

  it('rejects unparseable CLI output', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'not json',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>)

    const result = buildBrain({ repo, name: 'core', scope: ['src/'], model: 'haiku' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not JSON')
  })
})
