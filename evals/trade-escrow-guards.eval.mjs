// trade-escrow-guards eval (M15c, ADR-0108):
// Verifies that the three escrow guard functions (reject_if_monster_in_trade,
// escrowed_item_qty, escrowed_currency_amount) are wired into every reducer that
// mutates an asset that can be offered in a trade (TR-2 through TR-13).
//
// Guard sites checked (12 tuples: [fnName, guard, minCount]):
//   evolve          reject_if_monster_in_trade  >=1  (TR-2)
//   fuse            reject_if_monster_in_trade  >=2  (TR-3 — BOTH parents)
//   set_nickname    reject_if_monster_in_trade  >=1  (TR-4)
//   set_party_slot  reject_if_monster_in_trade  >=1  (TR-5)
//   care            reject_if_monster_in_trade  >=1  (TR-6)
//   train           reject_if_monster_in_trade  >=1  (TR-7)
//   start_battle    reject_if_monster_in_trade  >=2  (TR-11 — party + opponent loops)
//   sell            escrowed_item_qty           >=1  (TR-8)
//   use_battle_item escrowed_item_qty           >=1  (TR-12)
//   attempt_recruit escrowed_item_qty           >=1  (TR-13)
//   buy             escrowed_currency_amount    >=1  (TR-9)
//   heal_party      escrowed_currency_amount    >=1  (TR-10)
//
// Proof-of-teeth: three teeth per checker family —
//   (a) body WITH the guard >= minCount passes,
//   (b) body WITHOUT the guard fails,
//   (c) for fuse: body with exactly ONE call fails the minCount=2 check.
//       This is the mutation class "one parent guard deleted".
//
// No new RegExp() — all patterns are literal regex literals or indexOf advances.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SERVER_SRC = 'server-module/src';

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract a named function's body (between outer braces), or null if not found.
 * Handles both `pub fn <name>(` and `fn <name>(`.
 */
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

/**
 * Count occurrences of `needle` in `haystack` using indexOf (no dynamic regex).
 * Advances past each match to avoid infinite loops on zero-length needles.
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    pos = haystack.indexOf(needle, pos);
    if (pos === -1) break;
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Read all *.rs files under `dir` (recursive) into one concatenated string.
 * Used to find a named function even when it might live in any sub-module.
 */
function readAllRustSources(dir) {
  const parts = [];
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true });
  } catch {
    return '';
  }
  for (const f of entries) {
    if (typeof f !== 'string' || !f.endsWith('.rs')) continue;
    try {
      parts.push(readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      // skip unreadable
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Core checker: does the named function have >= minCount calls to guard?
// Returns { ok: bool, found: number }.
// Strips Rust double-quoted string literal CONTENTS before counting so that a
// guard name appearing inside a string (e.g. log::info!("reject_if_monster_in_trade(x)"))
// is NOT counted as a real call site (RT-SEC-02, RT-SEC-02b). Raw string literals
// (r#"..."#) are not stripped — they are rare in these guard functions.
// ---------------------------------------------------------------------------
function bodyHasGuard(combinedSrc, fnName, guard, minCount) {
  const body = extractFunctionBody(combinedSrc, fnName);
  if (!body) return { ok: false, found: -1 }; // function not found
  const bodyNoStrings = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const count = countOccurrences(bodyNoStrings, `${guard}(`);
  return { ok: count >= minCount, found: count };
}

// ---------------------------------------------------------------------------
// Guard-site table (fnName, guard, minCount, earsCriterion)
// ---------------------------------------------------------------------------
const GUARD_SITES = [
  ['evolve', 'reject_if_monster_in_trade', 1, 'TR-2'],
  ['fuse', 'reject_if_monster_in_trade', 2, 'TR-3 (both parents)'],
  ['set_nickname', 'reject_if_monster_in_trade', 1, 'TR-4'],
  ['set_party_slot', 'reject_if_monster_in_trade', 1, 'TR-5'],
  ['care', 'reject_if_monster_in_trade', 1, 'TR-6'],
  ['train', 'reject_if_monster_in_trade', 1, 'TR-7'],
  // TR-11: start_battle guards BOTH party monsters AND opponent monsters; minCount=2
  // kills the mutation class "one loop's guard silently deleted" (analogous to fuse).
  ['start_battle', 'reject_if_monster_in_trade', 2, 'TR-11 (party + opponent loops)'],
  ['sell', 'escrowed_item_qty', 1, 'TR-8'],
  ['use_battle_item', 'escrowed_item_qty', 1, 'TR-12'],
  ['attempt_recruit', 'escrowed_item_qty', 1, 'TR-13'],
  ['buy', 'escrowed_currency_amount', 1, 'TR-9'],
  ['heal_party', 'escrowed_currency_amount', 1, 'TR-10'],
];

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'trade-escrow-guards (M15c, ADR-0108: TR-2..TR-13 reject_if_monster_in_trade + escrowed_item_qty + escrowed_currency_amount wired into every asset-mutating reducer)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth (three teeth per guard family)
  // -------------------------------------------------------------------------

  // Tooth (a): body WITH guard passes.
  const goodMonster =
    'fn evolve(ctx, monster_id) { reject_if_monster_in_trade(iter, monster_id)?; do_evolve(); Ok(()) }';
  const goodMonsterResult = bodyHasGuard(goodMonster, 'evolve', 'reject_if_monster_in_trade', 1);
  if (!goodMonsterResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (a): bodyHasGuard did not pass on fixture WITH reject_if_monster_in_trade',
    };
  }

  // Tooth (b): body WITHOUT guard fails.
  const badMonster =
    'fn evolve(ctx, monster_id) { reject_if_in_battle(iter, monster_id)?; do_evolve(); Ok(()) }';
  const badMonsterResult = bodyHasGuard(badMonster, 'evolve', 'reject_if_monster_in_trade', 1);
  if (badMonsterResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (b): bodyHasGuard should NOT pass on fixture WITHOUT reject_if_monster_in_trade',
    };
  }

  // Tooth (c): fuse minCount=2 — ONE call should fail the double-parent requirement.
  // This is the mutation class "second parent's guard was silently deleted".
  const fuseOneCall =
    'fn fuse(ctx, a_id, b_id) { reject_if_monster_in_trade(iter, a_id)?; do_fuse(); Ok(()) }';
  const fuseOneResult = bodyHasGuard(fuseOneCall, 'fuse', 'reject_if_monster_in_trade', 2);
  if (fuseOneResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (c): fuse minCount=2 should FAIL for a body with only ONE reject_if_monster_in_trade call ' +
        '— the second-parent guard deletion mutation class would be missed',
    };
  }
  // Good fuse: TWO calls should pass.
  const fuseTwoCalls =
    'fn fuse(ctx, a_id, b_id) { reject_if_monster_in_trade(iter_a, a_id)?; reject_if_monster_in_trade(iter_b, b_id)?; do_fuse(); Ok(()) }';
  const fuseTwoResult = bodyHasGuard(fuseTwoCalls, 'fuse', 'reject_if_monster_in_trade', 2);
  if (!fuseTwoResult.ok) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED (c-good): fuse minCount=2 should PASS for a body with TWO guard calls',
    };
  }
  // RT-SEC-02: fuse minCount=2 must NOT be satisfied by ONE real call plus the guard
  // name appearing in a string literal without an open paren (e.g. a prose error message).
  // bodyHasGuard strips string literal contents before counting, so guard names in strings
  // are excluded regardless of what follows them (RT-SEC-02b covers the paren-in-string case).
  const fuseOneCallOneString =
    'fn fuse(ctx, a_id, b_id) { reject_if_monster_in_trade(iter_a, a_id)?; return Err(format!("reject_if_monster_in_trade skipped for b_id {}", b_id)); }';
  const fuseOneStringResult = bodyHasGuard(
    fuseOneCallOneString,
    'fuse',
    'reject_if_monster_in_trade',
    2,
  );
  if (fuseOneStringResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-SEC-02): fuse minCount=2 passed a fixture with ONE real guard call and the ' +
        'guard name in a string literal — string stripping did not exclude the literal content',
    };
  }

  // RT-SEC-02b: same as RT-SEC-02 but the string literal contains the guard name WITH an
  // immediate open paren — e.g. log::info!("reject_if_monster_in_trade(b_id) bypassed").
  // Without string stripping, the needle `reject_if_monster_in_trade(` would match inside
  // the string, producing a false positive (ok:true). bodyHasGuard strips string literal
  // contents so the paren-in-string variant is also correctly excluded.
  const fuseParenInString =
    'fn fuse(ctx, a_id, b_id) { reject_if_monster_in_trade(iter_a, a_id)?; log::info!("reject_if_monster_in_trade(b_id) was already handled above"); }';
  const fuseParenInStringResult = bodyHasGuard(
    fuseParenInString,
    'fuse',
    'reject_if_monster_in_trade',
    2,
  );
  // bodyHasGuard must return ok:false (the string literal content does NOT count as a call).
  if (fuseParenInStringResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-SEC-02b): fuse minCount=2 passed a fixture with ONE real guard call and the ' +
        'guard name WITH open paren inside a string literal — string stripping did not exclude the literal content',
    };
  }

  // Tooth for item/currency guards.
  const goodSell =
    'fn sell(ctx, item_id, qty) { let escrowed = escrowed_item_qty(iter, owner, item_id); Ok(()) }';
  const goodSellResult = bodyHasGuard(goodSell, 'sell', 'escrowed_item_qty', 1);
  if (!goodSellResult.ok) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: bodyHasGuard did not pass on sell fixture WITH escrowed_item_qty',
    };
  }
  const badSell = 'fn sell(ctx, item_id, qty) { consume_one(ctx, owner, item_id)?; Ok(()) }';
  const badSellResult = bodyHasGuard(badSell, 'sell', 'escrowed_item_qty', 1);
  if (badSellResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: bodyHasGuard should NOT pass on sell fixture WITHOUT escrowed_item_qty',
    };
  }

  const goodBuy =
    'fn buy(ctx, item_id, qty) { let escrowed = escrowed_currency_amount(iter, owner); Ok(()) }';
  const goodBuyResult = bodyHasGuard(goodBuy, 'buy', 'escrowed_currency_amount', 1);
  if (!goodBuyResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: bodyHasGuard did not pass on buy fixture WITH escrowed_currency_amount',
    };
  }
  const badBuy = 'fn buy(ctx, item_id, qty) { spend_currency(ctx, owner, price)?; Ok(()) }';
  const badBuyResult = bodyHasGuard(badBuy, 'buy', 'escrowed_currency_amount', 1);
  if (badBuyResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: bodyHasGuard should NOT pass on buy fixture WITHOUT escrowed_currency_amount',
    };
  }

  // TR-13 teeth: attempt_recruit escrowed_item_qty guard.
  // Good fixture: body WITH escrowed_item_qty( passes.
  // Kills: a false-negative in bodyHasGuard that fails to find a real call site.
  const goodRecruit =
    'fn attempt_recruit(ctx, battle_id, bait_item_id) { let escrowed = escrowed_item_qty(iter, owner, bait_item_id); Ok(()) }';
  const goodRecruitResult = bodyHasGuard(goodRecruit, 'attempt_recruit', 'escrowed_item_qty', 1);
  if (!goodRecruitResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (TR-13 good): bodyHasGuard did not pass on attempt_recruit fixture WITH escrowed_item_qty',
    };
  }
  // Bad fixture: body WITHOUT escrowed_item_qty( must fail.
  // Kills: a future regression in taming.rs that removes the bait-escrow guard —
  // a body that only checks consume_one without the pre-flight escrowed_item_qty
  // call would allow recruiting with an escrowed bait item.
  const badRecruit =
    'fn attempt_recruit(ctx, battle_id, bait_item_id) { consume_one(ctx, owner, bait_item_id)?; Ok(()) }';
  const badRecruitResult = bodyHasGuard(badRecruit, 'attempt_recruit', 'escrowed_item_qty', 1);
  if (badRecruitResult.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (TR-13 bad): bodyHasGuard should NOT pass on attempt_recruit fixture WITHOUT escrowed_item_qty',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source files (all *.rs under server-module/src/)
  // -------------------------------------------------------------------------
  const combinedSrc = readAllRustSources(SERVER_SRC);
  if (!combinedSrc) {
    return { name, pass: false, detail: `No Rust sources found under ${SERVER_SRC}` };
  }

  const failures = [];

  for (const [fnName, guard, minCount, ears] of GUARD_SITES) {
    const result = bodyHasGuard(combinedSrc, fnName, guard, minCount);
    if (result.found === -1) {
      failures.push(
        `${ears}: function \`${fnName}\` not found in server-module/src/ — reducer may have been renamed`,
      );
    } else if (!result.ok) {
      const countWord = minCount > 1 ? `${result.found} (need ≥${minCount})` : '0';
      failures.push(
        `${ears}: \`${fnName}\` body has ${countWord} calls to \`${guard}\` — escrowed asset can be mutated during active trade`,
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
      'all 12 escrow-guard sites verified (TR-2..TR-13): reject_if_monster_in_trade in 7 reducers (fuse≥2, start_battle≥2), escrowed_item_qty in 3 (sell, use_battle_item, attempt_recruit), escrowed_currency_amount in 2',
  };
}
