//! Raising module — focus-training (EV top-off → re-derive) and the shared
//! cooldown-ready predicate. Pure & deterministic. The
//! critical-path start of M9 (raising); the M9b `train`/`care` reducers
//! delegate to these rules.

pub mod rules;
pub mod types;

#[cfg(test)]
pub mod rules_tests;

pub use rules::{focus_train, is_cooldown_ready, CARE_COOLDOWN_MS};
pub use types::{FocusTrainError, FocusTrainResult};
