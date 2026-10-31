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

use super::clock::{ClockState, Window};
use super::economy::{EconomyError, Entry};
use super::events::{EndHow, EventPayload, HaltKind};
use super::geometry::{Cell, GeometryError, Side};
use super::movement::{Path, PathError};
use super::resolve::{ActError, DeployError, TacticalState};
use super::tuning::{BattleKind, TacticsTuning, TuningError};
use super::types::{ActionKind, Phase, QueuedAction, TurnState};

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
    /// The wild planner (bt-4 `ai::plan`): a pure function of the live board, no seed. Only
    /// `Move`, `Skill` and a trailing `EndTurn` are accepted from it (anything else halts the
    /// plan as `BadShape` at idx 0).
    fn plan_ai(&self, state: &TacticalState, unit: u32) -> Vec<QueuedAction>;
    /// Extra rules of a delegated entry (item range and target filter, recruit pre-flight), at
    /// submit (first entry of a live submit) and at pop.
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
    /// removal (`RecruitResult`), the flee bookkeeping (the executor itself sets `outcome = Fled`
    /// and emits `BattleEnd`). May return only `RecruitResult`, `Awards`, `Status`, `Ko`, `Moved`
    /// and `ItemUsed` payloads; every other kind is the executor's and is dropped.
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
    /// The owner holds fewer of `item_id` than the plan uses (Item entries + bait).
    ItemNotHeld {
        item_id: u32,
        needed: u32,
        held: u32,
    },
    /// Recruit without party headroom (the same predicate the client greys the verb with).
    NoHeadroom,
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
        todo!("bt-3 skeleton")
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
    /// `aim` is the bound unit's CURRENT tile (or the caster's for `SelfTarget`); the targets are
    /// `target_set`'s answer on the live board.
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
    /// No READY row and the unit has not started its turn this round.
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
    /// `start` when not `NotActive` + `Ongoing`; `advance` when not `Advancing`.
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

/// The tactical battle between transactions (the server composes it from its rows; see the
/// persistence manifest in the slice's plan memo / PR body).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TacticalBattle {
    pub battle_id: u64,
    pub state: TacticalState,
    /// READY rows, ascending `unit`. The authority: `state.queued` is derived from it.
    pub plans: Vec<ReadyPlan>,
    pub turn_state: TurnState,
    /// Per side (A = 0, B = 1). A wild side's clock never runs. bt-7 keys `battle_clock` by side.
    pub clocks: [ClockState; 2],
    /// Σ presentation caps of the events emitted since the last Waiting (persisted across
    /// transactions; saturating; capped at `pad_cap_ms` when a window opens).
    pub pending_pad_ms: u32,
}

/// Player-owned: every side under the PvP ruleset; side A in a wild battle (the player's side).
#[must_use]
pub fn is_player_owned(kind: BattleKind, side: Side) -> bool {
    let _ = (kind, side);
    todo!("bt-3 skeleton")
}

/// The AP floor: the cheapest action (`min(light_cost, move_stride_cost, item_cost)`, 2 at the
/// design's numbers), never below 1. A unit with less can do nothing but end its turn, so control
/// never returns to it live.
#[must_use]
pub fn min_action_cost(t: &TacticsTuning) -> u8 {
    let _ = t;
    todo!("bt-3 skeleton")
}

/// The carried M14 turn-skip rule (`combat::status::apply_pre_turn_effects`, private helper
/// `check_action_block`): Sleep and Freeze always block, Paralysis blocks when `roll < 25`, Poison,
/// Burn and no status never. Re-stated because the carried function needs a 1v1 `BattleState`;
/// `queue_tests` pins it equal to the carried function over every status × roll (bt-17 retires both).
#[must_use]
pub fn status_blocks_turn(status: Option<StatusEffect>, roll: u8) -> bool {
    let _ = (status, roll);
    todo!("bt-3 skeleton")
}

/// The execution gate (design §2.3): validate `action` for `unit` on the live `state`, reading
/// the owner's inventory through `hooks`. Pure (reads only). Per kind, first failure wins:
/// - every kind: `t.validate()` → `Tuning`; `can_act` → `Act`; `validate_unit(actor)` → `BadUnit`;
/// - Move: `disengage_taxed` on the unit's CURRENT tile → `spend` on a copy of the budget
///   (`Economy`: zero strides, the stride cap — checked before any stride math — affordability)
///   → `find_path` on the live board (`Path`: unreachable, occupied, impassable, off-board — the
///   whole Move is invalid, never a partial walk) → `cost > strides × stride` → `TooFar`;
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
/// # Errors
/// See [`HaltReason`].
pub fn validate_at_pop(
    state: &TacticalState,
    unit: u32,
    action: &QueuedAction,
    hooks: &dyn Hooks,
    t: &TacticsTuning,
) -> Result<Validated, HaltReason> {
    let _ = (state, unit, action, hooks, t);
    todo!("bt-3 skeleton")
}

impl TacticalBattle {
    /// A deployed battle before its first step: `NotActive`, no plans, idle clocks, pad 0,
    /// `state.queued` cleared.
    #[must_use]
    pub fn new(battle_id: u64, state: TacticalState) -> TacticalBattle {
        let _ = (battle_id, state);
        todo!("bt-3 skeleton")
    }

    /// `Phase::of(state.outcome)`.
    #[must_use]
    pub fn phase(&self) -> Phase {
        todo!("bt-3 skeleton")
    }

    /// The waiting unit's position in this round's initiative (the turn-order bar cursor); 0
    /// when no unit is waiting.
    #[must_use]
    pub fn turn_idx(&self) -> u8 {
        todo!("bt-3 skeleton")
    }

    /// The READY plan for `unit`, if any.
    #[must_use]
    pub fn plan(&self, unit: u32) -> Option<&ReadyPlan> {
        let _ = unit;
        todo!("bt-3 skeleton")
    }

    /// The round-boundary pin while `turn_state == Advancing`.
    #[must_use]
    pub fn advance_pin(&self) -> Option<AdvancePin> {
        todo!("bt-3 skeleton")
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
        let _ = (sender, unit, entries, hooks, t);
        todo!("bt-3 skeleton")
    }

    /// `submit_queue`: [`TacticalBattle::validate_submit`], then — pre-queue: normalise (append
    /// `EndTurn` iff absent; `[]` becomes `[EndTurn]`), replace any previous plan for the unit (in
    /// place, `plans` stays sorted by unit), return an empty result (U's clock untouched); live:
    /// snapshot the initiative and the continuation index FIRST, close U's window
    /// (`clock::accept_submit`), execute with origin `Live`, continue the round from the snapshot.
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
        let _ = (now_ms, sender, unit, entries, rules, hooks);
        todo!("bt-3 skeleton")
    }

    /// Delete `unit`'s READY row.
    ///
    /// # Errors
    /// `NotYourUnit`; `AlreadyActing` when no row exists because TurnStart consumed it (the unit
    /// is waiting or precedes the waiting unit this round); `NoPlan` otherwise.
    pub fn cancel_queue(&mut self, sender: Side, unit: u32) -> Result<(), CancelError> {
        let _ = (sender, unit);
        todo!("bt-3 skeleton")
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
        let _ = (now_ms, rules, hooks);
        todo!("bt-3 skeleton")
    }

    /// The zero-delay `tactical_advance` row fired: from `Advancing` with `pin ==
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
        let _ = (now_ms, pin, rules, hooks);
        todo!("bt-3 skeleton")
    }

    /// The scheduled deadline fired for `unit`'s window `window_seq` at `now_ms`:
    /// `clock::expire` → PvP ruleset `AutoPass` (turn ends uncommitted, no Guard, one strike;
    /// the `autopass_forfeit`-th concludes the battle with `BattleEnd{Forfeit}` for the other
    /// side) or wild `AutoFlee` (the flee hook, then `conclude(Fled, AutoFlee)` whatever the hook
    /// did), then continue the round from the snapshot taken before anything ran.
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
        let _ = (now_ms, unit, window_seq, rules, hooks);
        todo!("bt-3 skeleton")
    }

    /// End the battle from outside the chain (a forfeit, a disconnect): `outcome` is recorded
    /// (never overwriting a decided one), `BattleEnd{outcome, how}` is emitted, every READY plan
    /// is voided (`QueueVoided` each, ascending unit), any open window is closed without idle
    /// accounting, `turn_state = NotActive`. The same path every in-chain end takes.
    ///
    /// # Errors
    /// `NotAnEnd` for `Ongoing`; `AlreadyFinished`.
    pub fn conclude(
        &mut self,
        outcome: BattleOutcome,
        how: EndHow,
    ) -> Result<StepResult, ConcludeError> {
        let _ = (outcome, how);
        todo!("bt-3 skeleton")
    }
}
