//! Protocol-number tests.
//!
//! Declared from `game-core/src/lib.rs` as `#[cfg(test)] mod protocol_tests;`, so
//! `super::` is the crate root.

use super::{MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION};
use std::hint::black_box;

/// The oldest client protocol the module still serves can never be newer than the
/// protocol the module speaks. Both constants pass through `black_box`, so this is a
/// runtime comparison (`clippy::assertions_on_constants` does not apply).
#[test]
fn min_client_protocol_never_exceeds_protocol_version() {
    let min_client = black_box(MIN_CLIENT_PROTOCOL);
    let protocol = black_box(PROTOCOL_VERSION);
    assert!(
        min_client <= protocol,
        "MIN_CLIENT_PROTOCOL ({min_client}) exceeds PROTOCOL_VERSION ({protocol})"
    );
}
