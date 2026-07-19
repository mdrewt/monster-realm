// ranking-security eval (m17c, ADR-0119; RL-7 refined by ADR-0132/pt-c1):
// Static-scan gate for the ranking module's security contract, independent of
// the Rust pvp_tests.rs needle tests. Runs in `just eval` even if the Rust test
// module is disabled (toolchain-boundary defense-in-depth).
//
// Criteria:
//   A MODULE_WRITE_ONLY (RL-7)
//     A1: ranking.rs declares EXACTLY ONE #[spacetimedb::reducer], named
//         `set_profile_name`, whose body is PROFILE-UNTOUCHING — it contains
//         `validate_name(` + `player().identity().update(` and NONE of
//         `profile().identity()` / `profile().insert` / `profile().delete` /
//         `get_or_init_profile(` / `refresh_profile_name(` / `= ctx.db.profile()`.
//         (ADR-0132 refines ADR-0119 D6's original "zero reducers" tooth to
//          "exactly one profile-untouching name-setter"; the security invariant
//          "no client-callable reducer writes profile rating/W/L" is PRESERVED
//          because the one allowed reducer touches no profile table at all. The
//          allowlist body scan — not a rating:/wins: blocklist — closes the
//          mutable-binding/helper-indirection evasions, red-team F1/F2; the
//          get_or_init_profile/.insert bans close the rating-1000 leaderboard-row
//          injection hole, red-team F3; tying count-to-name closes the
//          wrong-named-rating-reducer-with-a-set_profile_name-comment evasion,
//          red-team F4.)
//     A2: ctx.db.profile() table access lives ONLY in ranking.rs
//         (intentionally coupled to ADR-0119 D6 — pt-c1's set_profile_name is
//          IN ranking.rs; if it moves elsewhere, widen the allowlist
//          in the PR, not silently — AM-8)
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
// reducerNameAfterAttr: given stripped source, locate the single
// `#[spacetimedb::reducer` attribute and return the identifier of the `fn`
// declaration that follows it (the reducer's name), or null.
//
// Robustness (red-team F4): the identifier is read char-by-char after the first
// `fn ` token past the attribute (skipping `pub`, whitespace, and any other
// attributes/tokens between the reducer attr and the fn), so the tie of
// count-to-name cannot be fooled by a `set_profile_name(` mention in a comment
// (comments are already stripped) — the name is the *actual* declared fn name.
// ---------------------------------------------------------------------------
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isIdentChar(ch) {
  return (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
  );
}
function reducerNameAfterAttr(strippedSrc) {
  const attr = '#[spacetimedb::reducer';
  const attrIdx = strippedSrc.indexOf(attr);
  if (attrIdx === -1) return null;
  // Find the first `fn ` token at/after the attribute.
  const fnIdx = strippedSrc.indexOf('fn ', attrIdx);
  if (fnIdx === -1) return null;
  // Read the identifier following `fn ` (no regex — ReDoS gate; AM-note).
  let i = fnIdx + 3;
  while (i < strippedSrc.length && isWs(strippedSrc[i])) i++;
  let ident = '';
  while (i < strippedSrc.length && isIdentChar(strippedSrc[i])) {
    ident += strippedSrc[i];
    i++;
  }
  return ident === '' ? null : ident;
}

// ---------------------------------------------------------------------------
// CHECKER A1: ranking.rs declares EXACTLY ONE #[spacetimedb::reducer], named
// `set_profile_name`, whose body is PROFILE-UNTOUCHING (ADR-0132 D3).
//
// Returns true iff ALL of:
//   1. reducer-attr count === 1 (was: 0; ADR-0132 refines the tooth).
//   2. the fn immediately after that single attr is named `set_profile_name`
//      (F4: tie count to name).
//   3. the `set_profile_name` body CONTAINS `validate_name(` AND
//      `player().identity().update(` (the name-only write, allowlist), and
//      CONTAINS NONE of the profile needles (F1/F2/F3).
// ---------------------------------------------------------------------------
const REQUIRED_NAME_REDUCER = 'set_profile_name';
// Allowlist: the reducer MUST compose these (validated write of player.name).
const A1_REQUIRED_BODY_NEEDLES = ['validate_name(', 'player().identity().update('];
// Blocklist: the reducer MUST NOT touch the profile table at all.
const A1_FORBIDDEN_BODY_NEEDLES = [
  'profile().identity()',
  'profile().insert',
  'profile().delete',
  'get_or_init_profile(',
  'refresh_profile_name(',
  '= ctx.db.profile()',
];

function checkExactlyOneNameReducer(rankingSrc) {
  const code = stripBoth(rankingSrc);
  // 1. exactly one reducer attribute.
  if (countOccurrences(code, '#[spacetimedb::reducer') !== 1) return false;
  // 2. the fn after the single attr is named set_profile_name.
  if (reducerNameAfterAttr(code) !== REQUIRED_NAME_REDUCER) return false;
  // 3. body allowlist + blocklist.
  const body = extractReducerBody(code, REQUIRED_NAME_REDUCER);
  if (body === null) return false;
  for (const needle of A1_REQUIRED_BODY_NEEDLES) {
    if (body.indexOf(needle) === -1) return false;
  }
  for (const needle of A1_FORBIDDEN_BODY_NEEDLES) {
    if (body.indexOf(needle) !== -1) return false;
  }
  return true;
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
  // Fixture A1-GOOD: exactly one clean `set_profile_name` reducer whose body
  // validates + writes ONLY player.name (touches no profile) → must PASS.
  // KILLS: a checker with a false-positive on the correct implementation shape.
  // -------------------------------------------------------------------------
  const goodNameReducerSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let me = ctx.sender;
        let mut player = match ctx.db.player().identity().find(me) {
            Some(p) => p,
            None => {
                let e = "not joined".to_string();
                log_reject("set_profile_name", me, &e);
                return Err(e);
            }
        };
        let validated = validate_name(&name).inspect_err(|e| log_reject("set_profile_name", me, e))?;
        player.name = validated;
        ctx.db.player().identity().update(player);
        Ok(())
    }
    pub(crate) fn apply_pvp_rating(ctx: &ReducerContext, battle: &Battle) {}
  `;
  if (!checkExactlyOneNameReducer(goodNameReducerSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-GOOD): checkExactlyOneNameReducer returned false for a clean ' +
        'single set_profile_name reducer that validates and writes only player.name — false positive',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-BAD-ZERO-REDUCERS: no reducer at all → must FLAG (count != 1).
  // KILLS: a checker that accepts zero reducers (the old ADR-0119 shape must no
  // longer pass — ADR-0132 requires exactly one name-setter).
  // -------------------------------------------------------------------------
  const badZeroReducersSrc = `
    pub(crate) fn get_or_init_profile(ctx: &ReducerContext, identity: Identity) -> Profile {
        match ctx.db.profile().identity().find(identity) {
            Some(p) => p,
            None => ctx.db.profile().insert(Profile { identity, rating: 1000, wins: 0, losses: 0, name: String::new() }),
        }
    }
    pub(crate) fn apply_pvp_rating(ctx: &ReducerContext, battle: &Battle) {}
  `;
  if (checkExactlyOneNameReducer(badZeroReducersSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-BAD-ZERO-REDUCERS): checkExactlyOneNameReducer returned true for a ' +
        'ranking.rs shape with zero reducers — the count must be exactly 1 (ADR-0132)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-BAD-TWO-REDUCERS: two #[spacetimedb::reducer] → must FLAG.
  // KILLS: a checker that tolerates count > 1 (a second reducer could write
  // profile rating/W/L — the module-write-only property forbids it).
  // -------------------------------------------------------------------------
  const badTwoReducersSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let mut player = match ctx.db.player().identity().find(ctx.sender) { Some(p) => p, None => return Err("x".to_string()) };
        player.name = validate_name(&name)?;
        ctx.db.player().identity().update(player);
        Ok(())
    }
    #[spacetimedb::reducer]
    pub fn boost_rating(ctx: &ReducerContext) -> Result<(), String> {
        let mut p = ctx.db.profile().identity().find(ctx.sender).unwrap();
        p.rating = 9999;
        ctx.db.profile().identity().update(p);
        Ok(())
    }
  `;
  if (checkExactlyOneNameReducer(badTwoReducersSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-BAD-TWO-REDUCERS): checkExactlyOneNameReducer returned true for a ' +
        'ranking.rs shape with two #[spacetimedb::reducer] attributes — count must be exactly 1',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-BAD-PROFILE-TOUCH-X: single set_profile_name whose body writes
  // profile via a MUTABLE BINDING (`let mut p = ...; p.rating = 9999;
  // ctx.db.profile().identity().update(p)`) → must FLAG.
  // This is the core safety tooth (red-team F1/F2): a rating:/wins: blocklist
  // would MISS this (the write is via a mutable binding, no `rating:` struct
  // literal); the allowlist (profile-untouching) catches it via the
  // `profile().identity()` forbidden needle.
  // -------------------------------------------------------------------------
  const badProfileTouchMutSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let me = ctx.sender;
        let validated = validate_name(&name)?;
        let mut p = ctx.db.profile().identity().find(me).unwrap();
        p.name = validated;
        p.rating = 9999;
        ctx.db.profile().identity().update(p);
        let mut player = ctx.db.player().identity().find(me).unwrap();
        player.name = "x".to_string();
        ctx.db.player().identity().update(player);
        Ok(())
    }
  `;
  if (checkExactlyOneNameReducer(badProfileTouchMutSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-BAD-PROFILE-TOUCH-X): checkExactlyOneNameReducer returned true for a ' +
        'set_profile_name body that writes profile via a mutable binding (p.rating = 9999; ' +
        'ctx.db.profile().identity().update(p)) — the profile-untouching allowlist must flag it (F1/F2)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-BAD-PROFILE-TOUCH-Y: single set_profile_name whose body calls
  // `get_or_init_profile(ctx, me)` (the leaderboard-injection hole, red-team F3
  // — creates a rating-1000 profile row on the public leaderboard for an
  // unrated player) → must FLAG.
  // -------------------------------------------------------------------------
  const badProfileTouchInitSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let me = ctx.sender;
        let validated = validate_name(&name)?;
        get_or_init_profile(ctx, me);
        let mut player = ctx.db.player().identity().find(me).unwrap();
        player.name = validated;
        ctx.db.player().identity().update(player);
        Ok(())
    }
  `;
  if (checkExactlyOneNameReducer(badProfileTouchInitSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-BAD-PROFILE-TOUCH-Y): checkExactlyOneNameReducer returned true for a ' +
        'set_profile_name body that calls get_or_init_profile(ctx, me) — the rating-1000 ' +
        'leaderboard-injection hole (F3) must be flagged',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-BAD-WRONG-NAME: exactly one reducer, but named `boost_rating`
  // (writes p.rating), PLUS a comment mentioning set_profile_name( → must FLAG.
  // KILLS (red-team F4): a checker that ties the tooth to a `set_profile_name`
  // token appearing anywhere (e.g. in a comment) rather than to the actual
  // declared reducer name. count == 1 but name mismatch; the stripped comment
  // must not satisfy the name check.
  // -------------------------------------------------------------------------
  const badWrongNameSrc = `
    // TODO: this should really be set_profile_name(ctx, name) but we shipped a rating booster
    #[spacetimedb::reducer]
    pub fn boost_rating(ctx: &ReducerContext) -> Result<(), String> {
        let mut p = ctx.db.profile().identity().find(ctx.sender).unwrap();
        p.rating = 9999;
        ctx.db.profile().identity().update(p);
        Ok(())
    }
  `;
  if (checkExactlyOneNameReducer(badWrongNameSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-BAD-WRONG-NAME): checkExactlyOneNameReducer returned true for a single ' +
        'reducer named boost_rating with a set_profile_name( mention only in a comment — the ' +
        'count-to-name tie (F4) must reject it (name mismatch, comment must not satisfy the check)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture A1-EVASION: a correct single set_profile_name reducer PLUS a dead
  // string literal containing `#[spacetimedb::reducer]` → after stripping, the
  // count is the real count (1) and the fixture PASSES.
  // KILLS: a checker that does not strip strings before counting (would see 2
  // reducer attrs and wrongly flag a correct module).
  // -------------------------------------------------------------------------
  const evasionReducerAttrSrc = `
    // doc: the module declares exactly one #[spacetimedb::reducer] by design
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let _dead = "#[spacetimedb::reducer] pub fn evil() { ctx.db.profile().insert(x); }";
        let mut player = match ctx.db.player().identity().find(ctx.sender) { Some(p) => p, None => return Err("not joined".to_string()) };
        player.name = validate_name(&name)?;
        ctx.db.player().identity().update(player);
        Ok(())
    }
  `;
  if (!checkExactlyOneNameReducer(evasionReducerAttrSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (A1-EVASION): checkExactlyOneNameReducer returned false on a fixture where ' +
        'an extra #[spacetimedb::reducer] and profile().insert appear only inside a string literal — ' +
        'string stripping is not working (real count is 1, body is profile-untouching)',
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
  // Criterion A1: ranking.rs declares EXACTLY ONE #[spacetimedb::reducer], named
  // `set_profile_name`, whose body is PROFILE-UNTOUCHING (ADR-0132 D3).
  // -------------------------------------------------------------------------
  if (!checkExactlyOneNameReducer(rankingSrc)) {
    // Build a specific diagnostic so the failure names the violated sub-check.
    const a1code = stripBoth(rankingSrc);
    const a1count = countOccurrences(a1code, '#[spacetimedb::reducer');
    const a1nameFound = reducerNameAfterAttr(a1code);
    const a1body = a1count === 1 ? extractReducerBody(a1code, REQUIRED_NAME_REDUCER) : null;
    let a1why;
    if (a1count !== 1) {
      a1why = `reducer-attr count is ${a1count}, must be exactly 1 (the single set_profile_name name-setter, ADR-0132)`;
    } else if (a1nameFound !== REQUIRED_NAME_REDUCER) {
      a1why = `the single reducer is named ${JSON.stringify(a1nameFound)}, must be ${JSON.stringify(REQUIRED_NAME_REDUCER)} (F4: count tied to name)`;
    } else if (a1body === null) {
      a1why = 'set_profile_name body could not be extracted (brace-matcher found no body)';
    } else {
      const missing = A1_REQUIRED_BODY_NEEDLES.filter((n) => a1body.indexOf(n) === -1);
      const present = A1_FORBIDDEN_BODY_NEEDLES.filter((n) => a1body.indexOf(n) !== -1);
      if (missing.length > 0) {
        a1why = `set_profile_name body is missing required needle(s): ${missing.join(', ')} (must validate + write player.name)`;
      } else if (present.length > 0) {
        a1why = `set_profile_name body is NOT profile-untouching — contains forbidden needle(s): ${present.join(', ')} (red-team F1/F2/F3)`;
      } else {
        a1why = 'unknown A1 sub-check failure';
      }
    }
    failures.push(
      'A1 MODULE_WRITE_ONLY (RL-7, ADR-0132 refines ADR-0119 D6): ranking.rs must declare ' +
        'EXACTLY ONE #[spacetimedb::reducer], named set_profile_name, whose body validates via ' +
        'validate_name( + writes player().identity().update( and touches NO profile table. ' +
        `Violation: ${a1why}. The one allowed reducer must be profile-untouching so the ` +
        'module-write-only security property is preserved (no client-callable reducer writes ' +
        'profile rating/W/L). Strip comments+strings before scan.',
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
      'A1 ranking.rs declares exactly one #[spacetimedb::reducer] (set_profile_name), ' +
      'whose body validates via validate_name( + writes only player().identity().update( ' +
      'and is profile-untouching (module-write-only preserved, ADR-0132); ' +
      'A2 ctx.db.profile() access lives only in ranking.rs (ADR-0119 D6); ' +
      `B1 exactly 1 path-qualified ranking::apply_pvp_rating( in pvp.rs; ` +
      `B2 bare apply_pvp_rating absent from all ${domainFiles.length} other non-test domain files (AM-1 two-needle); ` +
      'C1a chained-delete needles absent from all non-test sources; ' +
      'C1b split-binding = ctx.db.profile() absent outside ranking.rs (AM-4); ' +
      'C2 on_disconnect body contains no profile( token (ADR-0119 D1).',
  };
}
