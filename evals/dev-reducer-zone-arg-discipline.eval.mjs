// dev-reducer-zone-arg-discipline.eval.mjs — M8.7b red-team finding (MED-1)
//
// INVARIANT: After the zone_id != character.zone_id reject check passes in
// `start_wild_battle`, the subsequent encounter table lookup must use the
// server-authoritative `character.zone_id`, NOT the raw client-supplied
// `zone_id` argument.
//
// CURRENT STATE: The implementation (lib.rs:1545) uses the argument `zone_id`
// after the check. Because `zone_id == character.zone_id` is guaranteed at that
// point (the reject returned Err otherwise), this is EQUIVALENT today but is a
// defense-in-depth gap: if the reject check is ever weakened or reordered, the
// lookup silently reverts to trusting the client argument.
//
// This eval starts RED (the current code uses the argument, not the field).
// It turns GREEN when the lookup is changed to `character.zone_id`.
//
// ADR reference: ADR-0054 §3 (reject-not-clamp), MED-1 red-team finding.
//
// Implementation: pure source-scan with indexOf — NO new RegExp.

import { readFileSync, readdirSync, statSync } from 'node:fs';

/**
 * Strip `//` line comments from Rust source.
 * @param {string} src
 * @returns {string}
 */
export function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const c = line.indexOf('//');
      return c === -1 ? line : line.slice(0, c);
    })
    .join('\n');
}

/**
 * Extract the body of `start_wild_battle` from comment-stripped source.
 * Returns null if the function is not found (e.g. feature gate strips it from
 * source text — which does NOT happen for #[cfg] since it operates on
 * the compiled artifact, not the raw source text).
 *
 * @param {string} src  Comment-stripped source.
 * @returns {string|null}
 */
export function extractStartWildBattleBody(src) {
  const needle = 'pub fn start_wild_battle(';
  const idx = src.indexOf(needle);
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

/**
 * Check that `start_wild_battle`'s body uses `character.zone_id` (not the raw
 * `zone_id` argument) in the encounter table lookup.
 *
 * The encounter table lookup pattern is:
 *   ctx.db.encounter().zone_id().find(<value>)
 *
 * GOOD: <value> is `character.zone_id`
 * BAD: <value> is the raw `zone_id` argument
 *
 * Algorithm:
 *   1. Find `encounter()` in the body (the lookup call).
 *   2. Find `.find(` after `encounter()`.
 *   3. Extract the argument passed to `.find(`.
 *   4. Require that argument to contain `character.zone_id`.
 *   5. Reject if the argument is exactly `zone_id` (the raw client arg).
 *
 * @param {string} body  Body of start_wild_battle, comment-stripped.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkEncounterLookupUsesServerZone(body) {
  const compact = body.replace(/\s+/g, '');

  // Find the encounter table lookup.
  const encIdx = compact.indexOf('encounter()');
  if (encIdx === -1) {
    return (
      'start_wild_battle: no encounter() lookup found in body — ' +
      'expected ctx.db.encounter().zone_id().find(...) for the private encounter table'
    );
  }

  // Find .find( after the encounter() call.
  const findNeedle = '.find(';
  const findIdx = compact.indexOf(findNeedle, encIdx);
  if (findIdx === -1) {
    return 'start_wild_battle: encounter() found but no .find( call after it';
  }

  // Extract the argument to .find(: walk to matching ')'.
  const argStart = findIdx + findNeedle.length;
  let i = argStart;
  let depth = 1;
  while (i < compact.length && depth > 0) {
    if (compact[i] === '(') depth++;
    else if (compact[i] === ')') depth--;
    i++;
  }
  const arg = compact.slice(argStart, i - 1);

  // GOOD: argument contains character.zone_id (server-authoritative value).
  if (arg.indexOf('character.zone_id') !== -1) {
    return null; // pass
  }

  // BAD: argument is the raw zone_id parameter (client-supplied).
  if (arg === 'zone_id') {
    return (
      'start_wild_battle: encounter().find(zone_id) uses the raw client-supplied argument — ' +
      'after the zone_id != character.zone_id reject check, the lookup must use ' +
      'character.zone_id (the server-authoritative value) not the argument zone_id. ' +
      'Currently equivalent since the check guarantees equality, but is a defense-in-depth gap: ' +
      'if the reject check is ever weakened or reordered, the lookup silently trusts the client. ' +
      'Fix: change .find(zone_id) to .find(character.zone_id) after the reject check. ' +
      '[MED-1, ADR-0054 §3]'
    );
  }

  // Unknown argument form — conservative fail.
  return (
    `start_wild_battle: encounter().find(${arg}) — argument is neither character.zone_id ` +
    'nor the raw zone_id; manual review required'
  );
}

// ============================================================================
// Proof-of-teeth fixtures
// ============================================================================

// BAD fixture: lookup uses the raw argument (current production state).
const BAD_USES_ARGUMENT = `
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(player) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(character) = ctx.db.character().entity_id().find(player.entity_id) else {
        return Err("no character".to_string());
    };
    if zone_id != character.zone_id {
        return Err(format!("zone mismatch: arg {} != character zone {}", zone_id, character.zone_id));
    }
    let Some(row) = ctx.db.encounter().zone_id().find(zone_id) else {
        return Err(format!("no encounter table for zone {zone_id}"));
    };
    Ok(())
}
`;
// Must be flagged: uses the argument, not character.zone_id.

// GOOD fixture: lookup uses the server-authoritative field.
const GOOD_USES_SERVER_FIELD = `
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(player) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(character) = ctx.db.character().entity_id().find(player.entity_id) else {
        return Err("no character".to_string());
    };
    if zone_id != character.zone_id {
        return Err(format!("zone mismatch: arg {} != character zone {}", zone_id, character.zone_id));
    }
    let Some(row) = ctx.db.encounter().zone_id().find(character.zone_id) else {
        return Err(format!("no encounter table for zone {}", character.zone_id));
    };
    Ok(())
}
`;
// Must pass: uses character.zone_id after the reject check.

// ============================================================================
// Default export
// ============================================================================

export default async function () {
  const name =
    'dev-reducer-zone-arg-discipline (M8.7b MED-1: encounter lookup must use character.zone_id, not raw zone_id arg, after reject check)';

  // --- Tooth A: bad fixture (uses argument) must be flagged ------------------
  {
    const body = extractStartWildBattleBody(stripLineComments(BAD_USES_ARGUMENT));
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH A: could not extract body from BAD_USES_ARGUMENT fixture (parser bug)',
      };
    }
    const result = checkEncounterLookupUsesServerZone(body);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH A: BAD_USES_ARGUMENT (encounter().find(zone_id) using raw client arg) was NOT flagged — ' +
          'the check must require character.zone_id in the encounter lookup',
      };
    }
  }

  // --- Tooth B: good fixture (uses character.zone_id) must pass --------------
  {
    const body = extractStartWildBattleBody(stripLineComments(GOOD_USES_SERVER_FIELD));
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH B: could not extract body from GOOD_USES_SERVER_FIELD fixture (parser bug)',
      };
    }
    const result = checkEncounterLookupUsesServerZone(body);
    if (result) {
      return {
        name,
        pass: false,
        detail: `TEETH B: GOOD_USES_SERVER_FIELD was incorrectly flagged: ${result}`,
      };
    }
  }

  // ==========================================================================
  // REAL SOURCE CHECK — expected RED (current code uses zone_id argument).
  // Turns GREEN when the encounter lookup is changed to character.zone_id.
  // ==========================================================================

  const SERVER_SRC = 'server-module/src';
  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }

  const src = stripLineComments(rawSrc);

  // start_wild_battle is behind #[cfg(feature = "dev_reducers")] — but the
  // source TEXT is always present in lib.rs (cfg strips the compiled output, not
  // the source). If the function is absent from source (deleted), that is a
  // structural change outside this slice's scope; report as pass-with-note.
  const body = extractStartWildBattleBody(src);
  if (!body) {
    return {
      name,
      pass: true,
      detail:
        'start_wild_battle not found in source (may have been deleted at M9+). ' +
        'Zone-arg-discipline invariant vacuously holds — no lookup to audit.',
    };
  }

  const result = checkEncounterLookupUsesServerZone(body);
  if (result) {
    return { name, pass: false, detail: result };
  }

  return {
    name,
    pass: true,
    detail:
      'start_wild_battle encounter lookup uses character.zone_id (server-authoritative) ' +
      'not the raw zone_id argument — zone-arg-discipline invariant holds. ' +
      'Teeth verified: BAD_USES_ARGUMENT flagged, GOOD_USES_SERVER_FIELD passed.',
  };
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
