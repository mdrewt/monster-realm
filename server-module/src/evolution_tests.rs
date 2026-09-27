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
//! `game_core::path_satisfied`, `game_core::unmet_requirement`). The REAL
//! reducer is driven by the native-host `nh` suite at the end of this file
//! (debloat Phase 2, which also deleted this file's source-text scans).
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
//!
//! WHAT 20r-d ADDS (ADR-0254, spec §20r-d B1 — the post-evolve notification):
//!   - `TestEvolutionDb` grows a `notices` list and an injected `now_ms`, and
//!     `apply_evolution_seam` pushes one reveal entry per applied edge — so
//!     "one entry per evolution, in chain order, keyed by the MONSTER's owner,
//!     stamped with the transaction clock" is BEHAVIOURAL, not textual.
//!   - The three LIFECYCLE helpers run against real rows (`erase`/`rekey` in
//!     the `nh` suite), and `has_evolution_notices` BEHAVIOURALLY — including the
//!     empty-entries row that makes ROW-EXISTS distinguishable from
//!     entries-non-empty, and the `accounts::account_has_game_data` disjunct
//!     that consumes it.
//!   - The pure `crate::evolution::ack_prefix` is executed directly (reject 0,
//!     reject count > len, drain the exact prefix), and the REAL
//!     `ack_evolution_notices` reducer is executed against the rb-41 native
//!     host for its three REFUSAL paths (the admitted path runs in `nh`).
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
// out of the server layer keeps every gate read in the shared rules layer.
//
// Its own contract tests — `None` exactly when `path_satisfied` is true, and the
// per-gate keyword/threshold vocabulary — live in game-core alongside it. This
// file exercises it only through the seam, where it is the reducer's rejection
// message (`evolve_rejects_names_the_failing_requirement`).
// ===========================================================================

// ---------------------------------------------------------------------------
// Test seam — `evolve_seam` lives HERE (not in evolution.rs): it is test
// infrastructure, not production code.
//
// It mirrors the `evolve` reducer step for step, calling the REAL production
// guards, marshaling helpers, gate predicate, and requirement describer; only
// the `ctx.db` accessors are replaced by `TestEvolutionDb`. It is a hand copy
// (drift risk); the `nh` suite at the end of this file runs the REAL reducer.
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

    // 20r-d (ADR-0254 D4): bind the owner and the transaction stamp BEFORE the
    // write-back moves `m` — production binds `owner` immediately after its own
    // `find` for exactly this reason.
    let owner = m.owner_identity;
    let stamp = db.now_ms;

    // Dual-write, with the tier from the FRESH target species row.
    let pub_row = crate::marshal::pub_from_monster(&m, to_species_row.tier);
    db.update_monster(m);
    db.update_monster_pub(pub_row);

    // 20r-d (ADR-0254 D4): ONE reveal entry per applied edge, AFTER the
    // dual-write and inside the same helper (= the same transaction in
    // production). The species come from the IMMUTABLE `path` argument, never
    // from the monster row — the row has already been transformed above, so
    // reading `m.species_id` for `from_species` would record the POST species
    // as the pre-evolution form. The owner is the MONSTER's owner: the auto
    // path is reachable from `pvp_deadline_reaper`, whose sender is the
    // scheduler, so a sender-keyed write would file the reveal under an
    // identity that owns nothing.
    db.push_notice(
        owner,
        crate::schema::EvolutionRevealRow {
            monster_id,
            from_species: path.from_species,
            to_species: path.to_species,
            evolved_at_ms: stamp,
        },
    );

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
    /// 20r-d (ADR-0254 D4): the `pending_evolution_notice` table, one row per
    /// owner. A `Vec` and not a `HashMap<Identity, _>` ON PURPOSE — the row is
    /// found by an `owner_identity` comparison, which needs only the `PartialEq`
    /// this file already relies on (`m.owner_identity != sender` in
    /// `evolve_seam`), so the fake cannot fail to compile for a reason that has
    /// nothing to do with the behaviour under test. At most one row per owner is
    /// an INVARIANT of `push_notice` below, exactly as the PK is in production.
    pub notices: Vec<crate::schema::PendingEvolutionNotice>,
    /// 20r-d: the injected transaction clock. Production stamps every entry with
    /// `crate::marshal::now_ms(ctx)`, which is constant within one reducer call —
    /// so ONE value per seam run is the faithful model, and it is what makes
    /// "the stamp is the transaction clock, not a per-step wall-clock read"
    /// observable at all.
    pub now_ms: i64,
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
            notices: vec![],
            now_ms: 0,
            next_monster_id: 100,
        }
    }

    /// 20r-d (ADR-0254 D4): append ONE reveal entry to `owner`'s notice row,
    /// creating the row when the owner holds none. Mirrors production's
    /// find-then-push-or-insert upsert; never replaces an existing entry list
    /// (a replace is the "second evolution loses the first" bug).
    pub fn push_notice(&mut self, owner: Identity, entry: crate::schema::EvolutionRevealRow) {
        if let Some(row) = self.notices.iter_mut().find(|r| r.owner_identity == owner) {
            row.entries.push(entry);
            return;
        }
        self.notices.push(crate::schema::PendingEvolutionNotice {
            owner_identity: owner,
            entries: vec![entry],
        });
    }

    /// 20r-d: `owner`'s pending reveal entries, in Vec order (= display order,
    /// EG2-13). An owner with no row reads as an EMPTY list, never a panic — the
    /// distinction the tests below rely on when they assert that a notice is
    /// keyed by the MONSTER's owner and by nobody else.
    pub fn notices_for(&self, owner: Identity) -> Vec<crate::schema::EvolutionRevealRow> {
        self.notices
            .iter()
            .find(|r| r.owner_identity == owner)
            .map(|r| r.entries.clone())
            .unwrap_or_default()
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

// ===========================================================================
// 20r-d (ADR-0254) — POST-EVOLVE NOTIFICATION. EARS B1, server half.
//
// EARS criterion covered (spec M-postgate-twentieth-review-residuals §20r-d B1):
//   WHEN a monster evolves (player-invoked OR auto), an evolution reveal record
//   SHALL be written to the owner's pending-notification queue in the SAME
//   transaction, and the owner SHALL be able to acknowledge a prefix of it.
//
// WITNESSES: the SEAM observes "one entry per applied edge, in chain order,
// stamped with the transaction clock, filed under the MONSTER's owner"; the
// real `ack_prefix` truth table and the `ack_evolution_notices` refusal paths
// run below against the native host; the `nh` suite at the end of this file
// runs the REAL evolve / check_and_evolve / ack / rekey / erase paths
// (success included) against it.
// ===========================================================================

/// One `EvolutionRevealRow` fixture. Every field DISTINCT and non-default so a
/// field-swap (`from_species` written into `to_species`, `monster_id` written
/// into `evolved_at_ms`) is visible rather than masked by shared zeros.
fn s20rd_reveal(
    monster_id: u64,
    from_species: u32,
    to_species: u32,
    evolved_at_ms: i64,
) -> crate::schema::EvolutionRevealRow {
    crate::schema::EvolutionRevealRow {
        monster_id,
        from_species,
        to_species,
        evolved_at_ms,
    }
}

/// The `(from_species, to_species)` pairs of `owner`'s notice entries, in Vec
/// order — the shape the chain test reasons about (Vec order IS display order,
/// EG2-13).
fn s20rd_pairs(db: &TestEvolutionDb, owner: Identity) -> Vec<(u32, u32)> {
    db.notices_for(owner)
        .iter()
        .map(|e| (e.from_species, e.to_species))
        .collect()
}

// ---------------------------------------------------------------------------
// T1 — EXECUTED: the pure prefix-drain core.
//
// THE THREE REJECTION MESSAGES ARE PINNED WHOLE, NOT BY SUBSTRING.
//
// WHY (and this is not tidiness): the CLIENT classifies these messages. Two of
// them — the missing row and the over-count — are SWALLOWED by
// `isBenignAckRejection` as benign two-tab races; the third, the zero count, is
// a client defect and must reach the status line. A `contains("exceeds")` pin
// leaves the rest of the sentence free to drift, and the moment it does the
// client's transcription stops matching: both benign races start surfacing as
// errors, and no test in either half notices. The client fixtures in
// `client/src/ui/evolutionNotice.test.ts` (EN-BENIGN-1) are TRANSCRIPTIONS of
// exactly these five literals.
//
// THE THREE `exceeds` LITERALS CARRY DIFFERENT NUMBERS ON PURPOSE: an
// implementation that returns a CONSTANT over-count message (the easiest way to
// make a substring pin green) satisfies at most one of them.
// ---------------------------------------------------------------------------

/// `count == 0`. NOT benign on the client — a zero count can only come from a
/// client bug, so this one must reach the player-facing status line.
const S20RD_ERR_ZERO_COUNT: &str = "ack count must be positive";
/// No row for the caller. Benign on the client (a second tab already drained).
const S20RD_ERR_NO_ROW: &str = "no pending evolution notices";
/// `ack count {count} exceeds {len} pending evolution notices`, at the three
/// (count, len) pairs the tests below exercise. Spelled as three INDEPENDENT
/// literals rather than one `format!` helper: a helper shared with the
/// implementation would make a single mis-transcription pass every arm.
const S20RD_ERR_4_OF_3: &str = "ack count 4 exceeds 3 pending evolution notices";
const S20RD_ERR_1_OF_0: &str = "ack count 1 exceeds 0 pending evolution notices";
const S20RD_ERR_3_OF_2: &str = "ack count 3 exceeds 2 pending evolution notices";

/// 20r-d (ADR-0254 D5): the REAL `crate::evolution::ack_prefix` truth table.
///
/// NO MIRROR: this executes the shipped production function. A seam copy could
/// drift from it silently, and the arithmetic IS the criterion ("acknowledge a
/// prefix").
///
/// kills:
///  - `count == 0` accepted as a no-op success: the client's benign-rejection
///    filter would then never see the bug that produced a zero count, and a
///    zero-count ack is always a client defect worth surfacing;
///  - `count > len` CLAMPED instead of rejected (the ADR's named anti-pattern):
///    a stale banner in a second tab would drain entries that tab never showed;
///  - `drain(..1)` / `remove(0)` ignoring `count` entirely — the `count == len`
///    and `count < len` arms both catch it;
///  - draining from the TAIL (`truncate`, `split_off`, `pop`) — the surviving
///    suffix is pinned by value, so a tail drain lands on the wrong entries;
///  - a rejected call that still mutates: both rejection arms assert the vector
///    is byte-identical afterwards;
///  - a REWORDED rejection: all three messages are compared WHOLE, and the client
///    fixtures are transcriptions of the same literals, so wording drift cannot
///    silently move a benign race into the player-facing status line (or hide a
///    real client bug out of it);
///  - a CONSTANT over-count message, or a transposed `{len} exceeds {count}`:
///    the 4-of-3 and 1-of-0 arms carry different numbers, so at most one of the
///    two can be satisfied by a fixed or reversed sentence.
#[test]
fn s20rd_ack_prefix_truth_table() {
    let a = s20rd_reveal(11, 1, 2, 100);
    let b = s20rd_reveal(12, 2, 3, 200);
    let c = s20rd_reveal(13, 3, 4, 300);

    // --- count == 0 -> Err, vector untouched --------------------------------
    let mut entries = vec![a.clone(), b.clone(), c.clone()];
    let err = crate::evolution::ack_prefix(&mut entries, 0)
        .expect_err("TEETH(20r-d): a zero count must be REJECTED, never a silent no-op success");
    assert_eq!(
        err, S20RD_ERR_ZERO_COUNT,
        "TEETH(20r-d ADR-0254 D5): the zero-count rejection must be EXACTLY \
         {S20RD_ERR_ZERO_COUNT:?}; got {err:?}. Pinned WHOLE, not by substring: the \
         client's `isBenignAckRejection` deliberately does NOT swallow this one (a \
         zero count can only come from a client bug), so any drift in the wording \
         silently changes which rejections the player is told about"
    );
    assert_eq!(
        entries,
        vec![a.clone(), b.clone(), c.clone()],
        "TEETH(20r-d): a REJECTED ack must leave the entry list byte-identical — a \
         reject-then-drain implementation loses a reveal the player never saw"
    );

    // --- count > len -> Err, vector untouched -------------------------------
    let mut entries = vec![a.clone(), b.clone(), c.clone()];
    let err = crate::evolution::ack_prefix(&mut entries, 4)
        .expect_err("TEETH(20r-d): a count above the queue length must be REJECTED, never clamped");
    assert_eq!(
        err, S20RD_ERR_4_OF_3,
        "TEETH(20r-d ADR-0254 D5): acking 4 of 3 must reject with EXACTLY \
         {S20RD_ERR_4_OF_3:?}; got {err:?}. BOTH numbers are interpolated from the \
         call, so a CONSTANT message (the cheapest way to satisfy a \
         `contains(\"exceeds\")` pin) reds here or at the 1-of-0 arm below, and a \
         transposed `{{len}} exceeds {{count}}` reads 3-exceeds-4 and reds too. The \
         client swallows exactly this sentence as a benign two-tab race"
    );
    assert_eq!(
        entries,
        vec![a.clone(), b.clone(), c.clone()],
        "TEETH(20r-d): an over-count ack must leave the entry list untouched. A \
         CLAMPING implementation empties it here — silently discarding reveals the \
         player never saw, which is the whole reason D5 says reject-not-clamp"
    );

    // --- count == len -> Ok, emptied ----------------------------------------
    let mut entries = vec![a.clone(), b.clone(), c.clone()];
    crate::evolution::ack_prefix(&mut entries, 3)
        .expect("TEETH(20r-d): acking the whole queue must succeed");
    assert!(
        entries.is_empty(),
        "TEETH(20r-d): acking `count == len` must leave an EMPTY list (the row \
         itself survives — only the account cascade deletes it). Found: {entries:?}"
    );

    // --- count < len -> Ok, the EXACT surviving suffix ----------------------
    let mut entries = vec![a.clone(), b.clone(), c.clone()];
    crate::evolution::ack_prefix(&mut entries, 1)
        .expect("TEETH(20r-d): acking one of three must succeed");
    assert_eq!(
        entries,
        vec![b.clone(), c.clone()],
        "TEETH(20r-d ADR-0254 D5): acking 1 of 3 must drain the FIRST entry and \
         leave exactly the remaining two, in order. A tail drain (`truncate`, \
         `pop`, `split_off`) leaves [a, b]; a whole-list clear leaves []; an \
         off-by-one leaves [c]. Vec order IS display order (EG2-13), so the \
         surviving suffix is what the banner shows next"
    );

    // --- two-step drain: the prefix rule composes ---------------------------
    crate::evolution::ack_prefix(&mut entries, 2)
        .expect("TEETH(20r-d): acking the remaining two must succeed");
    assert!(
        entries.is_empty(),
        "TEETH(20r-d): draining the remaining suffix must empty the list. Found: \
         {entries:?}"
    );
    let err = crate::evolution::ack_prefix(&mut entries, 1)
        .expect_err("TEETH(20r-d): acking an EMPTY queue must reject (1 exceeds 0)");
    assert_eq!(
        err, S20RD_ERR_1_OF_0,
        "TEETH(20r-d): acking an empty queue is the `count > len` arm with len 0, and \
         its message must be EXACTLY {S20RD_ERR_1_OF_0:?}; got {err:?}. This is the \
         SECOND (count, len) pair: together with the 4-of-3 arm above it proves both \
         numbers are interpolated from the call rather than baked into a literal, \
         and it proves the empty queue takes the over-count arm and not a separate, \
         differently-worded 'queue is empty' path the client would not recognise"
    );
}

// ---------------------------------------------------------------------------
// T2 — BEHAVIOURAL: the seam.
//
// ⚠ HONESTY, STATED ONCE FOR THE THREE `s20rd_seam_*` TESTS BELOW. The seam is a
// MIRROR of production, not production. `apply_evolution_seam` carries its own
// copy of the notice push (added by this slice, a few hundred lines above), so a
// production `apply_evolution` that writes NO notice at all leaves all three
// tests GREEN. What they prove is the SHAPE of the write — one entry per applied
// edge, in chain order, pre/post species off the immutable `path`, one shared
// transaction stamp, filed under the MONSTER's owner and nobody else's — which
// is precisely what no source scan can see and what the wasm-only production
// path cannot be executed for in `cargo test`.
//
// THE WRITE SITE ITSELF IS PROVEN ELSEWHERE, and that split is load-bearing:
//   * `s20rd_apply_evolution_writes_the_notice_after_the_dual_write` pins that
//     production's `apply_evolution` performs the push at all, after the
//     dual-write, from the `path` argument, under the monster row's owner;
//   * `s20rd_pending_evolution_notice_accessor_census` pins that no OTHER
//     production file writes the table behind its back;
//   * the `S9-evolve-notice` milestone in `evals/account-e2e.eval.mjs` drives a
//     REAL evolve reducer against a live host and polls the view for the row.
// Read the three together; none of them substitutes for another.
// ---------------------------------------------------------------------------

/// 20r-d (ADR-0254 D4): a player-invoked evolution appends EXACTLY ONE reveal
/// entry, carrying the pre/post species from the authored edge, the monster id,
/// and the transaction clock — filed under the MONSTER's owner.
///
/// kills: zero entries (the feature absent); two entries (a push in both
///        `apply_evolution` and `evolve`, so the chain tail would double every
///        step); `from_species` captured AFTER the transform (it would read 2);
///        a wall-clock read instead of the injected transaction clock (the
///        stamp would not be 4242); a notice filed under an identity other than
///        the monster's owner.
#[test]
fn s20rd_seam_player_evolve_writes_one_notice() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.now_ms = 4242;
    seed_evolvable_world(&mut db, 1, owner);

    evolve_seam(&mut db, owner, 1, 2).expect("a fully qualified monster must evolve");

    let entries = db.notices_for(owner);
    assert_eq!(
        entries.len(),
        1,
        "TEETH(20r-d ADR-0254 D4): ONE evolution must append EXACTLY ONE reveal \
         entry. Zero means nothing is written (the §20r-d defect, unfixed); two \
         means the push happens on BOTH the reducer and the shared helper, so a \
         3-step chain would show six reveals. Found: {entries:?}"
    );
    assert_eq!(
        entries[0],
        s20rd_reveal(1, 1, 2, 4242),
        "TEETH(20r-d ADR-0254 D4): the entry must be exactly \
         {{ monster_id: 1, from_species: 1, to_species: 2, evolved_at_ms: 4242 }}. \
         A `from_species` read off the monster row AFTER the transform yields 2 (the \
         banner would say \"evolved from X into X\"); a wall-clock stamp yields \
         something other than the injected 4242"
    );
    assert!(
        db.notices_for(other_owner_id()).is_empty(),
        "TEETH(20r-d): no OTHER identity may receive a copy of the reveal"
    );
}

/// 20r-d (ADR-0254 D4 + EG2-13): a 3-step auto-evolution chain appends THREE
/// entries whose (from, to) pairs are the three applied edges IN ORDER, all
/// stamped with the SAME transaction clock, all filed under the monster's owner.
///
/// THE AUTO PATH IS THE SENDER-INDEPENDENCE WITNESS: `check_and_evolve_seam`
/// takes no caller at all, exactly as production's `check_and_evolve(ctx,
/// monster_id)` gets its sender from a `ReducerContext` that, at the
/// `pvp_deadline_reaper` call site, belongs to the SCHEDULER. The entries must
/// still land on the monster's owner, and on nobody else — including the
/// all-zero identity a sender-keyed implementation would use in a native test.
///
/// kills: a chain that writes one entry for the whole cascade (the player would
///        be told about the first step and never the other two); entries in
///        reverse order (Vec order IS display order, EG2-13); a per-step clock
///        read (the three stamps would differ); the sender-keyed owner.
#[test]
fn s20rd_seam_auto_evolve_chain_writes_entries_in_order() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.now_ms = 909_090;
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

    let steps = check_and_evolve_seam(&mut db, 1);
    assert_eq!(
        steps, 3,
        "the 3-step chain must resolve in ONE call (EG2-13)"
    );

    assert_eq!(
        s20rd_pairs(&db, owner),
        vec![(1, 2), (2, 3), (3, 4)],
        "TEETH(20r-d ADR-0254 D4 / EG2-13): a 3-step chain must append THREE entries \
         whose (from, to) pairs are the three applied edges IN ORDER. One entry means \
         only the first (or last) step is announced; a reversed list means the banner \
         walks the chain backwards, since Vec order IS display order"
    );
    for (i, entry) in db.notices_for(owner).iter().enumerate() {
        assert_eq!(
            entry.monster_id, 1,
            "TEETH(20r-d): entry {i} must name the monster that evolved"
        );
        assert_eq!(
            entry.evolved_at_ms, 909_090,
            "TEETH(20r-d ADR-0254 D1): entry {i} must carry the TRANSACTION clock — \
             every entry of one chain shares one stamp. A per-step wall-clock read \
             would make the stamps differ, and the ADR is explicit that the stamp is \
             display metadata, never an ordering or dedupe key"
        );
    }
    assert!(
        db.notices_for(other_owner_id()).is_empty(),
        "TEETH(20r-d): a second identity must receive nothing"
    );
    assert!(
        db.notices_for(Identity::from_byte_array([0u8; 32]))
            .is_empty(),
        "TEETH(20r-d ADR-0254 D4): NOTHING may be filed under the all-zero identity. \
         The auto path has no caller of its own, so an implementation that keys the \
         write on `ctx.sender()` files the whole chain under whichever identity \
         happens to be driving the reducer — the pvp deadline SCHEDULER in \
         production, and the all-zero dummy sender in a native test"
    );
}

/// 20r-d (ADR-0254 D4): a SECOND evolution APPENDS to the owner's existing row —
/// it never replaces the entry list and never opens a second row.
///
/// kills: an upsert that writes `entries: vec![entry]` on the update arm (the
///        first reveal is lost, so a player who evolves twice before dismissing
///        only ever learns about the second); an insert-always implementation,
///        which in production is a primary-key PANIC (a wasm trap that aborts
///        the HOST reducer).
#[test]
fn s20rd_seam_second_evolution_appends_not_replaces() {
    let owner = owner_id();
    let mut db = TestEvolutionDb::new();
    db.now_ms = 77;
    db.insert_species(source_species_row()); // 1
    db.insert_species(target_species_row()); // 2
    db.insert_species(make_species_row(3, 40, 60, 2));
    let m = make_qualified_monster_row(1, owner);
    db.insert_monster(m.clone());
    db.insert_monster_pub(make_monster_pub(&m, 0));

    apply_evolution_seam(&mut db, 1, &make_evolution_path_row(1, 100, 1, 2))
        .expect("the first evolution must apply");
    assert_eq!(
        db.notices_for(owner).len(),
        1,
        "precondition: the first evolution appends one entry"
    );

    apply_evolution_seam(&mut db, 1, &make_level_only_path_row(2, 101, 2, 3, 20))
        .expect("the second evolution must apply");

    assert_eq!(
        db.notices_for(owner),
        vec![s20rd_reveal(1, 1, 2, 77), s20rd_reveal(1, 2, 3, 77)],
        "TEETH(20r-d ADR-0254 D4): the second evolution must APPEND — the owner's row \
         must hold BOTH reveals, oldest first. A `entries: vec![entry]` write on the \
         existing-row arm leaves only the 1->2 reveal's successor and silently drops \
         the reveal the player had not dismissed yet"
    );
    assert_eq!(
        db.notices.len(),
        1,
        "TEETH(20r-d ADR-0254 D4): the owner must hold EXACTLY ONE row. A second row \
         for the same owner is what a bare `.insert` produces — and in production \
         that is a primary-key PANIC, i.e. a wasm trap that aborts the HOST reducer \
         (the player's movement or battle write is rolled back by their own second \
         evolution)"
    );
}

// ---------------------------------------------------------------------------
// T2 — EXECUTED: the ack reducer's three refusal paths (rb-41 native host).
//
// The dummy sender is the ALL-ZERO identity (native_host_tests.rs module doc),
// so "the caller's row" is seeded under `[0u8; 32]` and "somebody else's row"
// under `[1u8; 32]`. Every WRITE syscall aborts the PROCESS, so only paths that
// return `Err` BEFORE the `.update(` are executable here — which is exactly the
// set of refusals D5 legislates. `database_identity()` is unstubbed in this host
// and is never reached by this reducer.
// ---------------------------------------------------------------------------

/// 20r-d (ADR-0254 D5): `ack_evolution_notices` refuses when the CALLER holds no
/// row, even while another player's queue is non-empty.
///
/// kills: an ack that acts on the first row of the table instead of the sender's
///        (one player could drain another player's queue); an ack that treats a
///        missing row as success (the client would clear a banner it never
///        acked); an `unwrap()` on the find (a wasm trap).
#[test]
fn s20rd_ack_rejects_when_no_row_for_sender() {
    let fx = crate::native_host_tests::fixture();
    let table = ["pending", "_evolution_notice"].concat();
    let column = ["owner", "_identity"].concat();
    let handle =
        fx.table::<crate::schema::PendingEvolutionNotice>(&table, &column, |r| r.owner_identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    let stranger = Identity::from_byte_array([1u8; 32]);
    assert_ne!(
        stranger, me,
        "fixture(20r-d): the stranger identity must differ from the host's dummy \
         sender, or this test proves nothing about owner scoping"
    );

    // A STRANGER holds a non-empty queue; the CALLER holds nothing.
    handle.seed(&crate::schema::PendingEvolutionNotice {
        owner_identity: stranger,
        entries: vec![s20rd_reveal(9_001, 1, 2, 5)],
    });

    let err = crate::evolution::ack_evolution_notices(&ctx, 1).expect_err(
        "TEETH(20r-d ADR-0254 D5): a caller with no notice row must be REJECTED. A \
         success here means the reducer acted on whatever row it found first, which \
         is one player draining another player's queue",
    );
    assert_eq!(
        err,
        S20RD_ERR_NO_ROW,
        "TEETH(20r-d ADR-0254 D5): the missing-row rejection must be EXACTLY \
         {S20RD_ERR_NO_ROW:?}; got {err:?}. Pinned WHOLE: the client swallows this \
         exact sentence as a benign stale-banner race, so a reworded message turns \
         a normal two-tab race into a player-facing error and no test on either \
         side of the wire would notice. Indexes the generated code asked the host \
         for: {:?}",
        fx.requested_indexes()
    );
}

/// 20r-d (ADR-0254 D5): a ZERO count is refused even though the caller's row
/// exists and is non-empty.
///
/// kills: `count == 0` treated as a no-op success (a client bug that sends zero
///        would be invisible forever); a `count.max(1)` normalisation.
#[test]
fn s20rd_ack_rejects_zero_count() {
    let fx = crate::native_host_tests::fixture();
    let table = ["pending", "_evolution_notice"].concat();
    let column = ["owner", "_identity"].concat();
    let handle =
        fx.table::<crate::schema::PendingEvolutionNotice>(&table, &column, |r| r.owner_identity);
    let ctx = fx.ctx();

    // Seeded under the CALLER's own identity (never a hard-coded byte array), so
    // the reducer's sender-keyed `find` resolves and the rejection under test is
    // the COUNT check rather than a missing row.
    handle.seed(&crate::schema::PendingEvolutionNotice {
        owner_identity: ctx.sender(),
        entries: vec![s20rd_reveal(9_001, 1, 2, 5), s20rd_reveal(9_002, 2, 3, 5)],
    });

    let err = crate::evolution::ack_evolution_notices(&ctx, 0).expect_err(
        "TEETH(20r-d ADR-0254 D5): a zero count must be REJECTED even for a caller \
         whose queue exists — reject, never clamp, never no-op",
    );
    assert_eq!(
        err,
        S20RD_ERR_ZERO_COUNT,
        "TEETH(20r-d): the zero-count rejection must be EXACTLY \
         {S20RD_ERR_ZERO_COUNT:?}; got {err:?}. This is the ONE rejection the client \
         does NOT swallow, so its wording is what decides whether a client bug that \
         sends `count: 0` is ever seen. Indexes the generated code asked the host \
         for: {:?}",
        fx.requested_indexes()
    );
}

/// 20r-d (ADR-0254 D5): a count ABOVE the caller's queue length is refused
/// rather than clamped.
///
/// PROOF-OF-TEETH: the caller's queue holds exactly two entries and the count is
/// three, so a CLAMPING implementation succeeds here — and, because the success
/// path reaches `.update(`, the native host would ABORT the process rather than
/// return. Either way this test does not pass for a clamping implementation; the
/// `Err` assertion is what makes the distinction legible.
///
/// kills: `count.min(entries.len())`, `entries.clear()`, `drain(..)` — every
///        shape that silently discards reveals the client never rendered.
#[test]
fn s20rd_ack_rejects_count_above_len() {
    let fx = crate::native_host_tests::fixture();
    let table = ["pending", "_evolution_notice"].concat();
    let column = ["owner", "_identity"].concat();
    let handle =
        fx.table::<crate::schema::PendingEvolutionNotice>(&table, &column, |r| r.owner_identity);
    let ctx = fx.ctx();

    // The CALLER's own row, holding exactly TWO entries.
    handle.seed(&crate::schema::PendingEvolutionNotice {
        owner_identity: ctx.sender(),
        entries: vec![s20rd_reveal(9_001, 1, 2, 5), s20rd_reveal(9_002, 2, 3, 5)],
    });

    let err = crate::evolution::ack_evolution_notices(&ctx, 3).expect_err(
        "TEETH(20r-d ADR-0254 D5): acking 3 of 2 must be REJECTED. A clamping \
         implementation drains both entries and returns Ok — silently discarding a \
         reveal the player never saw, which is the exact anti-pattern the ADR names",
    );
    assert_eq!(
        err,
        S20RD_ERR_3_OF_2,
        "TEETH(20r-d): acking 3 of 2 must reject with EXACTLY {S20RD_ERR_3_OF_2:?}; \
         got {err:?}. THE THIRD (count, len) PAIR — this one is produced by the REAL \
         reducer against REAL rows, so together with the 4-of-3 and 1-of-0 pairs in \
         the truth table it proves both numbers come from the call and from the \
         row, not from a literal. The client swallows this exact sentence as a \
         benign two-tab race. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

/// 20r-d (ADR-0254 D5): `has_evolution_notices` answers ROW-EXISTS, per ASKED
/// owner, from LIVE rows — and the guest-claim predicate consumes it.
///
/// WHY THIS ONE IS EXECUTABLE WHERE ITS TWO SIBLINGS ARE NOT: it is READ-ONLY,
/// so it never reaches the unmodelled write syscalls that abort the rb-41 native
/// host. That makes it the only lifecycle helper whose BEHAVIOUR can be proven
/// in `cargo test`, and the only one where a hollowed body ("perform the read,
/// then return a constant") is invisible to every source scan — the exact
/// ADR-0222 known-limit rb-41 exists to close.
///
/// THE EMPTY-ENTRIES ROW IS THE WHOLE POINT. An ack NEVER deletes the row (an
/// empty `Vec` persists, like `player_wallet` — ADR-0254 D4), so "row present,
/// entries empty" is the NORMAL state of every player who has dismissed their
/// last reveal. If this predicate answered `!entries.is_empty()` it would drop
/// that player out of `account_has_game_data`, and `complete_guest_claim`'s
/// guard 11 would then admit a claim whose rekey inserts INTO an occupied
/// primary key — a wasm trap on a path the player cannot retry. That is what
/// makes the no-merge rekey sound, and it is why D5 says ROW-EXISTS in as many
/// words.
///
/// THE ASKED OWNER IS `[1u8; 32]`, NEVER THE DUMMY SENDER. The native host's
/// `ctx.sender()` is the all-zero identity, so a body keyed on the SENDER rather
/// than on its `owner` ARGUMENT would pass against an owner of `[0u8; 32]` and
/// fail here — which is the point (the cascade and the guest claim both call
/// this for somebody who is not the caller).
///
/// kills:
///  - the ADR-0222 known-limit hollow, `{ let _ = <the read>; false }`: the
///    owner-row assertion goes red while every source scan stays green;
///  - the inverted hollow, `{ let _ = <the read>; true }`: the empty-table and
///    stranger-only assertions go red;
///  - `!entries.is_empty()` / `entries.len() > 0` instead of row-exists: the
///    EMPTY-entries row seeded below reads false and this test names why;
///  - a body that answers does-the-table-hold-ANY-row: the stranger-only
///    assertion goes red, and so does the post-removal one;
///  - a body keyed on `ctx.sender()` instead of the `owner` argument;
///  - a latched or memoised answer that never returns to false: the
///    post-removal assertion goes red;
///  - deleting the new disjunct from `accounts::account_has_game_data`: the
///    paired account assertions go red while the direct ones stay green.
#[test]
fn s20rd_has_evolution_notices_is_row_exists() {
    let fx = crate::native_host_tests::fixture();
    let table = ["pending", "_evolution_notice"].concat();
    let column = ["owner", "_identity"].concat();
    let handle =
        fx.table::<crate::schema::PendingEvolutionNotice>(&table, &column, |r| r.owner_identity);
    let ctx = fx.ctx();

    // Both identities are non-zero, so neither can be satisfied by a body that
    // reads `ctx.sender()` (the host's dummy sender is the all-zero identity).
    let owner = Identity::from_byte_array([1u8; 32]);
    let stranger = Identity::from_byte_array([2u8; 32]);

    assert!(
        !crate::evolution::has_evolution_notices(&ctx, owner),
        "TEETH(20r-d ADR-0254 D5): `has_evolution_notices` must be false for an owner \
         with no row — the table is EMPTY here, so a true answer means the return \
         value is not derived from the table read at all"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "TEETH(20r-d): `account_has_game_data` must be false while the owner holds no \
         row in ANY of its tables — nothing has been seeded yet"
    );

    // A STRANGER's row, deliberately NON-empty.
    handle.seed(&crate::schema::PendingEvolutionNotice {
        owner_identity: stranger,
        entries: vec![s20rd_reveal(9_101, 1, 2, 11)],
    });
    assert!(
        !crate::evolution::has_evolution_notices(&ctx, owner),
        "TEETH(20r-d ADR-0254 D5): `has_evolution_notices` must stay false when the \
         ONLY row belongs to a DIFFERENT owner — the predicate answers per-owner, \
         never table-is-non-empty. A table-scan answer would make every guest claim \
         fail guard 11 as soon as ANY player held a pending reveal. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "TEETH(20r-d): `account_has_game_data` must stay false when the only seeded \
         row belongs to a stranger — a guest claim keys on the CALLER identity, never \
         on global table population"
    );

    // ★ The owner's OWN row, with an EMPTY entries Vec — the normal post-ack state.
    handle.seed(&crate::schema::PendingEvolutionNotice {
        owner_identity: owner,
        entries: vec![],
    });
    assert!(
        crate::evolution::has_evolution_notices(&ctx, owner),
        "TEETH(20r-d ADR-0254 D5 ROW-EXISTS): `has_evolution_notices` must report TRUE \
         for an owner whose row exists with an EMPTY entry list. An ack never deletes \
         the row (an empty Vec persists, the `player_wallet` rule), so this is the \
         state of every player who has dismissed their last reveal — and an \
         `entries.is_empty()`-based answer reads FALSE here, drops that player out of \
         `account_has_game_data`, and lets a guest claim rekey INTO their occupied \
         primary key. A body that performs the read and returns a constant false (the \
         ADR-0222 known-limit hollow) fails exactly here. Indexes the generated code \
         asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "TEETH(20r-d ADR-0254 D5): `account_has_game_data` must be true through its \
         NEW pending-evolution-notice disjunct while the owner holds a notice row and \
         NOTHING else. A disjunct that was never added fails exactly here, while the \
         direct predicate assertion above stays green — which is the whole reason this \
         pair is asserted together. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        handle.remove(owner),
        1,
        "fixture(20r-d): the owner held exactly ONE row to remove — a different count \
         means the seeded state is not the state this test reasons about (`seed` \
         appends, it never upserts)"
    );
    assert!(
        !crate::evolution::has_evolution_notices(&ctx, owner),
        "TEETH(20r-d): `has_evolution_notices` must return to FALSE once the owner's \
         row is gone — the answer tracks LIVE rows, so it can never latch on a row \
         that no longer exists. This is the state in which a guest claim is allowed \
         to proceed"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "TEETH(20r-d): `account_has_game_data` must return to false once the owner's \
         last row is gone"
    );
    assert!(
        crate::evolution::has_evolution_notices(&ctx, stranger),
        "TEETH(20r-d): removing the OWNER's row must leave the STRANGER's row \
         untouched — without this, the negatives above could be explained by an \
         emptied table rather than by owner scoping. Indexes the generated code asked \
         the host for: {:?}",
        fx.requested_indexes()
    );
}

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: EV-evolution-reducer-security,
// ST-evolution_tests#evolve-reducer-guards, ST-evolution_tests#view-scope-erase).
//
// Every case runs the SHIPPED reducer / helper through `Fixture::run_as(_at)`
// against the tables it reads through their real indexes (the seam suite above
// runs a hand mirror). HOST LIMIT: no transaction rollback, so a rejection is
// asserted as refusal BEFORE any write (the whole store byte-identical). The
// owner-scoped `my_pending_evolution_notices` view is a private fn in schema.rs
// and cannot be called from here (residual; Phase-3 candidate: pub(crate)).
// ===========================================================================
mod nh {
    use crate::evolution::{
        ack_evolution_notices, check_and_evolve, erase_evolution_notices, evolve,
        has_evolution_notices, rekey_evolution_notices, MAX_EVOLUTION_CHAIN_STEPS,
    };
    use crate::marshal::{monster_to_instance, pub_from_monster, species_from_row};
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::schema::{
        Battle, EssenceRequirementRow, EvolutionPathRow, EvolutionRevealRow, Monster, MonsterPub,
        PendingEvolutionNotice, SpeciesRow, TradeOffer,
    };
    use game_core::{Affinity, BattleOutcome, TradeStatus};
    use spacetimedb::sats::bsatn::to_vec;
    use spacetimedb::{Identity, Timestamp};

    const T0: i64 = 1_750_000_000_000;

    fn a() -> Identity {
        Identity::from_byte_array([0xA1; 32])
    }
    fn b() -> Identity {
        Identity::from_byte_array([0xB2; 32])
    }
    fn c() -> Identity {
        Identity::from_byte_array([0xC3; 32])
    }
    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    fn species(id: u32, base: u16, tier: u8) -> SpeciesRow {
        SpeciesRow {
            id,
            name: format!("s{id}"),
            base_hp: base,
            base_attack: base + 1,
            base_defense: base + 2,
            base_speed: base + 3,
            base_sp_attack: base + 4,
            base_sp_defense: base + 5,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1],
            ability: None,
            tier,
        }
    }

    fn edge(id: u32, from: u32, to: u32, min_level: u8, fire: u32) -> EvolutionPathRow {
        EvolutionPathRow {
            path_id: u64::from(id),
            edge_id: id,
            from_species: from,
            to_species: to,
            min_level,
            essence: if fire == 0 {
                vec![]
            } else {
                vec![EssenceRequirementRow {
                    affinity: Affinity::Fire,
                    amount: fire,
                }]
            },
            min_trust_tier: None,
            min_quality_time_tier: None,
            min_nutrition_pct: None,
        }
    }

    /// Distinct, non-zero growth history so a transform that dropped or zeroed
    /// the lifetime columns is visible.
    fn monster(monster_id: u64, owner: Identity, species_id: u32) -> Monster {
        Monster {
            monster_id,
            owner_identity: owner,
            species_id,
            nickname: format!("m{monster_id}"),
            level: 7,
            xp: 120,
            iv_hp: 10,
            iv_attack: 11,
            iv_defense: 12,
            iv_speed: 13,
            iv_sp_attack: 14,
            iv_sp_defense: 15,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 4,
            ev_attack: 5,
            ev_defense: 6,
            ev_speed: 7,
            ev_sp_attack: 8,
            ev_sp_defense: 9,
            stat_hp: 40,
            stat_attack: 20,
            stat_defense: 20,
            stat_speed: 20,
            stat_sp_attack: 20,
            stat_sp_defense: 20,
            current_hp: 33,
            party_slot: 0,
            last_care_at_ms: 5,
            essence_fire: 10,
            essence_water: 3,
            essence_plant: 0,
            essence_electric: 1,
            essence_earth: 0,
            essence_wind: 0,
            essence_light: 2,
            essence_dark: 0,
            trust_favorable_count: 9,
            trust_unfavorable_count: 1,
            trust_favorable_battle_day_epoch: 3,
            quality_time_ticks_total: 44,
            quality_time_accum_ms: 1_000,
            quality_time_window_ms: 2_000,
            quality_time_window_start_ms: 7,
            last_essence_train_at_ms: 11,
        }
    }

    fn battle(
        battle_id: u64,
        player: Identity,
        opponent: Identity,
        party: Vec<u64>,
        opp: Vec<u64>,
        outcome: BattleOutcome,
    ) -> Battle {
        let lead = game_core::BattleMonster {
            species_id: 1,
            affinity: Affinity::Fire,
            level: 7,
            current_hp: 30,
            max_hp: 30,
            stats: game_core::StatBlock {
                hp: 30,
                attack: 20,
                defense: 20,
                speed: 20,
                sp_attack: 20,
                sp_defense: 20,
            },
            known_skill_ids: vec![1],
            status: None,
        };
        Battle {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![lead.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![lead],
                },
                outcome,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: party,
            opponent_monster_ids: opp,
            created_at_ms: 0,
        }
    }

    fn offer(trade_id: u64, initiator: Identity, counterparty: Identity) -> TradeOffer {
        TradeOffer {
            trade_id,
            initiator,
            counterparty,
            initiator_monster_ids: vec![],
            initiator_items: vec![],
            initiator_currency: 0,
            counterparty_monster_ids: vec![],
            counterparty_items: vec![],
            counterparty_currency: 0,
            initiator_cards: vec![],
            counterparty_cards: vec![],
            status: TradeStatus::Pending,
            created_at_ms: T0,
        }
    }

    /// Every table `evolve` / `apply_evolution` / `check_and_evolve` / the notice
    /// helpers touch, under each index they read. Writes are opened only on the
    /// tables the success path writes.
    struct World<'a> {
        monsters: Handle<'a, Monster, u64>,
        pubs: Handle<'a, MonsterPub, u64>,
        species: Handle<'a, SpeciesRow, u32>,
        paths: Handle<'a, EvolutionPathRow, u32>,
        notices: Handle<'a, PendingEvolutionNotice>,
        battles: Handle<'a, Battle>,
        offers: Handle<'a, TradeOffer>,
    }

    fn world(fx: &Fixture) -> World<'_> {
        let w = World {
            monsters: fx
                .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
                .writable()
                .unique(),
            pubs: fx
                .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
                .writable()
                .unique(),
            species: fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id),
            paths: fx.table_keyed::<EvolutionPathRow, u32>("evolution_path", "from_species", |r| {
                r.from_species
            }),
            notices: fx
                .table::<PendingEvolutionNotice>(
                    "pending_evolution_notice",
                    "owner_identity",
                    |r| r.owner_identity,
                )
                .writable()
                .unique(),
            battles: fx.table::<Battle>("battle", "player_identity", |r| r.player_identity),
            offers: fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator),
        };
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        w
    }

    impl World<'_> {
        fn seed_monster(&self, m: &Monster, tier: u8) {
            self.pubs.seed(&pub_from_monster(m, tier));
            self.monsters.seed(m);
        }
        fn monster(&self, id: u64) -> Monster {
            self.monsters
                .rows()
                .into_iter()
                .find(|m| m.monster_id == id)
                .expect("monster row")
        }
        fn pub_row(&self, id: u64) -> MonsterPub {
            self.pubs
                .rows()
                .into_iter()
                .find(|m| m.monster_id == id)
                .expect("monster_pub row")
        }
        fn entries(&self, owner: Identity) -> Option<Vec<EvolutionRevealRow>> {
            self.notices
                .rows()
                .into_iter()
                .find(|n| n.owner_identity == owner)
                .map(|n| n.entries)
        }
        fn snapshot(&self) -> Vec<Vec<u8>> {
            vec![
                to_vec(&self.monsters.rows()).unwrap(),
                to_vec(&self.pubs.rows()).unwrap(),
                to_vec(&self.notices.rows()).unwrap(),
            ]
        }
    }

    /// The standard graph: 1 (tier 0) -> 2 (tier 1) at level 5 + 10 Fire essence.
    fn standard(fx: &Fixture) -> World<'_> {
        let w = world(fx);
        w.species.seed(&species(1, 30, 0));
        w.species.seed(&species(2, 60, 1));
        w.paths.seed(&edge(1, 1, 2, 5, 10));
        w
    }

    fn reveal(monster_id: u64, from: u32, to: u32, ms: i64) -> EvolutionRevealRow {
        EvolutionRevealRow {
            monster_id,
            from_species: from,
            to_species: to,
            evolved_at_ms: ms,
        }
    }

    /// Success: the real reducer applies the edge through the pure transform,
    /// dual-writes monster + monster_pub consistently (tier read FRESH from the
    /// target species), zeroes every essence pool, keeps the lifetime Trust /
    /// Quality-Time history, and files exactly one reveal with the PRE and POST
    /// species under the monster's owner.
    #[test]
    fn nh_evolve_success_dual_writes_and_files_one_notice() {
        let fx = fixture();
        let w = standard(&fx);
        let m = monster(11, a(), 1);
        w.seed_monster(&m, 0);
        let expected = game_core::evolve(
            &monster_to_instance(&m).unwrap(),
            &species_from_row(&species(2, 60, 1)).unwrap(),
        );

        let got = fx.run_as_at(a(), at(T0), |ctx| evolve(ctx, 11, 2));
        assert_eq!(got, Ok(()), "indexes asked: {:?}", fx.requested_indexes());

        let after = w.monster(11);
        assert_eq!(after.species_id, 2);
        assert_eq!(after.stat_hp, expected.derived_stats.hp);
        assert_eq!(after.stat_sp_defense, expected.derived_stats.sp_defense);
        assert_ne!(
            after.stat_hp, m.stat_hp,
            "stats re-derived from the TARGET base"
        );
        assert_eq!(
            [
                after.essence_fire,
                after.essence_water,
                after.essence_plant,
                after.essence_electric,
                after.essence_earth,
                after.essence_wind,
                after.essence_light,
                after.essence_dark,
            ],
            [0; 8],
            "every essence pool is zeroed by the transform"
        );
        assert_eq!(
            (
                after.trust_favorable_count,
                after.trust_unfavorable_count,
                after.quality_time_ticks_total,
                after.quality_time_window_start_ms,
                after.last_care_at_ms,
            ),
            (9, 1, 44, 7, 5),
            "lifetime Trust / Quality-Time history and bookkeeping survive the evolution"
        );
        assert_eq!(
            to_vec(&w.pub_row(11)).unwrap(),
            to_vec(&pub_from_monster(&after, 1)).unwrap(),
            "monster_pub == pub_from_monster(monster, fresh target tier 1)"
        );
        assert_eq!(w.entries(a()), Some(vec![reveal(11, 1, 2, T0)]));
    }

    /// A second evolution APPENDS to the owner's existing reveal queue.
    #[test]
    fn nh_evolve_appends_to_an_existing_notice_queue() {
        let fx = fixture();
        let w = standard(&fx);
        w.seed_monster(&monster(11, a(), 1), 0);
        w.notices.seed(&PendingEvolutionNotice {
            owner_identity: a(),
            entries: vec![reveal(99, 7, 8, 1)],
        });
        assert_eq!(fx.run_as_at(a(), at(T0), |ctx| evolve(ctx, 11, 2)), Ok(()));
        assert_eq!(
            w.entries(a()),
            Some(vec![reveal(99, 7, 8, 1), reveal(11, 1, 2, T0)])
        );
        assert_eq!(w.notices.rows().len(), 1, "one queue row per owner");
    }

    /// Refusals: unknown monster, non-owner, owner's monster in an ONGOING battle
    /// (side A party and PvP side B), monster in trade escrow (both roles), and a
    /// foreign / non-existent edge — each refused with the store byte-identical.
    #[test]
    fn nh_evolve_refusals_write_nothing() {
        type Setup = fn(&World<'_>);
        let cases: [(&str, Identity, u64, u32, Setup, &str); 7] = [
            ("unknown monster", a(), 12, 2, |_| {}, "monster not found"),
            ("non-owner", b(), 11, 2, |_| {}, "not owner"),
            (
                "in battle, side A",
                a(),
                11,
                2,
                |w| {
                    w.battles.seed(&battle(
                        1,
                        a(),
                        crate::WILD_IDENTITY,
                        vec![11],
                        vec![],
                        BattleOutcome::Ongoing,
                    ))
                },
                "monster is in an ongoing battle",
            ),
            (
                "in battle, PvP side B",
                a(),
                11,
                2,
                |w| {
                    w.battles.seed(&battle(
                        1,
                        b(),
                        a(),
                        vec![21],
                        vec![11],
                        BattleOutcome::Ongoing,
                    ))
                },
                "monster is in an ongoing battle",
            ),
            (
                "escrowed as initiator",
                a(),
                11,
                2,
                |w| {
                    let mut o = offer(1, a(), b());
                    o.initiator_monster_ids = vec![11];
                    w.offers.seed(&o);
                },
                "monster is in an active trade",
            ),
            (
                "escrowed as counterparty",
                a(),
                11,
                2,
                |w| {
                    let mut o = offer(1, b(), a());
                    o.counterparty_monster_ids = vec![11];
                    w.offers.seed(&o);
                },
                "monster is in an active trade",
            ),
            (
                "foreign edge (3 -> 2 exists, 1 -> 3 does not)",
                a(),
                11,
                3,
                |w| w.paths.seed(&edge(2, 3, 2, 1, 0)),
                "no such evolution: species 1 has no path to species 3",
            ),
        ];
        for (label, caller, id, to, setup, want) in cases {
            let fx = fixture();
            let w = standard(&fx);
            w.seed_monster(&monster(11, a(), 1), 0);
            setup(&w);
            let before = w.snapshot();
            let got = fx.run_as_at(caller, at(T0), |ctx| evolve(ctx, id, to));
            assert_eq!(got, Err(want.to_string()), "{label}");
            assert_eq!(w.snapshot(), before, "{label}: a refusal writes nothing");
        }
    }

    /// Control for the battle/escrow refusals: a COMPLETED battle and an offer
    /// that escrows a DIFFERENT monster do not block the evolution.
    #[test]
    fn nh_evolve_completed_battle_and_foreign_escrow_do_not_block() {
        let fx = fixture();
        let w = standard(&fx);
        w.seed_monster(&monster(11, a(), 1), 0);
        w.battles.seed(&battle(
            1,
            b(),
            a(),
            vec![21],
            vec![11],
            BattleOutcome::SideAWins,
        ));
        let mut o = offer(1, a(), b());
        o.initiator_monster_ids = vec![12];
        w.offers.seed(&o);
        assert_eq!(fx.run_as_at(a(), at(T0), |ctx| evolve(ctx, 11, 2)), Ok(()));
        assert_eq!(w.monster(11).species_id, 2);
    }

    /// The gate at its boundaries, on the REAL reducer: level 4 vs min 5 and
    /// Fire 9 vs 10 each refuse naming the requirement with nothing written;
    /// exactly at the thresholds the evolution applies.
    #[test]
    fn nh_evolve_gate_boundaries() {
        let mk = |level: u8, fire: u32| {
            let mut m = monster(11, a(), 1);
            m.level = level;
            m.essence_fire = fire;
            m
        };
        for (label, m, want) in [
            ("level one below", mk(4, 10), Some("requires level 5")),
            ("essence one below", mk(5, 9), Some("essence")),
            ("exactly at both thresholds", mk(5, 10), None),
        ] {
            let fx = fixture();
            let w = standard(&fx);
            w.seed_monster(&m, 0);
            let before = w.snapshot();
            let got = fx.run_as_at(a(), at(T0), |ctx| evolve(ctx, 11, 2));
            match want {
                Some(needle) => {
                    let e = got.expect_err(label);
                    assert!(e.contains(needle), "{label}: {e:?} must name {needle:?}");
                    assert_eq!(w.snapshot(), before, "{label}: nothing written");
                }
                None => {
                    assert_eq!(got, Ok(()), "{label}");
                    assert_eq!(w.monster(11).species_id, 2, "{label}");
                }
            }
        }
    }

    /// check_and_evolve on the REAL helper: an unambiguous chain 1 -> 2 -> 3
    /// resolves in one call with the reveals in order; two eligible out-edges
    /// leave the choice to the player (nothing written).
    #[test]
    fn nh_check_and_evolve_chain_and_ambiguity() {
        let fx = fixture();
        let w = world(&fx);
        w.species.seed(&species(1, 30, 0));
        w.species.seed(&species(2, 40, 1));
        w.species.seed(&species(3, 50, 2));
        w.paths.seed(&edge(1, 1, 2, 1, 0));
        w.paths.seed(&edge(2, 2, 3, 1, 0));
        w.seed_monster(&monster(11, a(), 1), 0);
        fx.run_as_at(b(), at(T0), |ctx| check_and_evolve(ctx, 11));
        assert_eq!(w.monster(11).species_id, 3);
        assert_eq!(w.pub_row(11).tier, 2);
        assert_eq!(
            w.entries(a()),
            Some(vec![reveal(11, 1, 2, T0), reveal(11, 2, 3, T0)]),
            "filed under the monster's OWNER, never the caller"
        );

        drop(fx);
        let fx = fixture();
        let w = world(&fx);
        w.species.seed(&species(1, 30, 0));
        w.species.seed(&species(2, 40, 1));
        w.species.seed(&species(3, 50, 1));
        w.paths.seed(&edge(1, 1, 2, 1, 0));
        w.paths.seed(&edge(2, 1, 3, 1, 0));
        w.seed_monster(&monster(11, a(), 1), 0);
        let before = w.snapshot();
        fx.run_as_at(a(), at(T0), |ctx| check_and_evolve(ctx, 11));
        assert_eq!(w.snapshot(), before, "2 eligible: the player chooses");
    }

    /// Degenerate (R5-violating) cycle 1 <-> 2: the chain stops after exactly
    /// MAX_EVOLUTION_CHAIN_STEPS applications instead of looping forever.
    #[test]
    fn nh_check_and_evolve_cycle_stops_at_the_cap() {
        let fx = fixture();
        let w = world(&fx);
        w.species.seed(&species(1, 30, 0));
        w.species.seed(&species(2, 40, 1));
        w.paths.seed(&edge(1, 1, 2, 1, 0));
        w.paths.seed(&edge(2, 2, 1, 1, 0));
        w.seed_monster(&monster(11, a(), 1), 0);
        fx.run_as_at(a(), at(T0), |ctx| check_and_evolve(ctx, 11));
        let n = w.entries(a()).expect("notice row").len();
        assert_eq!(n, MAX_EVOLUTION_CHAIN_STEPS as usize);
        let expected_species = if n % 2 == 1 { 2 } else { 1 };
        assert_eq!(w.monster(11).species_id, expected_species);
    }

    /// ack is keyed on the CALLER: B cannot drain A's queue; A drains the
    /// acknowledged prefix; an emptied row survives; over-ack is refused.
    #[test]
    fn nh_ack_is_sender_scoped_and_drains_the_prefix() {
        let fx = fixture();
        let w = world(&fx);
        let q = vec![reveal(1, 1, 2, 1), reveal(2, 1, 2, 2), reveal(3, 1, 2, 3)];
        w.notices.seed(&PendingEvolutionNotice {
            owner_identity: a(),
            entries: q.clone(),
        });
        let before = w.snapshot();
        assert_eq!(
            fx.run_as(b(), |ctx| ack_evolution_notices(ctx, 1)),
            Err("no pending evolution notices".to_string())
        );
        assert_eq!(w.snapshot(), before, "B's ack touches nothing of A's");

        assert_eq!(fx.run_as(a(), |ctx| ack_evolution_notices(ctx, 2)), Ok(()));
        assert_eq!(w.entries(a()), Some(vec![q[2].clone()]));
        assert!(fx.run_as(a(), |ctx| ack_evolution_notices(ctx, 2)).is_err());
        assert_eq!(w.entries(a()), Some(vec![q[2].clone()]), "over-ack refused");
        assert_eq!(fx.run_as(a(), |ctx| ack_evolution_notices(ctx, 1)), Ok(()));
        assert_eq!(w.entries(a()), Some(vec![]), "the emptied row survives");
    }

    /// Claim re-key moves the queue verbatim; erase removes it (idempotently);
    /// has_evolution_notices is ROW-exists (an emptied row still counts).
    #[test]
    fn nh_rekey_erase_and_row_exists() {
        let fx = fixture();
        let w = world(&fx);
        let q = vec![reveal(1, 1, 2, 1)];
        w.notices.seed(&PendingEvolutionNotice {
            owner_identity: a(),
            entries: q.clone(),
        });
        w.notices.seed(&PendingEvolutionNotice {
            owner_identity: b(),
            entries: vec![],
        });
        let ctx = fx.ctx();
        assert!(
            has_evolution_notices(&ctx, b()),
            "an emptied row still exists"
        );
        assert!(!has_evolution_notices(&ctx, c()));

        rekey_evolution_notices(&ctx, a(), c());
        assert_eq!(w.entries(a()), None);
        assert_eq!(w.entries(c()), Some(q));
        rekey_evolution_notices(&ctx, a(), c()); // no source row: no-op
        assert_eq!(w.notices.rows().len(), 2);

        erase_evolution_notices(&ctx, c());
        assert_eq!(w.entries(c()), None);
        erase_evolution_notices(&ctx, c());
        assert_eq!(w.entries(b()), Some(vec![]), "erase is owner-scoped");
        assert!(!has_evolution_notices(&ctx, c()));
    }
}
