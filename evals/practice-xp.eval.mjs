// practice-xp eval (M12.5e2): write_back_battle_results must call
// game_core::practice_xp_reward for the 0.1× practice-battle XP penalty.
//
// EARS: practice battles (opponent_identity != WILD_IDENTITY) SHALL award
// floor(base_xp / 10) XP; wild battles SHALL award full base_xp.
//
// Proof-of-teeth:
//   TEETH A: a fixture WITHOUT practice_xp_reward( must fail the check.
//   TEETH B: a fixture WITH practice_xp_reward(base_xp, is_practice) must pass.
//
// Implementation note:
//   All pattern matching uses String.indexOf() or String.includes() ONLY.
//   NO `new RegExp(...)` with a non-literal argument is used anywhere.
import { readdirSync, readFileSync, statSync } from 'node:fs';

const SERVER_SRC = 'server-module/src';

function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function extractFnBody(src, fnName) {
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

function hasPracticeXpCall(body) {
  // No self-match risk: this file is under evals/, not server-module/src/,
  // so it is never in the scanned corpus.
  return body.includes('practice_xp_reward(');
}

function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      parts.push(readServerModuleSources(full));
    } else if (entry.endsWith('.rs')) {
      parts.push(readFileSync(full, 'utf8'));
    }
  }
  return parts.join('\n');
}

export default async function () {
  const name = 'practice-xp (M12.5e2: write_back_battle_results must call practice_xp_reward)';

  // TEETH A: body WITHOUT practice_xp_reward — must be flagged RED.
  const BAD_NO_PRACTICE_XP = `
    pub(crate) fn write_back_battle_results(
        ctx: &ReducerContext,
        battle: &Battle,
    ) -> Result<(), String> {
        write_back_party_hp(ctx, battle)?;
        ctx.db.battle_wild().battle_id().delete(battle.battle_id);
        if battle.state.outcome == BattleOutcome::SideAWins {
            let bst = loser_base_stat_total(&loser_species);
            let xp_gained = battle_xp_reward(winner_lvl, bst, loser_lvl);
            let (new_xp, new_level, leveled_up) = apply_xp_gain(current_xp, xp_gained);
        }
        Ok(())
    }
  `;
  {
    const stripped = stripRustComments(BAD_NO_PRACTICE_XP);
    const body = extractFnBody(stripped, 'write_back_battle_results');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH FAILED: extractFnBody failed on BAD_NO_PRACTICE_XP',
      };
    }
    if (hasPracticeXpCall(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A): hasPracticeXpCall returned true for a body without practice_xp_reward — checker is toothless',
      };
    }
  }

  // TEETH B: body WITH practice_xp_reward — must pass.
  const GOOD_WITH_PRACTICE_XP = `
    pub(crate) fn write_back_battle_results(
        ctx: &ReducerContext,
        battle: &Battle,
    ) -> Result<(), String> {
        write_back_party_hp(ctx, battle)?;
        ctx.db.battle_wild().battle_id().delete(battle.battle_id);
        if battle.state.outcome == BattleOutcome::SideAWins {
            let bst = loser_base_stat_total(&loser_species);
            let base_xp = battle_xp_reward(winner_lvl, bst, loser_lvl);
            let is_practice = battle.opponent_identity != WILD_IDENTITY;
            let xp_gained = game_core::practice_xp_reward(base_xp, is_practice);
            let (new_xp, new_level, leveled_up) = apply_xp_gain(current_xp, xp_gained);
        }
        Ok(())
    }
  `;
  {
    const stripped = stripRustComments(GOOD_WITH_PRACTICE_XP);
    const body = extractFnBody(stripped, 'write_back_battle_results');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH FAILED: extractFnBody failed on GOOD_WITH_PRACTICE_XP',
      };
    }
    if (!hasPracticeXpCall(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (B): hasPracticeXpCall returned false for a body with practice_xp_reward — false negative',
      };
    }
  }

  // REAL CHECK
  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }

  const src = stripRustComments(rawSrc);
  const body = extractFnBody(src, 'write_back_battle_results');
  if (!body) {
    return {
      name,
      pass: false,
      detail: 'write_back_battle_results not found in server-module source',
    };
  }

  if (!hasPracticeXpCall(body)) {
    return {
      name,
      pass: false,
      detail:
        'write_back_battle_results does not call practice_xp_reward( — ' +
        'the 0.1× practice-battle XP penalty is not wired through game-core (ADR-0003 violation). ' +
        'Expected: compute is_practice = (battle.opponent_identity != WILD_IDENTITY), ' +
        'then xp_gained = game_core::practice_xp_reward(base_xp, is_practice).',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'write_back_battle_results calls practice_xp_reward( — ' +
      '0.1× practice-battle XP penalty wired via game-core SSOT (ADR-0078); ' +
      'teeth verified via 2 fixtures (A=no-call flagged, B=with-call passes).',
  };
}
