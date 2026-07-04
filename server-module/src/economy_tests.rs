//! `economy_tests` — M13a gating tests for the server-module economy submodule
//! (server-module/src/economy.rs, ADR-0081).
//!
//! Declared from `economy.rs` as:
//!   `#[cfg(test)] #[path = "economy_tests.rs"] mod economy_tests;`
//! so `super` resolves to the `economy` module.
//!
//! These tests do NOT require a live `ReducerContext`. They test:
//!   1. Accessibility — the helper functions and the MAX_BALANCE constant from
//!      game_core::currency are reachable from the server module (compilation test).
//!   2. Privacy invariant — the `player_wallet` table definition does NOT carry
//!      the `public` attribute (structural source inspection).
//!   3. Economy source surface — `economy.rs` contains no direct `.balance +=`
//!      or `.balance -=` (single-surface discipline, ADR-0081).
//!   4. Zero-grant guard — `grant_currency` source contains the `if amount == 0`
//!      guard so a zero-amount call never inserts a phantom wallet row.
//!
//! Note on ctx-dependent tests: `grant_currency` and `spend_currency` require a
//! `ReducerContext` (live SpacetimeDB instance). Those are covered by the
//! `currency-integrity.eval.mjs` eval (not a unit test). The structural tests
//! here are all we can assert without spinning up a DB.
//!
//! RED state: tests 3 and 4 reference source files that will exist once the
//! implementer creates them, but the structural assertions will fail until the
//! implementation is complete and correct. Test 1 compiles against the stubs.
//! Test 2 fails until the schema stub is corrected to match the spec.

// `super::*` pulls in grant_currency, spend_currency from economy.rs (stubs),
// and the use declarations there pull in apply_grant/apply_spend for compilation.
use super::*;
use game_core::currency::MAX_BALANCE;

// ---------------------------------------------------------------------------
// Test 1: Accessibility — MAX_BALANCE from game_core::currency is reachable
// ---------------------------------------------------------------------------

/// M13a: the MAX_BALANCE constant from game_core::currency is accessible from
/// the server module (compilation test — if game_core::currency is not declared
/// as `pub mod currency` in game_core/src/lib.rs this test will not compile).
///
/// Also asserts the documented value (9 digits, UI-legible per ADR-0081).
///
/// kills: a MAX_BALANCE declared as a local constant in server-module, diverged
///        from the game-core SSOT (two sources of truth for the cap).
#[test]
fn max_balance_is_accessible_and_has_correct_value() {
    assert_eq!(
        MAX_BALANCE, 999_999_999,
        "MAX_BALANCE must be 999_999_999 (9-digit UI cap, ADR-0081)"
    );
}

// ---------------------------------------------------------------------------
// Test 2: Privacy invariant — player_wallet table must NOT be `public`
// ---------------------------------------------------------------------------

/// Include schema.rs for structural inspection.
const SCHEMA_SOURCE: &str = include_str!("schema.rs");

/// M13a (ADR-0015 privacy invariant): the `player_wallet` table must be
/// declared WITHOUT the `public` attribute. Balance data must-never-leak to
/// non-owner clients.
///
/// kills: an impl that adds `public` to player_wallet (either accidentally via
///        copy-paste from inventory, or intentionally as a "convenience").
///
/// Pattern: we search for the player_wallet table macro and assert there is no
/// `public` on that specific table. We search for `name = player_wallet, public`
/// (the pattern SpacetimeDB uses for public tables) and assert it is ABSENT.
#[test]
fn player_wallet_table_is_not_public() {
    // The private pattern (correct): `#[spacetimedb::table(name = player_wallet)]`
    // The forbidden pattern: `#[spacetimedb::table(name = player_wallet, public)]`
    // We assemble from parts to avoid this test file matching itself if ever
    // included in a source scan.
    let public_pattern = ["name = player_wallet", ", public"].concat();
    assert!(
        !SCHEMA_SOURCE.contains(public_pattern.as_str()),
        "TEETH(ADR-0015): player_wallet table MUST NOT have `public` attribute — \
         wallet balances must never be broadcast to non-owner clients. \
         Found `{}` in schema.rs. Remove the `public` attribute.",
        public_pattern
    );

    // Also assert the table itself IS declared (so a missing table doesn't pass).
    let table_declaration = ["name = player_wallet"].concat();
    assert!(
        SCHEMA_SOURCE.contains(table_declaration.as_str()),
        "player_wallet table must be declared in schema.rs; found nothing matching \
         `{}`. The implementer must add the PlayerWallet table.",
        table_declaration
    );
}

// ---------------------------------------------------------------------------
// Test 3: Single-surface discipline — no direct balance mutations in economy.rs
// ---------------------------------------------------------------------------

/// Include economy.rs for structural inspection.
const ECONOMY_SOURCE: &str = include_str!("economy.rs");

/// M13a (ADR-0081 single-surface discipline): `economy.rs` must NOT contain
/// `.balance +=` or `.balance -=` operators. All balance mutations must route
/// through `apply_grant` / `apply_spend` from game_core::currency.
///
/// kills: an implementer who short-circuits the pure layer and writes
///        `row.balance += amount;` directly (bypasses the cap and the checked
///        arithmetic invariants).
#[test]
fn economy_has_no_direct_balance_mutations() {
    // Assemble the patterns from parts so this test file's own source text
    // does not self-match if it is ever included in a source scan.
    let add_assign = [".balance", " +="].concat();
    let sub_assign = [".balance", " -="].concat();

    assert!(
        !ECONOMY_SOURCE.contains(add_assign.as_str()),
        "TEETH(ADR-0081): economy.rs must not contain `{}` — all balance credits \
         must route through apply_grant (game_core::currency SSOT). \
         Found direct mutation: replace with apply_grant.",
        add_assign
    );
    assert!(
        !ECONOMY_SOURCE.contains(sub_assign.as_str()),
        "TEETH(ADR-0081): economy.rs must not contain `{}` — all balance debits \
         must route through apply_spend (game_core::currency SSOT). \
         Found direct mutation: replace with apply_spend.",
        sub_assign
    );
}

// ---------------------------------------------------------------------------
// Test 4: Zero-grant guard — grant_currency must contain the early-return guard
// ---------------------------------------------------------------------------

/// M13a: `grant_currency` must contain an `if amount == 0` guard that returns
/// early, preventing insertion of a phantom wallet row for a zero-amount grant.
///
/// kills: an impl that delegates to `apply_grant` (which returns balance unchanged)
///        but still performs a DB upsert for 0-amount calls, leaving phantom rows.
///
/// Structural test: we search for the guard pattern inside the `grant_currency`
/// function body. We look for `amount == 0` in the economy source.
///
/// Note: the exact guard form may vary (`if amount == 0 { return; }` vs
/// `if amount == 0 { return Ok(()); }`), so we check for the condition text only.
#[test]
fn grant_currency_has_zero_amount_guard() {
    // Assemble from parts to avoid false self-match in source scans.
    let guard_pattern = ["amount", " == 0"].concat();
    let fn_marker = ["fn grant", "_currency"].concat();

    // The guard must appear AFTER the `fn grant_currency` declaration — i.e., inside
    // the grant_currency body — not merely elsewhere in the file (e.g., spend_currency).
    let fn_pos = ECONOMY_SOURCE
        .find(fn_marker.as_str())
        .expect("TEETH: fn grant_currency not found in economy.rs");
    let after_fn = &ECONOMY_SOURCE[fn_pos..];
    assert!(
        after_fn.contains(guard_pattern.as_str()),
        "TEETH(ADR-0081 §zero-grant): grant_currency must contain an `{}` guard \
         to prevent inserting phantom wallet rows on 0-amount grants. \
         Add: `if amount == 0 {{ return; }}` at the top of grant_currency.",
        guard_pattern
    );
}

// ---------------------------------------------------------------------------
// Test 5: Zero-spend guard — spend_currency must contain the early-return guard
// ---------------------------------------------------------------------------

/// M13a: `spend_currency` must contain an `if amount == 0` guard that returns
/// `Ok(())` early, preventing a DB round-trip (find + update) on zero-amount spends.
///
/// ADR-0081 states: "with `amount == 0` is also a no-op (returns `Ok(())`);
/// a zero-amount call on either direction never touches the DB."
///
/// kills: an impl that calls `apply_spend(balance, 0)` (which returns `Ok(balance)`)
///        but still reads and writes the row (wasted DB IO), or one that treats a
///        zero-amount spend as an error.
///
/// Note: structural test — we verify the guard exists inside `spend_currency`.
/// The exact form (`if amount == 0 { return Ok(()); }`) may vary, so we check for
/// the condition text after the `fn spend_currency` declaration.
#[test]
fn spend_currency_has_zero_amount_guard() {
    let guard_pattern = ["amount", " == 0"].concat();
    let fn_marker = ["fn spend", "_currency"].concat();

    // The guard must appear AFTER the `fn spend_currency` declaration.
    let fn_pos = ECONOMY_SOURCE
        .find(fn_marker.as_str())
        .expect("TEETH: fn spend_currency not found in economy.rs");
    let after_fn = &ECONOMY_SOURCE[fn_pos..];
    assert!(
        after_fn.contains(guard_pattern.as_str()),
        "TEETH(ADR-0081 §zero-spend): spend_currency must contain an `{}` guard \
         to prevent a wasted DB read+write on 0-amount spends. \
         Add: `if amount == 0 {{ return Ok(()); }}` at the top of spend_currency.",
        guard_pattern
    );
}
