// battle-reducer-security eval (M7b): every battle reducer in server-module
// must have an ownership check (ctx.sender / player_identity guard) and the
// three action reducers (submit_attack, swap_active, flee) must check
// outcome == Ongoing before acting.
//
// Proof-of-teeth: a fixture reducer WITHOUT an ownership check must be flagged.
// A fixture reducer WITH both checks must pass.
//
// This eval starts RED until the implementer adds all five battle reducers.
import { readFileSync } from 'node:fs';

const SERVER_SRC = 'server-module/src/lib.rs';

// ---------------------------------------------------------------------------
// Strip Rust comments so doc-comment prose doesn't trip the scanner.
// ---------------------------------------------------------------------------
export function stripRustComments(src) {
  // Block comments first, then line comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Extract a single reducer's body from the source.
//
// Matches:  pub fn <name>(ctx: &ReducerContext, ...) -> Result<(), String> { ... }
// We use brace-depth counting because the body may be multi-line.
// Returns the raw text of the function body (between the outer braces), or
// null if the reducer is not found.
// ---------------------------------------------------------------------------
export function extractReducerBody(src, reducerName) {
  // Find `pub fn <name>(` using indexOf to avoid dynamic RegExp (semgrep ReDoS rule).
  const needle = `pub fn ${reducerName}(`;
  const idx = src.indexOf(needle);
  if (idx === -1) return null;

  // Walk forward from the signature to find the opening brace.
  let i = idx + needle.length;
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
// Patterns accepted:
//   - outcome == BattleOutcome::Ongoing (positive guard: "must be ongoing")
//   - outcome != BattleOutcome::Ongoing (negative guard: "reject if not ongoing")
//   - Ongoing (bare variant in a match or if expression)
// ---------------------------------------------------------------------------
export function hasOutcomeCheck(body) {
  const code = stripRustComments(body);
  return (
    /BattleOutcome::Ongoing/.test(code) ||
    /outcome\s*(==|!=)\s*/.test(code) ||
    /\.outcome/.test(code)
  );
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'battle-reducer-security (ownership checks, outcome guards, no battle logic in server module)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth #1: a reducer WITHOUT ownership check must be flagged.
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
  // Proof-of-teeth #2: a reducer WITHOUT outcome check must be flagged.
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
  // Proof-of-teeth #3: a reducer WITH both checks must PASS (no false positive).
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
  // Real check: scan the actual server-module source.
  // -------------------------------------------------------------------------
  let src;
  try {
    src = readFileSync(SERVER_SRC, 'utf8');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read ${SERVER_SRC}: ${e.message}`,
    };
  }

  // All five battle reducers must be present.
  const ALL_REDUCERS = ['start_battle', 'submit_attack', 'swap_active', 'flee', 'heal_party'];
  // These three must additionally check outcome before acting.
  const OUTCOME_CHECKED_REDUCERS = ['submit_attack', 'swap_active', 'flee'];

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

  if (failures.length > 0) {
    return {
      name,
      pass: false,
      detail: failures.join('; '),
    };
  }

  return {
    name,
    pass: true,
    detail: `all ${ALL_REDUCERS.length} battle reducers found with ownership checks; outcome guards present in ${OUTCOME_CHECKED_REDUCERS.join(', ')} (teeth verified)`,
  };
}
