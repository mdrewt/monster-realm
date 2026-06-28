//! Raising value types — the focus-training result and the reject-not-clamp
//! error enums. Pure data: no I/O, no clock, no RNG (ADR-0003 / ADR-0058).

use crate::monster::types::{EVs, StatBlock};

/// The two fields focus-training changes on a monster: the topped-off EVs and
/// the re-derived stat block. The M9b reducer writes both back
/// (`MonsterInstance { evs, derived_stats, ..old }`) — see ADR-0058 §1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FocusTrainResult {
    pub evs: EVs,
    pub derived_stats: StatBlock,
}

/// Why a focus-training application was rejected (reject-not-clamp, ADR-0058 §2).
///
/// Closed, game-core-internal: no `serde` / `SpacetimeType` — it is never stored
/// in a table nor sent on the wire (the M9b reducer consumes the `Result` and
/// maps it to a reducer error). Not `#[non_exhaustive]`: a complete, closed set
/// of training-rejection modes we *want* the compiler to flag at every match site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusTrainError {
    /// The target stat is already at the per-stat EV cap (252) — no headroom.
    StatAtCap,
    /// The total-EV budget (510) is exhausted while the target stat is below 252.
    BudgetExhausted,
    /// The food grants nothing (`amount == 0`) — a content/contract error,
    /// checked before the cap guards (ADR-0058 §2: input-validity precedence).
    NoEffect,
}

/// Why a care application was rejected (reject-not-clamp, ADR-0058 §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CareError {
    /// Bond is already at the maximum (`u8::MAX` = 255) — no headroom.
    AtMaxBond,
    /// The care action raises bond by nothing (`amount == 0`).
    NoEffect,
}
