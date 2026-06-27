//! Monster subsystem — types, stat derivation rules, and seeded rolls (M6a).
//!
//! `types` defines the value objects (IVs, EVs, Nature, Level, etc.).
//! `rules` holds the pure stat-derivation formula and XP/level functions.
//! `rolls` provides seeded RNG-based construction (deterministic, never
//! wall-clock-seeded — purity guard, ADR-0003).

pub mod rolls;
pub mod rules;
pub mod types;

#[cfg(test)]
mod battle_redteam_tests;

// The M8d gating tests assert `RECRUIT_BASE_RATE <= 1000` — a `const`-only
// comparison that clippy reports as `assertions_on_constants`. That assertion is
// intentional (it documents/pins the per-mille invariant and compile-references
// the const so a missing const is a RED compile error). Allow the lint at the
// include site so the workspace `clippy -D warnings` gate passes without editing
// the gating test file itself.
#[cfg(test)]
#[allow(clippy::assertions_on_constants)]
mod m8d_gating_tests;

pub use rolls::{build_monster, roll_individuality, roll_starter};
pub use rules::{derive_stats, level_bounds, level_for_xp, xp_for_level};
pub use types::{
    Affinity, Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, StatKind, Xp,
};
