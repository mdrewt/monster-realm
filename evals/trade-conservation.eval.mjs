// trade-conservation eval (M15c+M16.5b+M17.5b, ADR-0108/0113/0123):
// Verifies TR-16 conservation invariants in the `confirm_trade` reducer — the
// atomic swap must transfer ALL assets in a symmetric debit/credit pair (no
// duplication, no destruction) and delete the offer row at the end (no stuck escrow).
//
// Criteria (all scoped to the confirm_trade function body):
//   DUAL_WRITE       — both monster and monster_pub are updated (public projection sync)
//   ITEM_CONSUME     — consume_one is called (item debit from source party)
//   ITEM_GRANT       — grant_item is called (item credit to destination party)
//   CURRENCY_SPEND   — spend_currency is called (currency debit from source party)
//   CURRENCY_GRANT   — grant_currency is called (currency credit to destination party)
//   ROW_DELETION     — trade_offer row is deleted at the end (escrow released, TR-16 D5)
//   HEADROOM_CHECK   — check_headroom called (reject-not-clamp, ADR-0113)
//   APPLY_ORDER      — for step in plan.ordered_steps() loop (debits-before-credits, ADR-0123)
//
// Proof-of-teeth: each "conservation break" fixture (grant without take, or
// take without grant) is the adversarial exploitation scenario; it must flag.
//
// No new RegExp() — all patterns are literal regex literals or indexOf checks.
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function extractFunctionBody(rawSrc, fnName) {
  const src = stripRustComments(rawSrc);
  let idx = src.indexOf(`pub fn ${fnName}(`);
  if (idx === -1) idx = src.indexOf(`fn ${fnName}(`);
  if (idx === -1) return null;
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

// ---------------------------------------------------------------------------
// Criterion: DUAL_WRITE
// confirm_trade must update BOTH monster AND monster_pub after changing ownership.
// Missing the monster_pub write leaves the public projection stale (counterparty
// sees the old owner in monster_pub table until the next external trigger).
// bad fixture: updates only monster, not monster_pub → must flag.
// good fixture: updates both → must not flag.
// ---------------------------------------------------------------------------
function hasMonsterUpdate(body) {
  const code = stripRustComments(body);
  return /ctx\.db\.monster\(\)\.monster_id\(\)\.update\s*\(/.test(code);
}

function hasMonsterPubUpdate(body) {
  const code = stripRustComments(body);
  return /ctx\.db\.monster_pub\(\)\.monster_id\(\)\.update\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: ITEM_CONSUME + ITEM_GRANT
// confirm_trade must call consume_one (debit) AND grant_item (credit) for each
// item transfer. A grant without consume = item duplication; a consume without
// grant = item destruction. Either is a conservation failure.
// ---------------------------------------------------------------------------
function hasConsumeOne(body) {
  const code = stripRustComments(body);
  return /consume_one\s*\(/.test(code);
}

function hasGrantItem(body) {
  const code = stripRustComments(body);
  return /grant_item\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: CURRENCY_SPEND + CURRENCY_GRANT
// confirm_trade must call spend_currency (debit) AND grant_currency (credit).
// A grant without spend = currency printing; a spend without grant = currency burn.
// ---------------------------------------------------------------------------
function hasSpendCurrency(body) {
  const code = stripRustComments(body);
  return /spend_currency\s*\(/.test(code);
}

function hasGrantCurrency(body) {
  const code = stripRustComments(body);
  return /grant_currency\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: ROW_DELETION (TR-16 D5)
// confirm_trade must delete the trade_offer row after a successful swap.
// Without deletion: the offer row persists, locking all escrowed assets forever
// (offer guard still fires; the assets can never be used again).
// ---------------------------------------------------------------------------
function hasRowDeletion(body) {
  const code = stripRustComments(body);
  return /\.trade_offer\(\)\.trade_id\(\)\.delete\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: HEADROOM_CHECK (16.5b-1, ADR-0113)
// confirm_trade must call check_headroom before build_swap_plan to reject any
// trade where a receiver's item stack would exceed MAX_ITEM_STACK or their
// currency balance would exceed MAX_BALANCE. Without this call, grant_item /
// grant_currency clamp silently, destroying excess value with no Err returned.
// bad fixture: omits check_headroom → must flag.
// good fixture: includes check_headroom call → must pass.
// ---------------------------------------------------------------------------
function hasHeadroomCheck(body) {
  const code = stripRustComments(body);
  return /check_headroom\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: APPLY_ORDER (17.5b-1, ADR-0123 — debits-before-credits ordering)
//
// Strip Rust string literals from `src` (after comment stripping).
// Replaces content between unescaped `"…"` delimiters with nothing.
//
// IMPORTANT: call AFTER stripRustComments so that string-like content
// inside already-blanked comments does not trip up the byte walker.
//
// Mirrors trading_tests.rs `strip_rust_strings_trading` exactly.
// Handles escape sequences (backslash + next char consumed as one unit).
//
// Prior-slice trap (M16.5e): backslash-newline continuation — the escape
// handler consumes both bytes, so a `\<newline>` inside a string literal
// is swallowed correctly and does not leave a dangling `"` to confuse the
// outer loop.
//
// No new RegExp() — this is a character-by-character byte walker.
// ---------------------------------------------------------------------------
function stripRustStrings(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      out.push('"');
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          // Escape sequence: skip both the backslash and the next character.
          i += 2;
        } else if (src[i] === '"') {
          out.push('"');
          i++;
          break;
        } else {
          // Swallow — replace with nothing (shrinks output).
          i++;
        }
      }
    } else {
      out.push(src[i]);
      i++;
    }
  }
  return out.join('');
}

/** Remove all whitespace for fmt-proof needle matching (`cargo fmt` must not flip any gate). */
function normalizeWs(s) {
  return s.replace(/\s/g, '');
}

/**
 * Check the APPLY_ORDER criterion against `tradingSrc` (the raw trading.rs source).
 *
 * Runs teeth self-checks first (bad/good fixtures), then checks the real source.
 * Returns { pass: true, detail } or { pass: false, detail }.
 *
 * POSITIVE:  whitespace-normalized confirm_trade body contains `inplan.ordered_steps()`
 *            — kills the `let _ = plan.ordered_steps()` discard pattern.
 * NEGATIVE:  normalized body does NOT contain legacy loop needles
 *            `in&plan.item_transfers` / `inplan.item_transfers` /
 *            `in&plan.currency_transfers` / `inplan.currency_transfers`
 *            — kills a shadow or split legacy loop kept alongside ordered_steps.
 *
 * All needles are literal string indexOf checks — no new RegExp().
 */
function checkApplyOrder(tradingSrc) {
  // Normalized needles — built with concatenation to prevent self-match in this file.
  const POS_NEEDLE = 'in' + 'plan.ordered_steps()';
  const NEG_ITEM_REF = 'in' + '&plan.item_transfers';
  const NEG_ITEM_PLAIN = 'in' + 'plan.item_transfers';
  const NEG_CURRENCY_REF = 'in' + '&plan.currency_transfers';
  const NEG_CURRENCY_PLAIN = 'in' + 'plan.currency_transfers';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: bad fixtures must fail; good fixture must pass.
  // These checks are near the top so a broken eval self-reports as TEETH FAILED.
  // -------------------------------------------------------------------------

  // BAD FIXTURE (i): discard + old loops.
  // `let _ = plan.ordered_steps()` discards; body falls back to legacy loops.
  // Positive check must FAIL (no loop-consumption of ordered_steps).
  // Negative needles must be PRESENT (teeth bite on the legacy loops).
  const discardFixture = [
    'fn confirm_trade(ctx, trade_id) {',
    '    let _ = plan.ordered_steps();',
    '    for xfer in &plan.item_transfers { consume_one(ctx, from, xfer.item_id)?; grant_item(ctx, to, xfer.item_id, xfer.qty); }',
    '    for xfer in &plan.currency_transfers { spend_currency(ctx, from, xfer.amount)?; grant_currency(ctx, to, xfer.amount); }',
    '    Ok(())',
    '}',
    'fn cancel_trade() {}',
  ].join('\n');
  const discardNorm = normalizeWs(stripRustStrings(stripRustComments(discardFixture)));
  if (discardNorm.includes(POS_NEEDLE)) {
    return {
      pass: false,
      detail:
        'TEETH FAILED: discard fixture (let _ = plan.ordered_steps()) should NOT contain the ' +
        'loop-consumption needle "' +
        POS_NEEDLE +
        '" — the discard pattern must fail the positive check',
    };
  }
  if (!discardNorm.includes(NEG_ITEM_REF)) {
    return {
      pass: false,
      detail:
        'TEETH FAILED: discard fixture must contain legacy needle "' +
        NEG_ITEM_REF +
        '" so the negative check has something to bite',
    };
  }

  // BAD FIXTURE (ii): split debit-loop / credit-loop (no unified ordered_steps).
  // Two separate loops — debits-first reorder but NOT using ordered_steps.
  // Positive check must FAIL. Legacy needles must be PRESENT.
  const splitFixture = [
    'fn confirm_trade(ctx, trade_id) {',
    '    for xfer in &plan.item_transfers { consume_one(ctx, from, xfer.item_id)?; }',
    '    for xfer in &plan.currency_transfers { spend_currency(ctx, from, xfer.amount)?; }',
    '    for xfer in &plan.item_transfers { grant_item(ctx, to, xfer.item_id, xfer.qty); }',
    '    for xfer in &plan.currency_transfers { grant_currency(ctx, to, xfer.amount); }',
    '    Ok(())',
    '}',
    'fn cancel_trade() {}',
  ].join('\n');
  const splitNorm = normalizeWs(stripRustStrings(stripRustComments(splitFixture)));
  if (splitNorm.includes(POS_NEEDLE)) {
    return {
      pass: false,
      detail:
        'TEETH FAILED: split debit-loop/credit-loop fixture should NOT contain ' +
        '"' +
        POS_NEEDLE +
        '" — split loops must fail the positive check',
    };
  }
  if (!splitNorm.includes(NEG_ITEM_REF)) {
    return {
      pass: false,
      detail:
        'TEETH FAILED: split fixture must contain legacy needle "' +
        NEG_ITEM_REF +
        '" to validate the negative check teeth',
    };
  }

  // GOOD FIXTURE: single `for step in plan.ordered_steps()` match loop, no legacy loops.
  const goodFixture = [
    'fn confirm_trade(ctx, trade_id) {',
    '    let plan = build_swap_plan(&i_live, &c_live, &offer.initiator_items, &offer.counterparty_items, 0, 0)?;',
    '    for step in plan.ordered_steps() {',
    '        match step {',
    '            ApplyStep::ItemDebit { from_initiator, item_id, qty } => { consume_one(ctx, from, item_id)?; }',
    '            ApplyStep::CurrencyDebit { from_initiator, amount } => { spend_currency(ctx, from, amount)?; }',
    '            ApplyStep::ItemCredit { to_initiator, item_id, qty } => { grant_item(ctx, to, item_id, qty); }',
    '            ApplyStep::CurrencyCredit { to_initiator, amount } => { grant_currency(ctx, to, amount); }',
    '        }',
    '    }',
    '    Ok(())',
    '}',
    'fn cancel_trade() {}',
  ].join('\n');
  const goodNorm = normalizeWs(stripRustStrings(stripRustComments(goodFixture)));
  if (!goodNorm.includes(POS_NEEDLE)) {
    return {
      pass: false,
      detail:
        'TEETH FAILED: good fixture must contain the loop-consumption needle "' +
        POS_NEEDLE +
        '" after normalization',
    };
  }
  if (
    goodNorm.includes(NEG_ITEM_REF) ||
    goodNorm.includes(NEG_ITEM_PLAIN) ||
    goodNorm.includes(NEG_CURRENCY_REF) ||
    goodNorm.includes(NEG_CURRENCY_PLAIN)
  ) {
    return {
      pass: false,
      detail:
        'TEETH FAILED: good fixture must NOT contain any legacy loop needle ' +
        '(in&plan.item_transfers / inplan.item_transfers / in&plan.currency_transfers / inplan.currency_transfers)',
    };
  }

  // -------------------------------------------------------------------------
  // Real source check (expected RED until Phase C implemented).
  // -------------------------------------------------------------------------
  const noComments = stripRustComments(tradingSrc);
  const noStrings = stripRustStrings(noComments);

  // Extract confirm_trade body (bounded by cancel_trade).
  const confirmFn = 'fn ' + 'confirm_trade(';
  const cancelFn = 'fn ' + 'cancel_trade(';
  const fnIdx = noStrings.indexOf(confirmFn);
  if (fnIdx === -1) {
    return { pass: false, detail: 'APPLY_ORDER: confirm_trade not found in trading.rs' };
  }
  const cancelIdx = noStrings.indexOf(cancelFn, fnIdx);
  const bodyEnd = cancelIdx === -1 ? noStrings.length : cancelIdx;
  const body = noStrings.slice(fnIdx, bodyEnd);
  const norm = normalizeWs(body);

  const applyFailures = [];

  // POSITIVE: loop-consumption of ordered_steps().
  if (!norm.includes(POS_NEEDLE)) {
    applyFailures.push(
      'APPLY_ORDER (POSITIVE, 17.5b-1/ADR-0123): confirm_trade does not contain the ' +
        'loop-consumption form "' +
        POS_NEEDLE +
        '" (whitespace-normalized after comment+string stripping). ' +
        'The debits-before-credits ordering contract requires a single ' +
        '`for step in plan.ordered_steps()` loop replacing the separate ' +
        'item_transfers / currency_transfers loops. ' +
        'A `let _ = plan.ordered_steps()` discard also fails this check. ' +
        'Fix: replace the item + currency apply loops with `for step in plan.ordered_steps()` ' +
        'and an exhaustive match dispatching to consume_one/spend_currency/grant_item/grant_currency.',
    );
  }

  // NEGATIVE: legacy loops must be absent.
  if (norm.includes(NEG_ITEM_REF)) {
    applyFailures.push(
      'APPLY_ORDER (NEGATIVE): confirm_trade contains legacy needle "' +
        NEG_ITEM_REF +
        '" — shadow or split loop over item_transfers still exists. Remove all iteration over plan.item_transfers.',
    );
  }
  if (norm.includes(NEG_ITEM_PLAIN)) {
    applyFailures.push(
      'APPLY_ORDER (NEGATIVE): confirm_trade contains legacy needle "' +
        NEG_ITEM_PLAIN +
        '" — remove all iteration over plan.item_transfers.',
    );
  }
  if (norm.includes(NEG_CURRENCY_REF)) {
    applyFailures.push(
      'APPLY_ORDER (NEGATIVE): confirm_trade contains legacy needle "' +
        NEG_CURRENCY_REF +
        '" — remove all iteration over plan.currency_transfers.',
    );
  }
  if (norm.includes(NEG_CURRENCY_PLAIN)) {
    applyFailures.push(
      'APPLY_ORDER (NEGATIVE): confirm_trade contains legacy needle "' +
        NEG_CURRENCY_PLAIN +
        '" — remove all iteration over plan.currency_transfers.',
    );
  }

  if (applyFailures.length > 0) {
    return { pass: false, detail: applyFailures.join('; ') };
  }

  return { pass: true, detail: 'APPLY_ORDER: ordered_steps loop present, no legacy loops' };
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'trade-conservation (M15c+M16.5b+M17.5b, ADR-0108/0113/0123: TR-16 dual-write + item consume+grant + currency spend+grant + row deletion + headroom check + apply-order ordered_steps in confirm_trade)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: conservation-break fixtures (adversarial scenarios)
  // -------------------------------------------------------------------------

  // DUAL_WRITE: updating only monster (not monster_pub) must flag.
  const badDualWrite =
    'fn confirm_trade(ctx, trade_id) { ctx.db.monster().monster_id().update(m); /* missing monster_pub */ Ok(()) }';
  if (!hasMonsterUpdate(badDualWrite)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasMonsterUpdate did not detect ctx.db.monster().monster_id().update(',
    };
  }
  if (hasMonsterPubUpdate(badDualWrite)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasMonsterPubUpdate should NOT pass on fixture missing monster_pub update',
    };
  }
  const goodDualWrite =
    'fn confirm_trade(ctx, trade_id) { ctx.db.monster().monster_id().update(m); ctx.db.monster_pub().monster_id().update(mp); Ok(()) }';
  if (!hasMonsterPubUpdate(goodDualWrite)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasMonsterPubUpdate did not detect ctx.db.monster_pub().monster_id().update(',
    };
  }

  // ITEM: grant without consume = duplication exploit.
  const badItemGrant =
    'fn confirm_trade(ctx, trade_id) { grant_item(ctx, to, item_id, qty); /* no consume_one */ Ok(()) }';
  if (!hasGrantItem(badItemGrant)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasGrantItem did not detect grant_item call',
    };
  }
  if (hasConsumeOne(badItemGrant)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasConsumeOne should NOT pass on fixture with only grant_item (no consume_one)',
    };
  }

  // ITEM: consume without grant = item destruction.
  const badItemConsume =
    'fn confirm_trade(ctx, trade_id) { consume_one(ctx, from, item_id)?; /* no grant_item */ Ok(()) }';
  if (!hasConsumeOne(badItemConsume)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasConsumeOne did not detect consume_one call',
    };
  }
  if (hasGrantItem(badItemConsume)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasGrantItem should NOT pass on fixture with only consume_one (no grant_item)',
    };
  }

  // ITEM: good fixture has both.
  const goodItem =
    'fn confirm_trade(ctx, trade_id) { consume_one(ctx, from, item_id)?; grant_item(ctx, to, item_id, qty); Ok(()) }';
  if (!hasConsumeOne(goodItem) || !hasGrantItem(goodItem)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: good item fixture must have both consume_one and grant_item',
    };
  }

  // CURRENCY: grant without spend = currency printing exploit.
  const badCurrencyGrant =
    'fn confirm_trade(ctx, trade_id) { grant_currency(ctx, to, amount); /* no spend_currency */ Ok(()) }';
  if (!hasGrantCurrency(badCurrencyGrant)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasGrantCurrency did not detect grant_currency call',
    };
  }
  if (hasSpendCurrency(badCurrencyGrant)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasSpendCurrency should NOT pass on fixture with only grant_currency (no spend_currency)',
    };
  }

  // CURRENCY: spend without grant = currency burn.
  const badCurrencySpend =
    'fn confirm_trade(ctx, trade_id) { spend_currency(ctx, from, amount)?; /* no grant_currency */ Ok(()) }';
  if (!hasSpendCurrency(badCurrencySpend)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasSpendCurrency did not detect spend_currency call',
    };
  }
  if (hasGrantCurrency(badCurrencySpend)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasGrantCurrency should NOT pass on fixture with only spend_currency (no grant_currency)',
    };
  }

  // CURRENCY: good fixture has both.
  const goodCurrency =
    'fn confirm_trade(ctx, trade_id) { spend_currency(ctx, from, amount)?; grant_currency(ctx, to, amount); Ok(()) }';
  if (!hasSpendCurrency(goodCurrency) || !hasGrantCurrency(goodCurrency)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: good currency fixture must have both spend_currency and grant_currency',
    };
  }

  // ROW_DELETION: missing deletion = stuck escrow / can re-confirm.
  const badNoDeletion =
    'fn confirm_trade(ctx, trade_id) { spend_currency(ctx, from, amount)?; grant_currency(ctx, to, amount); Ok(()) }';
  if (hasRowDeletion(badNoDeletion)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasRowDeletion should NOT pass on fixture missing .trade_offer().trade_id().delete(',
    };
  }
  const goodDeletion =
    'fn confirm_trade(ctx, trade_id) { ctx.db.trade_offer().trade_id().delete(trade_id); Ok(()) }';
  if (!hasRowDeletion(goodDeletion)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasRowDeletion did not detect .trade_offer().trade_id().delete( in fixture',
    };
  }

  // HEADROOM_CHECK: omitting check_headroom = silent cap-clamping value destruction.
  const badNoHeadroom =
    'fn confirm_trade(ctx, trade_id) { consume_one(ctx, from, item_id)?; grant_item(ctx, to, item_id, qty); Ok(()) }';
  if (hasHeadroomCheck(badNoHeadroom)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasHeadroomCheck should NOT pass on fixture without check_headroom call',
    };
  }
  const goodHeadroom =
    'fn confirm_trade(ctx, trade_id) { check_headroom(&items, &stacks, cur, bal, &[], &[], 0, 0)?; Ok(()) }';
  if (!hasHeadroomCheck(goodHeadroom)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasHeadroomCheck did not detect check_headroom( in fixture',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source
  // -------------------------------------------------------------------------
  let tradingSrc;
  try {
    tradingSrc = readFileSync('server-module/src/trading.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/trading.rs not found' };
  }

  const confirmBody = extractFunctionBody(tradingSrc, 'confirm_trade');
  if (!confirmBody) {
    return {
      name,
      pass: false,
      detail: 'confirm_trade function not found in server-module/src/trading.rs',
    };
  }

  const failures = [];

  // DUAL_WRITE
  if (!hasMonsterUpdate(confirmBody)) {
    failures.push(
      'DUAL_WRITE: confirm_trade does not call ctx.db.monster().monster_id().update() — monster ownership not transferred',
    );
  }
  if (!hasMonsterPubUpdate(confirmBody)) {
    failures.push(
      'DUAL_WRITE: confirm_trade does not call ctx.db.monster_pub().monster_id().update() — public projection diverges from private row (client sees old owner)',
    );
  }

  // ITEM_CONSUME + ITEM_GRANT
  if (!hasConsumeOne(confirmBody)) {
    failures.push(
      'ITEM_CONSUME (TR-16): confirm_trade does not call consume_one — offered items are credited to the counterparty without being debited from the initiator (item duplication)',
    );
  }
  if (!hasGrantItem(confirmBody)) {
    failures.push(
      'ITEM_GRANT (TR-16): confirm_trade does not call grant_item — offered items are debited from the source without being credited to the destination (item destruction)',
    );
  }

  // CURRENCY_SPEND + CURRENCY_GRANT
  if (!hasSpendCurrency(confirmBody)) {
    failures.push(
      'CURRENCY_SPEND (TR-16): confirm_trade does not call spend_currency — offered currency is credited to the counterparty without being debited from the initiator (currency printing)',
    );
  }
  if (!hasGrantCurrency(confirmBody)) {
    failures.push(
      'CURRENCY_GRANT (TR-16): confirm_trade does not call grant_currency — offered currency is debited from the source without being credited to the destination (currency burn)',
    );
  }

  // ROW_DELETION
  if (!hasRowDeletion(confirmBody)) {
    failures.push(
      'ROW_DELETION (TR-16/D5): confirm_trade does not delete the trade_offer row — escrow guard persists after swap, locking all offered assets permanently',
    );
  }

  // HEADROOM_CHECK (16.5b-1, ADR-0113)
  if (!hasHeadroomCheck(confirmBody)) {
    failures.push(
      'HEADROOM_CHECK (16.5b-1/ADR-0113): confirm_trade does not call check_headroom — ' +
        'trading 50 potions to a receiver holding 9,980 silently destroys 31 (grant_item clamps ' +
        'at MAX_ITEM_STACK=9999 with no error), violating the reject-not-clamp invariant',
    );
  }

  // APPLY_ORDER (17.5b-1, ADR-0123) — teeth self-checks run inside checkApplyOrder.
  const applyOrderResult = checkApplyOrder(tradingSrc);
  if (!applyOrderResult.pass) {
    failures.push(applyOrderResult.detail);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 8 conservation criteria met in confirm_trade (dual-write monster+pub, item consume+grant, currency spend+grant, row deletion, headroom check, apply-order ordered_steps loop — ADR-0108/0113/0123)',
  };
}
