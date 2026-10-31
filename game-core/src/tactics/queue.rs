//! The turn machine — design §2.2 (unit-turn state machine, transaction chain rule) and §2.3
//! (queue states, submit gate, execution gate, halt-and-return).
//!
//! [`TacticalBattle`] is the whole tactical battle as the server persists it between
//! transactions: the rules state (`TacticalState`), the READY plans (`battle_queue` rows — DRAFT
//! never leaves the client), `turn_state`, one idle clock per side and the pending presentation
//! pad. Its inputs are the things a reducer can bring: `start` (a battle start), `advance` (a
//! zero-delay `tactical_advance` row, pinned), `submit_queue`, `cancel_queue`, `expire` (the
//! explicit `AutoPass`/`AutoFlee` input, pinned — so there is no wall clock here) and `conclude`
//! (a forfeit or a disconnect). Everything in between — TurnStart, the executor,
//! halt-and-return, TurnEnd, the chain of pre-queued and AI turns, upkeep — runs inside one call
//! and is never persisted ("Executing" is not a state).
//!
//! Two gates, both server-authoritative and both typed (reject, never clamp):
//! - the **submit gate** ([`TacticalBattle::validate_submit`]) costs the plan on the board as it
//!   stands at submit (strides × 2 + tiers + Exert + 3 × items + the disengage tax of each Move
//!   whose start tile is enemy-adjacent) against 6 for a pre-queue or the current AP for a live
//!   submit, and never stores a plan that is unaffordable on the unchanged board;
//! - the **execution gate** ([`validate_at_pop`]) re-costs, re-paths and re-targets every entry on
//!   the LIVE board when it pops, re-reading the owner's inventory through [`Hooks`]; a
//!   client-sent tile is never read (Moves bind a destination, Skills bind a unit).
//!
//! **Waste rule — halt-and-return** (§12 Q2, `docs/DECISIONS.md`): the first invalid entry and
//! every later one are wasted — never executed, 0 AP, never retried, never in any event beyond
//! `PlanHalted{unit, idx, reason_kind}` — and a player-owned, conscious unit with ≥ 2 AP gets the
//! remainder back live in `Waiting(U)`.
//!
//! What this slice does NOT own arrives through [`Hooks`]: the wild planner (bt-4 `ai::plan`), the
//! inventory (bt-8 rows), the recruit headroom predicate and the Item / Recruit / Flee resolution
//! (bt-5 rules, bt-9 glue). The shell implements the trait by calling those game-core rules; the
//! tests inject fakes. Rules still live once — the trait is a seam, not a second home.
//!
//! `plans` is the authority over which units hold a READY row; `TacticalState::queued` is derived
//! from it at the entry of every input (so a stale shell-loaded mirror can never delete a plan) and
//! bt-2's KO sweep edits it mid-step; [`TacticalBattle`] re-syncs after every settle, upkeep and
//! delegated resolution.

use serde::{Deserialize, Serialize};

use crate::combat::type_chart::TypeChart;
use crate::combat::types::{BattleOutcome, StatusEffect};

use super::clock::{self, ClockState, Window};
use super::economy::{plan_cost, spend, EconomyError, Entry, TurnBudget, TurnEndCause};
use super::events::{
    payload_of, presentation_cap_ms, AutoPassEvent, BattleEndEvent, BattleStartedEvent, EndHow,
    EventPayload, HaltKind, ItemUsedEvent, MovedEvent, PlanHaltedEvent, QueueVoidedEvent,
    RoundEndedEvent, StatusChange, StatusEvent, TurnEndedEvent,
};
use super::geometry::{is_adjacent, target_set, Cell, GeometryError, Side};
use super::movement::{disengage_taxed, find_path, stride_for_base_speed, Path, PathError};
use super::outcome::{settle, StepSnapshot};
use super::resolve::{
    can_act, draw, resolve_attack, side_index, turn_end, turn_start, validate_unit, ActError,
    DeployError, ResolveError, TacticalState, UnitState,
};
use super::tuning::{BattleKind, TacticsTuning, TuningError};
use super::types::{ActionKind, ActionTarget, Phase, QueuedAction, TurnState, MAX_PLAN_ACTIONS};
use super::upkeep::run_upkeep;

/// The rule inputs every transition needs: the type chart (for `resolve_attack`) and the tuning.
#[derive(Clone, Copy)]
pub struct Rules<'a> {
    pub chart: &'a TypeChart,
    pub tuning: &'a TacticsTuning,
}

/// What the executor needs from outside the rules state. The server implements it over its rows
/// by calling the owning game-core rules (bt-4 `ai::plan`, bt-5 recruit/flee/rewards, bt-6 item
/// content); tests inject fakes. `unit` is always a unit id: the shell maps it to the owner.
///
/// Delegated kinds (Item, Recruit, Flee) reach the hooks AFTER this module's own checks, as the
/// [`Validated`] facts (the bound unit resolved, the aim re-centred) — never as the client's words.
/// A delegated refusal maps onto the existing reasons (an item's target filter →
/// `HaltReason::NotAllowed(Item)`, its range → `HaltReason::Geometry(OutOfRange)`, a recruit
/// pre-flight → `NoHeadroom`/`NotAdjacent`); `HaltReason` and `HaltKind` are frozen here.
pub trait Hooks {
    /// Live count of `item_id` held by `unit`'s owner.
    fn item_count(&self, unit: u32, item_id: u32) -> u32;
    /// Debit one `item_id` from `unit`'s owner; `false` when none is held (the entry halts, 0 AP —
    /// for an Item entry AND for a Recruit's bait). The debit happens in the same transaction as
    /// the effect.
    fn take_item(&mut self, unit: u32, item_id: u32) -> bool;
    /// Whether `unit`'s owner can receive a recruited monster (bt-5's `check_headroom` result).
    fn recruit_headroom(&self, unit: u32) -> bool;
    /// The wild planner (bt-4 `ai::plan`): a pure function of the live board, no seed — it is
    /// handed the state with `seed` and `action_seq` zeroed, so its answer is one a client can
    /// reproduce. Only `Move`, `Skill` and a trailing `EndTurn` are accepted from it (anything
    /// else halts the plan as `BadShape` at idx 0).
    fn plan_ai(&self, state: &TacticalState, unit: u32) -> Vec<QueuedAction>;
    /// Extra rules of a delegated entry (item range and target filter, recruit pre-flight), at
    /// submit (first entry of a live submit) and at pop; sees the state with the secret stream
    /// zeroed.
    ///
    /// # Errors
    /// The halt reason (the entry is wasted, 0 AP, nothing debited).
    fn validate_delegated(
        &self,
        state: &TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Result<(), HaltReason>;
    /// Resolve a validated, paid, debited delegated entry: the item's effect, the recruit roll and
    /// removal (`RecruitResult`), the flee bookkeeping. May return only `RecruitResult`,
    /// `Awards` and `Status` payloads (its own rule's outcomes); every other kind is the
    /// executor's or bt-2's and is dropped. A hook never decides the outcome: the terminal sweep
    /// (`outcome::settle`) does after it, and the executor itself sets `Fled` for a flee.
    fn resolve_delegated(
        &mut self,
        state: &mut TacticalState,
        unit: u32,
        validated: &Validated,
    ) -> Vec<EventPayload>;
}

/// A READY plan (`battle_queue` row): ≤ `MAX_STORED_ENTRIES` entries, the last always `EndTurn`.
/// `plans` is kept in ascending `unit` order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyPlan {
    pub unit: u32,
    pub entries: Vec<QueuedAction>,
}

/// The chain stopped at a round boundary: the shell schedules a zero-delay `tactical_advance`
/// row pinned by `(battle_id, round)` (ADR-0126 pattern) and calls [`TacticalBattle::advance`]
/// with the same pin. `round` is the round about to start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvancePin {
    pub battle_id: u64,
    pub round: u16,
}

/// Why the submit gate refused a plan (first failure wins, in declaration order).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmitError {
    Tuning(TuningError),
    /// The unit cannot act (battle over, unknown, recruited, fainted).
    Act(ActError),
    /// The unit is not on the sender's side.
    NotYourUnit,
    /// The unit is not player-owned (a wild never holds a plan).
    NotPlayerOwned,
    /// A live submit while no window is open (the shell's clock row is out of step).
    NoWindow,
    /// A live submit with no entry would execute nothing.
    Empty,
    /// More than `MAX_PLAN_ACTIONS` action entries (`count` saturates at 255).
    TooManyActions {
        count: u8,
    },
    /// `EndTurn` may only be the last entry.
    EndTurnNotLast,
    /// Recruit and Flee must each be the only action.
    MustBeAlone(ActionKind),
    /// Recruit and Flee are refused under the PvP ruleset.
    NotInPvp(ActionKind),
    UnknownSkill {
        skill_id: u32,
    },
    /// A bound unit id (skill/item target, recruit target) is not in the battle.
    UnknownTarget {
        id: u32,
    },
    /// A Move destination off the map.
    OffBoard {
        x: u8,
        y: u8,
    },
    /// Recruit without party headroom (the same predicate the client greys the verb with).
    NoHeadroom,
    /// The owner holds fewer of `item_id` than the plan uses (Item entries + bait).
    ItemNotHeld {
        item_id: u32,
        needed: u32,
        held: u32,
    },
    /// The disengage predicate refused a start tile (unreachable once `OffBoard` passed).
    Path(PathError),
    /// Costing on the unchanged board: stride cap, unaffordable, Recruit/Flee without the full budget.
    Economy(EconomyError),
    /// Live only: the first entry fails the execution gate on the live board — nothing executes,
    /// the window keeps running.
    InvalidNow {
        reason: HaltReason,
    },
}

/// Why an entry is invalid at pop (typed; `kind` is the stored coarse reason).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HaltReason {
    Act(ActError),
    /// A plan with more than `MAX_PLAN_ACTIONS` actions, a non-terminal `EndTurn`, or an AI plan
    /// holding anything but Move / Skill / EndTurn.
    BadShape,
    UnknownSkill {
        skill_id: u32,
    },
    /// The bound unit is gone or unconscious.
    TargetGone {
        id: u32,
    },
    /// No path on the live board (unreachable, occupied, impassable, off-board).
    Path(PathError),
    /// The cheapest path costs more stride points than the entry's strides buy.
    TooFar {
        cost: u16,
        points: u16,
    },
    /// `target_set` refused (range, LoS, aim).
    Geometry(GeometryError),
    NotAdjacent {
        target: u32,
    },
    /// A Recruit target that is player-owned.
    NotWild {
        target: u32,
    },
    /// Recruit / Flee under the PvP ruleset, or Item / Recruit / Flee by a wild.
    NotAllowed(ActionKind),
    NoHeadroom,
    ItemNotHeld {
        item_id: u32,
    },
    Economy(EconomyError),
    /// A unit row the pipeline cannot run on (`validate_unit`: 0 HP, over max HP, 0 defense) —
    /// the hostile-state guard carried from bt-2.
    BadUnit(DeployError),
    /// A tuning no rule can run on.
    Tuning(TuningError),
}

impl HaltReason {
    /// The stored coarse kind: `Act` → `CannotAct`, `Path` → `Unreachable`, `Geometry` →
    /// `Geometry`, `Economy` → `Unaffordable`, `BadUnit` | `Tuning` → `BadState`, everything else
    /// one-to-one.
    #[must_use]
    pub fn kind(&self) -> HaltKind {
        match self {
            HaltReason::Act(_) => HaltKind::CannotAct,
            HaltReason::BadShape => HaltKind::BadShape,
            HaltReason::UnknownSkill { .. } => HaltKind::UnknownSkill,
            HaltReason::TargetGone { .. } => HaltKind::TargetGone,
            HaltReason::Path(_) => HaltKind::Unreachable,
            HaltReason::TooFar { .. } => HaltKind::TooFar,
            HaltReason::Geometry(_) => HaltKind::Geometry,
            HaltReason::NotAdjacent { .. } => HaltKind::NotAdjacent,
            HaltReason::NotWild { .. } => HaltKind::NotWild,
            HaltReason::NotAllowed(_) => HaltKind::NotAllowed,
            HaltReason::NoHeadroom => HaltKind::NoHeadroom,
            HaltReason::ItemNotHeld { .. } => HaltKind::ItemNotHeld,
            HaltReason::Economy(_) => HaltKind::Unaffordable,
            HaltReason::BadUnit(_) | HaltReason::Tuning(_) => HaltKind::BadState,
        }
    }

    /// A residual `resolve_attack` refusal after the gate passed (the state is untouched) as a
    /// halt reason, one-to-one.
    fn of_resolve(error: ResolveError) -> HaltReason {
        match error {
            ResolveError::Act(e) => HaltReason::Act(e),
            ResolveError::UnknownSkill { skill_id, .. } => HaltReason::UnknownSkill { skill_id },
            ResolveError::Geometry(e) => HaltReason::Geometry(e),
            ResolveError::Economy(e) => HaltReason::Economy(e),
            ResolveError::Tuning(e) => HaltReason::Tuning(e),
            ResolveError::BadUnit(e) => HaltReason::BadUnit(e),
        }
    }
}

/// What the execution gate established for an entry — the executor (and the hooks) resolve from
/// this, never from the client's words again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Validated {
    /// The cheapest live path (fits `strides × stride`) and the costed entry (tax included).
    Move {
        path: Path,
        entry: Entry,
    },
    /// `aim` is the bound unit's CURRENT tile (or the caster's for `SelfTarget`); `targets` is
    /// `target_set`'s answer on the live board — the gate's word for the client's forecast and
    /// badges (bt-11), not read by the executor, which lets `resolve_attack` recompute it.
    Skill {
        skill_id: u32,
        aim: Cell,
        targets: Vec<u32>,
    },
    /// `target` is the resolved unit id (the actor itself for `SelfTarget`).
    Item {
        item_id: u32,
        target: u32,
        entry: Entry,
    },
    Recruit {
        target: u32,
        bait: Option<u32>,
        entry: Entry,
    },
    Flee {
        entry: Entry,
    },
    EndTurn,
}

/// Why a cancel was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CancelError {
    /// The unit is not on the sender's side.
    NotYourUnit,
    /// The row was consumed at TurnStart (the unit is waiting or has acted this round).
    AlreadyActing,
    /// No READY row and the unit has not started its turn this round (or no such unit).
    NoPlan,
}

/// Why an expiry was refused (every variant is a no-op for the shell; `NotDue` is the only one
/// that may retry).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpireError {
    Tuning(TuningError),
    NotWaiting,
    WrongUnit {
        waiting: u32,
    },
    /// The fire's `window_seq` is not the open window's (ADR-0126 arg-identity pin), or no
    /// window is open.
    StaleWindow {
        current: u32,
    },
    /// `now_ms < deadline_ms`: a premature fire changes nothing.
    NotDue {
        deadline_ms: i64,
    },
}

/// Why `start` / `advance` was refused (a stale advance is a no-op for the shell).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepError {
    Tuning(TuningError),
    /// `start` when not `NotActive` + `Ongoing`; `advance` when not `Advancing` + `Ongoing`.
    NotStartable {
        turn_state: TurnState,
    },
    /// `advance` with a pin that is not the current round boundary's.
    StaleAdvance {
        current: AdvancePin,
    },
}

/// Why `conclude` was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConcludeError {
    /// `conclude(Ongoing, _)` is not an end.
    NotAnEnd,
    AlreadyFinished,
}

/// What one input produced: the events to store (in order), the round they belong to (one round
/// per step by the chain rule), the window opened if the step ended in `Waiting`, and the
/// chain-bound counters: `unit_turns` = TurnStarts that passed `can_act` plus one for the
/// continuing live/expiry unit; `actions` = executed entries other than `EndTurn`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepResult {
    pub events: Vec<EventPayload>,
    pub round: u16,
    pub window: Option<Window>,
    pub unit_turns: u8,
    pub actions: u8,
}

/// The tactical battle between transactions. The server composes it from its rows and writes
/// it back — the persistence manifest (bt-7): `battle_id` (the anchor row); `state.{kind, seed,
/// action_seq, round, width, height, terrain, blocks_los, initiative, attack_damage_dealt}`
/// (`battle_tactical` + `battle_secret` + the map id; `attack_damage_dealt` is not in design §8.1
/// — appended); `state.units[*]` with `budget.{ap, strides_used, attacks, last}`, `guard`,
/// `first_stand`, `state`, `slot` (`battle_unit`); `plans` (`battle_queue`); `turn_state`
/// (`battle_tactical`); `clocks[side]` (`battle_clock`, keyed by SIDE — in Practice one player
/// holds both sides and both strike counts); `pending_pad_ms` (`battle_tactical`, not in §8.1 —
/// appended). `state.queued` is derived from `plans`, never stored. Never serialised toward a
/// client: it holds the seed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TacticalBattle {
    pub battle_id: u64,
    pub state: TacticalState,
    /// READY rows. Canonicalised (ascending `unit`, unique, units of this battle only) at the
    /// entry of every input; the authority `state.queued` is derived from.
    pub plans: Vec<ReadyPlan>,
    pub turn_state: TurnState,
    /// Per side (A = 0, B = 1). A wild side's clock never runs.
    pub clocks: [ClockState; 2],
    /// Σ presentation caps of the events emitted since the last Waiting (persisted across
    /// transactions; saturating; capped at `pad_cap_ms` when a window opens).
    pub pending_pad_ms: u32,
}

/// Player-owned: every side under the PvP ruleset; side A in a wild battle (the player's side).
#[must_use]
pub fn is_player_owned(kind: BattleKind, side: Side) -> bool {
    kind.uses_pvp_rules() || side == Side::A
}

/// The AP floor: the cheapest action (`min(light_cost, move_stride_cost, item_cost)`, 2 at the
/// design's numbers), never below 1. A unit with less can do nothing but end its turn, so control
/// never returns to it live.
#[must_use]
pub fn min_action_cost(t: &TacticsTuning) -> u8 {
    t.light_cost.min(t.move_stride_cost).min(t.item_cost).max(1)
}

/// The carried M14 turn-skip rule (`combat::status::apply_pre_turn_effects`, private helper
/// `check_action_block`): Sleep and Freeze always block, Paralysis blocks when `roll < 25`, Poison,
/// Burn and no status never. Re-stated (the `upkeep::status_tick_damage` precedent) because the
/// carried function takes a 1v1 `BattleState`, whose `BattleSide` has a sanctioned constructor
/// surface this module may not bypass; `queue_tests` pins it equal to the carried function over
/// every status × roll (bt-17 retires both).
#[must_use]
pub fn status_blocks_turn(status: Option<StatusEffect>, roll: u8) -> bool {
    match status {
        None | Some(StatusEffect::Poison | StatusEffect::Burn) => false,
        Some(StatusEffect::Paralysis) => roll < 25,
        Some(StatusEffect::Sleep { .. } | StatusEffect::Freeze) => true,
    }
}

/// The stride points a Move of `strides` strides buys a unit of `base_speed`
/// (`strides × stride_for_base_speed`); the cheapest live path must cost no more.
#[must_use]
pub fn stride_points(strides: u8, base_speed: u16) -> u16 {
    u16::from(strides) * u16::from(stride_for_base_speed(base_speed))
}

/// Where a plan came from (design §2.2 `origin`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlanOrigin {
    /// A submit for the waiting unit — executes now; a drain with ≥ 2 AP re-enters `Waiting`.
    Live,
    /// A READY row consumed at TurnStart — a drain ends the turn committed.
    PreQueued,
    /// `ai::plan` for a wild — a drain ends the turn committed.
    Ai,
}

impl PlanOrigin {
    /// The committed cause a halted-or-drained plan of this origin ends the turn with.
    fn end_cause(self) -> TurnEndCause {
        match self {
            PlanOrigin::Live => TurnEndCause::EndTurn,
            PlanOrigin::PreQueued => TurnEndCause::PreQueuedDrain,
            PlanOrigin::Ai => TurnEndCause::AiEnd,
        }
    }
}

/// How a unit-turn left the executor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Flow {
    /// The unit's turn ended (or it could not act); the round continues.
    Ended,
    /// `Waiting(U)`: the step stops here.
    Waiting,
    /// The battle is decided: the step stops here.
    Finished,
}

/// What one executed entry did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Resolved {
    /// Charged and resolved; the plan goes on.
    Executed,
    /// `EndTurn` executed: the turn ended.
    TurnEnded,
    /// Flee executed: the battle ended.
    BattleOver,
}

/// The shape every plan must have, whatever its origin: ≤ `MAX_PLAN_ACTIONS` actions and
/// `EndTurn` only last.
fn plan_shape(entries: &[QueuedAction]) -> Result<(), SubmitError> {
    let actions = entries.iter().filter(|e| e.is_action()).count();
    if actions > MAX_PLAN_ACTIONS {
        return Err(SubmitError::TooManyActions {
            count: u8::try_from(actions).unwrap_or(u8::MAX),
        });
    }
    let last = entries.len().saturating_sub(1);
    if entries
        .iter()
        .enumerate()
        .any(|(i, e)| !e.is_action() && i != last)
    {
        return Err(SubmitError::EndTurnNotLast);
    }
    Ok(())
}

/// The bound unit of a Skill / Item target on the live board: `(id, its current tile)`.
fn resolve_target(
    state: &TacticalState,
    actor: u32,
    actor_pos: Cell,
    target: ActionTarget,
) -> Result<(u32, Cell), HaltReason> {
    match target {
        ActionTarget::SelfTarget => Ok((actor, actor_pos)),
        ActionTarget::Unit(id) => state
            .unit(id)
            .filter(|u| u.is_conscious())
            .map(|u| (id, u.pos))
            .ok_or(HaltReason::TargetGone { id }),
    }
}

/// The state as a client could build it: the secret stream (`seed`, `action_seq`) zeroed. What
/// the planner and the delegated validators see, so their answers can never depend on it.
fn public_view(state: &TacticalState) -> TacticalState {
    TacticalState {
        seed: 0,
        action_seq: 0,
        ..state.clone()
    }
}

/// The execution gate (design §2.3): validate `action` for `unit` on the live `state`, reading
/// the owner's inventory through `hooks`. Pure (reads only). Per kind, first failure wins:
/// - every kind: `t.validate()` → `Tuning`; `can_act` → `Act`; `validate_unit(actor)` → `BadUnit`;
/// - Move: `disengage_taxed` on the unit's CURRENT tile → `spend` on a copy of the budget
///   (`Economy`: zero strides, the stride cap — checked before any stride math — affordability)
///   → `find_path` on the live board (`Path`: unreachable, occupied, impassable, off-board — the
///   whole Move is invalid, never a partial walk) → `cost > stride_points` → `TooFar`;
/// - Skill: skill in the kit (`UnknownSkill`) → the bound unit conscious, `aim` = its current
///   tile, or the caster's for `SelfTarget` (`TargetGone`) → `spend` copy (`Economy`, Exert
///   included) → `target_set` through the ONE geometry function (`Geometry`) → `validate_unit`
///   on every target (`BadUnit`);
/// - Item: `NotAllowed(Item)` unless the actor is player-owned → target as for Skill
///   (`TargetGone`) → `item_count ≥ 1` (`ItemNotHeld`) → `spend` copy → `hooks.validate_delegated`;
/// - Recruit: `NotAllowed(Recruit)` under PvP rules or by a wild → target conscious
///   (`TargetGone`) → not player-owned (`NotWild`) → `is_adjacent` (`NotAdjacent`) →
///   `recruit_headroom` (`NoHeadroom`) → bait `item_count ≥ 1` (`ItemNotHeld`) → `spend` copy
///   (`Economy`: the full budget) → `hooks.validate_delegated`;
/// - Flee: `NotAllowed(Flee)` under PvP rules or by a wild → `spend` copy →
///   `hooks.validate_delegated`;
/// - EndTurn: always valid.
///
/// The delegated validators see the [`public_view`] of the state.
///
/// # Errors
/// See [`HaltReason`].
pub fn validate_at_pop(
    state: &TacticalState,
    unit: u32,
    action: &QueuedAction,
    hooks: &dyn Hooks,
    t: &TacticsTuning,
) -> Result<Validated, HaltReason> {
    t.validate().map_err(HaltReason::Tuning)?;
    can_act(state, unit).map_err(HaltReason::Act)?;
    let actor = state
        .unit(unit)
        .ok_or(HaltReason::Act(ActError::UnknownUnit(unit)))?;
    validate_unit(actor).map_err(HaltReason::BadUnit)?;
    let player_owned = is_player_owned(state.kind, actor.side);
    let pvp = state.kind.uses_pvp_rules();
    // Every spend below runs on a COPY: the gate charges nothing.
    let affordable = |entry: Entry| -> Result<(), HaltReason> {
        let mut budget = actor.budget;
        spend(&mut budget, entry, t)
            .map(|_| ())
            .map_err(HaltReason::Economy)
    };
    let delegated = |validated: Validated| -> Result<Validated, HaltReason> {
        hooks.validate_delegated(&public_view(state), unit, &validated)?;
        Ok(validated)
    };
    match action {
        QueuedAction::Move(m) => {
            let board = state.board();
            let taxed = disengage_taxed(&board, unit, actor.pos).map_err(HaltReason::Path)?;
            let entry = Entry::Move {
                strides: m.strides,
                taxed,
            };
            affordable(entry)?;
            let path = find_path(&board, unit, actor.pos, m.dest()).map_err(HaltReason::Path)?;
            let points = stride_points(m.strides, actor.kit.base_speed);
            if path.cost > points {
                return Err(HaltReason::TooFar {
                    cost: path.cost,
                    points,
                });
            }
            Ok(Validated::Move { path, entry })
        }
        QueuedAction::Skill(s) => {
            let skill = actor
                .kit
                .skills
                .iter()
                .find(|k| k.skill_id == s.skill_id)
                .ok_or(HaltReason::UnknownSkill {
                    skill_id: s.skill_id,
                })?;
            let (_, aim) = resolve_target(state, unit, actor.pos, s.target)?;
            affordable(Entry::Attack(skill.tier))?;
            let board = state.board();
            let targets =
                target_set(&skill.geometry, unit, aim, &board).map_err(HaltReason::Geometry)?;
            for target in targets.iter().filter_map(|&id| state.unit(id)) {
                validate_unit(target).map_err(HaltReason::BadUnit)?;
            }
            Ok(Validated::Skill {
                skill_id: s.skill_id,
                aim,
                targets,
            })
        }
        QueuedAction::Item(i) => {
            if !player_owned {
                return Err(HaltReason::NotAllowed(ActionKind::Item));
            }
            let (target, _) = resolve_target(state, unit, actor.pos, i.target)?;
            if hooks.item_count(unit, i.item_id) == 0 {
                return Err(HaltReason::ItemNotHeld { item_id: i.item_id });
            }
            affordable(Entry::Item)?;
            delegated(Validated::Item {
                item_id: i.item_id,
                target,
                entry: Entry::Item,
            })
        }
        QueuedAction::Recruit(r) => {
            if pvp || !player_owned {
                return Err(HaltReason::NotAllowed(ActionKind::Recruit));
            }
            let target = state
                .unit(r.target)
                .filter(|u| u.is_conscious())
                .ok_or(HaltReason::TargetGone { id: r.target })?;
            if is_player_owned(state.kind, target.side) {
                return Err(HaltReason::NotWild { target: r.target });
            }
            if !is_adjacent(actor.pos, target.pos) {
                return Err(HaltReason::NotAdjacent { target: r.target });
            }
            if !hooks.recruit_headroom(unit) {
                return Err(HaltReason::NoHeadroom);
            }
            if let Some(bait) = r.bait {
                if hooks.item_count(unit, bait) == 0 {
                    return Err(HaltReason::ItemNotHeld { item_id: bait });
                }
            }
            affordable(Entry::Recruit)?;
            delegated(Validated::Recruit {
                target: r.target,
                bait: r.bait,
                entry: Entry::Recruit,
            })
        }
        QueuedAction::Flee => {
            if pvp || !player_owned {
                return Err(HaltReason::NotAllowed(ActionKind::Flee));
            }
            affordable(Entry::Flee)?;
            delegated(Validated::Flee { entry: Entry::Flee })
        }
        QueuedAction::EndTurn => Ok(Validated::EndTurn),
    }
}

/// The payload kinds a hook may contribute (its own rule's outcomes); everything else — every
/// kind this module or bt-2's rules emit — is dropped.
fn hook_may_emit(event: &EventPayload) -> bool {
    matches!(
        event,
        EventPayload::RecruitResult(_) | EventPayload::Awards(_) | EventPayload::Status(_)
    )
}

/// The other side's win (`outcome::winner_outcome` is private — out of this slice's touches).
fn win_for_opponent_of(side: Side) -> BattleOutcome {
    match side {
        Side::A => BattleOutcome::SideBWins,
        Side::B => BattleOutcome::SideAWins,
    }
}

impl TacticalBattle {
    /// A deployed battle before its first step: `NotActive`, no plans, idle clocks, pad 0,
    /// `state.queued` cleared.
    #[must_use]
    pub fn new(battle_id: u64, mut state: TacticalState) -> TacticalBattle {
        state.queued.clear();
        TacticalBattle {
            battle_id,
            state,
            plans: Vec::new(),
            turn_state: TurnState::NotActive,
            clocks: [ClockState::default(), ClockState::default()],
            pending_pad_ms: 0,
        }
    }

    /// `Phase::of(state.outcome)`.
    #[must_use]
    pub fn phase(&self) -> Phase {
        Phase::of(self.state.outcome)
    }

    /// The waiting unit's position in this round's initiative (the turn-order bar cursor); 0
    /// when no unit is waiting.
    #[must_use]
    pub fn turn_idx(&self) -> u8 {
        match self.turn_state {
            TurnState::Waiting(unit) => self
                .position(unit)
                .map_or(0, |p| u8::try_from(p).unwrap_or(u8::MAX)),
            TurnState::NotActive | TurnState::Advancing => 0,
        }
    }

    /// The READY plan for `unit`, if any.
    #[must_use]
    pub fn plan(&self, unit: u32) -> Option<&ReadyPlan> {
        self.plans.iter().find(|p| p.unit == unit)
    }

    /// The round-boundary pin while `turn_state == Advancing`.
    #[must_use]
    pub fn advance_pin(&self) -> Option<AdvancePin> {
        match self.turn_state {
            TurnState::Advancing => Some(AdvancePin {
                battle_id: self.battle_id,
                round: self.state.round,
            }),
            TurnState::NotActive | TurnState::Waiting(_) => None,
        }
    }

    /// The submit gate (design §2.3), pure. A live submit is one for the waiting unit; everything
    /// else is a pre-queue. In order: `t.validate()` → `can_act` → `NotYourUnit` →
    /// `NotPlayerOwned` → live: `NoWindow` → shape (`Empty` live only, `TooManyActions` on the
    /// `usize` count, `EndTurnNotLast`) → `MustBeAlone` → `NotInPvp` → per entry `UnknownSkill`
    /// / `UnknownTarget` / `OffBoard` → `NoHeadroom` → `ItemNotHeld` (Item entries and bait
    /// summed per item) → costing with `Move.taxed = disengage_taxed(start)` where start is the
    /// unit's tile, then each previous Move's destination, from a fresh budget (pre-queue) or the
    /// unit's budget (live) → live only: `validate_at_pop(entries[0])` → `InvalidNow`.
    ///
    /// # Errors
    /// See [`SubmitError`].
    pub fn validate_submit(
        &self,
        sender: Side,
        unit: u32,
        entries: &[QueuedAction],
        hooks: &dyn Hooks,
        t: &TacticsTuning,
    ) -> Result<(), SubmitError> {
        t.validate().map_err(SubmitError::Tuning)?;
        can_act(&self.state, unit).map_err(SubmitError::Act)?;
        let actor = self
            .state
            .unit(unit)
            .ok_or(SubmitError::Act(ActError::UnknownUnit(unit)))?;
        if actor.side != sender {
            return Err(SubmitError::NotYourUnit);
        }
        if !is_player_owned(self.state.kind, actor.side) {
            return Err(SubmitError::NotPlayerOwned);
        }
        let live = self.turn_state == TurnState::Waiting(unit);
        if live && self.clocks[side_index(actor.side)].window_open_ms.is_none() {
            return Err(SubmitError::NoWindow);
        }
        if live && entries.is_empty() {
            return Err(SubmitError::Empty);
        }
        plan_shape(entries)?;
        let actions = entries.iter().filter(|e| e.is_action()).count();
        let alone_kind = entries
            .iter()
            .map(QueuedAction::kind)
            .find(|k| matches!(k, ActionKind::Recruit | ActionKind::Flee));
        if let Some(kind) = alone_kind {
            if actions != 1 {
                return Err(SubmitError::MustBeAlone(kind));
            }
            if self.state.kind.uses_pvp_rules() {
                return Err(SubmitError::NotInPvp(kind));
            }
        }
        // One pass: the per-entry refusals, and the costable entries (a Move's tax is judged
        // in the costing pass below, once the start tiles are known).
        let known = |id: u32| self.state.unit(id).is_some();
        let mut plan: Vec<Entry> = Vec::with_capacity(entries.len());
        for entry in entries {
            plan.push(match entry {
                QueuedAction::Skill(s) => {
                    let tier = actor
                        .kit
                        .skills
                        .iter()
                        .find(|k| k.skill_id == s.skill_id)
                        .map(|k| k.tier)
                        .ok_or(SubmitError::UnknownSkill {
                            skill_id: s.skill_id,
                        })?;
                    if let ActionTarget::Unit(id) = s.target {
                        if !known(id) {
                            return Err(SubmitError::UnknownTarget { id });
                        }
                    }
                    Entry::Attack(tier)
                }
                QueuedAction::Item(i) => {
                    if let ActionTarget::Unit(id) = i.target {
                        if !known(id) {
                            return Err(SubmitError::UnknownTarget { id });
                        }
                    }
                    Entry::Item
                }
                QueuedAction::Recruit(r) => {
                    if !known(r.target) {
                        return Err(SubmitError::UnknownTarget { id: r.target });
                    }
                    Entry::Recruit
                }
                QueuedAction::Move(m) => {
                    if m.x >= self.state.width || m.y >= self.state.height {
                        return Err(SubmitError::OffBoard { x: m.x, y: m.y });
                    }
                    Entry::Move {
                        strides: m.strides,
                        taxed: false,
                    }
                }
                QueuedAction::Flee => Entry::Flee,
                QueuedAction::EndTurn => Entry::EndTurn,
            });
        }
        if alone_kind == Some(ActionKind::Recruit) && !hooks.recruit_headroom(unit) {
            return Err(SubmitError::NoHeadroom);
        }
        let mut usage: Vec<(u32, u32)> = Vec::new();
        let mut use_item = |item_id: u32| match usage.iter_mut().find(|(id, _)| *id == item_id) {
            Some((_, needed)) => *needed = needed.saturating_add(1),
            None => usage.push((item_id, 1)),
        };
        for entry in entries {
            match entry {
                QueuedAction::Item(i) => use_item(i.item_id),
                QueuedAction::Recruit(r) => {
                    if let Some(bait) = r.bait {
                        use_item(bait);
                    }
                }
                QueuedAction::Move(_)
                | QueuedAction::Skill(_)
                | QueuedAction::Flee
                | QueuedAction::EndTurn => {}
            }
        }
        for &(item_id, needed) in &usage {
            let held = hooks.item_count(unit, item_id);
            if held < needed {
                return Err(SubmitError::ItemNotHeld {
                    item_id,
                    needed,
                    held,
                });
            }
        }
        let board = self.state.board();
        let mut start = actor.pos;
        for (entry, action) in plan.iter_mut().zip(entries) {
            if let (Entry::Move { taxed, .. }, QueuedAction::Move(m)) = (entry, action) {
                *taxed = disengage_taxed(&board, unit, start).map_err(SubmitError::Path)?;
                start = m.dest();
            }
        }
        let budget = if live {
            actor.budget
        } else {
            TurnBudget::fresh(t)
        };
        plan_cost(&budget, &plan, t).map_err(SubmitError::Economy)?;
        if live {
            if let Some(first) = entries.first() {
                validate_at_pop(&self.state, unit, first, hooks, t)
                    .map_err(|reason| SubmitError::InvalidNow { reason })?;
            }
        }
        Ok(())
    }

    /// `submit_queue`: [`TacticalBattle::validate_submit`], then — pre-queue: normalise (append
    /// `EndTurn` iff absent; `[]` becomes `[EndTurn]`), replace any previous plan for the unit,
    /// return an empty result (U's clock untouched); live: snapshot the initiative and the
    /// continuation index FIRST, close U's window (`clock::accept_submit`), execute with origin
    /// `Live`, continue the round from the snapshot.
    ///
    /// # Errors
    /// See [`SubmitError`]; on `Err` the battle is byte-identical (nothing executes, no clock change).
    pub fn submit_queue(
        &mut self,
        now_ms: i64,
        sender: Side,
        unit: u32,
        entries: Vec<QueuedAction>,
        rules: &Rules,
        hooks: &mut dyn Hooks,
    ) -> Result<StepResult, SubmitError> {
        self.validate_submit(sender, unit, &entries, hooks, rules.tuning)?;
        self.canonicalise_plans();
        let mut out = StepResult {
            round: self.state.round,
            ..StepResult::default()
        };
        if self.turn_state != TurnState::Waiting(unit) {
            let mut entries = entries;
            if !matches!(entries.last(), Some(QueuedAction::EndTurn)) {
                entries.push(QueuedAction::EndTurn);
            }
            self.put_plan(ReadyPlan { unit, entries });
            return Ok(out);
        }
        let side = self.side_of(unit).ok_or(SubmitError::NotYourUnit)?;
        let order = self.state.initiative.clone();
        let next = self.position(unit).map_or(order.len(), |p| p + 1);
        clock::accept_submit(&mut self.clocks[side_index(side)], now_ms)
            .map_err(|_| SubmitError::NoWindow)?;
        out.unit_turns = 1;
        let flow = self.execute(
            unit,
            &entries,
            PlanOrigin::Live,
            now_ms,
            rules,
            hooks,
            &mut out,
        );
        self.after_turn(flow, &order, next, now_ms, rules, hooks, &mut out);
        Ok(out)
    }

    /// Delete `unit`'s READY row.
    ///
    /// # Errors
    /// `NotYourUnit`; `AlreadyActing` when no row exists because TurnStart consumed it (the unit
    /// is waiting or precedes the waiting unit this round); `NoPlan` otherwise. Every `Err`
    /// leaves the battle byte-identical.
    pub fn cancel_queue(&mut self, sender: Side, unit: u32) -> Result<(), CancelError> {
        let side = self.side_of(unit).ok_or(CancelError::NoPlan)?;
        if side != sender {
            return Err(CancelError::NotYourUnit);
        }
        if self.plan(unit).is_some() {
            self.canonicalise_plans();
            self.take_plan(unit);
            return Ok(());
        }
        if let TurnState::Waiting(waiting) = self.turn_state {
            if waiting == unit {
                return Err(CancelError::AlreadyActing);
            }
            if let (Some(mine), Some(theirs)) = (self.position(unit), self.position(waiting)) {
                if mine < theirs {
                    return Err(CancelError::AlreadyActing);
                }
            }
        }
        Err(CancelError::NoPlan)
    }

    /// The battle starts (design §2.2): from `NotActive` + `Ongoing` only — emits
    /// `BattleStarted{round}` and runs the round from its first unit: TurnStart each unit in a
    /// snapshot of the initiative, keep starting pre-queued and AI turns until `Waiting`,
    /// `Finished`, or the round's upkeep completes (`Advancing`). Never crosses a round
    /// boundary; ≤ initiative length unit-turns × ≤ 3 actions + one upkeep.
    ///
    /// # Errors
    /// `Tuning`, `NotStartable`.
    pub fn start(
        &mut self,
        now_ms: i64,
        rules: &Rules,
        hooks: &mut dyn Hooks,
    ) -> Result<StepResult, StepError> {
        rules.tuning.validate().map_err(StepError::Tuning)?;
        if self.turn_state != TurnState::NotActive || self.state.outcome != BattleOutcome::Ongoing {
            return Err(StepError::NotStartable {
                turn_state: self.turn_state,
            });
        }
        self.canonicalise_plans();
        let mut out = StepResult {
            round: self.state.round,
            ..StepResult::default()
        };
        self.emit(
            &mut out,
            EventPayload::BattleStarted(BattleStartedEvent {
                round: self.state.round,
            }),
        );
        let order = self.state.initiative.clone();
        self.continue_round(&order, 0, now_ms, rules, hooks, &mut out);
        Ok(out)
    }

    /// The zero-delay `tactical_advance` row fired: from `Advancing` + `Ongoing` with `pin ==
    /// advance_pin()` only, run the new round from its first unit (as [`TacticalBattle::start`]).
    ///
    /// # Errors
    /// `Tuning`, `NotStartable`, `StaleAdvance` — a duplicate or stale fire changes nothing.
    pub fn advance(
        &mut self,
        now_ms: i64,
        pin: AdvancePin,
        rules: &Rules,
        hooks: &mut dyn Hooks,
    ) -> Result<StepResult, StepError> {
        rules.tuning.validate().map_err(StepError::Tuning)?;
        let current = self
            .advance_pin()
            .filter(|_| self.state.outcome == BattleOutcome::Ongoing)
            .ok_or(StepError::NotStartable {
                turn_state: self.turn_state,
            })?;
        if pin != current {
            return Err(StepError::StaleAdvance { current });
        }
        self.canonicalise_plans();
        let mut out = StepResult {
            round: self.state.round,
            ..StepResult::default()
        };
        let order = self.state.initiative.clone();
        self.continue_round(&order, 0, now_ms, rules, hooks, &mut out);
        Ok(out)
    }

    /// The scheduled deadline fired for `unit`'s window `window_seq` at `now_ms`:
    /// `clock::expire` → PvP ruleset `AutoPass` (turn ends uncommitted, no Guard, one strike;
    /// the `autopass_forfeit`-th concludes the battle with `BattleEnd{Forfeit}` for the other
    /// side) or wild `AutoFlee` (the flee hook, then `BattleEnd{Fled, AutoFlee}` whatever the
    /// hook did), then continue the round from the snapshot taken before anything ran.
    ///
    /// # Errors
    /// `Tuning`, `NotWaiting`, `WrongUnit`, `StaleWindow`, `NotDue` — every one changes nothing.
    pub fn expire(
        &mut self,
        now_ms: i64,
        unit: u32,
        window_seq: u32,
        rules: &Rules,
        hooks: &mut dyn Hooks,
    ) -> Result<StepResult, ExpireError> {
        let t = rules.tuning;
        t.validate().map_err(ExpireError::Tuning)?;
        let TurnState::Waiting(waiting) = self.turn_state else {
            return Err(ExpireError::NotWaiting);
        };
        if waiting != unit {
            return Err(ExpireError::WrongUnit { waiting });
        }
        let side = self.side_of(unit).ok_or(ExpireError::NotWaiting)?;
        let idx = side_index(side);
        let current = self.clocks[idx].window_seq;
        if self.clocks[idx].window_open_ms.is_none() || current != window_seq {
            return Err(ExpireError::StaleWindow { current });
        }
        let expiry = match clock::expire(&mut self.clocks[idx], now_ms, self.state.kind, t) {
            Ok(expiry) => expiry,
            Err(clock::ClockError::NotDue { deadline_ms }) => {
                return Err(ExpireError::NotDue { deadline_ms })
            }
            Err(
                clock::ClockError::NoWindow
                | clock::ClockError::AlreadyOpen
                | clock::ClockError::WindowCap { .. },
            ) => return Err(ExpireError::StaleWindow { current }),
        };
        self.canonicalise_plans();
        let order = self.state.initiative.clone();
        let next = self.position(unit).map_or(order.len(), |p| p + 1);
        let mut out = StepResult {
            round: self.state.round,
            unit_turns: 1,
            ..StepResult::default()
        };
        match expiry {
            clock::Expiry::AutoPass { strike, forfeit } => {
                self.emit(
                    &mut out,
                    EventPayload::AutoPass(AutoPassEvent { unit, strike }),
                );
                let flow = self.end_turn(unit, TurnEndCause::AutoPass, t, &mut out);
                if forfeit {
                    self.end_with(win_for_opponent_of(side), EndHow::Forfeit, &mut out);
                    return Ok(out);
                }
                self.after_turn(flow, &order, next, now_ms, rules, hooks, &mut out);
            }
            clock::Expiry::AutoFlee => {
                self.delegate(
                    unit,
                    &Validated::Flee { entry: Entry::Flee },
                    hooks,
                    &mut out,
                );
                self.end_with(BattleOutcome::Fled, EndHow::AutoFlee, &mut out);
            }
        }
        Ok(out)
    }

    /// End the battle from outside the chain (a forfeit, a disconnect): `outcome` is recorded,
    /// `BattleEnd{outcome, how}` is emitted, every READY plan is voided (`QueueVoided` each,
    /// ascending unit), any open window is closed without idle accounting, `turn_state =
    /// NotActive`. The same path every in-chain end takes.
    ///
    /// # Errors
    /// `NotAnEnd` for `Ongoing`; `AlreadyFinished`.
    pub fn conclude(
        &mut self,
        outcome: BattleOutcome,
        how: EndHow,
    ) -> Result<StepResult, ConcludeError> {
        if outcome == BattleOutcome::Ongoing {
            return Err(ConcludeError::NotAnEnd);
        }
        if self.state.outcome != BattleOutcome::Ongoing {
            return Err(ConcludeError::AlreadyFinished);
        }
        self.canonicalise_plans();
        let mut out = StepResult {
            round: self.state.round,
            ..StepResult::default()
        };
        self.end_with(outcome, how, &mut out);
        Ok(out)
    }

    // ------------------------------------------------------------------------------------------
    // The chain (design §2.2), private.
    // ------------------------------------------------------------------------------------------

    /// TurnStart every unit of `order` from `from`; stop at `Waiting` / `Finished`; after the
    /// last unit run the round's upkeep and stop at `Advancing` (or `finish`).
    fn continue_round(
        &mut self,
        order: &[u32],
        from: usize,
        now_ms: i64,
        rules: &Rules,
        hooks: &mut dyn Hooks,
        out: &mut StepResult,
    ) {
        for &id in order.iter().skip(from) {
            if self.state.outcome != BattleOutcome::Ongoing {
                return;
            }
            match self.start_turn(id, now_ms, rules, hooks, out) {
                Flow::Ended => {}
                Flow::Waiting | Flow::Finished => return,
            }
        }
        if self.state.outcome != BattleOutcome::Ongoing {
            return;
        }
        self.end_round(rules, out);
    }

    /// What follows one unit's turn inside a live submit or an expiry.
    #[allow(clippy::too_many_arguments)]
    fn after_turn(
        &mut self,
        flow: Flow,
        order: &[u32],
        next: usize,
        now_ms: i64,
        rules: &Rules,
        hooks: &mut dyn Hooks,
        out: &mut StepResult,
    ) {
        match flow {
            Flow::Ended => self.continue_round(order, next, now_ms, rules, hooks, out),
            Flow::Waiting | Flow::Finished => {}
        }
    }

    /// The end-of-round upkeep: `RoundEnded{r}` first (the batch header), then the upkeep's
    /// events, then `Advancing` — or `finish` when the upkeep decided the battle.
    fn end_round(&mut self, rules: &Rules, out: &mut StepResult) {
        let round = self.state.round;
        self.emit(out, EventPayload::RoundEnded(RoundEndedEvent { round }));
        let events = run_upkeep(&mut self.state, rules.tuning);
        for event in &events {
            self.emit(out, payload_of(event));
        }
        self.sync_plans(out);
        if self.state.outcome != BattleOutcome::Ongoing {
            self.finish(out);
            return;
        }
        self.turn_state = TurnState::Advancing;
    }

    /// TurnStart(U): skip a unit that cannot act; refresh the budget, Guard and First-Stand;
    /// begin the owner's unit-turn on its clock; void a READY row under a turn-skip status;
    /// execute the AI plan (wild) or the READY row (player), else wait.
    fn start_turn(
        &mut self,
        unit: u32,
        now_ms: i64,
        rules: &Rules,
        hooks: &mut dyn Hooks,
        out: &mut StepResult,
    ) -> Flow {
        let t = rules.tuning;
        if can_act(&self.state, unit).is_err() || turn_start(&mut self.state, unit, t).is_err() {
            return Flow::Ended;
        }
        let Some((side, status)) = self.state.unit(unit).map(|u| (u.side, u.status)) else {
            return Flow::Ended;
        };
        out.unit_turns = out.unit_turns.saturating_add(1);
        let player_owned = is_player_owned(self.state.kind, side);
        if player_owned {
            clock::begin_unit_turn(&mut self.clocks[side_index(side)]);
        }
        let roll = if matches!(status, Some(StatusEffect::Paralysis)) {
            (draw(&mut self.state) % 100) as u8
        } else {
            0
        };
        if let Some(status) = status.filter(|_| status_blocks_turn(status, roll)) {
            self.emit(
                out,
                EventPayload::Status(StatusEvent {
                    unit,
                    status,
                    change: StatusChange::Blocked,
                    amount: 0,
                }),
            );
            if self.take_plan(unit).is_some() {
                self.emit(out, EventPayload::QueueVoided(QueueVoidedEvent { unit }));
            }
            return self.end_turn(unit, TurnEndCause::AutoPass, t, out);
        }
        if !player_owned {
            let plan = hooks.plan_ai(&public_view(&self.state), unit);
            return self.execute(unit, &plan, PlanOrigin::Ai, now_ms, rules, hooks, out);
        }
        if let Some(plan) = self.take_plan(unit) {
            return self.execute(
                unit,
                &plan.entries,
                PlanOrigin::PreQueued,
                now_ms,
                rules,
                hooks,
                out,
            );
        }
        self.enter_waiting(unit, now_ms, rules, out)
    }

    /// Execute(entries, origin) — design §2.2: the shape check for every origin, then each entry
    /// through the gate; the first refusal halts the plan (the one halt site).
    #[allow(clippy::too_many_arguments)]
    fn execute(
        &mut self,
        unit: u32,
        entries: &[QueuedAction],
        origin: PlanOrigin,
        now_ms: i64,
        rules: &Rules,
        hooks: &mut dyn Hooks,
        out: &mut StepResult,
    ) -> Flow {
        let t = rules.tuning;
        let ai_ok = origin != PlanOrigin::Ai
            || entries.iter().all(|e| {
                matches!(
                    e,
                    QueuedAction::Move(_) | QueuedAction::Skill(_) | QueuedAction::EndTurn
                )
            });
        if plan_shape(entries).is_err() || !ai_ok {
            return self.halt(unit, 0, HaltReason::BadShape, origin, now_ms, rules, out);
        }
        for (idx, action) in entries.iter().enumerate() {
            match self.run_entry(unit, action, rules, hooks, out) {
                Err(reason) => {
                    let idx = u8::try_from(idx).unwrap_or(u8::MAX);
                    return self.halt(unit, idx, reason, origin, now_ms, rules, out);
                }
                Ok(Resolved::TurnEnded) => return Flow::Ended,
                Ok(Resolved::BattleOver) => {
                    out.actions = out.actions.saturating_add(1);
                    return Flow::Finished;
                }
                Ok(Resolved::Executed) => {}
            }
            out.actions = out.actions.saturating_add(1);
            self.sync_plans(out);
            if self.state.outcome != BattleOutcome::Ongoing {
                self.finish(out);
                return Flow::Finished;
            }
            if can_act(&self.state, unit).is_err() {
                return self.end_turn(unit, origin.end_cause(), t, out);
            }
        }
        let ap = self.state.unit(unit).map_or(0, |u| u.budget.ap);
        match origin {
            PlanOrigin::PreQueued | PlanOrigin::Ai => {
                self.end_turn(unit, origin.end_cause(), t, out)
            }
            PlanOrigin::Live if ap < min_action_cost(t) => {
                self.end_turn(unit, TurnEndCause::EndTurn, t, out)
            }
            PlanOrigin::Live => self.enter_waiting(unit, now_ms, rules, out),
        }
    }

    /// One entry: the gate, then the resolution. `Err` is a halt — nothing charged, nothing
    /// debited (a debit precedes its charge, and both follow the gate).
    fn run_entry(
        &mut self,
        unit: u32,
        action: &QueuedAction,
        rules: &Rules,
        hooks: &mut dyn Hooks,
        out: &mut StepResult,
    ) -> Result<Resolved, HaltReason> {
        let t = rules.tuning;
        let snap = StepSnapshot::capture(&self.state);
        let validated = validate_at_pop(&self.state, unit, action, hooks, t)?;
        match &validated {
            Validated::EndTurn => {
                self.charge(unit, Entry::EndTurn, t)?;
                self.end_turn(unit, TurnEndCause::EndTurn, t, out);
                Ok(Resolved::TurnEnded)
            }
            Validated::Move { path, entry } => {
                let from = self
                    .state
                    .unit(unit)
                    .map(|u| u.pos)
                    .ok_or(HaltReason::Act(ActError::UnknownUnit(unit)))?;
                self.charge(unit, *entry, t)?;
                let to = path.steps.last().copied().unwrap_or(from);
                if let Some(u) = self.state.unit_mut(unit) {
                    u.pos = to;
                }
                self.emit(
                    out,
                    EventPayload::Moved(MovedEvent {
                        unit,
                        from_x: from.x,
                        from_y: from.y,
                        to_x: to.x,
                        to_y: to.y,
                        tiles: u8::try_from(path.steps.len()).unwrap_or(u8::MAX),
                    }),
                );
                self.settle_now(&snap, out);
                Ok(Resolved::Executed)
            }
            Validated::Skill { skill_id, aim, .. } => {
                let outcome =
                    resolve_attack(&mut self.state, unit, *skill_id, *aim, rules.chart, t)
                        .map_err(HaltReason::of_resolve)?;
                for event in &outcome.events {
                    self.emit(out, payload_of(event));
                }
                Ok(Resolved::Executed)
            }
            Validated::Item {
                item_id,
                target,
                entry,
            } => {
                if !hooks.take_item(unit, *item_id) {
                    return Err(HaltReason::ItemNotHeld { item_id: *item_id });
                }
                self.charge(unit, *entry, t)?;
                self.emit(
                    out,
                    EventPayload::ItemUsed(ItemUsedEvent {
                        unit,
                        item_id: *item_id,
                        target: *target,
                    }),
                );
                self.delegate(unit, &validated, hooks, out);
                self.settle_now(&snap, out);
                Ok(Resolved::Executed)
            }
            Validated::Recruit { bait, entry, .. } => {
                if let Some(bait) = *bait {
                    if !hooks.take_item(unit, bait) {
                        return Err(HaltReason::ItemNotHeld { item_id: bait });
                    }
                }
                self.charge(unit, *entry, t)?;
                self.delegate(unit, &validated, hooks, out);
                self.settle_now(&snap, out);
                Ok(Resolved::Executed)
            }
            Validated::Flee { entry } => {
                self.charge(unit, *entry, t)?;
                self.delegate(unit, &validated, hooks, out);
                self.end_with(BattleOutcome::Fled, EndHow::Fled, out);
                Ok(Resolved::BattleOver)
            }
        }
    }

    /// Halt-and-return: `PlanHalted`, then `Waiting(U)` for a player-owned conscious unit with
    /// the AP floor left, else a committed TurnEnd.
    #[allow(clippy::too_many_arguments)]
    fn halt(
        &mut self,
        unit: u32,
        idx: u8,
        reason: HaltReason,
        origin: PlanOrigin,
        now_ms: i64,
        rules: &Rules,
        out: &mut StepResult,
    ) -> Flow {
        let t = rules.tuning;
        self.emit(
            out,
            EventPayload::PlanHalted(PlanHaltedEvent {
                unit,
                idx,
                reason_kind: reason.kind(),
            }),
        );
        let returnable = self.state.unit(unit).is_some_and(|u| {
            is_player_owned(self.state.kind, u.side)
                && can_act(&self.state, unit).is_ok()
                && u.budget.ap >= min_action_cost(t)
        });
        if returnable {
            return self.enter_waiting(unit, now_ms, rules, out);
        }
        self.end_turn(unit, origin.end_cause(), t, out)
    }

    /// `Waiting(U)`: open the owner's window with the accumulated pad. A refused window (the
    /// per-unit-turn cap, unreachable at the design's numbers; or a window the shell left open)
    /// ends the turn uncommitted.
    fn enter_waiting(
        &mut self,
        unit: u32,
        now_ms: i64,
        rules: &Rules,
        out: &mut StepResult,
    ) -> Flow {
        let t = rules.tuning;
        let Some(side) = self.side_of(unit) else {
            return self.end_turn(unit, TurnEndCause::AutoPass, t, out);
        };
        self.turn_state = TurnState::Waiting(unit);
        match clock::open_window(
            &mut self.clocks[side_index(side)],
            now_ms,
            self.pending_pad_ms,
            self.state.kind,
            t,
        ) {
            Ok(window) => {
                self.pending_pad_ms = 0;
                out.window = Some(window);
                Flow::Waiting
            }
            Err(clock::ClockError::WindowCap { .. } | clock::ClockError::AlreadyOpen) => {
                self.turn_state = TurnState::NotActive;
                self.end_turn(unit, TurnEndCause::AutoPass, t, out)
            }
            Err(clock::ClockError::NoWindow | clock::ClockError::NotDue { .. }) => {
                // `open_window` never returns these; treated as the cap for totality.
                self.turn_state = TurnState::NotActive;
                self.end_turn(unit, TurnEndCause::AutoPass, t, out)
            }
        }
    }

    /// TurnEnd: Guard per `economy::guard_granted`, the budget idled, `TurnEnded`. A unit that
    /// can no longer act (KO'd during its own turn) ends uncommitted without Guard.
    fn end_turn(
        &mut self,
        unit: u32,
        cause: TurnEndCause,
        t: &TacticsTuning,
        out: &mut StepResult,
    ) -> Flow {
        let (guard, committed) = match turn_end(&mut self.state, unit, cause, t) {
            Ok(guard) => (guard, cause.committed()),
            Err(_) => (false, false),
        };
        self.emit(
            out,
            EventPayload::TurnEnded(TurnEndedEvent {
                unit,
                guard,
                committed,
            }),
        );
        Flow::Ended
    }

    /// `outcome::settle` after a non-attack entry (the one terminal-sweep site), then the plan sync.
    fn settle_now(&mut self, snap: &StepSnapshot, out: &mut StepResult) {
        let events = settle(&mut self.state, snap);
        for event in &events {
            self.emit(out, payload_of(event));
        }
    }

    /// A delegated resolution: the hook's events (roster-filtered). A hook never decides the
    /// outcome — an outcome it wrote is restored, the terminal sweep decides (`settle`), and the
    /// Flee arms set `Fled` themselves.
    fn delegate(
        &mut self,
        unit: u32,
        validated: &Validated,
        hooks: &mut dyn Hooks,
        out: &mut StepResult,
    ) {
        let before = self.state.outcome;
        let events = hooks.resolve_delegated(&mut self.state, unit, validated);
        self.state.outcome = before;
        for event in events.into_iter().filter(hook_may_emit) {
            self.emit(out, event);
        }
    }

    /// Record `outcome` (the caller guarantees the battle is undecided), emit `BattleEnd`, `finish`.
    fn end_with(&mut self, outcome: BattleOutcome, how: EndHow, out: &mut StepResult) {
        self.state.outcome = outcome;
        self.emit(
            out,
            EventPayload::BattleEnd(BattleEndEvent { outcome, how }),
        );
        self.finish(out);
    }

    /// Every end path: void the remaining plans (ascending unit), close any open window
    /// without idle accounting, `NotActive`.
    fn finish(&mut self, out: &mut StepResult) {
        let plans = std::mem::take(&mut self.plans);
        for plan in plans {
            self.emit(
                out,
                EventPayload::QueueVoided(QueueVoidedEvent { unit: plan.unit }),
            );
        }
        self.state.queued.clear();
        for clock in &mut self.clocks {
            clock.window_open_ms = None;
            clock.deadline_ms = None;
        }
        self.turn_state = TurnState::NotActive;
    }

    /// Spend `entry` from `unit`'s budget (already validated on a copy).
    fn charge(&mut self, unit: u32, entry: Entry, t: &TacticsTuning) -> Result<u8, HaltReason> {
        let u = self
            .state
            .unit_mut(unit)
            .ok_or(HaltReason::Act(ActError::UnknownUnit(unit)))?;
        spend(&mut u.budget, entry, t).map_err(HaltReason::Economy)
    }

    /// Push an event and accumulate its presentation cap into the pending pad.
    fn emit(&mut self, out: &mut StepResult, event: EventPayload) {
        self.pending_pad_ms = self
            .pending_pad_ms
            .saturating_add(presentation_cap_ms(&event));
        out.events.push(event);
    }

    /// Drop every plan whose unit left `state.queued` (bt-2's sweep or a recruit removal). A
    /// fainted unit's `QueueVoided` already came from the sweep; any other removal is voided here.
    fn sync_plans(&mut self, out: &mut StepResult) {
        let gone: Vec<u32> = self
            .plans
            .iter()
            .map(|p| p.unit)
            .filter(|unit| !self.state.queued.contains(unit))
            .collect();
        for unit in gone {
            self.plans.retain(|p| p.unit != unit);
            let fainted = self
                .state
                .unit(unit)
                .is_some_and(|u| u.state == UnitState::Fainted);
            if !fainted {
                self.emit(out, EventPayload::QueueVoided(QueueVoidedEvent { unit }));
            }
        }
    }

    /// Canonicalise the shell-loaded rows — ascending `unit`, one per unit (the first kept),
    /// units of this battle only — and derive `state.queued` from them (the authority).
    fn canonicalise_plans(&mut self) {
        self.plans.retain(|p| self.state.unit(p.unit).is_some());
        self.plans.sort_by_key(|p| p.unit);
        self.plans.dedup_by_key(|p| p.unit);
        self.derive_queued();
    }

    /// `state.queued` from `plans`.
    fn derive_queued(&mut self) {
        self.state.queued = self.plans.iter().map(|p| p.unit).collect();
    }

    /// Insert or replace in place (`plans` is canonical), then re-derive the mirror.
    fn put_plan(&mut self, plan: ReadyPlan) {
        match self.plans.binary_search_by_key(&plan.unit, |p| p.unit) {
            Ok(i) => self.plans[i] = plan,
            Err(i) => self.plans.insert(i, plan),
        }
        self.derive_queued();
    }

    /// Remove and return the plan for `unit`, then re-derive the mirror.
    fn take_plan(&mut self, unit: u32) -> Option<ReadyPlan> {
        let i = self.plans.iter().position(|p| p.unit == unit)?;
        let plan = self.plans.remove(i);
        self.derive_queued();
        Some(plan)
    }

    fn side_of(&self, unit: u32) -> Option<Side> {
        self.state.unit(unit).map(|u| u.side)
    }

    fn position(&self, unit: u32) -> Option<usize> {
        self.state.initiative.iter().position(|&u| u == unit)
    }
}
