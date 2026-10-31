//! AP economy — design §2.1 (costs), §2.1.1 (ruling checks), §2.1.2 (Guard), §2.1.3 (the
//! degenerate-optimum audit, property-tested in `economy_tests.rs`).
//!
//! A unit-turn starts with `ap_turn` AP and no carry-over. Every entry is costed from
//! [`TacticsTuning`] — nothing here hard-codes a number — and [`spend`] refuses (never clamps) an
//! entry the budget cannot pay. Exert makes every attack after the first cost `+exert_surcharge`,
//! which is what keeps Heavy + Light (8) and Heavy + Heavy (10) out of a 6-AP turn; two stationary
//! Lights (2 + 4 = 6) are the only double attack.
//!
//! Guard replaces AP banking: a unit that ends its turn by player commitment without attacking,
//! with ≥ `guard_min_ap` unspent and whose last action was not Recruit or Flee takes
//! ×`guard_num/guard_den` attack damage until its next TurnStart. It never stacks (a flag), and
//! status ticks and Surge ignore it (they never call [`apply_guard`]).
//!
//! `strides` is CLIENT-controlled (bt-3's `Move{dest, strides}`), so every sum and product here is
//! u16 or saturating and the stride cap is checked before any multiplication: a hostile
//! `strides: 255` is a typed `Err`, never a trap. This module depends on `tuning` only; `resolve`
//! embeds a [`TurnBudget`] in every unit.

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

/// The per-unit-turn ledger (stored per unit; the design's `ap`, `strides_used`, `attacks`, plus
/// the last ACTION spent — `EndTurn` never updates it — for Guard's Recruit/Flee clause).
/// `Default` (all zero, no last action) is a unit that has not activated, or whose turn ended.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnBudget {
    pub ap: u8,
    pub strides_used: u8,
    pub attacks: u8,
    pub last: Option<Entry>,
}

impl TurnBudget {
    /// The budget at a unit's TurnStart: `ap_turn` AP, nothing used, no last action.
    #[must_use]
    pub fn fresh(t: &TacticsTuning) -> Self {
        TurnBudget {
            ap: t.ap_turn,
            strides_used: 0,
            attacks: 0,
            last: None,
        }
    }
}

/// Why an entry cannot be spent. Checked in declaration order by [`spend`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EconomyError {
    /// A Move of zero strides is not an entry.
    ZeroStrides,
    /// `strides_used + requested` exceeds `max_strides_per_turn` (checked before any cost math).
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
        match self {
            TurnEndCause::EndTurn | TurnEndCause::PreQueuedDrain | TurnEndCause::AiEnd => true,
            TurnEndCause::AutoPass => false,
        }
    }
}

/// The AP an entry costs against `budget` (Exert reads `budget.attacks`). u16 math, saturating
/// into the u8 result.
#[must_use]
pub fn cost(entry: Entry, budget: &TurnBudget, t: &TacticsTuning) -> u8 {
    let exert = if budget.attacks >= 1 {
        u16::from(t.exert_surcharge)
    } else {
        0
    };
    let total: u16 = match entry {
        Entry::Move { strides, taxed } => {
            let tax = if taxed { u16::from(t.disengage_tax) } else { 0 };
            u16::from(strides) * u16::from(t.move_stride_cost) + tax
        }
        Entry::Attack(Tier::Light) => u16::from(t.light_cost) + exert,
        Entry::Attack(Tier::Heavy) => u16::from(t.heavy_cost) + exert,
        Entry::Item => u16::from(t.item_cost),
        Entry::Recruit => u16::from(t.recruit_cost),
        Entry::Flee => u16::from(t.flee_cost),
        Entry::EndTurn => u16::from(t.end_turn_cost),
    };
    u8::try_from(total).unwrap_or(u8::MAX)
}

/// Spend `entry` from `budget`, returning the AP charged. Checks, first failure wins:
/// `Move { strides: 0 }` → `ZeroStrides`; stride cap → `StrideCap`; Recruit/Flee without the
/// full budget → `NeedsFullBudget`; `cost > ap` → `Unaffordable`. On `Err` the budget is
/// untouched. On `Ok` it subtracts the cost, adds the strides, counts an attack, and records the
/// entry as `last` unless it is `EndTurn`.
///
/// # Errors
/// See [`EconomyError`].
pub fn spend(budget: &mut TurnBudget, entry: Entry, t: &TacticsTuning) -> Result<u8, EconomyError> {
    if let Entry::Move { strides, .. } = entry {
        if strides == 0 {
            return Err(EconomyError::ZeroStrides);
        }
        let used = budget.strides_used;
        if u16::from(used) + u16::from(strides) > u16::from(t.max_strides_per_turn) {
            return Err(EconomyError::StrideCap {
                used,
                requested: strides,
                cap: t.max_strides_per_turn,
            });
        }
    }
    if matches!(entry, Entry::Recruit | Entry::Flee) && budget.ap != t.ap_turn {
        return Err(EconomyError::NeedsFullBudget {
            ap: budget.ap,
            required: t.ap_turn,
        });
    }
    let charged = cost(entry, budget, t);
    if charged > budget.ap {
        return Err(EconomyError::Unaffordable {
            cost: charged,
            ap: budget.ap,
        });
    }
    budget.ap -= charged;
    match entry {
        Entry::Move { strides, .. } => {
            budget.strides_used = budget.strides_used.saturating_add(strides);
        }
        Entry::Attack(_) => budget.attacks = budget.attacks.saturating_add(1),
        Entry::Item | Entry::Recruit | Entry::Flee | Entry::EndTurn => {}
    }
    if entry != Entry::EndTurn {
        budget.last = Some(entry);
    }
    Ok(charged)
}

/// The total cost of `entries` spent in order from `start` (a fresh budget for a pre-queue, the
/// current one for a live submit — the submit gate's costing and the §2.1.3 audit's oracle).
///
/// # Errors
/// The first entry that cannot be spent.
pub fn plan_cost(
    start: &TurnBudget,
    entries: &[Entry],
    t: &TacticsTuning,
) -> Result<u8, EconomyError> {
    let mut budget = *start;
    let mut total: u16 = 0;
    for entry in entries {
        total += u16::from(spend(&mut budget, *entry, t)?);
    }
    Ok(u8::try_from(total).unwrap_or(u8::MAX))
}

/// Design §2.1.2: Guard iff the end was committed AND no attack executed AND
/// `ap ≥ guard_min_ap` AND `budget.last` is not Recruit or Flee.
#[must_use]
pub fn guard_granted(cause: TurnEndCause, budget: &TurnBudget, t: &TacticsTuning) -> bool {
    cause.committed()
        && budget.attacks == 0
        && budget.ap >= t.guard_min_ap
        && !matches!(budget.last, Some(Entry::Recruit | Entry::Flee))
}

/// Guard on incoming ATTACK damage: `damage × guard_num / guard_den`, floor, min 1 — except
/// that 0 damage (an immune hit) stays 0. Status ticks and Surge never call this. Precondition:
/// `t.validate()` passed (`guard_den ≥ 1`).
#[must_use]
pub fn apply_guard(damage: u16, t: &TacticsTuning) -> u16 {
    if damage == 0 {
        return 0;
    }
    let scaled = u32::from(damage) * u32::from(t.guard_num) / u32::from(t.guard_den);
    u16::try_from(scaled.max(1)).unwrap_or(u16::MAX)
}

/// Flank on attack damage: `damage × flank_num / flank_den`, floor (saturating at `u16::MAX`).
/// Precondition: `t.validate()` passed (`flank_den ≥ 1`).
#[must_use]
pub fn apply_flank(damage: u16, t: &TacticsTuning) -> u16 {
    let scaled = u32::from(damage) * u32::from(t.flank_num) / u32::from(t.flank_den);
    u16::try_from(scaled).unwrap_or(u16::MAX)
}
