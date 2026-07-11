# ADR-0094 — M14c: Passive per-species ability system

**Status:** Accepted  
**Date:** 2026-07-10  
**Deciders:** Drew Teter  
**Relates to:** ADR-0092 (M14a status-effect rules), ADR-0093 (M14b persistence), ADR-0010 (OCP gate), ADR-0006 (additive schema)

---

## Context

M14a/14b shipped a status-effect system (Poison, Burn, Paralysis, Sleep, Freeze) that
applies conditions per-turn. A natural follow-on is **passive species abilities** —
permanent effects that trigger on entry or modify per-turn status interactions, driven
entirely by content data with no per-ability server code.

The design must satisfy:
- **Data-driven**: a new ability is one RON entry, no code change
- **OCP gate**: adding a new `AbilityEffect` variant forces exhaustive-match updates
  at compile time (ADR-0010)
- **Additive schema**: `Species.ability: Option<u32>` must deserialize with a missing
  field as `None` (ADR-0006 `#[serde(default)]`)
- **No signature change**: `validate_content` and `resolve_full_turn` signatures must
  stay fixed (server calls them)
- **Deterministic**: no non-deterministic data structures in the ability pipeline

---

## Decisions

### 1. `StatusKind` — payload-free discriminant for immunity content

`StatusEffect::Sleep { turns_remaining: u8 }` carries a payload that makes it
awkward to embed in RON as an immunity target. Writing
`StatusImmunity(immune_to: Sleep { turns_remaining: 0 })` leaks an internal
simulation detail into content.

**Decision:** introduce `StatusKind` as a payload-free discriminant enum that mirrors
`StatusEffect` variants without payloads. RON reads `StatusImmunity(immune_to: Sleep)`
cleanly. `StatusKind::matches(&StatusEffect)` provides the comparison.

The `matches` function uses an explicit multi-arm match (not `matches!`) to document
the `StatusKind → StatusEffect` pairing. Adding a new `StatusKind` variant requires
adding a new arm — the code serves as its own pairing table.

### 2. `AbilityEffect` is exhaustive (NOT `#[non_exhaustive]`)

Per ADR-0010: enum variants that appear at every resolution site must be exhaustive so
a new variant forces a compile-time update at every handler. `AbilityEffect` has two
variants with distinct resolution semantics:
- `StatusImmunity { immune_to: StatusKind }` — handled in both `apply_entry_ability`
  and `apply_ability_modifiers`
- `EntryHeal { denom: u16 }` — handled only in `apply_entry_ability`

`apply_ability_modifiers` uses a non-exhaustive `if let Some(StatusImmunity {...})` for
the per-turn path because `EntryHeal` intentionally has no per-turn effect. A future
`AbilityEffect` variant that needs per-turn handling must explicitly add a branch.
The `AbilityEffect` doc comment warns about this.

### 3. `AbilityStore` mirrors `BattleStatusStore`

`AbilityStore` is a parallel `Vec<Option<AbilityEffect>>` for each side, matching the
shape of `BattleStatusStore`. No `SpacetimeType` derive — abilities are not persisted
per-slot (they are derived from species content at call time). Sized by team size at
construction.

### 4. `apply_entry_ability` and `apply_ability_modifiers` are standalone hooks

These are NOT wired into `resolve_full_turn` in this slice (which would change the
signature). The server wiring (constructing an `AbilityStore` from species content and
calling the hooks in the battle pipeline) is a subsequent slice.

`apply_entry_ability` returns `()` — no `Vec<BattleEvent>` — because no event types
exist for ability activations yet. When the client needs to display ability popups, a
new `BattleEvent` variant will be added at that time.

### 5. `validate_abilities` is an additive sibling to `validate_content`

`validate_content` signature cannot change (server calls it with 4 fixed params). A
new `validate_abilities(abilities, species)` function follows the `validate_shops` /
`validate_evolution_fusion` precedent as an additive sibling. It cross-checks:
- Unique ability ids
- `EntryHeal.denom >= 2` (denom 0/1 would grant a free full-heal on entry)
- Every `species.ability` `Some(id)` references an existing ability id

`validate_abilities` is called from `sync_content_inner` in the validate phase
(all-before-any-write) immediately after `validate_shops`, closing the RT-A14-01
gap where dangling ability ids would silently be accepted.

### 6. `EntryHeal` precondition policy (ADR-0055)

Per the project's `debug_assert` precondition policy: `apply_entry_ability` asserts
`denom >= 2` via `debug_assert!` at runtime. This fires loudly in debug/test builds
if `denom < 2` bypasses `validate_abilities`. In release builds, `monster.max_hp / denom`
produces a division-by-zero panic for `denom = 0` (loud), and an unguarded full-heal
for `denom = 1` (the root fix is the server-side `validate_abilities` call). The
minimum-heal floor is `(heal).max(1)` — ensuring at least 1 HP is restored.

### 7. `Species.ability: Option<u32>` is additive (ADR-0006)

The field uses `#[serde(default)]`, so existing species RON files that omit the field
deserialize with `ability: None` (no passive). Content authors opt-in per species.
The ability id is a foreign key into the abilities registry; `validate_abilities`
enforces referential integrity.

---

## Considered alternatives

### A. `StatusImmunity(immune_to: StatusEffect)` in RON

Rejected: `StatusEffect::Sleep { turns_remaining: N }` requires a payload in RON.
The content semantic is "immune to Sleep regardless of duration" — no duration is
meaningful in an immunity definition. `StatusKind` is the cleaner representation.

### B. Wire abilities into `resolve_full_turn` in this slice

Rejected: would require a signature change (adding `AbilityStore` param) that the
server calls with. Deferred to the next battle-pipeline slice when the server is
ready to construct `AbilityStore` from loaded species content.

### C. `AbilityEffect::EntryHeal` using absolute HP amount instead of fraction

Rejected: absolute amounts become stale as species BST scales. A denominator
(fraction of max_hp) is content-stable across level scaling.

---

## Consequences

- **Positive:** New passive abilities require only a RON entry with no code change.
- **Positive:** OCP gate enforced at compile time for new `AbilityEffect` variants.
- **Positive:** Additive schema — existing content unaffected, `ability: None` default.
- **Deferred:** Server wiring of `apply_entry_ability` / `apply_ability_modifiers` into
  the battle pipeline (next slice). Until then, species with abilities play identically
  to those without — abilities are validated but not yet applied.
- **Known gap (RT-A14-02):** `AbilityStore` size is not asserted to equal team size.
  Undersized store silently skips ability for non-zero active slot. Same structural gap
  as `BattleStatusStore` (RT-S14-03). Deferred to the slice that wires abilities into
  the battle pipeline, where the correct construction site is known.
- **Next free ADR:** 0095
