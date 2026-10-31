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
//! - `tuning`     — `TacticsTuning`: every design constant, read by every rule below.
//! - `economy`    — AP costs, Exert, the stride cap, Guard eligibility and multiplier.
//! - `initiative` — the round comparator and the tie-priority coin.
//! - `resolve`    — the battle model (`TacticalState`, events) and the §2.4 damage pipeline.
//! - `upkeep`     — the fixed-order end-of-round upkeep (ticks, Surge, KO sweep, caps).
//! - `outcome`    — the KO sweep, battle-end check, adjudication; `BattleOutcome` unchanged.
//! - `golden`     — the native = wasm golden-fixture runner.

pub mod economy;
#[cfg(test)]
mod economy_tests;
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
pub mod resolve;
#[cfg(test)]
mod resolve_tests;
pub mod tuning;
#[cfg(test)]
mod tuning_tests;
pub mod upkeep;
#[cfg(test)]
mod upkeep_tests;

pub use economy::{
    apply_flank, apply_guard, cost, guard_granted, plan_cost, spend, EconomyError, Entry, Tier,
    TurnBudget, TurnEndCause,
};
pub use geometry::{
    is_adjacent, is_flanked, line_of_sight, manhattan, target_set, Board, BoardUnit, Cell,
    FfFilter, GeometryError, Origin, Shape, Side, SkillGeometry,
};
pub use golden::{run_golden, GoldenBoard, GoldenCase, GoldenResult};
pub use initiative::{order, priority_for_round, round1_priority, Contender};
pub use map::{parse_battle_map, validate_battle_map, BattleMapDef, MapError, TileDef};
pub use movement::{
    disengage_taxed, find_path, stride_for_base_speed, terrain_weight, MoveClass, Path, PathError,
    Terrain,
};
pub use outcome::{
    adjudicate, check_battle_end, sweep_kos, Adjudication, BattleEndHow, StepSnapshot,
};
pub use resolve::{
    can_act, damage_pipeline, deploy_unit, draw_rolls, resolve_attack, splitmix64, turn_end,
    turn_start, ActError, AttackOutcome, BattleKind, DeployError, PipelineTrace, ResolveError,
    RollPair, SkillTactics, TacticalEvent, TacticalState, TacticalUnit, TargetResult, UnitKit,
    UnitState,
};
pub use tuning::TacticsTuning;
pub use upkeep::{run_upkeep, status_tick_damage, surge_damage, UpkeepStep, UPKEEP_ORDER};
