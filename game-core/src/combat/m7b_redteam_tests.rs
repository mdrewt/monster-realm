//! Red-team attack tests for the M7b plan.
//!
//! These tests are written against the M7b design plan. They target the
//! server-side reducer layer (battle table + reducers) and the combat engine
//! integration, focusing on attack vectors specific to the planned server
//! implementation.
//!
//! Each test is annotated with:
//!   - Finding number and severity
//!   - Attack description
//!   - What the test proves (or documents where a runtime test is impossible)
//!
//! Tests that exercise existing game-core code WILL compile and run.
//! Tests for server-side reducer logic (SpacetimeDB context) are annotated
//! with `#[cfg(FALSE)]` — they document the required reducer behaviour and
//! serve as a specification for the implementation.
//!
//! Run: cargo test m7b_redteam -- --nocapture

use crate::combat::{
    apply_xp_gain, battle_xp_reward,
    types::{BattleMonster, BattleOutcome, BattleSide, BattleState, TurnVariance},
};
use crate::monster::types::{Affinity, EVs, IVs, Level, Nature, NatureKind, StatBlock, Xp};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

fn zero_stats() -> StatBlock {
    StatBlock {
        hp: 100,
        attack: 50,
        defense: 50,
        speed: 50,
        sp_attack: 50,
        sp_defense: 50,
    }
}

fn make_battle_monster(hp: u16, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: hp,
        max_hp: hp,
        stats: StatBlock {
            hp,
            attack: 50,
            defense: 50,
            speed,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: None,
    }
}

fn ongoing_battle(a_hp: u16, b_hp: u16) -> BattleState {
    BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![make_battle_monster(a_hp, 50)],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_battle_monster(b_hp, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    }
}

// ===========================================================================
// FINDING M7b-1 (CRITICAL): No double-battle guard — a player can start two
// simultaneous battles.
//
// Attack: call start_battle twice before the first battle completes.
// The plan's `start_battle` reducer is described as thin: "validate ownership
// / legality → delegate to game-core → write back". There is NO mention of
// checking whether the caller already has an active battle row before
// inserting a new one.
//
// Impact: a player with two live battle rows can interleave submit_attack
// calls against both, earning double XP from a single set of monsters. The
// HP write-back re-verifies owner_identity but does NOT check for duplicate
// battle rows — both rows point to the same party_monster_ids. The winner
// of EITHER battle would trigger apply_xp_gain on the same monster, causing
// double XP grant. If both battles end simultaneously (in the same tick?),
// the second write-back reads the already-modified monster XP and adds again.
// ===========================================================================

#[test]
fn m7b_1_double_battle_double_xp_arithmetic() {
    // Prove that two separate xp gains on the same starting XP are additive
    // and not idempotent — the server must prevent starting a second battle.
    let starting_xp = Xp::new(0);
    let xp_gain = Xp::new(500);

    let (after_first, level_after_first, _) = apply_xp_gain(starting_xp, xp_gain);
    let (after_second, level_after_second, _) = apply_xp_gain(after_first, xp_gain);

    // Two separate XP grants from two battles accumulate.
    assert_eq!(
        after_second.value(),
        1000,
        "Two separate xp grants of 500 each accumulate to 1000"
    );

    // This MUST NOT happen — the server reducer must enforce:
    //   "player may not start_battle if they already have a battle row
    //    with outcome == Ongoing"
    // Without this guard, the player earns XP from BOTH battles.
    assert!(
        level_after_second.as_u8() >= level_after_first.as_u8(),
        "M7b-1: Two simultaneous battles grant DOUBLE XP. \
         start_battle MUST query the battle table for any existing row \
         WHERE player_identity = ctx.sender AND outcome = Ongoing \
         and return Err if one is found."
    );
}

// ===========================================================================
// FINDING M7b-2 (CRITICAL): HP write-back reads owner at finish-time, but
// party_monster_ids were snapshotted at battle-start. A transferred monster
// is written back to a new owner.
//
// Attack sequence:
//   1. Player A starts a battle. party_monster_ids = [monster_42].
//      monster_42.owner_identity = A.
//   2. During the battle, monster_42 is traded/transferred to Player B.
//      monster_42.owner_identity = B. (No trading reducer exists yet, but
//      this gap becomes critical the moment it does.)
//   3. Player A wins the battle. The HP write-back reducer does:
//        let m = ctx.db.monster().find(party_monster_ids[0]);
//        if m.owner_identity != ctx.sender { return Err } -- CORRECT CHECK
//        BUT: the plan says "Re-verify owner_identity against CURRENT state,
//        not battle-time snapshot." This means monster_42 now belongs to B,
//        so the re-verify REJECTS the write-back. The player wins but their
//        HP damage is silently lost — or worse, if the impl writes WITHOUT
//        re-verifying, they write reduced HP onto B's monster.
//
// Impact: The plan's description of "re-verify owner_identity" is correct
// intent, but the consequence is SILENT HP LOSS for the winner when any
// monster changes hands during battle (even if that path doesn't exist yet).
// The spec MUST define what happens: abort with an error, or write-back only
// monsters that still belong to the caller.
//
// NOTE: evals/spec-gap-revival.eval.mjs mechanically force-revives this test —
// the gate FAILS if a trade/transfer reducer lands while this stays #[ignore].
// ===========================================================================

#[test]
fn m7b_2_owner_change_mid_battle_spec_gap() {
    // Spec gap CLOSED (M15a, ADR-0106) + battle↔trade interlock (m16.5a, ADR-0112).
    //
    // write_back_party_hp cannot be called from game-core (server-module depends on
    // game-core, not vice-versa). Source-scan asserts the abort-on-owner-change
    // contract in write_back_party_hp and the two-direction interlock in trading.rs.

    // --- Criterion 1: write_back_party_hp aborts on owner mismatch (ADR-0106 M15a) ---
    let battle_src = include_str!("../../../server-module/src/battle.rs");
    // Strip line-comment lines so commented-out code cannot satisfy assertions.
    let stripped_battle: String = battle_src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    let fn_start = stripped_battle
        .find("fn write_back_party_hp")
        .expect("write_back_party_hp must exist in server-module/src/battle.rs");
    let fn_body = &stripped_battle[fn_start..];

    // The owner-mismatch guard must be present.
    assert!(
        fn_body.contains("owner_identity != battle.player_identity"),
        "write_back_party_hp must check `owner_identity != battle.player_identity` \
         (ADR-0106 M15a abort-on-owner-change). Without this guard an owner change \
         mid-battle silently corrupts another player's monster HP."
    );
    // The guard must abort via Err (not panic), leaving other player's row untouched.
    assert!(
        fn_body.contains("return Err("),
        "write_back_party_hp must return Err (not panic) on owner mismatch so the \
         SpacetimeDB transaction rolls back with the other player's monster row untouched."
    );
    // The abort must happen BEFORE any monster row update — the other player's row must
    // remain untouched.
    let abort_pos = fn_body
        .find("owner_identity != battle.player_identity")
        .expect("confirmed above");
    let first_update_pos = fn_body
        .find("ctx.db.monster().monster_id().update(")
        .unwrap_or(usize::MAX);
    assert!(
        abort_pos < first_update_pos,
        "write_back_party_hp must abort BEFORE any `ctx.db.monster().monster_id().update(` \
         so the other player's monster row is untouched on owner mismatch (ADR-0106 M15a)."
    );

    // --- Criterion 2: both-direction battle↔trade interlock (m16.5a, ADR-0112) ---
    let trading_src = include_str!("../../../server-module/src/trading.rs");
    let stripped_trading: String = trading_src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    // propose_trade and confirm_trade must each call reject_if_in_battle (>= 2 sites).
    let count = stripped_trading.matches("reject_if_in_battle").count();
    assert!(
        count >= 2,
        "trading.rs must call reject_if_in_battle in both propose_trade and confirm_trade \
         (m16.5a, ADR-0112). Found {count} occurrence(s); need >= 2."
    );

    // propose_trade must chain opponent_identity to catch PvP side-B participants.
    let propose_start = stripped_trading
        .find("fn propose_trade")
        .expect("propose_trade must exist");
    let respond_start = stripped_trading[propose_start..]
        .find("fn respond_trade")
        .map(|p| propose_start + p)
        .unwrap_or(stripped_trading.len());
    let propose_body = &stripped_trading[propose_start..respond_start];
    assert!(
        propose_body.contains("opponent_identity()"),
        "propose_trade must chain `opponent_identity().filter(` to catch PvP side-B \
         participants (ADR-0109/ADR-0112). Without this, a battling side-B monster can \
         be freely traded out, creating a zombie battle."
    );
}

// ===========================================================================
// FINDING M7b-3 (CRITICAL): Acted-on-finished-battle — submit_attack / flee
// / swap_active after BattleOutcome != Ongoing.
//
// Attack: Player submits a `submit_attack` after the battle has already ended
// (outcome = SideAWins or SideBWins) but before the client processes the
// final event.
//
// The plan says reducers "validate ownership/legality". The legality check
// MUST include: `if battle.state.outcome != BattleOutcome::Ongoing { return Err }`.
// The plan does not explicitly list this guard.
//
// Impact: If the guard is missing, a second submit_attack on a finished battle
// runs resolve_turn on a terminal state. resolve_turn increments turn_number
// and may generate spurious events. Worse: if SideBWins but the second
// submit_attack triggers an XP grant (because SideA's health check passes),
// the loser earns XP.
// ===========================================================================

#[test]
fn m7b_3_resolve_turn_on_terminal_state_increments_turn_number() {
    use crate::combat::type_chart::TypeChart;
    use crate::combat::{resolve_turn, types::TurnChoice};
    use crate::content::{load_type_chart, SkillDef};

    // Build a battle that is already finished.
    let mut finished = ongoing_battle(0, 100); // side_a has 0 HP — already fainted
    finished.outcome = BattleOutcome::SideBWins;

    let type_chart_data = load_type_chart().expect("type chart must parse");
    let chart = TypeChart::new(&type_chart_data);

    let skill = SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    };
    let skills = vec![skill];
    let variance = TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    };

    let turn_before = finished.turn_number;

    // THIS IS THE BUG: calling resolve_turn on a terminal state still
    // increments turn_number and produces events — it does not check outcome.
    let events = resolve_turn(
        &mut finished,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills,
        &chart,
        &variance,
    );

    // FAILS: resolve_turn does not guard against terminal BattleOutcome.
    // A correct implementation would return Err or an empty event list
    // without mutating state when outcome != Ongoing.
    assert_eq!(
        finished.turn_number, turn_before,
        "M7b-3: resolve_turn on a terminal (SideBWins) battle still incremented \
         turn_number from {} to {}. The submit_attack reducer MUST check \
         battle.state.outcome == Ongoing before calling resolve_turn.",
        turn_before, finished.turn_number
    );

    // Also assert no events were produced (vacuous if the assert above fires first,
    // but included for completeness).
    assert!(
        events.is_empty(),
        "M7b-3: resolve_turn on a terminal battle produced {} events — expected 0",
        events.len()
    );
}

// ===========================================================================
// FINDING M7b-4 (HIGH): heal_party battle-check uses a linear scan over all
// battle rows and relies on the caller-supplied player_identity index.
//
// Attack: The plan says `heal_party` is "rejected if in battle". The check
// presumably queries: "does any battle row exist WHERE player_identity =
// ctx.sender AND outcome = Ongoing?"
//
// Race condition: In SpacetimeDB, reducers execute serially within a module,
// so there is no true concurrency. However, a client can send:
//   1. flee(battle_id)      — queued
//   2. heal_party()         — queued immediately after
//
// If the module drains these in order, flee executes first (sets outcome =
// SideAFled or similar), then heal_party sees outcome != Ongoing and heals.
// This is CORRECT and intended behavior.
//
// But: if flee is NOT atomic with the outcome update (e.g., flee sets outcome
// in a separate step after writing back HP), a heal_party squeezed in between
// the two writes would see a stale Ongoing state and REJECT the heal even
// though the flee was accepted. The player loses their free heal.
//
// Worse: if the plan allows flee to set outcome = SideAFled (a third outcome
// variant) but heal_party only checks `outcome != Ongoing`, and SideAFled is
// not Ongoing, then flee+heal is fine. But if flee sets outcome = SideAWins
// (player fled = enemy wins?), the heal is still blocked until the next
// disambiguation.
//
// The plan MUST define: what outcome value does `flee` set? The plan says
// "flee(battle_id)" but does not define the resulting BattleOutcome variant.
// BattleOutcome currently has: Ongoing, SideAWins, SideBWins. There is NO
// Fled variant.
// ===========================================================================

#[test]
fn m7b_4_flee_outcome_variant_exists() {
    // BattleOutcome now has four variants including Fled (added in M7b).
    let outcome = BattleOutcome::Fled;
    let is_terminal = match outcome {
        BattleOutcome::Ongoing => false,
        BattleOutcome::SideAWins => true,
        BattleOutcome::SideBWins => true,
        BattleOutcome::Fled => true,
    };

    assert!(
        is_terminal,
        "M7b-4: BattleOutcome::Fled must be a terminal outcome"
    );

    // Fled variant now exists — gap resolved in M7b.
    assert_ne!(
        BattleOutcome::Fled,
        BattleOutcome::Ongoing,
        "Fled must be distinct from Ongoing so heal_party treats it as terminal"
    );
}

// ===========================================================================
// FINDING M7b-5 (HIGH): swap_active can swap to an out-of-bounds team_index
// or to a fainted monster.
//
// Attack: send swap_active(battle_id, team_index=999) or
//         swap_active(battle_id, team_index=0) when index 0 is fainted.
//
// The plan says: "validate ownership/legality → delegate to game-core →
// write back state". The resolve_player_swap function sets:
//   state.side_a.active = new_active   (direct assignment, no bounds check)
//
// If new_active >= side_a.team.len(), the next call to active_monster()
// will panic with an out-of-bounds index panic in release builds.
// In SpacetimeDB, a reducer panic aborts the transaction but may leave the
// module in an inconsistent state if the panic occurs mid-write.
//
// If the target monster is fainted (current_hp == 0), the swap succeeds
// but now active_monster() returns a fainted monster. The subsequent call
// to active_monster().stats.speed reads the fainted monster's speed,
// allowing the fainted monster to determine turn order. More critically,
// a fainted monster attacking is nonsensical and breaks the is_fainted
// semantic.
// ===========================================================================

#[test]
fn m7b_5_swap_to_fainted_monster_makes_active_monster_fainted() {
    // Construct a side where team[0] is fainted, team[1] is alive.
    // Swap active to index 0 (the fainted one).
    let fainted = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 0, // fainted
        max_hp: 100,
        stats: zero_stats(),
        known_skill_ids: vec![1],
        status: None,
    };
    let alive = BattleMonster {
        species_id: 2,
        affinity: Affinity::Water,
        level: 5,
        current_hp: 80,
        max_hp: 100,
        stats: zero_stats(),
        known_skill_ids: vec![1],
        status: None,
    };

    let mut side = BattleSide {
        active: 1, // alive monster is active
        team: vec![fainted, alive],
    };

    // Simulate what resolve_player_swap does (no validation):
    side.active = 0; // swap to the fainted monster

    // NOW active_monster() returns a fainted monster.
    let active = side.active_monster();
    assert!(
        active.is_fainted(),
        "M7b-5: swap_active to a fainted monster makes is_fainted() return true \
         for the active slot. The submit_attack reducer will then try to attack \
         with a fainted monster. The swap_active reducer MUST validate: \
         team[team_index].current_hp > 0 (not fainted) \
         AND team_index < team.len() \
         before accepting the swap."
    );
}

#[test]
fn m7b_5b_swap_to_out_of_bounds_team_index_panics() {
    // Prove that BattleSide::active_monster panics on OOB index.
    // We use std::panic::catch_unwind to avoid aborting the test runner.
    let side = BattleSide {
        active: 99, // OOB — team has 1 element
        team: vec![make_battle_monster(100, 50)],
    };

    let result = std::panic::catch_unwind(|| {
        let _ = side.active_monster();
    });

    assert!(
        result.is_err(),
        "M7b-5b: BattleSide::active_monster with active=99 on a 1-element team \
         should panic with out-of-bounds. The swap_active reducer MUST validate \
         team_index < party_monster_ids.len() before writing state. \
         Without this check, a malicious client can crash the module reducer."
    );
}

// ===========================================================================
// FINDING M7b-6 (HIGH): BattleState is stored as a single opaque column in a
// PUBLIC table. BattleMonster contains stats: StatBlock (attack, defense,
// speed, sp_attack, sp_defense, hp) for ALL monsters including the opponent.
//
// Information leaked per BattleState column (public, no RLS):
//   - Opponent's exact stats (derived from hidden IVs+EVs+nature+level)
//   - Opponent's current_hp during the battle
//   - Opponent's known_skill_ids (the exact moveset)
//   - The full team roster for both sides (species, level, affinity)
//
// For PvE this is documented as acceptable in ADR-0042. But for PvP (M16),
// this leaks the OPPONENT'S derived stats, which are computed from their
// private IVs/EVs/nature. A player who reads the battle table during a PvP
// match can determine their opponent's exact IV/EV/nature without any
// server-side oracle — they just reverse the stat formula.
//
// The stat formula is:
//   stat = (((2*base + iv + ev/4) * level / 100) + 5) * nat_num / nat_den
// Given known base stats, level, and the published derived stat, iv+ev/4
// can be narrowed to 1-2 values by inverting the formula.
// ===========================================================================

#[test]
fn m7b_6_public_battlestate_leaks_opponent_derived_stats() {
    // Demonstrate that derived stats expose hidden gene information.
    use crate::monster::rules::derive_stats;
    use crate::monster::types::StatKind;

    let base = StatBlock {
        hp: 45,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    };
    let secret_iv_attack: u8 = 31; // hidden — this is what the attacker wants secret
    let ivs = IVs::new(15, secret_iv_attack, 15, 15, 15, 15).unwrap();
    let evs = EVs::zero();
    let nature = Nature::new(NatureKind::Hardy);
    let level = Level::new(50).unwrap();

    let derived = derive_stats(&base, &ivs, &evs, &nature, level);
    let public_attack_stat = derived.get(StatKind::Attack);

    // An adversary who reads the public battle table can now reverse-engineer iv_attack:
    // stat = (((2*49 + iv + 0) * 50 / 100) + 5) * 10 / 10
    //      = (2*49 + iv) / 2 + 5        (integer truncation for level=50)
    // public_attack_stat - 5 = (98 + iv) / 2
    // (public_attack_stat - 5) * 2 = 98 + iv  (approximately, due to truncation)
    let derived_iv_attack_approx = ((public_attack_stat as i32 - 5) * 2 - 98).max(0) as u8;

    // The adversary gets iv=31 or iv=30 (within 1 due to truncation).
    let iv_exposed = derived_iv_attack_approx >= 30;
    assert!(
        iv_exposed,
        "M7b-6: Public BattleState leaks opponent's Attack stat = {}. \
         Reverse-engineering gives iv_attack ~= {} (actual: {}). \
         For PvP (M16), this is a CRITICAL information disclosure. \
         ADR-0042 accepts this for PvE ONLY. The plan must add a note: \
         'PvP battles MUST use private battle tables or stat-redacted projections.'",
        public_attack_stat, derived_iv_attack_approx, secret_iv_attack
    );
}

// ===========================================================================
// FINDING M7b-7 (HIGH): XP write-back race — apply_xp_gain is called with
// the monster's XP from the battle-start snapshot, not current DB state.
//
// Attack sequence (within valid SpacetimeDB serial execution):
//   1. Player A starts battle. Monster 42 has xp=1000.
//      BattleState snapshot: side_a.team[0].level = 10.
//   2. Battle ends. write-back reducer reads monster 42 from DB: xp=1000.
//   3. write-back calls apply_xp_gain(Xp(1000), gained) → new_xp=1200.
//   4. Writes new_xp=1200, new_level=10 back to monster 42.
//
// This is correct if the monster's XP was not modified between steps 1 and 4.
// BUT: if the player also ran heal_party between steps 1 and 4 (allowed,
// since heal_party is rejected only if in-battle), and heal_party for some
// reason modifies xp... actually heal_party only modifies current_hp, not xp.
// So this specific path is safe.
//
// The REAL risk: the plan says "derive_stats recomputation" after level-up.
// But the XP write-back reads the LIVE monster from DB (correct), yet the
// level comparison uses the BattleState snapshot's derived stats. If the
// monster leveled up via some OTHER path between battle start and write-back,
// the write-back may incorrectly re-apply derive_stats at the wrong level.
//
// This is a latent bug that becomes critical when M9+ adds non-battle XP
// sources (e.g., exploration XP, item use). The write-back MUST use the
// live monster's current_level as the baseline, not the battle snapshot.
// ===========================================================================

#[test]
fn m7b_7_xp_writeback_must_use_live_db_state_not_snapshot() {
    // Prove that apply_xp_gain is idempotent-unsafe: if called twice with
    // the same snapshot XP, it adds XP twice.
    let snapshot_xp = Xp::new(1000); // XP at battle start
    let xp_earned = Xp::new(200);

    // Correct: read live XP from DB, add earned XP.
    let (after_correct, _, _) = apply_xp_gain(snapshot_xp, xp_earned);
    assert_eq!(after_correct.value(), 1200);

    // WRONG: if some other reducer modified XP between battle-start and write-back,
    // and write-back uses snapshot_xp as the base, it OVERWRITES the other change.
    // (Not a double-add here, but a stale-write overwrite.)
    //
    // Example: player was also granted 50 XP from exploration during the battle.
    // live_xp = 1050 (snapshot + 50 from exploration)
    // write-back reads live_xp=1050, adds earned=200 → 1250. CORRECT.
    // BUT if write-back blindly uses snapshot_xp=1000:
    //   apply_xp_gain(snapshot_xp=1000, earned=200) = 1200
    //   writes 1200 → LOSES the 50 exploration XP (stale write overwrite).
    let live_xp_after_exploration = Xp::new(1050);
    let (after_correct_live, _, _) = apply_xp_gain(live_xp_after_exploration, xp_earned);
    let (after_stale_write, _, _) = apply_xp_gain(snapshot_xp, xp_earned);

    assert_ne!(
        after_correct_live.value(),
        after_stale_write.value(),
        "M7b-7: Using battle-start snapshot XP ({}) instead of live DB XP ({}) \
         for write-back loses {} XP gained from other sources during the battle. \
         The write-back reducer MUST read the CURRENT monster.xp from the DB, \
         not the XP snapshotted into BattleState at battle start.",
        snapshot_xp.value(),
        live_xp_after_exploration.value(),
        after_correct_live.value() - after_stale_write.value()
    );
}

// ===========================================================================
// FINDING M7b-8 (MEDIUM): The TurnVariance struct has no validated constructor.
// The server must call ctx.random() to generate variance values, but there
// is no TurnVariance::from_random() helper that enforces the documented ranges:
//   damage_roll_a, damage_roll_b: 85..=100
//   accuracy_roll_a, accuracy_roll_b: 0..=99
//
// If the server reducer calls ctx.random() and uses the raw u8 for damage_roll,
// values 0..84 are invalid (too low — produce heavily reduced damage) and
// values 101..255 are invalid (too high — produce 2.55x intended max damage).
//
// This is not just a theoretical concern: SpacetimeDB's ctx.random() returns
// a u32, which the caller must range-narrow. The narrowing is not specified
// in the plan. The common mistake is: damage_roll = (ctx.random() % 16 + 85) as u8
// which correctly gives 85..=100. But accuracy_roll = ctx.random() % 100 as u8
// gives 0..=99 correctly. Missing a `% 100` or using wrong modulus is easy.
// ===========================================================================

#[test]
fn m7b_8_turnvariance_out_of_range_damage_roll_produces_wrong_damage() {
    use crate::combat::damage::calc_damage;
    use crate::combat::type_chart::TypeChart;
    use crate::content::{load_type_chart, SkillDef};

    let type_chart_data = load_type_chart().expect("type chart must parse");
    let chart = TypeChart::new(&type_chart_data);

    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 50,
        current_hp: 200,
        max_hp: 200,
        stats: StatBlock {
            hp: 200,
            attack: 100,
            defense: 50,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: None,
    };
    let defender = BattleMonster {
        species_id: 2,
        affinity: Affinity::Water,
        level: 50,
        current_hp: 200,
        max_hp: 200,
        stats: StatBlock {
            hp: 200,
            attack: 50,
            defense: 50,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: None,
    };
    let skill = SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    };

    // Valid range: damage_roll in 85..=100
    let (dmg_valid_max, _) = calc_damage(&attacker, &defender, &skill, &chart, 100, None);
    let (dmg_valid_min, _) = calc_damage(&attacker, &defender, &skill, &chart, 85, None);

    // Out-of-range: damage_roll = 0 (below minimum)
    // calc_damage does not validate — it just uses variance directly.
    let (dmg_zero_roll, _) = calc_damage(&attacker, &defender, &skill, &chart, 0, None);

    // Out-of-range: damage_roll = 255 (above maximum)
    let (dmg_max_roll, _) = calc_damage(&attacker, &defender, &skill, &chart, 255, None);

    assert!(
        dmg_zero_roll < dmg_valid_min,
        "M7b-8a: damage_roll=0 produces {} damage, less than valid min {}. \
         The server MUST use: damage_roll = 85 + (ctx.random() % 16) as u8.",
        dmg_zero_roll,
        dmg_valid_min
    );

    assert!(
        dmg_max_roll > dmg_valid_max,
        "M7b-8b: damage_roll=255 produces {} damage, more than valid max {}. \
         An out-of-range roll inflates damage by {}%. \
         TurnVariance needs a validated server-side constructor.",
        dmg_max_roll,
        dmg_valid_max,
        (dmg_max_roll as u32 * 100 / dmg_valid_max.max(1) as u32).saturating_sub(100)
    );
}

// ===========================================================================
// FINDING M7b-9 (MEDIUM): party_monster_ids contains indices into the player's
// party, but these IDs are monster_ids (u64 PKs), not party slot indices.
// The plan says `party_monster_ids: Vec<u64>` — so they ARE the monster PKs.
//
// Attack: start_battle with party_monster_ids that includes:
//   - monster_ids from a DIFFERENT player (authz bypass attempt)
//   - duplicate monster_ids (same monster on both sides, or twice on same side)
//   - monster_ids that don't exist (deleted monsters)
//   - monster_ids for monsters with current_hp = 0 (all-fainted party)
//
// The plan does not enumerate these validation checks on start_battle.
// ===========================================================================

#[test]
fn m7b_9_all_fainted_party_gives_degenerate_battle_state() {
    // Prove that starting a battle with all-fainted monsters produces a
    // BattleState where has_conscious_member() is immediately false.
    let fainted_a = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 0, // fainted
        max_hp: 100,
        stats: zero_stats(),
        known_skill_ids: vec![1],
        status: None,
    };

    let side_with_all_fainted = BattleSide {
        active: 0,
        team: vec![fainted_a],
    };

    assert!(
        !side_with_all_fainted.has_conscious_member(),
        "M7b-9: A BattleState built from a party where all monsters have \
         current_hp=0 is immediately terminal — has_conscious_member() = false. \
         start_battle MUST validate that at least one party monster has current_hp > 0. \
         Without this check, the player enters a battle they cannot take any \
         turn in, and the server has no defined behavior for the first auto-faint."
    );
}

#[test]
fn m7b_9b_duplicate_monster_id_in_party_spec_gap() {
    // Gap CLOSED: dedup is now enforced in server-module `start_battle` via a
    // HashSet rejection (~lib.rs:1180-1194). Covered by the server-module reducer
    // tests. This test retains the BattleSide shape assertions that document the
    // degenerate state a duplicate would create at the game-core level.

    let monster_a = make_battle_monster(100, 50);
    let monster_b = monster_a.clone(); // exact duplicate (same stats, different slot)

    let side = BattleSide {
        active: 0,
        team: vec![monster_a, monster_b],
    };

    // Both cloned slots appear alive — this is the degenerate state the
    // server-side HashSet guard prevents from ever reaching the DB.
    assert!(
        side.has_conscious_member(),
        "m7b_9b: a duplicate-slot side still has a conscious member (shape check)"
    );
    assert_eq!(
        side.team.len(),
        2,
        "m7b_9b: duplicate-slot side has two team entries (shape check)"
    );
}

// ===========================================================================
// FINDING M7b-10 (MEDIUM): The plan states #[non_exhaustive] is added to
// BattleEvent to allow M14 to add new variants. However, the battle table
// stores BattleState as a SpacetimeDB column using SpacetimeType derive.
// BattleEvent is NOT stored in the battle table (only BattleState is), but
// SpacetimeType is being added to BattleEvent per the plan.
//
// PROBLEM: SpacetimeType derive and #[non_exhaustive] are INCOMPATIBLE for
// deserialization. When a client compiled against an older schema (without the
// new variant) receives a BattleEvent with the new variant tag, the client's
// deserializer will panic or return an error — it does not know the new tag.
//
// This is a forward-compatibility hazard: the plan's goal of "M14 can add new
// variants without breaking exhaustive matches" is ONLY true for Rust pattern
// matching, NOT for the SpacetimeType wire format. Adding a new BattleEvent
// variant in M14 with existing clients breaks those clients.
//
// The plan must add: "BattleEvent is NOT stored as a SpacetimeType column.
// It is returned as a transient Vec<BattleEvent> from resolver calls and
// never persisted to the DB. The SpacetimeType derive on BattleEvent is
// therefore unnecessary and should be removed to avoid the false impression
// that it is schema-stable."
// ===========================================================================

// gap closed (type-level): BattleEvent does NOT derive SpacetimeType.
// The enforced invariant lives at game-core/src/combat/types.rs:121:
//   "DO NOT add SpacetimeType here — BattleEvent is transient (resolver return
//    value only, never stored in a table). Adding it would make new variants a
//    breaking wire-format change for old clients. See ADR-0042."
// No runtime assertion is possible for a compile-time derivation absence;
// the type definition is the enforcement. If SpacetimeType is ever added to
// BattleEvent, the types.rs comment and ADR-0042 will both contradict it.
// fn m7b_10_non_exhaustive_plus_spacetimetype_compatibility_spec_gap — removed (tautology)

// ===========================================================================
// FINDING M7b-11 (MEDIUM): XP reward formula uses loser's base_stat_total,
// but BattleMonster does not store species base stats — only derived stats.
// The XP formula needs the LOSER'S SPECIES base stat total (BST), but
// BattleMonster.stats is the DERIVED stats (computed from base+IV+EV+nature+level).
//
// The plan says: "On SideAWins via battle_xp_reward + apply_xp_gain".
// battle_xp_reward signature: fn(winner_level, loser_base_stat_total: u16, loser_level)
//
// Where does loser_base_stat_total come from? The write-back reducer must:
//   1. Look up the loser's species_id from the battle state.
//   2. Look up the species in species_row by species_id.
//   3. Sum the six base stats.
// This chain is NOT described in the plan. If the impl incorrectly passes
// BattleMonster.stats (derived) instead of species base stats, the XP reward
// is wildly inflated for high-level monsters (derived stats >> base stats).
// ===========================================================================

#[test]
fn m7b_11_derived_stats_vs_base_stats_xp_inflation() {
    // Prove that using derived stats vs base stats gives different (inflated) XP.
    let winner_level = Level::new(10).unwrap();
    let loser_level = Level::new(10).unwrap();

    // Flameling: base stat total = 45+49+49+65+65+45 = 318
    let loser_base_stat_total: u16 = 318;

    // Flameling level-100 DERIVED stat total (maximum case):
    // HP=714, Attack=609, Defense=609, Speed=761, SpAtk=761, SpDef=609 ≈ 4063
    let loser_derived_stat_total: u16 = 4063;

    let xp_correct = battle_xp_reward(winner_level, loser_base_stat_total, loser_level);
    let xp_inflated = battle_xp_reward(winner_level, loser_derived_stat_total, loser_level);

    assert!(
        xp_inflated.value() > xp_correct.value() * 5,
        "M7b-11: Using derived stats ({}) instead of base stats ({}) for XP reward \
         inflates XP by {}x. The write-back reducer MUST look up loser.species_id \
         in species_row, sum base stats, and pass that to battle_xp_reward. \
         Passing BattleMonster.stats (derived) is a {}-XP vs {}-XP difference.",
        loser_derived_stat_total,
        loser_base_stat_total,
        xp_inflated.value() / xp_correct.value().max(1),
        xp_inflated.value(),
        xp_correct.value()
    );
}

// ===========================================================================
// FINDING M7b-12 (LOW): The battle table is PUBLIC, and BattleState stores
// turn_number: u16. The maximum value is 65535 turns. A griefing player who
// never attacks (or always misses with low-accuracy skills, though accuracy is
// not player-controlled) can keep a PvP battle alive for a very long time.
//
// For PvE: the AI always acts, so battles terminate. Not a concern.
// For PvP (M16): if a player disconnects mid-battle, the battle row persists
// with outcome=Ongoing indefinitely. The opponent's monsters are locked in
// that battle (they cannot start a new one due to the double-battle guard).
// The plan does not specify a battle timeout.
//
// A turn limit at u16::MAX (65535) is the natural overflow guard, but 65535
// turns of a never-ending battle is a resource concern (the battle row stays
// in the public table forever).
// ===========================================================================

#[test]
fn m7b_12_battle_turn_number_max_value() {
    // Document the turn_number overflow bound.
    let mut state = ongoing_battle(100, 100);
    state.turn_number = u16::MAX;

    // If resolve_turn is called when turn_number = u16::MAX, it adds 1.
    // u16::MAX + 1 wraps to 0 in release builds — the turn counter resets.
    let next_turn = state.turn_number.wrapping_add(1);
    assert_eq!(
        next_turn, 0,
        "M7b-12: turn_number at u16::MAX wraps to 0 on the next turn. \
         A battle alive for 65535 turns has an ambiguous state after wrap. \
         The plan should add a maximum turn count (e.g., 500) after which \
         the battle is automatically resolved as a draw or opponent win, \
         preventing endless battles from locking monsters."
    );
}

// ===========================================================================
// FINDING M7b-13 (LOW): skill_id in submit_attack is not validated against
// the active monster's known_skill_ids.
//
// Attack: submit_attack(battle_id, skill_id=9999) where 9999 is not in the
// active monster's known_skill_ids.
//
// The plan says: "validate ... legality → delegate to game-core → ...".
// But resolve_turn calls resolve_one_attack which calls:
//   skills.iter().find(|s| s.id == skill_id).unwrap_or_else(|| panic!(...))
//
// So an unknown skill_id causes a PANIC in the resolver, which aborts the
// SpacetimeDB transaction. This is documented as "content integrity failure"
// in resolve.rs. For the SERVER, this means a player-supplied skill_id causes
// a reducer panic, which is a denial-of-service vector for the player's own
// battle (they lose the battle via panic) but not for other players.
//
// The submit_attack reducer MUST validate:
//   state.side_a.active_monster().known_skill_ids.contains(&skill_id)
// BEFORE calling resolve_turn.
// ===========================================================================

#[test]
fn m7b_13_unknown_skill_id_panics_in_resolver() {
    use crate::combat::type_chart::TypeChart;
    use crate::combat::{resolve_turn, types::TurnChoice};
    use crate::content::load_type_chart;

    let type_chart_data = load_type_chart().expect("type chart must parse");
    let chart = TypeChart::new(&type_chart_data);

    // Active monster knows only skill_id=1.
    let mut state = ongoing_battle(100, 100);

    let variance = TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    };

    // skill_id=9999 does not exist in the skills slice.
    // This WILL panic — proving that submit_attack must validate skill ownership first.
    // We use AssertUnwindSafe because &mut BattleState is not UnwindSafe by default.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 9999 }, // unknown skill
            TurnChoice::Attack { skill_id: 1 },
            &[], // empty skills registry — nothing will match
            &chart,
            &variance,
        );
    }));

    assert!(
        result.is_err(),
        "M7b-13: resolve_turn with an unknown skill_id must panic (content integrity). \
         The submit_attack reducer MUST validate skill_id is in \
         active_monster().known_skill_ids BEFORE calling resolve_turn, \
         to convert a panic into a clean Err return."
    );
}
