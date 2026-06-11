/**
 * Forking a brain: staleness gate first, then `claude --resume
 * <sessionId> --fork-session`.
 *
 * Policy: a stale brain is REGENERATED before forking (the default), never
 * forked as-is. The diff check in manifest.ts is the gate; regeneration
 * re-runs the same build recipe and rewrites the manifest. Callers who
 * would rather fail fast than pay a rebuild pass rebuildOnStale: false.
 */

import { spawnSync } from 'node:child_process'

import type { BrainManifest } from './manifest.js'
import { diffScope, formatDrift, isStale, writeManifest } from './manifest.js'
import { buildBrain } from './build.js'

export interface ForkOptions {
  readonly prompt?: string
  readonly rebuildOnStale?: boolean
  readonly timeoutMs?: number
  /** Print fork/rebuild progress to stderr. */
  readonly log?: (line: string) => void
}

export interface ForkResult {
  readonly ok: boolean
  readonly rebuilt: boolean
  /** Session id actually forked from (post-rebuild when rebuilt). */
  readonly sourceSessionId?: string
  readonly output?: string
  readonly error?: string
}

const DEFAULT_FORK_TIMEOUT_MS = 600_000

/**
 * Ensures the brain is fresh, regenerating it when the scope drifted.
 * Returns the manifest to fork from, or an error.
 */
export function ensureFresh(
  manifest: BrainManifest,
  rebuildOnStale: boolean,
  log: (line: string) => void
): { manifest: BrainManifest; rebuilt: boolean } | { error: string } {
  const drift = diffScope(manifest)
  if (!isStale(drift)) {
    return { manifest, rebuilt: false }
  }

  if (!rebuildOnStale) {
    return {
      error: `brain "${manifest.name}" is stale (${formatDrift(drift)}); rerun build or fork without --no-rebuild`,
    }
  }

  log(`brain "${manifest.name}" is stale (${formatDrift(drift)}); regenerating...`)
  const rebuilt = buildBrain({
    repo: manifest.repo,
    name: manifest.name,
    scope: manifest.scope,
    model: manifest.model,
  })
  if (!rebuilt.ok || !rebuilt.manifest) {
    return { error: `regeneration failed: ${rebuilt.error ?? 'unknown'}` }
  }
  writeManifest(rebuilt.manifest)
  log(`brain "${manifest.name}" regenerated (session ${rebuilt.manifest.sessionId})`)
  return { manifest: rebuilt.manifest, rebuilt: true }
}

/**
 * Forks the brain's session. With a prompt, runs headless and returns the
 * result text; without one, hands the terminal over to an interactive
 * forked session (stdio inherit).
 */
export function forkBrain(manifest: BrainManifest, options: ForkOptions = {}): ForkResult {
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'))

  const fresh = ensureFresh(manifest, options.rebuildOnStale ?? true, log)
  if ('error' in fresh) {
    return { ok: false, rebuilt: false, error: fresh.error }
  }

  const args = ['--resume', fresh.manifest.sessionId, '--fork-session']

  if (options.prompt === undefined) {
    const proc = spawnSync('claude', args, {
      cwd: fresh.manifest.repo,
      stdio: 'inherit',
    })
    return {
      ok: proc.status === 0,
      rebuilt: fresh.rebuilt,
      sourceSessionId: fresh.manifest.sessionId,
      error: proc.status === 0 ? undefined : `claude exited ${proc.status}`,
    }
  }

  const proc = spawnSync('claude', [...args, '-p', options.prompt], {
    cwd: fresh.manifest.repo,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? DEFAULT_FORK_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TOM_SWE_INTERNAL: '1' },
  })

  if (proc.error) {
    return { ok: false, rebuilt: fresh.rebuilt, error: `claude spawn failed: ${proc.error.message}` }
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      rebuilt: fresh.rebuilt,
      sourceSessionId: fresh.manifest.sessionId,
      error: `claude exited ${proc.status}: ${(proc.stderr ?? '').slice(0, 500)}`,
    }
  }

  return {
    ok: true,
    rebuilt: fresh.rebuilt,
    sourceSessionId: fresh.manifest.sessionId,
    output: proc.stdout,
  }
}
