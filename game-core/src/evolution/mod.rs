//! Evolution subsystem — essence-graph eligibility + the species transform.
//!
//! `eligibility` holds the pure predicate layer: `path_satisfied` (the ONE
//! shared five-gate predicate, used by both the panel read path and the
//! reducer write path), its explanatory twin `unmet_requirement` (the
//! player-facing "which gate blocked me" message, rules-layer SSOT for both
//! the reducer rejection and the client panel), `eligible_evolution_paths`
//! (the full eligible set — never a first-match winner), and the three
//! derived-tier helpers `trust_tier_of` / `quality_time_tier_of` /
//! `nutrition_pct_of`.
//!
//! `transform` holds the constructor: `evolve` (single-species evolution,
//! carries all individuality, zeroes all 8 essence
//! pools, leaves Trust/Quality-Time untouched).
//!
//! All functions are pure and deterministic: no wall-clock reads, no
//! unseeded RNG, no floats.

pub mod eligibility;
pub mod transform;

#[cfg(test)]
mod m10a_gating_tests;

pub use eligibility::{
    eligible_evolution_paths, nutrition_pct_from_ev_total, nutrition_pct_of, path_satisfied,
    quality_time_tier_of, trust_tier_of, unmet_requirement, QUALITY_TIME_TIER_TICKS,
    TRUST_BAND_PCT, TRUST_K,
};
pub use transform::evolve;
