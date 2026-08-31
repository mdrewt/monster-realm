//! M22 privacy and data-lifecycle module — the owning module for `export_bundle`
//! writes (spec M22 §7.2 assigns S4's export machinery here; G5/D0 module-write
//! isolation bans those writes in `accounts.rs`).
//!
//! rb-22 (ADR-0220) creates this module ahead of S4 to close the guest-export
//! orphan: pre-claim `export_bundle` chunks must not survive under a retired
//! guest identity after `complete_guest_claim`.
