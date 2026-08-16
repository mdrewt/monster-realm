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

    let mut wallet_fns_in_economy = 0usize;
    let mut wallet_fns_in_schema = 0usize;

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

            assert!(
                !body.contains(delete_pat.as_str()),
                "TEETH(ux2 ADR-0154 R2): `{}` in {} touches `{}` AND contains `{}` — \
                 player_wallet rows must NEVER be deleted. The client's wallet slot is \
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
