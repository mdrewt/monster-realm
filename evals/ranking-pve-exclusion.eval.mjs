// ranking-pve-exclusion eval (m17c, ADR-0119, RL-17):
// Re-verifies the four PvE-path PvP-reject guards (RL-8/9) and hardens the
// checker with a no-op-body kill via `hasPvpRejectWithNonEmptyBody` (AM-3).
//
// Imports { stripRustComments, extractReducerBody, stripRustStrings,
//           hasPvpRejectGuard, pvpGuardAfterOngoingCheck }
// from the frozen battle-reducer-security.eval.mjs (guarded dynamic import —
// returns RED, never throws, if an export is missing).
//
// Criteria:
//   R17-A: submit_attack / swap_active / flee / use_battle_item in battle.rs
//           each have hasPvpRejectGuard AND pvpGuardAfterOngoingCheck (re-verify)
//   R17-B: hasPvpRejectWithNonEmptyBody (AM-3 algorithm) — the guard block must
//           contain `return Err` inside it, not just be empty or log-only.
//           Closes the documented no-op residual from battle-reducer-security.eval.mjs.
//
// AM-3 algorithm for hasPvpRejectWithNonEmptyBody(body):
//   1. strip = stripRustStrings(stripRustComments(body))
//   2. needle idx = indexOf('if is_ranked_pvp(&battle)')
//   3. walk forward to first `{` after needle
//   4. brace-depth-count to the matching `}`
//   5. require 'return Err' INSIDE that sub-slice ONLY
//
// Documented residual (honest):
//   `if is_ranked_pvp(&battle) { if false { return Err(...) } }` still passes
//   the static scan — nested-dead-code is a static-scan limit; covered by
//   mutation testing + Rust tests.
//
// No new RegExp() anywhere.

import { readFileSync } from 'node:fs';

const BATTLE_RS_PATH = 'server-module/src/battle.rs';
const BATTLE_SECURITY_EVAL_PATH = './battle-reducer-security.eval.mjs';

// ---------------------------------------------------------------------------
// hasPvpRejectWithNonEmptyBody (AM-3):
// Returns true iff the reducer body contains `if is_ranked_pvp(&battle)` with
// a non-empty block body that contains `return Err` inside the block.
//
// Algorithm (AM-3 exact spec):
//   1. strip comments then strings
//   2. find `if is_ranked_pvp(&battle)` needle
//   3. walk to first `{` after the needle
//   4. brace-depth-count to matching `}`
//   5. require `return Err` INSIDE that sub-slice ONLY
//
// Fixtures (full set per AM-3):
//   bad-noop:             `if is_ranked_pvp(&battle) {}` → false
//   bad-noop-whitespace:  `if is_ranked_pvp(&battle) { }` → false
//   bad-noop-comment:     `if is_ranked_pvp(&battle) { /* nothing */ }` → false
//   bad-log-only:         `if is_ranked_pvp(&battle) { log::warn!("pvp"); }` → false
//   positional-evasion:   guard block empty, `return Err` AFTER the block → false
//   nested-brace good:    reject body containing inner `{}` (e.g. format! nesting) → true
//   next-line-brace good: guard block on next line → true
// ---------------------------------------------------------------------------
export function hasPvpRejectWithNonEmptyBody(body) {
  const code = stripRustStrings_local(stripRustComments_local(body));
  const needle = 'if is_ranked_pvp(&battle)';
  const needleIdx = code.indexOf(needle);
  if (needleIdx === -1) return false;

  // Walk forward from the needle to find the first `{`.
  let braceOpenIdx = needleIdx + needle.length;
  while (braceOpenIdx < code.length && code[braceOpenIdx] !== '{') {
    braceOpenIdx++;
  }
  if (braceOpenIdx >= code.length) return false;

  // Brace-depth-count to find the matching `}`.
  let depth = 1;
  let i = braceOpenIdx + 1;
  const blockStart = i;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  // The matching `}` is at position i-1 (depth went to 0 and i was incremented).
  const blockEnd = i - 1;
  const blockBody = code.slice(blockStart, blockEnd);

  // Require `return Err` INSIDE the block sub-slice ONLY (AM-3 step 5).
  return blockBody.indexOf('return Err') !== -1;
}

// Local copies of strip fns (not yet imported — import below is guarded).
// These are IDENTICAL to the exports from battle-reducer-security.eval.mjs.
// We need them for the fixture suite which runs before the dynamic import.
function stripRustComments_local(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function stripRustStrings_local(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      out += ' ';
      i++;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += '  ';
          i += 2;
        } else if (src[i] === '"') {
          out += ' ';
          i++;
          break;
        } else {
          out += ' ';
          i++;
        }
      }
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'ranking-pve-exclusion (RL-17: R17-A re-verify four PvP-reject guards; R17-B hasPvpRejectWithNonEmptyBody no-op-body kill)';

  // =========================================================================
  // R17-B TEETH FIXTURES — run FIRST so a broken hasPvpRejectWithNonEmptyBody
  // short-circuits TEETH FAILED before the import or real-source scan.
  // =========================================================================

  // -------------------------------------------------------------------------
  // Fixture R17B-BAD-NOOP: empty block → false.
  // KILLS: a checker that only requires the needle without inspecting the block.
  // -------------------------------------------------------------------------
  const badNoop = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle) {}
        Ok(())
    }
  `;
  if (hasPvpRejectWithNonEmptyBody(badNoop)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-BAD-NOOP): hasPvpRejectWithNonEmptyBody returned true for an empty guard block `{}` — ' +
        'must require `return Err` inside the block body (AM-3)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture R17B-BAD-NOOP-WHITESPACE: whitespace-only block → false.
  // KILLS: a checker that accepts any non-empty block content.
  // -------------------------------------------------------------------------
  const badNoopWhitespace = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle) {   }
        Ok(())
    }
  `;
  if (hasPvpRejectWithNonEmptyBody(badNoopWhitespace)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-BAD-NOOP-WHITESPACE): hasPvpRejectWithNonEmptyBody returned true for a whitespace-only guard block — ' +
        'must require `return Err` inside the block (AM-3)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture R17B-BAD-NOOP-COMMENT: comment-only block → false after strip.
  // KILLS: a checker that counts comment text as real content.
  // -------------------------------------------------------------------------
  const badNoopComment = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle) { /* nothing here */ }
        Ok(())
    }
  `;
  if (hasPvpRejectWithNonEmptyBody(badNoopComment)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-BAD-NOOP-COMMENT): hasPvpRejectWithNonEmptyBody returned true for a comment-only guard block — ' +
        'comments are stripped before inspection; `return Err` must appear in real code (AM-3)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture R17B-BAD-LOG-ONLY: log-only block → false.
  // KILLS: a checker that accepts any non-empty block as a rejection.
  // -------------------------------------------------------------------------
  const badLogOnly = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle) {
            log::warn!("pvp battle detected in flee");
        }
        Ok(())
    }
  `;
  if (hasPvpRejectWithNonEmptyBody(badLogOnly)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-BAD-LOG-ONLY): hasPvpRejectWithNonEmptyBody returned true for a log-only guard block — ' +
        'a log without `return Err` is a no-op rejection; must reject the call (AM-3)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture R17B-POSITIONAL-EVASION: guard block empty, `return Err` appears
  // AFTER the block → false.
  // KILLS: a checker that scans the full body for `return Err` without bounding
  // the search to the guard block sub-slice (AM-3 step 5).
  // -------------------------------------------------------------------------
  const positionalEvasion = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle) {}
        return Err("some other error".to_string());
    }
  `;
  if (hasPvpRejectWithNonEmptyBody(positionalEvasion)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-POSITIONAL-EVASION): hasPvpRejectWithNonEmptyBody returned true for a fixture where ' +
        '`return Err` appears AFTER the guard block (not inside it) — ' +
        'the brace-depth-count must bound the search to the block sub-slice only (AM-3 step 5)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture R17B-NESTED-BRACE-GOOD: reject body with inner `{}` (e.g. format!/
  // to_string nesting inside the error message) → true.
  // KILLS: a brace-depth bug where the first `}` inside a nested expression
  // terminates the block prematurely (the depth counter must track inner braces).
  // -------------------------------------------------------------------------
  const nestedBraceGood = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle) {
            let msg = format!("cannot flee pvp battle {}", battle_id);
            return Err(msg);
        }
        Ok(())
    }
  `;
  if (!hasPvpRejectWithNonEmptyBody(nestedBraceGood)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-NESTED-BRACE-GOOD): hasPvpRejectWithNonEmptyBody returned false for a guard block ' +
        'containing nested braces (format! macro) followed by `return Err` — ' +
        'brace-depth-count must track inner `{}` pairs before finding the matching close brace (AM-3)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture R17B-NEXT-LINE-BRACE-GOOD: guard block on next line → true.
  // KILLS: a checker that requires the `{` on the same line as the needle.
  // -------------------------------------------------------------------------
  const nextLineBraceGood = `
    pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id).unwrap();
        if battle.state.outcome != BattleOutcome::Ongoing { return Err("".to_string()); }
        if is_ranked_pvp(&battle)
        {
            return Err("ranked pvp: use submit_pvp_action".to_string());
        }
        Ok(())
    }
  `;
  if (!hasPvpRejectWithNonEmptyBody(nextLineBraceGood)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (R17B-NEXT-LINE-BRACE-GOOD): hasPvpRejectWithNonEmptyBody returned false for a guard block ' +
        'where the opening `{` is on a new line after the needle (AM-3 reviewer W-2)',
    };
  }

  // =========================================================================
  // GUARDED IMPORT of battle-reducer-security.eval.mjs checkers (plan §3)
  // Returns RED (not throw) if any required export is missing.
  // =========================================================================
  let extractReducerBody, hasPvpRejectGuard, pvpGuardAfterOngoingCheck;
  try {
    const mod = await import(BATTLE_SECURITY_EVAL_PATH);
    // Validate ALL FIVE required exports are present and callable — including
    // stripRustComments and stripRustStrings which are used internally by the
    // imported checkers (hasPvpRejectGuard / pvpGuardAfterOngoingCheck call them).
    // Validation is over mod[k] so no unused bindings are created for the two
    // strip fns; only the three bindings this file directly calls are assigned.
    const required = [
      'stripRustComments',
      'extractReducerBody',
      'stripRustStrings',
      'hasPvpRejectGuard',
      'pvpGuardAfterOngoingCheck',
    ];
    const missing = required.filter((k) => typeof mod[k] !== 'function');
    if (missing.length > 0) {
      return {
        name,
        pass: false,
        detail:
          `guarded import RED: battle-reducer-security.eval.mjs is missing required exports: ${missing.join(', ')}. ` +
          'This eval depends on those checkers — it cannot proceed without them (plan §3).',
      };
    }
    extractReducerBody = mod.extractReducerBody;
    hasPvpRejectGuard = mod.hasPvpRejectGuard;
    pvpGuardAfterOngoingCheck = mod.pvpGuardAfterOngoingCheck;
  } catch (e) {
    return {
      name,
      pass: false,
      detail:
        `guarded import RED: could not import battle-reducer-security.eval.mjs: ${e.message}. ` +
        'This is a hard dependency — the file must exist and export the required checkers.',
    };
  }

  // =========================================================================
  // READ REAL SOURCE
  // =========================================================================
  let battleSrc;
  try {
    battleSrc = readFileSync(BATTLE_RS_PATH, 'utf8');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read ${BATTLE_RS_PATH}: ${e.message}`,
    };
  }

  const PVP_REJECT_REDUCERS = ['submit_attack', 'swap_active', 'flee', 'use_battle_item'];
  const failures = [];

  // =========================================================================
  // R17-A: re-verify all four PvE-path reducers have the guard AND ordering
  // =========================================================================
  for (const reducerName of PVP_REJECT_REDUCERS) {
    const body = extractReducerBody(battleSrc, reducerName);
    if (!body) {
      failures.push(
        `R17-A: ${reducerName} not found in ${BATTLE_RS_PATH} — cannot verify PvP-reject guard`,
      );
      continue;
    }

    if (!hasPvpRejectGuard(body)) {
      failures.push(
        `R17-A: ${reducerName} missing conditional PvP-reject guard (if is_ranked_pvp(&battle)) — ` +
          'RL-8/9: PvP battles must be rejected from PvE reducers via an if-branch (ADR-0119 D5, F1)',
      );
    } else if (!pvpGuardAfterOngoingCheck(body)) {
      failures.push(
        `R17-A: ${reducerName} if is_ranked_pvp(&battle) appears BEFORE BattleOutcome::Ongoing check — ` +
          'must be placed immediately AFTER the Ongoing check (ADR-0119 D5)',
      );
    }
  }

  // =========================================================================
  // R17-B: stronger no-op-body check — guard block must contain `return Err`
  // =========================================================================
  for (const reducerName of PVP_REJECT_REDUCERS) {
    const body = extractReducerBody(battleSrc, reducerName);
    if (!body) continue; // already flagged in R17-A

    if (!hasPvpRejectWithNonEmptyBody(body)) {
      failures.push(
        `R17-B: ${reducerName} has if is_ranked_pvp(&battle) but its block body does not contain ` +
          '`return Err` — an empty/log-only/noop guard block is not a rejection; ' +
          'the guard must actually return an Err to prevent PvE-path exploitation (AM-3, ADR-0119 D5). ' +
          'Documented residual: `if is_ranked_pvp(&battle) { if false { return Err(...) } }` would pass ' +
          '— static-scan limit; covered by mutation testing + Rust tests.',
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
      `RL-17 all criteria met: ` +
      `R17-A all ${PVP_REJECT_REDUCERS.length} PvE reducers (${PVP_REJECT_REDUCERS.join(', ')}) ` +
      'have if is_ranked_pvp(&battle) guard in conditional form after Ongoing check (RL-8/9, ADR-0119 D5); ' +
      'R17-B all four guard blocks contain `return Err` (no-op-body kill, AM-3); ' +
      'checkers imported from frozen battle-reducer-security.eval.mjs (guarded import); ' +
      'teeth: 7 R17-B fixtures (noop/whitespace/comment/log-only/positional-evasion/nested-brace-good/next-line-brace-good).',
  };
}
