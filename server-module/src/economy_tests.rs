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
/// `public` on that specific table. We search for `accessor = player_wallet, public`
/// (the pattern SpacetimeDB 2.x uses for public tables) and assert it is ABSENT.
#[test]
fn player_wallet_table_is_not_public() {
    // The private pattern (correct): `#[spacetimedb::table(accessor = player_wallet)]`
    // The forbidden pattern: `#[spacetimedb::table(accessor = player_wallet, public)]`
    // We assemble from parts to avoid this test file matching itself if ever
    // included in a source scan.
    let public_pattern = ["accessor = player_wallet", ", public"].concat();
    assert!(
        !SCHEMA_SOURCE.contains(public_pattern.as_str()),
        "TEETH(ADR-0015): player_wallet table MUST NOT have `public` attribute — \
         wallet balances must never be broadcast to non-owner clients. \
         Found `{}` in schema.rs. Remove the `public` attribute.",
        public_pattern
    );

    // Also assert the table itself IS declared (so a missing table doesn't pass).
    let table_declaration = ["accessor = player_wallet"].concat();
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

// ===========================================================================
// M13b: shop reducer structural tests (EARS-BUY-1..3, EARS-SELL-1..3,
//        EARS-SEC-1/2, EARS-PRIVACY-1)
//
// These tests use include_str! to inspect economy.rs and schema.rs source.
// They compile against the existing files but assert that patterns exist which
// DO NOT YET EXIST — the tests START RED and turn green once the implementer
// adds the buy/sell reducers, shop tables, and item_row.sell_price.
//
// Pattern: each test assembles the search string from parts (["fn buy", "("])
// so this test file's own source text cannot self-match in future source scans.
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 6: buy and sell reducers exist in economy.rs
// ---------------------------------------------------------------------------

/// M13b (EARS-BUY-1 / EARS-SELL-1): economy.rs must contain both `fn buy` and
/// `fn sell` reducer bodies. This is the minimal existence gate — a missing reducer
/// causes every downstream structural test to fail with "not found" rather than
/// a misleading false-pass.
///
/// kills: an impl that adds buy/sell to a different file (not economy.rs), or
///        one that names them `do_buy`/`do_sell` instead of the canonical names.
#[test]
fn shop_reducers_exist_in_economy() {
    let buy_marker = ["fn buy", "("].concat();
    let sell_marker = ["fn sell", "("].concat();

    assert!(
        ECONOMY_SOURCE.contains(buy_marker.as_str()),
        "TEETH(M13b EARS-BUY-1): economy.rs must contain `fn buy(` — \
         the buy reducer must be defined in economy.rs (ADR-0081 single-surface discipline). \
         Add: `pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32)`"
    );
    assert!(
        ECONOMY_SOURCE.contains(sell_marker.as_str()),
        "TEETH(M13b EARS-SELL-1): economy.rs must contain `fn sell(` — \
         the sell reducer must be defined in economy.rs. \
         Add: `pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32)`"
    );
}

// ---------------------------------------------------------------------------
// Test 7: require_owner appears before spend_currency in the buy function body
// (EARS-SEC-1 for buy)
// ---------------------------------------------------------------------------

/// M13b (EARS-SEC-1): in the `buy` reducer body, `require_owner` must appear
/// BEFORE `spend_currency`. The ownership check must gate every wallet operation.
///
/// This test walks the buy function body (brace-depth delimited) and asserts
/// the byte-offset of `require_owner` is less than the byte-offset of
/// `spend_currency`.
///
/// kills: an impl that calls spend_currency before the ownership check, allowing
///        a rogue caller to drain another player's wallet without being rejected.
#[test]
fn buy_reducer_calls_require_owner_before_spend() {
    // Locate `fn buy(` (or `pub fn buy(`) in the economy source.
    let buy_fn_marker = ["fn buy", "("].concat();
    let fn_pos = match ECONOMY_SOURCE.find(buy_fn_marker.as_str()) {
        Some(p) => p,
        None => panic!(
            "TEETH(M13b EARS-SEC-1): fn buy not found in economy.rs — \
             add the buy reducer before this structural test can pass"
        ),
    };

    // Find the opening brace of the buy function body.
    let open_brace = ECONOMY_SOURCE[fn_pos..]
        .find('{')
        .map(|offset| fn_pos + offset)
        .expect("buy function body opening brace not found");

    // Walk braces to find the matching closing brace.
    let mut depth: usize = 0;
    let mut close_brace = open_brace;
    for (i, ch) in ECONOMY_SOURCE[open_brace..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_brace = open_brace + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let buy_body = &ECONOMY_SOURCE[open_brace..=close_brace];

    // require_owner must appear BEFORE spend_currency inside the buy body.
    let require_owner_pat = ["require", "_owner"].concat();
    let spend_pat = ["spend", "_currency"].concat();

    let ro_pos = buy_body.find(require_owner_pat.as_str()).expect(
        "TEETH(M13b EARS-SEC-1): require_owner not found inside the buy reducer body — \
         add `require_owner(ctx, \"buy\", ctx.sender());` as the FIRST call in buy",
    );
    let spend_pos = buy_body.find(spend_pat.as_str()).expect(
        "TEETH(M13b EARS-SEC-1): spend_currency not found inside the buy reducer body — \
         the buy reducer must call spend_currency to debit the wallet",
    );

    assert!(
        ro_pos < spend_pos,
        "TEETH(M13b EARS-SEC-1): require_owner (at offset {ro_pos}) must appear BEFORE \
         spend_currency (at offset {spend_pos}) in the buy reducer body — \
         a rogue caller who bypasses ownership can drain another player's wallet"
    );
}

// ---------------------------------------------------------------------------
// Test 8: require_owner appears before grant_currency in the sell function body
// (EARS-SEC-1 for sell)
// ---------------------------------------------------------------------------

/// M13b (EARS-SEC-1): in the `sell` reducer body, `require_owner` must appear
/// BEFORE `grant_currency`. The ownership check must gate every wallet operation.
///
/// kills: an impl that calls grant_currency before the ownership check, allowing
///        a rogue caller to credit their wallet by "selling" items they don't own.
#[test]
fn sell_reducer_calls_require_owner_before_grant() {
    let sell_fn_marker = ["fn sell", "("].concat();
    let fn_pos = match ECONOMY_SOURCE.find(sell_fn_marker.as_str()) {
        Some(p) => p,
        None => panic!(
            "TEETH(M13b EARS-SEC-1): fn sell not found in economy.rs — \
             add the sell reducer before this structural test can pass"
        ),
    };

    let open_brace = ECONOMY_SOURCE[fn_pos..]
        .find('{')
        .map(|offset| fn_pos + offset)
        .expect("sell function body opening brace not found");

    let mut depth: usize = 0;
    let mut close_brace = open_brace;
    for (i, ch) in ECONOMY_SOURCE[open_brace..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_brace = open_brace + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let sell_body = &ECONOMY_SOURCE[open_brace..=close_brace];

    let require_owner_pat = ["require", "_owner"].concat();
    let grant_pat = ["grant", "_currency"].concat();

    let ro_pos = sell_body.find(require_owner_pat.as_str()).expect(
        "TEETH(M13b EARS-SEC-1): require_owner not found inside the sell reducer body — \
         add `require_owner(ctx, \"sell\", ctx.sender());` as the FIRST call in sell",
    );
    let grant_pos = sell_body.find(grant_pat.as_str()).expect(
        "TEETH(M13b EARS-SEC-1): grant_currency not found inside the sell reducer body — \
         the sell reducer must call grant_currency after consuming items",
    );

    assert!(
        ro_pos < grant_pos,
        "TEETH(M13b EARS-SEC-1): require_owner (at offset {ro_pos}) must appear BEFORE \
         grant_currency (at offset {grant_pos}) in the sell reducer body — \
         ownership must be verified before any wallet credit"
    );
}

// ---------------------------------------------------------------------------
// Test 9: buy reducer does NOT accept a price/total parameter (EARS-SEC-2)
// ---------------------------------------------------------------------------

/// M13b (EARS-SEC-2): the `buy` reducer function signature must NOT contain a
/// `price` or `total` parameter. The server must compute the price from the
/// shop_item_row lookup — a client-provided price would allow price manipulation.
///
/// This test inspects only the signature text (from `fn buy(` up to the opening
/// brace `{`), not the full body.
///
/// kills: an impl that accepts a `price: u64` or `total: u64` parameter, allowing
///        a malicious client to submit an artificially low price for any item.
#[test]
fn buy_reducer_has_no_price_parameter() {
    let buy_fn_marker = ["fn buy", "("].concat();
    let fn_pos = match ECONOMY_SOURCE.find(buy_fn_marker.as_str()) {
        Some(p) => p,
        None => panic!(
            "TEETH(M13b EARS-SEC-2): fn buy not found in economy.rs — \
             add the buy reducer before this structural test can pass"
        ),
    };

    // Extract the signature: from `fn buy(` up to the opening `{`.
    let after_fn = &ECONOMY_SOURCE[fn_pos..];
    let brace_pos = after_fn
        .find('{')
        .expect("buy function body opening brace not found");
    let signature = &after_fn[..brace_pos];

    assert!(
        !signature.contains("price"),
        "TEETH(M13b EARS-SEC-2): buy reducer signature must NOT contain a `price` parameter — \
         the server computes price from shop_item_row (not from the caller). \
         Found `price` in signature: {:?}",
        signature
    );
    assert!(
        !signature.contains("total"),
        "TEETH(M13b EARS-SEC-2): buy reducer signature must NOT contain a `total` parameter — \
         the server computes the total as buy_price * qty server-side. \
         Found `total` in signature: {:?}",
        signature
    );
}

// ---------------------------------------------------------------------------
// Test 10: #[allow(dead_code)] removed from economy.rs
// ---------------------------------------------------------------------------

/// M13b: economy.rs must NOT contain `#[allow(dead_code)]` after the buy/sell
/// reducers are wired up. The temporary M13a allow-until-wired marker must be
/// removed once grant_currency and spend_currency are called from the reducers.
///
/// kills: an impl that adds the buy/sell reducers but forgets to remove the
///        `#[allow(dead_code)]` attrs from grant_currency/spend_currency (the
///        attributes become dead suppressions that mask real dead-code warnings
///        in future slices).
#[test]
fn dead_code_allow_removed() {
    // Assemble from parts to avoid this test file matching itself.
    let dead_code_attr = ["#[allow(dead", "_code)]"].concat();
    assert!(
        !ECONOMY_SOURCE.contains(dead_code_attr.as_str()),
        "TEETH(M13b): economy.rs must NOT contain `{}` after buy/sell are wired — \
         the temporary M13a 'allow until wired' markers must be removed once \
         grant_currency and spend_currency are called from the buy/sell reducers.",
        dead_code_attr
    );
}

// ---------------------------------------------------------------------------
// Test 11: shop_row and shop_item_row are declared public in schema.rs
// (EARS-PRIVACY-1)
// ---------------------------------------------------------------------------

/// M13b (EARS-PRIVACY-1): schema.rs must declare `shop_row` and `shop_item_row`
/// tables with the `public` attribute. Shop definitions are world-readable content
/// (players need to browse shop inventories without authentication).
///
/// This is OPPOSITE to the wallet privacy invariant (test 2): shop tables are
/// intentionally public, wallet tables are intentionally private.
///
/// kills: an impl that declares shop tables as private (no `public` keyword),
///        preventing clients from subscribing to shop data and rendering the
///        shop UI empty.
#[test]
fn shop_tables_are_public() {
    // The required pattern for a public SpacetimeDB table:
    //   #[spacetimedb::table(accessor = shop_row, public)]
    // We assemble from parts to avoid self-match in source scans.
    let shop_row_public = ["accessor = shop_row", ", public"].concat();
    let shop_item_row_public = ["accessor = shop_item_row", ", public"].concat();

    assert!(
        SCHEMA_SOURCE.contains(shop_row_public.as_str()),
        "TEETH(M13b EARS-PRIVACY-1): schema.rs must contain `{}` — \
         shop_row must be public so clients can subscribe to shop definitions. \
         Add `#[spacetimedb::table(accessor = shop_row, public)]`.",
        shop_row_public
    );
    assert!(
        SCHEMA_SOURCE.contains(shop_item_row_public.as_str()),
        "TEETH(M13b EARS-PRIVACY-1): schema.rs must contain `{}` — \
         shop_item_row must be public so clients can subscribe to shop stock. \
         Add `#[spacetimedb::table(accessor = shop_item_row, public)]`.",
        shop_item_row_public
    );
}

// ===========================================================================
// M13c: economy sinks/sources wiring structural tests (ADR-0083)
//
// These tests use include_str! to inspect raising.rs, npc.rs, and battle.rs
// source text, verifying that the three remaining economy sinks/sources are
// wired through the ADR-0081 currency helpers.
//
// Pattern (same as M13b tests 7 and 8): find `fn <name>` in the source text,
// then look for the required pattern AFTER that marker using `&source[fn_pos..]`.
// String literals are assembled from parts so this test file cannot self-match
// in future source scans.
//
// RED state: all four tests are red until the implementer:
//   - Adds `spend_currency` + `require_owner` (before spend) inside `heal_party`
//     in server-module/src/raising.rs
//   - Adds `grant_currency` inside `apply_quest_trigger` in server-module/src/npc.rs
//   - Adds `grant_currency` inside `write_back_battle_results` in server-module/src/battle.rs
// ===========================================================================

/// Include the source files for structural inspection.
/// These statics are used by M13c tests 9-12.
const RAISING_SOURCE: &str = include_str!("raising.rs");
const NPC_SOURCE: &str = include_str!("npc.rs");
const BATTLE_SOURCE: &str = include_str!("battle.rs");

// ---------------------------------------------------------------------------
// Test 12: ItemRow has sell_price field in schema.rs
// ---------------------------------------------------------------------------

/// M13b: schema.rs `ItemRow` must contain a `sell_price` field. This field is
/// needed by the sell reducer to look up the sell price server-side.
///
/// kills: an impl that adds ItemDef.sell_price to game-core but forgets to add
///        sell_price to the server-side ItemRow struct (causing a seeding gap
///        where sell_price is never persisted to the DB and always reads as 0).
#[test]
fn item_row_has_sell_price() {
    // We look for `sell_price` inside the ItemRow struct in schema.rs.
    // Strategy: find the ItemRow struct declaration and then check for the field
    // within that struct's body (brace-depth walk).
    let item_row_marker = ["struct Item", "Row"].concat();
    let fn_pos = SCHEMA_SOURCE.find(item_row_marker.as_str()).expect(
        "TEETH(M13b): ItemRow struct not found in schema.rs — \
             the struct must exist before the sell_price field can be added",
    );

    // Find the opening brace of the ItemRow struct body.
    let open_brace = SCHEMA_SOURCE[fn_pos..]
        .find('{')
        .map(|offset| fn_pos + offset)
        .expect("ItemRow struct opening brace not found");

    // Walk braces to find the matching closing brace.
    let mut depth: usize = 0;
    let mut close_brace = open_brace;
    for (i, ch) in SCHEMA_SOURCE[open_brace..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_brace = open_brace + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let item_row_body = &SCHEMA_SOURCE[open_brace..=close_brace];
    let sell_price_field = ["sell", "_price"].concat();

    assert!(
        item_row_body.contains(sell_price_field.as_str()),
        "TEETH(M13b): ItemRow struct in schema.rs must contain a `{}` field — \
         the sell reducer looks up the sell price from the ItemRow, not from game-core directly. \
         Add: `pub sell_price: u64,` to ItemRow.",
        sell_price_field
    );
}

// ===========================================================================
// M13c tests 13-16: economy sinks/sources wiring
// (labeled 13-16 to follow the existing M13a/M13b numbering in this file)
// ===========================================================================

// ---------------------------------------------------------------------------
// M13c Test 13: heal_party calls spend_currency
// (EARS-HEAL-1: heal costs are deducted before healing)
// ---------------------------------------------------------------------------

/// M13c (EARS-HEAL-1): `raising.rs` must contain `spend_currency` after the
/// `fn heal_party` declaration — the heal reducer must deduct a currency cost
/// from the player's wallet before healing (ADR-0083).
///
/// TEETH: if `spend_currency` is removed from `heal_party`, this test fails
/// with "spend_currency not found inside the heal_party body". A heal-for-free
/// impl that skips the deduction entirely is caught here.
#[test]
fn heal_party_calls_spend_currency() {
    let fn_marker = ["fn heal", "_party"].concat();
    let fn_pos = RAISING_SOURCE.find(fn_marker.as_str()).expect(
        "TEETH(M13c EARS-HEAL-1): fn heal_party not found in raising.rs — \
             the heal_party reducer must exist in raising.rs",
    );

    let after_fn = &RAISING_SOURCE[fn_pos..];
    let spend_pat = ["spend", "_currency"].concat();

    assert!(
        after_fn.contains(spend_pat.as_str()),
        "TEETH(M13c EARS-HEAL-1): `{}` not found in raising.rs after `fn heal_party` — \
         heal_party must call spend_currency to deduct the heal cost from the player's wallet \
         (ADR-0083). Add: `spend_currency(ctx, me, loc.cost_currency)?;` inside heal_party.",
        spend_pat
    );
}

// ---------------------------------------------------------------------------
// M13c Test 14: require_owner appears before spend_currency in heal_party
// (EARS-HEAL-SEC-1: ownership check gates every wallet spend)
// ---------------------------------------------------------------------------

/// M13c (EARS-HEAL-SEC-1): inside `heal_party`, `require_owner` must appear
/// BEFORE `spend_currency`. The ADR-0081 forward obligation for spend paths
/// mandates that ownership is verified before any wallet debit.
///
/// This test walks the heal_party function body (from `fn heal_party` to the
/// next fn declaration) and asserts the byte-offset of `require_owner` is less
/// than the byte-offset of `spend_currency`.
///
/// TEETH: swapping the order (spend first, then require_owner) makes this test
/// fail — a rogue caller could drain the wallet before the ownership check fires.
/// Also fails if either call is missing from the body.
#[test]
fn require_owner_before_spend_in_heal_party() {
    let fn_marker = ["fn heal", "_party"].concat();
    let fn_pos = RAISING_SOURCE
        .find(fn_marker.as_str())
        .expect("TEETH(M13c EARS-HEAL-SEC-1): fn heal_party not found in raising.rs");

    // Walk brace-depth from the opening `{` of heal_party to find the body.
    let after_decl = &RAISING_SOURCE[fn_pos..];
    let open_offset = after_decl
        .find('{')
        .expect("heal_party function body opening brace not found");
    let open_abs = fn_pos + open_offset;

    let mut depth: usize = 0;
    let mut close_abs = open_abs;
    for (i, ch) in RAISING_SOURCE[open_abs..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_abs = open_abs + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let body = &RAISING_SOURCE[open_abs..=close_abs];

    let require_owner_pat = ["require", "_owner"].concat();
    let spend_pat = ["spend", "_currency"].concat();

    let ro_pos = body.find(require_owner_pat.as_str()).expect(
        "TEETH(M13c EARS-HEAL-SEC-1): require_owner not found inside the heal_party body — \
         add `require_owner(ctx, \"heal_party\", ctx.sender());` before spend_currency",
    );
    let spend_pos = body.find(spend_pat.as_str()).expect(
        "TEETH(M13c EARS-HEAL-SEC-1): spend_currency not found inside the heal_party body — \
         heal_party must call spend_currency to deduct the heal cost",
    );

    assert!(
        ro_pos < spend_pos,
        "TEETH(M13c EARS-HEAL-SEC-1): require_owner (at body-offset {ro_pos}) must appear \
         BEFORE spend_currency (at body-offset {spend_pos}) in heal_party — \
         the ownership check must gate the wallet debit (ADR-0081 spend-path obligation). \
         Swapping the order allows a rogue caller to drain the wallet before rejection."
    );
}

// ---------------------------------------------------------------------------
// M13c Test 15: apply_quest_trigger calls grant_currency on quest completion
// (EARS-QUEST-REWARD-1)
// ---------------------------------------------------------------------------

/// M13c (EARS-QUEST-REWARD-1): `npc.rs` must contain `grant_currency` after the
/// `fn apply_quest_trigger` declaration — on `QuestAdvance::QuestComplete`,
/// `apply_quest_trigger` must call `grant_currency(ctx, owner, reward.currency)`
/// (ADR-0083).
///
/// TEETH: removing the `grant_currency` call from `apply_quest_trigger` means
/// quest completion never credits the player's wallet. This test fails with
/// "grant_currency not found inside the apply_quest_trigger body".
/// A quest that grants XP/items but silently drops the currency reward is caught here.
#[test]
fn apply_quest_trigger_calls_grant_currency() {
    let fn_marker = ["fn apply_quest", "_trigger"].concat();
    let fn_pos = NPC_SOURCE.find(fn_marker.as_str()).expect(
        "TEETH(M13c EARS-QUEST-REWARD-1): fn apply_quest_trigger not found in npc.rs — \
             the function must exist in npc.rs",
    );

    // Walk brace-depth to isolate the function body.
    let after_decl = &NPC_SOURCE[fn_pos..];
    let open_offset = after_decl
        .find('{')
        .expect("apply_quest_trigger function body opening brace not found");
    let open_abs = fn_pos + open_offset;

    let mut depth: usize = 0;
    let mut close_abs = open_abs;
    for (i, ch) in NPC_SOURCE[open_abs..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_abs = open_abs + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let body = &NPC_SOURCE[open_abs..=close_abs];
    let grant_pat = ["grant", "_currency"].concat();

    assert!(
        body.contains(grant_pat.as_str()),
        "TEETH(M13c EARS-QUEST-REWARD-1): `{}` not found inside the apply_quest_trigger body \
         in npc.rs — on QuestAdvance::QuestComplete, apply_quest_trigger must call \
         grant_currency(ctx, owner, reward.currency) to credit the player's wallet (ADR-0083). \
         Add: `grant_currency(ctx, owner, reward.currency);` inside the QuestComplete arm.",
        grant_pat
    );
}

// ---------------------------------------------------------------------------
// M13c Test 16: write_back_battle_results calls grant_currency on battle win
// (EARS-BATTLE-REWARD-1)
// ---------------------------------------------------------------------------

/// M13c (EARS-BATTLE-REWARD-1): `battle.rs` must contain `grant_currency` after
/// the `fn write_back_battle_results` declaration — on a win (`SideAWins`),
/// the function must call `grant_currency(ctx, battle.player_identity, reward)`
/// where `reward = game_core::battle_currency_reward(loser_bst)` (ADR-0083).
///
/// TEETH: removing the `grant_currency` call from `write_back_battle_results`
/// means battle victories never credit the player's wallet. This test fails with
/// "grant_currency not found inside the write_back_battle_results body".
/// An XP-only reward impl that silently drops the currency reward is caught here.
#[test]
fn write_back_battle_results_calls_grant_currency() {
    let fn_marker = ["fn write_back_battle", "_results"].concat();
    let fn_pos = BATTLE_SOURCE.find(fn_marker.as_str()).expect(
        "TEETH(M13c EARS-BATTLE-REWARD-1): fn write_back_battle_results not found in battle.rs — \
             the function must exist in battle.rs",
    );

    // Walk brace-depth to isolate the function body.
    let after_decl = &BATTLE_SOURCE[fn_pos..];
    let open_offset = after_decl
        .find('{')
        .expect("write_back_battle_results function body opening brace not found");
    let open_abs = fn_pos + open_offset;

    let mut depth: usize = 0;
    let mut close_abs = open_abs;
    for (i, ch) in BATTLE_SOURCE[open_abs..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_abs = open_abs + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let body = &BATTLE_SOURCE[open_abs..=close_abs];
    let grant_pat = ["grant", "_currency"].concat();

    assert!(
        body.contains(grant_pat.as_str()),
        "TEETH(M13c EARS-BATTLE-REWARD-1): `{}` not found inside the write_back_battle_results \
         body in battle.rs — on a SideAWins outcome, the function must call \
         grant_currency(ctx, battle.player_identity, reward) where reward is computed via \
         game_core::battle_currency_reward(loser_bst) (ADR-0083, once per battle win not per \
         monster). Add: `grant_currency(ctx, player, game_core::battle_currency_reward(bst));` \
         inside the SideAWins block.",
        grant_pat
    );
}

// ===========================================================================
// RT-M13C-01: heal_party require_owner is tautological (never rejects)
//
// Finding: `heal_party` calls `require_owner(ctx, "heal_party", me)` where
// `me = ctx.sender()`. Since `require_owner` checks `owner != ctx.sender()`,
// and here `owner = ctx.sender()`, this check ALWAYS returns Ok — it tests
// that the caller is themselves, not that they own any resource.
//
// This call is placed inside `if currency_cost > 0 { ... }`, meaning:
//   (a) When cost == 0 (all current content), the ownership check is skipped.
//   (b) When cost > 0, the check runs but is vacuous — always passes.
//
// The ADR-0081 "require_owner before spend" structural test passes because
// the call textually precedes `spend_currency`, but it provides zero
// authorization value. The real authorization is the player lookup at Step 1
// (`ctx.db.player().identity().find(me)`), which correctly rejects a caller
// who is not joined. The `require_owner` call inside the conditional is dead
// security theater.
//
// Repro: search for `require_owner(ctx, "heal_party", me)` in raising.rs —
// `me` is bound to `ctx.sender()` on the first line of heal_party. Calling
// `require_owner` with `ctx.sender()` as the `owner` argument always returns
// Ok(()) because `require_owner` only rejects when `owner != ctx.sender()`.
// ===========================================================================

/// RT-M13C-01: the `require_owner` call inside `heal_party`'s currency-cost
/// branch uses `me` as the owner argument, where `me = ctx.sender()`.
///
/// `require_owner(ctx, reducer, owner)` only rejects when `owner != ctx.sender()`.
/// When called as `require_owner(ctx, "heal_party", me)` with `me = ctx.sender()`,
/// the check is `ctx.sender() != ctx.sender()` which is always false — the guard
/// always returns Ok and provides no authorization protection.
///
/// This test is a permanent record of the finding. It is GREEN in the buggy
/// state (tautological call present) and turns RED when the call is removed.
/// The correct fix is to remove the `require_owner` call entirely from the
/// conditional — Step 1 of heal_party already rejects non-joined callers via
/// `ctx.db.player().identity().find(me)`.
///
/// KILLS: any refactor that silently changes the third argument of the
/// `require_owner` call to a different variable, causing the tautology to
/// gain real authorization semantics without this test noticing the change.
#[test]
fn rt_m13c_01_heal_party_require_owner_is_tautological() {
    // Locate the heal_party function body in raising.rs.
    let fn_marker = ["fn heal", "_party"].concat();
    let fn_pos = RAISING_SOURCE
        .find(fn_marker.as_str())
        .expect("RT-M13C-01: fn heal_party not found in raising.rs");

    // Walk brace-depth to isolate the function body.
    let after_decl = &RAISING_SOURCE[fn_pos..];
    let open_offset = after_decl
        .find('{')
        .expect("heal_party function body opening brace not found");
    let open_abs = fn_pos + open_offset;

    let mut depth: usize = 0;
    let mut close_abs = open_abs;
    for (i, ch) in RAISING_SOURCE[open_abs..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_abs = open_abs + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let body = &RAISING_SOURCE[open_abs..=close_abs];

    // The tautological pattern: require_owner called with `me` where `me = ctx.sender()`.
    // Built from parts to avoid self-match in source scans.
    let tautological_call = ["require_owner(ctx, \"heal_party\"", ", me)"].concat();

    assert!(
        body.contains(tautological_call.as_str()),
        "RT-M13C-01 FIXED: the tautological `require_owner(ctx, \"heal_party\", me)` call \
         is no longer present in the heal_party body. \
         If the fix was to REMOVE the redundant call (correct), delete this test. \
         If the argument was changed to something other than `me`, verify the new call \
         provides real authorization and update or remove this test accordingly.",
    );

    // Companion assertion: `me` must be bound to `ctx.sender()` in the body,
    // confirming the tautological nature of the ownership check.
    let me_binding = ["let me = ctx", ".sender"].concat();
    assert!(
        body.contains(me_binding.as_str()),
        "RT-M13C-01: `let me = ctx.sender()` not found in heal_party body — \
         the variable `me` used in require_owner must be bound to ctx.sender() \
         for this finding to apply. Re-evaluate whether require_owner is tautological.",
    );
}

// ===========================================================================
// m17.5c: shop headroom ordering pins (ADR-0124)
//
// These tests verify that the shop `buy` and `sell` reducers in economy.rs
// call the new headroom primitives BEFORE the irreversible wallet/inventory
// operations (spend_currency / consume_one).  Without the headroom check
// before the spend, a buyer can exceed MAX_ITEM_STACK and lose both currency
// and items.  On the sell side (grant_currency is infallible), a missing
// headroom check before consume_one DESTROYS items for clamped proceeds with
// no rollback backstop.
//
// Pattern:
//   1. Strip comments then string literals from ECONOMY_SOURCE (in that order,
//      mirroring RT-SEC-02b in trading_tests.rs).
//   2. Brace-depth body extraction on the stripped source.
//   3. Paren-anchored split-literal needles (`check_item_headroom(` with the
//      open paren — prevents substring-prefix bypass, red-team F3).
//   4. Provenance pins: for buy, require `inventory(` BEFORE headroom; for sell,
//      require `wallet_balance` BEFORE headroom (red-team F1/F2).
//   5. cfg-forbidden: assert the body contains neither `cfg!(` nor `#[cfg` —
//      shop reducer guards must never be conditionally compiled (red-team F4).
//   6. Statement-window slice (needle → first ';'): check `?` + argument pin.
//
// String-stripping note: strips comments first, then string literal contents.
// This makes brace-depth extraction robust against format-string braces (e.g.
// `format!("{shop_id}")`) and prevents a planted literal like
// `let _hint = "check_item_headroom(...)";` from satisfying the needle search.
//
// Mirrors RT-SEC-02b from trading_tests.rs (credited below).
//
// RED state: both tests are red until the implementer wires check_item_headroom
// and check_currency_headroom into buy and sell respectively (m17.5c Task 4).
// ===========================================================================

/// Comment-stripping helper for economy.rs source scans.
/// Removes `/* … */` block comments and `//` line comments, replacing removed
/// bytes with spaces to preserve byte offsets.
/// Mirrors trading_tests.rs::strip_rust_comments_trading.
fn strip_rust_comments_economy(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            // Block comment: scan for `*/`.
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2; // consume the closing `*/`
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            // Line comment: scan to end of line.
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("comment-stripped source must be valid UTF-8")
}

/// String-literal stripping helper for economy.rs source scans (red-team F5).
/// Replaces the CONTENT of every `"…"` string literal (including escape sequences)
/// with empty bytes, so a planted literal like
/// `let _hint = "check_item_headroom(...)?;";`
/// cannot satisfy needle searches on the stripped source.
///
/// IMPORTANT: call AFTER strip_rust_comments_economy so that string literals
/// inside comments (already blanked) do not confuse the byte walker.
///
/// NOTE: raw strings (`r#"…"#`) are not handled — acceptable because production
/// economy.rs contains none, and comment-strip runs first.
///
/// Credits: mirrors RT-SEC-02b (trading_tests.rs::strip_rust_strings_trading,
/// m16.5d/m16.5e, ADR-0116).
fn strip_rust_strings_economy(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        if bytes[i] == b'"' {
            // Emit the opening quote, then skip until the closing (unescaped) quote.
            out.push(b'"');
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    // Skip escape sequence (consume both backslash and the next char).
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b'"');
                    i += 1;
                    break;
                } else {
                    // Swallow the character (replace with nothing — shrinks the string).
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

// ---------------------------------------------------------------------------
// m17.5c Test 17: check_item_headroom( called and propagated before
// spend_currency in the buy reducer (EARS 17.5c-1)
// ---------------------------------------------------------------------------

/// m17.5c (EARS 17.5c-1): in the `buy` reducer body (after comment+string
/// stripping), `check_item_headroom(` (paren-anchored, F3) must appear BEFORE
/// `spend_currency(`, the call must propagate its Result with `?`, must pass
/// `item_id` as an argument, and must be preceded by `inventory(` and
/// `unwrap_or(0)` (provenance pins, F1/F2).  Additionally, the body must
/// contain neither `cfg!(` nor `#[cfg` (cfg-forbidden, F4).
///
/// Without this guard, buy calls spend_currency then infallible grant_item —
/// at MAX_ITEM_STACK the grant is silently dropped (inventory.rs monotone clamp)
/// while the player has already paid.  The headroom check must reject BEFORE
/// the irreversible spend (reject-not-destroy, ADR-0113 propagated to shop).
///
/// kills: impl that calls spend_currency before check_item_headroom;
///        impl that discards the headroom Result with `let _ = ...`;
///        impl that passes a hardcoded 0 as first argument and no inventory() read
///          (F1/F2 provenance bypass — hardcoded-zero voids the invariant);
///        impl that hides the headroom call inside a string literal (F5);
///        impl that cfg-gates the check so it is test-only (F4).
#[test]
fn buy_reducer_calls_headroom_before_spend() {
    // Strip comments then string literals from ECONOMY_SOURCE before all searches.
    // Order: comments first (so strings inside comments are blanked safely), then
    // string contents (so planted string literals cannot satisfy needle searches).
    let economy_stripped = strip_rust_strings_economy(&strip_rust_comments_economy(ECONOMY_SOURCE));

    // Locate `fn buy(` in the stripped source using split-literal (W-3: avoids
    // self-match if economy_tests.rs is ever scanned alongside economy.rs).
    let buy_fn_marker = ["fn buy", "("].concat();
    let fn_pos = match economy_stripped.find(buy_fn_marker.as_str()) {
        Some(p) => p,
        None => panic!(
            "TEETH(m17.5c EARS-17.5c-1): fn buy not found in economy.rs — \
             add the buy reducer before this structural test can pass"
        ),
    };

    // Find the opening brace of the buy function body on the stripped source.
    let open_brace = economy_stripped[fn_pos..]
        .find('{')
        .map(|offset| fn_pos + offset)
        .expect("buy function body opening brace not found");

    // Brace-depth walk to find the matching close brace.
    // Stripping format-string braces (e.g. `format!("{item_id}")`) makes this robust.
    let mut depth: usize = 0;
    let mut close_brace = open_brace;
    for (i, ch) in economy_stripped[open_brace..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_brace = open_brace + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let buy_body = &economy_stripped[open_brace..=close_brace];

    // --- cfg-forbidden (red-team F4) ---
    // Shop reducer guards must never be conditionally compiled.
    // `if cfg!(test) { check_item_headroom(...)?; }` makes the guard test-only
    // and the release build silently skips the cap check.
    let cfg_attr_pat = ["#[", "cfg"].concat();
    let cfg_macro_pat = ["cfg", "!("].concat();
    assert!(
        !buy_body.contains(cfg_attr_pat.as_str()),
        "TEETH(m17.5c F4 CFG-FORBIDDEN): buy reducer body contains `#[cfg` — \
         shop reducer guards must NEVER be conditionally compiled; \
         a cfg-gated check_item_headroom is skipped in release builds, \
         allowing value destruction at MAX_ITEM_STACK (ADR-0124)"
    );
    assert!(
        !buy_body.contains(cfg_macro_pat.as_str()),
        "TEETH(m17.5c F4 CFG-FORBIDDEN): buy reducer body contains `cfg!(` — \
         shop reducer guards must NEVER be conditionally compiled; \
         a cfg-gated check_item_headroom is skipped in release builds (ADR-0124)"
    );

    // --- Paren-anchored split-literal needles (W-3 + red-team F3) ---
    // Include the open paren so `check_item_headroom_always_ok(` (a differently-named
    // function with the needle as a prefix substring) does not satisfy this search.
    let headroom_pat = ["check", "_item_headroom("].concat();
    let spend_pat = ["spend", "_currency("].concat();
    // Provenance needle: `inventory(` — the DB accessor that reads the current stack.
    // Split at the boundary to avoid self-match on column comments.
    let inventory_pat = ["inven", "tory()"].concat();
    // Provenance needle: `unwrap_or(0)` — the default for a missing inventory row.
    // These two together prove the real current_count is read, not a hardcoded 0.
    let unwrap_or_pat = ["unwrap", "_or(0)"].concat();
    // Existing W-3 needles also paren-anchored (reviewer MINOR-3/4):
    let consume_pat = ["consume", "_one("].concat();
    let checked_mul_pat = ["checked", "_mul("].concat();

    // --- Provenance pins (red-team F1/F2): inventory() and unwrap_or(0) before headroom ---
    // Without these pins, an impl can pass 0 as `current_count` (hardcoded zero),
    // voiding the invariant: check_item_headroom(0, qty, item_id) always succeeds
    // even when the player already has MAX_ITEM_STACK items.
    let inventory_pos = buy_body.find(inventory_pat.as_str()).expect(
        "TEETH(m17.5c F1 PROVENANCE-BUY-INVENTORY): `inventory()` not found in buy body — \
         the current item count must be read from `ctx.db.inventory()` before calling \
         check_item_headroom; without this read, an impl can hardcode 0 as current_count, \
         making check_item_headroom always succeed even at MAX_ITEM_STACK (ADR-0124)",
    );
    let unwrap_or_pos = buy_body.find(unwrap_or_pat.as_str()).expect(
        "TEETH(m17.5c F2 PROVENANCE-BUY-UNWRAP): `unwrap_or(0)` not found in buy body — \
         a missing inventory row (new receiver) must default to 0 via `.unwrap_or(0)` before \
         check_item_headroom; without this, an impl can hardcode 0 directly as current_count \
         (both bypass the real read — a hardcoded 0 always passes the cap check, ADR-0124)",
    );

    let headroom_pos = buy_body.find(headroom_pat.as_str()).expect(
        "TEETH(m17.5c EARS-17.5c-1): check_item_headroom( not found in the buy reducer body — \
         add `check_item_headroom(current, qty, item_id).map_err(|e| e.to_string())?;` \
         BEFORE spend_currency in buy (ADR-0124: reject-not-destroy at receiver cap). \
         Note: paren-anchored needle `check_item_headroom(` — a differently-named function \
         with this as a prefix does NOT satisfy this requirement (red-team F3)",
    );

    // Lookup-filter pin (mutation 156:29 killer): the inventory read feeding the
    // headroom check must filter on the PURCHASED item — `r.item_id == item_id`
    // must appear between the inventory() read and the headroom call. Under the
    // `==`→`!=` cargo-mutants mutation this needle disappears from the mutated
    // source (include_str! sees the mutant), flipping this gate RED — keeping the
    // mutate-server missed count at the ADR-0118 baseline (no net-new survivors).
    let lookup_filter_pat = ["r.item", "_id == item", "_id"].concat();
    let lookup_window = &buy_body[inventory_pos..headroom_pos];
    assert!(
        lookup_window.contains(lookup_filter_pat.as_str()),
        "TEETH(m17.5c LOOKUP-FILTER-BUY): `r.item_id == item_id` not found between the \
         inventory() read and the check_item_headroom( call in buy — the current-count \
         lookup must select the stack for the item being purchased; a wrong-item filter \
         (e.g. `!=`, or matching shop_id) reads an unrelated count and voids the cap \
         check (ADR-0124)"
    );

    // Assert provenance pins precede the headroom call.
    assert!(
        inventory_pos < headroom_pos,
        "TEETH(m17.5c F1 PROVENANCE-BUY-INVENTORY): `inventory()` (at offset {inventory_pos}) \
         must appear BEFORE `check_item_headroom(` (at offset {headroom_pos}) in buy — \
         the current stack count must be read from the DB before the headroom call; \
         a hardcoded 0 as first arg voids the invariant (always passes, ADR-0124)"
    );
    assert!(
        unwrap_or_pos < headroom_pos,
        "TEETH(m17.5c F2 PROVENANCE-BUY-UNWRAP): `unwrap_or(0)` (at offset {unwrap_or_pos}) \
         must appear BEFORE `check_item_headroom(` (at offset {headroom_pos}) in buy — \
         the missing-row default must be applied before calling the headroom check; \
         a hardcoded 0 passed directly as current_count voids the invariant (ADR-0124)"
    );

    let spend_pos = buy_body.find(spend_pat.as_str()).expect(
        "TEETH(m17.5c EARS-17.5c-1): spend_currency( not found in the buy reducer body — \
         the buy reducer must call spend_currency to debit the wallet",
    );

    assert!(
        headroom_pos < spend_pos,
        "TEETH(m17.5c EARS-17.5c-1): check_item_headroom( (at offset {headroom_pos}) must appear \
         BEFORE spend_currency( (at offset {spend_pos}) in the buy reducer body — \
         without the headroom guard first, a buyer at MAX_ITEM_STACK pays currency \
         but the grant_item call is silently clamped (value destruction, ADR-0113/ADR-0124)"
    );

    // Verify paren-anchored consume_one( and checked_mul( appear in the body
    // (reviewer MINOR-3/4: bare needles could match comment prose in the sell body).
    // Note: these two needles exist in the sell body, not the buy body; however,
    // the brace-depth extraction isolates the buy body, so this is a guard that
    // the right body was extracted.  The buy body contains neither consume_one( nor
    // checked_mul(; their absence here is expected (buy uses grant_item, not consume_one).
    // We just verify the headroom and spend needles do NOT appear inside a comment
    // (already handled by stripping) and the body is well-formed (has a closing brace).
    assert!(
        buy_body.contains('}'),
        "TEETH(m17.5c): buy body extraction produced an unclosed body — \
         brace-depth walk may have failed (check format-string brace stripping)"
    );

    // Statement-window pin (F4/F6/F12): substring from the headroom call to the first `;`
    // after it must propagate the Result with `?` and pass the `item_id` argument.
    let after_headroom = &buy_body[headroom_pos..];
    let semi_pos = after_headroom.find(';').expect(
        "TEETH(m17.5c EARS-17.5c-1): no `;` found after check_item_headroom( in buy body — \
         the call must be a complete statement ending with `;`",
    );
    let statement_window = &after_headroom[..semi_pos + 1];

    assert!(
        statement_window.contains('?'),
        "TEETH(m17.5c EARS-17.5c-1): the check_item_headroom( statement in buy does not \
         contain `?` — the Result must be propagated (kills `let _ = check_item_headroom(...)` \
         which silently discards the error and destroys value on cap-exceeded). \
         Statement window: {:?}",
        statement_window
    );
    assert!(
        statement_window.contains("item_id"),
        "TEETH(m17.5c EARS-17.5c-1): the check_item_headroom( statement in buy does not \
         contain `item_id` — the actual item_id variable must be passed (not a hardcoded \
         sentinel), so the error payload identifies the correct item. \
         Statement window: {:?}",
        statement_window
    );

    // --- Argument-identity pin (red-team live-mutation: check_item_headroom(0, qty, item_id)) ---
    // The provenance pins above (inventory_pos < headroom_pos, unwrap_or_pos < headroom_pos)
    // prove that the real count IS read, but they do not prove it is PASSED.  An impl could
    // read `current_count` via inventory()/unwrap_or(0) and then call
    // `check_item_headroom(0, qty, item_id)` — hardcoding the first argument to 0 so the
    // check ALWAYS passes (0 + qty <= cap) even when the buyer holds MAX_ITEM_STACK items.
    // This pin anchors the variable name directly in the call, closing that bypass.
    let current_count_arg_needle = ["check", "_item_headroom(current", "_count,"].concat();
    assert!(
        buy_body.contains(current_count_arg_needle.as_str()),
        "TEETH(m17.5c ARG-IDENTITY-BUY): buy body does not contain `{}` — \
         check_item_headroom must receive `current_count` (the value read from inventory()/unwrap_or(0)) \
         as its first argument, not a hardcoded 0.  A hardcoded-0 first arg always passes the cap \
         check even at MAX_ITEM_STACK: the buyer pays currency but grant_item is silently clamped \
         (value destruction, ADR-0124).  Kills: check_item_headroom(0, qty, item_id) impl.",
        current_count_arg_needle
    );

    // Suppress unused-variable warnings for paren-anchored needles defined above
    // but not used in ordering assertions within this test.
    let _ = consume_pat;
    let _ = checked_mul_pat;
}

// ---------------------------------------------------------------------------
// m17.5c Test 18: check_currency_headroom( called and propagated before
// consume_one in the sell reducer (EARS 17.5c-2), with checked_mul before it
// ---------------------------------------------------------------------------

/// m17.5c (EARS 17.5c-2): in the `sell` reducer body (after comment+string
/// stripping), `checked_mul(` must appear BEFORE `check_currency_headroom(`,
/// which must appear BEFORE `consume_one(` (all paren-anchored, F3).
/// The headroom call must propagate its Result with `?` and pass `total` as an
/// argument, and must be preceded by `wallet_balance` (provenance pin, F1/F2).
/// The body must contain neither `cfg!(` nor `#[cfg` (cfg-forbidden, F4).
///
/// On the sell side, grant_currency is infallible — it saturates silently.
/// Without the headroom check before consume_one, the loop destroys items for
/// clamped (truncated) currency proceeds with NO rollback backstop.  This is
/// a value-DESTRUCTION path, not merely a rejection path (F4/F6/F12, ADR-0124).
///
/// Chain completeness (W-6): checked_mul must precede check_currency_headroom
/// so that `total` (the product used as the incoming argument) exists before
/// the headroom call.  Defense-in-depth: overflow is rejected first (F10).
///
/// kills: impl that calls consume_one before check_currency_headroom;
///        impl that discards the headroom Result with `let _ = ...`;
///        impl that passes a literal 0 instead of `total` (wrong argument pin);
///        impl that reads 0 as the balance without calling wallet_balance (F1/F2);
///        impl that hides the headroom call inside a string literal (F5);
///        impl that cfg-gates the check so it is test-only (F4).
#[test]
fn sell_reducer_calls_headroom_before_consume() {
    // Strip comments then string literals from ECONOMY_SOURCE.
    let economy_stripped = strip_rust_strings_economy(&strip_rust_comments_economy(ECONOMY_SOURCE));

    // Locate `fn sell(` in the stripped source using split-literal (W-3).
    let sell_fn_marker = ["fn sell", "("].concat();
    let fn_pos = match economy_stripped.find(sell_fn_marker.as_str()) {
        Some(p) => p,
        None => panic!(
            "TEETH(m17.5c EARS-17.5c-2): fn sell not found in economy.rs — \
             add the sell reducer before this structural test can pass"
        ),
    };

    // Find the opening brace of the sell function body.
    let open_brace = economy_stripped[fn_pos..]
        .find('{')
        .map(|offset| fn_pos + offset)
        .expect("sell function body opening brace not found");

    // Brace-depth walk to find the matching close brace.
    let mut depth: usize = 0;
    let mut close_brace = open_brace;
    for (i, ch) in economy_stripped[open_brace..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close_brace = open_brace + i;
                    break;
                }
            }
            _ => {}
        }
    }

    let sell_body = &economy_stripped[open_brace..=close_brace];

    // --- cfg-forbidden (red-team F4) ---
    let cfg_attr_pat = ["#[", "cfg"].concat();
    let cfg_macro_pat = ["cfg", "!("].concat();
    assert!(
        !sell_body.contains(cfg_attr_pat.as_str()),
        "TEETH(m17.5c F4 CFG-FORBIDDEN): sell reducer body contains `#[cfg` — \
         shop reducer guards must NEVER be conditionally compiled; \
         a cfg-gated check_currency_headroom is skipped in release builds, \
         allowing value destruction when the seller's wallet is at cap (ADR-0124)"
    );
    assert!(
        !sell_body.contains(cfg_macro_pat.as_str()),
        "TEETH(m17.5c F4 CFG-FORBIDDEN): sell reducer body contains `cfg!(` — \
         shop reducer guards must NEVER be conditionally compiled (ADR-0124)"
    );

    // --- Paren-anchored split-literal needles (W-3 + red-team F3) ---
    let checked_mul_pat = ["checked", "_mul("].concat();
    let headroom_pat = ["check", "_currency_headroom("].concat();
    let consume_pat = ["consume", "_one("].concat();
    // Provenance needle: wallet_balance is the sole sanctioned balance read (ADR-0081).
    // Split-literal to avoid self-match on comments referencing the function name.
    let wallet_balance_pat = ["wallet", "_balance"].concat();

    // --- Provenance pin (red-team F1/F2): wallet_balance before headroom ---
    // Without this pin, an impl can pass 0 as `balance` (hardcoded zero),
    // meaning check_currency_headroom(0, total) always succeeds even when the
    // seller's wallet is already at MAX_BALANCE, silently destroying items.
    let wallet_balance_pos = sell_body.find(wallet_balance_pat.as_str()).expect(
        "TEETH(m17.5c F1 PROVENANCE-SELL-WALLET): `wallet_balance` not found in sell body — \
         the seller's current balance must be read via wallet_balance() before calling \
         check_currency_headroom; without this read, an impl can hardcode 0 as balance, \
         making check_currency_headroom always succeed even at MAX_BALANCE (ADR-0124). \
         wallet_balance is the sole sanctioned balance read (ADR-0081)",
    );

    let checked_mul_pos = sell_body.find(checked_mul_pat.as_str()).expect(
        "TEETH(m17.5c EARS-17.5c-2): checked_mul( not found in the sell reducer body — \
         total = sell_price.checked_mul(qty as u64) must exist before check_currency_headroom \
         so that `total` is defined when the headroom call is made (W-6 chain completeness, F10). \
         Note: paren-anchored needle `checked_mul(` (red-team F3)",
    );
    let headroom_pos = sell_body.find(headroom_pat.as_str()).expect(
        "TEETH(m17.5c EARS-17.5c-2): check_currency_headroom( not found in the sell reducer body \
         — add `check_currency_headroom(balance, total).map_err(|e| e.to_string())?;` \
         BEFORE consume_one in sell (ADR-0124: reject-not-destroy, sell-side is value-DESTRUCTION \
         with no rollback backstop — grant_currency is infallible). \
         Note: paren-anchored needle `check_currency_headroom(` (red-team F3)",
    );
    let consume_pos = sell_body.find(consume_pat.as_str()).expect(
        "TEETH(m17.5c EARS-17.5c-2): consume_one( not found in the sell reducer body — \
         the sell reducer must call consume_one to remove items from the player's inventory. \
         Note: paren-anchored needle `consume_one(` (red-team F3)",
    );

    // Assert wallet_balance precedes headroom call.
    assert!(
        wallet_balance_pos < headroom_pos,
        "TEETH(m17.5c F1 PROVENANCE-SELL-WALLET): `wallet_balance` (at offset {wallet_balance_pos}) \
         must appear BEFORE `check_currency_headroom(` (at offset {headroom_pos}) in sell — \
         the current balance must be read before the headroom call; \
         a hardcoded 0 as balance voids the invariant (always passes, ADR-0124)"
    );

    // W-6 chain: checked_mul before check_currency_headroom (total must exist).
    assert!(
        checked_mul_pos < headroom_pos,
        "TEETH(m17.5c EARS-17.5c-2): checked_mul( (at offset {checked_mul_pos}) must appear \
         BEFORE check_currency_headroom( (at offset {headroom_pos}) in the sell reducer body — \
         `total` (the qty × sell_price product) must be defined before the headroom call (W-6)"
    );

    // Primary ordering: headroom before consume_one.
    assert!(
        headroom_pos < consume_pos,
        "TEETH(m17.5c EARS-17.5c-2): check_currency_headroom( (at offset {headroom_pos}) must \
         appear BEFORE consume_one( (at offset {consume_pos}) in the sell reducer body — \
         without the headroom guard first, items are destroyed by consume_one and grant_currency \
         silently clamps; there is no rollback backstop (sell-side value destruction, ADR-0124)"
    );

    // Statement-window pin (F4/F6/F12): substring from the headroom call to the first `;`
    // after it must propagate the Result with `?` and pass `total`.
    let after_headroom = &sell_body[headroom_pos..];
    let semi_pos = after_headroom.find(';').expect(
        "TEETH(m17.5c EARS-17.5c-2): no `;` found after check_currency_headroom( in sell body — \
         the call must be a complete statement ending with `;`",
    );
    let statement_window = &after_headroom[..semi_pos + 1];

    assert!(
        statement_window.contains('?'),
        "TEETH(m17.5c EARS-17.5c-2): the check_currency_headroom( statement in sell does not \
         contain `?` — the Result must be propagated (kills `let _ = check_currency_headroom(...)` \
         which silently discards the error; on the sell side this is a value-DESTRUCTION path \
         with no rollback backstop). Statement window: {:?}",
        statement_window
    );
    assert!(
        statement_window.contains("total"),
        "TEETH(m17.5c EARS-17.5c-2): the check_currency_headroom( statement in sell does not \
         contain `total` — the qty × sell_price product computed by checked_mul must be passed \
         as the `incoming` argument (not a literal 0 or other sentinel). \
         Statement window: {:?}",
        statement_window
    );

    // --- Argument-identity pin (red-team live-mutation: check_currency_headroom(0, total)) ---
    // The provenance pin above (wallet_balance_pos < headroom_pos) proves the balance IS read,
    // but does not prove it is PASSED.  An impl could call wallet_balance() for its side effects
    // and then pass a hardcoded 0 as the first argument:
    // `check_currency_headroom(0, total)` always returns Ok unless total > MAX_BALANCE alone,
    // meaning a seller whose wallet is already near MAX_BALANCE will have items destroyed by
    // the consume_one loop with only clamped (truncated) proceeds — value destruction with no
    // rollback backstop (ADR-0124).  This pin anchors the variable name in the call.
    let balance_arg_needle = ["check", "_currency_headroom(balance,"].concat();
    assert!(
        sell_body.contains(balance_arg_needle.as_str()),
        "TEETH(m17.5c ARG-IDENTITY-SELL): sell body does not contain `{}` — \
         check_currency_headroom must receive `balance` (the value from wallet_balance()) \
         as its first argument, not a hardcoded 0.  A hardcoded-0 first arg always passes unless \
         total > MAX_BALANCE, missing the case where balance is already near the cap: items are \
         destroyed by consume_one with clamped proceeds and no rollback backstop (ADR-0124). \
         Kills: check_currency_headroom(0, total) impl.",
        balance_arg_needle
    );
}

// ===========================================================================
// ux2: owner-scoped `my_wallet` view (ADR-0154) — R1 + R2
//
// `player_wallet` is PRIVATE (ADR-0015/ADR-0081) and therefore invisible to
// every client.  ux2 opens exactly ONE read path: a `#[spacetimedb::view]`
// named `my_wallet` in schema.rs that returns the SENDER'S row and nothing
// else.  The JS eval (evals/wallet-privacy.eval.mjs) owns the leak-SHAPE
// invariants (whole-tree call-graph view safety, return-type pin, `iter` ban,
// accessor confinement, bindings probe).  These two Rust tests own what the
// eval structurally cannot:
//
//   R1 — the cargo-mutants KILL.  `cargo mutants` runs `cargo test`, never
//        `just eval`, and `SCHEMA_SOURCE` is a RELATIVE `include_str!`, so in
//        the mutants scratch tree it reads the MUTATED schema.rs (M17.5c
//        precedent).  The `replace my_wallet -> Option<PlayerWallet> with
//        None` mutant blanks the body, the PRESENCE assertions below go red,
//        and the mutant dies — holding `mutate-server` at its exact committed
//        cap (justfile + nightly-smoke-wiring.eval.mjs).  Note the two
//        deliberate design choices: BODY-scoped (a file-scoped scan is
//        satisfied forever by the pre-existing `my_conversation` view, i.e.
//        vacuous) and PRESENCE-asserting (an absence-only assertion is
//        *satisfied by* the `None` mutant).
//
//   R2 — the never-deleted invariant.  No code path may delete a
//        `player_wallet` row.  This is what LICENSES the client's
//        insert-wins/no-remove store policy: through a view subscription a row
//        UPDATE is delivered as onInsert(new) + onDelete(old), so if wallet
//        rows were genuinely deletable the client could not tell a real delete
//        from the old half of an update pair (buy-then-sell 100 -> 50 -> 100
//        coalesces to I(50) I(100) D(100) D(50) — a balance-equality gate
//        would remove the LIVE row).
//
// Both scans run on the comment- AND string-stripped source (helpers above),
// so prose and planted string literals can neither satisfy nor trip a needle.
// Needles are assembled with `.concat()` (precedent: test 2 at the top of this
// file) so this test file cannot self-match if it is ever source-scanned.
// ===========================================================================

/// Remove ALL whitespace, so needles and the exact-body pin below survive
/// rustfmt line breaks and stray spaces (`player_wallet ()` compiles and would
/// otherwise bypass an un-compacted accessor needle — red-team F-6).
fn compact_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Brace-walk every `fn <name> … { … }` in a comment+string-stripped Rust source
/// and return `(name, signature, body_including_braces)` triples.
///
/// Shared by R1 (the exact-body pin on `my_wallet`) and R2 (the fn-scoped
/// never-deleted scan).  The SIGNATURE is returned because a fn can reach the
/// wallet table without ever naming the accessor in its body — it can take the
/// generated handle as a parameter (`&player_wallet__TableHandle`), which is a
/// one-hop bypass of a body-only scan (red-team F-2).
///
/// Nested fns are reported in addition to the enclosing fn (the enclosing body
/// simply contains them) — conservative, the safe direction for a security scan.
///
/// LIMITATION: the body-opening brace is "the first `{` before the first `;`".
/// A const-generic brace in a return type (`Vec<[T; {1}]>`) would blind it —
/// no such signature exists in this crate, and the JS eval's parser (which uses
/// an angle/paren-aware scan) is the belt to this suspenders.
fn rust_fn_bodies(src: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let bytes = src.as_bytes();
    let mut cursor = 0usize;
    while let Some(rel) = src[cursor..].find("fn ") {
        let idx = cursor + rel;
        cursor = idx + 3;

        // `fn` must be its own token (never the tail of an identifier).
        if idx > 0 {
            let prev = bytes[idx - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                continue;
            }
        }

        let name: String = src[idx + 3..]
            .chars()
            .skip_while(|c| c.is_whitespace())
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            continue;
        }

        // Body-opening brace; a `;` first means a bodyless declaration.
        let mut open_abs: Option<usize> = None;
        for (i, ch) in src[idx..].char_indices() {
            match ch {
                '{' => {
                    open_abs = Some(idx + i);
                    break;
                }
                ';' => break,
                _ => {}
            }
        }
        let Some(open_abs) = open_abs else {
            continue;
        };

        let mut depth: usize = 0;
        let mut close_abs: Option<usize> = None;
        for (i, ch) in src[open_abs..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close_abs = Some(open_abs + i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close_abs) = close_abs else {
            continue;
        };

        out.push((
            name,
            src[idx..open_abs].to_string(),
            src[open_abs..=close_abs].to_string(),
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// ux2 R1: the `my_wallet` view body is owner-scoped
// ---------------------------------------------------------------------------

/// ux2 (ADR-0154): schema.rs must declare `fn my_wallet`, and its BODY must
/// read the wallet through the `owner_identity` unique index keyed on
/// `ctx.sender()` — i.e. it must contain all of `player_wallet()`,
/// `owner_identity()` and `.find(ctx.sender())` (the `&ctx.sender()` borrow
/// spelling is an equally-correct form of the same scoping and is accepted).
///
/// EXACTNESS (red-team F-1, CRITICAL): the presence assertions alone are NOT
/// enough.  This body compiles, is clippy-clean and rustfmt-clean, contains
/// every needle below, and returns an ARBITRARY player's wallet:
/// ```ignore
/// let _decoy = <accessor>.owner_identity().find(ctx.sender());
/// let victim = Identity::from_byte_array([7u8; 32]);
/// <accessor>.owner_identity().find(victim)
/// ```
/// The sanctioned body is ONE expression, so the final assertion pins the
/// whitespace-compacted body EXACTLY.  That pin still CONTAINS the needles, so
/// it keeps killing the `cargo mutants` "replace body with `None`" mutant (an
/// absence-only rewrite would not) — `mutate-server` has zero headroom.
///
/// kills:
///  - `cargo mutants` "replace body with `None`" on `my_wallet` (the body loses
///    every needle AND stops matching the exact pin; `SCHEMA_SOURCE` is a
///    relative `include_str!` so the test reads the mutated file in the mutants
///    scratch tree);
///  - the decoy-line leak above (exact pin);
///  - a body that scans the table and filters afterwards;
///  - a body keyed on any identity other than `ctx.sender()`;
///  - a view placed in some OTHER module (SCHEMA_SOURCE would not contain it) —
///    which also matters because currency-integrity.eval.mjs's ACCESSOR_BYPASS
///    criterion only exempts economy.rs / schema.rs / economy_tests.rs.
///
/// Deliberately NOT absence-only and NOT file-scoped: see the block comment
/// above (both weaker forms are satisfied by an implementation that leaks).
#[test]
fn my_wallet_view_is_owner_scoped() {
    let schema_stripped = strip_rust_strings_economy(&strip_rust_comments_economy(SCHEMA_SOURCE));
    let bodies = rust_fn_bodies(&schema_stripped);

    // Split-literal fn name (self-match guard).
    let view_fn_name = ["my", "_wallet"].concat();
    let body = bodies
        .iter()
        .find(|(name, _, _)| *name == view_fn_name)
        .map(|(_, _, body)| body.as_str())
        .unwrap_or_else(|| {
            // The message deliberately does NOT spell the view attribute or the
            // wallet accessor literally: this file must stay free of tokens that
            // any current or future source scan could match against itself
            // (same doctrine as the split-literal needles below). See ux2 plan T1
            // for the exact snippet to paste.
            panic!(
                "TEETH(ux2 ADR-0154): `fn {view_fn_name}` not found in schema.rs — the \
                 owner-scoped view is the ONLY sanctioned client read path for the PRIVATE \
                 wallet table. Add it immediately after the PlayerWallet table, carrying the \
                 spacetimedb view attribute (accessor = {view_fn_name}, public), taking a \
                 &spacetimedb::ViewContext, returning Option<PlayerWallet>, with a body that \
                 is the sender-keyed unique-index lookup on the wallet accessor \
                 (owner_identity().find(ctx.sender())) and nothing else."
            )
        });

    let accessor = ["player", "_wallet()"].concat();
    let unique_index = ["owner", "_identity()"].concat();
    let find_sender = [".find(ctx", ".sender())"].concat();
    let find_sender_ref = [".find(&ctx", ".sender())"].concat();

    // All needles are matched on the whitespace-COMPACTED body (with the outer
    // braces peeled), so neither a rustfmt line break nor a stray space
    // (`player_wallet ()`) changes the verdict — red-team F-6.
    let compact_body = compact_ws(body);
    let inner = compact_body
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .unwrap_or(compact_body.as_str());

    assert!(
        inner.contains(accessor.as_str()),
        "TEETH(ux2 ADR-0154 R1): the `my_wallet` view BODY does not contain `{}` — \
         the view must actually read the wallet table (a stub returning `None`, or the \
         cargo-mutants `replace body with None` mutant, lands here). Body was: {:?}",
        accessor,
        body
    );
    assert!(
        inner.contains(unique_index.as_str()),
        "TEETH(ux2 ADR-0154 R1): the `my_wallet` view BODY does not contain `{}` — \
         the read MUST go through the owner_identity unique index, never a table scan \
         (a whole-table read is a balance leak for every player). Body was: {:?}",
        unique_index,
        body
    );
    assert!(
        inner.contains(find_sender.as_str()) || inner.contains(find_sender_ref.as_str()),
        "TEETH(ux2 ADR-0154 R1): the `my_wallet` view BODY contains neither `{}` nor `{}` — \
         the index lookup MUST be keyed on `ctx.sender()` (the host reconstructs `sender` \
         per caller; that is the ONLY thing making this view per-player). Body was: {:?}",
        find_sender,
        find_sender_ref,
        body
    );

    // --- EXACT-BODY PIN (red-team F-1, CRITICAL) -------------------------------
    // Everything above is presence-only and is passed by a decoy line. The
    // sanctioned body is ONE expression: pin it, whitespace-insensitively.
    let sanctioned = [
        "ctx.db.",
        "player",
        "_wallet().",
        "owner",
        "_identity().find(ctx",
        ".sender())",
    ]
    .concat();
    let sanctioned_ref = [
        "ctx.db.",
        "player",
        "_wallet().",
        "owner",
        "_identity().find(&ctx",
        ".sender())",
    ]
    .concat();

    assert!(
        inner == sanctioned || inner == sanctioned_ref,
        "TEETH(ux2 ADR-0154 R1 EXACT-BODY): the `my_wallet` view body is not EXACTLY the \
         sanctioned sender-keyed lookup.\n  expected (whitespace-insensitive): {}\n  \
         found:                            {}\n\
         This pin is exact ON PURPOSE: a presence check is passed by a decoy line \
         (`let _decoy = <accessor>.owner_identity().find(ctx.sender());` followed by a real \
         read keyed on some OTHER identity), which compiles clean, passes clippy and \
         rustfmt, and returns an arbitrary player's wallet. If this body must legitimately \
         change, the new shape has to be re-reviewed for sender-scoping HERE and in \
         evals/wallet-privacy.eval.mjs clause [B/2c].",
        sanctioned,
        inner
    );
}

// ---------------------------------------------------------------------------
// ux2 R2: no code path deletes a player_wallet row
// ---------------------------------------------------------------------------

/// ux2 (ADR-0154): in every function of economy.rs and schema.rs that touches
/// the wallet table — via the `player_wallet()` accessor in its body OR via a
/// generated wallet handle type in its SIGNATURE — neither `.delete(` nor
/// `.try_delete(` may appear.  Verified true at authoring time: economy.rs
/// does find / update / insert only, and no `on_disconnect` hook touches the
/// wallet.
///
/// fn-SCOPED rather than statement-scoped on purpose: a statement window
/// (accessor -> next `;`) is walked past by both
/// `let h = ctx.db.player_wallet(); h.owner_identity().delete(owner);` and by a
/// delete inside a `match ctx.db.player_wallet()…{ … }` arm.  Only
/// wallet-touching functions are constrained, so an unrelated future
/// `.delete(` elsewhere in economy.rs (e.g. an inventory row) does not
/// false-red this test.
///
/// SIGNATURE-AWARE (red-team F-2): a fn is "wallet-touching" when its body OR
/// its SIGNATURE names the accessor or a generated wallet handle type
/// (`player_wallet__TableHandle` / `player_wallet__ViewHandle`).  Without the
/// signature arm, one hop defeats the scan entirely:
/// ```ignore
/// fn purge(h: &crate::schema::player_wallet__TableHandle, owner: Identity) {
///     h.owner_identity().delete(owner);          // body never names the accessor
/// }
/// #[spacetimedb::reducer]
/// pub fn purge_wallet(ctx: &ReducerContext) -> Result<(), String> {
///     purge(ctx.db.player_wallet(), ctx.sender()); // caller has no `.delete(`
///     Ok(())
/// }
/// ```
/// Both halves are individually clean under a body-only scan; the signature arm
/// puts `purge` in scope and the `.delete(` fires.
///
/// Needles are matched on the whitespace-COMPACTED text so `player_wallet ()`
/// and `.delete (` cannot slip past (red-team F-6).
///
/// Non-vacuity: at least one wallet-touching fn must be found in EACH file.
/// The economy.rs arm kills a renamed/removed accessor silently emptying the
/// scan; the schema.rs arm requires the `my_wallet` view to live in schema.rs
/// (where currency-integrity.eval.mjs's ACCESSOR_BYPASS criterion exempts it)
/// so the never-deleted invariant actually covers the new read path.
///
/// kills:
///  - an impl that "cleans up" empty wallets with
///    `ctx.db.player_wallet().owner_identity().delete(owner)` on a zero balance
///    or on disconnect — that would make the client's insert-wins/no-remove
///    policy unsound (a genuine delete would be indistinguishable from the old
///    half of a view UPDATE pair, so the UI could not react to it);
///  - a `try_delete` spelling of the same;
///  - the view being added outside schema.rs (schema.rs arm goes red).
#[test]
fn player_wallet_rows_are_never_deleted() {
    let accessor = ["player", "_wallet()"].concat();
    // Generated handle types: `player_wallet__TableHandle`, `player_wallet__ViewHandle`.
    let handle = ["player", "_wallet__"].concat();
    let wallet_desc = [accessor.as_str(), " or handle type ", handle.as_str()].concat();
    let delete_pat = [".delete", "("].concat();
    let try_delete_pat = [".try", "_delete("].concat();

    // --- m22-s3b: THE ONE SANCTIONED WALLET DELETER, EXEMPTED BY NAME -------
    //
    // `player_wallet` carries the ERASE policy in `DATA_LIFECYCLE_MANIFEST`
    // (spec §3), so the M22 deletion cascade is the one code path that MUST
    // delete a wallet row. ADR-0228 D7(c) takes a single-fn exemption rather
    // than zeroing the balance: a surviving zeroed row is exactly the orphaned
    // data the operator's issue-#403 Option B ruling excludes, and the manifest
    // policy would then be a lie.
    //
    // A NAMED EXEMPTION CAN ONLY EVER LOOSEN THIS GATE, so it is paid for four
    // ways, all of them here and all of them driven by the SAME
    // `rust_fn_bodies` walk the ban itself runs over (never a second parse that
    // could disagree with the first):
    //   * exactly ONE walk entry may carry the exempted name — so a same-named
    //     twin, or the name attached to a different function, reds;
    //   * that entry's body is pinned by EXACT EQUALITY to the sanctioned
    //     owner-keyed delete, so the exemption cannot cover a dead branch, a
    //     shadowed binding, an appended foreign write, or (the catastrophic
    //     direction) an UNFILTERED sweep that deletes every player's wallet;
    //   * the exempted body must actually CONTAIN the delete verb, so the
    //     exemption can never decay into a permanently open slot;
    //   * the every-other-function ban below is unchanged.
    let erase_wallet = ["erase", "_wallet"].concat();
    let mut wallet_fns_in_economy = 0usize;
    let mut wallet_fns_in_schema = 0usize;
    let mut erase_wallet_entries = 0usize;
    let mut erase_wallet_body = String::new();

    for (file, src) in [("economy.rs", ECONOMY_SOURCE), ("schema.rs", SCHEMA_SOURCE)] {
        let stripped = strip_rust_strings_economy(&strip_rust_comments_economy(src));
        for (name, sig, raw_body) in rust_fn_bodies(&stripped) {
            let sig = compact_ws(&sig);
            let body = compact_ws(&raw_body);
            let touches_wallet = body.contains(accessor.as_str())
                || body.contains(handle.as_str())
                || sig.contains(accessor.as_str())
                || sig.contains(handle.as_str());
            if !touches_wallet {
                continue;
            }
            if file == "economy.rs" {
                wallet_fns_in_economy += 1;
            } else {
                wallet_fns_in_schema += 1;
            }

            // THE ONE EXEMPTION. Recorded rather than skipped, so the clauses
            // after the loop can hold it to its exact sanctioned shape.
            if name == erase_wallet {
                erase_wallet_entries += 1;
                erase_wallet_body = body.clone();
                continue;
            }

            assert!(
                !body.contains(delete_pat.as_str()),
                "TEETH(ux2 ADR-0154 R2): `{}` in {} touches `{}` AND contains `{}` — \
                 player_wallet rows must NEVER be deleted, except by the ONE cascade helper \
                 exempted by name below. The client's wallet slot is \
                 insert-wins with NO remove path precisely because of this invariant: \
                 through a view subscription an UPDATE is delivered as onInsert(new) + \
                 onDelete(old), so a genuine delete is indistinguishable from the old \
                 half of an update pair (buy-then-sell 100 -> 50 -> 100 coalesces to \
                 I(50) I(100) D(100) D(50)). Zero out the balance instead of deleting \
                 the row, or this slice's client policy must be redesigned.",
                name,
                file,
                wallet_desc,
                delete_pat
            );
            assert!(
                !body.contains(try_delete_pat.as_str()),
                "TEETH(ux2 ADR-0154 R2): `{}` in {} touches `{}` AND contains `{}` — \
                 player_wallet rows must NEVER be deleted (see the `.delete(` arm above; \
                 the fallible spelling is the same violation).",
                name,
                file,
                wallet_desc,
                try_delete_pat
            );
        }
    }

    assert_eq!(
        erase_wallet_entries, 1,
        "TEETH(m22-s3b / ADR-0228 D7(c) EXEMPTION-UNIQUE): the `rust_fn_bodies` walk found \
         {erase_wallet_entries} function(s) named `{erase_wallet}` across economy.rs and \
         schema.rs; EXACTLY ONE is allowed. ZERO means the cascade has no delegated wallet \
         eraser at all — `player_wallet` is an ERASE-policy table, G5 closes accounts.rs at \
         its four owned tables, and currency-integrity's ACCESSOR_BYPASS bans even a READ of \
         the wallet from any other module, so the deleting player's balance simply survives \
         the deletion. MORE THAN ONE means the by-NAME exemption covers more than one body, \
         and the exact-body pin below can then only speak for whichever the walk saw last."
    );
    let sanctioned = m22s3b_sanctioned_erase_wallet_body();
    assert_eq!(
        erase_wallet_body, sanctioned,
        "TEETH(m22-s3b / ADR-0228 D7(c) EXEMPTION-SHAPE): the exempted `{erase_wallet}` body \
         is not the sanctioned owner-keyed delete.\n  expected (whitespace-compacted): \
         {sanctioned:?}\n  found:    {erase_wallet_body:?}\n\
         EXACT EQUALITY, because a by-name exemption is a hole in a never-delete invariant \
         and containment was MEASURED insufficient for this exact family (the rb-22 red-team: \
         an `if false` wrapper around a correct body, a shadowed binding, a shadowed loop \
         variable and an appended aliased foreign write all satisfy every needle-based clause \
         and are clippy-clean). The catastrophic member of that family is an UNFILTERED sweep \
         — `for row in ctx.db.player_wallet().iter()` — which deletes EVERY player's wallet \
         and reads identically to every containment pin. If the sanctioned body legitimately \
         changes, re-derive this literal from ADR-0228 D7(c) and re-review the exemption in \
         the same change."
    );
    assert!(
        erase_wallet_body.contains(delete_pat.as_str()),
        "TEETH(m22-s3b / ADR-0228 D7(c) EXEMPTION-EXERCISED): the exempted `{erase_wallet}` \
         body contains no `{delete_pat}` at all. An exemption for a function that deletes \
         nothing is a permanently open slot in the never-delete gate: the name is skipped by \
         the ban above forever, and whatever is written there later is unmeasured. Widening \
         a gate must be paid for by the write it was widened for."
    );

    // Positional: the exempted helper must sit BEFORE `rekey_wallet` in the
    // file.
    //
    // MESSAGE CORRECTED IN r2 — the first draft overclaimed. What
    // `evals/currency-integrity.eval.mjs`'s wallet zero-argument pin searches
    // forward from `rekey_wallet` for is the ZEROING UPDATE, not a delete, so
    // `erase_wallet` placed after it would not red that eval today: the helper
    // contains no `update(` at all. The honest statement of the rule is
    // therefore a FENCE rather than a repair: that forward search has no upper
    // bound, so everything below `rekey_wallet` sits inside a window belonging to
    // a criterion written about a DIFFERENT function, and a helper that later
    // grows an `update(` — a zeroing step added beside the delete, say — would
    // silently start answering for `rekey_wallet`. Keeping the new helper above
    // that line is a one-line placement choice that costs nothing and removes the
    // whole class; it is not a claim that the eval reds today.
    let economy_clean = strip_rust_strings_economy(&strip_rust_comments_economy(ECONOMY_SOURCE));
    let erase_decl = ["fn ", erase_wallet.as_str(), "("].concat();
    let rekey_decl = ["fn ", "rekey", "_wallet("].concat();
    let at_erase = economy_clean.find(erase_decl.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH(m22-s3b EXEMPTION-PLACEMENT): economy.rs declares no `{erase_decl}`, so \
             the placement clause has no anchor and would pass vacuously."
        )
    });
    let at_rekey = economy_clean.find(rekey_decl.as_str()).unwrap_or_else(|| {
        panic!(
            "TEETH(m22-s3b EXEMPTION-PLACEMENT): economy.rs declares no `{rekey_decl}`, so \
             the placement clause has no anchor and would pass vacuously."
        )
    });
    assert!(
        at_erase < at_rekey,
        "TEETH(m22-s3b EXEMPTION-PLACEMENT): `{erase_wallet}` is declared at byte {at_erase}, \
         AFTER `rekey_wallet` at {at_rekey}. It must come first. \
         STATED ACCURATELY (r2 correction): evals/currency-integrity.eval.mjs pins the wallet \
         zero-argument shape by scanning FORWARD from `rekey_wallet` for the zeroing \
         `update(`, with NO upper bound — so everything below that declaration sits inside a \
         window belonging to a criterion written about a different function. `erase_wallet` \
         carries no `update(` today, so this is a FENCE rather than a live red: it costs one \
         line of placement and it removes the whole class, including the shape where a later \
         edit adds a zeroing step beside the delete and that step silently starts answering \
         for `rekey_wallet` in an eval nobody re-read. Do not relax this by moving the helper \
         and widening the eval instead."
    );

    assert!(
        wallet_fns_in_economy >= 1,
        "TEETH(ux2 ADR-0154 R2 NON-VACUITY): no function in economy.rs touches `{}` — \
         the never-deleted scan found nothing to check and would pass vacuously. \
         Either the wallet accessor was renamed (update this test) or the \
         single-surface wallet helpers (grant_currency / wallet_balance / \
         spend_currency, ADR-0081) were moved out of economy.rs.",
        wallet_desc
    );
    assert!(
        wallet_fns_in_schema >= 1,
        "TEETH(ux2 ADR-0154 R2 COVERAGE): no function in schema.rs touches `{}` — \
         the `my_wallet` view MUST live in schema.rs (currency-integrity.eval.mjs's \
         ACCESSOR_BYPASS criterion exempts only economy.rs / schema.rs / \
         economy_tests.rs), and the never-deleted scan must cover the file that owns \
         the new client read path.",
        wallet_desc
    );
}

/// The sanctioned whitespace-COMPACTED body of `erase_wallet`: the ONE
/// owner-keyed primary-key delete, brace-framed, and nothing else.
///
/// NARROWED TO A SINGLE FRAMING IN r2. The first draft accepted the statement
/// with AND without its surrounding braces, because the authoring pass could not
/// statically determine which one `rust_fn_bodies` produces. It has now been
/// measured: that walk always returns the body WITH its braces, so the
/// brace-free alternative was an accepted spelling nothing could ever emit —
/// dead tolerance in an exact-equality pin, which is the one place tolerance has
/// no business being. Removing it also removes the `iter().any()` comparison the
/// lint objected to at both call sites: with one expected value the assertion is
/// a plain equality, which is what it should have been.
///
/// `player_wallet` is keyed by `owner_identity` as its PRIMARY KEY (schema.rs),
/// so the delete is a point delete of exactly one row — not a filter, not a
/// scan.
fn m22s3b_sanctioned_erase_wallet_body() -> String {
    [
        "{",
        "ctx.db.",
        "player",
        "_wallet().",
        "owner",
        "_identity().delete(owner);",
        "}",
    ]
    .concat()
}

/// **PRV1-6b (m22-s3b)** — the delegated wallet eraser is exactly one
/// owner-keyed point delete, named as the gates ledger names it.
///
/// This is the same exact-body property the amended
/// `player_wallet_rows_are_never_deleted` above asserts as part of paying for
/// its by-name exemption; it is ALSO stated here as a standalone test so the
/// cascade's own requirement has a test named after it, and so a failure
/// attributes to the cascade rather than to the ux2 never-delete gate. The two
/// arms fail with different messages, so a mutation can be attributed to either.
///
/// Kills: a helper that filters instead of point-deleting (the column is the
///        PRIMARY key, so a filter is a scan that says the same thing more
///        slowly and stops being a proof that exactly one row is touched);
///        an UNFILTERED sweep, which deletes every player's wallet; a helper
///        that zeroes the balance instead of deleting (which leaves the orphaned
///        row Option B rules out and makes the ERASE manifest policy false); an
///        appended second write; a dead-branch wrapper.
#[test]
fn m22s3b_erase_wallet_sanctioned_shape() {
    let erase_wallet = ["erase", "_wallet"].concat();
    let stripped = strip_rust_strings_economy(&strip_rust_comments_economy(ECONOMY_SOURCE));

    let mut seen = 0usize;
    let mut body = String::new();
    let mut sig = String::new();
    for (name, raw_sig, raw_body) in rust_fn_bodies(&stripped) {
        if name == erase_wallet {
            seen += 1;
            sig = compact_ws(&raw_sig);
            body = compact_ws(&raw_body);
        }
    }
    assert_eq!(
        seen, 1,
        "m22-s3b PRV1-6b FAIL: economy.rs must declare `fn {erase_wallet}(` EXACTLY once; \
         the fn-body walk found {seen}. ZERO means the cascade has no delegated wallet \
         eraser: `player_wallet` is ERASE-policy, G5 MODULE_WRITE_ISOLATION closes \
         accounts.rs at its four owned tables, and currency-integrity's ACCESSOR_BYPASS bans \
         even a READ of the wallet from any module but this one — so the deleting player's \
         balance survives the deletion with nothing anywhere to remove it."
    );
    assert!(
        sig.contains("owner:Identity"),
        "m22-s3b PRV1-6b FAIL (signature): `{erase_wallet}` must take an OWNER-GENERIC \
         `owner: Identity`, mirroring `purge_export_bundles` and `disarm_deletion_reaper`. A \
         claim-specific or caller-specific parameter name signals a helper scoped to one \
         flow, and the cascade needs one that is scoped to whatever identity it is erasing. \
         Signature read: {sig:?}"
    );
    let sanctioned = m22s3b_sanctioned_erase_wallet_body();
    assert_eq!(
        body, sanctioned,
        "m22-s3b PRV1-6b FAIL (body): `{erase_wallet}` must be EXACTLY the one owner-keyed \
         point delete.\n  expected (whitespace-compacted): \
         {sanctioned:?}\n  found: {body:?}\n\
         `owner_identity` is the PRIMARY KEY of `player_wallet`, so the sanctioned shape is a \
         point delete of exactly one row. A filtered sweep says the same thing more slowly \
         and stops proving that only one row is touched; an UNFILTERED sweep deletes every \
         player's wallet in the database and reads identically to every containment pin; and \
         a zeroing update leaves the orphaned row the operator's Option B ruling excludes, \
         which would make this table's ERASE manifest policy false."
    );
}

// ---------------------------------------------------------------------------
// ux2 R3: no module code constructs a view context (forged-sender ban)
// ---------------------------------------------------------------------------

/// ux2 (ADR-0154, auditor finding M-1): neither schema.rs nor economy.rs may
/// CONSTRUCT a `ViewContext` — not via the constructor and not as a struct
/// literal.  Mirrors clause `[B/3c-forged-ctx]` of
/// `evals/wallet-privacy.eval.mjs` so `cargo test` bites too (the eval runs
/// only under `just eval`, never under `cargo mutants`).
///
/// WHY: `spacetimedb::ViewContext::new(sender)` is a `pub` constructor
/// (spacetimedb-1.12.0/src/lib.rs:902-911).  A second view can therefore
/// launder a read THROUGH the owner-scoped view with a sender it chose:
/// ```ignore
/// #[spacetimedb::view(accessor = peek_wallet, public)]
/// fn peek_wallet(_ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
///     let victim = Identity::from_byte_array([7u8; 32]);
///     my_wallet(&spacetimedb::ViewContext::new(victim))   // arbitrary wallet
/// }
/// ```
/// That body names neither the wallet accessor (so R1/R2, the eval's accessor
/// clauses, and currency-integrity's ACCESSOR_BYPASS all miss it) nor any
/// wallet-reading helper (the view fn is deliberately excluded from the eval's
/// reader closure, so a future HUD view may legitimately call it with its OWN
/// context).  The authenticity of `sender` is the WHOLE privacy mechanism: the
/// host is the only legitimate constructor
/// (spacetimedb-1.12.0/src/rt.rs:1100-1121), so module code constructing one is
/// banned outright.  No false-red surface: every live `ViewContext` occurrence
/// in these files is a `&spacetimedb::ViewContext` parameter type, and a
/// parameter is always followed by `)` or `,`.  (A fn that RETURNS a context —
/// `fn forge() -> spacetimedb::ViewContext {` — does compact to the banned
/// `ViewContext{` and is flagged: intended, because such a fn must have
/// constructed one.)
///
/// kills: any `peek_wallet`-shaped view; a struct-literal `ViewContext { … }`
///        spelling of the same; a helper that manufactures a context for a
///        reducer to pass into a view fn.
#[test]
fn no_forged_view_context_construction() {
    // Split-literal needles: this test file must never match itself, and the
    // needles are compared against the whitespace-COMPACTED source so
    // `ViewContext :: new (` cannot slip past.
    let ctor = ["ViewContext", "::new("].concat();
    let struct_literal = ["ViewContext", "{"].concat();

    for (file, src) in [("schema.rs", SCHEMA_SOURCE), ("economy.rs", ECONOMY_SOURCE)] {
        let compact = compact_ws(&strip_rust_strings_economy(&strip_rust_comments_economy(
            src,
        )));
        for needle in [ctor.as_str(), struct_literal.as_str()] {
            assert!(
                !compact.contains(needle),
                "TEETH(ux2 ADR-0154 R3 FORGED-CTX): {} constructs a view context (`{}`) — \
                 only the SpacetimeDB host may build a ViewContext; that is what makes \
                 `ctx.sender()` authentic, and authenticity of the sender is the ENTIRE \
                 privacy mechanism of the owner-scoped `my_wallet` view. A constructed \
                 context lets any view call `my_wallet` with a sender it picked and read \
                 an arbitrary player's wallet while naming neither the wallet table nor \
                 any wallet-reading helper. A view that needs the wallet must take its \
                 own `&spacetimedb::ViewContext` parameter and pass THAT.",
                file,
                needle
            );
        }
    }
}

// ===========================================================================
// M21a AUTH-24 / AUTH-23 (ADR-0179 D6): guest->account wallet re-key credits the
// balance forward via grant_currency, then zeroes the guest row IN PLACE — never
// deletes. Pure seam + a credit-before-zero ordering scan on economy.rs.
//
// economy_tests.rs is exempt from currency-integrity ACCESSOR_BYPASS, so a
// `PlayerWallet { .. }` literal here is legitimate (unlike accounts_tests.rs).
// ===========================================================================

/// AUTH-24 (pure): `zeroed_wallet` sets `balance == 0` and PRESERVES the PK owner
/// (the guest row survives with a zero balance — never a delete, AUTH-23).
///
/// Kills: a mutant that also rewrites `owner_identity`, or that returns the row
/// unchanged (balance not zeroed — the source could re-donate its balance to a
/// second fresh account via a later claim).
#[test]
fn auth24_zeroed_wallet_zeroes_balance_preserves_owner() {
    let owner = Identity::from_byte_array([9u8; 32]);
    let before = PlayerWallet {
        owner_identity: owner,
        balance: 500,
    };
    let after = zeroed_wallet(before);
    assert_eq!(
        after.balance, 0,
        "AUTH-24: the re-keyed guest wallet must be zeroed."
    );
    assert_eq!(
        after.owner_identity, owner,
        "AUTH-24/23: the wallet PK owner must be preserved (the row is zeroed, never deleted)."
    );
}

/// AUTH-24 (scan): `rekey_wallet` READS the guest balance (`find(from)`), CREDITS
/// it forward via `grant_currency`, THEN zeroes the guest row via `zeroed_wallet`
/// — and NEVER deletes a wallet row (AUTH-23).
///
/// Kills (proof-of-teeth): move the zeroing update BEFORE `grant_currency` — the
/// row would be credited with 0 (silent balance destruction). Also kills replacing
/// the in-place zero with a `.delete(`.
#[test]
fn auth24_rekey_wallet_credits_before_zero_never_deletes() {
    let compact = compact_ws(&strip_rust_strings_economy(&strip_rust_comments_economy(
        ECONOMY_SOURCE,
    )));
    let fn_needle = ["fnrekey", "_wallet("].concat();
    let fn_pos = compact
        .find(fn_needle.as_str())
        .expect("AUTH-24: fn rekey_wallet not found in economy.rs");

    let open = compact[fn_pos..]
        .find('{')
        .map(|o| fn_pos + o)
        .expect("AUTH-24: rekey_wallet body opening brace not found");
    let bytes = compact.as_bytes();
    let mut depth = 0usize;
    let mut close = open;
    for (i, &b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    close = i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &compact[open..=close];

    let find_from = ["find", "(from)"].concat();
    let grant = ["grant", "_currency("].concat();
    let zero = ["zeroed", "_wallet("].concat();
    let delete = [".del", "ete("].concat();

    let i_find = body
        .find(find_from.as_str())
        .expect("AUTH-24: rekey_wallet must read the guest wallet via find(from)");
    let i_grant = body
        .find(grant.as_str())
        .expect("AUTH-24: rekey_wallet must credit forward via grant_currency(");
    let i_zero = body
        .find(zero.as_str())
        .expect("AUTH-24: rekey_wallet must zero the guest row via zeroed_wallet(");

    assert!(
        i_find < i_grant,
        "AUTH-24: the guest balance must be READ (find(from)) before it is credited forward."
    );
    assert!(
        i_grant < i_zero,
        "AUTH-24: CREDIT before ZERO — grant_currency must precede the zeroing update. \
         (proof-of-teeth: moving the zero first credits 0 — silent balance destruction.)"
    );
    assert!(
        !body.contains(delete.as_str()),
        "AUTH-24/23: rekey_wallet must NEVER delete a wallet row (credit-forward + in-place zero)."
    );
}

// ===========================================================================
// rb-41 — R-rb-25-X9 (ADR-0222 known-limit 2, closed by the ADR-0224 native
// host migration): the REKEY exists-predicate for the wallet table, exercised
// against REAL rows instead of against its own source text.
//
// ADR-0222's guest-claim-integrity gate could only READ this predicate's
// source, so a HOLLOWED body — one that still performs the table read but
// returns a value decoupled from it — passed every check. The test below runs
// the shipped predicate against the in-memory host (native_host_tests) and
// pins its answer to the rows that actually exist, which no source scan can do.
// ===========================================================================

/// EARS R-rb-25-X9: `economy::wallet_exists` must answer from the CURRENT rows
/// of the wallet table, for the ASKED owner — false with no row, false while
/// only a stranger owns one, true once the owner owns one, false again once the
/// owner's row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin this table's disjunct of
/// the six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - the ADR-0222 known-limit hollow, `{ let _ = <the wallet read>; false }`:
///     the owner-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the wallet read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the wallet disjunct from `accounts::account_has_game_data`:
///     the paired account assertion goes red while the direct predicate
///     assertion stays green, naming the missing disjunct exactly.
#[test]
fn rb41_wallet_exists_tracks_real_wallet_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = fx.table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([11u8; 32]);
    let stranger = Identity::from_byte_array([12u8; 32]);

    assert!(
        !crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must be false for an owner with no wallet row: the table is empty here, \
         so a true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&PlayerWallet {
        owner_identity: stranger,
        balance: 0,
    });
    assert!(
        !crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must stay false when the ONLY wallet row belongs to a different owner: \
         the predicate answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&PlayerWallet {
        owner_identity: owner,
        balance: 0,
    });
    assert!(
        crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must report true while the owner holds a wallet row; a body that reads \
         the table and then returns a constant false (the ADR-0222 known-limit hollow) fails \
         exactly here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its wallet disjunct while the owner holds a \
         wallet row and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one wallet row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::economy::wallet_exists(&ctx, owner),
        "wallet_exists must return to false once the owner's wallet row is gone: the answer \
         tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::economy::wallet_exists(&ctx, stranger),
        "removing the owner's row must leave the stranger's row untouched: without this the \
         negative above could be explained by an emptied table rather than by owner scoping. \
         Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

// ===========================================================================
// rb-46 (residual R-m22-s5-X12, ADR-0236 D2/D4) — the caller-only deletion gate
// on the shop.
//
// EARS criterion covered here:
//
//   R-m22-s5-X12 (shop half)  WHILE the caller's account is inside the para-4.7
//   deletion gate, WHEN the caller invokes `buy` or `sell`, the server module
//   SHALL refuse the call before any wallet or inventory write, with the single
//   static reason.
//
// WHY THE SHOP IS IN SCOPE AT ALL: M22 para 4.7 selects gate targets
// mechanically from the tables they move, and `player_wallet` + `inventory` are
// both ERASE-policy tables (spec section 3 / `DATA_LIFECYCLE_MANIFEST`). A
// mid-grace account trading currency for items — or items for currency — is
// opening exactly the kind of new commitment the grace window exists to stop,
// and every unit of it lands in a table the cascade is about to erase.
//
// TWO VEHICLES, as in `battle_tests.rs` (ADR-0236 D4).
//
//   EXECUTION runs the SHIPPED reducers under the rb-41 native host
//   (`native_host_tests`) against real `account` and `player` rows, through a
//   five-state progression with a mid-grace STRANGER row present throughout. It
//   is the only proof of POLARITY (the gate refuses the two deleting states), of
//   REACHABILITY (it ADMITS the other three) and of CALLER-KEYING (the stranger
//   never refuses anybody) — none of which any source scan in this crate can
//   supply.
//
//   SOURCE PINS cover what execution cannot see: the fully-qualified path, the
//   `?`-propagation, ordering relative to a write the fixture never reaches, a
//   conditional-compilation attribute on the gate statement, and the REGION
//   ABOVE the gate, where an early return can carry every real caller around a
//   gate the tests still execute.
//
// The log TAG and the per-file gated SET live in
// `guards_tests.rs::rb46_gated_reducer_census_battle_and_economy`, on the one
// proven m22-s5 pipeline. The helper below reuses THIS file's existing
// `strip_rust_comments_economy` / `strip_rust_strings_economy` / `rust_fn_bodies`
// / `compact_ws`; no stripper and no body extractor is re-derived (ADR-0003).
//
// NOTE ON THE STRIPPED VIEW: `strip_rust_strings_economy` keeps the DELIMITERS
// and discards the payload, so a tagged call reads as an empty literal here —
// which is also why `require_owner` reads identically in both reducers and why
// every anchor below is BODY-scoped rather than file-scoped.
//
// SCAN SUBSTRATE RULES: every needle naming a production symbol is assembled
// from fragments, and the double-quote character is spelled as a NUMBER, never
// as a bare CHARACTER literal.
// ===========================================================================

/// The fully-qualified gate call, up to and including its open paren.
fn rb46_gate_call_opener() -> String {
    ["crate::guards::require_not_", "deleting("].concat()
}

/// The bare wrapper name — what an alias, a re-export or a differently-argued
/// sibling all still mention.
fn rb46_gate_bare_name() -> String {
    ["require_not_", "deleting"].concat()
}

/// The ASCII double quote as a one-character `String`, spelled as a NUMBER.
fn rb46_double_quote() -> String {
    char::from(0x22u8).to_string()
}

/// The gate STATEMENT in the two forms rustfmt can produce, spelled for THIS
/// file's stripped view: `strip_rust_strings_economy` KEEPS both quotes and
/// discards the payload, so the reducer tag reads as an empty literal.
///
/// WHICH FORM TO EXPECT. `fn_call_width` (60) bounds the ARGUMENT LIST, not the
/// whole call expression — `raising.rs:680` is an in-tree counter-example, a
/// 67-column call kept inline because its arguments are 52. The widest argument
/// list among this slice's four call sites is 24 columns, so ALL FOUR stay
/// INLINE and the first form below is the expected one (confirmed by running
/// `cargo fmt` over the canonical implementation). The trailing-comma form is
/// accepted purely as future-proofing against a rename long enough to push an
/// argument list past 60.
fn rb46_gate_needles() -> (String, String) {
    let call = rb46_gate_call_opener();
    let dq = rb46_double_quote();
    let blank = [dq.as_str(), dq.as_str()].concat();
    (
        [call.as_str(), "ctx,", blank.as_str(), ")?;"].concat(),
        [call.as_str(), "ctx,", blank.as_str(), ",)?;"].concat(),
    )
}

/// Assert that `fn_name`'s body in `economy.rs` carries the deletion gate exactly
/// once, as a reachable top-level `?`-propagating statement that nothing above it
/// can skip, between `before` and `after`, and above `write`.
///
/// A per-file copy of the `battle_tests.rs` helper of the same name, and
/// deliberately so: every `*_tests.rs` file is a `#[cfg(test)]` submodule of its
/// own production file and none can reach another's bare `fn` items, so sharing
/// would need a new `pub(crate) mod` — the same precedent
/// `content_cache_tests.rs:361-368` records for its own copies of the strippers.
/// The two copies differ in substrate: this one runs on the view where string
/// DELIMITERS survive.
///
/// Not a `#[test]`: it is driven once per gated reducer so each failure names its
/// own reducer. Every clause is required, and NONE may be relaxed to make a build
/// green — a pin that cannot be satisfied is a plan defect, to be re-derived from
/// ADR-0236 D2.
///
/// CLAUSE LETTERS ARE STABLE, WITH ONE GAP. Clause B of the first draft (the
/// qualified-opener count) was deleted as provably implied by A and F: every
/// occurrence of the opener contains the bare name, so `n_opener <= n_bare = 1`,
/// while A forces at least one. The letter is not reused. Clause I is the v2
/// addition and deliberately sits before G, because an unconstrained region above
/// the gate makes every ordering clause after it meaningless.
fn rb46_assert_gate_pinned(fn_name: &str, before: &str, after: &str, write: &str) {
    let stripped = strip_rust_strings_economy(&strip_rust_comments_economy(ECONOMY_SOURCE));
    let bodies = rust_fn_bodies(&stripped);

    // --- Clause 0a: exactly one declaration to scan -------------------------
    let n_decl = bodies
        .iter()
        .filter(|(n, _, _)| n.as_str() == fn_name)
        .count();
    assert_eq!(
        n_decl, 1,
        "rb-46 SCAN PRECONDITION: `economy.rs` declares `{fn_name}` {n_decl} time(s); it \
         must declare it EXACTLY once. With zero the reducer was renamed or removed and \
         every clause below would pass over a body that does not exist; with two the \
         extractor takes the FIRST match, so a decoy definition could carry the gate while \
         the real reducer stays ungated."
    );
    let raw = bodies
        .iter()
        .find(|(n, _, _)| n.as_str() == fn_name)
        .map(|(_, _, body)| body.as_str())
        .unwrap_or_else(|| panic!("rb-46: `{fn_name}` counted 1 but could not be extracted"));

    // `rust_fn_bodies` returns the body INCLUDING its outer braces; strip them so
    // brace depth at the gate is measured relative to the body's top level.
    let compact = compact_ws(raw);
    let body = compact
        .strip_prefix('{')
        .and_then(|inner| inner.strip_suffix('}'))
        .unwrap_or_else(|| {
            panic!(
                "rb-46 SCAN PRECONDITION: the extracted `{fn_name}` body is not brace \
                 delimited, so the extractor sliced the wrong region and every clause below \
                 would read meaningless text."
            )
        });

    // --- Clause 0b: the quote landmine, on the RAW source -------------------
    // Deliberately NOT checked on the body: `strip_rust_strings_economy` discards
    // every string payload, so a body-scoped quote-landmine assertion is
    // tautologically true and proves nothing. The RAW file is the only place that
    // can see the hazard — a char literal holding a double quote is read by that
    // stripper as an opening delimiter, and everything up to the next quote is
    // discarded, silently hollowing out every scan in this file.
    let dq = rb46_double_quote();
    let quote_landmine = ["'", dq.as_str(), "'"].concat();
    assert!(
        !ECONOMY_SOURCE.contains(quote_landmine.as_str()),
        "rb-46 SCAN PRECONDITION: `economy.rs` contains a char literal holding a double \
         quote. This file's strippers have no char lexer, so that quote opens a phantom \
         string literal and the bytes after it are discarded — every needle in this test \
         would then be searching text that no longer exists, and would report a missing gate \
         or a satisfied ordering. Spell the character with a Unicode escape (guards.rs's \
         `json_escape` is the in-tree precedent), or teach the stripper about char literals."
    );

    // --- Clause 0c: the brace landmines, on the body ------------------------
    // A char literal holding a brace SURVIVES the strippers and shifts clause C's
    // depth count by exactly one — enough to make a gate nested inside a
    // never-taken branch report as a top-level statement.
    let brace_landmines = [["'", "{", "'"].concat(), ["'", "}", "'"].concat()];
    for landmine in &brace_landmines {
        assert!(
            !body.contains(landmine.as_str()),
            "rb-46 SCAN PRECONDITION: `{fn_name}` contains the character literal \
             {landmine} , which this file's strippers keep. Its brace desynchronises clause \
             C's depth count by one, which is exactly enough to make a gate nested inside a \
             never-taken branch report as top level. Spell the character with a Unicode \
             escape, or teach the stripper about char literals; never delete this check."
        );
    }

    // --- Clause A: the gate statement is present EXACTLY once ---------------
    let (plain, trailing) = rb46_gate_needles();
    let n_gate = body.matches(plain.as_str()).count() + body.matches(trailing.as_str()).count();
    let head: String = body.chars().take(400).collect();
    assert_eq!(
        n_gate, 1,
        "rb-46 R-m22-s5-X12 FAIL (gate present exactly once): `{fn_name}` contains {n_gate} \
         deletion-gate statement(s) and must contain EXACTLY ONE. \
         ZERO IS THE RED STATE AT HEAD — the gate has not been wired into this reducer yet, \
         so a mid-grace or terminal account can still move currency and items through the \
         shop, into and out of tables the deletion cascade is about to erase. \
         The needle is the FULLY QUALIFIED call ending in `?;`, in either the inline form \
         (what rustfmt produces here) or the trailing-comma form, so an unqualified call \
         reached through an import — which behaves identically at runtime and is therefore \
         invisible to the behavioural test beside this one — reads as ZERO here. That is \
         deliberate: the qualified path cannot be shadowed by an import swap. It also reads \
         ZERO for a call whose verdict is discarded (`let _ = ..;`, `.ok();`), which \
         compiles, lints clean under `-D warnings` and gates nothing. TWO means a duplicated \
         call, under which every ordering clause below anchors on a first hit that a second \
         call can sit behind. Body scanned (first 400 chars) was:\n{head}"
    );

    let gate_at = body
        .find(plain.as_str())
        .or_else(|| body.find(trailing.as_str()))
        .expect("rb-46: the gate statement counted 1 but could not be located");

    // --- Clause C: the gate is at the TOP level of the body ------------------
    let opens = body[..gate_at].matches('{').count();
    let closes = body[..gate_at].matches('}').count();
    assert_eq!(
        opens, closes,
        "rb-46 R-m22-s5-X12 FAIL (unconditional): the deletion gate in `{fn_name}` sits at \
         brace depth {opens} minus {closes}, i.e. INSIDE a nested block, and it must sit at \
         the body's top level. A gate wrapped in `if false`, in a never-satisfied condition, \
         or inside a loop or match arm a real call never enters leaves every text needle in \
         this test satisfied while the reducer decides nothing. This is the shape a \
         whole-body `contains` check cannot see."
    );

    // --- Clause D: the gate is its own statement, not an attributed one ------
    // The character immediately before the statement must be a statement
    // boundary. An attribute leaves a closing square bracket, `let () = ..`
    // leaves an equals sign, `.and(..)` leaves a dot, and a token-swallowing
    // macro leaves an open paren.
    let semi = char::from(0x3Bu8);
    let close_brace = char::from(0x7Du8);
    let prev = body[..gate_at].chars().next_back();
    assert!(
        prev.is_none_or(|c| c == semi || c == close_brace),
        "rb-46 R-m22-s5-X12 FAIL (statement boundary): in `{fn_name}` the deletion gate is \
         preceded by {prev:?}, which is not a statement boundary (a semicolon, a closing \
         brace, or the start of the body). THE CASE THIS EXISTS FOR: a \
         conditional-compilation attribute on the gate statement leaves a closing square \
         bracket here. Under it EVERY test in this crate executes the gate — including the \
         behavioural test beside this one — while the published wasm is compiled WITHOUT it: \
         present in review, absent in production. The same clause kills a discarded binding \
         (an equals sign), a combinator that swallows the verdict (a dot), and a macro that \
         swallows the whole call (an open paren). Re-derive the placement from ADR-0236 D2; \
         never widen this clause."
    );

    // --- Clause E: no conditional compilation anywhere in the body ----------
    // The same two bans `shop-reducer-security` already applies to these two
    // bodies for the headroom checks, restated for the gate.
    let attr_open = ["#", "["].concat();
    let cfg_macro = ["cfg", "!("].concat();
    for (needle, what) in [
        (
            attr_open.as_str(),
            "an attribute — a conditional-compilation attribute on ANY statement here is the \
             deployment-dependent gate described in clause D, reached from further away",
        ),
        (
            cfg_macro.as_str(),
            "the conditional-compilation MACRO — the same defect as the attribute form, \
             expressed as an expression, which clause C would report only as a nested block",
        ),
    ] {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 0,
            "rb-46 R-m22-s5-X12 FAIL (no conditional compilation): `{fn_name}` contains {n} \
             occurrence(s) of {needle} — {what}. Shop guards must compile into every build. \
             Green at HEAD; keep it that way. NOTE that this clause is BODY-scoped and \
             therefore cannot see a conditional compilation switch declared at FILE scope — \
             clause I is what closes that."
        );
    }

    // --- Clause F: exactly ONE mention of the wrapper, by bare name ----------
    let bare = rb46_gate_bare_name();
    let n_bare = body.matches(bare.as_str()).count();
    assert_eq!(
        n_bare, 1,
        "rb-46 R-m22-s5-X12 FAIL (caller-only): `{fn_name}` mentions the deletion-gate \
         wrapper {n_bare} time(s) by BARE NAME and must mention it EXACTLY once. TWO is the \
         third-party gate: a sibling taking an identity argument, called beside the caller \
         gate, points the gate at somebody who is not the caller — and the shipped wrapper \
         takes no identity precisely so that cannot be written (ADR-0227 D2). The \
         behavioural test beside this one cannot see it, because the native host's dummy \
         sender is the only identity that ever calls. ZERO means the qualified call in \
         clause A was matched without the name, which is a scan defect."
    );

    // --- Clause I: every early exit ABOVE the gate is a rejection -----------
    // v2, from a MEASURED red-team bypass. Clauses A-H all constrain the gate
    // statement and what follows it; NOTHING constrained the region above it, and
    // two shapes exploit that while keeping all eight tests green:
    //
    //   (1) the sender-keyed twin — `if me != crate::WILD_IDENTITY { return
    //       buy_inner(ctx, shop_id, item_id, qty, p); }` above the gate. The
    //       native host's sender IS the all-zero identity, so only the harness
    //       ever reaches the gate; every real player is routed around it.
    //   (2) the cfg-const twin — a FILE-SCOPE pair of `#[cfg(debug_assertions)]` /
    //       `#[cfg(not(debug_assertions))]` constants plus `if !RB46_ENFORCE {
    //       return sell_body(..); }` above the gate. Tests build with
    //       debug_assertions; the shipped wasm is built with `--release`. Clause E
    //       is body-scoped and never sees the constant.
    //
    // Both were executed end to end and ran 8/8 green plus a full green suite.
    // The property that kills them: an early exit above a security gate is only
    // ever legitimate as a REJECTION, and a rejection returns an `Err`.
    let return_kw = ["ret", "urn"].concat();
    let return_err = ["ret", "urnErr(e);"].concat();
    let above = &body[..gate_at];
    let n_return = above.matches(return_kw.as_str()).count();
    let n_return_err = above.matches(return_err.as_str()).count();
    assert_eq!(
        n_return, n_return_err,
        "rb-46 R-m22-s5-X12 FAIL (no bypass above the gate): in `{fn_name}` the region above \
         the deletion gate contains {n_return} early exit(s) but only {n_return_err} of them \
         return an Err. Every early exit above a security gate must be a REJECTION; one that \
         returns anything else routes the caller AROUND the gate, and every other clause in \
         this test still passes because the gate statement itself is untouched. TWO MEASURED \
         SHAPES, both of which ran the whole suite green before this clause existed: (1) a \
         sender-keyed twin, which delegates to an inner function for every caller EXCEPT the \
         native host's all-zero dummy sender, so the tests are the only thing that ever \
         reaches the gate; (2) a file-scope conditional-compilation constant pair plus an \
         early return, which the body-scoped clause E cannot see, and which is true in the \
         test build and false in the shipped release wasm. HONEST RESIDUAL, registered in \
         the slice ledger rather than papered over: a `macro_rules!` expanding to a \
         conditional return contains no textual `return` and evades this clause. HONEST \
         LIMIT: a legitimate future guard spelled `return Err(..)` is accepted, but one \
         spelled without a `return` keyword and without `?` cannot exist in a rejecting \
         position, so a failure here is a real early exit — investigate it, never widen the \
         needle to make it green. AT HEAD AND AFTER THE FIX both counts are ZERO in this \
         reducer: nothing above `require_owner` returns at all."
    );

    // --- Clause G: every ordering anchor exists EXACTLY once -----------------
    let anchors: [(&str, &str); 3] = [
        (
            before,
            "the caller-standing guard the gate must follow — standing is established \
             exactly there, so the preamble reads joined, then owner, then not-deleting \
             (ADR-0227 D3)",
        ),
        (
            after,
            "the first input-shape check that must run AFTER the gate",
        ),
        (
            write,
            "the reducer's irreversible effect, the anchor the whole ordering exists to sit \
             above",
        ),
    ];
    for (needle, role) in anchors {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 1,
            "rb-46 R-m22-s5-X12 FAIL (ordering anchor, anti-vacuity): the anchor `{needle}` \
             — {role} — occurs {n} time(s) in `{fn_name}` and must occur EXACTLY once. ZERO \
             makes every ordering clause below unfireable, so the pin would pass over a \
             reducer whose landmark has moved or been renamed; TWO makes the comparison \
             depend on which copy is found first. Note that on this view the reducer tag is \
             blanked, so both shop reducers spell their standing guard identically — which \
             is why the anchor is scoped to ONE body and must never be widened to the file. \
             RE-DERIVE THE PIN AGAINST THE CURRENT BODY AND ADR-0236 D2; never relax it, and \
             never delete an anchor to make this green."
        );
    }
    let before_at = body
        .find(before)
        .expect("rb-46: the before-anchor counted 1 but could not be located");
    let after_at = body
        .find(after)
        .expect("rb-46: the after-anchor counted 1 but could not be located");
    let write_at = body
        .find(write)
        .expect("rb-46: the write-anchor counted 1 but could not be located");

    // --- Clause H: before < gate < after < write ----------------------------
    assert!(
        before_at < gate_at,
        "rb-46 R-m22-s5-X12 FAIL (placement): in `{fn_name}` the deletion gate (offset \
         {gate_at}) runs BEFORE the standing guard `{before}` (offset {before_at}). \
         `require_owner` stays the FIRST call in both shop reducers — `shop-reducer-security` \
         pins it before every spend and grant — and ADR-0227 D3 orders the deletion gate \
         immediately AFTER standing is established, so a caller with no standing is told \
         that, not something about their account lifecycle."
    );
    assert!(
        gate_at < after_at,
        "rb-46 R-m22-s5-X12 FAIL (placement): in `{fn_name}` the deletion gate (offset \
         {gate_at}) runs AFTER `{after}` (offset {after_at}). ADR-0236 D2 places the gate as \
         the first check after standing: a DB read already precedes the quantity check, so \
         the gate opens no NEW pre-check datastore exposure, and the pure check keeps its \
         place relative to every other read. Message precedence then stops depending on the \
         arguments the caller happened to send."
    );
    assert!(
        after_at < write_at,
        "rb-46 R-m22-s5-X12 FAIL (ordering, anti-vacuity): in `{fn_name}` the effect anchor \
         `{write}` (offset {write_at}) precedes `{after}` (offset {after_at}), so the two \
         landmarks this pin orders the gate between are themselves out of order. The body is \
         not the body this pin was derived against — re-derive it, do not renumber it."
    );
    assert!(
        gate_at < write_at,
        "rb-46 R-m22-s5-X12 FAIL (decision before irreversible effect): in `{fn_name}` the \
         deletion gate sits at offset {gate_at}, AFTER the effect at offset {write_at}. A \
         gate that runs once the wallet has been debited or the stack consumed gates \
         nothing: the transaction still rolls back on the reject, but the reducer has \
         already reordered its own guards so that a later refactor — or a partial-failure \
         path — commits value movement for an account that may not open new commitments. \
         The behavioural test beside this one cannot see this: the native host aborts the \
         process on any write syscall, so it never reaches the effect at all. This clause is \
         the only thing that owns the gate-after-write mutant."
    );
}

/// Seed the one `player` row every shop reducer's joined check needs.
///
/// The handle is registered against the SAME fixture the caller's account handle
/// comes from — rows live in the host store, not in the handle, so seeding
/// through a locally-scoped handle is exactly equivalent to seeding through one
/// the test holds. The row is a plain struct literal, which is the house pattern
/// for `Player`: unlike `Account` it has no pure constructor to route through and
/// carries no legal-state invariant to violate.
fn rb46_seed_player(fx: &crate::native_host_tests::Fixture, me: Identity) {
    let players = fx.table::<crate::schema::Player>("player", "identity", |r| r.identity);
    players.seed(&crate::schema::Player {
        identity: me,
        entity_id: 7,
        name: String::new(),
        online: true,
        last_input_seq: 0,
    });
}

/// A mid-grace account row for somebody who is NOT the caller.
///
/// Seeded once per behavioural test and never removed, so the account table is
/// never empty of deleting rows. Without it a TABLE-keyed gate — refuse if
/// ANYBODY is deleting — is observationally identical to the caller-keyed one in
/// all five states, because the fixture would only ever hold the sender's row.
/// `remove` and `find` are `Identity`-keyed, so this row never disturbs the
/// per-state `remove(me) == 1` assertions.
fn rb46_seed_deleting_stranger(
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
) {
    let stranger = Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));
}

/// **R-m22-s5-X12 (behaviour)** — `buy` refuses a deletion-gated caller, ADMITS
/// everybody else, and answers from the CALLER's row.
///
/// The shipped reducer runs under the rb-41 native host through five account
/// states, with the exact verdict pinned in each: no row, `Active`,
/// `PendingDeletion`, `PendingDeletion` + the terminal marker, and row removed.
/// The three admitted states are the positive control, and they are what make the
/// two refused states mean anything at all. A mid-grace STRANGER row is present in
/// every one of the five states (see `rb46_seed_deleting_stranger`), so the
/// admitted states additionally prove the gate keys on `ctx.sender()`.
///
/// WHY THE ADMITTED STATES ERR, and why that is the honest claim. `Fixture::table`
/// keys rows by `Identity` bytes, so the `u32`-keyed shop stock index can never be
/// seeded; an unregistered index yields no rows in this host
/// (`native_host_tests.rs:311-319`), so the stock lookup finds nothing and the
/// reducer stops there — one guard past the gate, and well before any wallet
/// write. Every write syscall ABORTS the process (uncatchable, so
/// `#[should_panic]` is not available here). The RED this test proves is
/// therefore: a deletion-gated caller is ADMITTED past the joined check, past the
/// ownership guard and into content lookup — not that currency changed hands.
/// Ordering relative to the spend is owned by `rb46_buy_carries_the_deletion_gate`.
///
/// The ordinary error is pinned EXACTLY rather than as any-error: without that, a
/// regression in the joined check (which would return a not-joined error instead)
/// would masquerade as a pass in all three admitted states, and the whole positive
/// control would go quietly vacuous.
///
/// The dummy sender is the all-zero identity; nothing in `buy` treats it
/// specially. Account rows are built with the shipped pure constructors only, so
/// this test can never assemble a state the module itself cannot. `seed` PUSHES
/// rather than upserting, so each state removes the previous row and asserts that
/// exactly one row went.
///
/// RED AT HEAD: at HEAD `buy` carries no deletion gate, so the `PendingDeletion`
/// state returns the ordinary next-guard error and the third assertion fails.
///
/// kills:
///   - M2, the dropped `buy` gate (and any later deletion of it).
///   - M5, the discarded verdict `let _ = ..` at the `buy` call site: the two
///     refused states go red exactly as a dropped gate does.
///   - M8, an `if false` wrapper or any other unreachable placement.
///   - M14, a constant reject: the three admitted states fail.
///   - INVERTED POLARITY, invisible to every source pin in this slice: the
///     `Active` and no-row states would return the deletion reject instead, which
///     is a total shop outage for every honest player.
///   - a row-exists-keyed fake (`is_some()` rather than the status test): the
///     `Active` state fails.
///   - A TABLE-WIDE SCAN OR ANY-ROW-PENDING FAKE: the three admitted states fail
///     while the stranger is mid-grace. (Written as a full-table iteration it
///     aborts the process on the unmodelled scan syscall instead — also a
///     failure, and a louder one.)
///   - a latched answer that never returns to admitting: the removed-row state
///     fails.
#[test]
fn rb46_buy_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb46_seed_player(&fx, me);

    let call = || crate::economy::buy(&ctx, 1, 1, 1);

    let ordinary: Result<(), String> = Err("shop 1 does not stock item 1".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb46_seed_deleting_stranger(&acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, no account row): `buy` returned {got:?} \
         for a joined caller with NO account row, while a STRANGER's row is mid-grace. A \
         caller who never authenticated is not inside the deletion gate and must be admitted \
         into the ordinary guard chain; the expected error is the stock lookup's, and pinning \
         it EXACTLY is what stops a regression in the joined check from masquerading as a \
         pass. A deletion reject here means the gate answers from the TABLE rather than from \
         the caller's own row. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row -------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, Active account): `buy` returned {got:?} \
         for a caller whose account row is `Active` (a stranger's row is mid-grace). This is \
         the ordinary player, and refusing them is a TOTAL SHOP OUTAGE that every source pin \
         in this slice would report as correctly gated — the call text is byte-identical \
         whichever way the decision runs. It is also exactly what a row-EXISTS-keyed fake \
         produces, what an any-row-pending TABLE scan produces, and what an inverted branch \
         produces."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `Active` account row was seeded for the CALLER and must \
         be removed before the next state is pushed — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup \
         would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         row is deliberately untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, mid-grace): `buy` returned {got:?} for a \
         caller whose account is `PendingDeletion`; it must return the module's single static \
         deletion reject. THIS IS THE RED STATE AT HEAD — at HEAD `buy` carries no deletion \
         gate, so a mid-grace account can still spend currency into an inventory the cascade \
         is about to erase. The expected value is compared against the CONSTANT, never a \
         re-typed literal, so a reworded reason cannot drift silently into text no client \
         ever receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER \
         and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, terminal): `buy` returned {got:?} for a \
         caller whose account carries the M22 terminal marker. An already-erased account has \
         no wallet and no inventory left — the cascade deleted both — so a purchase here \
         would recreate rows the deletion just removed. The pure decision is an explicit \
         disjunction (`accounts::should_reject_for_deletion`) precisely so this state is \
         fail-closed even on the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one terminal account row was seeded for the CALLER and must \
         be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, row removed): `buy` returned {got:?} once \
         the caller's account row was gone again (the stranger's mid-grace row is still \
         there). The verdict must track LIVE rows FOR THE CALLER: an answer that latches on a \
         row it has already seen — a memoised predicate, a cached decision, a process-wide \
         flag — would keep refusing this identity forever, and an any-row-pending answer \
         would refuse it because of somebody else. No state above can distinguish either of \
         those from a correct gate on its own."
    );
}

/// **R-m22-s5-X12 (behaviour)** — `sell` refuses a deletion-gated caller, ADMITS
/// everybody else, and answers from the CALLER's row.
///
/// The same five-state progression the `buy` test above runs — mid-grace stranger
/// included — applied to `sell`, whose ordinary next-guard error is the
/// item-content lookup's: `item_row` is `u32`-keyed and the fixture keys rows by
/// `Identity`, so the lookup finds nothing and the reducer stops one guard past
/// the gate, before any consume. A separate `#[test]` from `buy` on purpose — the
/// two reducers carry separate call sites, so one dropped gate must fail with a
/// message naming which.
///
/// RED AT HEAD: at HEAD `sell` carries no deletion gate, so the `PendingDeletion`
/// state returns the ordinary next-guard error and the third assertion fails.
///
/// kills: M3 (the dropped `sell` gate) · a discarded verdict at the `sell` call
/// site · an unreachable placement · a constant reject (the three admitted states)
/// · inverted polarity (the `Active` and no-row states) · a row-exists-keyed fake
/// (the `Active` state) · A TABLE-WIDE SCAN OR ANY-ROW-PENDING FAKE (the three
/// admitted states, while the stranger is mid-grace) · a latched answer (the
/// removed-row state). It ALSO kills a gate wired into `buy` only: without this
/// test, half the shop would be gated and the census would be the only witness.
#[test]
fn rb46_sell_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb46_seed_player(&fx, me);

    let call = || crate::economy::sell(&ctx, 1, 1);

    let ordinary: Result<(), String> = Err("unknown item 1".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb46_seed_deleting_stranger(&acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, no account row): `sell` returned {got:?} \
         for a joined caller with NO account row, while a STRANGER's row is mid-grace. A \
         caller who never authenticated is not inside the deletion gate and must be admitted \
         into the ordinary guard chain; the expected error is the item-content lookup's, and \
         pinning it EXACTLY is what stops a regression in the joined check from masquerading \
         as a pass. A deletion reject here means the gate answers from the TABLE rather than \
         from the caller's own row. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row -------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, Active account): `sell` returned {got:?} \
         for a caller whose account row is `Active` (a stranger's row is mid-grace). This is \
         the ordinary player, and refusing them is a TOTAL SHOP OUTAGE that every source pin \
         in this slice would report as correctly gated. It is also what a row-EXISTS-keyed \
         fake produces, what an any-row-pending TABLE scan produces, and what an inverted \
         branch produces — and an inverted gate here would additionally trap value: a player \
         could no longer liquidate an inventory the cascade is about to erase."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `Active` account row was seeded for the CALLER and must \
         be removed before the next state is pushed — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup \
         would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         row is deliberately untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, mid-grace): `sell` returned {got:?} for a \
         caller whose account is `PendingDeletion`; it must return the module's single static \
         deletion reject. THIS IS THE RED STATE AT HEAD — at HEAD `sell` carries no deletion \
         gate, so a mid-grace account can still consume inventory and credit a wallet the \
         cascade is about to erase. The expected value is compared against the CONSTANT, \
         never a re-typed literal, so a reworded reason cannot drift silently into text no \
         client ever receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER \
         and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, terminal): `sell` returned {got:?} for a \
         caller whose account carries the M22 terminal marker. An already-erased account has \
         no inventory and no wallet left, so a sale here would recreate a wallet row the \
         cascade deleted. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even \
         on the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one terminal account row was seeded for the CALLER and must \
         be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, row removed): `sell` returned {got:?} once \
         the caller's account row was gone again (the stranger's mid-grace row is still \
         there). The verdict must track LIVE rows FOR THE CALLER: an answer that latches on a \
         row it has already seen would keep refusing this identity forever, and an \
         any-row-pending answer would refuse it because of somebody else."
    );
}

/// **R-m22-s5-X12 (source pin)** — `buy`'s gate is qualified, reachable,
/// unskippable, unconditional, and sits between the ownership guard and the spend.
///
/// ADR-0236 D2 places it immediately after `require_owner` and before the quantity
/// check: standing (the row exists, the caller owns it) is established exactly
/// there, a DB read already precedes the quantity check, so the preamble reads
/// joined, then owner, then not-deleting (ADR-0227 D3) and the gate opens no new
/// pre-check datastore exposure. `require_owner` stays the FIRST call —
/// `shop-reducer-security` pins it before every spend and grant, and this pin is
/// written to keep that true.
///
/// On the stripped view the reducer tag is blanked to an empty literal, so `buy`
/// and `sell` spell their standing guard identically; every anchor here is
/// therefore scoped to ONE body and must never be widened to the file.
///
/// RED AT HEAD: the gate statement is absent, so clause A fails with a count of
/// zero. Clauses 0a-0c (the declaration count and the landmines), clause E (no
/// conditional compilation) and clause G (all three anchors present exactly once)
/// are GREEN at HEAD by design — they are the fences that keep this pin honest,
/// and a failure in any of them means the body moved out from under it.
///
/// kills: M2 (dropped gate) · M5 (`let _ =` — clause A, since the discarded form
/// does not end `)?;`) · M7 (gate moved below the spend — clause H) · M8
/// (`if false` wrapper — clause C) · M11 (import-shadowed unqualified call —
/// clause A) · M12 (duplicate call — clause A) · M13 (deleted call plus a decoy
/// comment — comments are stripped first) · M15 (`#[cfg(test)]` on the statement —
/// clauses D and E) · M16 (a third-party sibling — clause F) · M17 (a
/// token-swallowing macro — clause D) · the two MEASURED bypass twins above the
/// gate, sender-keyed and cfg-const (clause I).
#[test]
fn rb46_buy_carries_the_deletion_gate() {
    let dq = rb46_double_quote();
    let name = ["b", "uy"].concat();
    let before = [
        "require_",
        "owner(ctx,",
        dq.as_str(),
        dq.as_str(),
        ",p.identity)?;",
    ]
    .concat();
    let after = ["ifqty", "==0"].concat();
    let write = ["spend_", "currency("].concat();
    rb46_assert_gate_pinned(
        name.as_str(),
        before.as_str(),
        after.as_str(),
        write.as_str(),
    );
}

/// **R-m22-s5-X12 (source pin)** — `sell`'s gate is qualified, reachable,
/// unskippable, unconditional, and sits between the ownership guard and the
/// consume.
///
/// Same placement rule as `buy` (ADR-0236 D2), with the effect anchor on the
/// irreversible half of THIS reducer: `consume_one`. The sell side is
/// value-DESTRUCTION with no rollback backstop in the ADR-0124 sense, which is why
/// the ordering clause matters here even though the transaction would roll back a
/// rejected call: a gate below the consume loop is a reducer whose guard order no
/// longer says what it means.
///
/// RED AT HEAD: the gate statement is absent, so clause A fails with a count of
/// zero.
///
/// kills: M3 (dropped gate) · the same clause-for-clause set as
/// `rb46_buy_carries_the_deletion_gate`, applied to the second call site — which
/// is what stops a half-applied fix (gate `buy`, forget `sell`) from shipping with
/// only the census to object.
#[test]
fn rb46_sell_carries_the_deletion_gate() {
    let dq = rb46_double_quote();
    let name = ["se", "ll"].concat();
    let before = [
        "require_",
        "owner(ctx,",
        dq.as_str(),
        dq.as_str(),
        ",p.identity)?;",
    ]
    .concat();
    let after = ["ifqty", "==0"].concat();
    let write = ["consume_", "one("].concat();
    rb46_assert_gate_pinned(
        name.as_str(),
        before.as_str(),
        after.as_str(),
        write.as_str(),
    );
}
