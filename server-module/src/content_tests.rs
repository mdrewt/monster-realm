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
//!     re-derive seam) exists yet. (The `compute_evolves_to`/`evolves_to` model
//!     was deleted at EG1/ADR-0174 D2 and the column removed by Migration B —
//!     EG5-6/ADR-0177 D2.)
//!
//! EARS criteria covered:
//!   - 12.5b-2: `sync_content_inner` returns Result; a validation failure at ANY
//!     registry means no DB writes occur (txn atomic / load-all before write-all).
//!   - 12.5b-3: after `sync_content_inner` with a stale version, monster rows
//!     get updated stats (re-derived from new base stats).
//!
//! Pattern: these tests call the pure-seam helpers exposed by the implementation
//! and verify concrete state changes. No SpacetimeDB live context is used.

// EG1 mechanical migration (ADR-0174): `compute_evolves_to`, `EvolutionCondition`
// and `EvolutionTrigger` were deleted with the essence-graph redesign, so the
// imports (and the tests whose sole subject they were) are gone — see the
// deletion notes inline below.
use crate::schema::{Monster, SpeciesRow};
use game_core::NatureKind;
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
        ability: None,
        tier: 0,
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
        // EG1 Migration A columns at creation defaults (compiler-forced append).
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
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
    // EG1 mechanical migration: load_evolutions -> load_evolution_paths.
    let species = game_core::load_species().expect("species must parse for this test");
    let paths = game_core::load_evolution_paths().expect("evolution paths must parse");

    // Call the pure validation seam. RED until `sync_content_inner_recheck` exists.
    // The seam takes loaded registries and returns Result<(), String> for the
    // validation phase — no DB writes occur.
    let result = super::sync_content_inner_recheck(&species, &paths);

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
    // EG1 mechanical migration: load_evolutions -> load_evolution_paths.
    let paths = game_core::load_evolution_paths().expect("evolution paths must parse");

    // Empty species slice: this is a degenerate content state.
    let result = super::sync_content_inner_recheck(&[], &paths);

    assert!(
        result.is_err(),
        "TEETH(12.5b-2 proof-of-teeth): sync_content_inner_recheck with empty species must \
         return Err — an empty registry would wipe all species from the DB and break the game; \
         a recheck that always returns Ok does not protect against empty-content corruption. \
         Kills: recheck seam that accepts any input without validating minimum content size."
    );
}

// ---------------------------------------------------------------------------
// 12.5b-3: monster re-derive pass (historical: originally also refreshed the
// `evolves_to` hint — that model was deleted at EG1/ADR-0174 D2 and the column
// removed by Migration B, EG5-6/ADR-0177 D2)
//
// Criterion: after sync_content_inner with a stale version, monster rows get
// updated stat_hp (re-derived from new base stats).
//
// Because sync_content_inner operates on a live DB context (not unit-testable
// here), we test the pure-seam sub-function `recompute_monster_derived_fields`:
//
//   pub(crate) fn recompute_monster_derived_fields(
//       monster: &mut Monster,
//       species: &SpeciesRow,
//   )
//
// This seam updates monster.stat_hp (and other stats) in place.
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

    // Call the re-derive seam. RED until implementer adds recompute_monster_derived_fields.
    // EG1 mechanical migration: the evolutions parameter is gone (ADR-0174 D2).
    super::recompute_monster_derived_fields(&mut monster, &new_species);

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
        // EG1 Migration A columns at creation defaults (compiler-forced append).
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    };

    // NEW species: base_hp drastically REDUCED to 10.
    // New stat_hp at L5, IVs=0, EVs=0, Hardy:
    // HP = floor((2*10 + 0) * 5 / 100) + 5 + 10 = floor(100/100) + 15 = 1 + 15 = 16.
    let new_species = make_species_row(1, 10, 10);

    // EG1 mechanical migration: the evolutions parameter is gone (ADR-0174 D2).
    super::recompute_monster_derived_fields(&mut monster, &new_species);

    assert!(
        monster.current_hp <= monster.stat_hp,
        "TEETH(12.5b-3 clamp): current_hp ({}) must be <= new stat_hp ({}) after recompute; \
         an unclamped current_hp violates the HP invariant and would break the battle engine. \
         Kills: impl that updates stat_hp but forgets to clamp current_hp.",
        monster.current_hp,
        monster.stat_hp
    );
}

// (EG1/ADR-0174 D2 deleted the evolves_to recompute tests with their subject;
// Migration B — EG5-6/ADR-0177 D2 — then removed the frozen column itself, and
// the ineligible-stays-None fence went with it.)

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
    // Built with concat! so this test file never contains the contiguous
    // substring `fn sync_content(`: zone-warp-server-runtime.eval.mjs
    // extracts the FIRST such match over the sorted concatenation of the
    // server sources, and content_tests.rs sorts before lib.rs — a plain
    // literal here would shadow the real reducer body. (Do not write a
    // block-comment opener or a double-star glob in comments here: the
    // eval strippers remove block comments before line comments, so such
    // a token inside a line comment swallows every later source file.)
    let body = m13_5c_fn_body(&stripped, concat!("pub fn sync_content", "(ctx:"));

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
    // concat! needle: see the sibling test above for why this file must not
    // contain the contiguous substring `fn sync_content(`.
    let body = m13_5c_fn_body(&stripped, concat!("pub fn sync_content", "(ctx:"));

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
/// from the `zone_def` table.
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
///
/// NOTE on needle 2 form (Finding 4 / red-team MEDIUM): the original needle
/// `zone_def().zone_id().delete(` over-couples to the pk-index accessor chain;
/// the equally-correct row-delete form `zone_def().delete(&row)` would
/// false-RED it. Two loose needles (`zone_def()` present AND `.delete(`
/// present in the same compacted window) are sufficient — the behavioral
/// tests own semantics; this needle only guards wiring existence.
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
    // Two-part needle: zone_def() accessor present AND a .delete( call present
    // within the same fn body. The loose form accepts both the pk-index form
    // `zone_def().zone_id().delete(..)` AND the row-delete form
    // `zone_def().delete(&row)` — both are correct; the behavioral tests own
    // the semantics (the needle only checks that the delete is wired at all).
    assert!(
        compact.contains("zone_def()"),
        "TEETH(13.5c-2): sync_content_inner must access the zone_def table \
         (`ctx.db.zone_def()`) to delete stale rows; the accessor is absent \
         from the fn body — the dead zone_def row would survive after sync"
    );
    assert!(
        compact.contains(".delete("),
        "TEETH(13.5c-2): sync_content_inner must issue a `.delete(` call \
         within its body — computing stale ids without deleting leaves removed \
         zones live in the DB"
    );
}

// ---------------------------------------------------------------------------
// M13.5c T4 — `plan_npc_sync` planner tests (EARS 13.5c-1, tester RED phase).
//
// EXPECTED CONTRACT (compile-RED today: E0432 on the import below until
// content.rs supplies the planner — the repo's accepted red convention):
//
//   pub(crate) enum NpcSyncAction {
//       Insert { npc: Npc, character: Character },
//       Update { entity_id: u64, npc: Npc, character: Character },
//       Remove { entity_id: u64, npc_id: String },
//       Repair { entity_id: u64, npc: Npc, character: Character },
//   }
//   pub(crate) type NpcSyncPlan = Vec<NpcSyncAction>;
//   pub(crate) fn plan_npc_sync(
//       existing: &[(Npc, Option<Character>)],
//       defs: &[game_core::NpcDef],
//   ) -> NpcSyncPlan
//
// Semantics bound by docs/specs/m13.5c-plan.md §T4 + the binding review folds:
//   - deterministic: actions sorted by npc_id;
//   - actions carry COMPLETE replacement Npc/Character row values (fold n1 —
//     the shell is a pure apply fold, no patch interpretation);
//   - Update preserves entity_id (NEVER delete+reinsert: auto_inc would
//     orphan player_conversation.npc_entity_id + break client identity);
//   - zone SAME -> tile/facing/action/queue/move_started_at_ms preserved
//     verbatim; zone CHANGED -> respawn at def spawn, facing South, Idle,
//     cleared queue, move_started_at_ms 0; character sprite_id = def always;
//   - half-orphan (Npc, None) -> Repair = delete orphan npc row + fresh
//     insert (fold M1+RT-6); never a bare Insert (unique npc_id panic),
//     never silently skipped;
//   - identical existing<->defs -> EMPTY plan (idempotence). Live wander
//     state (tile/facing/queue/timestamps) is NOT a diff: sync_content runs
//     on every content-version bump and NPCs wander constantly, so diffing
//     live state would churn every sync.
//
// Correction log: every expected value below derives from spec section T4 and
// its review folds; none were fitted to an implementation.
// ---------------------------------------------------------------------------

use crate::content::{plan_npc_sync, NpcSyncAction, NpcSyncPlan};
use crate::schema::{Character, Npc};
use game_core::{ActionState, Direction, MoveInput, NpcDef};

/// Def fixture: spawn == home, radius 3, tree "tree_<npc_id>", sprite 7.
fn m13_5c_npc_def(id: u32, npc_id: &str, zone_id: u32, spawn: (i32, i32)) -> NpcDef {
    NpcDef {
        id,
        npc_id: npc_id.to_string(),
        zone_id,
        spawn_x: spawn.0,
        spawn_y: spawn.1,
        home_x: spawn.0,
        home_y: spawn.1,
        wander_radius: 3,
        dialogue_tree_id: format!("tree_{npc_id}"),
        sprite_id: 7,
        interaction: game_core::NpcInteraction::Dialogue,
    }
}

/// The (Npc, Character) pair the production seed derives from a def —
/// mirrors content.rs seeding: spawn tile, facing South, Idle, empty queue,
/// move_started_at_ms 0, sprite from def. (Npc/Character have no Clone;
/// fixtures are constructed fresh.)
fn m13_5c_pair_from_def(def: &NpcDef, entity_id: u64) -> (Npc, Character) {
    (
        Npc {
            entity_id,
            npc_id: def.npc_id.clone(),
            zone_id: def.zone_id,
            home_x: def.home_x,
            home_y: def.home_y,
            wander_radius: def.wander_radius,
            dialogue_tree_id: def.dialogue_tree_id.clone(),
            interaction: def.interaction,
        },
        Character {
            entity_id,
            zone_id: def.zone_id,
            tile_x: def.spawn_x,
            tile_y: def.spawn_y,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: def.sprite_id,
            move_queue: vec![],
        },
    )
}

/// Diagnostic tag (also the exhaustive declaration of the expected variants).
fn m13_5c_action_kind(a: &NpcSyncAction) -> &'static str {
    match a {
        NpcSyncAction::Insert { .. } => "Insert",
        NpcSyncAction::Update { .. } => "Update",
        NpcSyncAction::Remove { .. } => "Remove",
        NpcSyncAction::Repair { .. } => "Repair",
    }
}

/// npc_id an action is keyed on — used to assert deterministic plan order.
fn m13_5c_action_npc_id(a: &NpcSyncAction) -> &str {
    match a {
        NpcSyncAction::Insert { npc, .. } => &npc.npc_id,
        NpcSyncAction::Update { npc, .. } => &npc.npc_id,
        NpcSyncAction::Remove { npc_id, .. } => npc_id,
        NpcSyncAction::Repair { npc, .. } => &npc.npc_id,
    }
}

/// TRIVIAL apply fold (review fold n3: this must never grow logic). It only
/// mirrors the DB constraints the shell hits:
///   - insert mints entity_ids sequentially (auto_inc mirror; 1,2,... on an
///     empty world) and PANICS on a duplicate npc_id (`#[unique]` mirror —
///     this is the teeth that kills a bare-Insert "repair");
///   - Update requires a live (Npc, Some(Character)) target (a character
///     update has no row to hit on a half-orphan);
///   - Remove drops the pair; Repair drops the orphan then inserts fresh.
fn m13_5c_apply_npc_plan(
    mut existing: Vec<(Npc, Option<Character>)>,
    plan: NpcSyncPlan,
) -> Vec<(Npc, Option<Character>)> {
    let mut next_id: u64 = existing.iter().map(|(n, _)| n.entity_id).max().unwrap_or(0) + 1;
    for action in plan {
        match action {
            NpcSyncAction::Insert {
                mut npc,
                mut character,
            } => {
                assert!(
                    existing.iter().all(|(n, _)| n.npc_id != npc.npc_id),
                    "bare Insert of already-present npc_id `{}` — production \
                     `#[unique]` npc_id index panics here",
                    npc.npc_id
                );
                npc.entity_id = next_id;
                character.entity_id = next_id;
                next_id += 1;
                existing.push((npc, Some(character)));
            }
            NpcSyncAction::Update {
                entity_id,
                npc,
                character,
            } => {
                let idx = existing
                    .iter()
                    .position(|(n, _)| n.entity_id == entity_id)
                    .unwrap_or_else(|| panic!("Update targets unknown entity_id {entity_id}"));
                assert!(
                    existing[idx].1.is_some(),
                    "Update targets half-orphan entity_id {entity_id} — \
                     production has no character row to update; the planner \
                     must emit Repair (or Remove+Insert) instead"
                );
                existing[idx] = (npc, Some(character));
            }
            NpcSyncAction::Remove {
                entity_id,
                npc_id: _,
            } => {
                existing.retain(|(n, _)| n.entity_id != entity_id);
            }
            NpcSyncAction::Repair {
                entity_id,
                mut npc,
                mut character,
            } => {
                existing.retain(|(n, _)| n.entity_id != entity_id);
                npc.entity_id = next_id;
                character.entity_id = next_id;
                next_id += 1;
                existing.push((npc, Some(character)));
            }
        }
    }
    existing
}

/// EARS 13.5c-1 (core): sync twice with changed RON — first plan seeds, the
/// re-plan upserts changed defs, removes dropped ones, inserts new ones, all
/// in deterministic npc_id order, with complete replacement rows.
///
/// KILLS: the current insert-only seeding (`find(npc_id).is_some() ->
/// continue`) — under it the changed def "alpha" yields NO Update (stale
/// home/dialogue/sprite persist forever) and the dropped def "bravo" yields
/// NO Remove (ghost NPC): the exact 3-action plan asserted here catches
/// both. Also KILLS delete+reinsert-as-upsert: the Update must carry alpha's
/// ORIGINAL entity_id (1) and preserve its live tile (20,21)/facing/queue —
/// a reinsert mints a new entity_id and lands back on the spawn tile.
#[test]
fn m13_5c_plan_npc_sync_twice_with_changed_ron_upserts_and_removes() {
    let def_a = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let def_b = m13_5c_npc_def(2, "bravo", 1, (15, 16));

    // Sync #1 from an empty world; defs passed UNSORTED to prove ordering.
    let plan1: NpcSyncPlan = plan_npc_sync(&[], &[def_b.clone(), def_a.clone()]);
    let kinds1: Vec<&str> = plan1.iter().map(m13_5c_action_kind).collect();
    assert_eq!(
        kinds1,
        vec!["Insert", "Insert"],
        "TEETH(13.5c-1): empty world + 2 defs must plan exactly 2 Inserts"
    );
    let ids1: Vec<&str> = plan1.iter().map(m13_5c_action_npc_id).collect();
    assert_eq!(
        ids1,
        vec!["alpha", "bravo"],
        "TEETH(13.5c-1 determinism): plan must be npc_id-sorted even though \
         defs arrived as [bravo, alpha]"
    );
    match &plan1[0] {
        NpcSyncAction::Insert { npc, character } => {
            assert_eq!(npc.npc_id, "alpha");
            assert_eq!((npc.home_x, npc.home_y), (10, 11));
            assert_eq!(npc.wander_radius, 3);
            assert_eq!(npc.dialogue_tree_id, "tree_alpha");
            assert_eq!((character.tile_x, character.tile_y), (10, 11));
            assert_eq!(character.zone_id, 1);
            assert_eq!(character.facing, Direction::South);
            assert_eq!(character.action, ActionState::Idle);
            assert_eq!(character.move_started_at_ms, 0);
            assert!(character.move_queue.is_empty());
            assert_eq!(character.sprite_id, 7);
        }
        other => panic!(
            "plan1[0]: expected Insert, got {}",
            m13_5c_action_kind(other)
        ),
    }

    // Apply: alpha -> entity 1, bravo -> entity 2 (fold mints 1,2,...).
    let mut world = m13_5c_apply_npc_plan(vec![], plan1);
    assert_eq!(world.len(), 2);
    let alpha_idx = world
        .iter()
        .position(|(n, _)| n.npc_id == "alpha")
        .expect("alpha seeded");
    assert_eq!(world[alpha_idx].0.entity_id, 1, "fold mints 1,2,...");

    // Live wander: alpha's character moved off spawn with in-flight state.
    {
        let ch = world[alpha_idx].1.as_mut().expect("alpha has a character");
        ch.tile_x = 20;
        ch.tile_y = 21;
        ch.facing = Direction::East;
        ch.action = ActionState::Walking;
        ch.move_started_at_ms = 555;
        ch.move_queue = vec![MoveInput::Step(Direction::North), MoveInput::Jump];
    }

    // Changed RON: alpha mutated (dialogue+home+radius+sprite, SAME zone),
    // bravo dropped, charlie added. Defs again unsorted.
    let mut def_a2 = def_a;
    def_a2.dialogue_tree_id = "tree_alpha_v2".to_string();
    def_a2.home_x = 30;
    def_a2.home_y = 31;
    def_a2.wander_radius = 5;
    def_a2.sprite_id = 9;
    let def_c = m13_5c_npc_def(3, "charlie", 1, (50, 51));

    let plan2: NpcSyncPlan = plan_npc_sync(&world, &[def_c.clone(), def_a2]);
    let kinds2: Vec<&str> = plan2.iter().map(m13_5c_action_kind).collect();
    assert_eq!(
        kinds2,
        vec!["Update", "Remove", "Insert"],
        "TEETH(13.5c-1): changed A / dropped B / new C must plan exactly \
         [Update(alpha), Remove(bravo), Insert(charlie)] in npc_id order"
    );

    match &plan2[0] {
        NpcSyncAction::Update {
            entity_id,
            npc,
            character,
        } => {
            assert_eq!(*entity_id, 1, "Update preserves alpha's entity_id");
            assert_eq!(npc.entity_id, 1, "replacement npc row keeps entity_id");
            assert_eq!(npc.npc_id, "alpha");
            // New def-derived values on the npc row.
            assert_eq!((npc.home_x, npc.home_y), (30, 31));
            assert_eq!(npc.wander_radius, 5);
            assert_eq!(npc.dialogue_tree_id, "tree_alpha_v2");
            assert_eq!(npc.zone_id, 1);
            // Live character state preserved verbatim (same zone) ...
            assert_eq!(character.entity_id, 1);
            assert_eq!((character.tile_x, character.tile_y), (20, 21));
            assert_eq!(character.facing, Direction::East);
            assert_eq!(character.action, ActionState::Walking);
            assert_eq!(character.move_started_at_ms, 555);
            assert_eq!(
                character.move_queue,
                vec![MoveInput::Step(Direction::North), MoveInput::Jump]
            );
            // ... except sprite_id, which always takes the def.
            assert_eq!(character.sprite_id, 9, "sprite_id = NEW def value");
        }
        other => panic!(
            "plan2[0]: expected Update, got {}",
            m13_5c_action_kind(other)
        ),
    }
    match &plan2[1] {
        NpcSyncAction::Remove { entity_id, npc_id } => {
            assert_eq!(*entity_id, 2, "Remove(bravo) carries bravo's entity_id");
            assert_eq!(npc_id, "bravo");
        }
        other => panic!(
            "plan2[1]: expected Remove, got {}",
            m13_5c_action_kind(other)
        ),
    }
    match &plan2[2] {
        NpcSyncAction::Insert { npc, character } => {
            assert_eq!(npc.npc_id, "charlie");
            assert_eq!((character.tile_x, character.tile_y), (50, 51));
        }
        other => panic!(
            "plan2[2]: expected Insert, got {}",
            m13_5c_action_kind(other)
        ),
    }

    // Final world: {alpha (live tile kept), charlie}; bravo gone.
    let world2 = m13_5c_apply_npc_plan(world, plan2);
    let mut final_ids: Vec<&str> = world2.iter().map(|(n, _)| n.npc_id.as_str()).collect();
    final_ids.sort_unstable();
    assert_eq!(final_ids, vec!["alpha", "charlie"]);
    let (alpha_npc, alpha_ch) = world2
        .iter()
        .find(|(n, _)| n.npc_id == "alpha")
        .expect("alpha survives");
    let alpha_ch = alpha_ch.as_ref().expect("alpha keeps its character");
    assert_eq!(alpha_npc.entity_id, 1);
    assert_eq!((alpha_ch.tile_x, alpha_ch.tile_y), (20, 21));
    assert_eq!((alpha_npc.home_x, alpha_npc.home_y), (30, 31));
}

/// EARS 13.5c-1 (zone-change edge): def.zone_id != existing npc.zone_id ->
/// the Update's replacement character RESPAWNS at the new def's spawn tile
/// in the new zone with reset live state.
///
/// KILLS: a preserve-everything Update on zone change — the character would
/// keep tile (20,21) from the OLD zone's map (out-of-map/stranded in the new
/// zone) plus a stale in-flight queue/action that replays movement intents
/// against the wrong collision map.
#[test]
fn m13_5c_plan_npc_sync_zone_change_respawns_at_def_spawn() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, mut ch) = m13_5c_pair_from_def(&def_old, 5);
    ch.tile_x = 20;
    ch.tile_y = 21;
    ch.facing = Direction::East;
    ch.action = ActionState::Walking;
    ch.move_started_at_ms = 555;
    ch.move_queue = vec![MoveInput::Jump];
    let existing = vec![(npc, Some(ch))];

    let mut def_new = m13_5c_npc_def(1, "alpha", 2, (40, 41));
    def_new.dialogue_tree_id = "tree_alpha".to_string(); // only zone/spawn moved

    let plan: NpcSyncPlan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(plan.len(), 1, "zone move is ONE Update, not Remove+Insert");
    match &plan[0] {
        NpcSyncAction::Update {
            entity_id,
            npc,
            character,
        } => {
            assert_eq!(*entity_id, 5, "entity_id preserved across zone change");
            assert_eq!(npc.zone_id, 2, "npc row takes the def zone");
            assert_eq!(character.zone_id, 2);
            assert_eq!(
                (character.tile_x, character.tile_y),
                (40, 41),
                "TEETH(13.5c-1 zone edge): respawn at NEW def spawn tile"
            );
            assert_eq!(character.facing, Direction::South);
            assert_eq!(character.action, ActionState::Idle);
            assert_eq!(character.move_started_at_ms, 0);
            assert!(
                character.move_queue.is_empty(),
                "stale movement intents must not replay in the new zone"
            );
        }
        other => panic!("expected Update, got {}", m13_5c_action_kind(other)),
    }
}

/// EARS 13.5c-1 ("preserving live tile position"): def changed but zone SAME
/// -> tile/facing/action/queue/move_started_at_ms preserved verbatim.
///
/// Review fold n2 (documented, by design): the new home (90,91) radius 1
/// leaves the live tile (20,21) OUTSIDE the wander radius — convergence from
/// an out-of-radius start is the wander drive's (npc_decide) concern, not
/// sync's; the planner must still preserve the live tile.
///
/// KILLS: a blanket respawn-on-any-def-change planner — every content tweak
/// (a dialogue typo fix) would teleport every live NPC back to spawn
/// mid-conversation.
#[test]
fn m13_5c_plan_npc_sync_same_zone_preserves_live_tile() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, mut ch) = m13_5c_pair_from_def(&def_old, 5);
    ch.tile_x = 20;
    ch.tile_y = 21;
    ch.facing = Direction::East;
    ch.action = ActionState::Walking;
    ch.move_started_at_ms = 555;
    ch.move_queue = vec![MoveInput::Jump];
    let existing = vec![(npc, Some(ch))];

    let mut def_new = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    def_new.home_x = 90;
    def_new.home_y = 91;
    def_new.wander_radius = 1;
    def_new.dialogue_tree_id = "tree_alpha_v2".to_string();

    let plan: NpcSyncPlan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(plan.len(), 1, "same-zone def change is ONE Update");
    match &plan[0] {
        NpcSyncAction::Update {
            entity_id,
            npc,
            character,
        } => {
            assert_eq!(*entity_id, 5);
            assert_eq!((npc.home_x, npc.home_y), (90, 91));
            assert_eq!(npc.wander_radius, 1);
            assert_eq!(npc.dialogue_tree_id, "tree_alpha_v2");
            assert_eq!(
                (character.tile_x, character.tile_y),
                (20, 21),
                "TEETH(13.5c-1): live tile preserved VERBATIM on same-zone change"
            );
            assert_eq!(character.facing, Direction::East);
            assert_eq!(character.action, ActionState::Walking);
            assert_eq!(character.move_started_at_ms, 555);
            assert_eq!(character.move_queue, vec![MoveInput::Jump]);
            assert_eq!(character.sprite_id, 7, "sprite unchanged in this def");
        }
        other => panic!("expected Update, got {}", m13_5c_action_kind(other)),
    }
}

/// EARS 13.5c-1 (idempotence): identical existing<->defs -> EMPTY plan, even
/// when the character has wandered off spawn (live state is not a diff).
///
/// KILLS: a churn planner that diffs live character state (tile/facing/
/// queue/timestamps) or does delete-all+reinsert-all — either would emit a
/// non-empty plan on EVERY content-version bump, minting entity_ids and/or
/// rewriting rows for NPCs whose defs never changed.
#[test]
fn m13_5c_plan_npc_sync_identical_state_yields_empty_plan() {
    let def_a = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let def_b = m13_5c_npc_def(2, "bravo", 1, (15, 16));
    let (npc_a, mut ch_a) = m13_5c_pair_from_def(&def_a, 1);
    // Wandered live state — must NOT count as a diff.
    ch_a.tile_x = 25;
    ch_a.tile_y = 26;
    ch_a.facing = Direction::West;
    ch_a.action = ActionState::Walking;
    ch_a.move_started_at_ms = 999;
    ch_a.move_queue = vec![MoveInput::Jump];
    let (npc_b, ch_b) = m13_5c_pair_from_def(&def_b, 2);
    let existing = vec![(npc_a, Some(ch_a)), (npc_b, Some(ch_b))];

    let plan: NpcSyncPlan = plan_npc_sync(&existing, &[def_a, def_b]);
    assert!(
        plan.is_empty(),
        "TEETH(13.5c-1 idempotence): def-identical world must plan ZERO \
         actions; got {} action(s) [{}] — churn on every version bump",
        plan.len(),
        plan.iter()
            .map(m13_5c_action_kind)
            .collect::<Vec<_>>()
            .join(", ")
    );
}

/// EARS 13.5c-1 + review fold M1/RT-6 (half-orphan repair): existing
/// [(npc X, None)] with X still in defs must plan removal of the orphan npc
/// row PLUS a fresh insert (Repair, or Remove+Insert semantics) — never a
/// bare Insert, never a silent skip.
///
/// KILLS (bare Insert): inserting X while the orphan npc row survives —
/// production's `#[unique]` npc_id index panics; the fold mirrors that
/// panic. KILLS (insert-only skip): `find(npc_id).is_some() -> continue`
/// leaves X's character missing forever — the post-fold Some(character)
/// assertion catches it. KILLS (Update-as-repair): an Update against the
/// orphan has no character row to hit — the removal-of-entity-77 assertion
/// (and the fold's half-orphan guard) reject it.
#[test]
fn m13_5c_plan_npc_sync_half_orphan_repairs_not_bare_insert() {
    let def_x = m13_5c_npc_def(1, "xray", 1, (10, 11));
    let (orphan_npc, _dropped) = m13_5c_pair_from_def(&def_x, 77);
    let existing = vec![(orphan_npc, None)];

    let plan: NpcSyncPlan = plan_npc_sync(&existing, &[def_x]);

    assert!(
        !plan.is_empty(),
        "half-orphan must not be a no-op: X is unapplied"
    );
    let bare_insert = plan.len() == 1 && matches!(&plan[0], NpcSyncAction::Insert { .. });
    assert!(
        !bare_insert,
        "TEETH(13.5c-1 repair): a BARE Insert alone would hit the live \
         `#[unique]` npc_id index (panic) — the orphan npc row must be \
         removed (Repair or Remove+Insert)"
    );
    let removes_orphan = plan.iter().any(|a| match a {
        NpcSyncAction::Remove { entity_id, .. } => *entity_id == 77,
        NpcSyncAction::Repair { entity_id, .. } => *entity_id == 77,
        _ => false,
    });
    assert!(
        removes_orphan,
        "the plan must express deletion of the orphan npc row (entity 77) \
         via Remove or Repair"
    );

    let world = m13_5c_apply_npc_plan(existing, plan);
    assert_eq!(world.len(), 1, "exactly one X pair after repair");
    let (npc, ch) = &world[0];
    assert_eq!(npc.npc_id, "xray");
    let ch = ch
        .as_ref()
        .expect("repair must materialize a fresh character for X");
    assert_eq!(ch.entity_id, npc.entity_id, "pair ids agree after repair");
    assert_ne!(npc.entity_id, 77, "fresh insert mints a new entity_id");
    assert_eq!(
        (ch.tile_x, ch.tile_y),
        (10, 11),
        "fresh character at def spawn"
    );
    assert_eq!(ch.facing, Direction::South);
    assert_eq!(ch.action, ActionState::Idle);
}

/// EARS 13.5c-1 (exhaustive set property): over ALL 8^3 = 512 per-npc
/// scenario combinations (absent / new / dropped / unchanged / changed-same-
/// zone / changed-zone / orphan+def / orphan-no-def x 3 npc_ids), folding
/// the plan over `existing` yields EXACTLY the def npc_id set, each exactly
/// once, every survivor fully paired, and the plan npc_id-sorted.
/// Deterministic exhaustive enumeration — no RNG, no new deps (proptest is
/// already a dev-dep but adds nothing over full enumeration here).
///
/// NOTE on depth (Finding 7): this 512-grid checks the SET-MEMBERSHIP
/// invariant (exactly the def npc_id set survives) and entity_id agreement
/// (pair ids match post-fold). It does NOT re-verify original-value
/// preservation (tile/facing/queue, zone-change reset, Repair fresh-spawn) —
/// those depth checks are owned by the pointwise tests above
/// (m13_5c_plan_npc_sync_same_zone_preserves_live_tile,
///  m13_5c_plan_npc_sync_zone_change_respawns_at_def_spawn,
///  m13_5c_plan_npc_sync_half_orphan_repairs_not_bare_insert).
///
/// KILLS: any planner that drops or duplicates an id in SOME permutation the
/// pointwise tests above don't reach — e.g. remove-processing skipped when
/// defs is empty, orphan-with-no-def leaking through the Remove path, or an
/// Insert emitted alongside an Update for the same id (duplicate in `got`).
#[test]
fn m13_5c_plan_npc_sync_exhaustive_apply_yields_exact_def_set() {
    const IDS: [&str; 3] = ["n_alpha", "n_bravo", "n_charlie"];
    let mut combos = 0u32;
    for sa in 0..8u8 {
        for sb in 0..8u8 {
            for sc in 0..8u8 {
                let scenarios = [sa, sb, sc];
                let mut existing: Vec<(Npc, Option<Character>)> = Vec::new();
                let mut defs: Vec<NpcDef> = Vec::new();
                for (i, (&npc_id, &s)) in IDS.iter().zip(scenarios.iter()).enumerate() {
                    let base = m13_5c_npc_def(i as u32 + 1, npc_id, 1, (10 + i as i32, 20));
                    let entity_id = 100 + i as u64;
                    match s {
                        0 => {}               // absent everywhere
                        1 => defs.push(base), // new def -> Insert
                        2 => {
                            // dropped def -> Remove
                            let (n, c) = m13_5c_pair_from_def(&base, entity_id);
                            existing.push((n, Some(c)));
                        }
                        3 => {
                            // unchanged -> no-op
                            let (n, c) = m13_5c_pair_from_def(&base, entity_id);
                            existing.push((n, Some(c)));
                            defs.push(base);
                        }
                        4 => {
                            // changed, same zone -> Update
                            let (n, c) = m13_5c_pair_from_def(&base, entity_id);
                            existing.push((n, Some(c)));
                            let mut d = base;
                            d.home_x += 5;
                            d.sprite_id = 9;
                            defs.push(d);
                        }
                        5 => {
                            // zone change -> respawn Update
                            let (n, c) = m13_5c_pair_from_def(&base, entity_id);
                            existing.push((n, Some(c)));
                            let mut d = base;
                            d.zone_id = 2;
                            d.spawn_x = 40;
                            d.spawn_y = 41;
                            defs.push(d);
                        }
                        6 => {
                            // half-orphan + def -> Repair
                            let (n, _) = m13_5c_pair_from_def(&base, entity_id);
                            existing.push((n, None));
                            defs.push(base);
                        }
                        7 => {
                            // half-orphan, no def -> Remove
                            let (n, _) = m13_5c_pair_from_def(&base, entity_id);
                            existing.push((n, None));
                        }
                        _ => unreachable!(),
                    }
                }

                let plan: NpcSyncPlan = plan_npc_sync(&existing, &defs);
                let ids_in_plan: Vec<&str> = plan.iter().map(m13_5c_action_npc_id).collect();
                let mut sorted_ids = ids_in_plan.clone();
                sorted_ids.sort_unstable();
                assert_eq!(
                    ids_in_plan, sorted_ids,
                    "combo ({sa},{sb},{sc}): plan must be npc_id-sorted"
                );

                let mut expected: Vec<String> = defs.iter().map(|d| d.npc_id.clone()).collect();
                expected.sort_unstable();
                let result = m13_5c_apply_npc_plan(existing, plan);
                let mut got: Vec<String> = result.iter().map(|(n, _)| n.npc_id.clone()).collect();
                got.sort_unstable();
                assert_eq!(
                    got, expected,
                    "combo ({sa},{sb},{sc}): applied world must be EXACTLY \
                     the def npc_id set, each exactly once"
                );
                for (npc, ch) in &result {
                    let ch = ch.as_ref().unwrap_or_else(|| {
                        panic!(
                            "combo ({sa},{sb},{sc}): `{}` left half-orphaned",
                            npc.npc_id
                        )
                    });
                    assert_eq!(
                        ch.entity_id, npc.entity_id,
                        "combo ({sa},{sb},{sc}): pair ids must agree"
                    );
                }
                combos += 1;
            }
        }
    }
    assert_eq!(combos, 512, "exhaustive grid covered");
}

/// EARS 13.5c-1 source-guard, WINDOWED (review fold m1) to the body of the
/// RENAMED shell `fn sync_npc_entities_from(` via the fn-find + brace-walk
/// idiom — other `continue`s in content.rs are legitimate and must not
/// false-red. RED today: the fn only exists as `seed_npc_entities_from`, so
/// the window lookup itself fails.
///
/// KILLS (needle 1): a shell keeping ad-hoc diff logic instead of the
/// unit-tested `plan_npc_sync(` seam — every behavioral test above would be
/// exercising dead code.
/// KILLS (needle 2 — residual defense-in-depth): the insert-only seeding
/// surviving the rename — `.is_some()` guard immediately followed by `continue`
/// (whitespace-compacted adjacency, the exact current pattern) skips every
/// existing npc_id, so no Update/Remove ever executes. Note: this negative
/// needle can be evaded by exotic idioms (`if let Some`, `.any(...)`, match),
/// which is why needles 3–6 also require the exhaustive apply-fold shape.
/// KILLS (needles 3-6 / Finding 2): a shell that calls `plan_npc_sync(` but
/// ignores some action variants in the apply loop — the behavioral tests would
/// pass (they test the pure planner) while the shell silently discards Updates,
/// Removes, or Repairs. Each variant name must appear in the compacted window.
/// KILLS (needle 7 / Finding 3): a shell that removes NPC rows without
/// cascading the `player_conversation` table via its DB accessor — bare
/// mention of the word "player_conversation" in a comment or log string is NOT
/// sufficient; the accessor call shape `player_conversation()` is required (a
/// DB-accessor call cannot appear in a diagnostic string non-maliciously).
/// Additionally, a `.delete(` call must appear (the accessor call without a
/// delete writes nothing).
#[test]
fn m13_5c_sync_npc_entities_from_uses_planner_and_cascades() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    let body = m13_5c_fn_body(&stripped, "fn sync_npc_entities_from(");
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();

    // Needle 1: planner delegation.
    assert!(
        compact.contains("plan_npc_sync("),
        "TEETH(13.5c-1 needle 1): sync_npc_entities_from must delegate the \
         diff to the pure `plan_npc_sync(` seam (production call inside the \
         fn body)"
    );

    // Needle 2: negative — insert-only pattern gone (defense-in-depth; see doc above).
    assert!(
        !compact.contains(".is_some(){continue"),
        "TEETH(13.5c-1 needle 2): the insert-only seeding pattern (`.is_some()` \
         adjacent to `continue`) must be GONE from the shell body — it \
         silently skips every existing NPC, so changed defs never update \
         and dropped defs never remove. Note: exotic evasion idioms are caught \
         by needles 3–6 which require the exhaustive variant paths."
    );

    // Needles 3-6: exhaustive apply-fold shape — every NpcSyncAction variant the
    // planner emits must have a handling arm in the shell (Finding 2: the positive
    // `plan_npc_sync(` needle alone survives an impl that calls the planner but
    // continues past Update/Remove/Repair). Names match EXACTLY the enum variants
    // declared above so RED→green stays coherent.
    assert!(
        compact.contains("NpcSyncAction::Insert"),
        "TEETH(13.5c-1 needle 3): shell body must handle `NpcSyncAction::Insert` \
         — without this arm, new NPCs are never seeded into the DB"
    );
    assert!(
        compact.contains("NpcSyncAction::Update"),
        "TEETH(13.5c-1 needle 4): shell body must handle `NpcSyncAction::Update` \
         — without this arm, changed defs never upsert the existing NPC rows \
         (stale home/dialogue/sprite persist forever)"
    );
    assert!(
        compact.contains("NpcSyncAction::Remove"),
        "TEETH(13.5c-1 needle 5): shell body must handle `NpcSyncAction::Remove` \
         — without this arm, dropped defs leave ghost NPCs in the DB forever"
    );
    assert!(
        compact.contains("NpcSyncAction::Repair"),
        "TEETH(13.5c-1 needle 6): shell body must handle `NpcSyncAction::Repair` \
         — without this arm, half-orphan npc rows (npc exists, character missing) \
         are never self-healed (fold M1+RT-6)"
    );

    // Needle 7 (Finding 3): cascade must use the DB-accessor call shape
    // `player_conversation()` — a bare mention of the word "player_conversation"
    // can appear in a comment or log string and would false-green the needle.
    // A DB-accessor call cannot appear non-maliciously in a diagnostic string,
    // so this form is comment-stuffing-safe (comments are stripped above).
    // The additional `.delete(` needle ensures the accessor is used to DELETE,
    // not just query.
    assert!(
        compact.contains("player_conversation()"),
        "TEETH(13.5c-1 needle 7a): NPC removal must cascade `player_conversation` \
         rows via the DB accessor call `player_conversation()` (spec T4 removal \
         cascade); a bare word mention in a comment or log satisfies the \
         previous weaker form but never wires the actual delete"
    );
    assert!(
        compact.contains(".delete("),
        "TEETH(13.5c-1 needle 7b): the `player_conversation()` accessor must be \
         accompanied by a `.delete(` call in the shell body — an accessor \
         call alone (without delete) writes nothing"
    );
}

// ---------------------------------------------------------------------------
// Single-field plan_npc_sync mutation-killing tests (M13.5r)
//
// The exhaustive test above (m13_5c_plan_npc_sync_exhaustive_apply_yields_exact_def_set)
// changes MULTIPLE fields simultaneously (home_x += 5 AND sprite_id = 9), so the
// `||→&&` mutants in content.rs:491–496 survive: `(false && true) || true = true`
// still reaches the Update branch.
//
// These tests change EXACTLY ONE FIELD at a time, so a single `||→&&` mutant
// can flip the entire condition to false and suppress the Update.
//
// Mutants killed:
//   content.rs:492 (|| → && between zone_id and home_x)
//   content.rs:493 (|| → && between home_x and home_y)
//   content.rs:494 (|| → && between home_y and wander_radius)
//   content.rs:495 (|| → && between wander_radius and dialogue_tree_id)
//   content.rs:496 (|| → && in character_stale zone_id/sprite_id check)
// ---------------------------------------------------------------------------

/// plan_npc_sync detects a SINGLE home_x change and emits an Update.
///
/// Operator-precedence kill: the mutant at content.rs:492 changes the first `||`
/// to `&&`, making: `(zone_id!=def.zone_id && home_x!=def.home_x) || home_y!=...`.
/// With zone SAME (a=false) and ONLY home_x changed (b=true):
///   mutant → (false && true) || false || false || false = false → no Update (WRONG)
///   original → false || true || false || false || false = true → Update (correct)
///
/// KILLS: mutant content.rs:492 (|| → && between zone_id and home_x terms).
#[test]
fn plan_npc_sync_detects_only_home_x_change() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, ch) = m13_5c_pair_from_def(&def_old, 1);
    let existing = vec![(npc, Some(ch))];

    // Change ONLY home_x — zone, home_y, wander_radius, dialogue_tree_id, sprite_id unchanged.
    let mut def_new = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    def_new.home_x = 99; // only home_x changes

    let plan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(
        plan.len(),
        1,
        "TEETH(mutant-492): changing ONLY home_x must produce exactly 1 action; \
         got {:?}",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
    assert!(
        matches!(&plan[0], NpcSyncAction::Update { .. }),
        "TEETH(mutant-492): single home_x change must yield an Update, not {:?}",
        m13_5c_action_kind(&plan[0])
    );
}

/// plan_npc_sync detects a SINGLE home_y change and emits an Update.
///
/// Mutant at content.rs:493 changes `|| home_y!=` to `&& home_y!=`, making:
///   `zone!=... || (home_x!=... && home_y!=...) || wander!=... || dialogue!=...`
/// With zone SAME, home_x SAME, ONLY home_y changed:
///   mutant → false || (false && true) || false || false = false → no Update (WRONG)
///   original → false || false || true || false || false = true → Update (correct)
///
/// KILLS: mutant content.rs:493 (|| → && between home_x and home_y terms).
#[test]
fn plan_npc_sync_detects_only_home_y_change() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, ch) = m13_5c_pair_from_def(&def_old, 1);
    let existing = vec![(npc, Some(ch))];

    // Change ONLY home_y — zone, home_x, wander_radius, dialogue_tree_id, sprite_id unchanged.
    let mut def_new = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    def_new.home_y = 99; // only home_y changes

    let plan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(
        plan.len(),
        1,
        "TEETH(mutant-493): changing ONLY home_y must produce exactly 1 action; \
         got {:?}",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
    assert!(
        matches!(&plan[0], NpcSyncAction::Update { .. }),
        "TEETH(mutant-493): single home_y change must yield an Update, not {:?}",
        m13_5c_action_kind(&plan[0])
    );
}

/// plan_npc_sync detects a SINGLE wander_radius change and emits an Update.
///
/// Mutant at content.rs:494 changes `|| wander_radius!=` to `&& wander_radius!=`, making:
///   `zone!=... || home_x!=... || (home_y!=... && wander_radius!=...) || dialogue!=...`
/// With zone/home_x/home_y SAME, ONLY wander_radius changed:
///   mutant → false || false || (false && true) || false = false → no Update (WRONG)
///   original → false || false || false || true || false = true → Update (correct)
///
/// KILLS: mutant content.rs:494 (|| → && between home_y and wander_radius terms).
#[test]
fn plan_npc_sync_detects_only_wander_radius_change() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, ch) = m13_5c_pair_from_def(&def_old, 1);
    let existing = vec![(npc, Some(ch))];

    // Change ONLY wander_radius (was 3 in fixture, bump to 5).
    let mut def_new = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    def_new.wander_radius = 5; // only wander_radius changes

    let plan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(
        plan.len(),
        1,
        "TEETH(mutant-494): changing ONLY wander_radius must produce exactly 1 action; \
         got {:?}",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
    assert!(
        matches!(&plan[0], NpcSyncAction::Update { .. }),
        "TEETH(mutant-494): single wander_radius change must yield an Update, not {:?}",
        m13_5c_action_kind(&plan[0])
    );
}

/// plan_npc_sync detects a SINGLE dialogue_tree_id change and emits an Update.
///
/// Mutant at content.rs:495 changes `|| dialogue_tree_id!=` to `&& dialogue_tree_id!=`, making:
///   `zone!=... || home_x!=... || home_y!=... || (wander_radius!=... && dialogue_tree_id!=...)`
/// With zone/home_x/home_y/wander_radius SAME, ONLY dialogue_tree_id changed:
///   mutant → false || false || false || (false && true) = false → no Update (WRONG)
///   original → false || false || false || false || true = true → Update (correct)
///
/// KILLS: mutant content.rs:495 (|| → && between wander_radius and dialogue_tree_id terms).
#[test]
fn plan_npc_sync_detects_only_dialogue_tree_id_change() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, ch) = m13_5c_pair_from_def(&def_old, 1);
    let existing = vec![(npc, Some(ch))];

    // Change ONLY dialogue_tree_id (was "tree_alpha" in fixture).
    let mut def_new = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    def_new.dialogue_tree_id = "tree_alpha_v2".to_string(); // only dialogue changes

    let plan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(
        plan.len(),
        1,
        "TEETH(mutant-495): changing ONLY dialogue_tree_id must produce exactly 1 action; \
         got {:?}",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
    assert!(
        matches!(&plan[0], NpcSyncAction::Update { .. }),
        "TEETH(mutant-495): single dialogue_tree_id change must yield an Update, not {:?}",
        m13_5c_action_kind(&plan[0])
    );
}

// ---------------------------------------------------------------------------
// ptc5e e-2 — stale_heal_location_ids pure-seam unit tests + source-scan
//
// RED state:
//   - `super::stale_heal_location_ids` does not yet exist in content.rs
//     → compile-RED (E0425) on the three unit tests below.
//   - `seed_heal_locations_from` does not yet call `stale_heal_location_ids`
//     or `.delete(` → source-scan assertion-RED on the wiring guard.
//
// EARS criteria covered (ptc5e §e-2):
//   removed id detected — existing=[1,2,3], loaded=[1,3] → stale=[2].
//   identical sets shuffled → empty (kills positional/zip diff).
//   output sorted ascending — kills HashSet-iteration nondeterminism.
//   source-scan wiring — seed_heal_locations_from calls the seam AND deletes.
// ---------------------------------------------------------------------------

/// Heal location fixture — all mandatory fields filled; matches HealLocationDef
/// field layout (cost_currency has #[serde(default)] but we fill it explicitly).
fn ptc5e_heal_def(id: u32) -> game_core::HealLocationDef {
    game_core::HealLocationDef {
        location_id: id,
        zone_id: 0,
        tile_x: 5,
        tile_y: 5,
        cost_item_id: None,
        cost_qty: 0,
        cooldown_ms: 30_000,
        cost_currency: 0,
    }
}

/// ptc5e e-2-1: removed id is detected.
/// existing=[1,2,3], loaded=[def(1),def(3)] → stale=[2].
///
/// KILLS: an upsert-only impl (no set-difference seam) — it would never return
/// id 2, so a dead heal_location row survives forever and the location remains
/// usable after it was removed from the RON registry.
#[test]
fn ptc5e_stale_heal_location_ids_detects_removed_id() {
    let existing: Vec<u32> = vec![1, 2, 3];
    let loaded = vec![ptc5e_heal_def(1), ptc5e_heal_def(3)];

    let stale = super::stale_heal_location_ids(&existing, &loaded);

    assert_eq!(
        stale,
        vec![2u32],
        "TEETH(ptc5e e-2): heal_location 2 is in the DB but absent from loaded RON — \
         stale_heal_location_ids must return exactly [2]; an upsert-only sync \
         never reports it and the dead row stays joinable"
    );
}

/// ptc5e e-2-2: identical sets (shuffled) → empty.
///
/// KILLS: a positional/zip diff — `loaded` is deliberately shuffled relative to
/// `existing`, so a positional comparison would report phantom staleness and
/// issue spurious deletes against LIVE heal locations.
#[test]
fn ptc5e_stale_heal_location_ids_identical_sets_yield_empty() {
    let existing: Vec<u32> = vec![1, 2, 3];
    let loaded = vec![ptc5e_heal_def(3), ptc5e_heal_def(1), ptc5e_heal_def(2)]; // shuffled

    let stale = super::stale_heal_location_ids(&existing, &loaded);

    assert!(
        stale.is_empty(),
        "TEETH(ptc5e e-2): identical id sets must yield an empty stale list \
         (order-independent set-difference); got {stale:?} — a positional diff \
         would delete a live heal location"
    );
}

/// ptc5e e-2-3: output sorted ascending.
/// existing=[9,2,7,5], loaded=[def(7)] → stale=[2,5,9].
///
/// KILLS: a HashSet-backed set-difference with nondeterministic iteration order —
/// the delete sequence into the DB and any downstream logging must be deterministic.
/// Also kills an impl that preserves `existing` insertion order (9,2,5) without sorting.
#[test]
fn ptc5e_stale_heal_location_ids_output_sorted_ascending() {
    let existing: Vec<u32> = vec![9, 2, 7, 5];
    let loaded = vec![ptc5e_heal_def(7)]; // only location 7 survives

    let stale = super::stale_heal_location_ids(&existing, &loaded);

    assert_eq!(
        stale,
        vec![2u32, 5, 9],
        "TEETH(ptc5e e-2 determinism): stale ids must be sorted ascending [2,5,9]; \
         HashSet-iteration order or insertion-order preservation would give a \
         nondeterministic delete sequence"
    );
}

/// ptc5e e-2 source-scan: seed_heal_locations_from must call stale_heal_location_ids
/// AND issue a .delete( within its own fn body.
///
/// Windowed to the specific fn body (fn-find + brace-walk) so the seam's own
/// definition elsewhere in content.rs cannot false-green.
///
/// KILLS (needle 1 — stale_heal_location_ids(): an ad-hoc inline diff in the
/// shell that bypasses the unit-tested pure seam — the three unit tests above
/// would then exercise dead code.
/// KILLS (needle 2 — heal_location_row()): the accessor for the heal_location_row
/// table must appear in the fn body; absent means no stale row can be deleted.
/// KILLS (needle 3 — .delete(): computing stale ids without a delete call leaves
/// removed heal locations live in the DB; they remain usable after RON removal.
///
/// RED today: seed_heal_locations_from is upsert-only; none of the three
/// needles are present in its body.
#[test]
fn ptc5e_seed_heal_locations_from_uses_seam_and_deletes() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    let body = m13_5c_fn_body(&stripped, "fn seed_heal_locations_from(");
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();

    assert!(
        compact.contains("stale_heal_location_ids("),
        "TEETH(ptc5e e-2 needle 1): seed_heal_locations_from must call \
         stale_heal_location_ids( — ad-hoc inline diff bypasses the \
         unit-tested seam (behavioral tests would be testing dead code)"
    );
    assert!(
        compact.contains("heal_location_row()"),
        "TEETH(ptc5e e-2 needle 2): seed_heal_locations_from must access \
         the heal_location_row() table to delete stale rows; the accessor \
         is absent from the fn body"
    );
    assert!(
        compact.contains(".delete("),
        "TEETH(ptc5e e-2 needle 3): seed_heal_locations_from must issue a \
         .delete( call within its body — computing stale ids but never \
         deleting leaves removed heal locations live and usable forever"
    );
}

/// plan_npc_sync detects a SINGLE sprite_id change (no npc field change) and emits an Update.
///
/// Mutant at content.rs:496 changes `|| ch.sprite_id!=` to `&& ch.sprite_id!=` in:
///   `let character_stale = ch.zone_id != def.zone_id || ch.sprite_id != def.sprite_id;`
/// With zone SAME (ch.zone_id == def.zone_id → false), ONLY sprite_id changed:
///   mutant → false && true = false → character_stale = false
///   If npc_row_stale is also false (no npc fields changed) → no Update (WRONG)
///   original → false || true = true → character_stale = true → Update (correct)
///
/// KILLS: mutant content.rs:496 (|| → && in character_stale zone_id/sprite_id check).
#[test]
fn plan_npc_sync_detects_only_sprite_id_change() {
    let def_old = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    let (npc, ch) = m13_5c_pair_from_def(&def_old, 1);
    let existing = vec![(npc, Some(ch))];

    // Change ONLY sprite_id (was 7 in fixture) — all npc fields and zone unchanged.
    let mut def_new = m13_5c_npc_def(1, "alpha", 1, (10, 11));
    def_new.sprite_id = 99; // only sprite_id changes; zone/home/wander/dialogue same

    let plan = plan_npc_sync(&existing, &[def_new]);
    assert_eq!(
        plan.len(),
        1,
        "TEETH(mutant-496): changing ONLY sprite_id must produce exactly 1 action (character_stale); \
         got {:?}",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
    assert!(
        matches!(&plan[0], NpcSyncAction::Update { .. }),
        "TEETH(mutant-496): single sprite_id change must yield an Update, not {:?}",
        m13_5c_action_kind(&plan[0])
    );
}

// ---------------------------------------------------------------------------
// uxd2 (ADR-0161) — the `interaction` column: def -> row threading, the
// staleness OR-chain, and the validator wiring in sync_content_inner.
//
// RED until I1/I2 land: `game_core::NpcInteraction` and the `Npc.interaction` /
// `NpcDef.interaction` fields do not exist yet, so this section is compile-RED
// (E0433/E0063) — the accepted red convention for this file (see the M13.5c
// header above).
//
// Contract under test (plan of record `docs/specs/uxd2-plan.md` §I2):
//   schema.rs   `Npc` += `pub interaction: NpcInteraction` (appended last)
//   content.rs  `npc_row_from_def` threads `def.interaction`
//   content.rs  `npc_row_stale` += `|| npc.interaction != def.interaction`
//   content.rs  `sync_content_inner` calls `validate_npc_interactions(...)`
//               in the VALIDATE block, BEFORE any write.
//
// Fixtures below are LOCAL (`uxd2_*`): `m13_5c_npc_def` / `m13_5c_pair_from_def`
// belong to the M13.5c section and will be given SOME interaction value as a
// mechanical compile fix — these tests must not inherit whatever that is. Every
// uxd2 fixture states its interaction explicitly.
// ---------------------------------------------------------------------------

/// uxd2 def fixture — every field explicit, interaction included.
fn uxd2_npc_def(id: u32, npc_id: &str, interaction: game_core::NpcInteraction) -> NpcDef {
    NpcDef {
        id,
        npc_id: npc_id.to_string(),
        zone_id: 1,
        spawn_x: 8,
        spawn_y: 1,
        home_x: 8,
        home_y: 1,
        wander_radius: 0,
        dialogue_tree_id: format!("tree_{npc_id}"),
        sprite_id: 7,
        interaction,
    }
}

/// uxd2 live-pair fixture: the (Npc, Character) rows a correct seed derives
/// from `def` — interaction included, so a "live pair identical to the def"
/// really is identical on every def-derived column.
fn uxd2_pair_from_def(def: &NpcDef, entity_id: u64) -> (Npc, Character) {
    (
        Npc {
            entity_id,
            npc_id: def.npc_id.clone(),
            zone_id: def.zone_id,
            home_x: def.home_x,
            home_y: def.home_y,
            wander_radius: def.wander_radius,
            dialogue_tree_id: def.dialogue_tree_id.clone(),
            interaction: def.interaction,
        },
        Character {
            entity_id,
            zone_id: def.zone_id,
            tile_x: def.spawn_x,
            tile_y: def.spawn_y,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: def.sprite_id,
            move_queue: vec![],
        },
    )
}

/// uxd2 AC-14: `npc_row_from_def` copies `def.interaction` onto the row.
///
/// KILLS: an `npc_row_from_def` that hard-codes `NpcInteraction::Dialogue` (the
/// path of least resistance when fixing the E0063 the new column causes) — the
/// public `npc` table would then carry Dialogue for every NPC no matter what
/// the RON says, the client would derive no Shop affordance, and AC-2/AC-12
/// would fail with the whole Rust suite green.
#[test]
fn npc_row_from_def_copies_interaction() {
    let def = uxd2_npc_def(2, "shopkeeper", game_core::NpcInteraction::Shop(1));

    let row = super::npc_row_from_def(&def, 42);

    assert_eq!(
        row.interaction,
        game_core::NpcInteraction::Shop(1),
        "TEETH(uxd2 AC-14): npc_row_from_def must thread def.interaction onto \
         the row (Shop(1) in, Shop(1) out); got {:?}",
        row.interaction
    );
    assert_eq!(
        row.entity_id, 42,
        "uxd2: the row still takes the entity_id it was handed"
    );
    assert_eq!(
        row.npc_id, "shopkeeper",
        "uxd2: the row still takes the def npc_id"
    );
}

/// uxd2 AC-15: `plan_npc_sync` emits an Update when ONLY `interaction` differs,
/// and that Update carries the NEW interaction.
///
/// This is the ADR-0054 silent-skip class: `npc_row_stale` is a hand-maintained
/// OR-chain, so a def-derived column that never joins the chain re-syncs
/// exactly never. Every other def-derived field already has this tooth
/// (home_x/home_y/wander_radius/dialogue_tree_id/sprite_id above).
///
/// KILLS (needle 1 — plan.len()/variant): an `npc_row_stale` that omits
/// `|| npc.interaction != def.interaction`. A live world seeded before uxd2
/// (or before a shopkeeper's shop id changed) keeps the stale interaction
/// forever: sync bumps CONTENT_VERSION, plans nothing, and the shopkeeper stays
/// mute — the exact defect a `just smoke-republish` would surface only in prod.
/// ALSO KILLS: the `||`->`&&` mutant on the newly added chain term (only ONE
/// field changes here, so the conjunction collapses to false and suppresses the
/// Update).
/// KILLS (needle 2 — the carried value): an Update whose npc row is rebuilt
/// from the LIVE row instead of `npc_row_from_def(def, ..)` — it would be
/// planned but write back the old Dialogue value.
#[test]
fn plan_npc_sync_detects_only_interaction_change() {
    let def_old = uxd2_npc_def(2, "shopkeeper", game_core::NpcInteraction::Dialogue);
    let (npc, ch) = uxd2_pair_from_def(&def_old, 7);
    let existing = vec![(npc, Some(ch))];

    // Change ONLY interaction — zone/home/wander/dialogue_tree_id/sprite_id all
    // identical to the live pair.
    let def_new = uxd2_npc_def(2, "shopkeeper", game_core::NpcInteraction::Shop(1));

    let plan = plan_npc_sync(&existing, &[def_new]);

    assert_eq!(
        plan.len(),
        1,
        "TEETH(uxd2 AC-15): changing ONLY interaction must produce exactly 1 \
         action; got {:?} — an npc_row_stale chain missing the interaction term \
         never re-syncs the column (ADR-0054 silent-skip)",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
    match &plan[0] {
        NpcSyncAction::Update { entity_id, npc, .. } => {
            assert_eq!(
                *entity_id, 7,
                "TEETH(uxd2 AC-15): the Update must preserve the live entity_id \
                 (never delete+reinsert — auto_inc would orphan \
                 player_conversation.npc_entity_id)"
            );
            assert_eq!(
                npc.interaction,
                game_core::NpcInteraction::Shop(1),
                "TEETH(uxd2 AC-15): the Update must carry the NEW interaction \
                 Shop(1) from the def, not the live row's stale value; got {:?}",
                npc.interaction
            );
        }
        other => panic!(
            "TEETH(uxd2 AC-15): an interaction-only diff must yield an Update, \
             got {}",
            m13_5c_action_kind(other)
        ),
    }
}

/// uxd2 AC-15 (idempotence arm): a pair matching its def on a NON-default
/// interaction plans NOTHING.
///
/// The sibling `m13_5c_plan_npc_sync_identical_state_yields_empty_plan` covers
/// def-identical worlds, but only with whatever interaction the shared M13.5c
/// fixture happens to carry.
///
/// KILLS: the comparison-operator mutant `npc.interaction == def.interaction`
/// (inverted term) — every def-identical NPC would then be reported stale and
/// rewritten on EVERY content-version bump, churning the public `npc` table and
/// pushing a row update to every subscriber for nothing.
#[test]
fn plan_npc_sync_ignores_identical_shop_interaction() {
    let def = uxd2_npc_def(2, "shopkeeper", game_core::NpcInteraction::Shop(1));
    let (npc, ch) = uxd2_pair_from_def(&def, 7);
    let existing = vec![(npc, Some(ch))];

    let plan = plan_npc_sync(&existing, &[def]);

    assert!(
        plan.is_empty(),
        "TEETH(uxd2 AC-15 idempotence): a pair whose interaction already equals \
         the def's must plan ZERO actions; got {:?}",
        plan.iter().map(m13_5c_action_kind).collect::<Vec<_>>()
    );
}

/// uxd2 AC-8 wiring (vacuity guard): `sync_content_inner` must CALL
/// `validate_npc_interactions(` inside its own body, must propagate the Err,
/// and must do so BEFORE the write phase begins.
///
/// Windowed to the fn body (fn-find + brace-walk) and whitespace-compacted —
/// the same idiom as `m13_5c_sync_content_inner_deletes_stale_zone_defs` above.
/// The write-phase anchor is `stale_zone_def_ids(`: the first write-phase
/// statement of the fn (its presence there is itself pinned by that sibling
/// test), so "before the anchor" means "before ANY DB write".
///
/// KILLS (needle 1): a `validate_npc_interactions` that exists, is unit-tested
/// in game-core, and is never called — the entire AC-8 validator would be dead
/// code and a dangling `Shop(id)` would ship.
/// KILLS (needle 2): a call placed in the WRITE phase (e.g. next to
/// `sync_npc_entities_from`) — that breaks the all-before-any-write contract
/// (ADR-0073 §12.5b-2): zone/species/item/shop rows would already be committed
/// when the validator aborts the reducer.
/// KILLS (needle 3): a call whose Result is swallowed (`let _ = …` / `.ok();`),
/// which validates nothing at all.
#[test]
fn uxd2_sync_content_inner_validates_npc_interactions_before_write_phase() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    let body = m13_5c_fn_body(&stripped, "fn sync_content_inner(ctx");
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();

    let call_at = compact
        .find("validate_npc_interactions(")
        .unwrap_or_else(|| {
            panic!(
                "TEETH(uxd2 AC-8 needle 1): sync_content_inner must call \
             `validate_npc_interactions(` in its VALIDATE block — a validator \
             that is never called is dead code and a dangling Shop(id)/Heal(id) \
             seed reaches production unchecked"
            )
        });
    let write_at = compact
        .find("stale_zone_def_ids(")
        .expect("write-phase anchor `stale_zone_def_ids(` must exist in sync_content_inner");

    assert!(
        call_at < write_at,
        "TEETH(uxd2 AC-8 needle 2): validate_npc_interactions( must be called \
         BEFORE the write phase (anchor `stale_zone_def_ids(`, the first \
         write-phase statement) — all-before-any-write, ADR-0073 §12.5b-2. \
         Found the call at byte {call_at} and the anchor at {write_at} in the \
         compacted fn body."
    );

    // Needle 3: the Result must be propagated, not swallowed. Scan the single
    // statement that starts at the call site (up to its terminating `;`).
    let after = &compact[call_at..];
    let stmt_end = after.find(';').unwrap_or(after.len());
    let stmt = &after[..stmt_end];
    assert!(
        stmt.contains('?') || stmt.contains("returnErr("),
        "TEETH(uxd2 AC-8 needle 3): the validate_npc_interactions call must \
         propagate its Err (`?` / an explicit `return Err(`) — a swallowed \
         Result (`let _ = …`, `.ok();`) validates nothing while looking wired. \
         Statement scanned: {stmt:?}"
    );
}

/// uxd2 I2: `CONTENT_VERSION` must be >= 17.
///
/// Mirrors the EA-6 precedent in `m14_5d_1a_tests.rs` (same extraction shape).
///
/// KILLS: an impl that adds the `interaction` column and the RON seeds but
/// leaves CONTENT_VERSION at 16 — `sync_content_inner`'s version gate then
/// early-returns on every already-seeded DB, so `sync_npc_entities_from` never
/// runs, the shopkeeper is never inserted, and the new column stays at its
/// republish default. Every unit test still passes; only a live DB shows it
/// (the ADR-0054 silent-skip trap).
#[test]
fn uxd2_content_version_is_at_least_17() {
    let cv_needle = ["CONTENT_VERSION", ": u32 ="].concat();
    let cv_pos = M13_5C_LIB_RS_SOURCE
        .find(cv_needle.as_str())
        .expect("CONTENT_VERSION constant must be declared in lib.rs");
    let after_eq = &M13_5C_LIB_RS_SOURCE[cv_pos..];
    let eq_offset = after_eq.find('=').expect("CONTENT_VERSION must have `=`");
    let after_value = after_eq[eq_offset + 1..].trim_start();
    let end = after_value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after_value.len());
    let value: u32 = after_value[..end]
        .parse()
        .expect("CONTENT_VERSION must be a plain integer literal");

    assert!(
        value >= 17,
        "TEETH(uxd2 I2): CONTENT_VERSION in server-module/src/lib.rs must be \
         >= 17 (current: {value}). The uxd2 slice widens the public `npc` table \
         and appends a shopkeeper to the npcs RON; without the bump, \
         sync_content_inner's version gate returns Ok early on every deployed \
         DB and neither the column nor the new NPC is ever seeded (ADR-0054)."
    );
}

// ===========================================================================
// 12r-d — E1 (`heal_location_row.cost_currency`, server side) and E3 (the two
// hand-built JSON log sites inside `sync_npc_entities_from`).
//
// EARS criteria covered by this section:
//
//   E1  `HealLocationRow` SHALL carry a `cost_currency: u64` column APPENDED
//       after `cooldown_ms` and carrying an explicit, TYPED `#[default(0u64)]`;
//       `seed_heal_locations_from` SHALL map it from `def.cost_currency`; and
//       `evals/baselines/table-schemas.json` SHALL baseline it as `u64`.
//   E3  Every hand-built JSON log line in `content.rs` that interpolates
//       content-authored text SHALL interpolate a `crate::guards::json_escape`d
//       binding instead of the raw value (`npc_sync_remove`, `npc_sync_repair`).
//
// RED STATE — all four tests are ASSERTION-RED at HEAD:
//   * A1 — `HealLocationRow` (schema.rs:546-556) ends at `cooldown_ms: i64`.
//     There is no `cost_currency` field, so the field needle simply misses.
//   * A2 — the `HealLocationRow { .. }` literal (content.rs:724-732) has no
//     `cost_currency:` line, so the anchored adjacency needle misses.
//   * A3 — the `heal_location_row` block of `table-schemas.json` (line 325-336)
//     ends at `"cooldown_ms": "i64"`.
//   * A4 — content.rs:649 interpolates a raw `{npc_id}`, content.rs:670 feeds
//     `npc.npc_id` into a positional `{}`, and `sync_npc_entities_from` makes
//     ZERO `json_escape` calls.
//
// SCAN SUBSTRATE RULES honoured throughout (violating them breaks OTHER
// slices' gates, not this one): every needle naming a production marker is
// assembled from fragments — whole-tree eval parsers concatenate the
// `*_tests.rs` files into one scan blob (the EG2 poisoning precedent), so a
// contiguous copy of a marker in the test that forbids it poisons them — and no
// double quote is ever spelled as a CHAR literal (guards_tests G-5a).
// ===========================================================================

/// The production `schema.rs` source — 12r-d A1.
const D12R_SCHEMA_RS: &str = include_str!("schema.rs");

/// The eval schema baseline — 12r-d A3.
const D12R_TABLE_SCHEMAS_JSON: &str = include_str!("../../evals/baselines/table-schemas.json");

/// The ASCII double quote, spelled as a NUMBER.
///
/// This file must contain no bare delimiter CHARACTER literal: the repo's
/// source-scan substrate has no char-literal lexer, and a quote between
/// apostrophes inverts string/code polarity for every stripper that reads this
/// file downstream (guards_tests G-5a records the measured blast radius).
const D12R_DQUOTE: u8 = 0x22;

/// `src` with ALL whitespace removed, so a rustfmt line split can never turn a
/// correct implementation red.
fn d12r_squash(src: &str) -> String {
    src.split_whitespace().collect()
}

/// True when the quote byte at `idx` DELIMITS a string literal rather than
/// being an escaped `\"` inside one: a delimiter is preceded by an EVEN number
/// of consecutive backslashes.
fn d12r_quote_delimits(bytes: &[u8], idx: usize) -> bool {
    let mut n = 0usize;
    let mut i = idx;
    while i > 0 && bytes[i - 1] == b'\\' {
        n += 1;
        i -= 1;
    }
    n.is_multiple_of(2)
}

/// The interior (delimiters excluded) of the double-quoted string literal that
/// CONTAINS byte offset `at`.
///
/// The hand-built JSON log lines in this crate spell their structural quotes as
/// `\"` inside one literal, so a naive "nearest quote" scan would slice the
/// wrong span; [`d12r_quote_delimits`] is what distinguishes the two.
fn d12r_format_string_at(src: &str, at: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    let mut i = at;
    let open = loop {
        if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
            break i;
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    };
    let mut j = at;
    while j < bytes.len() {
        if bytes[j] == D12R_DQUOTE && d12r_quote_delimits(bytes, j) {
            return Some(&src[open + 1..j]);
        }
        j += 1;
    }
    None
}

/// Byte range of the `log::<level>!( .. )` invocation that CONTAINS `at`.
///
/// Walks parens from the macro's `(`, JUMPING OVER string literals so a paren
/// inside a log message cannot unbalance the walk. Returns `(start, end)` with
/// `end` just past the closing `)`.
fn d12r_log_call_range(src: &str, at: usize) -> Option<(usize, usize)> {
    let marker = ["log", "::"].concat();
    let start = src[..at].rfind(marker.as_str())?;
    let bytes = src.as_bytes();
    let open = start + src[start..].find('(')?;
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
                    break;
                }
                i += 1;
            }
        } else if bytes[i] == b'(' {
            depth += 1;
        } else if bytes[i] == b')' {
            depth -= 1;
            if depth == 0 {
                return Some((start, i + 1));
            }
        }
        i += 1;
    }
    None
}

/// Index of the `}` that balances the `{` at byte offset `open` in `src`.
///
/// A depth count with no string lexer — sufficient for every span it is used on
/// here (a `struct` body, a struct LITERAL and a JSON object), none of which
/// contains a brace inside a string.
fn d12r_matching_brace(src: &str, open: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The interior of the `{ .. }` block that OPENS at or after the first
/// occurrence of `head` in `src`, braces excluded.
///
/// Used for the JSON object in A3. (A1 does NOT use it: it anchors on the
/// `#[spacetimedb::table(..)]` attribute instead — see H4 in its doc comment.)
fn d12r_braced_block<'a>(src: &'a str, head: &str) -> Option<&'a str> {
    let start = src.find(head)?;
    let open = start + src[start..].find('{')?;
    let close = d12r_matching_brace(src, open)?;
    Some(&src[open + 1..close])
}

/// **A1** (12r-d E1) — `HealLocationRow` gains `cost_currency: u64`, APPENDED
/// after `cooldown_ms`, carrying a TYPED `#[default(0u64)]`.
///
/// ASSERTION-RED at HEAD: the struct (schema.rs:546-556) ends at
/// `cooldown_ms: i64` and the field needle misses outright.
///
/// WHAT EACH ASSERTION KILLS.
///   * **Field present, typed `u64`.** Kills the whole omission, and kills a
///     narrower `u32`/`i64` spelling — `game_core::HealLocationDef.cost_currency`
///     is `u64` and `player_wallet` balances are `u64`, so anything else either
///     truncates a price or forces a lossy cast at the seed site.
///   * **Strictly AFTER `cooldown_ms`.** SpacetimeDB's automatic migration only
///     accepts a TAIL append (ADR-0173 D5): a column inserted in the middle
///     renumbers every following column and the publish is rejected — the exact
///     failure the `#[default(..)]` discipline exists to avoid.
///   * **`#[default(0u64)]` IMMEDIATELY before the field.** Contiguity is the
///     point: an attribute that exists somewhere in the struct but decorates a
///     DIFFERENT field leaves the new column defaultless, and an automatic
///     migration that must invent values for existing rows without a default is
///     rejected outright.
///   * **The UNTYPED `#[default(0)]` is explicitly banned.** This is the
///     measured one, not a theoretical one: an untyped `0` in `#[default(..)]`
///     BSATN-encodes as FOUR bytes, and the publish fails with "data too short"
///     for an 8-byte column (schema.rs:291-293 records the same finding for the
///     two `i64` columns, which is why they carry `0i64`). A test that accepted
///     a bare `0` here would let a green CI ship a module that cannot publish.
///
/// H4 — THE BLOCK IS ANCHORED ON THE TABLE ATTRIBUTE, not on the first textual
/// match of `struct HealLocationRow`. The scan runs on the whitespace-squashed,
/// comment-stripped whole file and requires the sequence
/// `#[spacetimedb::table(name=heal_location_row` followed WITHIN A SHORT WINDOW
/// by `pub struct HealLocationRow {`. Anchoring on the struct name alone would
/// let a decoy — a same-named struct declared earlier in the file, or one whose
/// table attribute was removed — become the scanned block, so every assertion
/// below would describe a type SpacetimeDB never sees. Tying the block to the
/// attribute that MAKES it a table is what keeps the claims about a real column.
#[test]
fn heal_location_row_cost_currency_is_appended_with_a_default() {
    let stripped = m13_5c_strip_rust_comments(D12R_SCHEMA_RS);
    let sq_all = d12r_squash(&stripped);

    // H4 anchor: the table attribute, then the struct head it decorates.
    let attr = ["#[spacetimedb::", "table(name=heal_location", "_row"].concat();
    let attr_at = sq_all.find(attr.as_str()).unwrap_or_else(|| {
        panic!(
            "12r-d A1 (E1, H4 anchor): server-module/src/schema.rs must declare the \
             `heal_location_row` TABLE via {attr:?} (whitespace-squashed). Without the \
             attribute there is no table, and every column assertion below would \
             describe a plain struct SpacetimeDB never sees."
        )
    });
    let after_attr = &sq_all[attr_at..];
    let struct_head = ["pubstruct", "HealLocation", "Row{"].concat();
    let head_rel = after_attr.find(struct_head.as_str()).unwrap_or_else(|| {
        panic!(
            "12r-d A1 (E1, H4 anchor): no {struct_head:?} follows the \
             `heal_location_row` table attribute in schema.rs — the attribute and the \
             struct it decorates must be adjacent."
        )
    });
    assert!(
        head_rel < 200,
        "12r-d A1 (E1, H4 anchor): the `heal_location_row` table attribute and the \
         `pub struct HealLocationRow {{` head are {head_rel} squashed bytes apart; they \
         must be adjacent (< 200). A larger gap means the scan latched onto a struct \
         head belonging to some LATER table, and every assertion below would be about \
         the wrong type."
    );

    let open = attr_at + head_rel + struct_head.len() - 1;
    let close = d12r_matching_brace(&sq_all, open).unwrap_or_else(|| {
        panic!("12r-d A1 (E1): `HealLocationRow`'s struct body has unbalanced braces")
    });
    let sq = &sq_all[open + 1..close];

    let field = ["pubcost", "_currency:u64"].concat();
    let prev = ["pubcooldown", "_ms:i64"].concat();
    let typed_attr = ["#[def", "ault(0u64)]"].concat();
    let untyped_attr = ["#[def", "ault(0)]"].concat();
    let typed_attr_field = [typed_attr.as_str(), field.as_str()].concat();
    let untyped_attr_field = [untyped_attr.as_str(), field.as_str()].concat();

    assert!(
        sq.contains(prev.as_str()),
        "vacuity guard (12r-d A1, E1): `HealLocationRow` no longer declares \
         `pub cooldown_ms: i64` — the anchor every ordering claim below is made \
         against is gone, so those claims would prove nothing. Squashed struct \
         body was: {sq:?}"
    );
    assert!(
        sq.contains(field.as_str()),
        "TEETH (12r-d A1, E1): `HealLocationRow` in server-module/src/schema.rs must \
         declare `pub cost_currency: u64`. RED at HEAD — the struct ends at \
         `cooldown_ms: i64`. `game_core::HealLocationDef.cost_currency` is `u64` and \
         `heal_party` charges out of a `u64` wallet, so a `u32`/`i64` spelling either \
         truncates a price or forces a lossy cast at the seed site. Squashed struct \
         body was: {sq:?}"
    );

    let prev_at = sq.find(prev.as_str()).expect("asserted present above");
    let field_at = sq.find(field.as_str()).expect("asserted present above");
    assert!(
        prev_at < field_at,
        "TEETH (12r-d A1, E1): `cost_currency` must be APPENDED strictly AFTER \
         `cooldown_ms` (found cooldown_ms at {prev_at}, cost_currency at {field_at} in \
         the squashed struct body). SpacetimeDB's automatic migration accepts a TAIL \
         append only (ADR-0173 D5): a column spliced into the middle renumbers every \
         following column and the publish is rejected."
    );

    assert!(
        !sq.contains(untyped_attr_field.as_str()),
        "TEETH (12r-d A1, E1 — the measured publish failure): `cost_currency` carries \
         the UNTYPED `#[default(0)]`. An untyped `0` BSATN-encodes as FOUR bytes and \
         the publish rejects an 8-byte column with `data too short`; schema.rs:291-293 \
         records exactly this finding for the two `i64` columns, which is why they \
         carry `0i64`. Write `#[default(0u64)]`. A test that accepted the bare `0` \
         would let a green CI ship a module that cannot publish at all."
    );
    assert!(
        sq.contains(typed_attr_field.as_str()),
        "TEETH (12r-d A1, E1): the TYPED `#[default(0u64)]` attribute must sit \
         IMMEDIATELY before `pub cost_currency: u64` (needle {typed_attr_field:?} not \
         found in the squashed struct body). Contiguity is the property: an attribute \
         that exists somewhere in the struct but decorates a DIFFERENT field leaves \
         the new column defaultless, and an automatic migration that must invent \
         values for existing rows without a default is rejected. Squashed struct body \
         was: {sq:?}"
    );
}

/// **A2** (12r-d E1) — the `HealLocationRow` literal in `seed_heal_locations_from`
/// maps `cost_currency` from THE DEF, checked INSIDE the one and only literal.
///
/// ASSERTION-RED at HEAD: the literal (content.rs:724-732) ends at
/// `cooldown_ms: def.cooldown_ms,` — the scoped needle misses.
///
/// WHY A BARE, UNSCOPED `def.cost_currency` NEEDLE IS FORBIDDEN. The obvious
/// check — `body.contains("def.cost_currency")` — is satisfied by at least two
/// implementations that seed the column WRONG:
///   * `cost_currency: stale_def.cost_currency`, reading a binding whose name
///     merely ENDS in `def`, so the price comes from the wrong registry entry; and
///   * a dead-code mention anywhere else in the function — a `debug_assert`, a
///     log line, or (H1, the red-team's construction) a whole decoy struct
///     literal inside `if false { .. }`, which compiles clean while the LIVE
///     literal ships `cost_currency: 0` and every heal location stays free.
///
/// H1 — THREE LAYERS, IN ORDER:
///   1. **Exactly ONE `HealLocationRow {` literal in the function.** This fn
///      builds the row once, in the upsert loop. A second occurrence is either
///      the `if false` decoy above or a genuine second construction path that
///      nobody has reasoned about; both must stop the build.
///   2. **The needle is evaluated INSIDE that literal's brace block**, not
///      against the whole body — so no statement outside the literal can satisfy
///      it, whatever it says.
///   3. **A survivor pin** for `cooldown_ms: def.cooldown_ms` inside the same
///      literal, so "the field list is real" is a claim about a populated struct
///      and a swap that REPLACED a field rather than appending one is caught.
///
/// FIELD ORDER IS DELIBERATELY NOT PINNED HERE (reviewer MED: over-constraint /
/// false-RED risk). Once (1) and (2) hold, the scoped bare needle
/// `cost_currency:def.cost_currency` is already decoy-proof — note
/// `cost_currency:stale_def.cost_currency` does NOT contain that substring — and
/// the tail-append ORDER that automatic migration actually cares about is pinned
/// where it belongs: on the SCHEMA, by A1.
#[test]
fn seed_heal_locations_from_maps_cost_currency_from_the_def() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    let fn_head = ["fn seed_heal_locations", "_from("].concat();
    let body = m13_5c_fn_body(&stripped, fn_head.as_str());
    let sq = d12r_squash(body);

    // --- Layer 1: exactly ONE struct literal ---------------------------------
    let literal_head = ["HealLocation", "Row{"].concat();
    let n_literals = sq.matches(literal_head.as_str()).count();
    assert_eq!(
        n_literals, 1,
        "TEETH (12r-d A2, E1, H1 decoy kill): `seed_heal_locations_from` contains \
         {n_literals} `HealLocationRow {{` struct literal(s); it must contain EXACTLY \
         ONE — the row it upserts per def. TWO is the red-team's proven cheat: a dead \
         `if false {{ let _decoy = HealLocationRow {{ .. cost_currency: def.cost_currency \
         }}; }}` compiles clean, satisfies any needle scoped to the whole function body, \
         and leaves the LIVE literal shipping `cost_currency: 0` — every heal location \
         free, forever, with a green suite. Squashed fn body was: {sq:?}"
    );

    // --- Layer 2: scope the needles to THAT literal --------------------------
    let literal_at = sq
        .find(literal_head.as_str())
        .expect("asserted present by the count above");
    let open = literal_at + literal_head.len() - 1;
    let close = d12r_matching_brace(&sq, open).unwrap_or_else(|| {
        panic!(
            "12r-d A2 (E1): the `HealLocationRow {{ .. }}` literal in \
             `seed_heal_locations_from` has unbalanced braces after squashing"
        )
    });
    let literal = &sq[open + 1..close];

    // --- Layer 3: survivor pin + the field under test ------------------------
    let neighbour = ["cooldown_ms:def.cooldown", "_ms"].concat();
    assert!(
        literal.contains(neighbour.as_str()),
        "vacuity guard (12r-d A2, E1): the one `HealLocationRow` literal no longer maps \
         `cooldown_ms: def.cooldown_ms`. Either the extraction mis-sliced or a field was \
         REPLACED rather than appended — in both cases the assertion below would be \
         making a claim about a field list that is not the real one. Literal was: \
         {literal:?}"
    );

    let mapped = ["cost", "_currency:def.cost", "_currency"].concat();
    assert!(
        literal.contains(mapped.as_str()),
        "TEETH (12r-d A2, E1): the `HealLocationRow` literal in \
         `seed_heal_locations_from` must map `cost_currency: def.cost_currency` — the \
         squashed sequence {mapped:?} was not found INSIDE the literal. RED at HEAD (it \
         ends at `cooldown_ms: def.cooldown_ms,`), so every seeded row would keep the \
         column at its `#[default(0u64)]` and EVERY heal location would be free no \
         matter what the RON says. The needle is SCOPED to the literal, so a mention \
         anywhere else in the function cannot satisfy it, and it names `def.` \
         explicitly, so `cost_currency: stale_def.cost_currency` — the wrong registry \
         entry — does not match either. Literal was: {literal:?}"
    );
}

/// **A3** (12r-d E1) — the eval schema baseline carries the new column, typed.
///
/// ASSERTION-RED at HEAD: the `heal_location_row` block of
/// `evals/baselines/table-schemas.json` (lines 325-336) ends at
/// `"cooldown_ms": "i64"`.
///
/// The block is BRACE-BOUNDED, not read out of a fixed-size byte window: the
/// `heal_cooldown` table starts one line later, and a window that spilled into
/// it could satisfy a column claim from the wrong table. (The EA-5 precedent in
/// `m14_5d_1a_tests.rs` uses a 1 000-byte window; brace-bounding is the same
/// idea with the ambiguity removed.)
///
/// KILLS: a schema edit that lands in `schema.rs` and never reaches the
/// baseline — `battle-schema-snapshot` compares the baseline BIDIRECTIONALLY
/// against the parsed source, so the drift surfaces as a CI failure in a
/// different gate with no pointer back to this slice; and a baseline entry typed
/// `"u32"`/`"i64"`, which makes the snapshot agree with a schema the module
/// cannot actually publish.
#[test]
fn table_schemas_baseline_carries_heal_cost_currency() {
    let table = ["\"heal_location", "_row\""].concat();
    let block = d12r_braced_block(D12R_TABLE_SCHEMAS_JSON, table.as_str()).unwrap_or_else(|| {
        panic!(
            "12r-d A3 (E1): evals/baselines/table-schemas.json must contain a \
             {table} block — the column assertions below would be vacuous without it"
        )
    });
    let sq = d12r_squash(block);

    let neighbour = ["\"cooldown", "_ms\":\"i64\""].concat();
    assert!(
        sq.contains(neighbour.as_str()),
        "vacuity guard (12r-d A3, E1): the `heal_location_row` baseline block no \
         longer carries {neighbour} — the block was found but is not the one this \
         test means, so the assertion below would prove nothing. Squashed block was: \
         {sq:?}"
    );

    let column = ["\"cost", "_currency\""].concat();
    let typed_column = [column.as_str(), ":\"u64\""].concat();
    assert!(
        sq.contains(column.as_str()),
        "TEETH (12r-d A3, E1): evals/baselines/table-schemas.json must add a \
         {column} entry to the `heal_location_row` columns object. RED at HEAD (the \
         block ends at `\"cooldown_ms\": \"i64\"`). The baseline is one half of a \
         BIDIRECTIONAL comparison against the parsed schema source — leaving it \
         behind turns this slice's schema edit into a red `battle-schema-snapshot` \
         run in an unrelated gate. Squashed block was: {sq:?}"
    );
    assert!(
        sq.contains(typed_column.as_str()),
        "TEETH (12r-d A3, E1): the `cost_currency` baseline entry must be typed \
         `\"u64\"` (needle {typed_column:?}). The key is present but the type string \
         is wrong — a baseline typed `\"u32\"` or `\"i64\"` makes the snapshot agree \
         with a schema shape the module cannot publish, which is worse than no \
         baseline at all. Squashed block was: {sq:?}"
    );
}

/// One hand-built JSON log site under test (12r-d E3).
///
/// A named struct rather than a tuple so the driver's slice parameter stays
/// under clippy's `type_complexity` threshold and each field says what it pins.
struct D12rLogSite {
    /// The `evt` name; located inside its own format string literal.
    evt: String,
    /// Extra format-string text that selects THIS site when one `evt` name
    /// labels several. Empty means "every site carrying this evt".
    discriminator: String,
    /// How many sites the row must claim — asserted EXACTLY, so a deleted or
    /// duplicated log line is caught rather than silently skipped.
    expected_sites: usize,
    /// Text that must be ABSENT from the site's whole macro call.
    raw: String,
    /// Text that must be PRESENT in the site's FORMAT STRING.
    capture: String,
}

/// Assert one region's hand-built JSON log sites interpolate an ESCAPED binding.
///
/// `binding` is the identifier the escape must be bound to; `escape_args` lists
/// the ACCEPTED argument spellings (each including its closing paren, e.g.
/// `"&e)"`); `min_escape_calls` is the number of `json_escape(` calls the region
/// must make.
///
/// H3 — WHY THE ARGUMENT IS PART OF THE PROVENANCE NEEDLE. A needle that stops
/// at `let escaped = json_escape(` is satisfied by
/// `let escaped = json_escape(&"placeholder");` — the escape is called, its
/// result IS read by the format string, no lint fires, and the value logged is a
/// constant instead of the error nobody will now ever see. Naming the argument
/// closes it. The closing paren is part of each spelling on purpose: a bare `&e`
/// would also match `&entity_id`.
///
/// HONEST LIMITS. (a) A source scan, not execution (ADR-0156 P7): there is no
/// reducer harness in this crate. (b) It pins the INLINE-CAPTURE form
/// (`{escaped}`) rather than a positional argument, which is what makes "the
/// escaped value reaches THIS format string" checkable at all; the npc.rs:184-190
/// site is the precedent. (c) It cannot see an escaped value interpolated into
/// the wrong SLOT of the right line — that residue is covered by guards_tests
/// G-1..G-3 (the helper is worth calling) and by the composed-line framing table
/// in `battle_tests.rs`.
fn d12r_assert_escaped_log_sites(
    label: &str,
    body: &str,
    rows: &[D12rLogSite],
    binding: &str,
    escape_args: &[&str],
    min_escape_calls: usize,
) {
    for row in rows {
        let evt = &row.evt;
        let disc = &row.discriminator;
        let expected = &row.expected_sites;
        let raw = &row.raw;
        let capture = &row.capture;
        let mut seen = 0usize;
        for (at, _) in body.match_indices(evt.as_str()) {
            let fmt = d12r_format_string_at(body, at).unwrap_or_else(|| {
                panic!(
                    "12r-d E3 ({label}): the event name {evt:?} at byte {at} is not \
                     inside a string literal — this scan locates a log site by its \
                     format string, so the line must have been restructured. \
                     Re-derive the row DELIBERATELY rather than loosening it."
                )
            });
            if !disc.is_empty() && !fmt.contains(disc.as_str()) {
                continue;
            }
            seen += 1;

            let (cs, ce) = d12r_log_call_range(body, at).unwrap_or_else(|| {
                panic!(
                    "12r-d E3 ({label}): could not find the enclosing `log::<level>!( .. )` \
                     invocation for {evt:?}{disc:?} — the site scan needs it to prove the \
                     raw value is gone from the WHOLE call, not just from the format string"
                )
            });
            let call_sq = d12r_squash(&body[cs..ce]);

            assert!(
                !call_sq.contains(raw.as_str()),
                "TEETH (12r-d E3, ADR-0170 D5) {label} / {evt}{disc}: the log call still \
                 carries the RAW value {raw:?}. A hand-built JSON line interpolating an \
                 unescaped string emits a MALFORMED line the moment that string contains \
                 a double quote, a backslash or a control character — and a malformed \
                 line is silently dropped by the log ingest, so the diagnostic this site \
                 exists to produce disappears exactly when something has gone wrong. \
                 Route it through `crate::guards::json_escape` and interpolate the \
                 binding instead. Squashed call was: {call_sq:?}"
            );
            assert!(
                fmt.contains(capture.as_str()),
                "TEETH (12r-d E3, ADR-0170 D5) {label} / {evt}{disc}: the format string \
                 must interpolate {capture:?} — the output of \
                 `crate::guards::json_escape`, captured INLINE so this scan can prove \
                 the escaped value reaches THIS line and not some other one. Not found. \
                 The literal prefix (if any) stays OUTSIDE the capture: only the \
                 untrusted text is escaped, never the hand-written label. Format string \
                 was: {fmt:?}"
            );
        }
        assert_eq!(
            seen, *expected,
            "TEETH (12r-d E3) {label}: expected exactly {expected} log site(s) matching \
             event {evt:?} + discriminator {disc:?}, found {seen}. Fewer means a log \
             line was deleted or renamed rather than escaped (the cheapest way to make \
             every other assertion in this row vacuous); more means a new site appeared \
             and its escaping was never considered. Re-derive the count DELIBERATELY."
        );
    }

    let sq = d12r_squash(body);
    let escape_call = ["json", "_escape("].concat();
    let n_escape = sq.matches(escape_call.as_str()).count();
    assert!(
        n_escape >= min_escape_calls,
        "TEETH (12r-d E3, ADR-0170 D5) {label}: the region must make at least \
         {min_escape_calls} `json_escape(` call(s) — one per interpolated untrusted \
         value — but it makes {n_escape}. This is the arithmetic pin that survives a \
         future slice adding another log line: adding one without an escape trips this \
         count and forces the number to be re-derived on purpose."
    );

    let any_binding = ["let", binding, "="].concat();
    let n_all = sq.matches(any_binding.as_str()).count();
    let mut n_esc = 0usize;
    for &arg in escape_args {
        let qualified = ["let", binding, "=crate::guards::json", "_escape(", arg].concat();
        let bare = ["let", binding, "=json", "_escape(", arg].concat();
        n_esc += sq.matches(qualified.as_str()).count() + sq.matches(bare.as_str()).count();
    }

    assert!(
        n_esc >= 1,
        "TEETH (12r-d E3, ADR-0170 D5) {label}: the escaped value must be bound to the \
         identifier `{binding}` by a statement of the form \
         `let {binding} = crate::guards::json_escape(<arg>);` (the bare \
         `json_escape(<arg>)` spelling is accepted when the helper is imported), where \
         `<arg>` is one of {escape_args:?} — found none. \
         TWO things are pinned here and both are load-bearing. The exact BINDING NAME \
         ties the value that was escaped to the identifier the format string \
         interpolates; a differently-named escape binding is the red-team's proven \
         cheat (npc_tests.rs:1117-1223): `let _escaped = json_escape(&e);` (unused, not \
         `let _ =`, so clippy stays silent) beside a format string that still \
         interpolates the raw value. The exact ARGUMENT (H3) kills \
         `let {binding} = json_escape(&\"placeholder\");` — the escape is called, its \
         result IS read by the format string, nothing warns, and the line logs a \
         constant instead of the error nobody will now ever see."
    );
    assert_eq!(
        n_all, n_esc,
        "TEETH (12r-d E3, shadow-rebind + placeholder cheat kill) {label}: `{binding}` \
         is `let`-bound {n_all} time(s) but only {n_esc} of those bindings come from \
         `json_escape` applied to one of {escape_args:?}. \
         KILLS (a) the shadow-rebind that defeats every name-based assertion above — \
         `let {binding} = crate::guards::json_escape(&e); let {binding} = e.clone();` \
         satisfies 'the escape statement is present' AND 'the format string \
         interpolates `{binding}`', while the VALUE at the point of use is the raw, \
         un-escaped one, and the compiler does not complain because the binding IS \
         read, just not the one that was escaped; and (b) a per-site escape whose \
         ARGUMENT is a placeholder rather than the value being logged, which this \
         equality catches even when the other sites are correct."
    );
}

/// **A4** (12r-d E3) — both hand-built JSON log sites in `sync_npc_entities_from`
/// escape the content-authored `npc_id`.
///
/// ASSERTION-RED at HEAD on every layer: content.rs:649 interpolates
/// `\"npc_id\":\"{npc_id}\"` raw, content.rs:670 feeds `npc.npc_id` into a
/// positional `{}`, and the function makes ZERO `json_escape` calls.
///
/// WHY THESE TWO SITES. `npc_id` is CONTENT-AUTHORED text (it comes out of the
/// npcs RON registry) crossing into a hand-built JSON log line — structurally
/// the same trust boundary ADR-0170 D5 closed at `log_reject`, and exactly the
/// case npc.rs:184-190 already fixed for `quest_id`. One `npc_id` containing a
/// double quote turns both lines into unparseable JSON, and the log ingest drops
/// them — so the NPC-sync audit trail vanishes precisely for the malformed
/// registry entry that made the sync interesting.
///
/// The scan runs on COMMENT-STRIPPED but NOT string-blanked source: the needles
/// under test ARE the format-string contents, so blanking literals would make
/// every one of them vacuous. Comment stripping is still mandatory — the fix's
/// own explanatory comment will name both `npc_id` and `json_escape`.
///
/// KILLS, per row: an escape computed but not interpolated; the raw value left
/// in the call beside a new escaped binding (the belt-and-braces shell); a
/// shadow-rebind of the escaped name; a log line deleted or duplicated instead
/// of fixed (exact site count); a fix applied to only ONE of the two arms (the
/// `>= 2` call count); and — H3, via the ARGUMENT in the provenance needle —
/// `json_escape(&"placeholder")`, which otherwise satisfies every other layer
/// while logging a constant in place of the npc_id the line exists to report.
#[test]
fn sync_npc_entities_from_log_sites_escape_the_npc_id() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    let fn_head = ["fn sync_npc_entities", "_from("].concat();
    let body = m13_5c_fn_body(&stripped, fn_head.as_str());

    let binding = ["escaped", "_npc_id"].concat();
    let capture = ["{", binding.as_str(), "}"].concat();

    let rows = vec![
        D12rLogSite {
            evt: ["npc_sync", "_remove"].concat(),
            discriminator: String::new(),
            expected_sites: 1,
            raw: ["{npc", "_id}"].concat(),
            capture: capture.clone(),
        },
        D12rLogSite {
            evt: ["npc_sync", "_repair"].concat(),
            discriminator: String::new(),
            expected_sites: 1,
            raw: ["npc.npc", "_id"].concat(),
            capture: capture.clone(),
        },
    ];

    // H3: the two arms hold the npc_id under different names — the `Remove` arm
    // destructures `npc_id` out of the action, the `Repair` arm holds the whole
    // `npc` row — so BOTH argument spellings are accepted, and the `.as_str()`
    // form of each is accepted too (it is equally correct and equally specific).
    // A placeholder literal matches none of them.
    let escape_args = [
        "&npc_id)",
        "npc_id.as_str())",
        "&npc.npc_id)",
        "npc.npc_id.as_str())",
    ];

    d12r_assert_escaped_log_sites(
        "content.rs / sync_npc_entities_from",
        body,
        &rows,
        binding.as_str(),
        &escape_args,
        2,
    );
}

// ===========================================================================
// 12r-e ITEM 3 / EARS E4 — duplicate-(from, to)-pair rejection has EXACTLY ONE
// enforcement point, and its comment describes it accurately.
//
// THE DEFECT. `content.rs:66-82` calls `validate_evolution_paths(..)` (game-core's
// R1-R12 content gate) and then, IMMEDIATELY afterwards — same function, same
// unmutated `evolution_paths` Vec, nothing in between — re-runs a
// `HashSet<(from_species, to_species)>` duplicate-pair scan of its own.
// game-core's R1 (`game-core/src/content.rs:961-972`) is the IDENTICAL algorithm
// keyed on the IDENTICAL pair, so the server-side block is provably unreachable:
// any input that would trip it has already returned `Err` one statement earlier.
// Its own comment nevertheless calls it "the LAST line of defense", which is the
// part that actually costs something — a future reader trusting that comment
// believes duplicate-pair rejection is enforced HERE, and could weaken or delete
// the real gate in game-core without any test going red.
//
// THE FIX IS A DELETION: remove the block. E4 is then "one enforcement point,
// truthfully described".
//
// WHY THIS SHAPE OF ASSERTION (a previous draft was defeated). Asserting
// `body.matches("seen_pairs").count() == 0` is beaten by re-adding the identical
// block under any other binding name (`dup_guard`, `pairs`, ...) — a pure rename
// with zero behaviour change. The three needles below are asserted instead
// because they are the block's STRUCTURE, not its vocabulary: a duplicate-pair
// scan needs a set type, the path to that type, and a tuple insert. Renaming the
// binding changes none of them. (`seen_pairs` is also a bad baseline for a second
// reason: it appears TWICE in content.rs, at :73 and :75, not once.)
// ===========================================================================

/// **12r-e E4** — after the fix there is EXACTLY ONE duplicate-(from, to)-pair
/// enforcement point, and it is game-core's R1.
///
/// Scoped to the brace-matched body of `sync_content_inner` (comment-stripped
/// first, so neither the doomed block's own comment nor this test's rationale can
/// satisfy anything). Measured baseline at HEAD, inside that body:
///   * `HashSet`       — 1 occurrence (content.rs:73)
///   * `collections::` — 1 occurrence (content.rs:73)
///   * `.insert((`     — 1 occurrence (content.rs:75)
/// All three ARE the backstop, and all three must fall to 0. The three other
/// `HashSet` uses in content.rs (`sync_content_inner_recheck` :342,
/// `stale_zone_def_ids` :403, `stale_heal_location_ids` :423,
/// `sync_npc_entities_from` :689) are in DIFFERENT functions and are excluded by
/// the body extraction — the two boundary assertions below prove that exclusion
/// rather than assuming it.
///
/// VACUITY LAYER (load-bearing, do not remove). `validate_evolution_paths(` must
/// still be called EXACTLY ONCE in the same body. Without it, deleting the
/// validation call outright would also drive all three counts to 0 and this test
/// would report "one enforcement point" while there were ZERO — a real false
/// green, and a far worse outcome than the redundancy being removed.
///
/// HONEST LIMITS. (a) This is a SOURCE SCAN, not an execution: this crate has no
/// `ReducerContext` test harness (`content_tests.rs:144`), so `sync_content_inner`
/// cannot be run here at all. It proves the SHAPE of the seed gate, never that a
/// duplicate pair is rejected at runtime. (b) The behavioural proof of the
/// surviving enforcement point is NOT here and must not be duplicated here: it is
/// `game-core/src/content.rs`'s `r1_duplicate_from_to_pair_rejected` (~:3210),
/// which is a strictly stronger test of the same property (it builds a duplicate
/// pair and asserts the `Err`). This test only proves the server no longer
/// carries a second, unreachable copy of that rule. (c) A duplicate-pair scan
/// written with a `Vec` + `.contains(..)` instead of a `HashSet`, or with
/// `BTreeSet`, would evade all three needles. That is accepted: the point of E4
/// is the DELETION plus the truthful comment, and the vacuity layer keeps the
/// real gate wired; an implementer who re-adds the redundancy in a new spelling
/// has to do so deliberately, against this test's documented intent.
#[test]
fn r1_duplicate_pair_has_exactly_one_enforcement_point() {
    let stripped = m13_5c_strip_rust_comments(M13_5C_CONTENT_RS_SOURCE);
    // Same fn needle the sibling 13.5c-2 guard uses (line ~688). The `(ctx`
    // suffix excludes `sync_content_inner_recheck(` even though the reducer is
    // declared first in the file.
    let body = m13_5c_fn_body(&stripped, "fn sync_content_inner(ctx");
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();

    // --- Extraction boundary: prove the body is the one we mean --------------
    // Both directions matter. Undershooting (the brace walk stopping early, e.g.
    // on an unbalanced brace inside a log format string) would drop the backstop
    // from the window and turn every count below into a vacuous 0. Overshooting
    // into `sync_content_inner_recheck` / `stale_zone_def_ids` would import THEIR
    // legitimate `HashSet`s and make the fix impossible to land.
    let tail_anchor = ["recompute_monster_derived", "_fields(&mutm,"].concat();
    assert!(
        compact.contains(tail_anchor.as_str()),
        "SCAN PRECONDITION (12r-e E4): the extracted `sync_content_inner` body does \
         not reach its own re-derive tail ({tail_anchor:?}, content.rs:301). The \
         brace walk stopped early, so the window scanned below is only a PREFIX of \
         the function and every count in this test is untrustworthy. Fix the \
         extractor before trusting any verdict here."
    );
    let next_fn = ["sync_content_inner", "_recheck"].concat();
    assert!(
        !compact.contains(next_fn.as_str()),
        "SCAN PRECONDITION (12r-e E4): the extracted `sync_content_inner` body \
         spills into `{next_fn}` (content.rs:333), whose own `HashSet<u32>` is \
         legitimate. The counts below would then never reach 0 no matter what the \
         implementer deletes — a permanent false RED. Fix the extractor."
    );

    // --- Vacuity layer: the REAL enforcement point is still called -----------
    let validate = ["validate_evolution", "_paths("].concat();
    let n_validate = compact.matches(validate.as_str()).count();
    assert_eq!(
        n_validate, 1,
        "VACUITY GUARD (12r-e E4): `sync_content_inner` must call \
         `{validate}..)` EXACTLY once; found {n_validate}. This is what makes the \
         three zero-counts below mean `exactly one enforcement point` rather than \
         `none`. game-core's R1 IS the enforcement point (its behavioural test is \
         `r1_duplicate_from_to_pair_rejected` in game-core/src/content.rs) — \
         deleting the seed-gate backstop is only safe while this call survives. \
         Two calls would mean the gate was duplicated instead of the backstop \
         removed."
    );

    // --- The backstop is GONE, asserted on SHAPE not on identifier ----------
    let hash_set = ["Hash", "Set"].concat();
    let n_hash_set = compact.matches(hash_set.as_str()).count();
    assert_eq!(
        n_hash_set, 0,
        "TEETH (12r-e E4): `sync_content_inner`'s body still mentions `{hash_set}` \
         {n_hash_set} time(s); it must mention it ZERO times. RED at HEAD: 1 \
         (content.rs:73). The ONLY `{hash_set}` in this function is the \
         duplicate-(from, to)-pair backstop at content.rs:68-82, and that block is \
         DEAD CODE: `validate_evolution_paths` returned `Ok` one statement earlier \
         over the SAME unmutated `evolution_paths` Vec, and game-core's R1 \
         (game-core/src/content.rs:961-972) is the identical algorithm on the \
         identical key — so no input can ever reach the `return Err` inside it. \
         What it does do is LIE: its comment calls itself `the LAST line of \
         defense`, so a future reader believes duplicate rejection is enforced here \
         and can gut the real gate in game-core with every test still green. Delete \
         the block. This assertion is on the SHAPE (a set type) rather than on the \
         `seen_pairs` binding name on purpose — renaming the block to `dup_guard` \
         is a zero-behaviour-change evasion of a name-based check."
    );

    let collections = ["collections", "::"].concat();
    let n_collections = compact.matches(collections.as_str()).count();
    assert_eq!(
        n_collections, 0,
        "TEETH (12r-e E4): `sync_content_inner`'s body still mentions \
         `std::{collections}` {n_collections} time(s); it must mention it ZERO \
         times. RED at HEAD: 1 (content.rs:73). This is the second of three \
         structural needles on the dead duplicate-pair backstop; it survives an \
         evasion that imports the set type at the top of the file to shorten the \
         path at the use site. The other functions in content.rs that legitimately \
         use a set (`sync_content_inner_recheck`, `stale_zone_def_ids`, \
         `stale_heal_location_ids`, `sync_npc_entities_from`) are OUTSIDE this \
         body and are unaffected — the boundary assertions above prove that."
    );

    let tuple_insert = [".insert", "(("].concat();
    let n_tuple_insert = compact.matches(tuple_insert.as_str()).count();
    assert_eq!(
        n_tuple_insert, 0,
        "TEETH (12r-e E4): `sync_content_inner`'s body still performs a \
         tuple-keyed `{tuple_insert}..))` {n_tuple_insert} time(s); it must perform \
         ZERO. RED at HEAD: 1 (content.rs:75, `seen_pairs.insert((p.from_species, \
         p.to_species))`). This is the third structural needle and the most \
         specific one: a duplicate-PAIR scan is defined by inserting the pair, so \
         this survives both a rename of the binding AND a swap of the set type's \
         import path. Note the needle is whitespace-insensitive (the body is \
         compacted first), so a rustfmt line split cannot false-GREEN it."
    );
}
