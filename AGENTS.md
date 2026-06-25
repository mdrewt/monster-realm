# AGENTS.md — monster-realm

Project-specific rules. Inherits the workspace `AGENTS.md` and `standards/`.

- **Stack:** spacetimedb-game
- **Run:** `just setup` · `just test` · `just lint` · `just typecheck` · `just eval` · `just security` · `just ci`
- **Done =** `just ci` green and meaningful (coverage + mutation + security clean), ADR present for new deps/patterns.

## Notes
- Spec lives in `docs/specs/`; ADRs in `docs/adr/`.
- Tests are authored from acceptance criteria; the implementer doesn't grade its own tests.

## Principle tiers & inversions (this project)
Inherits `standards/principles.md`. Declare deviations here, one line of rationale each:
- Promoted to Tier 1: (none yet)
- Demoted / skipped: (none yet)
- Inverted: (none yet — e.g. "Postel inverted: reject out-of-contract input, don't clamp")

Record non-obvious calls as ADRs.
