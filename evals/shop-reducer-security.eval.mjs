// shop-reducer-security eval (M13b / m17.5c):
// Verifies the shop buy/sell reducer security invariants in the server-module source:
//   1. BUY_REQUIRE_OWNER  — buy function body contains require_owner before spend_currency
//   2. SELL_REQUIRE_OWNER — sell function body contains require_owner before grant_currency
//   3. NO_PRICE_PARAM     — buy function signature does NOT include a price or total parameter
//   4. SERVER_COMPUTED_TOTAL — buy body looks up buy_price from shop_item_row (not from a
//                              client-supplied parameter); checks for DB lookup pattern
//   5. SHOP_TABLES_PUBLIC — schema.rs has shop_row and shop_item_row with `public`
//   6. BUY_HEADROOM       — buy body calls check_item_headroom( (paren-anchored) before
//                           spend_currency(, with Result propagated (`?`), item_id argument,
//                           inventory() + unwrap_or(0) provenance before headroom,
//                           check_item_headroom(current_count, ...) arg-identity pin, and no
//                           cfg!( or #[cfg in the body (m17.5c-1, F1/F2/F3/F4/F5+ARG-ID)
//   7. SELL_HEADROOM      — sell body calls check_currency_headroom( (paren-anchored) before
//                           consume_one(, with Result propagated (`?`), total argument,
//                           wallet_balance provenance before headroom,
//                           check_currency_headroom(balance, ...) arg-identity pin, and no
//                           cfg!( or #[cfg in the body (m17.5c-2, F1/F2/F3/F4/F5+ARG-ID)
//
// Proof-of-teeth: each checker is tested against BAD fixtures (must flag) and a GOOD
// fixture (must pass). A checker that fails to flag a bad fixture is reported as a
// TEETH FAILURE, which fails the whole eval.
//
// No new RegExp() — all patterns are indexOf / literal regex only (Semgrep detect-non-literal-regexp).
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source stripping helpers (mirrors currency-integrity.eval.mjs)
// ---------------------------------------------------------------------------

/** Strip Rust line and block comments so doc-comment prose doesn't trip scanners. */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Replace Rust double-quoted string literal CONTENTS with "" (red-team F5, m16.5e ADR-0116).
 * Mirrors trade-escrow-guards.eval.mjs::stripRustStrings and
 * server-module/src/trading_tests.rs::strip_rust_strings_trading (RT-SEC-02b).
 *
 * The escape branch matches backslash + ANY char INCLUDING newline (JS `.` excludes
 * newline) because content.rs contains backslash-newline line-continuation strings.
 * With `\\.` those strings fail to match, quote pairing inverts, and whole code
 * regions are swallowed as "strings".
 *
 * Documented residuals: raw strings (r#...#) are not stripped; a block-comment
 * terminator inside a normal string can corrupt comment-then-string ordering (call
 * stripRustComments FIRST, then stripRustStrings).
 *
 * IMPORTANT: apply stripRustComments BEFORE stripRustStrings (comments first so
 * strings inside comments are already blanked and cannot confuse the byte walker).
 */
export function stripRustStrings(src) {
  return src.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
}

/** Strip both comments and string literals in the correct order. */
function stripBoth(src) {
  return stripRustStrings(stripRustComments(src));
}

// ---------------------------------------------------------------------------
// Body extractor: find a named function and return its body text (between
// outer braces), or null if not found.
// Mirrors extractReducerBody from battle-reducer-security.eval.mjs.
//
// IMPORTANT: extractFunctionBody uses ONLY comment-stripping (pre-existing
// behaviour for criteria 1–5 — do NOT change).  Criteria 6 and 7 use
// extractFunctionBodyStripped (comments + strings) via a separate path.
// ---------------------------------------------------------------------------
export function extractFunctionBody(src, fnName) {
  const code = stripRustComments(src);
  // Try `pub fn <name>(` first, then `fn <name>(`.
  let idx = code.indexOf(`pub fn ${fnName}(`);
  if (idx === -1) idx = code.indexOf(`fn ${fnName}(`);
  if (idx === -1) return null;

  // Walk forward to the opening brace of the function body.
  let i = idx;
  while (i < code.length && code[i] !== '{') i++;
  if (i >= code.length) return null;

  // Count braces to find the matching close.
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(start, i - 1);
}

/**
 * Body extractor for criteria 6 and 7 ONLY: strips BOTH comments AND string
 * literal contents before the brace-depth walk (red-team F5).
 *
 * This makes the extractor robust against:
 *   - Format-string braces: `format!("{item_id}")` → `format!("")` (brace-safe)
 *   - Planted literals: `let _hint = "check_item_headroom(...)";` → `let _hint = "";`
 *
 * Pre-existing criteria 1–5 continue to use extractFunctionBody (comment-strip only)
 * so their behaviour is unchanged.
 */
function extractFunctionBodyStripped(src, fnName) {
  const code = stripBoth(src);
  let idx = code.indexOf(`pub fn ${fnName}(`);
  if (idx === -1) idx = code.indexOf(`fn ${fnName}(`);
  if (idx === -1) return null;

  let i = idx;
  while (i < code.length && code[i] !== '{') i++;
  if (i >= code.length) return null;

  let depth = 1;
  const start = i + 1;
  i++;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(start, i - 1);
}

// ---------------------------------------------------------------------------
// Signature extractor: return the text from `fn <name>(` up to the opening
// brace of the body.  Returns null if the function is not found.
// ---------------------------------------------------------------------------
export function extractFunctionSignature(src, fnName) {
  const code = stripRustComments(src);
  let idx = code.indexOf(`pub fn ${fnName}(`);
  if (idx === -1) idx = code.indexOf(`fn ${fnName}(`);
  if (idx === -1) return null;
  const braceIdx = code.indexOf('{', idx);
  if (braceIdx === -1) return null;
  return code.slice(idx, braceIdx);
}

// ---------------------------------------------------------------------------
// Criterion 1: BUY_REQUIRE_OWNER
// require_owner must appear before spend_currency in the buy function body.
//
// Bad fixture: spend_currency appears before require_owner.
// Good fixture: require_owner appears before spend_currency.
// ---------------------------------------------------------------------------

/**
 * Returns true if require_owner appears before spend_currency in the buy body.
 * Returns false if either is absent or if the order is wrong.
 */
export function buyHasRequireOwnerBeforeSpend(src) {
  const body = extractFunctionBody(src, 'buy');
  if (!body) return false;
  const roIdx = body.indexOf('require_owner');
  const spendIdx = body.indexOf('spend_currency');
  if (roIdx === -1 || spendIdx === -1) return false;
  return roIdx < spendIdx;
}

// ---------------------------------------------------------------------------
// Criterion 2: SELL_REQUIRE_OWNER
// require_owner must appear before grant_currency in the sell function body.
//
// Bad fixture: grant_currency appears before require_owner.
// Good fixture: require_owner appears before grant_currency.
// ---------------------------------------------------------------------------

/**
 * Returns true if require_owner appears before grant_currency in the sell body.
 * Returns false if either is absent or if the order is wrong.
 */
export function sellHasRequireOwnerBeforeGrant(src) {
  const body = extractFunctionBody(src, 'sell');
  if (!body) return false;
  const roIdx = body.indexOf('require_owner');
  const grantIdx = body.indexOf('grant_currency');
  if (roIdx === -1 || grantIdx === -1) return false;
  return roIdx < grantIdx;
}

// ---------------------------------------------------------------------------
// Criterion 3: NO_PRICE_PARAM
// The buy function signature must NOT contain a `price` or `total` parameter.
// A client-supplied price would allow price manipulation (EARS-SEC-2).
//
// Bad fixture: `fn buy(ctx, shop_id, item_id, qty, price: u64)`.
// Good fixture: `fn buy(ctx, shop_id, item_id, qty: u32)`.
// ---------------------------------------------------------------------------

/**
 * Returns true if the buy function signature is free of `price` and `total` params.
 * Returns false if a price/total param is found OR if the function is absent.
 */
export function buySignatureHasNoPriceParam(src) {
  const sig = extractFunctionSignature(src, 'buy');
  if (!sig) return false;
  // Check that neither `price` nor `total` appear as identifier names in the
  // parameter list (after comment stripping, already done by extractFunctionSignature
  // via stripRustComments in extractFunctionBody — re-strip for safety).
  return !/\bprice\b/.test(sig) && !/\btotal\b/.test(sig);
}

// ---------------------------------------------------------------------------
// Criterion 4: SERVER_COMPUTED_TOTAL
// The buy body must look up buy_price from the DB (shop_item_row lookup) rather
// than reading it from a parameter. We check for presence of `shop_item_row`
// (the table accessor) OR `buy_price` (the field name from the DB row) inside
// the buy body. A buy_price computed from a parameter would not have the table
// accessor call.
//
// Bad fixture: fn buy(ctx, shop_id, item_id, qty, price: u64) { spend_currency(ctx, sender, price * qty); }
//   — no shop_item_row lookup, no `buy_price` field read.
// Good fixture: fn buy(ctx, shop_id, item_id, qty) { let row = ctx.db.shop_item_row()...; total = row.buy_price * qty; }
//   — contains `shop_item_row` and/or `buy_price`.
// ---------------------------------------------------------------------------

/**
 * Returns true if the buy body accesses the shop_item_row table or reads a
 * buy_price field (indicating server-side price lookup).
 * Returns false if neither pattern appears — implying a client-supplied price path.
 */
export function buyComputesTotalFromDB(src) {
  const body = extractFunctionBody(src, 'buy');
  if (!body) return false;
  // Accept if either the table accessor OR the field name appears in the body.
  return /shop_item_row/.test(body) || /buy_price/.test(body);
}

// ---------------------------------------------------------------------------
// Criterion 5: SHOP_TABLES_PUBLIC
// schema.rs must declare shop_row and shop_item_row with `public`.
// Shop definitions are world-readable content (ADR-0015: public is the
// correct visibility for content tables, private is for player data).
//
// Bad fixture: shop_row declared without `public`.
// Good fixture: `#[spacetimedb::table(name = shop_row, public)]`.
// ---------------------------------------------------------------------------

/**
 * Returns true if the schema source contains both shop_row and shop_item_row
 * declared with the `public` attribute.
 */
export function shopTablesArePublic(schemaSrc) {
  // Look for the SpacetimeDB table attribute pattern for each table.
  // We search for `name = shop_row` followed (within the same attribute) by `public`.
  // Strategy: find the attribute containing `name = shop_row` and check it has `public`.
  const hasShopRow = checkTableIsPublic(schemaSrc, 'shop_row');
  const hasShopItemRow = checkTableIsPublic(schemaSrc, 'shop_item_row');
  return hasShopRow && hasShopItemRow;
}

/**
 * Check whether a named SpacetimeDB table attribute contains `public`.
 * Mirrors walletTableIsPrivate from currency-integrity but asserts the PRESENCE
 * of `public` (shop tables must be public, wallet must not be).
 */
function checkTableIsPublic(schemaSrc, tableName) {
  const needle = `name = ${tableName}`;
  const idx = schemaSrc.indexOf(needle);
  if (idx === -1) return false;
  // Extract the attribute from `#[` before idx to `]` after idx.
  const attrStart = schemaSrc.lastIndexOf('#[', idx);
  const attrEnd = schemaSrc.indexOf(']', idx);
  if (attrStart === -1 || attrEnd === -1) return false;
  const attr = schemaSrc.slice(attrStart, attrEnd + 1);
  const clean = stripRustComments(attr);
  return /\bpublic\b/.test(clean);
}

// ---------------------------------------------------------------------------
// Criterion 6: BUY_HEADROOM (m17.5c-1)
// Uses extractFunctionBodyStripped (comments + strings stripped) to resist F5.
// Paren-anchored needles to resist F3 substring-prefix bypass.
// Provenance pins: inventory() and unwrap_or(0) must appear before headroom call (F1/F2).
// cfg-forbidden: body must not contain cfg!( or #[cfg (F4).
//
// Bad fixture A: check_item_headroom( absent entirely.
// Bad fixture B: check_item_headroom( AFTER spend_currency( (wrong order).
// Bad fixture C: check_item_headroom( present but discarded (no `?`).
// Bad fixture D: hardcoded 0 as first arg, no inventory()/unwrap_or(0) before headroom.
// Bad fixture E: headroom call only inside a "..." string literal (string-stripping test).
// Bad fixture F: check_item_headroom( inside cfg!(test) block (cfg-forbidden).
// Good fixture:  inventory() + unwrap_or(0) → check_item_headroom( → spend_currency(,
//               with `?`, item_id, no cfg.
// ---------------------------------------------------------------------------

/**
 * Returns true if the buy body (comment+string stripped) satisfies ALL of:
 *   - no cfg!( or #[cfg in the body (cfg-forbidden)
 *   - inventory() appears before check_item_headroom( (provenance F1)
 *   - unwrap_or(0) appears before check_item_headroom( (provenance F2)
 *   - check_item_headroom( appears before spend_currency( (paren-anchored, F3)
 *   - the statement window from check_item_headroom( to `;` contains `?`
 *   - the statement window contains `item_id`
 * Returns false on any violation or if any required call is absent.
 */
export function buyHasHeadroomBeforeSpend(src) {
  const body = extractFunctionBodyStripped(src, 'buy');
  if (!body) return false;
  // cfg-forbidden (F4)
  if (body.indexOf('#[cfg') !== -1) return false;
  if (body.indexOf('cfg!(') !== -1) return false;
  // Paren-anchored needles (F3)
  const headroomIdx = body.indexOf('check_item_headroom(');
  const spendIdx = body.indexOf('spend_currency(');
  if (headroomIdx === -1 || spendIdx === -1) return false;
  if (headroomIdx >= spendIdx) return false;
  // Provenance: inventory() and unwrap_or(0) before headroom (F1/F2)
  const inventoryIdx = body.indexOf('inventory()');
  const unwrapOrIdx = body.indexOf('unwrap_or(0)');
  if (inventoryIdx === -1 || inventoryIdx >= headroomIdx) return false;
  if (unwrapOrIdx === -1 || unwrapOrIdx >= headroomIdx) return false;
  // Statement-window: from the headroom call to the first `;` after it.
  const afterHeadroom = body.slice(headroomIdx);
  const semiPos = afterHeadroom.indexOf(';');
  if (semiPos === -1) return false;
  const window = afterHeadroom.slice(0, semiPos + 1);
  if (window.indexOf('?') === -1) return false;
  if (window.indexOf('item_id') === -1) return false;
  // Argument-identity pin (red-team live-mutation: check_item_headroom(0, qty, item_id)).
  // Provenance pins above prove current_count IS read; this pin proves it IS passed as arg 1.
  // A hardcoded-0 first arg always passes (0 + qty <= cap) even at MAX_ITEM_STACK — value
  // destruction: buyer pays but grant_item is silently clamped (ADR-0124).
  if (body.indexOf('check_item_headroom(current_count,') === -1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Criterion 7: SELL_HEADROOM (m17.5c-2)
// Uses extractFunctionBodyStripped (comments + strings stripped) to resist F5.
// Paren-anchored needles to resist F3 substring-prefix bypass.
// Provenance pin: wallet_balance must appear before headroom call (F1/F2).
// cfg-forbidden: body must not contain cfg!( or #[cfg (F4).
//
// Bad fixture A: check_currency_headroom( absent entirely.
// Bad fixture B: check_currency_headroom( AFTER consume_one( (wrong order).
// Bad fixture C: check_currency_headroom( present but discarded (no `?`).
// Bad fixture D: hardcoded 0 as balance arg, no wallet_balance before headroom.
// Bad fixture E: headroom call only inside a "..." string literal (string-stripping test).
// Bad fixture F: check_currency_headroom( inside cfg!(test) block (cfg-forbidden).
// Good fixture:  wallet_balance + checked_mul( → check_currency_headroom( → consume_one(,
//               with `?`, total, no cfg.
// ---------------------------------------------------------------------------

/**
 * Returns true if the sell body (comment+string stripped) satisfies ALL of:
 *   - no cfg!( or #[cfg in the body (cfg-forbidden)
 *   - wallet_balance appears before check_currency_headroom( (provenance F1/F2)
 *   - checked_mul( appears before check_currency_headroom( (W-6 chain)
 *   - check_currency_headroom( appears before consume_one( (paren-anchored, F3)
 *   - the statement window from check_currency_headroom( to `;` contains `?`
 *   - the statement window contains `total`
 * Returns false on any violation or if any required call is absent.
 */
export function sellHasHeadroomBeforeConsume(src) {
  const body = extractFunctionBodyStripped(src, 'sell');
  if (!body) return false;
  // cfg-forbidden (F4)
  if (body.indexOf('#[cfg') !== -1) return false;
  if (body.indexOf('cfg!(') !== -1) return false;
  // Paren-anchored needles (F3)
  const checkedMulIdx = body.indexOf('checked_mul(');
  const headroomIdx = body.indexOf('check_currency_headroom(');
  const consumeIdx = body.indexOf('consume_one(');
  if (checkedMulIdx === -1 || headroomIdx === -1 || consumeIdx === -1) return false;
  if (checkedMulIdx >= headroomIdx) return false;
  if (headroomIdx >= consumeIdx) return false;
  // Provenance: wallet_balance before headroom (F1/F2)
  const walletBalanceIdx = body.indexOf('wallet_balance');
  if (walletBalanceIdx === -1 || walletBalanceIdx >= headroomIdx) return false;
  // Statement-window: from the headroom call to the first `;` after it.
  const afterHeadroom = body.slice(headroomIdx);
  const semiPos = afterHeadroom.indexOf(';');
  if (semiPos === -1) return false;
  const window = afterHeadroom.slice(0, semiPos + 1);
  if (window.indexOf('?') === -1) return false;
  if (window.indexOf('total') === -1) return false;
  // Argument-identity pin (red-team live-mutation: check_currency_headroom(0, total)).
  // Provenance pin above proves balance IS read; this pin proves it IS passed as arg 1.
  // A hardcoded-0 first arg always passes unless total > MAX_BALANCE alone — missing the
  // case where balance is near cap: items destroyed by consume_one with clamped proceeds,
  // no rollback backstop (ADR-0124).
  if (body.indexOf('check_currency_headroom(balance,') === -1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'shop-reducer-security (M13b: buy/sell require_owner order, no client price param, server DB lookup, shop tables public, buy item-headroom before spend with current_count arg-identity, sell currency-headroom before consume with balance arg-identity (m17.5c))';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: each checker must flag the bad fixture.
  // A checker that passes the bad fixture reports TEETH FAILURE (eval fails).
  // -------------------------------------------------------------------------

  // --- Criterion 1: BUY_REQUIRE_OWNER teeth ---

  // Bad: spend_currency called before require_owner.
  const badBuyOrder =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'spend_currency(ctx, ctx.sender, total); require_owner(ctx, "buy", ctx.sender); }';
  if (buyHasRequireOwnerBeforeSpend(badBuyOrder)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_REQUIRE_OWNER): buyHasRequireOwnerBeforeSpend passed on a ' +
        'fixture where spend_currency appears before require_owner — a rogue caller ' +
        'could drain wallets without an ownership check.',
    };
  }

  // Bad: require_owner absent entirely.
  const badBuyNoOwner =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'spend_currency(ctx, ctx.sender, total); }';
  if (buyHasRequireOwnerBeforeSpend(badBuyNoOwner)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_REQUIRE_OWNER): buyHasRequireOwnerBeforeSpend passed on a ' +
        'fixture with NO require_owner call at all.',
    };
  }

  // Good: require_owner before spend_currency.
  const goodBuyOrder =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); spend_currency(ctx, ctx.sender, total); }';
  if (!buyHasRequireOwnerBeforeSpend(goodBuyOrder)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_REQUIRE_OWNER): buyHasRequireOwnerBeforeSpend did not pass on ' +
        'a correct fixture where require_owner appears before spend_currency.',
    };
  }

  // --- Criterion 2: SELL_REQUIRE_OWNER teeth ---

  // Bad: grant_currency called before require_owner.
  const badSellOrder =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'grant_currency(ctx, ctx.sender, total); require_owner(ctx, "sell", ctx.sender); }';
  if (sellHasRequireOwnerBeforeGrant(badSellOrder)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_REQUIRE_OWNER): sellHasRequireOwnerBeforeGrant passed on a ' +
        'fixture where grant_currency appears before require_owner.',
    };
  }

  // Bad: require_owner absent from sell.
  const badSellNoOwner =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasRequireOwnerBeforeGrant(badSellNoOwner)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_REQUIRE_OWNER): sellHasRequireOwnerBeforeGrant passed on a ' +
        'fixture with NO require_owner call.',
    };
  }

  // Good: require_owner before grant_currency.
  const goodSellOrder =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); grant_currency(ctx, ctx.sender, total); }';
  if (!sellHasRequireOwnerBeforeGrant(goodSellOrder)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_REQUIRE_OWNER): sellHasRequireOwnerBeforeGrant did not pass on ' +
        'a correct fixture where require_owner appears before grant_currency.',
    };
  }

  // --- Criterion 3: NO_PRICE_PARAM teeth ---

  // Bad: buy signature contains `price` parameter.
  const badBuyPriceParam =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32, price: u64) { ' +
    'require_owner(ctx, "buy", ctx.sender); spend_currency(ctx, ctx.sender, price * qty as u64); }';
  if (buySignatureHasNoPriceParam(badBuyPriceParam)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (NO_PRICE_PARAM): buySignatureHasNoPriceParam passed on a fixture ' +
        'with `price: u64` in the signature — a client-supplied price enables price manipulation.',
    };
  }

  // Bad: buy signature contains `total` parameter.
  const badBuyTotalParam =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32, total: u64) { ' +
    'require_owner(ctx, "buy", ctx.sender); spend_currency(ctx, ctx.sender, total); }';
  if (buySignatureHasNoPriceParam(badBuyTotalParam)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (NO_PRICE_PARAM): buySignatureHasNoPriceParam passed on a fixture ' +
        'with `total: u64` in the signature — a client-supplied total enables price manipulation.',
    };
  }

  // Good: buy signature has only the correct parameters (no price/total).
  const goodBuyNoPrice =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); spend_currency(ctx, ctx.sender, total); }';
  if (!buySignatureHasNoPriceParam(goodBuyNoPrice)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (NO_PRICE_PARAM): buySignatureHasNoPriceParam did not pass on a ' +
        'correct fixture with no price/total parameter.',
    };
  }

  // --- Criterion 4: SERVER_COMPUTED_TOTAL teeth ---

  // Bad: buy body has no shop_item_row lookup and no buy_price field reference —
  // only uses a client-supplied price parameter.
  const badBuyClientPrice =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32, price: u64) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let total = price * qty as u64; ' +
    'spend_currency(ctx, ctx.sender, total).expect("spend"); }';
  if (buyComputesTotalFromDB(badBuyClientPrice)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SERVER_COMPUTED_TOTAL): buyComputesTotalFromDB passed on a fixture ' +
        'that uses only a client-supplied price (no shop_item_row lookup, no buy_price field) — ' +
        'this allows a client to submit an arbitrary price.',
    };
  }

  // Good: buy body references shop_item_row (DB lookup).
  const goodBuyDBLookup =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let entry = ctx.db.shop_item_row().filter(...); ' +
    'let total = entry.buy_price * qty as u64; ' +
    'spend_currency(ctx, ctx.sender, total).expect("spend"); }';
  if (!buyComputesTotalFromDB(goodBuyDBLookup)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SERVER_COMPUTED_TOTAL): buyComputesTotalFromDB did not pass on a ' +
        'fixture that references shop_item_row and buy_price (correct server-side lookup).',
    };
  }

  // Good: buy body references only buy_price (no explicit shop_item_row accessor name,
  // but the field read implies the row was fetched from the DB).
  const goodBuyPriceField =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = find_shop_stock(ctx, shop_id, item_id)?; ' +
    'let total = row.buy_price * qty as u64; ' +
    'spend_currency(ctx, ctx.sender, total).expect("spend"); }';
  if (!buyComputesTotalFromDB(goodBuyPriceField)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SERVER_COMPUTED_TOTAL): buyComputesTotalFromDB did not pass on a ' +
        'fixture that reads buy_price from a row variable (server-computed total).',
    };
  }

  // --- Criterion 5: SHOP_TABLES_PUBLIC teeth ---

  // Bad: shop_row declared without `public`.
  const badSchemaNoPublic =
    '#[spacetimedb::table(name = shop_row)] pub struct ShopRow { pub shop_id: u32, pub name: String } ' +
    '#[spacetimedb::table(name = shop_item_row)] pub struct ShopItemRow { pub shop_item_id: u64 }';
  if (shopTablesArePublic(badSchemaNoPublic)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SHOP_TABLES_PUBLIC): shopTablesArePublic passed on a fixture where ' +
        'shop_row and shop_item_row have NO `public` attribute — clients would be unable to ' +
        'subscribe to shop data and the shop UI would be empty.',
    };
  }

  // Bad: only shop_row is public (shop_item_row is private).
  const badSchemaMixedPublic =
    '#[spacetimedb::table(name = shop_row, public)] pub struct ShopRow { pub shop_id: u32 } ' +
    '#[spacetimedb::table(name = shop_item_row)] pub struct ShopItemRow { pub shop_item_id: u64 }';
  if (shopTablesArePublic(badSchemaMixedPublic)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SHOP_TABLES_PUBLIC): shopTablesArePublic passed on a fixture where ' +
        'shop_item_row lacks `public` — clients cannot subscribe to shop stock entries.',
    };
  }

  // Good: both tables are public.
  const goodSchemaPublic =
    '#[spacetimedb::table(name = shop_row, public)] pub struct ShopRow { pub shop_id: u32, pub name: String } ' +
    '#[spacetimedb::table(name = shop_item_row, public)] pub struct ShopItemRow { pub shop_item_id: u64, pub shop_id: u32, pub item_id: u32, pub buy_price: u64 }';
  if (!shopTablesArePublic(goodSchemaPublic)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SHOP_TABLES_PUBLIC): shopTablesArePublic did not pass on a correct ' +
        'fixture where both shop_row and shop_item_row have `public`.',
    };
  }

  // --- Criterion 6: BUY_HEADROOM teeth (strengthened m17.5c) ---
  //
  // Good fixture shape (updated for new checker requirements):
  //   - inventory() before headroom (provenance F1)
  //   - unwrap_or(0) before headroom (provenance F2)
  //   - check_item_headroom( (paren-anchored, F3) before spend_currency(
  //   - `?` and item_id in the statement window
  //   - no cfg!( or #[cfg (F4)
  //   - headroom call NOT inside a string literal (F5 — string-stripping)

  // Bad A: check_item_headroom( absent entirely from buy — must flag.
  const badBuyHeadroomAbsent =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let current = ctx.db.inventory().owner_identity().filter(me).find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0); ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyHeadroomAbsent)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-A): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where check_item_headroom( is entirely absent — a buyer at MAX_ITEM_STACK ' +
        'pays currency but the grant_item call is silently clamped (value destruction, ADR-0124).',
    };
  }

  // Bad B: check_item_headroom( AFTER spend_currency( — must flag (wrong order).
  const badBuyHeadroomAfterSpend =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'let current = ctx.db.inventory().owner_identity().filter(me).find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0); ' +
    'check_item_headroom(current, qty, item_id).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyHeadroomAfterSpend)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-B): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where check_item_headroom( appears AFTER spend_currency( — the headroom check must ' +
        'precede the irreversible spend (reject-not-destroy, ADR-0113/ADR-0124).',
    };
  }

  // Bad C: check_item_headroom( present BEFORE spend_currency( but discarded — must flag.
  const badBuyHeadroomDiscarded =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let current = ctx.db.inventory().owner_identity().filter(me).find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0); ' +
    'let _ = check_item_headroom(current, qty, item_id); ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyHeadroomDiscarded)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-C): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where check_item_headroom( is called before spend_currency( but its Result is ' +
        'discarded with `let _ = ...` — a discard silently ignores the cap-exceeded error ' +
        'and allows value destruction to proceed (F4/F12, ADR-0124).',
    };
  }

  // Bad D: hardcoded 0 as first arg to check_item_headroom( with no inventory()/unwrap_or(0)
  // before the headroom call — must flag (provenance F1/F2 bypass).
  // Kills: impl that passes `check_item_headroom(0, qty, item_id)` without reading
  //        the current stack; check_item_headroom(0, qty, item_id) always succeeds at
  //        or below MAX_ITEM_STACK even when the buyer already holds MAX_ITEM_STACK items.
  const badBuyHardcodedZero =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'check_item_headroom(0, qty, item_id).map_err(|e| e.to_string())?; ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyHardcodedZero)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-D): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where check_item_headroom( is called with a hardcoded 0 as the first argument ' +
        'and there is no inventory()/unwrap_or(0) read before the headroom call — ' +
        'check_item_headroom(0, qty, ...) always succeeds (0 + qty <= cap), voids the ' +
        'invariant and allows value destruction at MAX_ITEM_STACK (F1/F2, ADR-0124). ' +
        'Kills: provenance-bypass impl that skips the real inventory read.',
    };
  }

  // Bad E: check_item_headroom( hidden inside a string literal — must flag (F5 string-strip).
  // Kills: impl that plants `let _hint = "check_item_headroom(0, qty, item_id)?;";`
  //        to make a naive source scan pass while never executing the guard.
  const badBuyPlantedString =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let _hint = "check_item_headroom(current, qty, item_id).map_err(|e| e.to_string())?; inventory() unwrap_or(0)"; ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyPlantedString)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-E): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where check_item_headroom( appears ONLY inside a string literal — ' +
        'string-stripping (F5) must blank string contents before needle search; ' +
        'without stripping, a planted literal defeats the raw-source scan. ' +
        'Kills: impl that relies on the needle being visible in a dead-code string.',
    };
  }

  // Bad F: check_item_headroom( inside cfg!(test) block — must flag (cfg-forbidden F4).
  // Kills: impl that wraps the guard in `if cfg!(test) { ... }` making it test-only.
  const badBuyCfgWrapped =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let current = ctx.db.inventory().owner_identity().filter(me).map(|r| r.count).unwrap_or(0); ' +
    'if cfg!(test) { check_item_headroom(current, qty, item_id).map_err(|e| e.to_string())?; } ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyCfgWrapped)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-F): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where check_item_headroom( is wrapped in `if cfg!(test) { ... }` — ' +
        'shop reducer guards must NEVER be conditionally compiled; a cfg-gated guard ' +
        'is skipped in release builds, allowing value destruction at MAX_ITEM_STACK ' +
        '(cfg-forbidden, F4, ADR-0124).',
    };
  }

  // Bad G: inventory()/unwrap_or(0) provenance present BUT hardcoded 0 as first arg —
  // must flag (argument-identity bypass: check_item_headroom(0, qty, item_id)).
  // Kills: impl that reads the count correctly but then passes 0 instead of current_count,
  //        so the cap check always succeeds regardless of how many items the buyer holds.
  const badBuyArgIdentity =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let current_count = ctx.db.inventory().owner_identity().filter(me).find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0); ' +
    'check_item_headroom(0, qty, item_id).map_err(|e| e.to_string())?; ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (buyHasHeadroomBeforeSpend(badBuyArgIdentity)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-G): buyHasHeadroomBeforeSpend passed on a fixture ' +
        'where inventory()/unwrap_or(0) is present (provenance F1/F2 satisfied) BUT ' +
        'check_item_headroom is called with a hardcoded 0 as the first argument instead of ' +
        'current_count — check_item_headroom(0, qty, item_id) always succeeds (0+qty<=cap), ' +
        'so a buyer at MAX_ITEM_STACK pays currency but grant_item is silently clamped ' +
        '(value destruction; argument-identity pin, ADR-0124). ' +
        'Kills: read-then-discard impl that passes 0 not current_count.',
    };
  }

  // Good: inventory() + unwrap_or(0) → check_item_headroom(current_count, ...) → spend_currency(,
  //       with `?`, item_id, no cfg — must pass.
  // Note: variable name MUST be `current_count` (matching the argument-identity pin).
  // String-stripping erases the empty ok_or("") content → ok_or("") which is brace-safe.
  const goodBuyHeadroom =
    'pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "buy", ctx.sender); ' +
    'let row = ctx.db.shop_item_row().filter(item_id).unwrap(); ' +
    'let total = row.buy_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let current_count = ctx.db.inventory().owner_identity().filter(me).find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0); ' +
    'check_item_headroom(current_count, qty, item_id).map_err(|e| e.to_string())?; ' +
    'spend_currency(ctx, ctx.sender, total).map_err(|e| e.to_string())?; ' +
    'grant_item(ctx, ctx.sender, item_id, qty); }';
  if (!buyHasHeadroomBeforeSpend(goodBuyHeadroom)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BUY_HEADROOM-GOOD): buyHasHeadroomBeforeSpend did not pass on a ' +
        'correct fixture with inventory()+unwrap_or(0) before check_item_headroom(current_count, ...) ' +
        'before spend_currency(, with `?` and item_id, no cfg — the checker is too strict and ' +
        'rejects a correct implementation.',
    };
  }

  // --- Criterion 7: SELL_HEADROOM teeth (strengthened m17.5c) ---
  //
  // Good fixture shape (updated for new checker requirements):
  //   - wallet_balance before headroom (provenance F1/F2)
  //   - checked_mul( before check_currency_headroom( (W-6)
  //   - check_currency_headroom( (paren-anchored, F3) before consume_one(
  //   - `?` and total in the statement window
  //   - no cfg!( or #[cfg (F4)

  // Bad A: check_currency_headroom( absent entirely from sell — must flag.
  const badSellHeadroomAbsent =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellHeadroomAbsent)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-A): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where check_currency_headroom( is entirely absent — items are destroyed by consume_one( ' +
        'and grant_currency silently clamps the proceeds (sell-side value destruction, ADR-0124).',
    };
  }

  // Bad B: check_currency_headroom( AFTER consume_one( — must flag (wrong order).
  const badSellHeadroomAfterConsume =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'check_currency_headroom(balance, total).map_err(|e| e.to_string())?; ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellHeadroomAfterConsume)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-B): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where check_currency_headroom( appears AFTER consume_one( — the headroom guard must ' +
        'precede item consumption so items are not destroyed before the cap is checked ' +
        '(reject-not-destroy, no rollback backstop on sell side, ADR-0124).',
    };
  }

  // Bad C: check_currency_headroom( present BEFORE consume_one( but discarded — must flag.
  const badSellHeadroomDiscarded =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'let _ = check_currency_headroom(balance, total); ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellHeadroomDiscarded)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-C): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where check_currency_headroom( is called before consume_one( but its Result is ' +
        'discarded with `let _ = ...` — the cap-exceeded error is silently ignored, ' +
        'items are consumed, and proceeds are clamped (value destruction, F4/F12, ADR-0124).',
    };
  }

  // Bad D: hardcoded 0 as balance arg, no wallet_balance before headroom — must flag (F1/F2).
  // Kills: impl that passes check_currency_headroom(0, total) without reading wallet_balance;
  //        check_currency_headroom(0, total) always succeeds unless total > MAX_BALANCE,
  //        voids the invariant for sellers at or near MAX_BALANCE (items destroyed, ADR-0124).
  const badSellHardcodedZero =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'check_currency_headroom(0, total).map_err(|e| e.to_string())?; ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellHardcodedZero)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-D): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where check_currency_headroom( is called with a hardcoded 0 as the balance argument ' +
        'and there is no wallet_balance read before it — check_currency_headroom(0, total) ' +
        'always succeeds, voids the invariant for sellers near MAX_BALANCE ' +
        '(items destroyed without adequate proceeds, F1/F2, ADR-0124). ' +
        'Kills: provenance-bypass impl that skips the real wallet read.',
    };
  }

  // Bad E: check_currency_headroom( hidden inside a string literal — must flag (F5).
  // Kills: impl that plants a string literal to defeat raw-source needle search.
  const badSellPlantedString =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let _hint = "check_currency_headroom(balance, total).map_err(|e| e.to_string())?; wallet_balance checked_mul("; ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellPlantedString)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-E): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where check_currency_headroom( appears ONLY inside a string literal — ' +
        'string-stripping (F5) must blank string contents before needle search; ' +
        'without stripping, a planted literal defeats the raw-source scan. ' +
        'Kills: impl that relies on the needle being visible in a dead-code string.',
    };
  }

  // Bad F: check_currency_headroom( inside cfg!(test) block — must flag (cfg-forbidden F4).
  const badSellCfgWrapped =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'if cfg!(test) { check_currency_headroom(balance, total).map_err(|e| e.to_string())?; } ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellCfgWrapped)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-F): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where check_currency_headroom( is wrapped in `if cfg!(test) { ... }` — ' +
        'shop reducer guards must NEVER be conditionally compiled; a cfg-gated guard ' +
        'is skipped in release builds, allowing sell-side value destruction (F4, ADR-0124).',
    };
  }

  // Bad G: wallet_balance provenance present BUT hardcoded 0 as first arg —
  // must flag (argument-identity bypass: check_currency_headroom(0, total)).
  // Kills: impl that reads the balance correctly but then passes 0 instead of balance,
  //        so the cap check only catches cases where total alone exceeds MAX_BALANCE,
  //        missing the case where balance is near MAX_BALANCE — items destroyed, ADR-0124.
  const badSellArgIdentity =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'check_currency_headroom(0, total).map_err(|e| e.to_string())?; ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (sellHasHeadroomBeforeConsume(badSellArgIdentity)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-G): sellHasHeadroomBeforeConsume passed on a fixture ' +
        'where wallet_balance is present (provenance F1/F2 satisfied) BUT ' +
        'check_currency_headroom is called with a hardcoded 0 as the first argument instead ' +
        'of balance — check_currency_headroom(0, total) only rejects when total itself exceeds ' +
        'MAX_BALANCE, missing the case where balance is already near the cap: items are destroyed ' +
        'by consume_one with clamped proceeds and no rollback backstop (ADR-0124). ' +
        'Kills: read-then-discard impl that passes 0 not balance.',
    };
  }

  // Good: wallet_balance + checked_mul( → check_currency_headroom(balance, ...) → consume_one(,
  //       with `?`, total, no cfg — must pass.
  // Note: variable name `balance` matches the argument-identity pin.
  const goodSellHeadroom =
    'pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) { ' +
    'require_owner(ctx, "sell", ctx.sender); ' +
    'let row = ctx.db.item_row().filter(item_id).unwrap(); ' +
    'let total = row.sell_price.checked_mul(qty as u64).ok_or("")?; ' +
    'let balance = wallet_balance(ctx, ctx.sender); ' +
    'check_currency_headroom(balance, total).map_err(|e| e.to_string())?; ' +
    'for _ in 0..qty { consume_one(ctx, ctx.sender, item_id)?; } ' +
    'grant_currency(ctx, ctx.sender, total); }';
  if (!sellHasHeadroomBeforeConsume(goodSellHeadroom)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (SELL_HEADROOM-GOOD): sellHasHeadroomBeforeConsume did not pass on a ' +
        'correct fixture with wallet_balance before check_currency_headroom(balance, ...) before ' +
        'consume_one(, with checked_mul(, `?`, total, no cfg — the checker is too strict and ' +
        'rejects a correct implementation.',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source files.
  // -------------------------------------------------------------------------

  let economySrc, schemaSrc;
  try {
    economySrc = readFileSync('server-module/src/economy.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/economy.rs not found' };
  }
  try {
    schemaSrc = readFileSync('server-module/src/schema.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/schema.rs not found' };
  }

  const failures = [];

  // Criterion 1: BUY_REQUIRE_OWNER (uses extractFunctionBody — comment-strip only, unchanged)
  if (!buyHasRequireOwnerBeforeSpend(economySrc)) {
    const body = extractFunctionBody(economySrc, 'buy');
    if (!body) {
      failures.push('BUY_REQUIRE_OWNER: fn buy not found in economy.rs — add the buy reducer');
    } else if (body.indexOf('require_owner') === -1) {
      failures.push(
        'BUY_REQUIRE_OWNER: require_owner not found in buy reducer body — ' +
          'add `require_owner(ctx, "buy", ctx.sender);` as the first call (ADR-0081)',
      );
    } else if (body.indexOf('spend_currency') === -1) {
      failures.push(
        'BUY_REQUIRE_OWNER: spend_currency not found in buy reducer body — ' +
          'the buy reducer must call spend_currency to debit the wallet',
      );
    } else {
      failures.push(
        'BUY_REQUIRE_OWNER: spend_currency appears before require_owner in buy — ' +
          'move require_owner(ctx, "buy", ctx.sender) to be the FIRST call',
      );
    }
  }

  // Criterion 2: SELL_REQUIRE_OWNER (uses extractFunctionBody — unchanged)
  if (!sellHasRequireOwnerBeforeGrant(economySrc)) {
    const body = extractFunctionBody(economySrc, 'sell');
    if (!body) {
      failures.push('SELL_REQUIRE_OWNER: fn sell not found in economy.rs — add the sell reducer');
    } else if (body.indexOf('require_owner') === -1) {
      failures.push(
        'SELL_REQUIRE_OWNER: require_owner not found in sell reducer body — ' +
          'add `require_owner(ctx, "sell", ctx.sender);` as the first call (ADR-0081)',
      );
    } else if (body.indexOf('grant_currency') === -1) {
      failures.push(
        'SELL_REQUIRE_OWNER: grant_currency not found in sell reducer body — ' +
          'the sell reducer must call grant_currency after consuming items',
      );
    } else {
      failures.push(
        'SELL_REQUIRE_OWNER: grant_currency appears before require_owner in sell — ' +
          'move require_owner(ctx, "sell", ctx.sender) to be the FIRST call',
      );
    }
  }

  // Criterion 3: NO_PRICE_PARAM (unchanged)
  if (!buySignatureHasNoPriceParam(economySrc)) {
    const sig = extractFunctionSignature(economySrc, 'buy');
    if (!sig) {
      failures.push('NO_PRICE_PARAM: fn buy not found in economy.rs');
    } else {
      failures.push(
        'NO_PRICE_PARAM: buy reducer signature contains `price` or `total` parameter — ' +
          'remove it; the server must compute the price from shop_item_row (EARS-SEC-2). ' +
          `Signature: ${sig.trim().slice(0, 120)}`,
      );
    }
  }

  // Criterion 4: SERVER_COMPUTED_TOTAL (unchanged)
  if (!buyComputesTotalFromDB(economySrc)) {
    const body = extractFunctionBody(economySrc, 'buy');
    if (!body) {
      failures.push('SERVER_COMPUTED_TOTAL: fn buy not found in economy.rs');
    } else {
      failures.push(
        'SERVER_COMPUTED_TOTAL: buy reducer does not reference shop_item_row or buy_price — ' +
          'the server must look up the price from the DB (not accept it from the client). ' +
          'Add a ctx.db.shop_item_row() lookup and read entry.buy_price.',
      );
    }
  }

  // Criterion 5: SHOP_TABLES_PUBLIC (unchanged)
  if (!shopTablesArePublic(schemaSrc)) {
    const hasSR = schemaSrc.indexOf('name = shop_row') !== -1;
    const hasSIR = schemaSrc.indexOf('name = shop_item_row') !== -1;
    if (!hasSR) {
      failures.push(
        'SHOP_TABLES_PUBLIC: shop_row table not declared in schema.rs — ' +
          'add `#[spacetimedb::table(name = shop_row, public)]`',
      );
    } else if (!checkTableIsPublic(schemaSrc, 'shop_row')) {
      failures.push(
        'SHOP_TABLES_PUBLIC: shop_row is declared in schema.rs but lacks `public` — ' +
          'clients cannot subscribe to shop definitions without `public`',
      );
    }
    if (!hasSIR) {
      failures.push(
        'SHOP_TABLES_PUBLIC: shop_item_row table not declared in schema.rs — ' +
          'add `#[spacetimedb::table(name = shop_item_row, public)]`',
      );
    } else if (!checkTableIsPublic(schemaSrc, 'shop_item_row')) {
      failures.push(
        'SHOP_TABLES_PUBLIC: shop_item_row is declared in schema.rs but lacks `public` — ' +
          'clients cannot subscribe to shop stock without `public`',
      );
    }
  }

  // Criterion 6: BUY_HEADROOM (m17.5c-1)
  // buyHasHeadroomBeforeSpend uses extractFunctionBodyStripped (F5) + paren-anchored
  // needles (F3) + provenance pins (F1/F2) + cfg-forbidden (F4).
  if (!buyHasHeadroomBeforeSpend(economySrc)) {
    const body = extractFunctionBodyStripped(economySrc, 'buy');
    if (!body) {
      failures.push('BUY_HEADROOM (17.5c-1): fn buy not found in economy.rs — add the buy reducer');
    } else if (body.indexOf('#[cfg') !== -1 || body.indexOf('cfg!(') !== -1) {
      failures.push(
        'BUY_HEADROOM (17.5c-1): buy reducer body contains a cfg attribute/macro — ' +
          'shop reducer guards must NEVER be conditionally compiled (cfg-forbidden, F4, ADR-0124)',
      );
    } else if (body.indexOf('check_item_headroom(') === -1) {
      failures.push(
        'BUY_HEADROOM (17.5c-1): check_item_headroom( not found in the buy reducer body — ' +
          'add `check_item_headroom(current, qty, item_id).map_err(|e| e.to_string())?` ' +
          'BEFORE spend_currency( in buy (ADR-0124: reject-not-destroy at receiver item cap; ' +
          'without this guard a buyer at MAX_ITEM_STACK pays but the grant_item is silently clamped). ' +
          'Paren-anchored: a differently-named function with this as a prefix does not qualify (F3)',
      );
    } else if (body.indexOf('inventory()') === -1) {
      failures.push(
        'BUY_HEADROOM (17.5c-1): inventory() not found in the buy reducer body before headroom — ' +
          'read the current stack via ctx.db.inventory() before calling check_item_headroom( ' +
          '(provenance F1: a hardcoded 0 as current_count voids the invariant, ADR-0124)',
      );
    } else if (body.indexOf('unwrap_or(0)') === -1) {
      failures.push(
        'BUY_HEADROOM (17.5c-1): unwrap_or(0) not found in the buy reducer body before headroom — ' +
          'default a missing inventory row to 0 via .unwrap_or(0) before check_item_headroom( ' +
          '(provenance F2: without this, a hardcoded 0 is indistinguishable from a real read, ADR-0124)',
      );
    } else if (body.indexOf('spend_currency(') === -1) {
      failures.push(
        'BUY_HEADROOM (17.5c-1): spend_currency( not found in the buy reducer body — ' +
          'the buy reducer must call spend_currency( to debit the wallet',
      );
    } else {
      const headroomIdx = body.indexOf('check_item_headroom(');
      const spendIdx = body.indexOf('spend_currency(');
      const inventoryIdx = body.indexOf('inventory()');
      const unwrapOrIdx = body.indexOf('unwrap_or(0)');
      if (inventoryIdx >= headroomIdx) {
        failures.push(
          'BUY_HEADROOM (17.5c-1): inventory() (offset ' +
            inventoryIdx +
            ') must appear ' +
            'BEFORE check_item_headroom( (offset ' +
            headroomIdx +
            ') — ' +
            'read the DB before the headroom call (provenance F1, ADR-0124)',
        );
      } else if (unwrapOrIdx >= headroomIdx) {
        failures.push(
          'BUY_HEADROOM (17.5c-1): unwrap_or(0) (offset ' +
            unwrapOrIdx +
            ') must appear ' +
            'BEFORE check_item_headroom( (offset ' +
            headroomIdx +
            ') (provenance F2, ADR-0124)',
        );
      } else if (headroomIdx >= spendIdx) {
        failures.push(
          'BUY_HEADROOM (17.5c-1): check_item_headroom( (offset ' +
            headroomIdx +
            ') appears ' +
            'AFTER spend_currency( (offset ' +
            spendIdx +
            ') in buy — move the headroom check ' +
            'BEFORE spend_currency( (reject-not-destroy: the spend is irreversible, ADR-0124)',
        );
      } else {
        const afterHeadroom = body.slice(headroomIdx);
        const semiPos = afterHeadroom.indexOf(';');
        const window = semiPos !== -1 ? afterHeadroom.slice(0, semiPos + 1) : afterHeadroom;
        if (window.indexOf('?') === -1) {
          failures.push(
            'BUY_HEADROOM (17.5c-1): check_item_headroom( statement in buy does not propagate ' +
              'the Result with `?` — add `.map_err(|e| e.to_string())?` so a cap-exceeded ' +
              'error is returned to the caller (kills silent discard, F4/F12)',
          );
        } else if (window.indexOf('item_id') === -1) {
          failures.push(
            'BUY_HEADROOM (17.5c-1): check_item_headroom( statement in buy does not contain ' +
              '`item_id` — pass the actual item_id variable so the error payload identifies ' +
              'the correct item (not a hardcoded sentinel)',
          );
        } else if (body.indexOf('check_item_headroom(current_count,') === -1) {
          failures.push(
            'BUY_HEADROOM (17.5c-1 ARG-IDENTITY): check_item_headroom( is called but the first ' +
              'argument is not `current_count` — the variable read from inventory()/unwrap_or(0) ' +
              'must be passed directly as arg 1 (not a hardcoded 0). ' +
              'A hardcoded-0 first arg always passes (0+qty<=cap) even at MAX_ITEM_STACK: ' +
              'the buyer pays currency but grant_item is silently clamped (ADR-0124). ' +
              'Fix: `check_item_headroom(current_count, qty, item_id).map_err(|e| e.to_string())?`',
          );
        }
      }
    }
  }

  // Criterion 7: SELL_HEADROOM (m17.5c-2)
  // sellHasHeadroomBeforeConsume uses extractFunctionBodyStripped (F5) + paren-anchored
  // needles (F3) + provenance pin wallet_balance (F1/F2) + cfg-forbidden (F4).
  if (!sellHasHeadroomBeforeConsume(economySrc)) {
    const body = extractFunctionBodyStripped(economySrc, 'sell');
    if (!body) {
      failures.push(
        'SELL_HEADROOM (17.5c-2): fn sell not found in economy.rs — add the sell reducer',
      );
    } else if (body.indexOf('#[cfg') !== -1 || body.indexOf('cfg!(') !== -1) {
      failures.push(
        'SELL_HEADROOM (17.5c-2): sell reducer body contains a cfg attribute/macro — ' +
          'shop reducer guards must NEVER be conditionally compiled (cfg-forbidden, F4, ADR-0124)',
      );
    } else if (body.indexOf('check_currency_headroom(') === -1) {
      failures.push(
        'SELL_HEADROOM (17.5c-2): check_currency_headroom( not found in the sell reducer body — ' +
          'add `check_currency_headroom(balance, total).map_err(|e| e.to_string())?` ' +
          'BEFORE consume_one( in sell (ADR-0124: reject-not-destroy; sell-side is value-DESTRUCTION ' +
          'with no rollback backstop — grant_currency is infallible and silently clamps). ' +
          'Paren-anchored: a differently-named function with this as a prefix does not qualify (F3)',
      );
    } else if (body.indexOf('wallet_balance') === -1) {
      failures.push(
        'SELL_HEADROOM (17.5c-2): wallet_balance not found in the sell reducer body before headroom — ' +
          'read the current balance via wallet_balance() before calling check_currency_headroom( ' +
          '(provenance F1/F2: a hardcoded 0 as balance voids the invariant; ' +
          'wallet_balance is the sole sanctioned balance read, ADR-0081/ADR-0124)',
      );
    } else if (body.indexOf('consume_one(') === -1) {
      failures.push(
        'SELL_HEADROOM (17.5c-2): consume_one( not found in the sell reducer body — ' +
          'the sell reducer must call consume_one( to remove items from inventory',
      );
    } else if (body.indexOf('checked_mul(') === -1) {
      failures.push(
        'SELL_HEADROOM (17.5c-2): checked_mul( not found in the sell reducer body — ' +
          '`total` must be computed via checked_mul( before the headroom call (W-6 chain: ' +
          'overflow is rejected first as defense-in-depth, F10)',
      );
    } else {
      const walletBalanceIdx = body.indexOf('wallet_balance');
      const checkedMulIdx = body.indexOf('checked_mul(');
      const headroomIdx = body.indexOf('check_currency_headroom(');
      const consumeIdx = body.indexOf('consume_one(');
      if (walletBalanceIdx >= headroomIdx) {
        failures.push(
          'SELL_HEADROOM (17.5c-2): wallet_balance (offset ' +
            walletBalanceIdx +
            ') must appear ' +
            'BEFORE check_currency_headroom( (offset ' +
            headroomIdx +
            ') — ' +
            'read the real balance before the headroom call (provenance F1/F2, ADR-0124)',
        );
      } else if (checkedMulIdx >= headroomIdx) {
        failures.push(
          'SELL_HEADROOM (17.5c-2): checked_mul( (offset ' +
            checkedMulIdx +
            ') must appear ' +
            'BEFORE check_currency_headroom( (offset ' +
            headroomIdx +
            ') — ' +
            '`total` must exist before the headroom call (W-6)',
        );
      } else if (headroomIdx >= consumeIdx) {
        failures.push(
          'SELL_HEADROOM (17.5c-2): check_currency_headroom( (offset ' +
            headroomIdx +
            ') appears ' +
            'AFTER consume_one( (offset ' +
            consumeIdx +
            ') in sell — move the headroom check ' +
            'BEFORE consume_one( (without this guard items are destroyed before the cap is checked, ADR-0124)',
        );
      } else {
        const afterHeadroom = body.slice(headroomIdx);
        const semiPos = afterHeadroom.indexOf(';');
        const window = semiPos !== -1 ? afterHeadroom.slice(0, semiPos + 1) : afterHeadroom;
        if (window.indexOf('?') === -1) {
          failures.push(
            'SELL_HEADROOM (17.5c-2): check_currency_headroom( statement in sell does not ' +
              'propagate the Result with `?` — add `.map_err(|e| e.to_string())?` so a ' +
              'cap-exceeded error is returned before items are consumed (F4/F12, ADR-0124)',
          );
        } else if (window.indexOf('total') === -1) {
          failures.push(
            'SELL_HEADROOM (17.5c-2): check_currency_headroom( statement in sell does not ' +
              'contain `total` — pass the checked_mul( product as the `incoming` argument ' +
              '(not a literal 0 or other sentinel)',
          );
        } else if (body.indexOf('check_currency_headroom(balance,') === -1) {
          failures.push(
            'SELL_HEADROOM (17.5c-2 ARG-IDENTITY): check_currency_headroom( is called but the ' +
              'first argument is not `balance` — the variable read from wallet_balance() must be ' +
              'passed directly as arg 1 (not a hardcoded 0). ' +
              'A hardcoded-0 first arg only rejects when total alone exceeds MAX_BALANCE, ' +
              'missing the case where balance is near the cap: items are destroyed by consume_one ' +
              'with clamped proceeds and no rollback backstop (ADR-0124). ' +
              'Fix: `check_currency_headroom(balance, total).map_err(|e| e.to_string())?`',
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 7 shop-reducer-security criteria met ' +
      '(buy require_owner before spend, sell require_owner before grant, ' +
      'no client price param, server DB lookup, shop tables public, ' +
      'buy check_item_headroom(current_count, before spend_currency( with ?+item_id+inventory()+unwrap_or(0)+arg-identity+no-cfg (m17.5c), ' +
      'sell check_currency_headroom(balance, before consume_one( with ?+total+wallet_balance+arg-identity+no-cfg (m17.5c))',
  };
}
