//! M22 slice S1 — external reachability proof for the deletion contract
//! surface (spec `M22-privacy-compliance.spec.md` §4.3, §4.5, §4.7, §5, §8.1).
//!
//! `tests/*.rs` house style: each file compiles as its own independent test
//! binary against the crate as an EXTERNAL consumer would see it (see
//! `game-core/tests/rw3c_wave3_tuning.rs`, `game-core/tests/eg3_evolution_graph.rs`
//! — both import via the flat `game_core::` path only).
//!
//! Its ONLY job is to prove all six S1 symbols are reachable from OUTSIDE the
//! crate, because S2/S3/S4 will write `use game_core::TOMBSTONE_IDENTITY_BYTES;`
//! (etc.) at their own call sites. An in-crate `crate::accounts::deletion::X`
//! reference — as used inside `game-core/src/accounts/deletion_tests.rs` —
//! does NOT prove this: Rust item privacy is scoped to "defining module +
//! descendants", so a non-`pub` `use`, or a `pub(crate) mod accounts;` with
//! no root re-export, still resolves for that in-crate test module while
//! silently breaking every downstream external call site. This file is what
//! catches that specific gap; `deletion_tests.rs` cannot.
//!
//! RED-first: neither the `deletion` module nor its crate-root re-export
//! exists yet, so this binary fails to compile until the implementer adds
//! both the module AND the `lib.rs` re-exports.

// ===========================================================================
// Flat re-export path — game_core::NAME (what S2/S3/S4 will actually import)
// ===========================================================================

/// PRV1 §4.3/§4.5/§4.7/§5/§8.1: all five S1 constants must be `pub use`d at
/// the crate root, reachable via `game_core::NAME`.
///
/// kills: a `pub(crate) use` at the root (compiles for the in-crate
/// `deletion_tests` module, fails to LINK this external test binary), and a
/// bare `mod accounts;`/`pub mod accounts;` in lib.rs with no re-export
/// statement at all for these names.
///
/// Each assertion is non-vacuous (a real property of the value, never a
/// bare `let _ = ...;`), so a symbol that resolves to a degenerate/default
/// value (empty string, zero-length slice) still fails this test.
#[test]
fn root_reexport_exposes_every_s1_constant() {
    let grace: i64 = game_core::DELETION_GRACE_MS_DEFAULT;
    assert!(
        grace > 0,
        "game_core::DELETION_GRACE_MS_DEFAULT must be reachable at the crate root and positive"
    );
    assert_ne!(
        game_core::TOMBSTONE_IDENTITY_BYTES,
        [0u8; 32],
        "game_core::TOMBSTONE_IDENTITY_BYTES must be reachable at the crate root and non-zero"
    );
    assert!(
        !game_core::TOMBSTONE_AUTH_ISSUER.trim().is_empty(),
        "game_core::TOMBSTONE_AUTH_ISSUER must be reachable at the crate root and non-blank"
    );
    let chunk_rows: u32 = game_core::EXPORT_CHUNK_ROWS;
    assert!(
        chunk_rows > 0,
        "game_core::EXPORT_CHUNK_ROWS must be reachable at the crate root and non-zero"
    );
    assert_eq!(
        game_core::STATE_TRANSITION_OWNERS.len(),
        3,
        "game_core::STATE_TRANSITION_OWNERS must be reachable at the crate root with exactly \
         3 entries"
    );
}

/// PRV1 §4.3: `is_deletion_due` must be a `pub use`d function at the crate
/// root, callable by the flat `game_core::is_deletion_due` path — not merely
/// reachable via a deep module path.
///
/// kills: an `is_deletion_due` that exists only inside
/// `accounts::deletion` with no root re-export (every downstream
/// `use game_core::is_deletion_due;` call site S2/S3/S4 need would fail to
/// compile).
#[test]
fn root_reexport_exposes_is_deletion_due() {
    let t: i64 = 1_000_000;
    assert!(
        !game_core::is_deletion_due(Some(t), t),
        "game_core::is_deletion_due(Some(t), t) must be false at the request instant"
    );
    assert!(
        game_core::is_deletion_due(Some(t), t + game_core::DELETION_GRACE_MS_DEFAULT),
        "game_core::is_deletion_due must be true once the grace window has fully elapsed"
    );
}

// ===========================================================================
// Deep module path — game_core::accounts::deletion::NAME (also pinned)
// ===========================================================================

/// PRV1 §4.3/§4.5: the DEEP module path
/// `game_core::accounts::deletion::NAME` must ALSO resolve for downstream
/// slices that prefer the fully-qualified form, so both the flat and the
/// deep path are pinned as contract, not just whichever one
/// `root_reexport_exposes_*` happens to exercise.
///
/// kills: an `accounts` module declared `pub(crate) mod accounts;` (only an
/// eventual flat re-export, if any, would be externally visible — this call
/// site would fail to compile even if the flat-path tests above pass), and a
/// `deletion` module declared non-`pub` inside `accounts/mod.rs`.
#[test]
fn deep_module_path_also_resolves_for_downstream_slices() {
    assert_eq!(
        game_core::accounts::deletion::TOMBSTONE_IDENTITY_BYTES,
        [0xFFu8; 32],
        "TOMBSTONE_IDENTITY_BYTES must resolve via the deep module path \
         game_core::accounts::deletion::TOMBSTONE_IDENTITY_BYTES and be pinned to all-0xFF"
    );
    assert!(
        !game_core::accounts::deletion::is_deletion_due(None, i64::MAX),
        "is_deletion_due must resolve via the deep module path \
         game_core::accounts::deletion::is_deletion_due and correctly return false for None"
    );
}
