//! `trading_session` — trade sessions and the trade swap machinery.
//!
//! A session is two players each editing their own offer, each confirming the
//! revision they reviewed, and the swap executing in the confirm that completes
//! the pair. The reducers here are a thin shell over `game_core::trading`: they
//! read live rows into the rule facts, call the rule and write its result. This
//! module owns every write to `trade_session`, `trade_session_snapshot` and
//! `trade_session_reaper_schedule`; other modules end sessions through the
//! `pub(crate)` write halves (`cancel_sessions_listing`, `delete_sessions_of`,
//! `decline_sessions`).
//!
//! The swap machinery lives here too: the trade-time trainer-bond reset, the
//! netted receiver-stack construction and the atomic apply of a game-core
//! `SwapPlan`. The confirm that completes a pair is its only caller.

use crate::economy::{grant_currency, spend_currency, wallet_balance};
use crate::guards::{
    characters_in_interact_range, escrowed_currency_amount, escrowed_item_qty, json_escape,
    log_reject, offers_of, reject_if_in_battle, reject_if_monster_in_trade, session_lists_monster,
    session_locked_currency, session_locked_item_qty, sessions_of,
};
use crate::inventory::{consume_n, grant_item, item_count};
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{
    battle, inventory, item_row, monster, monster_pub, player, trade_session,
    trade_session_snapshot, Battle, Monster, TradeOffer, TradeSession, TradeSessionSnapshot,
};
use game_core::raising::rules::{reset_bond_on_trade, TrainerBond};
use game_core::trading::{
    apply_edit, arrival_slots, can_confirm, check_offer_eligibility, check_offer_size,
    check_session_open, is_session_stale, judge_execute, reset_confirms, side_check,
    snapshot_drifted, ExecuteVerdict, MonsterSnapshot, OwnedMonster, ReceiptFacts, SessionSide,
    SideFacts, TradeSessionError, TradeSessionOffer, TradeSessionState, TRADE_SESSION_TTL_MS,
};
use game_core::{
    build_swap_plan, check_headroom, make_monster_card, ApplyStep, ItemStack, LiveMonsterOwner,
    MonsterCard, SwapPlan, TradeItem, TradeSide,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};

/// Trade-time bond reset — the imperative half of game-core's
/// `reset_bond_on_trade` (decision "Trading resets the bond, not the monster"):
/// copy the seven Trust / Quality-Time columns into a `TrainerBond`, run the
/// rule, copy them back. The struct literal and the destructure both name every
/// field (no `..`), so a bond field added in game-core is a compile error here
/// until the row copies it; no other column of `m` is named, so this cannot
/// touch level, genes, xp or essence. Called from `apply_swap`'s transfer
/// loop only — never from the guest-claim re-key
/// (`monster_mgmt::rekey_monsters`), which is the SAME trainer under a new
/// identity.
fn reset_trainer_bond(m: &mut Monster) {
    let mut bond = TrainerBond {
        trust_favorable_count: m.trust_favorable_count,
        trust_unfavorable_count: m.trust_unfavorable_count,
        trust_favorable_battle_day_epoch: m.trust_favorable_battle_day_epoch,
        quality_time_ticks_total: m.quality_time_ticks_total,
        quality_time_accum_ms: m.quality_time_accum_ms,
        quality_time_window_ms: m.quality_time_window_ms,
        quality_time_window_start_ms: m.quality_time_window_start_ms,
    };
    reset_bond_on_trade(&mut bond);
    let TrainerBond {
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
    } = bond;
    m.trust_favorable_count = trust_favorable_count;
    m.trust_unfavorable_count = trust_unfavorable_count;
    m.trust_favorable_battle_day_epoch = trust_favorable_battle_day_epoch;
    m.quality_time_ticks_total = quality_time_ticks_total;
    m.quality_time_accum_ms = quality_time_accum_ms;
    m.quality_time_window_ms = quality_time_window_ms;
    m.quality_time_window_start_ms = quality_time_window_start_ms;
}

/// The display card of `m`: the fields a trade partner sees, no hidden genes.
fn card_of(m: &Monster) -> MonsterCard {
    make_monster_card(
        m.monster_id,
        m.species_id,
        m.nickname.clone(),
        m.level,
        m.current_hp,
        m.stat_hp,
    )
}

/// The receiver's post-debit stack for every item in `receiving`, in `receiving`
/// order: its live inventory count minus the qty of the same `item_id` it is
/// simultaneously `sending` (saturating at 0), so the headroom check sees the
/// effective count rather than the raw one. Without the netting a symmetric
/// same-item swap (give 15 of X, receive 20 of X while holding 9990) falsely
/// rejects: 9990+20>9999 but net 9990-15+20=9995 is fine.
pub(crate) fn netted_receiver_stacks(
    ctx: &ReducerContext,
    receiver: Identity,
    receiving: &[TradeItem],
    sending: &[TradeItem],
) -> Vec<ItemStack> {
    receiving
        .iter()
        .map(|ti| {
            let raw_count = item_count(ctx, receiver, ti.item_id);
            let sending_qty = sending
                .iter()
                .find(|si| si.item_id == ti.item_id)
                .map(|si| si.qty)
                .unwrap_or(0);
            ItemStack {
                item_id: ti.item_id,
                current_count: raw_count.saturating_sub(sending_qty),
            }
        })
        .collect()
}

/// Apply a `SwapPlan` between `initiator` and `counterparty`: every monster
/// transfer first (new owner, `dest_slot(monster_id)` as its party slot, bond
/// reset), then the item and currency steps in the debits-before-credits order
/// of `SwapPlan::ordered_steps()`. Writes land as they go, so the caller must
/// return any `Err` out of its reducer — that aborts the transaction and no
/// partial apply commits. `dest_slot` is written unchecked: the caller passes a
/// slot it has already validated for the new owner's party.
pub(crate) fn apply_swap(
    ctx: &ReducerContext,
    plan: &SwapPlan,
    initiator: Identity,
    counterparty: Identity,
    dest_slot: impl Fn(u64) -> u8,
) -> Result<(), String> {
    // Apply monster transfers (dual-write monster + monster_pub, set party_slot to the
    // destination slot, reset the trainer bond).
    for xfer in &plan.monster_transfers {
        let new_owner = if xfer.new_owner_idx == TradeSide::Counterparty {
            counterparty
        } else {
            initiator
        };

        let mut m = ctx
            .db
            .monster()
            .monster_id()
            .find(xfer.monster_id)
            .ok_or_else(|| format!("monster {} gone during apply", xfer.monster_id))?;
        m.owner_identity = new_owner;
        let slot = dest_slot(xfer.monster_id);
        m.party_slot = slot;
        // The monster changes trainer: its Trust / Quality-Time bond returns to the
        // fresh-monster baseline BEFORE the projection below, so `monster_pub`'s
        // derived tiers re-derive from the reset counters.
        reset_trainer_bond(&mut m);
        // Copy-forward tier: read the existing monster_pub row;
        // a missing row fails loud (same convention as the monster read above).
        let existing_pub = ctx
            .db
            .monster_pub()
            .monster_id()
            .find(xfer.monster_id)
            .ok_or_else(|| format!("monster_pub {} gone during apply", xfer.monster_id))?;
        let mut mp = pub_from_monster(&m, existing_pub.tier);
        mp.owner_identity = new_owner;
        mp.party_slot = slot;
        let moved = ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(mp);
        // A session that still lists this monster ends here: it has a new owner.
        cancel_sessions_listing(ctx, &moved);
    }

    // Apply item + currency transfers in the debits-before-credits order published
    // by game-core: ALL debits land before ANY credit, so a
    // same-item bilateral swap near a cap credits into an already-debited stack —
    // the caller's netted headroom check is exact and no clamping grant ever engages
    // (reject-not-clamp). Debit arms read from_initiator (sender); credit
    // arms read to_initiator (receiver) — game-core inverted at emission, so there
    // is NO inversion here.
    for step in plan.ordered_steps() {
        match step {
            ApplyStep::ItemDebit {
                from_initiator,
                item_id,
                qty,
            } => {
                let from = if from_initiator {
                    initiator
                } else {
                    counterparty
                };
                // consume_n returns Err if the stack is short — the whole transaction rolls back.
                consume_n(ctx, from, item_id, qty)?;
            }
            ApplyStep::CurrencyDebit {
                from_initiator,
                amount,
            } => {
                let from = if from_initiator {
                    initiator
                } else {
                    counterparty
                };
                // spend_currency returns Err if insufficient (broke-sender rejection
                // site) — the whole transaction rolls back.
                spend_currency(ctx, from, amount)?;
            }
            ApplyStep::ItemCredit {
                to_initiator,
                item_id,
                qty,
            } => {
                let to = if to_initiator {
                    initiator
                } else {
                    counterparty
                };
                grant_item(ctx, to, item_id, qty);
            }
            ApplyStep::CurrencyCredit {
                to_initiator,
                amount,
            } => {
                let to = if to_initiator {
                    initiator
                } else {
                    counterparty
                };
                grant_currency(ctx, to, amount);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Trade sessions
// ---------------------------------------------------------------------------

/// A missing session and a session the caller is not party to.
pub(crate) const ERR_SESSION_NOT_FOUND: &str = "trade session not found";
pub(crate) const ERR_NOT_JOINED: &str = "not joined";
pub(crate) const ERR_PARTNER_NOT_JOINED: &str = "that player is not a joined player";
/// Another zone, too far apart, and either character row missing.
pub(crate) const ERR_OUT_OF_RANGE: &str = "that player is not close enough to trade";
/// Every failure after both sides passed their checks. Fixed text: the
/// underlying message could describe the other participant's rows.
pub(crate) const ERR_EXECUTE_FAILED: &str = "trade could not be completed";

/// Log a refusal under the caller's identity and return it.
fn reject<T>(reducer: &str, who: Identity, reason: impl std::fmt::Display) -> Result<T, String> {
    let reason = reason.to_string();
    log_reject(reducer, who, &reason);
    Err(reason)
}

// --- TTL reaper ------------------------------------------------------------

// Scheduled table colocated with its reducer. PRIVATE: a client must not be
// able to read or edit a session's deadline.
#[spacetimedb::table(accessor = trade_session_reaper_schedule, scheduled(trade_session_reaper))]
pub struct TradeSessionReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    /// The session this schedule guards (auto_inc, never reused).
    #[index(btree)]
    pub session_id: u64,
}

/// Arm the TTL reaper for a new session. The deadline is computed from the
/// ms-floored `created_at_ms`, so the schedule can never fire before
/// `is_session_stale`'s ms clock reaches the TTL boundary.
fn arm_session_reaper(ctx: &ReducerContext, session_id: u64, created_at_ms: i64) {
    let deadline_micros = created_at_ms
        .saturating_mul(1_000)
        .saturating_add(TRADE_SESSION_TTL_MS.saturating_mul(1_000));
    ctx.db
        .trade_session_reaper_schedule()
        .insert(TradeSessionReaperSchedule {
            scheduled_id: 0, // auto_inc
            scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
                deadline_micros,
            )),
            session_id,
        });
}

// --- Delete sites ----------------------------------------------------------

/// Delete a session's snapshot rows, then the session row. The only place a
/// `trade_session` row is deleted.
fn delete_session_rows(ctx: &ReducerContext, session_id: u64) {
    delete_snapshots(ctx, session_id, |_| true);
    ctx.db.trade_session().session_id().delete(session_id);
}

/// Delete the snapshot rows of `session_id` whose monster `which` selects.
fn delete_snapshots(ctx: &ReducerContext, session_id: u64, which: impl Fn(u64) -> bool) {
    let snapshot_ids: Vec<u64> = ctx
        .db
        .trade_session_snapshot()
        .session_id()
        .filter(session_id)
        .filter(|row| which(row.monster_id))
        .map(|row| row.snapshot_id)
        .collect();
    for snapshot_id in snapshot_ids {
        ctx.db
            .trade_session_snapshot()
            .snapshot_id()
            .delete(snapshot_id);
    }
}

/// End a session: disarm its TTL schedule row, then delete its snapshot rows
/// and the session row. Every path that ends a session calls this, except the
/// reaper, whose own fired schedule row the runtime deletes.
fn delete_session(ctx: &ReducerContext, session_id: u64) {
    let scheduled_ids: Vec<u64> = ctx
        .db
        .trade_session_reaper_schedule()
        .session_id()
        .filter(session_id)
        .map(|row| row.scheduled_id)
        .collect();
    for scheduled_id in scheduled_ids {
        ctx.db
            .trade_session_reaper_schedule()
            .scheduled_id()
            .delete(scheduled_id);
    }
    delete_session_rows(ctx, session_id);
}

/// Delete every session `who` is in, as opener or as partner. Called when the
/// player disconnects, when their account is erased, and for both identities
/// of a guest claim.
pub(crate) fn delete_sessions_of(ctx: &ReducerContext, who: Identity) {
    let session_ids: Vec<u64> = sessions_of(ctx, who).map(|s| s.session_id).collect();
    for session_id in session_ids {
        delete_session(ctx, session_id);
    }
}

/// The sessions opened WITH `partner`, as `(session_id, created_at_ms)`: the
/// rows `accounts::plan_declines_at_cancel` judges against a deletion request.
/// Partner column only — a deletion-gated player cannot open a session.
pub(crate) fn open_sessions_addressed_to(
    ctx: &ReducerContext,
    partner: Identity,
) -> Vec<(u64, i64)> {
    ctx.db
        .trade_session()
        .partner()
        .filter(partner)
        .map(|s| (s.session_id, s.created_at_ms))
        .collect()
}

/// Delete the given sessions. Called from `accounts::cancel_account_deletion`
/// with the ids `accounts::plan_declines_at_cancel` selected.
pub(crate) fn decline_sessions(ctx: &ReducerContext, session_ids: &[u64]) {
    for &session_id in session_ids {
        delete_session(ctx, session_id);
    }
}

// --- Auto-cancel at the monster write seam -----------------------------------

/// End every session that lists `written` when the row, as just written, is
/// not its offerer's to give: it has another owner, it left the party, or it
/// fainted. The verdict is the eligibility rule's own, asked about this
/// one monster; a write that keeps the monster offerable ends nothing.
///
/// Called after every monster write that can re-own, box or faint a monster:
/// `monster_mgmt::update_monster_synced` and `apply_swap`.
pub(crate) fn cancel_sessions_listing(ctx: &ReducerContext, written: &Monster) {
    let session_ids: Vec<u64> = ctx
        .db
        .trade_session_snapshot()
        .monster_id()
        .filter(written.monster_id)
        .map(|row| row.session_id)
        .collect();
    for session_id in session_ids {
        let Some(session) = ctx.db.trade_session().session_id().find(session_id) else {
            continue;
        };
        let offerer = if session
            .opener_offer
            .monster_ids
            .contains(&written.monster_id)
        {
            session.opener
        } else if session
            .partner_offer
            .monster_ids
            .contains(&written.monster_id)
        {
            session.partner
        } else {
            continue;
        };
        if !still_offerable(written, offerer) {
            delete_session(ctx, session_id);
            log::info!(
                "{{\"evt\":\"trade_session_auto_cancelled\",\"session_id\":{session_id},\"monster_id\":{}}}",
                written.monster_id
            );
        }
    }
}

/// Whether `offerer` could still offer `m`, judged on the owner, the party
/// slot and the HP alone: the eligibility rule over this one monster, with
/// nothing else on the side.
fn still_offerable(m: &Monster, offerer: Identity) -> bool {
    let rows: Vec<OwnedMonster> = if m.owner_identity == offerer {
        vec![OwnedMonster {
            monster_id: m.monster_id,
            party_slot: m.party_slot,
            current_hp: m.current_hp,
            in_other_trade: false,
            in_battle: false,
        }]
    } else {
        Vec::new()
    };
    check_offer_eligibility(&SideFacts {
        monster_ids: &[m.monster_id],
        items: &[],
        currency: 0,
        monster_rows: &rows,
        known_item_ids: &[],
        stacks: &[],
        locked_stacks: &[],
        balance: 0,
        locked_currency: 0,
    })
    .is_ok()
}

// --- Session row helpers ---------------------------------------------------

fn side_of(session: &TradeSession, who: Identity) -> Option<SessionSide> {
    if session.opener == who {
        Some(SessionSide::Opener)
    } else if session.partner == who {
        Some(SessionSide::Partner)
    } else {
        None
    }
}

fn other_side(side: SessionSide) -> SessionSide {
    match side {
        SessionSide::Opener => SessionSide::Partner,
        SessionSide::Partner => SessionSide::Opener,
    }
}

fn party_of(session: &TradeSession, side: SessionSide) -> Identity {
    match side {
        SessionSide::Opener => session.opener,
        SessionSide::Partner => session.partner,
    }
}

fn offer_of(session: &TradeSession, side: SessionSide) -> &TradeSessionOffer {
    match side {
        SessionSide::Opener => &session.opener_offer,
        SessionSide::Partner => &session.partner_offer,
    }
}

fn is_confirmed(session: &TradeSession, side: SessionSide) -> bool {
    match side {
        SessionSide::Opener => session.opener_confirmed,
        SessionSide::Partner => session.partner_confirmed,
    }
}

fn set_confirmed(session: &mut TradeSession, side: SessionSide, confirmed: bool) {
    match side {
        SessionSide::Opener => session.opener_confirmed = confirmed,
        SessionSide::Partner => session.partner_confirmed = confirmed,
    }
}

fn state_offer_mut(state: &mut TradeSessionState, side: SessionSide) -> &mut TradeSessionOffer {
    match side {
        SessionSide::Opener => &mut state.opener_offer,
        SessionSide::Partner => &mut state.partner_offer,
    }
}

/// The columns of `session` the edit and confirm rules read and write.
fn state_of(session: &TradeSession) -> TradeSessionState {
    TradeSessionState {
        opener_offer: session.opener_offer.clone(),
        partner_offer: session.partner_offer.clone(),
        opener_confirmed: session.opener_confirmed,
        partner_confirmed: session.partner_confirmed,
        revision: session.revision,
    }
}

/// `session` with the rule columns replaced by `state`.
fn with_state(session: TradeSession, state: TradeSessionState) -> TradeSession {
    TradeSession {
        opener_offer: state.opener_offer,
        partner_offer: state.partner_offer,
        opener_confirmed: state.opener_confirmed,
        partner_confirmed: state.partner_confirmed,
        revision: state.revision,
        ..session
    }
}

/// The session `session_id` together with the caller's side of it. A session
/// that does not exist and one the caller is not party to are the same
/// refusal.
fn find_own_session(
    ctx: &ReducerContext,
    reducer: &str,
    session_id: u64,
) -> Result<(TradeSession, SessionSide), String> {
    let me = ctx.sender();
    let own = ctx
        .db
        .trade_session()
        .session_id()
        .find(session_id)
        .and_then(|session| side_of(&session, me).map(|side| (session, side)));
    match own {
        Some(found) => Ok(found),
        None => reject(reducer, me, ERR_SESSION_NOT_FOUND),
    }
}

// --- Review snapshots ----------------------------------------------------------

/// Every column of `m` except the owner. The destructure names every field,
/// so a column added to `monster` does not compile until it is copied here.
fn snapshot_of(m: &Monster) -> MonsterSnapshot {
    let Monster {
        monster_id,
        owner_identity: _,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    } = m.clone();
    MonsterSnapshot {
        monster_id,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    }
}

/// The snapshot row stored for one offered monster: `snapshot` with the
/// columns a partner does not review blanked.
fn snapshot_row(session_id: u64, snapshot: MonsterSnapshot) -> TradeSessionSnapshot {
    let MonsterSnapshot {
        monster_id,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    } = snapshot.masked();
    TradeSessionSnapshot {
        snapshot_id: 0, // auto_inc
        session_id,
        monster_id,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    }
}

fn snapshot_from_row(row: &TradeSessionSnapshot) -> MonsterSnapshot {
    let TradeSessionSnapshot {
        snapshot_id: _,
        session_id: _,
        monster_id,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    } = row.clone();
    MonsterSnapshot {
        monster_id,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    }
}

// --- Live facts ------------------------------------------------------------

/// One side's live rows, read once per reducer call, in the shape the
/// session rules take them.
struct SideLive {
    /// The offered monsters the side owns, live.
    owned: Vec<Monster>,
    monster_rows: Vec<OwnedMonster>,
    known_item_ids: Vec<u32>,
    stacks: Vec<ItemStack>,
    locked_stacks: Vec<ItemStack>,
    balance: u64,
    locked_currency: u64,
    owned_monster_count: usize,
}

impl SideLive {
    fn facts<'a>(&'a self, offer: &'a TradeSessionOffer) -> SideFacts<'a> {
        SideFacts {
            monster_ids: &offer.monster_ids,
            items: &offer.items,
            currency: offer.currency,
            monster_rows: &self.monster_rows,
            known_item_ids: &self.known_item_ids,
            stacks: &self.stacks,
            locked_stacks: &self.locked_stacks,
            balance: self.balance,
            locked_currency: self.locked_currency,
        }
    }

    fn receipt<'a>(&self, incoming: &'a TradeSessionOffer) -> ReceiptFacts<'a> {
        ReceiptFacts {
            owned_monster_count: self.owned_monster_count,
            incoming,
        }
    }
}

/// Read `who`'s side of session `session_id` for `offer`. `who`'s legacy
/// offers, other sessions and battles are each collected once, so the work is
/// bounded by those rows plus the offer's length. Locks and the
/// already-in-a-trade fact count every trade of `who` EXCEPT this session:
/// its own confirmed side must not count against itself.
fn read_side(
    ctx: &ReducerContext,
    who: Identity,
    session_id: u64,
    offer: &TradeSessionOffer,
) -> SideLive {
    let legacy: Vec<TradeOffer> = offers_of(ctx, who).collect();
    let others: Vec<TradeSession> = sessions_of(ctx, who)
        .filter(|s| s.session_id != session_id)
        .collect();
    let battles: Vec<Battle> = ctx
        .db
        .battle()
        .player_identity()
        .filter(who)
        .chain(ctx.db.battle().opponent_identity().filter(who))
        .collect();
    let owned: Vec<Monster> = offer
        .monster_ids
        .iter()
        .filter_map(|&id| ctx.db.monster().monster_id().find(id))
        .filter(|m| m.owner_identity == who)
        .collect();
    let monster_rows = owned
        .iter()
        .map(|m| OwnedMonster {
            monster_id: m.monster_id,
            party_slot: m.party_slot,
            current_hp: m.current_hp,
            in_other_trade: reject_if_monster_in_trade(legacy.iter(), m.monster_id).is_err()
                || session_lists_monster(others.iter(), m.monster_id),
            in_battle: reject_if_in_battle(battles.iter(), m.monster_id).is_err(),
        })
        .collect();
    let known_item_ids = offer
        .items
        .iter()
        .map(|item| item.item_id)
        .filter(|&item_id| ctx.db.item_row().id().find(item_id).is_some())
        .collect();
    let stacks = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(who)
        .map(|row| ItemStack {
            item_id: row.item_id,
            current_count: row.count,
        })
        .collect();
    let locked_stacks = offer
        .items
        .iter()
        .map(|item| ItemStack {
            item_id: item.item_id,
            current_count: escrowed_item_qty(legacy.iter(), who, item.item_id)
                .saturating_add(session_locked_item_qty(others.iter(), who, item.item_id)),
        })
        .collect();
    SideLive {
        monster_rows,
        known_item_ids,
        stacks,
        locked_stacks,
        balance: wallet_balance(ctx, who),
        locked_currency: escrowed_currency_amount(legacy.iter(), who)
            .saturating_add(session_locked_currency(others.iter(), who)),
        owned_monster_count: ctx.db.monster().owner_identity().filter(who).count(),
        owned,
    }
}

// --- Reducers --------------------------------------------------------------

/// Open a blank trade session with `partner`, face to face.
///
/// In order: the caller is joined; the caller is not deletion-gated; `partner`
/// is joined; both characters stand within interact range (one refusal for
/// another zone, too far and a missing character); the session-open rule
/// (not oneself, no session with this player yet, fewer than
/// `MAX_OPEN_TRADE_SESSIONS` opened by the caller). Nothing of `partner`'s
/// account, wallet, inventory, monsters or sessions is read.
#[spacetimedb::reducer]
pub fn open_trade_session(ctx: &ReducerContext, partner: Identity) -> Result<(), String> {
    let me = ctx.sender();
    if ctx.db.player().identity().find(me).is_none() {
        return reject("open_trade_session", me, ERR_NOT_JOINED);
    }
    crate::guards::require_not_deleting(ctx, "open_trade_session")?;
    if ctx.db.player().identity().find(partner).is_none() {
        return reject("open_trade_session", me, ERR_PARTNER_NOT_JOINED);
    }
    if !characters_in_interact_range(ctx, me, partner) {
        return reject("open_trade_session", me, ERR_OUT_OF_RANGE);
    }
    let mine: Vec<(Identity, Identity)> = sessions_of(ctx, me)
        .map(|s| (s.opener, s.partner))
        .collect();
    if let Err(e) = check_session_open(&mine, &me, &partner) {
        return reject("open_trade_session", me, e);
    }

    let session = ctx.db.trade_session().insert(TradeSession {
        session_id: 0, // auto_inc
        opener: me,
        partner,
        opener_offer: TradeSessionOffer::default(),
        partner_offer: TradeSessionOffer::default(),
        opener_confirmed: false,
        partner_confirmed: false,
        revision: 0,
        created_at_ms: now_ms(ctx),
    });
    arm_session_reaper(ctx, session.session_id, session.created_at_ms);
    log::info!(
        "{{\"evt\":\"trade_session_opened\",\"session_id\":{},\"opener\":\"{me}\",\"partner\":\"{partner}\"}}",
        session.session_id
    );
    Ok(())
}

/// Replace the caller's own side of a session. The three asset arguments are
/// always the caller's: no argument names the other side's assets.
///
/// In order: the caller is not deletion-gated; the request is within the
/// per-side size caps; the session exists and the caller is party to it; the
/// caller's side is not confirmed; the offer is eligible on live rows. An
/// accepted edit rebuilds the caller's cards and review snapshots, advances
/// the revision and clears both confirms. The other side's offer is untouched.
#[spacetimedb::reducer]
pub fn set_trade_offer(
    ctx: &ReducerContext,
    session_id: u64,
    monster_ids: Vec<u64>,
    items: Vec<TradeItem>,
    currency: u64,
) -> Result<(), String> {
    crate::guards::require_not_deleting(ctx, "set_trade_offer")?;
    let me = ctx.sender();
    if let Err(e) = check_offer_size(monster_ids.len(), items.len()) {
        return reject("set_trade_offer", me, e);
    }
    let (session, side) = find_own_session(ctx, "set_trade_offer", session_id)?;
    let previous_ids = offer_of(&session, side).monster_ids.clone();
    let request = TradeSessionOffer {
        monster_ids,
        items,
        currency,
        cards: Vec::new(),
    };
    let mut edited = match apply_edit(state_of(&session), side, request) {
        Ok(edited) => edited,
        Err(e) => return reject("set_trade_offer", me, e),
    };
    let offer = state_offer_mut(&mut edited, side);
    let live = read_side(ctx, me, session_id, offer);
    if let Err(e) = check_offer_eligibility(&live.facts(offer)) {
        return reject("set_trade_offer", me, e);
    }
    // Eligibility proved every offered id is one of `live.owned`, exactly once.
    let mut cards = Vec::with_capacity(offer.monster_ids.len());
    for id in &offer.monster_ids {
        if let Some(m) = live.owned.iter().find(|m| m.monster_id == *id) {
            cards.push(card_of(m));
        }
    }
    offer.cards = cards;

    delete_snapshots(ctx, session_id, |id| previous_ids.contains(&id));
    for m in &live.owned {
        ctx.db
            .trade_session_snapshot()
            .insert(snapshot_row(session_id, snapshot_of(m)));
    }
    let revision = edited.revision;
    ctx.db
        .trade_session()
        .session_id()
        .update(with_state(session, edited));
    log::info!(
        "{{\"evt\":\"trade_session_offer_set\",\"session_id\":{session_id},\"by\":\"{me}\",\"revision\":{revision}}}"
    );
    Ok(())
}

/// Confirm the caller's side at the revision they reviewed; the confirm that
/// completes the pair executes the swap in this call.
///
/// In order:
/// 1. the session exists and the caller is party to it;
/// 2. a deletion-gated caller may confirm only a session opened before their
///    deletion request;
/// 3. a revision other than the current one is refused;
/// 4. an offered monster, on either side, whose live row differs from its
///    review snapshot (or has none): the snapshot and card are refreshed, the
///    revision advances, both confirms clear and nothing is confirmed;
/// 5. the caller's own side check, refused with the caller's own reason;
/// 6. the other side not yet confirmed: the caller's confirm is recorded;
/// 7. otherwise the other side's check runs too. If it alone fails, its
///    confirm is cleared, the caller's is recorded, nothing moves and the call
///    succeeds: the caller is never told why. If both pass, the session, its
///    snapshots and its schedule row are deleted and the swap is applied —
///    monsters to the receiver's lowest free party slots, then Storage.
#[spacetimedb::reducer]
pub fn confirm_trade_session(
    ctx: &ReducerContext,
    session_id: u64,
    revision: u64,
) -> Result<(), String> {
    let me = ctx.sender();
    let (session, side) = find_own_session(ctx, "confirm_trade_session", session_id)?;
    crate::guards::require_commitment_predates_deletion(
        ctx,
        "confirm_trade_session",
        session.created_at_ms,
    )?;
    let other = other_side(side);
    let them = party_of(&session, other);
    let own_live = read_side(ctx, me, session_id, offer_of(&session, side));
    let other_live = read_side(ctx, them, session_id, offer_of(&session, other));
    let (opener_live, partner_live) = match side {
        SessionSide::Opener => (&own_live, &other_live),
        SessionSide::Partner => (&other_live, &own_live),
    };

    let own_check = can_confirm(
        session.revision,
        revision,
        &own_live.facts(offer_of(&session, side)),
        &own_live.receipt(offer_of(&session, other)),
    );
    if let Err(TradeSessionError::StaleRevision) = own_check {
        return reject(
            "confirm_trade_session",
            me,
            TradeSessionError::StaleRevision,
        );
    }

    if refresh_drifted(ctx, &session, &opener_live.owned, &partner_live.owned) {
        log::info!(
            "{{\"evt\":\"trade_session_drift_reset\",\"session_id\":{session_id},\"by\":\"{me}\"}}"
        );
        return Ok(());
    }

    if let Err(e) = own_check {
        return reject("confirm_trade_session", me, e);
    }
    if !is_confirmed(&session, other) {
        let mut confirmed = session;
        set_confirmed(&mut confirmed, side, true);
        ctx.db.trade_session().session_id().update(confirmed);
        log::info!(
            "{{\"evt\":\"trade_session_confirmed\",\"session_id\":{session_id},\"by\":\"{me}\"}}"
        );
        return Ok(());
    }

    let other_check = side_check(
        &other_live.facts(offer_of(&session, other)),
        &other_live.receipt(offer_of(&session, side)),
    );
    if let Err(reason) = &other_check {
        // The other side's reason is logged under ITS identity, never returned.
        log_reject("confirm_trade_session", them, &reason.to_string());
    }
    match judge_execute(own_check, other_check) {
        ExecuteVerdict::RejectCaller(e) => reject("confirm_trade_session", me, e),
        ExecuteVerdict::ResetOther => {
            let mut reset = session;
            set_confirmed(&mut reset, side, true);
            set_confirmed(&mut reset, other, false);
            ctx.db.trade_session().session_id().update(reset);
            log::info!(
                "{{\"evt\":\"trade_session_other_reset\",\"session_id\":{session_id},\"by\":\"{me}\"}}"
            );
            Ok(())
        }
        ExecuteVerdict::Execute => {
            if let Err(detail) = execute_swap(ctx, &session, opener_live, partner_live) {
                // The detail may describe either participant's rows, so it is
                // logged against the session, under nobody's identity.
                log::warn!(
                    "{{\"evt\":\"trade_session_execute_failed\",\"session_id\":{session_id},\"reason\":\"{}\"}}",
                    json_escape(&detail)
                );
                return Err(ERR_EXECUTE_FAILED.to_string());
            }
            log::info!(
                "{{\"evt\":\"trade_session_executed\",\"session_id\":{session_id},\"by\":\"{me}\"}}"
            );
            Ok(())
        }
    }
}

/// Compare every offered monster a side still owns with its review snapshot.
/// When any differs or has no snapshot: replace those snapshot rows, rebuild
/// those cards, advance the revision, clear both confirms, write the session
/// and return `true`. Returns `false`, having written nothing, when every
/// snapshot matches.
fn refresh_drifted(
    ctx: &ReducerContext,
    session: &TradeSession,
    opener_owned: &[Monster],
    partner_owned: &[Monster],
) -> bool {
    let stored: Vec<TradeSessionSnapshot> = ctx
        .db
        .trade_session_snapshot()
        .session_id()
        .filter(session.session_id)
        .collect();
    let drifted = |m: &&Monster| {
        let live = snapshot_of(m);
        !stored.iter().any(|row| {
            row.monster_id == m.monster_id && !snapshot_drifted(&snapshot_from_row(row), &live)
        })
    };
    let opener_drifted: Vec<&Monster> = opener_owned.iter().filter(drifted).collect();
    let partner_drifted: Vec<&Monster> = partner_owned.iter().filter(drifted).collect();
    if opener_drifted.is_empty() && partner_drifted.is_empty() {
        return false;
    }

    let mut state = reset_confirms(state_of(session));
    for (side, monsters) in [
        (SessionSide::Opener, &opener_drifted),
        (SessionSide::Partner, &partner_drifted),
    ] {
        let offer = state_offer_mut(&mut state, side);
        for m in monsters {
            let listed = offer.monster_ids.iter().position(|id| *id == m.monster_id);
            if let Some(card) = listed.and_then(|at| offer.cards.get_mut(at)) {
                *card = card_of(m);
            }
        }
    }
    let ids: Vec<u64> = opener_drifted
        .iter()
        .chain(partner_drifted.iter())
        .map(|m| m.monster_id)
        .collect();
    delete_snapshots(ctx, session.session_id, |id| ids.contains(&id));
    for m in opener_drifted.iter().chain(partner_drifted.iter()) {
        ctx.db
            .trade_session_snapshot()
            .insert(snapshot_row(session.session_id, snapshot_of(m)));
    }
    ctx.db
        .trade_session()
        .session_id()
        .update(with_state(session.clone(), state));
    true
}

/// Each of `incoming` paired with the party slot it arrives in: `receiver`'s
/// lowest free slots once its own `outgoing` monsters have left, then Storage.
fn arrivals(
    ctx: &ReducerContext,
    receiver: Identity,
    outgoing: &[u64],
    incoming: &[u64],
) -> Vec<(u64, u8)> {
    let staying: Vec<u8> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(receiver)
        .filter(|m| !outgoing.contains(&m.monster_id))
        .map(|m| m.party_slot)
        .collect();
    incoming
        .iter()
        .copied()
        .zip(arrival_slots(&staying, incoming.len()))
        .collect()
}

/// Execute a session both sides have confirmed and passed their checks for:
/// the combined headroom check, the swap plan, then the session delete BEFORE
/// the apply. Any `Err` must be returned out of the reducer so the whole call
/// rolls back.
fn execute_swap(
    ctx: &ReducerContext,
    session: &TradeSession,
    opener_live: &SideLive,
    partner_live: &SideLive,
) -> Result<(), String> {
    let (opener, partner) = (session.opener, session.partner);
    let (gives, takes) = (&session.opener_offer, &session.partner_offer);

    check_headroom(
        &takes.items,
        &netted_receiver_stacks(ctx, opener, &takes.items, &gives.items),
        takes.currency,
        opener_live.balance.saturating_sub(gives.currency),
        &gives.items,
        &netted_receiver_stacks(ctx, partner, &gives.items, &takes.items),
        gives.currency,
        partner_live.balance.saturating_sub(takes.currency),
    )
    .map_err(|e| e.to_string())?;

    let live_owners = |offer: &TradeSessionOffer, live: &SideLive| -> Vec<LiveMonsterOwner> {
        offer
            .monster_ids
            .iter()
            .map(|&monster_id| LiveMonsterOwner {
                monster_id,
                owner_matches_expected: live.owned.iter().any(|m| m.monster_id == monster_id),
            })
            .collect()
    };
    let plan = build_swap_plan(
        &live_owners(gives, opener_live),
        &live_owners(takes, partner_live),
        &gives.items,
        &takes.items,
        gives.currency,
        takes.currency,
    )
    .map_err(|e| e.to_string())?;

    let mut slots = arrivals(ctx, opener, &gives.monster_ids, &takes.monster_ids);
    slots.extend(arrivals(
        ctx,
        partner,
        &takes.monster_ids,
        &gives.monster_ids,
    ));

    delete_session(ctx, session.session_id);
    apply_swap(ctx, &plan, opener, partner, |monster_id| {
        slots
            .iter()
            .find(|(arriving, _)| *arriving == monster_id)
            .map_or(crate::PARTY_SLOT_NONE, |(_, slot)| *slot)
    })
}

/// Cancel a session. Either participant may, at any time before the swap; it
/// is never deletion-gated and reads nothing of the other side.
#[spacetimedb::reducer]
pub fn cancel_trade_session(ctx: &ReducerContext, session_id: u64) -> Result<(), String> {
    let me = ctx.sender();
    let (session, _) = find_own_session(ctx, "cancel_trade_session", session_id)?;
    delete_session(ctx, session.session_id);
    log::info!(
        "{{\"evt\":\"trade_session_cancelled\",\"session_id\":{session_id},\"by\":\"{me}\"}}"
    );
    Ok(())
}

/// Scheduled reaper: delete a session that has outlived `TRADE_SESSION_TTL_MS`.
///
/// SCHEDULER-ONLY. Staleness is re-checked, so an early fire or clock skew
/// never reaps a fresh session; a session spared that way is re-armed at its
/// own deadline. The reaper does not delete its own schedule row: the runtime
/// deletes a fired one-shot row after the reducer returns.
#[spacetimedb::reducer]
pub fn trade_session_reaper(
    ctx: &ReducerContext,
    args: TradeSessionReaperSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("trade_session_reaper is scheduler-only".to_string());
    }
    let Some(session) = ctx.db.trade_session().session_id().find(args.session_id) else {
        return Ok(());
    };
    if !is_session_stale(session.created_at_ms, now_ms(ctx)) {
        // The runtime consumes the fired row, so a session spared here needs
        // a new one or nothing would ever reap it.
        arm_session_reaper(ctx, session.session_id, session.created_at_ms);
        return Ok(());
    }
    delete_session_rows(ctx, session.session_id);
    log::info!(
        "{{\"evt\":\"trade_session_reaped\",\"session_id\":{}}}",
        session.session_id
    );
    Ok(())
}

#[cfg(test)]
#[path = "trading_session_tests.rs"]
mod trading_session_tests;
