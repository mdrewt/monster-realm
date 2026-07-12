# ADR-0092 — M14a Status-Effect Rules: Layered DoT Resolution, Separate Variance Struct, Pure Game-Core Persistence Model

**Status:** Accepted
**Date:** 2026-07-10
**Slice:** M14a
**Supersedes:** none
**Amends:** ADR-0017 (resolve_turn signature), ADR-0023 (turn model), ADR-0041 (damage formula)

---

## Context

StatusEffect semantics were not defined in the core v1 battle model (ADR-0041/ADR-0017). M14a implements:

1. `StatusEffect` enum with variants (Burn, Poison, Paralysis, Sleep, etc.) for per-turn DoT resolution.
2. Per-turn effects applied layered on top of `resolve_turn` (via `resolve_full_turn`), post-attack and simultaneous on both sides.
3. Effects are pure game-core rules; persistence (SpacetimeType table + schema) deferred to m14b.

Key design tensions:

- **Signature stability** — `resolve_turn` is called from the client predictor (fixed interface); changing its signature would widen scope to client-wasm bindings regen.
- **Circular imports** — applying effects post-turn (in `status.rs`) duplicates faint logic that exists in `resolve.rs`. Extracting a helper creates a cycle.
- **Simultaneous KO tie-break** — both sides can die from DoT in the same turn-phase; who wins determines turn direction and loot grants.
- **Event shape** — `StatusCured` events need slot index to distinguish bench-only cures from active-slot cures; schema TBD in m14b.

---

## Decisions

### D1 — Separate `StatusVariance` struct (not merged into `TurnVariance`)

**Decision:** `StatusVariance` is a **distinct struct** from `TurnVariance`, passed only to `resolve_full_turn`. It contains per-turn randomized rolls (e.g., `hit_status_check`, `dodge_status_check`).

```rust
pub struct StatusVariance {
    pub hit_status_check: f64,
    pub dodge_status_check: f64,
    // ... 4 more rolls reserved for m14b
}

pub fn resolve_turn(c: Choice, a: Choice, tv: &TurnVariance, ...) -> TurnResult {
    // No StatusVariance parameter; signature unchanged.
}

pub fn resolve_full_turn(
    c: Choice, a: Choice,
    tv: &TurnVariance, sv: &StatusVariance,  // Both passed here
    ...
) -> FullTurnResult {
    // ...
}
```

**Rationale:** `resolve_turn` is the canonical turn API used by the client predictor. Adding a parameter would break bindings (wasm-bindgen export) and every predictor call site. By introducing `resolve_full_turn` as a thin wrapper that:
1. calls `resolve_turn(c, a, tv, ...)`
2. calls `apply_post_turn_effects(result, sv, ...)`

we preserve the interface contract of ADR-0017 and ADR-0023. The cost is that `TurnVariance` and `StatusVariance` are separate inputs; they are orthogonal concerns (turn damage variance vs status effect rolls).

**Deferred to m14b:** `StatusVariance::from_ctx_random` — currently rolls are passed as `&StatusVariance { hit: 0.5, dodge: 0.5, ... }` (placeholder). M14b must add the derivation function parallel to `TurnVariance::from_ctx_random` so rolls are consistently derived server-side and passed to both client and server reducers.

### D2 — `BattleStatusStore` is pure game-core, not SpacetimeType

**Decision:** `BattleStatusStore` lives in `game_core/src/battle/status.rs` as a Rust struct, not a SpacetimeType in the schema.

```rust
pub struct BattleStatusStore {
    pub a_statuses: Vec<(MonsterSlot, StatusEffect)>,
    pub b_statuses: Vec<(MonsterSlot, StatusEffect)>,
}
```

Persistence (serializing to DB) is deferred to m14b. Schema changes would require:
- New `battle_status` table or `status_effects` column in `battle`.
- Bindings regen (ripple to all `battle` callers).
- Serialization logic (encode/decode RON or JSON).

**Rationale:** m14a's scope is pure rules. By keeping `BattleStatusStore` in-memory within `resolve_full_turn`, we:
- Ship a working, testable DoT engine without schema churn.
- Defer storage serialization to m14b (a separate, scoped task).
- Avoid bindings regen in m14a (which would delay other concurrent slices).

The `FullTurnResult` returned by `resolve_full_turn` includes `statuses: BattleStatusStore`; the server reducer will apply it to the in-memory battle object for the turn. At battle end, statuses are dropped (not persisted). Across-battle persistence is deferred.

### D3 — Status-blocking applies to attacks only; swap is always permitted (amended M14.5a, ADR-0098)

**Decision (amended):** Status blocking (Sleep, Paralysis, Freeze) gates `Attack` choices only. `Swap` is always permitted regardless of the active monster's status — a player may always switch out a blocked monster. This is the Pokémon-conventional behavior and was blessed in D-14.5-1 (default (b)). `resolve_player_swap` therefore never calls `check_action_block`.

The original D3 text described a swap-conversion-to-Pass that was never implemented (`swap_active` does not call `check_action_block`). The ADR is amended to match the production behavior rather than an unimplemented design sketch.

**Pinned by:** `swap_allowed_when_player_active_has_{sleep,freeze,paralysis}` tests in `game-core/src/combat/resolve.rs` (M14.5a, ADR-0098 D3).

```rust
pub fn resolve_full_turn(c_choice: Choice, a_choice: Choice, ...) -> FullTurnResult {
    let c_active = !is_blocked(c_side);  // Determined from current statuses
    let a_active = !is_blocked(a_side);

    // Attack-only block: Swap is always permitted.
    let c_resolved = if c_active || matches!(c_choice, Choice::Swap { .. }) { c_choice } else { Choice::Pass };
    let a_resolved = if a_active || matches!(a_choice, Choice::Swap { .. }) { a_choice } else { Choice::Pass };

    let turn_result = resolve_turn(c_resolved, a_resolved, ...)?;
    // ...
}
```

`resolve_turn` has a `Pass => { /* do nothing */ }` arm; it never calls `skill_id_from(Pass)`.

**Rationale:** `skill_id_from` (used to look up damage formula parameters) is only called when `a_attacks = matches!(TurnChoice::Attack{..})`. A `Pass` variant is not `Attack{..}`, so `skill_id_from(Pass)` is never reached. The `Pass => unreachable!()` arm in the exhaustive match is a **compile-time guard** ensuring that if a new caller mishandles `Pass`, the compiler forces a fix rather than silently accepting it.

This design keeps `resolve_turn` agnostic to status effects; the blocking logic lives in `resolve_full_turn`.

### D4 — DoT KO cascade duplication (status.rs vs resolve.rs)

**Decision:** Faint logic triggered by DoT is **duplicated** in `status.rs::apply_post_turn_effects`, mirroring the faint handling in `resolve.rs::resolve_one_attack`. No shared helper is extracted.

```rust
// In status.rs::apply_post_turn_effects:
if statuses[i].tick() causes faint {
    // Faint logic (auto-switch or BattleEnd)
    // Duplicated from resolve_one_attack
}

// In resolve.rs::resolve_one_attack:
if damage > hp {
    // Same faint logic
}
```

**Rationale:** Extracting a shared `fn apply_faint_cascade(...)` would require importing it in both modules:
- `status.rs` imports from `resolve.rs`
- `resolve.rs` already imports from `status.rs` (to call effect hooks)

This creates a cycle. Rust's module system does not permit circular imports. The duplication is ~20 lines and the modules stay independent. Future refactoring (e.g., extracting both to a `faint.rs` module) can deduplicate; for m14a, isolation is prioritized.

### D5 — SideA-first DoT ordering (SideA wins on simultaneous KO)

**Decision:** `apply_post_turn_effects` iterates over statuses in order: `[SideA, SideB]`. If both sides would faint from DoT in the same turn-phase, **SideA is processed first**. SideA's faint triggers BattleEnd or auto-switch; SideB's faint is then evaluated against a potentially-different battle state (opponent may have switched). The net effect: **SideA wins** on simultaneous DoT KO.

```rust
pub fn apply_post_turn_effects(
    result: &mut TurnResult,
    statuses: &mut BattleStatusStore,
    ...
) {
    for side_id in [SideId::A, SideId::B] {
        for slot in statuses[side_id].iter_mut() {
            slot.tick_status();
            if slot.hp == 0 {
                // Faint cascade (auto-switch or BattleEnd)
                // Run for SideA first
            }
        }
    }
}
```

**Rationale:** The rule must be deterministic and asymmetry-free. Without a tie-break, simultaneous KO would require a branch (`if both sides faint { ... }`), which couples the rules. ADR-0023 (turn model) establishes that SideA acts first in normal resolution (attack/swap order). Extending this to the DoT phase is consistent. The tie-break is named **RT-S14-04** in validation tests.

### D6 — `StatusCured` event shape gap (deferred, named residual)

**Decision:** `StatusCured` events are emitted by `apply_post_turn_effects` and `advance_turn` (cure via turn-count). The event struct is:

```rust
pub enum EffectEvent {
    StatusCured { side: SideId },
    // ...
}
```

**Known gap:** `StatusCured` does **not carry the slot index**. This means a bench-slot cure (e.g., bench Pokémon healing Burn) cannot be distinguished from an active-slot cure at the event consumer layer. Both emit `StatusCured{side: SideA}`.

**Rationale:** m14a focuses on the DoT engine; event schema is orthogonal. m14b will stabilize event shapes with full slot awareness (`StatusCured { side: SideId, slot: MonsterSlot }`). For m14a, `side` is sufficient to trigger client-side UI updates (e.g., clear status icon for the side). The precise slot affected is available via subscription to `battle_monster` table changes.

**Named residual:** RT-S14-01 documents this gap. m14b's issue: finalize event schema before multiplayer support requires precise client-side slot tracking.

### D7 — `sleep_wake_roll_a` and `sleep_wake_roll_b` reserved in `StatusVariance`

**Decision:** `StatusVariance` struct reserves two fields:

```rust
pub struct StatusVariance {
    pub hit_status_check: f64,     // Turn-1+ check if side lands status
    pub dodge_status_check: f64,   // Turn-1+ check if side dodges status
    pub sleep_wake_roll_a: f64,    // Reserved; unused in m14a
    pub sleep_wake_roll_b: f64,    // Reserved; unused in m14a
    // ... 2 more reserved
}
```

Currently, Sleep cures via turn-count in `tick_status()`, not probabilistic wake rolls. The rolls are not used in m14a.

**Rationale:** m14b will add a `roll_sleep_wake` check during `tick_status` (e.g., 25% chance to wake each turn). To maintain determinism, these rolls must be derived server-side and passed to client predictors (via `StatusVariance::from_ctx_random`). Reserving the fields now prevents future ADRs or refactors from accidental re-use and forces intentional derivation in m14b.

**Contract for m14b:** `StatusVariance::from_ctx_random` must be added, parallel to `TurnVariance::from_ctx_random`. All 6 fields must be derived from `ctx.random()` calls:

```rust
pub fn from_ctx_random(ctx: &ResolveContext) -> Self {
    Self {
        hit_status_check: ctx.random().gen_range(0.0..1.0),
        dodge_status_check: ctx.random().gen_range(0.0..1.0),
        sleep_wake_roll_a: ctx.random().gen_range(0.0..1.0),
        sleep_wake_roll_b: ctx.random().gen_range(0.0..1.0),
        // ... 2 more
    }
}
```

---

## Consequences

- `resolve_full_turn` becomes the canonical server-reducer turn API. Client predictor continues to call `resolve_turn` (unchanged interface).
- Battle-status mutations (status application, curing, ticking) are confined to `status.rs`; coupling to `resolve.rs` is minimal.
- `apply_post_turn_effects` is called **once per turn**, after `resolve_turn` completes, before `FullTurnResult` is returned to the reducer. This serialization ensures faint cascades are deterministic.
- SideA-first DoT processing is a behavioral commitment; changing it requires an ADR amendment.
- Event consumers must treat `StatusCured{side}` as a side-wide notification, not a per-slot guarantee (until m14b adds slot index).

## Named residuals

- **RT-S14-01** (slot-aware cures in `StatusCured` event): Event schema redesign (add `slot: MonsterSlot`) — deferred to m14b.
- **RT-S14-04** (simultaneous-DoT KO tie-break rule): Documented; SideA-first processing is canonical.
- **M14b derivation contract** (`StatusVariance::from_ctx_random`): All 6 fields must be consistently derived server-side and passed to both server reducers and client predictors.
