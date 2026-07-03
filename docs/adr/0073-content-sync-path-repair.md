# ADR-0073: Content-sync path repair (M12.5b)

- **Status:** Accepted
- **Date:** 2026-07-03
- **Context milestone:** M12.5b
- **Implements:** ADR-0006 (additive schema, content-sync promise), ADR-0037 amendment
- **Fixes:** six-review finding — `sync_content` is dead code end-to-end (G1/ADR-0037 promise broken)

## Context

The sixth review found the "content update without `--delete-data`" promise (G1, ADR-0006/0037) to be dead code on three dimensions:

1. **Auth guard unreachable (12.5b-1):** `sync_content` guards `ctx.sender != ctx.identity()`. The module identity (`ctx.identity()`) is the wasm module's identity, NOT the database owner's. The database owner calling `spacetime call sync_content` has a different `ctx.sender` than the module identity, so the guard always rejects them. No path exists to call sync_content.

2. **Partial-commit on validation failure (12.5b-2):** `sync_content_inner` interleaves loads, writes, and validations. A late validation failure (e.g., `validate_evolution_fusion` after encounter writes) commits partial state with no version stamp. The function returns `()` and uses `log::error!(); return;` patterns that silently commit earlier writes.

3. **No re-derive pass (12.5b-3):** `sync_content_inner` never touches `monster`/`monster_pub` rows. A base-stat change in a species RON file leaves stale `stat_*` columns, possibly `current_hp > stat_hp`, and stale `evolves_to` hints.

4. **Stale `evolves_to` on mutation (12.5b-4):** `evolves_to` is only recomputed during `evolve`/`fuse` (evolution.rs). Battle level-up and care (bond change) can alter evolution eligibility but leave the stored hint stale.

5. **No mechanical coupling of content to CONTENT_VERSION (12.5b-5):** The constant is bumped manually with no CI gate linking it to actual file changes.

## Decision

### 12.5b-1: Owner-identity check via stored publisher identity

Store the publisher's identity in `Config.owner_identity` during `init` (where `ctx.sender` is the identity of the person who ran `spacetime publish`). In `sync_content`, replace `ctx.sender != ctx.identity()` with `ctx.sender != cfg.owner_identity`.

**ADR-0037 amendment:** The "callable on republish" mechanism note in ADR-0037 claimed `ctx.sender != ctx.identity()` as the mechanism. This was wrong: `ctx.identity()` is the MODULE identity, not the scheduled-reducer caller. The correct mechanism is an owner-identity check against the stored publisher identity from `init`.

Schema change: `Config` gains `owner_identity: Identity` with `#[default(Identity::from_byte_array([0u8; 32]))]` for additive migration safety (ADR-0006). The zero-identity default for pre-existing rows means old databases must re-publish to register the owner; `sync_content` on an old DB will reject (correct — the owner isn't registered yet).

### 12.5b-2: Load-all → validate-all → write-all

Refactor `sync_content_inner` from `fn(ctx) -> ()` to `fn(ctx) -> Result<(), String>`. Collect ALL registry loads at the top (zones, zone_maps, species, skills, type_chart, items, encounters, evolutions, fusions, npc_defs, dialogue_trees, quest_defs, heal_defs). Run ALL validators. Only then begin DB writes. A validation failure at any point returns `Err` before any write, so the reducer's transaction rolls back the whole operation. This makes the "validate before commit" contract enforceable by SpacetimeDB's transaction semantics.

`init` calls `sync_content_inner(ctx).expect("content seeding failed on init")` — a panic on init failure is appropriate (init is not retried; a broken content load on first publish must be visible).

### 12.5b-3: Re-derive monster pass on version change

After all content table writes (and before version stamp), iterate all `monster` rows. For each: load the updated species row, re-derive stats (`derive_stats`), clamp `current_hp` to the new `stat_hp`, recompute `evolves_to` (`compute_evolves_to`), dual-write `monster_pub`. Log-and-continue on per-row errors (corrupt row shouldn't abort content sync for all other players; mirrors `movement_tick` per-character philosophy).

### 12.5b-4: evolves_to recompute on mutation

- **Battle level-up write-back (`battle.rs`):** After `derive_stats`, load evolutions from game_core and call `compute_evolves_to`. Level change can unlock a new evolution branch.
- **Care reducer (`raising.rs`):** After bond update, load evolutions and call `compute_evolves_to`. Bond increase can cross a bond threshold.
- **Creation paths (`marshal.rs` callers in `taming.rs`):** `monster_from_instance` hardcodes `evolves_to: None`. Touching `taming.rs` is OUTSIDE the declared touches (could collide with a sibling). Implementer's call: correct the `schema.rs` comment to the narrower truth — `evolves_to` starts `None` on creation and is computed on first applicable event (sync_content, evolve, level-up, care). This is a known limitation documented in the schema, not a silent divergence.

### 12.5b-5: Content-hash eval gate

New eval `evals/content-version.eval.mjs`: hash the sorted file-list of `game-core/content/**` (deterministic — sorted before hashing), compare against a committed baseline in `evals/baselines/content-hash.json` keyed by `{ "version": N, "hash": "sha256:..." }`. The version is read from `server-module/src/lib.rs` `CONTENT_VERSION` constant. If the content hash mismatches the baseline for the current version, CI fails. Baseline is updated deliberately (alongside CONTENT_VERSION bump).

**Proof-of-teeth:** The eval has two explicit teeth:
- TEETH_HASH_MATCH: current hash matches baseline → passes
- TEETH_HASH_MISMATCH: simulated mismatch (baseline with wrong hash) → fails

### 12.5b-6 (DECISION, deferred)

Republish smoke e2e (`publish → edit content → republish without --delete-data → assert data survives + new content served`) is explicitly deferred to Drew. Recommendation: nightly CI job, not per-PR. No implementation in this slice.

## Consequences

- `sync_content` is now callable by the database owner via `spacetime call sync_content`, making G1 (live content update) a working path.
- A late-validation failure in `sync_content_inner` leaves the DB unchanged (atomic).
- A content version bump triggers a full monster re-derive in the same transaction (stats, evolves_to, hp clamp).
- Battle level-up and care mutations keep `evolves_to` current.
- `evolves_to` on fresh monsters (from taming) starts as `None` (documented limitation; fixed by the first applicable sync_content or evolve).
- CI gates content changes via hash — a content file edit without a CONTENT_VERSION bump fails the eval.
- `Config` table gains `owner_identity: Identity` (additive; zero-identity default for old rows).
