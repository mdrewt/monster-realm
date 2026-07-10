# AGENTS.md — monster-realm

Project-specific rules. Inherits the workspace `AGENTS.md` and `standards/`.

- **Stack:** spacetimedb-game
- **Toolchain (pinned):** Rust `1.96.0` (`rust-toolchain.toml` — rustup auto-selects, incl. `wasm32-unknown-unknown` + clippy/rustfmt) · spacetime `2.6.0` (global `spacetime version use 2.6.0`; no per-project file — verify with `spacetime --version`) · Node `24.13.1` (workspace `.tool-versions`) · wasm-pack `0.15.0` (no per-project pin file — `cargo install wasm-pack --version 0.15.0`; CI install action is pinned to `v0.15.0` (M3, ADR-0036); verify with `wasm-pack --version`). Bump deliberately.
- **Run:** `just setup` · `just test` · `just lint` · `just typecheck` · `just eval` · `just security` · `just ci`
- **Done =** `just ci` green and meaningful (lint + typecheck + test + eval + security + client checks); the nightly workflow (`.github/workflows/nightly.yml`) enforces mutation + coverage off the PR path; ADR present for new deps/patterns.

## Notes
- **Specs & ADRs live in two locations — check both.** The authoritative milestone/spec
  corpus is the **harness**: `../../specs/monster-realm-v2/` (milestone specs `M0`–`M25`
  incl. `M8.5`/`M8.6`/`M8.7`/`M8.8`/`M8.9`/`M8.95`, `M10.5`, `M12.5`; `PLAN.md`,
  `game-design.md`, `security-threat-model.md`,
  `validation-checklist.md`, and the **design ADRs `0001`–`0034`** under `adr/`).
  Project-local docs are under **`docs/`**: `docs/specs/` (project-scoped specs +
  `TEMPLATE.md` — see its `README.md`) and `docs/adr/` (**implementation ADRs `0001`,
  `0035`+**). Resolving a reference: milestone spec or ADR `0002`–`0034` → harness corpus;
  ADR `0035`+ → `docs/adr/`. (`0001` is mirrored in both.) **Exception:** the harness
  spec corpus also contains design ADRs numbered `0055`–`0057` (different topics from
  project ADRs `0055`–`0057`); a bare `ADR-0055` citation in this project's context
  always means the project's `docs/adr/0055-*` unless an explicit `harness adr/0055`
  path prefix is used.
- Tests are authored from acceptance criteria; the implementer doesn't grade its own tests.
- **Code knowledge graph (`codebase-memory-mcp`):** a global MCP server (registered in `~/.claude/.mcp.json`) indexes this repo into a queryable graph (per-project index in `~/.cache/codebase-memory-mcp/`). Use it for **impact analysis** — before changing a shared `game-core` signature/type (the workspace rule: report affected callers/tests first), query `trace_path` / `search_graph` / `get_code_snippet` to enumerate callers instead of reading whole files (cheaper, more precise). **Keep the graph current:** re-index at each milestone close — `index_repository` (full) or `detect_changes` (incremental). Read-only query tools + indexing are pre-allowlisted in `.claude/settings.json`; `delete_project` is intentionally not. **Arg nuance:** `index_repository` / `detect_changes` take `repo_path` (absolute path); the query tools (`search_graph`, `trace_path`, `index_status`, …) take `project` — the indexed name from `list_projects` (here `home-mdrewt-projects-ai-apps-claude-harness-projects-monster-realm`).

## Principle tiers & inversions (this project)
Inherits `standards/principles.md`. Declare deviations here, one line of rationale each:
- Promoted to Tier 1: (none yet)
- Demoted / skipped: (none yet)
- Inverted: (none yet — e.g. "Postel inverted: reject out-of-contract input, don't clamp")

Record non-obvious calls as ADRs.
