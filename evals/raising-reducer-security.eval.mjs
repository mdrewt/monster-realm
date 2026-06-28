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
    'raising-reducer-security (care: ownership, server-clock, reject-never-burns, cooldown-op, SSOT, dual-write)';

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

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'care guard ladder (ownership, server-clock, reject-never-burns, cooldown-op, SSOT, dual-write) + evaluate_care seam — all teeth verified',
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
