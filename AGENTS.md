# AGENTS.md — monster-realm

Project-specific rules. Inherits the workspace `AGENTS.md` and `standards/`.

- **Stack:** spacetimedb-game
- **Toolchain (pinned):** Rust `1.96.0` (`rust-toolchain.toml` — rustup auto-selects, incl. `wasm32-unknown-unknown` + clippy/rustfmt) · spacetime `2.6.0` (global `spacetime version use 2.6.0`; no per-project file — verify with `spacetime --version`) · Node `24.13.1` (workspace `.tool-versions`) · wasm-pack `0.15.0` (no per-project pin file — `cargo install wasm-pack --version 0.15.0`; pin the CI install action to `v0.15.0` when the client prediction-WASM build lands at M3; verify with `wasm-pack --version`). Bump deliberately.
- **Run:** `just setup` · `just test` · `just lint` · `just typecheck` · `just eval` · `just security` · `just ci`
- **Done =** `just ci` green and meaningful (coverage + mutation + security clean), ADR present for new deps/patterns.

## Notes
- Spec lives in `docs/specs/`; ADRs in `docs/adr/`.
- Tests are authored from acceptance criteria; the implementer doesn't grade its own tests.
- **Code knowledge graph (`codebase-memory-mcp`):** a global MCP server (registered in `~/.claude/.mcp.json`) indexes this repo into a queryable graph (per-project index in `~/.cache/codebase-memory-mcp/`). Use it for **impact analysis** — before changing a shared `game-core` signature/type (the workspace rule: report affected callers/tests first), query `trace_path` / `search_graph` / `get_code_snippet` to enumerate callers instead of reading whole files (cheaper, more precise). **Keep the graph current:** re-index at each milestone close — `index_repository` (full) or `detect_changes` (incremental). Read-only query tools + indexing are pre-allowlisted in `.claude/settings.json`; `delete_project` is intentionally not. **Arg nuance:** `index_repository` / `detect_changes` take `repo_path` (absolute path); the query tools (`search_graph`, `trace_path`, `index_status`, …) take `project` — the indexed name from `list_projects` (here `home-mdrewt-projects-ai-apps-claude-harness-projects-monster-realm`).

## Principle tiers & inversions (this project)
Inherits `standards/principles.md`. Declare deviations here, one line of rationale each:
- Promoted to Tier 1: (none yet)
- Demoted / skipped: (none yet)
- Inverted: (none yet — e.g. "Postel inverted: reject out-of-contract input, don't clamp")

Record non-obvious calls as ADRs.
