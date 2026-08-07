// evolution-reducer-security eval (EG1 rewrite, ADR-0174; formerly ADR-0061/0062/0147):
// The `evolve` reducer in server-module/src/evolution.rs must satisfy a security
// invariant ladder so no player can mutate another player's monsters, evolve a
// monster that is mid-battle, or bypass the shared essence-graph gate.
//
// EG1 (ADR-0174 D3) DELETED fusion as a feature: the `fuse` reducer, its
// eligibility helper chain (`reject_if_not_fusable` / `game_core::fusion_eligible`)
// and every fuse-specific check that lived here (E1-fuse-twice, E2-fuse-twice,
// the E3 delegation ladder, fuse body extraction) are gone with it. `evolve` is
// now the two-argument essence-graph edge walk: `evolve(ctx, monster_id, to_species)`.
//
// EG5-2 (spec §2 EG5-2, per EG2-10) ADDS the essence_train /
// consume_crystalized_essence invariant ladder S1-S6 below, and HARDENS E2 so
// evolve's battle guard must actually be both-role.
//
// EG2 (ADR-0175 D3/D6) factored the transform-and-write OUT of `evolve` into
// the shared `apply_evolution(ctx, monster_id, &EvolutionPathRow)` helper (the
// ONE transform path, called by both `evolve` and `check_and_evolve`). The
// dual-write and SSOT-transform invariants therefore now bind
// `apply_evolution`'s body, and a NEW delegation check binds `evolve`'s: it
// must actually CALL apply_evolution(, so the delegation cannot be satisfied by
// an orphan helper nobody invokes.
//
// Invariants checked:
//
//   E1. Ownership guard — evolve calls require_owner( for the input monster.
//   E2. Battle guard — evolve calls reject_if_in_battle(, AND (EG5-2 hardening,
//       plan addendum item 5) that call's own argument region must cover BOTH
//       the player_identity() AND the opponent_identity() chains: unlike
//       is_in_ongoing_battle (both-role BY CONSTRUCTION, guards.rs:286-307),
//       reject_if_in_battle only sees the iterator the CALL SITE hands it, so a
//       player_identity()-only call silently lets side B of an ongoing PvP
//       battle evolve (ADR-0122/ADR-0136 both-role discipline).
//   E3. Delegation (EG2) — evolve's body calls apply_evolution( — the
//       player-invoked path and the auto-evolution path apply an evolution
//       through exactly one code path (EG2-11).
//   E4. Dual-write mirror — apply_evolution writes monster_pub as well as
//       monster so the public projection stays coherent (ADR-0040/ADR-0015
//       discipline), via pub_from_monster( (never a hand-rolled partial struct).
//   E5. SSOT delegation, two halves (ADR-0174 D4b / EG1-11):
//       (gate)      evolve's DECISION is `(game_core::)path_satisfied(` in
//                   enforced `if !path_satisfied(..) { .. return Err/Err(..) }`
//                   form — a discarded call (`let _ = ..`) satisfies a bare
//                   presence scan while the gate does nothing;
//       (transform) apply_evolution's species change is `game_core::evolve(` /
//                   `game_core_evolve(` — inlining it bypasses the
//                   carry-individuality + essence-zeroing invariant (ADR-0174 D2).
//
// EG5-2 — the EG2 essence reducers (`essence_train`, ADR-0175 D5 /
// `consume_crystalized_essence`), same invariant SHAPE as E1-E5, one checker per
// row, every failure message carrying a STABLE `S<n>-...:` prefix:
//
//   S1. Ownership — both reducers call require_owner( (or an inline
//       owner_identity != ctx.sender comparison that leads to an Err().
//   S2. Ongoing-battle guard — both reducers use the SSOT
//       `if is_in_ongoing_battle(..) { .. Err(..) }` shape (spec EG2-3/EG2-4:
//       "mirrors care"). NARROW on purpose: this is NOT checkBattleGuard, and
//       checkBattleGuard is NOT widened to accept it — the two guard helpers have
//       different both-role properties (see E2 above), so each reducer family is
//       pinned to the exact helper whose shape is safe for it.
//   S3. Monster trade escrow — both reducers call reject_if_monster_in_trade(.
//   S4. ITEM trade escrow — consume_crystalized_essence ONLY: the escrowed_item_qty(
//       block must lead to a `return Err(` (EG2-4 calls this guard non-optional;
//       it closes a real double-spend-shaped gap).
//   S5. Decision-before-consume (EG2-4/EG2-10 reject-never-burns) — the pure
//       decision seam must appear strictly BEFORE the irreversible mutation:
//       evaluate_essence_train( before grant_essence( ; and
//       evaluate_consume_crystalized( before consume_one(.
//   S6. Dual-write mirror — each reducer's mutation tail writes monster AND
//       monster_pub via pub_from_monster( (the E4 shape, reused verbatim).
//
// Proof-of-teeth: each invariant has a BAD fixture that MUST be flagged — by the
// NAMED sub-check, asserted on the stable message prefix — and the GOOD fixtures
// must pass every check scoped to them, so a regression in a checker is caught
// before it lets a bad implementation slip through. A tooth that stops biting
// fails THIS eval, not some future one.
//
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Shared helpers (same convention as other security evals in this project).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments from source.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comments blanked.
 */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract a single function body (the text between the outer braces) from
 * comment-stripped Rust source. Tries `pub fn <name>(` first, then `fn <name>(`.
 * Returns null if the function is not found.
 *
 * Uses indexOf + brace-depth counting — NO dynamic RegExp.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  Bare function name.
 * @returns {string|null}
 */
export function extractReducerBody(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
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
// Check functions (exported for unit-testability; pure → null = pass).
// ---------------------------------------------------------------------------

/**
 * E1 — Ownership guard: the body must call require_owner( (the canonical
 * consolidation from ADR-0056 guards.rs).  A custom inline ownership check is
 * also accepted: owner_identity != ctx.sender followed by Err(.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkOwnershipGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');

  // Short-circuit: canonical guard helper.
  if (compact.indexOf('require_owner(') !== -1) {
    return null;
  }

  // Fallback: inline owner_identity != ctx.sender ... Err(.
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
      `${fnName}: missing ownership guard — require \`require_owner(\` call OR ` +
      '`owner_identity != ctx.sender` (or alias) followed by Err('
    );
  }

  const window = compact.slice(cmpIdx, cmpIdx + 320);
  if (window.indexOf('Err(') === -1) {
    return (
      `${fnName}: ownership comparison found but no Err( within 320 chars — ` +
      'the comparison must lead to a rejection'
    );
  }

  return null;
}

/**
 * E2 — Battle guard, BOTH-ROLE (EG5-2 hardening, plan addendum item 5):
 *
 *   E2-missing:     no reject_if_in_battle( call at all;
 *   E2-parse:       the call's parentheses do not balance (a scanner that cannot
 *                   find the argument region must FAIL, never silently pass);
 *   E2-single-role: the call's OWN argument region does not mention BOTH
 *                   player_identity( and opponent_identity(.
 *
 * Why the argument region and not mere presence: `reject_if_in_battle` takes an
 * iterator the caller builds (guards.rs:262-279). It is both-role ONLY if the
 * call site chains `ctx.db.battle().opponent_identity().filter(..)` onto the
 * player_identity filter — drop that chain and a monster whose owner sits on
 * side B of an ongoing PvP battle evolves mid-battle, with every other check in
 * this file still green (ADR-0122 both-role, ADR-0136 amendment; the sibling
 * helper `is_in_ongoing_battle` is both-role by construction and is what the
 * S2 checker below pins for the raising-side reducers).
 *
 * The argument region is found by paren-depth counting from the call's own `(`
 * — indexOf + a character walk, NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkBattleGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');
  const NEEDLE = 'reject_if_in_battle(';
  const callIdx = compact.indexOf(NEEDLE);
  if (callIdx === -1) {
    return (
      `E2-missing: ${fnName}: missing battle guard — must call reject_if_in_battle( to ` +
      'prevent evolving a monster that is currently in a battle'
    );
  }

  // Walk the call's argument region: openIdx is the '(' that ends the needle.
  const openIdx = callIdx + NEEDLE.length - 1;
  let depth = 1;
  let i = openIdx + 1;
  while (i < compact.length && depth > 0) {
    if (compact[i] === '(') depth++;
    else if (compact[i] === ')') depth--;
    i++;
  }
  if (depth !== 0) {
    return (
      `E2-parse: ${fnName}: reject_if_in_battle( parentheses do not balance — the ` +
      'argument region could not be isolated, so the both-role chain cannot be verified'
    );
  }
  const args = compact.slice(openIdx + 1, i - 1);

  if (args.indexOf('player_identity(') === -1) {
    return (
      `E2-single-role: ${fnName}: reject_if_in_battle( argument region does not mention ` +
      'player_identity( — the guard must be fed the caller-as-side-A battle index'
    );
  }
  if (args.indexOf('opponent_identity(') === -1) {
    return (
      `E2-single-role: ${fnName}: reject_if_in_battle( argument region does not mention ` +
      'opponent_identity( — the both-role chain (ADR-0122/ADR-0136) is missing, so a ' +
      'monster whose owner is side B of an ongoing PvP battle can still be evolved ' +
      'mid-battle while every other check here stays green'
    );
  }

  return null;
}

/**
 * S2 (EG5-2) — Ongoing-battle guard for the EG2 essence reducers. Deliberately
 * NARROW and deliberately NOT checkBattleGuard (which stays pinned to evolve's
 * `reject_if_in_battle(` shape): spec EG2-3/EG2-4 say these two reducers mirror
 * `care`, and `care` uses the SSOT `is_in_ongoing_battle(ctx, ctx.sender)`
 * predicate (guards.rs:302-307), which is both-role BY CONSTRUCTION — it walks
 * the player_identity AND opponent_identity indexes itself, so no call site can
 * get the chain wrong. Accepting either helper in one widened checker would let
 * a single-role `reject_if_in_battle(player_identity-only)` satisfy this row.
 *
 * Enforced shape (compacted): `if is_in_ongoing_battle(` followed by an `Err(`
 * within 240 compacted chars — the same "called AND enforced" ladder as
 * checkPathSatisfiedGate, because a bare presence scan is satisfied by a
 * discarded `let _ = is_in_ongoing_battle(..)` that guards nothing.
 *
 *   S2-missing:    no is_in_ongoing_battle( call at all;
 *   S2-unenforced: called, but not in the `if ..(..) { .. Err(..) }` shape.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkOngoingBattleGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('is_in_ongoing_battle(') === -1) {
    return (
      `S2-missing: ${fnName}: no is_in_ongoing_battle( call — the both-role ongoing-battle ` +
      'guard is missing entirely (spec EG2-3/EG2-4: the guard set mirrors care), so a ' +
      'caller mid-battle can mutate a monster that is currently fighting'
    );
  }

  const gateIdx = compact.indexOf('ifis_in_ongoing_battle(');
  if (gateIdx === -1) {
    return (
      `S2-unenforced: ${fnName}: is_in_ongoing_battle( is called but not in the enforced ` +
      '`if is_in_ongoing_battle(..) { .. Err(..) }` shape — a discarded call ' +
      '(`let _ = is_in_ongoing_battle(..)`) satisfies a bare presence scan while the ' +
      'guard rejects nothing at all'
    );
  }

  const afterGate = compact.slice(gateIdx, gateIdx + 240);
  if (afterGate.indexOf('Err(') === -1) {
    return (
      `S2-unenforced: ${fnName}: \`if is_in_ongoing_battle(\` found but no Err( within 240 ` +
      'chars — the guard branch must lead to a rejection, not a log line'
    );
  }

  return null;
}

/**
 * S3 (EG5-2) — Monster trade-escrow guard: the body must call
 * reject_if_monster_in_trade( (TR-6/ADR-0106). An escrowed monster must not be
 * mutated while an active trade offer references it, or the counterparty can be
 * handed a monster whose essence/cooldown changed after they accepted.
 *
 * Presence is the invariant: the helper itself is `?`-propagating, exactly like
 * require_owner( in E1/S1 — there is no "call it and ignore it" shape.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkMonsterTradeEscrowGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('reject_if_monster_in_trade(') === -1) {
    return (
      `S3-missing: ${fnName}: no reject_if_monster_in_trade( call — a monster sitting in an ` +
      'active trade offer must not be mutated (TR-6, ADR-0106); the guard set of these ' +
      'reducers mirrors care/train, which both carry it'
    );
  }
  return null;
}

/**
 * S4 (EG5-2, consume_crystalized_essence ONLY) — ITEM trade-escrow guard: the
 * escrowed_item_qty( block must lead to a `return Err(`.
 *
 * EG2-4 calls this guard NON-OPTIONAL: without it a player can offer their last
 * crystalized-essence item in a trade and consume it at the same time — the
 * double-spend-shaped gap the spec names explicitly. `train` carries the same
 * block for its food item; this is that block, transplanted.
 *
 *   S4-missing:    no escrowed_item_qty( call at all;
 *   S4-unenforced: called, but no `return Err(` within 500 compacted chars — the
 *                  reserve is computed and then thrown away.
 *
 * `returnErr(` (the compacted form of `return Err(`) is the needle, NOT bare
 * `Err(`: the shipped block is followed by a `.map_err(` on the item lookup, and
 * `map_err(` CONTAINS the characters `Err(` — a bare-Err scan would pass a body
 * whose escrow comparison had been deleted. The shipped block puts its
 * `return Err(` ~316 compacted chars after the call, so 500 is a working
 * margin that still ends well before the reducer's next unrelated rejection.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkItemEscrowGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');

  const idx = compact.indexOf('escrowed_item_qty(');
  if (idx === -1) {
    return (
      `S4-missing: ${fnName}: no escrowed_item_qty( call — the ITEM trade-escrow guard is ` +
      'missing (EG2-4 makes it non-optional: it closes the double-spend-shaped gap where ' +
      'an item escrowed in an active trade is consumed anyway)'
    );
  }

  const window = compact.slice(idx, idx + 500);
  if (window.indexOf('returnErr(') === -1) {
    return (
      `S4-unenforced: ${fnName}: escrowed_item_qty( is called but no \`return Err(\` follows ` +
      'within 500 chars — the escrowed reserve is computed and then discarded, which is ' +
      'indistinguishable from having no item-escrow guard at all'
    );
  }

  return null;
}

/**
 * S5 (EG5-2) — Decision-before-consume, PARAMETERISED over the (decision,
 * irreversible-step) pair so both EG2 reducers use one checker:
 *
 *   essence_train:                evaluate_essence_train(  before  grant_essence(
 *   consume_crystalized_essence:  evaluate_consume_crystalized(  before  consume_one(
 *
 * Reject-never-burns (ADR-0059 §3, spec EG2-4/EG2-10): the fallible decision runs
 * BEFORE the irreversible step, so a rejected call (wrong item, cooldown not
 * elapsed) rolls back with the item intact and the cooldown unburned.
 *
 * Textual index ordering on the comment-STRIPPED body is the accepted proxy in
 * this eval family (checkTrainConsumeAfterDecision in raising-reducer-security
 * uses exactly this mechanism): it cannot see control flow, but it does catch
 * the real regression shape — someone moving the spend above the seam. The
 * comment-stripping is load-bearing and has its own tooth
 * (BAD_CONSUME_DECISION_ONLY_IN_COMMENT): a decision call that exists ONLY
 * inside a comment must read as ABSENT, never as "present and first".
 *
 *   S5-no-decision: the decision seam is not called;
 *   S5-no-consume:  the irreversible step is not called (absence-is-fail — a
 *                   reducer that grants nothing is not a passing reducer);
 *   S5-order:       the irreversible step precedes the decision.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} decisionNeedle  e.g. 'evaluate_consume_crystalized('.
 * @param {string} consumeNeedle   e.g. 'consume_one('.
 * @returns {string|null}
 */
export function checkDecisionBeforeConsume(body, decisionNeedle, consumeNeedle) {
  const compact = body.replace(/\s+/g, '');

  const decisionIdx = compact.indexOf(decisionNeedle);
  const consumeIdx = compact.indexOf(consumeNeedle);

  if (decisionIdx === -1) {
    return (
      `S5-no-decision: body does not call ${decisionNeedle} — the pure decision seam is ` +
      'missing, so the reducer decides (or skips) the reject conditions itself instead of ' +
      'delegating them, and nothing guarantees they run before the irreversible step'
    );
  }
  if (consumeIdx === -1) {
    return (
      `S5-no-consume: body does not call ${consumeNeedle} — the irreversible step this ` +
      'ordering invariant is about is absent, so the check would pass vacuously'
    );
  }
  if (consumeIdx < decisionIdx) {
    return (
      `S5-order: ${consumeNeedle} appears BEFORE ${decisionNeedle} — reject-never-burns ` +
      'violated (ADR-0059 §3, spec EG2-4/EG2-10): a rejected call would burn the item / ' +
      'grant essence before the decision that was supposed to prevent it'
    );
  }

  return null;
}

/**
 * E4 — Dual-write mirror: the body must update both the private monster table
 * AND the public monster_pub table, using pub_from_monster(.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkDualWriteMirror(body, fnName) {
  const compact = body.replace(/\s+/g, '');

  // The monster table is written via update or insert.
  const hasMonsterWrite =
    compact.indexOf('monster().monster_id().update(') !== -1 ||
    compact.indexOf('monster().insert(') !== -1;
  if (!hasMonsterWrite) {
    return `${fnName}: body does not write the private monster table (update or insert) — success path is incomplete`;
  }

  // monster_pub is written via update or insert.
  const hasPubWrite =
    compact.indexOf('monster_pub().monster_id().update(') !== -1 ||
    compact.indexOf('monster_pub().insert(') !== -1;
  if (!hasPubWrite) {
    return (
      `${fnName}: writes monster() but does NOT write monster_pub() — ` +
      'E4 dual-write discipline: every monster mutation must mirror monster_pub (ADR-0040)'
    );
  }

  if (compact.indexOf('pub_from_monster(') === -1) {
    return (
      `${fnName}: monster_pub write found but pub_from_monster( not called — ` +
      'the pub mirror must use pub_from_monster to project the private row, ' +
      'not a hand-rolled partial struct (field parity would silently diverge)'
    );
  }

  return null;
}

/**
 * E5 (gate half, ADR-0174 D4b) — the evolve body must DELEGATE the gate
 * DECISION to the shared `path_satisfied` predicate, and ENFORCE it:
 *
 *   E5g-missing:    no `path_satisfied(` call at all — the reducer decides the
 *                   gate itself (or not at all), exactly the drift EG1-11 bans;
 *   E5g-unenforced: `path_satisfied(` is called but not in the enforced
 *                   `if !(game_core::)path_satisfied(` shape with a
 *                   `return Err(` / `Err(` in the guarded block — a discarded
 *                   `let _ = path_satisfied(..)` satisfies a bare presence scan
 *                   while the gate does nothing.
 *
 * Accepted enforcement shape (compacted): `if!game_core::path_satisfied(` or
 * `if!path_satisfied(`, followed by `Err(` within 400 compacted chars (the
 * shipped reducer builds the message via game_core::unmet_requirement first).
 *
 * Every failure message starts with a STABLE `E5g-...:` prefix so each tooth
 * can assert WHICH sub-check fired.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped evolve function body.
 * @returns {string|null}
 */
export function checkPathSatisfiedGate(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('path_satisfied(') === -1) {
    return (
      'E5g-missing: evolve does not call path_satisfied( — the gate DECISION must be ' +
      'the shared game_core predicate (ADR-0174 D4b / EG1-11); a reducer that decides ' +
      '(or skips) the gate itself is exactly the server-side rule drift this bans'
    );
  }

  let gateIdx = compact.indexOf('if!game_core::path_satisfied(');
  if (gateIdx === -1) gateIdx = compact.indexOf('if!path_satisfied(');
  if (gateIdx === -1) {
    return (
      'E5g-unenforced: path_satisfied( is called but not in the enforced ' +
      '`if !(game_core::)path_satisfied(..) { .. Err(..) }` shape — a discarded call ' +
      '(`let _ = path_satisfied(..)`) leaves every other check satisfied while the ' +
      'gate does nothing at all'
    );
  }

  const afterGate = compact.slice(gateIdx, gateIdx + 400);
  if (afterGate.indexOf('Err(') === -1) {
    return (
      'E5g-unenforced: `if !path_satisfied(` found but no Err( within 400 chars — ' +
      'the negated gate must lead to a rejection'
    );
  }

  return null;
}

/**
 * E5 (transform half) — SSOT delegation: the body must call the game-core
 * transform function, not inline the species-change or individuality logic.
 * EG2: scoped to `apply_evolution`'s body — the ONE transform path.
 *
 * Accepted patterns: game_core_evolve(  OR  game_core::evolve(
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body    Comment-stripped function body.
 * @returns {string|null}
 */
export function checkSSOTDelegation(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('game_core_evolve(') !== -1 || compact.indexOf('game_core::evolve(') !== -1) {
    return null;
  }
  return (
    'apply_evolution: body does not call game_core_evolve( or game_core::evolve( — ' +
    'the species transform must be delegated to the game-core pure rule (ADR-0003 SSOT); ' +
    'inlining the transform bypasses the carry-individuality + essence-zeroing ' +
    'invariant (ADR-0174 D2)'
  );
}

/**
 * E3 (EG2, ADR-0175 D3/D6) — delegation: `evolve`'s body must CALL
 * `apply_evolution(`. The dual-write/SSOT checks moved to apply_evolution's
 * body, so without this check an `evolve` that keeps (or regrows) its own
 * inline transform next to an orphan helper would satisfy every other check
 * while the codebase carries two write paths — the exact "an evolution is
 * NEVER applied through two different code paths" failure EG2-11 names.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped evolve function body.
 * @returns {string|null}
 */
export function checkEvolveDelegation(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('apply_evolution(') === -1) {
    return (
      'evolve: body does not call apply_evolution( — the transform-and-write must be ' +
      'delegated to the ONE shared helper both evolve and check_and_evolve use (EG2-11, ' +
      'ADR-0175 D3); an evolve with its own transform tail leaves two write paths that ' +
      'drift the first time one is fixed'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings — all in the EG2 delegating shape (ADR-0175):
// evolve = guards + targeted lookup + enforced gate + apply_evolution call;
// apply_evolution = fresh find + fresh target species + game_core::evolve +
// dual-write.
// ---------------------------------------------------------------------------

// GOOD — the EG2 target shape for the reducer: ownership, battle guard,
// targeted edge lookup, enforced path_satisfied gate, DELEGATED transform.
// This ONE fixture must pass E1, E2, E3 and the gate half of E5.
const GOOD_EVOLVE = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(
          ctx.db.battle().player_identity().filter(m.owner_identity)
              .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
          monster_id,
      )?;
      let Some(path_row) = ctx.db.evolution_path().from_species().filter(m.species_id).find(|p| p.to_species == to_species) else {
          return Err("no such evolution".to_string());
      };
      let path = evolution_path_from_row(&path_row)?;
      let instance = monster_to_instance(&m)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err(game_core::unmet_requirement(&instance, &path)
              .unwrap_or_else(|| "evolution requirements not met".to_string()));
      }
      apply_evolution(ctx, monster_id, &path_row)?;
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// GOOD — the EG2 target shape for the shared helper: fresh find, fresh target
// species, game_core::evolve transform, pub_from_monster dual-write.
// Must pass E4 and the transform half of E5.
const GOOD_APPLY_EVOLUTION = `
  pub(crate) fn apply_evolution(ctx: &ReducerContext, monster_id: u64, path: &EvolutionPathRow) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      let instance = monster_to_instance(&m)?;
      let Some(to_species_row) = ctx.db.species_row().id().find(path.to_species) else {
          return Err("target species not found".to_string());
      };
      let target = species_from_row(&to_species_row)?;
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E3 BAD — an evolve that never delegates: it keeps its own inline transform
// and dual-write (the pre-EG2 shape). checkEvolveDelegation must flag it —
// every other check would pass this body, and an orphan apply_evolution
// elsewhere in the file would satisfy a mere-existence scan.
const BAD_EVOLVE_NO_DELEGATION = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(
          ctx.db.battle().player_identity().filter(m.owner_identity)
              .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
          monster_id,
      )?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E1 BAD — evolve without ownership guard.
const BAD_EVOLVE_NO_OWNERSHIP = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      reject_if_in_battle(
          ctx.db.battle().player_identity().filter(m.owner_identity)
              .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
          monster_id,
      )?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      apply_evolution(ctx, monster_id, &path_row)?;
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// E2 BAD — evolve without battle guard.
const BAD_EVOLVE_NO_BATTLE_GUARD = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      apply_evolution(ctx, monster_id, &path_row)?;
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// E2 BAD (EG5-2 hardening) — evolve WITH reject_if_in_battle, but single-role:
// the opponent_identity chain is dropped. Identical to GOOD_EVOLVE in every
// other respect (single-property mutation), so it passes E1/E3/E5g and only the
// hardened E2 can catch it. Kills: the pre-EG5 presence-only battle-guard scan,
// under which side B of an ongoing PvP battle could evolve mid-battle.
const BAD_EVOLVE_SINGLE_ROLE_BATTLE_GUARD = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let Some(path_row) = ctx.db.evolution_path().from_species().filter(m.species_id).find(|p| p.to_species == to_species) else {
          return Err("no such evolution".to_string());
      };
      let path = evolution_path_from_row(&path_row)?;
      let instance = monster_to_instance(&m)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      apply_evolution(ctx, monster_id, &path_row)?;
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// E4 BAD — apply_evolution without the monster_pub update.
const BAD_APPLY_EVOLUTION_NO_PUB_WRITE = `
  pub(crate) fn apply_evolution(ctx: &ReducerContext, monster_id: u64, path: &EvolutionPathRow) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      let instance = monster_to_instance(&m)?;
      let Some(to_species_row) = ctx.db.species_row().id().find(path.to_species) else {
          return Err("target species not found".to_string());
      };
      let target = species_from_row(&to_species_row)?;
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      ctx.db.monster().monster_id().update(m);
      Ok(())
  }
`;

// E5 (transform) BAD — apply_evolution without game_core delegation: the
// species change and a stat write are inlined instead of transformed.
const BAD_APPLY_EVOLUTION_NO_SSOT = `
  pub(crate) fn apply_evolution(ctx: &ReducerContext, monster_id: u64, path: &EvolutionPathRow) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      let Some(to_species_row) = ctx.db.species_row().id().find(path.to_species) else {
          return Err("target species not found".to_string());
      };
      m.species_id = path.to_species;
      m.stat_hp = 75;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E5 (gate) BAD — no path_satisfied call at all: the reducer never gates.
const BAD_EVOLVE_NO_PATH_GATE = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(
          ctx.db.battle().player_identity().filter(m.owner_identity)
              .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
          monster_id,
      )?;
      apply_evolution(ctx, monster_id, &path_row)?;
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// E5 (gate) BAD — path_satisfied is called but its verdict is DISCARDED: every
// bare-presence scan is satisfied while the gate does nothing at all.
const BAD_EVOLVE_GATE_DISCARDED = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(
          ctx.db.battle().player_identity().filter(m.owner_identity)
              .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
          monster_id,
      )?;
      let _ = game_core::path_satisfied(&instance, &path);
      apply_evolution(ctx, monster_id, &path_row)?;
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// EG5-2 proof-of-teeth fixtures — the EG2 essence reducers (ADR-0175).
//
// GOOD_ESSENCE_TRAIN / GOOD_CONSUME are the shipped target shapes; every BAD
// below is a SINGLE-PROPERTY mutation of the matching GOOD, so exactly one
// checker can be the one that catches it and the tooth's attribution assertion
// is meaningful.
// ---------------------------------------------------------------------------

// GOOD — essence_train: care-shaped guard set, decision before mutation,
// dual-write. Must pass S1, S2, S3, S5 and S6.
const GOOD_ESSENCE_TRAIN = `
  pub fn essence_train(ctx: &ReducerContext, monster_id: u64, affinity: Affinity) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "essence_train", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot essence-train during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      evaluate_essence_train(m.last_essence_train_at_ms, now)?;
      grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
      m.last_essence_train_at_ms = now;
      let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
          return Err(format!("monster_pub row missing for monster {monster_id}"));
      };
      let pub_row = pub_from_monster(&m, existing_pub.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      accrue_quality_time(ctx, monster_id);
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// GOOD — consume_crystalized_essence: the FULL guard set (ownership, both-role
// battle, monster escrow, ITEM escrow), decision before the irreversible spend,
// dual-write. Must pass S1, S2, S3, S4, S5 and S6.
const GOOD_CONSUME = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot consume essence during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      {
          let escrowed = escrowed_item_qty(
              ctx.db.trade_offer().initiator().filter(m.owner_identity)
                  .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
              m.owner_identity,
              item_id,
          );
          let count = ctx.db.inventory().owner_identity().filter(m.owner_identity)
              .find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0);
          if escrowed >= count {
              return Err("item is in an active trade".to_string());
          }
      }
      let item = crate::content_cache::cached_items()
          .map_err(|e| format!("cached_items: {e}"))?
          .iter()
          .find(|d| d.id == item_id)
          .ok_or_else(|| format!("item {item_id} not found"))?;
      let now = now_ms(ctx);
      let (item_affinity, amount) =
          evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      consume_one(ctx, ctx.sender, item_id)?;
      grant_essence(&mut m, item_affinity, amount);
      m.last_essence_train_at_ms = now;
      let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
          return Err(format!("monster_pub row missing for monster {monster_id}"));
      };
      let pub_row = pub_from_monster(&m, existing_pub.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      accrue_quality_time(ctx, monster_id);
      check_and_evolve(ctx, monster_id);
      Ok(())
  }
`;

// S1 BAD — essence_train with the ownership guard deleted: anyone can pump
// essence into anyone else's monster.
const BAD_ESSENCE_TRAIN_NO_OWNERSHIP = `
  pub fn essence_train(ctx: &ReducerContext, monster_id: u64, affinity: Affinity) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot essence-train during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      evaluate_essence_train(m.last_essence_train_at_ms, now)?;
      grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S2 BAD (missing) — consume with NO ongoing-battle guard at all.
const BAD_CONSUME_NO_BATTLE_GUARD = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      let (item_affinity, amount) =
          evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      consume_one(ctx, ctx.sender, item_id)?;
      grant_essence(&mut m, item_affinity, amount);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S2 BAD (unenforced, discarded) — the guard is CALLED and its verdict thrown
// away. Kills a bare `is_in_ongoing_battle(` presence scan.
const BAD_CONSUME_BATTLE_GUARD_DISCARDED = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      let _fighting = is_in_ongoing_battle(ctx, ctx.sender);
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      let (item_affinity, amount) =
          evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      consume_one(ctx, ctx.sender, item_id)?;
      grant_essence(&mut m, item_affinity, amount);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S2 BAD (unenforced, logs instead of rejecting) — the enforced if-shape is
// there but the branch only logs. Kills a check that stops at the if-shape.
const BAD_ESSENCE_TRAIN_BATTLE_GUARD_LOGS_ONLY = `
  pub fn essence_train(ctx: &ReducerContext, monster_id: u64, affinity: Affinity) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "essence_train", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          log::warn!("essence_train while battling");
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      evaluate_essence_train(m.last_essence_train_at_ms, now)?;
      grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S3 BAD — essence_train without the monster trade-escrow guard.
const BAD_ESSENCE_TRAIN_NO_TRADE_GUARD = `
  pub fn essence_train(ctx: &ReducerContext, monster_id: u64, affinity: Affinity) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "essence_train", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot essence-train during an ongoing battle".to_string());
      }
      let now = now_ms(ctx);
      evaluate_essence_train(m.last_essence_train_at_ms, now)?;
      grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S4 BAD (missing) — consume with the whole item-escrow block deleted: the
// double-spend-shaped gap EG2-4 names as non-optional.
const BAD_CONSUME_NO_ITEM_ESCROW = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot consume essence during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      let (item_affinity, amount) =
          evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      consume_one(ctx, ctx.sender, item_id)?;
      grant_essence(&mut m, item_affinity, amount);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S4 BAD (unenforced) — the escrowed reserve is COMPUTED and then discarded:
// no comparison, no rejection. Kills a bare escrowed_item_qty( presence scan.
// Deliberately carries NO further `return Err(` after the call, so the window
// scan cannot be satisfied by an unrelated later rejection.
const BAD_CONSUME_ITEM_ESCROW_DISCARDED = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot consume essence during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let escrowed = escrowed_item_qty(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          m.owner_identity,
          item_id,
      );
      log::debug!("escrowed reserve computed but ignored: {escrowed}");
      let item = crate::content_cache::cached_items()
          .map_err(|e| format!("cached_items: {e}"))?
          .iter()
          .find(|d| d.id == item_id)
          .ok_or_else(|| format!("item {item_id} not found"))?;
      let now = now_ms(ctx);
      let (item_affinity, amount) =
          evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      consume_one(ctx, ctx.sender, item_id)?;
      grant_essence(&mut m, item_affinity, amount);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S5 BAD (order) — consume_one BEFORE the decision seam: a rejected feed (wrong
// item / cooldown) has already burned the item.
const BAD_CONSUME_SPEND_BEFORE_DECISION = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot consume essence during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      consume_one(ctx, ctx.sender, item_id)?;
      let (item_affinity, amount) =
          evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      grant_essence(&mut m, item_affinity, amount);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S5 BAD (comment-stripping tooth) — the decision seam exists ONLY inside a
// line comment. After stripRustComments it is ABSENT, so the expected verdict
// is S5-no-decision. If stripping were ever skipped/moved after the check, the
// commented call would sit textually BEFORE consume_one( and the checker would
// return null — this fixture then fails the eval with "was NOT flagged".
const BAD_CONSUME_DECISION_ONLY_IN_COMMENT = `
  pub fn consume_crystalized_essence(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot consume essence during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      // seam inlined for speed; the old call was:
      // let (a, n) = evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
      consume_one(ctx, ctx.sender, item_id)?;
      grant_essence(&mut m, item.essence_affinity.unwrap(), item.essence_amount);
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S5 BAD (order, essence_train needle pair) — the essence grant lands BEFORE
// the cooldown decision, so a cooldown-rejected call has already mutated the
// in-memory row the tail writes back.
const BAD_ESSENCE_TRAIN_GRANT_BEFORE_DECISION = `
  pub fn essence_train(ctx: &ReducerContext, monster_id: u64, affinity: Affinity) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "essence_train", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot essence-train during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
      evaluate_essence_train(m.last_essence_train_at_ms, now)?;
      m.last_essence_train_at_ms = now;
      let pub_row = pub_from_monster(&m, 0);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// S6 BAD — essence_train mutates the private row but never mirrors monster_pub:
// the public essence/tier projection silently diverges (ADR-0040).
const BAD_ESSENCE_TRAIN_NO_PUB_WRITE = `
  pub fn essence_train(ctx: &ReducerContext, monster_id: u64, affinity: Affinity) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "essence_train", m.owner_identity)?;
      if is_in_ongoing_battle(ctx, ctx.sender) {
          return Err("cannot essence-train during an ongoing battle".to_string());
      }
      reject_if_monster_in_trade(
          ctx.db.trade_offer().initiator().filter(m.owner_identity)
              .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
          monster_id,
      )?;
      let now = now_ms(ctx);
      evaluate_essence_train(m.last_essence_train_at_ms, now)?;
      grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
      m.last_essence_train_at_ms = now;
      ctx.db.monster().monster_id().update(m);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// PRODUCTION-ONLY reader — recursive glob over server-module/src, skipping
// files ending in `_tests.rs` (the no-idle-accrual.eval.mjs pattern). The
// invariants are about what PRODUCTION does: evolution_tests.rs contains
// evolve-shaped fixture strings that could otherwise shadow the real reducer.
// ---------------------------------------------------------------------------
export function readServerModuleProdSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      parts.push(readServerModuleProdSources(full));
    } else if (entry.endsWith('.rs') && !entry.endsWith('_tests.rs')) {
      parts.push(readFileSync(full, 'utf8'));
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function evolutionReducerSecurityEval() {
  const name =
    'evolution-reducer-security (evolve: ownership, BOTH-ROLE battle-guard, path_satisfied gate, apply_evolution delegation; apply_evolution: dual-write + game_core::evolve SSOT; essence_train/consume_crystalized_essence: S1-S6 guard+ordering+dual-write ladder; ADR-0174/0175, EG5-2)';

  // =========================================================================
  // PROOFS-OF-TEETH — run before real-source scan.
  // =========================================================================

  // --- Tooth E1: evolve without ownership must be flagged -------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_OWNERSHIP), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_OWNERSHIP',
      };
    }
    if (!checkOwnershipGuard(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_EVOLVE_NO_OWNERSHIP was NOT flagged by checkOwnershipGuard',
      };
    }
  }

  // --- Teeth E2: battle guard — missing AND single-role, BY SUB-CHECK -------
  {
    const battleBad = [
      [
        'BAD_EVOLVE_NO_BATTLE_GUARD',
        BAD_EVOLVE_NO_BATTLE_GUARD,
        'E2-missing:',
        'no reject_if_in_battle call at all',
      ],
      [
        'BAD_EVOLVE_SINGLE_ROLE_BATTLE_GUARD',
        BAD_EVOLVE_SINGLE_ROLE_BATTLE_GUARD,
        'E2-single-role:',
        'the opponent_identity chain is dropped, so PvP side B evolves mid-battle',
      ],
    ];
    for (const [label, fixture, prefix, why] of battleBad) {
      const body = extractReducerBody(stripRustComments(fixture), 'evolve');
      if (!body) {
        return { name, pass: false, detail: `TEETH: could not extract evolve body from ${label}` };
      }
      const flagged = checkBattleGuard(body, 'evolve');
      if (!flagged) {
        return {
          name,
          pass: false,
          detail: `TEETH: ${label} was NOT flagged by checkBattleGuard (${why})`,
        };
      }
      if (flagged.indexOf(prefix) !== 0) {
        return {
          name,
          pass: false,
          detail:
            `TEETH ATTRIBUTION: ${label} (${why}) was flagged, but by the WRONG sub-check — ` +
            `expected a message starting with "${prefix}", got: ${flagged}`,
        };
      }
    }
  }

  // --- Tooth E3: evolve without the apply_evolution delegation must be flagged
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_DELEGATION), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_DELEGATION',
      };
    }
    if (!checkEvolveDelegation(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_EVOLVE_NO_DELEGATION (inline transform, no apply_evolution call) was NOT flagged by checkEvolveDelegation',
      };
    }
  }

  // --- Tooth E4: apply_evolution without monster_pub update must be flagged --
  {
    const body = extractReducerBody(
      stripRustComments(BAD_APPLY_EVOLUTION_NO_PUB_WRITE),
      'apply_evolution',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract apply_evolution body from BAD_APPLY_EVOLUTION_NO_PUB_WRITE',
      };
    }
    if (!checkDualWriteMirror(body, 'apply_evolution')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_APPLY_EVOLUTION_NO_PUB_WRITE (no monster_pub update) was NOT flagged by checkDualWriteMirror',
      };
    }
  }

  // --- Tooth E5 (transform): apply_evolution without game_core must be flagged
  {
    const body = extractReducerBody(
      stripRustComments(BAD_APPLY_EVOLUTION_NO_SSOT),
      'apply_evolution',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract apply_evolution body from BAD_APPLY_EVOLUTION_NO_SSOT',
      };
    }
    if (!checkSSOTDelegation(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_APPLY_EVOLUTION_NO_SSOT (inline species change) was NOT flagged by checkSSOTDelegation',
      };
    }
  }

  // --- Teeth E5 (gate): each BAD fixture flagged BY THE NAMED SUB-CHECK -----
  {
    const gateBad = [
      [
        'BAD_EVOLVE_NO_PATH_GATE',
        BAD_EVOLVE_NO_PATH_GATE,
        'E5g-missing:',
        'no path_satisfied call at all',
      ],
      [
        'BAD_EVOLVE_GATE_DISCARDED',
        BAD_EVOLVE_GATE_DISCARDED,
        'E5g-unenforced:',
        '`let _ =` throws the gate verdict away',
      ],
    ];
    for (const [label, fixture, prefix, why] of gateBad) {
      const body = extractReducerBody(stripRustComments(fixture), 'evolve');
      if (!body) {
        return { name, pass: false, detail: `TEETH: could not extract evolve body from ${label}` };
      }
      const flagged = checkPathSatisfiedGate(body);
      if (!flagged) {
        return {
          name,
          pass: false,
          detail: `TEETH: ${label} was NOT flagged by checkPathSatisfiedGate (${why})`,
        };
      }
      if (flagged.indexOf(prefix) !== 0) {
        return {
          name,
          pass: false,
          detail:
            `TEETH ATTRIBUTION: ${label} (${why}) was flagged, but by the WRONG sub-check — ` +
            `expected a message starting with "${prefix}", got: ${flagged}`,
        };
      }
    }
  }

  // --- Tooth GOOD: the EG2 target shapes must pass EVERY scoped check --------
  {
    const body = extractReducerBody(stripRustComments(GOOD_EVOLVE), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from GOOD_EVOLVE',
      };
    }
    const errs = [
      checkOwnershipGuard(body, 'evolve'),
      checkBattleGuard(body, 'evolve'),
      checkEvolveDelegation(body),
      checkPathSatisfiedGate(body),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVOLVE incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }
  {
    const body = extractReducerBody(stripRustComments(GOOD_APPLY_EVOLUTION), 'apply_evolution');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract apply_evolution body from GOOD_APPLY_EVOLUTION',
      };
    }
    const errs = [checkDualWriteMirror(body, 'apply_evolution'), checkSSOTDelegation(body)].filter(
      (e) => e !== null,
    );
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_APPLY_EVOLUTION incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // =========================================================================
  // PROOFS-OF-TEETH (EG5-2) — the essence reducers' S1-S6 ladder. Every BAD is
  // asserted to be flagged BY THE NAMED SUB-CHECK (stable message prefix), so a
  // checker that starts flagging everything (or the wrong thing) fails here.
  // =========================================================================
  {
    const essenceBad = [
      [
        'BAD_ESSENCE_TRAIN_NO_OWNERSHIP',
        BAD_ESSENCE_TRAIN_NO_OWNERSHIP,
        'essence_train',
        (b) => checkOwnershipGuard(b, 'essence_train'),
        'essence_train: missing ownership guard',
        'S1: require_owner deleted — anyone could train anyone else’s monster',
      ],
      [
        'BAD_CONSUME_NO_BATTLE_GUARD',
        BAD_CONSUME_NO_BATTLE_GUARD,
        'consume_crystalized_essence',
        (b) => checkOngoingBattleGuard(b, 'consume_crystalized_essence'),
        'S2-missing:',
        'S2: no is_in_ongoing_battle call at all',
      ],
      [
        'BAD_CONSUME_BATTLE_GUARD_DISCARDED',
        BAD_CONSUME_BATTLE_GUARD_DISCARDED,
        'consume_crystalized_essence',
        (b) => checkOngoingBattleGuard(b, 'consume_crystalized_essence'),
        'S2-unenforced:',
        'S2: the guard verdict is bound to `_fighting` and ignored',
      ],
      [
        'BAD_ESSENCE_TRAIN_BATTLE_GUARD_LOGS_ONLY',
        BAD_ESSENCE_TRAIN_BATTLE_GUARD_LOGS_ONLY,
        'essence_train',
        (b) => checkOngoingBattleGuard(b, 'essence_train'),
        'S2-unenforced:',
        'S2: the if-shape is present but the branch only logs, never rejects',
      ],
      [
        'BAD_ESSENCE_TRAIN_NO_TRADE_GUARD',
        BAD_ESSENCE_TRAIN_NO_TRADE_GUARD,
        'essence_train',
        (b) => checkMonsterTradeEscrowGuard(b, 'essence_train'),
        'S3-missing:',
        'S3: an escrowed monster could be mutated mid-trade',
      ],
      [
        'BAD_CONSUME_NO_ITEM_ESCROW',
        BAD_CONSUME_NO_ITEM_ESCROW,
        'consume_crystalized_essence',
        (b) => checkItemEscrowGuard(b, 'consume_crystalized_essence'),
        'S4-missing:',
        'S4: the non-optional item-escrow block is gone (double-spend gap)',
      ],
      [
        'BAD_CONSUME_ITEM_ESCROW_DISCARDED',
        BAD_CONSUME_ITEM_ESCROW_DISCARDED,
        'consume_crystalized_essence',
        (b) => checkItemEscrowGuard(b, 'consume_crystalized_essence'),
        'S4-unenforced:',
        'S4: escrowed_item_qty is computed, logged, and never compared',
      ],
      [
        'BAD_CONSUME_SPEND_BEFORE_DECISION',
        BAD_CONSUME_SPEND_BEFORE_DECISION,
        'consume_crystalized_essence',
        (b) => checkDecisionBeforeConsume(b, 'evaluate_consume_crystalized(', 'consume_one('),
        'S5-order:',
        'S5: consume_one runs before the decision — a rejected feed burns the item',
      ],
      [
        'BAD_CONSUME_DECISION_ONLY_IN_COMMENT',
        BAD_CONSUME_DECISION_ONLY_IN_COMMENT,
        'consume_crystalized_essence',
        (b) => checkDecisionBeforeConsume(b, 'evaluate_consume_crystalized(', 'consume_one('),
        'S5-no-decision:',
        'S5: the decision call survives only inside a comment — comment-stripping ' +
          'must run BEFORE the ordering check, or this reads as "present and first"',
      ],
      [
        'BAD_ESSENCE_TRAIN_GRANT_BEFORE_DECISION',
        BAD_ESSENCE_TRAIN_GRANT_BEFORE_DECISION,
        'essence_train',
        (b) => checkDecisionBeforeConsume(b, 'evaluate_essence_train(', 'grant_essence('),
        'S5-order:',
        'S5: essence is granted before the cooldown decision',
      ],
      [
        'BAD_ESSENCE_TRAIN_NO_PUB_WRITE',
        BAD_ESSENCE_TRAIN_NO_PUB_WRITE,
        'essence_train',
        (b) => checkDualWriteMirror(b, 'essence_train'),
        'essence_train: writes monster() but does NOT write monster_pub()',
        'S6: the public projection silently diverges from the private row',
      ],
    ];

    for (const [label, fixture, fnName, run, prefix, why] of essenceBad) {
      const body = extractReducerBody(stripRustComments(fixture), fnName);
      if (!body) {
        return {
          name,
          pass: false,
          detail: `TEETH: could not extract ${fnName} body from ${label}`,
        };
      }
      const flagged = run(body);
      if (!flagged) {
        return { name, pass: false, detail: `TEETH: ${label} was NOT flagged (${why})` };
      }
      if (flagged.indexOf(prefix) !== 0) {
        return {
          name,
          pass: false,
          detail:
            `TEETH ATTRIBUTION: ${label} (${why}) was flagged, but by the WRONG sub-check — ` +
            `expected a message starting with "${prefix}", got: ${flagged}`,
        };
      }
    }
  }

  // --- Tooth GOOD (EG5-2): both essence reducers pass every scoped check -----
  {
    const body = extractReducerBody(stripRustComments(GOOD_ESSENCE_TRAIN), 'essence_train');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract essence_train body from GOOD_ESSENCE_TRAIN',
      };
    }
    const errs = [
      checkOwnershipGuard(body, 'essence_train'),
      checkOngoingBattleGuard(body, 'essence_train'),
      checkMonsterTradeEscrowGuard(body, 'essence_train'),
      checkDecisionBeforeConsume(body, 'evaluate_essence_train(', 'grant_essence('),
      checkDualWriteMirror(body, 'essence_train'),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_ESSENCE_TRAIN incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }
  {
    const body = extractReducerBody(stripRustComments(GOOD_CONSUME), 'consume_crystalized_essence');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract consume_crystalized_essence body from GOOD_CONSUME',
      };
    }
    const errs = [
      checkOwnershipGuard(body, 'consume_crystalized_essence'),
      checkOngoingBattleGuard(body, 'consume_crystalized_essence'),
      checkMonsterTradeEscrowGuard(body, 'consume_crystalized_essence'),
      checkItemEscrowGuard(body, 'consume_crystalized_essence'),
      checkDecisionBeforeConsume(body, 'evaluate_consume_crystalized(', 'consume_one('),
      checkDualWriteMirror(body, 'consume_crystalized_essence'),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_CONSUME incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // --- Cross-checker misfire control: the essence reducers' S2 guard shape is
  //     NOT the evolve guard shape and vice versa. Without this, someone
  //     "simplifying" the two checkers into one widened battle-guard check
  //     (exactly what EG5-2 forbids) would still pass every tooth above.
  {
    const evolveBody = extractReducerBody(stripRustComments(GOOD_EVOLVE), 'evolve');
    const trainBody = extractReducerBody(stripRustComments(GOOD_ESSENCE_TRAIN), 'essence_train');
    if (!evolveBody || !trainBody) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract bodies for the S2/E2 cross-checker misfire control',
      };
    }
    if (!checkOngoingBattleGuard(evolveBody, 'evolve')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: checkOngoingBattleGuard accepted GOOD_EVOLVE (reject_if_in_battle shape) — ' +
          'the S2 checker must be pinned to is_in_ongoing_battle(, not widened to accept ' +
          'the guard whose both-role-ness depends on the call site',
      };
    }
    if (!checkBattleGuard(trainBody, 'essence_train')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: checkBattleGuard accepted GOOD_ESSENCE_TRAIN (is_in_ongoing_battle shape) — ' +
          'E2 must stay pinned to evolve’s reject_if_in_battle( both-role chain',
      };
    }
  }

  // =========================================================================
  // REAL-SOURCE SCAN — apply all checks to the actual PRODUCTION source.
  // =========================================================================

  const SERVER_SRC = 'server-module/src';
  let prodSrc;
  try {
    prodSrc = stripRustComments(readServerModuleProdSources(SERVER_SRC));
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }

  const failures = [];

  const evolveBody = extractReducerBody(prodSrc, 'evolve');
  if (!evolveBody) {
    failures.push(
      'evolve: reducer not found in PRODUCTION server-module source (non-*_tests.rs files)',
    );
  } else {
    const e1 = checkOwnershipGuard(evolveBody, 'evolve');
    if (e1) failures.push(e1);
    const e2 = checkBattleGuard(evolveBody, 'evolve');
    if (e2) failures.push(e2);
    const e3 = checkEvolveDelegation(evolveBody);
    if (e3) failures.push(e3);
    const e5g = checkPathSatisfiedGate(evolveBody);
    if (e5g) failures.push(e5g);
  }

  const applyBody = extractReducerBody(prodSrc, 'apply_evolution');
  if (!applyBody) {
    failures.push(
      'apply_evolution: shared transform helper not found in PRODUCTION server-module ' +
        'source (non-*_tests.rs files) — EG2-11 puts the ONE transform-and-write path there',
    );
  } else {
    const e4 = checkDualWriteMirror(applyBody, 'apply_evolution');
    if (e4) failures.push(e4);
    const e5t = checkSSOTDelegation(applyBody);
    if (e5t) failures.push(e5t);
  }

  // --- EG5-2: essence_train (spec EG2-3) — S1, S2, S3, S5, S6 ---------------
  // Absence-is-fail: a missing reducer body is a FAILURE, never a silent skip.
  const essenceTrainBody = extractReducerBody(prodSrc, 'essence_train');
  if (!essenceTrainBody) {
    failures.push(
      'essence_train: reducer not found in PRODUCTION server-module source ' +
        '(non-*_tests.rs files) — spec EG2-3 puts it in raising.rs; a missing body must ' +
        'FAIL this eval, not silently skip S1/S2/S3/S5/S6',
    );
  } else {
    const s1 = checkOwnershipGuard(essenceTrainBody, 'essence_train');
    if (s1) failures.push(s1);
    const s2 = checkOngoingBattleGuard(essenceTrainBody, 'essence_train');
    if (s2) failures.push(s2);
    const s3 = checkMonsterTradeEscrowGuard(essenceTrainBody, 'essence_train');
    if (s3) failures.push(s3);
    const s5 = checkDecisionBeforeConsume(
      essenceTrainBody,
      'evaluate_essence_train(',
      'grant_essence(',
    );
    if (s5) failures.push(`essence_train: ${s5}`);
    const s6 = checkDualWriteMirror(essenceTrainBody, 'essence_train');
    if (s6) failures.push(s6);
  }

  // --- EG5-2: consume_crystalized_essence (EG2-4/EG2-10) — S1..S6 -----------
  const consumeBody = extractReducerBody(prodSrc, 'consume_crystalized_essence');
  if (!consumeBody) {
    failures.push(
      'consume_crystalized_essence: reducer not found in PRODUCTION server-module source ' +
        '(non-*_tests.rs files) — spec EG2-4 puts it in raising.rs; a missing body must ' +
        'FAIL this eval, not silently skip S1..S6',
    );
  } else {
    const s1 = checkOwnershipGuard(consumeBody, 'consume_crystalized_essence');
    if (s1) failures.push(s1);
    const s2 = checkOngoingBattleGuard(consumeBody, 'consume_crystalized_essence');
    if (s2) failures.push(s2);
    const s3 = checkMonsterTradeEscrowGuard(consumeBody, 'consume_crystalized_essence');
    if (s3) failures.push(s3);
    const s4 = checkItemEscrowGuard(consumeBody, 'consume_crystalized_essence');
    if (s4) failures.push(s4);
    const s5 = checkDecisionBeforeConsume(
      consumeBody,
      'evaluate_consume_crystalized(',
      'consume_one(',
    );
    if (s5) failures.push(`consume_crystalized_essence: ${s5}`);
    const s6 = checkDualWriteMirror(consumeBody, 'consume_crystalized_essence');
    if (s6) failures.push(s6);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'evolve: ownership guard, BOTH-ROLE battle guard, enforced path_satisfied gate and ' +
      'apply_evolution delegation; apply_evolution: dual-write mirror and ' +
      'game_core::evolve SSOT delegation; essence_train + consume_crystalized_essence ' +
      '(EG5-2): ownership, enforced is_in_ongoing_battle guard, monster trade escrow, ' +
      'item trade escrow (consume only), decision-before-consume ordering and dual-write ' +
      '— verified against production source (teeth: 19 BAD + 4 GOOD synthetic fixtures ' +
      'plus 2 cross-checker misfire controls; fuse checks deleted with the reducer, ' +
      'EG1/ADR-0174)',
  };
}

// ---------------------------------------------------------------------------
// Main-guard (the ci-gate-wiring / wallet-privacy idiom): `node
// evals/evolution-reducer-security.eval.mjs` runs this eval standalone and exits
// non-zero on failure. No-op when imported by evals/run.mjs (process.argv[1] is
// run.mjs there). Run it from the project root — the real-source scan resolves
// `server-module/src` relative to the cwd.
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await evolutionReducerSecurityEval();
    } catch (e) {
      return {
        name: 'evolution-reducer-security',
        pass: false,
        detail: `threw: ${e?.message ?? String(e)}`,
      };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
