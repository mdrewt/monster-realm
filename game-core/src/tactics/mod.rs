//! Tactical battles (M-battle-tactics) — the grid rules, written once.
//!
//! The server validator, the client highlighter and forecast (via `client-wasm`) and
//! the wild AI all call these same functions; re-implementing one elsewhere is the
//! desync bug. Every rule is integer-only and iterates in an explicit order (no
//! hash-map iteration), so native and wasm agree byte-for-byte — `golden` holds the
//! shared fixture harness that proves it.
//!
//! - `geometry`   — Manhattan metric, line of sight, the skill target set, flank.
//! - `movement`   — stride bands, terrain × class weights, Dijkstra pathing, disengage.
//! - `map`        — the battle-map RON schema and its validator.
//! - `tuning`     — `TacticsTuning` (every design constant, read by every rule below) + `BattleKind`.
//! - `economy`    — AP costs, Exert, the stride cap, Guard eligibility and multiplier.
//! - `initiative` — the round comparator and the tie-priority coin.
//! - `resolve`    — the battle model (`TacticalState`, events) and the §2.4 damage pipeline.
//! - `upkeep`     — the fixed-order end-of-round upkeep (ticks, Surge, KO sweep, caps).
//! - `outcome`    — the KO sweep, battle-end check, adjudication; `BattleOutcome` unchanged.
//! - `golden`     — the native = wasm golden-fixture runner.
//! - `types`      — the storage enums: `QueuedAction`, `TurnState`, `Phase` (BSATN, append-only).
//! - `events`     — the `battle_event` payload enum + the §9.4 presentation caps.
//! - `clock`      — the idle clock: pure window / pad / reset / strike arithmetic.
//! - `queue`      — `Battle`: submit gate, `validate_at_pop`, the executor (halt-and-return), the chain rule.

pub mod clock;
#[cfg(test)]
mod clock_tests;
pub mod economy;
#[cfg(test)]
mod economy_tests;
pub mod events;
#[cfg(test)]
mod events_tests;
pub mod geometry;
#[cfg(test)]
mod geometry_tests;
pub mod golden;
#[cfg(test)]
mod golden_tests;
pub mod initiative;
#[cfg(test)]
mod initiative_tests;
pub mod map;
#[cfg(test)]
mod map_tests;
pub mod movement;
#[cfg(test)]
mod movement_tests;
pub mod outcome;
#[cfg(test)]
mod outcome_tests;
pub mod queue;
#[cfg(test)]
mod queue_tests;
pub mod resolve;
#[cfg(test)]
mod resolve_tests;
pub mod tuning;
#[cfg(test)]
mod tuning_tests;
pub mod types;
#[cfg(test)]
mod types_tests;
pub mod upkeep;
#[cfg(test)]
mod upkeep_tests;

pub use clock::{
    accept_submit, begin_unit_turn, deploy_budget_ms, expire, open_window, window_budget_ms,
    ClockError, ClockState, Expiry, Window,
};
pub use economy::{
    apply_flank, apply_guard, cost, guard_granted, plan_cost, spend, EconomyError, Entry, Tier,
    TurnBudget, TurnEndCause,
};
pub use events::{
    payload_of, presentation_cap_ms, AutoPassEvent, AwardsEvent, BattleEndEvent,
    BattleStartedEvent, EndHow, EventPayload, ExecutedEvent, HaltKind, HitEffectiveness,
    ItemUsedEvent, KoEvent, MissedEvent, MovedEvent, PlanHaltedEvent, QueueVoidedEvent,
    RecruitResultEvent, RoundEndedEvent, StatusChange, StatusEvent, StoodGroundEvent, SurgeEvent,
    TargetHit, TurnEndedEvent, ACTION_CAP_MS, BATTLE_START_CAP_MS, MOVE_CAP_MS, RESULTS_CAP_MS,
    TILE_CAP_MS, UPKEEP_CAP_MS,
};
pub use geometry::{
    is_adjacent, is_flanked, line_of_sight, manhattan, target_set, Board, BoardUnit, Cell,
    FfFilter, GeometryError, Origin, Shape, Side, SkillGeometry,
};
pub use golden::{run_golden, GoldenBoard, GoldenCase, GoldenResult};
pub use initiative::{compare, order, priority_for_round, round1_priority, Contender, TIE_SALT};
pub use map::{parse_battle_map, validate_battle_map, BattleMapDef, MapError, TileDef};
pub use movement::{
    disengage_taxed, find_path, stride_for_base_speed, terrain_weight, MoveClass, Path, PathError,
    Terrain,
};
pub use outcome::{
    adjudicate, check_battle_end, end_battle, settle, sweep_kos, Adjudication, BattleEndHow,
    StepSnapshot,
};
pub use queue::{
    is_player_owned, min_action_cost, validate_at_pop, Advancing, Battle, CancelError, ExpireError,
    HaltReason, Hooks, PlanOrigin, ReadyPlan, Rules, StepResult, SubmitError, Validated,
};
pub use resolve::{
    can_act, damage_pipeline, deploy_unit, draw_rolls, resolve_attack, splitmix64, turn_end,
    turn_start, validate_unit, ActError, AttackOutcome, DeployError, PipelineTrace, ResolveError,
    RollPair, SkillTactics, TacticalEvent, TacticalState, TacticalUnit, TargetResult, UnitKit,
    UnitState,
};
pub use tuning::{BattleKind, TacticsTuning, TuningError};
pub use types::{
    ActionKind, ActionTarget, ItemAction, MoveAction, Phase, QueuedAction, RecruitAction,
    SkillAction, TurnState, MAX_PLAN_ACTIONS, MAX_STORED_ENTRIES,
};
pub use upkeep::{run_upkeep, status_tick_damage, surge_damage};
