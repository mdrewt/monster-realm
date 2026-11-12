//! `pvp` — server-module domain submodule.
//!
//! PvP orchestration: the challenge handshake (the accept opens a TACTICAL battle), the
//! challenge TTL reaper and forfeit-on-disconnect. The 1v1 secret-pick path (the submit, the
//! both-submit resolution and the turn-deadline arming) is deleted since bt-17; the scheduled
//! `pvp_deadline_reaper` stays (scheduled-ness is fixed at first publish) and consumes rows
//! nothing arms.
//! Challenge liveness: a scheduled TTL reaper deletes Pending challenges older
//! than `CHALLENGE_TTL_MS`; every challenge-deletion path
//! disarms its schedule row.
//!
//! Design invariants:
//! - `battle_action` is PRIVATE (must-never-leak). Clients detect turn resolution
//!   by watching `battle.state.turn_number` increment on their own rows of the
//!   participant-scoped `my_battle` view (`battle` itself is private).
//! - Accepting a challenge opens a TACTICAL battle through `tactics::start_pvp_tactical`
//!   (bt-16: the one live PvP path; the 1v1 start is deleted).
//! - Forfeit maps to the existing `SideAWins`/`SideBWins` outcomes; no new
//!   `BattleOutcome` variant is added (BSATN stability).
//! - `PvpDeadlineSchedule` is colocated here (not in schema.rs) per the
//!   `scheduled(pvp_deadline_reaper)` cohabitation rule.
//! - `settle_pvp_battle` is the single decisive-commit funnel: every terminal
//!   PvP outcome (the deadline forfeit of a legacy anchor, the disconnect forfeit) commits
//!   through it, and it is the ONLY caller of `ranking::apply_pvp_rating`. A
//!   TACTICAL PvP battle (bt-14: forfeit, disconnect, the 4th auto-pass, Surge,
//!   adjudication) commits through it too, from `tactics::finish`, in
//!   `SideAWriteBack::HpOnly` mode — HP only; the tactical settlement pays.
//!   One named exception: the deletion cascade's forced-terminal fallback
//!   (`battle::anonymize_battles`) commits `SideAWins`/`SideBWins`
//!   outside this funnel, without rating, HP, XP, currency or evolution
//!   write-back and without the `battle_action` sweep.

use crate::battle::{write_back_battle_results, write_back_party_hp};
use crate::guards::{
    check_monster_in_party, check_party_size, is_in_ongoing_battle, log_reject,
    reject_if_monster_locked,
};
use crate::marshal::{char_state, now_ms};
use crate::monster_mgmt::update_monster_synced;
use crate::ranking;
use crate::schema::{
    battle, battle_action, battle_challenge, battle_tactical, character, monster, player, Battle,
    BattleAction, BattleChallenge, ChallengeStatus, Player,
};
use crate::WILD_IDENTITY;
use game_core::interact::within_interact_range;
use game_core::{
    is_challenge_stale, pvp_deadline_forfeit_side, pvp_forfeit_outcome, BattleOutcome, SideId,
    CHALLENGE_TTL_MS,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};

// ===========================================================================
// Ranked account gate
// ===========================================================================

/// The exact fail-closed placeholder committed in `accounts::ALLOWED_ISSUERS`
/// (SSOT: accounts.rs). If this value ever drifts from accounts.rs,
/// `ranked_enforcement_active()` flips true and the EA-RA-06a canary reds
/// loudly — drift cannot be silent.
const RANKED_PLACEHOLDER_ISSUER: &str = "https://auth.monster-realm.invalid/";

/// reject reason, caller leg. The VALUE is a client contract.
const ERR_RANKED_REQUIRES_ACCOUNT: &str = "ranked play requires an account";

/// EARS-1 reject reason, opponent leg (target in `challenge_pvp`, challenger
/// in `accept_challenge`). Distinct from the caller leg so the EA-RA-01 truth
/// table can pin which side failed and the client can phrase the two
/// differently.
const ERR_RANKED_OPPONENT_NEEDS_ACCOUNT: &str = "opponent must have an account for ranked play";

/// PURE: true iff at least one configured issuer is real, i.e.
/// differs from the committed fail-closed placeholder. Exact equality, not a
/// substring sniff: a mixed allowlist (real + leftover placeholder) must
/// ENFORCE, and a real issuer whose host merely contains `.invalid` as a
/// substring must count as real. Empty slice: false (no issuer can mint an
/// account, so the gate stays inert rather than bricking PvP for everyone).
fn issuers_configured(issuers: &[&str]) -> bool {
    issuers.iter().any(|i| *i != RANKED_PLACEHOLDER_ISSUER)
}

/// Deployment-conditional activation: the ranked account gate is
/// live iff this deployment can actually mint accounts. Today
/// `ALLOWED_ISSUERS` is the fail-closed placeholder, so the gate is INERT and
/// every existing PvP flow is unchanged. The moment a real issuer lands,
/// enforcement activates automatically.
fn ranked_enforcement_active() -> bool {
    issuers_configured(crate::accounts::ALLOWED_ISSUERS)
}

/// The ranked-eligibility decision. PURE — no ctx, no I/O — so
/// it is exhaustively unit-testable in-crate (reducer bodies are not). The
/// CALLER leg is evaluated first: when both parties are guests the caller
/// reason wins (EA-RA-01 pins this precedence). `is_account_holder` — never
/// `has_jwt`, which is true for every connection — supplies both booleans at
/// the call sites.
fn ranked_account_gate(
    enforced: bool,
    caller_has_account: bool,
    opponent_has_account: bool,
) -> Result<(), &'static str> {
    if !enforced {
        return Ok(());
    }
    if !caller_has_account {
        return Err(ERR_RANKED_REQUIRES_ACCOUNT);
    }
    if !opponent_has_account {
        return Err(ERR_RANKED_OPPONENT_NEEDS_ACCOUNT);
    }
    Ok(())
}

// ===========================================================================
// Scheduled table (colocated with its reducer)
// ===========================================================================

/// One-shot reaper schedule for the retired 1v1 turn deadline. Never armed since bt-17
/// (the arming path is deleted); the table and its reducer stay because scheduled-ness is
/// fixed at first publish. PRIVATE (no `public`) — scheduling information is not client-facing.
/// Colocated with `pvp_deadline_reaper` so the `scheduled(...)` attribute
/// reference resolves within this module (mirrors `movement_tick_schedule`
/// in movement.rs).
#[spacetimedb::table(accessor = pvp_deadline_schedule, scheduled(pvp_deadline_reaper))]
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

// ===========================================================================
// Challenge TTL reaper — clone of the trade_offer_reaper
// ===========================================================================

// Scheduled table colocated with its reducer.
// PRIVATE — prevents client schedule manipulation; the underlying facts are already public via battle_challenge.
#[spacetimedb::table(accessor = battle_challenge_reaper_schedule, scheduled(battle_challenge_reaper))]
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
/// `is_challenge_stale`'s ms clock reaches the TTL boundary. This is a clone of
/// trading.rs `schedule_trade_reaper`.
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
/// challenge-deletion site so no orphaned schedule row survives its challenge.
/// Collect-before-delete (mirrors `disarm_trade_reaper`): gather
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

/// bt-14 (BT14.1): the party-size format a challenge opens, derived from the challenger's
/// party pick — `min(party_len, MAX_PACK)` (ranked plays 3v3 by picking 3; casual 1–3). Pure.
pub(crate) fn challenge_format(party_len: usize) -> u8 {
    u8::try_from(party_len.min(usize::from(PVP_FORMAT_MAX))).unwrap_or(PVP_FORMAT_MAX)
}

/// The PvP format cap (design §6.1: ranked plays 3v3, casual picks 1–3). Equal to the wild pack
/// cap `MAX_PACK` at the design's numbers, but a separate rule — never aliased to it.
pub(crate) const PVP_FORMAT_MAX: u8 = 3;

/// Apply forfeit to an ongoing PvP battle: set the forfeit outcome, then
/// delegate the entire terminal-commit sequence to `settle_pvp_battle`
/// — the write-back/update/rating/side-B/sweep ordering
/// invariants live on the funnel, not here.
/// `forfeited_side`: SideA = challenger (player_identity); SideB = opponent.
fn apply_pvp_forfeit(
    ctx: &ReducerContext,
    mut battle: Battle,
    forfeited_side: SideId,
) -> Result<(), String> {
    battle.state.outcome = pvp_forfeit_outcome(forfeited_side);
    settle_pvp_battle(ctx, battle, SideAWriteBack::Legacy1v1).map(|_| ())
}

/// Which side-A write-back the decisive commit runs (bt-14). A 1v1 anchor pays the legacy credits
/// (`write_back_battle_results`: HP, the faint penalty, XP and currency on a side-A win, the
/// prior-terminal sweep). A TACTICAL anchor writes HP only (`write_back_party_hp`): the tactical
/// settlement (`tactics_settle`) owns its rewards (essence to the killer, both sides, no XP, no
/// currency), its penalties and its sweep — `write_back_battle_results`' side-A XP and currency
/// are exactly the M16a asymmetry design §7 removes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SideAWriteBack {
    Legacy1v1,
    HpOnly,
}

/// Settle a PvP battle that has reached a terminal outcome — the ONE funnel
/// through which every decisive PvP result (the deadline forfeit of a legacy
/// anchor, the disconnect forfeit, the tactical finish) commits. Sole caller of
/// `ranking::apply_pvp_rating`, which makes rating application exactly-once
/// by construction. One named exception: the deletion cascade's forced-terminal
/// fallback (`battle::anonymize_battles`) commits
/// `SideAWins`/`SideBWins` outside this funnel, without rating, HP, XP, currency
/// or evolution write-back and without the `battle_action` sweep.
///
/// Invariant commit order:
/// - `write_back_battle_results` runs while the battle row is still Ongoing in
///   the DB so its GC sweep targets only prior terminal rows, not the current
///   one. Log-and-continue: cosmetic HP staleness only.
/// - The battle row update commits the terminal outcome and must precede
///   `write_back_party_hp_pvp_side_b` so that a side-B HP write-back failure
///   (e.g. ownership changed) cannot leave the battle stuck in `Ongoing`.
///   Write-backs use log-and-continue.
/// - The rating rides the just-committed outcome and is
///   infallible by construction — no error posture needed.
/// - The stale `battle_action` sweep runs last (hoisted from the forfeit path).
pub(crate) fn settle_pvp_battle(
    ctx: &ReducerContext,
    battle: Battle,
    side_a: SideAWriteBack,
) -> Result<bool, String> {
    let battle_id = battle.battle_id;

    // Side A first. A 1v1 anchor is still Ongoing in the DB here, so the legacy write-back's
    // prior-terminal sweep cannot take it; a TACTICAL anchor arrives already terminal
    // (`tactics::store` wrote the outcome) and takes the HP-only write-back, which sweeps nothing.
    let side_a_ok = match side_a {
        SideAWriteBack::Legacy1v1 => write_back_battle_results(ctx, &battle),
        SideAWriteBack::HpOnly => write_back_party_hp(ctx, &battle),
    };
    let side_a_ok = match side_a_ok {
        Ok(()) => true,
        Err(e) => {
            // `e` is error text that may contain quotes — escape before interpolating.
            let escaped = crate::guards::json_escape(&e);
            log::error!(
                "{{\"evt\":\"pvp_settle_writeback_fail\",\"battle_id\":{battle_id},\"err\":\"{escaped}\"}}",
            );
            false
        }
    };

    // Commit the terminal outcome AFTER the side-A write-back and BEFORE
    // write_back_party_hp_pvp_side_b. The clone is load-bearing: `update` consumes a row by
    // value, and `battle` is still borrowed afterwards by apply_pvp_rating and the side-B write-back.
    ctx.db.battle().battle_id().update(battle.clone());

    // Ranked-ladder rating on the just-committed outcome (no-op for wild/practice battles and
    // non-decisive outcomes). THE ONLY CALLER.
    ranking::apply_pvp_rating(ctx, &battle);

    // Side-B HP write-back. Log-and-continue: the outcome is already committed.
    let side_b_ok = match write_back_party_hp_pvp_side_b(ctx, &battle) {
        Ok(()) => true,
        Err(e) => {
            let escaped = crate::guards::json_escape(&e);
            log::error!(
                "{{\"evt\":\"pvp_settle_side_b_hp_fail\",\"battle_id\":{battle_id},\"err\":\"{escaped}\"}}",
            );
            false
        }
    };

    // Sweep any stale battle_action rows for this battle (collect-then-mutate). No-op on the
    // resolve path (the turn's actions were deleted before resolution) and for a tactical anchor
    // (which never holds one).
    let stale_actions = ctx.db.battle_action().battle_id().filter(battle_id);
    let stale_actions: Vec<BattleAction> = stale_actions.collect();
    for action in stale_actions {
        ctx.db.battle_action().delete(action);
    }

    Ok(side_a_ok && side_b_ok)
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
            update_monster_synced(ctx, m)?;
        }
    }
    Ok(())
}

// ===========================================================================
// on_disconnect / deletion-cascade helpers (reached via lib.rs
// `resolve_all_live_interactions`, or per cascade step from accounts.rs)
// ===========================================================================

/// Forfeit any ongoing PvP battle involving `disconnected` (either as challenger
/// or opponent). Reached via `crate::resolve_all_live_interactions` from BOTH
/// `on_disconnect` (before the player row is deleted) and the deletion
/// cascade's step 6a (before the 6b erasures). An `apply_pvp_forfeit` Err is
/// logged and the loop continues, with no retry here: on a plain disconnect the
/// row waits for the next disconnect pass (nothing arms a deadline since bt-17); on the cascade path step 6c
/// (`battle::anonymize_battles`) forces any surviving `Ongoing` row terminal.
pub(crate) fn forfeit_on_disconnect(ctx: &ReducerContext, disconnected: Identity) {
    /// An Ongoing 1v1 PvP anchor. A tactical anchor (bt-14) is
    /// `tactics::resolve_tactical_on_disconnect`'s, which runs first and leaves it terminal; it
    /// must never route through the 1v1 credits.
    fn is_live_legacy_pvp(ctx: &ReducerContext, b: &Battle) -> bool {
        b.state.outcome == BattleOutcome::Ongoing
            && b.opponent_identity != WILD_IDENTITY
            && ctx
                .db
                .battle_tactical()
                .battle_id()
                .find(b.battle_id)
                .is_none()
    }
    // Collect battle_ids first (collect-then-mutate discipline — never mutate
    // a SpacetimeDB table while iterating over it).

    // Side A (challenger / player_identity):
    let side_a_ids: Vec<u64> = ctx
        .db
        .battle()
        .player_identity()
        .filter(disconnected)
        .filter(|b| is_live_legacy_pvp(ctx, b))
        .map(|b| b.battle_id)
        .collect();

    // Side B (opponent / opponent_identity), using the new btree index:
    let side_b_ids: Vec<u64> = ctx
        .db
        .battle()
        .opponent_identity()
        .filter(disconnected)
        .filter(|b| is_live_legacy_pvp(ctx, b))
        .map(|b| b.battle_id)
        .collect();

    for battle_id in side_a_ids {
        if let Some(battle) = ctx.db.battle().battle_id().find(battle_id) {
            // Re-check outcome (a previous loop iteration may have resolved this battle).
            if battle.state.outcome != BattleOutcome::Ongoing {
                continue;
            }
            if let Err(e) = apply_pvp_forfeit(ctx, battle, SideId::SideA) {
                let escaped = crate::guards::json_escape(&e);
                log::error!(
                    "{{\"evt\":\"forfeit_on_disconnect_err\",\"battle_id\":{battle_id},\"reason\":\"{escaped}\"}}"
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
                let escaped = crate::guards::json_escape(&e);
                log::error!(
                    "{{\"evt\":\"forfeit_on_disconnect_err\",\"battle_id\":{battle_id},\"reason\":\"{escaped}\"}}"
                );
            }
        }
    }
}

/// Delete pending outgoing challenges from `player` (as challenger) on disconnect.
/// Incoming challenges targeting `player` remain — the challenger might reconnect
/// and await.
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

/// delete every `battle_challenge` naming `owner` on EITHER side — challenger
/// AND target, any status (contrast `cancel_challenges_on_disconnect` above,
/// outgoing pending only) — disarming each challenge's TTL schedule row (the
/// JOIN_ONLY sweep riding its parent), then every `battle_action` the owner
/// submitted (per-turn secret picks; the identity column is unindexed, so
/// this is one of the cascade's two accepted linear scans). Called only from
/// `accounts::account_deletion_reaper`.
pub(crate) fn erase_pvp_rows(ctx: &ReducerContext, owner: Identity) {
    let mut challenge_ids: Vec<u64> = ctx
        .db
        .battle_challenge()
        .challenger()
        .filter(owner)
        .map(|c| c.challenge_id)
        .collect();
    challenge_ids.extend(
        ctx.db
            .battle_challenge()
            .target()
            .filter(owner)
            .map(|c| c.challenge_id),
    );
    for id in challenge_ids {
        disarm_challenge_reaper(ctx, id);
        ctx.db.battle_challenge().challenge_id().delete(id);
    }
    let action_ids: Vec<u64> = ctx
        .db
        .battle_action()
        .iter()
        .filter(|a| a.player_identity == owner)
        .map(|a| a.action_id)
        .collect();
    for id in action_ids {
        ctx.db.battle_action().action_id().delete(id);
    }
}

/// delete every `pvp_deadline_schedule` row guarding
/// `battle_id`. Lives HERE because pvp.rs is the only module touching that table (the
/// delegation doctrine's ownership rule; nothing inserts into it since bt-17); called per battle row from
/// `battle::anonymize_battles`, BEFORE that row's identity swap (after the
/// swap the join can no longer find it). The column is unindexed — a linear
/// scan over a table that holds no new rows since bt-17.
pub(crate) fn disarm_pvp_deadlines(ctx: &ReducerContext, battle_id: u64) {
    let ids: Vec<u64> = ctx
        .db
        .pvp_deadline_schedule()
        .iter()
        .filter(|s| s.battle_id == battle_id)
        .map(|s| s.scheduled_id)
        .collect();
    for id in ids {
        ctx.db.pvp_deadline_schedule().scheduled_id().delete(id);
    }
}

// ===========================================================================
// Reducers
// ===========================================================================

/// `challenge_pvp` reject reason when the two characters are not within interact range. One
/// text for a character in another zone, one too far away and a missing one.
const ERR_OUT_OF_RANGE: &str = "that player is not close enough to challenge";

/// True when the characters of `a` and `b` (each found through its `player` row's
/// `entity_id`) are within interact range of each other. A player with no character row is
/// out of range.
fn characters_in_interact_range(ctx: &ReducerContext, a: &Player, b: &Player) -> bool {
    let (Some(a), Some(b)) = (
        ctx.db.character().entity_id().find(a.entity_id),
        ctx.db.character().entity_id().find(b.entity_id),
    ) else {
        return false;
    };
    within_interact_range(a.zone_id, char_state(&a).pos, b.zone_id, char_state(&b).pos)
}

/// Send a PvP battle challenge to another online player, face to face.
///
/// Guard order (reject-not-clamp, decision-before-irreversible):
/// 1. Caller must be joined.
///    1a. Caller is not deletion-gated — new challenge
///    commitments only; live ones are untouched.
/// 2. Cannot challenge self.
/// 3. Target must be joined and online.
///    3a. Both characters stand within interact range (one refusal for another zone, too
///    far and a missing character). Sending only: accepting, declining and cancelling a
///    challenge have no range rule.
///    3b. Both parties hold a full account (ranked-only, issue #307).
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
    let me = ctx.sender();

    // Guard 1: joined.
    let Some(my_player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    };

    // Guard 1a: a deletion-gated caller cannot OPEN a new challenge.
    // Earlier than guard 3b on purpose: 3b's late placement bounds disclosure of a
    // THIRD PARTY's account state; this is a self-property and
    // discloses nothing about the target.
    crate::guards::require_not_deleting(ctx, "challenge_pvp")?;

    // Guard 2: no self-challenges.
    if target == me {
        let e = "cannot challenge yourself".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 3: target must be joined and online.
    let target_player = match ctx.db.player().identity().find(target) {
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
        Some(p) => p,
    };

    // Guard 3a: both characters stand within interact range. Ahead of every guard that
    // answers from the target's account, battles or challenges, so those answer only a
    // caller standing next to the target; a caller out of range learns guard 3 and no more.
    if !characters_in_interact_range(ctx, &my_player, &target_player) {
        let e = ERR_OUT_OF_RANGE.to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 3b: ranked play requires a full account —
    // BOTH parties. Placed after guards 3 and 3a so account existence is only ever
    // disclosed for an online target the caller stands next to, never for
    // arbitrary identities. The gate is inert
    // until a real auth issuer is configured.
    if let Err(reason) = ranked_account_gate(
        ranked_enforcement_active(),
        crate::accounts::is_account_holder(ctx, me),
        crate::accounts::is_account_holder(ctx, target),
    ) {
        let e = reason.to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
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

    // Guard 5a: target must not be in an ongoing battle.
    if is_in_ongoing_battle(ctx, target) {
        let e = "target is already in an ongoing battle".to_string();
        log_reject("challenge_pvp", me, &e);
        return Err(e);
    }

    // Guard 5b: caller must not have a pending incoming challenge.
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
    // Duplicate ID dedup (double-XP guard; the retired 1v1 start had the same check).
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
        reject_if_monster_locked(ctx, me, mid)
            .inspect_err(|e| log_reject("challenge_pvp", me, e))?;
    }

    // Guard 8 (irreversible): insert the challenge row (`format` from the pick, BT14.1).
    let format = challenge_format(party_ids.len());
    let challenge = ctx.db.battle_challenge().insert(BattleChallenge {
        challenge_id: 0,
        challenger: me,
        target,
        challenger_party_ids: party_ids,
        status: ChallengeStatus::Pending,
        created_at_ms: now_ms(ctx),
        format,
    });

    // Guard 9: arm the TTL reaper (post-insert — the auto_inc challenge_id only
    // exists once the insert returns).
    schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms);

    log::info!(
        "{{\"evt\":\"pvp_challenge\",\"challenge_id\":{},\"challenger\":\"{me}\",\"target\":\"{target}\"}}",
        challenge.challenge_id
    );
    Ok(())
}

/// Accept a pending PvP challenge. Opens a tactical PvP battle through
/// `tactics::start_pvp_tactical` (bt-16).
///
/// Guard order:
/// 1. Challenge exists.
/// 2. ctx.sender() == challenge.target (only the target accepts).
///    2a. Caller is not deletion-gated — accepting OPENS the battle
///    commitment; the pending challenge row itself is not force-terminated.
/// 3. status == Pending.
///    3a. Both parties hold a full account (re-checked at accept).
/// 4. Neither party currently in an ongoing battle (re-checked here).
/// 5. Opponent (target) party size + monster validation.
/// 6. `tactics::start_pvp_tactical` (the anchor, the Deploying tactical row, both clocks on
///    the 45 s deploy deadline, both owner-only staging rows, the deploy window) —
///    irreversible. A refusal returns BEFORE the challenge row is touched (it stays Pending,
///    its reaper armed); the challenger's own deletion gate is reported as "challenge is no
///    longer available" (the acceptor passed 2a, so the bare gate reason would disclose a
///    third party's account state).
/// 7. Delete the challenge row and disarm its reaper.
#[spacetimedb::reducer]
pub fn accept_challenge(
    ctx: &ReducerContext,
    challenge_id: u64,
    party_ids: Vec<u64>,
) -> Result<(), String> {
    let me = ctx.sender();

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

    // Guard 2a: authorization first, then refuse a deletion-gated caller before
    // any state read or write — accepting is what OPENS the battle commitment.
    crate::guards::require_not_deleting(ctx, "accept_challenge")?;

    // Guard 3: must be Pending.
    if challenge.status != ChallengeStatus::Pending {
        let e = "challenge is not pending".to_string();
        log_reject("accept_challenge", me, &e);
        return Err(e);
    }

    // Guard 3a: re-checked at accept time — load-bearing, not
    // redundant. Pending rows created before enforcement activation, and any
    // future account-status revocation, must never create a ranked battle;
    // the tactical start (guard 6, irreversible) is reached ONLY from here.
    if let Err(reason) = ranked_account_gate(
        ranked_enforcement_active(),
        crate::accounts::is_account_holder(ctx, me),
        crate::accounts::is_account_holder(ctx, challenge.challenger),
    ) {
        let e = reason.to_string();
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

    // Guard 6 (irreversible): open the TACTICAL battle (bt-16). The challenge's `format`
    // (bt-14, derived from the challenger's pick) is the battle's; a pre-bt-14 row carries 0
    // and is refused by the writer — reject, never clamp. The seed is drawn here, as every
    // caller of the writer must.
    let seed: u64 = ctx.random();
    let battle_id = crate::tactics::start_pvp_tactical(
        ctx,
        challenge.challenger,
        &challenge.challenger_party_ids,
        me,
        &party_ids,
        challenge.format,
        seed,
    )
    .map_err(|e| {
        // The acceptor passed guard 2a, so a deletion-gate refusal here is the CHALLENGER's:
        // report it without naming a third party's account state.
        let e = if e == crate::guards::REJECT_DELETION_GATED {
            "challenge is no longer available".to_string()
        } else {
            e
        };
        log_reject("accept_challenge", me, &e);
        e
    })?;

    // Guard 7: consume the challenge row (Accepted challenges are GC'd immediately —
    // mirrors terminal trade_offer deletion in trading.rs).
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
    let me = ctx.sender();

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
    let me = ctx.sender();

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

/// Scheduled reaper: delete a Pending battle challenge that has outlived
/// `CHALLENGE_TTL_MS`.
///
/// This is a SCHEDULER-ONLY reducer — clients must never call it directly.
/// Guard: `ctx.sender() != ctx.database_identity()` (identical to `pvp_deadline_reaper`).
/// Staleness is re-checked via `is_challenge_stale` so an early
/// fire or clock skew never reaps a fresh challenge. No status re-check:
/// non-Pending rows never persist, so the existence check is
/// the only row-state defense needed.
///
/// No self-disarm: one-shot `ScheduleAt::Time` rows are deleted BY THE RUNTIME
/// after the reducer returns ("Scheduled reducers delete the row after execution"
/// — SpacetimeDB docs, schedule-tables §Row Lifecycle).
/// A self-delete here would race the runtime's post-execution delete.
#[spacetimedb::reducer]
pub fn battle_challenge_reaper(
    ctx: &ReducerContext,
    args: BattleChallengeReaperSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
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

/// Scheduled reaper: forfeit the non-submitting side when the 1v1 turn deadline fires.
/// Never armed since bt-17 (no path inserts a `pvp_deadline_schedule` row); kept because a
/// table's scheduled-ness is fixed at first publish.
///
/// This is a SCHEDULER-ONLY reducer — clients must never call it directly.
/// Guard: `ctx.sender() != ctx.database_identity()` (identical to `movement_tick` at
/// movement.rs:156).
#[spacetimedb::reducer]
pub fn pvp_deadline_reaper(ctx: &ReducerContext, args: PvpDeadlineSchedule) -> Result<(), String> {
    // Scheduler-only guard (mirrors movement_tick).
    if ctx.sender() != ctx.database_identity() {
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
    // (unreachable: the 1v1 resolution ran in the same txn as the second submit,
    // before the deadline fired).
    if a_submitted && b_submitted {
        return Ok(());
    }

    // Apply challenger-first tie-break.
    let forfeited_side = pvp_deadline_forfeit_side(a_submitted, b_submitted);

    log::info!(
        "{{\"evt\":\"pvp_deadline_forfeit\",\"battle_id\":{battle_id},\"turn\":{scheduled_turn},\"forfeited_side\":\"{forfeited_side:?}\"}}"
    );

    apply_pvp_forfeit(ctx, battle, forfeited_side)
}

// pvp.rs is a file-module (declared `mod pvp;` in `lib.rs`), so a plain
// `mod pvp_tests;` would resolve under `src/pvp/`; `#[path]` keeps the test
// file a sibling in `src/`.
#[cfg(test)]
#[path = "pvp_tests.rs"]
mod pvp_tests;
