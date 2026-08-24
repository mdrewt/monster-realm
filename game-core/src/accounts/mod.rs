//! Account lifecycle module — pure, deterministic, I/O-free (M22, ADR-0031).
//!
//! Houses the rules that govern an account's privacy lifecycle: the deletion
//! grace window, the anonymization sentinels, the data-export chunk size and
//! the deletion-gate exemption list (spec `M22-privacy-compliance.spec.md`).

pub mod deletion;

#[cfg(test)]
pub mod deletion_tests;

pub use deletion::{
    is_deletion_due, DELETION_GRACE_MS_DEFAULT, EXPORT_CHUNK_ROWS, STATE_TRANSITION_OWNERS,
    TOMBSTONE_AUTH_ISSUER, TOMBSTONE_IDENTITY_BYTES,
};
