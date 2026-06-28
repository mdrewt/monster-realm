// raising-reducer-security eval (M9b): the `care` reducer in server-module/src/raising.rs
// must satisfy a ladder of security invariants:
//
//   F1. No DB write before success path — reject branches NEVER mutate the monster row.
//   F2. Ownership guard — care checks ownership before any state read.
//   F4. Dual-write mirror — both monster() and monster_pub() updated on success.
//   F5. Server clock only — care reads ctx.timestamp or now_ms(ctx); no client time param.
//   F6. SSOT — care delegates bond arithmetic to apply_care(); no inline bond math.
//   F7. Cooldown operator — cooldown uses strict `<` (not `<=`).
//   F8. Dual-write uses pub_from_monster — no hand-rolled pub row on update.
//
// Every check comes with a proof-of-teeth fixture — a deliberately-bad inline
// string that MUST be flagged — and a green fixture that MUST pass.
//
// This eval starts RED: the `care` reducer does not exist yet in the source →
// extractReducerBody returns null → FAIL.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All pattern matching uses String.indexOf() or literal /regex/ patterns.
//   NO `new RegExp(...)` with a non-literal argument is used anywhere here.
//   This convention has been bitten 3 times in the codebase; see the eval rule.
import { readdirSync, readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Re-use helpers from recruit-reducer-security (verbatim copy — no circular
// import risk; these are trivially small functions).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments so that comment prose doesn't trip the
 * pattern scanner.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comment content blanked.
 */
export function stripRustComments(src) {
  // Block comments first, then line comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract a single function body from comment-stripped Rust source.
 *
 * Matches:  pub fn <name>(  OR  fn <name>(
 * Uses indexOf + brace-depth counting — NO dynamic RegExp.
 * Returns the raw text between the outer braces, or null if not found.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  The bare function name (e.g. "care").
 * @returns {string|null}
 */
export function extractReducerBody(src, fnName) {
  // Try `pub fn <name>(` first, then `fn <name>(`.
  // Using indexOf — no dynamic RegExp (Semgrep detect-non-literal-regexp).
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  // Walk forward to the opening brace.
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  // Brace-depth counting to find the matching close brace.
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
 * Extract the function SIGNATURE (from pub fn <name>( up to but not including
 * the opening brace `{`). Returns null if not found.
 *
 * Used to scan parameter lists for forbidden time arguments.
 * Uses indexOf only — NO dynamic RegExp.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  The bare function name (e.g. "care").
 * @returns {string|null}
 */
export function extractFnSignature(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  // Walk to the opening brace.
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  return src.slice(idx, i);
}

// ---------------------------------------------------------------------------
// Individual check functions (exported for unit-testability).
// Each returns null on pass, or a string describing the failure.
// ---------------------------------------------------------------------------

/**
 * Check — Ownership guard: the care body must contain a rejecting ownership
 * comparison. Accepts:
 *   (a) require_owner( call
 *   (b) owner_identity != ctx.sender ... Err(
 *   (c) owner_identity != me ... Err(  (alias form)
 *
 * Algorithm (whitespace-collapsed body):
 *   1. If `require_owner(` is present → PASS (it is the canonical guard helper).
 *   2. Else collect all aliases bound to ctx.sender via `let<alias>=ctx.sender;`.
 *   3. Require `owner_identity!=<token>` for any accepted token.
 *   4. Require `Err(` within ~320 chars of that comparison.
 *
 * Uses only indexOf and literal /regex/ — NO new RegExp(...).
 *
 * @param {string} body  Body of care, comment-stripped.
 * @returns {string|null}
 */
export function checkCareOwnershipGuard(body) {
  const compact = body.replace(/\s+/g, '');

  // Short-circuit: canonical guard helper present.
  if (compact.indexOf('require_owner(') !== -1) {
    return null;
  }

  // Collect ctx.sender aliases.
  const senderTokens = ['ctx.sender'];
  const aliasRe = /let(\w+)=ctx\.sender;/g;
  let am = aliasRe.exec(compact);
  while (am !== null) {
    senderTokens.push(am[1]);
    am = aliasRe.exec(compact);
  }

  // Find any owner_identity!=<token> comparison.
  let cmpIdx = -1;
  for (const tok of senderTokens) {
    const idx = compact.indexOf(`owner_identity!=${tok}`);
    if (idx !== -1) {
      cmpIdx = idx;
      break;
    }
  }

  if (cmpIdx === -1) {
    return (
      'care: missing ownership guard — require `require_owner(` call OR ' +
      '`owner_identity != ctx.sender` (or alias) followed by Err('
    );
  }

  // Require Err( within ~320 chars after the comparison.
  const window = compact.slice(cmpIdx, cmpIdx + 320);
  if (window.indexOf('Err(') === -1) {
    return (
      'care: ownership comparison found but no Err( within 320 chars — ' +
      'the comparison must lead to a rejection'
    );
  }

  return null;
}

/**
 * Check — Server clock / no client time: the care reducer signature must NOT
 * include a client-supplied timestamp parameter (i64 named `now`, `timestamp`,
 * `time`, or `client_time` after the ctx parameter), and the body must reference
 * a server-side clock call (now_ms( or ctx.timestamp).
 *
 * Two sub-checks:
 *   (a) Signature: after the `ctx: &ReducerContext` parameter, no `i64` time
 *       parameter appears under suspicious names. We check the compact signature
 *       for `now:i64`, `timestamp:i64`, `client_time:i64`, `time:i64`.
 *   (b) Body: contains `now_ms(` or `ctx.timestamp`.
 *
 * Uses only indexOf and literal /regex/ — NO new RegExp(...).
 *
 * @param {string} src   Full comment-stripped source (for signature extraction).
 * @param {string} body  Body of care, comment-stripped.
 * @returns {string|null}
 */
export function checkCareServerClock(src, body) {
  // (a) Signature must NOT have a client-supplied time param.
  const sig = extractFnSignature(src, 'care');
  if (sig !== null) {
    const compactSig = sig.replace(/\s+/g, '');
    // Drop `ctx:&ReducerContext` so we don't flag internal ctx types.
    const ctxEnd = compactSig.indexOf('ReducerContext');
    const afterCtx = ctxEnd === -1 ? compactSig : compactSig.slice(ctxEnd);
    // Suspicious client-time param shapes (using indexOf only).
    const forbidden = ['now:i64', 'timestamp:i64', 'client_time:i64', 'time:i64'];
    for (const f of forbidden) {
      if (afterCtx.indexOf(f) !== -1) {
        return (
          `care: signature contains forbidden client-time parameter '${f}' — ` +
          'the server clock (ctx.timestamp / now_ms) must be read inside the reducer, ' +
          'never accepted as a client argument (client clocks are never trusted)'
        );
      }
    }
  }

  // (b) Body must reference a server clock.
  const compactBody = body.replace(/\s+/g, '');
  if (compactBody.indexOf('now_ms(') === -1 && compactBody.indexOf('ctx.timestamp') === -1) {
    return (
      'care: body does not reference now_ms( or ctx.timestamp — ' +
      'the care cooldown must be measured from the server clock, not from a missing/client value'
    );
  }

  return null;
}

/**
 * Check F1 — Reject-never-burns: no monster().monster_id().update( may appear
 * BEFORE a `return Err(` rejection in the care body.
 *
 * Strategy: whitespace-collapse the body and scan for
 * `monster().monster_id().update(` followed by `returnErr(` (the compact form
 * of `return Err(`). Using `returnErr(` rather than bare `Err(` avoids a
 * false-positive on string literals that happen to contain the characters
 * "Err(" — e.g. `log::info!("...Err(cases_handled)...")` after the update.
 * Only an actual `return Err(...)` control-flow exit is a burn-then-reject.
 *
 * The compensating completeness control is checkCareDualWrite: if the monster
 * update is absent entirely, that check (g6) fires instead of this one
 * returning null, so the missing-update return-null here is safe.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of care, comment-stripped.
 * @returns {string|null}
 */
export function checkCareRejectNeverBurns(body) {
  const compact = body.replace(/\s+/g, '');

  const updateIdx = compact.indexOf('monster().monster_id().update(');
  if (updateIdx === -1) {
    // No monster update in the body at all — not this check's concern
    // (checkCareDualWrite gates completeness separately).
    return null;
  }

  // Find any `return Err(` that occurs AFTER the update — compact form `returnErr(`.
  // This targets actual control-flow exits, not string literals containing "Err(".
  const returnErrAfterUpdate = compact.indexOf('returnErr(', updateIdx);
  if (returnErrAfterUpdate !== -1) {
    return (
      'care: monster().monster_id().update( appears before a `return Err(` rejection branch — ' +
      'F1 reject-never-burns: the monster row must NOT be mutated on a reject path; ' +
      'all validation (ownership + bond-check + cooldown) must precede the first DB write'
    );
  }

  return null;
}

/**
 * Check F7 — Cooldown operator: the cooldown comparison must use strict `<`
 * (boundary elapsed is allowed), not `<=` (boundary would be an extra off-by-one
 * rejection). Scan the compact body for `<CARE_COOLDOWN_MS` and flag
 * `<=CARE_COOLDOWN_MS`.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of care or evaluate_care, comment-stripped.
 * @returns {string|null}
 */
export function checkCareCooldownOperator(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('<=CARE_COOLDOWN_MS') !== -1) {
    return (
      'care/evaluate_care: cooldown comparison uses `<=` — spec requires strict `<` ' +
      '(elapsed == CARE_COOLDOWN_MS is exactly at the boundary and must be ALLOWED); ' +
      'using `<=` would reject a request at exactly the cooldown boundary (off-by-one)'
    );
  }

  return null;
}

/**
 * Check F6 — SSOT: a function body must delegate bond arithmetic to either
 * `apply_care(` directly OR to the pure seam `evaluate_care(` (which itself
 * calls `apply_care`). Both are SSOT-honoring paths:
 *   - `care` body: expected to call `evaluate_care(` (seam delegation), but
 *     calling `apply_care(` directly is also accepted.
 *   - `evaluate_care` body: expected to call `apply_care(` (real-source check
 *     g8 enforces this separately on evaluate_care's own body).
 *
 * FORBIDDEN in both: inline bond arithmetic `Bond::new(bond.saturating_add(`
 * which would bypass the game-core pure rule entirely.
 *
 * The SSOT chain care → evaluate_care → apply_care is fully enforced because:
 *   1. This check (g5) requires care to call apply_care OR evaluate_care.
 *   2. The separate g8 check requires evaluate_care to call apply_care.
 *   3. The BAD_INLINE_BOND_MATH fixture has neither call AND has inline math
 *      → must still be flagged (the forbidden check catches it).
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of care (or evaluate_care), comment-stripped.
 * @returns {string|null}
 */
export function checkCareSSOT(body) {
  const compact = body.replace(/\s+/g, '');

  // SSOT satisfied by calling either the seam (evaluate_care) or the core rule
  // directly (apply_care). Both delegation styles are correct.
  const delegatesToSSOT =
    compact.indexOf('apply_care(') !== -1 || compact.indexOf('evaluate_care(') !== -1;

  if (!delegatesToSSOT) {
    return (
      'care: body calls neither apply_care( nor evaluate_care( — bond arithmetic must be ' +
      'delegated to the game-core pure rule via apply_care( directly or via the evaluate_care( ' +
      'seam (ADR-0003 SSOT); inline `Bond::new(bond.saturating_add(` is forbidden'
    );
  }

  // Detect inline bond arithmetic that bypasses both apply_care and evaluate_care.
  if (compact.indexOf('Bond::new(bond.saturating_add(') !== -1) {
    return (
      'care: body contains inline `Bond::new(bond.saturating_add(` — bond arithmetic ' +
      'must be delegated to apply_care( or evaluate_care(, not re-implemented inline'
    );
  }

  return null;
}

/**
 * Check F4/F8 — Dual-write mirror with pub_from_monster: the care body must
 * contain both `monster().monster_id().update(` and `monster_pub().monster_id().update(`
 * on the success path, and the monster_pub update must use `pub_from_monster(`.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of care, comment-stripped.
 * @returns {string|null}
 */
export function checkCareDualWrite(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('monster().monster_id().update(') === -1) {
    return 'care: body does not update the private monster table — success path is incomplete';
  }

  if (compact.indexOf('monster_pub().monster_id().update(') === -1) {
    return (
      'care: body updates monster() but does NOT update monster_pub() — ' +
      'F4 dual-write discipline: every monster mutation must mirror monster_pub'
    );
  }

  if (compact.indexOf('pub_from_monster(') === -1) {
    return (
      'care: monster_pub update found but pub_from_monster( not called — ' +
      'F8: the pub mirror must use pub_from_monster to project the private row, ' +
      'not a hand-rolled partial struct (field parity would silently diverge)'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// M9b-tail: train reducer + evaluate_train seam check functions.
//
// Security invariants for `train`:
//   T1. Ownership guard — train checks require_owner before any item or monster read.
//   T2. Signature — no client-supplied stat/amount after ReducerContext; the server
//       reads stat+amount from the item_row content table (ADR-0006 content SSOT).
//   T3. Consume-after-decision — evaluate_train( appears before consume_one( in body.
//   T4. Reject-never-burns — no monster update before a return Err(.
//   T5. current_hp untouched — no `.current_hp=` assignment in the train body.
//   T6. Dual-write mirror — monster().update + monster_pub().update + pub_from_monster.
//   T7. SSOT — train body calls evaluate_train(; evaluate_train body calls focus_train(.
//
// Implementation note: indexOf / literal /regex/ ONLY — no new RegExp(non-literal).
// ---------------------------------------------------------------------------

/**
 * Check T1 — Ownership guard: the train body must contain require_owner(.
 * OR an owner_identity != ctx.sender comparison followed by Err(.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of train, comment-stripped.
 * @returns {string|null}
 */
export function checkTrainOwnershipGuard(body) {
  const compact = body.replace(/\s+/g, '');

  // Short-circuit: canonical guard helper.
  if (compact.indexOf('require_owner(') !== -1) {
    return null;
  }

  // Collect ctx.sender aliases (same algorithm as checkCareOwnershipGuard).
  const senderTokens = ['ctx.sender'];
  const aliasRe = /let(\w+)=ctx\.sender;/g;
  let am = aliasRe.exec(compact);
  while (am !== null) {
    senderTokens.push(am[1]);
    am = aliasRe.exec(compact);
  }

  let cmpIdx = -1;
  for (const tok of senderTokens) {
    const idx = compact.indexOf(`owner_identity!=${tok}`);
    if (idx !== -1) {
      cmpIdx = idx;
      break;
    }
  }

  if (cmpIdx === -1) {
    return (
      'train: missing ownership guard — require `require_owner(` call OR ' +
      '`owner_identity != ctx.sender` (or alias) followed by Err('
    );
  }

  const window = compact.slice(cmpIdx, cmpIdx + 320);
  if (window.indexOf('Err(') === -1) {
    return (
      'train: ownership comparison found but no Err( within 320 chars — ' +
      'the comparison must lead to a rejection'
    );
  }

  return null;
}

/**
 * Check T2 — Signature (allowlist / exact-param check): the train reducer MUST
 * have exactly the canonical parameter list and nothing more:
 *   train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32)
 *
 * Strategy: extract the full signature text, locate the outer parameter region
 * (from the first `(` to its matching `)` by paren-depth counting), compact
 * whitespace, drop the `ctx:&ReducerContext` prefix up through the first `,`,
 * then require the remainder to be EXACTLY `,monster_id:u64,food_item_id:u32`.
 * Any extra parameter — regardless of its name or type — is rejected. This
 * closes the denylist evasion gap (e.g. `ev_count: u16`, `delta: u16`, `qty:
 * u16` would all pass a denylist but are caught here because they appear after
 * `food_item_id:u32` in the compact tail).
 *
 * Uses only indexOf and literal /regex/ — NO new RegExp(...).
 *
 * @param {string} src  Full comment-stripped source (for signature extraction).
 * @returns {string|null}
 */
export function checkTrainSignature(src) {
  const sig = extractFnSignature(src, 'train');
  if (sig === null) {
    // Missing train fn altogether — the real-source check will handle that.
    return null;
  }

  // Extract the text between the outermost `(` and its matching `)` using
  // paren-depth counting (indexOf only — no dynamic RegExp).
  const openIdx = sig.indexOf('(');
  if (openIdx === -1) {
    return 'train: signature has no opening paren (parser error)';
  }
  let depth = 1;
  let i = openIdx + 1;
  while (i < sig.length && depth > 0) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')') depth--;
    i++;
  }
  const paramRegion = sig.slice(openIdx + 1, i - 1);

  // Compact the parameter region.
  const compact = paramRegion.replace(/\s+/g, '');

  // Drop the leading ctx param: everything up to and including the first `,`
  // that follows `ReducerContext`. If ReducerContext is absent we still fall
  // through to the tail check (which will fail for a malformed sig).
  const ctxEnd = compact.indexOf('ReducerContext');
  let tail;
  if (ctxEnd === -1) {
    tail = compact;
  } else {
    // Advance past `ReducerContext` and any trailing chars until the first `,`.
    const commaAfterCtx = compact.indexOf(',', ctxEnd);
    tail = commaAfterCtx === -1 ? '' : compact.slice(commaAfterCtx);
  }

  // Allowlist: the ONLY acceptable tail is exactly `,monster_id:u64,food_item_id:u32`.
  // Any extra param (extra comma + name:type) makes the tail longer than this.
  const CANONICAL_TAIL = ',monster_id:u64,food_item_id:u32';
  if (tail !== CANONICAL_TAIL) {
    return (
      'train: signature parameter list does not match the canonical ' +
      '`train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32)` — ' +
      `got compact tail '${tail}', expected '${CANONICAL_TAIL}'; ` +
      'train_stat and train_amount must be read from item_row (content SSOT, ADR-0006), ' +
      'never accepted as client arguments (a client choosing its own stat/amount bypasses content)'
    );
  }

  return null;
}

/**
 * Check T3 — Consume-after-decision: evaluate_train( must appear BEFORE consume_one(
 * in the compacted train body. Spending before deciding would burn the food on a
 * rejected train (e.g. stat already at cap, wrong item type).
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of train, comment-stripped.
 * @returns {string|null}
 */
export function checkTrainConsumeAfterDecision(body) {
  const compact = body.replace(/\s+/g, '');

  const decisionIdx = compact.indexOf('evaluate_train(');
  const consumeIdx = compact.indexOf('consume_one(');

  if (decisionIdx === -1) {
    return (
      'train: body does not call evaluate_train( — the decision seam is missing; ' +
      'train must delegate to evaluate_train before spending the food'
    );
  }

  if (consumeIdx === -1) {
    return (
      'train: body does not call consume_one( — the food spend is missing; ' +
      'a successful train must consume exactly one food item from inventory'
    );
  }

  if (consumeIdx < decisionIdx) {
    return (
      'train: consume_one( appears BEFORE evaluate_train( — T3 spend-after-decide violated; ' +
      'a rejected train (stat at cap, wrong item, etc.) would burn the food before the decision'
    );
  }

  return null;
}

/**
 * Check T4 — Reject-never-burns: no monster().monster_id().update( may appear
 * BEFORE a `return Err(` in the train body.
 *
 * Uses only indexOf — NO new RegExp(...). Uses `returnErr(` (compact form) to
 * avoid false-positives on string literals containing "Err(".
 *
 * @param {string} body  Body of train, comment-stripped.
 * @returns {string|null}
 */
export function checkTrainRejectNeverBurns(body) {
  const compact = body.replace(/\s+/g, '');

  const updateIdx = compact.indexOf('monster().monster_id().update(');
  if (updateIdx === -1) {
    // No monster update in body — checkTrainDualWrite will handle completeness.
    return null;
  }

  const returnErrAfterUpdate = compact.indexOf('returnErr(', updateIdx);
  if (returnErrAfterUpdate !== -1) {
    return (
      'train: monster().monster_id().update( appears before a `return Err(` rejection — ' +
      'T4 reject-never-burns: the monster row must NOT be mutated on any reject path; ' +
      'all decision logic (evaluate_train, consume_one) must precede the first DB write'
    );
  }

  return null;
}

/**
 * Check T5 — current_hp untouched: the train body must NOT contain `.current_hp=`
 * (an assignment to current_hp). Training only modifies EVs and derived stats —
 * writing current_hp would be a free heal (ADR-0058 residual a).
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of train, comment-stripped.
 * @returns {string|null}
 */
export function checkTrainCurrentHpUntouched(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('.current_hp=') !== -1) {
    return (
      'train: body contains `.current_hp=` assignment — training must NEVER write current_hp; ' +
      'writing it here would grant a free heal on every train action (ADR-0058 residual a)'
    );
  }

  return null;
}

/**
 * Check T6 — Dual-write mirror: the train body must contain all three of:
 *   monster().monster_id().update(
 *   monster_pub().monster_id().update(
 *   pub_from_monster(
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Body of train, comment-stripped.
 * @returns {string|null}
 */
export function checkTrainDualWrite(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('monster().monster_id().update(') === -1) {
    return 'train: body does not update the private monster table — success path is incomplete';
  }

  if (compact.indexOf('monster_pub().monster_id().update(') === -1) {
    return (
      'train: body updates monster() but does NOT update monster_pub() — ' +
      'T6 dual-write discipline: every monster EV/stat mutation must mirror monster_pub'
    );
  }

  if (compact.indexOf('pub_from_monster(') === -1) {
    return (
      'train: monster_pub update found but pub_from_monster( not called — ' +
      'the pub mirror must use pub_from_monster to project the private row, ' +
      'not a hand-rolled partial struct (field parity would silently diverge)'
    );
  }

  return null;
}

/**
 * Check T7 — SSOT delegation:
 *   (a) The train body must call evaluate_train( and must NOT call focus_train( or
 *       derive_stats( directly (those belong inside the seam, not the reducer).
 *   (b) The evaluate_train body must call focus_train(.
 *
 * @param {string} trainBody          Body of train, comment-stripped.
 * @param {string|null} evalTrainBody Body of evaluate_train, comment-stripped (or null).
 * @returns {string|null}
 */
export function checkTrainSSOT(trainBody, evalTrainBody) {
  const compactTrain = trainBody.replace(/\s+/g, '');

  // (a) train body must delegate to evaluate_train.
  if (compactTrain.indexOf('evaluate_train(') === -1) {
    return (
      'train: body does not call evaluate_train( — train must delegate to the seam ' +
      '(SSOT: all EV decision logic belongs in evaluate_train, not inlined in the reducer)'
    );
  }

  // (a) train body must NOT inline focus_train or derive_stats directly.
  if (compactTrain.indexOf('focus_train(') !== -1) {
    return (
      'train: body calls focus_train( directly — train must delegate to evaluate_train( only; ' +
      'focus_train belongs inside the evaluate_train seam'
    );
  }
  if (compactTrain.indexOf('derive_stats(') !== -1) {
    return (
      'train: body calls derive_stats( directly — stat derivation must happen inside ' +
      'evaluate_train (which delegates to focus_train → derive_stats), not in the reducer'
    );
  }

  // (b) evaluate_train body must call focus_train.
  if (evalTrainBody !== null) {
    const compactEval = evalTrainBody.replace(/\s+/g, '');
    if (compactEval.indexOf('focus_train(') === -1) {
      return (
        'evaluate_train: body does not call focus_train( — the seam must delegate EV arithmetic ' +
        'to the game-core SSOT focus_train, not re-implement it inline'
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// M9b-tail: proof-of-teeth fixture strings for train checks.
// Each BAD fixture is a deliberately wrong inline Rust snippet.
// Each GOOD fixture is a fully compliant inline Rust snippet.
// ---------------------------------------------------------------------------

/** BAD T1: train with no ownership guard. Must be flagged by checkTrainOwnershipGuard. */
const BAD_TRAIN_NO_OWNERSHIP = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      // DELIBERATELY MISSING: no owner check
      let item = ctx.db.item_row().id().find(food_item_id)
          .ok_or_else(|| "item not found".to_string())?;
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, item.train_amount)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      m.ev_hp = result.evs.get(StatKind::Hp);
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD T2: train signature has client-supplied stat param. Must be flagged by checkTrainSignature. */
const BAD_TRAIN_CLIENT_STAT_PARAM = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32, stat: StatKind, amount: u16) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, "train", m.owner_identity)?;
      let result = evaluate_train(&base, &ivs, &evs, &nature, level, Some(stat), amount)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD T2b: train signature has a non-denylist extra client param `ev_count: u16`.
 * Passes the old denylist check but MUST be flagged by the allowlist check.
 * The body passes ev_count to evaluate_train instead of item.train_amount,
 * letting the client choose the EV grant — bypasses the content SSOT (ADR-0006). */
const BAD_TRAIN_EXTRA_CLIENT_PARAM = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32, ev_count: u16) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "train", m.owner_identity)?;
      let Some(item) = ctx.db.item_row().id().find(food_item_id) else {
          return Err("item not found".to_string());
      };
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, ev_count)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD T3: train calls consume_one BEFORE evaluate_train. Must be flagged by checkTrainConsumeAfterDecision. */
const BAD_TRAIN_CONSUME_BEFORE_DECISION = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, "train", m.owner_identity)?;
      // DELIBERATELY WRONG: spend before decide
      consume_one(ctx, ctx.sender, food_item_id)?;
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, item.train_amount)?;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD T4: train updates monster BEFORE a return Err. Must be flagged by checkTrainRejectNeverBurns. */
const BAD_TRAIN_UPDATE_BEFORE_ERR = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, "train", m.owner_identity)?;
      // DELIBERATELY WRONG: update before the decision return
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, item.train_amount)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      return Err("should not reach here".to_string());
  }
`;

/** BAD T5: train assigns to current_hp. Must be flagged by checkTrainCurrentHpUntouched. */
const BAD_TRAIN_WRITES_CURRENT_HP = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, "train", m.owner_identity)?;
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, item.train_amount)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      // DELIBERATELY WRONG: writes current_hp (free heal)
      m.current_hp = result.derived_stats.hp;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD T6: train hand-rolls the pub update without pub_from_monster. Must be flagged by checkTrainDualWrite. */
const BAD_TRAIN_HAND_ROLLED_PUB = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, "train", m.owner_identity)?;
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, item.train_amount)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      m.ev_attack = result.evs.get(StatKind::Attack);
      ctx.db.monster().monster_id().update(m.clone());
      // DELIBERATELY WRONG: hand-rolled pub without pub_from_monster
      let mut pub_m = ctx.db.monster_pub().monster_id().find(m.monster_id).unwrap();
      pub_m.stat_attack = result.derived_stats.attack;
      ctx.db.monster_pub().monster_id().update(pub_m);
      Ok(())
  }
`;

/** BAD T7a: train body inlines focus_train directly instead of calling evaluate_train.
 * Must be flagged by checkTrainSSOT (no evaluate_train call). */
const BAD_TRAIN_INLINE_MATH = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, "train", m.owner_identity)?;
      let item = ctx.db.item_row().id().find(food_item_id)
          .ok_or_else(|| "item not found".to_string())?;
      // DELIBERATELY WRONG: calls focus_train directly instead of evaluate_train
      let result = focus_train(&base, &ivs, &evs, &nature, level,
          item.train_stat.unwrap(), item.train_amount)
          .map_err(|e| format!("{e:?}"))?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** GOOD: a fully compliant train reducer (delegates to evaluate_train, proper ordering). */
const GOOD_TRAIN = `
  pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "train", m.owner_identity)?;
      let Some(item) = ctx.db.item_row().id().find(food_item_id) else {
          return Err("item not found".to_string());
      };
      let Some(species) = ctx.db.species_row().id().find(m.species_id) else {
          return Err("species not found".to_string());
      };
      let base = StatBlock { hp: species.base_hp, attack: species.base_attack,
          defense: species.base_defense, speed: species.base_speed,
          sp_attack: species.base_sp_attack, sp_defense: species.base_sp_defense };
      let ivs = game_core::IVs::new(m.iv_hp, m.iv_attack, m.iv_defense,
          m.iv_speed, m.iv_sp_attack, m.iv_sp_defense)?;
      let evs = game_core::EVs::new(m.ev_hp, m.ev_attack, m.ev_defense,
          m.ev_speed, m.ev_sp_attack, m.ev_sp_defense)?;
      let nature = game_core::Nature::new(m.nature_kind);
      let level = game_core::Level::new(m.level)?;
      let result = evaluate_train(&base, &ivs, &evs, &nature, level,
          item.train_stat, item.train_amount)?;
      consume_one(ctx, ctx.sender, food_item_id)?;
      m.ev_hp      = result.evs.get(StatKind::Hp);
      m.ev_attack  = result.evs.get(StatKind::Attack);
      m.ev_defense = result.evs.get(StatKind::Defense);
      m.ev_speed   = result.evs.get(StatKind::Speed);
      m.ev_sp_attack  = result.evs.get(StatKind::SpAttack);
      m.ev_sp_defense = result.evs.get(StatKind::SpDefense);
      m.stat_hp      = result.derived_stats.hp;
      m.stat_attack  = result.derived_stats.attack;
      m.stat_defense = result.derived_stats.defense;
      m.stat_speed   = result.derived_stats.speed;
      m.stat_sp_attack  = result.derived_stats.sp_attack;
      m.stat_sp_defense = result.derived_stats.sp_defense;
      let pub_row = pub_from_monster(&m);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

/** GOOD: a fully compliant evaluate_train seam (calls focus_train). */
const GOOD_EVALUATE_TRAIN = `
  pub(crate) fn evaluate_train(
      base: &StatBlock,
      ivs: &IVs,
      evs: &EVs,
      nature: &Nature,
      level: Level,
      train_stat: Option<StatKind>,
      train_amount: u16,
  ) -> Result<FocusTrainResult, String> {
      let stat = train_stat.ok_or_else(|| "item is not a training food".to_string())?;
      focus_train(base, ivs, evs, nature, level, stat, train_amount)
          .map_err(|e| format!("train rejected: {e:?}"))
  }
`;

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings.
// Each is a minimal inline Rust snippet. extractReducerBody must parse these.
// ---------------------------------------------------------------------------

/** BAD: care with no ownership guard. Must be flagged by checkCareOwnershipGuard. */
const BAD_NO_OWNERSHIP = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      // DELIBERATELY MISSING: no owner check
      let now = now_ms(ctx);
      let new_bond = apply_care(Bond::new(m.bond), CARE_BOND_AMOUNT)?;
      m.bond = new_bond.value();
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD: care signature has a client-supplied time param. Must be flagged by checkCareServerClock. */
const BAD_CLIENT_TIME_PARAM = `
  pub fn care(ctx: &ReducerContext, monster_id: u64, now: i64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let new_bond = apply_care(Bond::new(m.bond), CARE_BOND_AMOUNT)?;
      m.bond = new_bond.value();
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD: care updates monster BEFORE a cooldown Err. Must be flagged by checkCareRejectNeverBurns. */
const BAD_UPDATE_BEFORE_ERR = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let now = now_ms(ctx);
      let new_bond = apply_care(Bond::new(m.bond), CARE_BOND_AMOUNT)?;
      m.bond = new_bond.value();
      m.last_care_at_ms = now;
      // DELIBERATELY WRONG: update before cooldown check
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      if now.saturating_sub(m.last_care_at_ms) < CARE_COOLDOWN_MS {
          return Err("cooldown not elapsed".to_string());
      }
      Ok(())
  }
`;

/** BAD: care uses <= for cooldown. Must be flagged by checkCareCooldownOperator. */
const BAD_COOLDOWN_LEQ = `
  pub fn evaluate_care(bond: u8, last_care_at_ms: i64, now_ms: i64) -> Result<u8, String> {
      let new_bond = apply_care(Bond::new(bond), CARE_BOND_AMOUNT)
          .map_err(|e| format!("{:?}", e))?;
      if now_ms.saturating_sub(last_care_at_ms) <=CARE_COOLDOWN_MS {
          return Err("cooldown not elapsed".to_string());
      }
      Ok(new_bond.value())
  }
`;

/** BAD: care has inline bond arithmetic instead of apply_care. Must be flagged by checkCareSSOT. */
const BAD_INLINE_BOND_MATH = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let now = now_ms(ctx);
      if now.saturating_sub(m.last_care_at_ms) < CARE_COOLDOWN_MS {
          return Err("cooldown not elapsed".to_string());
      }
      // DELIBERATELY WRONG: inline bond math instead of apply_care
      let new_bond = Bond::new(m.bond.saturating_add(CARE_BOND_AMOUNT));
      m.bond = new_bond.value();
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** BAD: care updates monster_pub without pub_from_monster. Must be flagged by checkCareDualWrite. */
const BAD_UPDATE_HAND_ROLLED_PUB = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let now = now_ms(ctx);
      if now.saturating_sub(m.last_care_at_ms) < CARE_COOLDOWN_MS {
          return Err("cooldown not elapsed".to_string());
      }
      let new_bond = apply_care(Bond::new(m.bond), CARE_BOND_AMOUNT)?;
      m.bond = new_bond.value();
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      // DELIBERATELY WRONG: hand-rolled pub update without pub_from_monster
      let mut pub_m = ctx.db.monster_pub().monster_id().find(m.monster_id).unwrap();
      pub_m.bond = m.bond;
      ctx.db.monster_pub().monster_id().update(pub_m);
      Ok(())
  }
`;

/** GOOD: a fully-compliant care reducer. Must pass ALL checks. */
const GOOD_CARE = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let now = now_ms(ctx);
      if now.saturating_sub(m.last_care_at_ms) < CARE_COOLDOWN_MS {
          return Err("cooldown not elapsed".to_string());
      }
      let new_bond = apply_care(Bond::new(m.bond), CARE_BOND_AMOUNT)?;
      m.bond = new_bond.value();
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** GOOD: a fully-compliant care that delegates to evaluate_care (the real impl style per ADR-0059).
 * Must pass ALL SIX care checks. This is the canonical delegating style:
 *   care → evaluate_care (seam) → apply_care (game-core pure rule).
 * The SSOT chain is enforced: this body calls evaluate_care(, and evaluate_care's
 * own body (checked separately via g8) calls apply_care(.
 */
const GOOD_CARE_DELEGATING = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let now = now_ms(ctx);
      let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now)
          .map_err(|e| format!("care rejected: {e}"))?;
      m.bond = new_bond;
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      Ok(())
  }
`;

/** GOOD: a fully-compliant care that logs after both updates using a string that
 * contains the characters "Err(" — must NOT be flagged by checkCareRejectNeverBurns.
 * Kills: a naive bare-Err( scanner that false-positives on log strings.
 */
const GOOD_CARE_WITH_LOG = `
  pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let mut m = ctx.db.monster().monster_id().find(monster_id)
          .ok_or_else(|| "monster not found".to_string())?;
      require_owner(ctx, m.owner_identity)?;
      let now = now_ms(ctx);
      let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now)
          .map_err(|e| format!("care rejected: {e}"))?;
      m.bond = new_bond;
      m.last_care_at_ms = now;
      ctx.db.monster().monster_id().update(m.clone());
      ctx.db.monster_pub().monster_id().update(pub_from_monster(&m));
      log::info!("{{"evt":"care_ok","monster_id":{monster_id},"bond":{},"note":"Err(cases_handled_above)"}}",
          m.bond);
      Ok(())
  }
`;

/** GOOD: a fully-compliant evaluate_care seam. Must pass cooldown operator check. */
const GOOD_EVALUATE_CARE = `
  pub(crate) fn evaluate_care(bond: u8, last_care_at_ms: i64, now_ms: i64) -> Result<u8, String> {
      let new_bond = apply_care(Bond::new(bond), CARE_BOND_AMOUNT)
          .map_err(|e| format!("{:?}", e))?;
      if now_ms.saturating_sub(last_care_at_ms) <CARE_COOLDOWN_MS {
          return Err("cooldown not elapsed".to_string());
      }
      Ok(new_bond.value())
  }
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'raising-reducer-security (care+train: ownership, server-clock, reject-never-burns, cooldown-op, SSOT, dual-write; train: signature, consume-after-decision, hp-untouched)';

  // =========================================================================
  // PROOFS-OF-TEETH — every tooth must bite before we scan real source.
  // =========================================================================

  // --- Tooth 1: missing ownership guard must be flagged --------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_NO_OWNERSHIP), 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract care body from BAD_NO_OWNERSHIP fixture (parser bug)',
      };
    }
    if (!checkCareOwnershipGuard(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_NO_OWNERSHIP fixture was NOT flagged by checkCareOwnershipGuard',
      };
    }
  }

  // --- Tooth 2: client time param in signature must be flagged -------------
  {
    const stripped = stripRustComments(BAD_CLIENT_TIME_PARAM);
    const body = extractReducerBody(stripped, 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract care body from BAD_CLIENT_TIME_PARAM fixture (parser bug)',
      };
    }
    if (!checkCareServerClock(stripped, body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_CLIENT_TIME_PARAM fixture (now: i64 param) was NOT flagged by checkCareServerClock',
      };
    }
  }

  // --- Tooth 3: update before Err must be flagged --------------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_UPDATE_BEFORE_ERR), 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract care body from BAD_UPDATE_BEFORE_ERR fixture (parser bug)',
      };
    }
    if (!checkCareRejectNeverBurns(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_UPDATE_BEFORE_ERR fixture (update before cooldown Err) was NOT flagged by checkCareRejectNeverBurns',
      };
    }
  }

  // --- Tooth 4: <= cooldown operator must be flagged -----------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_COOLDOWN_LEQ), 'evaluate_care');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract evaluate_care body from BAD_COOLDOWN_LEQ fixture (parser bug)',
      };
    }
    if (!checkCareCooldownOperator(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_COOLDOWN_LEQ fixture (<=CARE_COOLDOWN_MS) was NOT flagged by checkCareCooldownOperator',
      };
    }
  }

  // --- Tooth 5: inline bond math must be flagged ---------------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_INLINE_BOND_MATH), 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract care body from BAD_INLINE_BOND_MATH fixture (parser bug)',
      };
    }
    if (!checkCareSSOT(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_INLINE_BOND_MATH fixture (Bond::new(bond.saturating_add)) was NOT flagged by checkCareSSOT',
      };
    }
  }

  // --- Tooth 6: hand-rolled pub update must be flagged ---------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_UPDATE_HAND_ROLLED_PUB), 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract care body from BAD_UPDATE_HAND_ROLLED_PUB fixture (parser bug)',
      };
    }
    if (!checkCareDualWrite(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_UPDATE_HAND_ROLLED_PUB fixture (no pub_from_monster on update) was NOT flagged by checkCareDualWrite',
      };
    }
  }

  // --- Green-path teeth: good fixtures must pass ALL checks (no false positives) ---
  {
    const stripped = stripRustComments(GOOD_CARE);
    const body = extractReducerBody(stripped, 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract care body from GOOD_CARE fixture (parser bug)',
      };
    }
    const errs = [
      checkCareOwnershipGuard(body),
      checkCareServerClock(stripped, body),
      checkCareRejectNeverBurns(body),
      checkCareCooldownOperator(body),
      checkCareSSOT(body),
      checkCareDualWrite(body),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_CARE was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }
  // --- Green-path: delegating style (care → evaluate_care) must pass all six checks ---
  {
    const stripped = stripRustComments(GOOD_CARE_DELEGATING);
    const body = extractReducerBody(stripped, 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract care body from GOOD_CARE_DELEGATING fixture (parser bug)',
      };
    }
    const errs = [
      checkCareOwnershipGuard(body),
      checkCareServerClock(stripped, body),
      checkCareRejectNeverBurns(body),
      checkCareCooldownOperator(body),
      checkCareSSOT(body),
      checkCareDualWrite(body),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_CARE_DELEGATING (delegates to evaluate_care) was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }
  // --- Green-path: GOOD_CARE_WITH_LOG — log string contains "Err(" but AFTER updates,
  //     checkCareRejectNeverBurns must NOT flag it (scanner uses returnErr( not bare Err() ---
  {
    const stripped = stripRustComments(GOOD_CARE_WITH_LOG);
    const body = extractReducerBody(stripped, 'care');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract care body from GOOD_CARE_WITH_LOG fixture (parser bug)',
      };
    }
    const result = checkCareRejectNeverBurns(body);
    if (result !== null) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_CARE_WITH_LOG was incorrectly flagged by checkCareRejectNeverBurns: ${result} — scanner must use returnErr( not bare Err(`,
      };
    }
  }
  {
    const body = extractReducerBody(stripRustComments(GOOD_EVALUATE_CARE), 'evaluate_care');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract evaluate_care body from GOOD_EVALUATE_CARE fixture (parser bug)',
      };
    }
    if (checkCareCooldownOperator(body)) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVALUATE_CARE was incorrectly flagged by checkCareCooldownOperator: ${checkCareCooldownOperator(body)}`,
      };
    }
  }

  // =========================================================================
  // PROOFS-OF-TEETH (train) — train BAD fixtures must bite; GOOD must pass.
  // =========================================================================

  // --- Train Tooth T1: missing ownership guard must be flagged ---------------
  {
    const body = extractReducerBody(stripRustComments(BAD_TRAIN_NO_OWNERSHIP), 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract train body from BAD_TRAIN_NO_OWNERSHIP fixture (parser bug)',
      };
    }
    if (!checkTrainOwnershipGuard(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_TRAIN_NO_OWNERSHIP fixture was NOT flagged by checkTrainOwnershipGuard',
      };
    }
  }

  // --- Train Tooth T2a: client-supplied stat param in signature must be flagged ---
  {
    const stripped = stripRustComments(BAD_TRAIN_CLIENT_STAT_PARAM);
    if (!checkTrainSignature(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_CLIENT_STAT_PARAM fixture (stat: StatKind, amount: u16 params) was NOT flagged by checkTrainSignature',
      };
    }
  }

  // --- Train Tooth T2b: extra client param not in denylist must be flagged ---
  // (ev_count: u16 would evade the old denylist; the allowlist catches it)
  {
    const stripped = stripRustComments(BAD_TRAIN_EXTRA_CLIENT_PARAM);
    if (!checkTrainSignature(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_EXTRA_CLIENT_PARAM fixture (ev_count: u16 extra param — not in old denylist) was NOT flagged by checkTrainSignature; allowlist check must reject any param beyond monster_id+food_item_id',
      };
    }
  }

  // --- Train Tooth T3: consume before decision must be flagged ---------------
  {
    const body = extractReducerBody(stripRustComments(BAD_TRAIN_CONSUME_BEFORE_DECISION), 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract train body from BAD_TRAIN_CONSUME_BEFORE_DECISION fixture (parser bug)',
      };
    }
    if (!checkTrainConsumeAfterDecision(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_CONSUME_BEFORE_DECISION fixture (consume_one before evaluate_train) was NOT flagged by checkTrainConsumeAfterDecision',
      };
    }
  }

  // --- Train Tooth T4: update before return Err must be flagged -------------
  {
    const body = extractReducerBody(stripRustComments(BAD_TRAIN_UPDATE_BEFORE_ERR), 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract train body from BAD_TRAIN_UPDATE_BEFORE_ERR fixture (parser bug)',
      };
    }
    if (!checkTrainRejectNeverBurns(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_UPDATE_BEFORE_ERR fixture (monster update before return Err) was NOT flagged by checkTrainRejectNeverBurns',
      };
    }
  }

  // --- Train Tooth T5: current_hp assignment must be flagged ----------------
  {
    const body = extractReducerBody(stripRustComments(BAD_TRAIN_WRITES_CURRENT_HP), 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract train body from BAD_TRAIN_WRITES_CURRENT_HP fixture (parser bug)',
      };
    }
    if (!checkTrainCurrentHpUntouched(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_WRITES_CURRENT_HP fixture (.current_hp= assignment) was NOT flagged by checkTrainCurrentHpUntouched',
      };
    }
  }

  // --- Train Tooth T6: hand-rolled pub update must be flagged ---------------
  {
    const body = extractReducerBody(stripRustComments(BAD_TRAIN_HAND_ROLLED_PUB), 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract train body from BAD_TRAIN_HAND_ROLLED_PUB fixture (parser bug)',
      };
    }
    if (!checkTrainDualWrite(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_HAND_ROLLED_PUB fixture (no pub_from_monster on update) was NOT flagged by checkTrainDualWrite',
      };
    }
  }

  // --- Train Tooth T7: inline focus_train (no evaluate_train) must be flagged ---
  {
    const body = extractReducerBody(stripRustComments(BAD_TRAIN_INLINE_MATH), 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract train body from BAD_TRAIN_INLINE_MATH fixture (parser bug)',
      };
    }
    if (!checkTrainSSOT(body, null)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_TRAIN_INLINE_MATH fixture (focus_train called directly, no evaluate_train) was NOT flagged by checkTrainSSOT',
      };
    }
  }

  // --- Train green-path: GOOD_TRAIN must pass ALL train checks ---------------
  {
    const stripped = stripRustComments(GOOD_TRAIN);
    const body = extractReducerBody(stripped, 'train');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract train body from GOOD_TRAIN fixture (parser bug)',
      };
    }
    const errs = [
      checkTrainOwnershipGuard(body),
      checkTrainSignature(stripped),
      checkTrainConsumeAfterDecision(body),
      checkTrainRejectNeverBurns(body),
      checkTrainCurrentHpUntouched(body),
      checkTrainDualWrite(body),
      checkTrainSSOT(body, null),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_TRAIN was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // --- Train green-path: GOOD_EVALUATE_TRAIN seam must satisfy SSOT check ---
  {
    const evalBody = extractReducerBody(stripRustComments(GOOD_EVALUATE_TRAIN), 'evaluate_train');
    if (!evalBody) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract evaluate_train body from GOOD_EVALUATE_TRAIN fixture (parser bug)',
      };
    }
    // Build a minimal compliant train body so checkTrainSSOT(b) can check (b).
    const trainBodyForSSOT = `evaluate_train( consume_one( monster().monster_id().update( monster_pub().monster_id().update( pub_from_monster(`;
    const err = checkTrainSSOT(trainBodyForSSOT, evalBody);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVALUATE_TRAIN was incorrectly flagged by checkTrainSSOT: ${err}`,
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual server-module source.
  // =========================================================================

  const SERVER_SRC = 'server-module/src';
  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }
  const src = stripRustComments(rawSrc);

  const failures = [];

  // --- Check: care reducer exists and passes the guard ladder ---------------
  const careBody = extractReducerBody(src, 'care');
  if (!careBody) {
    failures.push(
      'care: reducer not found in server-module source — raising.rs not yet implemented (expected RED state)',
    );
  } else {
    const g1 = checkCareOwnershipGuard(careBody);
    if (g1) failures.push(g1);
    const g2 = checkCareServerClock(src, careBody);
    if (g2) failures.push(g2);
    const g3 = checkCareRejectNeverBurns(careBody);
    if (g3) failures.push(g3);
    const g4 = checkCareCooldownOperator(careBody);
    if (g4) failures.push(g4);
    const g5 = checkCareSSOT(careBody);
    if (g5) failures.push(g5);
    const g6 = checkCareDualWrite(careBody);
    if (g6) failures.push(g6);
  }

  // --- Check: evaluate_care seam exists and passes cooldown operator check --
  const evaluateCareBody = extractReducerBody(src, 'evaluate_care');
  if (!evaluateCareBody) {
    failures.push(
      'evaluate_care: pure seam not found in server-module source — raising.rs not yet implemented',
    );
  } else {
    const g7 = checkCareCooldownOperator(evaluateCareBody);
    if (g7) failures.push(g7);
    const g8 = checkCareSSOT(evaluateCareBody);
    if (g8) failures.push(g8);
  }

  // --- Check: train reducer exists and passes all train guard checks --------
  // This block starts RED (train not yet in source) — the intended state.
  const trainBody = extractReducerBody(src, 'train');
  if (!trainBody) {
    failures.push(
      'train: reducer not found in server-module source — raising.rs train not yet implemented (expected RED state)',
    );
  } else {
    const t1 = checkTrainOwnershipGuard(trainBody);
    if (t1) failures.push(t1);
    const t2 = checkTrainSignature(src);
    if (t2) failures.push(t2);
    const t3 = checkTrainConsumeAfterDecision(trainBody);
    if (t3) failures.push(t3);
    const t4 = checkTrainRejectNeverBurns(trainBody);
    if (t4) failures.push(t4);
    const t5 = checkTrainCurrentHpUntouched(trainBody);
    if (t5) failures.push(t5);
    const t6 = checkTrainDualWrite(trainBody);
    if (t6) failures.push(t6);
    // evaluate_train body is needed for T7(b); extract it separately.
    const evaluateTrainBody = extractReducerBody(src, 'evaluate_train');
    if (!evaluateTrainBody) {
      failures.push(
        'evaluate_train: pure seam not found in server-module source — train seam not yet implemented',
      );
    }
    const t7 = checkTrainSSOT(trainBody, evaluateTrainBody ?? null);
    if (t7) failures.push(t7);
  }

  // --- Check: evaluate_train seam exists (separate from train body check) ---
  const evaluateTrainBodyStandalone = extractReducerBody(src, 'evaluate_train');
  if (!evaluateTrainBodyStandalone) {
    // Only push if we haven't already reported it inside the train block.
    if (trainBody) {
      failures.push(
        'evaluate_train: pure seam not found in server-module source — train seam not yet implemented',
      );
    }
    // If trainBody is also missing the failure is already recorded above.
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'care guard ladder (ownership, server-clock, reject-never-burns, cooldown-op, SSOT, dual-write) + evaluate_care seam + ' +
      'train guard ladder (ownership, signature, consume-after-decision, reject-never-burns, hp-untouched, dual-write, SSOT) + evaluate_train seam — all teeth verified',
  };
}

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split.
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}
