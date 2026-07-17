// ranking-security eval (m17c, ADR-0119, RL-16):
// Static-scan gate for the ranking module's security contract, independent of
// the Rust pvp_tests.rs needle tests. Runs in `just eval` even if the Rust test
// module is disabled (toolchain-boundary defense-in-depth).
//
// Criteria:
//   A MODULE_WRITE_ONLY (RL-7)
//     A1: ranking.rs declares no #[spacetimedb::reducer]
//     A2: ctx.db.profile() table access lives ONLY in ranking.rs
//         (intentionally coupled to ADR-0119 D6 — m17b's set_profile_name is
//          expected IN ranking.rs; if it moves elsewhere, widen the allowlist
//          in the m17b PR, not silently — AM-8)
//
//   B ONCE_ONLY_CALLSITE (RL-10) — TWO-NEEDLE strategy (AM-1, mirrors pvp_tests.rs:782)
//     B1: path-qualified `ranking::apply_pvp_rating(` in pvp.rs == 1
//     B2: bare `apply_pvp_rating` in every other non-test domain file == 0 each
//         (catches `use crate::ranking::apply_pvp_rating;` + bare-call aliasing)
//         Files read INDIVIDUALLY; filenames ending _tests.rs excluded (AM-9 F-8)
//
//   C NEVER_DELETED (RL-2)
//     C1a: chained-delete needles (`profile().identity().delete` / `profile().delete`)
//          absent in ALL non-test sources (concatenated scan)
//     C1b: split-binding needle `= ctx.db.profile()` absent OUTSIDE ranking.rs
//          (mirrors pvp_tests.rs:1206 needle — AM-4)
//     C2: on_disconnect body (extracted from lib.rs) contains no `profile(` token
//
// All strips applied: stripRustComments THEN stripRustStrings before every needle count.
// No new RegExp() anywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';

const SERVER_SRC = 'server-module/src';

// ---------------------------------------------------------------------------
// Comment and string stripping (sourced from battle-reducer-security pattern)
// ---------------------------------------------------------------------------
function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function stripRustStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      out += ' ';
      i++;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) {
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

function stripBoth(src) {
  return stripRustStrings(stripRustComments(src));
}

// ---------------------------------------------------------------------------
// extractReducerBody: extract a named function's body (between outer braces).
// ---------------------------------------------------------------------------
function extractReducerBody(src, fnName) {
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
// countOccurrences: count non-overlapping occurrences of needle in haystack.
// ---------------------------------------------------------------------------
function countOccurrences(haystack, needle) {
  let count = 0;
  let start = 0;
  while (true) {
    const idx = haystack.indexOf(needle, start);
    if (idx === -1) break;
    count++;
    start = idx + needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// readServerModuleSources: recursive concatenation of all .rs files.
// ---------------------------------------------------------------------------
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// CHECKER A1: ranking.rs must NOT contain `#[spacetimedb::reducer`
// ---------------------------------------------------------------------------
function checkNoReducerAttr(rankingSrc) {
  const code = stripBoth(rankingSrc);
  return code.indexOf('#[spacetimedb::reducer') === -1;
}

// ---------------------------------------------------------------------------
// CHECKER A2: ctx.db.profile() appears ONLY in ranking.rs across all sources.
// Returns an array of filenames (relative to SERVER_SRC) where the needle is
// found outside ranking.rs; empty array = pass.
// ---------------------------------------------------------------------------
function findProfileAccessOutsideRanking(dir) {
  const violations = [];
  // ADR-0119 D6 coupling note: this needle intentionally alerts when a future
  // slice moves profile access outside ranking.rs — the allowlist lives here.
  // Scope: production (non-test) files only. Test files (*_tests.rs) legitimately
  // access ctx.db.profile() through the SpacetimeDB test harness context — the
  // threat model is client-callable production paths, not test scaffolding.
  const needle = 'ctx.db.profile()';
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'ranking.rs') continue; // allowed home
    if (entry.endsWith('_tests.rs')) continue; // test scaffolding, not production
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      violations.push(...findProfileAccessOutsideRanking(full));
      continue;
    }
    if (!entry.endsWith('.rs')) continue;
    const code = stripBoth(readFileSync(full, 'utf8'));
    if (code.indexOf(needle) !== -1) {
      violations.push(entry);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'ranking-security (RL-16: MODULE_WRITE_ONLY A1/A2, ONCE_ONLY_CALLSITE B1/B2, NEVER_DELETED C1a/C1b/C2)';

  // =========================================================================
  // TEETH FIXTURES — run FIRST, short-circuit TEETH FAILED if any bite is lost
  // =========================================================================

  // -------------------------------------------------------------------------
  // Fixture A1-BAD: ranking.rs shape with a reducer attribute → must flag.
  // KILLS: a checker that accepts any source with #[spacetimedb::reducer].
  // -------------------------------------------------------------------------
  const badReducerAttrSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        get_or_init_profile(ctx, ctx.sender);
        Ok(())
    }
    pub(crate) fn apply_pvp_rating(ctx: &ReducerContext, battle: &Battle) {}
  `;
  if (checkNoReducerAttr(badReducerAttrSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-BAD): checkNoReducerAttr returned true for a ranking.rs fixture containing ' +
        '#[spacetimedb::reducer] — checker does not bite the bad case',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-GOOD: clean ranking.rs shape → must pass.
  // KILLS: a checker with a false-positive on a well-formed module.
  // -------------------------------------------------------------------------
  const goodRankingSrc = `
    pub(crate) fn get_or_init_profile(ctx: &ReducerContext, identity: Identity) -> Profile {
        match ctx.db.profile().identity().find(identity) {
            Some(p) => p,
            None => ctx.db.profile().insert(Profile { identity, rating: 1000, wins: 0, losses: 0, name: String::new() }),
        }
    }
    pub(crate) fn apply_pvp_rating(ctx: &ReducerContext, battle: &Battle) {}
  `;
  if (!checkNoReducerAttr(goodRankingSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-GOOD): checkNoReducerAttr returned false for a clean ranking.rs fixture — false positive',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-EVASION: reducer attr inside a string literal → must pass after strip.
  // KILLS: a checker that does not strip strings before scanning.
  // -------------------------------------------------------------------------
  const evasionReducerAttrSrc = `
    // doc-comment: the module declares no #[spacetimedb::reducer] by design
    let _dead = "#[spacetimedb::reducer]";
    pub(crate) fn apply_pvp_rating(ctx: &ReducerContext, battle: &Battle) {}
  `;
  if (!checkNoReducerAttr(evasionReducerAttrSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-EVASION): checkNoReducerAttr returned false on a fixture where ' +
        '#[spacetimedb::reducer] appears only in a string literal — stripping is not working',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture B-BAD-TWO-SITES: two path-qualified callsites in pvp.rs → must flag.
  // KILLS: a checker that does not count or tolerates count > 1.
  // -------------------------------------------------------------------------
  const badTwoCallsPvpSrc = `
    fn settle_pvp_battle(ctx: &ReducerContext, battle_id: u64) {
        ranking::apply_pvp_rating(ctx, &battle);
        // second call — must never happen
        ranking::apply_pvp_rating(ctx, &battle2);
    }
  `;
  if (countOccurrences(stripBoth(badTwoCallsPvpSrc), 'ranking::apply_pvp_rating(') !== 2) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (B-BAD-TWO-SITES): fixture construction error — expected 2 occurrences of ' +
        'ranking::apply_pvp_rating( in the bad fixture; countOccurrences is broken',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture B-BAD-ZERO-SITES: zero path-qualified callsites in pvp.rs → must flag.
  // KILLS: a checker that accepts count == 0 (funnel severed).
  // -------------------------------------------------------------------------
  const badZeroCallsPvpSrc = `
    fn settle_pvp_battle(ctx: &ReducerContext, battle_id: u64) {
        // forgot to call apply_pvp_rating
    }
  `;
  if (countOccurrences(stripBoth(badZeroCallsPvpSrc), 'ranking::apply_pvp_rating(') !== 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (B-BAD-ZERO-SITES): fixture construction error — expected 0 occurrences in zero-sites fixture',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture B-BAD-BARE-ALIAS: bare identifier in a non-pvp domain file → must flag.
  // This is the AM-1 critical fixture: catches `use crate::ranking::apply_pvp_rating;`
  // + bare-call aliasing in any non-pvp file.
  // KILLS: a checker that only counts path-qualified calls in pvp.rs and misses
  // bare alias imports in other files.
  // -------------------------------------------------------------------------
  const badBareAliasSrc = `
    use crate::ranking::apply_pvp_rating;
    fn some_economy_fn(ctx: &ReducerContext, battle: &Battle) {
        apply_pvp_rating(ctx, battle); // alias bypass
    }
  `;
  const bareNeedle = 'apply_pvp_rating';
  if (countOccurrences(stripBoth(badBareAliasSrc), bareNeedle) === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (B-BAD-BARE-ALIAS): bare identifier fixture construction error — ' +
        'expected > 0 occurrences of apply_pvp_rating in the alias fixture',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture B-EVASION: second occurrence of path-qualified call inside a comment
  // or string literal → count 1 after stripping (not 2).
  // KILLS: a checker that does not strip before counting.
  // -------------------------------------------------------------------------
  const evasionCallSiteSrc = `
    fn settle_pvp_battle(ctx: &ReducerContext, battle_id: u64) {
        ranking::apply_pvp_rating(ctx, &battle);
        // doc: do not call ranking::apply_pvp_rating( twice
        let _s = "ranking::apply_pvp_rating(";
    }
  `;
  if (countOccurrences(stripBoth(evasionCallSiteSrc), 'ranking::apply_pvp_rating(') !== 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (B-EVASION): after stripping comments + strings, expected exactly 1 occurrence ' +
        'of ranking::apply_pvp_rating( in the evasion fixture; strip is not working',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture C1a-BAD-CHAINED: chained delete form → must flag.
  // KILLS: a checker that does not detect the chained delete pattern.
  // -------------------------------------------------------------------------
  const badChainedDeleteSrc = `
    fn clear_profile(ctx: &ReducerContext, id: Identity) {
        ctx.db.profile().identity().delete(id);
    }
  `;
  const chainedNeedle1 = 'profile().identity().delete';
  const chainedNeedle2 = 'profile().delete';
  if (
    countOccurrences(stripBoth(badChainedDeleteSrc), chainedNeedle1) === 0 &&
    countOccurrences(stripBoth(badChainedDeleteSrc), chainedNeedle2) === 0
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C1a-BAD): chained-delete fixture has neither needle — fixture construction error',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture C1b-BAD-SPLIT-BINDING: split-binding form → must flag.
  // KILLS: a checker that only catches the chained form and misses the
  // split-binding evasion (mirrors pvp_tests.rs:1206).
  // -------------------------------------------------------------------------
  const badSplitBindingSrc = `
    fn reset_profile(ctx: &ReducerContext, id: Identity) {
        let p = ctx.db.profile();
        p.identity().delete(id);
    }
  `;
  const splitNeedle = '= ctx.db.profile()';
  if (countOccurrences(stripBoth(badSplitBindingSrc), splitNeedle) === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C1b-BAD): split-binding fixture does not contain `= ctx.db.profile()` — ' +
        'fixture construction error; needle would not fire even on a correct implementation',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture C2-BAD: on_disconnect body touching profile → must flag.
  // KILLS: a checker that does not scan the on_disconnect body for profile access.
  // -------------------------------------------------------------------------
  const badOnDisconnectSrc = `
    pub fn on_disconnect(ctx: &ReducerContext) {
        let me = ctx.sender;
        trading::cancel_trades_on_disconnect(ctx, me);
        pvp::forfeit_on_disconnect(ctx, me);
        // BUG: on_disconnect must not touch profile
        let p = ctx.db.profile().identity().find(me);
        if let Some(mut row) = p {
            row.name = String::new();
            ctx.db.profile().identity().update(row);
        }
        ctx.db.player().identity().delete(me);
    }
  `;
  const badOnDisconnectBody = extractReducerBody(badOnDisconnectSrc, 'on_disconnect');
  if (!badOnDisconnectBody) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C2-BAD): could not extract on_disconnect body from bad-disconnect fixture (parser bug)',
    };
  }
  if (stripBoth(badOnDisconnectBody).indexOf('profile(') === -1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C2-BAD): bad-disconnect fixture body does not contain `profile(` after strip — fixture construction error',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture C2-GOOD: on_disconnect body NOT touching profile → must pass.
  // KILLS: a false-positive checker that flags clean on_disconnect bodies.
  // -------------------------------------------------------------------------
  const goodOnDisconnectSrc = `
    pub fn on_disconnect(ctx: &ReducerContext) {
        let me = ctx.sender;
        trading::cancel_trades_on_disconnect(ctx, me);
        pvp::forfeit_on_disconnect(ctx, me);
        pvp::cancel_challenges_on_disconnect(ctx, me);
        ctx.db.player_conversation().owner_identity().delete(me);
        if let Some(p) = ctx.db.player().identity().find(me) {
            ctx.db.character().entity_id().delete(p.entity_id);
            ctx.db.player().identity().delete(me);
        }
    }
  `;
  const goodOnDisconnectBody = extractReducerBody(goodOnDisconnectSrc, 'on_disconnect');
  if (!goodOnDisconnectBody) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C2-GOOD): could not extract on_disconnect body from good-disconnect fixture (parser bug)',
    };
  }
  if (stripBoth(goodOnDisconnectBody).indexOf('profile(') !== -1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C2-GOOD): good-disconnect fixture body erroneously contains `profile(` after strip — fixture or strip is broken',
    };
  }

  // =========================================================================
  // REAL-SOURCE SCAN
  // =========================================================================

  // --- Read individual source files ---
  let rankingSrc, pvpSrc, libSrc;
  try {
    rankingSrc = readFileSync(`${SERVER_SRC}/ranking.rs`, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}/ranking.rs: ${e.message}` };
  }
  try {
    pvpSrc = readFileSync(`${SERVER_SRC}/pvp.rs`, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}/pvp.rs: ${e.message}` };
  }
  try {
    libSrc = readFileSync(`${SERVER_SRC}/lib.rs`, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}/lib.rs: ${e.message}` };
  }

  // --- Read non-test domain files individually for Criterion B2 (AM-1) ---
  // Enumerate all .rs files in SERVER_SRC (non-recursive, src is flat per M8.9b)
  // excluding filenames ending in _tests.rs (AM-9 F-8) and ranking.rs (definition) and pvp.rs (B1).
  let domainFiles; // Array of {name, src}
  try {
    domainFiles = readdirSync(SERVER_SRC)
      .filter((f) => {
        if (!f.endsWith('.rs')) return false;
        if (f.endsWith('_tests.rs')) return false; // exclude test files (AM-9)
        if (f === 'ranking.rs') return false; // definition file — excluded
        if (f === 'pvp.rs') return false; // B1 handles pvp.rs separately
        return true;
      })
      .map((f) => ({ name: f, src: readFileSync(`${SERVER_SRC}/${f}`, 'utf8') }));
  } catch (e) {
    return { name, pass: false, detail: `cannot enumerate ${SERVER_SRC}: ${e.message}` };
  }

  const failures = [];

  // -------------------------------------------------------------------------
  // Criterion A1: ranking.rs declares no #[spacetimedb::reducer]
  // -------------------------------------------------------------------------
  if (!checkNoReducerAttr(rankingSrc)) {
    failures.push(
      'A1 MODULE_WRITE_ONLY (RL-7): ranking.rs contains `#[spacetimedb::reducer` — ' +
        'no client-callable reducer may write `profile` (ADR-0119 D6); ' +
        'strip comments+strings before scan confirms this is a real declaration',
    );
  }

  // -------------------------------------------------------------------------
  // Criterion A2: ctx.db.profile() access lives ONLY in ranking.rs
  // (ADR-0119 D6 intentional coupling — AM-8 inline note)
  // -------------------------------------------------------------------------
  const profileOutside = findProfileAccessOutsideRanking(SERVER_SRC);
  if (profileOutside.length > 0) {
    failures.push(
      'A2 MODULE_WRITE_ONLY (RL-7, ADR-0119 D6): `ctx.db.profile()` found outside ranking.rs in: ' +
        profileOutside.join(', ') +
        ' — profile table access is intentionally coupled to ranking.rs only. ' +
        'If m17b set_profile_name moves profile access elsewhere, widen this allowlist in the m17b PR (never silently — AM-8).',
    );
  }

  // -------------------------------------------------------------------------
  // Criterion B1: path-qualified `ranking::apply_pvp_rating(` in pvp.rs == 1
  // -------------------------------------------------------------------------
  const pvpStripped = stripBoth(pvpSrc);
  const pvpCallNeedle = 'ranking::apply_pvp_rating(';
  const pvpCallCount = countOccurrences(pvpStripped, pvpCallNeedle);
  if (pvpCallCount !== 1) {
    failures.push(
      `B1 ONCE_ONLY_CALLSITE (RL-10): expected exactly 1 path-qualified call \`${pvpCallNeedle}\` in pvp.rs, ` +
        `found ${pvpCallCount}. The settle_pvp_battle funnel must be the single caller of apply_pvp_rating ` +
        `(ADR-0119 D3). Zero = funnel severed; >1 = double-count risk.`,
    );
  }

  // -------------------------------------------------------------------------
  // Criterion B2: bare `apply_pvp_rating` in every other non-test domain file == 0
  // Read individually (AM-1); filenames ending _tests.rs excluded (AM-9 F-8).
  // flat scan — server-module/src has no subdirectories (M8.9b); if a subdir is
  // ever added, make this recursive (A2's scan already recurses).
  // -------------------------------------------------------------------------
  const bareNeedleB2 = 'apply_pvp_rating';
  for (const { name: fileName, src } of domainFiles) {
    const stripped = stripBoth(src);
    const bareCount = countOccurrences(stripped, bareNeedleB2);
    if (bareCount > 0) {
      failures.push(
        `B2 ONCE_ONLY_CALLSITE (RL-10): found ${bareCount} occurrence(s) of \`${bareNeedleB2}\` in ${fileName} — ` +
          'only pvp.rs may reference apply_pvp_rating (path-qualified as ranking::apply_pvp_rating); ' +
          'all other domain files must never call it. Catches use-import + bare-call aliasing (AM-1, ADR-0119 D3).',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Criterion C1a: chained-delete needles absent in ALL non-test sources
  // -------------------------------------------------------------------------
  let allNonTestSrc;
  try {
    // Build a concatenated blob from non-test sources only for C1a/C1b
    allNonTestSrc = readdirSync(SERVER_SRC)
      .filter((f) => f.endsWith('.rs') && !f.endsWith('_tests.rs'))
      .sort()
      .map((f) => readFileSync(`${SERVER_SRC}/${f}`, 'utf8'))
      .join('\n');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read server-module sources for C1 scan: ${e.message}`,
    };
  }

  const allStripped = stripBoth(allNonTestSrc);
  if (countOccurrences(allStripped, 'profile().identity().delete') > 0) {
    failures.push(
      'C1a NEVER_DELETED (RL-2): found `profile().identity().delete` in non-test sources — ' +
        'profile rows must NEVER be deleted (persistent leaderboard, ADR-0119 D1). ' +
        'This needle catches the chained-delete form.',
    );
  }
  if (countOccurrences(allStripped, 'profile().delete') > 0) {
    failures.push(
      'C1a NEVER_DELETED (RL-2): found `profile().delete` in non-test sources — ' +
        'profile rows must NEVER be deleted (persistent leaderboard, ADR-0119 D1). ' +
        'This needle catches the alternate chained-delete form.',
    );
  }

  // -------------------------------------------------------------------------
  // Criterion C1b: split-binding `= ctx.db.profile()` absent OUTSIDE ranking.rs
  // (AM-4 — mirrors pvp_tests.rs:1206 split-binding needle)
  //
  // Scan set = domainFiles (all non-test files except ranking.rs and pvp.rs)
  // PLUS pvp.rs explicitly (pvp.rs is excluded from domainFiles for B1/B2 reasons
  // but must still be checked for the split-binding needle).
  // Together this covers every non-test .rs file except ranking.rs, each exactly once.
  // -------------------------------------------------------------------------
  const splitBindingNeedle = '= ctx.db.profile()';
  const c1bFiles = [...domainFiles, { name: 'pvp.rs', src: pvpSrc }];
  for (const { name: fileName, src } of c1bFiles) {
    if (stripBoth(src).indexOf(splitBindingNeedle) !== -1) {
      failures.push(
        `C1b NEVER_DELETED (RL-2): found \`${splitBindingNeedle}\` in ${fileName} — ` +
          'assigning the profile table accessor to a binding outside ranking.rs risks a .delete() call. ' +
          'Use inline chained access: `ctx.db.profile().identity().find(id)` in ranking.rs only (AM-4, ADR-0119 D1).',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Criterion C2: on_disconnect body contains no `profile(` token
  // -------------------------------------------------------------------------
  const libStripped = stripBoth(libSrc);
  const onDisconnectBody = extractReducerBody(libStripped, 'on_disconnect');
  if (!onDisconnectBody) {
    failures.push(
      'C2 NEVER_DELETED (RL-2): on_disconnect function not found in server-module/src/lib.rs — ' +
        'cannot verify that the disconnect hook does not touch profile.',
    );
  } else if (onDisconnectBody.indexOf('profile(') !== -1) {
    failures.push(
      'C2 NEVER_DELETED (RL-2): on_disconnect body contains `profile(` token — ' +
        'on_disconnect must not read or write profile rows (ADR-0119 D1); ' +
        'profile persistence through disconnect is what makes ratings durable.',
    );
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'RL-16 all criteria met: ' +
      'A1 ranking.rs declares no #[spacetimedb::reducer] (module-write-only); ' +
      'A2 ctx.db.profile() access lives only in ranking.rs (ADR-0119 D6); ' +
      `B1 exactly 1 path-qualified ranking::apply_pvp_rating( in pvp.rs; ` +
      `B2 bare apply_pvp_rating absent from all ${domainFiles.length} other non-test domain files (AM-1 two-needle); ` +
      'C1a chained-delete needles absent from all non-test sources; ' +
      'C1b split-binding = ctx.db.profile() absent outside ranking.rs (AM-4); ' +
      'C2 on_disconnect body contains no profile( token (ADR-0119 D1).',
  };
}
