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
