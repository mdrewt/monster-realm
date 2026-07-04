// economy-sinks-sources eval (M13c, ADR-0083):
// Verifies that all economy sinks/sources route through the ADR-0081 currency helpers:
//   1. HEAL_SPEND        — heal_party body contains spend_currency call (cost sink wired)
//   2. HEAL_OWNER_FIRST  — require_owner appears BEFORE spend_currency in heal_party body
//                          (ADR-0081 forward obligation for every spend path)
//   3. QUEST_GRANT       — apply_quest_trigger / QuestComplete block contains grant_currency
//                          (quest completion source wired)
//   4. BATTLE_GRANT      — write_back_battle_results body contains grant_currency call
//                          (battle win source wired)
//   5. NO_DIRECT_BALANCE — no new direct `.balance +=` or `.balance -=` in the three
//                          wired paths (raising.rs, npc.rs, battle.rs); single-surface
//                          discipline (ADR-0081 §5) must hold in the new source paths.
//
// Proof-of-teeth: each checker is tested against a BAD fixture (must flag) and a GOOD
// fixture (must pass). A checker that fails to flag the bad fixture is reported as a
// TEETH FAILURE, which fails the whole eval.
//
// No new RegExp() — all patterns are literal regex literals (Semgrep detect-non-literal-regexp).
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source stripping helpers (mirrors currency-integrity.eval.mjs)
// ---------------------------------------------------------------------------

/** Strip Rust line and block comments so doc-comment prose doesn't trip scanners. */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Body extractor: find a named function and return its body text (between
// outer braces), or null if not found.
// Handles both `pub fn` and plain `fn` declarations.
// ---------------------------------------------------------------------------
export function extractFunctionBody(src, fnName) {
  const code = stripRustComments(src);
  let idx = code.indexOf(`pub fn ${fnName}(`);
  if (idx === -1) idx = code.indexOf(`fn ${fnName}(`);
  if (idx === -1) return null;

  // Walk forward to the opening brace of the function body.
  let i = idx;
  while (i < code.length && code[i] !== '{') i++;
  if (i >= code.length) return null;

  // Count braces to find the matching close.
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(start, i - 1);
}

// ---------------------------------------------------------------------------
// Criterion 1: HEAL_SPEND
// heal_party body must contain a spend_currency call.
//
// Bad fixture: heal_party body has NO spend_currency call (cost sink missing).
// Good fixture: heal_party body contains spend_currency (cost sink wired).
// ---------------------------------------------------------------------------

/**
 * Returns true if the heal_party body contains a spend_currency call.
 */
export function healPartyCallsSpendCurrency(src) {
  const body = extractFunctionBody(src, 'heal_party');
  if (!body) return false;
  return body.indexOf(['spend', '_currency'].join('')) !== -1;
}

// ---------------------------------------------------------------------------
// Criterion 2: HEAL_OWNER_FIRST
// require_owner must appear BEFORE spend_currency inside heal_party.
// ADR-0081: every spend path must call require_owner first.
//
// Bad fixture: spend_currency before require_owner (or require_owner missing).
// Good fixture: require_owner before spend_currency.
// ---------------------------------------------------------------------------

/**
 * Returns true if require_owner appears before spend_currency in the heal_party body.
 */
export function healPartyHasRequireOwnerBeforeSpend(src) {
  const body = extractFunctionBody(src, 'heal_party');
  if (!body) return false;
  const spendPat = ['spend', '_currency'].join('');
  const roIdx = body.indexOf('require_owner');
  const spendIdx = body.indexOf(spendPat);
  if (roIdx === -1 || spendIdx === -1) return false;
  return roIdx < spendIdx;
}

// ---------------------------------------------------------------------------
// Criterion 3: QUEST_GRANT
// apply_quest_trigger body must contain a grant_currency call.
// Quest completion is a currency SOURCE (ADR-0083).
//
// Bad fixture: apply_quest_trigger has NO grant_currency call.
// Good fixture: apply_quest_trigger contains grant_currency.
// ---------------------------------------------------------------------------

/**
 * Returns true if the apply_quest_trigger body contains a grant_currency call.
 */
export function questTriggerCallsGrantCurrency(src) {
  const body = extractFunctionBody(src, 'apply_quest_trigger');
  if (!body) return false;
  return body.indexOf(['grant', '_currency'].join('')) !== -1;
}

// ---------------------------------------------------------------------------
// Criterion 4: BATTLE_GRANT
// write_back_battle_results body must contain a grant_currency call.
// Battle wins are a currency SOURCE (ADR-0083).
//
// Bad fixture: write_back_battle_results has NO grant_currency call.
// Good fixture: write_back_battle_results contains grant_currency.
// ---------------------------------------------------------------------------

/**
 * Returns true if the write_back_battle_results body contains a grant_currency call.
 */
export function battleResultsCallsGrantCurrency(src) {
  const body = extractFunctionBody(src, 'write_back_battle_results');
  if (!body) return false;
  return body.indexOf(['grant', '_currency'].join('')) !== -1;
}

// ---------------------------------------------------------------------------
// Criterion 5: NO_DIRECT_BALANCE
// The three new source-path files (raising.rs, npc.rs, battle.rs) must not
// contain any direct `.balance +=` or `.balance -=` mutations that bypass
// the grant/spend helpers (ADR-0081 single-surface discipline).
//
// Bad fixture: source contains `.balance +=`.
// Good fixture: source has no direct balance increment/decrement.
// ---------------------------------------------------------------------------

/**
 * Returns true if the source file contains a direct balance mutation (bypass).
 * Checks for `.balance +=` or `.balance -=`.
 */
export function hasDirectBalanceMutation(src) {
  const code = stripRustComments(src);
  return /\.balance\s*\+=/.test(code) || /\.balance\s*-=/.test(code);
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'economy-sinks-sources (M13c/ADR-0083: heal spend, heal owner-first, quest grant, battle grant, no balance bypass)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: each checker must flag the bad fixture.
  // -------------------------------------------------------------------------

  // --- Criterion 1: HEAL_SPEND teeth ---

  // Bad: heal_party body with NO spend_currency call.
  const badHealNoSpend =
    'pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> { ' +
    'let me = ctx.sender; require_owner(ctx, "heal_party", me)?; Ok(()) }';
  if (healPartyCallsSpendCurrency(badHealNoSpend)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (HEAL_SPEND): healPartyCallsSpendCurrency passed on a ' +
        'fixture where heal_party has NO spend_currency call — the heal cost sink is missing.',
    };
  }

  // Good: heal_party body contains spend_currency.
  const goodHealSpend =
    'pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> { ' +
    'let me = ctx.sender; require_owner(ctx, "heal_party", me)?; ' +
    'spend_currency(ctx, me, 10)?; Ok(()) }';
  if (!healPartyCallsSpendCurrency(goodHealSpend)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (HEAL_SPEND): healPartyCallsSpendCurrency did not pass on a ' +
        'correct fixture where heal_party contains spend_currency.',
    };
  }

  // --- Criterion 2: HEAL_OWNER_FIRST teeth ---

  // Bad: spend_currency before require_owner.
  const badHealOrderSwapped =
    'pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> { ' +
    'let me = ctx.sender; spend_currency(ctx, me, 10)?; require_owner(ctx, "heal_party", me)?; Ok(()) }';
  if (healPartyHasRequireOwnerBeforeSpend(badHealOrderSwapped)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (HEAL_OWNER_FIRST): healPartyHasRequireOwnerBeforeSpend passed on a ' +
        'fixture where spend_currency appears BEFORE require_owner — ownership check must precede spend.',
    };
  }

  // Bad: require_owner missing entirely.
  const badHealNoOwner =
    'pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> { ' +
    'let me = ctx.sender; spend_currency(ctx, me, 10)?; Ok(()) }';
  if (healPartyHasRequireOwnerBeforeSpend(badHealNoOwner)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (HEAL_OWNER_FIRST): healPartyHasRequireOwnerBeforeSpend passed on a ' +
        'fixture with NO require_owner call — ADR-0081 requires ownership check before spend.',
    };
  }

  // Good: require_owner before spend_currency.
  const goodHealOwnerFirst =
    'pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> { ' +
    'let me = ctx.sender; require_owner(ctx, "heal_party", me)?; spend_currency(ctx, me, 10)?; Ok(()) }';
  if (!healPartyHasRequireOwnerBeforeSpend(goodHealOwnerFirst)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (HEAL_OWNER_FIRST): healPartyHasRequireOwnerBeforeSpend did not pass on ' +
        'a correct fixture where require_owner appears before spend_currency.',
    };
  }

  // --- Criterion 3: QUEST_GRANT teeth ---

  // Bad: apply_quest_trigger body with NO grant_currency call.
  const badQuestNoGrant =
    'fn apply_quest_trigger(ctx: &ReducerContext, owner: Identity, event: &TriggerEvent, state: &mut PlayerDialogueState) { ' +
    'for item in &reward.items { grant_item(ctx, owner, item.item_id, item.qty); } }';
  if (questTriggerCallsGrantCurrency(badQuestNoGrant)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (QUEST_GRANT): questTriggerCallsGrantCurrency passed on a ' +
        'fixture where apply_quest_trigger has NO grant_currency call — quest currency rewards missing.',
    };
  }

  // Good: apply_quest_trigger contains grant_currency.
  const goodQuestGrant =
    'fn apply_quest_trigger(ctx: &ReducerContext, owner: Identity, event: &TriggerEvent, state: &mut PlayerDialogueState) { ' +
    'for item in &reward.items { grant_item(ctx, owner, item.item_id, item.qty); } ' +
    'grant_currency(ctx, owner, reward.currency); }';
  if (!questTriggerCallsGrantCurrency(goodQuestGrant)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (QUEST_GRANT): questTriggerCallsGrantCurrency did not pass on a ' +
        'correct fixture where apply_quest_trigger contains grant_currency.',
    };
  }

  // --- Criterion 4: BATTLE_GRANT teeth ---

  // Bad: write_back_battle_results body with NO grant_currency call.
  const badBattleNoGrant =
    'pub(crate) fn write_back_battle_results(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> { ' +
    'let xp = battle_xp_reward(winner_lvl, bst, loser_lvl); apply_xp_gain(current_xp, xp); Ok(()) }';
  if (battleResultsCallsGrantCurrency(badBattleNoGrant)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BATTLE_GRANT): battleResultsCallsGrantCurrency passed on a ' +
        'fixture where write_back_battle_results has NO grant_currency — battle currency rewards missing.',
    };
  }

  // Good: write_back_battle_results contains grant_currency.
  const goodBattleGrant =
    'pub(crate) fn write_back_battle_results(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> { ' +
    'let xp = battle_xp_reward(winner_lvl, bst, loser_lvl); apply_xp_gain(current_xp, xp); ' +
    'grant_currency(ctx, battle.player_identity, reward); Ok(()) }';
  if (!battleResultsCallsGrantCurrency(goodBattleGrant)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (BATTLE_GRANT): battleResultsCallsGrantCurrency did not pass on a ' +
        'correct fixture where write_back_battle_results contains grant_currency.',
    };
  }

  // --- Criterion 5: NO_DIRECT_BALANCE teeth ---

  // Bad: source contains `.balance +=`.
  const badBalanceIncrement =
    'fn grant_something(ctx: &ReducerContext, owner: Identity, amount: u64) { ' +
    'let mut row = ctx.db.player_wallet().find(owner).unwrap(); ' +
    'row.balance += amount; ctx.db.player_wallet().update(row); }';
  if (!hasDirectBalanceMutation(badBalanceIncrement)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (NO_DIRECT_BALANCE): hasDirectBalanceMutation did not flag a fixture ' +
        'with `.balance +=` — direct balance mutation bypasses ADR-0081 single-surface discipline.',
    };
  }

  // Bad: source contains `.balance -=`.
  const badBalanceDecrement =
    'fn spend_something(ctx: &ReducerContext, owner: Identity, amount: u64) { ' +
    'let mut row = ctx.db.player_wallet().find(owner).unwrap(); ' +
    'row.balance -= amount; ctx.db.player_wallet().update(row); }';
  if (!hasDirectBalanceMutation(badBalanceDecrement)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (NO_DIRECT_BALANCE): hasDirectBalanceMutation did not flag a fixture ' +
        'with `.balance -=` — direct balance subtraction bypasses the spend helper.',
    };
  }

  // Good: no direct balance mutation (uses helper functions).
  const goodNoBalance =
    'fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> { ' +
    'let me = ctx.sender; require_owner(ctx, "heal_party", me)?; ' +
    'spend_currency(ctx, me, 10)?; ' +
    'for mid in monster_ids { heal_monster(ctx, mid); } Ok(()) }';
  if (hasDirectBalanceMutation(goodNoBalance)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (NO_DIRECT_BALANCE): hasDirectBalanceMutation flagged a correct fixture ' +
        'that has no direct balance mutation — false positive.',
    };
  }

  // -------------------------------------------------------------------------
  // Read actual source files.
  // -------------------------------------------------------------------------

  let raisingSrc, npcSrc, battleSrc;
  try {
    raisingSrc = readFileSync('server-module/src/raising.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/raising.rs not found' };
  }
  try {
    npcSrc = readFileSync('server-module/src/npc.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/npc.rs not found' };
  }
  try {
    battleSrc = readFileSync('server-module/src/battle.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/battle.rs not found' };
  }

  const failures = [];

  // Criterion 1: HEAL_SPEND
  if (!healPartyCallsSpendCurrency(raisingSrc)) {
    const body = extractFunctionBody(raisingSrc, 'heal_party');
    if (!body) {
      failures.push('HEAL_SPEND: fn heal_party not found in raising.rs');
    } else {
      failures.push(
        'HEAL_SPEND: heal_party body in raising.rs contains no spend_currency call — ' +
          'wire the currency cost sink: load HealLocationDef.cost_currency from game-core ' +
          'content and call spend_currency(ctx, me, cost_currency)? before healing (ADR-0083)',
      );
    }
  }

  // Criterion 2: HEAL_OWNER_FIRST
  if (!healPartyHasRequireOwnerBeforeSpend(raisingSrc)) {
    const body = extractFunctionBody(raisingSrc, 'heal_party');
    if (!body) {
      failures.push('HEAL_OWNER_FIRST: fn heal_party not found in raising.rs');
    } else {
      const spendPat = ['spend', '_currency'].join('');
      const hasSpend = body.indexOf(spendPat) !== -1;
      const hasOwner = body.indexOf('require_owner') !== -1;
      if (!hasOwner) {
        failures.push(
          'HEAL_OWNER_FIRST: require_owner absent from heal_party body — ' +
            'add require_owner(ctx, "heal_party", me)? before spend_currency (ADR-0081)',
        );
      } else if (!hasSpend) {
        failures.push(
          'HEAL_OWNER_FIRST: spend_currency absent from heal_party body — ' +
            'add the spend_currency call (see HEAL_SPEND criterion above)',
        );
      } else {
        failures.push(
          'HEAL_OWNER_FIRST: spend_currency appears before require_owner in heal_party — ' +
            'move require_owner(ctx, "heal_party", me)? to be called BEFORE spend_currency (ADR-0081)',
        );
      }
    }
  }

  // Criterion 3: QUEST_GRANT
  if (!questTriggerCallsGrantCurrency(npcSrc)) {
    const body = extractFunctionBody(npcSrc, 'apply_quest_trigger');
    if (!body) {
      failures.push('QUEST_GRANT: fn apply_quest_trigger not found in npc.rs');
    } else {
      failures.push(
        'QUEST_GRANT: apply_quest_trigger body in npc.rs has no grant_currency call — ' +
          'wire quest currency rewards: in the QuestAdvance::QuestComplete branch, ' +
          'call grant_currency(ctx, owner, reward.currency) (ADR-0083)',
      );
    }
  }

  // Criterion 4: BATTLE_GRANT
  if (!battleResultsCallsGrantCurrency(battleSrc)) {
    const body = extractFunctionBody(battleSrc, 'write_back_battle_results');
    if (!body) {
      failures.push('BATTLE_GRANT: fn write_back_battle_results not found in battle.rs');
    } else {
      failures.push(
        'BATTLE_GRANT: write_back_battle_results body in battle.rs has no grant_currency call — ' +
          'wire battle win currency reward: inside the SideAWins branch, ' +
          'call grant_currency(ctx, player, battle_currency_reward(bst)) (ADR-0083)',
      );
    }
  }

  // Criterion 5: NO_DIRECT_BALANCE — check all three files
  const filesToCheck = [
    { name: 'raising.rs', src: raisingSrc },
    { name: 'npc.rs', src: npcSrc },
    { name: 'battle.rs', src: battleSrc },
  ];
  for (const { name: fname, src } of filesToCheck) {
    if (hasDirectBalanceMutation(src)) {
      failures.push(
        `NO_DIRECT_BALANCE: ${fname} contains a direct .balance += or .balance -= mutation — ` +
          'all balance mutations must route through grant_currency / spend_currency (ADR-0081 §5)',
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
      'all 5 economy-sinks-sources criteria met ' +
      '(heal_party spend_currency wired, require_owner before spend, ' +
      'quest grant_currency wired, battle grant_currency wired, no direct balance bypass)',
  };
}
