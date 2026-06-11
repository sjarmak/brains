/**
 * Brain building: a headless Claude Code exploration whose session becomes
 * the forkable brain.
 *
 * The explorer reads the scope first-person and ends by writing a
 * structured knowledge summary into its own transcript. Forks of that
 * session inherit the reads and the conclusions as the agent's own memory,
 * which is the entire point: a forked agent does not re-derive what it
 * already "did". The explorer is restricted to read-only tools, so a brain
 * build can never mutate the repo.
 */

import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

import type { BrainManifest } from './manifest.js'
import { hashScope, resolveScope } from './manifest.js'

// --- Explorer prompt ---

export function buildExplorerPrompt(
  name: string,
  scope: readonly string[],
  files: readonly string[],
  codegraph: boolean = false
): string {
  const lines = [
    `You are building a reusable knowledge base ("brain") named "${name}" covering this scope: ${scope.join(', ')}.`,
    `Future agents will be forked from this session and must be able to work on this scope WITHOUT re-reading files you already read — your reads and conclusions become their memory.`,
    ``,
    `In-scope files:`,
    ...files.map((f) => `- ${f}`),
    ``,
    `Instructions:`,
    `1. Read the load-bearing files in full. Skip lockfiles, generated artifacts, and anything whose content a summary line covers.`,
    `2. Be economical: do not re-read files, do not run broad searches you don't need. Every wasted read bloats every future fork.`,
    `3. End with a structured knowledge summary under these headings: Purpose; Architecture (components and data flow); Key types and invariants; Conventions; Gotchas; File map (one line per file: what it holds and when to touch it).`,
    `4. State conclusions definitively — this is your own understanding, not a report for someone else.`,
  ]
  if (codegraph) {
    lines.push(
      ``,
      `This project has a CodeGraph index (.codegraph/). Use codegraph_explore as your PRIMARY tool: it returns full source sections from all relevant files in one call, which keeps this transcript lean. Do NOT re-read files codegraph_explore already returned source for; fall back to Read/Grep only for gaps it missed.`
    )
  }
  return lines.join('\n')
}

/** A repo with a CodeGraph index gets the codegraph MCP tools and guidance. */
export function detectCodegraph(repo: string): boolean {
  return fs.existsSync(path.join(repo, '.codegraph'))
}

// --- Headless invocation ---

const CliResultSchema = z.looseObject({
  session_id: z.string(),
  result: z.string().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
})

export interface BuildResult {
  readonly ok: boolean
  readonly manifest?: BrainManifest
  readonly error?: string
}

export interface BuildOptions {
  readonly repo: string
  readonly name: string
  readonly scope: readonly string[]
  readonly model: string
  readonly timeoutMs?: number
}

const DEFAULT_BUILD_TIMEOUT_MS = 600_000

function gitHead(repo: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Runs the explorer headlessly and returns the manifest pinning what it saw.
 * Scope hashes are captured BEFORE the exploration starts, so a file that
 * changes mid-build makes the brain immediately stale rather than silently
 * half-known.
 */
export function buildBrain(options: BuildOptions): BuildResult {
  const files = resolveScope(options.repo, options.scope)
  if (files.length === 0) {
    return { ok: false, error: `scope matched no files in ${options.repo}` }
  }

  const fileHashes = hashScope(options.repo, options.scope)
  const codegraph = detectCodegraph(options.repo)
  const prompt = buildExplorerPrompt(options.name, options.scope, files, codegraph)

  const proc = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      options.model,
      '--output-format',
      'json',
      '--allowedTools',
      codegraph ? 'Read,Glob,Grep,mcp__codegraph' : 'Read,Glob,Grep',
    ],
    {
      cwd: options.repo,
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TOM_SWE_INTERNAL: '1' },
    }
  )

  if (proc.error) {
    return { ok: false, error: `claude spawn failed: ${proc.error.message}` }
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      error: `claude exited ${proc.status}: ${(proc.stderr ?? '').slice(0, 500)}`,
    }
  }

  let parsed: z.infer<typeof CliResultSchema>
  try {
    const result = CliResultSchema.safeParse(JSON.parse(proc.stdout))
    if (!result.success) {
      return { ok: false, error: `unexpected CLI output shape: ${result.error.message}` }
    }
    parsed = result.data
  } catch {
    return { ok: false, error: `CLI output was not JSON: ${proc.stdout.slice(0, 200)}` }
  }

  const usage = parsed.usage
  const buildTokens =
    usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)
      ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      : null

  const manifest: BrainManifest = {
    v: 1,
    name: options.name,
    repo: options.repo,
    scope: [...options.scope],
    sessionId: parsed.session_id,
    model: options.model,
    commit: gitHead(options.repo),
    builtAt: new Date().toISOString(),
    fileHashes,
    buildTokens,
  }

  return { ok: true, manifest }
}
