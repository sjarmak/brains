/**
 * brain CLI — build, check, fork, and list per-project brains.
 *
 *   brain build <name> --scope <glob> [--scope <glob>...] [--model sonnet] [--repo path]
 *   brain check <name> [--repo path]
 *   brain fork  <name> [-p "task"] [--no-rebuild] [--repo path]
 *   brain list  [--repo path]
 */

import { buildBrain } from './build.js'
import { forkBrain } from './fork.js'
import {
  diffScope,
  formatDrift,
  isStale,
  listManifests,
  readManifest,
  writeManifest,
} from './manifest.js'

interface ParsedArgs {
  readonly command: string
  readonly name: string | null
  readonly repo: string
  readonly scope: string[]
  readonly model: string
  readonly prompt: string | undefined
  readonly rebuildOnStale: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const [command, ...rest] = argv
  if (!command) {
    return { error: 'usage: brain <build|check|fork|list> [name] [options]' }
  }

  let name: string | null = null
  let repo = process.cwd()
  const scope: string[] = []
  let model = 'sonnet'
  let prompt: string | undefined
  let rebuildOnStale = true

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? ''
    if (arg === '--scope') {
      scope.push(rest[++i] ?? '')
    } else if (arg === '--model') {
      model = rest[++i] ?? model
    } else if (arg === '--repo') {
      repo = rest[++i] ?? repo
    } else if (arg === '-p' || arg === '--prompt') {
      prompt = rest[++i] ?? ''
    } else if (arg === '--no-rebuild') {
      rebuildOnStale = false
    } else if (!arg.startsWith('-') && name === null) {
      name = arg
    } else {
      return { error: `unknown argument: ${arg}` }
    }
  }

  return { command, name, repo, scope, model, prompt, rebuildOnStale }
}

export function main(argv: readonly string[]): number {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    process.stderr.write(parsed.error + '\n')
    return 2
  }

  const { command, name, repo } = parsed

  if (command === 'list') {
    const manifests = listManifests(repo)
    if (manifests.length === 0) {
      process.stdout.write('no brains in this repo\n')
      return 0
    }
    for (const m of manifests) {
      const stale = isStale(diffScope(m))
      process.stdout.write(
        `${m.name}  scope=[${m.scope.join(', ')}]  built=${m.builtAt}  commit=${m.commit.slice(0, 7) || '-'}  ${stale ? 'STALE' : 'fresh'}\n`
      )
    }
    return 0
  }

  if (!name) {
    process.stderr.write(`brain ${command} requires a name\n`)
    return 2
  }

  if (command === 'build') {
    if (parsed.scope.length === 0) {
      process.stderr.write('brain build requires at least one --scope\n')
      return 2
    }
    process.stderr.write(`building brain "${name}" over [${parsed.scope.join(', ')}]...\n`)
    const result = buildBrain({ repo, name, scope: parsed.scope, model: parsed.model })
    if (!result.ok || !result.manifest) {
      process.stderr.write(`build failed: ${result.error ?? 'unknown'}\n`)
      return 1
    }
    writeManifest(result.manifest)
    process.stdout.write(
      `brain "${name}" built: session ${result.manifest.sessionId}, ` +
        `${Object.keys(result.manifest.fileHashes).length} files pinned, ` +
        `tokens ${result.manifest.buildTokens ?? 'n/a'}\n`
    )
    return 0
  }

  const manifest = readManifest(repo, name)
  if (!manifest) {
    process.stderr.write(`no brain named "${name}" in ${repo}\n`)
    return 1
  }

  if (command === 'check') {
    const drift = diffScope(manifest)
    process.stdout.write(
      isStale(drift) ? `STALE — ${formatDrift(drift)}\n` : 'fresh — scope matches build-time hashes\n'
    )
    return isStale(drift) ? 1 : 0
  }

  if (command === 'fork') {
    const result = forkBrain(manifest, {
      prompt: parsed.prompt,
      rebuildOnStale: parsed.rebuildOnStale,
    })
    if (!result.ok) {
      process.stderr.write(`fork failed: ${result.error ?? 'unknown'}\n`)
      return 1
    }
    if (result.output !== undefined) {
      process.stdout.write(result.output)
    }
    return 0
  }

  process.stderr.write(`unknown command: ${command}\n`)
  return 2
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)))
}
