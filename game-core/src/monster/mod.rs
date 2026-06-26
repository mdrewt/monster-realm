//! Monster subsystem — types, stat derivation rules, and seeded rolls (M6a).
//!
//! `types` defines the value objects (IVs, EVs, Nature, Level, etc.).
//! `rules` holds the pure stat-derivation formula and XP/level functions.
//! `rolls` provides seeded RNG-based construction (deterministic, never
//! wall-clock-seeded — purity guard, ADR-0003).

pub mod rolls;
pub mod rules;
pub mod types;

pub use rolls::{roll_individuality, roll_starter};
pub use rules::{derive_stats, level_bounds, level_for_xp, xp_for_level};
pub use types::{
    Affinity, Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, StatKind, Xp,
};
