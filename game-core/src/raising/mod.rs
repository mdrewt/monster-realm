//! Raising module — focus-training (EV top-off → re-derive) and care (bond).
//! Pure & deterministic (ADR-0003 / ADR-0058). The critical-path start of M9
//! (raising); the M9b `train`/`care` reducers delegate to these rules.

pub mod rules;
pub mod types;

#[cfg(test)]
pub mod m9a_gating_tests;

pub use rules::{apply_care, focus_train, is_cooldown_ready, CARE_BOND_AMOUNT, CARE_COOLDOWN_MS};
pub use types::{CareError, FocusTrainError, FocusTrainResult};
