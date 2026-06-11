import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(() => 'deadbeef\n'),
}))

import { spawnSync } from 'node:child_process'
import { forkBrain, ensureFresh } from './fork'
import { hashScope, readManifest } from './manifest'
import type { BrainManifest } from './manifest'

const mockSpawnSync = vi.mocked(spawnSync)

let repo: string

function write(rel: string, content: string): void {
  const full = path.join(repo, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function makeManifest(): BrainManifest {
  return {
    v: 1,
    name: 'core',
    repo,
    scope: ['src/'],
    sessionId: 'sess-original',
    model: 'haiku',
    commit: 'abc',
    builtAt: '2026-06-10T00:00:00.000Z',
    fileHashes: hashScope(repo, ['src/']),
    buildTokens: 100,
  }
}

function cliSuccess(sessionId: string, result = 'ok'): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout: JSON.stringify({ session_id: sessionId, result }),
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brains-fork-test-'))
  write('src/a.ts', 'original content')
  mockSpawnSync.mockReset()
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('ensureFresh', () => {
  it('passes a fresh brain through without rebuilding', () => {
    const manifest = makeManifest()
    const result = ensureFresh(manifest, true, () => {})
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.rebuilt).toBe(false)
      expect(result.manifest).toBe(manifest)
    }
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('regenerates a stale brain and persists the new manifest', () => {
    const manifest = makeManifest()
    write('src/a.ts', 'CHANGED content')
    mockSpawnSync.mockReturnValue(cliSuccess('sess-rebuilt'))

    const result = ensureFresh(manifest, true, () => {})
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.rebuilt).toBe(true)
      expect(result.manifest.sessionId).toBe('sess-rebuilt')
      // New manifest pins the NEW content hashes — fresh again by definition.
      const persisted = readManifest(repo, 'core')
      expect(persisted?.sessionId).toBe('sess-rebuilt')
    }
  })

  it('refuses a stale brain when rebuildOnStale is false', () => {
    const manifest = makeManifest()
    write('src/a.ts', 'CHANGED content')

    const result = ensureFresh(manifest, false, () => {})
    expect('error' in result && result.error).toContain('stale')
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })
})

describe('forkBrain (headless)', () => {
  it('forks a fresh brain with --resume and --fork-session', () => {
    mockSpawnSync.mockReturnValue(cliSuccess('sess-fork', 'answer'))
    const result = forkBrain(makeManifest(), { prompt: 'do a task', log: () => {} })

    expect(result.ok).toBe(true)
    expect(result.rebuilt).toBe(false)
    expect(result.sourceSessionId).toBe('sess-original')

    const call = mockSpawnSync.mock.calls[0] ?? []
    const args = (call[1] ?? []) as string[]
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-original')
    expect(args).toContain('--fork-session')
    expect(args[args.indexOf('-p') + 1]).toBe('do a task')
  })

  it('rebuilds first when stale, then forks the new session', () => {
    const manifest = makeManifest()
    write('src/a.ts', 'CHANGED')
    mockSpawnSync
      .mockReturnValueOnce(cliSuccess('sess-rebuilt'))
      .mockReturnValueOnce(cliSuccess('fork-result', 'answer'))

    const result = forkBrain(manifest, { prompt: 'task', log: () => {} })
    expect(result.ok).toBe(true)
    expect(result.rebuilt).toBe(true)
    expect(result.sourceSessionId).toBe('sess-rebuilt')

    // Second spawn is the fork, resuming the rebuilt session.
    const forkCall = mockSpawnSync.mock.calls[1] ?? []
    const args = (forkCall[1] ?? []) as string[]
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-rebuilt')
  })

  it('propagates fork failures as typed errors', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'resume failed',
      pid: 1,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>)

    const result = forkBrain(makeManifest(), { prompt: 'task', log: () => {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exited 1')
  })
})
