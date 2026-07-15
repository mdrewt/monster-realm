// pvp-handshake-guards eval (M16c, ADR-0109):
// Verifies the security guards across the four PvP challenge lifecycle reducers
// (challenge_pvp, accept_challenge, decline_challenge, cancel_challenge).
//
// Each reducer must check: the correct role (who is permitted to act), the
// correct lifecycle state (Pending only), and must GC the challenge row when
// done.  Missing any of these enables role-confusion attacks, status races,
// or orphaned challenge rows that permanently lock the challenge slot.
//
// Criteria (11 guard sites):
//   SELF_CHALLENGE_GUARD  — challenge_pvp checks `target == me` (no self-challenges)
//   TARGET_BATTLE_GUARD   — challenge_pvp checks is_in_ongoing_battle for the TARGET
//   ACCEPT_ROLE           — accept_challenge guards `challenge.target != me`
//   ACCEPT_STATUS         — accept_challenge checks ChallengeStatus::Pending
//   ACCEPT_DELETE         — accept_challenge deletes the challenge row (GC)
//   DECLINE_ROLE          — decline_challenge guards `challenge.target != me`
//   DECLINE_STATUS        — decline_challenge checks ChallengeStatus::Pending
//   DECLINE_DELETE        — decline_challenge deletes the challenge row (GC)
//   CANCEL_INITIATOR      — cancel_challenge guards `challenge.challenger != me`
//   CANCEL_STATUS         — cancel_challenge checks ChallengeStatus::Pending
//   CANCEL_DELETE         — cancel_challenge deletes the challenge row (GC)
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

/**
 * Extract a named function's body (between outer braces), or null if missing.
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

// ---------------------------------------------------------------------------
// Criterion: SELF_CHALLENGE_GUARD
// challenge_pvp must check `target == me` and return Err (no self-challenges).
// bad fixture: no self-challenge guard → must flag.
// good fixture: has `target == me` guard → must not flag.
// ---------------------------------------------------------------------------
function hasSelfChallengeGuard(body) {
  const code = stripRustComments(body);
  return /\btarget\s*==\s*me\b/.test(code) || /\bme\s*==\s*target\b/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: TARGET_BATTLE_GUARD
// challenge_pvp must call is_in_ongoing_battle with the `target` identity
// (not just the caller `me`) before inserting the BattleChallenge row.
// bad fixture: only checks `me` → must flag.
// good fixture: calls is_in_ongoing_battle(ctx, target) → must not flag.
// ---------------------------------------------------------------------------
function hasTargetBattleGuard(body) {
  const code = stripRustComments(body);
  return /is_in_ongoing_battle\s*\(\s*ctx\s*,\s*target\s*\)/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: ACCEPT_ROLE / DECLINE_ROLE
// accept_challenge and decline_challenge must guard on challenge.target != me
// (only the designated target may accept or decline).
// bad fixture: no role check → must flag.
// good fixture: has `challenge.target != me` → must not flag.
// ---------------------------------------------------------------------------
function hasChallengeTargetCheck(body) {
  const code = stripRustComments(body);
  return (
    /challenge\.target\s*!=\s*me\b/.test(code) ||
    /\bme\s*!=\s*challenge\.target\b/.test(code) ||
    /challenge\.target\s*!=\s*ctx\.sender\b/.test(code)
  );
}

// ---------------------------------------------------------------------------
// Criterion: ACCEPT_STATUS / DECLINE_STATUS / CANCEL_STATUS
// All three must gate on ChallengeStatus::Pending to reject stale/non-pending
// challenges and prevent double-accept / double-decline races.
// bad fixture: no status check → must flag.
// good fixture: has `ChallengeStatus::Pending` → must not flag.
// ---------------------------------------------------------------------------
function hasPendingStatusCheck(body) {
  const code = stripRustComments(body);
  return /ChallengeStatus::Pending/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: ACCEPT_DELETE / DECLINE_DELETE / (cancel_challenge uses same pattern)
// Accepted, declined, and cancelled challenges are GC'd immediately — the challenge
// row must be deleted.  An undead challenge row permanently occupies the challenge
// slot, leaving both players unable to initiate new challenges.
// bad fixture: no delete call → must flag.
// good fixture: has `challenge_id().delete(` → must not flag.
// ---------------------------------------------------------------------------
function hasChallengeDelete(body) {
  const code = stripRustComments(body);
  // Allow \s* between challenge_id() and .delete( because the real source
  // chains these on separate lines (multi-line method chaining).
  return /challenge_id\(\)\s*\.delete\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion: CANCEL_INITIATOR
// cancel_challenge must guard on `challenge.challenger != me` (only the initiator
// may cancel their own challenge; the target cannot cancel on the initiator's behalf).
// bad fixture: no initiator check → must flag.
// good fixture: has `challenge.challenger != me` → must not flag.
// ---------------------------------------------------------------------------
function hasChallengeInitiatorCheck(body) {
  const code = stripRustComments(body);
  return (
    /challenge\.challenger\s*!=\s*me\b/.test(code) ||
    /\bme\s*!=\s*challenge\.challenger\b/.test(code) ||
    /challenge\.challenger\s*!=\s*ctx\.sender\b/.test(code)
  );
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'pvp-handshake-guards (M16c, ADR-0109: 11 challenge lifecycle guards — role+status+GC across challenge_pvp/accept/decline/cancel)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: bad fixtures must flag; good fixtures must not flag
  // -------------------------------------------------------------------------

  // SELF_CHALLENGE_GUARD
  const badSelf =
    'fn challenge_pvp(ctx, target, party_ids) { let me = ctx.sender; if !is_in_ongoing_battle(ctx, me) { insert(challenge); } }';
  if (hasSelfChallengeGuard(badSelf)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasSelfChallengeGuard should NOT pass fixture without `target == me` check',
    };
  }
  const goodSelf =
    'fn challenge_pvp(ctx, target, party_ids) { if target == me { return Err("cannot challenge yourself"); } }';
  if (!hasSelfChallengeGuard(goodSelf)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasSelfChallengeGuard should detect `target == me` in good fixture',
    };
  }

  // TARGET_BATTLE_GUARD
  const badTargetBattle =
    'fn challenge_pvp(ctx, target, party_ids) { if is_in_ongoing_battle(ctx, me) { return Err(""); } insert(challenge); }';
  if (hasTargetBattleGuard(badTargetBattle)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasTargetBattleGuard should NOT pass fixture that only checks `me` (not `target`)',
    };
  }
  const goodTargetBattle =
    'fn challenge_pvp(ctx, target, party_ids) { if is_in_ongoing_battle(ctx, target) { return Err("target in battle"); } }';
  if (!hasTargetBattleGuard(goodTargetBattle)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasTargetBattleGuard should detect `is_in_ongoing_battle(ctx, target)` in good fixture',
    };
  }

  // ACCEPT_ROLE / DECLINE_ROLE — hasChallengeTargetCheck
  const badTargetCheck =
    'fn accept_challenge(ctx, challenge_id, party_ids) { let ch = find(challenge_id); start_pvp_battle(ctx, ch.challenger, ch.target); }';
  if (hasChallengeTargetCheck(badTargetCheck)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasChallengeTargetCheck should NOT pass fixture without `challenge.target != me` check',
    };
  }
  const goodTargetCheck =
    'fn accept_challenge(ctx, challenge_id, party_ids) { if challenge.target != me { return Err("not target"); } }';
  if (!hasChallengeTargetCheck(goodTargetCheck)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasChallengeTargetCheck should detect `challenge.target != me` in good fixture',
    };
  }

  // ACCEPT_STATUS / DECLINE_STATUS / CANCEL_STATUS — hasPendingStatusCheck
  const badStatus =
    'fn accept_challenge(ctx, challenge_id, party_ids) { if challenge.target != me { return Err(""); } start_battle(); }';
  if (hasPendingStatusCheck(badStatus)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasPendingStatusCheck should NOT pass fixture without ChallengeStatus::Pending check',
    };
  }
  const goodStatus =
    'fn accept_challenge(ctx, challenge_id, party_ids) { if challenge.status != ChallengeStatus::Pending { return Err("not pending"); } }';
  if (!hasPendingStatusCheck(goodStatus)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasPendingStatusCheck should detect `ChallengeStatus::Pending` in good fixture',
    };
  }

  // ACCEPT_DELETE / DECLINE_DELETE — hasChallengeDelete
  const badDelete =
    'fn accept_challenge(ctx, challenge_id) { start_pvp_battle(ctx, challenger, me, ...); Ok(()) }';
  if (hasChallengeDelete(badDelete)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasChallengeDelete should NOT pass fixture without challenge_id().delete( call',
    };
  }
  const goodDelete =
    'fn accept_challenge(ctx, challenge_id) { ctx.db.battle_challenge().challenge_id().delete(challenge_id); Ok(()) }';
  if (!hasChallengeDelete(goodDelete)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasChallengeDelete should detect `challenge_id().delete(` in good fixture',
    };
  }

  // CANCEL_INITIATOR — hasChallengeInitiatorCheck
  const badInitiator =
    'fn cancel_challenge(ctx, challenge_id) { if challenge.target != me { return Err(""); } ctx.db.battle_challenge().challenge_id().delete(challenge_id); }';
  if (hasChallengeInitiatorCheck(badInitiator)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasChallengeInitiatorCheck should NOT pass fixture that checks `challenge.target` (not `challenge.challenger`)',
    };
  }
  const goodInitiator =
    'fn cancel_challenge(ctx, challenge_id) { if challenge.challenger != me { return Err("not initiator"); } }';
  if (!hasChallengeInitiatorCheck(goodInitiator)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasChallengeInitiatorCheck should detect `challenge.challenger != me` in good fixture',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source files
  // -------------------------------------------------------------------------
  let pvpSrc;
  try {
    pvpSrc = readFileSync('server-module/src/pvp.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/pvp.rs not found' };
  }

  const failures = [];

  // -------------------------------------------------------------------------
  // challenge_pvp: self-challenge guard + target-battle guard
  // -------------------------------------------------------------------------
  const challengeBody = extractFunctionBody(pvpSrc, 'challenge_pvp');
  if (!challengeBody) {
    failures.push(
      'SELF_CHALLENGE_GUARD: `challenge_pvp` function not found in server-module/src/pvp.rs',
    );
  } else {
    if (!hasSelfChallengeGuard(challengeBody)) {
      failures.push(
        'SELF_CHALLENGE_GUARD (ADR-0109): `challenge_pvp` does not check `target == me` — ' +
          'a player can challenge themselves, creating a trivial self-PvP exploit',
      );
    }
    if (!hasTargetBattleGuard(challengeBody)) {
      failures.push(
        'TARGET_BATTLE_GUARD (ADR-0109): `challenge_pvp` does not call ' +
          '`is_in_ongoing_battle(ctx, target)` — a player can be challenged while already ' +
          'in an active PvP or PvE battle, creating an accept-race and inbox clutter',
      );
    }
  }

  // -------------------------------------------------------------------------
  // accept_challenge: role + status + GC
  // -------------------------------------------------------------------------
  const acceptBody = extractFunctionBody(pvpSrc, 'accept_challenge');
  if (!acceptBody) {
    failures.push('ACCEPT_ROLE: `accept_challenge` function not found in server-module/src/pvp.rs');
  } else {
    if (!hasChallengeTargetCheck(acceptBody)) {
      failures.push(
        'ACCEPT_ROLE (ADR-0109): `accept_challenge` does not check `challenge.target != me` — ' +
          'the challenger themselves (or a third party) can accept their own challenge, ' +
          'bypassing the target consent requirement',
      );
    }
    if (!hasPendingStatusCheck(acceptBody)) {
      failures.push(
        'ACCEPT_STATUS (ADR-0109): `accept_challenge` does not check `ChallengeStatus::Pending` — ' +
          'a previously accepted or declined challenge row can be accepted again via a race',
      );
    }
    if (!hasChallengeDelete(acceptBody)) {
      failures.push(
        'ACCEPT_DELETE (ADR-0109): `accept_challenge` does not delete the challenge row — ' +
          'the Pending challenge stays in the public table after the battle starts, ' +
          'leaving a ghost row that blocks future challenges',
      );
    }
  }

  // -------------------------------------------------------------------------
  // decline_challenge: role + status + GC
  // -------------------------------------------------------------------------
  const declineBody = extractFunctionBody(pvpSrc, 'decline_challenge');
  if (!declineBody) {
    failures.push(
      'DECLINE_ROLE: `decline_challenge` function not found in server-module/src/pvp.rs',
    );
  } else {
    if (!hasChallengeTargetCheck(declineBody)) {
      failures.push(
        'DECLINE_ROLE (ADR-0109): `decline_challenge` does not check `challenge.target != me` — ' +
          'the challenger can decline their own challenge, cancelling it while logging it as a decline',
      );
    }
    if (!hasPendingStatusCheck(declineBody)) {
      failures.push(
        'DECLINE_STATUS (ADR-0109): `decline_challenge` does not check `ChallengeStatus::Pending` — ' +
          'a non-pending challenge row can be declined, creating a double-decline race',
      );
    }
    if (!hasChallengeDelete(declineBody)) {
      failures.push(
        'DECLINE_DELETE (ADR-0109): `decline_challenge` does not delete the challenge row — ' +
          'a declined challenge stays in the public table, permanently blocking new challenges ' +
          'for the target player',
      );
    }
  }

  // -------------------------------------------------------------------------
  // cancel_challenge: initiator-only + status + GC
  // -------------------------------------------------------------------------
  const cancelBody = extractFunctionBody(pvpSrc, 'cancel_challenge');
  if (!cancelBody) {
    failures.push(
      'CANCEL_INITIATOR: `cancel_challenge` function not found in server-module/src/pvp.rs',
    );
  } else {
    if (!hasChallengeInitiatorCheck(cancelBody)) {
      failures.push(
        'CANCEL_INITIATOR (ADR-0109): `cancel_challenge` does not check `challenge.challenger != me` — ' +
          'the target (or anyone) can cancel a challenge they did not send, denying the challenger ' +
          'the ability to receive an accept',
      );
    }
    if (!hasPendingStatusCheck(cancelBody)) {
      failures.push(
        'CANCEL_STATUS (ADR-0109): `cancel_challenge` does not check `ChallengeStatus::Pending` — ' +
          'a non-pending challenge can be cancelled after it has already been accepted',
      );
    }
    if (!hasChallengeDelete(cancelBody)) {
      failures.push(
        'CANCEL_DELETE (ADR-0109): `cancel_challenge` does not delete the challenge row — ' +
          'a cancelled challenge stays in the public battle_challenge table, permanently ' +
          'blocking the target from receiving new challenges from anyone',
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
      'all 11 PvP handshake-guard criteria met: self-challenge guard, target-battle guard, ' +
      'accept role+status+GC, decline role+status+GC, cancel initiator+status+GC (ADR-0109)',
  };
}
