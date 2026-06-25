# ADR-0035: Scaffold hardening — robust secret-scan + SpacetimeDB-stack `.gitignore`

- **Status:** Accepted
- **Date:** 2026-06-25
- **Context milestone:** Setup (pre-M0a), one-time scaffold gate
- **Relates to:** ADR-0009 (CI completeness/gates), ADR-0010 (proof-of-teeth),
  Tier-1 validation item #3 (`validation-checklist.md` — "generator scaffolds a green build")

## Context

`just new monster-realm spacetimedb-game` scaffolded the project, but the
out-of-the-box `just ci` was **red**, failing the Tier-1 assumption that the
generator yields an empty-but-green build. Two defects:

1. **`scripts/check-secrets.mjs` crashed on a dangling symlink.** The harness
   skill-vendoring (`npx skills add`) creates `.claude/skills/pixijs*` symlinks
   that point into `.agents/skills/`, which is not yet populated. The scanner
   walked the working tree and called `stat()` (follows symlinks) on a dangling
   link, throwing an uncaught `ENOENT` that aborted `just security` / the
   `pre-commit` hook.
2. **The scaffold shipped only the minimal `_base` `.gitignore`.** It did not
   ignore derived agent tooling (`.agents/`), build output (`pkg/`, `*.wasm`),
   SpacetimeDB CLI scratch (`spacetime*.json`), Playwright output, the
   codebase-memory index, or machine-specific `.mcp.json` — all of which the v1
   (`pokemon-mmo`) `.gitignore` already handles for this exact stack.

## Decision

- **Harden `check-secrets.mjs`** to be robust as a local pre-commit scanner:
  skip symlinks (never crash on a dangling link, never follow links out of the
  tree or into cycles), skip the derived `.agents/` dir, and guard `stat()`
  against racey/unreadable entries. `gitleaks` remains the authoritative
  commit-time scanner in CI.
- **Adopt the SpacetimeDB-stack `.gitignore`** ported and adapted from the
  proven v1 conventions: ignore derived skills (`.agents/`,
  `.claude/skills/pixijs*`), build/bundler output, SpacetimeDB CLI scratch,
  Playwright artifacts, the codebase-memory index, and `.mcp.json`; keep
  `Cargo.lock` and generated client bindings **committed**.

## Consequences

- `just ci` is green-and-meaningful from the baseline; the `pre-commit` hook no
  longer aborts on derived skill symlinks.
- The curated `*.md` skills under `.claude/skills/` stay tracked; PixiJS skill
  vendoring (`.agents/`, `skills-lock.json`) is **deferred to M4** (frontend),
  where it is first needed — declared, not silently dropped.
- **Upstream recommendation (flagged, not actioned here):** both defects
  originate in `templates/_base` (the harness scaffold). The same fixes should
  be upstreamed to `templates/_base/scripts/check-secrets.mjs` and the
  spacetimedb-game template `.gitignore` so future scaffolds are green by
  default. Tracked as a harness follow-up, outside this project's build-loop.
