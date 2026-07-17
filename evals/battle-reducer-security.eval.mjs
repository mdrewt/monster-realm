// battle-reducer-security eval (M8.5a): every battle reducer in server-module
// must have an ownership check (ctx.sender / player_identity guard), the three
// action reducers (submit_attack, swap_active, flee) must check outcome ==
// Ongoing before acting, start_battle must have an opponent-provenance gate,
// and write_back helpers must not touch side_b rows.
//
// Proof-of-teeth: fixtures WITHOUT the required pattern are flagged; fixtures
// WITH them pass. A checker that doesn't bite is reported as TEETH FAILED.
//
// This eval starts RED until the implementer adds the opponent-provenance gate
// to start_battle.
import { readdirSync, readFileSync, statSync } from 'node:fs';

const SERVER_SRC = 'server-module/src';

// ---------------------------------------------------------------------------
// Strip Rust comments so doc-comment prose doesn't trip the scanner.
// ---------------------------------------------------------------------------
export function stripRustComments(src) {
  // Block comments first, then line comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Extract a single function's body from the source.
//
// Matches:  pub fn <name>( or fn <name>(
// We use brace-depth counting because the body may be multi-line.
// Returns the raw text of the function body (between the outer braces), or
// null if the function is not found.
// ---------------------------------------------------------------------------
export function extractReducerBody(src, reducerName) {
  // Find `pub fn <name>(` or `fn <name>(` using indexOf to avoid dynamic
  // RegExp (semgrep ReDoS rule).
  let idx = src.indexOf(`pub fn ${reducerName}(`);
  if (idx === -1) idx = src.indexOf(`fn ${reducerName}(`);
  if (idx === -1) return null;

  // Walk forward from the signature to find the opening brace.
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  // Count braces to find the matching close.
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
// Check: does the reducer body contain an ownership check?
//
// An ownership check is: comparing ctx.sender (or battle.player_identity)
// against some known identity — either via `ctx.sender` direct comparison
// or via a `player_identity` field comparison.
//
// Patterns accepted (after comment-stripping):
//   - ctx.sender
//   - player_identity
// ---------------------------------------------------------------------------
export function hasOwnershipCheck(body) {
  const code = stripRustComments(body);
  return /ctx\.sender/.test(code) || /player_identity/.test(code);
}

// ---------------------------------------------------------------------------
// Check: does the reducer body check outcome == Ongoing before acting?
//
// FIXED (M8.5a): the old `/\.outcome/.test(code)` clause was toothless —
// it matched any read of `.outcome` without requiring a comparison. Now we
// require an explicit equality/inequality test against BattleOutcome::Ongoing
// OR a direct outcome== / outcome!= comparison. A bare `.outcome` read (e.g.
// to log or assign) no longer satisfies this checker.
//
// Patterns accepted (after comment-stripping):
//   - BattleOutcome::Ongoing (must appear in source — used in match or ==)
//   - outcome == / outcome != (direct comparison)
// ---------------------------------------------------------------------------
export function hasOutcomeCheck(body) {
  const code = stripRustComments(body);
  return /BattleOutcome::Ongoing/.test(code) || /outcome\s*(==|!=)\s*/.test(code);
}

// ---------------------------------------------------------------------------
// NEW (M8.5a): Check that a start_battle body gates on opponent provenance.
//
// Returns true IFF the body contains a provenance comparison of
// `opponent_identity` against a sender/sentinel token (me, ctx.sender, or
// WILD_IDENTITY) that appears in a CONDITIONAL context — inside an `if`,
// or joined by `&&` / `||`.  A bare `let _ = opponent_identity != me;` or
// `assert!(opponent_identity != me);` (dead code) does NOT satisfy this
// because neither is preceded by `if`/`&&`/`||`.
//
// Implemented with literal regexes only (NO new RegExp — Semgrep
// detect-non-literal-regexp has bitten 3×).
//
// Accepted patterns (LHS-first, all three conditional prefixes):
//   if opponent_identity (==|!=) me/ctx.sender/WILD_IDENTITY
//   && opponent_identity (==|!=) me/ctx.sender/WILD_IDENTITY
//   || opponent_identity (==|!=) me/ctx.sender/WILD_IDENTITY
//   (and reversed-operand forms with same three prefixes)
//
// The real implemented gate is:
//   if opponent_identity != me && opponent_identity != WILD_IDENTITY { ... }
// — line 1 matches the `if` LHS-form; line 2 matches the `&&` LHS-form.
// ---------------------------------------------------------------------------
export function hasOpponentProvenanceGate(body) {
  const code = stripRustComments(body);
  // LHS-first forms: (if|&&|||) opponent_identity (==|!=) SENTINEL
  return (
    /if\s+opponent_identity\s*(==|!=)\s*me\b/.test(code) ||
    /if\s+opponent_identity\s*(==|!=)\s*ctx\.sender/.test(code) ||
    /if\s+opponent_identity\s*(==|!=)\s*WILD_IDENTITY/.test(code) ||
    /&&\s*opponent_identity\s*(==|!=)\s*me\b/.test(code) ||
    /&&\s*opponent_identity\s*(==|!=)\s*ctx\.sender/.test(code) ||
    /&&\s*opponent_identity\s*(==|!=)\s*WILD_IDENTITY/.test(code) ||
    /\|\|\s*opponent_identity\s*(==|!=)\s*me\b/.test(code) ||
    /\|\|\s*opponent_identity\s*(==|!=)\s*ctx\.sender/.test(code) ||
    /\|\|\s*opponent_identity\s*(==|!=)\s*WILD_IDENTITY/.test(code) ||
    // Reversed-operand forms: (if|&&|||) SENTINEL (==|!=) opponent_identity
    /if\s+me\s*(==|!=)\s*opponent_identity/.test(code) ||
    /if\s+ctx\.sender\s*(==|!=)\s*opponent_identity/.test(code) ||
    /if\s+WILD_IDENTITY\s*(==|!=)\s*opponent_identity/.test(code) ||
    /&&\s*me\s*(==|!=)\s*opponent_identity/.test(code) ||
    /&&\s*ctx\.sender\s*(==|!=)\s*opponent_identity/.test(code) ||
    /&&\s*WILD_IDENTITY\s*(==|!=)\s*opponent_identity/.test(code) ||
    /\|\|\s*me\s*(==|!=)\s*opponent_identity/.test(code) ||
    /\|\|\s*ctx\.sender\s*(==|!=)\s*opponent_identity/.test(code) ||
    /\|\|\s*WILD_IDENTITY\s*(==|!=)\s*opponent_identity/.test(code)
  );
}

// ---------------------------------------------------------------------------
// NEW (M8.5a): Check that write_back helpers do NOT *write* to side_b rows.
//
// Extracts the bodies of `write_back_battle_results` AND `write_back_party_hp`
// from the source and returns true iff EITHER body contains a side-B write
// loop pattern — meaning it iterates `side_b.team` (symmetric write-back) OR
// references `opponent_monster_ids` (resolving opponent rows to update).
//
// The legitimate read `battle.state.side_b.active_monster()` in
// write_back_battle_results (for the XP formula — reads the loser's species)
// contains NEITHER `side_b.team` NOR `opponent_monster_ids`, so it passes.
//
// Invariant: side-B rows (monster / monster_pub) must be byte-for-byte
// unchanged after any battle ends. Only side_a (party) rows are written back.
// ---------------------------------------------------------------------------
export function writeBackTouchesSideB(src) {
  const body1 = extractReducerBody(src, 'write_back_battle_results');
  const body2 = extractReducerBody(src, 'write_back_party_hp');
  const code1 = body1 ? stripRustComments(body1) : '';
  const code2 = body2 ? stripRustComments(body2) : '';
  // Flag a side-B *write loop*: team iteration over side_b, or resolving
  // opponent_monster_ids (the backing ids for the opponent's owned monsters).
  // A bare `side_b.active_monster()` read contains neither pattern.
  return (
    /side_b\.team/.test(code1) ||
    /side_b\.team/.test(code2) ||
    /opponent_monster_ids/.test(code1) ||
    /opponent_monster_ids/.test(code2)
  );
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'battle-reducer-security (ownership checks, outcome guards, opponent-provenance gate, side-B no-write)';

  // =========================================================================
  // Biting fixture suite — these run BEFORE the real-source scan so a broken
  // checker is caught immediately. If any checker does not bite, we short-
  // circuit with TEETH FAILED.
  // =========================================================================

  // -------------------------------------------------------------------------
  // Fixture 1 (existing): a reducer WITHOUT ownership check must be flagged.
  // -------------------------------------------------------------------------
  const badReducerNoOwnership = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        // No ownership check — any player can flee any battle!
        let mut battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        battle.state.outcome = BattleOutcome::Fled;
        ctx.db.battle().battle_id().update(battle);
        Ok(())
    }
  `;
  const badBody1 = extractReducerBody(badReducerNoOwnership, 'flee');
  if (!badBody1) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: could not extract flee body from bad fixture (parser bug)',
    };
  }
  if (hasOwnershipCheck(badBody1)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: reducer without ownership check was not flagged',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 2 (existing): a reducer WITHOUT outcome check must be flagged.
  // -------------------------------------------------------------------------
  const badReducerNoOutcome = `
    pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        // No outcome check — can attack a finished battle!
        resolve_turn_and_write_back(ctx, battle, skill_id)
    }
  `;
  const badBody2 = extractReducerBody(badReducerNoOutcome, 'submit_attack');
  if (!badBody2) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: could not extract submit_attack body from bad fixture (parser bug)',
    };
  }
  if (hasOutcomeCheck(badBody2)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: reducer without outcome check was not flagged',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 3 (existing): a reducer WITH both ownership + outcome checks must
  // pass (no false positive).
  // -------------------------------------------------------------------------
  const goodReducer = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let me = ctx.sender;
        let mut battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        if battle.state.outcome != BattleOutcome::Ongoing {
            return Err("battle is not ongoing".to_string());
        }
        battle.state.outcome = BattleOutcome::Fled;
        ctx.db.battle().battle_id().update(battle);
        Ok(())
    }
  `;
  const goodBody = extractReducerBody(goodReducer, 'flee');
  if (!goodBody) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: could not extract flee body from good fixture (parser bug)',
    };
  }
  if (!hasOwnershipCheck(goodBody)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: good reducer was incorrectly flagged as missing ownership check',
    };
  }
  if (!hasOutcomeCheck(goodBody)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: good reducer was incorrectly flagged as missing outcome check',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 4 (M8.5a NEW): hasOutcomeCheck must NOT match a bare `.outcome`
  // read.  A body that reads `battle.state.outcome` and assigns / logs it but
  // never compares it must be flagged.
  //
  // Kills: the old toothless `/\.outcome/.test(code)` clause.
  // -------------------------------------------------------------------------
  const bareOutcomeRead = `
    pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String> {
        let battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        // Only reads .outcome but never compares it — toothless guard.
        let o = battle.state.outcome;
        log::info!("outcome is {:?}", o);
        resolve_turn_and_write_back(ctx, battle, skill_id)
    }
  `;
  const bareOutcomeBody = extractReducerBody(bareOutcomeRead, 'submit_attack');
  if (!bareOutcomeBody) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: could not extract submit_attack body from bare-outcome fixture (parser bug)',
    };
  }
  if (hasOutcomeCheck(bareOutcomeBody)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: outcome checker matched a bare .outcome read without ==|!= comparison ' +
        '(the old toothless /\\.outcome/ clause was not removed)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 5 (M8.5a NEW — provenance BAD): a start_battle body that builds
  // side-B from opponent_identity but has no ==|!= gate against a sentinel.
  //
  // This is the distilled bug: caller provides any Identity they like; server
  // blindly uses it as the opponent.  Assert hasOpponentProvenanceGate === false.
  // If it returns true → TEETH FAILED.
  // -------------------------------------------------------------------------
  const provenanceBadBody = `
    pub fn start_battle(
        ctx: &ReducerContext,
        opponent_identity: Identity,
        party_monster_ids: Vec<u64>,
        opponent_monster_ids: Vec<u64>,
    ) -> Result<(), String> {
        let me = ctx.sender;
        // No provenance gate — accepts any opponent_identity the caller passes.
        for &mid in &opponent_monster_ids {
            let m = ctx.db.monster().monster_id().find(mid)
                .ok_or_else(|| "not found".to_string())?;
            if m.owner_identity != opponent_identity {
                return Err("wrong owner".to_string());
            }
        }
        Ok(())
    }
  `;
  const provenanceBad = extractReducerBody(provenanceBadBody, 'start_battle');
  if (!provenanceBad) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: could not extract start_battle body from provenance-bad fixture (parser bug)',
    };
  }
  if (hasOpponentProvenanceGate(provenanceBad)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: provenance checker did not bite a gate-less start_battle — ' +
        'hasOpponentProvenanceGate returned true for a body with NO ==|!= to me/ctx.sender/WILD_IDENTITY',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 6 (M8.5a NEW — provenance GOOD): a start_battle body containing
  // the correct inline guard.  Assert hasOpponentProvenanceGate === true.
  // -------------------------------------------------------------------------
  const provenanceGoodBody = `
    pub fn start_battle(
        ctx: &ReducerContext,
        opponent_identity: Identity,
        party_monster_ids: Vec<u64>,
        opponent_monster_ids: Vec<u64>,
    ) -> Result<(), String> {
        let me = ctx.sender;
        // Provenance gate: reject if opponent is neither the caller nor the wild sentinel.
        if opponent_identity != me && opponent_identity != WILD_IDENTITY {
            return Err("opponent_identity must be self or WILD_IDENTITY".to_string());
        }
        Ok(())
    }
  `;
  const provenanceGood = extractReducerBody(provenanceGoodBody, 'start_battle');
  if (!provenanceGood) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: could not extract start_battle body from provenance-good fixture (parser bug)',
    };
  }
  if (!hasOpponentProvenanceGate(provenanceGood)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: provenance checker produced a false negative on a correctly-gated start_battle',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 7 (M8.5a NEW — provenance TRIVIAL-BYPASS): a body with a
  // self-comparison `opponent_identity == opponent_identity` and NO real gate.
  //
  // A self-compare trivially satisfies nothing — the checker must return false.
  // This fixture kills any regex that accepts any `opponent_identity ==` pattern
  // without anchoring the RHS to me/ctx.sender/WILD_IDENTITY.
  // -------------------------------------------------------------------------
  const provenanceTrivialBody = `
    pub fn start_battle(
        ctx: &ReducerContext,
        opponent_identity: Identity,
        party_monster_ids: Vec<u64>,
        opponent_monster_ids: Vec<u64>,
    ) -> Result<(), String> {
        let me = ctx.sender;
        // Trivial self-compare — not a real gate.
        if opponent_identity == opponent_identity {
            // always true, so this is a no-op
        }
        Ok(())
    }
  `;
  const provenanceTrivial = extractReducerBody(provenanceTrivialBody, 'start_battle');
  if (!provenanceTrivial) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: could not extract start_battle body from trivial-bypass fixture (parser bug)',
    };
  }
  if (hasOpponentProvenanceGate(provenanceTrivial)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: provenance checker accepted a trivial self-compare (opponent_identity == opponent_identity) ' +
        'as a valid gate — the RHS anchors must require me/ctx.sender/WILD_IDENTITY',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 7b (M8.5a HARDENED — provenance DEAD-CODE bypass): a body that
  // compares `opponent_identity != me` but only as a dead let-binding, never
  // inside an `if`/`&&`/`||` conditional.  The pre-hardening checker accepted
  // this as a valid gate; the hardened checker must return false.
  //
  // Kills: the old bare-comparison checker that only required `opponent_identity
  // (==|!=) me` anywhere in the body without a conditional prefix.
  // -------------------------------------------------------------------------
  const provenanceDeadCodeBody = `
    pub fn start_battle(
        ctx: &ReducerContext,
        opponent_identity: Identity,
        party_monster_ids: Vec<u64>,
        opponent_monster_ids: Vec<u64>,
    ) -> Result<(), String> {
        let me = ctx.sender;
        // Dead-code comparison — result is immediately discarded, no rejection.
        let _ = opponent_identity != me;
        Ok(())
    }
  `;
  const provenanceDeadCode = extractReducerBody(provenanceDeadCodeBody, 'start_battle');
  if (!provenanceDeadCode) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: could not extract start_battle body from dead-code fixture (parser bug)',
    };
  }
  if (hasOpponentProvenanceGate(provenanceDeadCode)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: provenance checker accepted a dead-code bypass ' +
        '(`let _ = opponent_identity != me;` with no if/&&/||) as a valid gate — ' +
        'comparison must appear in a conditional context',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 8 (M8.5a NEW — side-B BAD): a fake write-back body that touches
  // side_b.  writeBackTouchesSideB must return true.
  //
  // Kills: an impl that symmetrically writes back both sides.
  // -------------------------------------------------------------------------
  const sideBBadSrc = `
    fn write_back_party_hp(ctx: &ReducerContext, battle: &Battle) {
        for (i, bm) in battle.state.side_a.team.iter().enumerate() {
            let mid = battle.party_monster_ids[i];
            if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
                write_back_hp(&mut m, bm);
                ctx.db.monster().monster_id().update(m);
            }
        }
        // BUG: also writes back side_b (the opponent's monsters)
        for (i, bm) in battle.state.side_b.team.iter().enumerate() {
            let mid = battle.opponent_monster_ids[i];
            if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
                write_back_hp(&mut m, bm);
                ctx.db.monster().monster_id().update(m);
            }
        }
    }
    fn write_back_battle_results(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
        write_back_party_hp(ctx, battle);
        Ok(())
    }
  `;
  if (!writeBackTouchesSideB(sideBBadSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: side-B checker did not flag a write_back_party_hp that iterates side_b.team',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 9 (M8.5a NEW — side-B GOOD): correct write-back touches only
  // side_a.  writeBackTouchesSideB must return false.
  //
  // Critically, write_back_battle_results legitimately READS side_b via
  // `battle.state.side_b.active_monster()` (to get the loser's species for
  // the XP formula). The checker must NOT flag this read — only a write loop
  // over `side_b.team` or resolution of `opponent_monster_ids` is a violation.
  // This fixture proves the checker allows the legitimate read pattern.
  // -------------------------------------------------------------------------
  const sideBGoodSrc = `
    fn write_back_party_hp(ctx: &ReducerContext, battle: &Battle) {
        for (i, bm) in battle.state.side_a.team.iter().enumerate() {
            let mid = battle.party_monster_ids[i];
            if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
                write_back_hp(&mut m, bm);
                ctx.db.monster().monster_id().update(m);
            }
        }
    }
    fn write_back_battle_results(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
        write_back_party_hp(ctx, battle);
        // Legitimate read of side_b for XP formula (loser's species) — NOT a write.
        let loser_active = battle.state.side_b.active_monster();
        let loser_species = ctx.db.species_row().id().find(loser_active.species_id)
            .ok_or_else(|| "loser species not found".to_string())?;
        let _bst = loser_base_stat_total(&loser_species);
        Ok(())
    }
  `;
  if (writeBackTouchesSideB(sideBGoodSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: side-B checker produced a false positive on a correct write-back — ' +
        'the legitimate side_b.active_monster() read (for XP formula) must NOT be flagged; ' +
        'only side_b.team iteration or opponent_monster_ids resolution is a violation',
    };
  }

  // =========================================================================
  // Real-source scan
  // =========================================================================
  let src;
  try {
    src = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read ${SERVER_SRC}: ${e.message}`,
    };
  }

  // All six battle reducers must be present (use_battle_item added m14e, ADR-0096).
  const ALL_REDUCERS = [
    'start_battle',
    'submit_attack',
    'swap_active',
    'flee',
    'heal_party',
    'use_battle_item',
  ];
  // These must additionally check outcome == Ongoing before acting.
  const OUTCOME_CHECKED_REDUCERS = ['submit_attack', 'swap_active', 'flee', 'use_battle_item'];

  const failures = [];

  for (const reducerName of ALL_REDUCERS) {
    const body = extractReducerBody(src, reducerName);
    if (!body) {
      failures.push(`${reducerName}: reducer not found in server-module source`);
      continue;
    }

    if (!hasOwnershipCheck(body)) {
      failures.push(
        `${reducerName}: missing ownership check (ctx.sender / player_identity comparison)`,
      );
    }

    if (OUTCOME_CHECKED_REDUCERS.includes(reducerName) && !hasOutcomeCheck(body)) {
      failures.push(
        `${reducerName}: missing outcome == Ongoing guard (must reject on finished battle)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // M8.5a ADDITION: start_battle must have an opponent-provenance gate in a
  // conditional context (if/&&/||) — not just a dead-code comparison.
  // -------------------------------------------------------------------------
  const startBattleBody = extractReducerBody(src, 'start_battle');
  if (startBattleBody !== null) {
    if (!hasOpponentProvenanceGate(startBattleBody)) {
      failures.push(
        'start_battle: missing opponent-provenance gate — must reject opponent_identity ' +
          'that is neither ctx.sender (self-battle) nor WILD_IDENTITY (NPC/server sentinel); ' +
          'use: if opponent_identity != me && opponent_identity != WILD_IDENTITY { return Err(..) }',
      );
    }
  }

  // -------------------------------------------------------------------------
  // M8.5a ADDITION: write_back helpers must NOT write to side_b rows.
  // A legitimate side_b.active_monster() read (for XP formula) is allowed;
  // only side_b.team iteration or opponent_monster_ids resolution is flagged.
  // -------------------------------------------------------------------------
  if (writeBackTouchesSideB(src)) {
    failures.push(
      'write_back_battle_results or write_back_party_hp contains a side-B write loop ' +
        '(side_b.team iteration or opponent_monster_ids resolution) — ' +
        'write-back must be one-sided (side_a only); opponent rows must be byte-for-byte unchanged',
    );
  }

  if (failures.length > 0) {
    return {
      name,
      pass: false,
      detail: failures.join('; '),
    };
  }

  // =========================================================================
  // m17a (ADR-0119, RL-8/9/17): PvP-reject guard criterion
  //
  // Fixtures A/B/C run first (proof-of-teeth), then the real-source scan for
  // the four PvE reducers. Failures accumulate into pvpFailures[].
  // RED now: is_ranked_pvp(&battle) absent from all four reducer bodies.
  // =========================================================================

  // -------------------------------------------------------------------------
  // Fixture A (BAD — missing pvp guard): flee body with outcome check but NO
  // is_ranked_pvp. hasPvpRejectGuard must return false.
  // Kills: a checker that accepts any body containing BattleOutcome::Ongoing.
  // -------------------------------------------------------------------------
  const badNoPvpGuard = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let me = ctx.sender;
        let mut battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        if battle.state.outcome != BattleOutcome::Ongoing {
            return Err("battle is not ongoing".to_string());
        }
        battle.state.outcome = BattleOutcome::Fled;
        ctx.db.battle().battle_id().update(battle);
        Ok(())
    }
  `;
  const badBodyA = extractReducerBody(badNoPvpGuard, 'flee');
  if (!badBodyA) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture A): could not extract flee body from bad-no-pvp-guard fixture',
    };
  }
  if (hasPvpRejectGuard(badBodyA)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture A): hasPvpRejectGuard returned true for a body ' +
        'without is_ranked_pvp — checker does not bite a missing guard',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture B (GOOD — outcome check and pvp guard in correct order):
  // hasPvpRejectGuard must return true; pvpGuardAfterOngoingCheck must return true.
  // Kills: a checker with a false negative on a correctly-guarded reducer.
  // -------------------------------------------------------------------------
  const goodWithPvpGuard = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let me = ctx.sender;
        let mut battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        if battle.state.outcome != BattleOutcome::Ongoing {
            return Err("battle is not ongoing".to_string());
        }
        if is_ranked_pvp(&battle) {
            log_reject("flee", me, "pvp battle");
            return Err("cannot flee a ranked PvP battle".to_string());
        }
        battle.state.outcome = BattleOutcome::Fled;
        ctx.db.battle().battle_id().update(battle);
        Ok(())
    }
  `;
  const goodBodyB = extractReducerBody(goodWithPvpGuard, 'flee');
  if (!goodBodyB) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture B): could not extract flee body from good-with-pvp-guard fixture',
    };
  }
  if (!hasPvpRejectGuard(goodBodyB)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture B): hasPvpRejectGuard returned false for a ' +
        'correctly-guarded body — checker has a false negative',
    };
  }
  if (!pvpGuardAfterOngoingCheck(goodBodyB)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture B): pvpGuardAfterOngoingCheck returned false for a ' +
        'correctly-ordered body (is_ranked_pvp after BattleOutcome::Ongoing) — ' +
        'order checker has a false negative',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture C (BAD ORDER — pvp guard BEFORE outcome check):
  // pvpGuardAfterOngoingCheck must return false.
  // Kills: an order checker that ignores position and just checks presence.
  // -------------------------------------------------------------------------
  const badWrongOrder = `
    pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String> {
        let me = ctx.sender;
        let battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        if is_ranked_pvp(&battle) {
            return Err("ranked pvp: use submit_pvp_action".to_string());
        }
        if battle.state.outcome != BattleOutcome::Ongoing {
            return Err("battle is not ongoing".to_string());
        }
        Ok(())
    }
  `;
  const badBodyC = extractReducerBody(badWrongOrder, 'submit_attack');
  if (!badBodyC) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture C): could not extract submit_attack body from bad-wrong-order fixture',
    };
  }
  if (!hasPvpRejectGuard(badBodyC)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture C): hasPvpRejectGuard returned false even though guard is present — ' +
        'presence check broken',
    };
  }
  if (pvpGuardAfterOngoingCheck(badBodyC)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture C): pvpGuardAfterOngoingCheck returned true for a body ' +
        'where is_ranked_pvp appears BEFORE BattleOutcome::Ongoing — ' +
        'order checker does not bite wrong ordering',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture D (BAD — dead-code call, no conditional branch):
  // `let _ = is_ranked_pvp(&battle);` after the Ongoing check.
  // hasPvpRejectGuard must return false (the identifier is present but not
  // in an `if` — the F1 hardening kills this evasion).
  // Kills: a checker that only tests identifier presence, not the `if` form.
  // -------------------------------------------------------------------------
  const deadCodeCall = `
    pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
        let me = ctx.sender;
        let mut battle = ctx.db.battle().battle_id().find(battle_id)
            .ok_or_else(|| "battle not found".to_string())?;
        if battle.player_identity != ctx.sender {
            return Err("not owner".to_string());
        }
        if battle.state.outcome != BattleOutcome::Ongoing {
            return Err("battle is not ongoing".to_string());
        }
        let _ = is_ranked_pvp(&battle);
        battle.state.outcome = BattleOutcome::Fled;
        ctx.db.battle().battle_id().update(battle);
        Ok(())
    }
  `;
  const deadBodyD = extractReducerBody(deadCodeCall, 'flee');
  if (!deadBodyD) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture D): could not extract flee body from dead-code-call fixture',
    };
  }
  if (hasPvpRejectGuard(deadBodyD)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17a fixture D): hasPvpRejectGuard returned true for a body with ' +
        'only `let _ = is_ranked_pvp(&battle)` (dead-code call, no conditional branch) — ' +
        'F1 hardening failed: checker must require the `if is_ranked_pvp(&battle)` form',
    };
  }

  // -------------------------------------------------------------------------
  // Real-source scan: four PvE reducers must carry the PvP-reject guard.
  // RED now: if is_ranked_pvp(&battle) absent from all four bodies.
  // -------------------------------------------------------------------------
  const PVP_REJECT_REDUCERS = ['submit_attack', 'swap_active', 'flee', 'use_battle_item'];
  const pvpFailures = [];

  for (const reducerName of PVP_REJECT_REDUCERS) {
    const body = extractReducerBody(src, reducerName);
    if (!body) {
      pvpFailures.push(`${reducerName}: reducer not found in server-module source`);
      continue;
    }
    if (!hasPvpRejectGuard(body)) {
      pvpFailures.push(
        `${reducerName}: missing conditional PvP-reject guard (if is_ranked_pvp(&battle)) — ` +
          `RL-8/9: PvP battles must be rejected from PvE reducers via an if-branch (ADR-0119 D5, F1)`,
      );
    } else if (!pvpGuardAfterOngoingCheck(body)) {
      pvpFailures.push(
        `${reducerName}: if is_ranked_pvp(&battle) appears BEFORE BattleOutcome::Ongoing check — ` +
          `must be placed immediately AFTER the Ongoing check (ADR-0119 D5)`,
      );
    }
  }

  if (pvpFailures.length > 0) {
    return {
      name,
      pass: false,
      detail: pvpFailures.join('; '),
    };
  }

  // =========================================================================
  // m17.5a (ADR-0122): side-B battle-guard criteria C1–C4
  //
  // C1 — shared-guard call sites (EARS 17.5a-1): 4 PvE reducer bodies must
  //      contain `is_in_ongoing_battle(ctx,` replacing their player-only inlines.
  // C2 — evolve/fuse both-role chain (EARS 17.5a-2): bodies must contain
  //      `.opponent_identity().filter(` chained into reject_if_in_battle.
  // C3 — SSOT single-definition + wrapper-body integrity: exactly one
  //      `fn is_in_ongoing_battle(` across all sources; it is in guards.rs;
  //      pvp.rs has none; wrapper body references both player_identity() and
  //      opponent_identity() (kills a wrapper passing the player iterator twice).
  // C4 — classification / insert-site provenance (EARS 17.5a-5): exactly 3
  //      battle insert sites; each has an allowlisted (file, enclosing-fn, form);
  //      is_ranked_pvp body is the two-clause sentinel form.
  //
  // All four start RED (real-source scans fail today).
  // Bad/good fixture teeth run first — TEETH FAILED short-circuits immediately.
  // Failures accumulate into sideBFailures[]; merged into final pass/detail.
  // =========================================================================

  // =========================================================================
  // C1 fixture teeth — hasBothRoleBattleGuard checker
  // =========================================================================

  // C1 bad fixture: heal_party-shaped body with only player_identity().filter inline.
  // hasBothRoleBattleGuard(body, 'me') must return FALSE (the checker bites).
  const c1BadFixture = `
    pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
        let me = ctx.sender;
        // Old player-only inline — the gap this slice closes.
        let already = ctx.db.battle().player_identity().filter(me)
            .any(|b| b.state.outcome == BattleOutcome::Ongoing);
        if already {
            return Err("cannot heal during an ongoing battle".to_string());
        }
        do_heal(ctx, me)
    }
  `;
  const c1BadBody = extractReducerBody(c1BadFixture, 'heal_party');
  if (!c1BadBody) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 bad fixture): could not extract heal_party body from ' +
        'c1BadFixture — extractReducerBody parser bug',
    };
  }
  if (hasBothRoleBattleGuard(c1BadBody, 'me')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 bad fixture): hasBothRoleBattleGuard returned true for a ' +
        'body containing only player_identity().filter inline (no is_in_ongoing_battle call) — ' +
        'checker does not bite a player-only body',
    };
  }

  // C1 bad fixture B2 (E2 NEW — dead-code call, non-if form):
  // `let _ = is_in_ongoing_battle(ctx, me);` — the guard is present but not in a
  // conditional branch. hasBothRoleBattleGuard(body, 'me') must return false.
  // Kills: a checker that only tests call-site presence, not the `if` form.
  const c1BadFixtureDeadCode = `
    pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
        let me = ctx.sender;
        // Dead-code call — result discarded, no conditional branch.
        let _ = is_in_ongoing_battle(ctx, me);
        do_heal(ctx, me)
    }
  `;
  const c1BadBodyDeadCode = extractReducerBody(c1BadFixtureDeadCode, 'heal_party');
  if (!c1BadBodyDeadCode) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 bad fixture B2 — E2 dead-code): could not extract heal_party body — ' +
        'parser bug',
    };
  }
  if (hasBothRoleBattleGuard(c1BadBodyDeadCode, 'me')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 bad fixture B2 — E2 dead-code call): hasBothRoleBattleGuard ' +
        'returned true for a body with only `let _ = is_in_ongoing_battle(ctx, me);` ' +
        '(dead-code call, non-if form) — the checker must require the `if` form (E2)',
    };
  }

  // C1 bad fixture B3 (E2 NEW — wrong-identity evasion):
  // `if is_in_ongoing_battle(ctx, opponent_identity)` when identTok='me'.
  // hasBothRoleBattleGuard(body, 'me') must return false.
  // Kills: a checker that accepts any identity token in the `if` form without
  // verifying it matches the expected per-reducer token.
  const c1BadFixtureWrongIdent = `
    pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
        let me = ctx.sender;
        // Wrong identity token — checks opponent_identity instead of me.
        if is_in_ongoing_battle(ctx, opponent_identity) {
            return Err("cannot heal during an ongoing battle".to_string());
        }
        do_heal(ctx, me)
    }
  `;
  const c1BadBodyWrongIdent = extractReducerBody(c1BadFixtureWrongIdent, 'heal_party');
  if (!c1BadBodyWrongIdent) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 bad fixture B3 — E2 wrong-identity): could not extract ' +
        'heal_party body — parser bug',
    };
  }
  if (hasBothRoleBattleGuard(c1BadBodyWrongIdent, 'me')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 bad fixture B3 — E2 wrong-identity evasion): hasBothRoleBattleGuard ' +
        'returned true for a body with `if is_in_ongoing_battle(ctx, opponent_identity)` ' +
        "when identTok='me' — the checker must require the exact per-reducer identity token (E2)",
    };
  }

  // C1 good fixture A: body with `if is_in_ongoing_battle(ctx, me)`, identTok='me'.
  const c1GoodFixtureA = `
    pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
        let me = ctx.sender;
        if is_in_ongoing_battle(ctx, me) {
            return Err("cannot heal during an ongoing battle".to_string());
        }
        do_heal(ctx, me)
    }
  `;
  const c1GoodBodyA = extractReducerBody(c1GoodFixtureA, 'heal_party');
  if (!c1GoodBodyA) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 good fixture A): could not extract heal_party body — parser bug',
    };
  }
  if (!hasBothRoleBattleGuard(c1GoodBodyA, 'me')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 good fixture A): hasBothRoleBattleGuard returned false for ' +
        "a body containing `if is_in_ongoing_battle(ctx, me)` with identTok='me' — false negative",
    };
  }

  // C1 good fixture B (plan W-1 / E2): pub(crate) fn begin_encounter shape,
  // identTok='player_identity' (the per-reducer token for begin_encounter, ADR-0122 §1.2).
  // Proves the body EXTRACTION handles the `pub(crate) fn` form — a TEETH FAILED
  // result if extraction returns null (the fn is present but not extracted).
  // Also proves the if-form check works with player_identity as the identTok.
  const c1GoodFixtureB = `
    pub(crate) fn begin_encounter(
        ctx: &ReducerContext,
        player_identity: Identity,
        party_monster_ids: Vec<u64>,
        wild_species_id: u32,
        wild_level: u8,
        individuality_seed: u32,
    ) -> Result<u64, String> {
        if is_in_ongoing_battle(ctx, player_identity) {
            return Err("already in an ongoing battle".to_string());
        }
        do_begin_encounter_work(ctx, player_identity, party_monster_ids)
    }
  `;
  const c1GoodBodyB = extractReducerBody(c1GoodFixtureB, 'begin_encounter');
  if (!c1GoodBodyB) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 good fixture B — plan W-1 / E2): extractReducerBody returned null ' +
        'for a `pub(crate) fn begin_encounter(` signature — the `fn <name>(` fallback must ' +
        'match pub(crate) fn forms; parser does not handle this shape',
    };
  }
  if (!hasBothRoleBattleGuard(c1GoodBodyB, 'player_identity')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C1 good fixture B): hasBothRoleBattleGuard returned false for ' +
        'begin_encounter body containing `if is_in_ongoing_battle(ctx, player_identity)` ' +
        "with identTok='player_identity' — false negative",
    };
  }

  // =========================================================================
  // C2 fixture teeth — countBothRoleChains / hasBothRoleChain checker (E3)
  // =========================================================================

  // C2 bad fixture A: evolve-shaped body with only player_identity().filter (player-only).
  // countBothRoleChains must return 0 (the checker bites — no structural chain).
  const c2BadFixture = `
    pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
        let m = get_monster(ctx, monster_id)?;
        // Old player-only chain — does not catch side-B monsters.
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(m.owner_identity),
            monster_id,
        )?;
        do_evolve(ctx, m)
    }
  `;
  const c2BadBody = extractReducerBody(c2BadFixture, 'evolve');
  if (!c2BadBody) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED (m17.5a C2 bad fixture A): could not extract evolve body — parser bug',
    };
  }
  if (countBothRoleChains(c2BadBody) > 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 bad fixture A): countBothRoleChains returned > 0 for a body ' +
        'with only player_identity().filter (no structural .chain( call) — checker does not bite',
    };
  }

  // C2 bad fixture B (E3 NEW — logging bypass): player-only reject_if_in_battle call
  // plus a stray `let _ = ctx.db.battle().opponent_identity().filter(owner).count();`
  // (a logging/diagnostic bypass that uses the opponent index but is NOT in the chain).
  // countBothRoleChains must return 0 — the structural .chain( token is absent.
  // Kills: a checker that only tests bare opponent_identity().filter( presence anywhere.
  const c2BadFixtureLoggingBypass = `
    pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
        let m = get_monster(ctx, monster_id)?;
        // Diagnostic log — NOT a structural chain into reject_if_in_battle.
        let _ = ctx.db.battle().opponent_identity().filter(m.owner_identity).count();
        // Guard uses only the player arm (the bypass).
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(m.owner_identity),
            monster_id,
        )?;
        do_evolve(ctx, m)
    }
  `;
  const c2BadBodyLogging = extractReducerBody(c2BadFixtureLoggingBypass, 'evolve');
  if (!c2BadBodyLogging) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 bad fixture B — E3 logging bypass): could not extract evolve body — ' +
        'parser bug',
    };
  }
  if (countBothRoleChains(c2BadBodyLogging) > 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 bad fixture B — E3 logging bypass): countBothRoleChains returned > 0 ' +
        'for a body with a stray `let _ = ctx.db.battle().opponent_identity().filter(owner).count()` ' +
        'but player-only reject_if_in_battle — the structural .chain( check must NOT be fooled by ' +
        'a bystander use of opponent_identity outside the chain call',
    };
  }

  // C2 bad fixture C (E3 NEW — partial-fuse bypass): fuse-shaped body where only ONE
  // of the two reject_if_in_battle calls has the structural chain.
  // countBothRoleChains must return 1 (< 2 = fails the ≥2 fuse requirement).
  // Kills: a fuse implementation that only chains the first reject call but leaves
  // the second (parent B) as player-only.
  const c2BadFixturePartialFuse = `
    pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
        let a = get_monster(ctx, a_id)?;
        let b = get_monster(ctx, b_id)?;
        // First call: CORRECTLY chained (catches parent A in side-B).
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(a.owner_identity)
                .chain(ctx.db.battle().opponent_identity().filter(a.owner_identity)),
            a_id,
        )?;
        // Second call: player-only (partial-fuse bypass — parent B in side-B not caught).
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(b.owner_identity),
            b_id,
        )?;
        do_fuse(ctx, a, b)
    }
  `;
  const c2BadBodyPartialFuse = extractReducerBody(c2BadFixturePartialFuse, 'fuse');
  if (!c2BadBodyPartialFuse) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 bad fixture C — E3 partial-fuse bypass): could not extract fuse body — ' +
        'parser bug',
    };
  }
  const partialFuseCount = countBothRoleChains(c2BadBodyPartialFuse);
  if (partialFuseCount >= 2) {
    return {
      name,
      pass: false,
      detail:
        `TEETH FAILED (m17.5a C2 bad fixture C — E3 partial-fuse bypass): countBothRoleChains ` +
        `returned ${partialFuseCount} (>= 2) for a fuse body where only ONE of two reject calls ` +
        'is structurally chained — the ≥2 count requirement for fuse must reject this partial fix',
    };
  }

  // C2 good fixture A: evolve body with one structurally chained call (single-line).
  // countBothRoleChains must return ≥ 1.
  const c2GoodFixture = `
    pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
        let m = get_monster(ctx, monster_id)?;
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(m.owner_identity)
                .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
            monster_id,
        )?;
        do_evolve(ctx, m)
    }
  `;
  const c2GoodBody = extractReducerBody(c2GoodFixture, 'evolve');
  if (!c2GoodBody) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED (m17.5a C2 good fixture A): could not extract evolve body — parser bug',
    };
  }
  if (countBothRoleChains(c2GoodBody) < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 good fixture A): countBothRoleChains returned < 1 for a body ' +
        'with .chain(ctx.db.battle().opponent_identity().filter( — false negative (E3)',
    };
  }

  // C2 good fixture A2 (E3 NEW — rustfmt multi-line format): evolve body where rustfmt
  // has split the chain across lines. The whitespace-collapse must make this identical
  // to the single-line form. countBothRoleChains must return ≥ 1.
  // Proves: a correctly formatted multi-line chain is never falsely rejected.
  const c2GoodFixtureMultiLine = `
    pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
        let m = get_monster(ctx, monster_id)?;
        reject_if_in_battle(
            ctx.db
                .battle()
                .player_identity()
                .filter(m.owner_identity)
                .chain(
                    ctx.db
                        .battle()
                        .opponent_identity()
                        .filter(m.owner_identity),
                ),
            monster_id,
        )?;
        do_evolve(ctx, m)
    }
  `;
  const c2GoodBodyMultiLine = extractReducerBody(c2GoodFixtureMultiLine, 'evolve');
  if (!c2GoodBodyMultiLine) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 good fixture A2 — E3 multi-line): could not extract evolve body — ' +
        'parser bug',
    };
  }
  if (countBothRoleChains(c2GoodBodyMultiLine) < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 good fixture A2 — E3 multi-line rustfmt): countBothRoleChains ' +
        'returned < 1 for a rustfmt-style multi-line chain body — whitespace-collapse must make ' +
        'this equivalent to the single-line form; false negative on correctly formatted code (E3)',
    };
  }

  // C2 good fixture B (E3 NEW — fuse body with both chains): two structurally chained
  // reject_if_in_battle calls (one per parent). countBothRoleChains must return ≥ 2.
  const c2GoodFixtureFuse = `
    pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
        let a = get_monster(ctx, a_id)?;
        let b = get_monster(ctx, b_id)?;
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(a.owner_identity)
                .chain(ctx.db.battle().opponent_identity().filter(a.owner_identity)),
            a_id,
        )?;
        reject_if_in_battle(
            ctx.db.battle().player_identity().filter(b.owner_identity)
                .chain(ctx.db.battle().opponent_identity().filter(b.owner_identity)),
            b_id,
        )?;
        do_fuse(ctx, a, b)
    }
  `;
  const c2GoodBodyFuse = extractReducerBody(c2GoodFixtureFuse, 'fuse');
  if (!c2GoodBodyFuse) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 good fixture B — E3 fuse): could not extract fuse body — parser bug',
    };
  }
  if (countBothRoleChains(c2GoodBodyFuse) < 2) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C2 good fixture B — E3 fuse): countBothRoleChains returned < 2 ' +
        'for a fuse body with two .chain(ctx.db.battle().opponent_identity().filter( calls — ' +
        'false negative; fuse requires ≥ 2 structural chains (E3)',
    };
  }

  // =========================================================================
  // C3 fixture teeth — SSOT single-definition + wrapper-body integrity
  // =========================================================================

  // C3 bad fixture A: two concatenated sources each defining is_in_ongoing_battle.
  const c3BadTwoDefsSrc =
    'pub(crate) fn is_in_ongoing_battle(ctx: &ReducerContext, identity: Identity) -> bool { true }\n' +
    'pub(crate) fn is_in_ongoing_battle(ctx: &ReducerContext, identity: Identity) -> bool { false }\n';
  if (countFnDefinitions(c3BadTwoDefsSrc, 'is_in_ongoing_battle') < 2) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C3 bad fixture A): countFnDefinitions did not count 2 definitions ' +
        'from a source with two fn is_in_ongoing_battle definitions — counter broken',
    };
  }

  // C3 bad fixture B (E1): wrapper body using player_identity() twice (no opponent_identity()).
  // Old checker accepted this; new checker requires the call-site args region to contain both.
  // Kills: a doubled-player-arm wrapper that passes player_identity() as both args.
  const c3BadWrapperBody = `
    is_in_ongoing_battle_either_role(
        ctx.db.battle().player_identity().filter(identity),
        ctx.db.battle().player_identity().filter(identity),
    )
  `;
  if (wrapperBodyHasBothIndexes(c3BadWrapperBody)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C3 bad fixture B — red-team F7 / E1): wrapperBodyHasBothIndexes ' +
        'returned true for a wrapper body that passes player_identity() twice with no ' +
        'opponent_identity() reference — checker does not bite the doubled-player-arm evasion',
    };
  }

  // C3 bad fixture B2 (E1 NEW): wrapper body that has a stray opponent_identity() in a
  // dead let-binding (NOT in the is_in_ongoing_battle_either_role args), then passes the
  // player iterator twice as both args.  The old bare-presence check accepted this because
  // opponent_identity() was present anywhere in the body; the new args-region check rejects
  // it because opponent_identity() does not appear in the args region after the call.
  // Kills: a wrapper that logs/stashes the opponent iterator but passes player twice.
  const c3BadWrapperBodyDeadLet = `
    let _ = ctx.db.battle().opponent_identity().filter(identity);
    is_in_ongoing_battle_either_role(
        ctx.db.battle().player_identity().filter(identity),
        ctx.db.battle().player_identity().filter(identity),
    )
  `;
  if (wrapperBodyHasBothIndexes(c3BadWrapperBodyDeadLet)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C3 bad fixture B2 — E1 dead-let evasion): ' +
        'wrapperBodyHasBothIndexes returned true for a wrapper body that has a stray ' +
        '`let _ = ctx.db.battle().opponent_identity().filter(identity)` before the call, ' +
        'then passes player_identity() as BOTH args to is_in_ongoing_battle_either_role — ' +
        'the args-region check must restrict to the token that appears AFTER the call, ' +
        'not anywhere in the body',
    };
  }

  // C3 bad fixture B3 (E1 NEW): wrapper body calling the core with swapped args
  // (opponent iterator first, player iterator second).  Arg-order is semantically
  // significant: as_player must be first, as_opponent second (ADR-0122 §1.1).
  // Kills: a wrapper with reversed arg order (opponent first, player second).
  const c3BadWrapperBodySwapped = `
    is_in_ongoing_battle_either_role(
        ctx.db.battle().opponent_identity().filter(identity),
        ctx.db.battle().player_identity().filter(identity),
    )
  `;
  if (wrapperBodyHasBothIndexes(c3BadWrapperBodySwapped)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C3 bad fixture B3 — E1 swapped-args evasion): ' +
        'wrapperBodyHasBothIndexes returned true for a wrapper body that passes the ' +
        'opponent iterator FIRST and the player iterator SECOND — ' +
        'the order check must require player_identity() < opponent_identity() in the args region ' +
        '(as_player first, as_opponent second — ADR-0122 §1.1)',
    };
  }

  // C3 good fixture: wrapper body with player_identity() first, opponent_identity() second.
  const c3GoodWrapperBody = `
    is_in_ongoing_battle_either_role(
        ctx.db.battle().player_identity().filter(identity),
        ctx.db.battle().opponent_identity().filter(identity),
    )
  `;
  if (!wrapperBodyHasBothIndexes(c3GoodWrapperBody)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C3 good fixture): wrapperBodyHasBothIndexes returned false for ' +
        'a correct wrapper body referencing player_identity() first and opponent_identity() second — ' +
        'false negative',
    };
  }

  // =========================================================================
  // C4 fixture teeth — insert-site provenance allowlist
  // =========================================================================

  // C4 bad fixture A (red-team F5 alias bypass): insert in novel function
  // `start_npc_trainer_battle` with `opponent_identity: opponent` (aliased name).
  // resolveInsertEnclosingFn must return a fn name NOT in the allowlist.
  const c4AliasBypassSrc = `
    pub(crate) fn start_npc_trainer_battle(
        ctx: &ReducerContext,
        trainer_id: u32,
        opponent: Identity,
    ) -> Result<(), String> {
        let battle = ctx.db.battle().insert(Battle {
            battle_id: 0,
            player_identity: ctx.sender,
            opponent_identity: opponent,
            state: make_state(),
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        });
        Ok(())
    }
  `;
  const aliasSites = findBattleInsertSites(c4AliasBypassSrc);
  if (aliasSites.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C4 alias bypass fixture): findBattleInsertSites found 0 sites ' +
        'in a source with one ctx.db.battle().insert call — site detector broken',
    };
  }
  // The enclosing fn must NOT be an allowlisted fn — the alias bypass should fail the allowlist.
  const aliasFn = aliasSites[0].enclosingFn;
  if (
    aliasFn === 'start_battle' ||
    aliasFn === 'begin_encounter' ||
    aliasFn === 'start_pvp_battle'
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C4 alias bypass fixture): enclosing fn was resolved as an ' +
        `allowlisted name (${aliasFn}) for a source with fn start_npc_trainer_battle — ` +
        'enclosing-fn resolver is matching the wrong function name',
    };
  }

  // C4 bad fixture B: is_ranked_pvp weakened to a single clause (only != WILD_IDENTITY).
  const c4BadRankedSrc = `
    pub(crate) fn is_ranked_pvp(battle: &Battle) -> bool {
        battle.opponent_identity != WILD_IDENTITY
    }
  `;
  if (isRankedPvpIsTwoClause(c4BadRankedSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C4 bad ranked fixture B): isRankedPvpIsTwoClause returned true ' +
        'for a single-clause is_ranked_pvp body (only != WILD_IDENTITY, missing player != opponent) — ' +
        'two-clause checker does not bite a weakened body',
    };
  }

  // C4 bad fixture C: start_battle body whose provenance gate was deleted but keeps
  // shorthand insert — hasOpponentProvenanceGate must fail on this body.
  const c4BadNoGateBody = `
    pub fn start_battle(ctx: &ReducerContext, opponent_identity: Identity) -> Result<(), String> {
        let me = ctx.sender;
        // provenance gate deleted — no check here
        let battle = ctx.db.battle().insert(Battle {
            opponent_identity,
            ..defaults()
        });
        Ok(())
    }
  `;
  const c4BadNoGateExtracted = extractReducerBody(c4BadNoGateBody, 'start_battle');
  if (!c4BadNoGateExtracted) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C4 bad fixture C): could not extract start_battle body from ' +
        'no-gate fixture — parser bug',
    };
  }
  if (hasOpponentProvenanceGate(c4BadNoGateExtracted)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C4 bad fixture C): hasOpponentProvenanceGate returned true for ' +
        'a start_battle body with the provenance gate deleted — false positive; ' +
        'C4 requires the gate to still exist when the shorthand insert is present',
    };
  }

  // C4 good fixture: is_ranked_pvp with the correct two-clause sentinel form.
  const c4GoodRankedSrc = `
    pub(crate) fn is_ranked_pvp(battle: &Battle) -> bool {
        battle.player_identity != battle.opponent_identity
            && battle.opponent_identity != WILD_IDENTITY
    }
  `;
  if (!isRankedPvpIsTwoClause(c4GoodRankedSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (m17.5a C4 good ranked fixture): isRankedPvpIsTwoClause returned false ' +
        'for the correct two-clause sentinel body — false negative',
    };
  }

  // =========================================================================
  // Real-source scan — C1, C2, C3, C4
  // =========================================================================
  const sideBFailures = [];

  // -------------------------------------------------------------------------
  // C1: 4 PvE reducer bodies must contain `if is_in_ongoing_battle(ctx, <identTok>)`
  // (conditional form, correct per-reducer identity token — E2 strengthening).
  // RED now: all four still use player_identity().filter inline.
  // Per-reducer identTok values (ADR-0122 §1.2):
  //   start_battle / heal_party / start_wild_battle → 'me'
  //   begin_encounter → 'player_identity'
  // -------------------------------------------------------------------------
  const BOTH_ROLE_GUARD_REDUCERS = [
    { name: 'start_battle', identTok: 'me' },
    { name: 'begin_encounter', identTok: 'player_identity' },
    { name: 'heal_party', identTok: 'me' },
    { name: 'start_wild_battle', identTok: 'me' },
  ];
  for (const { name: reducerName, identTok } of BOTH_ROLE_GUARD_REDUCERS) {
    const body = extractReducerBody(src, reducerName);
    if (!body) {
      sideBFailures.push(`C1/${reducerName}: reducer body not found in server-module source`);
      continue;
    }
    if (!hasBothRoleBattleGuard(body, identTok)) {
      sideBFailures.push(
        `C1/${reducerName}: missing conditional if is_in_ongoing_battle(ctx, ${identTok}) — ` +
          `body still uses player_identity().filter inline or lacks the if-form (ADR-0122 17.5a-1); ` +
          `RED until implementer replaces inline with the shared wrapper in conditional form`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // C2: evolve/fuse bodies must contain the structural .chain(ctx.db.battle()
  // .opponent_identity().filter( token (E3 strengthening — whitespace-collapsed
  // combined-token check, not a bare presence check).
  // Per-reducer chain count requirements (ADR-0122 §1.3):
  //   evolve → ≥ 1 chain occurrence (one reject_if_in_battle call)
  //   fuse   → ≥ 2 chain occurrences (two calls: parent a and parent b)
  // RED now: both use player_identity().filter only (countBothRoleChains returns 0).
  // -------------------------------------------------------------------------
  const CHAIN_GUARD_REDUCERS = [
    { name: 'evolve', minChains: 1 },
    { name: 'fuse', minChains: 2 },
  ];
  for (const { name: reducerName, minChains } of CHAIN_GUARD_REDUCERS) {
    const body = extractReducerBody(src, reducerName);
    if (!body) {
      sideBFailures.push(`C2/${reducerName}: reducer body not found in server-module source`);
      continue;
    }
    const chainCount = countBothRoleChains(body);
    if (chainCount < minChains) {
      sideBFailures.push(
        `C2/${reducerName}: structural chain count ${chainCount} < required ${minChains} — ` +
          `body must contain .chain(ctx.db.battle().opponent_identity().filter( ` +
          `${minChains === 1 ? 'once' : 'twice (once per reject_if_in_battle call)'} ` +
          `(ADR-0122 17.5a-2 E3); RED until implementer adds both-role chain`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // C3: exactly one fn is_in_ongoing_battle( across all sources; it is NOT in pvp.rs;
  // wrapper body references both player_identity() and opponent_identity().
  // RED now: pvp.rs still defines its own local copy.
  // -------------------------------------------------------------------------
  const totalDefs = countFnDefinitions(src, 'is_in_ongoing_battle');
  if (totalDefs !== 1) {
    sideBFailures.push(
      `C3/SSOT: found ${totalDefs} definitions of fn is_in_ongoing_battle( across server-module ` +
        `(expected exactly 1 in guards.rs); ` +
        (totalDefs === 0
          ? 'guards.rs does not yet define it — RED until implementer adds the fn'
          : 'pvp.rs still defines its own copy — delete it and import guards::is_in_ongoing_battle'),
    );
  }

  // C3 wrapper-body integrity: the guards.rs fn body must reference both indexes.
  // Extract guards.rs source only (not the whole crate) to isolate the wrapper.
  let guardsRsSrc = null;
  try {
    guardsRsSrc = readFileSync(`${SERVER_SRC}/guards.rs`, 'utf8');
  } catch (_) {
    sideBFailures.push('C3/wrapper-body: cannot read guards.rs — file missing or renamed');
  }
  if (guardsRsSrc !== null) {
    const wrapperBody = extractReducerBody(guardsRsSrc, 'is_in_ongoing_battle');
    if (!wrapperBody) {
      sideBFailures.push(
        'C3/wrapper-body: fn is_in_ongoing_battle( not found in guards.rs — ' +
          'RED until implementer adds the thin ctx wrapper',
      );
    } else {
      if (!wrapperBodyHasBothIndexes(wrapperBody)) {
        sideBFailures.push(
          'C3/wrapper-body: guards.rs fn is_in_ongoing_battle body does not reference BOTH ' +
            'player_identity() and opponent_identity() — ' +
            'a wrapper passing player_identity() twice cannot enforce both-role semantics ' +
            '(red-team F7; kills: doubled-player-arm evasion)',
        );
      }
    }
    // pvp.rs must NOT define a local fn is_in_ongoing_battle.
    let pvpRsSrc = null;
    try {
      pvpRsSrc = readFileSync(`${SERVER_SRC}/pvp.rs`, 'utf8');
    } catch (_) {
      sideBFailures.push('C3/pvp-no-local: cannot read pvp.rs — file missing or renamed');
    }
    if (pvpRsSrc !== null && countFnDefinitions(pvpRsSrc, 'is_in_ongoing_battle') > 0) {
      sideBFailures.push(
        'C3/pvp-no-local: pvp.rs still defines fn is_in_ongoing_battle — ' +
          'delete the private copy and import guards::is_in_ongoing_battle (ADR-0122 §1.1 anti-pattern)',
      );
    }
  }

  // -------------------------------------------------------------------------
  // C4: exactly 3 battle insert sites; each allowlisted; is_ranked_pvp two-clause.
  // Vacuous-pass guard: fail loud if 0 sites found (missing/renamed file).
  // Per-file scan so site.file is accurate for the allowlist (file, enclosing-fn) check.
  // RED now: will pass once the implementer confirms the 3 allowlisted sites
  // are byte-stable (likely no code change, but the eval verifies them).
  // -------------------------------------------------------------------------
  // Scan the two files that contain battle inserts (battle.rs + pvp.rs).
  const insertSites = [
    ...findBattleInsertSitesInFile(`${SERVER_SRC}/battle.rs`),
    ...findBattleInsertSitesInFile(`${SERVER_SRC}/pvp.rs`),
  ];
  if (insertSites.length === 0) {
    sideBFailures.push(
      'C4/insert-sites: no ctx.db.battle().insert(Battle { sites found — ' +
        'scanned files missing or battle insert was removed/renamed; ' +
        'vacuous-pass guard: exactly 3 sites required (ADR-0122 §1.5)',
    );
  } else if (insertSites.length !== 3) {
    sideBFailures.push(
      `C4/insert-sites: expected exactly 3 battle insert sites, found ${insertSites.length}; ` +
        'any new site requires updating this eval + is_ranked_pvp (ADR-0122 D5); ' +
        'sites found: ' +
        insertSites.map((s) => `${s.file}::${s.enclosingFn}`).join(', '),
    );
  } else {
    // Verify allowlisted triples: (file, enclosing-fn, form-check).
    // Triple 1: battle.rs / start_battle / shorthand `opponent_identity,` + provenance gate present.
    // Triple 2: battle.rs / begin_encounter / literal `WILD_IDENTITY`.
    // Triple 3: pvp.rs / start_pvp_battle / RHS is `opponent` (third-identity var, not WILD/me).
    const ALLOWLIST = [
      { file: 'battle.rs', fn: 'start_battle' },
      { file: 'battle.rs', fn: 'begin_encounter' },
      { file: 'pvp.rs', fn: 'start_pvp_battle' },
    ];
    for (const site of insertSites) {
      const allowed = ALLOWLIST.find(
        (a) => site.file.endsWith(a.file) && site.enclosingFn === a.fn,
      );
      if (!allowed) {
        sideBFailures.push(
          `C4/allowlist: insert site in ${site.file}::${site.enclosingFn} is NOT allowlisted — ` +
            'any new battle-creation path must be consciously reviewed and added to this allowlist ' +
            '(ADR-0122 §1.5); this kills the alias bypass (red-team F5)',
        );
      }
    }

    // Additional form checks on the allowlisted sites.
    // start_battle: enclosing body must contain the provenance gate (battle.rs:82 form).
    const startBattleSite = insertSites.find(
      (s) => s.file.endsWith('battle.rs') && s.enclosingFn === 'start_battle',
    );
    if (startBattleSite && !hasOpponentProvenanceGate(startBattleSite.enclosingBody)) {
      sideBFailures.push(
        'C4/start_battle-gate: start_battle has shorthand opponent_identity insert but ' +
          'the provenance gate (battle.rs:82 — opponent_identity != me && != WILD_IDENTITY check) ' +
          'is missing from its body — shorthand is only safe WITH the gate',
      );
    }

    // begin_encounter: insert must use literal WILD_IDENTITY.
    const beginEncSite = insertSites.find(
      (s) => s.file.endsWith('battle.rs') && s.enclosingFn === 'begin_encounter',
    );
    if (beginEncSite) {
      const insertRegion = beginEncSite.insertText;
      if (insertRegion.indexOf('WILD_IDENTITY') === -1) {
        sideBFailures.push(
          'C4/begin_encounter: begin_encounter insert site does not contain WILD_IDENTITY — ' +
            'expected `opponent_identity: WILD_IDENTITY` in the insert struct (ADR-0122 §1.5)',
        );
      }
    }

    // start_pvp_battle: opponent_identity RHS must be `opponent` (third-identity var),
    // not WILD_IDENTITY and not me/ctx.sender.
    // Real code (pvp.rs:242): `opponent_identity: opponent,`
    const pvpSite = insertSites.find(
      (s) => s.file.endsWith('pvp.rs') && s.enclosingFn === 'start_pvp_battle',
    );
    if (pvpSite) {
      const insertText = pvpSite.insertText;
      // The opponent_identity field must NOT be WILD_IDENTITY or me.
      if (
        insertText.indexOf('opponent_identity: WILD' + '_IDENTITY') !== -1 ||
        insertText.indexOf('opponent_identity: me') !== -1 ||
        insertText.indexOf('opponent_identity: ctx.sender') !== -1
      ) {
        sideBFailures.push(
          'C4/start_pvp_battle: opponent_identity in start_pvp_battle insert is WILD_IDENTITY ' +
            'or me/ctx.sender — expected a real third-identity variable (e.g. `opponent`) ' +
            '(ADR-0122 §1.5)',
        );
      }
    }
  }

  // C4 is_ranked_pvp two-clause check.
  if (!isRankedPvpIsTwoClause(src)) {
    sideBFailures.push(
      'C4/is_ranked_pvp: body is not the two-clause sentinel form ' +
        '(player_identity != opponent_identity && opponent_identity != WILD_IDENTITY); ' +
        'a single-clause body lets future battle sources silently rate as ranked (ADR-0122 §1.5)',
    );
  }

  if (sideBFailures.length > 0) {
    return {
      name,
      pass: false,
      detail: sideBFailures.join('; '),
    };
  }

  return {
    name,
    pass: true,
    detail:
      `all ${ALL_REDUCERS.length} battle reducers found with ownership checks; ` +
      `outcome guards present in ${OUTCOME_CHECKED_REDUCERS.join(', ')}; ` +
      `start_battle has opponent-provenance gate; write_back helpers side_a-only; ` +
      `m17a: all ${PVP_REJECT_REDUCERS.length} PvE reducers have if is_ranked_pvp(&battle) guard ` +
      `after Ongoing check (RL-8/9, ADR-0119 D5; teeth: 4 fixtures A/B/C/D — F1 hardened); ` +
      `m17.5a (ADR-0122): C1 if-form+identTok guard in 4 PvE reducers; C2 structural chain ` +
      `count (>=1 evolve, >=2 fuse); C3 SSOT single-def + arg-order wrapper; C4 exactly 3 ` +
      `insert sites allowlisted + is_ranked_pvp two-clause ` +
      `(EARS 17.5a-1/2/5; teeth: C1x5/C2x5/C3x5/C4x3 fixtures; E1/E2/E3/E4 hardened)`,
  };
}

// ===========================================================================
// m17a (ADR-0119, RL-8/9/17): PvP-reject guard checkers (module-level exports)
//
// These are exported for reuse by future m17c evals. They are NOT a second
// default export — the single default export above integrates their logic.
//
// F1 hardening (guard-fakery): needles require the CONDITIONAL form
// `if is_ranked_pvp(&battle)` — not just identifier presence. This kills:
//   - `let _ = is_ranked_pvp(&battle);`  (dead-code call, no branch)
//   - the identifier inside a string literal (stripped by stripRustStrings)
// Residual documented evasion: `if is_ranked_pvp(&battle) {}` (no-op body)
// still passes — caught by mutation testing, not a static needle scan.
// ===========================================================================

// ---------------------------------------------------------------------------
// Strip Rust double-quoted string literals from `src` (F1 hardening).
// Replaces each "..." with spaces so log-message text embedding the guard
// pattern does not produce false positives. Handles \" escapes inside strings.
// Raw strings (r"...", r#"..."#) are NOT handled — no production reducers use
// raw strings for the patterns we scan.
// ---------------------------------------------------------------------------
export function stripRustStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      out += ' ';
      i++;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) {
          // Escaped character — skip both bytes.
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
// Checker: does the reducer body contain the PvP-reject guard in conditional form?
//
// F1 hardened: needle is 'if is_ranked' + '_pvp(&battle)' (conditional form).
// String literals are stripped before matching to prevent false positives.
// Uses indexOf only — no dynamic RegExp (semgrep detect-non-literal-regexp).
// ---------------------------------------------------------------------------
export function hasPvpRejectGuard(body) {
  const code = stripRustStrings(stripRustComments(body));
  // needle: 'if is_ranked' + '_pvp(&battle)' = 'if is_ranked_pvp(&battle)'
  // F1: requires the `if` prefix — dead-code `let _ = is_ranked_pvp(&battle)` returns false.
  return code.indexOf('if is_ranked' + '_pvp(&battle)') !== -1;
}

// ---------------------------------------------------------------------------
// Checker: does the PvP guard appear AFTER the Ongoing check in the body?
// Returns true iff both are present and pvpGuard offset > ongoingCheck offset.
// F1 hardened: uses the same `if`-prefixed needle as hasPvpRejectGuard.
// ---------------------------------------------------------------------------
export function pvpGuardAfterOngoingCheck(body) {
  const code = stripRustStrings(stripRustComments(body));
  const ongoingIdx = code.indexOf('BattleOutcome::' + 'Ongoing');
  // F1: same conditional-form needle.
  const pvpIdx = code.indexOf('if is_ranked' + '_pvp(&battle)');
  if (ongoingIdx === -1 || pvpIdx === -1) return false;
  return pvpIdx > ongoingIdx;
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

// ===========================================================================
// m17.5a (ADR-0122): new helper functions for C1–C4 criteria.
//
// All helpers use indexOf only — no dynamic `new RegExp(...)`.
// (Semgrep detect-non-literal-regexp has bitten 3×; see eval header.)
// ===========================================================================

// ---------------------------------------------------------------------------
// C1: hasBothRoleBattleGuard(body, identTok) — does the body contain the
// conditional form `if is_in_ongoing_battle(ctx, <identTok>)`?
//
// E2 (BLOCKER): strengthened from bare call-presence to conditional-form check
// with per-reducer identity token.  The needle is:
//   `ifis_in_ongoing_battle(ctx,<identTok>)` (whitespace-collapsed)
// searched in a whitespace-collapsed stripped body so rustfmt multi-line
// formatting can never produce a false RED on a correctly implemented reducer.
//
// Per-reducer identTok values (ADR-0122 §1.2):
//   start_battle      → 'me'
//   heal_party        → 'me'
//   start_wild_battle → 'me'
//   begin_encounter   → 'player_identity'
//
// Whitespace robustness: rustfmt may split long expressions across lines, e.g.:
//   if is_in_ongoing_battle(
//       ctx,
//       me,
//   )
// Both the stripped body and the needle are whitespace-collapsed before matching
// (all whitespace runs → single space, then all spaces removed from the needle
// and body for the comparison) so line splits never cause a false mismatch.
//
// Bad fixtures:
//   (a) `let _ = is_in_ongoing_battle(ctx, me);` — dead-code call, non-if form → false.
//   (b) `if is_in_ongoing_battle(ctx, opponent_identity)` when identTok='me' → false.
// Good fixtures:
//   (a) `if is_in_ongoing_battle(ctx, me)` when identTok='me' → true.
//   (b) pub(crate) fn begin_encounter shape with identTok='player_identity' → true.
// ---------------------------------------------------------------------------
export function hasBothRoleBattleGuard(body, identTok) {
  const stripped = stripRustStrings(stripRustComments(body));
  // Collapse ALL whitespace (spaces, tabs, newlines) to nothing — rustfmt-safe comparison.
  const collapsed = stripped.replace(/\s+/g, '');
  // Needle: 'ifis_in_ongoing_battle(ctx,<identTok>)' — no spaces, all whitespace removed.
  // Split the static prefix to avoid matching it in comments that were already stripped.
  const needle = 'ifis_in_ongoing' + '_battle(ctx,' + identTok + ')';
  return collapsed.indexOf(needle) !== -1;
}

// ---------------------------------------------------------------------------
// C2: countBothRoleChains(body) — count structurally-chained opponent_identity
// occurrences in the body.
//
// E3 (BLOCKER): replaced the bare `.opponent_identity().filter(` presence check
// with a whitespace-collapsed combined-token count that requires the opponent
// iterator to be STRUCTURALLY CHAINED (not a bystander use or logging bypass):
//
//   needle (whitespace-collapsed): `.chain(ctx.db.battle().opponent_identity().filter(`
//
// This proves the opponent iterator is fed into reject_if_in_battle via .chain(),
// not merely present in a dead let-binding alongside the real call.
//
// Return value: the number of times the chain token appears (after strip + collapse).
//   evolve: requires ≥ 1 occurrence (one reject_if_in_battle call, one chain).
//   fuse:   requires ≥ 2 occurrences (two calls, one for parent a, one for parent b).
//
// Whitespace robustness: rustfmt may split long chains across lines, e.g.:
//   .chain(
//       ctx.db.battle().opponent_identity().filter(m.owner_identity),
//   )
// Both the body and the needle are whitespace-collapsed before matching so
// a correctly formatted multi-line chain is never falsely rejected.
//
// Bad fixtures:
//   (a) player-only reject_if_in_battle + stray `let _ = ctx.db.battle()
//       .opponent_identity().filter(owner).count();` (logging bypass) → 0.
//   (b) fuse body where only ONE of two reject calls has the chain → count=1
//       (fails the ≥2 requirement for fuse).
// Good fixtures:
//   (a) evolve body with one chained call (also with multi-line rustfmt style) → ≥1.
//   (b) fuse body with two chained calls → ≥2.
// ---------------------------------------------------------------------------
export function countBothRoleChains(body) {
  const stripped = stripRustStrings(stripRustComments(body));
  // Collapse ALL whitespace to nothing — rustfmt multi-line safe.
  const collapsed = stripped.replace(/\s+/g, '');
  // Combined-token needle: .chain( + ctx.db.battle().opponent_identity().filter(
  // Split to avoid any static analysis that might match the needle inside this file.
  const needle = '.chain(ctx.db.battle().opponent' + '_identity().filter(';
  let count = 0;
  let idx = 0;
  while (true) {
    idx = collapsed.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// C2: hasBothRoleChain(body) — convenience wrapper for evolve (requires ≥ 1 chain).
// Kept for callers that don't need the count; the real-source scan uses
// countBothRoleChains directly with per-reducer thresholds.
// ---------------------------------------------------------------------------
export function hasBothRoleChain(body) {
  return countBothRoleChains(body) >= 1;
}

// ---------------------------------------------------------------------------
// C3: countFnDefinitions(src, fnName) — count `fn <fnName>(` definitions.
//
// Returns the number of times `fn <fnName>(` appears in src (after comment
// stripping).  Used to assert exactly-1 definition of is_in_ongoing_battle.
//
// Bad fixture: two definitions → 2 (triggers the SSOT failure).
// Good fixture: one definition → 1.
// ---------------------------------------------------------------------------
export function countFnDefinitions(src, fnName) {
  // E4 (reviewer W-6): apply stripRustStrings in addition to stripRustComments so
  // a fn-name that appears inside a string literal (e.g. a log message like
  // "calling fn is_in_ongoing_battle(ctx,...") does not produce a false count.
  const code = stripRustStrings(stripRustComments(src));
  const needle = 'fn ' + fnName + '(';
  let count = 0;
  let idx = 0;
  while (true) {
    idx = code.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// C3: wrapperBodyHasBothIndexes(body) — does the wrapper body call
// is_in_ongoing_battle_either_role( with player_identity() BEFORE opponent_identity()?
//
// E1 (BLOCKER): strengthened from a bare presence check to a structural check:
//   1. Strip comments + strings.
//   2. Find `is_in_ongoing_battle_either_role(` in the wrapper body — if absent → false.
//   3. Slice the code from that call position onward (the args region).
//   4. Require BOTH `player_identity()` and `opponent_identity()` appear in the args region.
//   5. Require `player_identity()` appears BEFORE `opponent_identity()` — pins the
//      correct arg mapping: as_player first, as_opponent second (ADR-0122 §1.1).
//
// The old bare-presence check accepted:
//   (a) a wrapper that stashes `ctx.db.battle().opponent_identity().filter(identity)`
//       in a dead let-binding, then passes player_identity() as both args — the call
//       uses the opponent index but discards the result. Now rejected (args region check).
//   (b) a wrapper passing opponent iterator first, player iterator second (swapped args) —
//       would silently invert the as_player/as_opponent roles. Now rejected (order check).
//
// Bad fixtures: (a) player iterator twice + stray opponent let-binding → false.
//              (b) swapped args (opponent first, player second) → false.
// Good fixture: correct body (player first, opponent second) → true.
// ---------------------------------------------------------------------------
export function wrapperBodyHasBothIndexes(body) {
  const code = stripRustStrings(stripRustComments(body));
  // Step 1: find the call to the pure core.
  const callNeedle = 'is_in_ongoing_battle_either_role(';
  const callIdx = code.indexOf(callNeedle);
  if (callIdx === -1) return false;
  // Step 2: slice the args region (from the opening paren of the call onward).
  const argsRegion = code.slice(callIdx + callNeedle.length);
  // Step 3: find both index tokens in the args region.
  const playerIdx = argsRegion.indexOf('player_identity()');
  const opponentIdx = argsRegion.indexOf('opponent_identity()');
  if (playerIdx === -1 || opponentIdx === -1) return false;
  // Step 4: player_identity() must appear BEFORE opponent_identity() (arg-order pin).
  return playerIdx < opponentIdx;
}

// ---------------------------------------------------------------------------
// C4: findBattleInsertSites(src) — enumerate all ctx.db.battle().insert(Battle {
// sites with their enclosing function name and insert struct text.
//
// Returns an array of { file, enclosingFn, enclosingBody, insertText } objects.
// `file` is set to 'unknown' when called on concatenated sources (the caller
// must pass per-file sources or use the file field from the scan context).
//
// Algorithm:
//   1. Strip comments so the needle cannot match inside doc-comments.
//   2. Search for `ctx.db.battle().insert(Battle {` using indexOf.
//   3. For each hit, walk BACKWARDS from the hit to find the nearest
//      `fn <name>(` preceding it — that is the enclosing function.
//   4. Extract the enclosing function's full body (brace-depth counting).
//   5. Extract the Battle { ... } struct literal (brace-depth from the insert).
//
// Enclosing-fn resolution is left-scan to the nearest `fn ` token — sufficient
// because Rust does not allow nested named functions in reducers.
//
// Proof-of-teeth: the C4 alias bypass fixture (start_npc_trainer_battle) must
// resolve as a NON-allowlisted enclosing fn — if it resolves as an allowlisted
// name the C4 bad-fixture TEETH check fails immediately.
// ---------------------------------------------------------------------------
export function findBattleInsertSites(src) {
  const code = stripRustComments(src);
  const INSERT_NEEDLE = 'ctx.db.battle().insert(Battle {';
  const sites = [];
  let searchFrom = 0;

  while (true) {
    const insertIdx = code.indexOf(INSERT_NEEDLE, searchFrom);
    if (insertIdx === -1) break;

    // Walk backwards from insertIdx to find the nearest `fn <name>(`.
    // Scan for `fn ` in the text before insertIdx.
    let enclosingFn = 'unknown';
    let enclosingFnStart = -1;
    // Search backwards: find the last `fn ` before insertIdx.
    let scanBack = insertIdx;
    while (scanBack > 0) {
      // Find `fn ` ending before scanBack.
      const candidate = code.lastIndexOf('fn ', scanBack - 1);
      if (candidate === -1) break;
      // Extract the function name: text between `fn ` and the next `(`.
      const afterFn = candidate + 3; // skip 'fn '
      let nameEnd = afterFn;
      while (nameEnd < code.length && code[nameEnd] !== '(' && code[nameEnd] !== '\n') {
        nameEnd++;
      }
      if (code[nameEnd] === '(') {
        const candidateName = code.slice(afterFn, nameEnd).trim();
        // Reject if the name contains spaces (e.g. `fn ` inside a string or comment remnant)
        // or if it is empty.
        if (candidateName.length > 0 && !/\s/.test(candidateName)) {
          enclosingFn = candidateName;
          enclosingFnStart = candidate;
          break;
        }
      }
      scanBack = candidate;
    }

    // Extract the enclosing function body (from its opening brace to matching close).
    let enclosingBody = '';
    if (enclosingFnStart !== -1) {
      let bi = enclosingFnStart;
      while (bi < code.length && code[bi] !== '{') bi++;
      if (bi < code.length) {
        let depth = 1;
        const bodyStart = bi + 1;
        bi++;
        while (bi < code.length && depth > 0) {
          if (code[bi] === '{') depth++;
          else if (code[bi] === '}') depth--;
          bi++;
        }
        enclosingBody = code.slice(bodyStart, bi - 1);
      }
    }

    // Extract the Battle { ... } struct literal from the insert call.
    // Start after `ctx.db.battle().insert(`.
    let structStart = insertIdx + 'ctx.db.battle().insert('.length;
    // structStart now points at `Battle {`. Walk to find the matching `}`.
    while (structStart < code.length && code[structStart] !== '{') structStart++;
    let structEnd = structStart;
    let depth2 = 0;
    while (structEnd < code.length) {
      if (code[structEnd] === '{') depth2++;
      else if (code[structEnd] === '}') {
        depth2--;
        if (depth2 === 0) {
          structEnd++;
          break;
        }
      }
      structEnd++;
    }
    const insertText = code.slice(structStart, structEnd);

    sites.push({
      file: 'unknown', // caller resolves per-file context
      enclosingFn,
      enclosingBody,
      insertText,
    });

    searchFrom = insertIdx + INSERT_NEEDLE.length;
  }

  return sites;
}

// ---------------------------------------------------------------------------
// C4: findBattleInsertSitesInFile(filePath) — per-file wrapper for findBattleInsertSites.
// Reads the file and tags each site with the real filename.
// ---------------------------------------------------------------------------
export function findBattleInsertSitesInFile(filePath) {
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch (_) {
    return [];
  }
  return findBattleInsertSites(src).map((s) => ({ ...s, file: filePath }));
}

// ---------------------------------------------------------------------------
// C4: isRankedPvpIsTwoClause(src) — is is_ranked_pvp the two-clause sentinel form?
//
// Returns true iff the is_ranked_pvp function body (after comment + string
// stripping) contains BOTH:
//   - a comparison involving `player_identity` != `opponent_identity`  (clause 1)
//   - a comparison involving `opponent_identity` != WILD_IDENTITY       (clause 2)
//
// Bad fixture: body with only `opponent_identity != WILD_IDENTITY` → false.
// Good fixture: body with both clauses → true.
//
// Uses indexOf only (no dynamic RegExp).
// ---------------------------------------------------------------------------
export function isRankedPvpIsTwoClause(src) {
  const body = extractReducerBody(src, 'is_ranked_pvp');
  if (!body) return false;
  const code = stripRustStrings(stripRustComments(body));
  // Clause 1: player_identity and opponent_identity compared (either order).
  const hasPlayerOpponentClause =
    code.indexOf('player_identity') !== -1 && code.indexOf('opponent_identity') !== -1;
  // Clause 2: opponent_identity compared against WILD_IDENTITY.
  const hasWildClause = code.indexOf('WILD_IDENTITY') !== -1;
  return hasPlayerOpponentClause && hasWildClause;
}
