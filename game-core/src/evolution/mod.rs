//! Evolution subsystem — eligibility resolution and species transforms (M10a-rules).
//!
//! `eligibility` holds the pure predicate layer: `resolve_evolution` (which
//! species does this monster evolve into? canonical primitive) with its passive
//! wrapper `evolves_to`, and `fusion_eligible` (may this pair be fused? —
//! self-fusion and under-invested parents rejected, ADR-0147).
//!
//! `transform` holds the constructors: `evolve` (single-species evolution, carries
//! all individuality — ADR-0019 carry rule) and `fuse` (two-parent fusion, carries
//! TAXED individuality — per-stat-max IVs, 75%-taxed bond/level/EVs, optional
//! chosen nickname — ADR-0147).
//!
//! All functions are pure and deterministic (ADR-0003): no wall-clock reads, no
//! unseeded RNG. Time and randomness are injected by the caller if ever needed.

pub mod eligibility;
pub mod transform;

#[cfg(test)]
mod m10a_gating_tests;

pub use eligibility::{
    evolves_to, fusion_eligible, resolve_evolution, FusionError, MIN_FUSION_BOND,
    MIN_FUSION_LEVEL,
};
pub use transform::{evolve, fuse};
