// trade-conservation eval (M15c, ADR-0108):
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
//
// Proof-of-teeth: each "conservation break" fixture (grant without take, or
// take without grant) is the adversarial exploitation scenario; it must flag.
//
// No new RegExp() — all patterns are literal regex literals.
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
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'trade-conservation (M15c+M16.5b, ADR-0108/0113: TR-16 dual-write + item consume+grant + currency spend+grant + row deletion + headroom check in confirm_trade)';

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

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 7 conservation criteria met in confirm_trade (dual-write monster+pub, item consume+grant, currency spend+grant, row deletion, headroom check — ADR-0108/0113)',
  };
}
