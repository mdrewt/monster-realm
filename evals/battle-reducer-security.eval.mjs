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
  // Real-source scan: four PvE reducers must carry the PvP-reject guard.
  // RED now: is_ranked_pvp(&battle) absent from all four bodies.
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
        `${reducerName}: missing PvP-reject guard (is_ranked_pvp(&battle)) — ` +
          `RL-8/9: PvP battles must be rejected from PvE reducers (ADR-0119 D5)`,
      );
    } else if (!pvpGuardAfterOngoingCheck(body)) {
      pvpFailures.push(
        `${reducerName}: is_ranked_pvp(&battle) appears BEFORE BattleOutcome::Ongoing check — ` +
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

  return {
    name,
    pass: true,
    detail:
      `all ${ALL_REDUCERS.length} battle reducers found with ownership checks; ` +
      `outcome guards present in ${OUTCOME_CHECKED_REDUCERS.join(', ')}; ` +
      `start_battle has opponent-provenance gate; write_back helpers side_a-only; ` +
      `m17a: all ${PVP_REJECT_REDUCERS.length} PvE reducers have is_ranked_pvp(&battle) guard ` +
      `after Ongoing check (RL-8/9, ADR-0119 D5; teeth: 3 fixtures A/B/C)`,
  };
}

// ===========================================================================
// m17a (ADR-0119, RL-8/9/17): PvP-reject guard checkers (module-level exports)
//
// These are exported for reuse by future m17c evals. They are NOT a second
// default export — the single default export above integrates their logic.
// ===========================================================================

// ---------------------------------------------------------------------------
// Checker: does the reducer body contain the PvP-reject guard?
// Uses indexOf only — no dynamic RegExp (semgrep detect-non-literal-regexp).
// The needle is assembled from two parts so it does not appear verbatim as a
// complete string in this file (convention consistency).
// ---------------------------------------------------------------------------
export function hasPvpRejectGuard(body) {
  const code = stripRustComments(body);
  // needle: 'is_ranked' + '_pvp(&battle)' = 'is_ranked_pvp(&battle)'
  return code.indexOf('is_ranked' + '_pvp(&battle)') !== -1;
}

// ---------------------------------------------------------------------------
// Checker: does the PvP guard appear AFTER the Ongoing check in the body?
// Returns true iff both are present and pvpGuard offset > ongoingCheck offset.
// ---------------------------------------------------------------------------
export function pvpGuardAfterOngoingCheck(body) {
  const code = stripRustComments(body);
  const ongoingIdx = code.indexOf('BattleOutcome::' + 'Ongoing');
  const pvpIdx = code.indexOf('is_ranked' + '_pvp(&battle)');
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
