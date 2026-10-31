//! Wild AI — design §4.2: the three stances + the universal Exhausted rule, **seed-free**.
//!
//! [`plan`] is a pure function of the public board. It takes no RNG and no seed parameter (the
//! compile shape), reads the state only through a private view that has no `seed`/`action_seq`
//! field, and costs from a fresh budget — so the client's intent chip (the same wasm build on the
//! shared provisional board) and the server's TurnStart plan can never disagree. A stance that
//! wants randomness cannot compile against a seed; it must move its telegraph into server-pushed
//! `battle_event`s. Every choice is one `min_by_key` over an explicit tuple, so native and wasm
//! agree byte for byte.
//!
//! The plan is executed by the same executor as player queues (`queue::TacticalBattle`), so every
//! emitted entry is one `validate_at_pop` accepts: paths come from `movement::find_path`, aims
//! from `geometry::target_set`, the disengage tax from `movement::disengage_taxed`, stride points
//! from `queue::stride_points`, costs from `economy::plan_cost` (the trailing `EndTurn` included),
//! and every target-set unit passes `resolve::validate_unit`. No rule is re-implemented here.

use serde::{Deserialize, Serialize};

use super::geometry::Cell;
use super::resolve::TacticalState;
use super::tuning::TacticsTuning;
use super::types::QueuedAction;

/// Species stance (content `battler.stance`, joined by bt-6). Serde only — never a wire type (it is
/// re-derived from the species, not stored). Append-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stance {
    Aggressive,
    Territorial,
    Skittish,
}

/// Design §4.2 — the universal Exhausted rule: `cur_hp × 4 < max_hp`, in u32.
#[must_use]
pub fn is_exhausted(cur_hp: u16, max_hp: u16) -> bool {
    todo!("bt-4 skeleton")
}

/// THE wild planner. Pure function of `state`'s public board; no RNG, no seed; total (never
/// panics); costs from `TurnBudget::fresh(t)`; always ends with `EndTurn`; emits only `Move`,
/// `Skill` and `EndTurn`. `stance` is the species' `battler.stance`, `spawn` the wild's
/// `spawn_b[slot]` tile (the shell reads both from its rows). An actor that cannot act, a hostile
/// state (duplicate ids, an invalid actor, an unusable tuning) or a board with no conscious enemy
/// plans `[EndTurn]`.
#[must_use]
pub fn plan(
    state: &TacticalState,
    unit: u32,
    stance: Stance,
    spawn: Cell,
    t: &TacticsTuning,
) -> Vec<QueuedAction> {
    todo!("bt-4 skeleton")
}
