// pvp-challenge-reaper eval (m17.5e, ADR-0126):
// Verifies the battle_challenge TTL-reaper invariants.  A Pending
// battle_challenge row locks BOTH parties out of new challenges (challenge_pvp
// guards 5b/6); the TTL reaper (clone of the m16.5f trade_offer_reaper,
// ADR-0117) bounds that lockout window for AFK/disconnected challengers.
//
// Criteria (7):
//   CHAL_REAPER_ARMED            — challenge_pvp arms the reaper AFTER the challenge
//                                  insert with the EXACT args (ctx, challenge.challenge_id,
//                                  challenge.created_at_ms) — F1 arg-identity pin
//   CHAL_REAPER_SCHEDULER_GUARD  — battle_challenge_reaper guards ctx.sender != ctx.identity()
//   CHAL_REAPER_STALE_CHECK      — battle_challenge_reaper re-checks staleness via the
//                                  negation-guard shape `if !is_challenge_stale(` … `return Ok(())`
//                                  (an ignored-result `let _ = is_challenge_stale(...)` fails — F4)
//   CHAL_REAPER_DELETES          — battle_challenge_reaper deletes via challenge_id().delete(
//   CHAL_REAPER_DISARM           — disarm_challenge_reaper called at ALL FOUR deletion sites
//                                  (accept/decline/cancel/cancel_challenges_on_disconnect)
//   CHAL_REAPER_SCHEDULE_PRIVATE — battle_challenge_reaper_schedule table attr has NO `public`
//   CHAL_REAPER_DEADLINE_MS_FLOORED — deadline = created_at_ms×1000 + CHALLENGE_TTL_MS×1000
//                                  (saturating, ADR-0117 D4) + schedule-row insert survivor-pin
//
// Every criterion is tested with proof-of-teeth bad fixtures (must flag) and a
// good fixture (must not flag) BEFORE the real source is checked (mirrors
// trade-reducer-security.eval.mjs).
//
// No new RegExp() — all patterns are literal regex literals or indexOf checks.
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Replace Rust double-quoted string literal CONTENTS with "" (Finding C,
 * ADR-0116 hardened version): the escape branch matches backslash + ANY char
 * INCLUDING newline, so a backslash-newline line-continuation string is handled
 * correctly.  Apply AFTER stripRustComments.  Prevents
 * `let _dead = "schedule_challenge_reaper(";` from satisfying needle searches.
 * DOES NOT strip raw strings (r#...#) — production pvp.rs contains none.
 */
function stripRustStrings(src) {
  return src.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
}

/**
 * Remove ALL whitespace (m17.5d mandatory pipeline stage, ADR-0125):
 * makes composite-needle matching rustfmt-proof — a call whose arguments
 * rustfmt splits across lines still matches a squashed needle.
 */
function squashWs(src) {
  return src.replace(/\s+/g, '');
}

/**
 * Full scan pipeline for a function body: strip comments → strip strings →
 * squash whitespace (plan T2/T3 pipeline order).
 */
function scanCode(body) {
  return squashWs(stripRustStrings(stripRustComments(body)));
}

/**
 * Extract a named function's body (between outer braces), or null if missing.
 * Handles both `pub fn <name>(` and `fn <name>(` (the latter also matches
 * `pub(crate) fn <name>(` by substring).  Brace-matched — cloned from
 * pvp-handshake-guards.eval.mjs.
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

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_ARMED (F1 arg-identity + ordering)
// challenge_pvp body: battle_challenge().insert( must appear BEFORE the arm
// call, and the arm call must pin the FULL squashed shape
// schedule_challenge_reaper(ctx,challenge.challenge_id,challenge.created_at_ms)
// — kills wrong-id arms (literal 0 reaps nothing) and wrong-time arms
// (now_ms(ctx) drifts the deadline off the row's own created_at_ms).
// bad fixtures: missing arm / arm-before-insert / literal-0 id / now_ms time /
//               string-literal bypass.  good fixture: insert then exact arm.
// ---------------------------------------------------------------------------
function checkChalReaperArmed(challengeBody) {
  if (!challengeBody) return { ok: false, reason: 'challenge_pvp function not found' };
  const code = scanCode(challengeBody);
  const insertIdx = code.indexOf('battle_challenge().insert(');
  if (insertIdx === -1)
    return { ok: false, reason: 'battle_challenge().insert( not found in challenge_pvp' };
  // Arg-identity pin: nothing may sit between the third argument and the close
  // paren.  Both closing forms are accepted — `)` (single-line call) and `,)`
  // (rustfmt adds a trailing comma when it splits a call across lines).
  const armPin = 'schedule_challenge_reaper(ctx,challenge.challenge_id,challenge.created_at_ms';
  let armIdx = code.indexOf(`${armPin})`);
  if (armIdx === -1) armIdx = code.indexOf(`${armPin},)`);
  if (armIdx === -1)
    return {
      ok: false,
      reason:
        'arm call schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms) ' +
        'not found in challenge_pvp (F1 arg-identity pin — a wrong-id or wrong-time arm also fails)',
    };
  if (armIdx <= insertIdx)
    return {
      ok: false,
      reason: `reaper arm (offset ${armIdx}) appears before challenge insert (offset ${insertIdx})`,
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_SCHEDULER_GUARD
// battle_challenge_reaper body must contain ctx.sender != ctx.identity()
// (either comparison order).  Without it any client can call the reaper and
// delete other players' pending challenges.
// bad fixture: no guard → must flag.  good fixture: guard present.
// ---------------------------------------------------------------------------
function checkChalReaperSchedulerGuard(reaperBody) {
  if (!reaperBody) return { ok: false, reason: 'battle_challenge_reaper function not found' };
  const code = scanCode(reaperBody);
  if (code.indexOf('ctx.sender!=ctx.identity()') !== -1) return { ok: true };
  if (code.indexOf('ctx.identity()!=ctx.sender') !== -1) return { ok: true };
  return {
    ok: false,
    reason: 'battle_challenge_reaper body missing ctx.sender != ctx.identity() guard',
  };
}

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_STALE_CHECK (F4 negation shape + arg order)
// battle_challenge_reaper body must contain the negation-guard shape
// `if !is_challenge_stale(` with the CORRECT argument order
// `<row>.created_at_ms, now_ms(ctx)` — a transposed call
// `is_challenge_stale(now_ms(ctx), row.created_at_ms)` computes a negative
// elapsed and the reaper permanently no-ops (the exact bug class this slice
// exists to fix).  The guard block must also OPEN with `return Ok(())` (the
// `){returnOk(())` immediate-open shape): an empty guard block + unconditional
// delete + trailing return Ok(()) passes the old check but fires the reaper on
// every invocation regardless of staleness.
// An ignored-result call (`let _ = is_challenge_stale(...)`) does NOT satisfy
// the `if!is_challenge_stale(` shape.
// bad fixtures: no stale call / ignored-result / transposed args / empty block.
// good fixture: the trade_offer_reaper-shaped guard.
// ---------------------------------------------------------------------------
function checkChalReaperStaleCheck(reaperBody) {
  if (!reaperBody) return { ok: false, reason: 'battle_challenge_reaper function not found' };
  const code = scanCode(reaperBody);
  const negIdx = code.indexOf('if!is_challenge_stale(');
  if (negIdx === -1)
    return {
      ok: false,
      reason:
        'negation guard `if !is_challenge_stale(` not found in battle_challenge_reaper ' +
        '(an ignored-result `let _ = is_challenge_stale(...)` does not count — F4 shape pin)',
    };
  // Arg-order pin: the squashed arg-tail after `if!is_challenge_stale(`
  // must be `.created_at_ms,now_ms(ctx))` — kills transposed calls where
  // now_ms comes first and elapsed is always negative.  Both `)` and `,)`
  // closing forms are accepted (rustfmt trailing-comma parity).
  const argTail = '.created_at_ms,now_ms(ctx))';
  const argTailTrailing = '.created_at_ms,now_ms(ctx),)';
  let argTailIdx = code.indexOf(argTail, negIdx);
  if (argTailIdx === -1) argTailIdx = code.indexOf(argTailTrailing, negIdx);
  if (argTailIdx === -1)
    return {
      ok: false,
      reason:
        'arg-order pin `.created_at_ms,now_ms(ctx))` not found after `if!is_challenge_stale(` ' +
        'in battle_challenge_reaper — a transposed call `is_challenge_stale(now_ms(ctx), ' +
        'row.created_at_ms)` computes a negative elapsed and the reaper permanently no-ops',
    };
  // Immediate-open shape: the block following the condition must open with
  // `return Ok(())` — i.e. `){returnOk(())` immediately after the arg-tail
  // (the `)` closes the condition, `{` opens the block, `returnOk(())` is the
  // early-return).  An empty guard `){ }` followed by unconditional delete
  // does not satisfy this and must flag.
  if (code.indexOf('){returnOk(())', argTailIdx) === -1)
    return {
      ok: false,
      reason:
        'guard block-open shape `){returnOk(())` not found immediately after the arg-tail — ' +
        'the staleness guard block must OPEN with `return Ok(())` (empty-block evasion: ' +
        'an empty block + unconditional delete fires the reaper on every invocation)',
    };
  if (code.indexOf('returnOk(())', negIdx) === -1)
    return {
      ok: false,
      reason:
        'no `return Ok(())` after the `if !is_challenge_stale(` guard — ' +
        'an early fire must no-op, never reap a fresh challenge (plan D7)',
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_DELETES
// battle_challenge_reaper body must delete the challenge row via
// challenge_id().delete( — body-scoped, so the accept/decline/cancel delete
// sites cannot satisfy it.
// bad fixture: no delete → must flag.  good fixture: delete present.
// ---------------------------------------------------------------------------
function checkChalReaperDeletes(reaperBody) {
  if (!reaperBody) return { ok: false, reason: 'battle_challenge_reaper function not found' };
  const code = scanCode(reaperBody);
  if (code.indexOf('challenge_id().delete(') === -1)
    return {
      ok: false,
      reason: 'battle_challenge_reaper body missing challenge_id().delete( call',
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_DISARM
// disarm_challenge_reaper( must appear in each of the four challenge-deletion
// function bodies (plan D4 — every deletion site disarms, EA-REAPER-02 parity):
// accept_challenge, decline_challenge, cancel_challenge,
// cancel_challenges_on_disconnect.
// bad fixture: one site missing the disarm → must flag.  good fixture: all four.
// ---------------------------------------------------------------------------
function checkChalReaperDisarm(pvpSrc) {
  const missing = [];
  for (const fn of [
    'accept_challenge',
    'decline_challenge',
    'cancel_challenge',
    'cancel_challenges_on_disconnect',
  ]) {
    const body = extractFunctionBody(pvpSrc, fn);
    if (!body) {
      missing.push(`${fn} (function not found)`);
      continue;
    }
    const code = scanCode(body);
    if (code.indexOf('disarm_challenge_reaper(') === -1) {
      missing.push(fn);
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, missing: [] };
}

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_SCHEDULE_PRIVATE
// The battle_challenge_reaper_schedule table attribute in pvp.rs must exist and
// must NOT contain `public` (plan D6 — clients must never see or manipulate
// reaper schedule rows; trade_offer_reaper_schedule precedent).
// bad fixtures: table absent / table with `public` → must flag.
// good fixture: private table attr → must not flag.
// ---------------------------------------------------------------------------
function checkScheduleTablePrivate(pvpSrc) {
  const code = squashWs(stripRustStrings(stripRustComments(pvpSrc)));
  const idx = code.indexOf('name=battle_challenge_reaper_schedule');
  if (idx === -1)
    return {
      ok: false,
      reason: 'battle_challenge_reaper_schedule table not declared in pvp.rs',
    };
  const attrStart = code.lastIndexOf('#[', idx);
  const attrEnd = code.indexOf(']', idx);
  if (attrStart === -1 || attrEnd === -1)
    return { ok: false, reason: 'malformed battle_challenge_reaper_schedule table attribute' };
  const attr = code.slice(attrStart, attrEnd + 1);
  if (/\bpublic\b/.test(attr))
    return {
      ok: false,
      reason:
        'battle_challenge_reaper_schedule table attribute contains `public` — must be PRIVATE',
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Criterion: CHAL_REAPER_DEADLINE_MS_FLOORED (F2)
// schedule_challenge_reaper body must compute the deadline from the ms-floored
// created_at_ms: created_at_ms.saturating_mul(1_000).saturating_add(
// CHALLENGE_TTL_MS.saturating_mul(1_000)) — a missing ×1000 fires the reaper
// early → the stale re-check no-ops → the one-shot row is consumed → the
// Pending challenge leaks forever (plan D7).  Survivor-pin: the schedule-row
// insert must also be present (kills body-replacement mutants).
// bad fixtures: un-multiplied TTL term / missing insert → must flag.
// good fixture: full trading.rs-shaped clone → must not flag.
// ---------------------------------------------------------------------------
function checkDeadlineMsFloored(scheduleBody) {
  if (!scheduleBody) return { ok: false, reason: 'schedule_challenge_reaper function not found' };
  const code = scanCode(scheduleBody);
  if (
    code.indexOf(
      'created_at_ms.saturating_mul(1_000).saturating_add(CHALLENGE_TTL_MS.saturating_mul(1_000))',
    ) === -1
  )
    return {
      ok: false,
      reason:
        'ms-floored deadline expression not found ' +
        '(created_at_ms×1000 + CHALLENGE_TTL_MS×1000, both saturating — ADR-0117 D4)',
    };
  if (code.indexOf('battle_challenge_reaper_schedule().insert(') === -1)
    return {
      ok: false,
      reason: 'battle_challenge_reaper_schedule().insert( not found (survivor-pin)',
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Default export — the eval runner calls this
// ---------------------------------------------------------------------------

export default async function () {
  const name = 'pvp-challenge-reaper (m17.5e, ADR-0126: battle_challenge TTL reaper)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: every checker must flag its bad fixtures and pass its good
  // fixture BEFORE the real source is read.
  // -------------------------------------------------------------------------

  // CHAL_REAPER_ARMED: bad-missing-arm — kills an impl that never arms the
  // reaper (Pending row from an AFK challenger locks both parties forever).
  const badArmMissing =
    'fn challenge_pvp(ctx: &ReducerContext) { let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); Ok(()) }';
  {
    const r = checkChalReaperArmed(badArmMissing);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_ARMED bad-missing-arm): checker passed fixture with no arm call',
      };
    }
  }
  // CHAL_REAPER_ARMED: bad-arm-before-insert — a pre-insert arm (even with the
  // pinned args) references a challenge_id that does not exist yet.
  const badArmBeforeInsert =
    'fn challenge_pvp(ctx: &ReducerContext) { schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms); let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); Ok(()) }';
  {
    const r = checkChalReaperArmed(badArmBeforeInsert);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_ARMED bad-arm-before-insert): checker passed fixture where the arm precedes the insert',
      };
    }
  }
  // CHAL_REAPER_ARMED: bad-literal-0 id — arms a reaper that reaps nothing
  // (challenge_id 0 never exists; the Pending row still leaks).
  const badArmLiteralZero =
    'fn challenge_pvp(ctx: &ReducerContext) { let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); schedule_challenge_reaper(ctx, 0, challenge.created_at_ms); Ok(()) }';
  {
    const r = checkChalReaperArmed(badArmLiteralZero);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_ARMED bad-literal-0): checker passed fixture arming with a literal 0 challenge_id (F1 arg-identity)',
      };
    }
  }
  // CHAL_REAPER_ARMED: bad-wrong-time — now_ms(ctx) instead of the row's own
  // created_at_ms drifts the deadline off the value is_challenge_stale checks.
  const badArmWrongTime =
    'fn challenge_pvp(ctx: &ReducerContext) { let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); schedule_challenge_reaper(ctx, challenge.challenge_id, now_ms(ctx)); Ok(()) }';
  {
    const r = checkChalReaperArmed(badArmWrongTime);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_ARMED bad-wrong-time): checker passed fixture arming with now_ms(ctx) instead of challenge.created_at_ms (F1 arg-identity)',
      };
    }
  }
  // CHAL_REAPER_ARMED: bad-string-literal-bypass (Finding C PoC) — the arm
  // needle appears only inside a dead-code string literal after the insert.
  const badArmLiteralBypass =
    'fn challenge_pvp(ctx: &ReducerContext) { let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); let _dead = "schedule_challenge_reaper(ctx,challenge.challenge_id,challenge.created_at_ms)"; Ok(()) }';
  {
    const r = checkChalReaperArmed(badArmLiteralBypass);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_ARMED bad-string-literal-bypass): checker passed fixture where the arm call exists only inside a string literal (Finding C bypass)',
      };
    }
  }
  // CHAL_REAPER_ARMED: good fixture — the rustfmt-split form (args across
  // lines WITH the trailing comma rustfmt adds).  Proves the squash pipeline
  // and the `,)` closing-form tolerance are both working.
  const goodArmSplit =
    'fn challenge_pvp(ctx: &ReducerContext) { let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); schedule_challenge_reaper(\n        ctx,\n        challenge.challenge_id,\n        challenge.created_at_ms,\n    ); Ok(()) }';
  {
    const r = checkChalReaperArmed(goodArmSplit);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_ARMED good-split): checker rejected valid rustfmt-split fixture: ${r.reason}`,
      };
    }
  }

  // CHAL_REAPER_ARMED: good fixture — the canonical single-line form.
  const goodArmCanonical =
    'fn challenge_pvp(ctx: &ReducerContext) { let challenge = ctx.db.battle_challenge().insert(BattleChallenge { challenge_id: 0 }); schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms); Ok(()) }';
  {
    const r = checkChalReaperArmed(goodArmCanonical);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_ARMED good-canonical): checker rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // CHAL_REAPER_SCHEDULER_GUARD: bad fixture.
  const badGuard =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { let row = ctx.db.battle_challenge().challenge_id().find(args.challenge_id); Ok(()) }';
  {
    const r = checkChalReaperSchedulerGuard(badGuard);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_SCHEDULER_GUARD bad): checker passed fixture without ctx.sender != ctx.identity() guard',
      };
    }
  }
  // CHAL_REAPER_SCHEDULER_GUARD: good fixture.
  const goodGuard =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("battle_challenge_reaper is scheduler-only".to_string()); } Ok(()) }';
  {
    const r = checkChalReaperSchedulerGuard(goodGuard);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_SCHEDULER_GUARD good): checker rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // CHAL_REAPER_STALE_CHECK: bad — no stale call at all.
  const badStaleMissing =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("".to_string()); } ctx.db.battle_challenge().challenge_id().delete(args.challenge_id); Ok(()) }';
  {
    const r = checkChalReaperStaleCheck(badStaleMissing);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_STALE_CHECK bad-missing): checker passed fixture without any is_challenge_stale call',
      };
    }
  }
  // CHAL_REAPER_STALE_CHECK: bad — ignored-result evasion (F4).  The staleness
  // is computed but never gates the delete; the reaper reaps fresh rows on an
  // early fire.
  const badStaleIgnored =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("".to_string()); } let _ = is_challenge_stale(row.created_at_ms, now_ms(ctx)); ctx.db.battle_challenge().challenge_id().delete(args.challenge_id); Ok(()) }';
  {
    const r = checkChalReaperStaleCheck(badStaleIgnored);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_STALE_CHECK bad-ignored-result): checker passed fixture where is_challenge_stale result is discarded (`let _ =`) — F4 negation-shape pin has no teeth',
      };
    }
  }
  // CHAL_REAPER_STALE_CHECK: bad — transposed argument order (HIGH gate-hole fix).
  // is_challenge_stale(now_ms(ctx), row.created_at_ms) computes a negative
  // elapsed → the reaper permanently no-ops (the exact bug class this slice
  // exists to fix — the negation flips, the delete is never reached).
  const badStaleTransposed =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("".to_string()); } let Some(row) = ctx.db.battle_challenge().challenge_id().find(args.challenge_id) else { return Ok(()); }; if !is_challenge_stale(now_ms(ctx), row.created_at_ms) { return Ok(()); } ctx.db.battle_challenge().challenge_id().delete(args.challenge_id); Ok(()) }';
  {
    const r = checkChalReaperStaleCheck(badStaleTransposed);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_STALE_CHECK bad-transposed-args): checker passed fixture with ' +
          'transposed args `is_challenge_stale(now_ms(ctx), row.created_at_ms)` — this computes a ' +
          'negative elapsed and the reaper permanently no-ops (HIGH gate-hole)',
      };
    }
  }
  // CHAL_REAPER_STALE_CHECK: bad — empty guard block (MEDIUM gate-hole fix).
  // `if !is_challenge_stale(...) { }` + unconditional delete + trailing
  // `return Ok(())` looks correct but fires the reaper on every invocation
  // regardless of staleness.
  const badStaleEmptyBlock =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("".to_string()); } let Some(row) = ctx.db.battle_challenge().challenge_id().find(args.challenge_id) else { return Ok(()); }; if !is_challenge_stale(row.created_at_ms, now_ms(ctx)) { } ctx.db.battle_challenge().challenge_id().delete(args.challenge_id); return Ok(()); }';
  {
    const r = checkChalReaperStaleCheck(badStaleEmptyBlock);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_STALE_CHECK bad-empty-block): checker passed fixture with ' +
          'empty guard block `if !is_challenge_stale(...) { }` — an empty block does not prevent ' +
          'the delete from executing on every invocation (MEDIUM gate-hole)',
      };
    }
  }
  // CHAL_REAPER_STALE_CHECK: good fixture (trade_offer_reaper shape; note the
  // existence-check else-branch also contains `return Ok(())` BEFORE the guard
  // — the checker must anchor its search AFTER the negation guard).
  const goodStale =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("".to_string()); } let Some(row) = ctx.db.battle_challenge().challenge_id().find(args.challenge_id) else { return Ok(()); }; if !is_challenge_stale(row.created_at_ms, now_ms(ctx)) { return Ok(()); } ctx.db.battle_challenge().challenge_id().delete(args.challenge_id); Ok(()) }';
  {
    const r = checkChalReaperStaleCheck(goodStale);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_STALE_CHECK good): checker rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // CHAL_REAPER_DELETES: bad fixture.
  const badDeletes =
    'fn battle_challenge_reaper(ctx: &ReducerContext, args: BattleChallengeReaperSchedule) { if ctx.sender != ctx.identity() { return Err("".to_string()); } if !is_challenge_stale(row.created_at_ms, now_ms(ctx)) { return Ok(()); } Ok(()) }';
  {
    const r = checkChalReaperDeletes(badDeletes);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_DELETES bad): checker passed fixture without challenge_id().delete( call',
      };
    }
  }
  // CHAL_REAPER_DELETES: good fixture.
  {
    const r = checkChalReaperDeletes(goodStale);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_DELETES good): checker rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // CHAL_REAPER_DISARM: bad fixture — cancel_challenge missing the disarm
  // (partial-disarm impl: three of four sites covered).
  const badDisarmSrc =
    'fn accept_challenge(ctx: &ReducerContext, challenge_id: u64) { disarm_challenge_reaper(ctx, challenge_id); ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) } ' +
    'fn decline_challenge(ctx: &ReducerContext, challenge_id: u64) { disarm_challenge_reaper(ctx, challenge_id); ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) } ' +
    'fn cancel_challenge(ctx: &ReducerContext, challenge_id: u64) { ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) } ' +
    'fn cancel_challenges_on_disconnect(ctx: &ReducerContext, player: Identity) { disarm_challenge_reaper(ctx, 0); ctx.db.battle_challenge().challenge_id().delete(0); }';
  {
    const r = checkChalReaperDisarm(badDisarmSrc);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_DISARM bad): checker passed fixture where cancel_challenge is missing disarm_challenge_reaper',
      };
    }
  }
  // CHAL_REAPER_DISARM: good fixture — all four sites disarm.
  const goodDisarmSrc =
    'fn accept_challenge(ctx: &ReducerContext, challenge_id: u64) { disarm_challenge_reaper(ctx, challenge_id); ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) } ' +
    'fn decline_challenge(ctx: &ReducerContext, challenge_id: u64) { disarm_challenge_reaper(ctx, challenge_id); ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) } ' +
    'fn cancel_challenge(ctx: &ReducerContext, challenge_id: u64) { disarm_challenge_reaper(ctx, challenge_id); ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) } ' +
    'fn cancel_challenges_on_disconnect(ctx: &ReducerContext, player: Identity) { disarm_challenge_reaper(ctx, 0); ctx.db.battle_challenge().challenge_id().delete(0); }';
  {
    const r = checkChalReaperDisarm(goodDisarmSrc);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_DISARM good): checker rejected valid fixture (missing: ${r.missing.join(', ')})`,
      };
    }
  }

  // CHAL_REAPER_SCHEDULE_PRIVATE: bad — table absent entirely.
  const badPrivateMissing = 'struct Unrelated {}';
  {
    const r = checkScheduleTablePrivate(badPrivateMissing);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_SCHEDULE_PRIVATE bad-missing): checker passed fixture with no battle_challenge_reaper_schedule table',
      };
    }
  }
  // CHAL_REAPER_SCHEDULE_PRIVATE: bad — table marked public.
  const badPrivatePublic =
    '#[spacetimedb::table(name = battle_challenge_reaper_schedule, scheduled(battle_challenge_reaper), public)] struct BattleChallengeReaperSchedule {}';
  {
    const r = checkScheduleTablePrivate(badPrivatePublic);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_SCHEDULE_PRIVATE bad-public): checker passed fixture where the schedule table is public',
      };
    }
  }
  // CHAL_REAPER_SCHEDULE_PRIVATE: good — private table.
  const goodPrivate =
    '#[spacetimedb::table(name = battle_challenge_reaper_schedule, scheduled(battle_challenge_reaper))] struct BattleChallengeReaperSchedule {}';
  {
    const r = checkScheduleTablePrivate(goodPrivate);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_SCHEDULE_PRIVATE good): checker rejected valid private table: ${r.reason}`,
      };
    }
  }

  // CHAL_REAPER_DEADLINE_MS_FLOORED: bad — un-multiplied TTL term (units bug:
  // fires ~2 minutes early; the stale re-check no-ops; the one-shot row is
  // consumed; the Pending challenge leaks forever — plan D7).
  const badDeadlineUnmultiplied =
    'fn schedule_challenge_reaper(ctx: &ReducerContext, challenge_id: u64, created_at_ms: i64) { let deadline_micros = created_at_ms.saturating_mul(1_000).saturating_add(CHALLENGE_TTL_MS); ctx.db.battle_challenge_reaper_schedule().insert(BattleChallengeReaperSchedule { scheduled_id: 0, scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(deadline_micros)), challenge_id }); }';
  {
    const r = checkDeadlineMsFloored(badDeadlineUnmultiplied);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_DEADLINE_MS_FLOORED bad-unmultiplied): checker passed fixture where the TTL term is not multiplied to micros (F2 units bug)',
      };
    }
  }
  // CHAL_REAPER_DEADLINE_MS_FLOORED: bad — correct expression but no schedule
  // insert (body-replacement mutant survivor-pin).
  const badDeadlineNoInsert =
    'fn schedule_challenge_reaper(ctx: &ReducerContext, challenge_id: u64, created_at_ms: i64) { let _deadline_micros = created_at_ms.saturating_mul(1_000).saturating_add(CHALLENGE_TTL_MS.saturating_mul(1_000)); }';
  {
    const r = checkDeadlineMsFloored(badDeadlineNoInsert);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (CHAL_REAPER_DEADLINE_MS_FLOORED bad-no-insert): checker passed fixture that never inserts the schedule row (survivor-pin)',
      };
    }
  }
  // CHAL_REAPER_DEADLINE_MS_FLOORED: good — full trading.rs-shaped clone.
  const goodDeadline =
    'fn schedule_challenge_reaper(ctx: &ReducerContext, challenge_id: u64, created_at_ms: i64) { let deadline_micros = created_at_ms\n        .saturating_mul(1_000)\n        .saturating_add(CHALLENGE_TTL_MS.saturating_mul(1_000)); ctx.db.battle_challenge_reaper_schedule().insert(BattleChallengeReaperSchedule { scheduled_id: 0, scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(deadline_micros)), challenge_id }); }';
  {
    const r = checkDeadlineMsFloored(goodDeadline);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (CHAL_REAPER_DEADLINE_MS_FLOORED good): checker rejected valid fixture: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Read the actual source and run all seven criteria
  // -------------------------------------------------------------------------
  let pvpSrc;
  try {
    pvpSrc = readFileSync('server-module/src/pvp.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/pvp.rs not found' };
  }

  const failures = [];

  const challengeBody = extractFunctionBody(pvpSrc, 'challenge_pvp');
  {
    const r = checkChalReaperArmed(challengeBody);
    if (!r.ok) failures.push(`CHAL_REAPER_ARMED: ${r.reason}`);
  }

  const reaperBody = extractFunctionBody(pvpSrc, 'battle_challenge_reaper');
  {
    const r = checkChalReaperSchedulerGuard(reaperBody);
    if (!r.ok) failures.push(`CHAL_REAPER_SCHEDULER_GUARD: ${r.reason}`);
  }
  {
    const r = checkChalReaperStaleCheck(reaperBody);
    if (!r.ok) failures.push(`CHAL_REAPER_STALE_CHECK: ${r.reason}`);
  }
  {
    const r = checkChalReaperDeletes(reaperBody);
    if (!r.ok) failures.push(`CHAL_REAPER_DELETES: ${r.reason}`);
  }
  {
    const r = checkChalReaperDisarm(pvpSrc);
    if (!r.ok) failures.push(`CHAL_REAPER_DISARM: missing disarm at: ${r.missing.join(', ')}`);
  }
  {
    const r = checkScheduleTablePrivate(pvpSrc);
    if (!r.ok) failures.push(`CHAL_REAPER_SCHEDULE_PRIVATE: ${r.reason}`);
  }

  const scheduleBody = extractFunctionBody(pvpSrc, 'schedule_challenge_reaper');
  {
    const r = checkDeadlineMsFloored(scheduleBody);
    if (!r.ok) failures.push(`CHAL_REAPER_DEADLINE_MS_FLOORED: ${r.reason}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      '7/7 challenge-reaper criteria hold (arm w/ arg-identity after insert, scheduler guard, ' +
      'stale negation shape, delete, 4-site disarm, private schedule table, ms-floored deadline); ' +
      'all teeth fixtures verified',
  };
}
