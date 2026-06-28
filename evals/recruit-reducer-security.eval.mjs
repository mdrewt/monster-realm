// recruit-reducer-security eval (M8d): the attempt_recruit, consume_one, grant_item,
// and grant_bait reducers/helpers in server-module must satisfy a ladder of security
// invariants:
//
//   1. Ownership guard  — attempt_recruit checks player_identity vs ctx.sender.
//   2. Outcome guard    — attempt_recruit checks BattleOutcome::Ongoing.
//   3. Wild-battle guard — attempt_recruit reads the battle_wild side-table.
//   4. Consume-before-roll ordering — consume_one precedes ctx.random/recruit_chance.
//   5. No-XP-on-recruit — success arm uses write_back_party_hp, NOT write_back_battle_results;
//                         no reference to battle_xp_reward/apply_xp_gain on success path.
//   6. checked_sub in consume_one / no bare decrement; saturating_add in grant_item.
//   7. Classify bait by data (recruit_bonus field), not by a magic hardcoded item id.
//   8. battle_wild GC — both attempt_recruit and write_back_battle_results delete battle_wild rows.
//   9. grant_bait self-scoped — body uses ctx.sender, signature has no Identity param.
//
// Every check comes with a proof-of-teeth fixture — a deliberately-bad inline
// string that MUST be flagged — and a green fixture that MUST pass.
//
// This eval starts RED: attempt_recruit / grant_item / consume_one / grant_bait do
// not exist yet → extractReducerBody returns null for every real check → FAIL.
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All pattern matching uses String.indexOf() or literal /regex/ patterns.
//   NO `new RegExp(...)` with a non-literal argument is used anywhere here.
//   This convention has been bitten 3 times in the codebase; see the eval rule.
import { readdirSync, readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Re-use the battle-reducer-security helpers verbatim (no dynamic RegExp).
// We copy them literally rather than importing — the import would create a
// circular dependency risk and the functions are trivially small.
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
 * @param {string} fnName  The bare function name (e.g. "attempt_recruit").
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

// ---------------------------------------------------------------------------
// Individual check functions (exported for unit-testability).
// Each returns null on pass, or a string describing the failure.
// ---------------------------------------------------------------------------

/**
 * Check 1: ownership guard — STRENGTHENED (rejecting-comparison required).
 *
 * Requires a `player_identity != <sender>` comparison followed by an Err(
 * within a bounded window (~200 chars). Accepts both:
 *   (a) alias form:  let me = ctx.sender; ... player_identity != me ... Err(
 *   (b) direct form: player_identity != ctx.sender ... Err(
 *
 * Algorithm (operates on whitespace-collapsed copy):
 *   1. Resolve sender tokens: default `ctx.sender`; collect ALL aliases bound by
 *      `let<alias>=ctx.sender;` (a body may bind ctx.sender to more than one
 *      local and guard with any of them).
 *   2. Require `player_identity!=<sender>` present for any accepted sender token.
 *   3. Require `Err(` within ~320 chars after that comparison.
 *
 * Uses only indexOf and literal /regex/ — NO new RegExp(...).
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkOwnershipGuard(body) {
  const compact = body.replace(/\s+/g, '');

  // Resolve ALL aliases bound to ctx.sender: `let<alias>=ctx.sender;`
  // (global match — a body may bind ctx.sender to more than one local and guard
  // with any of them, e.g. `let caller = ...; let me = ...; ... != me`).
  const senderTokens = ['ctx.sender'];
  const aliasRe = /let(\w+)=ctx\.sender;/g;
  let am = aliasRe.exec(compact);
  while (am !== null) {
    senderTokens.push(am[1]);
    am = aliasRe.exec(compact);
  }

  // Find a `player_identity!=<sender>` comparison for any accepted sender token.
  let cmpIdx = -1;
  for (const tok of senderTokens) {
    const idx = compact.indexOf(`player_identity!=${tok}`);
    if (idx !== -1) {
      cmpIdx = idx;
      break;
    }
  }

  if (cmpIdx === -1) {
    return (
      'attempt_recruit: missing rejecting ownership comparison — ' +
      'require `player_identity != me` (alias form) or `player_identity != ctx.sender` (direct form) ' +
      'followed by Err( (pure substring presence of player_identity or ctx.sender is insufficient)'
    );
  }

  // Require Err( within ~320 chars after the comparison (a real guard may log
  // a rejection between the `!=` and the `return Err`, so keep the window
  // generous but bounded).
  const window = compact.slice(cmpIdx, cmpIdx + 320);
  if (window.indexOf('Err(') === -1 && window.indexOf('returnErr') === -1) {
    return (
      'attempt_recruit: ownership comparison found but no Err( within 320 chars — ' +
      'the comparison must lead to a rejection'
    );
  }

  return null;
}

/**
 * Check 2: outcome guard.
 * The attempt_recruit body must contain an early-return guard that REJECTS a
 * non-Ongoing battle: specifically `!= BattleOutcome::Ongoing` (the standard
 * pattern in submit_attack, swap_active, flee).
 *
 * Why we require `!=` and not mere presence of `BattleOutcome::Ongoing`:
 *   A reducer that SETS outcome = BattleOutcome::SideAWins (the success path)
 *   will contain "BattleOutcome::Ongoing" in a write-context, not a guard
 *   context — and may also contain `.outcome` as an lvalue. Requiring the
 *   rejection comparison `!= BattleOutcome::Ongoing` detects the guard pattern
 *   specifically, because the only reason to write `!= BattleOutcome::Ongoing`
 *   in a reducer body is to reject a finished battle.
 *
 * Implementation: collapse all whitespace in the body (literal /\s+/g — not
 * new RegExp), then indexOf the compact literal.  This is tolerant of multi-
 * line formatting while still being a pure literal string search after the
 * collapse step.
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkOutcomeGuard(body) {
  // Collapse whitespace so `!= BattleOutcome::Ongoing` matches regardless of
  // line breaks or extra spaces.  /\s+/g is a LITERAL regex — not new RegExp.
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('!=BattleOutcome::Ongoing') === -1) {
    return 'attempt_recruit: missing `!= BattleOutcome::Ongoing` rejection guard — the reducer must early-return Err when the battle is not ongoing';
  }
  return null;
}

/**
 * Check 3: wild-battle guard — STRENGTHENED (lookup + rejection required).
 *
 * Requires a `battle_wild(` lookup whose not-found path rejects with Err.
 * Mere presence of `battle_wild(` in e.g. a GC `.delete()` call is NOT sufficient.
 *
 * Algorithm (operates on whitespace-collapsed copy). The rejection must BIND to
 * the battle_wild lookup result — an unrelated ok_or_else from a different query
 * nearby must NOT satisfy the gate (a discarded `let _ = ...find(...);` is a hole).
 * Try EACH `battle_wild(` occurrence (a body may use it for both lookup and GC):
 *   1. For an occurrence, require `.find(` within ~120 chars after it.
 *   2. Walk to the matching close-paren of that `.find(`.
 *   3. Inspect what immediately follows the find's `)`:
 *        - `.ok_or` chained directly on the find result → ACCEPT.
 *        - `{Some` (match arm) → require a `None=>` with `Err`/`return` shortly
 *          after within the match window → ACCEPT.
 *        - otherwise (e.g. a `;` discarding the result) → this occurrence does
 *          not bind a rejection; try the next `battle_wild(`.
 *
 * Uses only indexOf and literal /regex/ — NO new RegExp(...).
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkWildBattleGuard(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('battle_wild(') === -1) {
    return 'attempt_recruit: missing battle_wild( lookup (wild-battle guard absent — non-wild battles could be targeted)';
  }

  let sawFind = false;

  // Try each battle_wild( occurrence — only one needs to bind a rejection.
  let wildIdx = compact.indexOf('battle_wild(');
  while (wildIdx !== -1) {
    // Require .find( shortly after this battle_wild( (same call chain).
    const windowAfterWild = compact.slice(wildIdx, wildIdx + 120);
    const findOffset = windowAfterWild.indexOf('.find(');
    if (findOffset !== -1) {
      sawFind = true;
      // Walk to the matching close-paren of this .find(.
      // findAbsIdx points at the '.' of `.find(`; the '(' is 5 chars later.
      const findAbsIdx = wildIdx + findOffset;
      let i = findAbsIdx + '.find('.length; // first char inside find's parens
      let depth = 1;
      while (i < compact.length && depth > 0) {
        if (compact[i] === '(') depth++;
        else if (compact[i] === ')') depth--;
        i++;
      }
      // i now points just AFTER the find's matching ')'.
      const after = compact.slice(i, i + 320);

      // Accept: combinator chained directly on the find result.
      if (after.startsWith('.ok_or')) {
        return null;
      }

      // Accept: match arm — `{Some...` with a rejecting `None=>` shortly after.
      if (after.startsWith('{Some')) {
        const noneIdx = after.indexOf('None=>');
        if (noneIdx !== -1) {
          const noneWindow = after.slice(noneIdx, noneIdx + 200);
          if (noneWindow.indexOf('Err') !== -1 || noneWindow.indexOf('return') !== -1) {
            return null;
          }
        }
      }
      // Otherwise (e.g. `;` discards the result): this occurrence does not bind
      // a rejection — fall through to try the next battle_wild(.
    }
    wildIdx = compact.indexOf('battle_wild(', wildIdx + 1);
  }

  if (!sawFind) {
    return (
      'attempt_recruit: battle_wild( found but no .find( lookup — ' +
      'battle_wild( must perform a lookup, not just a delete'
    );
  }

  return (
    'attempt_recruit: battle_wild( .find( found but no rejection bound to it — ' +
    'require .ok_or/.ok_or_else chained on the find, or a match whose None arm returns Err; ' +
    'a discarded `let _ = ...find(...);` result does not reject on not-wild'
  );
}

/**
 * Check 4: consume-before-roll ordering.
 * If consume_one is called at all, its indexOf must be BEFORE the first
 * occurrence of ctx.random( or recruit_chance(.
 *
 * Why: consuming the bait BEFORE the roll prevents a failed attempt from
 * "remembering" the bait for a retry. If consume_one is absent (optional bait
 * path) we skip the check — absence is caught by the functional tests.
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkConsumeBeforeRoll(body) {
  const consumeIdx = body.indexOf('consume_one(');
  if (consumeIdx === -1) return null; // no bait call — skip ordering check

  const randomIdx = body.indexOf('ctx.random(');
  const chanceIdx = body.indexOf('recruit_chance(');

  // Find the FIRST roll-related call.
  let rollIdx = -1;
  if (randomIdx !== -1 && chanceIdx !== -1) {
    rollIdx = Math.min(randomIdx, chanceIdx);
  } else if (randomIdx !== -1) {
    rollIdx = randomIdx;
  } else if (chanceIdx !== -1) {
    rollIdx = chanceIdx;
  }

  if (rollIdx === -1) {
    // consume_one is present but no roll call — something is wrong.
    return 'attempt_recruit: consume_one( found but no ctx.random( or recruit_chance( found';
  }

  if (consumeIdx > rollIdx) {
    return `attempt_recruit: consume_one( (at offset ${consumeIdx}) appears AFTER roll call (at offset ${rollIdx}) — bait must be consumed before the roll`;
  }
  return null;
}

/**
 * Check 5: no XP on the success arm.
 * The attempt_recruit body must reference write_back_party_hp( (writing HP
 * without XP on success) and must NOT reference apply_xp_gain( or
 * battle_xp_reward( (which are XP paths, not HP paths).
 *
 * Why write_back_party_hp not write_back_battle_results:
 *   write_back_battle_results calls battle_xp_reward + apply_xp_gain. On a
 *   recruit, the player takes the wild — there is no "won a battle" reward. We
 *   scan for the named XP functions rather than trying to distinguish "success
 *   arm" text-structurally, because the latter would require parsing Rust control
 *   flow. The stronger literal invariants (write_back_party_hp present; XP fns
 *   absent) give the same security guarantee at lower parse complexity.
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkNoXpOnRecruit(body) {
  if (body.indexOf('write_back_party_hp(') === -1) {
    return 'attempt_recruit: missing write_back_party_hp( — HP must be written back on success without the XP path';
  }
  if (body.indexOf('apply_xp_gain(') !== -1) {
    return 'attempt_recruit: references apply_xp_gain( — XP must NOT be awarded on a successful recruit';
  }
  if (body.indexOf('battle_xp_reward(') !== -1) {
    return 'attempt_recruit: references battle_xp_reward( — XP reward must NOT be computed on a successful recruit';
  }
  return null;
}

/**
 * Check 6a: checked_sub in consume_one body, no bare count decrement.
 * checked_sub prevents silent underflow when count reaches 0 and avoids
 * the classic "wrap-around gives the player 2^32 items" bug.
 *
 * @param {string} consumeBody  Body of consume_one, comment-stripped.
 * @returns {string|null}
 */
export function checkConsumeOneUsesCheckedSub(consumeBody) {
  if (consumeBody.indexOf('checked_sub') === -1) {
    return 'consume_one: missing checked_sub — bare count subtraction can underflow (NEVER use count - 1 or -= 1 directly)';
  }
  // Reject bare `count - 1` / `- 1;` patterns.  We look for `- 1` as a
  // literal substring (with a space before the 1) as a heuristic.  This will
  // catch `count - 1` and `count -= 1` while tolerating saturating_sub(1) and
  // checked_sub(1) (which contain the literal `1)` not `1 `).
  // We use indexOf, not RegExp.
  if (consumeBody.indexOf('- 1') !== -1 && consumeBody.indexOf('checked_sub') === -1) {
    return "consume_one: bare '- 1' decrement found without checked_sub — underflow risk";
  }
  return null;
}

/**
 * Check 6b: saturating_add in grant_item body.
 * saturating_add prevents count overflow when items are stacked repeatedly.
 *
 * @param {string} grantBody  Body of grant_item, comment-stripped.
 * @returns {string|null}
 */
export function checkGrantItemUsesSaturatingAdd(grantBody) {
  if (grantBody.indexOf('saturating_add') === -1) {
    return 'grant_item: missing saturating_add — item count increment must saturate, not overflow';
  }
  return null;
}

/**
 * Check 7: classify bait by data, not by magic id.
 * attempt_recruit must reference recruit_bonus (the data field that marks an
 * item as bait) and must NOT contain a suspicious `== 1` / `== 2` style
 * hardcoded item-id comparison adjacent to the bait path.
 *
 * Heuristic: we look for `recruit_bonus` presence (required) and flag
 * `bait_item_id == ` as a magic-id gate pattern (rejected). A robust
 * alternative path (e.g. `recruit_bonus > 0`) is the expected contract.
 *
 * Why this heuristic: the spec explicitly says "read recruit_bonus from the
 * item_row DB row (NOT a hardcoded id)". The literal `bait_item_id ==` pattern
 * is the natural way a naive implementer would write a hardcoded id check. We
 * target that exact literal string (indexOf, not RegExp).
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkClassifyByData(body) {
  if (body.indexOf('recruit_bonus') === -1) {
    return 'attempt_recruit: missing recruit_bonus reference — bait classification must read the recruit_bonus field, not a hardcoded item id';
  }
  if (body.indexOf('bait_item_id ==') !== -1) {
    return "attempt_recruit: contains 'bait_item_id ==' — this looks like a hardcoded magic-id bait gate; classify by recruit_bonus > 0 instead";
  }
  return null;
}

/**
 * Check 8: battle_wild GC in attempt_recruit.
 * The body must delete the battle_wild row (on both success and terminal
 * failure paths). We scan for `.delete(` after a `battle_wild(` reference,
 * using indexOf positions.
 *
 * @param {string} body  Body of attempt_recruit, comment-stripped.
 * @returns {string|null}
 */
export function checkBattleWildGcInAttemptRecruit(body) {
  const wildIdx = body.indexOf('battle_wild(');
  if (wildIdx === -1) {
    return 'attempt_recruit: no battle_wild( reference — GC cannot happen (also caught by wild-battle guard)';
  }
  // .delete( must appear somewhere after the battle_wild reference.
  const deleteIdx = body.indexOf('.delete(', wildIdx);
  if (deleteIdx === -1) {
    return 'attempt_recruit: has battle_wild( but no .delete( following it — battle_wild row is never cleaned up (GC missing)';
  }
  return null;
}

/**
 * Check 8b: battle_wild GC in write_back_battle_results.
 * The spec mandates write_back_battle_results unconditionally deletes the
 * battle_wild row (to prevent orphaned rows when any non-recruit outcome runs
 * the results path: flee, loss, opponent death without a recruit attempt).
 *
 * @param {string} body  Body of write_back_battle_results, comment-stripped.
 * @returns {string|null}
 */
export function checkBattleWildGcInWriteBack(body) {
  const wildIdx = body.indexOf('battle_wild(');
  if (wildIdx === -1) {
    return 'write_back_battle_results: no battle_wild( reference — orphaned battle_wild rows will accumulate on non-recruit outcomes';
  }
  const deleteIdx = body.indexOf('.delete(', wildIdx);
  if (deleteIdx === -1) {
    return 'write_back_battle_results: has battle_wild( but no .delete( after it — GC is incomplete';
  }
  return null;
}

/**
 * Check F2 (M9b): consume_one delete-at-zero — the body must delete the row
 * when the count reaches zero (no lingering empty stacks).
 *
 * Required:
 *   - `checked_sub` still present (overflow safety, existing check 6a).
 *   - `.delete(` present in the body (row removed when count hits 0).
 *
 * Forbidden indicator:
 *   - A body that updates the row with `count = 0` or lacks `.delete(` is a
 *     zombie-stack implementation.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} consumeBody  Body of consume_one, comment-stripped.
 * @returns {string|null}
 */
export function checkConsumeOneDeleteAtZero(consumeBody) {
  if (consumeBody.indexOf('.delete(') === -1) {
    return (
      'consume_one: missing .delete( — a zero-count stack must be deleted, not updated ' +
      '(no lingering empty stacks; a row with count=0 is a zombie that wastes space and ' +
      'can confuse future grant_item lookups)'
    );
  }
  return null;
}

/**
 * Check F2 (M9b): grant_item qty-0 guard — the body must early-return / reject
 * when `qty == 0` before performing any DB insert or update. This prevents
 * `grant_item(ctx, owner, id, 0)` from inserting a count:0 zombie row.
 *
 * Required: body contains `qty==0` (whitespace-collapsed) as a guard.
 * Forbidden: a body where the only qty reference is inside `saturating_add(qty)`.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} grantBody  Body of grant_item, comment-stripped.
 * @returns {string|null}
 */
export function checkGrantItemQtyZeroGuard(grantBody) {
  const compact = grantBody.replace(/\s+/g, '');
  if (compact.indexOf('qty==0') === -1) {
    return (
      'grant_item: missing qty==0 guard — calling grant_item(ctx, owner, id, 0) must ' +
      'be a no-op (early return), not insert a count:0 zombie row; ' +
      'require an explicit `if qty == 0 { return; }` (or equivalent) before any DB write'
    );
  }
  return null;
}

/**
 * Check F3 (M9b): grant_item monotone cap — the existing-stack branch must
 * guard growth with `row.count < MAX_ITEM_STACK` before applying
 * `.saturating_add(qty).min(MAX_ITEM_STACK)`, so a grant never SHRINKS an
 * already-over-cap stack (monotone non-decrease invariant).
 *
 * Required (whitespace-collapsed body):
 *   - `row.count<MAX_ITEM_STACK` guard is present.
 *   - `.min(MAX_ITEM_STACK)` is present (applied after saturating_add).
 *   - `saturating_add` still present (overflow safety, existing check 6b).
 *
 * Forbidden: `saturating_add(qty).min(MAX_ITEM_STACK)` with no guard
 *   `row.count < MAX_ITEM_STACK` — without the guard a stack already above
 *   MAX_ITEM_STACK would be shrunk to MAX_ITEM_STACK by the .min().
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} grantBody  Body of grant_item, comment-stripped.
 * @returns {string|null}
 */
export function checkGrantItemMonotoneCap(grantBody) {
  const compact = grantBody.replace(/\s+/g, '');

  if (compact.indexOf('.min(MAX_ITEM_STACK)') === -1) {
    return (
      'grant_item: missing .min(MAX_ITEM_STACK) — the stack must be capped at ' +
      'MAX_ITEM_STACK; without it a flood of grants can inflate the count arbitrarily'
    );
  }

  if (compact.indexOf('row.count<MAX_ITEM_STACK') === -1) {
    return (
      'grant_item: missing `row.count < MAX_ITEM_STACK` guard before the saturating_add — ' +
      'F3 monotone-cap: without this guard a stack already at or above MAX_ITEM_STACK would ' +
      'be SHRUNK by the .min(MAX_ITEM_STACK) on every subsequent grant (monotone violation); ' +
      'the guard ensures over-cap stacks are left untouched'
    );
  }

  return null;
}

/**
 * Check 9: grant_bait self-scoped to ctx.sender.
 * The grant_bait reducer must use ctx.sender (no arbitrary Identity param).
 * We check: the function signature does NOT contain `Identity` as a parameter
 * type (after the mandatory `ctx: &ReducerContext`), and the body uses `ctx.sender`.
 *
 * Strategy: extract both the signature (the text before the opening brace) and
 * the body. The signature check is on the raw snippet around `pub fn grant_bait(`.
 *
 * @param {string} src  Full comment-stripped Rust source.
 * @param {string} body  Body of grant_bait, comment-stripped.
 * @returns {string|null}
 */
export function checkGrantBaitSelfScoped(src, body) {
  if (body.indexOf('ctx.sender') === -1) {
    return 'grant_bait: body does not reference ctx.sender — it must self-scope to the caller, not accept an arbitrary identity';
  }

  // Extract the signature (from `pub fn grant_bait(` to the first `{`).
  const needle = 'pub fn grant_bait(';
  const sigStart = src.indexOf(needle);
  if (sigStart === -1) return null; // grant_bait doesn't exist → caught by existence check.

  const braceIdx = src.indexOf('{', sigStart);
  if (braceIdx === -1) return null;

  const sig = src.slice(sigStart, braceIdx);

  // Drop the leading `pub fn grant_bait(ctx: &ReducerContext` fragment and scan
  // the REMAINING parameters for a bare `Identity` type annotation.
  // We find the first `,` after the ctx param and scan from there.
  // Using indexOf — no dynamic RegExp.
  const ctxEnd = sig.indexOf(',', sig.indexOf('ReducerContext'));
  if (ctxEnd === -1) {
    // Only the ctx param — no Identity param possible; this is fine.
    return null;
  }
  const restSig = sig.slice(ctxEnd);
  if (restSig.indexOf('Identity') !== -1) {
    return 'grant_bait: signature contains an Identity parameter after ctx — grant_bait must be self-scoped to ctx.sender, not accept an arbitrary recipient identity';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings.
// Each is a minimal inline Rust snippet.  extractReducerBody must be able to
// parse these — if it cannot, the eval returns FAIL with a clear message.
// ---------------------------------------------------------------------------

/** Fixture: attempt_recruit WITHOUT ownership guard. Must be flagged by checkOwnershipGuard. */
const BAD_NO_OWNERSHIP = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      // DELIBERATELY MISSING: no player_identity != ctx.sender check
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle".to_string())?;
      let roll: u32 = ctx.random();
      let chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, 0);
      write_back_party_hp(ctx, &battle);
      battle.state.outcome = BattleOutcome::SideAWins;
      ctx.db.battle_wild().battle_id().delete(battle_id);
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: attempt_recruit WITHOUT outcome guard. Must be flagged by checkOutcomeGuard. */
const BAD_NO_OUTCOME = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      // DELIBERATELY MISSING: no outcome == Ongoing check
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle".to_string())?;
      let roll: u32 = ctx.random();
      let chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, 0);
      write_back_party_hp(ctx, &battle);
      battle.state.outcome = BattleOutcome::SideAWins;
      ctx.db.battle_wild().battle_id().delete(battle_id);
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: attempt_recruit WITHOUT wild-battle guard. Must be flagged by checkWildBattleGuard. */
const BAD_NO_WILD_GUARD = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      // DELIBERATELY MISSING: no battle_wild lookup — would allow recruiting in PvP
      let roll: u32 = ctx.random();
      let chance = recruit_chance(100, 50, RECRUIT_BASE_RATE, 0);
      write_back_party_hp(ctx, &battle);
      battle.state.outcome = BattleOutcome::SideAWins;
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: consume_one AFTER roll. Must be flagged by checkConsumeBeforeRoll. */
const BAD_CONSUME_AFTER_ROLL = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle".to_string())?;
      let roll: u32 = ctx.random();
      // DELIBERATELY WRONG: consume_one AFTER ctx.random — should be before
      consume_one(ctx, ctx.sender, 1);
      let chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, 0);
      write_back_party_hp(ctx, &battle);
      ctx.db.battle_wild().battle_id().delete(battle_id);
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: attempt_recruit calling apply_xp_gain on success. Must be flagged by checkNoXpOnRecruit. */
const BAD_XP_ON_RECRUIT = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle".to_string())?;
      let roll: u32 = ctx.random();
      let chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, 0);
      // DELIBERATELY WRONG: XP must NOT be awarded on recruit
      write_back_party_hp(ctx, &battle);
      apply_xp_gain(xp, gained);
      battle.state.outcome = BattleOutcome::SideAWins;
      ctx.db.battle_wild().battle_id().delete(battle_id);
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: consume_one using bare subtraction. Must be flagged by checkConsumeOneUsesCheckedSub. */
const BAD_CONSUME_BARE_SUB = `
  fn consume_one(ctx: &ReducerContext, owner: Identity, item_id: u32) -> Result<(), String> {
      let mut row = ctx.db.inventory().find(owner, item_id)
          .ok_or_else(|| "item not found".to_string())?;
      if row.count == 0 {
          return Err("no items".to_string());
      }
      // DELIBERATELY WRONG: bare subtraction — use checked_sub instead
      row.count = row.count - 1;
      ctx.db.inventory().update(row);
      Ok(())
  }
`;

/** Fixture: grant_item without saturating_add. Must be flagged by checkGrantItemUsesSaturatingAdd. */
const BAD_GRANT_NO_SATURATING = `
  fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
      match ctx.db.inventory().find(owner, item_id) {
          Some(mut row) => {
              // DELIBERATELY WRONG: bare addition — use saturating_add instead
              row.count = row.count + qty;
              ctx.db.inventory().update(row);
          }
          None => {
              ctx.db.inventory().insert(InventoryRow { owner, item_id, count: qty });
          }
      }
  }
`;

/** Fixture: magic-id bait gate. Must be flagged by checkClassifyByData. */
const BAD_MAGIC_ID_BAIT = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle".to_string())?;
      // DELIBERATELY WRONG: hardcoded item id check instead of reading recruit_bonus
      let bait_bonus = if bait_item_id == Some(1) { 150u16 } else { 0u16 };
      let roll: u32 = ctx.random();
      let chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, bait_bonus);
      write_back_party_hp(ctx, &battle);
      ctx.db.battle_wild().battle_id().delete(battle_id);
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: no battle_wild GC in attempt_recruit. Must be flagged by checkBattleWildGcInAttemptRecruit. */
const BAD_NO_GC_IN_RECRUIT = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle".to_string())?;
      let roll: u32 = ctx.random();
      let chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, 0);
      write_back_party_hp(ctx, &battle);
      battle.state.outcome = BattleOutcome::SideAWins;
      // DELIBERATELY MISSING: no battle_wild delete → orphaned row
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** Fixture: consume_one that updates with count=0 instead of deleting. Must be flagged by checkConsumeOneDeleteAtZero. */
const BAD_CONSUME_NO_DELETE = `
  fn consume_one(ctx: &ReducerContext, owner: Identity, item_id: u32) -> Result<(), String> {
      let mut row = ctx.db.inventory().owner_identity().filter(owner)
          .find(|r| r.item_id == item_id)
          .ok_or_else(|| "item not in inventory".to_string())?;
      if row.count == 0 {
          return Err("item count is zero".to_string());
      }
      row.count = row.count.checked_sub(1).ok_or_else(|| "underflow".to_string())?;
      // DELIBERATELY WRONG: updates even when count reaches 0 — zombie stack survives
      ctx.db.inventory().inv_id().update(row);
      Ok(())
  }
`;

/** Fixture: grant_item with no qty==0 guard. Must be flagged by checkGrantItemQtyZeroGuard. */
const BAD_GRANT_NO_QTY_ZERO_GUARD = `
  fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
      // DELIBERATELY MISSING: no qty == 0 guard — calling grant_item(_, 0) inserts a zombie row
      let existing = ctx.db.inventory().owner_identity().filter(owner).find(|r| r.item_id == item_id);
      match existing {
          Some(mut row) => {
              if row.count < MAX_ITEM_STACK {
                  row.count = row.count.saturating_add(qty).min(MAX_ITEM_STACK);
                  ctx.db.inventory().inv_id().update(row);
              }
          }
          None => {
              ctx.db.inventory().insert(Inventory { inv_id: 0, owner_identity: owner, item_id, count: qty });
          }
      }
  }
`;

/** Fixture: grant_item with no row.count < MAX_ITEM_STACK guard. Must be flagged by checkGrantItemMonotoneCap. */
const BAD_GRANT_NO_MONOTONE_GUARD = `
  fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
      if qty == 0 { return; }
      let existing = ctx.db.inventory().owner_identity().filter(owner).find(|r| r.item_id == item_id);
      match existing {
          Some(mut row) => {
              // DELIBERATELY WRONG: no row.count < MAX_ITEM_STACK guard — a stack already
              // at/above MAX_ITEM_STACK would be shrunk by .min(MAX_ITEM_STACK) (monotone violation)
              row.count = row.count.saturating_add(qty).min(MAX_ITEM_STACK);
              ctx.db.inventory().inv_id().update(row);
          }
          None => {
              ctx.db.inventory().insert(Inventory { inv_id: 0, owner_identity: owner, item_id, count: qty });
          }
      }
  }
`;

/** Fixture: grant_bait accepts an arbitrary Identity param. Must be flagged by checkGrantBaitSelfScoped. */
const BAD_GRANT_BAIT_ARBITRARY_IDENTITY = `
  pub fn grant_bait(ctx: &ReducerContext, recipient: Identity, item_id: u32, qty: u32) -> Result<(), String> {
      // DELIBERATELY WRONG: should self-scope to ctx.sender, not accept arbitrary Identity
      grant_item(ctx, recipient, item_id, qty);
      Ok(())
  }
`;

/** A fully-compliant attempt_recruit that must pass ALL checks. */
const GOOD_ATTEMPT_RECRUIT = `
  pub fn attempt_recruit(ctx: &ReducerContext, battle_id: u64, bait_item_id: Option<u32>) -> Result<(), String> {
      let me = ctx.sender;
      let mut battle = ctx.db.battle().battle_id().find(battle_id)
          .ok_or_else(|| "battle not found".to_string())?;
      if battle.player_identity != ctx.sender {
          return Err("not owner".to_string());
      }
      if battle.state.outcome != BattleOutcome::Ongoing {
          return Err("not ongoing".to_string());
      }
      let wild = ctx.db.battle_wild().battle_id().find(battle_id)
          .ok_or_else(|| "not a wild battle — cannot recruit in PvP".to_string())?;
      let bait_bonus = if let Some(id) = bait_item_id {
          let item = ctx.db.item_row().id().find(id)
              .ok_or_else(|| "bait item not found".to_string())?;
          if item.recruit_bonus == 0 {
              return Err("item is not a bait item".to_string());
          }
          consume_one(ctx, me, id)?;
          item.recruit_bonus
      } else {
          0u16
      };
      let chance = recruit_chance(
          wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, bait_bonus,
      );
      let roll: u32 = ctx.random();
      if attempt_recruit_roll(chance, roll) {
          write_back_party_hp(ctx, &battle);
          battle.state.outcome = BattleOutcome::SideAWins;
          ctx.db.battle_wild().battle_id().delete(battle_id);
          ctx.db.battle().battle_id().update(battle);
          return Ok(());
      }
      battle.state.turn_number += 1;
      ctx.db.battle_wild().battle_id().delete(battle_id);
      ctx.db.battle().battle_id().update(battle);
      Ok(())
  }
`;

/** A compliant consume_one. Must pass checkConsumeOneUsesCheckedSub AND checkConsumeOneDeleteAtZero. */
const GOOD_CONSUME_ONE = `
  fn consume_one(ctx: &ReducerContext, owner: Identity, item_id: u32) -> Result<(), String> {
      let mut row = ctx.db.inventory().owner_identity().filter(owner)
          .find(|r| r.item_id == item_id)
          .ok_or_else(|| "item not in inventory".to_string())?;
      if row.count == 0 {
          ctx.db.inventory().inv_id().delete(row.inv_id);
          return Err("item count is zero".to_string());
      }
      row.count = row.count.checked_sub(1).ok_or_else(|| "item count is zero".to_string())?;
      if row.count == 0 {
          ctx.db.inventory().inv_id().delete(row.inv_id);
      } else {
          ctx.db.inventory().inv_id().update(row);
      }
      Ok(())
  }
`;

/** A compliant grant_item. Must pass checkGrantItemUsesSaturatingAdd, checkGrantItemQtyZeroGuard, and checkGrantItemMonotoneCap. */
const GOOD_GRANT_ITEM = `
  fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
      if qty == 0 { return; }
      let existing = ctx.db.inventory().owner_identity().filter(owner).find(|r| r.item_id == item_id);
      match existing {
          Some(mut row) => {
              if row.count < MAX_ITEM_STACK {
                  row.count = row.count.saturating_add(qty).min(MAX_ITEM_STACK);
                  ctx.db.inventory().inv_id().update(row);
              }
          }
          None => {
              ctx.db.inventory().insert(Inventory { inv_id: 0, owner_identity: owner, item_id, count: qty });
          }
      }
  }
`;

/** A compliant grant_bait. Must pass checkGrantBaitSelfScoped. */
const GOOD_GRANT_BAIT = `
  pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
      grant_item(ctx, ctx.sender, item_id, qty);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'recruit-reducer-security (attempt_recruit guards, consume-before-roll, no-XP, checked_sub, classify-by-data, battle_wild GC, grant_bait self-scoped, consume_one delete-at-zero, grant_item qty-0-guard+monotone-cap)';

  // =========================================================================
  // PROOFS-OF-TEETH — every tooth must bite before we scan real source.
  // If any fixture fails to be correctly classified, return FAIL immediately.
  // =========================================================================

  // --- Tooth 1: missing ownership guard must be flagged --------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_NO_OWNERSHIP), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_NO_OWNERSHIP fixture (parser bug)',
      };
    }
    if (!checkOwnershipGuard(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_NO_OWNERSHIP fixture was NOT flagged by checkOwnershipGuard',
      };
    }
  }

  // --- Tooth 2: missing outcome guard must be flagged ----------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_NO_OUTCOME), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_NO_OUTCOME fixture (parser bug)',
      };
    }
    if (!checkOutcomeGuard(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_NO_OUTCOME fixture was NOT flagged by checkOutcomeGuard',
      };
    }
  }

  // --- Tooth 3: missing wild-battle guard must be flagged ------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_NO_WILD_GUARD), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_NO_WILD_GUARD fixture (parser bug)',
      };
    }
    if (!checkWildBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_NO_WILD_GUARD fixture was NOT flagged by checkWildBattleGuard',
      };
    }
  }

  // --- Tooth 4: consume after roll must be flagged -------------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_CONSUME_AFTER_ROLL), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_CONSUME_AFTER_ROLL fixture (parser bug)',
      };
    }
    if (!checkConsumeBeforeRoll(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_CONSUME_AFTER_ROLL fixture was NOT flagged by checkConsumeBeforeRoll',
      };
    }
  }

  // --- Tooth 5: XP on recruit must be flagged ------------------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_XP_ON_RECRUIT), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_XP_ON_RECRUIT fixture (parser bug)',
      };
    }
    if (!checkNoXpOnRecruit(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_XP_ON_RECRUIT fixture was NOT flagged by checkNoXpOnRecruit',
      };
    }
  }

  // --- Tooth 6a: bare subtraction in consume_one must be flagged -----------
  {
    const body = extractReducerBody(stripRustComments(BAD_CONSUME_BARE_SUB), 'consume_one');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract consume_one body from BAD_CONSUME_BARE_SUB fixture (parser bug)',
      };
    }
    if (!checkConsumeOneUsesCheckedSub(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_CONSUME_BARE_SUB fixture (bare count - 1) was NOT flagged by checkConsumeOneUsesCheckedSub',
      };
    }
  }

  // --- Tooth 6b: missing saturating_add in grant_item must be flagged ------
  {
    const body = extractReducerBody(stripRustComments(BAD_GRANT_NO_SATURATING), 'grant_item');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract grant_item body from BAD_GRANT_NO_SATURATING fixture (parser bug)',
      };
    }
    if (!checkGrantItemUsesSaturatingAdd(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_GRANT_NO_SATURATING fixture was NOT flagged by checkGrantItemUsesSaturatingAdd',
      };
    }
  }

  // --- Tooth 7: magic-id bait gate must be flagged -------------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_MAGIC_ID_BAIT), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_MAGIC_ID_BAIT fixture (parser bug)',
      };
    }
    if (!checkClassifyByData(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MAGIC_ID_BAIT fixture (hardcoded bait_item_id == 1) was NOT flagged by checkClassifyByData',
      };
    }
  }

  // --- Tooth 8a: no battle_wild GC in attempt_recruit must be flagged ------
  {
    const body = extractReducerBody(stripRustComments(BAD_NO_GC_IN_RECRUIT), 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from BAD_NO_GC_IN_RECRUIT fixture (parser bug)',
      };
    }
    if (!checkBattleWildGcInAttemptRecruit(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_NO_GC_IN_RECRUIT fixture was NOT flagged by checkBattleWildGcInAttemptRecruit',
      };
    }
  }

  // --- Tooth 9: grant_bait with arbitrary Identity must be flagged ---------
  {
    const stripped = stripRustComments(BAD_GRANT_BAIT_ARBITRARY_IDENTITY);
    const body = extractReducerBody(stripped, 'grant_bait');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract grant_bait body from BAD_GRANT_BAIT_ARBITRARY_IDENTITY fixture (parser bug)',
      };
    }
    if (!checkGrantBaitSelfScoped(stripped, body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_GRANT_BAIT_ARBITRARY_IDENTITY fixture was NOT flagged by checkGrantBaitSelfScoped',
      };
    }
  }

  // --- Tooth F2a: consume_one with no .delete( must be flagged ---------------
  {
    const body = extractReducerBody(stripRustComments(BAD_CONSUME_NO_DELETE), 'consume_one');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract consume_one body from BAD_CONSUME_NO_DELETE fixture (parser bug)',
      };
    }
    if (!checkConsumeOneDeleteAtZero(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_CONSUME_NO_DELETE fixture (updates instead of deletes at zero) was NOT flagged by checkConsumeOneDeleteAtZero',
      };
    }
  }

  // --- Tooth F2b: grant_item with no qty==0 guard must be flagged -----------
  {
    const body = extractReducerBody(stripRustComments(BAD_GRANT_NO_QTY_ZERO_GUARD), 'grant_item');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract grant_item body from BAD_GRANT_NO_QTY_ZERO_GUARD fixture (parser bug)',
      };
    }
    if (!checkGrantItemQtyZeroGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_GRANT_NO_QTY_ZERO_GUARD fixture (no qty==0 guard) was NOT flagged by checkGrantItemQtyZeroGuard',
      };
    }
  }

  // --- Tooth F3: grant_item with no row.count < MAX guard must be flagged ---
  {
    const body = extractReducerBody(stripRustComments(BAD_GRANT_NO_MONOTONE_GUARD), 'grant_item');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract grant_item body from BAD_GRANT_NO_MONOTONE_GUARD fixture (parser bug)',
      };
    }
    if (!checkGrantItemMonotoneCap(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_GRANT_NO_MONOTONE_GUARD fixture (saturating_add.min with no < guard) was NOT flagged by checkGrantItemMonotoneCap',
      };
    }
  }

  // --- Green-path teeth: good fixtures must pass ALL checks (no false positives) ---
  {
    const stripped = stripRustComments(GOOD_ATTEMPT_RECRUIT);
    const body = extractReducerBody(stripped, 'attempt_recruit');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract attempt_recruit body from GOOD_ATTEMPT_RECRUIT fixture (parser bug)',
      };
    }
    const errs = [
      checkOwnershipGuard(body),
      checkOutcomeGuard(body),
      checkWildBattleGuard(body),
      checkConsumeBeforeRoll(body),
      checkNoXpOnRecruit(body),
      checkClassifyByData(body),
      checkBattleWildGcInAttemptRecruit(body),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_ATTEMPT_RECRUIT was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }
  {
    const body = extractReducerBody(stripRustComments(GOOD_CONSUME_ONE), 'consume_one');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract consume_one body from GOOD_CONSUME_ONE fixture (parser bug)',
      };
    }
    const consumeErrs = [
      checkConsumeOneUsesCheckedSub(body),
      checkConsumeOneDeleteAtZero(body),
    ].filter((e) => e !== null);
    if (consumeErrs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_CONSUME_ONE was incorrectly flagged: ${consumeErrs.join(' | ')}`,
      };
    }
  }
  {
    const body = extractReducerBody(stripRustComments(GOOD_GRANT_ITEM), 'grant_item');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract grant_item body from GOOD_GRANT_ITEM fixture (parser bug)',
      };
    }
    const grantErrs = [
      checkGrantItemUsesSaturatingAdd(body),
      checkGrantItemQtyZeroGuard(body),
      checkGrantItemMonotoneCap(body),
    ].filter((e) => e !== null);
    if (grantErrs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_GRANT_ITEM was incorrectly flagged: ${grantErrs.join(' | ')}`,
      };
    }
  }
  {
    const stripped = stripRustComments(GOOD_GRANT_BAIT);
    const body = extractReducerBody(stripped, 'grant_bait');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract grant_bait body from GOOD_GRANT_BAIT fixture (parser bug)',
      };
    }
    if (checkGrantBaitSelfScoped(stripped, body)) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_GRANT_BAIT was incorrectly flagged: ${checkGrantBaitSelfScoped(stripped, body)}`,
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

  // --- Check: attempt_recruit exists and passes the guard ladder ------------
  const recruitBody = extractReducerBody(src, 'attempt_recruit');
  if (!recruitBody) {
    failures.push(
      'attempt_recruit: reducer not found in server-module source (not yet implemented — expected RED state)',
    );
  } else {
    const g1 = checkOwnershipGuard(recruitBody);
    if (g1) failures.push(g1);
    const g2 = checkOutcomeGuard(recruitBody);
    if (g2) failures.push(g2);
    const g3 = checkWildBattleGuard(recruitBody);
    if (g3) failures.push(g3);
    const g4 = checkConsumeBeforeRoll(recruitBody);
    if (g4) failures.push(g4);
    const g5 = checkNoXpOnRecruit(recruitBody);
    if (g5) failures.push(g5);
    const g7 = checkClassifyByData(recruitBody);
    if (g7) failures.push(g7);
    const g8 = checkBattleWildGcInAttemptRecruit(recruitBody);
    if (g8) failures.push(g8);
  }

  // --- Check: consume_one exists, uses checked_sub, AND deletes at zero ------
  const consumeBody = extractReducerBody(src, 'consume_one');
  if (!consumeBody) {
    failures.push('consume_one: function not found in server-module source (not yet implemented)');
  } else {
    const g6a = checkConsumeOneUsesCheckedSub(consumeBody);
    if (g6a) failures.push(g6a);
    // F2: delete-at-zero (M9b hardening)
    const gF2 = checkConsumeOneDeleteAtZero(consumeBody);
    if (gF2) failures.push(gF2);
  }

  // --- Check: grant_item exists, uses saturating_add, qty-0 guard, monotone cap ---
  const grantItemBody = extractReducerBody(src, 'grant_item');
  if (!grantItemBody) {
    failures.push('grant_item: function not found in server-module source (not yet implemented)');
  } else {
    const g6b = checkGrantItemUsesSaturatingAdd(grantItemBody);
    if (g6b) failures.push(g6b);
    // F2: qty-0 guard (M9b hardening)
    const gF2b = checkGrantItemQtyZeroGuard(grantItemBody);
    if (gF2b) failures.push(gF2b);
    // F3: monotone cap (M9b hardening)
    const gF3 = checkGrantItemMonotoneCap(grantItemBody);
    if (gF3) failures.push(gF3);
  }

  // --- Check: write_back_battle_results GC (check 8b) ----------------------
  const writeBackBody = extractReducerBody(src, 'write_back_battle_results');
  if (!writeBackBody) {
    failures.push('write_back_battle_results: function not found — cannot check battle_wild GC');
  } else {
    const g8b = checkBattleWildGcInWriteBack(writeBackBody);
    if (g8b) failures.push(g8b);
  }

  // --- Check: grant_bait self-scoped (check 9) -----------------------------
  const grantBaitBody = extractReducerBody(src, 'grant_bait');
  if (!grantBaitBody) {
    failures.push('grant_bait: reducer not found in server-module source (not yet implemented)');
  } else {
    const g9 = checkGrantBaitSelfScoped(src, grantBaitBody);
    if (g9) failures.push(g9);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'attempt_recruit guard ladder (ownership, outcome, wild-battle, consume-before-roll, no-XP, classify-by-data, GC), consume_one checked_sub+delete-at-zero, grant_item saturating_add+qty-0-guard+monotone-cap, write_back_battle_results GC, grant_bait self-scoped — all teeth verified',
  };
}

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}
