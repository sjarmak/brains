# brains — Agent Operating Notes

> The **intention + failure-mode-prevention** layer for agents working in this repo.
> It holds only what lives nowhere else; everything general is referenced, not copied.

## What this project is

`brain` — a TypeScript CLI for forkable warm-start Claude Code agents. A brain
is a curated read-only exploration session over a scoped set of files; future
agents are *forked* from that session so its reads arrive as first-person
memory, not as a briefing they'd re-verify. The whole design hangs on one
trust chain: manifest hashes → staleness gate → fork.

Invariants a capable agent would otherwise get wrong:

- **Stale brains are regenerated, never forked as-is.** A confidently stale
  memory is worse than a cold start. `fork.ts` checks per-file SHA-256 hashes
  before every fork; rebuild-on-drift is the default, `--no-rebuild` means
  fail-fast — never "fork anyway". Don't add a code path that forks without
  passing the gate.
- **The manifest is the provenance contract.** `BrainManifestSchema`
  (`src/manifest.ts`) is a Zod `strictObject` with `v: 1` — unknown fields are
  rejected, so any shape change is a format-version decision, not a casual
  field add. Staleness = *any* drift: changed, added, or removed file in scope.
- **Manifests live in the target repo** (`<repo>/.claude/brains/<name>.json`),
  not in this repo. They are per-machine and per-repo-path (forking resumes a
  local session transcript); share the recipe and rebuild, never copy manifests
  across machines.
- **Remote code intelligence is deliberately excluded.** A brain is
  maximum-trust injected context; knowledge from a remote index can't be
  pinned by the content-hash gate — it would be undetectable drift. Don't
  "helpfully" wire in remote sources.
- **CodeGraph ordering matters:** the staleness gate hashes *source files*, not
  the index, so a lagging `.codegraph/` index can teach a brain stale facts
  the gate can't see. Rebuild the index before `brain build`.
- Builds and forks export `TOM_SWE_INTERNAL=1` so memory-plugin hooks treat
  them as machinery, not user sessions — keep that on any new claude-spawning
  path.
- Build sessions get read-only tools (`Read,Glob,Grep`, plus codegraph when
  indexed) and an economy-minded explorer prompt; every wasted read costs
  every future fork. Don't widen the toolset.
- `dist/` is gitignored tsc output (`bin` points at `dist/cli.js`). Source is
  `src/`; gate changes with `npm run typecheck && npm test && npm run build`.

## Failure-mode preventions

<!-- Append-only log of "don't do X here, it breaks Y" lessons from real
     incidents. One line each: the prevention, then the consequence it avoids.
     example:
- Don't run migrations against the read replica — it fails silently mid-batch.
-->

## Where to look (references)

- **Concept, usage, caveats:** `README.md`
- **Manifest schema + hashing/scope semantics:** `src/manifest.ts` (tests in `src/manifest.test.ts`)
- **Staleness gate + fork policy:** `src/fork.ts`
- **Explorer prompt + build mechanics:** `src/build.ts`
