//! `evolution_tests` — M10b gating integration tests for the `evolve` and `fuse`
//! reducers and the `compute_evolves_to` helper.
//!
//! Declared from `evolution.rs` as:
//!   `#[cfg(test)] #[path = "evolution_tests.rs"] mod evolution_tests;`
//! so `super` resolves to the `evolution` module, giving access to
//! `compute_evolves_to`, `reject_if_in_battle`, and any seam helpers.
//!
//! RED state: this file does not compile until the implementer creates
//! `server-module/src/evolution.rs` with the `evolve`/`fuse` reducers and the
//! `compute_evolves_to`/`reject_if_in_battle` helpers, and adds the `#[path]`
//! mod decl. That is intentional — the tests ARE the contract.
//!
//! EARS criteria covered (from M10 spec §3):
//!   - Slice 3 (Evolve reducer): ownership, eligibility, battle-guard, transform,
//!     dual-write, stats/HP recomputed.
//!   - Slice 4 (Fuse reducer): both-owned, both-not-in-battle, recipe lookup,
//!     atomic delete-two-insert-one, offspring properties.
//!   - Slice 6 (compute_evolves_to): eligible/not-eligible/first-match-wins.
//!
//! Pattern: SpacetimeDB `#[spacetimedb::client_visibility_filter]` is not a unit
//! test harness — these tests call the *seam functions* (the pure or nearly-pure
//! layers under the reducers) directly, following the established pattern of
//! `evaluate_care` in raising_tests.rs.  Where a seam does not yet exist the test
//! calls the reducer signature directly so the file is RED until the seam is added.
//!
//! Each test carries a `// kills:` comment stating which wrong implementation it
//! catches.

use super::*;

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrors m7b_test_monster_row pattern in marshal_tests)
// ---------------------------------------------------------------------------

use crate::schema::{Battle, Fusion, Monster, MonsterPub, SpeciesRow};
use game_core::{
    BattleOutcome, BattleSide, BattleState, Bond, EvolutionCondition, EvolutionTrigger, Level,
    NatureKind, StatBlock,
};
use spacetimedb::Identity;

/// Canonical test owner identity.
fn owner_id() -> Identity {
    Identity::from_byte_array([1u8; 32])
}

/// A second (different) owner — used to test ownership rejection.
fn other_owner_id() -> Identity {
    Identity::from_byte_array([2u8; 32])
}

/// A minimal SpeciesRow for seeding the species table in tests.
fn make_species_row(id: u32, hp: u16, other: u16) -> SpeciesRow {
    SpeciesRow {
        id,
        name: format!("TestSpecies{id}"),
        base_hp: hp,
        base_attack: other,
        base_defense: other,
        base_speed: other,
        base_sp_attack: other,
        base_sp_defense: other,
        affinity: game_core::Affinity::Fire,
        learnable_skill_ids: vec![],
    }
}

/// Canonical source species (id=1, Bulbasaur-like base stats).
fn source_species_row() -> SpeciesRow {
    make_species_row(1, 45, 49)
}

/// Canonical target evolved species (id=2, higher base stats).
fn target_species_row() -> SpeciesRow {
    make_species_row(2, 80, 80)
}

/// A Monster row for testing. Sets `owner_identity` to `owner_id()`.
/// Level 20, bond 100 — used by evolve tests (meets a Level(20) threshold).
fn make_monster_row(monster_id: u64, owner: Identity) -> Monster {
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 1,
        nickname: String::new(),
        level: 20,
        xp: 8000,
        bond: 100,
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
        stat_hp: 65,
        stat_attack: 56,
        stat_defense: 56,
        stat_speed: 72,
        stat_sp_attack: 72,
        stat_sp_defense: 52,
        current_hp: 50,
        party_slot: 0,
        last_care_at_ms: 0,
        // M10b: new columns — None until after evolution
        evolves_to: None,
    }
}

/// Build a MonsterPub projection from a Monster row (mirrors pub_from_monster).
fn make_monster_pub(m: &Monster) -> MonsterPub {
    MonsterPub {
        monster_id: m.monster_id,
        owner_identity: m.owner_identity,
        species_id: m.species_id,
        nickname: m.nickname.clone(),
        level: m.level,
        xp: m.xp,
        bond: m.bond,
        current_hp: m.current_hp,
        stat_hp: m.stat_hp,
        stat_attack: m.stat_attack,
        stat_defense: m.stat_defense,
        stat_speed: m.stat_speed,
        stat_sp_attack: m.stat_sp_attack,
        stat_sp_defense: m.stat_sp_defense,
        party_slot: m.party_slot,
        // M10b: new column
        evolves_to: m.evolves_to,
    }
}

/// A Fusion table row: species 1 + species 3 → offspring species 4.
/// Used for fuse tests.
fn make_fusion_recipe_row(id: u64, a: u32, b: u32, to: u32) -> Fusion {
    Fusion { id, a, b, to }
}

/// Build a BattleState where `side_a` has monsters for the given monster ids
/// (representing the player's party), with `outcome` = Ongoing.
/// The monster_ids slice represents `party_monster_ids` on the Battle row.
fn make_ongoing_battle(battle_id: u64, owner: Identity, party_monster_ids: Vec<u64>) -> Battle {
    // A minimal BattleState — just needs outcome=Ongoing to fire the guard.
    let dummy_monster = game_core::BattleMonster {
        species_id: 1,
        affinity: game_core::Affinity::Fire,
        level: 20,
        current_hp: 65,
        max_hp: 65,
        stats: StatBlock {
            hp: 65,
            attack: 56,
            defense: 56,
            speed: 72,
            sp_attack: 72,
            sp_defense: 52,
        },
        known_skill_ids: vec![],
    };
    let state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![dummy_monster.clone()],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![dummy_monster],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
    };
    Battle {
        battle_id,
        player_identity: owner,
        opponent_identity: Identity::from_byte_array([0u8; 32]),
        state,
        party_monster_ids,
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

/// A completed (non-Ongoing) battle that references the same monster id.
fn make_won_battle(battle_id: u64, owner: Identity, party_monster_ids: Vec<u64>) -> Battle {
    let mut b = make_ongoing_battle(battle_id, owner, party_monster_ids);
    b.state.outcome = BattleOutcome::SideAWins;
    b
}

/// Build a `game_core::Species` value from a `SpeciesRow` (mirrors how server code
/// assembles the pure type for delegation to game_core::evolve / game_core::fuse).
fn species_from_row(row: &SpeciesRow) -> Species {
    Species {
        id: row.id,
        name: row.name.clone(),
        base_stats: StatBlock {
            hp: row.base_hp,
            attack: row.base_attack,
            defense: row.base_defense,
            speed: row.base_speed,
            sp_attack: row.base_sp_attack,
            sp_defense: row.base_sp_defense,
        },
        affinity: row.affinity,
        learnable_skill_ids: row.learnable_skill_ids.clone(),
    }
}

// ---------------------------------------------------------------------------
// Slice 6 — compute_evolves_to helper (pure unit tests, no DB required)
//
// Tests the pure helper `compute_evolves_to(evolutions, monster_row) -> Option<u32>`.
// This is the server-side server-computed evolves_to column logic.
// RED state: compile-RED until `compute_evolves_to` is added to evolution.rs.
// ---------------------------------------------------------------------------

/// Slice 6 test 1: monster meets the level threshold → Some(target_species_id).
/// kills: an impl that always returns None, or that uses > instead of >=.
#[test]
fn test_compute_evolves_to_eligible() {
    // Evolution condition: Level(20) → species 2.
    // Monster is level 20 (exactly at threshold) — inclusive boundary must fire.
    let evolutions = vec![EvolutionCondition {
        trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
        to_species: 2,
    }];
    let m = make_monster_row(1, owner_id()); // level=20

    let result = compute_evolves_to(&evolutions, &m);

    assert_eq!(
        result,
        Some(2),
        "TEETH: monster at level 20 meets Level(20) threshold — must return Some(2); \
         kills: an impl that uses strict > instead of >=, or always returns None"
    );
}

/// Slice 6 test 2: no matching condition → None.
/// kills: an impl that returns Some unconditionally (level check not enforced).
#[test]
fn test_compute_evolves_to_not_eligible() {
    // Evolution condition: Level(30) → species 2.
    // Monster is level 20 — below the threshold.
    let evolutions = vec![EvolutionCondition {
        trigger: EvolutionTrigger::Level(Level::new(30).unwrap()),
        to_species: 2,
    }];
    let m = make_monster_row(1, owner_id()); // level=20

    let result = compute_evolves_to(&evolutions, &m);

    assert_eq!(
        result, None,
        "TEETH: monster at level 20 does NOT meet Level(30) threshold — must return None; \
         kills: an impl that ignores the trigger condition and returns Some unconditionally"
    );
}

/// Slice 6 test 3: multiple conditions, first one fires → returns first target, not later ones.
/// kills: a last-wins impl, a collect-all impl, or an impl that checks conditions in wrong order.
#[test]
fn test_compute_evolves_to_first_match_wins() {
    // Two conditions: Level(20) → species 2, Bond(50) → species 3.
    // Monster is level 20 AND bond 100 — BOTH conditions match.
    // FIRST-wins (declaration order): must return Some(2), NOT Some(3).
    let evolutions = vec![
        EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
            to_species: 2,
        },
        EvolutionCondition {
            trigger: EvolutionTrigger::Bond(Bond::new(50)),
            to_species: 3,
        },
    ];
    let m = make_monster_row(1, owner_id()); // level=20, bond=100 — both fire

    let result = compute_evolves_to(&evolutions, &m);

    assert_eq!(
        result,
        Some(2),
        "TEETH: both Level(20) and Bond(50) match, but first-wins must return Some(2); \
         kills: a last-wins impl (would return Some(3)), or a type-priority impl (if Bond > Level)"
    );
}

// ---------------------------------------------------------------------------
// Slice 3 — Evolve reducer integration tests
//
// These call `evolve_seam(ctx, monster_id)` — the pure testable seam over
// the `evolve` reducer that accepts a pre-populated fake context.
// Alternatively these may call the reducer via SpacetimeDB's test harness if
// one is available; until then they call through the seam directly.
//
// The seam signature:
//   pub(crate) fn evolve_seam(
//       db: &impl EvolutionDb,    // fake DB impl
//       sender: Identity,
//       monster_id: u64,
//   ) -> Result<EvolutionEffect, String>
//
// RED state: compile-RED until evolve_seam (or the reducer's pure inner fn) exists.
// ---------------------------------------------------------------------------

/// Slice 3 test 1: happy path — ownership ✓, eligible ✓, not in battle ✓.
/// After evolve: species_id changes, stats recomputed, evolves_to recomputed, dual-write verified.
/// kills: an impl that forgets to dual-write monster_pub, or that doesn't recompute stats from
///        the new species' base stats.
#[test]
fn test_evolve_eligible_monster_succeeds() {
    let owner = owner_id();
    let monster_id = 1u64;
    let mut db = TestEvolutionDb::new();

    // Seed: species 1 (source) and species 2 (evolved form).
    db.insert_species(source_species_row()); // id=1, hp=45
    db.insert_species(target_species_row()); // id=2, hp=80
    db.insert_species(make_species_row(3, 100, 100)); // id=3, a further evolution

    // Evolution registry: species 1 at Level(20) → species 2.
    db.insert_evolutions(
        1,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
            to_species: 2,
        }],
    );
    // Species 2 can evolve further at Level(40) → species 3 (for evolves_to recompute test).
    db.insert_evolutions(
        2,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(40).unwrap()),
            to_species: 3,
        }],
    );

    let m = make_monster_row(monster_id, owner); // level=20, species_id=1
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m));

    let result = evolve_seam(&mut db, owner, monster_id);

    assert!(
        result.is_ok(),
        "TEETH: eligible monster (level 20 >= Level(20) threshold) owned by caller must succeed; \
         got Err: {:?}",
        result.err()
    );

    // species_id changed to target
    let updated_monster = db
        .get_monster(monster_id)
        .expect("monster must still exist");
    assert_eq!(
        updated_monster.species_id, 2,
        "species_id must change to 2 after evolve"
    );

    // Dual-write: monster_pub must match the updated monster
    let updated_pub = db
        .get_monster_pub(monster_id)
        .expect("monster_pub must exist");
    assert_eq!(
        updated_pub.species_id, 2,
        "TEETH: monster_pub.species_id must also be updated (dual-write discipline); \
         kills: impl that writes monster but forgets monster_pub"
    );

    // Stats recomputed from the new species (species 2 has higher base_hp=80, not 45)
    // At level 20 with all-15 IVs, the new stat_hp must reflect species 2's base stats.
    assert!(
        updated_monster.stat_hp > m.stat_hp,
        "TEETH: stat_hp must be recomputed from species 2's base stats (hp=80 > 45); \
         kills: impl that carries old derived_stats instead of re-deriving from the target species; \
         old stat_hp={}, new stat_hp={}",
        m.stat_hp, updated_monster.stat_hp
    );

    // evolves_to recomputed: species 2 at level 20 is below Level(40), so evolves_to = None
    assert_eq!(
        updated_monster.evolves_to, None,
        "evolves_to must be recomputed after evolve — species 2 at level 20 < Level(40) → None"
    );
}

/// Slice 3 test 2: caller is not the owner → Err("not owner").
/// kills: an impl that skips the ownership check, allowing any caller to evolve any monster.
#[test]
fn test_evolve_not_owner_rejects() {
    let owner = owner_id();
    let thief = other_owner_id();
    let monster_id = 1u64;
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_evolutions(
        1,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
            to_species: 2,
        }],
    );
    let m = make_monster_row(monster_id, owner); // owned by `owner`, not `thief`
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m));

    let result = evolve_seam(&mut db, thief, monster_id); // called by thief

    assert!(
        result.is_err(),
        "TEETH: non-owner must not be able to evolve a monster; \
         kills: missing ownership check (would return Ok)"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("not owner"),
        "error must contain \"not owner\"; got: {:?}",
        msg
    );
}

/// Slice 3 test 3: monster_id does not exist → Err("monster not found").
/// kills: an impl that panics on None or returns Ok for a missing monster.
#[test]
fn test_evolve_monster_not_found() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());

    // No monster inserted — id 999 does not exist.
    let result = evolve_seam(&mut db, owner, 999);

    assert!(
        result.is_err(),
        "TEETH: missing monster must return Err, not panic; \
         kills: an impl that unwraps the Option"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("monster not found"),
        "error must contain \"monster not found\"; got: {:?}",
        msg
    );
}

/// Slice 3 test 4: species lookup fails → Err containing "species {} not found".
/// kills: an impl that panics on a missing species or returns Ok with garbage stats.
#[test]
fn test_evolve_species_not_found() {
    let owner = owner_id();
    let monster_id = 1u64;
    let mut db = TestEvolutionDb::new();

    // Target species 2 is NOT in the DB (only source species 1 is).
    db.insert_species(source_species_row());
    db.insert_evolutions(
        1,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
            to_species: 2, // species 2 is not seeded
        }],
    );
    let m = make_monster_row(monster_id, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m));

    let result = evolve_seam(&mut db, owner, monster_id);

    assert!(
        result.is_err(),
        "TEETH: missing target species must return Err; \
         kills: an impl that panics on species lookup failure"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("species") && msg.contains("not found"),
        "error must mention 'species' and 'not found'; got: {:?}",
        msg
    );
}

/// Slice 3 test 5: no evolution condition fires → Err("not eligible to evolve").
/// kills: an impl that lets ineligible monsters evolve (e.g., ignores the eligibility check).
#[test]
fn test_evolve_not_eligible() {
    let owner = owner_id();
    let monster_id = 1u64;
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    // Evolution threshold is Level(30) but monster is level 20 — ineligible.
    db.insert_evolutions(
        1,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(30).unwrap()),
            to_species: 2,
        }],
    );
    let m = make_monster_row(monster_id, owner); // level=20, below threshold
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m));

    let result = evolve_seam(&mut db, owner, monster_id);

    assert!(
        result.is_err(),
        "TEETH: ineligible monster (level 20 < Level(30) threshold) must return Err; \
         kills: an impl that evolves without checking eligibility"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("not eligible"),
        "error must contain \"not eligible\"; got: {:?}",
        msg
    );
}

/// Slice 3 test 6: monster is in an ongoing battle → Err("monster is in an ongoing battle").
/// PROOF-OF-TEETH: if `reject_if_in_battle` guard is removed, this test fails (passes when guard
/// is present but missing guard returns Ok unconditionally).
/// kills: missing `reject_if_in_battle` call in the evolve reducer.
#[test]
fn test_evolve_in_ongoing_battle_rejects() {
    let owner = owner_id();
    let monster_id = 1u64;
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_evolutions(
        1,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
            to_species: 2,
        }],
    );
    let m = make_monster_row(monster_id, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m));

    // Insert an ONGOING battle that contains this monster in its party.
    db.insert_battle(make_ongoing_battle(100, owner, vec![monster_id]));

    let result = evolve_seam(&mut db, owner, monster_id);

    assert!(
        result.is_err(),
        "TEETH(reject_if_in_battle): monster in an ongoing battle must not be evolvable; \
         kills: missing reject_if_in_battle guard — without it, this returns Ok"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {:?}",
        msg
    );
}

/// Slice 3 test 7: stats and HP correctly recomputed after evolve.
/// The old species has base HP=45, new species has base HP=200. The monster was
/// damaged (current_hp=30). After evolve: stat_hp reflects new base, current_hp
/// is clamped to new derived HP (30 < new_max, so 30 is preserved).
/// kills: carrying old derived_stats; heal-to-full on evolve; missing HP clamp.
#[test]
fn test_evolve_stats_and_hp_recomputed() {
    let owner = owner_id();
    let monster_id = 1u64;
    let mut db = TestEvolutionDb::new();

    let high_hp_species = make_species_row(2, 200, 100); // very high HP species
    db.insert_species(source_species_row()); // id=1, hp=45
    db.insert_species(high_hp_species); // id=2, hp=200
    db.insert_evolutions(
        1,
        vec![EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(20).unwrap()),
            to_species: 2,
        }],
    );

    let mut m = make_monster_row(monster_id, owner);
    m.current_hp = 30; // monster is damaged (below stat_hp=65)
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m));

    let result = evolve_seam(&mut db, owner, monster_id);
    assert!(result.is_ok(), "evolve must succeed: {:?}", result.err());

    let updated = db.get_monster(monster_id).unwrap();

    // stat_hp must be from the NEW species (base_hp=200 → much higher than old base_hp=45)
    assert!(
        updated.stat_hp > m.stat_hp,
        "TEETH: stat_hp must be re-derived from the target species (base_hp=200 > 45); \
         kills: impl that carries old stat_hp without re-derivation; \
         old stat_hp={}, new stat_hp={}",
        m.stat_hp,
        updated.stat_hp
    );

    // current_hp carried (not healed): was 30, new max is >> 30, so 30 is preserved.
    assert_eq!(
        updated.current_hp, 30,
        "TEETH: current_hp must be preserved when target HP is higher (damage carries through); \
         kills: impl that heals to full on evolve (would return new stat_hp, not 30)"
    );

    // current_hp never exceeds the new stat_hp
    assert!(
        updated.current_hp <= updated.stat_hp,
        "current_hp ({}) must not exceed new stat_hp ({})",
        updated.current_hp,
        updated.stat_hp
    );
}

// ---------------------------------------------------------------------------
// Slice 4 — Fuse reducer integration tests
//
// Seam signature:
//   pub(crate) fn fuse_seam(
//       db: &mut impl EvolutionDb,
//       sender: Identity,
//       monster_a_id: u64,
//       monster_b_id: u64,
//   ) -> Result<FuseEffect, String>
//
// RED state: compile-RED until fuse_seam (or the reducer's pure inner fn) exists.
// ---------------------------------------------------------------------------

/// Slice 4 test 1: happy path — both owned ✓, recipe ✓, neither in battle ✓.
/// After fuse: 2 parents deleted, 1 offspring inserted, offspring in lower party slot.
/// kills: missing delete of parents; offspring in wrong slot; offspring not inserted.
#[test]
fn test_fuse_both_owned_creates_offspring() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3 (parent B)
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)

    // Fusion recipe: species 1 + species 3 → species 4.
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    ma.party_slot = 2; // higher slot
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;
    mb.party_slot = 0; // lower slot — offspring must inherit this

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let result = fuse_seam(&mut db, owner, 1, 2);
    assert!(
        result.is_ok(),
        "TEETH: valid fuse (both owned, recipe exists, not in battle) must succeed; \
         got Err: {:?}",
        result.err()
    );

    // Both parents deleted
    assert!(
        db.get_monster(1).is_none(),
        "TEETH: parent A (monster_id=1) must be deleted after fuse; \
         kills: impl that deletes only one parent or neither"
    );
    assert!(
        db.get_monster(2).is_none(),
        "TEETH: parent B (monster_id=2) must be deleted after fuse; \
         kills: impl that only deletes parent A"
    );

    // One offspring inserted (auto-inc id, not 1 or 2)
    let offspring_id = result.unwrap().offspring_monster_id;
    let offspring = db
        .get_monster(offspring_id)
        .expect("offspring must be inserted");
    assert_eq!(
        offspring.species_id, 4,
        "offspring species_id must be 4 (recipe.to)"
    );

    // Offspring inherits the LOWER party slot of the parents (min(2, 0) = 0)
    assert_eq!(
        offspring.party_slot, 0,
        "TEETH: offspring must inherit the LOWER party slot (min(2, 0) = 0); \
         kills: impl that uses the higher slot or always uses slot 0 unconditionally"
    );
}

/// Slice 4 test 2: caller does not own monster A → Err("not owner").
/// kills: missing ownership check for parent A.
#[test]
fn test_fuse_a_not_owner_rejects() {
    let owner = owner_id();
    let thief = other_owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner); // owned by `owner`
    ma.species_id = 1;
    let mut mb = make_monster_row(2, thief); // owned by `thief`
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // Thief calls fuse on monster A (which thief does NOT own)
    let result = fuse_seam(&mut db, thief, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: non-owner of monster A must be rejected; \
         kills: missing ownership check for parent A"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("not owner"),
        "error must contain \"not owner\"; got: {:?}",
        msg
    );
}

/// Slice 4 test 3: caller does not own monster B → Err("not owner").
/// kills: ownership check only guards parent A, not parent B.
#[test]
fn test_fuse_b_not_owner_rejects() {
    let owner = owner_id();
    let other = other_owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner); // owned by `owner`
    ma.species_id = 1;
    let mut mb = make_monster_row(2, other); // owned by `other` — not the caller
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // Owner calls fuse: owns A but NOT B.
    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: owner of A but not B must be rejected; \
         kills: impl that only checks parent A ownership, not parent B"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("not owner"),
        "error must contain \"not owner\"; got: {:?}",
        msg
    );
}

/// Slice 4 test 4: A and B owned by different players → Err.
/// Same as test_fuse_b_not_owner_rejects from the thief's perspective, but
/// also tests that the both-must-be-same-owner rule fires from A's check.
/// kills: impl that only checks B's owner after confirming A's owner.
#[test]
fn test_fuse_both_must_be_same_owner() {
    let owner_a = owner_id();
    let owner_b = other_owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner_a);
    ma.species_id = 1;
    let mut mb = make_monster_row(2, owner_b);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // owner_a calls fuse: owns A but not B (B belongs to owner_b)
    let result = fuse_seam(&mut db, owner_a, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: fusing monsters from different owners must be rejected; \
         kills: impl that allows cross-player fusion by checking only A"
    );
}

/// Slice 4 test 5: monster A is in an ongoing battle → Err("monster is in an ongoing battle").
/// PROOF-OF-TEETH: removing `reject_if_in_battle` for parent A causes this to return Ok.
/// kills: missing battle guard for parent A.
#[test]
fn test_fuse_a_in_ongoing_battle_rejects() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // Monster A is in an ongoing battle.
    db.insert_battle(make_ongoing_battle(100, owner, vec![1]));

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: fusing parent A while it is in an ongoing battle must be rejected; \
         kills: missing reject_if_in_battle for parent A"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {:?}",
        msg
    );
}

/// Slice 4 test 6: monster B is in an ongoing battle → Err("monster is in an ongoing battle").
/// kills: battle guard only applied to parent A, not parent B.
#[test]
fn test_fuse_b_in_ongoing_battle_rejects() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // Only monster B is in an ongoing battle.
    db.insert_battle(make_ongoing_battle(100, owner, vec![2]));

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: fusing parent B while it is in an ongoing battle must be rejected; \
         kills: battle guard applied only to A, not to B"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {:?}",
        msg
    );
}

/// Slice 4 test 7: no Fusion row matches (a_species, b_species) → Err("no fusion recipe for this pair").
/// kills: impl that returns Ok with garbage offspring when no recipe matches.
#[test]
fn test_fuse_recipe_not_found_rejects() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3

    // No fusion recipe is seeded — db.fusion is empty.

    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: missing fusion recipe must return Err, not create a garbage offspring; \
         kills: impl that doesn't check the recipe table"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("no fusion recipe"),
        "error must contain \"no fusion recipe\"; got: {:?}",
        msg
    );
}

/// Slice 4 test 8: recipe.to species does not exist in the species table → Err.
/// kills: impl that inserts an offspring with an invalid species_id (orphan row) or panics.
#[test]
fn test_fuse_offspring_species_not_found() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3

    // Fusion recipe points to offspring species 99, which is NOT in the DB.
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 99));

    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH: offspring species not found in DB must return Err, not panic; \
         kills: impl that calls .unwrap() on the species lookup"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("species") && msg.contains("not found"),
        "error must mention species not found; got: {:?}",
        msg
    );
}

/// Slice 4 test 9: atomicity — both parents deleted AND offspring present after success.
/// PROOF-OF-TEETH: if fuse is non-atomic (delete without insert, or insert without delete),
/// this test catches the partial state.
/// Note on atomicity: SpacetimeDB guarantees all table mutations within a reducer
/// are committed in a single atomic transaction. This test verifies the LOGICAL
/// invariant (delete-2-insert-1) using the fake DB; the real atomicity guarantee
/// is SpacetimeDB's transaction semantics (not separately unit-testable here).
/// kills: partial impl that deletes parents but forgets to insert offspring,
///        or inserts offspring without deleting parents (dupe state).
#[test]
fn test_fuse_atomic_delete_insert_both_parents_gone() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let result = fuse_seam(&mut db, owner, 1, 2);
    assert!(result.is_ok(), "fuse must succeed: {:?}", result.err());

    let offspring_id = result.unwrap().offspring_monster_id;

    // ATOMICITY CHECK: both parents gone, offspring present.
    // If any of these three fail it means the implementation left a partial state.
    assert!(
        db.get_monster(1).is_none(),
        "TEETH(atomicity): parent A must be deleted; \
         kills: impl that inserts offspring but forgets to delete parents"
    );
    assert!(
        db.get_monster(2).is_none(),
        "TEETH(atomicity): parent B must be deleted; \
         kills: impl that only deletes one parent"
    );
    assert!(
        db.get_monster(offspring_id).is_some(),
        "TEETH(atomicity): offspring must be inserted; \
         kills: impl that deletes parents but forgets to insert the offspring (orphan)"
    );

    // monster_pub atomicity: both parent pubs gone, offspring pub present.
    assert!(
        db.get_monster_pub(1).is_none(),
        "TEETH(atomicity): parent A monster_pub must be deleted (dual-write discipline)"
    );
    assert!(
        db.get_monster_pub(2).is_none(),
        "TEETH(atomicity): parent B monster_pub must be deleted"
    );
    assert!(
        db.get_monster_pub(offspring_id).is_some(),
        "TEETH(atomicity): offspring monster_pub must be inserted (dual-write discipline)"
    );
}

/// Slice 4 test 10: offspring properties — level 1, zero EVs, bond=70, no nickname,
/// current_hp = derived HP at L1, species = recipe.to, IVs are per-stat max of parents,
/// nature from higher-bond parent (a wins on tie).
/// kills: carrying parent level/EVs/nickname/bond; wrong IV formula; wrong nature selection.
#[test]
fn test_fuse_offspring_properties() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    // Parent A: Adamant nature, bond=200 (higher), level=30, has nickname
    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    ma.nature_kind = NatureKind::Adamant;
    ma.bond = 200; // higher bond → nature goes to A
    ma.level = 30;
    ma.nickname = "ParentA".to_string();
    ma.party_slot = 3;
    // Distinctive IVs for parent A
    ma.iv_hp = 10;
    ma.iv_attack = 31;
    ma.iv_defense = 5;
    ma.iv_speed = 20;
    ma.iv_sp_attack = 0;
    ma.iv_sp_defense = 15;

    // Parent B: Timid nature, bond=100 (lower), level=25
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;
    mb.nature_kind = NatureKind::Timid;
    mb.bond = 100;
    mb.level = 25;
    mb.nickname = "ParentB".to_string();
    mb.party_slot = 1; // lower slot — offspring must use this
                       // Complementary IVs: per-stat max should be (31, 31, 20, 20, 15, 15)
    mb.iv_hp = 31;
    mb.iv_attack = 5;
    mb.iv_defense = 20;
    mb.iv_speed = 0;
    mb.iv_sp_attack = 15;
    mb.iv_sp_defense = 10;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let result = fuse_seam(&mut db, owner, 1, 2);
    assert!(result.is_ok(), "fuse must succeed: {:?}", result.err());

    let offspring_id = result.unwrap().offspring_monster_id;
    let off = db.get_monster(offspring_id).expect("offspring must exist");

    // species = recipe.to
    assert_eq!(off.species_id, 4, "offspring species must be recipe.to (4)");

    // level = 1
    assert_eq!(
        off.level, 1,
        "TEETH: offspring level must be 1; kills: carrying parent level"
    );

    // EVs = zero
    assert_eq!(off.ev_hp, 0, "ev_hp must be 0");
    assert_eq!(off.ev_attack, 0, "ev_attack must be 0");
    assert_eq!(off.ev_defense, 0, "ev_defense must be 0");
    assert_eq!(off.ev_speed, 0, "ev_speed must be 0");
    assert_eq!(off.ev_sp_attack, 0, "ev_sp_attack must be 0");
    assert_eq!(
        off.ev_sp_defense, 0,
        "ev_sp_defense must be 0; \
         kills: impl that carries parent EVs into offspring"
    );

    // bond = 70 (Bond::default_bond())
    assert_eq!(
        off.bond, 70,
        "TEETH: offspring bond must be 70 (default bond); kills: carrying parent bond"
    );

    // nickname = empty (no nickname)
    assert!(
        off.nickname.is_empty(),
        "TEETH: offspring nickname must be empty (fresh); kills: carrying parent nickname; \
         got: {:?}",
        off.nickname
    );

    // nature = parent A's nature (Adamant) because A has higher bond (200 > 100)
    assert_eq!(
        off.nature_kind,
        NatureKind::Adamant,
        "TEETH: offspring nature must be from higher-bond parent A (Adamant, bond=200); \
         kills: always-first-arg, always-second-arg, or lower-bond-wins"
    );

    // IVs: per-stat max of parents
    // A=(10,31,5,20,0,15), B=(31,5,20,0,15,10) → max=(31,31,20,20,15,15)
    assert_eq!(
        off.iv_hp, 31,
        "iv_hp: max(10, 31) = 31; kills: min or parent-A-only"
    );
    assert_eq!(
        off.iv_attack, 31,
        "iv_attack: max(31, 5) = 31; kills: parent-B-only"
    );
    assert_eq!(
        off.iv_defense, 20,
        "iv_defense: max(5, 20) = 20; kills: parent-A-only"
    );
    assert_eq!(off.iv_speed, 20, "iv_speed: max(20, 0) = 20");
    assert_eq!(off.iv_sp_attack, 15, "iv_sp_attack: max(0, 15) = 15");
    assert_eq!(
        off.iv_sp_defense, 15,
        "iv_sp_defense: max(15, 10) = 15; kills: field transposition"
    );

    // party_slot = min of present slots (min(3, 1) = 1)
    assert_eq!(
        off.party_slot, 1,
        "TEETH: offspring party_slot = min(3, 1) = 1; kills: max or always-A slot"
    );

    // current_hp = derived HP at L1 (full HP — not parent's current_hp)
    // We can't compute the exact value without running derive_stats, but we can
    // assert it equals stat_hp (full HP) and is > 0.
    assert_eq!(
        off.current_hp, off.stat_hp,
        "TEETH: offspring current_hp must equal stat_hp (full HP at L1); \
         kills: carrying parent current_hp"
    );
    assert!(
        off.current_hp > 0,
        "offspring current_hp must be > 0 (derived HP at L1 with valid base stats)"
    );
}

// ---------------------------------------------------------------------------
// Fuse order-independence (bonus): fuse(a, b) and fuse(b, a) with same pair
// → offspring species, IVs, and slot are identical (nature may differ on tie).
// kills: order-dependent IV computation or slot selection.
// ---------------------------------------------------------------------------

/// fuse(a, b) and fuse(b, a): with bonds a=200 > b=100, nature goes to A regardless
/// of arg order, so FULL equality holds.
/// kills: order-dependent IV max or slot computation.
#[test]
fn test_fuse_order_independence_when_bonds_differ() {
    let owner = owner_id();
    let mut db_ab = TestEvolutionDb::new();
    let mut db_ba = TestEvolutionDb::new();

    for db in [&mut db_ab, &mut db_ba] {
        db.insert_species(source_species_row());
        db.insert_species(make_species_row(3, 60, 70));
        db.insert_species(make_species_row(4, 80, 90));
        db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));
    }

    // Parent A: bond=200, Adamant, species=1, party_slot=5
    let mut ma = make_monster_row(1, owner);
    ma.species_id = 1;
    ma.bond = 200;
    ma.nature_kind = NatureKind::Adamant;
    ma.party_slot = 5;
    ma.iv_hp = 10;
    ma.iv_attack = 31;
    ma.iv_defense = 5;
    ma.iv_speed = 20;
    ma.iv_sp_attack = 0;
    ma.iv_sp_defense = 15;

    // Parent B: bond=100, Timid, species=3, party_slot=2
    let mut mb = make_monster_row(2, owner);
    mb.species_id = 3;
    mb.bond = 100;
    mb.nature_kind = NatureKind::Timid;
    mb.party_slot = 2;
    mb.iv_hp = 31;
    mb.iv_attack = 5;
    mb.iv_defense = 20;
    mb.iv_speed = 0;
    mb.iv_sp_attack = 15;
    mb.iv_sp_defense = 10;

    // Seed both fake DBs with the same monsters
    for db in [&mut db_ab, &mut db_ba] {
        db.insert_monster(ma.clone());
        db.insert_monster_pub(make_monster_pub(&ma));
        db.insert_monster(mb.clone());
        db.insert_monster_pub(make_monster_pub(&mb));
    }

    let r_ab = fuse_seam(&mut db_ab, owner, 1, 2).expect("fuse(a,b) must succeed");
    let r_ba = fuse_seam(&mut db_ba, owner, 2, 1).expect("fuse(b,a) must succeed");

    let off_ab = db_ab.get_monster(r_ab.offspring_monster_id).unwrap();
    let off_ba = db_ba.get_monster(r_ba.offspring_monster_id).unwrap();

    // With bonds differing (a=200 > b=100), nature is ALWAYS a's (Adamant) regardless of call order.
    assert_eq!(off_ab.nature_kind, off_ba.nature_kind,
        "TEETH: with differing bonds, nature must be from the higher-bond parent regardless of arg order; \
         kills: order-dependent nature selection");

    // IVs must be identical (per-stat max is order-independent)
    assert_eq!(
        off_ab.iv_hp, off_ba.iv_hp,
        "iv_hp must be order-independent"
    );
    assert_eq!(
        off_ab.iv_attack, off_ba.iv_attack,
        "iv_attack must be order-independent"
    );
    assert_eq!(
        off_ab.iv_defense, off_ba.iv_defense,
        "iv_defense must be order-independent"
    );
    assert_eq!(
        off_ab.iv_speed, off_ba.iv_speed,
        "iv_speed must be order-independent"
    );
    assert_eq!(
        off_ab.iv_sp_attack, off_ba.iv_sp_attack,
        "iv_sp_attack must be order-independent"
    );
    assert_eq!(
        off_ab.iv_sp_defense, off_ba.iv_sp_defense,
        "iv_sp_defense must be order-independent"
    );

    // party_slot is order-independent (min of present slots)
    assert_eq!(
        off_ab.party_slot, off_ba.party_slot,
        "TEETH: party_slot must be order-independent; kills: takes first arg's slot"
    );

    assert_eq!(
        off_ab.species_id, off_ba.species_id,
        "offspring species must be identical"
    );
}

// ---------------------------------------------------------------------------
// TestEvolutionDb — in-memory fake implementing the DB accessor interface
// used by the evolve_seam and fuse_seam pure helpers.
//
// The implementer must define a `trait EvolutionDb` (or equivalent interface)
// that the seam functions accept; this struct implements it for testing.
// The struct itself is ALSO red until the trait is defined.
// ---------------------------------------------------------------------------

/// Return value from a successful `fuse_seam` call — the new offspring's monster_id.
/// The implementer must define this type (or embed the id in a more general type).
pub struct FuseEffect {
    pub offspring_monster_id: u64,
}

/// Return value from a successful `evolve_seam` call.
/// May be `()` if the seam writes directly to the db; here typed for clarity.
pub struct EvolutionEffect;

/// In-memory fake DB for evolution/fuse seam tests.
/// The implementer defines the trait; this struct implements it.
/// All fields are public for test inspection.
pub struct TestEvolutionDb {
    pub monsters: std::collections::HashMap<u64, Monster>,
    pub monster_pubs: std::collections::HashMap<u64, MonsterPub>,
    pub species: std::collections::HashMap<u32, SpeciesRow>,
    pub evolutions: std::collections::HashMap<u32, Vec<EvolutionCondition>>,
    pub fusions: Vec<Fusion>,
    pub battles: Vec<Battle>,
    /// Auto-increment counter for new monster ids
    next_monster_id: u64,
}

impl TestEvolutionDb {
    pub fn new() -> Self {
        Self {
            monsters: Default::default(),
            monster_pubs: Default::default(),
            species: Default::default(),
            evolutions: Default::default(),
            fusions: vec![],
            battles: vec![],
            next_monster_id: 100, // start above 1/2 to avoid collision with seeded monsters
        }
    }

    pub fn insert_monster(&mut self, m: Monster) {
        self.monsters.insert(m.monster_id, m);
    }

    pub fn insert_monster_pub(&mut self, p: MonsterPub) {
        self.monster_pubs.insert(p.monster_id, p);
    }

    pub fn insert_species(&mut self, s: SpeciesRow) {
        self.species.insert(s.id, s);
    }

    pub fn insert_evolutions(&mut self, species_id: u32, conds: Vec<EvolutionCondition>) {
        self.evolutions.insert(species_id, conds);
    }

    pub fn insert_fusion(&mut self, f: Fusion) {
        self.fusions.push(f);
    }

    pub fn insert_battle(&mut self, b: Battle) {
        self.battles.push(b);
    }

    pub fn get_monster(&self, id: u64) -> Option<&Monster> {
        self.monsters.get(&id)
    }

    pub fn get_monster_pub(&self, id: u64) -> Option<&MonsterPub> {
        self.monster_pubs.get(&id)
    }

    /// Allocate the next auto-inc monster_id.
    pub fn alloc_monster_id(&mut self) -> u64 {
        let id = self.next_monster_id;
        self.next_monster_id += 1;
        id
    }
}
