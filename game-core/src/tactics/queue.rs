//! The turn machine — design §2.2 (unit-turn state machine, transaction chain rule) and §2.3
//! (queue states, submit gate, execution gate, halt-and-return).
//!
//! [`Battle`] is the whole tactical battle as the server persists it between transactions: the
//! rules state (`TacticalState`), the READY plans (`battle_queue` rows — DRAFT never leaves the
//! client), `turn_state`, one idle clock per side and the pending presentation pad. Its inputs are
//! the four things a reducer can bring: a submit, a cancel, a window expiry (the explicit
//! `AutoPass`/`AutoFlee` input, so there is no wall clock here) and "continue" (`step`, from a
//! battle start or a zero-delay `tactical_advance` row). Everything in between — TurnStart, the
//! executor, halt-and-return, TurnEnd, the chain of pre-queued and AI turns, upkeep — runs inside
//! one call and is never persisted ("Executing" is not a state).
//!
//! Two gates, both server-authoritative and both typed (reject, never clamp):
//! - the **submit gate** ([`Battle::validate_submit`]) costs the plan on the board as it stands at
//!   submit (strides × 2 + tiers + Exert + 3 × items + the disengage tax of each Move whose start
//!   tile is enemy-adjacent) against 6 for a pre-queue or the current AP for a live submit, and
//!   never stores a plan that is unaffordable on the unchanged board;
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

use serde::{Deserialize, Serialize};

use crate::combat::type_chart::TypeChart;

use super::clock::{ClockState, Window};
use super::economy::{EconomyError, Entry};
use super::events::{EventPayload, HaltKind};
use super::geometry::{Cell, GeometryError, Side};
use super::movement::{Path, PathError};
use super::resolve::{ActError, TacticalState};
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
pub trait Hooks {
    /// Live count of `item_id` held by `unit`'s owner.
    fn item_count(&self, unit: u32, item_id: u32) -> u32;
    /// Debit one `item_id` from `unit`'s owner; `false` when none is held (the entry halts, 0 AP).
    /// The debit happens in the same transaction as the effect.
    fn take_item(&mut self, unit: u32, item_id: u32) -> bool;
    /// Whether `unit`'s owner can receive a recruited monster (bt-5's `check_headroom` result).
    fn recruit_headroom(&self, unit: u32) -> bool;
    /// The wild planner (bt-4 `ai::plan`): a pure function of the live board, no seed.
    fn plan_ai(&self, state: &TacticalState, unit: u32) -> Vec<QueuedAction>;
    /// Extra rules of an Item / Recruit / Flee entry (item range and target filter, recruit
    /// pre-flight), run AFTER this module's own checks, at submit (first entry of a live submit)
    /// and at pop.
    ///
    /// # Errors
    /// The halt reason (the entry is wasted, 0 AP).
    fn validate_delegated(
        &self,
        state: &TacticalState,
        unit: u32,
        action: &QueuedAction,
    ) -> Result<(), HaltReason>;
    /// Resolve a validated, paid Item / Recruit / Flee entry: the item's effect, the recruit roll
    /// and removal (`RecruitResult`, `Awards`), the flee (set `outcome = Fled`). Must NOT emit
    /// `BattleEnd` — the executor does, from the outcome.
    fn resolve_delegated(
        &mut self,
        state: &mut TacticalState,
        unit: u32,
        action: &QueuedAction,
    ) -> Vec<EventPayload>;
}

/// Where a plan came from (design §2.2 `origin`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanOrigin {
    /// A submit for the waiting unit — executes now; a drain with ≥ 2 AP re-enters `Waiting`.
    Live,
    /// A READY row consumed at TurnStart — a drain ends the turn committed.
    PreQueued,
    /// `ai::plan` for a wild — a drain ends the turn committed.
    Ai,
}

/// A READY plan (`battle_queue` row): ≤ `MAX_STORED_ENTRIES` entries, the last always `EndTurn`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyPlan {
    pub unit: u32,
    pub entries: Vec<QueuedAction>,
}

/// The chain stopped at a round boundary: the shell schedules a zero-delay `tactical_advance`
/// row pinned by `(battle_id, round)` (ADR-0126 pattern) and calls [`Battle::step`] again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Advancing {
    pub battle_id: u64,
    pub round: u16,
}

/// Why the submit gate refused a plan (first failure wins, in declaration order).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmitError {
    Tuning(TuningError),
    /// The unit cannot act (battle over, unknown, recruited, fainted).
    Act(ActError),
    /// A live submit with no entry would execute nothing.
    Empty,
    /// More than `MAX_PLAN_ACTIONS` action entries.
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
    /// An AI plan with more than `MAX_PLAN_ACTIONS` actions or a non-terminal `EndTurn`.
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
    /// A Recruit target on the unit's own side.
    NotWild {
        target: u32,
    },
    /// Recruit / Flee under the PvP ruleset.
    NotAllowed(ActionKind),
    NoHeadroom,
    ItemNotHeld {
        item_id: u32,
    },
    Economy(EconomyError),
}

impl HaltReason {
    /// The stored coarse kind: `Act` → `CannotAct`, `Path` → `Unreachable`, `Geometry` →
    /// `Geometry`, `Economy` → `Unaffordable`, everything else one-to-one.
    #[must_use]
    pub fn kind(&self) -> HaltKind {
        todo!("bt-3 skeleton")
    }
}

/// What the execution gate established for an entry — the executor resolves from this, never
/// from the client's words again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Validated {
    /// The cheapest live path (fits `strides × stride`) and the costed entry (tax included).
    Move {
        path: Path,
        entry: Entry,
    },
    /// `aim` is the bound unit's CURRENT tile (or the caster's for `SelfTarget`).
    Skill {
        skill_id: u32,
        aim: Cell,
        entry: Entry,
    },
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
    /// The row was consumed at TurnStart (the unit is waiting or has acted this round).
    AlreadyActing,
    /// No READY row and the unit has not started its turn this round.
    NoPlan,
}

/// Why an expiry was refused (a stale fire is a no-op for the shell).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpireError {
    NotWaiting,
    WrongUnit {
        waiting: u32,
    },
    /// The fire's `window_seq` is not the open window's (ADR-0126 arg-identity pin).
    StaleWindow {
        current: u32,
    },
}

/// What one input produced: the events to store (in order), the window opened if the step ended
/// in `Waiting`, and the chain-bound counters (≤ 6 unit-turns, ≤ 18 actions per step).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepResult {
    pub events: Vec<EventPayload>,
    pub window: Option<Window>,
    pub unit_turns: u8,
    pub actions: u8,
}

/// The tactical battle between transactions (the server composes it from its rows).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Battle {
    pub battle_id: u64,
    pub state: TacticalState,
    /// READY rows. `state.queued` mirrors the ids so bt-2's KO sweep can void a plan; this module
    /// keeps the two in step.
    pub plans: Vec<ReadyPlan>,
    pub turn_state: TurnState,
    /// Per side (A = 0, B = 1). A wild side's clock never runs.
    pub clocks: [ClockState; 2],
    /// Σ presentation caps of the events emitted since the last Waiting (persisted across
    /// transactions; capped at `pad_cap_ms` when a window opens).
    pub pending_pad_ms: u32,
}

/// Player-owned: every side under the PvP ruleset; side A in a wild battle (the player's side).
#[must_use]
pub fn is_player_owned(kind: BattleKind, side: Side) -> bool {
    let _ = (kind, side);
    todo!("bt-3 skeleton")
}

/// The AP floor: the cheapest action (`min(light_cost, move_stride_cost, item_cost)`, 2 at the
/// design's numbers). A unit with less can do nothing but end its turn, so control never returns
/// to it live.
#[must_use]
pub fn min_action_cost(t: &TacticsTuning) -> u8 {
    let _ = t;
    todo!("bt-3 skeleton")
}

/// The execution gate (design §2.3): validate `action` for `unit` on the live `state`, reading
/// the owner's inventory through `hooks`. Pure (reads only). Per kind, first failure wins:
/// - every kind: `can_act` → `Act`;
/// - Move: `disengage_taxed` on the unit's CURRENT tile → `spend` on a copy of the budget
///   (`Economy`: zero strides, the stride cap — checked before any stride math — affordability)
///   → `find_path` on the live board (`Path`: unreachable, occupied, impassable, off-board — the
///   whole Move is invalid, never a partial walk) → `cost > strides × stride` → `TooFar`;
/// - Skill: skill in the kit (`UnknownSkill`) → the bound unit conscious, `aim` = its current
///   tile, or the caster's for `SelfTarget` (`TargetGone`) → `spend` copy (`Economy`, Exert
///   included) → `target_set` through the ONE geometry function (`Geometry`);
/// - Item: target as for Skill → `item_count ≥ 1` (`ItemNotHeld`) → `spend` copy →
///   `hooks.validate_delegated`;
/// - Recruit: `NotAllowed` under PvP rules → target conscious (`TargetGone`) → on the other side
///   (`NotWild`) → `is_adjacent` (`NotAdjacent`) → `recruit_headroom` (`NoHeadroom`) → bait
///   `item_count ≥ 1` (`ItemNotHeld`) → `spend` copy (`Economy`: the full budget) →
///   `hooks.validate_delegated`;
/// - Flee: `NotAllowed` under PvP rules → `spend` copy → `hooks.validate_delegated`;
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

impl Battle {
    /// A deployed battle before its first step: `NotActive`, no plans, idle clocks, pad 0.
    #[must_use]
    pub fn new(battle_id: u64, state: TacticalState) -> Battle {
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

    /// The round-boundary marker while `turn_state == Advancing`.
    #[must_use]
    pub fn advancing(&self) -> Option<Advancing> {
        todo!("bt-3 skeleton")
    }

    /// The submit gate (design §2.3), pure. A live submit is one for the waiting unit; everything
    /// else is a pre-queue. In order: `t.validate()` → `can_act` → shape (`Empty` live only,
    /// `TooManyActions`, `EndTurnNotLast`) → `MustBeAlone` → `NotInPvp` → per entry
    /// `UnknownSkill` / `UnknownTarget` / `OffBoard` → `NoHeadroom` → `ItemNotHeld` (Item
    /// entries and bait summed per item) → costing with `Move.taxed = disengage_taxed(start)`
    /// where start is the unit's tile, then each previous Move's destination, from a fresh budget
    /// (pre-queue) or the unit's budget (live) → live only: `validate_at_pop(entries[0])` →
    /// `InvalidNow`.
    ///
    /// # Errors
    /// See [`SubmitError`].
    pub fn validate_submit(
        &self,
        unit: u32,
        entries: &[QueuedAction],
        hooks: &dyn Hooks,
        t: &TacticsTuning,
    ) -> Result<(), SubmitError> {
        let _ = (unit, entries, hooks, t);
        todo!("bt-3 skeleton")
    }

    /// `submit_queue`: [`Battle::validate_submit`], then — pre-queue: normalise (append
    /// `EndTurn` iff absent; `[]` becomes `[EndTurn]`), replace any previous plan for the unit,
    /// mirror the id into `state.queued`, return an empty result (U's clock untouched); live:
    /// close U's window (`clock::accept_submit`), execute with origin `Live`, continue the round.
    ///
    /// # Errors
    /// See [`SubmitError`]; on `Err` the battle is byte-identical (nothing executes, no clock change).
    pub fn submit_queue(
        &mut self,
        now_ms: i64,
        unit: u32,
        entries: Vec<QueuedAction>,
        rules: &Rules,
        hooks: &mut dyn Hooks,
    ) -> Result<StepResult, SubmitError> {
        let _ = (now_ms, unit, entries, rules, hooks);
        todo!("bt-3 skeleton")
    }

    /// Delete `unit`'s READY row.
    ///
    /// # Errors
    /// `AlreadyActing` when no row exists because TurnStart consumed it (the unit is waiting or
    /// precedes the waiting unit this round); `NoPlan` otherwise.
    pub fn cancel_queue(&mut self, unit: u32) -> Result<(), CancelError> {
        let _ = unit;
        todo!("bt-3 skeleton")
    }

    /// Continue the chain (design §2.2): from `NotActive` (emits `BattleStarted`) or
    /// `Advancing`, start the round at its first unit and keep starting pre-queued and AI turns
    /// until `Waiting`, `Finished`, or the round's upkeep completes (`Advancing`). Never crosses
    /// a round boundary; ≤ initiative length unit-turns × ≤ 3 actions + one upkeep. While
    /// `Waiting` the step is a no-op (empty result).
    pub fn step(&mut self, now_ms: i64, rules: &Rules, hooks: &mut dyn Hooks) -> StepResult {
        let _ = (now_ms, rules, hooks);
        todo!("bt-3 skeleton")
    }

    /// The scheduled deadline fired for `unit`'s window `window_seq`: `clock::expire` → PvP
    /// `AutoPass` (turn ends uncommitted, one strike, the `autopass_forfeit`-th forfeits:
    /// `BattleEnd{Forfeit}`) or wild `AutoFlee` (the flee rule through `Hooks`, `BattleEnd{AutoFlee}`),
    /// then continue the round.
    ///
    /// # Errors
    /// `NotWaiting`, `WrongUnit`, `StaleWindow` — a stale fire changes nothing.
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
}
