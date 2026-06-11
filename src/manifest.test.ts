import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  matchesScope,
  resolveScope,
  hashScope,
  diffScope,
  isStale,
  formatDrift,
  readManifest,
  writeManifest,
  listManifests,
} from './manifest'
import type { BrainManifest } from './manifest'

let repo: string

function write(rel: string, content: string): void {
  const full = path.join(repo, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function makeManifest(partial: Partial<BrainManifest> = {}): BrainManifest {
  return {
    v: 1,
    name: 'test-brain',
    repo,
    scope: ['src/'],
    sessionId: 'sess-1',
    model: 'sonnet',
    commit: 'abc123',
    builtAt: '2026-06-10T00:00:00.000Z',
    fileHashes: hashScope(repo, ['src/']),
    buildTokens: 1000,
    ...partial,
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brains-test-'))
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('matchesScope', () => {
  it('matches exact paths', () => {
    expect(matchesScope('src/a.ts', 'src/a.ts')).toBe(true)
    expect(matchesScope('src/b.ts', 'src/a.ts')).toBe(false)
  })

  it('matches directory prefixes', () => {
    expect(matchesScope('src/deep/a.ts', 'src/')).toBe(true)
    expect(matchesScope('other/a.ts', 'src/')).toBe(false)
  })

  it('matches single-star globs within one segment', () => {
    expect(matchesScope('src/a.ts', 'src/*.ts')).toBe(true)
    expect(matchesScope('src/deep/a.ts', 'src/*.ts')).toBe(false)
  })

  it('matches double-star globs across segments', () => {
    expect(matchesScope('src/deep/a.ts', 'src/**')).toBe(true)
    expect(matchesScope('src/deep/a.ts', '**/*.ts')).toBe(true)
  })
})

describe('resolveScope and hashScope', () => {
  it('lists matching files sorted and skips excluded directories', () => {
    write('src/b.ts', 'b')
    write('src/a.ts', 'a')
    write('node_modules/dep/index.js', 'x')
    write('README.md', 'readme')

    expect(resolveScope(repo, ['src/'])).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('hashes content deterministically', () => {
    write('src/a.ts', 'hello')
    const first = hashScope(repo, ['src/'])
    const second = hashScope(repo, ['src/'])
    expect(first).toEqual(second)
    expect(first['src/a.ts']).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('diffScope — the staleness safeguard', () => {
  it('reports no drift when nothing changed', () => {
    write('src/a.ts', 'a')
    const manifest = makeManifest()
    const drift = diffScope(manifest)
    expect(isStale(drift)).toBe(false)
    expect(formatDrift(drift)).toBe('no drift')
  })

  it('detects changed file content', () => {
    write('src/a.ts', 'a')
    const manifest = makeManifest()
    write('src/a.ts', 'a CHANGED')

    const drift = diffScope(manifest)
    expect(isStale(drift)).toBe(true)
    expect(drift.changed).toEqual(['src/a.ts'])
  })

  it('detects files added to the scope after build', () => {
    write('src/a.ts', 'a')
    const manifest = makeManifest()
    write('src/new.ts', 'new')

    const drift = diffScope(manifest)
    expect(drift.added).toEqual(['src/new.ts'])
    expect(isStale(drift)).toBe(true)
  })

  it('detects files removed from the scope after build', () => {
    write('src/a.ts', 'a')
    write('src/gone.ts', 'gone')
    const manifest = makeManifest()
    fs.rmSync(path.join(repo, 'src/gone.ts'))

    const drift = diffScope(manifest)
    expect(drift.removed).toEqual(['src/gone.ts'])
    expect(isStale(drift)).toBe(true)
  })
})

describe('manifest storage', () => {
  it('round-trips a manifest through write and read', () => {
    write('src/a.ts', 'a')
    const manifest = makeManifest()
    writeManifest(manifest)

    const loaded = readManifest(repo, 'test-brain')
    expect(loaded).toEqual(manifest)
  })

  it('returns null for missing or invalid manifests', () => {
    expect(readManifest(repo, 'nope')).toBeNull()

    fs.mkdirSync(path.join(repo, '.claude', 'brains'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'brains', 'bad.json'), '{"v": 99}', 'utf-8')
    expect(readManifest(repo, 'bad')).toBeNull()
  })

  it('lists valid manifests and skips invalid ones', () => {
    write('src/a.ts', 'a')
    writeManifest(makeManifest({ name: 'one' }))
    writeManifest(makeManifest({ name: 'two' }))
    fs.writeFileSync(path.join(repo, '.claude', 'brains', 'bad.json'), 'junk', 'utf-8')

    const names = listManifests(repo).map((m) => m.name).sort()
    expect(names).toEqual(['one', 'two'])
  })
})
