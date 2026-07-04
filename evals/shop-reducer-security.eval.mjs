// shop-reducer-security eval (M13b):
// Verifies the shop buy/sell reducer security invariants in the server-module source:
//   1. BUY_REQUIRE_OWNER  — buy function body contains require_owner before spend_currency
//   2. SELL_REQUIRE_OWNER — sell function body contains require_owner before grant_currency
//   3. NO_PRICE_PARAM     — buy function signature does NOT include a price or total parameter
//   4. SERVER_COMPUTED_TOTAL — buy body looks up buy_price from shop_item_row (not from a
//                              client-supplied parameter); checks for DB lookup pattern
//   5. SHOP_TABLES_PUBLIC — schema.rs has shop_row and shop_item_row with `public`
//
// Proof-of-teeth: each checker is tested against a BAD fixture (must flag) and a GOOD
// fixture (must pass). A checker that fails to flag the bad fixture is reported as a
// TEETH FAILURE, which fails the whole eval.
//
// No new RegExp() — all patterns are literal regex literals (Semgrep detect-non-literal-regexp).
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source stripping helpers (mirrors currency-integrity.eval.mjs)
// ---------------------------------------------------------------------------

/** Strip Rust line and block comments so doc-comment prose doesn't trip scanners. */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Body extractor: find a named function and return its body text (between
// outer braces), or null if not found.
// Mirrors extractReducerBody from battle-reducer-security.eval.mjs.
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
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'shop-reducer-security (M13b: buy/sell require_owner order, no client price param, server DB lookup, shop tables public)';

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

  // Criterion 1: BUY_REQUIRE_OWNER
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

  // Criterion 2: SELL_REQUIRE_OWNER
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

  // Criterion 3: NO_PRICE_PARAM
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

  // Criterion 4: SERVER_COMPUTED_TOTAL
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

  // Criterion 5: SHOP_TABLES_PUBLIC
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

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 5 shop-reducer-security criteria met ' +
      '(buy require_owner before spend, sell require_owner before grant, ' +
      'no client price param, server DB lookup, shop tables public)',
  };
}
