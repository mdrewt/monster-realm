// battle-lifecycle-gc eval (M12.5e-1): write_back_battle_results must GC
// prior terminal (non-Ongoing) battle rows for the player, keeping only the
// latest terminal per player.
//
// EARS: Terminal battles SHALL be GC'd — at terminal write-back, delete all
// prior terminal (non-Ongoing) battle rows for this player, keeping the
// latest terminal per player.
//
// Proof-of-teeth:
//   TEETH A: a fixture WITHOUT the battle GC call must fail the check.
//   TEETH B: a fixture WITH the GC call must pass.
//
// Real check: the actual write_back_battle_results in the codebase must
// contain the GC pattern `ctx.db.battle().battle_id().delete(`.
//
// This eval is RED today: write_back_battle_results currently only GCs the
// `battle_wild` side-table (`ctx.db.battle_wild().battle_id().delete(...)`)
// and does NOT delete prior terminal `battle` rows.
//
// Implementation note:
//   All pattern matching uses String.indexOf() or String.includes() ONLY.
//   NO `new RegExp(...)` with a non-literal argument is used anywhere.
//   (Semgrep detect-non-literal-regexp has bitten 3× in this codebase.)
import { readdirSync, readFileSync, statSync } from 'node:fs';

const SERVER_SRC = 'server-module/src';

// ---------------------------------------------------------------------------
// Strip Rust line and block comments (matches the pattern used in
// battle-reducer-security.eval.mjs — copy-literal, no import).
// ---------------------------------------------------------------------------
function stripRustComments(src) {
  // Block comments first, then line comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Extract a single function body from comment-stripped Rust source.
//
// Matches `pub fn <name>(` or `fn <name>(`.
// Uses indexOf + brace-depth counting — NO dynamic RegExp.
// Returns the text between the outer braces (exclusive), or null if not found.
// ---------------------------------------------------------------------------
function extractFnBody(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  // Walk forward to the opening brace.
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  // Brace-depth counting to find the matching close brace.
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
// Core check: does the write_back_battle_results body contain
// `ctx.db.battle().battle_id().delete(` — the battle-row GC call?
//
// Key: this must be `battle()` (the battle table), NOT `battle_wild()` (the
// wild side-table whose GC is already present). We require the exact string
// `ctx.db.battle().battle_id().delete(` to appear in the body.
//
// Uses String.includes() only — no dynamic RegExp.
// ---------------------------------------------------------------------------
function hasBattleRowGc(body) {
  // The GC pattern is assembled from two parts here so this source file
  // does NOT contain the verbatim full string `ctx.db.battle().battle_id().delete(`
  // (which would cause self-match if this eval ever scanned its own source).
  // The check is split: first confirm `ctx.db.battle()` is present, then
  // that `.battle_id().delete(` follows it.
  //
  // We combine them into a single needle for the actual check:
  const needle = 'ctx.db.' + 'battle()' + '.battle_id()' + '.delete(';
  return body.includes(needle);
}

// ---------------------------------------------------------------------------
// Concatenate all .rs source files under the server-module src directory
// (recursive, sorted — deterministic).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'battle-lifecycle-gc (M12.5e-1: write_back_battle_results GCs prior terminal battle rows)';

  // =========================================================================
  // PROOF-OF-TEETH — run fixtures BEFORE scanning real source.
  // If any tooth fails to bite, short-circuit with TEETH FAILED.
  // =========================================================================

  // -------------------------------------------------------------------------
  // TEETH A: a write_back_battle_results body WITHOUT the battle GC call.
  //
  // This mirrors the CURRENT state of the codebase: the function GCs
  // `battle_wild` rows but NOT prior `battle` rows.
  //
  // hasBattleRowGc must return false for this fixture.
  // If it returns true → the checker is toothless (false positive).
  // -------------------------------------------------------------------------
  const BAD_NO_BATTLE_GC = `
    pub(crate) fn write_back_battle_results(
        ctx: &ReducerContext,
        battle: &Battle,
    ) -> Result<(), String> {
        check_team_coupling(
            battle.state.side_a.team.len(),
            battle.party_monster_ids.len(),
        )?;
        write_back_party_hp(ctx, battle)?;
        // GCs the WILD side-table only — battle rows are never cleaned up.
        // This is the current (buggy) state before M12.5e-1 is implemented.
        ctx.db.battle_wild().battle_id().delete(battle.battle_id);
        // XP grant block omitted for brevity.
        Ok(())
    }
  `;

  {
    const stripped = stripRustComments(BAD_NO_BATTLE_GC);
    const body = extractFnBody(stripped, 'write_back_battle_results');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED: could not extract write_back_battle_results body from ' +
          'BAD_NO_BATTLE_GC fixture (extractFnBody parser bug)',
      };
    }
    if (hasBattleRowGc(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (A): hasBattleRowGc returned true for a body that only ' +
          'calls `ctx.db.battle_wild().battle_id().delete(...)` and has NO ' +
          '`ctx.db.battle().battle_id().delete(` — checker is toothless ' +
          '(the `battle_wild()` call must NOT satisfy the `battle()` check)',
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH B: a write_back_battle_results body WITH the battle GC call.
  //
  // hasBattleRowGc must return true for this fixture.
  // If it returns false → false negative (checker is too strict).
  // -------------------------------------------------------------------------
  const GOOD_WITH_BATTLE_GC = `
    pub(crate) fn write_back_battle_results(
        ctx: &ReducerContext,
        battle: &Battle,
    ) -> Result<(), String> {
        check_team_coupling(
            battle.state.side_a.team.len(),
            battle.party_monster_ids.len(),
        )?;
        write_back_party_hp(ctx, battle)?;
        // GC the wild side-table row (existing behaviour).
        ctx.db.battle_wild().battle_id().delete(battle.battle_id);
        // GC prior terminal battle rows for this player (M12.5e-1).
        for old in ctx
            .db
            .battle()
            .player_identity()
            .filter(battle.player_identity)
            .filter(|b| b.battle_id != battle.battle_id
                && b.state.outcome != BattleOutcome::Ongoing)
            .collect::<Vec<_>>()
        {
            ctx.db.battle().battle_id().delete(old.battle_id);
        }
        Ok(())
    }
  `;

  {
    const stripped = stripRustComments(GOOD_WITH_BATTLE_GC);
    const body = extractFnBody(stripped, 'write_back_battle_results');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED: could not extract write_back_battle_results body from ' +
          'GOOD_WITH_BATTLE_GC fixture (extractFnBody parser bug)',
      };
    }
    if (!hasBattleRowGc(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (B): hasBattleRowGc returned false for a body that ' +
          'correctly calls `ctx.db.battle().battle_id().delete(old.battle_id)` — ' +
          'checker produced a false negative; the GC needle must match the good fixture',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual server-module source.
  // =========================================================================

  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read ${SERVER_SRC}: ${e.message}`,
    };
  }

  const src = stripRustComments(rawSrc);

  const fnName = 'write_back_battle_results';
  const body = extractFnBody(src, fnName);
  if (!body) {
    return {
      name,
      pass: false,
      detail: `${fnName}: function not found in server-module source — cannot check battle GC`,
    };
  }

  if (!hasBattleRowGc(body)) {
    return {
      name,
      pass: false,
      detail:
        `${fnName}: missing battle-row GC — the body does not contain ` +
        '`ctx.db.battle().battle_id().delete(`. ' +
        'Currently only `battle_wild()` rows are cleaned up. ' +
        'Add: iterate prior terminal battle rows for this player and delete them, ' +
        'keeping only the latest terminal per player. ' +
        'KILLS: any impl that orphans old fled/won/lost battle rows indefinitely.',
    };
  }

  return {
    name,
    pass: true,
    detail:
      `${fnName}: contains battle-row GC call ` +
      '(`ctx.db.battle().battle_id().delete(`); ' +
      'teeth verified via 2 fixtures (A=bad-no-GC flagged, B=good-with-GC passes).',
  };
}
