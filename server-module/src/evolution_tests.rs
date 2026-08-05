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
//! `game_core::path_satisfied`, `game_core::unmet_requirement`). The production
//! reducer's own delegation is pinned separately by the EG1-11 source-scan at
//! the bottom of this file.
//!
//! WHAT EG2 ADDS (ADR-0175 D3, spec EG2-1/9/11/12/13):
//!   - `apply_evolution_seam` — the transform-and-write half of `evolve_seam`,
//!     factored out exactly the way production factors `apply_evolution` out of
//!     `evolve()`, so BOTH seam paths apply an evolution through one code path.
//!   - `check_and_evolve_seam` — the auto-evolution driver: fresh monster read,
//!     DB `evolution_path` rows for the CURRENT species, the REAL
//!     `game_core::eligible_evolution_paths`, 0/2+ eligible are no-ops, exactly
//!     one applies, then the bounded chain loop re-checks against the NEW
//!     species. It takes its cap from the production constant
//!     `crate::evolution::MAX_EVOLUTION_CHAIN_STEPS`, so the seam can never
//!     drift from the reducer's own termination bound.
//!   - Source scans for the shapes a seam cannot observe: `evolve()` delegating
//!     (EG2-1), one transform path (EG2-11), no battle/trade guard on the
//!     auto-evolution path (EG2-12 Guard warning), DB rows not the RON cache,
//!     the explicit iteration cap (EG2-13), and the EG2-9 hard invariant that no
//!     SCHEDULED reducer body directly calls `accrue_quality_time`/
//!     `check_and_evolve`.
//!
//! Each test carries a `// kills:` note stating which wrong implementation it
//! catches.

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrors the m7b_test_monster_row pattern in
// marshal_tests.rs).
//
// NOTE: deliberately NO `use super::*;` — every production symbol is reached by
// an explicit path (`crate::guards::*`, `crate::marshal::*`, `game_core::*`), so
// this file cannot silently pick up whatever `evolution.rs` happens to import.
// Nothing here reaches into `super` at all: the seam's gate decision and its
// rejection message both come from game-core.
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

/// An `evolution_path` row gated ONLY on `min_level`.
///
/// The chain fixtures (EG2-13) need gates that SURVIVE an evolution: all 8
/// essence pools zero on every step (ADR-0174 D2), so an essence-gated second
/// step could never fire, while level / Trust / Quality-Time are lifetime state
/// and persist.
fn make_level_only_path_row(
    path_id: u64,
    edge_id: u32,
    from: u32,
    to: u32,
    min_level: u8,
) -> EvolutionPathRow {
    EvolutionPathRow {
        path_id,
        edge_id,
        from_species: from,
        to_species: to,
        min_level,
        essence: vec![],
        min_trust_tier: None,
        min_quality_time_tier: None,
        min_nutrition_pct: None,
    }
}

/// Field-by-field copy of an `evolution_path` row.
///
/// `EvolutionPathRow` deliberately does NOT derive `Clone` in schema.rs (unlike
/// `Monster`/`SpeciesRow`), and production never needs one: SpacetimeDB's table
/// iterators yield OWNED rows, so `check_and_evolve`'s
/// `from_species().filter(..).collect()` gets owned values for free. The seam
/// reads from an in-memory map instead, so it needs this one explicit copy —
/// test infrastructure only, and NOT a request to widen the schema derive.
fn copy_path_row(p: &EvolutionPathRow) -> EvolutionPathRow {
    EvolutionPathRow {
        path_id: p.path_id,
        edge_id: p.edge_id,
        from_species: p.from_species,
        to_species: p.to_species,
        min_level: p.min_level,
        essence: p.essence.clone(),
        min_trust_tier: p.min_trust_tier,
        min_quality_time_tier: p.min_quality_time_tier,
        min_nutrition_pct: p.min_nutrition_pct,
    }
}

/// An `evolution_path` row gated on `min_level` AND a Trust tier — Trust is
/// lifetime history (EG2-1) and survives an evolution, so it is a legitimate
/// mid-chain gate and proves the chain re-checks against surviving state.
fn make_level_and_trust_path_row(
    path_id: u64,
    edge_id: u32,
    from: u32,
    to: u32,
    min_level: u8,
    min_trust_tier: TrustTier,
) -> EvolutionPathRow {
    EvolutionPathRow {
        min_trust_tier: Some(min_trust_tier),
        ..make_level_only_path_row(path_id, edge_id, from, to, min_level)
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
// EG2-11/12/13 — `check_and_evolve` / `apply_evolution` behaviour.
//
// These drive `check_and_evolve_seam` / `apply_evolution_seam` (bottom of this
// file), which mirror the production helpers step for step against
// `TestEvolutionDb` while calling the REAL `game_core::eligible_evolution_paths`
// and the REAL marshaling helpers. The seam returns the number of chain steps it
// applied — production returns `()`, but the step count is the only way a test
// can distinguish "cascaded once" from "cascaded three times" from "spun to the
// cap", which is exactly what EG2-13 legislates.
// ===========================================================================

/// EG2-11: ZERO eligible paths -> a silent no-op. This is the normal state for
/// the whole EG1 -> EG3 window (no `evolution_path` content exists yet), so it
/// must never error, panic, or touch the row.
///
/// kills: an impl that treats an empty candidate set as "evolve along whatever
///        row it can find"; an impl that writes the monster row back unchanged
///        anyway (public-row churn on the movement hot path, ADR-0175 D1); an
///        impl that returns/propagates an error from a no-op check.
#[test]
fn check_and_evolve_zero_eligible_is_noop() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    // NO evolution_path rows at all.
    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(
        steps, 0,
        "no eligible path means no evolution step is applied"
    );
    let after = db.get_monster(1).expect("monster row must survive");
    assert_eq!(after.species_id, 1, "TEETH: the species must be unchanged");
    assert_eq!(
        after.essence_fire, 150,
        "TEETH: a no-op must not spend essence — the pools are only zeroed by an \
         evolution that actually happened"
    );
    assert_eq!(
        db.get_monster_pub(1)
            .expect("monster_pub must survive")
            .species_id,
        1,
        "the public projection must be unchanged too"
    );
}

/// EG2-11: EXACTLY ONE eligible path -> applied immediately, same transaction,
/// no player action. The full transform contract rides along: species on both
/// rows, all 8 essence pools zeroed, Trust/Quality-Time preserved, and
/// `MonsterPub.tier` from the TARGET species row.
///
/// kills: an impl that only computes eligibility and leaves the write to some
///        later player-invoked `evolve()` (EG2-1 says the single-path case never
///        reaches that reducer); an impl that applies the transform without the
///        dual-write; an impl that copies the tier forward from the stale public
///        row instead of the fresh target species.
#[test]
fn check_and_evolve_exactly_one_applies_same_transaction() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner);

    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(
        steps, 1,
        "exactly one eligible path must apply exactly one step"
    );
    let m = db.get_monster(1).expect("monster row must survive").clone();
    let p = db
        .get_monster_pub(1)
        .expect("monster_pub must survive")
        .clone();
    assert_eq!(m.species_id, 2, "the single eligible path must be applied");
    assert_eq!(
        p.species_id, 2,
        "TEETH(dual-write): the public projection must follow the private row"
    );
    assert_eq!(
        (
            m.essence_fire,
            m.essence_water,
            m.essence_plant,
            m.essence_electric,
            m.essence_earth,
            m.essence_wind,
            m.essence_light,
            m.essence_dark,
        ),
        (0, 0, 0, 0, 0, 0, 0, 0),
        "TEETH: an auto-evolution spends essence exactly like the player-invoked \
         one — the shared apply_evolution helper is the ONE transform path"
    );
    assert_eq!(
        m.trust_favorable_count, 30,
        "Trust is lifetime history and survives the auto-evolution"
    );
    assert_eq!(
        m.quality_time_ticks_total, 400,
        "Quality-Time is lifetime history and survives the auto-evolution"
    );
    assert_eq!(
        p.tier, 1,
        "TEETH(EG1-8): MonsterPub.tier must come from a FRESH lookup of the \
         TARGET species row (tier 1), not copied forward from the stale public row"
    );
}

/// EG2-11 (server-side dual of EG2-2): TWO simultaneously eligible paths -> a
/// no-op. The choice belongs to the player (EG4-2), and the server SHALL NOT
/// pick a first-match winner — the Tamagotchi/Wurmple "silent race" anti-pattern.
///
/// The pure half of this invariant is pinned in game-core at
/// `game-core/src/evolution/m10a_gating_tests.rs:880`
/// (`eligible_evolution_paths_returns_every_satisfied_path` — two paths from
/// species 1 return `vec![0, 1]`, BOTH indices). This test pins the SERVER's
/// reaction to that set: a length-2 result must stop, not index into it.
///
/// kills: `if let Some(idx) = eligible.first()` / `.find()` / `.position()` —
///        every "just take the first one" shape, which would silently railroad
///        the player past a genuine branch point; also an impl that checks
///        `>= 1` instead of `== 1`.
#[test]
fn check_and_evolve_two_eligible_is_noop() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_species(make_species_row(3, 40, 60, 1));
    // BOTH satisfied, BOTH out of species 1 — the genuine-ambiguity case.
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));
    db.insert_evolution_path(make_level_only_path_row(2, 101, 1, 3, 20));

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(steps, 0, "a 2-eligible monster must not auto-evolve at all");
    let after = db.get_monster(1).expect("monster row must survive");
    assert_eq!(
        after.species_id, 1,
        "TEETH(EG2-2/EG2-11): with TWO eligible paths the monster must stay at \
         its current species until the player picks — never a first-match winner"
    );
    assert_eq!(
        after.essence_fire, 150,
        "TEETH: an ambiguous state must not spend the essence either"
    );
}

/// EG2-11: candidate rows that are NOT satisfied do not count toward the
/// 0/1/2+ decision — only the ELIGIBLE set does, and the applied edge is the one
/// the eligible INDEX addresses.
///
/// Fixture ordering is load-bearing: the UNSATISFIED path (1 -> 3, `min_level`
/// 99) is inserted FIRST, so `eligible_evolution_paths` returns `[1]`, not `[0]`.
///
/// kills: an impl that counts candidate ROWS instead of eligible ones (would see
///        2 and bail — auto-evolution silently dead for any species with a
///        higher-level second branch); an impl that ignores the returned index
///        and applies `rows[0]` / `rows.first()` (the monster would be dragged
///        through an edge whose gates it does not meet, landing on species 3).
#[test]
fn check_and_evolve_ignores_unsatisfied_paths() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_species(make_species_row(3, 40, 60, 1));
    // Index 0: NOT satisfied (level 99). Index 1: satisfied.
    db.insert_evolution_path(make_level_only_path_row(1, 100, 1, 3, 99));
    db.insert_evolution_path(make_level_only_path_row(2, 101, 1, 2, 20));

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(
        steps, 1,
        "exactly one of the two candidate rows is eligible"
    );
    assert_eq!(
        db.get_monster(1)
            .expect("monster row must survive")
            .species_id,
        2,
        "TEETH: the SATISFIED edge (1 -> 2, index 1 of the candidate slice) must \
         be the one applied — an impl that applies rows[0] lands on species 3, \
         through a level-99 gate this level-20 monster does not meet"
    );
}

/// EG2-12 Guard warning: `check_and_evolve`/`apply_evolution` are NEVER
/// battle-guarded. At the `write_back_battle_results` call site the battle row is
/// still `Ongoing` (battle.rs's own documented ordering invariant), so the
/// "standard" guard would self-reject every auto-evolution from the one call
/// site covering essence + Trust + level together.
///
/// PROOF-OF-TEETH: the monster sits in an `Ongoing` battle here — the exact
/// fixture that makes `evolve()` reject (`evolve_rejects_when_owner_in_ongoing_
/// battle_side_a`, same world) — and the auto-evolution must still apply.
///
/// kills: a copy-paste of `evolve()`'s guard prologue into `check_and_evolve` or
///        `apply_evolution` (auto-evolution would go permanently dark from the
///        battle write-back path, and no other test would notice).
#[test]
fn check_and_evolve_applies_during_an_ongoing_battle() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    seed_evolvable_world(&mut db, 1, owner);
    db.insert_battle(make_side_a_battle(100, owner, vec![1]));

    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(
        steps, 1,
        "TEETH(EG2-12): the auto-evolution path must NOT be battle-guarded — the \
         battle row is still Ongoing when write_back_battle_results calls it"
    );
    assert_eq!(
        db.get_monster(1)
            .expect("monster row must survive")
            .species_id,
        2,
        "the evolution must actually have been applied mid-battle-write-back"
    );
}

/// EG2-11: a missing monster row is a silent no-op — `check_and_evolve` returns
/// `()` and never errors outward (its callers are reducer tails that must not
/// fail a legitimate care/train/battle write-back because a row vanished).
///
/// kills: `.unwrap()`/`.expect()` on the fresh find (a WASM trap that would roll
///        back the CALLER's already-committed dual-write); an impl that
///        propagates an Err out of a tail call.
#[test]
fn check_and_evolve_missing_monster_is_silent_noop() {
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));

    let steps = check_and_evolve_seam(&mut db, 424_242);

    assert_eq!(
        steps, 0,
        "TEETH: a missing monster must be a silent no-op, not a panic and not an \
         evolution of some other row"
    );
}

/// EG2-13 (chain, positive): three consecutive single-eligible steps resolve to
/// the FINAL species in ONE call, with no player action.
///
/// World: 1 (tier 0) -> 2 (tier 1) -> 3 (tier 2) -> 4 (tier 3). Step 1 carries
/// the full 5-gate edge (including Fire essence 100); steps 2 and 3 are gated on
/// level + Trust ONLY, because all 8 essence pools zero on every step — an
/// essence-gated step 2 could never fire, and that is the point of gating the
/// chain on state that survives.
///
/// kills: a `check_and_evolve` that applies one step and returns (the monster
///        would sit one form short until an unrelated later action nudged it);
///        a chain that re-checks against the STALE pre-evolution species (it
///        would re-match edge 1 -> 2 forever and only stop at the cap, landing on
///        species 2 after 7 steps); a chain that re-uses the already-marshaled
///        instance instead of a FRESH find.
#[test]
fn eg2_13_chain_three_single_eligible_steps_resolves_in_one_call() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row()); // 1, tier 0
    db.insert_species(target_species_row()); // 2, tier 1
    db.insert_species(make_species_row(3, 40, 60, 2));
    db.insert_species(make_species_row(4, 55, 70, 3));
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));
    db.insert_evolution_path(make_level_and_trust_path_row(
        2,
        101,
        2,
        3,
        20,
        TrustTier::Friendly,
    ));
    db.insert_evolution_path(make_level_and_trust_path_row(
        3,
        102,
        3,
        4,
        20,
        TrustTier::Friendly,
    ));

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    // ONE seam invocation — exactly what a reducer tail performs.
    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(
        steps, 3,
        "TEETH(EG2-13): the whole 3-step chain must resolve in ONE call — one \
         step means no cascade, more than three means the loop lost track of the \
         monster's NEW species"
    );
    let after = db.get_monster(1).expect("monster row must survive");
    assert_eq!(
        after.species_id, 4,
        "the monster must land on the FINAL species of the chain"
    );
    assert_eq!(
        after.trust_favorable_count, 30,
        "Trust survives every step (it is what gates steps 2 and 3)"
    );
    assert_eq!(
        after.quality_time_ticks_total, 400,
        "Quality-Time survives every step"
    );
    assert_eq!(
        after.essence_fire, 0,
        "essence is spent on the FIRST step and stays zero through the chain"
    );
    assert_eq!(
        db.get_monster_pub(1)
            .expect("monster_pub must survive")
            .tier,
        3,
        "TEETH: the public tier must be the FINAL species' tier (3), read fresh \
         on the last step — a chain that writes the tier once, up front, shows 1"
    );
}

/// EG2-13 (chain, stop condition): a chain stops the moment a step has 2+
/// eligible paths, leaving the monster at that intermediate species for the
/// player to choose from (EG4-8's badge is computed from exactly this state).
///
/// kills: a chain that keeps cascading past a branch point by taking the first
///        eligible path (the player never gets the choice — and the monster ends
///        up on a species they did not pick); a chain that stops one step EARLY
///        (the first, unambiguous step would not be applied at all).
#[test]
fn eg2_13_chain_stops_at_two_eligible() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row()); // 1, tier 0
    db.insert_species(target_species_row()); // 2, tier 1
    db.insert_species(make_species_row(3, 40, 60, 2));
    db.insert_species(make_species_row(5, 45, 65, 2));
    // Step 1: unambiguous. Then species 2 has TWO satisfied outgoing edges.
    db.insert_evolution_path(make_evolution_path_row(1, 100, 1, 2));
    db.insert_evolution_path(make_level_only_path_row(2, 101, 2, 3, 20));
    db.insert_evolution_path(make_level_only_path_row(3, 102, 2, 5, 20));

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let steps = check_and_evolve_seam(&mut db, 1);

    assert_eq!(steps, 1, "the chain must apply step 1 and then stop");
    assert_eq!(
        db.get_monster(1)
            .expect("monster row must survive")
            .species_id,
        2,
        "TEETH(EG2-13): the chain stops AT the branch point — species 2, not 3 \
         and not 5; the player owns that choice (EG4-2)"
    );
}

/// EG2-13 (termination, proof-of-teeth): the chain carries an EXPLICIT hard
/// iteration cap, so R5/R11-invalid content cannot spin it forever.
///
/// Fixture: deliberately R5-INVALID content seeded straight into the test DB —
/// 1 -> 2 AND 2 -> 1, both level-gated only, both ALWAYS satisfied. The content
/// gate (R5 tier monotonicity) makes this unauthorable, which is precisely why
/// the runtime guard is the last line of defence: this is the shape a future
/// R5/R11 relaxation would let through.
///
/// The cap is read from the PRODUCTION constant, so the seam can never encode a
/// different bound than the reducer.
///
/// kills: a bare `loop {}` / unbounded recursion (this test would hang forever
///        or blow the WASM stack instead of failing); an off-by-one cap that
///        runs one extra step; a cap set to a different value than
///        `MAX_EVOLUTION_CHAIN_STEPS` (the count assertion pins it at 7 = R11's
///        tier cap 5 + 2, ADR-0175 D3).
#[test]
fn eg2_13_iteration_cap_terminates_on_degenerate_cycle() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row()); // 1, tier 0
    db.insert_species(target_species_row()); // 2, tier 1
                                             // R5-INVALID by construction: a 2-cycle, both edges trivially satisfied.
    db.insert_evolution_path(make_level_only_path_row(1, 100, 1, 2, 1));
    db.insert_evolution_path(make_level_only_path_row(2, 101, 2, 1, 1));

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    // Terminates at all == the test returns. What it terminates AT is the pin.
    let steps = check_and_evolve_seam(&mut db, 1);

    let cap = usize::try_from(crate::evolution::MAX_EVOLUTION_CHAIN_STEPS)
        .expect("the chain cap must fit a usize");
    assert_eq!(
        cap, 7,
        "TEETH(EG2-13/ADR-0175 D3): MAX_EVOLUTION_CHAIN_STEPS must be 7 — R11's \
         tier cap 5 plus 2, generous on purpose and structurally unreachable for \
         R5-valid content"
    );
    assert_eq!(
        steps, cap,
        "TEETH: a degenerate cycle must stop EXACTLY at the cap — never run \
         longer, never hang"
    );
    assert_eq!(
        db.get_monster(1)
            .expect("monster row must survive")
            .species_id,
        2,
        "7 steps around a 2-cycle starting at species 1 ends on species 2 — pins \
         that every counted step really was applied, not skipped"
    );
}

/// EG2-11/EG2-1: `apply_evolution` zeroes ALL EIGHT essence pools and preserves
/// every Trust / Quality-Time / bookkeeping column, called DIRECTLY (not through
/// `evolve()`'s guard prologue).
///
/// Fixture: all 8 pools non-zero and DISTINCT, every Trust/QT column non-zero.
///
/// kills: an impl that zeroes only the pools the edge required (banked essence
///        of other affinities would survive an evolution that is supposed to
///        spend the bar); an impl that rebuilds the row via
///        `monster_from_instance` (which drops the server-only QT bookkeeping by
///        design) — including the `last_essence_train_at_ms` reset, which would
///        silently clear the shared essence-training cooldown on every evolution.
#[test]
fn apply_evolution_zeroes_all_eight_pools_and_preserves_trust_and_quality_time() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row());
    db.insert_species(target_species_row());

    let mut m = make_qualified_monster_row(1, owner);
    m.essence_fire = 111;
    m.essence_water = 122;
    m.essence_plant = 133;
    m.essence_electric = 144;
    m.essence_earth = 155;
    m.essence_wind = 166;
    m.essence_light = 177;
    m.essence_dark = 188;
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    let path = make_evolution_path_row(1, 100, 1, 2);
    apply_evolution_seam(&mut db, 1, &path).expect("apply_evolution must succeed");

    let after = db.get_monster(1).expect("monster row must survive").clone();
    assert_eq!(
        (
            after.essence_fire,
            after.essence_water,
            after.essence_plant,
            after.essence_electric,
            after.essence_earth,
            after.essence_wind,
            after.essence_light,
            after.essence_dark,
        ),
        (0, 0, 0, 0, 0, 0, 0, 0),
        "TEETH(ADR-0174 D2): ALL EIGHT pools zero — every one entered non-zero \
         and only the Fire pool was required by this edge"
    );
    assert_eq!(
        after.trust_favorable_count, 30,
        "trust_favorable_count must survive"
    );
    assert_eq!(
        after.trust_unfavorable_count, 2,
        "trust_unfavorable_count must survive"
    );
    assert_eq!(
        after.trust_favorable_battle_day_epoch, 5,
        "the once-per-day battle-credit anchor must survive"
    );
    assert_eq!(
        after.quality_time_ticks_total, 400,
        "quality_time_ticks_total must survive"
    );
    assert_eq!(
        after.quality_time_accum_ms, 777,
        "quality_time_accum_ms must survive"
    );
    assert_eq!(
        after.quality_time_window_ms, 888,
        "quality_time_window_ms must survive"
    );
    assert_eq!(
        after.quality_time_window_start_ms, 999,
        "quality_time_window_start_ms (the accrual anchor) must survive"
    );
    assert_eq!(
        after.last_essence_train_at_ms, 1234,
        "TEETH: last_essence_train_at_ms must survive — resetting it would clear \
         the shared essence-training cooldown on every evolution"
    );
    let p = db.get_monster_pub(1).expect("monster_pub must survive");
    assert_eq!(
        (
            p.essence_fire,
            p.essence_water,
            p.essence_plant,
            p.essence_electric,
            p.essence_earth,
            p.essence_wind,
            p.essence_light,
            p.essence_dark,
        ),
        (0, 0, 0, 0, 0, 0, 0, 0),
        "TEETH(dual-write): the PUBLIC pools must be zeroed too — the EG4 \
         requirements panel reads these"
    );
}

/// EG2-11/EG1-8: `apply_evolution` sets `MonsterPub.tier` from a FRESH lookup of
/// the path's `to_species` row — not from the (stale) public row, not from the
/// path, not a default.
///
/// Fixture: the target species row carries `tier: 2` while the existing public
/// row carries a deliberately stale `tier: 9`.
///
/// PROOF-OF-TEETH: a copy-forward impl writes 9; a defaulted/`unwrap_or(0)` impl
/// writes 0; a "source tier + 1" impl writes 1. Only a fresh
/// `species_row(path.to_species).tier` read produces 2.
///
/// kills: tier copy-forward / fabrication at the one call site that must read
///        fresh (A3, ADR-0174 D7).
#[test]
fn apply_evolution_sets_pub_tier_from_fresh_target_species_lookup() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.insert_species(source_species_row()); // 1, tier 0
    db.insert_species(make_species_row(2, 20, 80, 2)); // target, tier 2

    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 9)); // STALE

    let path = make_evolution_path_row(1, 100, 1, 2);
    apply_evolution_seam(&mut db, 1, &path).expect("apply_evolution must succeed");

    assert_eq!(
        db.get_monster_pub(1)
            .expect("monster_pub must survive")
            .tier,
        2,
        "TEETH(EG1-8): the tier must come from a FRESH species_row lookup of the \
         path's to_species (2); 9 = copy-forward, 0 = fabricated, 1 = derived \
         from the source tier"
    );
}

// ===========================================================================
// EG2-1 message layer — NOTE ON OWNERSHIP.
//
// `unmet_requirement` lives in GAME-CORE (`game_core::unmet_requirement`), NOT
// in `evolution.rs`: it is a pure function of (instance, path), and keeping it
// out of the server layer is what makes the whole-file source scan below sound
// (nothing in `evolution.rs` has any legitimate reason to read a gate field).
//
// Its own contract tests — `None` exactly when `path_satisfied` is true, and the
// per-gate keyword/threshold vocabulary — live in game-core alongside it. This
// file exercises it only through the seam, where it is the reducer's rejection
// message (`evolve_rejects_names_the_failing_requirement`).
// ===========================================================================

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
// Included for the EG2-9 scheduled-reducer scan ONLY (it hosts `playtest_reaper`);
// it calls no `pub_from_monster`, so it is deliberately NOT in the A3 file set.
const PLAYTEST_RS_SOURCE: &str = include_str!("playtest.rs");
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

// ---------------------------------------------------------------------------
// STRING-LITERAL BLANKING (hardening, mirrors movement_tests.rs:73-196 and
// guards_tests.rs).
//
// `strip_rust_comments` alone leaves string CONTENT in the scanned text, so a
// perfectly legitimate log line or error message in evolution.rs mentioning a
// banned needle (`min_level`, `loop {`, `reject_if_in_battle`, …) would fail a
// CORRECT implementation. Every needle this file scans for is a fact about
// CODE, so the scan pipeline blanks literals first. Char literals are preserved
// (they are code) but consumed as a unit, so a char literal holding a
// double-quote byte cannot open a phantom string and hollow out the rest of the
// scan — the exact misalignment the sibling scanners documented.
// ---------------------------------------------------------------------------

/// The ASCII double-quote byte, named rather than spelled as a char literal:
/// an unpaired double quote inside THIS file is the landmine
/// `movement_tests.rs:73` records (it blanked `pub fn init(` in an unrelated
/// file and turned a live gate vacuous). Keep every double quote in this file
/// part of a balanced Rust string literal.
const DQUOTE: u8 = 0x22;

/// Is `b` an identifier byte (used for word-boundary checks)?
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// If a STRING literal starts at `i`, the index one past its closing delimiter.
///
/// Covers plain, byte (`b"…"`) and raw (`r"…"` / `r#"…"#` / `br#"…"#`) forms. A
/// `b`/`r` prefix only counts when it is not part of a longer identifier, so
/// `ctx.db` and `row` are never mistaken for literal openers. No production
/// `.rs` file in this crate uses a raw or byte string today (only `_tests.rs`
/// files do); the handling is defensive.
fn string_literal_end(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    let first = bytes[i];
    if first != DQUOTE && first != b'r' && first != b'b' {
        return None;
    }
    let prev_is_ident = i > 0 && is_ident_byte(bytes[i - 1]);
    let mut p = i;
    if first == b'b' {
        if prev_is_ident || p + 1 >= len {
            return None;
        }
        if bytes[p + 1] != DQUOTE && bytes[p + 1] != b'r' {
            return None;
        }
        p += 1;
    } else if first == b'r' && prev_is_ident {
        return None;
    }
    if bytes[p] == b'r' {
        let mut hashes = 0usize;
        while p + 1 + hashes < len && bytes[p + 1 + hashes] == b'#' {
            hashes += 1;
        }
        if p + 1 + hashes >= len || bytes[p + 1 + hashes] != DQUOTE {
            return None;
        }
        let mut j = p + 2 + hashes;
        while j < len {
            if bytes[j] == DQUOTE {
                let mut k = 0usize;
                while k < hashes && j + 1 + k < len && bytes[j + 1 + k] == b'#' {
                    k += 1;
                }
                if k == hashes {
                    return Some(j + 1 + hashes);
                }
            }
            j += 1;
        }
        return Some(len);
    }
    let mut j = p + 1;
    while j < len {
        if bytes[j] == b'\\' {
            j += 2;
        } else if bytes[j] == DQUOTE {
            return Some(j + 1);
        } else {
            j += 1;
        }
    }
    Some(len)
}

/// If a CHAR (or byte-char) literal starts at `i`, the index one past it.
///
/// A `'` is only read as a literal when a closing `'` follows within four
/// bytes; otherwise it is a lifetime tick (`&'a str`) and is left alone.
fn char_literal_end(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    if bytes[i] != b'\'' {
        return None;
    }
    let escaped = i + 1 < len && bytes[i + 1] == b'\\';
    let first = if escaped { 3 } else { 2 };
    for k in first..=4 {
        if i + k < len && bytes[i + k] == b'\'' {
            return Some(i + k + 1);
        }
    }
    None
}

/// Comments AND string-literal content blanked; code (including char literals)
/// preserved at its original byte offsets. THE scan pipeline for every
/// needle check below.
fn strip_comments_and_strings(src: &str) -> String {
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
        } else if let Some(end) = string_literal_end(bytes, i) {
            i = end;
        } else if let Some(end) = char_literal_end(bytes, i) {
            while i < end {
                out[i] = bytes[i];
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// The byte range (exclusive of the braces) of the block whose opening `{` sits
/// at `open`. ONE brace-walk implementation, shared by the fn-body extractors
/// (ADR-0003 SSOT — two parsers for one grammar in one file is a duplicated
/// source of truth).
fn brace_block_range(stripped: &str, open: usize) -> (usize, usize) {
    let body_start = open + 1;
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
    (body_start, body_start + byte_off)
}

/// Byte range of the body of the function whose declaration starts at
/// `decl_needle`, or `None` if the declaration (or its body) is absent.
///
/// Ranges — not just text — because the confinement checks below must ask
/// "is THIS occurrence inside THAT function", which a copied substring cannot
/// answer.
fn extract_fn_body_range(stripped: &str, decl_needle: &str) -> Option<(usize, usize)> {
    let decl_pos = stripped.find(decl_needle)?;
    let brace_offset = stripped[decl_pos..].find('{')?;
    Some(brace_block_range(stripped, decl_pos + brace_offset))
}

/// Extract the body of the function whose declaration starts at `decl_needle`,
/// by walking braces from the first `{` after the declaration.
fn extract_fn_body(stripped: &str, decl_needle: &str) -> String {
    let (start, end) = extract_fn_body_range(stripped, decl_needle).unwrap_or_else(|| {
        panic!("declaration {decl_needle:?} (with a body) must exist in the scanned source")
    });
    stripped[start..end].to_string()
}

/// Byte offset of every occurrence of `needle` in `haystack`.
fn occurrences(haystack: &str, needle: &str) -> Vec<usize> {
    assert!(!needle.is_empty(), "an empty needle would never terminate");
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(idx) = haystack[pos..].find(needle) {
        let abs = pos + idx;
        out.push(abs);
        pos = abs + needle.len();
    }
    out
}

/// Every `fn NAME(` declaration in `stripped`, paired with its body text.
///
/// Nested fns are included; fn-pointer TYPES (`fn(u8) -> u8`, no space) and
/// body-less declarations (trait methods) are skipped. Used by the EG2-9 one-hop
/// wrapper closure.
fn enumerate_fn_bodies(stripped: &str) -> Vec<(String, String)> {
    let bytes = stripped.as_bytes();
    let len = bytes.len();
    let mut out = Vec::new();
    for decl in occurrences(stripped, "fn ") {
        // Word boundary before `fn` (never the tail of `pfn`/`my_fn`).
        if decl > 0 && is_ident_byte(bytes[decl - 1]) {
            continue;
        }
        let mut name_start = decl + 3;
        while name_start < len && (bytes[name_start] == b' ' || bytes[name_start] == b'\t') {
            name_start += 1;
        }
        let mut name_end = name_start;
        while name_end < len && is_ident_byte(bytes[name_end]) {
            name_end += 1;
        }
        if name_end == name_start {
            continue;
        }
        // Walk the signature to the body brace; a `;` first means no body.
        let mut k = name_end;
        while k < len && bytes[k] != b'{' && bytes[k] != b';' {
            k += 1;
        }
        if k >= len || bytes[k] == b';' {
            continue;
        }
        let (start, end) = brace_block_range(stripped, k);
        out.push((
            stripped[name_start..name_end].to_string(),
            stripped[start..end].to_string(),
        ));
    }
    out
}

/// Does `body` DIRECTLY call `name(`, with a word boundary before the name?
/// (`health_care(` is not a call to `care(`.) Mirrors
/// `no-idle-accrual.eval.mjs` Check B's direct-call test.
fn body_calls(body: &str, name: &str) -> bool {
    let needle = format!("{name}(");
    let bytes = body.as_bytes();
    occurrences(body, &needle)
        .into_iter()
        .any(|idx| idx == 0 || !is_ident_byte(bytes[idx - 1]))
}

/// The PRODUCTION region of a source file: everything before the first
/// `#[cfg(test)]` marker, comments AND string literals blanked.
///
/// Test-only code must never be able to satisfy (or pollute) a production-shape
/// assertion — the same file-scoping lesson `evolution-reducer-security`'s
/// `readServerModuleProdSources` already encodes at the eval layer.
fn production_region(src: &str) -> String {
    let stripped = strip_comments_and_strings(src);
    match stripped.find("#[cfg(test)]") {
        Some(idx) => stripped[..idx].to_string(),
        None => stripped,
    }
}

/// EG1-11 (positive): the `evolve` reducer body must make its gate decision BY
/// CALLING the shared predicate — in the load-bearing `if !…` form.
///
/// A bare `path_satisfied(` substring is NOT enough: a body that computes its own
/// verdict and merely mentions the predicate somewhere (a dead branch, a
/// `let _ = path_satisfied(..);`, a logging call) would satisfy a substring check
/// while the real decision came from re-implemented arithmetic. So the accepted
/// forms are exactly the two import styles of the negated call that GUARDS the
/// rejection:
///     if !game_core::path_satisfied(   |   if !path_satisfied(
///
/// kills: a decoy/dead-branch call to the shared predicate; an `evolve` that
///        decides eligibility with its own inline comparisons — which is exactly
///        how the read path (`eligible_evolution_paths`, powering the client
///        requirements panel) and the write path silently drift apart.
#[test]
fn eg1_11_evolve_body_delegates_to_path_satisfied() {
    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let body = extract_fn_body(&stripped, "pub fn evolve(ctx");

    // Vacuity guard: an empty extraction must never pass this test silently.
    assert!(
        !body.trim().is_empty(),
        "vacuity guard: the extracted `evolve` body is empty — the source scanner \
         has rotted and any verdict below would be meaningless"
    );

    let qualified = body.contains("if !game_core::path_satisfied(");
    let bare = body.contains("if !path_satisfied(");
    assert!(
        qualified || bare,
        "TEETH(EG1-11): the `evolve` reducer body must GUARD its rejection on the \
         shared predicate, written as `if !game_core::path_satisfied(` or \
         `if !path_satisfied(` — ONE shared gate predicate for both the read path \
         (eligible_evolution_paths) and this write path, so they cannot drift. A \
         bare mention of the predicate elsewhere in the body (dead branch, \
         `let _ = …`, a log line) does NOT count: the negated call must be the \
         thing that decides the rejection."
    );
}

/// EG1-11 (negative): NOTHING in the production region of `evolution.rs` may
/// contain gate arithmetic — not just `evolve`'s own body.
///
/// WHY WHOLE-FILE (the bypass this closes): scoping the ban to `extract_fn_body`
/// alone left a trivial escape — move the re-implemented gate into a private
/// helper two lines below `evolve` and call it. The ban is now sound at file
/// scope because the ONE function with a legitimate reason to read gate fields,
/// `unmet_requirement`, lives in GAME-CORE (pure, testable there), not here.
/// `evolution.rs` is a ctx/DB layer: it has no business touching a gate field.
///
/// Each banned needle is a field or helper that only a re-implemented gate (or a
/// re-implemented requirement description) touches:
///   * `min_level` / `min_trust_tier` / `min_quality_time_tier` /
///     `min_nutrition_pct` — the `EvolutionPath` gate fields,
///   * `.amount` — the `EssenceRequirement` threshold,
///   * `trust_tier_of(` / `quality_time_tier_of(` / `nutrition_pct_of(` /
///     `nutrition_pct_from_ev_total(` — the three tier derivations.
///
/// ---------------------------------------------------------------------------
/// EG2 REVISION (spec-driven, plan D12 / ADR-0175 D6) — NOT a weakening.
///
/// EG1 also banned `eligible_evolution_paths(` at FILE scope. EG2-11 MANDATES
/// that exact call in this exact file: `check_and_evolve` must compute the full
/// eligible set for the monster's current species (0 / 1 / 2+ is the whole
/// decision). A file-scoped ban and the spec now contradict each other, so the
/// needle is re-scoped rather than dropped — the invariant EG1 was protecting
/// (EG2-1's "evaluate only the ONE matched edge, never the full set" rule on the
/// player-invoked path) is preserved exactly, and is now enforced where it
/// actually lives:
///   (a) BODY-SCOPED BAN — `evolve`'s body must not call `eligible_evolution_paths(`.
///   (b) POSITIVE REQUIREMENT — `check_and_evolve`'s body MUST call it, so the
///       full-set query cannot be quietly replaced by a hand-rolled loop.
///   (c) EXACTLY ONE `path_satisfied(` in `evolve`'s body — one targeted row,
///       one gate decision; two occurrences means a loop over candidates.
///   (d) NO `.collect` in `evolve`'s body — closes the loop-reimplementation
///       escape where `evolve` gathers a candidate set and filters it by hand,
///       which is EG2-1's "re-deriving and discarding 9 irrelevant edges" waste
///       wearing a different name.
/// The other NINE needles stay file-scoped and now bind `apply_evolution` and
/// `check_and_evolve` too.
/// ---------------------------------------------------------------------------
///
/// NOTE FOR THE IMPLEMENTER: naming the failing requirement is still required
/// (EG2-1) — call `game_core::unmet_requirement(&instance, &path)`; do not
/// re-derive the message here. The write-back of the transformed instance
/// (`transformed.essence[...]` into the eight columns) is deliberately NOT
/// banned; only gate/threshold reads are.
///
/// kills: a hand-rolled `path.min_level <= level && …` chain anywhere in
///        `evolution.rs`; a private `fn describe_gate(..)` helper next to
///        `evolve` that re-implements the five gates; a body that computes the
///        three tiers itself; a full-set eligibility query on the player-invoked
///        path where a targeted lookup is required; a `check_and_evolve` that
///        re-implements the eligible-set query instead of calling the shared one.
#[test]
fn eg1_11_evolution_rs_production_region_has_no_inlined_gate_logic() {
    let production = production_region(EVOLUTION_RS_SOURCE);

    // Vacuity guards: the scanned region must be real production code that still
    // contains all three functions, otherwise a truncated/empty region would pass.
    assert!(
        !production.trim().is_empty(),
        "vacuity guard: the production region of evolution.rs is empty — the \
         scanner has rotted"
    );
    for decl in [
        "pub fn evolve(",
        "pub(crate) fn apply_evolution(",
        "pub(crate) fn check_and_evolve(",
    ] {
        assert!(
            production.contains(decl),
            "vacuity guard: the production region of evolution.rs does not contain \
             {decl:?} — either the function moved/was never written (EG2-11 puts \
             apply_evolution AND check_and_evolve in this file) or a `#[cfg(test)]` \
             marker above it truncated the scan, which would let gate logic below \
             the cut escape this check"
        );
    }
    // Soundness of the cut: the ONLY `#[cfg(test)]` in evolution.rs must be the
    // test-module declaration at the bottom. A second one placed above `evolve`
    // would shrink the scanned region (the exact way to smuggle gate logic past
    // a first-marker cut), and EG1 deletes the old cfg(test) effect structs
    // anyway.
    assert_eq!(
        strip_comments_and_strings(EVOLUTION_RS_SOURCE)
            .matches("#[cfg(test)]")
            .count(),
        1,
        "TEETH: evolution.rs must contain EXACTLY ONE `#[cfg(test)]` (the \
         `mod evolution_tests;` declaration at the bottom). A second marker moves \
         the production/test cut and would let code below it escape the gate scan; \
         EG1 also deletes the old cfg(test) EvolutionEffect/FuseEffect structs."
    );

    // --- File-scoped bans: the nine gate/threshold needles ------------------
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
    ];
    for needle in banned {
        assert!(
            !production.contains(needle),
            "TEETH(EG1-11): the production region of evolution.rs contains \
             {needle:?} — that is gate logic re-implemented in the server layer \
             instead of delegated to game-core. The gate DECISION belongs to \
             `game_core::path_satisfied`; requirement NAMING belongs to \
             `game_core::unmet_requirement`. Moving it into a private helper next \
             to `evolve` does not make it legal — this scan is file-scoped for \
             exactly that reason."
        );
    }

    // --- Body-scoped: the full-set query belongs to check_and_evolve ONLY ---
    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let evolve_body = extract_fn_body(&stripped, "pub fn evolve(ctx");
    assert!(
        !evolve_body.trim().is_empty(),
        "vacuity guard: the extracted `evolve` body is empty — the source scanner \
         has rotted and every verdict below would be meaningless"
    );
    assert!(
        !evolve_body.contains("eligible_evolution_paths("),
        "TEETH(EG2-1): `evolve`'s body must NOT call `eligible_evolution_paths(` — \
         the player-invoked path evaluates ONE targeted, indexed row \
         (from_species + to_species), never the full outgoing set. At up to 10 \
         edges per species that is nine edges' worth of gate checks derived and \
         discarded on every call."
    );
    assert_eq!(
        evolve_body.matches("path_satisfied(").count(),
        1,
        "TEETH(EG2-1): `evolve`'s body must contain EXACTLY ONE `path_satisfied(` \
         call — one targeted row, one gate decision. Two or more means the reducer \
         is iterating candidates, i.e. re-implementing `eligible_evolution_paths` \
         under another name."
    );
    assert!(
        !evolve_body.contains(".collect"),
        "TEETH(EG2-1, loop-reimplementation escape): `evolve`'s body must not \
         `.collect` anything — the only reason this reducer would build a \
         collection is to gather candidate edges and filter them by hand, which is \
         the full-set query the targeted lookup exists to avoid."
    );

    let check_body = extract_fn_body(&stripped, "pub(crate) fn check_and_evolve(");
    assert!(
        !check_body.trim().is_empty(),
        "vacuity guard: the extracted `check_and_evolve` body is empty — the \
         source scanner has rotted"
    );
    assert!(
        check_body.contains("eligible_evolution_paths("),
        "TEETH(EG2-11): `check_and_evolve`'s body MUST call \
         `eligible_evolution_paths(` — the 0 / exactly-1 / 2+ decision is defined \
         over the SHARED eligible set (the same set the EG4 client computes \
         client-side). A hand-rolled filter here is exactly the read-path / \
         write-path drift EG1-11 exists to prevent, and it would also silently \
         reintroduce the first-match-winner race EG2-2 forbids."
    );

    // --- CONFINEMENT: the body-scoped bans above are not enough on their own --
    //
    // THE ESCAPE THIS CLOSES: a private helper anywhere else in evolution.rs
    // (`fn candidate_paths(ctx, m) -> Vec<usize> { … eligible_evolution_paths(…)
    // … .collect() }`) called from `evolve`'s body satisfies every body-scoped
    // assertion above while putting the full-set query right back on the
    // player-invoked path — the SAME helper-indirection bypass the EG1 whole-file
    // ban was written to stop. D12 re-scoped that needle; it did not licence a
    // second copy. So the file-scope strength is restored as a CONFINEMENT rule:
    // the mandated occurrence is permitted in exactly one place, and nowhere else.
    let production_end = stripped.find("#[cfg(test)]").unwrap_or(stripped.len());
    let (check_start, check_end) =
        extract_fn_body_range(&stripped, "pub(crate) fn check_and_evolve(")
            .expect("vacuity guard: check_and_evolve's body must be locatable");

    let eligible_sites = occurrences(&stripped[..production_end], "eligible_evolution_paths(");
    assert_eq!(
        eligible_sites.len(),
        1,
        "TEETH(EG1-11 confinement): the production region of evolution.rs must \
         contain EXACTLY ONE `eligible_evolution_paths(` occurrence (found {}). \
         EG2-11 mandates the full-set query in `check_and_evolve` and NOWHERE \
         else — a second copy in a private helper is how the query walks back \
         onto `evolve`'s targeted path (EG2-1) without tripping any body-scoped \
         ban.",
        eligible_sites.len()
    );
    assert!(
        eligible_sites[0] >= check_start && eligible_sites[0] < check_end,
        "TEETH(EG1-11 confinement): the one `eligible_evolution_paths(` call in \
         evolution.rs sits OUTSIDE `check_and_evolve`'s body (byte {} not in \
         {check_start}..{check_end}) — a private helper hosting the full-set query \
         and called from `evolve` is exactly the indirection this scan exists to \
         catch",
        eligible_sites[0]
    );

    for site in occurrences(&stripped[..production_end], ".collect") {
        assert!(
            site >= check_start && site < check_end,
            "TEETH(EG1-11 confinement): a `.collect` at byte {site} of \
             evolution.rs's production region sits outside `check_and_evolve`'s \
             body ({check_start}..{check_end}). The ONLY legitimate collection in \
             this file is `check_and_evolve` gathering the current species' \
             candidate rows; anywhere else it is a hand-rolled candidate filter — \
             the loop-reimplementation escape, moved one function over."
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
    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);

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
// EG2 SOURCE SCANS — the shapes a seam cannot observe.
//
// The seam tests above prove BEHAVIOUR (given these rows, this is the result).
// They cannot prove that the production reducer reaches that result through the
// ONE shared helper, reads the DB instead of a cache, or carries an explicit
// termination bound — those are structural facts about the source, so they are
// scanned here, exactly as EG1-11 scans the shared-predicate delegation.
// ===========================================================================

/// EG2-1: `evolve()` DELEGATES the transform-and-write to `apply_evolution` —
/// it no longer performs one itself.
///
/// Three assertions, because the positive alone is bypassable: an `evolve` that
/// calls `apply_evolution(` AND still runs its own inline transform would satisfy
/// a call check while leaving two write paths in the codebase (the exact "an
/// evolution is NEVER applied through two different code paths" failure EG2-11
/// names). So the transform call and the monster update must BOTH be gone from
/// `evolve`'s body.
///
/// kills: a copy-pasted `apply_evolution` that duplicates instead of replacing
///        the reducer's tail (two write paths that drift the first time one is
///        fixed); a delegation added below a `return`; an `apply_evolution` that
///        exists but is never called from `evolve`.
#[test]
fn eg2_1_evolve_body_delegates_to_apply_evolution() {
    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let body = extract_fn_body(&stripped, "pub fn evolve(ctx");
    assert!(
        !body.trim().is_empty(),
        "vacuity guard: the extracted `evolve` body is empty — the scanner has rotted"
    );

    assert!(
        body.contains("apply_evolution("),
        "TEETH(EG2-1): `evolve`'s body must call `apply_evolution(` — the \
         transform-and-write logic is factored into ONE shared helper that both \
         `evolve()` and `check_and_evolve` call (EG2-11)"
    );
    assert!(
        !body.contains("game_core::evolve("),
        "TEETH(EG2-11): `evolve`'s body must NOT call `game_core::evolve(` any \
         more — the pure transform is invoked from `apply_evolution` and nowhere \
         else. A body that delegates AND transforms leaves two write paths."
    );
    assert!(
        !body.contains("monster().monster_id().update("),
        "TEETH(EG2-11): `evolve`'s body must NOT write the monster row itself — \
         the dual-write belongs to `apply_evolution`. A leftover update here means \
         the row is written twice (or written differently) depending on which \
         entry point ran."
    );
}

/// EG2-11: `apply_evolution` is the ONLY transform path in this file.
///
/// Two teeth working together: exactly ONE `game_core::evolve(` occurrence in the
/// whole production region, AND that occurrence is inside `apply_evolution`'s
/// body. Either alone is bypassable — a single occurrence sitting in a second
/// private helper would pass a count-only check, and a count-free body check
/// would tolerate a duplicate elsewhere in the file.
///
/// kills: an auto-evolution path that transforms the monster itself instead of
///        calling the shared helper; a private `fn apply_evolution_inner` twin;
///        a leftover transform in `evolve` (also caught above, deliberately
///        double-covered — this is the invariant EG2-11 states outright).
#[test]
fn eg2_11_apply_evolution_is_the_only_transform_path() {
    let production = production_region(EVOLUTION_RS_SOURCE);
    assert!(
        production.contains("pub(crate) fn apply_evolution("),
        "vacuity guard: `pub(crate) fn apply_evolution(` is not in evolution.rs's \
         production region — without it this test's count assertion is vacuous \
         (EG2-11 puts the shared helper in exactly this file)"
    );

    assert_eq!(
        production.matches("game_core::evolve(").count(),
        1,
        "TEETH(EG2-11): the production region of evolution.rs must contain EXACTLY \
         ONE `game_core::evolve(` call — an evolution is NEVER applied through two \
         different code paths"
    );

    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let apply_body = extract_fn_body(&stripped, "pub(crate) fn apply_evolution(");
    assert!(
        apply_body.contains("game_core::evolve("),
        "TEETH(EG2-11): the one transform call must live in `apply_evolution`'s \
         body — if it sits anywhere else, `apply_evolution` is not the shared \
         transform path the spec requires, whatever the file-wide count says"
    );
    assert!(
        apply_body.contains("pub_from_monster("),
        "TEETH(EG2-11/ADR-0015): `apply_evolution` owns the dual-write, so its body \
         must project the public row through `pub_from_monster(`"
    );
}

/// EG2-12 (Guard warning): `check_and_evolve` and `apply_evolution` SHALL NEVER
/// carry the standard guard prologue.
///
/// This inverts this codebase's default convention on purpose. At the
/// `write_back_battle_results` call site the battle's DB row is STILL `Ongoing`
/// (the mutating callers move it to its terminal state only after the write-back
/// returns), so `reject_if_in_battle` here would silently self-reject every
/// auto-evolution from the ONE call site covering essence + Trust + level
/// together. The other call sites (`care` / `train` / `essence_train` /
/// `enqueue_move` / `consume_crystalized_essence`) each guard BEFORE their own
/// mutation, so the tail call is already battle-clean; and ownership is not
/// checked because this is an internal helper, never a wire-reachable reducer.
///
/// kills: a well-meaning "every reducer in this file is guarded, so guard these
///        too" edit — which would make auto-evolution look fine in every unit
///        test while being dead in the one path that matters most in production.
#[test]
fn eg2_11_check_and_evolve_has_no_battle_or_trade_guard() {
    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let banned = [
        "reject_if_in_battle",
        "is_in_ongoing_battle",
        "reject_if_monster_in_trade",
        "require_owner",
    ];
    for decl in [
        "pub(crate) fn check_and_evolve(",
        "pub(crate) fn apply_evolution(",
    ] {
        let body = extract_fn_body(&stripped, decl);
        assert!(
            !body.trim().is_empty(),
            "vacuity guard: the extracted body for {decl:?} is empty — the scanner \
             has rotted"
        );
        for needle in banned {
            assert!(
                !body.contains(needle),
                "TEETH(EG2-12 Guard warning): {decl:?}'s body contains {needle:?} — \
                 the auto-evolution path must NEVER be battle-guarded, trade-guarded \
                 or ownership-guarded. The battle row is still Ongoing at the \
                 write_back_battle_results call site, so this guard disables \
                 auto-evolution exactly where essence, Trust and level all change."
            );
        }
    }
}

/// EG2-11: `check_and_evolve` reads the DB `evolution_path` rows — the same
/// source `evolve()` and the EG4 client read — not the compile-time RON cache.
///
/// `content_cache::cached_evolution_paths()` is `#[cfg(test)]`-gated
/// (content_cache.rs:68) and reflects the SHIPPED content bundle, not the rows
/// `sync_content` actually seeded; auto-evolving off it would make the server
/// disagree with the public table every client subscribes to.
///
/// The positive half is what gives the ban teeth: without it, the "no
/// cached_evolution_paths(" assertion passes vacuously in a file that reads
/// nothing at all.
///
/// kills: an impl that reaches for the in-process content cache because it is
///        easier than the indexed table read; an impl that iterates the WHOLE
///        `evolution_path` table instead of the `from_species` btree index
///        (1,500-4,000+ rows at full roster scale, on the movement hot path).
#[test]
fn eg2_11_check_and_evolve_reads_db_rows_not_the_ron_cache() {
    let production = production_region(EVOLUTION_RS_SOURCE);
    assert!(
        !production.contains("cached_evolution_paths("),
        "TEETH(EG2-11/ADR-0175 D3): evolution.rs must not read \
         `cached_evolution_paths(` — the eligible-set query runs against the DB \
         `evolution_path` rows, the same source the reducer's targeted lookup and \
         the EG4 client panel use (the cache is #[cfg(test)]-gated and can \
         disagree with what sync_content actually seeded)"
    );

    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let body = extract_fn_body(&stripped, "pub(crate) fn check_and_evolve(");
    assert!(
        body.contains("evolution_path()"),
        "TEETH(EG2-11): `check_and_evolve`'s body must read the `evolution_path()` \
         table — otherwise the ban above is vacuous"
    );
    assert!(
        body.contains("from_species()"),
        "TEETH(EG2-11/EG1-4): the read must go through the `from_species()` btree \
         index, not a full-table scan — this runs on the movement hot path once \
         per party monster"
    );
    assert!(
        body.contains("evolution_path_from_row("),
        "TEETH(EG2-11): each DB row must be converted through the shared \
         `evolution_path_from_row(` marshaling helper (parse-don't-validate, \
         ADR-0174 D4) before the pure eligible-set query sees it"
    );
}

/// EG2-13 (termination): the chain carries an EXPLICIT hard iteration cap and is
/// never a bare `loop {}`.
///
/// The bound is structurally guaranteed today (R5's strict tier +1 plus R11's
/// tier cap 5), but the spec demands the defensive guard anyway, in case a future
/// change to R5/R11 breaks that guarantee — an unbounded loop in a WASM reducer
/// is a stuck transaction, not a slow one.
///
/// THE CASCADE ITSELF IS PINNED HERE, not just the constant: the seam tests
/// exercise the seam's own mirror of the loop, so if this scan only required
/// `MAX_EVOLUTION_CHAIN_STEPS` and a `log::error!` to EXIST, a production
/// `check_and_evolve` that applies ONE step and returns would pass every test in
/// this file. So the loop REGION is checked too: there must be a `while`, and
/// both the eligible-set query and the apply call must appear AFTER it.
///
/// HONEST LIMIT: this is a textual-position check, not a scope check. It proves
/// the query and the apply are not hoisted ABOVE the loop (the "compute
/// eligibility once, then spin a decorative counter" cheat); it cannot prove they
/// sit lexically INSIDE the loop body rather than after it. Combined with the
/// re-check-against-the-NEW-species semantics the seam pins
/// (`eg2_13_chain_three_single_eligible_steps_resolves_in_one_call`) and the
/// single-transform-path scan, that is the buildable guarantee at this layer.
///
/// kills: a recursive `check_and_evolve` (no counter to inspect, and a stack
///        overflow instead of a bounded stop); a bare `loop {}` with only a
///        `break` on 0-eligible (which never fires on cyclic content); a silent
///        stop at the cap with no operator signal that content is broken; a
///        one-shot `check_and_evolve` with no cascade at all; a cheat that
///        computes the eligible set ONCE before the loop and re-applies the same
///        stale index every iteration.
#[test]
fn eg2_13_chain_has_explicit_iteration_cap() {
    let production = production_region(EVOLUTION_RS_SOURCE);
    assert!(
        production.contains("MAX_EVOLUTION_CHAIN_STEPS: u32 = 7"),
        "TEETH(EG2-13/ADR-0175 D3): evolution.rs must declare \
         `MAX_EVOLUTION_CHAIN_STEPS: u32 = 7` — R11's tier cap 5 plus 2, generous \
         on purpose. The seam test \
         `eg2_13_iteration_cap_terminates_on_degenerate_cycle` pins the same value \
         behaviourally."
    );

    let stripped = strip_comments_and_strings(EVOLUTION_RS_SOURCE);
    let body = extract_fn_body(&stripped, "pub(crate) fn check_and_evolve(");
    assert!(
        body.contains("MAX_EVOLUTION_CHAIN_STEPS"),
        "TEETH(EG2-13): `check_and_evolve`'s body must reference \
         `MAX_EVOLUTION_CHAIN_STEPS` — a constant declared but never consulted is \
         not a bound"
    );
    assert!(
        !body.contains("loop {") && !body.contains("loop{"),
        "TEETH(EG2-13): the cascade must be a bounded iterative loop with an \
         explicit counter, NEVER a bare `loop {{ }}` — the spec calls the cap a \
         defensive guard precisely because the structural guarantee could be \
         relaxed by a future content-rule change"
    );
    assert!(
        body.contains("log::error!"),
        "TEETH(ADR-0175 D3): hitting the cap must emit a distinct `log::error!` — \
         reaching it means an R5/R11 invariant violation shipped in content, and a \
         silent stop would hide it forever"
    );

    // --- The cascade must actually LOOP over the decision ------------------
    assert!(
        body.contains("while "),
        "TEETH(EG2-13/ADR-0175 D3): `check_and_evolve`'s body must contain a \
         `while` loop — the chain is an ITERATIVE cascade with an explicit \
         counter. A body with no loop at all is a one-shot check: the monster \
         stops one form short of where its surviving level/Trust/Quality-Time \
         already qualify it, and NOTHING else in this file would notice, because \
         the seam tests drive the seam's own loop."
    );
    let while_pos = body.find("while ").expect("asserted present just above");
    let eligible_pos = body.find("eligible_evolution_paths(").expect(
        "vacuity: pinned by eg1_11_evolution_rs_production_region_has_no_inlined_gate_logic",
    );
    let apply_pos = body
        .find("apply_evolution(")
        .expect("vacuity: check_and_evolve must apply the single eligible path");
    assert!(
        eligible_pos > while_pos,
        "TEETH(EG2-13): the FIRST `eligible_evolution_paths(` call (byte \
         {eligible_pos}) precedes the loop (byte {while_pos}) — eligibility must be \
         recomputed FRESH on every iteration against the monster's NEW species. \
         Hoisting it above the loop is the cheat where a decorative counter spins \
         while the same stale eligible set is re-applied."
    );
    assert!(
        apply_pos > while_pos,
        "TEETH(EG2-13): the FIRST `apply_evolution(` call (byte {apply_pos}) \
         precedes the loop (byte {while_pos}) — the apply is the loop's BODY. One \
         apply before a counter loop is a one-shot evolution wearing a cascade's \
         clothes."
    );
}

// ---------------------------------------------------------------------------
// EG2-9 — no SCHEDULED reducer may call the growth helpers (directly, or one
// hop away through a wrapper).
//
// SEMANTICS: BOUNDED at ONE HOP, deliberately NOT full transitive reachability.
// The spec (EG2-9) spells out why full reachability is unbuildable here:
// `write_back_battle_results` — itself a growth writer and a `check_and_evolve`
// call site — is ALREADY legitimately reachable from the scheduled
// `movement_tick` (grass encounter -> battle -> level-up) and from
// `pvp_deadline_reaper` (apply_pvp_forfeit -> settle_pvp_battle). A transitive
// scan would false-positive on both REAL paths and would have to be weakened or
// deleted, which is exactly why `no-idle-accrual.eval.mjs` Check B is
// direct-call-only. Idle accrual through that reachable battle path is prevented
// by a different mechanism entirely — EG2-7's wild-battle-only exemption
// (practice and PvP grant nothing) — not by a callgraph rule.
//
// This companion test goes ONE HOP FURTHER THAN THE EVAL, because a direct-call
// scan is defeated by a two-line wrapper and that wrapper would have no backstop
// at all. The single hop is the strongest line that still avoids the
// write_back_battle_results false positive (which is handled by an explicit,
// argued allowlist entry rather than by weakening the rule).
// ---------------------------------------------------------------------------

/// Every production source scanned for scheduled reducers. Superset of the A3
/// file set: `playtest.rs` hosts `playtest_reaper` but calls no
/// `pub_from_monster`, so it belongs here and not there.
fn scheduled_scan_sources() -> [(&'static str, &'static str); 10] {
    [
        ("evolution.rs", EVOLUTION_RS_SOURCE),
        ("battle.rs", BATTLE_RS_SOURCE),
        ("content.rs", CONTENT_RS_SOURCE),
        ("monster_mgmt.rs", MONSTER_MGMT_RS_SOURCE),
        ("movement.rs", MOVEMENT_RS_SOURCE),
        ("playtest.rs", PLAYTEST_RS_SOURCE),
        ("pvp.rs", PVP_RS_SOURCE),
        ("raising.rs", RAISING_RS_SOURCE),
        ("taming.rs", TAMING_RS_SOURCE),
        ("trading.rs", TRADING_RS_SOURCE),
    ]
}

/// Every scheduled reducer NAME declared in `src`, read out of the
/// `#[spacetimedb::table(... scheduled(<name>))]` attribute — the same canonical
/// form `no-idle-accrual.eval.mjs`'s `findScheduledReducers` scans, ported to
/// Rust so the companion test and the eval agree on what "scheduled" means.
fn scheduled_reducer_names(stripped: &str) -> Vec<String> {
    const ATTR: &str = "#[spacetimedb::table(";
    const SCHED: &str = "scheduled(";
    let mut names = Vec::new();
    let mut pos = 0usize;
    while let Some(idx) = stripped[pos..].find(ATTR) {
        let attr_start = pos + idx;
        let args_start = attr_start + ATTR.len();
        // Walk to the `)` that closes the attribute's own paren.
        let mut depth: usize = 1;
        let mut attr_end = args_start;
        for (off, ch) in stripped[args_start..].char_indices() {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    attr_end = args_start + off;
                    break;
                }
            }
        }
        let attr_args = &stripped[args_start..attr_end];
        if let Some(sched_idx) = attr_args.find(SCHED) {
            let name: String = attr_args[sched_idx + SCHED.len()..]
                .chars()
                .take_while(|c| is_word_char(*c))
                .collect();
            if !name.is_empty() {
                names.push(name);
            }
        }
        pos = attr_end.max(args_start);
    }
    names
}

/// The body of `fn <name>(` in `stripped`, or `None` if the declaration is not
/// in the scanned sources. Non-panicking twin of `extract_fn_body` (a scheduled
/// reducer could legitimately live in a file this scan does not include — the
/// caller turns that into an explicit, informative failure).
fn find_named_fn_body(stripped: &str, name: &str) -> Option<String> {
    let qualified = format!("pub fn {name}(");
    let bare = format!("fn {name}(");
    let needle = if stripped.contains(&qualified) {
        qualified
    } else if stripped.contains(&bare) {
        bare
    } else {
        return None;
    };
    Some(extract_fn_body(stripped, &needle))
}

/// EG2-9 (hard invariant, PROOF-OF-TEETH): NO scheduled reducer's own body calls
/// `accrue_quality_time(` or `check_and_evolve(`.
///
/// This is the companion test the spec names beside `no-idle-accrual.eval.mjs`
/// Check B. Quality Time is "time spent actively playing WITH the monster" — the
/// moment a timer can credit it, a player enqueues a walk, tapes down a key and
/// farms Trust/Quality-Time/evolutions overnight. `movement_tick` is the standing
/// temptation: it is where tile entry is actually detected, which is exactly why
/// EG2-12 routes the hook to the player-triggered `enqueue_move` instead.
///
/// ONE-HOP CLOSURE (L1): a direct-call scan alone is trivially evaded by a
/// one-line wrapper —
/// `fn tick_accrue(ctx, id) { accrue_quality_time(ctx, id); }` called from
/// `movement_tick` — and unlike the legitimately-reachable
/// `write_back_battle_results` (backstopped by EG2-7's wild-battle-only
/// exemption, so a timer can reach it but never GRANT through it), such a wrapper
/// has no backstop whatsoever. So this test also collects L1 = every fn in the
/// scanned sources whose OWN body calls a growth helper, and forbids a scheduled
/// reducer from calling any of them, with a single documented allowlist entry.
/// `care`/`train`/`essence_train`/`consume_crystalized_essence`/`enqueue_move`
/// land in L1 by design (they are the five/six intent-path call sites) and are
/// deliberately NOT allowlisted: no scheduled reducer may call an intent reducer
/// either.
///
/// HONEST LIMIT: one hop, not full transitivity. Two-hop nesting (scheduled ->
/// A -> B -> helper) is not covered — deliberately, because full reachability
/// re-introduces the `write_back_battle_results` false positive that forced
/// `no-idle-accrual.eval.mjs` Check B into direct-call-only in the first place.
/// One hop is the strictly-stronger-than-the-eval line that stays free of that
/// false positive; Check A (growth writes confined to allowlisted writers)
/// remains the independent backstop at the write site itself.
///
/// ABSENCE-IS-FAIL, four ways:
///   1. at least one scheduled reducer must be discovered (`movement_tick` must
///      exist) — a rotted attribute scanner would otherwise pass vacuously;
///   2. every discovered scheduled reducer's body must be FOUND in the scanned
///      sources — a scheduled reducer in an un-included file would otherwise be
///      checked by nobody;
///   3. both banned helpers must EXIST in the scanned production sources — you
///      cannot prove a scheduled reducer does not call a function that has not
///      been written yet;
///   4. L1 must be non-empty — an empty wrapper set means the fn enumerator
///      rotted (the helpers exist, so somebody calls them).
///
/// kills: `movement_tick` (or any reaper) growing an `accrue_quality_time(` /
///        `check_and_evolve(` tail — the AFK-farming vector this whole invariant
///        exists to close; the one-line wrapper that hides that tail one call
///        away; a scan that silently misses a reaper because its file is not in
///        the include list.
#[test]
fn eg2_9_no_scheduled_reducer_body_calls_growth_triggers() {
    let stripped: String = scheduled_scan_sources()
        .iter()
        .map(|(_, src)| strip_comments_and_strings(src))
        .collect::<Vec<String>>()
        .join("\n");

    // (3) The ban must not be vacuous.
    for decl in ["fn accrue_quality_time(", "fn check_and_evolve("] {
        assert!(
            stripped.contains(decl),
            "vacuity guard(EG2-9): {decl:?} does not exist in the scanned \
             production sources — until both growth helpers are written, \
             asserting that no scheduled reducer calls them proves nothing"
        );
    }

    // (1) The attribute scanner must actually find the live scheduled reducers.
    let names = scheduled_reducer_names(&stripped);
    assert!(
        !names.is_empty(),
        "vacuity guard(EG2-9): no `#[spacetimedb::table(... scheduled(..))]` \
         declaration found — movement_tick must exist; the scanner has rotted"
    );
    for known in [
        "movement_tick",
        "pvp_deadline_reaper",
        "battle_challenge_reaper",
        "trade_offer_reaper",
        "playtest_reaper",
    ] {
        assert!(
            names.iter().any(|n| n.as_str() == known),
            "vacuity guard(EG2-9): the scheduled reducer {known:?} was not \
             discovered — either it was renamed/removed (update this list \
             consciously, the way GROWTH_WRITERS is updated) or the scan no longer \
             covers its file. Discovered: {names:?}"
        );
    }

    let banned = ["accrue_quality_time(", "check_and_evolve("];

    // L1 — every fn whose OWN body calls a growth helper (the wrapper set).
    // `write_back_battle_results` is the ONE documented legitimate entry: it is
    // already transitively reachable from movement_tick (grass encounter) and
    // pvp_deadline_reaper (forfeit funnel), and EG2-7's wild-battle-only
    // exemption — not a callgraph rule — is what prevents accrual through it.
    const L1_ALLOWED: [&str; 1] = ["write_back_battle_results"];
    let mut l1: Vec<String> = Vec::new();
    for (fn_name, fn_body) in enumerate_fn_bodies(&stripped) {
        if banned.iter().any(|needle| fn_body.contains(*needle)) && !l1.contains(&fn_name) {
            l1.push(fn_name);
        }
    }
    // (4) An empty wrapper set means the enumerator rotted, not that the code is
    // clean: the guards above already proved both helpers exist, so SOMETHING
    // calls them.
    assert!(
        !l1.is_empty(),
        "vacuity guard(EG2-9): no function in the scanned sources calls \
         `accrue_quality_time(`/`check_and_evolve(`, yet both are declared — the \
         fn enumerator has rotted and the one-hop closure below is meaningless"
    );

    for name in &names {
        // (2) A scheduled reducer whose body we cannot see is a hole, not a pass.
        let body = find_named_fn_body(&stripped, name).unwrap_or_else(|| {
            panic!(
                "vacuity guard(EG2-9): scheduled reducer {name:?} is declared but \
                 its `fn` body is not in the scanned source set — extend \
                 `scheduled_scan_sources()` with the file that defines it, \
                 otherwise this invariant silently skips it"
            )
        });
        for needle in banned {
            assert!(
                !body.contains(needle),
                "TEETH(EG2-9): the SCHEDULED reducer {name:?} directly calls \
                 {needle:?} in its own body. Quality-Time and auto-evolution may \
                 only be driven by deliberate player action: a timer-driven call \
                 lets a player tape down a movement key (or simply stay connected) \
                 and farm Trust / Quality-Time / evolutions while AFK. The hook \
                 belongs on `enqueue_move`, not `movement_tick` (EG2-12). \
                 (Direct-call only: `write_back_battle_results` staying \
                 transitively reachable from movement_tick/pvp_deadline_reaper is \
                 INTENDED — EG2-7's wild-battle-only exemption, not a callgraph \
                 rule, is what stops accrual there.)"
            );
        }
        // ONE HOP: no scheduled reducer may call a fn that calls a growth helper.
        for wrapper in &l1 {
            if L1_ALLOWED.contains(&wrapper.as_str()) || wrapper == name {
                continue;
            }
            assert!(
                !body_calls(&body, wrapper),
                "TEETH(EG2-9, one-hop): the SCHEDULED reducer {name:?} calls \
                 {wrapper:?}, whose own body calls `accrue_quality_time(` or \
                 `check_and_evolve(`. A one-line wrapper is the cheapest way to \
                 put growth back on a timer while passing a direct-call scan, and \
                 it has NO backstop: unlike `write_back_battle_results` (the sole \
                 allowlisted entry, whose credits are wild-battle-only per EG2-7), \
                 a wrapper around the helpers grants unconditionally. If \
                 {wrapper:?} is a NEW legitimately-reachable funnel, it needs its \
                 own documented exemption argument before it joins L1_ALLOWED — \
                 not a silent addition."
            );
        }
    }
}

// ===========================================================================
// A3 SOURCE SCAN — no call site may FABRICATE a MonsterPub tier.
//
// ADR-0174 D7 / plan amendment A3: the 9 copy-forward sites take the tier from
// the existing `monster_pub` row; a MISSING row is fail-loud (or the site's own
// missing-row convention) — NEVER `unwrap_or(0)` and never a literal 0. A
// fabricated tier 0 would silently demote an evolved monster to a base form in
// every client that reads the public projection.
//
// TWO CHECKS, because either alone is bypassable:
//   1. `fabricated_tier_violations` — the tier ARGUMENT of every
//      `pub_from_monster(..)` call.
//   2. `monster_pub_literal_violations` — any DIRECT `MonsterPub { … }`
//      construction outside marshal.rs. Without this, a site can dodge check 1
//      entirely by hand-building the public row (no `pub_from_monster` call for
//      the tier scan to inspect) — and the monster-dual-write eval only requires
//      that the STRING `pub_from_monster(` appear somewhere in the same fn body,
//      which a neighbouring legitimate call already provides. That is the joint
//      bypass this sibling check closes.
//
// (Deliberately NOT a call-site COUNT pin — amendment A11: the compiler and the
// monster-dual-write eval already cover the site set. These scan SHAPE only.)
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

/// Is `c` an identifier character (used for word-boundary checks)?
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// One violation string per DIRECT `MonsterPub { … }` construction (or a fn
/// returning one) outside `marshal.rs`. `[]` = clean.
///
/// `pub_from_monster` is the SINGLE projection point (derive-on-write, ADR-0016).
/// A hand-rolled `MonsterPub { … }` literal at a call site bypasses it entirely:
/// it neither takes the tier argument nor re-derives `trust_tier` /
/// `quality_time_tier` / `nutrition_pct`, so every A3 tier check and the
/// monster-dual-write eval's `pub_from_monster` requirement are both satisfied
/// on paper while the row is built by hand with a fabricated tier.
///
/// Word-boundary aware, so `StoreMonsterPubRow`/`MonsterPubSomething` and type
/// positions (`Vec<MonsterPub>`, `&MonsterPub)`) are never flagged; only
/// `MonsterPub` immediately followed by `{` is.
fn monster_pub_literal_violations(file: &str, src: &str) -> Vec<String> {
    let stripped = strip_rust_comments(src);
    let needle = "MonsterPub";
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(idx) = stripped[pos..].find(needle) {
        let start = pos + idx;
        let end = start + needle.len();
        pos = end;
        // Word boundary on the LEFT: `StoreMonsterPub` must not match.
        if start > 0 {
            let prev = stripped[..start]
                .chars()
                .next_back()
                .expect("start > 0 implies a preceding char");
            if is_word_char(prev) {
                continue;
            }
        }
        // The first non-whitespace char to the RIGHT must be `{` for this to be a
        // struct-literal construction (or a fn whose return type it is).
        let rest = stripped[end..].trim_start();
        if rest.starts_with('{') {
            out.push(format!(
                "{file}: a `MonsterPub {{ … }}` value is constructed directly — only \
                 marshal.rs may build a MonsterPub. Every call site must go through \
                 pub_from_monster(&Monster, tier), the single projection point \
                 (ADR-0016): a hand-rolled literal fabricates the tier and skips the \
                 trust_tier / quality_time_tier / nutrition_pct derivations"
            ));
        }
    }
    out
}

/// The production files that call `pub_from_monster`. `marshal.rs` is
/// DELIBERATELY excluded: it owns both the definition and the one legitimate
/// `MonsterPub { … }` literal.
fn scanned_production_files() -> [(&'static str, &'static str); 9] {
    [
        ("evolution.rs", EVOLUTION_RS_SOURCE),
        ("battle.rs", BATTLE_RS_SOURCE),
        ("content.rs", CONTENT_RS_SOURCE),
        ("monster_mgmt.rs", MONSTER_MGMT_RS_SOURCE),
        ("movement.rs", MOVEMENT_RS_SOURCE),
        ("pvp.rs", PVP_RS_SOURCE),
        ("raising.rs", RAISING_RS_SOURCE),
        ("taming.rs", TAMING_RS_SOURCE),
        ("trading.rs", TRADING_RS_SOURCE),
    ]
}

/// PROOF-OF-TEETH for `monster_pub_literal_violations`.
///
/// kills: a checker that misses the joint A3/dual-write bypass (build the public
///        row by hand with `tier: 0`, so no `pub_from_monster(.., 0)` call site
///        exists for the A3 scan to find); and an over-eager checker that flags
///        mere type mentions.
#[test]
fn a3_monster_pub_literal_checker_has_teeth() {
    // Bad: a hand-rolled public row with a fabricated tier and no derived fields.
    let bad_literal =
        "    let pub_row = MonsterPub {\n        monster_id: m.monster_id,\n        tier: 0,\n    };\n";
    assert!(
        !monster_pub_literal_violations("fixture", bad_literal).is_empty(),
        "TEETH: a direct MonsterPub literal must be flagged — this is the joint \
         A3/dual-write bypass (no pub_from_monster call exists to inspect, so the \
         tier scan sees nothing, yet the row carries a fabricated tier 0)"
    );

    // Bad: the same shape written with a fully qualified path.
    let bad_qualified = "    let p = crate::schema::MonsterPub { monster_id: 1, tier: 0 };\n";
    assert!(
        !monster_pub_literal_violations("fixture", bad_qualified).is_empty(),
        "TEETH: a path-qualified MonsterPub literal must be flagged too"
    );

    // Good: the projection helper (the only legal way outside marshal.rs).
    let good_helper = "    let pub_row = pub_from_monster(&m, existing_pub.tier);\n";
    assert!(
        monster_pub_literal_violations("fixture", good_helper).is_empty(),
        "the pub_from_monster projection must NOT be flagged"
    );

    // Good: type positions and longer identifiers are only MENTIONS, not
    // constructions.
    let good_type_positions = "    fn f(p: &MonsterPub) -> u8 { p.tier }\n    let v: Vec<MonsterPub> = vec![];\n    struct StoreMonsterPubRow { x: u8 }\n";
    assert!(
        monster_pub_literal_violations("fixture", good_type_positions).is_empty(),
        "type mentions (&MonsterPub, Vec<MonsterPub>) and longer identifiers \
         (StoreMonsterPubRow) must NOT be flagged — only `MonsterPub {{` is a \
         construction"
    );

    // Good: a comment describing the literal is not the literal.
    let good_comment = "    // Dual-write: build MonsterPub { .. } via the helper\n    let p = pub_from_monster(&m, sp.tier);\n";
    assert!(
        monster_pub_literal_violations("fixture", good_comment).is_empty(),
        "a COMMENTED mention must NOT be flagged (comments are stripped first)"
    );
}

/// A3 sibling (real files): no production file outside `marshal.rs` constructs a
/// `MonsterPub` directly.
///
/// kills: the joint bypass where a call site skips `pub_from_monster` altogether
///        and hand-builds the public row with a fabricated tier — invisible to
///        the tier-argument scan above.
#[test]
fn a3_no_production_file_constructs_monster_pub_directly() {
    let mut violations: Vec<String> = Vec::new();
    for (name, src) in scanned_production_files() {
        violations.extend(monster_pub_literal_violations(name, src));
    }

    // No vacuity guard on a mention count here: ZERO `MonsterPub` mentions across
    // these files is a legitimate (indeed ideal) state — every site goes through
    // the helper and never names the type. The checker's own teeth are proven by
    // the fixtures in `a3_monster_pub_literal_checker_has_teeth`.
    assert!(
        violations.is_empty(),
        "TEETH(A3 sibling): {} direct MonsterPub construction(s) outside marshal.rs:\n{}",
        violations.len(),
        violations.join("\n")
    );
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
    let mut violations: Vec<String> = Vec::new();
    let mut sites = 0usize;
    for (name, src) in scanned_production_files() {
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
    let Some(m) = db.get_monster(monster_id).cloned() else {
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
    let Some(path_row) = db
        .find_evolution_path(m.species_id, to_species)
        .map(copy_path_row)
    else {
        return Err(format!(
            "no such evolution: species {} has no path to species {to_species}",
            m.species_id
        ));
    };
    let path = crate::marshal::evolution_path_from_row(&path_row)?;

    let instance = crate::marshal::monster_to_instance(&m)?;

    // The SHARED gate predicate (EG1-11) makes the decision; game-core's
    // describer only turns a failure into a sentence. Both are pure and live in
    // game-core, so `evolution.rs` never touches a gate field.
    if !game_core::path_satisfied(&instance, &path) {
        return Err(game_core::unmet_requirement(&instance, &path)
            .unwrap_or_else(|| "evolution requirements not met".to_string()));
    }

    // EG2-11: the transform-and-write is DELEGATED — the disambiguation path and
    // the auto-evolution path apply an evolution through exactly one helper.
    apply_evolution_seam(db, monster_id, &path_row)
}

/// Pure `apply_evolution` seam: mirrors
/// `apply_evolution(ctx, monster_id, path: &EvolutionPathRow)` (EG2-11) against a
/// `TestEvolutionDb`.
///
/// Deliberately guard-free (EG2-12 Guard warning) and deliberately re-reading the
/// monster row itself: production takes only `(ctx, monster_id, path)`, so a
/// caller can never hand it a stale in-memory copy — which is what makes the
/// chain (EG2-13) safe to run step after step.
pub(crate) fn apply_evolution_seam(
    db: &mut TestEvolutionDb,
    monster_id: u64,
    path: &EvolutionPathRow,
) -> Result<(), String> {
    let Some(mut m) = db.get_monster(monster_id).cloned() else {
        return Err("monster not found".to_string());
    };
    let instance = crate::marshal::monster_to_instance(&m)?;

    // FRESH target-species lookup — the tier source (EG1-8) and the transform's
    // base stats both come from it.
    let Some(to_species_row) = db.get_species(path.to_species).cloned() else {
        return Err(format!("target species {} not found", path.to_species));
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

/// Pure `check_and_evolve` seam: mirrors `check_and_evolve(ctx, monster_id)`
/// (EG2-11/EG2-13) against a `TestEvolutionDb`.
///
/// Production returns `()`. This seam returns the number of chain steps applied
/// — the ONLY observable that distinguishes "cascaded once" from "cascaded three
/// times" from "spun to the cap", which is precisely what EG2-13 legislates. The
/// cap itself is the PRODUCTION constant, so the seam cannot encode a bound the
/// reducer does not have.
///
/// Mirrors production step for step: fresh find (missing -> silent stop), the
/// `from_species`-filtered DB rows converted through the REAL
/// `marshal::evolution_path_from_row`, the REAL
/// `game_core::eligible_evolution_paths`, 0 or 2+ -> stop, exactly 1 -> apply,
/// then loop against the NEW species. NO battle/trade/ownership guard (EG2-12).
pub(crate) fn check_and_evolve_seam(db: &mut TestEvolutionDb, monster_id: u64) -> usize {
    let cap = usize::try_from(crate::evolution::MAX_EVOLUTION_CHAIN_STEPS)
        .expect("the chain cap must fit a usize");
    let mut steps = 0usize;

    while steps < cap {
        // FRESH find every step — the row changed under us on the last one.
        let Some(m) = db.get_monster(monster_id).cloned() else {
            return steps;
        };
        // Candidate edges out of the monster's CURRENT species (the btree read).
        let mut candidate_rows: Vec<EvolutionPathRow> = Vec::new();
        let mut candidate_paths: Vec<game_core::EvolutionPath> = Vec::new();
        for row in db.paths_from_species(m.species_id) {
            // A corrupt row is skipped, never fatal: production logs and moves on
            // (this is a reducer TAIL — it must not fail the caller's write).
            if let Ok(path) = crate::marshal::evolution_path_from_row(&row) {
                candidate_rows.push(row);
                candidate_paths.push(path);
            }
        }
        let Ok(instance) = crate::marshal::monster_to_instance(&m) else {
            return steps;
        };

        // THE decision: the shared full-set query (EG2-11), never a hand-rolled
        // first-match. 0 -> chain ends; 2+ -> the player owns the choice (EG2-2).
        let eligible = game_core::eligible_evolution_paths(&instance, &candidate_paths);
        if eligible.len() != 1 {
            return steps;
        }
        if apply_evolution_seam(db, monster_id, &candidate_rows[eligible[0]]).is_err() {
            return steps;
        }
        steps += 1;
    }

    // Cap reached: production ALSO emits a distinct log::error! here (ADR-0175
    // D3) — an R5/R11 invariant violation shipped in content.
    steps
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

    /// The FULL-SET lookup (EG2-11): every outgoing edge of `from`, in insertion
    /// order. Mirrors the production `evolution_path().from_species().filter(..)`
    /// btree read that `check_and_evolve` collects into a Vec.
    ///
    /// Insertion order is load-bearing for the index semantics
    /// `eligible_evolution_paths` returns against
    /// (`check_and_evolve_ignores_unsatisfied_paths` depends on it).
    pub fn paths_from_species(&self, from: u32) -> Vec<EvolutionPathRow> {
        self.evolution_paths
            .iter()
            .filter(|p| p.from_species == from)
            .map(copy_path_row)
            .collect()
    }

    pub fn update_monster(&mut self, m: Monster) {
        self.monsters.insert(m.monster_id, m);
    }

    pub fn update_monster_pub(&mut self, p: MonsterPub) {
        self.monster_pubs.insert(p.monster_id, p);
    }
}
