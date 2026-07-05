//! `content_tests` — M12.5b gating tests for the `sync_content_inner` seam.
//!
//! Declared from `content.rs` as:
//!   `#[cfg(test)] #[path = "content_tests.rs"] mod content_tests;`
//! so `super` resolves to the `content` module.
//!
//! RED state: these tests are red before the M12.5b implementation because:
//!   - 12.5b-2 seam: `sync_content_inner` currently returns `()`, not
//!     `Result<(), String>`. These tests call it expecting a Result.
//!   - 12.5b-3 re-derive: no `sync_content_inner_for_monsters` (or equivalent
//!     re-derive seam) exists yet. The test calls `compute_evolves_to` directly
//!     (available via `crate::evolution::compute_evolves_to`) to verify that
//!     after content version changes, monsters can have their evolves_to refreshed.
//!
//! EARS criteria covered:
//!   - 12.5b-2: `sync_content_inner` returns Result; a validation failure at ANY
//!     registry means no DB writes occur (txn atomic / load-all before write-all).
//!   - 12.5b-3: after `sync_content_inner` with a stale version, monster rows
//!     get updated stats (re-derived from new base stats) and updated `evolves_to`.
//!
//! Pattern: these tests call the pure-seam helpers exposed by the implementation
//! and verify concrete state changes. No SpacetimeDB live context is used.

use crate::evolution::compute_evolves_to;
use crate::schema::{Monster, SpeciesRow};
use game_core::{Bond, EvolutionCondition, EvolutionTrigger, Level, NatureKind};
use spacetimedb::Identity;

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrors evolution_tests.rs patterns)
// ---------------------------------------------------------------------------

fn owner_id() -> Identity {
    Identity::from_byte_array([42u8; 32])
}

/// A minimal SpeciesRow for seeding tests.
fn make_species_row(id: u32, base_hp: u16, base_other: u16) -> SpeciesRow {
    SpeciesRow {
        id,
        name: format!("TestSpecies{id}"),
        base_hp,
        base_attack: base_other,
        base_defense: base_other,
        base_speed: base_other,
        base_sp_attack: base_other,
        base_sp_defense: base_other,
        affinity: game_core::Affinity::Fire,
        learnable_skill_ids: vec![],
    }
}

/// A Monster row with known stale stats (derived from old base_hp=45 at level=20).
/// After a content change bumping base_hp to 100, stat_hp must be recomputed.
fn make_stale_monster(monster_id: u64, owner: Identity, species_id: u32) -> Monster {
    Monster {
        monster_id,
        owner_identity: owner,
        species_id,
        nickname: String::new(),
        level: 20,
        xp: 8000,
        bond: 50,
        iv_hp: 15,
        iv_attack: 15,
        iv_defense: 15,
        iv_speed: 15,
        iv_sp_attack: 15,
        iv_sp_defense: 15,
        nature_kind: NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        // Stale stats: computed from OLD base_hp=45 at level 20 with IVs=15, EVs=0, Hardy.
        // Formula: HP = floor((2*45 + 15) * 20 / 100) + 20 + 10 = 51.
        stat_hp: 51,
        stat_attack: 56,
        stat_defense: 56,
        stat_speed: 72,
        stat_sp_attack: 72,
        stat_sp_defense: 52,
        current_hp: 50,
        party_slot: 0,
        last_care_at_ms: 0,
        evolves_to: None, // stale: may be wrong
    }
}

// ---------------------------------------------------------------------------
// 12.5b-2: sync_content_inner returns Result<(), String>
//
// These tests call `super::sync_content_inner_result` — the new name expected
// once the signature changes to `Result<(), String>`. The implementer may
// choose to rename the function or add a thin wrapper; the test targets the
// new signature.
//
// The key behavioral test: if a validation step fails (simulated by passing
// invalid content through a seam), NO earlier-registry rows must have been
// written.
//
// Because we cannot easily inject bad content into the real file-based
// registries at the unit-test level, we instead test the structural guarantee
// via the pure-seam version of the function signature: it must return Result.
// The atomicity property (no partial writes on validation failure) is enforced
// by the load-all-before-write-all structure, which the structural test in
// content.rs::tests already covers (no bare `return;` inside the fn body).
//
// The seam test here calls `sync_content_inner` with a valid context and
// verifies it returns Ok (compilation proof: the return type IS Result).
// RED state: `sync_content_inner` currently returns `()`, so calling `.is_ok()`
// on its return value is a TYPE ERROR → compile-RED.
// ---------------------------------------------------------------------------

/// 12.5b-2: calling sync_content_inner must produce a Result<(), String> return value.
/// This test FAILS TO COMPILE until sync_content_inner's return type is changed to
/// Result<(), String>.
///
/// KILLS: a unit-return (()) implementation — `.is_ok()` on `()` is a compile error,
/// keeping this test RED until the signature is actually changed.
///
/// NOTE: because the real sync_content_inner requires a live SpacetimeDB ReducerContext
/// (which is not constructible in unit tests), this test validates the signature via
/// the structural source-scan in content.rs::tests and via a call to a seam helper
/// `sync_content_inner_recheck` that is expected to exist after the M12.5b implementation.
/// If that seam does not yet exist, this module will fail to compile (RED for the right
/// reason: missing impl).
///
/// The seam signature expected by the implementer:
///   pub(crate) fn sync_content_inner_recheck(
///       species: &[game_core::Species],
///       evolutions: &[game_core::SpeciesEvolutions],
///   ) -> Result<(), String>
///
/// This is the pure validation sub-step that the implementer must extract from the
/// load-phase of sync_content_inner so it can be unit-tested without a DB context.
#[test]
fn sync_content_inner_recheck_returns_result_on_valid_input() {
    // Load real content (same as the existing content_parses_and_validates test).
    let species = game_core::load_species().expect("species must parse for this test");
    let evolutions = game_core::load_evolutions().expect("evolutions must parse");

    // Call the pure validation seam. RED until `sync_content_inner_recheck` exists.
    // The seam takes loaded registries and returns Result<(), String> for the
    // validation phase — no DB writes occur.
    let result = super::sync_content_inner_recheck(&species, &evolutions);

    assert!(
        result.is_ok(),
        "TEETH(12.5b-2): sync_content_inner_recheck with valid species+evolutions must return Ok; \
         this test is RED (compile error) until the implementer adds sync_content_inner_recheck \
         with signature `(species, evolutions) -> Result<(), String>`. \
         Got Err: {:?}",
        result.err()
    );
}

/// 12.5b-2 proof-of-teeth: the recheck seam must return Err when given an empty
/// species slice (a degenerate content state that must be rejected before any DB write).
///
/// KILLS: a recheck seam that always returns Ok regardless of input (would allow an
/// empty content registry to wipe the live DB's species table with no rows).
#[test]
fn sync_content_inner_recheck_rejects_empty_species() {
    let evolutions = game_core::load_evolutions().expect("evolutions must parse");

    // Empty species slice: this is a degenerate content state.
    let result = super::sync_content_inner_recheck(&[], &evolutions);

    assert!(
        result.is_err(),
        "TEETH(12.5b-2 proof-of-teeth): sync_content_inner_recheck with empty species must \
         return Err — an empty registry would wipe all species from the DB and break the game; \
         a recheck that always returns Ok does not protect against empty-content corruption. \
         Kills: recheck seam that accepts any input without validating minimum content size."
    );
}

// ---------------------------------------------------------------------------
// 12.5b-3: compute_evolves_to is called on monster re-derive pass
//
// Criterion: after sync_content_inner with a stale version, monster rows get
// updated stat_hp (re-derived from new base stats), updated evolves_to.
//
// Because sync_content_inner operates on a live DB context (not unit-testable
// here), we test the pure-seam sub-function `recompute_monster_derived_fields`
// which the implementer must expose:
//
//   pub(crate) fn recompute_monster_derived_fields(
//       monster: &mut Monster,
//       species: &SpeciesRow,
//       evolutions: &[EvolutionCondition],
//   )
//
// This seam updates monster.stat_hp (and other stats) + monster.evolves_to in place.
// RED state: the function does not exist yet → compile-RED.
// ---------------------------------------------------------------------------

/// 12.5b-3: after recompute_monster_derived_fields with new species (higher base_hp),
/// the monster's stat_hp must be updated.
///
/// Fixture: species 1 OLD base_hp=45 → monster has stale stat_hp=51.
///          species 1 NEW base_hp=100 → stat_hp must be > 51 after recompute.
///
/// KILLS: an impl that skips re-derivation or only updates the version stamp
///        without touching existing monster rows.
#[test]
fn recompute_monster_derived_fields_updates_stat_hp() {
    let owner = owner_id();

    // Stale monster: stat_hp computed from old base_hp=45.
    let mut monster = make_stale_monster(1, owner, 1);
    let old_stat_hp = monster.stat_hp;
    assert_eq!(
        old_stat_hp, 51,
        "fixture sanity: stale stat_hp must be 51 (base_hp=45, lv=20, IVs=15)"
    );

    // NEW species: same id, but base_hp bumped to 100.
    let new_species = make_species_row(1, 100, 49);

    // No evolution conditions → evolves_to should be None after recompute.
    let evolutions: Vec<EvolutionCondition> = vec![];

    // Call the re-derive seam. RED until implementer adds recompute_monster_derived_fields.
    super::recompute_monster_derived_fields(&mut monster, &new_species, &evolutions);

    // stat_hp must be recomputed from new base_hp=100 at level=20, IVs=15, EVs=0, Hardy.
    // Formula: HP = floor((2*100 + 15) * 20 / 100) + 20 + 10 = floor(215*20/100) + 30 = 43 + 30 = 73.
    // Either way, it must be > 51 (the old value from base_hp=45).
    assert!(
        monster.stat_hp > old_stat_hp,
        "TEETH(12.5b-3): stat_hp must be recomputed from the new species base_hp=100; \
         old stat_hp={}, new stat_hp={}. \
         Kills: impl that does not call derive_stats when re-seeding content.",
        old_stat_hp,
        monster.stat_hp
    );
}

/// 12.5b-3: after recompute_monster_derived_fields, current_hp is clamped to new stat_hp
/// if it was larger (prevents current_hp > max_hp invariant violation).
///
/// Fixture: monster at current_hp=51, new stat_hp after recompute = 40
///          (rare case where base_hp is *reduced* in a content revision).
///
/// KILLS: an impl that does not clamp current_hp, leaving the monster at
///        current_hp=51 > stat_hp=40 — an illegal state the battle engine would reject.
#[test]
fn recompute_monster_derived_fields_clamps_current_hp() {
    let owner = owner_id();

    // Monster at level 5, IVs all 0, EVs all 0, Hardy — low level to get low derived HP.
    let mut monster = Monster {
        monster_id: 2,
        owner_identity: owner,
        species_id: 1,
        nickname: String::new(),
        level: 5,
        xp: 0,
        bond: 50,
        iv_hp: 0,
        iv_attack: 0,
        iv_defense: 0,
        iv_speed: 0,
        iv_sp_attack: 0,
        iv_sp_defense: 0,
        nature_kind: NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        // Stale: computed from OLD high base_hp=200. At L5, IVs=0, EVs=0, Hardy:
        // HP = floor((2*200 + 0) * 5 / 100) + 5 + 10 = floor(2000/100) + 15 = 20 + 15 = 35.
        stat_hp: 35,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 35, // at full HP
        party_slot: 0,
        last_care_at_ms: 0,
        evolves_to: None,
    };

    // NEW species: base_hp drastically REDUCED to 10.
    // New stat_hp at L5, IVs=0, EVs=0, Hardy:
    // HP = floor((2*10 + 0) * 5 / 100) + 5 + 10 = floor(100/100) + 15 = 1 + 15 = 16.
    let new_species = make_species_row(1, 10, 10);
    let evolutions: Vec<EvolutionCondition> = vec![];

    super::recompute_monster_derived_fields(&mut monster, &new_species, &evolutions);

    assert!(
        monster.current_hp <= monster.stat_hp,
        "TEETH(12.5b-3 clamp): current_hp ({}) must be <= new stat_hp ({}) after recompute; \
         an unclamped current_hp violates the HP invariant and would break the battle engine. \
         Kills: impl that updates stat_hp but forgets to clamp current_hp.",
        monster.current_hp,
        monster.stat_hp
    );
}

/// 12.5b-3: after recompute_monster_derived_fields, evolves_to is recomputed via
/// compute_evolves_to (not left as a stale None when the monster now meets a threshold).
///
/// Fixture: monster at level=20 was seeded when no evolution existed (evolves_to=None).
///          After a content revision adding Level(20)→species 2, the re-derive pass
///          must set evolves_to=Some(2).
///
/// KILLS: an impl that updates stats but does not call compute_evolves_to, leaving
///        evolves_to as None even when the monster is now eligible.
#[test]
fn recompute_monster_derived_fields_updates_evolves_to() {
    let owner = owner_id();
    let mut monster = make_stale_monster(3, owner, 1); // evolves_to=None (stale)

    let new_species = make_species_row(1, 45, 49); // same base stats (no stat change)

    // NEW evolution condition: Level(20) → species 2.
    // Monster is level 20 — exactly at threshold — so evolves_to must become Some(2).
    let evolutions = vec![EvolutionCondition {
        trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
        to_species: 2,
    }];

    super::recompute_monster_derived_fields(&mut monster, &new_species, &evolutions);

    assert_eq!(
        monster.evolves_to,
        Some(2),
        "TEETH(12.5b-3 evolves_to): after recompute, evolves_to must be Some(2) because \
         the monster (level=20) meets the new Level(20) evolution threshold; \
         was None (stale). \
         Kills: impl that updates stats but skips the compute_evolves_to call."
    );
}

/// 12.5b-3 proof-of-teeth: a monster below the evolution threshold must remain
/// evolves_to=None after recompute (does not accidentally gain an evolves_to).
///
/// KILLS: a recompute impl that sets evolves_to unconditionally (always Some or
///        always clones from the evolutions list without checking eligibility).
#[test]
fn recompute_monster_derived_fields_does_not_set_evolves_to_for_ineligible() {
    let owner = owner_id();
    let mut monster = make_stale_monster(4, owner, 1); // level=20
    monster.evolves_to = None;

    let new_species = make_species_row(1, 45, 49);

    // Evolution requires Level(30) — monster is level=20 (below threshold).
    let evolutions = vec![EvolutionCondition {
        trigger: EvolutionTrigger::Level(Level::new(30).unwrap()),
        to_species: 2,
    }];

    super::recompute_monster_derived_fields(&mut monster, &new_species, &evolutions);

    assert_eq!(
        monster.evolves_to, None,
        "TEETH(12.5b-3 proof-of-teeth): monster at level=20 does NOT meet Level(30) threshold; \
         evolves_to must remain None after recompute. \
         Kills: impl that sets evolves_to=Some(first_entry) without checking eligibility."
    );
}

// ---------------------------------------------------------------------------
// Direct compute_evolves_to re-use as oracle for 12.5b-3
//
// These tests ensure compute_evolves_to itself (the function recompute_monster_derived_fields
// must delegate to) handles edge cases that are specific to the sync_content re-derive path.
// ---------------------------------------------------------------------------

/// 12.5b-3 oracle: compute_evolves_to called with a Bond threshold checks the monster's
/// bond, not just level. After a content revision adding a Bond-based evolution, a monster
/// with sufficient bond must get evolves_to = Some(target).
///
/// KILLS: a recompute impl that only calls the level-branch of compute_evolves_to and
///        ignores bond-based conditions added in content revisions.
#[test]
fn compute_evolves_to_handles_bond_trigger_in_recompute_path() {
    let owner = owner_id();

    // Monster: level=10, bond=100. Below any typical Level threshold, but high bond.
    let monster = Monster {
        monster_id: 5,
        owner_identity: owner,
        species_id: 1,
        nickname: String::new(),
        level: 10,
        xp: 0,
        bond: 100,
        iv_hp: 0,
        iv_attack: 0,
        iv_defense: 0,
        iv_speed: 0,
        iv_sp_attack: 0,
        iv_sp_defense: 0,
        nature_kind: NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: 30,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 30,
        party_slot: 0,
        last_care_at_ms: 0,
        evolves_to: None,
    };

    // New content: Bond(50) → species 3. Monster has bond=100 ≥ 50 → eligible.
    let evolutions = vec![EvolutionCondition {
        trigger: EvolutionTrigger::Bond(Bond::new(50)),
        to_species: 3,
    }];

    let result = compute_evolves_to(&evolutions, &monster);

    assert_eq!(
        result,
        Some(3),
        "TEETH(12.5b-3 bond trigger): compute_evolves_to with Bond(50) trigger and monster \
         bond=100 must return Some(3); after a content revision adding this evolution, \
         the re-derive pass must pick it up. \
         Kills: a recompute impl that only checks level-based triggers."
    );
}

// ===========================================================================
// M13.5c gating tests — content lifecycle completion.
//
// EARS 13.5c-2: WHEN a zone is removed from the zone RON, sync_content must
//   delete its zone_def row AND no movement_tick_schedule row for that zone
//   remains after the sync.
// EARS 13.5c-4: the zero-owner-identity Err path in `sync_content` (lib.rs)
//   must prescribe the ONLY working remedy (`spacetime publish --delete-data`)
//   and must NOT keep the impossible "re-publish to register" prescription
//   (init only runs at DB creation; a plain re-publish never re-registers).
//
// RED state (2026-07-05):
//   - `super::stale_zone_def_ids` and `crate::plan_schedule_reconcile` do not
//     exist → this module fails to COMPILE (valid RED per the m7b convention:
//     compile-fail on a missing seam is red-for-the-right-reason).
//   - The two source-guards below are assertion-RED once the seams compile:
//     lib.rs still says "re-publish to register", and sync_content_inner
//     neither calls stale_zone_def_ids nor deletes zone_def rows.
//
// NOTE on the spec's type name: the plan says `loaded: &[Zone]`, but game-core
// has no `Zone` struct — the type `game_core::load_zones()` returns is
// `game_core::ZoneDef` (id/name/width/height). These tests target ZoneDef so
// the seam plugs into sync_content_inner's real load path without an adapter
// (correction strengthens the bite; a phantom-`Zone` seam could never be wired).
// ===========================================================================

/// Minimal loaded-zone fixture (shape of what `load_zones()` yields).
fn m13_5c_zone(id: u32) -> game_core::ZoneDef {
    game_core::ZoneDef {
        id,
        name: format!("TestZone{id}"),
        width: 8,
        height: 8,
    }
}

/// 13.5c-2: a zone_id present in the DB (`existing`) but absent from the
/// loaded RON must be reported stale.
///
/// KILLS: the current implementation shape (upsert-only seeding loop) — with
/// no diff seam at all this module does not compile; a seam that returns
/// only additions (or always-empty) fails the assert_eq.
#[test]
fn m13_5c_stale_zone_def_ids_detects_removed_zone() {
    let existing: Vec<u32> = vec![1, 2, 3];
    let loaded = vec![m13_5c_zone(1), m13_5c_zone(3)]; // zone 2 removed from RON

    let stale = super::stale_zone_def_ids(&existing, &loaded);

    assert_eq!(
        stale,
        vec![2u32],
        "TEETH(13.5c-2): zone 2 exists in the DB but not in the loaded RON — \
         stale_zone_def_ids must return exactly [2]; an upsert-only sync \
         (no set-difference) never reports it and the dead zone_def row \
         survives forever"
    );
}

/// 13.5c-2: identical sets (regardless of order) → nothing is stale.
///
/// KILLS: an order-sensitive diff (e.g. positional zip of the two lists) —
/// `loaded` is deliberately shuffled relative to `existing`, so a positional
/// comparison reports phantom staleness and deletes a LIVE zone.
#[test]
fn m13_5c_stale_zone_def_ids_identical_sets_yield_empty() {
    let existing: Vec<u32> = vec![1, 2, 3];
    let loaded = vec![m13_5c_zone(3), m13_5c_zone(1), m13_5c_zone(2)]; // shuffled

    let stale = super::stale_zone_def_ids(&existing, &loaded);

    assert!(
        stale.is_empty(),
        "TEETH(13.5c-2): identical id sets (order-independent) must yield an \
         empty stale list; got {stale:?} — a positional diff would delete a \
         live zone's row"
    );
}

/// 13.5c-2: output is sorted ascending (deterministic reducer behavior —
/// HashSet iteration order must not leak into the delete sequence).
///
/// KILLS: an impl that collects the set difference straight out of a
/// HashSet iterator (nondeterministic order) or preserves `existing`'s
/// insertion order (9, 2, 7 here) without sorting.
#[test]
fn m13_5c_stale_zone_def_ids_output_sorted_ascending() {
    let existing: Vec<u32> = vec![9, 2, 7, 5];
    let loaded = vec![m13_5c_zone(7)]; // only zone 7 survives in RON

    let stale = super::stale_zone_def_ids(&existing, &loaded);

    assert_eq!(
        stale,
        vec![2u32, 5, 9],
        "TEETH(13.5c-2 determinism): stale ids must come back sorted \
         ascending [2, 5, 9]; unsorted output makes the delete sequence \
         (and any downstream logging/replay) nondeterministic"
    );
}

// ---------------------------------------------------------------------------
// 13.5c-2: plan_schedule_reconcile — pure extraction of ensure_zone_schedules'
// diff logic (lib.rs) so "no schedule row remains for a removed zone" is an
// honest behavioral test, not a structural one.
//
// Contract: `crate::plan_schedule_reconcile(zone_ids: &[u32],
//   scheduled: &[(u64, u32)]) -> (Vec<u64>, Vec<u32>)`
// where `scheduled` is (schedule row id, zone_id) pairs; returns
// (schedule row ids to remove, zone ids to add).
// ---------------------------------------------------------------------------

/// 13.5c-2 composed EARS scenario: zone 2's zone_def was removed → its
/// schedule row (id=11) must be planned for removal, and applying the plan
/// leaves NO schedule row pointing at zone 2.
///
/// KILLS: an insert-only reconcile (to_remove always empty) — row (11, 2)
/// then survives the sync and fires `map_for` errors every tick forever.
#[test]
fn m13_5c_plan_schedule_reconcile_removes_row_for_deleted_zone() {
    // Post-sync surviving zones: 1 and 3 (zone 2's zone_def was deleted).
    let zone_ids: Vec<u32> = vec![1, 3];
    let scheduled: Vec<(u64, u32)> = vec![(10, 1), (11, 2), (12, 3)];

    let (to_remove, to_add) = crate::plan_schedule_reconcile(&zone_ids, &scheduled);

    assert_eq!(
        to_remove,
        vec![11u64],
        "TEETH(13.5c-2): zone 2 is gone from zone_ids while schedule row 11 \
         targets it — to_remove must be exactly [11]; an insert-only \
         reconcile leaves the orphan ticking"
    );
    assert!(
        to_add.is_empty(),
        "no zone is missing a schedule row here; got to_add={to_add:?}"
    );

    // Derive the EARS postcondition: after applying the plan, no schedule
    // row for zone 2 remains.
    let surviving: Vec<&(u64, u32)> = scheduled
        .iter()
        .filter(|(row_id, _)| !to_remove.contains(row_id))
        .collect();
    assert!(
        surviving.iter().all(|(_, zone_id)| *zone_id != 2),
        "TEETH(13.5c-2 postcondition): applying the plan must leave zero \
         schedule rows for removed zone 2; survivors: {surviving:?}"
    );
}

/// 13.5c-2: a zone present in zone_ids but with no schedule row must be
/// planned for addition.
///
/// KILLS: a remove-only (or vacuous empty-plan) reconcile — a newly added
/// zone would never get a movement tick and its NPCs would freeze.
#[test]
fn m13_5c_plan_schedule_reconcile_adds_unscheduled_zone() {
    let zone_ids: Vec<u32> = vec![1, 2];
    let scheduled: Vec<(u64, u32)> = vec![(10, 1)]; // zone 2 has no row yet

    let (to_remove, to_add) = crate::plan_schedule_reconcile(&zone_ids, &scheduled);

    assert_eq!(
        to_add,
        vec![2u32],
        "TEETH(13.5c-2): zone 2 exists but is unscheduled — to_add must be \
         exactly [2] or the new zone never ticks"
    );
    assert!(
        to_remove.is_empty(),
        "no schedule row is orphaned here; got to_remove={to_remove:?}"
    );
}

/// 13.5c-2 idempotence: steady state (every zone scheduled exactly once,
/// no orphans) → both plan halves empty.
///
/// KILLS: a churn reconcile (delete-all + reinsert-all every sync) — that
/// would mint new schedule row ids and reset every zone's tick interval on
/// each sync_content call.
#[test]
fn m13_5c_plan_schedule_reconcile_steady_state_is_empty() {
    let zone_ids: Vec<u32> = vec![1, 2];
    let scheduled: Vec<(u64, u32)> = vec![(10, 1), (11, 2)];

    let (to_remove, to_add) = crate::plan_schedule_reconcile(&zone_ids, &scheduled);

    assert!(
        to_remove.is_empty() && to_add.is_empty(),
        "TEETH(13.5c-2 idempotence): steady state must produce an empty plan; \
         got to_remove={to_remove:?}, to_add={to_add:?} — a non-empty plan \
         here means delete+reinsert churn on every sync"
    );
}

// ---------------------------------------------------------------------------
// M13.5c source-guards (strip + fn-window idiom, mirroring content.rs::tests).
// Helpers are duplicated locally (same as raising_tests.rs) because the
// inline `content.rs::tests` module is not importable from here.
// ---------------------------------------------------------------------------

const M13_5C_LIB_RS_SOURCE: &str = include_str!("lib.rs");
const M13_5C_CONTENT_RS_SOURCE: &str = include_str!("content.rs");

/// Strip Rust block + line comments, preserving byte positions (spaces).
/// Local mirror of content.rs::tests::strip_rust_comments.
fn m13_5c_strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Extract the body of the fn whose declaration starts with `fn_needle`
/// (fn-find + brace-walk, the content.rs:616 / lib.rs-guard idiom).
fn m13_5c_fn_body<'a>(stripped: &'a str, fn_needle: &str) -> &'a str {
    let fn_pos = stripped
        .find(fn_needle)
        .unwrap_or_else(|| panic!("fn declaration `{fn_needle}` must exist in the source"));
    let after = &stripped[fn_pos..];
    let brace_offset = after.find('{').expect("fn must have a body");
    let body_start = fn_pos + brace_offset + 1;
    let mut depth: usize = 1;
    let mut end = stripped.len();
    for (i, ch) in stripped[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    &stripped[body_start..end]
}

/// EARS 13.5c-4: the zero-owner-identity Err path in `sync_content` must
/// prescribe the working remedy: `spacetime publish --delete-data`.
///
/// KILLS: keeping (or rewording) the error without the only actionable
/// instruction — `init` runs solely at DB creation, so a message lacking
/// `--delete-data` leaves the operator with no working recovery path.
/// RED today: lib.rs's Err string has no `--delete-data`.
#[test]
fn m13_5c_sync_content_zero_identity_err_prescribes_delete_data() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_LIB_RS_SOURCE);
    // Needle matches the reducer, not sync_content_inner (the `(ctx:` suffix
    // excludes the `_inner` name). Same needle shape as the 12.5b-1 guard.
    let body = m13_5c_fn_body(&stripped, "pub fn sync_content(ctx:");

    assert!(
        body.contains("--delete-data"),
        "TEETH(13.5c-4): the zero-owner_identity Err path in sync_content \
         must name `spacetime publish --delete-data` — the ONLY operation \
         that re-runs `init` and re-registers the owner; a plain re-publish \
         never does. The string literal in the fn body must contain \
         `--delete-data`."
    );
}

/// EARS 13.5c-4 (negative): the impossible prescription must be GONE.
///
/// KILLS: the current lib.rs Err string ("...re-publish to register the
/// owner") — following it re-publishes without --delete-data, init never
/// re-runs, owner_identity stays zero, and sync_content fails identically
/// forever. RED today: the fragment is present verbatim.
#[test]
fn m13_5c_sync_content_zero_identity_err_drops_republish_claim() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_LIB_RS_SOURCE);
    let body = m13_5c_fn_body(&stripped, "pub fn sync_content(ctx:");

    assert!(
        !body.contains("re-publish to register"),
        "TEETH(13.5c-4): sync_content's Err string still claims a plain \
         re-publish registers the owner — that is false (init only runs at \
         DB creation). Remove the `re-publish to register` prescription \
         from the string (and fix the adjacent comment to match)."
    );
}

/// EARS 13.5c-2 source-guard: `sync_content_inner`'s write phase must call
/// the pure `stale_zone_def_ids` seam AND actually delete the stale rows
/// via `ctx.db.zone_def().zone_id().delete(..)`.
///
/// Windowed to the fn body (fn-find + brace-walk) so mentions elsewhere in
/// content.rs (including the seam's own definition) cannot false-green.
/// Whitespace is compacted before matching so rustfmt line-wrapping of the
/// accessor chain cannot false-red.
///
/// KILLS (needle 1): an impl that inlines ad-hoc diff logic in the shell
/// instead of the unit-tested pure seam — the behavioral tests above would
/// then be testing dead code.
/// KILLS (needle 2): an impl that computes stale ids but never issues the
/// delete (call without write), or deletes from the wrong table — the dead
/// zone_def row would survive and keep the zone joinable.
/// RED today: neither the seam nor any zone_def delete exists in the body.
#[test]
fn m13_5c_sync_content_inner_deletes_stale_zone_defs() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    let body = m13_5c_fn_body(&stripped, "fn sync_content_inner(ctx");
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();

    assert!(
        compact.contains("stale_zone_def_ids("),
        "TEETH(13.5c-2): sync_content_inner must compute stale zones via the \
         pure `stale_zone_def_ids(` seam (production call inside the fn \
         body) — ad-hoc shell diff logic bypasses the unit-tested rule"
    );
    assert!(
        compact.contains("zone_def().zone_id().delete("),
        "TEETH(13.5c-2): sync_content_inner must delete stale zone_def rows \
         (`ctx.db.zone_def().zone_id().delete(..)`); computing the stale set \
         without the delete leaves removed zones live in the DB"
    );
}
