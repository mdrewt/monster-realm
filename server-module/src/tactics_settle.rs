//! Tactical settlement (M-battle-tactics bt-9): the ONE terminal funnel of a tactical battle.
//!
//! `tactics::finish` calls [`settle`] exactly once per battle (its Finished guard). The reward
//! ledger (design §7) is a FOLD of the persisted transcript (`battle_event`, ascending `seq`):
//! every `Ko` is credited through `game_core::tactics::rewards::on_unit_defeated` to the attacker
//! of the last opposite-side hit on the victim, against the board as it stood at that moment —
//! the final board with the units not yet fallen restored ([`board_at`]). Consciousness is
//! monotone in P1 (nothing heals or revives mid-battle; items only cure status), which is what
//! makes that reconstruction exact. `rewards::pay` then pays only the units conscious at the end,
//! on every terminal path alike (win, loss, Flee, auto-flee, disconnect), through the legacy
//! funnel's per-monster credit (`battle::credit_monster`) over the anchor's whole party — so the
//! daily trust-favorable credit, Quality Time and the evolution check keep their carried scope;
//! the player's currency goes to the wallet; one `Awards` line per paid monster plus one
//! [`CURRENCY_AWARD_UNIT`] line for the currency is appended to the transcript after `BattleEnd`.
//! The faint penalty and the prior-terminal sweep are the legacy funnel's own helpers
//! (`battle::apply_faint_penalties`, `battle::sweep_prior_terminals`), run per [`Close`] kind.
//! `battle_summary` (design §8.1) is ONE row per battle: inserted at the Active start,
//! accumulated by every `store` step ([`step_delta`] → [`accumulate`]) and finalised here.
//!
//! Pure functions first (unit-tested without a host); the shell functions take `ctx`. Nothing
//! here panics or returns `Err` past `finish`: a scheduled or disconnect reducer that trapped
//! would freeze the battle, so every helper failure is logged and the next step still runs.

use std::collections::{BTreeMap, BTreeSet};

use crate::battle::{
    apply_faint_penalties, credit_monster, day_epoch_utc, is_wild_win, sweep_prior_terminals,
};
use crate::economy::grant_currency;
use crate::guards::json_escape;
use crate::observability::mr_log;
use crate::schema::{
    battle, battle_clock, battle_event, battle_summary, battle_tactical, battle_unit, monster,
    Battle, BattleEvent, BattleSummary, BattleTactical, SideRow,
};
use crate::tactics::{content_species, next_event_seq};
use game_core::tactics::queue::is_player_owned;
use game_core::tactics::{
    on_unit_defeated, pay, Award, AwardsEvent, EventPayload, HitEffectiveness, Ledger,
    StatusChange, StepResult, TacticalState, UnitState,
};
use game_core::{base_stat_total, BattleOutcome, Xp};
use spacetimedb::{ReducerContext, Table};

/// The H1 proxy's threshold (‰): a battle whose FIRST recruit attempt saw the wild below it is
/// `weaken_first`. `scripts/playtest-report.mjs` carries the same default (`weakenThresholdPermille`).
pub(crate) const WEAKEN_FIRST_PERMILLE: u16 = 500;

/// The `Awards` line that carries the player's currency: no unit earns currency, and unit ids
/// are `auto_inc` from 1 (`tactics::DEPLOY_WINDOW_UNIT` is the same "no unit" convention).
pub(crate) const CURRENCY_AWARD_UNIT: u32 = 0;

/// Buckets of the windows-per-unit-turn histogram a fresh row starts with: `0..=3`, the
/// shipped `max_windows_per_turn`. [`apply_delta`] grows the vector past it if a tuning ever does.
const HISTOGRAM_LEN: usize = 4;

/// How a battle closes — and therefore what settles:
///
/// | kind | rewards | faint penalty | sweep | summary |
/// |---|---|---|---|---|
/// | `Settled` | iff the HP write-back succeeded | iff the HP write-back succeeded | yes | finalise |
/// | `Deploying` | no | no | yes | one zero row |
/// | `LegacyEnded` | no (that reducer's funnel paid) | no (it penalised) | yes | finalise |
/// | `Fallback` | no (the board is unloadable) | yes | yes | finalise |
pub(crate) enum Close<'a> {
    /// A step the engine finished (`store`): the final board is in hand.
    Settled { state: &'a TacticalState },
    /// A Deploying battle timed out or lost its owner: nothing happened.
    Deploying,
    /// The anchor was ended by a legacy 1v1 reducer whose own write-back already ran.
    LegacyEnded,
    /// The rows could not be loaded (content drift): HP was written by hand.
    Fallback,
}

/// The transcript fold's result: the ledger plus what the audit found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Fold {
    pub(crate) ledger: Ledger,
    /// `Ko` victims no opposite-side unit ever hit (poison/Surge on an untouched unit): uncredited.
    pub(crate) unattributed: Vec<u32>,
    /// `Ko` victims whose species has no content row: uncredited (never a 0-BST credit).
    pub(crate) skipped_bst: Vec<u32>,
    /// Units `Fainted` on the final board with no `Ko` in the transcript (an audit finding).
    pub(crate) missing_ko: Vec<u32>,
    /// `Ko` victims the reward rule refused (`RewardError`): uncredited, by construction never.
    pub(crate) refused: Vec<u32>,
}

/// The turn-machine facts before a step that the summary's per-step delta needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StepPrev {
    /// The unit whose window was open (`TurnState::Waiting(u)`).
    pub(crate) waiting: Option<u32>,
    /// Windows opened so far in that unit-turn (`clocks[0].windows_this_unit_turn`).
    pub(crate) windows: u8,
    /// Units at full HP before the step.
    pub(crate) full_hp: Vec<u32>,
}

/// What one step adds to `battle_summary` (every field saturates on apply).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StepDelta {
    /// Index = windows opened in a unit-turn that ended this step (0 = pre-queued).
    pub(crate) windows: Vec<u32>,
    pub(crate) prequeued: u16,
    pub(crate) live: u16,
    pub(crate) autopasses: u16,
    /// Pre-queued player plans halted at pop (§12-F(b)).
    pub(crate) halted: u16,
    pub(crate) recruit_attempts: u16,
    pub(crate) recruit_successes: u16,
    pub(crate) items: u16,
    pub(crate) hits: u16,
    pub(crate) misses: u16,
    /// Single-hit super-effective KOs after round 1, both sides (§12-F(c)).
    pub(crate) se_kos_after_r1: u16,
}

impl StepDelta {
    /// Nothing to write: `accumulate` leaves the row byte-identical.
    #[must_use]
    pub(crate) fn is_zero(&self) -> bool {
        self == &StepDelta::default()
    }
}

/// `histogram[bucket] += 1`, growing the vector to fit (never an index past the end).
fn bump(histogram: &mut Vec<u32>, bucket: u8) {
    let i = usize::from(bucket);
    if histogram.len() <= i {
        histogram.resize(i + 1, 0);
    }
    if let Some(slot) = histogram.get_mut(i) {
        *slot = slot.saturating_add(1);
    }
}

/// The board as it stood when `fallen` had fallen and nothing else had: the final board with every
/// unit NOT in `fallen` restored to conscious (`Active`, HP ≥ 1; a unit that never fell is left
/// exactly as it ended). Exact under P1's monotone consciousness (no heal, no revive).
#[must_use]
pub(crate) fn board_at(final_state: &TacticalState, fallen: &BTreeSet<u32>) -> TacticalState {
    let mut board = final_state.clone();
    for unit in &mut board.units {
        if fallen.contains(&unit.id) || unit.is_conscious() {
            continue;
        }
        unit.state = UnitState::Active;
        unit.cur_hp = unit.cur_hp.max(1);
    }
    board
}

/// Fold the transcript into the reward ledger (module doc). The caller passes `events` ascending
/// `seq`. `bst_of(species_id)` is the victim species' base-stat total (content); `None` skips the
/// KO (`Fold::skipped_bst`). The killer of a `Ko` is the attacker of the LAST opposite-side hit on
/// the victim (any `hit`, a status-only one included) — the design names `on_unit_defeated(killer,
/// victim)` and `Executed.attacker`, and is silent on tick/Surge deaths: "last hitter" is the
/// marshaling of the transcript, never a reward amount or split (those stay in `rewards.rs`).
#[must_use]
pub(crate) fn ledger_of(
    events: &[EventPayload],
    final_state: &TacticalState,
    bst_of: &dyn Fn(u32) -> Option<u16>,
) -> Fold {
    let mut fold = Fold::default();
    let mut fallen: BTreeSet<u32> = BTreeSet::new();
    let mut last_hitter: BTreeMap<u32, u32> = BTreeMap::new();
    let side_of = |id: u32| final_state.unit(id).map(|u| u.side);
    for event in events {
        match event {
            EventPayload::Executed(x) => {
                let attacker_side = side_of(x.attacker);
                for r in &x.results {
                    let opposite = matches!(
                        (side_of(r.unit), attacker_side),
                        (Some(target), Some(attacker)) if target != attacker
                    );
                    if r.hit && opposite {
                        last_hitter.insert(r.unit, x.attacker);
                    }
                }
            }
            EventPayload::Ko(k) => {
                fallen.insert(k.unit);
                let Some(&killer) = last_hitter.get(&k.unit) else {
                    fold.unattributed.push(k.unit);
                    continue;
                };
                let species = final_state.unit(k.unit).map(|u| u.kit.species_id);
                let Some(bst) = species.and_then(bst_of) else {
                    fold.skipped_bst.push(k.unit);
                    continue;
                };
                let board = board_at(final_state, &fallen);
                if on_unit_defeated(&mut fold.ledger, &board, killer, k.unit, bst).is_err() {
                    fold.refused.push(k.unit);
                }
            }
            EventPayload::RecruitResult(r) => {
                if r.success {
                    fallen.insert(r.target);
                }
            }
            EventPayload::Missed(_)
            | EventPayload::PlanHalted(_)
            | EventPayload::QueueVoided(_)
            | EventPayload::AutoPass(_)
            | EventPayload::StoodGround(_)
            | EventPayload::Status(_)
            | EventPayload::Surge(_)
            | EventPayload::Awards(_)
            | EventPayload::Moved(_)
            | EventPayload::ItemUsed(_)
            | EventPayload::TurnEnded(_)
            | EventPayload::RoundEnded(_)
            | EventPayload::BattleStarted(_)
            | EventPayload::BattleEnd(_) => {}
        }
    }
    for unit in &final_state.units {
        if unit.state == UnitState::Fainted && !fallen.contains(&unit.id) {
            fold.missing_ko.push(unit.id);
        }
    }
    fold
}

/// The `Awards` lines of the credits that were applied: one per credited monster (in the order
/// given — the caller sorts by unit; `essence` = the sum over pools) plus one
/// [`CURRENCY_AWARD_UNIT`] line iff `currency > 0`.
/// The amounts are the ledger's — what was earned; a pool at `ESSENCE_SOFT_CAP`, a monster at
/// the XP ceiling or a wallet at `MAX_BALANCE` keeps less, and the line does not say so.
#[must_use]
pub(crate) fn awards_events(applied: &[Award], currency: u64) -> Vec<EventPayload> {
    let mut lines: Vec<EventPayload> = applied
        .iter()
        .map(|award| {
            EventPayload::Awards(AwardsEvent {
                unit: award.unit,
                xp: award.xp,
                essence: award
                    .essence
                    .iter()
                    .fold(0u32, |acc, &(_, n)| acc.saturating_add(n)),
                currency: 0,
            })
        })
        .collect();
    if currency > 0 {
        lines.push(EventPayload::Awards(AwardsEvent {
            unit: CURRENCY_AWARD_UNIT,
            xp: 0,
            essence: 0,
            currency,
        }));
    }
    lines
}

/// What `out` adds to the summary, given the facts before the step and the player-owned unit ids.
/// A player unit's `TurnEnded` (not `Status{Blocked}` this step) is `live` when it is the waiting
/// unit's (bucket `prev.windows`) else pre-queued (bucket 0); a `BattleEnd` that cuts the waiting
/// unit's turn counts it once; `PlanHalted` counts a PLAYER unit other than the waiting one (a
/// pre-queued plan); hits and misses come from `TargetHit`s of both sides (the separate `Missed`
/// adds nothing); a single-hit super-effective KO needs round > 1, a target at full HP at step start
/// and no earlier damage this step (an `Executed` hit, a `Status{Tick}` or a `Surge`).
#[must_use]
pub(crate) fn step_delta(prev: &StepPrev, out: &StepResult, player_units: &[u32]) -> StepDelta {
    let mut d = StepDelta::default();
    let is_player = |unit: u32| player_units.contains(&unit);
    let mut blocked: BTreeSet<u32> = BTreeSet::new();
    let mut damaged: BTreeSet<u32> = BTreeSet::new();
    let mut waiting_ended = false;
    for event in &out.events {
        match event {
            EventPayload::Status(s) => match s.change {
                StatusChange::Blocked => {
                    blocked.insert(s.unit);
                }
                StatusChange::Tick => {
                    if s.amount > 0 {
                        damaged.insert(s.unit);
                    }
                }
                StatusChange::Applied | StatusChange::Cured => {}
            },
            EventPayload::Surge(s) => {
                damaged.insert(s.unit);
            }
            EventPayload::TurnEnded(t) => {
                if !is_player(t.unit) || blocked.contains(&t.unit) {
                    continue;
                }
                if Some(t.unit) == prev.waiting {
                    waiting_ended = true;
                    d.live = d.live.saturating_add(1);
                    bump(&mut d.windows, prev.windows);
                } else {
                    d.prequeued = d.prequeued.saturating_add(1);
                    bump(&mut d.windows, 0);
                }
            }
            EventPayload::BattleEnd(_) => {
                if prev.waiting.is_some() && !waiting_ended {
                    waiting_ended = true;
                    d.live = d.live.saturating_add(1);
                    bump(&mut d.windows, prev.windows);
                }
            }
            EventPayload::PlanHalted(h) => {
                if is_player(h.unit) && Some(h.unit) != prev.waiting {
                    d.halted = d.halted.saturating_add(1);
                }
            }
            EventPayload::AutoPass(_) => d.autopasses = d.autopasses.saturating_add(1),
            EventPayload::ItemUsed(_) => d.items = d.items.saturating_add(1),
            EventPayload::RecruitResult(r) => {
                d.recruit_attempts = d.recruit_attempts.saturating_add(1);
                if r.success {
                    d.recruit_successes = d.recruit_successes.saturating_add(1);
                }
            }
            EventPayload::Executed(x) => {
                for r in &x.results {
                    if !r.hit {
                        d.misses = d.misses.saturating_add(1);
                        continue;
                    }
                    d.hits = d.hits.saturating_add(1);
                    let single_hit = r.ko
                        && out.round > 1
                        && r.effectiveness == Some(HitEffectiveness::SuperEffective)
                        && prev.full_hp.contains(&r.unit)
                        && !damaged.contains(&r.unit);
                    if single_hit {
                        d.se_kos_after_r1 = d.se_kos_after_r1.saturating_add(1);
                    }
                    if r.damage > 0 {
                        damaged.insert(r.unit);
                    }
                }
            }
            EventPayload::Missed(_)
            | EventPayload::QueueVoided(_)
            | EventPayload::StoodGround(_)
            | EventPayload::Ko(_)
            | EventPayload::Awards(_)
            | EventPayload::Moved(_)
            | EventPayload::RoundEnded(_)
            | EventPayload::BattleStarted(_) => {}
        }
    }
    d
}

/// `row` plus `delta`, saturating; the histogram grows to fit the largest bucket and keeps any
/// longer tail it already had.
#[must_use]
pub(crate) fn apply_delta(mut row: BattleSummary, delta: &StepDelta) -> BattleSummary {
    if row.windows_histogram.len() < delta.windows.len() {
        row.windows_histogram.resize(delta.windows.len(), 0);
    }
    for (slot, add) in row.windows_histogram.iter_mut().zip(delta.windows.iter()) {
        *slot = slot.saturating_add(*add);
    }
    row.unit_turns_prequeued = row.unit_turns_prequeued.saturating_add(delta.prequeued);
    row.unit_turns_live = row.unit_turns_live.saturating_add(delta.live);
    row.autopasses = row.autopasses.saturating_add(delta.autopasses);
    row.halted_plans = row.halted_plans.saturating_add(delta.halted);
    row.recruit_attempts = row.recruit_attempts.saturating_add(delta.recruit_attempts);
    row.recruit_successes = row
        .recruit_successes
        .saturating_add(delta.recruit_successes);
    row.items_used = row.items_used.saturating_add(delta.items);
    row.hits = row.hits.saturating_add(delta.hits);
    row.misses = row.misses.saturating_add(delta.misses);
    row.se_kos_after_r1 = row.se_kos_after_r1.saturating_add(delta.se_kos_after_r1);
    row
}

/// A fresh summary row for `anchor`/`tactical`: `outcome: Ongoing` marks an unfinished battle.
fn zero_row(anchor: &Battle, tactical: &BattleTactical) -> BattleSummary {
    BattleSummary {
        battle_id: anchor.battle_id,
        player_identity: anchor.player_identity,
        opponent_identity: anchor.opponent_identity,
        kind: tactical.kind,
        outcome: BattleOutcome::Ongoing,
        rounds: 0,
        wall_ms: 0,
        idle_ms_a: 0,
        idle_ms_b: 0,
        windows_histogram: vec![0; HISTOGRAM_LEN],
        autopasses: 0,
        recruit_attempts: 0,
        recruit_successes: 0,
        weaken_first: false,
        items_used: 0,
        damage_dealt_a: 0,
        damage_dealt_b: 0,
        hits: 0,
        misses: 0,
        unit_turns_prequeued: 0,
        unit_turns_live: 0,
        halted_plans: 0,
        se_kos_after_r1: 0,
    }
}

/// The battle's summary row, inserted zeroed when absent (the given anchor and tactical rows).
fn summary_row(ctx: &ReducerContext, anchor: &Battle, tactical: &BattleTactical) -> BattleSummary {
    match ctx.db.battle_summary().battle_id().find(anchor.battle_id) {
        Some(row) => row,
        None => ctx.db.battle_summary().insert(zero_row(anchor, tactical)),
    }
}

/// The battle's summary row, inserted zeroed (`outcome: Ongoing`) when absent. `None` when the
/// anchor or the tactical row is gone (nothing to describe).
pub(crate) fn find_or_insert_summary(
    ctx: &ReducerContext,
    battle_id: u64,
) -> Option<BattleSummary> {
    if let Some(row) = ctx.db.battle_summary().battle_id().find(battle_id) {
        return Some(row);
    }
    let anchor = ctx.db.battle().battle_id().find(battle_id)?;
    let tactical = ctx.db.battle_tactical().battle_id().find(battle_id)?;
    Some(summary_row(ctx, &anchor, &tactical))
}

/// Add one step's delta to the battle's summary row (a zero delta writes nothing but the row's
/// first insert).
pub(crate) fn accumulate(
    ctx: &ReducerContext,
    anchor: &Battle,
    tactical: &BattleTactical,
    delta: &StepDelta,
) {
    let row = summary_row(ctx, anchor, tactical);
    if delta.is_zero() {
        return;
    }
    ctx.db
        .battle_summary()
        .battle_id()
        .update(apply_delta(row, delta));
}

/// The recruit hook's one summary write: the battle's FIRST attempt decides `weaken_first`
/// (`hp_permille < WEAKEN_FIRST_PERMILLE`); later attempts leave it alone (the hook also keeps a
/// per-transaction flag, since the row's `recruit_attempts` advances only when the step stores).
pub(crate) fn mark_first_recruit(ctx: &ReducerContext, battle_id: u64, hp_permille: u16) {
    let Some(row) = find_or_insert_summary(ctx, battle_id) else {
        return;
    };
    if row.recruit_attempts > 0 {
        return;
    }
    ctx.db.battle_summary().battle_id().update(BattleSummary {
        weaken_first: hp_permille < WEAKEN_FIRST_PERMILLE,
        ..row
    });
}

/// Finalise a summary row: the outcome, the rounds the battle was Active for, the wall time, the
/// idle time per side (the clock rows) and the attack damage per side (the tactical row).
fn finalize(
    ctx: &ReducerContext,
    row: BattleSummary,
    anchor: &Battle,
    tactical: &BattleTactical,
    was_active: bool,
    wall_ms: u64,
) {
    let (mut idle_a, mut idle_b) = (0u64, 0u64);
    for clock in ctx.db.battle_clock().battle_id().filter(anchor.battle_id) {
        match clock.side {
            SideRow::A => idle_a = clock.idle_ms_total,
            SideRow::B => idle_b = clock.idle_ms_total,
        }
    }
    ctx.db.battle_summary().battle_id().update(BattleSummary {
        outcome: anchor.state.outcome,
        rounds: if was_active { tactical.round } else { 0 },
        wall_ms,
        idle_ms_a: idle_a,
        idle_ms_b: idle_b,
        damage_dealt_a: tactical.attack_damage_dealt_a,
        damage_dealt_b: tactical.attack_damage_dealt_b,
        ..row
    });
}

fn settle_log(evt: &str, battle_id: u64, reason: &str) {
    let escaped = json_escape(reason);
    mr_log(
        evt,
        &format!("\"battle_id\":{battle_id},\"reason\":\"{escaped}\""),
    );
}

/// Pay the ledger (module doc): fold the transcript, `pay` against the final board, credit every
/// conscious party member through the legacy per-monster credit, pay the currency, append the
/// `Awards` lines for what was applied.
fn pay_ledger(
    ctx: &ReducerContext,
    anchor: &Battle,
    tactical: &BattleTactical,
    state: &TacticalState,
    now_ms: i64,
) {
    let battle_id = anchor.battle_id;
    let mut rows: Vec<BattleEvent> = ctx
        .db
        .battle_event()
        .battle_id()
        .filter(battle_id)
        .collect();
    rows.sort_by_key(|e| e.seq);
    let events: Vec<EventPayload> = rows.into_iter().map(|e| e.payload).collect();
    let bst_of =
        |species_id: u32| content_species(species_id).map(|s| base_stat_total(&s.base_stats));
    let fold = ledger_of(&events, state, &bst_of);
    for (what, units) in [
        ("unattributed", &fold.unattributed),
        ("skipped_bst", &fold.skipped_bst),
        ("refused", &fold.refused),
    ] {
        if !units.is_empty() {
            mr_log(
                "tactical_ledger_skip",
                &format!("\"battle_id\":{battle_id},\"{what}\":{units:?}"),
            );
        }
    }
    if !fold.missing_ko.is_empty() {
        mr_log(
            "tactical_ledger_mismatch",
            &format!(
                "\"battle_id\":{battle_id},\"fainted_without_ko\":{:?}",
                fold.missing_ko
            ),
        );
    }
    let payout = pay(&fold.ledger, state);
    let units: Vec<(u32, u64)> = ctx
        .db
        .battle_unit()
        .battle_id()
        .filter(battle_id)
        .filter_map(|u| u.monster_id.map(|mid| (u.unit_id, mid)))
        .collect();
    let species_base = |species_id: u32| content_species(species_id).map(|s| s.base_stats);
    // The win-only credits (daily trust-favorable, Quality Time, the evolution check) need a
    // wild actually DEFEATED: a recruit-only win pays nothing (BT9.1), as the 1v1 recruit
    // success never paid them.
    let wild_defeated = state
        .units
        .iter()
        .any(|u| !is_player_owned(state.kind, u.side) && u.state == UnitState::Fainted);
    let favorable = is_wild_win(anchor) && wild_defeated;
    let today = day_epoch_utc(now_ms);
    let mut applied: Vec<Award> = Vec::new();
    // The legacy funnel's loop: every CONSCIOUS party member (deployed or benched), the ledger
    // supplying its XP and essence instead of the 1v1 formula; a member with nothing to credit
    // (no award, no win credit) is left untouched.
    for (i, bm) in anchor.state.side_a.team.iter().enumerate() {
        if bm.is_fainted() {
            continue;
        }
        let Some(&mid) = anchor.party_monster_ids.get(i) else {
            continue;
        };
        let award = units
            .iter()
            .find(|&&(_, m)| m == mid)
            .and_then(|&(unit, _)| payout.awards.iter().find(|a| a.unit == unit));
        if award.is_none() && !favorable {
            continue;
        }
        if ctx.db.monster().monster_id().find(mid).is_none() {
            settle_log(
                "tactical_settle_err",
                battle_id,
                &format!("monster {mid} is gone"),
            );
            continue;
        }
        let xp = Xp::new(award.map_or(0, |a| a.xp));
        let essence: Vec<(game_core::Affinity, u32)> =
            award.map_or_else(Vec::new, |a| a.essence.clone());
        match credit_monster(
            ctx,
            anchor.player_identity,
            mid,
            bm.max_hp,
            &species_base,
            Some(xp),
            &essence,
            favorable,
            today,
        ) {
            Ok(()) => {
                if let Some(award) = award {
                    applied.push(award.clone());
                }
            }
            Err(e) => settle_log("tactical_settle_err", battle_id, &e),
        }
    }
    grant_currency(ctx, anchor.player_identity, payout.currency);
    applied.sort_by_key(|a| a.unit);
    let mut seq = next_event_seq(ctx, battle_id);
    for payload in awards_events(&applied, payout.currency) {
        ctx.db.battle_event().insert(BattleEvent {
            event_id: 0,
            battle_id,
            seq,
            round: tactical.round,
            payload,
        });
        seq = seq.saturating_add(1);
    }
}

/// THE terminal settlement (module doc), called once by `tactics::finish` after the HP
/// write-back and the anchor update, with the tactical row as finished. Never `Err`s, never
/// panics: every helper failure is logged and the next step still runs.
pub(crate) fn settle(
    ctx: &ReducerContext,
    anchor: &Battle,
    tactical: &BattleTactical,
    close: &Close<'_>,
    hp_ok: bool,
    was_active: bool,
    now_ms: i64,
) {
    let battle_id = anchor.battle_id;
    match close {
        Close::Settled { state } => {
            if hp_ok {
                pay_ledger(ctx, anchor, tactical, state, now_ms);
                if let Err(e) = apply_faint_penalties(ctx, anchor) {
                    settle_log("tactical_settle_err", battle_id, &e);
                }
            } else {
                settle_log(
                    "tactical_settle_skipped",
                    battle_id,
                    "HP write-back failed: no rewards, no penalty",
                );
            }
        }
        Close::Deploying | Close::LegacyEnded => {}
        Close::Fallback => {
            let any_ko = ctx
                .db
                .battle_event()
                .battle_id()
                .filter(battle_id)
                .any(|e| matches!(e.payload, EventPayload::Ko(_)));
            if any_ko {
                settle_log(
                    "tactical_settle_skipped",
                    battle_id,
                    "board unloadable: the ledger's KOs are forfeited",
                );
            }
            if let Err(e) = apply_faint_penalties(ctx, anchor) {
                settle_log("tactical_settle_err", battle_id, &e);
            }
        }
    }
    sweep_prior_terminals(ctx, anchor, Some(battle_id));
    let row = summary_row(ctx, anchor, tactical);
    let wall_ms = u64::try_from(now_ms.saturating_sub(anchor.created_at_ms)).unwrap_or(0);
    finalize(ctx, row, anchor, tactical, was_active, wall_ms);
}

/// A swept (prior-terminal) tactical battle whose summary is still `Ongoing` is finalised with
/// its anchor's outcome before its rows go (the rows that would have finalised it are going).
/// Its end time is unknown — a legacy reducer ended the anchor without this funnel — so
/// `wall_ms` stays 0 (bt-13's pacing gate filters on it).
pub(crate) fn finalize_swept_summary(ctx: &ReducerContext, anchor: &Battle) {
    let Some(row) = ctx.db.battle_summary().battle_id().find(anchor.battle_id) else {
        return;
    };
    if row.outcome != BattleOutcome::Ongoing {
        return;
    }
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(anchor.battle_id) else {
        return;
    };
    let was_active = tactical.phase != game_core::tactics::Phase::Deploying;
    finalize(ctx, row, anchor, &tactical, was_active, 0);
}

#[cfg(test)]
#[path = "tactics_settle_tests.rs"]
mod tactics_settle_tests;
