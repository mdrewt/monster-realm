//! Storage enums — design §8.1: `QueuedAction` (the `battle_queue` entries and the
//! `submit_queue` argument), `TurnState` (`battle_tactical.turn_state`) and `Phase`
//! (`battle_tactical.phase`).
//!
//! These are BSATN wire types: `SpacetimeType` is derived behind the `spacetimedb` feature
//! (server-module only; the feature-isolation eval keeps it off `client-wasm`), variants and
//! fields are append-only (`evals/baselines/spacetime-types.json` freezes the order), and there is
//! NO `serde(default)` compatibility assumption (the M14.5f lesson: BSATN is positional, a defaulted
//! field is not a wire-compatible field). The derive accepts only unit or one-field variants, so
//! every payload is its own `#[derive(SpacetimeType)]` struct — which also freezes its field order.
//!
//! `QueuedAction` is CLIENT input: `MoveAction::strides` and every id are hostile until the submit
//! gate (`queue::Battle::validate_submit`) and the execution gate (`queue::validate_at_pop`) have
//! refused or accepted them. Nothing here validates; these are the shapes.

use serde::{Deserialize, Serialize};

use crate::combat::types::BattleOutcome;

use super::geometry::Cell;

/// Action entries a plan may hold (design §2.3: "≤ 3 action entries", the most 6 AP buys at the
/// 2-AP floor), excluding the trailing `EndTurn`.
pub const MAX_PLAN_ACTIONS: usize = 3;

/// Entries a stored plan may hold: `MAX_PLAN_ACTIONS` plus the trailing `EndTurn`.
pub const MAX_STORED_ENTRIES: usize = MAX_PLAN_ACTIONS + 1;

/// `Move{dest, strides}` — the bound destination and the stride count (1 or 2; the gates refuse
/// anything else). `x`/`y` are stored flat because `Cell` is not a wire type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct MoveAction {
    pub x: u8,
    pub y: u8,
    pub strides: u8,
}

impl MoveAction {
    /// The bound destination as a board tile.
    #[must_use]
    pub fn dest(&self) -> Cell {
        todo!("bt-3 skeleton")
    }
}

/// What a Skill or Item is bound to: a unit id (the executor re-centres on that unit's CURRENT
/// tile) or the actor itself. Never a tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum ActionTarget {
    Unit(u32),
    SelfTarget,
}

/// `Skill{skill_id, target}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct SkillAction {
    pub skill_id: u32,
    pub target: ActionTarget,
}

/// `Item{item_id, target}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct ItemAction {
    pub item_id: u32,
    pub target: ActionTarget,
}

/// `Recruit{target, bait}` — the wild unit id and an optional bait item id (0 AP, consumed).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct RecruitAction {
    pub target: u32,
    pub bait: Option<u32>,
}

/// The closed plan-entry enum (design §8.1). Append-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum QueuedAction {
    Move(MoveAction),
    Skill(SkillAction),
    Item(ItemAction),
    Recruit(RecruitAction),
    Flee,
    EndTurn,
}

/// The kind of a [`QueuedAction`] (for typed errors and the "only entry" rules). Not stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionKind {
    Move,
    Skill,
    Item,
    Recruit,
    Flee,
    EndTurn,
}

impl QueuedAction {
    /// The entry's kind.
    #[must_use]
    pub fn kind(&self) -> ActionKind {
        todo!("bt-3 skeleton")
    }

    /// Everything but the terminal `EndTurn`.
    #[must_use]
    pub fn is_action(&self) -> bool {
        todo!("bt-3 skeleton")
    }
}

/// `battle_tactical.turn_state` (design §8.1): `NotActive` in Deploying and Finished;
/// `Waiting(unit)` exactly when the battle is idle on that unit's owner and a clock window is
/// armed; `Advancing` exactly when a zero-delay `tactical_advance` row is pending between chained
/// transactions. Execution and upkeep happen inside a transaction and are never persisted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum TurnState {
    NotActive,
    Waiting(u32),
    Advancing,
}

/// `battle_tactical.phase`: `Deploying → Active → Finished`. `Deploying` is server-only (no
/// `TacticalState` exists yet); the rules see `Active` or `Finished`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Phase {
    Deploying,
    Active,
    Finished,
}

impl Phase {
    /// The phase of a deployed battle: `Ongoing` → `Active`, anything decided → `Finished`.
    #[must_use]
    pub fn of(outcome: BattleOutcome) -> Phase {
        let _ = outcome;
        todo!("bt-3 skeleton")
    }
}
