/**
 * Brain manifests: provenance and the staleness safeguard.
 *
 * A brain is a forkable Claude Code session whose transcript holds a
 * first-person exploration of a scope (a set of files in one repo). The
 * manifest pins exactly what the brain knows: per-file SHA-256 content
 * hashes over the scope at build time. Any drift — changed, added, or
 * removed file — marks the brain stale, and stale brains are regenerated,
 * not forked (a confidently stale memory is worse than a cold start).
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

// --- Schema ---

export const BrainManifestSchema = z.strictObject({
  /** Manifest format version. */
  v: z.literal(1),
  name: z.string().min(1),
  /** Absolute path of the repo the brain was built in (forking requires it). */
  repo: z.string().min(1),
  /** Scope globs, relative to repo root. */
  scope: z.array(z.string().min(1)).min(1),
  /** Claude Code session id of the exploration; forking resumes this. */
  sessionId: z.string().min(1),
  /** Model used for the exploration. */
  model: z.string().min(1),
  /** Git HEAD at build time (empty when not a git repo). */
  commit: z.string(),
  builtAt: z.string(),
  /** repo-relative path -> sha256 of content at build time. */
  fileHashes: z.record(z.string(), z.string()),
  /** Token usage of the build, when the CLI reported it. */
  buildTokens: z.number().nullable(),
})

export type BrainManifest = z.infer<typeof BrainManifestSchema>

// --- Scope resolution and hashing ---

/** Directories never worth a brain's attention. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage'])

function walk(dir: string, repoRoot: string, acc: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), repoRoot, acc)
      }
    } else if (entry.isFile()) {
      acc.push(path.relative(repoRoot, path.join(dir, entry.name)))
    }
  }
}

/**
 * Matches a repo-relative path against a scope glob. Supports the forms a
 * scope manifest realistically needs: exact paths, directory prefixes
 * ("tom/"), and single-star / double-star suffix globs ("tom/*.ts",
 * "src/**"). Deliberately not a full glob engine.
 */
export function matchesScope(relPath: string, glob: string): boolean {
  if (glob.endsWith('/')) {
    return relPath.startsWith(glob)
  }
  if (glob.endsWith('/**')) {
    return relPath.startsWith(glob.slice(0, -2))
  }
  if (glob.includes('*')) {
    const escaped = glob
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')
      )
      .join('.*')
    return new RegExp(`^${escaped}$`).test(relPath)
  }
  return relPath === glob
}

/** Lists repo-relative file paths matching any scope glob, sorted. */
export function resolveScope(repo: string, scope: readonly string[]): string[] {
  const all: string[] = []
  walk(repo, repo, all)
  return all
    .filter((rel) => scope.some((glob) => matchesScope(rel, glob)))
    .sort()
}

/** Hashes every in-scope file: repo-relative path -> sha256. */
export function hashScope(repo: string, scope: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const rel of resolveScope(repo, scope)) {
    const content = fs.readFileSync(path.join(repo, rel))
    hashes[rel] = crypto.createHash('sha256').update(content).digest('hex')
  }
  return hashes
}

// --- Staleness diff ---

export interface ScopeDrift {
  readonly changed: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export function isStale(drift: ScopeDrift): boolean {
  return drift.changed.length > 0 || drift.added.length > 0 || drift.removed.length > 0
}

/**
 * Diffs the manifest's recorded hashes against the scope's current state.
 * This is the staleness safeguard: any difference means the brain's
 * knowledge no longer matches the content it was built from.
 */
export function diffScope(manifest: BrainManifest): ScopeDrift {
  const current = hashScope(manifest.repo, manifest.scope)
  const recorded = manifest.fileHashes

  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []

  for (const [rel, hash] of Object.entries(current)) {
    const old = recorded[rel]
    if (old === undefined) {
      added.push(rel)
    } else if (old !== hash) {
      changed.push(rel)
    }
  }
  for (const rel of Object.keys(recorded)) {
    if (!(rel in current)) {
      removed.push(rel)
    }
  }

  return { changed, added, removed }
}

export function formatDrift(drift: ScopeDrift): string {
  const parts: string[] = []
  if (drift.changed.length > 0) parts.push(`changed: ${drift.changed.join(', ')}`)
  if (drift.added.length > 0) parts.push(`added: ${drift.added.join(', ')}`)
  if (drift.removed.length > 0) parts.push(`removed: ${drift.removed.join(', ')}`)
  return parts.length > 0 ? parts.join('; ') : 'no drift'
}

// --- Storage ---

export function brainsDir(repo: string): string {
  return path.join(repo, '.claude', 'brains')
}

export function manifestPath(repo: string, name: string): string {
  return path.join(brainsDir(repo), `${name}.json`)
}

export function readManifest(repo: string, name: string): BrainManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath(repo, name), 'utf-8')
    const parsed = BrainManifestSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeManifest(manifest: BrainManifest): void {
  const dir = brainsDir(manifest.repo)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    manifestPath(manifest.repo, manifest.name),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  )
}

export function listManifests(repo: string): BrainManifest[] {
  let files: string[]
  try {
    files = fs.readdirSync(brainsDir(repo)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files
    .map((f) => readManifest(repo, f.replace(/\.json$/, '')))
    .filter((m): m is BrainManifest => m !== null)
}
