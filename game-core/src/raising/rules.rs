//! Raising rule functions — focus-training (EV top-off → re-derive) and care
//! (bond raise). All pure and deterministic (ADR-0003 / ADR-0058): no clock,
//! no RNG, no I/O. The care cooldown time is read from `ctx.timestamp` in the
//! M9b reducer, never here.
//!
//! Both rules are **reject-not-clamp**: a maxed target stat / exhausted EV
//! budget / max bond returns `Err` so the M9b reducer rejects the action and
//! does NOT consume the food / burn the cooldown for nothing (M9 spec §3).
//! Stat derivation is **not** duplicated here — the topped-off EVs are fed back
//! through the single-source `derive_stats` (ADR-0016 derive-on-write).

use crate::monster::rules::derive_stats;
use crate::monster::types::{Bond, EVs, IVs, Level, Nature, StatBlock, StatKind};

use super::types::{CareError, FocusTrainError, FocusTrainResult};

/// Apply a focus-training food: grant `amount` EVs toward `target`, **topped off**
/// to the per-stat cap (252) AND the total-EV cap (510) — never overflowing —
/// then re-derive the monster's stats through `derive_stats`.
///
/// Returns the new `EVs` and re-derived `StatBlock` (the M9b reducer writes both
/// back). Reject-not-clamp, with precise variants (ADR-0058 §2):
/// `NoEffect` if `amount == 0`; `StatAtCap` if the target is already 252;
/// `BudgetExhausted` if the total is already 510 (target below 252).
///
/// # Errors
/// See above — `Err` whenever the application would move zero EVs.
pub fn focus_train(
    _base: &StatBlock,
    _ivs: &IVs,
    _evs: &EVs,
    _nature: &Nature,
    _level: Level,
    _target: StatKind,
    _amount: u16,
) -> Result<FocusTrainResult, FocusTrainError> {
    todo!("M9a: focus_train top-off + re-derive (ADR-0058 §2)")
}

/// Raise a monster's bond by `amount`, **saturating** at the maximum (`u8::MAX`).
///
/// Reject-not-clamp (ADR-0058 §3): `NoEffect` if `amount == 0`; `AtMaxBond` if
/// bond is already at the maximum (so the M9b reducer rejects before burning the
/// care cooldown).
///
/// # Errors
/// See above.
pub fn apply_care(_bond: Bond, _amount: u8) -> Result<Bond, CareError> {
    todo!("M9a: apply_care saturating bond raise (ADR-0058 §3)")
}
