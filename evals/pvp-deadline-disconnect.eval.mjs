// pvp-deadline-disconnect eval (M16c, ADR-0109):
// Verifies the PvP liveness invariants — the guards and ordering constraints that
// prevent players from being permanently locked in an Ongoing battle they cannot
// escape.
//
// Criteria (5 liveness invariants):
//
//   SCHEDULER_GUARD   — pvp_deadline_reaper has `ctx.sender != ctx.identity()` guard
//                       (scheduler-only; prevents clients from triggering forced forfeits)
//   STALE_TURN_CHECK  — pvp_deadline_reaper checks `battle.state.turn_number != scheduled_turn`
//                       (prevents double-forfeit when both sides submitted before deadline)
//   DISCONNECT_SIDE_A — forfeit_on_disconnect filters by `player_identity()` index
//                       (challenger / side-A disconnect is handled)
//   DISCONNECT_SIDE_B — forfeit_on_disconnect filters by `opponent_identity()` index
//                       (opponent / side-B disconnect is handled)
//   CANCEL_OUTGOING_ONLY — cancel_challenges_on_disconnect filters by `challenger()` index
//                          (only OUTGOING challenges cancelled; incoming ones remain so
//                           the challenger can reconnect and await — ADR-0109 D9)
//
// Proof-of-teeth: each checker has a bad fixture (must flag) and a good fixture
// (must not flag) before the real source is read.
//
// No new RegExp() — all patterns use literal regex literals or String.indexOf().
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
// Criterion: SCHEDULER_GUARD
// pvp_deadline_reaper must have the scheduler-only identity guard:
//   `ctx.sender != ctx.identity()`
// This mirrors the `movement_tick` guard in movement.rs (ADR-0056).
// bad fixture: body without the guard → must flag.
// good fixture: body with the guard → must not flag.
// ---------------------------------------------------------------------------
function hasSchedulerGuard(body) {
  const code = stripRustComments(body);
  return /ctx\.sender\s*!=\s*ctx\.identity\s*\(\s*\)/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: STALE_TURN_CHECK
// pvp_deadline_reaper must check that the battle's current turn matches the
// scheduled turn before forfeiting.  Without this check, a reaper issued for
// turn N fires after turn N already resolved, and the turn-N+1 deadline has not
// fired yet — the reaper would incorrectly forfeit a player who already submitted
// for turn N+1 (whose reaper hasn't fired yet).
//
// Pattern: `battle.state.turn_number != scheduled_turn` (or the inverse).
// bad fixture: no stale-turn check → must flag.
// good fixture: has stale-turn check → must not flag.
// ---------------------------------------------------------------------------
function hasStaleTurnCheck(body) {
  const code = stripRustComments(body);
  return (
    /battle\.state\.turn_number\s*!=\s*scheduled_turn/.test(code) ||
    /scheduled_turn\s*!=\s*battle\.state\.turn_number/.test(code)
  );
}

// ---------------------------------------------------------------------------
// Criterion: DISCONNECT_SIDE_A / DISCONNECT_SIDE_B
// forfeit_on_disconnect must handle BOTH sides of a PvP battle:
//   - side A (challenger): filter by `player_identity()` index
//   - side B (opponent):   filter by `opponent_identity()` index
// Handling only one side leaves the other side stuck in Ongoing forever.
// bad fixture (side A only): body without `opponent_identity()` → must flag for side-B.
// good fixture: body with both `player_identity()` and `opponent_identity()` → must not flag.
// ---------------------------------------------------------------------------
function hasDisconnectSideA(body) {
  const code = stripRustComments(body);
  return /\.player_identity\(\)/.test(code);
}

function hasDisconnectSideB(body) {
  const code = stripRustComments(body);
  return /\.opponent_identity\(\)/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: CANCEL_OUTGOING_ONLY
// cancel_challenges_on_disconnect must filter by `challenger()` index (the
// disconnecting player's OWN outgoing challenges).  It must NOT filter by
// `target()` — incoming challenges targeting the disconnected player must remain
// so the challenger can reconnect and await (ADR-0109 D9).
//
// bad fixture: filters by `.target()` instead of `.challenger()` → must flag.
// good fixture: filters by `.challenger()` → must not flag.
// ---------------------------------------------------------------------------
function cancelFiltersByChallenger(body) {
  const code = stripRustComments(body);
  // The `.challenger()` call must appear as a table index accessor.
  return /\.challenger\(\)/.test(code);
}

function cancelFiltersByTarget(body) {
  const code = stripRustComments(body);
  // If the cancel function filters by `.target()`, it would cancel INCOMING
  // challenges — wrong: the challenger, not the target, disconnected.
  return /\.target\(\)/.test(code);
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'pvp-deadline-disconnect (M16c, ADR-0109: 5 liveness invariants — scheduler guard, stale-turn, both-sides disconnect, cancel-outgoing-only)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: bad fixtures must flag; good fixtures must not flag
  // -------------------------------------------------------------------------

  // SCHEDULER_GUARD
  const badScheduler =
    'fn pvp_deadline_reaper(ctx, args: PvpDeadlineSchedule) { let battle = ctx.db.battle().battle_id().find(args.battle_id); apply_pvp_forfeit(ctx, battle); }';
  if (hasSchedulerGuard(badScheduler)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasSchedulerGuard should NOT pass fixture without `ctx.sender != ctx.identity()` guard',
    };
  }
  const goodScheduler =
    'fn pvp_deadline_reaper(ctx, args: PvpDeadlineSchedule) { if ctx.sender != ctx.identity() { return Err("scheduler-only"); } }';
  if (!hasSchedulerGuard(goodScheduler)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasSchedulerGuard should detect `ctx.sender != ctx.identity()` in good fixture',
    };
  }

  // STALE_TURN_CHECK
  const badStale =
    'fn pvp_deadline_reaper(ctx, args) { if ctx.sender != ctx.identity() { return Err(""); } let forfeited = pvp_deadline_forfeit_side(a_sub, b_sub); apply_pvp_forfeit(ctx, battle, forfeited); }';
  if (hasStaleTurnCheck(badStale)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasStaleTurnCheck should NOT pass fixture without turn_number stale-schedule check',
    };
  }
  const goodStale =
    'fn pvp_deadline_reaper(ctx, args) { if battle.state.turn_number != scheduled_turn { return Ok(()); } }';
  if (!hasStaleTurnCheck(goodStale)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasStaleTurnCheck should detect `battle.state.turn_number != scheduled_turn` in good fixture',
    };
  }

  // DISCONNECT_SIDE_A
  // Bad fixture: only has opponent_identity (side B), missing player_identity (side A).
  // Checker must return false (flag the missing side-A coverage).
  const sideAOnlyBad =
    'fn forfeit_on_disconnect(ctx, disconnected) { let ids: Vec<u64> = ctx.db.battle().opponent_identity().filter(disconnected).map(|b| b.battle_id).collect(); }';
  if (hasDisconnectSideA(sideAOnlyBad)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasDisconnectSideA should return false for fixture that only has opponent_identity() (no player_identity())',
    };
  }
  const sideAGood =
    'fn forfeit_on_disconnect(ctx, disconnected) { let a_ids = ctx.db.battle().player_identity().filter(disconnected).collect(); }';
  if (!hasDisconnectSideA(sideAGood)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasDisconnectSideA should detect `.player_identity()` in good fixture',
    };
  }

  // DISCONNECT_SIDE_B
  const sideBOnlyBad =
    'fn forfeit_on_disconnect(ctx, disconnected) { let ids = ctx.db.battle().player_identity().filter(disconnected).collect(); }';
  if (hasDisconnectSideB(sideBOnlyBad)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasDisconnectSideB should return false for fixture that only has player_identity() (no opponent_identity())',
    };
  }
  const sideBGood =
    'fn forfeit_on_disconnect(ctx, disconnected) { let b_ids = ctx.db.battle().opponent_identity().filter(disconnected).collect(); }';
  if (!hasDisconnectSideB(sideBGood)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasDisconnectSideB should detect `.opponent_identity()` in good fixture',
    };
  }

  // CANCEL_OUTGOING_ONLY — cancelFiltersByChallenger + cancelFiltersByTarget
  const badCancelTarget =
    'fn cancel_challenges_on_disconnect(ctx, player) { let ids = ctx.db.battle_challenge().target().filter(player).map(|c| c.challenge_id).collect(); }';
  if (cancelFiltersByChallenger(badCancelTarget)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: cancelFiltersByChallenger should NOT detect `.challenger()` in target-only bad fixture',
    };
  }
  if (!cancelFiltersByTarget(badCancelTarget)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: cancelFiltersByTarget should detect `.target()` in bad fixture (wrong filter)',
    };
  }
  const goodCancelChallenger =
    'fn cancel_challenges_on_disconnect(ctx, player) { let ids = ctx.db.battle_challenge().challenger().filter(player).map(|c| c.challenge_id).collect(); }';
  if (!cancelFiltersByChallenger(goodCancelChallenger)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: cancelFiltersByChallenger should detect `.challenger()` in good fixture',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source file
  // -------------------------------------------------------------------------
  let pvpSrc;
  try {
    pvpSrc = readFileSync('server-module/src/pvp.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/pvp.rs not found' };
  }

  const failures = [];

  // -------------------------------------------------------------------------
  // pvp_deadline_reaper: scheduler guard + stale-turn check
  // -------------------------------------------------------------------------
  const reaperBody = extractFunctionBody(pvpSrc, 'pvp_deadline_reaper');
  if (!reaperBody) {
    failures.push(
      'SCHEDULER_GUARD: `pvp_deadline_reaper` function not found in server-module/src/pvp.rs',
    );
  } else {
    if (!hasSchedulerGuard(reaperBody)) {
      failures.push(
        'SCHEDULER_GUARD (ADR-0109): `pvp_deadline_reaper` is missing the `ctx.sender != ctx.identity()` ' +
          'guard — any client can call pvp_deadline_reaper directly, forcing an immediate forfeit ' +
          'of the non-calling side without waiting for the real deadline',
      );
    }
    if (!hasStaleTurnCheck(reaperBody)) {
      failures.push(
        'STALE_TURN_CHECK (ADR-0109): `pvp_deadline_reaper` does not check ' +
          '`battle.state.turn_number != scheduled_turn` — a reaper issued for turn N fires ' +
          'AFTER turn N resolved normally; without the stale-turn check it incorrectly forfeits ' +
          'one or both players on a turn that already completed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // forfeit_on_disconnect: both side-A and side-B
  // -------------------------------------------------------------------------
  const forfeitBody = extractFunctionBody(pvpSrc, 'forfeit_on_disconnect');
  if (!forfeitBody) {
    failures.push(
      'DISCONNECT_SIDE_A: `forfeit_on_disconnect` function not found in server-module/src/pvp.rs',
    );
  } else {
    if (!hasDisconnectSideA(forfeitBody)) {
      failures.push(
        'DISCONNECT_SIDE_A (ADR-0109 D8): `forfeit_on_disconnect` does not filter by ' +
          '`player_identity()` — disconnecting challenger (side A) battles are not forfeited, ' +
          'leaving the opponent stuck in an Ongoing battle they cannot leave',
      );
    }
    if (!hasDisconnectSideB(forfeitBody)) {
      failures.push(
        'DISCONNECT_SIDE_B (ADR-0109 D8): `forfeit_on_disconnect` does not filter by ' +
          '`opponent_identity()` — disconnecting opponent (side B) battles are not forfeited, ' +
          'leaving the challenger stuck in an Ongoing battle they cannot leave',
      );
    }
  }

  // -------------------------------------------------------------------------
  // cancel_challenges_on_disconnect: only cancels OUTGOING (challenger) challenges
  // -------------------------------------------------------------------------
  const cancelBody = extractFunctionBody(pvpSrc, 'cancel_challenges_on_disconnect');
  if (!cancelBody) {
    failures.push(
      'CANCEL_OUTGOING_ONLY: `cancel_challenges_on_disconnect` function not found in server-module/src/pvp.rs',
    );
  } else {
    if (!cancelFiltersByChallenger(cancelBody)) {
      failures.push(
        'CANCEL_OUTGOING_ONLY (ADR-0109 D9): `cancel_challenges_on_disconnect` does not filter by ' +
          "`.challenger()` — the disconnecting player's outgoing challenges are not cleaned up, " +
          'leaving ghost Pending rows in the public `battle_challenge` table that permanently ' +
          'block the target from receiving new challenges',
      );
    }
    if (cancelFiltersByTarget(cancelBody)) {
      failures.push(
        'CANCEL_OUTGOING_ONLY (ADR-0109 D9): `cancel_challenges_on_disconnect` filters by ' +
          '`.target()` — this cancels INCOMING challenges targeting the disconnected player, ' +
          'which is wrong: incoming challenges must remain so the challenger can reconnect and ' +
          'still have their challenge accepted (ADR-0109 D9 policy)',
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
      'all 5 PvP liveness invariants confirmed: scheduler guard, stale-turn check, ' +
      'disconnect side-A, disconnect side-B, cancel-outgoing-only (ADR-0109)',
  };
}
