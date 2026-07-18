//! `pvp` — server-module domain submodule (M16, ADR-0109).
//!
//! PvP battle orchestration: challenge handshake, secret-pick submission,
//! both-submit resolution via the existing symmetric `resolve_full_turn`, and
//! liveness (turn-deadline scheduled reaper + forfeit-on-disconnect).
//! Challenge liveness: a scheduled TTL reaper deletes Pending challenges older
//! than `CHALLENGE_TTL_MS` (17.5e-1, ADR-0126); every challenge-deletion path
//! disarms its schedule row.
//!
//! Design invariants (ADR-0109):
//! - `battle_action` is PRIVATE (must-never-leak). Clients detect turn resolution
//!   by watching `battle.state.turn_number` increment on the public `battle` table.
//! - `start_battle` (the public reducer) retains its ADR-0048 provenance guard.
//!   PvP battles are created by the internal `start_pvp_battle` helper, never
//!   by routing through `start_battle`.
//! - Forfeit maps to the existing `SideAWins`/`SideBWins` outcomes; no new
//!   `BattleOutcome` variant is added (BSATN stability, ADR-0006).
//! - `PvpDeadlineSchedule` is colocated here (not in schema.rs) per the
//!   `scheduled(pvp_deadline_reaper)` cohabitation rule (ADR-0056 exception,
//!   same discipline as `movement_tick_schedule` in movement.rs).
//! - `settle_pvp_battle` is the single decisive-commit funnel: every terminal
//!   PvP outcome (both-submit, deadline forfeit, disconnect forfeit) commits
//!   through it, and it is the ONLY caller of `ranking::apply_pvp_rating`
//!   (ADR-0119 D3, amends ADR-0109 — exactly-once rating by construction).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::battle::write_back_battle_results;
use crate::content_cache::cached_skills;
use crate::guards::{
    check_monster_in_party, check_party_size, is_in_ongoing_battle, log_reject,
    reject_if_monster_in_trade, require_pvp_participant,
};
use crate::marshal::{
    battle_monster_from_row, build_ability_store, now_ms, pub_from_monster, type_chart_from_rows,
};
use crate::ranking;
use crate::schema::{
    battle, battle_action, battle_challenge, monster, monster_pub, player, skill_row, species_row,
    trade_offer, type_relation_row, Battle, BattleAction, BattleChallenge, ChallengeStatus,
    SkillRow,
};
use crate::WILD_IDENTITY;
use game_core::{
    apply_entry_ability, is_challenge_stale, load_abilities, pvp_deadline_forfeit_side,
    pvp_forfeit_outcome, resolve_full_turn, BattleMonster, BattleOutcome, BattleSide, BattleState,
    BattleStatusStore, PvpAction, SideId, StatusVariance, TurnVariance, CHALLENGE_TTL_MS,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};

/// Per-turn PvP deadline: 60 seconds from the start of each turn. The reaper
/// runs once per turn, forfeiting the side(s) that have not submitted.
const PVP_TURN_DEADLINE_MS: i64 = 60_000;

// ===========================================================================
// Scheduled table (colocated with its reducer, per ADR-0056 exception)
// ===========================================================================

/// One-shot reaper: fires `PVP_TURN_DEADLINE_MS` after a PvP turn starts.
/// PRIVATE (no `public`) — scheduling information is not client-facing.
/// Colocated with `pvp_deadline_reaper` so the `scheduled(...)` attribute
/// reference resolves within this module (mirrors `movement_tick_schedule`
/// in movement.rs).
#[spacetimedb::table(name = pvp_deadline_schedule, scheduled(pvp_deadline_reaper))]
pub struct PvpDeadlineSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    /// The PvP battle this schedule guards.
    pub battle_id: u64,
    /// The turn this schedule was issued for. Used by the reaper to detect
    /// stale schedules (issued for turn N, battle is now on turn N+1 → no-op).
    pub turn_number: u16,
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/// Schedule a one-shot deadline reaper for `battle_id` at turn `turn_number`.
/// Called from `accept_challenge` (turn 0) and `resolve_pvp_turn_if_ready`
/// (each subsequent turn).
fn schedule_deadline(ctx: &ReducerContext, battle_id: u64, turn_number: u16) {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let deadline_micros = now_micros.saturating_add(PVP_TURN_DEADLINE_MS * 1_000);
    let deadline = spacetimedb::Timestamp::from_micros_since_unix_epoch(deadline_micros);
    ctx.db.pvp_deadline_schedule().insert(PvpDeadlineSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(deadline),
        battle_id,
        turn_number,
    });
}

// ===========================================================================
// Challenge TTL reaper (17.5e-1, ADR-0126) — clone of the trade_offer_reaper
// (16.5f-4, ADR-0117)
// ===========================================================================

// Scheduled table colocated with its reducer (ADR-0056 exception, mirrors pvp_deadline_schedule).
// PRIVATE — prevents client schedule manipulation; the underlying facts are already public via battle_challenge.
#[spacetimedb::table(name = battle_challenge_reaper_schedule, scheduled(battle_challenge_reaper))]
pub struct BattleChallengeReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    /// The battle challenge this schedule guards (auto_inc — never reused, no ABA).
    #[index(btree)]
    pub challenge_id: u64,
}

/// Arm the TTL reaper for a newly-inserted challenge.
///
/// The deadline is computed FROM THE MS-FLOORED `created_at_ms` (not raw micros) —
/// kills the ms-truncation edge where the schedule could fire fractionally before
/// `is_challenge_stale`'s ms clock reaches the TTL boundary (ADR-0117 D4). The
/// adjacent `schedule_deadline` computes from raw now-micros and is NOT the
/// template here — this is a clone of trading.rs `schedule_trade_reaper`.
fn schedule_challenge_reaper(ctx: &ReducerContext, challenge_id: u64, created_at_ms: i64) {
    let deadline_micros = created_at_ms
        .saturating_mul(1_000)
        .saturating_add(CHALLENGE_TTL_MS.saturating_mul(1_000));
    ctx.db
        .battle_challenge_reaper_schedule()
        .insert(BattleChallengeReaperSchedule {
            scheduled_id: 0, // auto_inc
            scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
                deadline_micros,
            )),
            challenge_id,
        });
}

/// Disarm the reaper schedule(s) for `challenge_id`. Called at every
/// challenge-deletion site so no orphaned schedule row survives its challenge
/// (ADR-0126). Collect-before-delete (mirrors `disarm_trade_reaper`): gather
/// the scheduled_ids via the challenge_id btree filter first, then delete each
/// via the primary key.
fn disarm_challenge_reaper(ctx: &ReducerContext, challenge_id: u64) {
    let scheduled_ids: Vec<u64> = ctx
        .db
        .battle_challenge_reaper_schedule()
        .challenge_id()
        .filter(challenge_id)
        .map(|s| s.scheduled_id)
        .collect();
    for sid in scheduled_ids {
        ctx.db
            .battle_challenge_reaper_schedule()
            .scheduled_id()
            .delete(sid);
    }
}

// ===========================================================================
// Internal helpers (continued)
// ===========================================================================

/// Returns true if `identity` has any active (Pending) challenge as challenger.
fn has_active_outgoing_challenge(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .battle_challenge()
        .challenger()
        .filter(identity)
        .any(|c| c.status == ChallengeStatus::Pending)
}

/// Returns true if `identity` has any active (Pending) challenge targeting them.
fn has_active_incoming_challenge(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .battle_challenge()
        .target()
        .filter(identity)
        .any(|c| c.status == ChallengeStatus::Pending)
}

/// Build a team of `BattleMonster`s from `party_ids` owned by `owner`.
/// Validates each monster: exists, owned, party-slotted, not in trade.
/// Also returns the per-slot ability ids (parallel to the team vec).
fn build_pvp_team(
    ctx: &ReducerContext,
    party_ids: &[u64],
    owner: Identity,
    reducer: &str,
) -> Result<(Vec<BattleMonster>, Vec<Option<u32>>), String> {
    let mut team = Vec::with_capacity(party_ids.len());
    let mut ability_ids: Vec<Option<u32>> = Vec::with_capacity(party_ids.len());

    for &mid in party_ids {
        let m = ctx.db.monster().monster_id().find(mid).ok_or_else(|| {
            let e = format!("monster {mid} not found");
            log_reject(reducer, owner, &e);
            e
        })?;
        if m.owner_identity != owner {
            let e = format!("monster {mid} not owned by caller");
            log_reject(reducer, owner, &e);
            return Err(e);
        }
        if let Err(e) = check_monster_in_party(m.party_slot) {
            let e = format!("monster {mid} {e}");
            log_reject(reducer, owner, &e);
            return Err(e);
        }
        reject_if_monster_in_trade(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(owner)
                .chain(ctx.db.trade_offer().counterparty().filter(owner)),
            mid,
        )
        .inspect_err(|e| log_reject(reducer, owner, e))?;
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        ability_ids.push(sp.ability);
        team.push(battle_monster_from_row(&m, &sp, &skills)?);
    }
    Ok((team, ability_ids))
}

/// Create a PvP battle row directly (bypassing `start_battle`'s ADR-0048
/// provenance guard, which correctly rejects a client naming another player).
/// This is an internal function — called only from `accept_challenge`.
///
/// Returns the new `battle_id`.
pub(crate) fn start_pvp_battle(
    ctx: &ReducerContext,
    challenger: Identity,
    challenger_party: Vec<u64>,
    opponent: Identity,
    opponent_party: Vec<u64>,
) -> Result<u64, String> {
    let (team_a, ability_ids_a) =
        build_pvp_team(ctx, &challenger_party, challenger, "start_pvp_battle")?;
    let (team_b, ability_ids_b) =
        build_pvp_team(ctx, &opponent_party, opponent, "start_pvp_battle")?;

    if !team_a.iter().any(|m| !m.is_fainted()) {
        return Err("challenger party has no conscious monster".to_string());
    }
    if !team_b.iter().any(|m| !m.is_fainted()) {
        return Err("opponent party has no conscious monster".to_string());
    }

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: team_a,
        },
        side_b: BattleSide {
            active: 0,
            team: team_b,
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    // Apply entry abilities for both initial actives (ADR-0100).
    let ability_defs = load_abilities()?;
    let abilities = build_ability_store(&ability_ids_a, &ability_ids_b, &ability_defs);
    let mut status = BattleStatusStore {
        side_a: state.side_a.team.iter().map(|m| m.status).collect(),
        side_b: state.side_b.team.iter().map(|m| m.status).collect(),
    };
    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);
    apply_entry_ability(&mut state, SideId::SideB, &abilities, &mut status);
    for (m, s) in state.side_a.team.iter_mut().zip(status.side_a.iter()) {
        m.status = *s;
    }
    for (m, s) in state.side_b.team.iter_mut().zip(status.side_b.iter()) {
        m.status = *s;
    }

    let battle = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity: challenger,
        opponent_identity: opponent,
        state,
        party_monster_ids: challenger_party,
        opponent_monster_ids: opponent_party,
        created_at_ms: now_ms(ctx),
    });

    log::info!(
        "{{\"evt\":\"pvp_battle_start\",\"battle_id\":{},\"challenger\":\"{challenger}\",\"opponent\":\"{opponent}\"}}",
        battle.battle_id
    );
    Ok(battle.battle_id)
}

/// Apply forfeit to an ongoing PvP battle: set the forfeit outcome, then
/// delegate the entire terminal-commit sequence to `settle_pvp_battle`
/// (ADR-0119 D3) — the write-back/update/rating/side-B/sweep ordering
/// invariants live on the funnel, not here.
/// `forfeited_side`: SideA = challenger (player_identity); SideB = opponent.
fn apply_pvp_forfeit(
    ctx: &ReducerContext,
    mut battle: Battle,
    forfeited_side: SideId,
) -> Result<(), String> {
    battle.state.outcome = pvp_forfeit_outcome(forfeited_side);
    settle_pvp_battle(ctx, battle)
}

/// Check if both PvP participants have submitted actions for the current turn.
/// If so, collect the actions, delete them, resolve the turn, and reschedule
/// the deadline for the next turn. No-op if only one (or neither) has submitted.
fn resolve_pvp_turn_if_ready(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    // Re-read the battle row to get current turn_number and state.
    let mut battle = match ctx.db.battle().battle_id().find(battle_id) {
        Some(b) => b,
        None => return Ok(()),
    };
    if battle.state.outcome != BattleOutcome::Ongoing {
        return Ok(());
    }
    let current_turn = battle.state.turn_number;

    // Collect submitted actions for this turn (indexed by battle_id).
    let actions: Vec<BattleAction> = ctx
        .db
        .battle_action()
        .battle_id()
        .filter(battle_id)
        .filter(|a| a.turn_number == current_turn)
        .collect();

    // Need exactly two: one for each side.
    if actions.len() < 2 {
        return Ok(());
    }
    debug_assert!(
        actions.len() == 2,
        "expected exactly 2 actions for turn {current_turn} of battle {battle_id}, got {}",
        actions.len()
    );

    // Find side A (player_identity) and side B (opponent_identity) actions.
    let action_a = match actions
        .iter()
        .find(|a| a.player_identity == battle.player_identity)
    {
        Some(a) => a.action,
        None => return Ok(()),
    };
    let action_b = match actions
        .iter()
        .find(|a| a.player_identity == battle.opponent_identity)
    {
        Some(a) => a.action,
        None => return Ok(()),
    };

    // Consume the two action rows (they are turn-scoped; the next turn gets fresh ones).
    let action_ids: Vec<u64> = actions.iter().map(|a| a.action_id).collect();
    for id in action_ids {
        ctx.db.battle_action().action_id().delete(id);
    }

    // Build all inputs for resolve_full_turn (mirrors submit_attack in battle.rs).
    let skill_defs = cached_skills()?;
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter())?;
    let variance = TurnVariance::from_ctx_random(ctx.random());
    let sv = StatusVariance::from_ctx_random(ctx.random());

    let mut status = BattleStatusStore {
        side_a: battle.state.side_a.team.iter().map(|m| m.status).collect(),
        side_b: battle.state.side_b.team.iter().map(|m| m.status).collect(),
    };

    let ability_defs = load_abilities()?;
    let a_ability_ids: Vec<Option<u32>> = battle
        .state
        .side_a
        .team
        .iter()
        .map(|m| {
            ctx.db
                .species_row()
                .id()
                .find(m.species_id)
                .and_then(|sp| sp.ability)
        })
        .collect();
    let b_ability_ids: Vec<Option<u32>> = battle
        .state
        .side_b
        .team
        .iter()
        .map(|m| {
            ctx.db
                .species_row()
                .id()
                .find(m.species_id)
                .and_then(|sp| sp.ability)
        })
        .collect();
    let abilities = build_ability_store(&a_ability_ids, &b_ability_ids, &ability_defs);

    let _events = resolve_full_turn(
        &mut battle.state,
        action_a.into_turn_choice(),
        action_b.into_turn_choice(),
        skill_defs,
        &type_chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // Persist status back into BattleMonster.status (ongoing only).
    // Terminal-turn status is not flushed: HP is on BattleMonster directly (mutated
    // in-place by resolve_full_turn), so HP write-back is unaffected. End-of-battle
    // status is semantically irrelevant — the battle row transitions to a terminal
    // outcome immediately. This mirrors battle.rs (submit_attack / swap_active).
    if battle.state.outcome == BattleOutcome::Ongoing {
        for (m, s) in battle
            .state
            .side_a
            .team
            .iter_mut()
            .zip(status.side_a.iter())
        {
            m.status = *s;
        }
        for (m, s) in battle
            .state
            .side_b
            .team
            .iter_mut()
            .zip(status.side_b.iter())
        {
            m.status = *s;
        }
    }

    if battle.state.outcome != BattleOutcome::Ongoing {
        // Terminal: delegate the entire commit sequence to the settle funnel
        // (ADR-0119 D3) — the ordering invariants live there.
        settle_pvp_battle(ctx, battle)?;
    } else {
        // Reschedule the deadline for the new turn (turn_number was incremented by resolve_full_turn).
        schedule_deadline(ctx, battle_id, battle.state.turn_number);
        // Persist the advanced (still-Ongoing) state. Deliberately NOT the
        // chained `battle().battle_id().update(...)` form: the RT-M16-08 source
        // scan pins that needle to the TERMINAL commit ordering inside
        // settle_pvp_battle below; this ongoing-path persist is not a terminal
        // commit and must not shadow that needle.
        let battles = ctx.db.battle();
        battles.battle_id().update(battle);
    }
    Ok(())
}

/// Settle a PvP battle that has reached a terminal outcome — the ONE funnel
/// through which every decisive PvP result (both-submit resolution, deadline
/// forfeit, disconnect forfeit) commits (ADR-0119 D3, RL-10). Sole caller of
/// `ranking::apply_pvp_rating`, which makes rating application exactly-once
/// by construction.
///
/// Invariant commit order (unified verbatim from the two pre-M17 sites):
/// - `write_back_battle_results` runs while the battle row is still Ongoing in
///   the DB so its GC sweep targets only prior terminal rows, not the current
///   one (RT-M16-08). Log-and-continue (ADR-0077): cosmetic HP staleness only.
/// - The battle row update commits the terminal outcome and must precede
///   `write_back_party_hp_pvp_side_b` so that a side-B HP write-back failure
///   (e.g. ownership changed) cannot leave the battle stuck in `Ongoing`
///   (RT-M16-05). Write-backs use log-and-continue (ADR-0077).
/// - The rating rides the just-committed outcome (ADR-0119 D3 step 3) and is
///   infallible by construction (D6) — no error posture needed.
/// - The stale `battle_action` sweep runs last (hoisted from the forfeit path).
fn settle_pvp_battle(ctx: &ReducerContext, battle: Battle) -> Result<(), String> {
    let battle_id = battle.battle_id;

    // write_back_battle_results first — battle row is still Ongoing in DB so its
    // GC sweep does not delete the current row (RT-M16-08).
    if let Err(e) = write_back_battle_results(ctx, &battle) {
        log::error!(
            "{{\"evt\":\"pvp_settle_writeback_fail\",\"battle_id\":{battle_id},\"err\":\"{e}\"}}",
        );
    }

    // Commit terminal outcome AFTER write_back_battle_results (RT-M16-08) and
    // BEFORE write_back_party_hp_pvp_side_b (RT-M16-05). The clone is
    // load-bearing: `update` consumes a row by value, and `battle` is still
    // borrowed afterwards by apply_pvp_rating and write_back_party_hp_pvp_side_b.
    ctx.db.battle().battle_id().update(battle.clone());

    // Ranked-ladder rating on the just-committed outcome (ADR-0119 D3 step 3;
    // no-op for wild/practice battles and non-decisive outcomes).
    ranking::apply_pvp_rating(ctx, &battle);

    // Side-B HP write-back. Log-and-continue (ADR-0077): outcome already committed.
    if let Err(e) = write_back_party_hp_pvp_side_b(ctx, &battle) {
        log::error!(
            "{{\"evt\":\"pvp_settle_side_b_hp_fail\",\"battle_id\":{battle_id},\"err\":\"{e}\"}}",
        );
    }

    // Sweep any stale battle_action rows for this battle (collect-then-mutate).
    // No-op on the resolve path: the current turn's actions were deleted before
    // resolution, and SpacetimeDB within-transaction deletes are immediately
    // visible, so this re-reads an empty set.
    let stale_actions = ctx.db.battle_action().battle_id().filter(battle_id);
    let stale_actions: Vec<BattleAction> = stale_actions.collect();
    for action in stale_actions {
        ctx.db.battle_action().delete(action);
    }

    Ok(())
}

/// Write back HP for side B (opponent party) after a PvP battle ends.
/// Side A HP is handled by `write_back_battle_results` / `write_back_party_hp`.
/// This mirrors the side-A write-back pattern, applied to `opponent_monster_ids`.
fn write_back_party_hp_pvp_side_b(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    let team_b = &battle.state.side_b.team;
    let ids_b = &battle.opponent_monster_ids;
    if team_b.len() != ids_b.len() {
        return Err(format!(
            "write_back_party_hp_pvp_side_b: team/ids length mismatch ({} vs {}) \
             — invariant violation; PvP battles always populate both lists",
            team_b.len(),
            ids_b.len(),
        ));
    }
    for (bm, &mid) in team_b.iter().zip(ids_b.iter()) {
        if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
            if m.owner_identity != battle.opponent_identity {
                return Err(format!(
                    "write_back_party_hp_pvp_side_b: ownership changed for monster {mid}"
                ));
            }
            crate::marshal::write_back_hp(&mut m, bm);
            let pub_row = pub_from_monster(&m);
            ctx.db.monster().monster_id().update(m);
            ctx.db.monster_pub().monster_id().update(pub_row);
        }
    }
    Ok(())
}

// ===========================================================================
// on_disconnect helpers (called from lib.rs `on_disconnect`)
// ===========================================================================

/// Forfeit any ongoing PvP battle involving `disconnected` (either as challenger
/// or opponent). Called from `on_disconnect` BEFORE the player row is deleted.
pub(crate) fn forfeit_on_disconnect(ctx: &ReducerContext, disconnected: Identity) {
    // Collect battle_ids first (collect-then-mutate discipline — never mutate
    // a SpacetimeDB table while iterating over it).

    // Side A (challenger / player_identity):
    let side_a_ids: Vec<u64> = ctx
        .db
        .battle()
        .player_identity()
        .filter(disconnected)
        .filter(|b| {
            b.state.outcome == BattleOutcome::Ongoing && b.opponent_identity != WILD_IDENTITY
        })
        .map(|b| b.battle_id)
        .collect();

    // Side B (opponent / opponent_identity), using the new btree index:
    let side_b_ids: Vec<u64> = ctx
        .db
        .battle()
        .opponent_identity()
        .filter(disconnected)
        .filter(|b| {
            b.state.outcome == BattleOutcome::Ongoing && b.opponent_identity != WILD_IDENTITY
        })
        .map(|b| b.battle_id)
        .collect();

    for battle_id in side_a_ids {
        if let Some(battle) = ctx.db.battle().battle_id().find(battle_id) {
            // Re-check outcome (a previous loop iteration may have resolved this battle).
            if battle.state.outcome != BattleOutcome::Ongoing {
                continue;
            }
            if let Err(e) = apply_pvp_forfeit(ctx, battle, SideId::SideA) {
                log::error!(
                    "{{\"evt\":\"forfeit_on_disconnect_err\",\"battle_id\":{battle_id},\"reason\":\"{e}\"}}"
                );
            }
        }
    }

    for battle_id in side_b_ids {
        if let Some(battle) = ctx.db.battle().battle_id().find(battle_id) {
            if battle.state.outcome != BattleOutcome::Ongoing {
                continue;
            }
            if let Err(e) = apply_pvp_forfeit(ctx, battle, SideId::SideB) {
                log::error!(
                    "{{\"evt\":\"forfeit_on_disconnect_err\",\"battle_id\":{battle_id},\"reason\":\"{e}\"}}"
                );
            }
        }
    }
}

/// Delete pending outgoing challenges from `player` (as challenger) on disconnect.
/// Incoming challenges targeting `player` remain — the challenger might reconnect
/// and await. (ADR-0109 D9)
pub(crate) fn cancel_challenges_on_disconnect(ctx: &ReducerContext, player: Identity) {
    let pending_ids: Vec<u64> = ctx
        .db
        .battle_challenge()
        .challenger()
        .filter(player)
        .filter(|c| c.status == ChallengeStatus::Pending)
        .map(|c| c.challenge_id)
        .collect();
    for id in pending_ids {
        ctx.db.battle_challenge().challenge_id().delete(id);
        disarm_challenge_reaper(ctx, id);
    }
}

// ===========================================================================
// Reducers
// ===========================================================================

/// Send a PvP battle challenge to another online player.
///
/// Guard order (reject-not-clamp, decision-before-irreversible):
/// 1. Caller must be joined.
/// 2. Cannot challenge self.
/// 3. Target must be joined and online.
/// 4. Party size within bounds (1..=MAX_PARTY_SIZE).
/// 5. Caller not already in an ongoing battle (either role).
/// 6. Caller has no active outgoing challenge; target has no active incoming challenge targeting caller.
/// 7. Each party monster: exists, owned, party-slotted, not in trade.
/// 8. Insert BattleChallenge (the only irreversible effect).
/// 9. Arm TTL reaper (post-insert).
#[spacetimedb::reducer]
pub fn challenge_pvp(
    ctx: &ReducerContext,
    target: Identity,
    party_ids: Vec<u64>,
) -> Result<(), String> {
    let me = ctx.sender;

    // Guard 1: joined.
    if ctx.db.player().identity().find(me).is_none() {
        let e = "not joined".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 2: no self-challenges.
    if target == me {
        let e = "cannot challenge yourself".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 3: target must be joined and online.
    let target_player = ctx.db.player().identity().find(target);
    match &target_player {
        None => {
            let e = "target player not found".to_string();
            log_reject("challenge_pvp", me, &e);
            return Err(e);
        }
        Some(p) if !p.online => {
            let e = "target player is offline".to_string();
            log_reject("challenge_pvp", me, &e);
            return Err(e);
        }
        _ => {}
    }

    // Guard 4: party size.
    if let Err(e) = check_party_size(party_ids.len()) {
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 5: not already in a battle.
    if is_in_ongoing_battle(ctx, me) {
        let e = "already in an ongoing battle".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 5a: target must not be in an ongoing battle (RT-M16-01).
    if is_in_ongoing_battle(ctx, target) {
        let e = "target is already in an ongoing battle".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 5b: caller must not have a pending incoming challenge (H-2 reviewer).
    // A player with an unresolved incoming challenge cannot open an outgoing one —
    // they must accept or decline first.
    if has_active_incoming_challenge(ctx, me) {
        let e = "you have a pending incoming challenge — accept or decline it first".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 6: no duplicate pending challenge.
    if has_active_outgoing_challenge(ctx, me) {
        let e = "already have an active outgoing challenge".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }
    if has_active_incoming_challenge(ctx, target) {
        let e = "target already has a pending incoming challenge".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 7: validate party monsters (existence, ownership, slot, escrow).
    // Duplicate ID dedup (double-XP guard, mirrors start_battle).
    {
        let mut seen = std::collections::HashSet::new();
        for &mid in &party_ids {
            if !seen.insert(mid) {
                let e = format!("duplicate monster_id {mid} in party_ids");
                log_reject("challenge_pvp", me, &e);
                return Err(e);
            }
        }
    }
    for &mid in &party_ids {
        let m = ctx.db.monster().monster_id().find(mid).ok_or_else(|| {
            let e = format!("monster {mid} not found");
            log_reject("challenge_pvp", me, &e);
            e
        })?;
        if m.owner_identity != me {
            let e = format!("monster {mid} not owned by caller");
            log_reject("challenge_pvp", me, &e);
            return Err(e);
        }
        if let Err(e) = check_monster_in_party(m.party_slot) {
            let e = format!("monster {mid} {e}");
            log_reject("challenge_pvp", me, &e);
            return Err(e);
        }
        reject_if_monster_in_trade(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(me)
                .chain(ctx.db.trade_offer().counterparty().filter(me)),
            mid,
        )
        .inspect_err(|e| log_reject("challenge_pvp", me, e))?;
    }

    // Guard 8 (irreversible): insert the challenge row.
    let challenge = ctx.db.battle_challenge().insert(BattleChallenge {
        challenge_id: 0,
        challenger: me,
        target,
        challenger_party_ids: party_ids,
        status: ChallengeStatus::Pending,
        created_at_ms: now_ms(ctx),
    });

    // Guard 9: arm the TTL reaper (post-insert — the auto_inc challenge_id only
    // exists once the insert returns; ADR-0126).
    schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms);

    log::info!(
        "{{\"evt\":\"pvp_challenge\",\"challenge_id\":{},\"challenger\":\"{me}\",\"target\":\"{target}\"}}",
        challenge.challenge_id
    );
    Ok(())
}

/// Accept a pending PvP challenge. Creates the `battle` row and schedules the
/// turn deadline.
///
/// Guard order:
/// 1. Challenge exists.
/// 2. ctx.sender == challenge.target (only the target accepts).
/// 3. status == Pending.
/// 4. Neither party currently in an ongoing battle (re-checked here).
/// 5. Opponent (target) party size + monster validation.
/// 6. start_pvp_battle (creates the Battle row) — irreversible.
/// 7. schedule_deadline — post-battle scheduling.
/// 8. Delete the challenge row.
#[spacetimedb::reducer]
pub fn accept_challenge(
    ctx: &ReducerContext,
    challenge_id: u64,
    party_ids: Vec<u64>,
) -> Result<(), String> {
    let me = ctx.sender;

    // Guard 1: challenge exists.
    let challenge = ctx
        .db
        .battle_challenge()
        .challenge_id()
        .find(challenge_id)
        .ok_or_else(|| {
            let e = "challenge not found".to_string();
            log_reject("accept_challenge", me, &e);
            e
        })?;

    // Guard 2: caller must be the target.
    if challenge.target != me {
        let e = "not the challenge target".to_string();
        log_reject("accept_challenge", me, &e);
        return Err(e);
    }

    // Guard 3: must be Pending.
    if challenge.status != ChallengeStatus::Pending {
        let e = "challenge is not pending".to_string();
        log_reject("accept_challenge", me, &e);
        return Err(e);
    }

    // Guard 4: neither party in an ongoing battle.
    if is_in_ongoing_battle(ctx, me) {
        let e = "already in an ongoing battle".to_string();
        log_reject("accept_challenge", me, &e);
        return Err(e);
    }
    if is_in_ongoing_battle(ctx, challenge.challenger) {
        let e = "challenger is already in an ongoing battle".to_string();
        log_reject("accept_challenge", me, &e);
        return Err(e);
    }

    // Guard 5: party size.
    if let Err(e) = check_party_size(party_ids.len()) {
        log_reject("accept_challenge", me, &e);
        return Err(e);
    }

    // Guard 5 cont: duplicate dedup.
    {
        let mut seen = std::collections::HashSet::new();
        for &mid in &party_ids {
            if !seen.insert(mid) {
                let e = format!("duplicate monster_id {mid} in party_ids");
                log_reject("accept_challenge", me, &e);
                return Err(e);
            }
        }
    }

    // Guard 6 (irreversible): create the PvP battle.
    let battle_id = start_pvp_battle(
        ctx,
        challenge.challenger,
        challenge.challenger_party_ids.clone(),
        me,
        party_ids,
    )?;

    // Guard 7: schedule the first-turn deadline.
    schedule_deadline(ctx, battle_id, 0);

    // Guard 8: consume the challenge row (Accepted challenges are GC'd immediately —
    // ADR-0109 D6; mirrors terminal trade_offer deletion in trading.rs).
    ctx.db
        .battle_challenge()
        .challenge_id()
        .delete(challenge_id);
    disarm_challenge_reaper(ctx, challenge_id);

    log::info!(
        "{{\"evt\":\"pvp_accept\",\"challenge_id\":{challenge_id},\"battle_id\":{battle_id},\"target\":\"{me}\"}}"
    );
    Ok(())
}

/// Decline a pending PvP challenge. Deletes the challenge row.
#[spacetimedb::reducer]
pub fn decline_challenge(ctx: &ReducerContext, challenge_id: u64) -> Result<(), String> {
    let me = ctx.sender;

    let challenge = ctx
        .db
        .battle_challenge()
        .challenge_id()
        .find(challenge_id)
        .ok_or_else(|| {
            let e = "challenge not found".to_string();
            log_reject("decline_challenge", me, &e);
            e
        })?;
    if challenge.target != me {
        let e = "not the challenge target".to_string();
        log_reject("decline_challenge", me, &e);
        return Err(e);
    }
    if challenge.status != ChallengeStatus::Pending {
        let e = "challenge is not pending".to_string();
        log_reject("decline_challenge", me, &e);
        return Err(e);
    }

    ctx.db
        .battle_challenge()
        .challenge_id()
        .delete(challenge_id);
    disarm_challenge_reaper(ctx, challenge_id);
    log::info!("{{\"evt\":\"pvp_decline\",\"challenge_id\":{challenge_id},\"decliner\":\"{me}\"}}");
    Ok(())
}

/// Cancel a pending PvP challenge (initiator-only).
#[spacetimedb::reducer]
pub fn cancel_challenge(ctx: &ReducerContext, challenge_id: u64) -> Result<(), String> {
    let me = ctx.sender;

    let challenge = ctx
        .db
        .battle_challenge()
        .challenge_id()
        .find(challenge_id)
        .ok_or_else(|| {
            let e = "challenge not found".to_string();
            log_reject("cancel_challenge", me, &e);
            e
        })?;
    if challenge.challenger != me {
        let e = "not the challenge initiator".to_string();
        log_reject("cancel_challenge", me, &e);
        return Err(e);
    }
    if challenge.status != ChallengeStatus::Pending {
        let e = "challenge is not pending".to_string();
        log_reject("cancel_challenge", me, &e);
        return Err(e);
    }

    ctx.db
        .battle_challenge()
        .challenge_id()
        .delete(challenge_id);
    disarm_challenge_reaper(ctx, challenge_id);
    log::info!("{{\"evt\":\"pvp_cancel\",\"challenge_id\":{challenge_id},\"canceller\":\"{me}\"}}");
    Ok(())
}

/// Submit a PvP action (Attack or Swap) for the current turn.
///
/// Guard order:
/// 1. Battle exists.
/// 2. ctx.sender is player_identity (side A) or opponent_identity (side B).
/// 3. battle is PvP (opponent_identity != WILD_IDENTITY).
/// 4. outcome == Ongoing.
/// 5. Validate action against caller's active monster (skill in moveset / index legal).
/// 6. Double-submit guard: no existing BattleAction for (battle_id, caller, turn_number).
/// 7. Insert BattleAction (irreversible).
/// 8. Resolve turn if both sides have now submitted.
#[spacetimedb::reducer]
pub fn submit_pvp_action(
    ctx: &ReducerContext,
    battle_id: u64,
    action: PvpAction,
) -> Result<(), String> {
    let me = ctx.sender;

    // Guard 1: battle exists.
    let battle = ctx.db.battle().battle_id().find(battle_id).ok_or_else(|| {
        let e = "battle not found".to_string();
        log_reject("submit_pvp_action", me, &e);
        e
    })?;

    // Guard 2: participation check — returns SideId.
    let my_side = require_pvp_participant(ctx, "submit_pvp_action", &battle)?;

    // Guard 3: PvP only.
    if battle.opponent_identity == WILD_IDENTITY {
        let e = "not a PvP battle".to_string();
        log_reject("submit_pvp_action", me, &e);
        return Err(e);
    }

    // Guard 4: ongoing.
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("submit_pvp_action", me, &e);
        return Err(e);
    }

    let current_turn = battle.state.turn_number;

    // Guard 5: validate action against caller's active monster.
    let my_team = match my_side {
        SideId::SideA => &battle.state.side_a,
        SideId::SideB => &battle.state.side_b,
    };
    match action {
        PvpAction::Attack { skill_id } => {
            if !my_team.active_monster().known_skill_ids.contains(&skill_id) {
                let e = format!("skill {skill_id} not in active monster's moveset");
                log_reject("submit_pvp_action", me, &e);
                return Err(e);
            }
        }
        PvpAction::Swap { team_index } => {
            let idx = team_index as usize;
            if idx >= my_team.team.len() {
                let e = format!("team_index {team_index} out of bounds");
                log_reject("submit_pvp_action", me, &e);
                return Err(e);
            }
            if my_team.team[idx].is_fainted() {
                let e = format!("monster at index {team_index} is fainted");
                log_reject("submit_pvp_action", me, &e);
                return Err(e);
            }
            if my_team.active == team_index {
                let e = "already the active monster".to_string();
                log_reject("submit_pvp_action", me, &e);
                return Err(e);
            }
        }
    }

    // Guard 6: double-submit guard (no composite unique constraint in SpacetimeDB 2.6 —
    // same discipline as inventory single-stack; enforce in code).
    let already_submitted = ctx
        .db
        .battle_action()
        .battle_id()
        .filter(battle_id)
        .any(|a| a.player_identity == me && a.turn_number == current_turn);
    if already_submitted {
        let e = "already submitted an action for this turn".to_string();
        log_reject("submit_pvp_action", me, &e);
        return Err(e);
    }

    // Guard 7 (irreversible): record the action.
    ctx.db.battle_action().insert(BattleAction {
        action_id: 0,
        battle_id,
        player_identity: me,
        action,
        turn_number: current_turn,
        submitted_at_ms: now_ms(ctx),
    });

    log::info!(
        "{{\"evt\":\"pvp_action\",\"battle_id\":{battle_id},\"sender\":\"{me}\",\"turn\":{current_turn}}}"
    );

    // Guard 8: resolve the turn if both sides have now submitted.
    resolve_pvp_turn_if_ready(ctx, battle_id)
}

/// Scheduled reaper: delete a Pending battle challenge that has outlived
/// `CHALLENGE_TTL_MS` (17.5e-1, ADR-0126).
///
/// This is a SCHEDULER-ONLY reducer — clients must never call it directly.
/// Guard: `ctx.sender != ctx.identity()` (identical to `pvp_deadline_reaper`,
/// ADR-0056). Staleness is re-checked via `is_challenge_stale` so an early
/// fire or clock skew never reaps a fresh challenge. No status re-check:
/// non-Pending rows never persist (ADR-0109 D6), so the existence check is
/// the only row-state defense needed.
///
/// No self-disarm: one-shot `ScheduleAt::Time` rows are deleted BY THE RUNTIME
/// after the reducer returns ("Scheduled reducers delete the row after execution"
/// — SpacetimeDB docs, schedule-tables §Row Lifecycle; ADR-0109 D7 precedent).
/// A self-delete here would race the runtime's post-execution delete.
#[spacetimedb::reducer]
pub fn battle_challenge_reaper(
    ctx: &ReducerContext,
    args: BattleChallengeReaperSchedule,
) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("battle_challenge_reaper is scheduler-only".to_string());
    }
    let Some(challenge) = ctx
        .db
        .battle_challenge()
        .challenge_id()
        .find(args.challenge_id)
    else {
        return Ok(()); // challenge accepted/declined/cancelled before TTL — no-op (schedule row was consumed on fire)
    };
    if !is_challenge_stale(challenge.created_at_ms, now_ms(ctx)) {
        return Ok(()); // defensive: fired early/clock skew — never reap a fresh challenge
    }
    let challenge_id = args.challenge_id;
    log::info!("{{\"evt\":\"battle_challenge_reaped\",\"challenge_id\":{challenge_id}}}");
    ctx.db
        .battle_challenge()
        .challenge_id()
        .delete(args.challenge_id);
    Ok(())
}

/// Scheduled reaper: forfeit the non-submitting side when the turn deadline fires.
///
/// This is a SCHEDULER-ONLY reducer — clients must never call it directly.
/// Guard: `ctx.sender != ctx.identity()` (identical to `movement_tick` at
/// movement.rs:156, ADR-0056).
#[spacetimedb::reducer]
pub fn pvp_deadline_reaper(ctx: &ReducerContext, args: PvpDeadlineSchedule) -> Result<(), String> {
    // Scheduler-only guard (mirrors movement_tick).
    if ctx.sender != ctx.identity() {
        return Err("pvp_deadline_reaper is scheduler-only".to_string());
    }

    let battle_id = args.battle_id;
    let scheduled_turn = args.turn_number;

    // Load the battle; exit cleanly if it's gone or already resolved.
    let battle = match ctx.db.battle().battle_id().find(battle_id) {
        Some(b) => b,
        None => return Ok(()),
    };
    if battle.state.outcome != BattleOutcome::Ongoing {
        return Ok(());
    }

    // Stale-schedule check: if the battle has already advanced past the turn this
    // reaper was issued for, it means both sides submitted in time and the turn
    // resolved normally. No action needed.
    if battle.state.turn_number != scheduled_turn {
        return Ok(());
    }

    // Determine which sides have submitted for the current turn.
    let a_submitted = ctx
        .db
        .battle_action()
        .battle_id()
        .filter(battle_id)
        .any(|a| a.player_identity == battle.player_identity && a.turn_number == scheduled_turn);
    let b_submitted = ctx
        .db
        .battle_action()
        .battle_id()
        .filter(battle_id)
        .any(|a| a.player_identity == battle.opponent_identity && a.turn_number == scheduled_turn);

    // Both submitted: resolution is in-flight; this is a no-op safe path
    // (should be unreachable: resolve_pvp_turn_if_ready runs in the same txn
    // as the second submit, before the deadline fires).
    if a_submitted && b_submitted {
        return Ok(());
    }

    // Apply challenger-first tie-break (ADR-0109 D5).
    let forfeited_side = pvp_deadline_forfeit_side(a_submitted, b_submitted);

    log::info!(
        "{{\"evt\":\"pvp_deadline_forfeit\",\"battle_id\":{battle_id},\"turn\":{scheduled_turn},\"forfeited_side\":\"{forfeited_side:?}\"}}"
    );

    apply_pvp_forfeit(ctx, battle, forfeited_side)
}

// pvp.rs is a file-module (declared `mod pvp;` in `lib.rs`), so a plain
// `mod pvp_tests;` would resolve under `src/pvp/`; `#[path]` keeps the test
// file a sibling in `src/` (the game-core `*_tests.rs` convention, ADR-0056 map).
#[cfg(test)]
#[path = "pvp_tests.rs"]
mod pvp_tests;
