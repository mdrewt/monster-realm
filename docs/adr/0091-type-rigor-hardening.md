# ADR-0091 — Type-Rigor Hardening: GrantItem Gate, Quest Match, Coded Decode, Party-Slot Core Check, Marshal Re-Checks

**Status:** Accepted
**Date:** 2026-07-10
**Slice:** M13.5f
**Supersedes:** none
**Amends:** ADR-0068 (once-only gate enforcement), ADR-0049 (marshal trust boundary), ADR-0053 (typed-error pattern)

---

## Context

Five latent correctness/security gaps found in the seventh review:

1. **GrantItem unlimited-item farm** — `validate_npc_content` did not cross-reference GrantItem item ids or require a once-only flag gate. Because `talk()` re-applies `find_entry_node` + `auto_effects` on every call, a GrantItem node without a `NotFlag`+`SetFlag` gate yields unlimited item duplication via `talk`-spam. No RON content currently uses GrantItem, making this latent but exploitable the moment any content does.

2. **Quest trigger wildcard** — `trigger_matches` in `quest/rules.rs` closed the `(StepTrigger, TriggerEvent)` pair with `_ => false`, violating the project's no-wildcard doctrine (ADR-0003). A new `TriggerEvent` variant would compile silently and never match any quest step.

3. **Silent invalid-code coercion** — `dir_from_code`/`action_from_code` silently coerced out-of-range codes to North/Idle (the serde path is fail-loud). The prediction path is client-facing; invalid codes should surface as errors to prevent silent desync.

4. **Party-slot check inline in reducer** — Slot range + uniqueness logic was duplicated inline in `set_party_slot`, violating the ADR-0053 pattern (pure game-core check + typed error, reducer delegates).

5. **Marshal trust-boundary inconsistency** — `monster_to_instance` re-validates seed-time ranges at the marshal boundary; `skill_defs_from_rows` and `type_chart_from_rows` did not. An undetected corrupt DB row would silently classify wrong effectiveness or accept a zero-power skill.

---

## Decisions

### D1 — GrantItem once-only gate enforcement (f-1)

**Decision:** `validate_npc_content` enforces that every `GrantItem`-bearing node/choice has a `NotFlag(f)` + `SetFlag(f)` pair with the **same flag name `f`** in its own `entry_conditions`/`auto_effects` (for nodes) or `conditions`/`effects` (for choices). Cross-registry GrantItem item-id validation added in the same pass.

**Design notes:**
- Gate check uses `BTreeSet` intersection of NotFlag names and SetFlag names — requires strict same-flag-name match (not "any NotFlag AND any SetFlag").
- Choice-level GrantItems must be gated within the choice's own `conditions`+`effects`. A node-level `entry_conditions` gate does NOT satisfy a choice-level GrantItem check — the spec requires the gate at the same scope level (node or choice). This is intentionally strict: it prevents a future content edit from adding a GrantItem to a new choice on a gated node without its own gate.
- If a node carries multiple GrantItems, a single `NotFlag(f)`+`SetFlag(f)` pair covers all of them (they share the gate). Content authors must understand that all items on the node fire together.
- The `talk` reducer comment documents the re-application semantics: auto_effects fire every `talk()` call because `find_entry_node` re-evaluates each time. The gate is the only enforcement point.

**Security residual (RANK 3 from red-team, RT-PS-DIALOGUE):** A two-connection race on `advance_dialogue` for a GrantItem choice can duplicate the grant within the `write_player_dialogue_state` TOCTOU window. This is a SpacetimeDB architectural limitation (per-connection serialization, not per-identity). The f-1 gate makes the race window narrow (both connections must call `advance_dialogue` for the same GrantItem choice simultaneously), but cannot eliminate it at the application layer. Closed by SpacetimeDB-level per-identity reducer serialization (not available in 1.12.0) or a conditional flag-insert at DB level. Deferred.

### D2 — Exhaustive quest trigger match (f-2)

**Decision:** `trigger_matches` uses exhaustive nested match over `(StepTrigger, TriggerEvent)` — no tuple wildcard. Compiler flags every new variant combination. The existing `_ => false` wildcard is removed.

### D3 — Fail-loud coded decode (f-3)

**Decision:** `dir_from_code`/`action_from_code` return `Option<T>` (not `T` with a silent default). `apply_move_coded` returns `Result<[i32;4], String>` and propagates `Err` via `?`. `predict_move` in client-wasm returns `Result<Vec<i32>, JsValue>`. Error strings include the invalid code value for debuggability.

The `String` error type (not `&'static str`) is chosen for consistency with all other `game_core` error returns and to allow `.map_err(|e| format!("context: {e}"))` idioms.

### D4 — Pure `check_party_slot` + `SlotError` in game-core (f-4)

**Decision:** Party-slot legality moves to `game_core::check_party_slot(slot, occupied_slots) -> Result<(), SlotError>` following the ADR-0053 SwapError pattern. `SlotError` is an enum with `OutOfRange` and `Occupied` variants. The reducer builds `occupied_slots` from the caller's other monsters, **excluding boxed monsters** (`party_slot == PARTY_SLOT_NONE`), and delegates to the pure function.

**Why exclude PARTY_SLOT_NONE from occupied_slots:** The `check_party_slot` contract specifies "party slots only." Passing the sentinel 255 for boxed monsters does not cause a false positive (255 triggers the `PARTY_SLOT_NONE` early-return before the `contains` check), but it violates the function's documented contract and would break future callers that count or iterate `occupied_slots`.

**Concurrent-write race (RT-PS-01):** Two simultaneous connections can each read `occupied_slots` before the other writes, both passing `check_party_slot` and both writing the same slot. The pure layer is correct given its input; the race is in the reducer's read-check-write gap. Fix requires a DB-level unique constraint on `(owner_identity, party_slot)` filtered to slots `!= PARTY_SLOT_NONE` — not available in SpacetimeDB 1.12.0 (no partial unique constraints). Documented via `rt_ps_01_concurrent_slot_assignment_requires_db_uniqueness_constraint` in `world.rs`. Deferred to infrastructure milestone.

### D5 — Marshal trust-boundary double-validation (f-5)

**Decision:** `skill_defs_from_rows` and `type_chart_from_rows` now return `Result<T, String>` and validate:
- Skill: `power > 0` and `accuracy ∈ [1, 100]`
- Type chart: `effectiveness ∈ {0, 5, 10, 20}`

These are the same constraints enforced at seed time by `validate_content` / `sync_content`. The double-check is cheap and symmetric with `monster_to_instance`'s trust-boundary re-validation (ADR-0049). An invalid DB row (from a seed bug or direct DB write) surfaces as a `Result::Err` from the marshal function rather than silently producing a malformed `SkillDef` or misclassified type effectiveness.

**API note (minor):** `skill_defs_from_rows` takes `&[SkillRow]` while `type_chart_from_rows` takes `impl Iterator<Item = TypeRelationRow>`. The asymmetry reflects call-site reality: skills are collected into a `Vec` for dual use (marshal + `battle_monster_from_row`); type chart rows are iterated once. Not worth normalizing at this stage.

---

## Consequences

- `validate_npc_content` is now a cross-registry validator (items + once-only gate). Content authors must gate every GrantItem; the validator rejects at seed time.
- `apply_move_coded` callers that previously ignored the return value (`let _ = apply_move_coded(...)`) will receive `Result::Ok` for valid codes but must handle the `Err` path. Existing call sites (`sim-harness`, `client-wasm`) updated.
- `set_party_slot` now produces typed error strings via `SlotError::Display`, matching the reject-not-clamp posture of other reducers.
- `skill_defs_from_rows`/`type_chart_from_rows` call sites (`battle.rs`, `taming.rs`) use `?` propagation — any invalid row aborts the reducer with an error instead of proceeding with corrupt data.

## Named residuals

- **RT-PS-01** (party-slot concurrent-write race): DB unique constraint on `(owner_identity, party_slot WHERE != PARTY_SLOT_NONE)` — deferred pending SpacetimeDB partial-unique-constraint support.
- **RT-PS-DIALOGUE** (GrantItem TOCTOU in `advance_dialogue`): per-identity SpacetimeDB serialization or conditional-flag-insert — deferred.
- **pp > 0 not validated**: `skill_defs_from_rows` validates power and accuracy but not pp. `validate_content` also omits pp. A zero-pp skill would be usable but has infinite-pp semantics at the combat level. Named deferral; pp exhaustion is not yet modeled.
- **Asymmetric API** (`&[SkillRow]` vs `impl Iterator`): acceptable until a third marshal function is added that warrants normalization.
