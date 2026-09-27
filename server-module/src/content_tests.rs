//! `content_tests` — gating tests for the `sync_content_inner` seam.
//!
//! Declared from `content.rs` as:
//!   `#[cfg(test)] #[path = "content_tests.rs"] mod content_tests;`
//! so `super` resolves to the `content` module.
//!
//! Pattern: these tests call the pure-seam helpers exposed by the implementation
//! and verify concrete state changes. No SpacetimeDB live context is used.

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
// sync_content_inner returns Result<(), String>
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
// ---------------------------------------------------------------------------

/// Calling sync_content_inner must produce a Result<(), String> return value.
///
/// KILLS: a unit-return (()) implementation — `.is_ok()` on `()` is a compile error.
///
/// NOTE: because the real sync_content_inner requires a live SpacetimeDB ReducerContext
/// (which is not constructible in unit tests), this test validates the signature via
/// the structural source-scan in content.rs::tests and via a call to a seam helper
/// `sync_content_inner_recheck`.
#[test]
fn sync_content_inner_recheck_returns_result_on_valid_input() {
    // Load real content (same as the existing content_parses_and_validates test).
    let species = game_core::load_species().expect("species must parse for this test");
    let paths = game_core::load_evolution_paths().expect("evolution paths must parse");

    // Call the pure validation seam.
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

/// the recheck seam must return Err when given an empty
/// species slice (a degenerate content state that must be rejected before any DB write).
///
/// KILLS: a recheck seam that always returns Ok regardless of input (would allow an
/// empty content registry to wipe the live DB's species table with no rows).
#[test]
fn sync_content_inner_recheck_rejects_empty_species() {
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
// Monster re-derive pass
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

/// After recompute_monster_derived_fields with new species (higher base_hp),
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

    // Call the re-derive seam.
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

/// After recompute_monster_derived_fields, current_hp is clamped to new stat_hp
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

// ===========================================================================
// content lifecycle completion.
//
// WHEN a zone is removed from the zone RON, sync_content must
//   delete its zone_def row AND no movement_tick_schedule row for that zone
//   remains after the sync.
// the zero-owner-identity Err path in `sync_content` (lib.rs)
//   must prescribe the ONLY working remedy (`spacetime publish --delete-data`)
//   and must NOT keep the impossible "re-publish to register" prescription
//   (init only runs at DB creation; a plain re-publish never re-registers).
//
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

/// A zone_id present in the DB (`existing`) but absent from the
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

/// Identical sets (regardless of order) → nothing is stale.
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

/// Output is sorted ascending (deterministic reducer behavior —
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
// plan_schedule_reconcile — pure extraction of ensure_zone_schedules'
// diff logic (lib.rs) so "no schedule row remains for a removed zone" is an
// honest behavioral test, not a structural one.
//
// Contract: `crate::plan_schedule_reconcile(zone_ids: &[u32],
//   scheduled: &[(u64, u32)]) -> (Vec<u64>, Vec<u32>)`
// where `scheduled` is (schedule row id, zone_id) pairs; returns
// (schedule row ids to remove, zone ids to add).
// ---------------------------------------------------------------------------

/// zone 2's zone_def was removed → its schedule row (id=11) must be
/// planned for removal, and applying the plan leaves NO schedule row
/// pointing at zone 2.
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

    // Derive the postcondition: after applying the plan, no schedule
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

/// A zone present in zone_ids but with no schedule row must be
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

/// idempotence: steady state (every zone scheduled exactly once,
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
// `plan_npc_sync` planner tests.
//
// EXPECTED CONTRACT:
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
//   - deterministic: actions sorted by npc_id;
//   - actions carry COMPLETE replacement Npc/Character row values;
//   - Update preserves entity_id (NEVER delete+reinsert: auto_inc would
//     orphan player_conversation.npc_entity_id + break client identity);
//   - zone SAME -> tile/facing/action/queue/move_started_at_ms preserved
//     verbatim; zone CHANGED -> respawn at def spawn, facing South, Idle,
//     cleared queue, move_started_at_ms 0; character sprite_id = def always;
//   - half-orphan (Npc, None) -> Repair = delete orphan npc row + fresh
//     insert; never a bare Insert (unique npc_id panic),
//     never silently skipped;
//   - identical existing<->defs -> EMPTY plan (idempotence). Live wander
//     state (tile/facing/queue/timestamps) is NOT a diff: sync_content runs
//     on every content-version bump and NPCs wander constantly, so diffing
//     live state would churn every sync.
//
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

/// TRIVIAL apply fold. It only mirrors the DB constraints the shell hits:
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

/// sync twice with changed RON — first plan seeds, the
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

/// def.zone_id != existing npc.zone_id -> the Update's replacement character
/// RESPAWNS at the new def's spawn tile in the new zone with reset live
/// state.
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

/// def changed but zone SAME
/// -> tile/facing/action/queue/move_started_at_ms preserved verbatim.
///
/// the new home (90,91) radius 1 leaves the live tile (20,21) OUTSIDE the
/// wander radius — convergence from an out-of-radius start is the wander
/// drive's (npc_decide) concern, not sync's; the planner must still preserve
/// the live tile.
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

/// identical existing<->defs -> EMPTY plan, even
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

/// existing [(npc X, None)] with X still in defs must plan removal of the
/// orphan npc row PLUS a fresh insert (Repair, or Remove+Insert semantics)
/// — never a bare Insert, never a silent skip.
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

/// over ALL 8^3 = 512 per-npc scenario combinations (absent / new / dropped
/// / unchanged / changed-same- zone / changed-zone / orphan+def /
/// orphan-no-def x 3 npc_ids), folding the plan over `existing` yields
/// EXACTLY the def npc_id set, each exactly once, every survivor fully
/// paired, and the plan npc_id-sorted.
/// Deterministic exhaustive enumeration — no RNG, no new deps (proptest is
/// already a dev-dep but adds nothing over full enumeration here).
///
/// NOTE on depth: this 512-grid checks the SET-MEMBERSHIP
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

// ---------------------------------------------------------------------------
// Single-field plan_npc_sync mutation-killing tests
//
// The exhaustive test above (m13_5c_plan_npc_sync_exhaustive_apply_yields_exact_def_set)
// changes MULTIPLE fields simultaneously (home_x += 5 AND sprite_id = 9), so the
// `||→&&` mutants survive: `(false && true) || true = true`
// still reaches the Update branch.
//
// These tests change EXACTLY ONE FIELD at a time, so a single `||→&&` mutant
// can flip the entire condition to false and suppress the Update.
//
// ---------------------------------------------------------------------------

/// plan_npc_sync detects a SINGLE home_x change and emits an Update.
///
/// Operator-precedence kill: the changes the first `||`
/// to `&&`, making: `(zone_id!=def.zone_id && home_x!=def.home_x) || home_y!=...`.
/// With zone SAME (a=false) and ONLY home_x changed (b=true):
///   mutant → (false && true) || false || false || false = false → no Update (WRONG)
///   original → false || true || false || false || false = true → Update (correct)
///
/// KILLS: (|| → && between zone_id and home_x terms).
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
/// Mutant changes `|| home_y!=` to `&& home_y!=`, making:
///   `zone!=... || (home_x!=... && home_y!=...) || wander!=... || dialogue!=...`
/// With zone SAME, home_x SAME, ONLY home_y changed:
///   mutant → false || (false && true) || false || false = false → no Update (WRONG)
///   original → false || false || true || false || false = true → Update (correct)
///
/// KILLS: (|| → && between home_x and home_y terms).
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
/// Mutant changes `|| wander_radius!=` to `&& wander_radius!=`, making:
///   `zone!=... || home_x!=... || (home_y!=... && wander_radius!=...) || dialogue!=...`
/// With zone/home_x/home_y SAME, ONLY wander_radius changed:
///   mutant → false || false || (false && true) || false = false → no Update (WRONG)
///   original → false || false || false || true || false = true → Update (correct)
///
/// KILLS: (|| → && between home_y and wander_radius terms).
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
/// Mutant changes `|| dialogue_tree_id!=` to `&& dialogue_tree_id!=`, making:
///   `zone!=... || home_x!=... || home_y!=... || (wander_radius!=... && dialogue_tree_id!=...)`
/// With zone/home_x/home_y/wander_radius SAME, ONLY dialogue_tree_id changed:
///   mutant → false || false || false || (false && true) = false → no Update (WRONG)
///   original → false || false || false || false || true = true → Update (correct)
///
/// KILLS: (|| → && between wander_radius and dialogue_tree_id terms).
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
// stale_heal_location_ids pure-seam unit tests + source-scan
//
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

/// removed id is detected.
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

/// identical sets (shuffled) → empty.
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

/// output sorted ascending.
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

/// plan_npc_sync detects a SINGLE sprite_id change (no npc field change) and emits an Update.
///
/// Mutant changes `|| ch.sprite_id!=` to `&& ch.sprite_id!=` in:
///   `let character_stale = ch.zone_id != def.zone_id || ch.sprite_id != def.sprite_id;`
/// With zone SAME (ch.zone_id == def.zone_id → false), ONLY sprite_id changed:
///   mutant → false && true = false → character_stale = false
///   If npc_row_stale is also false (no npc fields changed) → no Update (WRONG)
///   original → false || true = true → character_stale = true → Update (correct)
///
/// KILLS: (|| → && in character_stale zone_id/sprite_id check).
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
// The `interaction` column: def -> row threading, the
// staleness OR-chain, and the validator wiring in sync_content_inner.
//
// ---------------------------------------------------------------------------

/// every field explicit, interaction included.
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

/// the (Npc, Character) rows a correct seed derives
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

/// `npc_row_from_def` copies `def.interaction` onto the row.
///
/// KILLS: an `npc_row_from_def` that hard-codes `NpcInteraction::Dialogue`
/// — the public `npc` table would then carry Dialogue for every NPC no matter
/// what the RON says, the client would derive no Shop affordance.
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

/// `plan_npc_sync` emits an Update when ONLY `interaction` differs,
/// and that Update carries the NEW interaction.
///
/// `npc_row_stale` is a hand-maintained OR-chain, so a def-derived column that
/// never joins the chain re-syncs exactly never. Every other def-derived field
/// already has this tooth
/// (home_x/home_y/wander_radius/dialogue_tree_id/sprite_id above).
///
/// KILLS: an `npc_row_stale` that omits `|| npc.interaction !=
/// def.interaction`. A live world keeps the stale interaction forever: sync
/// bumps CONTENT_VERSION, plans nothing, and the shopkeeper stays mute — the
/// exact defect a `just smoke-republish` would surface only in prod.
/// ALSO KILLS: the `||`->`&&` mutant on the newly added chain term (only ONE
/// field changes here, so the conjunction collapses to false and suppresses the
/// Update).
/// KILLS: an Update whose npc row is rebuilt from the LIVE row instead of
/// `npc_row_from_def(def, ..)` — it would be planned but write back the old
/// Dialogue value.
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

/// a pair matching its def on a NON-default interaction plans NOTHING.
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

/// a SHORT `StatusKind` roster must be REJECTED.
///
/// the roster is hand-maintained, so the gate has to notice when a variant was
/// added to the enum but not to the roster. Passing the first 4 of the 5
/// shipped entries simulates exactly that drift (5 declared variants, 4
/// rostered).
///
/// KILLS: a `check_roster_is_total` that only ever returns `Ok(())` (a stub, or
/// one that compares the roster against itself, or one that `zip`s the two
/// lists and so silently stops at the shorter one).
///
/// The message clauses pin the Err-message contract stated in the block header:
/// the enum name plus BOTH counts. Without the counts the operator reading a CI
/// failure cannot tell which side drifted.
#[test]
fn rb54_short_status_roster_is_rejected() {
    let full: [game_core::StatusKind; 5] = game_core::content::STATUS_KIND_ALL;
    let short = &full[..4];

    let outcome = super::check_roster_is_total::<game_core::StatusKind>("StatusKind", short);
    let msg = outcome.expect_err(
        "TEETH(rb-54 A): check_roster_is_total accepted a 4-entry StatusKind \
         roster while the type declares 5 variants. That is the shipped defect \
         in miniature — the validator must compare the roster length against \
         the REFLECTED variant count and return Err on a mismatch, not zip or \
         truncate to the shorter of the two. Returned",
    );

    assert!(
        msg.contains("StatusKind"),
        "TEETH(rb-54 A): the rejection message must name the enum it is about \
         (the `enum_name` argument, verbatim) so a CI failure says WHICH roster \
         drifted; got {msg:?}"
    );
    assert!(
        msg.contains('5'),
        "TEETH(rb-54 A): the rejection message must state the REFLECTED variant \
         count (5 for StatusKind) so the reader knows what the type declares; \
         got {msg:?}"
    );
    assert!(
        msg.contains('4'),
        "TEETH(rb-54 A): the rejection message must state the ROSTER length (4 \
         here) so the reader knows what the hand-written list contains; got \
         {msg:?}"
    );
}

/// a SHORT `Affinity` roster must be REJECTED, and the message
/// must attribute the failure to Affinity.
///
/// KILLS: a `check_roster_is_total` that is hard-wired to StatusKind (reflects
/// StatusKind regardless of `T`, or ignores `enum_name` and prints a fixed
/// string). Such an impl passes tooth A and mis-attributes every Affinity
/// failure, sending the next author to the wrong roster.
#[test]
fn rb54_short_affinity_roster_is_rejected() {
    let full: [game_core::Affinity; 8] = game_core::Affinity::ALL;
    let short = &full[..7];

    let outcome = super::check_roster_is_total::<game_core::Affinity>("Affinity", short);
    let msg = outcome.expect_err(
        "TEETH(rb-54 B): check_roster_is_total accepted a 7-entry Affinity \
         roster while the type declares 8 variants. Affinity::ALL is the second \
         hand-maintained roster behind validate_a11y_tokens and must be checked \
         by the same rule as StatusKind. Returned",
    );

    assert!(
        msg.contains("Affinity"),
        "TEETH(rb-54 B): the rejection message must name Affinity — an impl that \
         prints a hard-coded `StatusKind` (or ignores `enum_name`) points the \
         next author at the wrong roster; got {msg:?}"
    );
    assert!(
        msg.contains('8'),
        "TEETH(rb-54 B): the rejection message must state Affinity's REFLECTED \
         variant count (8); got {msg:?}"
    );
    assert!(
        msg.contains('7'),
        "TEETH(rb-54 B): the rejection message must state the ROSTER length (7 \
         here); got {msg:?}"
    );
}

/// POSITIVE CONTROL: the SHIPPED rosters are total, so the
/// production entry point must return `Ok(())` today.
///
/// KILLS: an always-Err validator (which would satisfy teeth A, B and E1 while
/// making every `sync_content` call fail), and a reflection helper whose Err
/// branch fires on the real enums.
///
/// FENCE NOTE: this test is also the alarm for a genuine future drift — when a
/// 6th StatusKind (or 9th Affinity) variant is added without growing the
/// roster, THIS test goes red in CI. That red is the feature, not a regression:
/// fix the roster, do not weaken the test.
#[test]
fn rb54_shipped_rosters_are_total() {
    let outcome = super::validate_enum_rosters();
    assert!(
        outcome.is_ok(),
        "TEETH(rb-54 C): validate_enum_rosters must accept the SHIPPED rosters \
         (STATUS_KIND_ALL has all 5 StatusKind variants, Affinity::ALL has all \
         8 Affinity variants). An Err here means either the validator is \
         unconditionally rejecting (which would break every sync_content call) \
         or a roster has genuinely drifted from its enum — in the latter case \
         add the missing entry to the roster, never relax this test. Got: \
         {outcome:?}"
    );
}

/// the reflection ORACLE returns the DECLARED variant names.
///
/// The expected names are written as LITERALS, not derived from the same
/// roster the gate is supposed to police. A test that compared reflection to
/// `STATUS_KIND_ALL` would be circular: it would pass for a 6th variant that is
/// missing from the roster, which is the exact defect.
///
/// KILLS: a `reflected_variant_names` that returns the roster back, an empty
/// vec, a vec of indices, or the names of the wrong type; and a length-only
/// oracle (one that returns `Result<usize, _>` in spirit) — the NAMES are what
/// let a future maintainer see WHICH variant is unrostered.
#[test]
fn rb54_reflection_returns_declared_variant_names() {
    let status_outcome = super::reflected_variant_names::<game_core::StatusKind>("StatusKind");
    let status = status_outcome.expect(
        "TEETH(rb-54 D): reflecting StatusKind must succeed — it is a fieldless \
         enum with a derived SpacetimeType, so it reflects to a named-variant \
         sum. The oracle returned",
    );
    assert!(
        !status.is_empty(),
        "TEETH(rb-54 D): reflecting StatusKind returned ZERO variant names. An \
         empty oracle makes every roster look total (0 == 0 is never asserted, \
         but a truncating comparison would pass) — the Err branch must fire on \
         a zero-variant sum instead of returning an empty vec"
    );
    assert_eq!(
        status,
        ["Poison", "Burn", "Paralysis", "Sleep", "Freeze"],
        "TEETH(rb-54 D): reflected StatusKind variant names must equal the five \
         DECLARED variants, in declaration order (measured spike). If this list \
         changed because a variant was added, that is the drift this slice \
         exists to catch: add the variant to STATUS_KIND_ALL and to the a11y \
         token table, then update this literal DELIBERATELY, from the spec"
    );

    let affinity_outcome = super::reflected_variant_names::<game_core::Affinity>("Affinity");
    let affinity = affinity_outcome.expect(
        "TEETH(rb-54 D): reflecting Affinity must succeed — it is a fieldless \
         enum with a derived SpacetimeType. The oracle returned",
    );
    assert!(
        !affinity.is_empty(),
        "TEETH(rb-54 D): reflecting Affinity returned ZERO variant names; see \
         the StatusKind clause above for why an empty oracle is a false green"
    );
    assert_eq!(
        affinity,
        ["Fire", "Water", "Plant", "Electric", "Earth", "Wind", "Light", "Dark"],
        "TEETH(rb-54 D): reflected Affinity variant names must equal the eight \
         DECLARED variants, in declaration order (measured spike). The order is \
         load-bearing elsewhere too — Affinity::ALL is the canonical layout of \
         the eight flat essence columns (EG1-1/EG1-7, ADR-0174 D1)"
    );
}

/// a roster with a REPEATED entry must be REJECTED.
///
/// The fixture has exactly 5 entries, so the length clause is satisfied: ONLY a
/// pairwise-distinctness clause can catch it.
///
/// KILLS: a length-only `check_roster_is_total`. That impl calls a roster of
/// `[Poison, Poison, Burn, Paralysis, Sleep]` total while `Freeze` is missing —
/// which is precisely the shipped defect wearing a different hat (the a11y
/// `required` set would still be short one key).
#[test]
fn rb54_duplicate_roster_entry_is_rejected() {
    let dup: [game_core::StatusKind; 5] = [
        game_core::StatusKind::Poison,
        game_core::StatusKind::Poison,
        game_core::StatusKind::Burn,
        game_core::StatusKind::Paralysis,
        game_core::StatusKind::Sleep,
    ];

    let outcome = super::check_roster_is_total::<game_core::StatusKind>("StatusKind", &dup);
    let msg = outcome.expect_err(
        "TEETH(rb-54 E1): check_roster_is_total accepted a 5-entry StatusKind \
         roster that lists Poison TWICE and omits Freeze. The length clause \
         alone cannot see this — the validator must ALSO require the roster \
         entries to be pairwise distinct (that is what the `PartialEq` bound on \
         T is for). Returned",
    );

    assert!(
        msg.contains("StatusKind"),
        "TEETH(rb-54 E1): the duplicate-entry rejection must name the enum it is \
         about (the `enum_name` argument, verbatim); got {msg:?}"
    );
}

/// the reflection oracle's Err branch is REACHABLE.
///
/// `u32` reflects to `AlgebraicType::U32`, which is not a named-variant sum, so
/// the one Err branch of `reflected_variant_names` must fire.
///
/// KILLS: an oracle whose Err branch is dead (e.g. one that unwraps/expects the
/// sum and would PANIC a reducer instead of returning Err, or one that returns
/// `Ok(vec![])` for a non-sum — which tooth D's non-empty clause only covers
/// for the two real enums).
#[test]
fn rb54_reflection_rejects_a_non_sum_type() {
    let outcome = super::reflected_variant_names::<u32>("u32");
    assert!(
        outcome.is_err(),
        "TEETH(rb-54 E2): reflecting a non-sum type must return Err, never Ok \
         and never a panic. A panicking oracle inside sync_content_inner aborts \
         the reducer with no diagnostic; an Ok here means the not-a-named-sum \
         branch is dead code. Got: {outcome:?}"
    );
}

/// the oracle is driven by its TYPE PARAMETER, not by
/// its diagnostic label.
///
/// `enum_name` is documented as diagnostic only, so reflecting `Affinity` while
/// labelling the call `StatusKind` must still return the eight Affinity names.
/// An oracle that branches on the label returns the five status names here.
///
/// Deliberately mismatching the label is what makes the two implementations
/// diverge.
#[test]
fn rb54_oracle_is_driven_by_the_type_not_the_label() {
    let names = super::reflected_variant_names::<game_core::Affinity>("StatusKind")
        .expect("reflecting Affinity must succeed regardless of the diagnostic label");

    assert_eq!(
        names,
        vec![
            "Fire".to_string(),
            "Water".to_string(),
            "Plant".to_string(),
            "Electric".to_string(),
            "Earth".to_string(),
            "Wind".to_string(),
            "Light".to_string(),
            "Dark".to_string(),
        ],
        "TEETH(rb-54 J): reflected_variant_names must reflect its TYPE PARAMETER \
         and treat enum_name as a diagnostic string only. Reflecting Affinity \
         under the label StatusKind returned {names:?}. If that is the five \
         status names, the oracle is branching on the label and reflecting some \
         other type — a MEASURED bypass that leaves the roster gate dead while \
         every name-comparing tooth stays green, because StatusKind and \
         StatusEffect declare identical variant names."
    );
}

// ===========================================================================
// Native-host content sync.
//
// The shipped code runs against the SHIPPED RON through the native host; the
// expected values are read from the same game-core loaders it reads.
//
// Not drivable here: "invalid zone maps are rejected before any write".
// Content is compiled-in RON with no injection seam, so
// no invalid map can reach sync_content_inner; the rejection predicate itself is
// game-core's validate_zone_maps (unit-tested there).
// ===========================================================================
mod nh_sync {
    use crate::accounts::AccountDeletionReaperSchedule;
    use crate::movement::MovementTickSchedule;
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::observability::MrHeartbeatSchedule;
    use crate::playtest::PlaytestReaperSchedule;
    use crate::privacy::ExportBundleReaperSchedule;
    use crate::schema::{
        Account, Character, Config, EncounterRow, EvolutionPathRow, HealLocationRow, ItemRow,
        Monster, MonsterPub, Npc, PlayerConversation, ShopItemRow, ShopRow, SkillRow, SpeciesRow,
        TypeRelationRow, ZoneDefRow,
    };
    use crate::CONTENT_VERSION;
    use spacetimedb::Identity;

    fn owner() -> Identity {
        Identity::from_byte_array([77u8; 32])
    }

    fn bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
        spacetimedb::sats::bsatn::to_vec(row).expect("rows encode")
    }

    /// Every table `init` / `sync_content` touch, registered writable + scannable.
    struct World<'a> {
        config: Handle<'a, Config, u32>,
        zones: Handle<'a, ZoneDefRow, u32>,
        species: Handle<'a, SpeciesRow, u32>,
        items: Handle<'a, ItemRow, u32>,
        paths: Handle<'a, EvolutionPathRow, u64>,
        npcs: Handle<'a, Npc, u64>,
        heals: Handle<'a, HealLocationRow, u32>,
        ticks: Handle<'a, MovementTickSchedule, u64>,
    }

    fn world(fx: &Fixture) -> World<'_> {
        let _ = fx
            .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
            .writable()
            .scannable()
            .unique();
        let _ = fx
            .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
            .writable()
            .unique();
        let _ = fx
            .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .writable()
            .unique()
            .auto_inc(|r| r.entity_id, |r, id| r.entity_id = id);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        let _ = fx
            .table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
            .writable()
            .scannable()
            .unique();
        let _ = fx
            .table_keyed::<TypeRelationRow, u64>("type_relation_row", "id", |r| r.id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, id| r.id = id);
        let _ = fx
            .table_keyed::<ShopItemRow, u64>("shop_item_row", "shop_item_id", |r| r.shop_item_id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.shop_item_id, |r, id| r.shop_item_id = id);
        let _ = fx.table_keyed::<ShopItemRow, u32>("shop_item_row", "shop_id", |r| r.shop_id);
        let _ = fx
            .table_keyed::<ShopRow, u32>("shop_row", "shop_id", |r| r.shop_id)
            .writable()
            .scannable()
            .unique();
        let _ = fx
            .table_keyed::<EncounterRow, u32>("encounter", "zone_id", |r| r.zone_id)
            .writable()
            .scannable()
            .unique();
        let _ = fx.table_keyed::<EvolutionPathRow, u32>("evolution_path", "from_species", |r| {
            r.from_species
        });
        let _ = fx.table_keyed::<Npc, u32>("npc", "zone_id", |r| r.zone_id);
        let _ =
            fx.table_keyed::<HealLocationRow, u32>("heal_location_row", "zone_id", |r| r.zone_id);
        let _ = fx
            .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                r.owner_identity
            })
            .writable()
            .scannable();
        // init / sync_content's singleton + per-account reaper arms.
        let _ = fx
            .table_keyed::<PlaytestReaperSchedule, u64>("playtest_reaper_schedule", "id", |r| r.id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, id| r.id = id);
        let _ = fx
            .table_keyed::<MrHeartbeatSchedule, u64>("mr_heartbeat_schedule", "id", |r| r.id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, id| r.id = id);
        let _ = fx
            .table_keyed::<ExportBundleReaperSchedule, u64>(
                "export_bundle_reaper_schedule",
                "id",
                |r| r.id,
            )
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, id| r.id = id);
        let _ = fx
            .table::<Account>("account", "identity", |r| r.identity)
            .unique()
            .writable()
            .scannable();
        let _ = fx
            .table::<AccountDeletionReaperSchedule>(
                "account_deletion_reaper_schedule",
                "account_identity",
                |r| r.account_identity,
            )
            .writable()
            .scannable()
            .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v);
        World {
            config: fx
                .table_keyed::<Config, u32>("config", "id", |r| r.id)
                .writable()
                .unique(),
            zones: fx
                .table_keyed::<ZoneDefRow, u32>("zone_def", "zone_id", |r| r.zone_id)
                .writable()
                .scannable()
                .unique(),
            species: fx
                .table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id)
                .writable()
                .scannable()
                .unique(),
            items: fx
                .table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id)
                .writable()
                .scannable()
                .unique(),
            paths: fx
                .table_keyed::<EvolutionPathRow, u64>("evolution_path", "path_id", |r| r.path_id)
                .writable()
                .scannable()
                .unique()
                .auto_inc(|r| r.path_id, |r, id| r.path_id = id),
            npcs: fx
                .table_keyed::<Npc, u64>("npc", "entity_id", |r| r.entity_id)
                .writable()
                .scannable()
                .unique(),
            heals: fx
                .table_keyed::<HealLocationRow, u32>("heal_location_row", "location_id", |r| {
                    r.location_id
                })
                .writable()
                .scannable()
                .unique(),
            ticks: fx
                .table_keyed::<MovementTickSchedule, u64>("movement_tick_schedule", "id", |r| r.id)
                .writable()
                .scannable()
                .unique()
                .auto_inc(|r| r.id, |r, id| r.id = id),
        }
    }

    fn seed_config(w: &World<'_>, version: u32) {
        w.config.remove(0);
        w.config.seed(&Config {
            id: 0,
            content_version: version,
            owner_identity: owner(),
        });
    }

    fn sync(fx: &Fixture) {
        let got = fx.run_as(owner(), super::super::sync_content_inner);
        assert_eq!(
            got,
            Ok(()),
            "sync_content_inner; asked {:?}",
            fx.requested_indexes()
        );
    }

    fn version(w: &World<'_>) -> u32 {
        w.config.rows()[0].content_version
    }

    /// A stale DB whose content rows carry the OPPOSITE of every shipped Option
    /// value (Some where the RON says None and vice versa), then one sync. Every
    /// Option content column must end equal to its RON value, every npc row must
    /// equal its def-derived row in full, and the version must be stamped.
    /// kills: an Option column dropped from a row literal or left to a `..old`
    /// spread (the stale value survives), a spread that loses a def field, a
    /// missing version stamp.
    #[test]
    fn nh_sync_content_lands_every_option_column_and_stamps_the_version() {
        let fx = fixture();
        let w = world(&fx);
        seed_config(&w, 0);
        let species = game_core::load_species().expect("species RON");
        let items = game_core::load_items().expect("items RON");
        let paths = game_core::load_evolution_paths().expect("evolution paths RON");
        let heals = game_core::load_heal_locations().expect("heal locations RON");
        let npcs = game_core::load_npc_defs().expect("npc RON");
        for sp in &species {
            w.species.seed(&SpeciesRow {
                id: sp.id,
                name: sp.name.clone(),
                base_hp: 1,
                base_attack: 1,
                base_defense: 1,
                base_speed: 1,
                base_sp_attack: 1,
                base_sp_defense: 1,
                affinity: sp.affinity,
                learnable_skill_ids: vec![],
                ability: if sp.ability.is_some() {
                    None
                } else {
                    Some(9_999)
                },
                tier: sp.tier,
            });
        }
        for it in &items {
            w.items.seed(&ItemRow {
                id: it.id,
                name: it.name.clone(),
                description: it.description.clone(),
                recruit_bonus: it.recruit_bonus,
                train_stat: if it.train_stat.is_some() {
                    None
                } else {
                    Some(game_core::StatKind::Speed)
                },
                train_amount: it.train_amount,
                sell_price: it.sell_price,
                cure_status: if it.cure_status.is_some() {
                    None
                } else {
                    Some(game_core::StatusKind::Poison)
                },
            });
        }
        for h in &heals {
            w.heals.seed(&HealLocationRow {
                location_id: h.location_id,
                zone_id: h.zone_id,
                tile_x: h.tile_x,
                tile_y: h.tile_y,
                cost_item_id: if h.cost_item_id.is_some() {
                    None
                } else {
                    Some(9_999)
                },
                cost_qty: h.cost_qty,
                cooldown_ms: h.cooldown_ms,
                cost_currency: h.cost_currency,
            });
        }
        // Non-vacuity: the shipped content must exercise both Some and None somewhere,
        // or the flipped seed above proves only one direction.
        assert!(
            species.iter().any(|s| s.ability.is_some()),
            "no species ability is Some"
        );
        assert!(
            items.iter().any(|i| i.train_stat.is_some()),
            "no item train_stat is Some"
        );
        assert!(
            items.iter().any(|i| i.cure_status.is_some()),
            "no item cure_status is Some"
        );
        assert!(
            paths.iter().any(|p| p.min_trust_tier.is_some()),
            "no path min_trust_tier"
        );

        sync(&fx);

        assert_eq!(
            version(&w),
            CONTENT_VERSION,
            "sync must stamp CONTENT_VERSION"
        );
        let sp_rows = w.species.rows();
        assert_eq!(
            sp_rows.len(),
            species.len(),
            "one species_row per RON species"
        );
        for sp in &species {
            let row = sp_rows.iter().find(|r| r.id == sp.id).expect("species row");
            assert_eq!(row.ability, sp.ability, "species {} ability", sp.id);
        }
        let item_rows = w.items.rows();
        assert_eq!(item_rows.len(), items.len(), "one item_row per RON item");
        for it in &items {
            let row = item_rows.iter().find(|r| r.id == it.id).expect("item row");
            assert_eq!(row.train_stat, it.train_stat, "item {} train_stat", it.id);
            assert_eq!(
                row.cure_status, it.cure_status,
                "item {} cure_status",
                it.id
            );
        }
        let path_rows = w.paths.rows();
        assert_eq!(
            path_rows.len(),
            paths.len(),
            "one evolution_path row per RON edge"
        );
        for p in &paths {
            let row = path_rows
                .iter()
                .find(|r| r.edge_id == p.edge_id)
                .expect("path row");
            assert_eq!(
                row.min_trust_tier, p.min_trust_tier,
                "edge {} trust",
                p.edge_id
            );
            assert_eq!(
                row.min_quality_time_tier, p.min_quality_time_tier,
                "edge {} quality-time",
                p.edge_id
            );
            assert_eq!(
                row.min_nutrition_pct, p.min_nutrition_pct,
                "edge {} nutrition",
                p.edge_id
            );
        }
        let heal_rows = w.heals.rows();
        assert_eq!(
            heal_rows.len(),
            heals.len(),
            "one heal_location_row per RON location"
        );
        for h in &heals {
            let row = heal_rows
                .iter()
                .find(|r| r.location_id == h.location_id)
                .expect("heal row");
            assert_eq!(
                row.cost_item_id, h.cost_item_id,
                "heal {} cost_item_id",
                h.location_id
            );
        }
        let npc_rows = w.npcs.rows();
        assert_eq!(npc_rows.len(), npcs.len(), "one npc row per RON npc");
        for def in &npcs {
            let row = npc_rows
                .iter()
                .find(|r| r.npc_id == def.npc_id)
                .expect("npc row");
            assert_eq!(
                bytes(row),
                bytes(&super::super::npc_row_from_def(def, row.entity_id)),
                "npc {} must equal its def-derived row in full",
                def.npc_id
            );
        }
    }

    /// The version gate: with the stamp current a second sync writes NOTHING (a
    /// species row deleted after the first sync stays gone), and a stale stamp
    /// reseeds (it comes back).
    /// kills: the equal-version early return deleted (reseed every init) or
    /// inverted, the stamp written before the gate.
    #[test]
    fn nh_sync_content_skips_at_the_current_version_and_reseeds_a_stale_one() {
        let fx = fixture();
        let w = world(&fx);
        seed_config(&w, 0);
        sync(&fx);
        let victim = w.species.rows()[0].id;
        assert_eq!(w.species.remove(victim), 1, "removed one species row");

        sync(&fx);
        assert!(
            !w.species.rows().iter().any(|r| r.id == victim),
            "an equal-version sync must be a no-op, but species {victim} was reseeded"
        );
        assert_eq!(version(&w), CONTENT_VERSION);

        seed_config(&w, CONTENT_VERSION.wrapping_sub(1));
        sync(&fx);
        assert!(
            w.species.rows().iter().any(|r| r.id == victim),
            "a stale-version sync must reseed species {victim}"
        );
        assert_eq!(
            version(&w),
            CONTENT_VERSION,
            "the reseed restamps the version"
        );
    }

    fn ticks_by_zone(w: &World<'_>) -> Vec<(u32, u64)> {
        let mut v: Vec<(u32, u64)> = w.ticks.rows().iter().map(|t| (t.zone_id, t.id)).collect();
        v.sort_unstable();
        v
    }

    /// A republish: `init` on a fresh DB, then the owner's `sync_content` twice
    /// (the first after one zone's schedule was lost). After every step each
    /// zone_def zone has EXACTLY one movement tick schedule; sync_content heals the
    /// lost one, and no pass adds, drops or re-mints any other schedule row or zone.
    /// kills: ensure_zone_schedules dropped from init or from sync_content (no
    /// schedule / a zone stops ticking), a non-additive reconcile (duplicate rows or
    /// fresh ids every republish), zone_def delete+reinsert.
    #[test]
    fn nh_init_then_sync_content_keeps_one_tick_schedule_per_zone() {
        let fx = fixture();
        let w = world(&fx);
        fx.run_as(owner(), crate::init);
        let zone_ids = |w: &World<'_>| {
            let mut z: Vec<u32> = w.zones.rows().iter().map(|z| z.zone_id).collect();
            z.sort_unstable();
            z
        };
        let zones = zone_ids(&w);
        assert!(!zones.is_empty(), "init seeds the shipped zones");
        let after_init = ticks_by_zone(&w);
        assert_eq!(
            after_init.iter().map(|(z, _)| *z).collect::<Vec<_>>(),
            zones,
            "init: exactly one tick schedule per zone"
        );
        assert_eq!(version(&w), CONTENT_VERSION, "init stamps the version");

        // Pass 1 takes the reseed path with one zone's schedule lost (the state a
        // republish must heal); pass 2 takes the equal-version skip path.
        let (lost_zone, lost_id) = after_init[0];
        assert_eq!(
            w.ticks.remove(lost_id),
            1,
            "dropped zone {lost_zone}'s schedule"
        );
        seed_config(&w, 0);
        let got = fx.run_as(owner(), crate::sync_content);
        assert_eq!(got, Ok(()), "sync_content pass 1");
        assert_eq!(zone_ids(&w), zones, "pass 1: zone set unchanged");
        let after_pass1 = ticks_by_zone(&w);
        assert_eq!(
            after_pass1.iter().map(|(z, _)| *z).collect::<Vec<_>>(),
            zones,
            "pass 1: sync_content restores exactly one schedule per zone"
        );
        assert!(
            after_init
                .iter()
                .filter(|(z, _)| *z != lost_zone)
                .all(|t| after_pass1.contains(t)),
            "pass 1: untouched zones keep their schedule rows and ids"
        );

        let got = fx.run_as(owner(), crate::sync_content);
        assert_eq!(got, Ok(()), "sync_content pass 2");
        assert_eq!(zone_ids(&w), zones, "pass 2: zone set unchanged");
        assert_eq!(
            ticks_by_zone(&w),
            after_pass1,
            "pass 2: the same one schedule row per zone, same ids"
        );
    }
}

// ===========================================================================
// Dialogue content contract (debloat Phase 2: EV-dialogue-client-integrity
// #ron-bundle-crossref). The client ships a hand-maintained mirror of the
// dialogue trees (client/src/ui/dialogueContent.ts) and `advance_dialogue` is
// index-based, so a drifted mirror makes the player pick a different server
// choice than the one shown. This test renders the SHIPPED trees (the game-core
// loader the server reads) into a canonical text artifact; the client test
// `client/src/ui/dialogueContent.contract.test.ts` renders the runtime
// DIALOGUE_TREES value the same way and compares it to the same file. Neither
// side parses the other's source.
//
// Canonical form (both renderers MUST agree byte-for-byte): trees sorted by id,
// nodes sorted by id within a tree, choices in authored order; one record per
// line; `\` and newlines in text escaped as `\\` and `\n`; a missing next node is
// `-`.
//     tree <id>
//     node <id>
//     text <text>
//     choice <next-node-or-dash> <text>
// Regenerate after an intentional RON change (then update dialogueContent.ts
// until the client test agrees):
//     MR_BLESS_DIALOGUE_TREES=1 cargo test -p monster-realm-module --lib dialogue_trees_contract
// ===========================================================================

const DIALOGUE_TREES_CONTRACT: &str = "../evals/baselines/dialogue-trees.txt";

fn contract_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\n', "\\n")
}

fn render_dialogue_contract(trees: &[game_core::DialogueTree]) -> String {
    let mut trees: Vec<&game_core::DialogueTree> = trees.iter().collect();
    trees.sort_by(|a, b| a.id.cmp(&b.id));
    let mut out = String::new();
    for tree in trees {
        out.push_str(&format!("tree {}\n", contract_escape(&tree.id)));
        let mut nodes: Vec<_> = tree.nodes.iter().collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        for node in nodes {
            out.push_str(&format!("node {}\n", contract_escape(&node.id)));
            out.push_str(&format!("text {}\n", contract_escape(&node.text)));
            for choice in &node.choices {
                let next = choice
                    .next_node
                    .as_deref()
                    .map_or("-".to_string(), contract_escape);
                out.push_str(&format!(
                    "choice {next} {}\n",
                    contract_escape(&choice.text)
                ));
            }
        }
    }
    out
}

/// The committed dialogue contract equals the shipped RON trees.
/// kills: a RON edit (node text, a choice added/removed/reordered, a next node)
/// that is not carried into the contract the client mirror is checked against.
#[test]
fn dialogue_trees_contract_matches_the_shipped_ron() {
    let trees = game_core::load_dialogue_trees().expect("shipped dialogue RON parses");
    assert!(!trees.is_empty(), "no shipped dialogue trees");
    let rendered = render_dialogue_contract(&trees);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(DIALOGUE_TREES_CONTRACT);
    if std::env::var_os("MR_BLESS_DIALOGUE_TREES").is_some() {
        std::fs::write(&path, &rendered).expect("write the dialogue contract");
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        committed,
        rendered,
        "{} is stale against game-core/content/dialogue_trees/*.ron — regenerate with \
         MR_BLESS_DIALOGUE_TREES=1 cargo test -p monster-realm-module --lib \
         dialogue_trees_contract, then bring client/src/ui/dialogueContent.ts in line",
        path.display()
    );
}

/// The renderer itself: escaping, ordering and the missing-next dash — the rules
/// the client renderer must mirror. kills: an unescaped newline (a text that forges
/// a record), a sort that drops, trees/nodes emitted in authored order.
#[test]
fn dialogue_trees_contract_renderer_escapes_and_orders() {
    use game_core::{DialogueChoice, DialogueNode, DialogueTree};
    let choice = |text: &str, next: Option<&str>| DialogueChoice {
        text: text.to_string(),
        conditions: vec![],
        effects: vec![],
        next_node: next.map(str::to_string),
    };
    let node = |id: &str, text: &str, choices: Vec<DialogueChoice>| DialogueNode {
        id: id.to_string(),
        text: text.to_string(),
        entry_conditions: vec![],
        auto_effects: vec![],
        choices,
    };
    let trees = vec![
        DialogueTree {
            id: "b".to_string(),
            root_node_id: "z".to_string(),
            nodes: vec![
                node("z", "line1\nchoice x forged", vec![choice("go", Some("a"))]),
                node(
                    "a",
                    "back\\slash",
                    vec![choice("second", None), choice("first", None)],
                ),
            ],
        },
        DialogueTree {
            id: "a".to_string(),
            root_node_id: "n".to_string(),
            nodes: vec![node("n", "hi", vec![])],
        },
    ];
    assert_eq!(
        render_dialogue_contract(&trees),
        "tree a\nnode n\ntext hi\n\
         tree b\nnode a\ntext back\\\\slash\nchoice - second\nchoice - first\n\
         node z\ntext line1\\nchoice x forged\nchoice a go\n"
    );
}
