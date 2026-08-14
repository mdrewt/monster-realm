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
//         `get_or_init_profile(` / `refresh_profile_name(` / `=ctx.db.profile()`
//         (body needles matched against WHITESPACE-COMPACTED text, M21c).
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
//         M21c: matched against WHITESPACE-COMPACTED source (see below), so a
//         rustfmt-wrapped `ctx.db\n.profile()\n.identity()\n.find(x)` in
//         accounts.rs can no longer slip past the needle.
//
//   B ONCE_ONLY_CALLSITE (RL-10) — TWO-NEEDLE strategy (AM-1, mirrors pvp_tests.rs:782)
//     B1: path-qualified `ranking::apply_pvp_rating(` in pvp.rs == 1
//     B2: bare `apply_pvp_rating` in every other non-test domain file == 0 each
//         (catches `use crate::ranking::apply_pvp_rating;` + bare-call aliasing)
//         Files read INDIVIDUALLY; filenames ending _tests.rs excluded (AM-9 F-8)
//
//   C NEVER_DELETED (RL-2)
//     C1a: chained-delete needles (`profile().identity().delete` / `profile().delete`)
//          absent in ALL non-test sources (scanned PER FILE, M21c)
//     C1b: split-binding needle `=ctx.db.profile()` absent OUTSIDE ranking.rs
//          (mirrors pvp_tests.rs:1206 needle — AM-4)
//     C2: on_disconnect body (extracted from lib.rs) contains no `profile(` token
//
//   G8 REKEY_PROFILE (M21c, ADR-0179 D6 / AUTH-23/25)
//     [G8/tombstone-arg-pin]: inside `rekey_profile`'s body, the SECOND
//          `.profile().identity().update(` call's argument must be EXACTLY
//          `tombstoned_profile(guest)` (whitespace-compacted, value-exact).
//
// -- M21c A2 corollary: WHITESPACE COMPACTION (reviewer BLOCKER B1) ------------
// Every A1-body/A2/C1a/C1b needle used to be matched against comment/string-stripped but
// UN-SQUASHED source. The live tree is rustfmt-WRAPPED — `ranking.rs:209-221` is
// literally `ctx.db\n.profile()\n.identity()\n.update(` — so a `profile` delete
// written in this repo's OWN formatting style evaded C1a entirely (red-team
// confirmed the equivalent hole elsewhere in the stack). Fix: every one of those
// needles now runs against `compactWs(stripBoth(src))` and is WRITTEN IN
// WHITESPACE-FREE FORM (hence `=ctx.db.profile()`, not `= ctx.db.profile()`).
// Verified green on the unmutated tree: `profile()` appears in exactly one
// non-test source (ranking.rs), and that file contains no `.delete` on the chain
// and no split binding. Fixtures G8-BAD-c1a-wrapped-delete /
// G8-BAD-c1b-wrapped-binding / G8-BAD-a2-wrapped-find prove the squash BITES —
// each is undetected by the pre-M21c un-squashed matcher.
//
// All strips applied (13r-c/ADR-0181): ONE string-literal-aware pass over
// comments AND string literals (evals/rust-scan.mjs), THEN compactWs, before
// every needle count. This replaced an ordered `stripRustComments` THEN
// `stripRustStrings` pipeline whose ordering was itself the bug — see the
// stripping section below and tooth [13r-c/T2]. (C2 keeps the un-squashed body
// scan — its needle `profile(` has no internal whitespace to survive and the
// body is extracted, not needled, so compaction buys nothing there.)
// No new RegExp() anywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { assertStripperSound, compactWs, countOccurrences, stripRustSource } from './rust-scan.mjs';

const SERVER_SRC = 'server-module/src';

// 13r-c: hazard characters as data, never written contiguously as literal text in
// this file's own source (this file is itself scanned by other repo scanners —
// precedent: evals/account-privacy.eval.mjs:180-185, client/src/main.wiring.test.ts:7991).
const DQ = String.fromCharCode(0x22); // "
const SLASH = String.fromCharCode(0x2f); // /

// ---------------------------------------------------------------------------
// Comment and string stripping — 13r-c (ADR-0181).
//
// WAS: `stripRustComments` THEN `stripRustStrings`, i.e. comments were stripped
// BEFORE strings. That ordering is the false-GREEN bug this slice closes. A real
// issuer URL in a literal —
//     const ISSUER: &str = <a quote>https:<slash><slash>auth.example/<a quote>;
// — lost its tail (and its CLOSING quote) to the line-comment pass, leaving ONE
// unmatched quote. `stripRustStrings` is a whole-text quote-toggle walk with no
// line boundary, so it then treated everything from that orphan quote onward as
// string data and blanked it — real code included. Tooth [13r-c/T2] pins the
// exact shape: a genuine `profile().identity().delete(` ~20 lines below such a
// const was blanked, and the RL-2/C1a ban reported PASS.
//
// NOW: one shared, single-pass, offset-preserving lexer (evals/rust-scan.mjs)
// where a slash-slash inside a literal is data and can never open a comment.
// `stripBoth` / `scanCode` keep their names so the ~25 needle call sites below
// read unchanged; only the engine underneath them changed.
// ---------------------------------------------------------------------------
function stripBoth(src) {
  return stripRustSource(src);
}

// scanCode: the canonical pipeline — strip comments AND strings in one pass,
// then squash whitespace so needles survive rustfmt line-wrapping
// (`ctx.db\n  .profile()\n  .identity()\n  .delete(x)` compiles and is exactly
// how this repo formats a 4-hop chain). EVERY needle below is written against
// this output.
function scanCode(src) {
  return compactWs(stripBoth(src));
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
// M21c: the body needles below are matched against compactWs(body), so they are
// written WHITESPACE-FREE. Without the squash a rustfmt-wrapped
// `ctx.db\n.profile()\n.identity()\n.update(p)` inside set_profile_name evades
// the blocklist — and A2 can never be the backstop here, because ranking.rs is
// A2's allowed home. Fixture: G8-BAD-a1-wrapped-profile-touch.
// Allowlist: the reducer MUST compose these (validated write of player.name).
const A1_REQUIRED_BODY_NEEDLES = ['validate_name(', 'player().identity().update('];
// Blocklist: the reducer MUST NOT touch the profile table at all.
const A1_FORBIDDEN_BODY_NEEDLES = [
  'profile().identity()',
  'profile().insert',
  'profile().delete',
  'get_or_init_profile(',
  'refresh_profile_name(',
  '=ctx.db.profile()',
];

// extractA1Body: the set_profile_name body, comment/string-stripped AND
// whitespace-compacted. Extraction happens on UN-compacted text on purpose —
// `pub fn set_profile_name(` needs its spaces to be found at all.
function extractA1Body(strippedCode) {
  const body = extractReducerBody(strippedCode, REQUIRED_NAME_REDUCER);
  return body === null ? null : compactWs(body);
}

function checkExactlyOneNameReducer(rankingSrc) {
  const code = stripBoth(rankingSrc);
  // 1. exactly one reducer attribute.
  if (countOccurrences(code, '#[spacetimedb::reducer') !== 1) return false;
  // 2. the fn after the single attr is named set_profile_name.
  if (reducerNameAfterAttr(code) !== REQUIRED_NAME_REDUCER) return false;
  // 3. body allowlist + blocklist (whitespace-compacted).
  const body = extractA1Body(code);
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
// M21c needle table. ALL of these are matched against scanCode() output, so
// they are written WHITESPACE-FREE (a space in any of them would make the
// needle unmatchable — that is the whole point of the A2 corollary).
// ---------------------------------------------------------------------------
const PROFILE_ACCESS_NEEDLE = 'ctx.db.profile()'; // A2
const C1A_CHAINED_NEEDLE = 'profile().identity().delete'; // C1a
const C1A_ALT_NEEDLE = 'profile().delete'; // C1a (alternate chain)
// C1a (UFCS). `UniqueColumn::delete(&ctx.db.profile().identity(), id)` places
// the VERB BEFORE the accessor, so neither chained needle above matches, and the
// accessor is preceded by `(&` rather than `=`, so C1b's split-binding needle
// does not match either. A red-team pass landed exactly this in
// `ranking.rs::rekey_profile` and observed it compile, pass clippy `-D warnings`
// and `fmt --check`, and leave this eval AND pvp_tests' RL-2 scan green while
// deleting a permanent ladder record. Both spellings, since `&` is optional at
// the call site depending on the receiver's binding.
const C1A_UFCS_NEEDLES = ['::delete(&ctx.db.profile()', '::delete(ctx.db.profile()'];
const C1B_SPLIT_BINDING_NEEDLE = '=ctx.db.profile()'; // C1b (was '= ctx.db.profile()')

// ---------------------------------------------------------------------------
// CHECKER A2 (needle half): does this ONE source touch the profile table?
// Extracted as a pure predicate so the A2 needle logic can be fixtured without
// touching the directory walker below (which intentionally walks the REAL tree
// — the orchestrator proves it with a live mutation, not a fixture).
// ---------------------------------------------------------------------------
function hasProfileTableAccess(src) {
  return scanCode(src).indexOf(PROFILE_ACCESS_NEEDLE) !== -1;
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
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'ranking.rs') continue; // allowed home
    if (entry.endsWith('_tests.rs')) continue; // test scaffolding, not production
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      violations.push(...findProfileAccessOutsideRanking(full));
      continue;
    }
    if (!entry.endsWith('.rs')) continue;
    // M21c: whitespace-compacted match (A2 corollary) — a rustfmt-wrapped
    // `ctx.db\n.profile()\n.identity()\n.find(from)` inlined into accounts.rs
    // is now a violation, where before it was invisible.
    if (hasProfileTableAccess(readFileSync(full, 'utf8'))) {
      violations.push(entry);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// CHECKER G8 [G8/tombstone-arg-pin] — AUTH-25 re-donation (M21c, ADR-0179 D6).
//
// `ranking.rs::rekey_profile` copies the guest's rating/W/L forward onto the
// destination row and then rewrites the guest's OWN row in place. The SECOND
// write is load-bearing and must zero the stats (`ranking.rs:178-182`): without
// the zero, the same guest identity can donate the same rating/W/L to an
// UNBOUNDED number of fresh accounts.
//
// Nothing in the repo catches the loss of the zero today. A red-team shipped
//     let (rating, wins, losses) = (guest.rating, guest.wins, guest.losses);
//     let tomb = tombstoned_profile(guest);
//     ctx.db.profile().identity()
//         .update(profile_with_carried_stats(tomb, rating, wins, losses));
// and got 78/78 evals PASS + 547/547 Rust tests PASS: the row is still renamed
// to the tombstone, `tombstoned_profile(` is still called, no row is deleted,
// and `ranking_tests.rs:636-646`'s update-COUNT pin (== 2) is preserved.
//
// The one thing that variant CANNOT preserve is the VALUE handed to the second
// update. So this clause is value-exact and deliberately spelling-exact: the
// second update's argument must compact to exactly `tombstoned_profile(guest)`.
// Any rewrap, any extra argument, any indirection through a local binding is a
// PR-visible edit to this line — which is the point.
//
// Scope note (do NOT widen): the copy-forward, two-update-count, never-delete,
// not-a-reducer and tombstone-name-untypability properties are ALREADY enforced
// for real by shipped Rust (`ranking_tests.rs:636-646` / `:651-659`,
// `accounts_tests.rs:1396`, `ranking_tests.rs:1548` which executes
// `guards::validate_name(PROFILE_TOMBSTONE_NAME).is_err()`) and by A1 above
// (reducer-attr count === 1). Restating them here would be drift-prone SSOT
// duplication; it was explicitly cut at plan review.
//
// Returns { ok: true } or { ok: false, why: string }. Fails LOUD (never skips)
// when the fn or the second update cannot be located.
// ---------------------------------------------------------------------------
const REKEY_PROFILE_FN = 'rekey_profile';
const PROFILE_UPDATE_NEEDLE = '.profile().identity().update(';
const REQUIRED_TOMBSTONE_UPDATE_ARG = 'tombstoned_profile(guest)';

// extractCallArg: given compacted text and the index of the '(' that opens an
// argument list, return the text between it and its matching ')', or null when
// the parentheses are unbalanced. No regex (nesting is not a regular language).
function extractCallArg(compacted, openParenIdx) {
  if (compacted[openParenIdx] !== '(') return null;
  let depth = 0;
  for (let i = openParenIdx; i < compacted.length; i++) {
    const ch = compacted[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return compacted.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

function checkTombstoneArgPin(rankingSrc) {
  const body = extractReducerBody(stripBoth(rankingSrc), REKEY_PROFILE_FN);
  if (body === null) {
    return {
      ok: false,
      why:
        `\`fn ${REKEY_PROFILE_FN}(\` not found in ranking.rs — the AUTH-25 zero-in-place ` +
        'pin cannot fire (fail loud, never skip)',
    };
  }
  const compact = compactWs(body);
  const updateAt = [];
  for (
    let at = compact.indexOf(PROFILE_UPDATE_NEEDLE);
    at !== -1;
    at = compact.indexOf(PROFILE_UPDATE_NEEDLE, at + PROFILE_UPDATE_NEEDLE.length)
  ) {
    updateAt.push(at);
  }
  if (updateAt.length < 2) {
    return {
      ok: false,
      why:
        `${REKEY_PROFILE_FN} body contains ${updateAt.length} \`${PROFILE_UPDATE_NEEDLE}\` call(s); ` +
        'the guest-row tombstone write (the SECOND update) is missing, so the value pin ' +
        'cannot fire (fail loud, never skip)',
    };
  }
  const openParenIdx = updateAt[1] + PROFILE_UPDATE_NEEDLE.length - 1;
  const arg = extractCallArg(compact, openParenIdx);
  if (arg === null) {
    return {
      ok: false,
      why: `unbalanced parentheses after the second \`${PROFILE_UPDATE_NEEDLE}\` in ${REKEY_PROFILE_FN}`,
    };
  }
  if (arg !== REQUIRED_TOMBSTONE_UPDATE_ARG) {
    return {
      ok: false,
      why:
        `the second \`${PROFILE_UPDATE_NEEDLE}\` argument is \`${arg}\`, must be EXACTLY ` +
        `\`${REQUIRED_TOMBSTONE_UPDATE_ARG}\``,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CHECKER D: RANKED_REQUIRES_ACCOUNT (14r-g, ADR-0189, issue #307).
//
// `challenge_pvp` and `accept_challenge` must reject unless BOTH parties hold
// an `account` row, through ONE pure `ranked_account_gate` seam per reducer,
// placed BEFORE that reducer's irreversible effect. Every human-vs-human battle
// is ranked (`is_ranked_pvp`, ADR-0119 D4), and `start_pvp_battle` — the single
// ranked-battle constructor — is reachable only from `accept_challenge`, so
// these two handshake gates are the complete cover (ADR-0189 D1).
//
// This is the toolchain-boundary twin of `pvp_tests.rs` EA-RA-02/03/04/06c: it
// runs in `just eval` even when the Rust test module is disabled. The
// behavioural half (the gate's truth table, the reason VALUES, the
// inert-until-activation canary) is NOT re-encoded here — it is executed for
// real by EA-RA-01/05/06a/06b, and a JS restatement would be drift-prone SSOT
// duplication with no extra coverage.
//
// SHAPE OF THE PIN — deliberately exact. A first-draft "does it mention
// is_account_holder?" design was beaten 7/7 by a red-team pass (discarded
// `Result`, hard-coded `true` leg, `gate(false, ..)`, swapped legs, a nested
// `if false`, a gate after the insert, a local module shim). All seven are
// killed by ONE exact-equality compacted statement needle plus a brace-depth
// fence and an ordering check, so that is what this criterion pins. Deviating
// from the statement text is therefore a PR-visible edit — which is the point.
//
// Clauses, each tagged so a fixture can assert WHICH one fired (the
// account-privacy precedent: without the tag, deleting a clause can leave the
// suite green because a neighbouring clause's message shares a word). EVERY
// clause is fail-loud — an extraction failure or a missing anchor returns
// {ok:false}, never a silent skip, including for the BAN clauses:
//   [D/fn-missing]        `fn ranked_account_gate(` exists at all.
//   [D/challenge-missing] `challenge_pvp`'s body can be extracted.
//   [D/accept-missing]    `accept_challenge`'s body can be extracted.
//   [D/challenge-stmt]    the exact compacted Guard 3a statement, count == 1.
//   [D/challenge-depth]   it sits at brace depth 0 of the reducer body.
//   [D/challenge-order]   it precedes `battle_challenge().insert(`.
//   [D/accept-stmt]       ditto, challenger leg.
//   [D/accept-depth]      ditto.
//   [D/accept-order]      it precedes `start_pvp_battle(`.
//   [D/no-has-jwt]        `has_jwt` count == 0 (true for EVERY connection —
//                         a gate keyed off it is vacuous; ADR-0189 D2).
//   [D/no-account-table]  `ctx.db.account(` count == 0 (no SSOT fork).
//   [D/ctor-cover]        `start_pvp_battle(` == 2 and `.battle().insert(` == 1.
//   [D/active-body]       the exact `ranked_enforcement_active` body.
//
// Needles are literal `indexOf`/`countOccurrences` only — NO `new RegExp(`
// anywhere (Semgrep detect-non-literal-regexp is remote-only and would fail the
// PR after every local gate has passed). They are WHITESPACE-FREE and matched
// against `compactWs(stripBoth(src))`, because the live tree is rustfmt-wrapped
// and a >100-column call is split one argument per line. Hazard characters come
// from the DQ/SLASH constants above.
// ---------------------------------------------------------------------------
const D_GATE_FN = 'ranked_account_gate';
const D_ACTIVE_FN = 'ranked_enforcement_active';
const D_HOLDER_CALL = 'crate::accounts::is_account_holder';
const D_CHALLENGE_FN = 'challenge_pvp';
const D_ACCEPT_FN = 'accept_challenge';
// Each reducer's own irreversible effect — the thing the gate must precede.
const D_CHALLENGE_EFFECT = 'battle_challenge().insert(';
const D_ACCEPT_EFFECT = 'start_pvp_battle(';
const D_HAS_JWT_NEEDLE = 'has_jwt';
const D_ACCOUNT_TABLE_NEEDLE = 'ctx.db.account(';
const D_BATTLE_INSERT_NEEDLE = '.battle().insert(';
// `fn ranked_enforcement_active() -> bool { issuers_configured(crate::accounts::ALLOWED_ISSUERS) }`
const D_ACTIVE_BODY_PIN = `fn${D_ACTIVE_FN}()->bool{issuers_configured(crate::accounts::ALLOWED_ISSUERS)}`;

// The pre-compaction spelling of the statement's opening line. Used ONLY by the
// D-GOOD-wrapped fixture, to prove the wrapped fixture really is wrapped (if
// this legacy spaced needle still matched it, the fixture would be contiguous
// and would prove nothing about the squash) — the G8-BAD-*-wrapped precedent.
const D_LEGACY_SPACED_NEEDLE = `if let Err(reason) = ${D_GATE_FN}(`;

// Build the compacted Guard 3a needle. `thirdArg` is the opponent-leg subject
// (`target` in challenge_pvp, `challenge.challenger` in accept_challenge).
// `trailingComma` selects the rustfmt-split closing form: a >100-column call is
// broken one argument per line WITH a trailing comma, which compacts to `,)`.
// The log tag's payload is BLANKED by the stripper (quotes survive, contents do
// not), so the needle carries an empty literal and this pin constrains the
// decision logic rather than the log text.
function dGuardNeedle(thirdArg, trailingComma) {
  return (
    `ifletErr(reason)=${D_GATE_FN}(` +
    `${D_ACTIVE_FN}(),` +
    `${D_HOLDER_CALL}(ctx,me),` +
    `${D_HOLDER_CALL}(ctx,${thirdArg})` +
    (trailingComma ? ',' : '') +
    `){lete=reason.to_string();log_reject(${DQ}${DQ},me,&e);returnErr(e);}`
  );
}

// Brace depth of `compacted[0..at)` — 0 means "top-level statement of the body".
function dBraceDepthAt(compacted, at) {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    if (compacted[i] === '{') depth++;
    else if (compacted[i] === '}') depth--;
  }
  return depth;
}

/**
 * Criterion D: is the ranked-requires-account gate wired into both PvP
 * handshake reducers exactly as ADR-0189 specifies?
 * @param {string} pvpSrc Raw `server-module/src/pvp.rs` source.
 * @returns {{ok: boolean, why: string}} `why` starts with the failing clause tag.
 */
export function checkRankedAccountGate(pvpSrc) {
  const code = scanCode(pvpSrc); // stripped + whitespace-compacted, whole file
  const stripped = stripBoth(pvpSrc); // stripped, UN-compacted: body extraction needs the spaces

  if (code.indexOf(`fn${D_GATE_FN}(`) === -1) {
    return {
      ok: false,
      why:
        `[D/fn-missing] pvp.rs declares no \`fn ${D_GATE_FN}(\` — the ranked-requires-account ` +
        'seam does not exist, so guests can enter ranked play through either handshake ' +
        'reducer (ADR-0189 D1/D5, issue #307). Every clause below would pass vacuously ' +
        'without this anchor (fail loud, never skip)',
    };
  }

  const legs = [
    {
      tag: 'challenge',
      fnName: D_CHALLENGE_FN,
      thirdArg: 'target',
      effect: D_CHALLENGE_EFFECT,
      effectWhat: 'the challenge row insert',
    },
    {
      tag: 'accept',
      fnName: D_ACCEPT_FN,
      thirdArg: 'challenge.challenger',
      effect: D_ACCEPT_EFFECT,
      effectWhat: 'the ranked battle construction',
    },
  ];

  const bodies = {};
  for (const leg of legs) {
    const body = extractReducerBody(stripped, leg.fnName);
    if (body === null) {
      return {
        ok: false,
        why:
          `[D/${leg.tag}-missing] \`fn ${leg.fnName}(\` could not be located in pvp.rs, so the ` +
          'ranked-account statement pin for it cannot fire. A pin that goes quiet when its ' +
          'anchor moves is worth nothing (fail loud, never skip)',
      };
    }
    bodies[leg.tag] = compactWs(body);
  }

  for (const leg of legs) {
    const compact = bodies[leg.tag];
    const plain = dGuardNeedle(leg.thirdArg, false);
    const trailing = dGuardNeedle(leg.thirdArg, true);
    const hits = countOccurrences(compact, plain) + countOccurrences(compact, trailing);
    if (hits !== 1) {
      return {
        ok: false,
        why:
          `[D/${leg.tag}-stmt] \`${leg.fnName}\` must carry the ADR-0189 Guard 3a statement ` +
          `EXACTLY ONCE; found ${hits} match(es) of the compacted pin (both the \`)\` and the ` +
          `rustfmt-split \`,)\` closing forms are accepted). This one exact-equality needle is ` +
          'what kills the seven proven evasions at once: a discarded `Result` (`let _ = ' +
          `${D_GATE_FN}(..)\`), a hard-coded \`true\`/\`false\` first argument in place of ` +
          `\`${D_ACTIVE_FN}()\`, a \`true\` literal substituted for either ` +
          '`is_account_holder` leg, swapped caller/opponent arguments, and a local ' +
          '`use crate::accounts;` shim redirecting the SSOT predicate. Expected: ' +
          `\`${trailing}\``,
      };
    }
    let at = compact.indexOf(plain);
    if (at === -1) at = compact.indexOf(trailing);

    const depth = dBraceDepthAt(compact, at);
    if (depth !== 0) {
      return {
        ok: false,
        why:
          `[D/${leg.tag}-depth] the Guard 3a statement in \`${leg.fnName}\` sits at brace depth ` +
          `${depth}, not 0. Nesting it inside \`if false { .. }\` (or any other conditional ` +
          'block) leaves the exact statement text in the file while never executing it — the ' +
          'gate must be an unconditional top-level statement of the reducer body',
      };
    }

    const effectAt = compact.indexOf(leg.effect);
    if (effectAt === -1) {
      return {
        ok: false,
        why:
          `[D/${leg.tag}-order] the irreversible-effect anchor \`${leg.effect}\` was not found ` +
          `in \`${leg.fnName}\`, so the decision-before-irreversible ordering cannot be ` +
          'checked (fail loud, never skip)',
      };
    }
    if (at > effectAt) {
      return {
        ok: false,
        why:
          `[D/${leg.tag}-order] the Guard 3a statement in \`${leg.fnName}\` is at compacted ` +
          `offset ${at}, AFTER \`${leg.effect}\` at ${effectAt}. A gate that runs once ` +
          `${leg.effectWhat} has already been committed does not gate anything`,
      };
    }
  }

  const jwtCount = countOccurrences(code, D_HAS_JWT_NEEDLE);
  if (jwtCount !== 0) {
    return {
      ok: false,
      why:
        `[D/no-has-jwt] pvp.rs references \`${D_HAS_JWT_NEEDLE}\` ${jwtCount} time(s); it must ` +
        'be 0. `has_jwt()` is true for EVERY connection — the SpacetimeDB host mints its own ' +
        'identity token even for a tokenless connect — so a ranked gate keyed off it admits ' +
        'every guest and is entirely vacuous. `crate::accounts::is_account_holder` (an ' +
        '`account`-row lookup) is the SSOT predicate (ADR-0189 D2)',
    };
  }

  const accountTableCount = countOccurrences(code, D_ACCOUNT_TABLE_NEEDLE);
  if (accountTableCount !== 0) {
    return {
      ok: false,
      why:
        `[D/no-account-table] pvp.rs touches \`${D_ACCOUNT_TABLE_NEEDLE}\` ${accountTableCount} ` +
        'time(s); it must be 0. Re-deriving "does this identity hold an account?" here forks ' +
        'the SSOT: a future change to what account-holding means (status, expiry) would ' +
        'silently miss the ranked gate. Call the accounts.rs predicate (ADR-0189 D2)',
    };
  }

  const ctorCount = countOccurrences(code, D_ACCEPT_EFFECT);
  const insertCount = countOccurrences(code, D_BATTLE_INSERT_NEEDLE);
  if (ctorCount !== 2 || insertCount !== 1) {
    return {
      ok: false,
      why:
        `[D/ctor-cover] expected exactly 2 \`${D_ACCEPT_EFFECT}\` (the definition plus its ONE ` +
        `caller, \`${D_ACCEPT_FN}\`) and exactly 1 \`${D_BATTLE_INSERT_NEEDLE}\` in pvp.rs; ` +
        `found ${ctorCount} and ${insertCount}. Gating the two handshake reducers is the ` +
        'COMPLETE cover for ranked-battle creation only while this holds (ADR-0189 D1) — a ' +
        'second constructor (a quick-match reducer, a rematch path) would build ungated ' +
        'ranked battles. Gate the new path and update ADR-0189 D1 rather than moving these ' +
        'numbers',
    };
  }

  const activeCount = countOccurrences(code, D_ACTIVE_BODY_PIN);
  if (activeCount !== 1) {
    return {
      ok: false,
      why:
        `[D/active-body] pvp.rs must define \`${D_ACTIVE_FN}\` with EXACTLY the body ` +
        '`issuers_configured(crate::accounts::ALLOWED_ISSUERS)` (compacted pin, found ' +
        `${activeCount}). The value-exact pin kills the discard mutant ` +
        '`{ let _ = issuers_configured(crate::accounts::ALLOWED_ISSUERS); false }`, which ' +
        'keeps every reference alive while wiring enforcement permanently OFF, and it ties ' +
        "activation to accounts.rs's REAL allowlist so the gate flips the day a provider " +
        'lands (ADR-0189 D6)',
    };
  }

  return { ok: true, why: '' };
}

// ---------------------------------------------------------------------------
// Criterion D fixture apparatus. ONE template builder, so a BAD fixture can
// never drift away from the GOOD one it is supposed to differ from by a single
// mutation: every fixture below is `buildDSource(<one override>)`.
// ---------------------------------------------------------------------------
const D_GUARD_CHALLENGE = `    if let Err(reason) = ranked_account_gate(
        ranked_enforcement_active(),
        crate::accounts::is_account_holder(ctx, me),
        crate::accounts::is_account_holder(ctx, target),
    ) {
        let e = reason.to_string();
        log_reject(${DQ}challenge_pvp${DQ}, me, &e);
        return Err(e);
    }`;

const D_GUARD_ACCEPT = `    if let Err(reason) = ranked_account_gate(
        ranked_enforcement_active(),
        crate::accounts::is_account_holder(ctx, me),
        crate::accounts::is_account_holder(ctx, challenge.challenger),
    ) {
        let e = reason.to_string();
        log_reject(${DQ}accept_challenge${DQ}, me, &e);
        return Err(e);
    }`;

const D_GATE_DEF = `fn ranked_account_gate(
    enforced: bool,
    caller_has_account: bool,
    opponent_has_account: bool,
) -> Result<(), &'static str> {
    if !enforced {
        return Ok(());
    }
    if !caller_has_account {
        return Err(ERR_RANKED_REQUIRES_ACCOUNT);
    }
    if !opponent_has_account {
        return Err(ERR_RANKED_OPPONENT_NEEDS_ACCOUNT);
    }
    Ok(())
}`;

const D_ACTIVE_DEF = `fn ranked_enforcement_active() -> bool {
    issuers_configured(crate::accounts::ALLOWED_ISSUERS)
}`;

const D_START_PVP_BATTLE_DEF = `pub(crate) fn start_pvp_battle(
    ctx: &ReducerContext,
    challenger: Identity,
    challenger_party_ids: Vec<u64>,
    opponent: Identity,
    opponent_party_ids: Vec<u64>,
) -> Result<u64, String> {
    let battle = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity: challenger,
        opponent_identity: opponent,
    });
    Ok(battle.battle_id)
}`;

// buildDSource: the GOOD pvp.rs shape, with named single-point overrides.
//   gateDef / activeDef       — the two seam definitions
//   challengeFn               — the whole challenge_pvp reducer (null = generated)
//   challengeGuardPre / Post  — guard slot BEFORE / AFTER the challenge insert
//   acceptGuard               — guard slot before start_pvp_battle
//   extra                     — appended source (a second ctor, a stray helper)
function buildDSource(over = {}) {
  const o = {
    gateDef: D_GATE_DEF,
    activeDef: D_ACTIVE_DEF,
    challengeFn: null,
    challengeGuardPre: D_GUARD_CHALLENGE,
    challengeGuardPost: '',
    acceptGuard: D_GUARD_ACCEPT,
    extra: '',
    ...over,
  };

  const challengeFn =
    o.challengeFn !== null
      ? o.challengeFn
      : `pub fn challenge_pvp(ctx: &ReducerContext, target: Identity, party_ids: Vec<u64>) -> Result<(), String> {
    let me = ctx.sender;
    if ctx.db.player().identity().find(me).is_none() {
        let e = ${DQ}not joined${DQ}.to_string();
        log_reject(${DQ}challenge_pvp${DQ}, me, &e);
        return Err(e);
    }
${o.challengeGuardPre}
    if let Err(e) = check_party_size(party_ids.len()) {
        log_reject(${DQ}challenge_pvp${DQ}, me, &e);
        return Err(e);
    }
    let challenge = ctx.db.battle_challenge().insert(BattleChallenge {
        challenge_id: 0,
        challenger: me,
        target,
        status: ChallengeStatus::Pending,
        created_at_ms: now_ms(ctx),
    });
${o.challengeGuardPost}
    schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms);
    Ok(())
}`;

  const acceptFn = `pub fn accept_challenge(ctx: &ReducerContext, challenge_id: u64, party_ids: Vec<u64>) -> Result<(), String> {
    let me = ctx.sender;
    let challenge = match ctx.db.battle_challenge().challenge_id().find(challenge_id) {
        Some(c) => c,
        None => return Err(${DQ}challenge not found${DQ}.to_string()),
    };
    if challenge.target != me {
        let e = ${DQ}not the challenge target${DQ}.to_string();
        log_reject(${DQ}accept_challenge${DQ}, me, &e);
        return Err(e);
    }
${o.acceptGuard}
    let battle_id = start_pvp_battle(
        ctx,
        challenge.challenger,
        challenge.challenger_party_ids.clone(),
        me,
        party_ids,
    )?;
    schedule_deadline(ctx, battle_id, 0);
    Ok(())
}`;

  const chunks = [o.gateDef, o.activeDef, challengeFn, acceptFn, D_START_PVP_BATTLE_DEF, o.extra];
  return chunks.filter((chunk) => chunk !== '').join('\n\n');
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'ranking-security (RL-16: MODULE_WRITE_ONLY A1/A2, ONCE_ONLY_CALLSITE B1/B2, NEVER_DELETED C1a/C1b/C2, RANKED_REQUIRES_ACCOUNT D)';

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
  if (
    countOccurrences(scanCode(badChainedDeleteSrc), C1A_CHAINED_NEEDLE) === 0 &&
    countOccurrences(scanCode(badChainedDeleteSrc), C1A_ALT_NEEDLE) === 0
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (C1a-BAD): chained-delete fixture has neither needle — fixture construction error',
    };
  }

  // -------------------------------------------------------------------------
  // [13r-c/T2] Fixture C1a-BAD-https-then-delete: a `https://` issuer const on
  // line 1, ~20 padding lines, THEN a genuine chained profile delete far below.
  //
  // PROVES: this file's own strip pipeline (stripBoth = stripRustStrings(
  // stripRustComments(src))) is a TWO-STAGE bug, not a one-line truncation.
  // Stage 1 (stripRustComments, regex-only, per-line `\/\/[^\n]*`): the `//`
  // inside the `https://` URL is treated as a comment start and eats the REST
  // OF LINE 1 ONLY — including the string's own closing `"`. That leaves ONE
  // unmatched `"` (the opening quote) in the text handed to stage 2.
  // Stage 2 (stripRustStrings, a character-by-character quote-toggle walk with
  // NO per-line boundary): it hits that lone unmatched `"`, enters "inside a
  // string" mode, and — because no OTHER `"` exists anywhere later in the
  // fixture — never finds a closing quote again. Every character from there to
  // EOF is blanked, including all ~20 padding lines and the real
  // `ctx.db.profile().identity().delete(who);` call. C1a's needle count on the
  // fully-stripped text is 0, even though the source contains a genuine
  // permanent-leaderboard-row DELETE (RL-2 / ADR-0119 D1).
  //
  // RED TODAY: the C1a needle count is expected to be > 0 (a real violation is
  // present) but is 0 — this whole eval-teeth section returns TEETH FAILED,
  // which is the intended RED for a not-yet-fixed stripper.
  //
  // VACUOUS IF: an implementer rewrites this fixture so the delete sits on the
  // SAME physical line as the URL const — that would only prove the
  // single-line truncation stage (already covered by
  // evals/currency-integrity.eval.mjs's T1a), not this file's DISTINCT
  // multi-line propagation through stripRustStrings. Also vacuous if any other
  // `"` character is introduced anywhere after line 1 (it would re-close the
  // string and stop the blanking early).
  // -------------------------------------------------------------------------
  const httpsIssuerLine = `const ISSUER: &str = ${DQ}https:${SLASH}${SLASH}issuer.example.com${DQ};`;
  const paddingLines = [];
  for (let i = 0; i < 20; i++) {
    paddingLines.push(`    let _pad${i} = ${i};`);
  }
  const badHttpsThenDeleteSrc = [
    httpsIssuerLine,
    'fn purge_profile(ctx: &ReducerContext, who: Identity) {',
    ...paddingLines,
    '    ctx.db.profile().identity().delete(who);',
    '}',
  ].join('\n');
  const t2Count =
    countOccurrences(scanCode(badHttpsThenDeleteSrc), C1A_CHAINED_NEEDLE) +
    countOccurrences(scanCode(badHttpsThenDeleteSrc), C1A_ALT_NEEDLE);
  if (t2Count === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED [13r-c/T2]: the C1a chained-delete needle did not fire on a fixture ' +
        `containing a genuine \`ctx.db.profile().identity().delete(who);\` call ~20 lines ` +
        `below a \`${DQ}https:${SLASH}${SLASH}...${DQ}\` issuer-URL const. ` +
        "stripRustComments' per-line `//` truncation eats line 1's closing quote, leaving " +
        'ONE unmatched `"`; stripRustStrings (a whole-text quote-toggle walk with no line ' +
        'boundary) then treats everything from there to EOF as string data and blanks it — ' +
        'including the real profile DELETE. A file could hide a permanent-leaderboard-row ' +
        'delete this way and RL-2/C1a would report PASS.',
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
  if (countOccurrences(scanCode(badSplitBindingSrc), C1B_SPLIT_BINDING_NEEDLE) === 0) {
    return {
      name,
      pass: false,
      detail:
        `TEETH FAILED (C1b-BAD): split-binding fixture does not contain \`${C1B_SPLIT_BINDING_NEEDLE}\` — ` +
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
  // M21c TEETH — the whitespace-squash blocker (A2 corollary) and G8.
  //
  // The three G8-BAD-*-wrapped-* fixtures below are the load-bearing ones: each
  // is a REAL attack written in this repo's own rustfmt style, and each asserts
  // BOTH that the squashed matcher catches it AND that the pre-M21c un-squashed
  // matcher did NOT — so the squash cannot be silently reverted.
  // =========================================================================

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-c1a-wrapped-delete: a profile delete written as a rustfmt-
  // WRAPPED chain (exactly the shape ranking.rs:209-221 already uses for its
  // updates) → must be caught by C1a.
  // KILLS: the pre-M21c C1a, which matched `profile().identity().delete`
  // against un-squashed source and therefore missed every wrapped chain — i.e.
  // a `profile` delete formatted the way this repo formats everything else.
  // -------------------------------------------------------------------------
  const badWrappedDeleteSrc = `
    fn purge_profile(ctx: &ReducerContext, id: Identity) {
        ctx.db
            .profile()
            .identity()
            .delete(id);
    }
  `;
  if (countOccurrences(scanCode(badWrappedDeleteSrc), C1A_CHAINED_NEEDLE) === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-c1a-wrapped-delete): the squashed C1a needle ' +
        `\`${C1A_CHAINED_NEEDLE}\` did not fire on a rustfmt-wrapped ` +
        '`ctx.db\\n.profile()\\n.identity()\\n.delete(id)` — whitespace compaction is not ' +
        "applied, so a profile delete in this repo's own formatting style evades RL-2",
    };
  }
  if (countOccurrences(stripBoth(badWrappedDeleteSrc), C1A_CHAINED_NEEDLE) !== 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-c1a-wrapped-delete): the fixture is matched even WITHOUT ' +
        'compaction — it is written contiguously and therefore proves nothing about the ' +
        'squash. Rewrite it wrapped across lines (fixture construction error).',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-GOOD-c1a-wrapped-update: ranking.rs's REAL wrapped update chain
  // → must NOT match either C1a delete needle after compaction.
  // KILLS: a trigger-happy squashed matcher that flags any wrapped profile
  // chain (which would false-RED the live tree on arrival).
  // -------------------------------------------------------------------------
  const goodWrappedUpdateSrc = `
    fn rekey(ctx: &ReducerContext, guest: Profile) {
        ctx.db
            .profile()
            .identity()
            .update(tombstoned_profile(guest));
    }
  `;
  if (
    countOccurrences(scanCode(goodWrappedUpdateSrc), C1A_CHAINED_NEEDLE) !== 0 ||
    countOccurrences(scanCode(goodWrappedUpdateSrc), C1A_ALT_NEEDLE) !== 0
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-GOOD-c1a-wrapped-update): a C1a delete needle fired on ' +
        "ranking.rs's legitimate wrapped `.profile().identity().update(...)` chain — the " +
        'compacted matcher is over-broad and would false-RED the unmutated tree',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-c1b-wrapped-binding: the split-binding evasion, wrapped.
  // KILLS: the pre-M21c C1b needle `= ctx.db.profile()` (one literal space),
  // which misses `let p = ctx.db\n    .profile();` — the exact evasion C1b
  // exists to close, written in the repo's own style.
  // -------------------------------------------------------------------------
  const badWrappedSplitBindingSrc = `
    fn reset_profile(ctx: &ReducerContext, id: Identity) {
        let p = ctx.db
            .profile();
        p.identity().delete(id);
    }
  `;
  if (countOccurrences(scanCode(badWrappedSplitBindingSrc), C1B_SPLIT_BINDING_NEEDLE) === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-c1b-wrapped-binding): the squashed C1b needle ' +
        `\`${C1B_SPLIT_BINDING_NEEDLE}\` did not fire on a wrapped split binding ` +
        '(`let p = ctx.db\\n.profile();`) — compaction is not applied',
    };
  }
  if (countOccurrences(stripBoth(badWrappedSplitBindingSrc), '= ctx.db.profile()') !== 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-c1b-wrapped-binding): fixture construction error — the ' +
        'pre-M21c spaced needle already matches it, so it proves nothing about the squash',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-GOOD-c1b-match-read: ranking.rs's `let guest = match ctx.db
  // .profile()...` read form → must NOT match the compacted C1b needle.
  // KILLS: the naive assumption that compaction makes `=ctx.db.profile()`
  // match everything — `= match ctx.db.profile()` compacts to
  // `=matchctx.db.profile()`, which must stay clean. This is exactly why
  // ranking.rs:202-204 reads via `match` and documents it.
  // -------------------------------------------------------------------------
  const goodMatchReadSrc = `
    fn read_profile(ctx: &ReducerContext, from: Identity) {
        let guest = match ctx.db.profile().identity().find(from) {
            Some(g) => g,
            None => return,
        };
    }
  `;
  if (countOccurrences(scanCode(goodMatchReadSrc), C1B_SPLIT_BINDING_NEEDLE) !== 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-GOOD-c1b-match-read): the compacted C1b needle fired on a ' +
        '`let guest = match ctx.db.profile()...` READ — that is the sanctioned form ' +
        '(ranking.rs:202-204) and flagging it would false-RED the live tree',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-GOOD-a2-accounts-delegates (ADR-0179 G8): an accounts.rs-shaped
  // source that reaches the profile table ONLY through the ranking module's
  // pub(crate) seams → A2's needle must NOT fire.
  // KILLS: an A2 needle so broad that the sanctioned M21a delegation shape
  // (`crate::ranking::rekey_profile(` / `crate::ranking::profile_exists(`)
  // counts as profile table access — which would RED the merged tree.
  // -------------------------------------------------------------------------
  const goodAccountsDelegatesSrc = `
    pub(crate) fn account_has_game_data(ctx: &ReducerContext, identity: Identity) -> bool {
        crate::economy::wallet_exists(ctx, identity)
            || crate::ranking::profile_exists(ctx, identity)
            || crate::raising::has_heal_cooldown(ctx, identity)
    }
    pub(crate) fn rekey_all(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
        crate::economy::rekey_wallet(ctx, from, to);
        crate::ranking::rekey_profile(ctx, from, to);
        Ok(())
    }
  `;
  if (hasProfileTableAccess(goodAccountsDelegatesSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-GOOD-a2-accounts-delegates): A2 flagged an accounts.rs-shaped ' +
        'source that only calls crate::ranking::rekey_profile( / crate::ranking::profile_exists( — ' +
        'delegating through the ranking seams is the sanctioned shape (ADR-0179 D6) and must stay green',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-a2-inline-find: accounts.rs inlining the table access.
  // KILLS: an A2 that only looks at ranking.rs, or that trusts the delegation
  // convention instead of scanning for the accessor.
  // -------------------------------------------------------------------------
  const badAccountsInlineSrc = `
    pub(crate) fn rekey_all(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
        if let Some(g) = ctx.db.profile().identity().find(from) {
            let _ = g;
        }
        Ok(())
    }
  `;
  if (!hasProfileTableAccess(badAccountsInlineSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-a2-inline-find): A2 did not flag an accounts.rs-shaped source ' +
        'that inlines `ctx.db.profile().identity().find(from)` — profile table access must ' +
        'live only in ranking.rs (ADR-0119 D6)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-a2-wrapped-find: the SAME inline access, rustfmt-wrapped.
  // KILLS: the pre-M21c A2 needle (un-squashed `ctx.db.profile()`), which a
  // wrapped `ctx\n.db\n.profile()` chain walked straight past.
  // -------------------------------------------------------------------------
  const badAccountsWrappedSrc = `
    pub(crate) fn rekey_all(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
        let guest = ctx
            .db
            .profile()
            .identity()
            .find(from);
        let _ = guest;
        Ok(())
    }
  `;
  if (!hasProfileTableAccess(badAccountsWrappedSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-a2-wrapped-find): A2 did not flag a rustfmt-WRAPPED ' +
        '`ctx\\n.db\\n.profile()\\n.identity()\\n.find(from)` — compaction is not applied to A2',
    };
  }
  if (stripBoth(badAccountsWrappedSrc).indexOf(PROFILE_ACCESS_NEEDLE) !== -1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-a2-wrapped-find): fixture construction error — the un-squashed ' +
        'needle already matches, so the fixture proves nothing about the squash',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-a1-wrapped-profile-touch: a single `set_profile_name` whose
  // body writes the profile table through a rustfmt-WRAPPED chain → must FLAG.
  // KILLS: the same squash hole one layer in — A1's forbidden needle
  // `profile().identity()` was matched against un-squashed body text, so the
  // wrapped form of the F1/F2 rating write slipped through A1 *and* through A2
  // (ranking.rs is A2's allowed home, so A2 can never be the backstop here).
  // -------------------------------------------------------------------------
  const badWrappedProfileTouchSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let me = ctx.sender;
        let validated = validate_name(&name)?;
        let mut p = ctx.db
            .profile()
            .identity()
            .find(me)
            .unwrap();
        p.rating = 9999;
        ctx.db
            .profile()
            .identity()
            .update(p);
        let mut player = ctx.db.player().identity().find(me).unwrap();
        player.name = validated;
        ctx.db.player().identity().update(player);
        Ok(())
    }
  `;
  if (checkExactlyOneNameReducer(badWrappedProfileTouchSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-a1-wrapped-profile-touch): checkExactlyOneNameReducer returned ' +
        'true for a set_profile_name body that sets p.rating = 9999 and writes it back through ' +
        "a rustfmt-WRAPPED `ctx.db\\n.profile()\\n.identity()\\n.update(p)` chain — A1's " +
        'profile-untouching blocklist must run on whitespace-compacted body text',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-GOOD-a1-rekey-not-a-reducer (ADR-0179 G8, the literal ask):
  // ranking.rs shaped as it is on master — ONE `set_profile_name` reducer plus
  // the non-reducer `pub(crate) fn rekey_profile` / `profile_exists` seams →
  // checkExactlyOneNameReducer must return TRUE (rekey_profile does not change
  // A1's reducer count) AND [G8/tombstone-arg-pin] must be satisfied.
  // KILLS: an A1 that counts `fn`s or profile touches file-wide rather than
  // inside the single reducer's body — such a checker would RED the merged
  // M21a tree, which is exactly what ADR-0179 G8 asks us to prove cannot happen.
  // -------------------------------------------------------------------------
  const goodRekeyProfileSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let mut player = match ctx.db.player().identity().find(ctx.sender) {
            Some(p) => p,
            None => return Err("not joined".to_string()),
        };
        player.name = validate_name(&name)?;
        ctx.db.player().identity().update(player);
        Ok(())
    }
    pub(crate) fn rekey_profile(ctx: &ReducerContext, from: Identity, to: Identity) {
        let guest = match ctx.db.profile().identity().find(from) {
            Some(g) => g,
            None => return,
        };
        let dest = get_or_init_profile(ctx, to);
        ctx.db
            .profile()
            .identity()
            .update(profile_with_carried_stats(
                dest,
                guest.rating,
                guest.wins,
                guest.losses,
            ));
        ctx.db
            .profile()
            .identity()
            .update(tombstoned_profile(guest));
    }
    pub(crate) fn profile_exists(ctx: &ReducerContext, identity: Identity) -> bool {
        ctx.db.profile().identity().find(identity).is_some()
    }
  `;
  if (!checkExactlyOneNameReducer(goodRekeyProfileSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-GOOD-a1-rekey-not-a-reducer): checkExactlyOneNameReducer returned ' +
        'false for a ranking.rs carrying one set_profile_name reducer plus the non-reducer ' +
        'pub(crate) rekey_profile / profile_exists seams — the M21a re-key seams must not ' +
        "change A1's reducer count (ADR-0179 G8)",
    };
  }
  const goodPin = checkTombstoneArgPin(goodRekeyProfileSrc);
  if (!goodPin.ok) {
    return {
      name,
      pass: false,
      detail:
        '[G8/tombstone-arg-pin] TEETH FAILED (G8-GOOD-a1-rekey-not-a-reducer): the pin ' +
        `rejected the real rekey_profile body — ${goodPin.why}`,
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-a1-rekey-is-a-reducer: the same source with rekey_profile
  // carrying #[spacetimedb::reducer] → must FLAG.
  // KILLS: any relaxation of A1's `count === 1` that would let the re-key seam
  // become client-callable — a reducer that hands one identity's rating/W/L to
  // an arbitrary `to` is an unauthenticated ladder transfer.
  // -------------------------------------------------------------------------
  const badRekeyIsReducerSrc = `
    #[spacetimedb::reducer]
    pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
        let mut player = match ctx.db.player().identity().find(ctx.sender) {
            Some(p) => p,
            None => return Err("not joined".to_string()),
        };
        player.name = validate_name(&name)?;
        ctx.db.player().identity().update(player);
        Ok(())
    }
    #[spacetimedb::reducer]
    pub fn rekey_profile(ctx: &ReducerContext, from: Identity, to: Identity) {
        let guest = match ctx.db.profile().identity().find(from) {
            Some(g) => g,
            None => return,
        };
        let dest = get_or_init_profile(ctx, to);
        ctx.db.profile().identity().update(profile_with_carried_stats(dest, guest.rating, guest.wins, guest.losses));
        ctx.db.profile().identity().update(tombstoned_profile(guest));
    }
  `;
  if (checkExactlyOneNameReducer(badRekeyIsReducerSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (G8-BAD-a1-rekey-is-a-reducer): checkExactlyOneNameReducer returned true ' +
        'for a ranking.rs where rekey_profile carries #[spacetimedb::reducer] — the re-key seam ' +
        'must never be client-callable (reducer-attr count must be exactly 1)',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-tombstone-rewrapped [G8/tombstone-arg-pin]: the PROVEN
  // AUTH-25 re-donation hole. `tombstoned_profile(guest)` is still called, the
  // row is still renamed, no row is deleted, and there are still exactly two
  // profile updates — but the tombstone's zeroed stats are immediately
  // overwritten with the guest's ORIGINAL rating/W/L, so the same guest
  // identity can donate the same stats to unbounded fresh accounts.
  // KILLS: every weaker G8 formulation — copy-forward presence, update COUNT
  // (ranking_tests.rs:636-646 pins == 2 and this preserves it), never-delete,
  // and `tombstoned_profile(` presence. This exact source scored 78/78 evals
  // PASS and 547/547 Rust tests PASS before this clause existed.
  // -------------------------------------------------------------------------
  const badTombstoneRewrappedSrc = `
    pub(crate) fn rekey_profile(ctx: &ReducerContext, from: Identity, to: Identity) {
        let guest = match ctx.db.profile().identity().find(from) {
            Some(g) => g,
            None => return,
        };
        let dest = get_or_init_profile(ctx, to);
        let (rating, wins, losses) = (guest.rating, guest.wins, guest.losses);
        ctx.db
            .profile()
            .identity()
            .update(profile_with_carried_stats(dest, rating, wins, losses));
        let tomb = tombstoned_profile(guest);
        ctx.db
            .profile()
            .identity()
            .update(profile_with_carried_stats(tomb, rating, wins, losses));
    }
  `;
  const badRewrapPin = checkTombstoneArgPin(badTombstoneRewrappedSrc);
  if (badRewrapPin.ok) {
    return {
      name,
      pass: false,
      detail:
        '[G8/tombstone-arg-pin] TEETH FAILED (G8-BAD-tombstone-rewrapped): the pin accepted a ' +
        "rekey_profile whose second profile update re-applies the guest's original " +
        'rating/wins/losses on top of the tombstone (AUTH-25 unbounded re-donation). The ' +
        'second update argument must be EXACTLY tombstoned_profile(guest).',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-tombstone-missing [G8/tombstone-arg-pin], fail-loud half:
  // a rekey_profile with NO second profile update at all → the clause must go
  // RED ("cannot fire"), never silently skip.
  // KILLS: a pin that returns ok when it cannot locate the second update —
  // an attacker would then simply restructure the write out of needle range
  // and inherit a green gate.
  // -------------------------------------------------------------------------
  const badTombstoneMissingSrc = `
    pub(crate) fn rekey_profile(ctx: &ReducerContext, from: Identity, to: Identity) {
        let guest = match ctx.db.profile().identity().find(from) {
            Some(g) => g,
            None => return,
        };
        let dest = get_or_init_profile(ctx, to);
        ctx.db
            .profile()
            .identity()
            .update(profile_with_carried_stats(dest, guest.rating, guest.wins, guest.losses));
    }
  `;
  if (checkTombstoneArgPin(badTombstoneMissingSrc).ok) {
    return {
      name,
      pass: false,
      detail:
        '[G8/tombstone-arg-pin] TEETH FAILED (G8-BAD-tombstone-missing): the pin returned ok ' +
        'for a rekey_profile with only ONE profile update — the guest row keeps its full ' +
        'rating/W/L. The clause must fail LOUD when the second update cannot be located.',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture G8-BAD-tombstone-no-fn [G8/tombstone-arg-pin], fail-loud half:
  // rekey_profile renamed/removed → the clause must go RED, not vacuously pass.
  // KILLS: a pin that treats "function not found" as success.
  // -------------------------------------------------------------------------
  const badTombstoneNoFnSrc = `
    pub(crate) fn profile_exists(ctx: &ReducerContext, identity: Identity) -> bool {
        ctx.db.profile().identity().find(identity).is_some()
    }
  `;
  if (checkTombstoneArgPin(badTombstoneNoFnSrc).ok) {
    return {
      name,
      pass: false,
      detail:
        '[G8/tombstone-arg-pin] TEETH FAILED (G8-BAD-tombstone-no-fn): the pin returned ok for ' +
        'a ranking.rs with no rekey_profile at all — a missing anchor must be RED, never a skip',
    };
  }

  // =========================================================================
  // CRITERION D TEETH — ranked-requires-account gate (14r-g, ADR-0189)
  //
  // Every fixture is `buildDSource(<one override>)`, so a BAD fixture can only
  // differ from the GOOD one by the single mutation it is named after — the
  // drift failure mode where a "bad" fixture is really bad for an unrelated
  // reason (and the clause under test never fires) cannot occur here.
  //
  // Each BAD fixture asserts its SPECIFIC clause tag via `why.startsWith`. A
  // bare "returned not-ok" assertion would keep passing after a clause is
  // deleted, because a neighbouring clause would fire instead.
  // =========================================================================

  // -------------------------------------------------------------------------
  // Fixture D-GOOD: the sanctioned ADR-0189 shape → must PASS.
  // KILLS: a checker whose needle is unsatisfiable by the planned
  // implementation (a false-positive gate is a gate the implementer deletes).
  // -------------------------------------------------------------------------
  const dGoodSrc = buildDSource();
  const dGood = checkRankedAccountGate(dGoodSrc);
  if (!dGood.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (D-GOOD): checkRankedAccountGate rejected the sanctioned ADR-0189 ' +
        `implementation shape — the pin is unsatisfiable. Reported: ${dGood.why}`,
    };
  }
  if (stripBoth(dGoodSrc).indexOf(D_LEGACY_SPACED_NEEDLE) === -1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (D-GOOD): fixture construction error — the contiguous GOOD fixture ' +
        `does not contain the un-compacted spelling \`${D_LEGACY_SPACED_NEEDLE}\`, so the ` +
        'D-GOOD-wrapped squash proof below would be vacuous',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture D-GOOD-wrapped: the SAME statement, rustfmt-wrapped across lines
  // (which is how the live tree is actually formatted — a >100-column call is
  // split one argument per line) → must PASS, and must NOT be matchable
  // without the whitespace squash.
  // KILLS: a criterion-D that pins the statement in its spaced spelling. That
  // version reports GREEN on the wrapped tree only by accident and goes RED the
  // first time rustfmt rewraps the call — so it would be "fixed" by weakening,
  // which is exactly how a security gate dies. The second assertion is the
  // G8-BAD-*-wrapped precedent: prove the fixture really is wrapped, otherwise
  // it proves nothing about the squash.
  // -------------------------------------------------------------------------
  const dWrappedGuard = `    if let Err(reason) =
        ranked_account_gate(
            ranked_enforcement_active(),
            crate::accounts::is_account_holder(
                ctx, me),
            crate::accounts::is_account_holder(ctx,
                target),
        )
    {
        let e =
            reason.to_string();
        log_reject(
            ${DQ}challenge_pvp${DQ}, me, &e);
        return Err(e);
    }`;
  const dWrappedSrc = buildDSource({ challengeGuardPre: dWrappedGuard });
  // Body-scoped on purpose: the fixture's ACCEPT guard is still contiguous, so a
  // whole-file check would find the legacy spelling there and mis-report this as
  // a construction error.
  const dWrappedChallengeBody = extractReducerBody(stripBoth(dWrappedSrc), D_CHALLENGE_FN);
  if (
    dWrappedChallengeBody === null ||
    dWrappedChallengeBody.indexOf(D_LEGACY_SPACED_NEEDLE) !== -1
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (D-GOOD-wrapped): fixture construction error — challenge_pvp is ' +
        `unextractable, or its body is still matched by the un-compacted spelling ` +
        `\`${D_LEGACY_SPACED_NEEDLE}\`, meaning the guard was written contiguously and the ` +
        'fixture proves nothing about the whitespace squash',
    };
  }
  const dWrapped = checkRankedAccountGate(dWrappedSrc);
  if (!dWrapped.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (D-GOOD-wrapped): checkRankedAccountGate rejected a correct gate that ' +
        'is merely rustfmt-WRAPPED across lines. Every needle must be matched against ' +
        `compactWs(stripBoth(src)) and written whitespace-free. Reported: ${dWrapped.why}`,
    };
  }

  // -------------------------------------------------------------------------
  // BAD fixtures: one mutation each, one clause tag each.
  // `constructed` proves the mutation actually landed in the fixture BEFORE the
  // checker runs, so a broken fixture is reported as a fixture bug rather than
  // silently turning the tooth vacuous.
  // -------------------------------------------------------------------------
  const dGuardTrailingNeedleChallenge = dGuardNeedle('target', true);
  const dBadFixtures = [
    {
      // The whole seam deleted: guests keep full ranked access (issue #307).
      label: 'D-BAD-absent',
      tag: '[D/fn-missing]',
      what: 'a pvp.rs with no ranked_account_gate seam and no guard at either handshake',
      src: buildDSource({ gateDef: '', challengeGuardPre: '', acceptGuard: '' }),
      constructed: (src) => scanCode(src).indexOf(`fn${D_GATE_FN}(`) === -1,
      constructedWhy: `the fixture still declares \`fn ${D_GATE_FN}(\``,
    },
    {
      // The anchor vanished: every downstream clause must NOT go vacuously green.
      label: 'D-BAD-challenge-missing',
      tag: '[D/challenge-missing]',
      what: 'a pvp.rs whose challenge_pvp reducer cannot be located at all',
      src: buildDSource({ challengeFn: '' }),
      constructed: (src) => extractReducerBody(stripBoth(src), D_CHALLENGE_FN) === null,
      constructedWhy: 'challenge_pvp is still extractable from the fixture',
    },
    {
      // Compiles, is clippy-clean (let_underscore_must_use is off by default),
      // and rejects nobody: the gate is evaluated and thrown away.
      label: 'D-BAD-discarded-result',
      tag: '[D/challenge-stmt]',
      what: 'a challenge_pvp that computes the gate and DISCARDS its Result (`let _ = ..`)',
      src: buildDSource({
        challengeGuardPre: `    let _ = ranked_account_gate(
        ranked_enforcement_active(),
        crate::accounts::is_account_holder(ctx, me),
        crate::accounts::is_account_holder(ctx, target),
    );`,
      }),
      constructed: (src) => scanCode(src).indexOf(`let_=${D_GATE_FN}(`) !== -1,
      constructedWhy: 'the discard spelling `let _ = ranked_account_gate(` is not in the fixture',
    },
    {
      // The caller leg hard-wired to "holds an account": half the gate is dead.
      label: 'D-BAD-true-literal',
      tag: '[D/challenge-stmt]',
      what: 'a challenge_pvp whose CALLER leg is a hard-coded `true` instead of the predicate',
      src: buildDSource({
        challengeGuardPre: D_GUARD_CHALLENGE.replace(`${D_HOLDER_CALL}(ctx, me)`, 'true'),
      }),
      constructed: (src) => scanCode(src).indexOf(`${D_ACTIVE_FN}(),true,`) !== -1,
      constructedWhy: 'the `true` literal did not replace the caller-leg predicate',
    },
    {
      // Enforcement pinned OFF at the call site: the seam is decorative.
      label: 'D-BAD-enforced-false',
      tag: '[D/challenge-stmt]',
      what: 'a challenge_pvp that passes a literal `false` for the enforced flag',
      src: buildDSource({
        challengeGuardPre: D_GUARD_CHALLENGE.replace(`${D_ACTIVE_FN}()`, 'false'),
      }),
      constructed: (src) => scanCode(src).indexOf(`${D_GATE_FN}(false,`) !== -1,
      constructedWhy: 'the `false` literal did not replace ranked_enforcement_active()',
    },
    {
      // Legs transposed: the caller is told the OPPONENT needs an account and
      // vice versa — the parked client affordance then prompts the wrong player.
      label: 'D-BAD-swapped-legs',
      tag: '[D/challenge-stmt]',
      what: 'a challenge_pvp whose caller and opponent legs are transposed',
      src: buildDSource({
        challengeGuardPre: D_GUARD_CHALLENGE.replace('(ctx, me),', '(ctx, __swap__),')
          .replace('(ctx, target),', '(ctx, me),')
          .replace('(ctx, __swap__),', '(ctx, target),'),
      }),
      constructed: (src) =>
        scanCode(src).indexOf(`${D_HOLDER_CALL}(ctx,target),${D_HOLDER_CALL}(ctx,me),`) !== -1,
      constructedWhy: 'the two legs are not transposed in the fixture',
    },
    {
      // The exact statement text survives verbatim; it just never executes.
      label: 'D-BAD-unreachable-if',
      tag: '[D/challenge-depth]',
      what: 'a challenge_pvp whose gate is nested inside an `if false { .. }` block',
      src: buildDSource({
        challengeGuardPre: `    if false {\n${D_GUARD_CHALLENGE}\n    }`,
      }),
      constructed: (src) => scanCode(src).indexOf('iffalse{ifletErr(reason)=') !== -1,
      constructedWhy: 'the gate is not nested inside `if false {` in the fixture',
    },
    {
      // The challenge row is already committed when the reject returns.
      label: 'D-BAD-after-insert',
      tag: '[D/challenge-order]',
      what: 'a challenge_pvp whose gate runs AFTER the battle_challenge insert',
      src: buildDSource({ challengeGuardPre: '', challengeGuardPost: D_GUARD_CHALLENGE }),
      constructed: (src) => {
        const body = extractReducerBody(stripBoth(src), D_CHALLENGE_FN);
        if (body === null) return false;
        const compact = compactWs(body);
        const at = compact.indexOf(dGuardTrailingNeedleChallenge);
        const effectAt = compact.indexOf(D_CHALLENGE_EFFECT);
        return at !== -1 && effectAt !== -1 && at > effectAt;
      },
      constructedWhy: 'the gate is not positioned after the insert in the fixture',
    },
    {
      // Challenge-time only. ADR-0189 D3: the accept-time re-check is the
      // enforcement point (pre-activation Pending rows, future revocation).
      label: 'D-BAD-accept-gateless',
      tag: '[D/accept-stmt]',
      what: 'a pvp.rs that gates challenge_pvp but leaves accept_challenge ungated',
      src: buildDSource({ acceptGuard: '' }),
      constructed: (src) => {
        const body = extractReducerBody(stripBoth(src), D_ACCEPT_FN);
        return body !== null && compactWs(body).indexOf(`${D_GATE_FN}(`) === -1;
      },
      constructedWhy: 'accept_challenge still references ranked_account_gate in the fixture',
    },
    {
      // has_jwt() is true for EVERY connection: the vacuous-predicate trap.
      label: 'D-BAD-has-jwt',
      tag: '[D/no-has-jwt]',
      what: 'a pvp.rs that reaches for has_jwt() (true for every connection, ADR-0189 D2)',
      src: buildDSource({
        extra: `fn peek_token(ctx: &ReducerContext) -> bool {
    ctx.sender_auth().has_jwt()
}`,
      }),
      constructed: (src) => scanCode(src).indexOf(D_HAS_JWT_NEEDLE) !== -1,
      constructedWhy: 'the fixture does not reference has_jwt',
    },
    {
      // SSOT fork: account-holding re-derived locally.
      label: 'D-BAD-inline-table',
      tag: '[D/no-account-table]',
      what: 'a pvp.rs that re-derives account-holding from the account table inline',
      src: buildDSource({
        extra: `fn holds_account(ctx: &ReducerContext, id: Identity) -> bool {
    ctx.db.account().identity().find(id).is_some()
}`,
      }),
      constructed: (src) => scanCode(src).indexOf(D_ACCOUNT_TABLE_NEEDLE) !== -1,
      constructedWhy: 'the fixture does not touch ctx.db.account(',
    },
    {
      // A second ranked-battle constructor: both handshake gates stay perfect
      // and ranked battles are created past them anyway (ADR-0189 D1).
      label: 'D-BAD-second-ctor',
      tag: '[D/ctor-cover]',
      what: 'a pvp.rs with a SECOND reducer that calls start_pvp_battle (quick-match path)',
      src: buildDSource({
        extra: `pub fn quick_match(ctx: &ReducerContext, opponent: Identity, party_ids: Vec<u64>) -> Result<(), String> {
    let me = ctx.sender;
    let battle_id = start_pvp_battle(ctx, me, party_ids.clone(), opponent, party_ids)?;
    schedule_deadline(ctx, battle_id, 0);
    Ok(())
}`,
      }),
      constructed: (src) => countOccurrences(scanCode(src), D_ACCEPT_EFFECT) === 3,
      constructedWhy: 'the fixture does not contain a third start_pvp_battle( occurrence',
    },
    {
      // Enforcement wired permanently OFF while every reference stays alive —
      // a "is issuers_configured referenced?" check would report GREEN.
      label: 'D-BAD-active-discard',
      tag: '[D/active-body]',
      what: 'a ranked_enforcement_active that discards issuers_configured and returns `false`',
      src: buildDSource({
        activeDef: `fn ranked_enforcement_active() -> bool {
    let _ = issuers_configured(crate::accounts::ALLOWED_ISSUERS);
    false
}`,
      }),
      constructed: (src) =>
        countOccurrences(scanCode(src), D_ACTIVE_BODY_PIN) === 0 &&
        scanCode(src).indexOf('issuers_configured(crate::accounts::ALLOWED_ISSUERS)') !== -1,
      constructedWhy:
        'the fixture either still matches the exact body pin or dropped the ' +
        'issuers_configured reference the mutation is supposed to preserve',
    },
  ];

  for (const fixture of dBadFixtures) {
    if (!fixture.constructed(fixture.src)) {
      return {
        name,
        pass: false,
        detail: `TEETH FAILED (${fixture.label}): fixture construction error — ${fixture.constructedWhy}`,
      };
    }
    const dResult = checkRankedAccountGate(fixture.src);
    if (dResult.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH FAILED (${fixture.label}): checkRankedAccountGate returned ok for ` +
          `${fixture.what} — clause ${fixture.tag} must fire (ADR-0189)`,
      };
    }
    if (!dResult.why.startsWith(fixture.tag)) {
      return {
        name,
        pass: false,
        detail:
          `TEETH FAILED (${fixture.label}): ${fixture.what} must be caught by clause ` +
          `${fixture.tag}, but the checker reported: ${dResult.why}`,
      };
    }
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

  // 13r-c (ADR-0181) STRIPPER-SOUNDNESS GATE, per file. A desync GREENS every
  // ban below and reds only the presence checks, so it is invisible to the very
  // clauses it blinds — it must be caught here. Covers the three named sources
  // plus every enumerated non-test domain file.
  for (const { label, src } of [
    { label: 'ranking.rs', src: rankingSrc },
    { label: 'pvp.rs', src: pvpSrc },
    { label: 'lib.rs', src: libSrc },
    ...domainFiles.map((f) => ({ label: f.name, src: f.src })),
  ]) {
    const desync = assertStripperSound(src, `${SERVER_SRC}/${label}`);
    if (desync !== null) failures.push(desync);
  }

  // -------------------------------------------------------------------------
  // Criterion A1: ranking.rs declares EXACTLY ONE #[spacetimedb::reducer], named
  // `set_profile_name`, whose body is PROFILE-UNTOUCHING (ADR-0132 D3).
  // -------------------------------------------------------------------------
  if (!checkExactlyOneNameReducer(rankingSrc)) {
    // Build a specific diagnostic so the failure names the violated sub-check.
    const a1code = stripBoth(rankingSrc);
    const a1count = countOccurrences(a1code, '#[spacetimedb::reducer');
    const a1nameFound = reducerNameAfterAttr(a1code);
    const a1body = a1count === 1 ? extractA1Body(a1code) : null;
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
  // Criterion C1a: chained-delete needles absent in ALL non-test sources.
  //
  // M21c: scanned PER FILE (never a concatenated blob) and WHITESPACE-COMPACTED.
  // Per-file matters now that the text is squashed — joining first would let one
  // file's trailing `...profile()` fuse with the next file's leading
  // `.identity().delete` and manufacture a phantom violation.
  // Subdirectory note: this enumeration is flat (server-module/src is flat);
  // A2's walker above DOES recurse, so a profile accessor hidden in a future
  // subdirectory is still caught there.
  // -------------------------------------------------------------------------
  let allNonTestFiles;
  try {
    allNonTestFiles = readdirSync(SERVER_SRC)
      .filter((f) => f.endsWith('.rs') && !f.endsWith('_tests.rs'))
      .sort()
      .map((f) => ({ name: f, src: readFileSync(`${SERVER_SRC}/${f}`, 'utf8') }));
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `cannot read server-module sources for C1 scan: ${e.message}`,
    };
  }

  for (const { name: fileName, src } of allNonTestFiles) {
    const code = scanCode(src);
    if (countOccurrences(code, C1A_CHAINED_NEEDLE) > 0) {
      failures.push(
        `C1a NEVER_DELETED (RL-2): found \`${C1A_CHAINED_NEEDLE}\` in ${fileName} — ` +
          'profile rows must NEVER be deleted (persistent leaderboard, ADR-0119 D1). ' +
          'This needle catches the chained-delete form, INCLUDING the rustfmt-wrapped ' +
          '`ctx.db\\n.profile()\\n.identity()\\n.delete(x)` spelling (M21c whitespace squash).',
      );
    }
    if (countOccurrences(code, C1A_ALT_NEEDLE) > 0) {
      failures.push(
        `C1a NEVER_DELETED (RL-2): found \`${C1A_ALT_NEEDLE}\` in ${fileName} — ` +
          'profile rows must NEVER be deleted (persistent leaderboard, ADR-0119 D1). ' +
          'This needle catches the alternate chained-delete form.',
      );
    }
    for (const ufcs of C1A_UFCS_NEEDLES) {
      if (countOccurrences(code, ufcs) > 0) {
        failures.push(
          `C1a NEVER_DELETED (RL-2): found \`${ufcs}\` in ${fileName} — a UFCS delete ` +
            'reaches the profile table with the VERB BEFORE the accessor, so both chained ' +
            'needles and C1b’s split-binding needle are blind to it. Profile rows must ' +
            'NEVER be deleted (persistent leaderboard, ADR-0119 D1); the guest→account ' +
            're-key tombstones IN PLACE (AUTH-23 / ADR-0179 D6).',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Criterion C1b: split-binding `=ctx.db.profile()` absent OUTSIDE ranking.rs
  // (AM-4 — mirrors pvp_tests.rs:1206 split-binding needle)
  //
  // Scan set = domainFiles (all non-test files except ranking.rs and pvp.rs)
  // PLUS pvp.rs explicitly (pvp.rs is excluded from domainFiles for B1/B2 reasons
  // but must still be checked for the split-binding needle).
  // Together this covers every non-test .rs file except ranking.rs, each exactly once.
  //
  // M21c: matched against compacted text, so the needle carries NO space and a
  // wrapped `let p = ctx.db\n    .profile();` is now caught. `let x = match
  // ctx.db.profile()...` still compacts to `=matchctx.db.profile()` and stays
  // clean — that is precisely why ranking.rs:202-204 reads via `match`.
  // -------------------------------------------------------------------------
  const c1bFiles = [...domainFiles, { name: 'pvp.rs', src: pvpSrc }];
  for (const { name: fileName, src } of c1bFiles) {
    if (scanCode(src).indexOf(C1B_SPLIT_BINDING_NEEDLE) !== -1) {
      failures.push(
        `C1b NEVER_DELETED (RL-2): found \`${C1B_SPLIT_BINDING_NEEDLE}\` in ${fileName} — ` +
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

  // -------------------------------------------------------------------------
  // Criterion G8 [G8/tombstone-arg-pin]: rekey_profile's SECOND profile update
  // must hand over EXACTLY `tombstoned_profile(guest)` (AUTH-25, ADR-0179 D6).
  // See checkTombstoneArgPin's header for the proven 78/78-green bypass this
  // closes, and for why the neighbouring G8 properties are deliberately NOT
  // restated here (they are enforced for real by shipped Rust).
  // -------------------------------------------------------------------------
  const tombstonePin = checkTombstoneArgPin(rankingSrc);
  if (!tombstonePin.ok) {
    failures.push(
      `[G8/tombstone-arg-pin] REKEY_PROFILE (AUTH-25, ADR-0179 D6): ${tombstonePin.why}. ` +
        "The guest's OWN profile row must be rewritten with the zeroed, tombstoned value and " +
        "nothing else: re-applying the guest's rating/wins/losses on top of the tombstone lets " +
        'ONE guest identity donate the SAME ladder stats to an unbounded number of fresh ' +
        'accounts (ranking.rs:178-182 — the zero is load-bearing, not cosmetic). ' +
        'ranking_tests.rs:636-646 pins the update COUNT, not the value, so this clause is the ' +
        'only thing standing between the tree and that bypass.',
    );
  }

  // -------------------------------------------------------------------------
  // Criterion D RANKED_REQUIRES_ACCOUNT (14r-g, ADR-0189, issue #307):
  // both PvP handshake reducers carry the exact ranked-account gate, before
  // their irreversible effects, keyed off the accounts.rs SSOT predicate.
  // See checkRankedAccountGate's header for the clause list and for why the
  // statement is pinned by exact equality (7/7 red-team evasions of the weaker
  // "does it mention is_account_holder?" design).
  // -------------------------------------------------------------------------
  const rankedGate = checkRankedAccountGate(pvpSrc);
  if (!rankedGate.ok) {
    failures.push(
      `D RANKED_REQUIRES_ACCOUNT (ADR-0189, issue #307): ${rankedGate.why}. Ranked play ` +
        'requires a full account on BOTH sides: every human-vs-human battle is ranked ' +
        '(ADR-0119 D4), so an ungated handshake lets guest identities — which are ' +
        'unbounded and free to mint — enter and shape the persistent ladder. The gate is ' +
        'deployment-conditional (inert while accounts::ALLOWED_ISSUERS is the .invalid ' +
        'placeholder, ADR-0189 D6), which is exactly why its STRUCTURE has to be pinned ' +
        'statically: nothing can execute the active path in any environment today.',
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
      `C1a chained-delete needles absent from all ${allNonTestFiles.length} non-test sources; ` +
      'C1b split-binding =ctx.db.profile() absent outside ranking.rs (AM-4); ' +
      'C2 on_disconnect body contains no profile( token (ADR-0119 D1); ' +
      "[G8/tombstone-arg-pin] rekey_profile's second profile update argument is exactly " +
      'tombstoned_profile(guest) (AUTH-25, ADR-0179 D6); ' +
      'D RANKED_REQUIRES_ACCOUNT: challenge_pvp and accept_challenge each carry the exact ' +
      'ADR-0189 ranked_account_gate statement once, at brace depth 0, before their ' +
      'irreversible effects, with has_jwt and ctx.db.account( absent, start_pvp_battle( == 2, ' +
      '.battle().insert( == 1 and the exact ranked_enforcement_active body (issue #307). ' +
      'A1/A2/C1a/C1b/D all matched against WHITESPACE-COMPACTED source (M21c A2 corollary), ' +
      'so rustfmt-wrapped chains cannot evade them.',
  };
}
