//! M22 privacy and data-lifecycle module — the owning module for `export_bundle`
//! writes (spec M22 §7.2 assigns S4's export machinery here; G5/D0 module-write
//! isolation bans those writes in `accounts.rs`).
//!
//! rb-22 (ADR-0220) creates this module ahead of S4 to close the guest-export
//! orphan: pre-claim `export_bundle` chunks must not survive under a retired
//! guest identity after `complete_guest_claim` — the S3 deletion cascade keys on
//! a live account's own identity and structurally cannot reach them, and S4's
//! 7-day TTL reaper is an independent expiry, not a reachability guarantee.
//!
//! SCAN HYGIENE (gate-enforced by `privacy_tests.rs`, which scans this file AND
//! itself): line comments only — never a block comment or a path glob spelling
//! that contains one; no raw strings; no logging or print macros (the reducer
//! that calls a helper here owns any logging); no escaped or char-literal double
//! quote. A dozen evals concatenate every source file in this crate, test files
//! included, and strip comments naively — one unpaired opener here silently
//! blanks later modules from their view.

use crate::schema::export_bundle;
use spacetimedb::{Identity, ReducerContext};

/// Delete every `export_bundle` chunk owned by `owner` (collect the PKs via the
/// `owner_identity` btree index, then delete each by PK — the ADR-0126 idiom,
/// mirroring `disarm_claim_reaper`).
///
/// OWNER-GENERIC on purpose: `complete_guest_claim` passes the RETIRED GUEST
/// identity (rb-22), and the M22-S3 account-deletion cascade reuses the same
/// helper verbatim for the deleting account's own chunks (`export_bundle` is
/// `Erase`-policy in `DATA_LIFECYCLE_MANIFEST`). The body is a frozen contract:
/// `privacy_tests.rs` pins it byte-exactly in squashed form, so ANY reshaping —
/// a conditional, an extra binding, a second statement — is a deliberate,
/// test-visible change, never a drive-by edit.
pub(crate) fn purge_export_bundles(ctx: &ReducerContext, owner: Identity) {
    let ids: Vec<u64> = ctx
        .db
        .export_bundle()
        .owner_identity()
        .filter(owner)
        .map(|c| c.chunk_id)
        .collect();
    for id in ids {
        ctx.db.export_bundle().chunk_id().delete(id);
    }
}

#[cfg(test)]
#[path = "privacy_tests.rs"]
mod privacy_tests;
