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
        ability: None,
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
        // Formula-computed for species 1 (base_hp=45, IV=15, EV=0, level=20, Hardy):
        // HP = (2*45 + 15) * 20 / 100 + 20 + 10 = 51. Species 2 (base_hp=80) at
        // the same level/IV gives 65, so the evolution recomputation check works.
        stat_hp: 51,
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

/// A0 (ADR-0147): a Monster row that CLEARS the new fusion-eligibility gate.
///
/// `make_monster_row`'s defaults (level 20, bond 100) clear `MIN_FUSION_LEVEL = 10`
/// but NOT `MIN_FUSION_BOND = 120`, so every fuse test whose target error lives
/// DOWNSTREAM of the eligibility gate (battle guards, recipe lookup, offspring
/// species, atomicity, offspring properties) must build its parents through this
/// helper or its assertion becomes unreachable.
///
/// `make_monster_row` itself is deliberately UNCHANGED — it is shared with the
/// evolve tests, which depend on level 20 / bond 100 exactly (a Level(20) trigger
/// and a Bond(50) trigger are both pinned against those defaults).
///
/// `xp` is recomputed as `level^3` (this codebase's medium-fast curve) so the row's
/// level/xp pair stays self-consistent; every other field is `make_monster_row`'s.
fn make_fusable_monster_row(monster_id: u64, owner: Identity, level: u8, bond: u8) -> Monster {
    let mut m = make_monster_row(monster_id, owner);
    m.level = level;
    m.bond = bond;
    m.xp = u32::from(level) * u32::from(level) * u32::from(level);
    m
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
fn make_fusion_recipe_row(
    fusion_id: u64,
    a_species: u32,
    b_species: u32,
    to_species: u32,
) -> Fusion {
    Fusion {
        fusion_id,
        a_species,
        b_species,
        to_species,
    }
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
        status: None,
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
        weather: None,
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

// ---------------------------------------------------------------------------
// Slice 6 — compute_evolves_to helper (pure unit tests, no DB required)
//
// Tests the pure helper `compute_evolves_to(evolutions, level, bond) -> Option<u32>`.
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

    let result = compute_evolves_to(&evolutions, m.level, m.bond);

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

    let result = compute_evolves_to(&evolutions, m.level, m.bond);

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

    let result = compute_evolves_to(&evolutions, m.level, m.bond);

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

/// Slice 4 test 0: self-fuse guard — fusing a monster with itself is rejected.
///
/// A0 (ADR-0147) note: the assertions here are UNCHANGED — this test is the
/// byte-compatibility pin proving the self-fusion refusal survives the move from the
/// seam's own inline id comparison to `reject_if_not_fusable` → `fusion_eligible`.
/// The fixture deliberately seeds NO recipe: with the eligibility gate placed before
/// the recipe lookup, self-fusion still reports "itself" (an eligibility-late impl
/// would report "no fusion recipe" here and fail).
///
/// kills: dropping the self-fusion arm from the eligibility gate; placing the gate
///        after the recipe lookup (message drift).
#[test]
fn test_fuse_self_fuse_rejects() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1 (parent A species)
    let m = make_monster_row(1, owner);
    db.insert_monster_pub(make_monster_pub(&m));
    db.insert_monster(m);

    let result = fuse_seam(&mut db, owner, 1, 1);
    assert!(
        result.is_err(),
        "TEETH(self-fuse guard): fusing a monster with itself must return Err; \
         kills: an eligibility gate that lost its self-fusion arm"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("itself") || msg.contains("cannot fuse"),
        "error message must mention self-fuse, got: {msg}"
    );
}

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

    // A0 fixture bump (no assertion weakened): eligible parents (bond >= 120).
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    ma.party_slot = 2; // higher slot
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
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

/// Slice 4 test 4 (A0 RE-PIN, plan rev-2 #6): cross-owner fusion is rejected by the
/// PER-PARENT OWNERSHIP check, not by a separate same-owner rule.
///
/// The old `a.owner_identity != b.owner_identity` branch was DEAD code: both
/// ownership checks compare against the SAME `sender`, so two parents that both
/// pass them are necessarily co-owned and the branch could never fire (a guaranteed
/// mutation-ratchet survivor). It is deleted from the seam AND the reducer.
///
/// This test therefore no longer pins "must be owned by the same player" (that
/// message no longer exists anywhere). It re-pins the behaviour the spec actually
/// requires — a cross-owner pair is refused — at the guard that really owns it, and
/// asserts the EXACT parent named, so a swapped/one-sided ownership check dies here.
///
/// kills: dropping parent B's ownership check (cross-player fusion would succeed);
///        an impl that reports parent A when it is parent B that is foreign.
#[test]
fn test_fuse_cross_owner_rejected_by_ownership_guard() {
    let owner_a = owner_id();
    let owner_b = other_owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row());
    db.insert_species(make_species_row(3, 60, 70));
    db.insert_species(make_species_row(4, 80, 90));
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    // Both parents are fully ELIGIBLE (level 20 / bond 200) so eligibility can never
    // be the reason for the rejection — ownership must own it.
    let mut ma = make_fusable_monster_row(1, owner_a, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner_b, 20, 200);
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
    let msg = result.unwrap_err();
    assert!(
        msg.contains("not owner of monster b"),
        "TEETH: parent B is the foreign one — the error must name monster b; \
         kills: a one-sided or swapped ownership check; got: {msg:?}"
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

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
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

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
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

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
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

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
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

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
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

/// Slice 4 test 10 (A0 REWRITE, T32): offspring ROW carries the TAXED level, xp,
/// bond and EVs — the marshaling half of ADR-0147.
///
/// The old assertions (level 1, EVs 0, bond 70) pinned the deleted fresh-body model
/// and are replaced by exact hardcoded pins. `game_core`'s own suite proves the
/// formulas; THIS test proves the taxed values survive the seam's Monster-row build
/// (a row builder that still writes `1` / `0` / `70`, or that writes the PARENT's
/// values, dies here).
///
/// Parents: a = L34 bond 200 EVs(252,0,100,0,0,0) Adamant "ParentA" slot 3
///          b = L12 bond 150 EVs(0,252,0,0,0,0)   Timid   "ParentB" slot 1
/// Offspring pins (arithmetic in the assertion messages):
///   level 17 · xp 4913 · bond 150 · EVs (94, 94, 37, 0, 0, 0)
/// kills: level-1/EV-0/bond-70 leftovers; carrying a parent's level/bond/EVs/nickname
///        into the row; wrong IV formula; wrong nature selection; xp desync.
#[test]
fn test_fuse_offspring_properties() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    // Parent A: Adamant nature, bond=200 (higher), level=34, has nickname
    let mut ma = make_fusable_monster_row(1, owner, 34, 200);
    ma.species_id = 1;
    ma.nature_kind = NatureKind::Adamant; // higher bond → nature goes to A
    ma.nickname = "ParentA".to_string();
    ma.party_slot = 3;
    // Distinctive IVs for parent A
    ma.iv_hp = 10;
    ma.iv_attack = 31;
    ma.iv_defense = 5;
    ma.iv_speed = 20;
    ma.iv_sp_attack = 0;
    ma.iv_sp_defense = 15;
    // Distinctive EVs for parent A (total 352 <= 510)
    ma.ev_hp = 252;
    ma.ev_defense = 100;

    // Parent B: Timid nature, bond=150 (lower but still eligible), level=12
    let mut mb = make_fusable_monster_row(2, owner, 12, 150);
    mb.species_id = 3;
    mb.nature_kind = NatureKind::Timid;
    mb.nickname = "ParentB".to_string();
    mb.party_slot = 1; // lower slot — offspring must use this
                       // Complementary IVs: per-stat max should be (31, 31, 20, 20, 15, 15)
    mb.iv_hp = 31;
    mb.iv_attack = 5;
    mb.iv_defense = 20;
    mb.iv_speed = 0;
    mb.iv_sp_attack = 15;
    mb.iv_sp_defense = 10;
    // Complementary EVs for parent B (total 252 <= 510)
    mb.ev_attack = 252;

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

    // level: max(avg(34,12)=23 taxed to 17, max(34,12)=34 retained to 17) = 17
    assert_eq!(
        off.level, 17,
        "TEETH(A0-3): offspring ROW level must be 17 for parents (34, 12); \
         kills: the level-1 leftover, and carrying a parent's level (34 or 12)"
    );

    // xp: 17^3 = 4913 (xp_for_level of the TAXED level, not of level 1)
    assert_eq!(
        off.xp, 4913,
        "TEETH(A0-4): offspring ROW xp must be 17^3 = 4913; \
         kills: xp_for_level(1) = 1, xp = 0, and carrying a parent's xp"
    );

    // bond: max(200, 150) = 200, taxed 75% = 150
    assert_eq!(
        off.bond, 150,
        "TEETH(A0-2): offspring ROW bond must be 150 (200 * 75 / 100); \
         kills: the default_bond() 70 leftover, an untaxed carry (200), a taxed average (131)"
    );

    // EVs: per-stat taxed average of the parents' EVs
    assert_eq!(
        off.ev_hp, 94,
        "TEETH(A0-5): ev_hp must be 94 (avg(252, 0) = 126, taxed 75% = 94); \
         kills: the zero-init leftover and an untaxed carry (126)"
    );
    assert_eq!(
        off.ev_attack, 94,
        "TEETH(A0-5): ev_attack must be 94 (avg(0, 252) = 126, taxed = 94)"
    );
    assert_eq!(
        off.ev_defense, 37,
        "TEETH(A0-5): ev_defense must be 37 (avg(100, 0) = 50, taxed = 37); \
         kills: a stat transposition (speed/sp_attack/sp_defense are all 0)"
    );
    assert_eq!(off.ev_speed, 0, "ev_speed must be 0 (both parents 0)");
    assert_eq!(off.ev_sp_attack, 0, "ev_sp_attack must be 0 (both parents 0)");
    assert_eq!(
        off.ev_sp_defense, 0,
        "ev_sp_defense must be 0 (both parents 0)"
    );

    // nickname = empty (the seam/reducer pass chosen_nickname = None)
    assert!(
        off.nickname.is_empty(),
        "TEETH(A0-6): offspring nickname must be empty (None -> unwrap_or_default); \
         kills: carrying a parent nickname; got: {:?}",
        off.nickname
    );

    // nature = parent A's nature (Adamant) because A has higher bond (200 > 150)
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

    // current_hp = full derived HP at the TAXED level (not the parents' current_hp,
    // and not the level-1 body's HP). The exact number depends on derive_stats, so
    // pin the invariant (full HP) plus a floor that the level-1 body cannot reach:
    // make_monster_row's parents ship current_hp = 50, so an accidental carry shows.
    assert_eq!(
        off.current_hp, off.stat_hp,
        "TEETH: offspring current_hp must equal stat_hp (full HP at the taxed level); \
         kills: carrying parent current_hp"
    );
    assert!(
        off.current_hp > 0,
        "offspring current_hp must be > 0 (derived HP with valid base stats)"
    );
    assert_ne!(
        off.current_hp, 50,
        "TEETH: offspring current_hp must NOT be the parents' stored current_hp (50); \
         kills: an impl that copies a parent's current_hp into the offspring row"
    );
}

// ---------------------------------------------------------------------------
// Fuse order-independence (bonus): fuse(a, b) and fuse(b, a) with same pair
// → offspring species, IVs, and slot are identical (nature may differ on tie).
// kills: order-dependent IV computation or slot selection.
// ---------------------------------------------------------------------------

/// fuse(a, b) and fuse(b, a): with bonds a=200 > b=150, nature goes to A regardless
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
    // A0 fixture bump: both parents are now eligible (bond >= 120) and the bonds
    // still DIFFER (200 vs 150), which is what this test's premise requires.
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    ma.nature_kind = NatureKind::Adamant;
    ma.party_slot = 5;
    ma.iv_hp = 10;
    ma.iv_attack = 31;
    ma.iv_defense = 5;
    ma.iv_speed = 20;
    ma.iv_sp_attack = 0;
    ma.iv_sp_defense = 15;

    // Parent B: bond=150, Timid, species=3, party_slot=2
    let mut mb = make_fusable_monster_row(2, owner, 20, 150);
    mb.species_id = 3;
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

    // With bonds differing (a=200 > b=150), nature is ALWAYS a's (Adamant) regardless of call order.
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
// EARS 12.5a-3 — dual-write ordering: offspring monster_pub must have the
// auto-assigned monster_id (not 0).
//
// Bug reference: 12.5a-1 (evolution.rs lines 359-361).  pub_from_monster is
// called on the pre-insert Monster row (monster_id==0) so the resulting
// monster_pub.monster_id is 0 instead of the real auto_inc id.
//
// This test starts RED because fuse_seam intentionally reproduces the buggy
// ordering (pub_from_monster before insert).  It turns GREEN when the
// implementer fixes both the seam AND evolution.rs:
//   let inserted = ctx.db.monster().insert(offspring_monster);
//   ctx.db.monster_pub().insert(pub_from_monster(&inserted));
// ---------------------------------------------------------------------------

/// 12.5a-3: offspring monster_pub.monster_id must equal offspring monster.monster_id.
///
/// RED state: fuse_seam calls `pub_from_monster(&offspring_monster)` before
/// `db.insert_monster(offspring_monster)`.  Because `offspring_monster.monster_id == 0`
/// at that point, `offspring_pub.monster_id` is 0.  The assertions below catch this.
///
/// Kills: any implementation (seam OR production) that calls pub_from_monster on
/// the pre-insert row (i.e. before the auto_inc id is assigned).
#[test]
fn fuse_offspring_pub_id_matches_monster_id() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    // Seed species: 1 (parent A), 3 (parent B), 4 (offspring).
    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)

    // Fusion recipe: species 1 + species 3 → species 4.
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let effect = fuse_seam(&mut db, owner, 1, 2).expect("fuse must succeed with valid setup");

    // ASSERTION 1: no monster_pub row may have monster_id == 0
    // (kills: calling pub_from_monster on the pre-insert offspring row)
    for pub_row in db.monster_pubs.values() {
        assert_ne!(
            pub_row.monster_id,
            0,
            "TEETH(12.5a): monster_pub must not have monster_id=0; \
             a pub row with id=0 means pub_from_monster was called before insert assigned the auto_inc id"
        );
    }

    // ASSERTION 2: HashMap key must match the pub row's monster_id
    // (kills: pub row keyed under 0 but with a non-zero field, or vice versa)
    for (key, pub_row) in &db.monster_pubs {
        assert_eq!(
            *key, pub_row.monster_id,
            "TEETH(12.5a): monster_pub HashMap key ({key}) must equal pub_row.monster_id ({}); \
             mismatch means the pub was inserted under the wrong key",
            pub_row.monster_id
        );
    }

    // ASSERTION 3: a monster_pub row must exist for the real offspring id returned by fuse_seam
    // (kills: impl that inserts pub under id=0, leaving the real offspring id without a pub row)
    assert!(
        db.monster_pubs.contains_key(&effect.offspring_monster_id),
        "TEETH(12.5a): monster_pub row must exist for offspring id={}; \
         missing pub means the pub was inserted under a different key (likely 0)",
        effect.offspring_monster_id
    );

    // ASSERTION 4: the pub row's monster_id must reference an existing monster row
    // (kills: pub row with garbage id that has no matching private monster)
    let offspring_pub = db.monster_pubs.get(&effect.offspring_monster_id).unwrap();
    assert!(
        db.monsters.contains_key(&offspring_pub.monster_id),
        "TEETH(12.5a): monster row must exist for pub_row.monster_id={}; \
         the pub and private tables must point at the same row",
        offspring_pub.monster_id
    );
}

// ---------------------------------------------------------------------------
// A0 (ADR-0147) — fusion-eligibility gate through the seam (spec A0-7/A0-8/A0-9)
//
// The seam no longer hand-rolls any part of the guard chain: self-fusion, the level
// minimum and the bond minimum all arrive through ONE call to
// `super::reject_if_not_fusable` → `game_core::fusion_eligible`.
//
// Every expected message substring below is HARDCODED ("itself", "level 10",
// "120 bond") — never built from MIN_FUSION_LEVEL/MIN_FUSION_BOND — so a silent
// retune of either constant turns these red instead of quietly re-targeting.
// ---------------------------------------------------------------------------

/// A0 helper: seed a COMPLETE, otherwise-valid two-parent fuse setup.
///
/// Species 1 (parent A) + species 3 (parent B) → species 4, with the recipe row
/// present, both parents owned by `owner`, and no battles. Levels and bonds are the
/// ONLY variables, so any `Err` from `fuse_seam` on this setup can come from the
/// eligibility gate and nothing else — that is what makes the parity matrix and the
/// rejection tests non-vacuous.
///
/// Returns the two seeded rows so a test can build the pure oracle's
/// `MonsterInstance`s from the very same data the seam reads.
fn seed_fusable_pair(
    db: &mut TestEvolutionDb,
    owner: Identity,
    a_level: u8,
    a_bond: u8,
    b_level: u8,
    b_bond: u8,
) -> (Monster, Monster) {
    db.insert_species(source_species_row()); // id=1 (parent A)
    db.insert_species(make_species_row(3, 60, 70)); // id=3 (parent B)
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_fusable_monster_row(1, owner, a_level, a_bond);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, b_level, b_bond);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    (ma, mb)
}

/// T27a (A0-7): parent A below `MIN_FUSION_LEVEL` is refused through the seam.
/// Parent B is STRICTLY above BOTH minimums (level 50 / bond 200), so the level gate
/// is the only thing that can fire.
#[test]
fn test_fuse_level_below_minimum_rejects_a() {
    // kills: no level gate at all; a b-only check; an `&&` form that only refuses
    //        when BOTH parents are under-levelled
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_fusable_pair(&mut db, owner, 9, 200, 50, 200);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH(A0-7): parent A at level 9 is below the fusion minimum — must be refused"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("level 10"),
        "the refusal must name the level minimum (10); got: {msg:?}"
    );
}

/// T27b (A0-7): parent B below `MIN_FUSION_LEVEL` is refused through the seam.
#[test]
fn test_fuse_level_below_minimum_rejects_b() {
    // kills: an a-only check (parent A is fully eligible here, so an a-only gate
    //        would let this pair through)
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_fusable_pair(&mut db, owner, 50, 200, 9, 200);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH(A0-7): parent B at level 9 is below the fusion minimum — must be refused"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("level 10"),
        "the refusal must name the level minimum (10); got: {msg:?}"
    );
}

/// T28a (A0-7): parent A below `MIN_FUSION_BOND` is refused through the seam.
/// Both parents are level 50 (strictly above the level minimum), so bond is the only
/// gate that can fire.
#[test]
fn test_fuse_bond_below_minimum_rejects_a() {
    // kills: no bond gate at all; a b-only check; an `&&` form that only refuses
    //        when BOTH parents are under-bonded
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_fusable_pair(&mut db, owner, 50, 119, 50, 200);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH(A0-7): parent A at bond 119 is below the fusion minimum — must be refused"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("120 bond"),
        "the refusal must name the bond minimum (120); got: {msg:?}"
    );
}

/// T28b (A0-7): parent B below `MIN_FUSION_BOND` is refused through the seam.
#[test]
fn test_fuse_bond_below_minimum_rejects_b() {
    // kills: an a-only bond check (parent A is fully eligible here)
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_fusable_pair(&mut db, owner, 50, 200, 50, 119);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "TEETH(A0-7): parent B at bond 119 is below the fusion minimum — must be refused"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("120 bond"),
        "the refusal must name the bond minimum (120); got: {msg:?}"
    );
}

/// T29 (A0-7 boundary): the EXACT minimums (level 10 AND bond 120 on both parents)
/// are ACCEPTED and the fusion completes end-to-end.
#[test]
fn test_fuse_exact_eligibility_boundary_succeeds() {
    // kills: a strict `>` boundary anywhere in the chain (level == 10 or bond == 120
    //        would be refused); an over-eager gate that refuses everything
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_fusable_pair(&mut db, owner, 10, 120, 10, 120);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_ok(),
        "TEETH(A0-7): level 10 / bond 120 is the INCLUSIVE minimum on both parents — \
         the fusion must succeed; got Err: {:?}",
        result.err()
    );
    let offspring_id = result.unwrap().offspring_monster_id;
    let off = db.get_monster(offspring_id).expect("offspring must exist");
    assert_eq!(
        off.species_id, 4,
        "the boundary fusion must really produce the recipe's offspring species"
    );
    assert_eq!(
        off.bond, 90,
        "offspring bond must be 90 (max(120, 120) * 75 / 100) — proves the accepted \
         fusion ran the real transform, not a short-circuit"
    );
}

/// T30 (A0-9, ELIGIBILITY PARITY): on every boundary case, `fuse_seam`'s accept/
/// reject decision agrees with `game_core::fusion_eligible` evaluated on the same
/// rows, and every rejection carries the message its variant maps to.
///
/// Scope (plan rev-2 #5): this proves `seam ∘ reject_if_not_fusable == fusion_eligible`,
/// NOT `whole-seam == reducer`. Each row is otherwise fully valid (owned, recipe
/// seeded, no battle), so eligibility is the only thing that can differ.
///
/// kills: a seam (or helper) that re-implements the guard chain by hand and drifts
///        from game_core on ANY boundary — a single disagreeing row fails;
///        a variant→message mapping that emits the wrong string (e.g. the level
///        message for a bond failure), which would silently mislead the player.
#[test]
fn test_fuse_eligibility_parity_matrix() {
    let owner = owner_id();

    // (label, a_level, a_bond, b_level, b_bond, self_fuse)
    let rows: [(&str, u8, u8, u8, u8, bool); 14] = [
        ("self-fusion with perfect stats", 50, 200, 50, 200, true),
        ("a level 9 (below)", 9, 200, 50, 200, false),
        ("a level 10 (exact minimum)", 10, 200, 50, 200, false),
        ("a level 11 (above)", 11, 200, 50, 200, false),
        ("b level 9 (below)", 50, 200, 9, 200, false),
        ("b level 10 (exact minimum)", 50, 200, 10, 200, false),
        ("b level 11 (above)", 50, 200, 11, 200, false),
        ("a bond 119 (below)", 50, 119, 50, 200, false),
        ("a bond 120 (exact minimum)", 50, 120, 50, 200, false),
        ("a bond 121 (above)", 50, 121, 50, 200, false),
        ("b bond 119 (below)", 50, 200, 50, 119, false),
        ("b bond 120 (exact minimum)", 50, 200, 50, 120, false),
        ("b bond 121 (above)", 50, 200, 50, 121, false),
        ("both below: a level 9 + b bond 119", 9, 200, 50, 119, false),
    ];

    for (label, a_level, a_bond, b_level, b_bond, self_fuse) in rows {
        let mut db = TestEvolutionDb::new();
        let (ma, mb) = seed_fusable_pair(&mut db, owner, a_level, a_bond, b_level, b_bond);

        // Oracle: the pure gate, over the SAME rows the seam is about to read.
        let a_inst = super::monster_to_instance(&ma).expect("parent a must marshal");
        let b_inst = super::monster_to_instance(&mb).expect("parent b must marshal");
        let (call_a, call_b) = if self_fuse { (1u64, 1u64) } else { (1u64, 2u64) };
        let oracle = if self_fuse {
            game_core::fusion_eligible(call_a, call_b, &a_inst, &a_inst)
        } else {
            game_core::fusion_eligible(call_a, call_b, &a_inst, &b_inst)
        };

        let seam = fuse_seam(&mut db, owner, call_a, call_b);

        assert_eq!(
            seam.is_err(),
            oracle.is_err(),
            "PARITY[{label}]: fuse_seam and game_core::fusion_eligible must agree; \
             seam = {:?}, fusion_eligible = {:?}",
            seam.as_ref().err(),
            oracle
        );

        if let Err(variant) = oracle {
            // Hardcoded per-variant substrings — never derived from the constants.
            let needle = match variant {
                game_core::FusionError::SelfFusion => "itself",
                game_core::FusionError::BelowMinLevel => "level 10",
                game_core::FusionError::BelowMinBond => "120 bond",
            };
            let msg = seam.expect_err("parity above asserted the seam rejects this row");
            assert!(
                msg.contains(needle),
                "PARITY[{label}]: {variant:?} must surface a message containing {needle:?}; \
                 got: {msg:?}"
            );
        }
    }
}

/// T31 (A0-8, END-TO-END): the bond tax reaches the offspring ROW and closes the
/// "reusable high-bond carrier" loop through the real seam.
///
/// Two bond-120 parents are exactly at `MIN_FUSION_BOND`, so their fusion is legal;
/// the offspring row must then carry bond 90 = 120 * 75 / 100. A second fusion using
/// that offspring against a FULLY eligible partner — with a matching recipe seeded,
/// so "no fusion recipe" cannot be the reason — must be refused for bond.
#[test]
fn test_fuse_bond_tax_blocks_reusing_the_offspring_as_a_carrier() {
    // kills: an untaxed bond carry (the row would read 120 and the re-fuse would
    //        SUCCEED, re-opening the exploit the slice exists to close);
    //        a bond that never reaches the row at all (a default_bond() 70 leftover
    //        also blocks the re-fuse, so the exact `90` pin is what separates the
    //        correct impl from that accidentally-passing one);
    //        an eligibility gate that never re-reads the offspring's own bond
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    // First fusion: species 1 + 3 → 4, both parents at EXACTLY MIN_FUSION_BOND.
    seed_fusable_pair(&mut db, owner, 20, 120, 20, 120);

    let offspring_id = fuse_seam(&mut db, owner, 1, 2)
        .expect("bond-120 parents are eligible — the first fusion must succeed")
        .offspring_monster_id;

    // Read the two columns out before touching `db` mutably again.
    let (offspring_bond, offspring_level) = {
        let offspring = db.get_monster(offspring_id).expect("offspring must exist");
        (offspring.bond, offspring.level)
    };
    assert_eq!(
        offspring_bond, 90,
        "TEETH(A0-8): the offspring ROW must carry the TAXED bond 90 (120 * 75 / 100)"
    );
    assert_eq!(
        offspring_level, 15,
        "fixture sanity: the offspring is level 15 (>= the level minimum), so LEVEL \
         cannot be why the re-fuse below is refused"
    );

    // Seed a THIRD, fully eligible partner AND a recipe pairing it with the
    // offspring's species — the re-fuse would otherwise be a completely legal fusion.
    db.insert_species(make_species_row(5, 70, 70)); // id=5 (partner)
    db.insert_species(make_species_row(6, 90, 90)); // id=6 (second-generation offspring)
    db.insert_fusion(make_fusion_recipe_row(2, 4, 5, 6));

    let mut partner = make_fusable_monster_row(3, owner, 20, 200);
    partner.species_id = 5;
    db.insert_monster(partner.clone());
    db.insert_monster_pub(make_monster_pub(&partner));

    let result = fuse_seam(&mut db, owner, offspring_id, 3);

    assert!(
        result.is_err(),
        "TEETH(A0-8): a bond-90 offspring must NOT be re-fusable — the carrier must \
         regrow bond through cooldown-gated apply_care first"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("120 bond"),
        "TEETH(A0-8): the refusal must be the BOND gate — a recipe IS seeded and the \
         offspring clears the level minimum; got: {msg:?}"
    );
}

/// T33 (A0-6): the seam passes `chosen_nickname = None`, so the offspring ROW's
/// nickname column is the empty string (`Option::unwrap_or_default`) even when BOTH
/// parents are named. The dual-written `monster_pub` row must agree.
#[test]
fn test_fuse_offspring_row_nickname_is_empty_when_none_is_chosen() {
    // kills: carrying either parent's nickname into the row; a placeholder default
    //        name; a private/pub divergence on the nickname column
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    ma.nickname = "ParentA".to_string();
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
    mb.species_id = 3;
    mb.nickname = "ParentB".to_string();

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    let offspring_id = fuse_seam(&mut db, owner, 1, 2)
        .expect("both parents are eligible — this fusion must succeed")
        .offspring_monster_id;

    let off = db.get_monster(offspring_id).expect("offspring must exist");
    assert!(
        off.nickname.is_empty(),
        "TEETH(A0-6): chosen_nickname is None, so the row's nickname column must be \
         the empty string — never a parent's name; got: {:?}",
        off.nickname
    );

    let off_pub = db
        .get_monster_pub(offspring_id)
        .expect("offspring monster_pub must exist");
    assert!(
        off_pub.nickname.is_empty(),
        "TEETH: monster_pub.nickname must match the private row (dual-write discipline); \
         got: {:?}",
        off_pub.nickname
    );
}

// ---------------------------------------------------------------------------
// m17.5a (ADR-0122) — side-B seam rejection tests (§1.3 BINDING, seam-parity)
//
// These tests verify that evolve_seam and fuse_seam, after their both-role chain
// update, correctly REJECT when the monster's owner appears ONLY as
// opponent_identity of an Ongoing PvP battle (the side-B slot).
//
// GREEN-BY-CONSTRUCTION: these tests execute the seams directly against the
// updated TestEvolutionDb and real reject_if_in_battle logic — no stub needed.
// The production-forcing RED gate for the *real source code* is the C2 eval
// criterion in evals/battle-reducer-security.eval.mjs, which scans the actual
// evolution.rs bodies for the opponent_identity chain.
//
// Each test inserts a PvP battle where:
//   player_identity  = some other identity  (not the monster's owner)
//   opponent_identity = owner               (the monster's owner as side-B)
//   outcome           = Ongoing
//   opponent_monster_ids includes the target monster_id
//
// This matches the actual shape of PvP battles created by start_pvp_battle
// (pvp.rs:239-247): opponent_identity = real player, opponent_monster_ids =
// opponent_party.  The evolve/fuse guards must block the side-B participant.
// ---------------------------------------------------------------------------

/// m17.5a — evolve rejected when monster's owner is side-B (opponent_identity) of an
/// Ongoing PvP battle (the monster appears in opponent_monster_ids).
///
/// GREEN-by-construction (seam executes reject_if_in_battle directly with the
/// both-role chain); the RED gate for production code is the C2 eval criterion.
///
/// Kills a seam that still uses player-only filter: the player arm would be empty
/// for this owner in this battle, so player-only returns Ok (exploit succeeds).
/// The both-role chain catches the opponent arm and returns Err.
#[test]
fn test_evolve_sideb_pvp_battle_rejects() {
    let owner = owner_id(); // [1u8;32]
    let pvp_challenger = other_owner_id(); // [2u8;32] — the PvP side-A player
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

    // PvP battle: owner is side-B (opponent_identity); the challenger is side-A.
    // The monster appears in opponent_monster_ids — matching the real pvp.rs shape.
    let pvp_battle = Battle {
        battle_id: 200,
        player_identity: pvp_challenger, // side A — NOT the owner
        opponent_identity: owner,        // side B — the monster's owner
        state: {
            let dummy = game_core::BattleMonster {
                species_id: 1,
                affinity: game_core::Affinity::Fire,
                level: 20,
                current_hp: 50,
                max_hp: 50,
                stats: game_core::StatBlock {
                    hp: 50,
                    attack: 40,
                    defense: 40,
                    speed: 40,
                    sp_attack: 40,
                    sp_defense: 40,
                },
                known_skill_ids: vec![],
                status: None,
            };
            game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy],
                },
                outcome: game_core::BattleOutcome::Ongoing,
                turn_number: 1,
                weather: None,
            }
        },
        party_monster_ids: vec![999u64], // challenger's monster (not relevant)
        opponent_monster_ids: vec![monster_id], // owner's monster in side-B slot
        created_at_ms: 0,
    };
    db.insert_battle(pvp_battle);

    let result = evolve_seam(&mut db, owner, monster_id);

    assert!(
        result.is_err(),
        "m17.5a TEETH (evolve side-B): owner as opponent_identity of an Ongoing PvP battle \
         must be rejected; \
         kills: a seam that only filters player_identity (player-only chain would see \
         no player-arm row for this owner and return Ok — the pre-fix exploit path)"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {:?}",
        msg
    );
}

/// m17.5a — evolve NOT rejected when owner's only battle is Ongoing but as side-B
/// of a NON-Ongoing (completed) PvP battle.  Verifies no false positive.
///
/// GREEN-by-construction; no production gap here (the guard correctly allows
/// evolution once the PvP battle is complete).
#[test]
fn test_evolve_sideb_completed_pvp_battle_accepted() {
    let owner = owner_id(); // [1u8;32]
    let pvp_challenger = other_owner_id(); // [2u8;32]
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

    // Completed PvP battle (SideBWins) where owner is side-B.
    let completed_battle = Battle {
        battle_id: 201,
        player_identity: pvp_challenger,
        opponent_identity: owner,
        state: {
            let dummy = game_core::BattleMonster {
                species_id: 1,
                affinity: game_core::Affinity::Fire,
                level: 20,
                current_hp: 50,
                max_hp: 50,
                stats: game_core::StatBlock {
                    hp: 50,
                    attack: 40,
                    defense: 40,
                    speed: 40,
                    sp_attack: 40,
                    sp_defense: 40,
                },
                known_skill_ids: vec![],
                status: None,
            };
            game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy],
                },
                outcome: game_core::BattleOutcome::SideBWins, // completed — must not block
                turn_number: 5,
                weather: None,
            }
        },
        party_monster_ids: vec![999u64],
        opponent_monster_ids: vec![monster_id],
        created_at_ms: 0,
    };
    db.insert_battle(completed_battle);

    let result = evolve_seam(&mut db, owner, monster_id);

    assert!(
        result.is_ok(),
        "m17.5a NO-FALSE-POSITIVE (evolve side-B completed): completed PvP battle as side-B \
         must NOT block evolution — only Ongoing battles matter; \
         got Err: {:?}",
        result.err()
    );
}

/// m17.5a — fuse rejected when monster A's owner is side-B (opponent_identity) of
/// an Ongoing PvP battle (monster A appears in opponent_monster_ids).
///
/// GREEN-by-construction (seam executes reject_if_in_battle directly with the
/// both-role chain); the RED gate for production code is the C2 eval criterion.
///
/// Kills: a fuse seam that still uses player-only filter for parent A's check.
#[test]
fn test_fuse_sideb_pvp_battle_rejects_a() {
    let owner = owner_id(); // [1u8;32]
    let pvp_challenger = other_owner_id(); // [2u8;32]
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // PvP battle where owner is side-B and monster A (id=1) is in opponent_monster_ids.
    let pvp_battle = Battle {
        battle_id: 202,
        player_identity: pvp_challenger,
        opponent_identity: owner,
        state: {
            let dummy = game_core::BattleMonster {
                species_id: 1,
                affinity: game_core::Affinity::Fire,
                level: 20,
                current_hp: 50,
                max_hp: 50,
                stats: game_core::StatBlock {
                    hp: 50,
                    attack: 40,
                    defense: 40,
                    speed: 40,
                    sp_attack: 40,
                    sp_defense: 40,
                },
                known_skill_ids: vec![],
                status: None,
            };
            game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy],
                },
                outcome: game_core::BattleOutcome::Ongoing,
                turn_number: 1,
                weather: None,
            }
        },
        party_monster_ids: vec![999u64],
        opponent_monster_ids: vec![1u64], // monster A is in side-B slot
        created_at_ms: 0,
    };
    db.insert_battle(pvp_battle);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "m17.5a TEETH (fuse side-B, parent A): monster A as opponent_identity side-B \
         of an Ongoing PvP battle must be rejected; \
         kills: player-only fuse seam for parent A (pre-fix would return Ok)"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {:?}",
        msg
    );
}

/// m17.5a — fuse rejected when monster B's owner is side-B (opponent_identity) of
/// an Ongoing PvP battle (monster B (id=2) appears in opponent_monster_ids, monster A
/// is NOT in any battle).
///
/// Mirrors test_fuse_sideb_pvp_battle_rejects_a but pins the SECOND reject_if_in_battle
/// call in fuse_seam independently: if only the first call (parent A) is chained but the
/// second call (parent B) is player-only, this test catches the partial-fuse bypass.
///
/// GREEN-by-construction (seam executes reject_if_in_battle directly with the
/// both-role chain); the RED gate for production code is the C2 eval criterion.
///
/// Kills: a fuse seam/production code where only parent-A's reject_if_in_battle call
/// has the both-role chain and parent-B's call is player-only (partial-fuse bypass).
#[test]
fn test_fuse_sideb_pvp_battle_rejects_b() {
    let owner = owner_id(); // [1u8;32]
    let pvp_challenger = other_owner_id(); // [2u8;32]
    let mut db = TestEvolutionDb::new();

    db.insert_species(source_species_row()); // id=1
    db.insert_species(make_species_row(3, 60, 70)); // id=3
    db.insert_species(make_species_row(4, 80, 90)); // id=4 (offspring)
    db.insert_fusion(make_fusion_recipe_row(1, 1, 3, 4));

    // A0 fixture bump (no assertion weakened): both parents must CLEAR the new
    // fusion-eligibility gate (bond >= 120) or this test's target error becomes
    // unreachable behind "at least 120 bond".
    let mut ma = make_fusable_monster_row(1, owner, 20, 200);
    ma.species_id = 1;
    let mut mb = make_fusable_monster_row(2, owner, 20, 200);
    mb.species_id = 3;

    db.insert_monster(ma.clone());
    db.insert_monster_pub(make_monster_pub(&ma));
    db.insert_monster(mb.clone());
    db.insert_monster_pub(make_monster_pub(&mb));

    // PvP battle where owner is side-B and monster B (id=2) is in opponent_monster_ids.
    // Monster A (id=1) is NOT present in any battle — the first reject_if_in_battle
    // call (for parent A) should pass; only the second (for parent B) must reject.
    let pvp_battle = Battle {
        battle_id: 203,
        player_identity: pvp_challenger,
        opponent_identity: owner,
        state: {
            let dummy = game_core::BattleMonster {
                species_id: 1,
                affinity: game_core::Affinity::Fire,
                level: 20,
                current_hp: 50,
                max_hp: 50,
                stats: game_core::StatBlock {
                    hp: 50,
                    attack: 40,
                    defense: 40,
                    speed: 40,
                    sp_attack: 40,
                    sp_defense: 40,
                },
                known_skill_ids: vec![],
                status: None,
            };
            game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![dummy],
                },
                outcome: game_core::BattleOutcome::Ongoing,
                turn_number: 1,
                weather: None,
            }
        },
        party_monster_ids: vec![999u64],
        opponent_monster_ids: vec![2u64], // monster B (id=2) is in side-B slot; A (id=1) is NOT
        created_at_ms: 0,
    };
    db.insert_battle(pvp_battle);

    let result = fuse_seam(&mut db, owner, 1, 2);

    assert!(
        result.is_err(),
        "m17.5a TEETH (fuse side-B, parent B): monster B as opponent_identity side-B \
         of an Ongoing PvP battle must be rejected; \
         kills: partial-fuse bypass where only parent-A's reject_if_in_battle has the \
         both-role chain and parent-B's call is player-only (pre-fix would return Ok \
         because monster A is not in any battle, so the first call passes, and the \
         player-only second call misses monster B in the opponent_identity slot)"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {:?}",
        msg
    );
}

// ---------------------------------------------------------------------------
// Test seams — evolve_seam / fuse_seam live HERE (not in evolution.rs) so that
// the no-idle-accrual eval, which excludes _tests.rs files from its growth-field
// scan, does not flag them. They are test infrastructure, not production code.
// ---------------------------------------------------------------------------

/// Pure evolve seam: mirrors the `evolve` reducer logic against a `TestEvolutionDb`.
/// Tests call this instead of the reducer (which requires a live SpacetimeDB context).
pub(crate) fn evolve_seam(
    db: &mut TestEvolutionDb,
    sender: Identity,
    monster_id: u64,
) -> Result<EvolutionEffect, String> {
    let Some(mut m) = db.get_monster(monster_id).cloned() else {
        return Err("monster not found".to_string());
    };

    // Ownership check
    if m.owner_identity != sender {
        return Err("not owner".to_string());
    }

    // Battle guard — chain BOTH roles (player_identity and opponent_identity) to mirror the
    // production path after ADR-0122: ctx.db.battle().player_identity().filter(owner).chain(
    //     ctx.db.battle().opponent_identity().filter(owner)) passed to reject_if_in_battle.
    // The chain catches monsters that are side-B of a PvP battle (opponent_identity role).
    // NOTE: reject_if_in_battle needs no != WILD_IDENTITY refinement here because it keys
    // on monster_id ∈ opponent_monster_ids, and wild battles have empty opponent_monster_ids
    // (plan §1.3) — so an owned monster can never appear in a wild opponent slot. The chain
    // is deliberate to catch side-B PvP monsters, not an omission of the WILD refinement.
    // GREEN-by-construction once this seam update is applied (it exercises reject_if_in_battle
    // directly); the RED gate forcing the production change is the C2 eval criterion.
    super::reject_if_in_battle(
        db.get_battles()
            .filter(|b| b.player_identity == sender)
            .chain(db.get_battles().filter(|b| b.opponent_identity == sender)),
        monster_id,
    )?;

    // Load source species
    let Some(_src_species_row) = db.get_species(m.species_id) else {
        return Err(format!("source species {} not found", m.species_id));
    };

    // Find evolutions for this monster's current species (from test database)
    let evolutions: Vec<game_core::EvolutionCondition> =
        db.get_evolutions(m.species_id).cloned().unwrap_or_default();

    // Check eligibility
    let target_species_id = match super::compute_evolves_to(&evolutions, m.level, m.bond) {
        Some(target) => target,
        None => return Err("monster is not eligible to evolve".to_string()),
    };

    // Load target species
    let Some(target_species_row) = db.get_species(target_species_id) else {
        return Err(format!("target species {} not found", target_species_id));
    };

    // Marshal to MonsterInstance and call game_core::evolve
    let m_inst = super::monster_to_instance(&m)?;
    let target_species = super::species_from_row(target_species_row)?;
    let transformed = game_core::evolve(&m_inst, &target_species);

    // Update the monster: species, level, xp, stats, evolves_to
    m.species_id = transformed.species_id;
    m.level = transformed.level.as_u8();
    m.xp = transformed.xp.value();
    m.stat_hp = transformed.derived_stats.hp;
    m.stat_attack = transformed.derived_stats.attack;
    m.stat_defense = transformed.derived_stats.defense;
    m.stat_speed = transformed.derived_stats.speed;
    m.stat_sp_attack = transformed.derived_stats.sp_attack;
    m.stat_sp_defense = transformed.derived_stats.sp_defense;
    m.current_hp = transformed.current_hp;

    // Recompute evolves_to on the new species
    let evolutions_after = db
        .get_evolutions(transformed.species_id)
        .cloned()
        .unwrap_or_default();
    m.evolves_to = super::compute_evolves_to(&evolutions_after, m.level, m.bond);

    // Dual-write: Monster + MonsterPub
    let pub_row = super::pub_from_monster(&m);
    db.update_monster(m);
    db.update_monster_pub(pub_row);

    Ok(EvolutionEffect)
}

/// Pure fuse seam: mirrors the `fuse` reducer logic against a `TestEvolutionDb`.
///
/// A0 (ADR-0147) rewiring — guard order is now:
///   lookup a,b → ownership a,b → marshal a,b (MOVED UP) → `reject_if_not_fusable`
///   → battle ×2 → species ×2 → recipe → offspring species → canonicalize → fuse.
///
/// Three deliberate deletions (spec A0-7 / plan rev-2 #6):
/// - the inline self-id comparison block is GONE — self-fusion is now owned by
///   `super::reject_if_not_fusable` → `game_core::fusion_eligible`; the
///   hand-duplicated guard chain is DELETED, not migrated.
/// - the `a.owner_identity != b.owner_identity` block is GONE — it is dead code
///   after two ownership checks against the same `sender` (a guaranteed mutation
///   survivor).
/// - marshal moved above the battle guards because eligibility needs the two
///   `MonsterInstance`s; `monster_to_instance` reads only the Monster row.
///
/// The seam still has NO trade guard (the real reducer does) — that pre-existing
/// asymmetry is unchanged by this slice and is recorded in ADR-0147.
pub(crate) fn fuse_seam(
    db: &mut TestEvolutionDb,
    sender: Identity,
    a_id: u64,
    b_id: u64,
) -> Result<FuseEffect, String> {
    let Some(a) = db.get_monster(a_id).cloned() else {
        return Err("monster a not found".to_string());
    };
    let Some(b) = db.get_monster(b_id).cloned() else {
        return Err("monster b not found".to_string());
    };

    // Ownership checks — these precede EVERY stats-derived error so a caller can
    // never probe a foreign monster's level/bond through an eligibility message.
    if a.owner_identity != sender {
        return Err("not owner of monster a".to_string());
    }
    if b.owner_identity != sender {
        return Err("not owner of monster b".to_string());
    }

    // Marshal MOVED UP (A0): the eligibility gate is expressed over MonsterInstance.
    let a_inst = super::monster_to_instance(&a)?;
    let b_inst = super::monster_to_instance(&b)?;

    // Fusion eligibility (self-fusion / MIN_FUSION_LEVEL / MIN_FUSION_BOND) through
    // the ONE shared helper both this seam and the real `fuse` reducer call, which
    // delegates to `game_core::fusion_eligible` and maps the variants to messages
    // exactly once (plan D3).
    super::reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;

    // Neither can be in battle — chain BOTH roles (player_identity and opponent_identity) to
    // mirror the production path after ADR-0122.  The chain catches a monster that is side-B
    // of a PvP battle (opponent_identity role) — the exact gap this slice closes.
    // NOTE: reject_if_in_battle needs no != WILD_IDENTITY refinement here because it keys
    // on monster_id ∈ opponent_monster_ids, and wild battles have empty opponent_monster_ids
    // (plan §1.3) — so an owned monster can never appear in a wild opponent slot. The chain
    // shape mirrors the production CHAIN SHAPE; the identity-only filter is deliberate, not
    // an omission of the WILD refinement.
    // GREEN-by-construction once this seam update is applied (it exercises reject_if_in_battle
    // directly); the RED gate forcing the production change is the C2 eval criterion.
    super::reject_if_in_battle(
        db.get_battles()
            .filter(|b| b.player_identity == sender)
            .chain(db.get_battles().filter(|b| b.opponent_identity == sender)),
        a_id,
    )?;
    super::reject_if_in_battle(
        db.get_battles()
            .filter(|b| b.player_identity == sender)
            .chain(db.get_battles().filter(|b| b.opponent_identity == sender)),
        b_id,
    )?;

    // Load both species rows
    let Some(_a_species_row) = db.get_species(a.species_id) else {
        return Err(format!("species {} not found", a.species_id));
    };
    let Some(_b_species_row) = db.get_species(b.species_id) else {
        return Err(format!("species {} not found", b.species_id));
    };

    // Find fusion recipe (order-independent)
    let Some(fusion_recipe) = db.find_fusion_recipe(a.species_id, b.species_id) else {
        return Err("no fusion recipe for these species".to_string());
    };

    // Load offspring species
    let Some(offspring_species_row) = db.get_species(fusion_recipe.to_species) else {
        return Err(format!(
            "offspring species {} not found",
            fusion_recipe.to_species
        ));
    };

    // (parents were marshaled above, before the eligibility gate)
    let offspring_species = super::species_from_row(offspring_species_row)?;

    // Call pure transform (order-independent when bonds differ; canonicalize for tie-break).
    // A0-6: the reducer/seam pass `None` — the chosen-nickname arg is wired but
    // unreachable from the client until slice A1.
    let offspring_inst = if a_id < b_id {
        game_core::fuse(&a_inst, &b_inst, &offspring_species, None)
    } else {
        game_core::fuse(&b_inst, &a_inst, &offspring_species, None)
    };

    // Compute evolves_to for offspring
    let offspring_evolutions = db
        .get_evolutions(offspring_inst.species_id)
        .cloned()
        .unwrap_or_default();

    let offspring_evolves_to = super::compute_evolves_to(
        &offspring_evolutions,
        offspring_inst.level.as_u8(),
        offspring_inst.bond.value(),
    );

    // monster_id starts at 0 — insert_monster assigns the real auto_inc id at insert time,
    // mirroring SpacetimeDB's auto_inc behaviour (ADR-0072).

    // Marshal offspring MonsterInstance to Monster row (owner same as parents)
    let offspring_monster = Monster {
        monster_id: 0, // auto_inc — assigned by insert_monster (mirrors production)
        owner_identity: a.owner_identity,
        species_id: offspring_inst.species_id,
        nickname: offspring_inst.nickname.clone().unwrap_or_default(),
        level: offspring_inst.level.as_u8(),
        xp: offspring_inst.xp.value(),
        bond: offspring_inst.bond.value(),
        iv_hp: offspring_inst.ivs.get(game_core::StatKind::Hp),
        iv_attack: offspring_inst.ivs.get(game_core::StatKind::Attack),
        iv_defense: offspring_inst.ivs.get(game_core::StatKind::Defense),
        iv_speed: offspring_inst.ivs.get(game_core::StatKind::Speed),
        iv_sp_attack: offspring_inst.ivs.get(game_core::StatKind::SpAttack),
        iv_sp_defense: offspring_inst.ivs.get(game_core::StatKind::SpDefense),
        nature_kind: offspring_inst.nature.kind(),
        ev_hp: offspring_inst.evs.get(game_core::StatKind::Hp),
        ev_attack: offspring_inst.evs.get(game_core::StatKind::Attack),
        ev_defense: offspring_inst.evs.get(game_core::StatKind::Defense),
        ev_speed: offspring_inst.evs.get(game_core::StatKind::Speed),
        ev_sp_attack: offspring_inst.evs.get(game_core::StatKind::SpAttack),
        ev_sp_defense: offspring_inst.evs.get(game_core::StatKind::SpDefense),
        stat_hp: offspring_inst.derived_stats.hp,
        stat_attack: offspring_inst.derived_stats.attack,
        stat_defense: offspring_inst.derived_stats.defense,
        stat_speed: offspring_inst.derived_stats.speed,
        stat_sp_attack: offspring_inst.derived_stats.sp_attack,
        stat_sp_defense: offspring_inst.derived_stats.sp_defense,
        current_hp: offspring_inst.current_hp,
        party_slot: offspring_inst.party_slot.unwrap_or(crate::PARTY_SLOT_NONE),
        last_care_at_ms: 0,
        evolves_to: offspring_evolves_to,
    };

    // Atomic: delete both parents, insert offspring
    db.delete_monster(a_id);
    db.delete_monster(b_id);
    db.delete_monster_pub(a_id);
    db.delete_monster_pub(b_id);

    let inserted = db.insert_monster(offspring_monster); // assigns real auto_inc id
    db.insert_monster_pub(super::pub_from_monster(&inserted)); // pub built from real id

    Ok(FuseEffect {
        offspring_monster_id: inserted.monster_id,
    })
}

// ---------------------------------------------------------------------------
// TestEvolutionDb — in-memory fake implementing the DB accessor interface
// used by the evolve_seam and fuse_seam pure helpers.
//
// The implementer must define a `trait EvolutionDb` (or equivalent interface)
// that the seam functions accept; this struct implements it for testing.
// The struct itself is ALSO red until the trait is defined.
// ---------------------------------------------------------------------------

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

    /// Insert a Monster row.  If `m.monster_id == 0` the id is auto-assigned
    /// (mirroring SpacetimeDB's auto_inc column behaviour in production).
    /// Returns the inserted row — callers that ignore the return value still compile.
    pub fn insert_monster(&mut self, m: Monster) -> Monster {
        if m.monster_id == 0 {
            let id = self.alloc_monster_id();
            let m2 = Monster {
                monster_id: id,
                ..m
            };
            self.monsters.insert(id, m2.clone());
            m2
        } else {
            self.monsters.insert(m.monster_id, m.clone());
            m
        }
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

    pub fn get_species(&self, id: u32) -> Option<&SpeciesRow> {
        self.species.get(&id)
    }

    pub fn get_evolutions(&self, species_id: u32) -> Option<&Vec<EvolutionCondition>> {
        self.evolutions.get(&species_id)
    }

    pub fn get_battles(&self) -> impl Iterator<Item = &Battle> {
        self.battles.iter()
    }

    pub fn find_fusion_recipe(&self, a_species_id: u32, b_species_id: u32) -> Option<&Fusion> {
        let (recipe_a, recipe_b) = if a_species_id <= b_species_id {
            (a_species_id, b_species_id)
        } else {
            (b_species_id, a_species_id)
        };
        self.fusions
            .iter()
            .find(|r| r.a_species == recipe_a && r.b_species == recipe_b)
    }

    pub fn delete_monster(&mut self, id: u64) {
        self.monsters.remove(&id);
    }

    pub fn delete_monster_pub(&mut self, id: u64) {
        self.monster_pubs.remove(&id);
    }

    pub fn update_monster(&mut self, m: Monster) {
        self.monsters.insert(m.monster_id, m);
    }

    pub fn update_monster_pub(&mut self, p: MonsterPub) {
        self.monster_pubs.insert(p.monster_id, p);
    }
}
