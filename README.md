# brains

Forkable warm-start agents for Claude Code. A *brain* is a curated exploration session over one project component: an agent reads the scope first-person and writes its conclusions into its own transcript, and future agents are **forked** from that session so the reads and conclusions arrive as their own memory — not as a briefing they feel obliged to re-verify. The result is a specialized agent that starts a thread without redundant searches and file reads.

A briefing is testimony; a forked transcript is memory. Agents re-verify testimony. They trust memory.

## Staleness safeguard

Every brain's manifest pins the exact content it was built from: SHA-256 hashes of every in-scope file, plus the git commit. Any drift — a changed, added, or removed file in scope — marks the brain stale, and **stale brains are regenerated, never forked as-is** (a confidently stale memory is worse than a cold start). `brain fork` checks the hashes before every fork and rebuilds automatically on drift; pass `--no-rebuild` to fail fast instead.

## Usage

```bash
brain build pref-math --repo ~/projects/tom-swe \
  --scope tom/preferences.ts --scope tom/aggregation.ts --scope tom/schemas.ts \
  --model sonnet
# building brain "pref-math" over [...]
# brain "pref-math" built: session 77f679fa-..., 3 files pinned, tokens 2149

brain check pref-math --repo ~/projects/tom-swe
# fresh — scope matches build-time hashes   (exit 0; STALE exits 1)

brain fork pref-math --repo ~/projects/tom-swe -p "rename the decay half-life config key"
# checks hashes → rebuilds if stale → claude --resume <session> --fork-session -p ...

brain fork pref-math --repo ~/projects/tom-swe
# interactive: hands the terminal to a forked session that already knows the scope

brain list --repo ~/projects/tom-swe
# pref-math  scope=[...]  built=...  commit=19e2a36  fresh
```

Manifests live in `<repo>/.claude/brains/<name>.json`. Scope globs support exact paths, directory prefixes (`tom/`), and `*`/`**` suffix patterns.

## How it works

- `brain build` runs `claude -p` headlessly in the repo with read-only tools (`Read,Glob,Grep`), prompting the explorer to read load-bearing files economically and end with a structured knowledge summary (purpose, architecture, invariants, conventions, gotchas, file map). The session id from `--output-format json` plus the scope hashes become the manifest.
- When the repo has a CodeGraph index (`.codegraph/`), the build also allows the `mcp__codegraph` tools and instructs the explorer to use `codegraph_explore` as its primary tool — one call returns the relevant source sections, which keeps the brain transcript lean (and every fork cheaper). Rebuild the index before building a brain: the staleness gate hashes *source files*, so a lagging index can teach the brain stale facts the hash gate can't see.
- Remote code intelligence is deliberately not used: a brain is maximum-trust injected context, and knowledge pulled from a remote index about code outside the local checkout can't be pinned by the content-hash safeguard — it would be drift the gate cannot detect. Revisit only for scopes spanning repos that can't be checked out locally, and pin those brains some other way.
- `brain fork` resumes that session with `--fork-session`: the fork gets a new session id and the full first-person context. With `-p` it runs headless and prints the result; without, it opens interactively.
- Builds and forks export `TOM_SWE_INTERNAL=1` so memory-plugin hooks treat them as internal machinery, not user sessions.

Validated end to end: a brain built over tom-swe's preference math answered detailed questions (exact decay formula, floor semantics including which code paths do *not* apply the floor, pipeline ordering) from a fork with tools forbidden — knowledge served entirely from inherited context, zero re-reads.

## Caveats

- A brain costs its transcript size as input on every fork; keep scopes small and explorations economical (that's why the explorer prompt forbids wasteful reads).
- Brains are per-machine and per-repo-path: forking resumes a local session transcript, so manifests don't transfer across machines. Share the *recipe* (name, scope, model — all in the manifest) and rebuild remotely.
- Brains are maximum-trust injected context. Build them from sources you trust, and treat the explorer as a trust boundary.

## Development

```bash
npm run typecheck && npm test && npm run build
```
