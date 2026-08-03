//! `evolution_tests` — EG1 gating tests for the rewritten `evolve` reducer
//! (spec EG1-9/EG1-11 + EG2-1's reducer shape; ADR-0174).
//!
//! Declared from `evolution.rs` as:
//!   `#[cfg(test)] #[path = "evolution_tests.rs"] mod evolution_tests;`
//! so `super` resolves to the `evolution` module.
//!
//! WHAT CHANGED IN EG1 (this file was rewritten, not patched):
//!   - The ENTIRE fuse matrix is DELETED (`test_fuse_*`, `fuse_seam`,
//!     `make_fusion_recipe_row`, the fuse parity/seam helpers) — fusion is
//!     removed as a feature (EG1-9), not repurposed.
//!   - Every `compute_evolves_to` test is DELETED — the helper and its whole
//!     trigger content model (`EvolutionCondition`/`EvolutionTrigger`) no longer
//!     exist.
//!   - `evolve` is now `evolve(ctx, monster_id: u64, to_species: u32)`: one
//!     targeted `evolution_path` row, gated by the SHARED `game_core::
//!     path_satisfied` predicate, `MonsterPub.tier` from a FRESH target-species
//!     lookup, essence zeroed, Trust/Quality-Time preserved.
//!
//! Pattern (unchanged, ADR-0056): SpacetimeDB's `ReducerContext` is not a unit
//! test harness, so these tests drive `evolve_seam` — the seam mirroring the
//! reducer against an in-memory `TestEvolutionDb` — while calling the REAL
//! production helpers it can (`crate::guards::*`, `crate::marshal::*`,
//! `game_core::path_satisfied`, `super::unmet_requirement`). The production
//! reducer's own delegation is pinned separately by the EG1-11 source-scan at
//! the bottom of this file.
//!
//! Each test carries a `// kills:` note stating which wrong implementation it
//! catches.

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrors the m7b_test_monster_row pattern in
// marshal_tests.rs).
//
// NOTE: deliberately NO `use super::*;` — every production symbol is reached by
// an explicit path (`super::unmet_requirement`, `crate::guards::*`,
// `crate::marshal::*`), so this file cannot silently pick up whatever
// `evolution.rs` happens to import.
// ---------------------------------------------------------------------------

use crate::schema::{
    Battle, EssenceRequirementRow, EvolutionPathRow, Monster, MonsterPub, SpeciesRow, TradeOffer,
};
use game_core::{
    Affinity, BattleOutcome, BattleSide, BattleState, NatureKind, StatBlock, TradeStatus, TrustTier,
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

/// A minimal `SpeciesRow` for seeding the species table in tests.
fn make_species_row(id: u32, hp: u16, other: u16, tier: u8) -> SpeciesRow {
    SpeciesRow {
        id,
        name: format!("TestSpecies{id}"),
        base_hp: hp,
        base_attack: other,
        base_defense: other,
        base_speed: other,
        base_sp_attack: other,
        base_sp_defense: other,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
        ability: None,
        tier,
    }
}

/// Canonical source species (id=1, tier 0 — a base, wild-catchable form).
fn source_species_row() -> SpeciesRow {
    make_species_row(1, 45, 49, 0)
}

/// Canonical target species (id=2, tier 1, DELIBERATELY low base HP so the
/// post-evolve `current_hp` clamp actually fires).
fn target_species_row() -> SpeciesRow {
    make_species_row(2, 20, 80, 1)
}

/// A `Monster` row with every EG1 column at its creation default (0). Level 20,
/// species 1. Used as the base for both the qualified and the disqualified
/// fixtures below.
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
        stat_hp: 51,
        stat_attack: 56,
        stat_defense: 56,
        stat_speed: 72,
        stat_sp_attack: 72,
        stat_sp_defense: 52,
        current_hp: 50,
        party_slot: 0,
        last_care_at_ms: 0,
        // Frozen dead column (Migration B / EG5-6 removes it).
        evolves_to: None,
        // --- EG1 Migration A: the 16 appended columns (ADR-0174 D1) ----------
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

/// A monster that CLEARS every gate on `make_evolution_path_row` — and carries a
/// distinctive value in each of the server-only Quality-Time / Trust columns so
/// that a write-back which rebuilds the row from scratch (instead of patching it)
/// is visible.
///
/// Gate arithmetic (all inclusive):
///   level 20            >= min_level 20
///   essence_fire 150    >= Fire 100
///   trust (30 fav, 2 unfav) -> smoothed 40/52 = 76.9% -> Friendly >= Friendly
///   quality-time 400 ticks -> tier 4 >= 2
///   EVs 252+252 = 504 of 510 -> 98% >= 50%
fn make_qualified_monster_row(monster_id: u64, owner: Identity) -> Monster {
    let mut m = make_monster_row(monster_id, owner);
    m.essence_fire = 150;
    // A pool the path does NOT require — it must still be zeroed on evolution.
    m.essence_water = 7;
    m.trust_favorable_count = 30;
    m.trust_unfavorable_count = 2;
    m.quality_time_ticks_total = 400;
    m.ev_hp = 252;
    m.ev_attack = 252;
    // Distinctive server-only Quality-Time / Trust bookkeeping.
    m.trust_favorable_battle_day_epoch = 5;
    m.quality_time_accum_ms = 777;
    m.quality_time_window_ms = 888;
    m.quality_time_window_start_ms = 999;
    m.last_essence_train_at_ms = 1234;
    // Deliberately ABOVE what species 2 derives at level 20, so the clamp fires.
    m.stat_hp = 250;
    m.current_hp = 250;
    m
}

/// Build the public projection for a monster row through the REAL production
/// marshaling helper, so a fixture can never drift from `pub_from_monster`.
fn make_monster_pub(m: &Monster, tier: u8) -> MonsterPub {
    crate::marshal::pub_from_monster(m, tier)
}

/// The canonical `evolution_path` row: species 1 -> species 2, all five gates
/// present (so every rejection fixture below can weaken exactly one of them).
fn make_evolution_path_row(path_id: u64, edge_id: u32, from: u32, to: u32) -> EvolutionPathRow {
    EvolutionPathRow {
        path_id,
        edge_id,
        from_species: from,
        to_species: to,
        min_level: 20,
        essence: vec![EssenceRequirementRow {
            affinity: Affinity::Fire,
            amount: 100,
        }],
        min_trust_tier: Some(TrustTier::Friendly),
        min_quality_time_tier: Some(2),
        min_nutrition_pct: Some(50),
    }
}

/// A minimal `Ongoing` `BattleState` — enough to fire the battle guard.
fn ongoing_state() -> BattleState {
    let dummy = game_core::BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
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
    BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![dummy.clone()],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![dummy],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    }
}

/// SIDE A: `owner` is `player_identity` and the monster sits in
/// `party_monster_ids`.
fn make_side_a_battle(battle_id: u64, owner: Identity, party_monster_ids: Vec<u64>) -> Battle {
    Battle {
        battle_id,
        player_identity: owner,
        opponent_identity: Identity::from_byte_array([0u8; 32]),
        state: ongoing_state(),
        party_monster_ids,
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

/// SIDE B: someone ELSE is `player_identity`, `owner` is `opponent_identity`, and
/// the monster sits in `opponent_monster_ids` — the PvP shape that a
/// player-identity-only guard misses (ADR-0122).
fn make_side_b_battle(
    battle_id: u64,
    challenger: Identity,
    owner: Identity,
    opponent_monster_ids: Vec<u64>,
) -> Battle {
    Battle {
        battle_id,
        player_identity: challenger,
        opponent_identity: owner,
        state: ongoing_state(),
        party_monster_ids: vec![999],
        opponent_monster_ids,
        created_at_ms: 0,
    }
}

/// An ACTIVE (Pending) trade offer escrowing `monster_id` on the initiator side.
fn make_active_trade_offer(trade_id: u64, initiator: Identity, monster_id: u64) -> TradeOffer {
    TradeOffer {
        trade_id,
        initiator,
        counterparty: other_owner_id(),
        initiator_monster_ids: vec![monster_id],
        initiator_items: vec![],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    }
}

/// Seed the standard happy-path world: species 1 (tier 0) + species 2 (tier 1),
/// one path 1 -> 2, and a qualified monster (+ its public projection).
fn seed_evolvable_world(db: &mut TestEvolutionDb, monster_id: u64, owner: Identity) -> Monster {
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));
    let m = make_qualified_monster_row(monster_id, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));
    m
}

// ===========================================================================
// EG2-1 guard suite — every rejection is MESSAGE-PINNED, so an always-Err stub
// cannot satisfy the suite (each test names a DIFFERENT substring, and the
// success tests below require Ok).
// ===========================================================================

/// The monster id does not exist -> Err("monster not found"), never a panic.
///
/// kills: an impl that unwraps the `find` Option (a WASM trap, not a rejection);
///        an impl that returns Ok for a missing row.
#[test]
fn evolve_rejects_unknown_monster() {
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));

    let msg = evolve_seam(&mut db, owner_id(), 999, 2)
        .expect_err("a missing monster must reject, not succeed");
    assert!(
        msg.contains("monster not found"),
        "error must contain \"monster not found\"; got: {msg:?}"
    );
}

/// The caller is not the owner -> `require_owner`'s "not owner".
///
/// PROOF-OF-TEETH: the monster is fully QUALIFIED and the path exists, so the
/// only possible rejection is ownership — an impl that dropped `require_owner`
/// would return Ok here and this test fires.
///
/// kills: a missing/short-circuited ownership check (any caller could evolve any
///        monster).
#[test]
fn evolve_rejects_non_owner() {
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner_id());

    let msg = evolve_seam(&mut db, other_owner_id(), 1, 2)
        .expect_err("a non-owner must be rejected outright");
    assert!(
        msg.contains("not owner"),
        "error must contain require_owner's \"not owner\"; got: {msg:?}"
    );
    // The monster must be untouched by a rejected call.
    assert_eq!(
        db.get_monster(1).expect("monster still exists").species_id,
        1,
        "TEETH: a rejected evolve must not mutate the row"
    );
}

/// SIDE A: the owner is `player_identity` of an `Ongoing` battle holding this
/// monster -> "monster is in an ongoing battle".
///
/// kills: a missing `reject_if_in_battle` call (would return Ok — the monster is
///        otherwise fully qualified).
#[test]
fn evolve_rejects_when_owner_in_ongoing_battle_side_a() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner);
    db.insert_battle(make_side_a_battle(100, owner, vec![1]));

    let msg = evolve_seam(&mut db, owner, 1, 2)
        .expect_err("a monster in an ongoing battle must not be evolvable");
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {msg:?}"
    );
}

/// SIDE B: the owner is `opponent_identity` of an `Ongoing` PvP battle and the
/// monster sits in `opponent_monster_ids` -> still rejected (ADR-0122).
///
/// PROOF-OF-TEETH: the monster appears in NO `party_monster_ids` and the owner is
/// NOT any battle's `player_identity`, so a guard that filters only
/// `player_identity` (dropping the `.chain(opponent_identity)` leg) returns Ok
/// here and this test fires. That is the exact both-role gap ADR-0122 closed.
///
/// kills: a single-role battle guard on the evolve path.
#[test]
fn evolve_rejects_when_owner_in_ongoing_battle_side_b() {
    let owner = owner_id();
    let challenger = other_owner_id();
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner);
    db.insert_battle(make_side_b_battle(203, challenger, owner, vec![1]));

    let msg =
        evolve_seam(&mut db, owner, 1, 2).expect_err("a side-B PvP monster must not be evolvable");
    assert!(
        msg.contains("ongoing battle"),
        "error must mention \"ongoing battle\"; got: {msg:?}"
    );
}

/// NO FALSE POSITIVE (m17.5a, re-pinned for EG1): a COMPLETED side-B PvP battle
/// must NOT block an evolution — only `Ongoing` battles matter.
///
/// PROOF-OF-TEETH for the opposite failure mode: an over-broad guard that rejects
/// on the mere EXISTENCE of a battle row naming the owner (dropping the
/// `outcome == Ongoing` test) would reject here, permanently bricking evolution
/// for anyone who has ever finished a PvP battle. Without this test the two
/// battle-guard tests above could be satisfied by exactly that bug.
///
/// kills: a battle guard that ignores `BattleOutcome`.
#[test]
fn evolve_allows_when_side_b_pvp_battle_is_completed() {
    let owner = owner_id();
    let challenger = other_owner_id();
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner);

    let mut completed = make_side_b_battle(201, challenger, owner, vec![1]);
    completed.state.outcome = BattleOutcome::SideBWins;
    completed.state.turn_number = 5;
    db.insert_battle(completed);

    evolve_seam(&mut db, owner, 1, 2).expect(
        "a COMPLETED side-B PvP battle must not block evolution — only Ongoing \
         battles do; kills a guard that ignores BattleOutcome",
    );
    assert_eq!(
        db.get_monster(1).expect("monster survives").species_id,
        2,
        "the evolution must actually have been applied"
    );
}

/// The monster is escrowed in an ACTIVE trade offer -> "monster is in an active
/// trade" (TR-2, ADR-0106).
///
/// kills: a missing `reject_if_monster_in_trade` call — an escrowed monster could
///        be transformed mid-trade, so the counterparty would receive a different
///        species than the offer card showed.
#[test]
fn evolve_rejects_when_monster_in_trade_escrow() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner);
    db.insert_trade_offer(make_active_trade_offer(7, owner, 1));

    let msg =
        evolve_seam(&mut db, owner, 1, 2).expect_err("an escrowed monster must not be evolvable");
    assert!(
        msg.contains("active trade"),
        "error must mention \"active trade\"; got: {msg:?}"
    );
}

/// EG2-1: an EMPTY `evolution_path` table -> "no such evolution".
///
/// This is the normal, expected state for the whole EG1 -> EG3 window (evolution
/// is intentionally dark until content lands, ADR-0174 Consequences), so it must
/// be a clean rejection, never an error or a panic.
///
/// kills: an impl that treats "no row" as "no gate" and evolves anyway; an impl
///        that panics on the empty lookup.
#[test]
fn evolve_rejects_no_such_evolution_path() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    // NO evolution_path rows seeded — the pre-EG3 state.
    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let msg =
        evolve_seam(&mut db, owner, 1, 2).expect_err("no path row means no evolution is possible");
    assert!(
        msg.contains("no such evolution"),
        "error must contain \"no such evolution\"; got: {msg:?}"
    );
    assert_eq!(
        db.get_monster(1).expect("monster still exists").species_id,
        1,
        "TEETH: species must be unchanged after a no-path rejection"
    );
}

/// EG2-1 (client-supplied `to_species` cannot cross-apply): a path exists for
/// (from=5 -> to=2), but the caller's monster is species 1. The lookup is keyed
/// on BOTH endpoints, so this is the same "no such evolution" rejection.
///
/// PROOF-OF-TEETH: an impl that looks the row up by `to_species` alone (or that
/// filters the btree index on `from_species` but then forgets to compare
/// `to_species`, or vice-versa) finds this row and evolves a species-1 monster
/// through a species-5 edge — arbitrary species teleportation driven by a client
/// argument. This assertion is what stops that.
///
/// kills: a single-endpoint path lookup in either direction.
#[test]
fn evolve_rejects_wrong_from_species() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    // species 1 = the monster's own species; species 5 = the foreign edge's
    // from_species; species 2 = the edge's to_species.
    db.insert_species(source_species_row());
    db.insert_species(make_species_row(5, 60, 60, 0));
    db.insert_species(target_species_row());
    // The ONLY path is 5 -> 2. The monster below is species 1.
    db.insert_evolution_path(make_evolution_path_row(1, 100, 5, 2));

    // species_id = 1
    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let msg = evolve_seam(&mut db, owner, 1, 2)
        .expect_err("a foreign edge must not apply to this monster's species");
    assert!(
        msg.contains("no such evolution"),
        "error must contain \"no such evolution\"; got: {msg:?}"
    );
    assert_eq!(
        db.get_monster(1).expect("monster still exists").species_id,
        1,
        "TEETH: the monster must NOT be teleported to species 2 through a \
         species-5 edge — a to_species-only lookup would do exactly that"
    );
}

/// EG2-1: when the matched row's gates are not satisfied, the rejection NAMES the
/// specific failing requirement (not a generic "not eligible").
///
/// Fixture: an otherwise-qualified monster one level BELOW `min_level` 20.
///
/// kills: a bare `"not eligible to evolve"` message (the player cannot tell which
///        of five gates to work on); an impl that skips the gate entirely.
#[test]
fn evolve_rejects_names_the_failing_requirement() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));

    let mut m = make_qualified_monster_row(1, owner);
    m.level = 19; // the ONLY unmet gate
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let msg =
        evolve_seam(&mut db, owner, 1, 2).expect_err("an unmet level gate must reject the evolve");
    let lower = msg.to_lowercase();
    assert!(
        lower.contains("level"),
        "TEETH(EG2-1): the rejection must NAME the failing requirement — the level \
         gate is the only unmet one, so the message must mention \"level\"; got: {msg:?}"
    );
    assert!(
        lower.contains("20"),
        "the message should carry the required value (min_level 20) so the player \
         knows the target; got: {msg:?}"
    );
    assert_eq!(
        db.get_monster(1).expect("monster still exists").species_id,
        1,
        "a gate rejection must leave the monster untouched"
    );
}

/// A missing TARGET species row is a loud rejection, not a panic and not an
/// orphaned row pointing at a species that does not exist.
///
/// kills: `.unwrap()` on the fresh target-species lookup (EG1-8's tier source).
#[test]
fn evolve_rejects_when_target_species_row_missing() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    // Species 2 is NOT seeded, but a path 1 -> 2 exists (a diverged content state).
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));
    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let msg = evolve_seam(&mut db, owner, 1, 2)
        .expect_err("a missing target species must reject, not panic");
    assert!(
        msg.contains("species") && msg.contains("not found"),
        "error must mention the missing species; got: {msg:?}"
    );
}

// ===========================================================================
// EG2-1 success path — transform, essence reset, dual-write, fresh tier
// ===========================================================================

/// EG2-1 happy path: species changes on BOTH rows, all 8 essence pools zero on
/// BOTH rows, stats are re-derived from the TARGET species, and `current_hp` is
/// clamped to the new (lower) maximum.
///
/// The target species has base HP 20 against the source's 45, and the fixture
/// enters with `current_hp = stat_hp = 250`, so the clamp MUST fire.
///
/// kills: a monster-only write (the public projection silently keeps the old
///        species — the client would render the pre-evolution form forever);
///        an impl that carries the old `derived_stats` instead of re-deriving
///        from the target; a missing HP clamp (leaves current_hp > stat_hp, an
///        illegal row); an impl that forgets to write the zeroed essence columns
///        back (banked essence survives an evolution that is supposed to spend
///        it — including `essence_water`, a pool this edge never required).
#[test]
fn evolve_success_dual_writes_and_zeroes_essence() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    let before = seed_evolvable_world(&mut db, 1, owner);

    evolve_seam(&mut db, owner, 1, 2).expect("a fully qualified monster must evolve");

    let m = db.get_monster(1).expect("monster row must survive").clone();
    let p = db
        .get_monster_pub(1)
        .expect("monster_pub row must survive")
        .clone();

    assert_eq!(m.species_id, 2, "Monster.species_id must become the target");
    assert_eq!(
        p.species_id, 2,
        "TEETH(dual-write): MonsterPub.species_id must ALSO become the target; \
         kills an impl that updates `monster` and forgets `monster_pub`"
    );

    let private_essence = (
        m.essence_fire,
        m.essence_water,
        m.essence_plant,
        m.essence_electric,
        m.essence_earth,
        m.essence_wind,
        m.essence_light,
        m.essence_dark,
    );
    assert_eq!(
        private_essence,
        (0, 0, 0, 0, 0, 0, 0, 0),
        "TEETH(ADR-0174 D2): ALL 8 private essence columns must be zero after an \
         evolution — the fixture entered with essence_fire=150 (spent by the gate) \
         AND essence_water=7 (never required by this edge); both must be cleared"
    );
    let public_essence = (
        p.essence_fire,
        p.essence_water,
        p.essence_plant,
        p.essence_electric,
        p.essence_earth,
        p.essence_wind,
        p.essence_light,
        p.essence_dark,
    );
    assert_eq!(
        public_essence,
        (0, 0, 0, 0, 0, 0, 0, 0),
        "TEETH(dual-write): the PUBLIC essence columns must be zero too — the \
         requirements panel reads these, and a stale public copy would show the \
         player essence they no longer have"
    );

    // Stats re-derived from the TARGET species (base HP 20 vs the source's 45).
    assert_ne!(
        m.stat_hp, before.stat_hp,
        "TEETH: stat_hp must be RE-DERIVED from the target species' base stats; \
         kills an impl that carries the pre-evolution derived stats"
    );
    assert_eq!(
        p.stat_hp, m.stat_hp,
        "the public projection must carry the re-derived stats"
    );

    // current_hp clamped to the new (lower) maximum — never above it.
    assert_eq!(
        m.current_hp, m.stat_hp,
        "TEETH: entering at current_hp=250 with a much lower target max, \
         current_hp must be clamped DOWN to the new stat_hp; kills a missing clamp"
    );
    assert!(
        m.current_hp < before.current_hp,
        "the clamp must have actually lowered current_hp (250 -> {}), \
         otherwise this fixture is vacuous",
        m.current_hp
    );
    assert!(
        m.current_hp <= m.stat_hp,
        "current_hp ({}) must never exceed stat_hp ({})",
        m.current_hp,
        m.stat_hp
    );
}

/// EG1-8/EG2-1: `MonsterPub.tier` comes from a FRESH lookup of the TARGET species
/// row — never copied forward from the monster's existing public row.
///
/// Fixture: the pre-evolution `monster_pub` carries a deliberately stale
/// `tier = 9`; the target species row carries `tier = 1`.
///
/// PROOF-OF-TEETH: a copy-forward implementation writes 9 and this assertion
/// fires; a hardcoded/defaulted implementation writes 0 and it fires too. Only a
/// fresh `species_row(to_species).tier` read produces 1.
///
/// kills: copy-forward tier at the one call site that must NOT copy forward;
///        `unwrap_or(0)` tier fabrication (A3).
#[test]
fn evolve_success_sets_pub_tier_from_fresh_target_species_lookup() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row()); // tier 0
    db.insert_species(target_species_row()); // tier 1
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    // STALE public tier — nothing in the world justifies a 9.
    db.insert_monster_pub(make_monster_pub(&m, 9));

    evolve_seam(&mut db, owner, 1, 2).expect("a fully qualified monster must evolve");

    let p = db.get_monster_pub(1).expect("monster_pub must survive");
    assert_eq!(
        p.tier, 1,
        "TEETH(EG1-8): MonsterPub.tier must be the TARGET species' tier (1), read \
         fresh from species_row; a copy-forward impl writes the stale 9 and a \
         defaulted impl writes 0"
    );
}

/// EG2-1: Trust and Quality-Time are LIFETIME history — they survive an
/// evolution untouched, as do the server-only Quality-Time bookkeeping columns.
///
/// PROOF-OF-TEETH: an implementation that rebuilds the row through
/// `monster_from_instance` (which zeroes the server-only columns by design)
/// wipes `quality_time_accum_ms`/`window_ms`/`window_start_ms`/
/// `last_essence_train_at_ms`/`trust_favorable_battle_day_epoch` — each is
/// seeded with a distinct non-zero value here precisely so that wipe is visible.
/// Resetting `last_essence_train_at_ms` would also silently clear the essence
/// cooldown, letting a player chain-train immediately after an evolution.
///
/// kills: essence-style "spend" semantics applied to Trust/Quality-Time; a
///        row-rebuild write-back that drops the server-only columns.
#[test]
fn evolve_preserves_trust_and_quality_time_columns() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    let before = seed_evolvable_world(&mut db, 1, owner);

    evolve_seam(&mut db, owner, 1, 2).expect("a fully qualified monster must evolve");

    let m = db.get_monster(1).expect("monster row must survive");
    assert_eq!(
        m.trust_favorable_count, 30,
        "TEETH: trust_favorable_count is lifetime history and must survive (30)"
    );
    assert_eq!(
        m.trust_unfavorable_count, 2,
        "TEETH: trust_unfavorable_count must survive (2)"
    );
    assert_eq!(
        m.quality_time_ticks_total, 400,
        "TEETH: quality_time_ticks_total must survive (400)"
    );
    assert_eq!(
        m.trust_favorable_battle_day_epoch, before.trust_favorable_battle_day_epoch,
        "trust_favorable_battle_day_epoch (the once-per-24h credit anchor) must survive"
    );
    assert_eq!(
        m.quality_time_accum_ms, 777,
        "quality_time_accum_ms must survive an evolution"
    );
    assert_eq!(
        m.quality_time_window_ms, 888,
        "quality_time_window_ms must survive an evolution"
    );
    assert_eq!(
        m.quality_time_window_start_ms, 999,
        "quality_time_window_start_ms must survive an evolution"
    );
    assert_eq!(
        m.last_essence_train_at_ms, 1234,
        "TEETH: last_essence_train_at_ms must survive — resetting it would clear \
         the shared essence-training cooldown on every evolution"
    );

    // The public projection re-derives its two history tiers from the surviving
    // counters (Friendly from 30/2, tier 4 from 400 ticks).
    let p = db.get_monster_pub(1).expect("monster_pub must survive");
    assert_eq!(
        p.trust_tier,
        TrustTier::Friendly,
        "MonsterPub.trust_tier must still derive from the surviving counters"
    );
    assert_eq!(
        p.quality_time_tier, 4,
        "MonsterPub.quality_time_tier must still derive from the surviving ticks"
    );
}

// ===========================================================================
// EG2-1 message layer — `unmet_requirement` (the requirement-NAMING helper) must
// agree with the SSOT gate, `game_core::path_satisfied`.
//
// The gate DECISION belongs to `path_satisfied` (EG1-11); this helper exists
// only to turn a failure into a player-facing sentence. Keeping it a separate
// function is what lets the source-scan below forbid gate arithmetic inside the
// `evolve` reducer body itself.
// ===========================================================================

/// Marshal a row into the pure instance the gate predicates operate on.
fn instance_of(m: &Monster) -> game_core::MonsterInstance {
    crate::marshal::monster_to_instance(m).expect("fixture rows are always valid")
}

/// The pure path built from the canonical row fixture.
fn canonical_path() -> game_core::EvolutionPath {
    crate::marshal::evolution_path_from_row(&make_evolution_path_row(1, 100, 1, 2))
        .expect("the canonical path row marshals")
}

/// `unmet_requirement` returns `None` exactly when `path_satisfied` returns true.
///
/// PROOF-OF-TEETH: this is the anti-drift assertion. If the describer ever checks
/// a gate the predicate does not (or vice-versa) — e.g. it forgets Nutrition —
/// one of the six rows below disagrees and this fires. Six rows: one all-pass and
/// five single-gate failures.
///
/// kills: a describer that silently disagrees with the SSOT gate; a describer
///        that returns Some(..) unconditionally (row 0 fires) or None
///        unconditionally (rows 1-5 fire).
#[test]
fn unmet_requirement_agrees_with_path_satisfied() {
    let path = canonical_path();
    let owner = owner_id();

    let mut below_level = make_qualified_monster_row(1, owner);
    below_level.level = 19;
    let mut short_essence = make_qualified_monster_row(1, owner);
    short_essence.essence_fire = 99;
    let mut low_trust = make_qualified_monster_row(1, owner);
    low_trust.trust_favorable_count = 0;
    low_trust.trust_unfavorable_count = 0;
    let mut low_quality_time = make_qualified_monster_row(1, owner);
    low_quality_time.quality_time_ticks_total = 9;
    let mut low_nutrition = make_qualified_monster_row(1, owner);
    low_nutrition.ev_hp = 0;
    low_nutrition.ev_attack = 0;

    let cases: [(&str, Monster); 6] = [
        ("all gates satisfied", make_qualified_monster_row(1, owner)),
        ("level 19 < min_level 20", below_level),
        ("essence_fire 99 < Fire 100", short_essence),
        ("trust Neutral < Friendly", low_trust),
        ("quality-time tier 0 < 2", low_quality_time),
        ("nutrition 0% < 50%", low_nutrition),
    ];

    for (label, row) in cases {
        let inst = instance_of(&row);
        let satisfied = game_core::path_satisfied(&inst, &path);
        let described = super::unmet_requirement(&inst, &path);
        assert_eq!(
            described.is_none(),
            satisfied,
            "TEETH(anti-drift, {label}): unmet_requirement must return None EXACTLY \
             when game_core::path_satisfied returns true; got satisfied={satisfied}, \
             message={described:?}"
        );
    }
}

/// Each unmet gate is named by its own vocabulary, so a player can tell the five
/// gates apart.
///
/// kills: a describer that always reports the same gate (e.g. always "level");
///        one that reports a gate the monster actually clears.
#[test]
fn unmet_requirement_names_each_gate() {
    let path = canonical_path();
    let owner = owner_id();

    let mut below_level = make_qualified_monster_row(1, owner);
    below_level.level = 19;
    let msg = super::unmet_requirement(&instance_of(&below_level), &path)
        .expect("an unmet level gate must be described");
    assert!(
        msg.to_lowercase().contains("level"),
        "the level gate must be named \"level\"; got: {msg:?}"
    );

    let mut short_essence = make_qualified_monster_row(1, owner);
    short_essence.essence_fire = 99;
    let msg = super::unmet_requirement(&instance_of(&short_essence), &path)
        .expect("an unmet essence gate must be described");
    let lower = msg.to_lowercase();
    assert!(
        lower.contains("essence"),
        "the essence gate must be named \"essence\"; got: {msg:?}"
    );
    assert!(
        lower.contains("fire"),
        "TEETH: the essence gate must name the AFFINITY that is short (Fire) — a \
         message that only says \"essence\" cannot tell a player which of up to \
         three pools to grow; got: {msg:?}"
    );

    let mut low_trust = make_qualified_monster_row(1, owner);
    low_trust.trust_favorable_count = 0;
    low_trust.trust_unfavorable_count = 0;
    let msg = super::unmet_requirement(&instance_of(&low_trust), &path)
        .expect("an unmet trust gate must be described");
    assert!(
        msg.to_lowercase().contains("trust"),
        "the Trust gate must be named \"trust\"; got: {msg:?}"
    );

    let mut low_quality_time = make_qualified_monster_row(1, owner);
    low_quality_time.quality_time_ticks_total = 9;
    let msg = super::unmet_requirement(&instance_of(&low_quality_time), &path)
        .expect("an unmet quality-time gate must be described");
    assert!(
        msg.to_lowercase().contains("quality"),
        "the Quality-Time gate must be named \"quality\"; got: {msg:?}"
    );

    let mut low_nutrition = make_qualified_monster_row(1, owner);
    low_nutrition.ev_hp = 0;
    low_nutrition.ev_attack = 0;
    let msg = super::unmet_requirement(&instance_of(&low_nutrition), &path)
        .expect("an unmet nutrition gate must be described");
    assert!(
        msg.to_lowercase().contains("nutrition"),
        "the Nutrition gate must be named \"nutrition\"; got: {msg:?}"
    );
}

// ===========================================================================
// EG1-11 SOURCE SCAN — the `evolve` reducer must SHARE `path_satisfied`, not
// re-implement the gates.
//
// Scanned file: server-module/src/evolution.rs (NOT this test file).
// ===========================================================================

const EVOLUTION_RS_SOURCE: &str = include_str!("evolution.rs");
const BATTLE_RS_SOURCE: &str = include_str!("battle.rs");
const CONTENT_RS_SOURCE: &str = include_str!("content.rs");
const MONSTER_MGMT_RS_SOURCE: &str = include_str!("monster_mgmt.rs");
const MOVEMENT_RS_SOURCE: &str = include_str!("movement.rs");
const PVP_RS_SOURCE: &str = include_str!("pvp.rs");
const RAISING_RS_SOURCE: &str = include_str!("raising.rs");
const TAMING_RS_SOURCE: &str = include_str!("taming.rs");
const TRADING_RS_SOURCE: &str = include_str!("trading.rs");

/// Strip Rust block and line comments (mirrors the helper in content_tests.rs /
/// battle_tests.rs). Byte-walking, so it cannot mis-handle a doc comment that
/// happens to contain a needle.
fn strip_rust_comments(src: &str) -> String {
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

/// Extract the body of the function whose declaration starts at `decl_needle`,
/// by walking braces from the first `{` after the declaration.
fn extract_fn_body(stripped: &str, decl_needle: &str) -> String {
    let decl_pos = stripped
        .find(decl_needle)
        .unwrap_or_else(|| panic!("declaration {decl_needle:?} must exist in the scanned source"));
    let after = &stripped[decl_pos..];
    let brace_offset = after
        .find('{')
        .expect("the scanned function must have a body");
    let body_start = decl_pos + brace_offset + 1;

    let mut depth: usize = 1;
    let mut byte_off = 0usize;
    for ch in stripped[body_start..].chars() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                break;
            }
        }
        byte_off += ch.len_utf8();
    }
    stripped[body_start..body_start + byte_off].to_string()
}

/// EG1-11 (positive): the `evolve` reducer body must call the SHARED predicate.
///
/// kills: an `evolve` that decides eligibility with its own inline comparisons,
///        which is exactly how the read path (`eligible_evolution_paths`, powering
///        the client requirements panel) and the write path silently drift apart.
#[test]
fn eg1_11_evolve_body_delegates_to_path_satisfied() {
    let stripped = strip_rust_comments(EVOLUTION_RS_SOURCE);
    let body = extract_fn_body(&stripped, "pub fn evolve(ctx");

    assert!(
        body.contains("path_satisfied("),
        "TEETH(EG1-11): the `evolve` reducer body must call `path_satisfied(...)` — \
         ONE shared gate predicate for both the read path \
         (eligible_evolution_paths) and this write path, so they cannot drift"
    );
}

/// EG1-11 (negative): the `evolve` reducer body must NOT contain gate arithmetic
/// of its own.
///
/// Each banned needle is a field or helper that ONLY a re-implemented gate (or a
/// re-implemented requirement description) touches:
///   * `min_level` / `min_trust_tier` / `min_quality_time_tier` /
///     `min_nutrition_pct` — the `EvolutionPath` gate fields,
///   * `.amount` — the `EssenceRequirement` threshold,
///   * `trust_tier_of(` / `quality_time_tier_of(` / `nutrition_pct_of(` /
///     `nutrition_pct_from_ev_total(` — the three tier derivations,
///   * `eligible_evolution_paths(` — the FULL-SET query, which EG2-1 explicitly
///     forbids on this path (the targeted, indexed lookup is the point).
///
/// NOTE FOR THE IMPLEMENTER: naming the failing requirement is still required
/// (EG2-1) — put that logic in the separate `unmet_requirement` helper (tested
/// above), which lives OUTSIDE this function body. The write-back of the
/// transformed instance (`transformed.essence[...]` into the eight columns) is
/// deliberately NOT banned; only gate/threshold reads are.
///
/// kills: a hand-rolled `path.min_level <= level && ...` chain inside `evolve`;
///        a body that computes the three tiers itself; a full-set eligibility
///        query where a targeted lookup is required.
#[test]
fn eg1_11_evolve_body_has_no_inlined_gate_logic() {
    let stripped = strip_rust_comments(EVOLUTION_RS_SOURCE);
    let body = extract_fn_body(&stripped, "pub fn evolve(ctx");

    let banned = [
        "min_level",
        "min_trust_tier",
        "min_quality_time_tier",
        "min_nutrition_pct",
        ".amount",
        "trust_tier_of(",
        "quality_time_tier_of(",
        "nutrition_pct_of(",
        "nutrition_pct_from_ev_total(",
        "eligible_evolution_paths(",
    ];
    for needle in banned {
        assert!(
            !body.contains(needle),
            "TEETH(EG1-11): the `evolve` reducer body contains {needle:?} — that is \
             gate logic re-implemented next to `path_satisfied` instead of \
             delegated to it. The gate DECISION belongs to \
             `game_core::path_satisfied`; requirement NAMING belongs to the \
             separate `unmet_requirement` helper. Move it out of this fn body."
        );
    }
}

/// EG1-9: the fusion machinery and `compute_evolves_to` are DELETED from
/// `evolution.rs`, not left behind unused.
///
/// kills: a "delete later" rewrite that leaves the `fuse` reducer registered (it
///        would still be callable over the wire) or keeps `compute_evolves_to`
///        alive against a content model that no longer exists.
#[test]
fn eg1_9_evolution_rs_has_no_fusion_or_compute_evolves_to_leftovers() {
    let stripped = strip_rust_comments(EVOLUTION_RS_SOURCE);

    let banned = [
        "pub fn fuse(",
        "fn reject_if_not_fusable",
        "fn find_fusion_recipe",
        "fn compute_evolves_to",
    ];
    for needle in banned {
        assert!(
            !stripped.contains(needle),
            "TEETH(EG1-9): evolution.rs still declares {needle:?} — fusion and the \
             passive evolves_to derivation are deleted outright in EG1, not \
             repurposed (the Fusion TABLE struct stays in schema.rs until \
             Migration B, but no code may reference this)"
        );
    }
}

// ===========================================================================
// A3 SOURCE SCAN — no `pub_from_monster` call site may FABRICATE a tier.
//
// ADR-0174 D7 / plan amendment A3: the 9 copy-forward sites take the tier from
// the existing `monster_pub` row; a MISSING row is fail-loud (or the site's own
// missing-row convention) — NEVER `unwrap_or(0)` and never a literal 0. A
// fabricated tier 0 would silently demote an evolved monster to a base form in
// every client that reads the public projection.
//
// (Deliberately NOT a call-site COUNT pin — amendment A11: the compiler and the
// monster-dual-write eval already cover the site set. This scans the shape of
// each site's tier argument only.)
// ===========================================================================

/// One violation string per `pub_from_monster(..)` call whose tier argument is
/// fabricated (a literal `0`, an `unwrap_or(0)`, or an `unwrap_or_default()`), or
/// which passes no tier at all. `[]` = clean.
fn fabricated_tier_violations(file: &str, src: &str) -> Vec<String> {
    let stripped = strip_rust_comments(src);
    let needle = "pub_from_monster(";
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(idx) = stripped[pos..].find(needle) {
        let open = pos + idx + needle.len();
        // Walk to the matching close paren.
        let mut depth: usize = 1;
        let mut end = open;
        for (off, ch) in stripped[open..].char_indices() {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    end = open + off;
                    break;
                }
            }
        }
        let args_src = &stripped[open..end];
        // Split on TOP-LEVEL commas only.
        let mut args: Vec<String> = Vec::new();
        let mut depth2: usize = 0;
        let mut current = String::new();
        for ch in args_src.chars() {
            match ch {
                '(' | '[' | '<' => {
                    depth2 += 1;
                    current.push(ch);
                }
                ')' | ']' | '>' => {
                    depth2 = depth2.saturating_sub(1);
                    current.push(ch);
                }
                ',' if depth2 == 0 => {
                    args.push(current.trim().to_string());
                    current = String::new();
                }
                _ => current.push(ch),
            }
        }
        if !current.trim().is_empty() {
            args.push(current.trim().to_string());
        }

        if args.len() < 2 {
            out.push(format!(
                "{file}: pub_from_monster({args_src}) passes no tier argument \
                 (EG1-8 signature is pub_from_monster(&Monster, tier: u8))"
            ));
        } else {
            let tier_arg = args[1].clone();
            let flat: String = tier_arg.split_whitespace().collect();
            if flat == "0" || flat.contains("unwrap_or(0)") || flat.contains("unwrap_or_default()")
            {
                out.push(format!(
                    "{file}: pub_from_monster(.., {tier_arg}) FABRICATES a tier — A3 \
                     forbids a literal 0 / unwrap_or(0) / unwrap_or_default() tier; a \
                     missing monster_pub row must fail loud instead"
                ));
            }
        }
        pos = end.max(open);
    }
    out
}

/// PROOF-OF-TEETH for `fabricated_tier_violations`: the checker must bite on each
/// fabrication shape and stay silent on the legitimate ones.
///
/// kills: a checker that only looks for the literal `0` (misses `unwrap_or(0)`),
///        one that flags every call (the two clean fixtures fire), and one that
///        cannot handle a rustfmt-wrapped multi-line call.
#[test]
fn a3_fabricated_tier_checker_has_teeth() {
    // Bad 1: literal zero tier.
    let bad_literal = "    let pub_row = pub_from_monster(&m, 0);\n";
    assert!(
        !fabricated_tier_violations("fixture", bad_literal).is_empty(),
        "TEETH: a literal 0 tier must be flagged"
    );

    // Bad 2: fabricated fallback when the monster_pub row is missing.
    let bad_unwrap =
        "    let pub_row = pub_from_monster(&m, existing.map(|p| p.tier).unwrap_or(0));\n";
    assert!(
        !fabricated_tier_violations("fixture", bad_unwrap).is_empty(),
        "TEETH: an unwrap_or(0) tier fallback must be flagged — this is the exact \
         A3 shape that silently demotes an evolved monster to a base form"
    );

    // Bad 3: un-migrated single-argument call.
    let bad_arity = "    let pub_row = pub_from_monster(&m);\n";
    assert!(
        !fabricated_tier_violations("fixture", bad_arity).is_empty(),
        "TEETH: a call with no tier argument must be flagged"
    );

    // Good 1: fresh species-row tier.
    let good_fresh = "    let pub_row = pub_from_monster(&m, to_species_row.tier);\n";
    assert!(
        fabricated_tier_violations("fixture", good_fresh).is_empty(),
        "a fresh species-row tier must NOT be flagged"
    );

    // Good 2: copy-forward from an existing public row, rustfmt-wrapped.
    let good_copy_forward =
        "    let pub_row = pub_from_monster(\n        &m,\n        existing_pub.tier,\n    );\n";
    assert!(
        fabricated_tier_violations("fixture", good_copy_forward).is_empty(),
        "a multi-line copy-forward tier must NOT be flagged (the checker must \
         tolerate rustfmt wrapping)"
    );

    // Good 3: a fail-loud missing-row convention (no fabrication at all).
    let good_fail_loud = "    let Some(existing) = ctx.db.monster_pub().monster_id().find(id) else {\n        return Err(\"monster_pub row missing\".to_string());\n    };\n    let pub_row = pub_from_monster(&m, existing.tier);\n";
    assert!(
        fabricated_tier_violations("fixture", good_fail_loud).is_empty(),
        "the fail-loud shape must NOT be flagged"
    );
}

/// A3 (real files): no production `pub_from_monster` call site fabricates a tier.
///
/// kills: any of the 9 copy-forward sites papering over a missing `monster_pub`
///        row with a default tier instead of failing loud.
#[test]
fn a3_no_call_site_fabricates_a_tier() {
    let files: [(&str, &str); 9] = [
        ("evolution.rs", EVOLUTION_RS_SOURCE),
        ("battle.rs", BATTLE_RS_SOURCE),
        ("content.rs", CONTENT_RS_SOURCE),
        ("monster_mgmt.rs", MONSTER_MGMT_RS_SOURCE),
        ("movement.rs", MOVEMENT_RS_SOURCE),
        ("pvp.rs", PVP_RS_SOURCE),
        ("raising.rs", RAISING_RS_SOURCE),
        ("taming.rs", TAMING_RS_SOURCE),
        ("trading.rs", TRADING_RS_SOURCE),
    ];

    let mut violations: Vec<String> = Vec::new();
    let mut sites = 0usize;
    for (name, src) in files {
        sites += strip_rust_comments(src)
            .matches("pub_from_monster(")
            .count();
        violations.extend(fabricated_tier_violations(name, src));
    }

    // Vacuity guard (NOT a count pin — A11): if the scan finds no call sites at
    // all, the parser has rotted and a clean result would be meaningless.
    assert!(
        sites > 0,
        "vacuity guard: zero pub_from_monster call sites discovered across the 9 \
         production files — the scanner has rotted"
    );
    assert!(
        violations.is_empty(),
        "TEETH(A3): {} call site(s) fabricate a MonsterPub tier:\n{}",
        violations.len(),
        violations.join("\n")
    );
}

// ---------------------------------------------------------------------------
// Test seam — `evolve_seam` lives HERE (not in evolution.rs) so the
// no-idle-accrual eval, which excludes _tests.rs files from its growth-field
// scan, does not flag it. It is test infrastructure, not production code.
//
// It mirrors the `evolve` reducer step for step, calling the REAL production
// guards, marshaling helpers, gate predicate, and requirement describer; only
// the `ctx.db` accessors are replaced by `TestEvolutionDb`. The production
// reducer's own delegation is pinned by the EG1-11 source scan above.
// ---------------------------------------------------------------------------

/// Pure evolve seam: mirrors the `evolve(ctx, monster_id, to_species)` reducer
/// against a `TestEvolutionDb`.
pub(crate) fn evolve_seam(
    db: &mut TestEvolutionDb,
    sender: Identity,
    monster_id: u64,
    to_species: u32,
) -> Result<(), String> {
    let Some(mut m) = db.get_monster(monster_id).cloned() else {
        return Err("monster not found".to_string());
    };

    // Ownership (mirrors crate::guards::require_owner's message exactly).
    if m.owner_identity != sender {
        return Err("not owner".to_string());
    }

    // Both-role battle guard (ADR-0122): chain the opponent_identity iterator so a
    // monster whose owner sits on side B of an ongoing PvP battle is caught.
    crate::guards::reject_if_in_battle(
        db.get_battles()
            .filter(|b| b.player_identity == sender)
            .chain(db.get_battles().filter(|b| b.opponent_identity == sender)),
        monster_id,
    )?;

    // Trade escrow guard (TR-2, ADR-0106) — both roles, same chain shape.
    crate::guards::reject_if_monster_in_trade(
        db.get_trade_offers()
            .filter(|t| t.initiator == sender)
            .chain(db.get_trade_offers().filter(|t| t.counterparty == sender)),
        monster_id,
    )?;

    // EG2-1: ONE targeted row, keyed on BOTH endpoints (production reads the
    // from_species btree index and compares to_species).
    let path = match db.find_evolution_path(m.species_id, to_species) {
        Some(row) => crate::marshal::evolution_path_from_row(row)?,
        None => {
            return Err(format!(
                "no such evolution: species {} has no path to species {to_species}",
                m.species_id
            ))
        }
    };

    let instance = crate::marshal::monster_to_instance(&m)?;

    // The SHARED gate predicate (EG1-11) makes the decision; the describer only
    // turns a failure into a sentence.
    if !game_core::path_satisfied(&instance, &path) {
        return Err(super::unmet_requirement(&instance, &path)
            .unwrap_or_else(|| "evolution requirements not met".to_string()));
    }

    // FRESH target-species lookup — the tier source (EG1-8) and the transform's
    // base stats both come from it.
    let Some(to_species_row) = db.get_species(to_species).cloned() else {
        return Err(format!("target species {to_species} not found"));
    };
    let target = crate::marshal::species_from_row(&to_species_row)?;

    // Pure transform: carries individuality, re-derives stats, clamps HP, and
    // zeroes all 8 essence pools (ADR-0174 D2).
    let transformed = game_core::evolve(&instance, &target);

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
    m.essence_fire = transformed.essence[Affinity::Fire.index()];
    m.essence_water = transformed.essence[Affinity::Water.index()];
    m.essence_plant = transformed.essence[Affinity::Plant.index()];
    m.essence_electric = transformed.essence[Affinity::Electric.index()];
    m.essence_earth = transformed.essence[Affinity::Earth.index()];
    m.essence_wind = transformed.essence[Affinity::Wind.index()];
    m.essence_light = transformed.essence[Affinity::Light.index()];
    m.essence_dark = transformed.essence[Affinity::Dark.index()];
    // Trust and Quality-Time are lifetime history — untouched on purpose.

    // Dual-write, with the tier from the FRESH target species row.
    let pub_row = crate::marshal::pub_from_monster(&m, to_species_row.tier);
    db.update_monster(m);
    db.update_monster_pub(pub_row);

    Ok(())
}

// ---------------------------------------------------------------------------
// TestEvolutionDb — in-memory fake standing in for the `ctx.db` accessors the
// `evolve` reducer uses. The `fusions` / `evolutions` maps are DELETED; an
// `evolution_paths` list and a `trade_offers` list take their place.
// ---------------------------------------------------------------------------

/// In-memory fake DB for the evolve seam tests. All fields are public for
/// inspection.
pub struct TestEvolutionDb {
    pub monsters: std::collections::HashMap<u64, Monster>,
    pub monster_pubs: std::collections::HashMap<u64, MonsterPub>,
    pub species: std::collections::HashMap<u32, SpeciesRow>,
    pub evolution_paths: Vec<EvolutionPathRow>,
    pub battles: Vec<Battle>,
    pub trade_offers: Vec<TradeOffer>,
    /// Auto-increment counter for new monster ids.
    next_monster_id: u64,
}

impl TestEvolutionDb {
    pub fn new() -> Self {
        Self {
            monsters: Default::default(),
            monster_pubs: Default::default(),
            species: Default::default(),
            evolution_paths: vec![],
            battles: vec![],
            trade_offers: vec![],
            next_monster_id: 100,
        }
    }

    /// Insert a Monster row. `monster_id == 0` gets an auto-assigned id
    /// (mirroring SpacetimeDB's auto_inc behaviour in production).
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

    pub fn insert_evolution_path(&mut self, p: EvolutionPathRow) {
        self.evolution_paths.push(p);
    }

    pub fn insert_battle(&mut self, b: Battle) {
        self.battles.push(b);
    }

    pub fn insert_trade_offer(&mut self, t: TradeOffer) {
        self.trade_offers.push(t);
    }

    pub fn get_monster(&self, id: u64) -> Option<&Monster> {
        self.monsters.get(&id)
    }

    pub fn get_monster_pub(&self, id: u64) -> Option<&MonsterPub> {
        self.monster_pubs.get(&id)
    }

    pub fn alloc_monster_id(&mut self) -> u64 {
        let id = self.next_monster_id;
        self.next_monster_id += 1;
        id
    }

    pub fn get_species(&self, id: u32) -> Option<&SpeciesRow> {
        self.species.get(&id)
    }

    pub fn get_battles(&self) -> impl Iterator<Item = &Battle> {
        self.battles.iter()
    }

    pub fn get_trade_offers(&self) -> impl Iterator<Item = &TradeOffer> {
        self.trade_offers.iter()
    }

    /// The targeted lookup: the ONE row matching BOTH endpoints (R1 guarantees
    /// at most one). Mirrors the production `from_species` btree filter followed
    /// by a `to_species` comparison.
    pub fn find_evolution_path(&self, from: u32, to: u32) -> Option<&EvolutionPathRow> {
        self.evolution_paths
            .iter()
            .find(|p| p.from_species == from && p.to_species == to)
    }

    pub fn update_monster(&mut self, m: Monster) {
        self.monsters.insert(m.monster_id, m);
    }

    pub fn update_monster_pub(&mut self, p: MonsterPub) {
        self.monster_pubs.insert(p.monster_id, p);
    }
}
