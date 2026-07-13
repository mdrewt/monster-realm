# ADR-0079 — Nightly republish smoke test (§12.5b-6)

**Status:** Accepted
**Date:** 2026-07-03
**Slice:** m12.5b6
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, schema-persistence
**Decision:** Nightly smoke test republishes the module without --delete-data, calls sync_content, and asserts that player rows survive and CONTENT_VERSION increments.


**Status:** Accepted  
**Date:** 2026-07-03  
**Deciders:** Drew Teter  
**Spec:** `specs/monster-realm-v2/M12.5-sixth-review-residuals.spec.md §12.5b-6`

## Context

`ADR-0006` (additive schema) and `ADR-0037` (live-content update) promise that
`spacetime publish` on a live database without `--delete-data` preserves existing
player rows, and that `sync_content` (owner-callable since §12.5b-1, ADR-0073)
then re-seeds the content registries to the new `CONTENT_VERSION`.

Before §12.5b-6, this end-to-end path had **zero automated coverage**. Nothing
checked that:

1. A player created before a republish still exists after it.
2. `sync_content` actually updates `config.content_version` after detecting a
   version mismatch.

The sixth review identified this as a HIGH gap: the G1 promise was dead code,
unexercised by any CI gate.

## Decision

Add a **nightly GitHub Actions job** (`smoke-republish` in `nightly.yml`) that
executes the full publish → edit-content → republish-without-delete → sync_content
→ assert sequence. The job is **schedule-only** (not a per-PR gate) because it
requires a live SpacetimeDB instance and takes ~3–4 min; adding it to the per-PR
`ci.yml` path would violate the ADR-0043 fast-loop principle.

**Failure policy (Drew's decision, 2026-07-03):** Any nightly failure is inserted
into the milestone slice queue as the NEXT slice to be worked on when detected.
Priority: same tier as fix-red-master, below it in ordering. The supervisor picks
it up as a priority target on the next supervision tick.

## Smoke test sequence (`scripts/smoke-republish.sh`)

1. **Build + initial publish** (`--delete-data -y`) → fresh DB, `init` runs,
   content seeded at `CONTENT_VERSION = V`.
2. **Create test data** → `spacetime call join_game '["SmokePlayer"]'`.
   `join_game` creates both a `player`+`character` row (cleared by `on_disconnect`)
   and a starter `monster` row (session-independent — NOT cleared by `on_disconnect`).
   We assert on the `monster` table, not `player` (RT-SR-01).
3. **Verify starter monster exists** → `spacetime sql "SELECT monster_id FROM monster"`
   must return at least one numeric row.
4. **Patch `CONTENT_VERSION`** → `sed -i` bumps the constant from `V` to `V+1`
   in `server-module/src/lib.rs`; a `trap … EXIT` restores the file on completion
   (keeps local runs clean; CI runners are ephemeral). The sed pattern is anchored
   to the declaration line start so comments and strings in the file are not matched.
5. **Rebuild + republish WITHOUT `--delete-data`** → module binary now embeds
   `CONTENT_VERSION = V+1`; existing table rows (incl. the player) are preserved.
6. **Call `sync_content`** → `sync_content_inner` detects `cfg.content_version`
   (still `V`) ≠ `CONTENT_VERSION` (`V+1`) and re-seeds all registries.
7. **Assert data survived** → `spacetime sql "SELECT monster_id FROM monster"`
   still returns at least one numeric row (starter monster persists across republish).
8. **Assert new content served** → `spacetime sql "SELECT content_version FROM config"`
   contains `V+1`.

## Isolation

The nightly job passes `MR_SMOKE_DB=monster-realm-smoke-${{ github.run_id }}` so
each run uses a unique in-memory DB. Concurrent nightly runs (e.g., a manually
triggered `workflow_dispatch` overlap) never collide.

## Consequences

**Good:**
- The ADR-0006/ADR-0037 live-content-update promise is now mechanically verified
  on every night that tests pass.
- Failures surface within 24 h of a regression being merged (the mutation gate
  already provides nightly coverage for game logic; this adds the deploy path).
- The eval `evals/nightly-smoke-wiring.eval.mjs` verifies the wiring statically
  on every fast CI run (proof-of-teeth: missing job / missing script / missing
  failure-policy doc all fail the eval).

**Trade-offs:**
- The script temporarily modifies `server-module/src/lib.rs` (CONTENT_VERSION
  bump). The `trap … EXIT` restores it; local dev runs are safe.
- The nightly job takes ~3–4 min (build × 2 + publish × 2 + sync). Acceptable
  for a nightly gate.
- `spacetime call` invokes reducers as the CLI identity; `join_game` creates a
  starter monster tied to that identity. The `player` and `character` rows are
  cleared by `on_disconnect` the moment the CLI disconnects (RT-SR-01); the
  `monster` row persists. We assert on `monster`, not `player`.

## Alternatives considered

**Per-PR smoke job:** Rejected — requires a live STDB instance, ~3–4 min build,
violates ADR-0043 fast inner loop.

**Mock/unit test of republish path:** Insufficient — the real risk is at the
SpacetimeDB publish + identity + owner-check level; a mock cannot catch it.

**Do nothing:** The spec §12.5b-6 DECISION by Drew was to build this. Deferral
would leave G1/ADR-0037 unverified indefinitely.
