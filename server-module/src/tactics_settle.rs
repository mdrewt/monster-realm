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
//! Pure functions first (unit-tested without a host); the shell functions take `ctx`.
//!
//! bt-9 API freeze: every body below is neutral until the gating tests are red.
#![allow(dead_code)] // bt-9 API freeze only — removed with the implementation.

use std::collections::BTreeSet;

use crate::schema::{Battle, BattleSummary, BattleTactical};
use game_core::tactics::{Award, EventPayload, Ledger, StepResult, TacticalState};
use game_core::BattleOutcome;
use spacetimedb::ReducerContext;

/// The H1 proxy's threshold (‰): a battle whose FIRST recruit attempt saw the wild below it is
/// `weaken_first`. `scripts/playtest-report.mjs` carries the same default (`weakenThresholdPermille`).
pub(crate) const WEAKEN_FIRST_PERMILLE: u16 = 500;

/// The `Awards` line that carries the player's currency: no unit earns currency, and unit ids
/// are `auto_inc` from 1 (`tactics::DEPLOY_WINDOW_UNIT` is the same "no unit" convention).
pub(crate) const CURRENCY_AWARD_UNIT: u32 = 0;

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

/// The board as it stood when `fallen` had fallen and nothing else had: the final board with every
/// unit NOT in `fallen` restored to conscious (`Active`, HP ≥ 1). Exact under P1's monotone
/// consciousness (no heal, no revive).
#[must_use]
pub(crate) fn board_at(final_state: &TacticalState, fallen: &BTreeSet<u32>) -> TacticalState {
    let _ = fallen;
    final_state.clone()
}

/// Fold the transcript into the reward ledger (module doc). `events` may arrive in any order; the
/// fold sorts nothing — the caller passes them ascending `seq`. `bst_of(species_id)` is the
/// victim species' base-stat total (content); `None` skips the KO (`Fold::skipped_bst`).
#[must_use]
pub(crate) fn ledger_of(
    events: &[EventPayload],
    final_state: &TacticalState,
    bst_of: &dyn Fn(u32) -> Option<u16>,
) -> Fold {
    let _ = (events, final_state, bst_of);
    Fold::default()
}

/// The `Awards` lines of what was ACTUALLY applied: one per credited monster (ascending unit;
/// `essence` = the sum over pools) plus one [`CURRENCY_AWARD_UNIT`] line iff `currency > 0`.
#[must_use]
pub(crate) fn awards_events(applied: &[Award], currency: u64) -> Vec<EventPayload> {
    let _ = (applied, currency);
    Vec::new()
}

/// What `out` adds to the summary, given the facts before the step and the player-owned unit ids.
#[must_use]
pub(crate) fn step_delta(prev: &StepPrev, out: &StepResult, player_units: &[u32]) -> StepDelta {
    let _ = (prev, out, player_units);
    StepDelta::default()
}

/// `row` plus `delta`, saturating; the histogram grows to fit the largest bucket.
#[must_use]
pub(crate) fn apply_delta(row: BattleSummary, delta: &StepDelta) -> BattleSummary {
    let _ = delta;
    row
}

/// The battle's summary row, inserted zeroed (`outcome: Ongoing`) when absent. `None` when the
/// anchor or the tactical row is gone (nothing to describe).
pub(crate) fn find_or_insert_summary(
    ctx: &ReducerContext,
    battle_id: u64,
) -> Option<BattleSummary> {
    let _ = (ctx, battle_id);
    None
}

/// Add one step's delta to the battle's summary row (a zero delta writes nothing).
pub(crate) fn accumulate(
    ctx: &ReducerContext,
    anchor: &Battle,
    tactical: &BattleTactical,
    delta: &StepDelta,
) {
    let _ = (ctx, anchor, tactical, delta);
}

/// The recruit hook's one summary write: the battle's FIRST attempt decides `weaken_first`
/// (`hp_permille < WEAKEN_FIRST_PERMILLE`); later attempts leave it alone.
pub(crate) fn mark_first_recruit(ctx: &ReducerContext, battle_id: u64, hp_permille: u16) {
    let _ = (ctx, battle_id, hp_permille);
}

/// THE terminal settlement (module doc), called once by `tactics::finish` after the HP
/// write-back and the anchor update. Never `Err`s, never panics: every helper failure is logged
/// and the next step still runs.
pub(crate) fn settle(
    ctx: &ReducerContext,
    anchor: &Battle,
    tactical: &BattleTactical,
    close: &Close<'_>,
    hp_ok: bool,
    was_active: bool,
    now_ms: i64,
) {
    let _ = (ctx, anchor, tactical, close, hp_ok, was_active, now_ms);
}

/// A swept (prior-terminal) tactical battle whose summary is still `Ongoing` is finalised with
/// its anchor's outcome: the rows that would have finalised it are going.
pub(crate) fn finalize_swept_summary(
    ctx: &ReducerContext,
    battle_id: u64,
    outcome: BattleOutcome,
    rounds: u16,
    now_ms: i64,
) {
    let _ = (ctx, battle_id, outcome, rounds, now_ms);
}

#[cfg(test)]
#[path = "tactics_settle_tests.rs"]
mod tactics_settle_tests;
