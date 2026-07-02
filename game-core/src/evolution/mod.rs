//! Evolution subsystem — eligibility resolution and species transforms (M10a-rules).
//!
//! `eligibility` holds the pure predicate layer: given a branch list and the current
//! monster state (level, bond, optional applied item), which species does this monster
//! evolve into? `resolve_evolution` is the canonical primitive; `evolves_to` is the
//! passive convenience wrapper (no item applied).
//!
//! `transform` holds the constructors: `evolve` (single-species evolution, carries
//! all individuality — ADR-0019 carry rule) and `fuse` (two-parent fusion, produces
//! a fresh level-1 offspring with per-stat-max IVs).
//!
//! All functions are pure and deterministic (ADR-0003): no wall-clock reads, no
//! unseeded RNG. Time and randomness are injected by the caller if ever needed.

pub mod eligibility;
pub mod transform;

#[cfg(test)]
mod m10a_gating_tests;

pub use eligibility::{evolves_to, resolve_evolution};
pub use transform::{evolve, fuse};
