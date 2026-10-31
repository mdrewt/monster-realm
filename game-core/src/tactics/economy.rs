//! AP economy — design §2.1 (costs), §2.1.1 (ruling checks), §2.1.2 (Guard), §2.1.3 (the
//! degenerate-optimum audit, property-tested in `economy_tests.rs`).
//!
//! A unit-turn starts with `ap_turn` AP and no carry-over. Every entry is costed from
//! [`TacticsTuning`] — nothing here hard-codes a number — and [`spend`] refuses (never clamps) an
//! entry the budget cannot pay. Exert makes every attack after the first cost `+exert_surcharge`,
//! which is what keeps Heavy + Light (8) and Heavy + Heavy (10) out of a 6-AP turn; two stationary
//! Lights (2 + 4 = 6) are the only double attack.
//!
//! Guard replaces AP banking: a unit that ends its turn by player commitment without attacking and
//! with ≥ `guard_min_ap` unspent takes ×`guard_num/guard_den` attack damage until its next
//! TurnStart. It never stacks (a flag), and status ticks and Surge ignore it (they never call
//! [`apply_guard`]).
//!
//! This module depends on `tuning` only; `resolve` embeds a [`TurnBudget`] in every unit.

use serde::{Deserialize, Serialize};

use super::tuning::TacticsTuning;

/// Attack tier — content decides which (bt-6's `tactics_skills`); the economy prices it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    Light,
    Heavy,
}

/// One costable plan entry. `Move.taxed` is the disengage predicate's answer
/// (`movement::disengage_taxed`) for that entry's start tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Entry {
    Move { strides: u8, taxed: bool },
    Attack(Tier),
    Item,
    Recruit,
    Flee,
    EndTurn,
}

/// The per-unit-turn ledger (stored per unit; the design's `ap`, `strides_used`, `attacks`).
/// `Default` (all zero) is a unit that has not activated yet.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnBudget {
    pub ap: u8,
    pub strides_used: u8,
    pub attacks: u8,
}

impl TurnBudget {
    /// The budget at a unit's TurnStart: `ap_turn` AP, nothing used.
    #[must_use]
    pub fn fresh(t: &TacticsTuning) -> Self {
        let _ = t;
        todo!("bt-2 economy: TurnBudget::fresh")
    }
}

/// Why an entry cannot be spent. Checked in declaration order by [`spend`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EconomyError {
    /// A Move of zero strides is not an entry.
    ZeroStrides,
    /// `strides_used + requested` exceeds `max_strides_per_turn`.
    StrideCap { used: u8, requested: u8, cap: u8 },
    /// Recruit and Flee need the unit's full `ap_turn` AP at execution.
    NeedsFullBudget { ap: u8, required: u8 },
    /// `cost > ap`.
    Unaffordable { cost: u8, ap: u8 },
}

/// Why a unit-turn ended. Only a committed end can grant Guard (design §2.1.2 (a)).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnEndCause {
    /// An `EndTurn` entry executed.
    EndTurn,
    /// A pre-queued plan drained.
    PreQueuedDrain,
    /// The wild AI ended its plan.
    AiEnd,
    /// A clock window expired (PvP). Never counts as commitment.
    AutoPass,
}

impl TurnEndCause {
    /// Player commitment: everything except a timeout auto-pass.
    #[must_use]
    pub fn committed(self) -> bool {
        todo!("bt-2 economy: TurnEndCause::committed")
    }
}

/// The AP an entry costs against `budget` (Exert reads `budget.attacks`). Saturating u8.
#[must_use]
pub fn cost(entry: Entry, budget: &TurnBudget, t: &TacticsTuning) -> u8 {
    let _ = (entry, budget, t);
    todo!("bt-2 economy: cost")
}

/// Spend `entry` from `budget`, returning the AP charged. Checks, first failure wins:
/// `Move { strides: 0 }` → `ZeroStrides`; stride cap → `StrideCap`; Recruit/Flee without the
/// full budget → `NeedsFullBudget`; `cost > ap` → `Unaffordable`. On `Err` the budget is
/// untouched. On `Ok` it subtracts the cost, adds the strides and counts an attack.
///
/// # Errors
/// See [`EconomyError`].
pub fn spend(budget: &mut TurnBudget, entry: Entry, t: &TacticsTuning) -> Result<u8, EconomyError> {
    let _ = (budget, entry, t);
    todo!("bt-2 economy: spend")
}

/// The total cost of `entries` spent in order from a fresh budget (the submit gate's costing
/// and the §2.1.3 audit's oracle).
///
/// # Errors
/// The first entry that cannot be spent.
pub fn plan_cost(entries: &[Entry], t: &TacticsTuning) -> Result<u8, EconomyError> {
    let _ = (entries, t);
    todo!("bt-2 economy: plan_cost")
}

/// Design §2.1.2: Guard iff the end was committed AND no attack executed AND
/// `ap ≥ guard_min_ap` AND the last entry was not Recruit or Flee.
#[must_use]
pub fn guard_granted(
    cause: TurnEndCause,
    budget: &TurnBudget,
    last: Option<Entry>,
    t: &TacticsTuning,
) -> bool {
    let _ = (cause, budget, last, t);
    todo!("bt-2 economy: guard_granted")
}

/// Guard on incoming ATTACK damage: `damage × guard_num / guard_den`, floor, min 1 — except
/// that 0 damage (an immune hit) stays 0. Status ticks and Surge never call this.
#[must_use]
pub fn apply_guard(damage: u16, t: &TacticsTuning) -> u16 {
    let _ = (damage, t);
    todo!("bt-2 economy: apply_guard")
}

/// Flank on attack damage: `damage × flank_num / flank_den`, floor (clamped to `u16::MAX`).
#[must_use]
pub fn apply_flank(damage: u16, t: &TacticsTuning) -> u16 {
    let _ = (damage, t);
    todo!("bt-2 economy: apply_flank")
}
