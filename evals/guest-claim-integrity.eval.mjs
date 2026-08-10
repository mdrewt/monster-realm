// Guest-claim integrity eval (M21c T3/T4/T5 — ADR-0179 G2 NO_CLIENT_IDENTITY,
// G3 ANON_PASSTHROUGH + ISSUER_AND_AUDIENCE_CHECKED, G4 NO_SERVER_RNG,
// G5 MODULE_WRITE_ISOLATION, G11 SINGLE_USE_CONSUMED, G6 REKEY_COMPLETENESS).
//
// The accounts subsystem derives identity ONLY from `ctx.sender`, never from a
// client-supplied value; anonymous play survives the connect hook untouched; the
// JWT issuer AND audience are both allowlist-checked before an `account` row is
// ever inserted; the module mints no randomness; it writes exactly three tables
// and reaches every other table through a delegated `rekey_*` helper; a claim
// code is consumed exactly once on the success path; and every `Identity` column
// in the whole schema carries an explicit re-key policy that is actually wired
// into `rekey_all` AND `account_has_game_data`.
//
// VERIFIED SEMANTICS (re-checked against the live tree at authoring time):
//   * accounts.rs declares EXACTLY five reducers — start_guest_claim,
//     complete_guest_claim, delete_account, cancel_account_deletion,
//     guest_claim_reaper. [R/name-set] pins that SET by exact equality rather
//     than counting, because a red-team proved two ADDITIVE reducers that are
//     unauthenticated, code-less transfers of any identity's monsters,
//     inventory, wallet, NPC state and profile — both compile and both pass
//     `clippy --all-targets -D warnings`:
//       E1  #[derive(spacetimedb::SpacetimeType)] pub struct ClaimTarget {
//               pub guest_identity: Identity }
//           #[spacetimedb::reducer] pub fn complete_guest_claim_for(
//               ctx: &ReducerContext, target: ClaimTarget) -> Result<(),String> {
//               rekey_all(ctx, target.guest_identity, ctx.sender) }
//       E2  #[spacetimedb::reducer] pub fn adopt_guest(
//               ctx: &ReducerContext, guest_hex: String) -> Result<(),String> {
//               let g = Identity::from_hex(&guest_hex)?;
//               rekey_all(ctx, g, ctx.sender) }
//     Neither declares an `: Identity` PARAMETER, so the naive "no reducer takes
//     an Identity" clause is green on both. E1 is caught by [R/param-types]
//     (a non-wire-scalar argument type), E2 by [R/identity-ctor] (nothing in
//     accounts.rs legitimately CONSTRUCTS an Identity), and any further additive
//     reducer by [R/name-set]. The shipped Rust twin cannot see either:
//     accounts_tests.rs:1517-1525 iterates a HARDCODED five-name reducer list,
//     so a new reducer is invisible to it. Reducers are therefore enumerated
//     FROM SOURCE here, never from a list.
//   * accounts.rs:505 `guest_claim_reaper(ctx, args: GuestClaimReaperSchedule)`
//     is a LEGITIMATE struct-argument reducer: `GuestClaimReaperSchedule` is the
//     `scheduled(guest_claim_reaper)` target table declared in the same file
//     (accounts.rs:489), so its `guest_identity: Identity` field is written by
//     the SCHEDULER, not by a client, and accounts.rs:509's
//     `ctx.sender != ctx.identity()` guard rejects any client that calls it.
//     [R/param-types] carves out exactly that shape — same-file scheduled table,
//     param type EQUAL to the scheduled struct, guard present — which is narrow
//     enough that E1's `ClaimTarget` is still rejected. The GUARD half is pinned
//     as a REJECTING EARLY RETURN (`if ctx.sender != ctx.identity() { return`),
//     not as a bare comparison: the adversarial pass showed that
//       let scheduler_only = ctx.sender != ctx.identity();
//       let _ = scheduler_only;
//     satisfies a substring test, compiles, is clippy-clean — and rejects
//     nobody, so any client can invoke the scheduled reducer with a hand-built
//     row naming any victim identity. Fixture FG58.
//   * lib.rs:204 is `if !ctx.sender_auth().has_jwt() {`, so `ctx.sender_auth()`
//     legitimately precedes `has_jwt(`. [I/anon-first] is therefore worded as
//     "has_jwt( precedes each of {accounts::, ctx.db., Err(}", NOT as "has_jwt is
//     the first token" — the latter false-REDs on arrival.
//   * accounts.rs:89-90: an EMPTY `aud` MUST reject (the token was minted for no
//     audience at all, AUTH-3). A red-team beat a presence-only audience clause
//     with `if !claims.audience().is_empty() && !audience_allowed(...)`, which
//     inverts that rule and lets an audience-less token provision an account
//     while all four [I/*] clauses stayed green. [I/aud] therefore pins the
//     guard SHAPE by exact needle, and [I/const-pin] separately pins WHICH
//     allowlist each predicate is called with — both consts are `&[&str]`, so
//     `issuer_allowed(issuer, ALLOWED_AUDIENCE)` type-checks and silently
//     destroys the gate.
//   * A one-token argument swap kills single-use:
//     `consume_claim_and_disarm(ctx, me)` (was `guest`) deletes nothing — `me`
//     has no `guest_claim` row — so the guest's claim row and its armed reaper
//     both survive and the 64-hex code stays redeemable until TTL (AUTH-34/35
//     dead). Count-, region- and ordering-only clauses all pass it, so [S/arg-pin]
//     pins the ARGUMENT and [S/depth0] additionally requires the call at
//     brace-depth 0 (closing the `if cond { consume... }` dead-branch variant,
//     whose condition is always false after `rekey_all`).
//   * A red-team showed that bounding the accessor -> verb span at `;` (which
//     [W/write-target] does, so a `Vec::insert` after an unrelated read is not
//     misattributed) turns
//       let presence = ctx.db.player(); presence.identity().delete(from);
//     from MISATTRIBUTED into UNDETECTED — a net regression versus the Rust twin
//     (accounts_tests.rs:1569's unbounded rfind catches it today). [W/split-binding]
//     closes exactly that hole, and the pair together covers both.
//
// OWNERSHIP / SSOT — what this eval deliberately does NOT do:
//   * Table privacy (G1), the `my_account` view body and inventory, client
//     bindings, and the no-PII-in-reject-logs gate (G12) belong to the sibling
//     account-privacy.eval.mjs.
//   * `rekey_profile`'s tombstone/zero invariants (G8) belong to
//     ranking-security.eval.mjs; the ACCESSOR_BYPASS allowlist belongs to
//     currency-integrity.eval.mjs; the recursive never-delete source scan
//     belongs to pvp_tests.rs.
//   * NO [I/order] issuer-before-audience clause. A JS checker does no
//     branch-window analysis, so an ordering pin here has no security rationale;
//     the direct precedent for cutting exactly this clause is
//     accounts_tests.rs:962-964.
//   * NO doc-tie clause parsing or counting headings in ADR-0179's D6 markdown.
//     That table has merged rows, an N/A row and TWO rows keyed `account`, so
//     such a clause fails on a legitimate reword and passes on a wrong manifest.
//     REKEY_MANIFEST below is the transcription; the [G6/*] clauses cross-check
//     it against live CODE in both directions instead.
//
// THE STRIPPER: a per-file LOCAL COPY of account-privacy.eval.mjs's canonical
// hardened `stripRustSource` / `compactWs` / `assertStripperSound`, copied
// VERBATIM. This is the repo convention (ranking-security.eval.mjs:51,
// currency-integrity.eval.mjs:147), and ci-gate-wiring.eval.mjs:342-346
// documents rejecting a shared stripper module outright: an eval that imports
// its own scanner from a neighbour can be blinded tree-wide by one edit to the
// neighbour. Strings are lexed FIRST (never comments first — a slash-slash
// inside a real issuer URL literal, accounts.rs:41-48, truncates the line and
// unbalances every quote after it); raw strings take ANY hash count with no
// escape processing; char literals are lexed with lifetime disambiguation. A
// desync GREENS every ban clause and reds only presence clauses, which is why
// [STRIP/length] / [STRIP/idempotent] / [STRIP/anchors] run on EVERY live source
// and fail loud.
// The adversarial pass added the FOUR string prefixes, not two: `c"..."`,
// `cr"..."` and `cr##"..."##` (stable Rust 1.77+) put a WORD CHARACTER in front
// of the `r`, so the raw branch's `!isWordChar(src[i-1])` guard skipped them and
// `cr"C:\"` was lexed as an ordinary string whose `\"` was eaten as an escape —
// the same polarity inversion as the r/br forms in a spelling the r/br
// hardening never enumerated. Placed at the END of a file the blanked tail
// carries no anchor, so even [STRIP/anchors] could not see it and an appended
// reducer became invisible to [R/name-set], [N/rng] and every [W/*] clause.
// Fixture FG54 pins the fix.
//
// Clause inventory (each checker is exported so the fixtures drive it directly;
// every clause carries a [tag] so a fixture can assert WHICH clause fired):
//   G2  checkNoClientIdentity(accountsSrc)
//       [R/identity-param] no reducer declares an `: Identity` / `: Option<Identity>`
//                          parameter (reducers enumerated FROM SOURCE).
//       [R/param-types]    every reducer parameter type is a wire-safe scalar,
//                          OR the reducer is the same-file `scheduled(...)`
//                          target whose param type IS the scheduled struct and
//                          whose body carries the scheduler guard.
//       [R/identity-ctor]  flat ban on Identity::from_hex( / from_byte_array( /
//                          from_be_byte_array( / from_str(.
//       [R/name-set]       the enumerated reducer NAME SET equals EXACTLY the
//                          five sanctioned names (also the non-vacuity guard).
//   G3  checkAnonPassthrough(libSrc)
//       [I/anon-first]     in on_connect's body, has_jwt( precedes EACH of
//                          {accounts::, ctx.db., Err(}.
//       [I/anon-no-err]    on_connect's body contains no `Err(` at all.
//       checkIssuerAndAudience(accountsSrc)
//       [I/iss]            `.issuer()` and `issuer_allowed(` both present.
//       [I/aud]            the audience guard's compacted condition is EXACTLY
//                          `if!audience_allowed(claims.audience(),ALLOWED_AUDIENCE){`.
//       [I/const-pin]      issuer_allowed is called with ALLOWED_ISSUERS and
//                          audience_allowed with ALLOWED_AUDIENCE.
//       [I/before-insert]  both checks precede `account().insert(`.
//   G4  checkNoServerRng(accountsSrc)
//       [N/rng] / [N/random]  `ctx.rng(` and `ctx.random(` absent (AUTH-11: the
//                          claim secret is CLIENT-minted because ctx.rng() is
//                          documented non-CSPRNG, ADR-0179 D3).
//   G5  checkModuleWriteIsolation(accountsSrc)
//       [W/battle-literal] literal `ctx.db.battle(` banned outright.
//       [W/write-target]   no write verb chained off a FOREIGN `ctx.db.<t>()`,
//                          span constrained to chain characters (so UFCS
//                          `UniqueColumn::delete(&ctx.db.player().identity(),...)`,
//                          where the verb PRECEDES the accessor, is rejected
//                          rather than mis-parsed).
//       [W/split-binding]  a foreign accessor whose chain TERMINATES at the
//                          accessor (the handle itself is the value).
//       [W/handle-type]    `<t>__TableHandle` / `<t>__ViewHandle` for foreign t.
//       [W/non-vacuous]    at least one OWNED-table write was found.
//   G11 checkSingleUseConsumed(accountsSrc)
//       [S/count]          exactly one `consume_claim_and_disarm(` in
//                          complete_guest_claim's body.
//       [S/arg-pin]        that call is exactly `consume_claim_and_disarm(ctx,guest)`.
//       [S/depth0]         it sits at brace-depth 0 of the fn body.
//       [S/success-region] it lies between `rekey_all(` and the trailing `Ok(())`,
//                          and precedes `account().identity().update(`.
//   G6  checkRekeyCompleteness(treeSrcs, accountsSrc[, manifest])
//       [G6/parse]         every `#[spacetimedb::table(` in each source yields
//                          exactly one PARSED table — a declaration
//                          parseTableSchemas cannot read hides its Identity
//                          columns from [G6/declared] (and from the schema
//                          baseline, which compares a union of both sides).
//       [G6/declared]      every `Identity`/`Option<Identity>` COLUMN in the tree
//                          has a manifest entry.
//       [G6/live]          every manifest key still resolves to a live column
//                          (bidirectional — a deleted column must not leave a
//                          stale policy behind).
//       [G6/anchors]       {account.identity, playtest_event.identity,
//                          profile.identity, player_wallet.owner_identity} all
//                          resolve, and playtest_event.identity is EXEMPT.
//       [G6/consumed]      each REKEY entry's `rekey` needle appears in
//                          rekey_all's body (accounts.rs:221-229) AND its
//                          `exists` needle in account_has_game_data's body
//                          (:209-216). The `exists` half is the ONLY part of G6
//                          not already covered by accounts_tests.rs:1320.
//
// HARD CONSTRAINTS honoured here:
//   * The live tree is rustfmt-WRAPPED (accounts.rs:430-433 is
//     `ctx.db` / `.account()` / `.identity()` / `.update(` across four lines), so
//     EVERY ordering/count/token clause runs against
//     `compactWs(stripRustSource(src))` and every needle is written in squashed
//     form. A contiguous needle matches ZERO times otherwise.
//   * The RegExp constructor is never used (Semgrep detect-non-literal-regexp is
//     a CI gate) — literal /regex/ and String.indexOf only.
//   * Strip PER FILE, never a concatenated blob: a quote left open in file A
//     silently blanks the whole of file B.
//
// Proof-of-teeth fixtures (FG1-FG59) run BEFORE the live-tree checks so a broken
// checker is caught first. Every clause has a BAD fixture asserting its [tag] by
// expectTag, and every checker has a GOOD fixture that must PASS — an always-red
// checker is indistinguishable from a working one (this repo's ux3 postmortem
// found a scan-only gate that let 9 of 19 broken implementations pass GREEN).
//
// EXPECTED STATE: GREEN against the current tree. The code these clauses gate is
// already merged and correct (M21a); this file is the structural gate over it.

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTableSchemas } from './battle-schema-snapshot.eval.mjs';
import {
  assertStripperSound,
  compactWs,
  containsIdent,
  countOccurrences,
  DQ,
  findCalls,
  findFnBody,
  isWordChar,
  SLASH_STAR,
  STAR_SLASH,
  splitArgs,
  stripRustSource,
} from './rust-scan.mjs';

// ---------------------------------------------------------------------------
// Shared structural parsers (findFnBody / findCalls are copied from
// account-privacy.eval.mjs; parseReducers and parseScheduledTargets are new).
// ---------------------------------------------------------------------------

/**
 * The final identifier of a (possibly pathed, possibly `!`-prefixed) callee.
 * `!issuer_allowed` -> `issuer_allowed`; `crate::npc::rekey_npc_state` ->
 * `rekey_npc_state`. findCalls' callee scan deliberately swallows a leading `!`
 * (it is part of the `!x(...)` token run), so normalising here is required.
 * @param {string} callee Dotted / pathed callee text.
 * @returns {string} The final identifier segment.
 */
function calleeTail(callee) {
  const segs = callee.split(/[.:!]+/).filter(Boolean);
  return segs.length === 0 ? '' : segs[segs.length - 1];
}

/**
 * Find the balanced close index for the `(` at `open`.
 * @param {string} s Text.
 * @param {number} open Index of the opening paren.
 * @returns {number} Index of the matching `)`, or -1.
 */
function matchParen(s, open) {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Enumerate every `#[spacetimedb::reducer...]`-attributed fn FROM SOURCE.
 * Never a hardcoded list: the shipped Rust twin (accounts_tests.rs:1517-1525)
 * iterates five hardcoded reducer needles and is therefore blind to an ADDED
 * reducer, which is exactly the proven E1/E2 bypass shape.
 * @param {string} stripped Stripped Rust source.
 * @returns {Array<{name:string, params:Array<{name:string, type:string}>}>} Reducers.
 */
export function parseReducers(stripped) {
  const ATTR = '#[spacetimedb::reducer';
  const out = [];
  for (let at = stripped.indexOf(ATTR); at !== -1; at = stripped.indexOf(ATTR, at + ATTR.length)) {
    const after = stripped[at + ATTR.length];
    // `#[spacetimedb::reducer]` and `#[spacetimedb::reducer(client_connected)]`
    // only — never a longer identifier that merely starts with `reducer`.
    if (after !== ']' && after !== '(') continue;

    let fnAt = -1;
    for (let k = stripped.indexOf('fn', at); k !== -1; k = stripped.indexOf('fn', k + 1)) {
      if (isWordChar(stripped[k - 1]) || isWordChar(stripped[k + 2])) continue;
      fnAt = k;
      break;
    }
    if (fnAt === -1) {
      out.push({ name: '', params: [] });
      continue;
    }

    let s = fnAt + 2;
    while (s < stripped.length && /\s/.test(stripped[s])) s++;
    let e = s;
    while (e < stripped.length && isWordChar(stripped[e])) e++;
    const name = stripped.slice(s, e);

    const open = stripped.indexOf('(', e);
    const close = open === -1 ? -1 : matchParen(stripped, open);
    if (open === -1 || close === -1) {
      out.push({ name, params: [] });
      continue;
    }
    const inner = stripped.slice(open + 1, close);
    const params = [];
    for (const arg of splitArgs(inner, inner)) {
      const text = arg.stripped;
      // First depth-0 `:` that is not part of a `::` path separator.
      let colon = -1;
      let depth = 0;
      let angle = 0;
      for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === '<') angle++;
        else if (ch === '>') angle = Math.max(0, angle - 1);
        else if (ch === ':' && depth === 0 && angle === 0) {
          if (text[k + 1] === ':') {
            k++;
            continue;
          }
          colon = k;
          break;
        }
      }
      if (colon === -1) {
        params.push({ name: text, type: text });
        continue;
      }
      params.push({ name: text.slice(0, colon), type: text.slice(colon + 1) });
    }
    out.push({ name, params });
  }
  return out;
}

/**
 * Map every `scheduled(<reducer>)` table declared in THIS file to its struct
 * name. Only a same-file scheduled table can justify a struct-typed reducer
 * argument (its `Identity` fields are written by the scheduler, not a client).
 * @param {string} stripped Stripped Rust source.
 * @returns {Map<string, string>} reducer name -> scheduled struct name.
 */
export function parseScheduledTargets(stripped) {
  const ATTR = '#[spacetimedb::table(';
  const map = new Map();
  for (let at = stripped.indexOf(ATTR); at !== -1; at = stripped.indexOf(ATTR, at + ATTR.length)) {
    const open = at + ATTR.length - 1;
    const close = matchParen(stripped, open);
    if (close === -1) continue;
    const attrText = compactWs(stripped.slice(open + 1, close));
    const schedAt = attrText.indexOf('scheduled(');
    if (schedAt === -1) continue;
    const nameStart = schedAt + 'scheduled('.length;
    let nameEnd = nameStart;
    while (nameEnd < attrText.length && isWordChar(attrText[nameEnd])) nameEnd++;
    const reducerName = attrText.slice(nameStart, nameEnd);
    if (reducerName === '') continue;

    const STRUCT = 'pub struct ';
    const structAt = stripped.indexOf(STRUCT, close);
    if (structAt === -1) continue;
    const s = structAt + STRUCT.length;
    let e = s;
    while (e < stripped.length && isWordChar(stripped[e])) e++;
    map.set(reducerName, stripped.slice(s, e));
  }
  return map;
}

// ---------------------------------------------------------------------------
// G2 — NO_CLIENT_IDENTITY.
// ---------------------------------------------------------------------------

const ACCOUNTS_PATH = 'server-module/src/accounts.rs';

// Pinned by EXACT SET EQUALITY, never `>= 5`: a count check cannot see E1/E2,
// whose whole shape is an ADDED reducer.
const SANCTIONED_REDUCERS = [
  'cancel_account_deletion',
  'complete_guest_claim',
  'delete_account',
  'guest_claim_reaper',
  'start_guest_claim',
];

// Wire-safe scalar argument types. Anything else in a reducer signature is a
// client-supplied composite whose fields the server cannot vouch for.
const WIRE_SCALARS = [
  'String',
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'f32',
  'f64',
];

// Nothing in accounts.rs legitimately CONSTRUCTS an Identity — every identity it
// handles arrives from `ctx.sender` or from a row it read. `Identity::from_hex`
// is `pub` (spacetimedb-lib-1.12.0/src/identity.rs:245), which is what makes E2
// a two-line, unauthenticated account-takeover reducer.
const IDENTITY_CTORS = [
  'Identity::from_hex(',
  'Identity::from_byte_array(',
  'Identity::from_be_byte_array(',
  'Identity::from_str(',
];

// The scheduler guard, pinned as a REJECTING EARLY RETURN rather than as a bare
// comparison. The adversarial pass found the carve-out was satisfied by
//     let scheduler_only = ctx.sender != ctx.identity();
//     let _ = scheduler_only;
// which contains the comparison, compiles, is clippy-clean — and lets ANY client
// invoke the scheduled reducer with a hand-built row naming any victim identity,
// i.e. exactly the client-supplied-Identity hole the carve-out assumes is
// closed. `{return` (not `{returnErr(`) so a future refactor to the equally
// valid `{ return Ok(()); }` silent-ignore form does not false-RED.
const SCHEDULER_GUARD = 'ifctx.sender!=ctx.identity(){return';

/**
 * Is this reducer parameter type a wire-safe scalar (recursively through
 * `Option<...>` / `Vec<...>`)?
 * @param {string} type Parameter type text.
 * @returns {boolean} True when the type is a wire-safe scalar.
 */
export function isWireSafeType(type) {
  const t = compactWs(type);
  if (WIRE_SCALARS.indexOf(t) !== -1) return true;
  for (const wrapper of ['Option<', 'Vec<']) {
    if (t.startsWith(wrapper) && t.endsWith('>')) {
      return isWireSafeType(t.slice(wrapper.length, -1));
    }
  }
  return false;
}

/**
 * G2 NO_CLIENT_IDENTITY — the server derives identity from `ctx.sender`, never
 * from a client-supplied value.
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoClientIdentity(accountsSrc) {
  const desync = assertStripperSound(accountsSrc, ACCOUNTS_PATH);
  if (desync) return desync;

  const stripped = stripRustSource(accountsSrc);
  const flat = compactWs(stripped);
  const reducers = parseReducers(stripped);
  const scheduled = parseScheduledTargets(stripped);

  // Non-vacuity: with no reducers parsed, every clause below passes on an empty
  // source. Reported under [R/name-set] because the empty set IS a set mismatch.
  if (reducers.length === 0) {
    return (
      `[R/name-set] no \`#[spacetimedb::reducer]\` declaration was parsed out of ${ACCOUNTS_PATH} ` +
      `— the sanctioned set is exactly {${SANCTIONED_REDUCERS.join(', ')}}. The scan reached the ` +
      'wrong file, the attribute spelling changed, or the stripper blanked the declarations; ' +
      'every clause below would pass VACUOUSLY, so this is a hard failure rather than a skip'
    );
  }
  for (const r of reducers) {
    if (r.name === '') {
      return (
        `[R/name-set] a \`#[spacetimedb::reducer]\` attribute in ${ACCOUNTS_PATH} is not followed ` +
        'by a parseable `fn NAME(` — refusing to classify is the fail-loud direction, because an ' +
        'unparsed reducer is an UNGATED reducer'
      );
    }
  }

  // [R/identity-param] — the direct form.
  for (const r of reducers) {
    for (const p of r.params) {
      const t = compactWs(p.type);
      if (t.endsWith('ReducerContext')) continue;
      if (!containsIdent(t, 'Identity')) continue;
      return (
        `[R/identity-param] reducer \`${r.name}\` declares the parameter \`${p.name}: ${t}\` — a ` +
        'reducer that accepts an Identity from the wire lets any client name ANY other player as ' +
        'the subject of the call, which for this module is an unauthenticated transfer of that ' +
        "identity's monsters, inventory, wallet, NPC state and profile. The subject identity is " +
        '`ctx.sender` and nothing else (ADR-0179 G2 / AUTH-6)'
      );
    }
  }

  // [R/param-types] — the E1 shape: an Identity smuggled inside a struct.
  for (const r of reducers) {
    for (let k = 0; k < r.params.length; k++) {
      const p = r.params[k];
      const t = compactWs(p.type);
      if (k === 0 && t.endsWith('ReducerContext')) continue;
      if (isWireSafeType(t)) continue;

      // Carve-out: the same-file `scheduled(<name>)` target, whose argument
      // struct is written by the SCHEDULER and whose body rejects any caller
      // that is not the module identity (accounts.rs:509).
      const schedStruct = scheduled.get(r.name);
      if (schedStruct !== undefined && schedStruct === t) {
        const span = findFnBody(stripped, r.name);
        const body = span === null ? '' : compactWs(stripped.slice(span.start, span.end));
        if (body.indexOf(SCHEDULER_GUARD) !== -1) continue;
        return (
          `[R/param-types] reducer \`${r.name}\` takes the scheduled struct \`${t}\` but its body ` +
          `does not contain the scheduler guard \`${SCHEDULER_GUARD}...\` — without it ANY client ` +
          'can invoke the scheduled reducer directly and hand it a hand-built row, which is ' +
          'precisely the client-supplied-Identity hole the carve-out assumes is closed. The guard ' +
          'is pinned as a REJECTING EARLY RETURN, not as a bare comparison: `let scheduler_only = ' +
          'ctx.sender != ctx.identity(); let _ = scheduler_only;` contains the comparison, ' +
          'compiles, passes clippy — and rejects nobody'
        );
      }

      return (
        `[R/param-types] reducer \`${r.name}\` declares the parameter \`${p.name}: ${t}\`, which is ` +
        'not a wire-safe scalar (String / u8..u128 / i8..i128 / f32 / f64 / bool / Vec<..> / ' +
        'Option<..> of those). A red-team PROVED this exact shape:\n' +
        '  #[derive(spacetimedb::SpacetimeType)] pub struct ClaimTarget { pub guest_identity: Identity }\n' +
        '  #[spacetimedb::reducer] pub fn complete_guest_claim_for(ctx: &ReducerContext, target: ClaimTarget)\n' +
        '      -> Result<(),String> { rekey_all(ctx, target.guest_identity, ctx.sender) }\n' +
        'It declares no `: Identity` parameter, compiles, passes `clippy --all-targets ' +
        '-D warnings`, and is a code-less transfer of ANY identity\u2019s game data. The ONLY ' +
        'sanctioned composite argument is the same-file `scheduled(...)` struct, whose fields the ' +
        'scheduler writes and whose reducer body carries the `' +
        SCHEDULER_GUARD +
        '` guard'
      );
    }
  }

  // [R/identity-ctor] — the E2 shape, closed independently of the parameter
  // analysis (E2's parameter is a perfectly wire-safe String).
  for (const ctor of IDENTITY_CTORS) {
    if (flat.indexOf(compactWs(ctor)) === -1) continue;
    return (
      `[R/identity-ctor] ${ACCOUNTS_PATH} calls \`${ctor}\` — nothing in this module legitimately ` +
      'CONSTRUCTS an Identity; every identity it handles comes from `ctx.sender` or from a row it ' +
      'read. A red-team PROVED the constructor is the whole attack:\n' +
      '  #[spacetimedb::reducer] pub fn adopt_guest(ctx: &ReducerContext, guest_hex: String)\n' +
      '      -> Result<(),String> { let g = Identity::from_hex(&guest_hex)?; rekey_all(ctx, g, ctx.sender) }\n' +
      'The parameter is a wire-safe String, so a parameter-type analysis alone never sees it. ' +
      '`Identity::from_hex` is `pub` in spacetimedb-lib'
    );
  }

  // [R/name-set] — EXACT set equality. An ADDED reducer is ITSELF the failure.
  const found = reducers.map((r) => r.name).sort();
  const sameSet =
    found.length === SANCTIONED_REDUCERS.length &&
    found.every((n, k) => n === SANCTIONED_REDUCERS[k]);
  if (!sameSet) {
    return (
      `[R/name-set] the reducer surface of ${ACCOUNTS_PATH} is [${found.join(', ')}] but the ` +
      `sanctioned set is EXACTLY [${SANCTIONED_REDUCERS.join(', ')}]. Set equality, not a count ` +
      'and not containment: the two proven takeover bypasses (E1 `complete_guest_claim_for`, E2 ' +
      '`adopt_guest`) are ADDITIVE, so a `>= 5` check or an "each expected name is present" check ' +
      'is green on both. Every reducer in this module is a client-reachable entry point into the ' +
      're-key machinery, so adding one is a security-relevant event that must be re-reviewed right ' +
      'here; a MISSING name means a client entry point silently disappeared'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// G3 — ANON_PASSTHROUGH (lib.rs) + ISSUER_AND_AUDIENCE_CHECKED (accounts.rs).
// ---------------------------------------------------------------------------

const LIB_PATH = 'server-module/src/lib.rs';
const CONNECT_FN = 'on_connect';
const PROVISION_FN = 'provision_or_touch_account';

// Tokens that must not precede the anonymous early-out. Deliberately an EXPLICIT
// SET, not "every other token": lib.rs:204 is
// `if !ctx.sender_auth().has_jwt() {`, so `ctx.sender_auth()` legitimately comes
// first and a "has_jwt is the first statement" phrasing false-REDs on arrival.
const ANON_AFTER_TOKENS = ['accounts::', 'ctx.db.', 'Err('];

// The ONE sanctioned audience guard, whitespace-compacted. Pinned by SHAPE
// because a red-team beat a presence-only check with
// `if !claims.audience().is_empty() && !audience_allowed(...)`, which inverts
// AUTH-3 (accounts.rs:89-90 — an EMPTY `aud` MUST reject) and lets an
// audience-less token provision an account with every [I/*] clause green.
const AUDIENCE_GUARD = 'if!audience_allowed(claims.audience(),ALLOWED_AUDIENCE){';

/**
 * G3 (first half) ANON_PASSTHROUGH — anonymous play is first-class; the connect
 * hook branches on JWT presence before it does anything else, and never returns
 * `Err` (returning `Err` from this lifecycle hook DISCONNECTS the client;
 * ADR-0179 D4/D1'').
 * @param {string} libSrc Raw server-module/src/lib.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkAnonPassthrough(libSrc) {
  const desync = assertStripperSound(libSrc, LIB_PATH);
  if (desync) return desync;

  const stripped = stripRustSource(libSrc);
  const span = findFnBody(stripped, CONNECT_FN);
  if (span === null) {
    return (
      `[I/anon-first] fn \`${CONNECT_FN}\` was not found in ${LIB_PATH} — the anonymous-passthrough ` +
      'scan has NO scope, so both clauses below would pass vacuously. Was the connect hook renamed, ' +
      'moved, or blanked by a stripper desync?'
    );
  }
  const body = compactWs(stripped.slice(span.start, span.end));
  if (body === '') {
    return (
      `[I/anon-first] fn \`${CONNECT_FN}\` in ${LIB_PATH} has an EMPTY body — the connect hook ` +
      'cannot be both implemented and empty; the extraction is broken or the hook is a stub'
    );
  }

  const jwtAt = body.indexOf('has_jwt(');
  if (jwtAt === -1) {
    return (
      `[I/anon-first] fn \`${CONNECT_FN}\` in ${LIB_PATH} never calls \`has_jwt(\` — anonymous play ` +
      'is FIRST-CLASS (ADR-0179 D4/D1\u2033). Without the JWT-presence branch the hook either runs ' +
      'account provisioning for a tokenless connection or (worse) rejects it; the sanctioned shape ' +
      'is `if !ctx.sender_auth().has_jwt() { return Ok(()); }` as the leading statement'
    );
  }
  for (const token of ANON_AFTER_TOKENS) {
    const at = body.indexOf(token);
    if (at === -1) continue;
    if (at < jwtAt) {
      return (
        `[I/anon-first] in ${LIB_PATH}'s \`${CONNECT_FN}\`, \`${token}\` appears at compacted ` +
        `offset ${at}, BEFORE the \`has_jwt(\` branch at ${jwtAt}. Every anonymous connection ` +
        'reaches this hook, so anything that runs before the JWT-presence early-out runs for ' +
        'players who have no account and never will. (This clause names an EXPLICIT token set ' +
        `{${ANON_AFTER_TOKENS.join(', ')}} rather than "first statement", because ` +
        '`ctx.sender_auth()` legitimately precedes `has_jwt()` in the sanctioned spelling)'
      );
    }
  }

  if (body.indexOf('Err(') !== -1) {
    return (
      `[I/anon-no-err] fn \`${CONNECT_FN}\` in ${LIB_PATH} contains \`Err(\`. Returning \`Err\` ` +
      'from the `client_connected` lifecycle hook DISCONNECTS the client. Anonymous play is ' +
      'first-class (ADR-0179 D4/D1\u2033), and the vendor\u2019s canonical example for this hook — ' +
      'which REJECTS JWT-less connections — is deliberately NOT copied here. Every provisioning ' +
      'decision, including the audience-disconnect branch, belongs in accounts.rs where it can ' +
      'return Ok for the anonymous path'
    );
  }

  return null;
}

/**
 * G3 (second half) ISSUER_AND_AUDIENCE_CHECKED — both JWT claims are
 * allowlist-checked, with the right allowlist, before any `account` row exists.
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkIssuerAndAudience(accountsSrc) {
  const desync = assertStripperSound(accountsSrc, ACCOUNTS_PATH);
  if (desync) return desync;

  const stripped = stripRustSource(accountsSrc);
  const span = findFnBody(stripped, PROVISION_FN);
  if (span === null) {
    return (
      `[I/iss] fn \`${PROVISION_FN}\` was not found in ${ACCOUNTS_PATH} — the provisioning scan has ` +
      'NO scope, so every clause below would pass vacuously. Fail loud rather than skip'
    );
  }
  const body = compactWs(stripped.slice(span.start, span.end));
  if (body === '') {
    return (
      `[I/iss] fn \`${PROVISION_FN}\` in ${ACCOUNTS_PATH} has an EMPTY body — provisioning cannot ` +
      'be both implemented and empty'
    );
  }

  // [I/iss]
  const issAt = body.indexOf('issuer_allowed(');
  if (body.indexOf('.issuer()') === -1 || issAt === -1) {
    return (
      `[I/iss] \`${PROVISION_FN}\` does not both read \`.issuer()\` and call \`issuer_allowed(\` — ` +
      'an unchecked issuer means ANY OIDC provider on the internet can mint a token that ' +
      'provisions an account here (AUTH-2). ALLOWED_ISSUERS is deployment config: exact-match, no ' +
      'prefix/suffix/case tolerance'
    );
  }

  // [I/aud] — SHAPE-pinned, not presence-pinned.
  const audAt = body.indexOf(AUDIENCE_GUARD);
  if (audAt === -1) {
    return (
      `[I/aud] \`${PROVISION_FN}\` does not contain the sanctioned audience guard. Expected ` +
      `(whitespace-compacted): \`${AUDIENCE_GUARD}\`. This clause pins the SHAPE, not the ` +
      'presence of `audience_allowed`, because a red-team beat a presence-only check with\n' +
      '  if !claims.audience().is_empty() && !audience_allowed(claims.audience(), ALLOWED_AUDIENCE)\n' +
      'which INVERTS AUTH-3: accounts.rs:89-90 requires an EMPTY `aud` to REJECT (the token was ' +
      'minted for no audience at all), so the short-circuit lets an audience-less token — the ' +
      'classic confused-deputy shape — provision an account while every other [I/*] clause stays ' +
      'green. Any legitimate change to this guard must be re-reviewed right here'
    );
  }

  // [I/const-pin] — WHICH allowlist. Both consts are `&[&str]`, so
  // `issuer_allowed(issuer, ALLOWED_AUDIENCE)` type-checks and silently destroys
  // the gate while [I/iss] and [I/aud] both stay green.
  const pins = [
    ['issuer_allowed', 'ALLOWED_ISSUERS'],
    ['audience_allowed', 'ALLOWED_AUDIENCE'],
  ];
  const calls = findCalls(stripped, accountsSrc, span.start, span.end);
  for (const [fn, expectedConst] of pins) {
    let seen = 0;
    for (const call of calls) {
      if (calleeTail(call.callee) !== fn) continue;
      seen++;
      if (call.args.length !== 2) {
        return (
          `[I/const-pin] \`${fn}(\` in \`${PROVISION_FN}\` was called with ${call.args.length} ` +
          `argument(s); the sanctioned signature is (value, allowed: &[&str]). This scan cannot ` +
          'classify an unexpected shape, and refusing to classify is the fail-loud direction'
        );
      }
      if (call.args[1].stripped !== expectedConst) {
        return (
          `[I/const-pin] \`${fn}(\` is called with allowlist \`${call.args[1].stripped}\`, not ` +
          `\`${expectedConst}\`. ALLOWED_ISSUERS and ALLOWED_AUDIENCE are BOTH \`&[&str]\`, so ` +
          'swapping them type-checks, compiles, passes clippy — and silently destroys the gate: ' +
          'the issuer would be compared against the audience allowlist, so no real token matches ' +
          'and (depending on the branch) either nothing is ever provisioned or the wrong claim ' +
          'gates provisioning entirely'
        );
      }
    }
    if (seen === 0) {
      return (
        `[I/const-pin] \`${fn}(\` was not called at all inside \`${PROVISION_FN}\` — the clause ` +
        'that pins WHICH allowlist each predicate uses has nothing to inspect, so it would pass ' +
        'vacuously'
      );
    }
  }

  // [I/before-insert]
  const insertAt = body.indexOf('account().insert(');
  if (insertAt === -1) {
    return (
      `[I/before-insert] \`${PROVISION_FN}\` contains no \`account().insert(\` — lazy provisioning ` +
      'is the whole point of this fn (AUTH-4), so its absence means either the insert moved out of ' +
      'scope of this gate or account creation was deleted. Fail loud: with no insert, "the checks ' +
      'precede the insert" is vacuously true'
    );
  }
  if (issAt > insertAt || audAt > insertAt) {
    return (
      `[I/before-insert] in \`${PROVISION_FN}\` the \`account().insert(\` at compacted offset ` +
      `${insertAt} is not preceded by BOTH the issuer check (${issAt}) and the audience check ` +
      `(${audAt}). AUTH-2/3 require that neither an unrecognized issuer nor an unrecognized ` +
      'audience can ever result in an `account` row; a row inserted first and validated afterwards ' +
      'is still a row (the reducer Err rolls back, but any code path that returns Ok after the ' +
      'insert persists it)'
    );
  }

  // [I/asym] — the DIRECTION of each branch, not merely its presence.
  //
  // ADR-0179 D1" is asymmetric, and the asymmetry is the whole outage-safety
  // argument: an unrecognized ISSUER must return `Ok` (leaving the connection
  // anonymous), an allowed issuer with an unrecognized AUDIENCE must return
  // `Err` (disconnecting). This matters because a live M21a probe established
  // that `has_jwt()` is TRUE FOR EVERY CONNECTION — the SpacetimeDB host mints
  // its own `iss=localhost` token even for a tokenless connect — so the
  // unrecognized-issuer branch is the MODAL path for every anonymous player.
  // Flipping it to `Err` disconnects the entire player base at connect.
  //
  // Every clause above stays green through that flip, including
  // [I/anon-no-err]: `on_connect`'s own body contains no `Err(` literal because
  // the error propagates out of the tail call to this fn. Only accounts_tests.rs
  // covers the direction today, which invites a future reader to delete the Rust
  // test believing "ISSUER_AND_AUDIENCE_CHECKED" already covers it.
  const issBranch = body.slice(issAt, audAt);
  if (issBranch.indexOf('returnOk(())') === -1) {
    return (
      `[I/asym] in \`${PROVISION_FN}\` the unrecognized-ISSUER branch does not \`return Ok(())\`. ` +
      'ADR-0179 D1" is asymmetric ON PURPOSE: `has_jwt()` is true for EVERY connection (the host ' +
      'mints its own `iss=localhost` token even for a tokenless connect — probed live in M21a), so ' +
      'this branch is the modal path for every anonymous player. Returning `Err` here disconnects ' +
      'the ENTIRE player base at connect, which is a total outage, not a security tightening. ' +
      'AUTH-2 (amended): return Ok without provisioning, leaving the connection anonymous'
    );
  }
  if (body.slice(audAt).indexOf('returnErr(') === -1) {
    return (
      `[I/asym] in \`${PROVISION_FN}\` the unrecognized-AUDIENCE branch does not \`return Err(\`. ` +
      'AUTH-3 is UNCHANGED by the D1" amendment: this branch is reachable only by a token whose ' +
      'issuer we explicitly allowlisted but whose `aud` targets another application — a ' +
      'same-issuer cross-app confused-deputy token, never a legitimate player. Downgrading it to ' +
      '`Ok` silently retires `aud` as an authorization control, which is exactly the CRITICAL-2 ' +
      'finding D1" was written to preserve against'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// G4 — NO_SERVER_RNG.
// ---------------------------------------------------------------------------

const RNG_NEEDLES = [
  ['[N/rng]', 'ctx.rng('],
  ['[N/random]', 'ctx.random('],
];

/**
 * G4 NO_SERVER_RNG — accounts.rs mints no randomness. The claim secret is
 * CLIENT-minted (32 bytes of `crypto.getRandomValues` rendered as lowercase hex)
 * precisely because `ctx.rng()` is documented non-CSPRNG (AUTH-11, ADR-0179 D3).
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoServerRng(accountsSrc) {
  const desync = assertStripperSound(accountsSrc, ACCOUNTS_PATH);
  if (desync) return desync;

  const flat = compactWs(stripRustSource(accountsSrc));
  for (const [tag, needle] of RNG_NEEDLES) {
    if (flat.indexOf(needle) === -1) continue;
    return (
      `${tag} ${ACCOUNTS_PATH} calls \`${needle}\` — the SpacetimeDB module RNG is documented ` +
      'NON-CRYPTOGRAPHIC and is deterministically seeded per reducer call, so a claim code minted ' +
      'from it is guessable by anyone who can observe or replay timing. AUTH-11 / ADR-0179 D3: the ' +
      'secret is CLIENT-minted (32 bytes of crypto.getRandomValues as lowercase hex) and the server ' +
      'only ever VALIDATES its shape. The needle is matched against whitespace-compacted, ' +
      'string- and comment-stripped source, so a mention in prose or in a literal is not a hit'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// G5 — MODULE_WRITE_ISOLATION.
// ---------------------------------------------------------------------------

// [W/db-binding] — every G5 clause below keys on the literal `ctx.db.<ident>(`.
// `ReducerContext.db` is a PUBLIC field of type `Local`, so one binding hides
// the whole family from every one of them:
//
//     let db = &ctx.db;
//     db.monster().monster_id().update(m);   // foreign write, [W/*] all green
//     db.battle().battle_id().find(id);      // [W/battle-literal] green too
//
// Same shape as [W/split-binding], one level up: if `ctx.db` is not immediately
// followed by `.`, the handle escaped into a binding and the accessor scan is
// blind from that point on. Banning the escape is exact — `accounts.rs` reaches
// the database only through inline `ctx.db.<table>()` chains.
const DB_ROOT = 'ctx.db';

// [W/ctx-binding] — the same escape one level FURTHER up.
//
// Every clause in this family (including [W/db-binding] above) keys on the
// literal string `ctx.db`, and deliberately skips any prefixed spelling so
// `my_ctx.db` is not mistaken for our root. That leaves the context itself as
// an escape hatch: reach the database through a `ReducerContext` bound under
// any other name and NOTHING in the family sees it. The merge-gate verifier
// proved this with ordinary, unremarkable Rust —
//
//     fn purge_stale_player(context: &ReducerContext, id: Identity) {
//         context.db.player().identity().delete(id);   // FOREIGN table delete
//     }
//     // called from delete_account:  purge_stale_player(ctx, me);
//
// — and measured it at `fmt --check` 0, `clippy -D warnings` 0, 80/80 evals
// PASS and 1662/1662 Rust tests passing, while `guest-claim-integrity`'s own
// success string still claimed "writes confined to {account, guest_claim,
// guest_claim_reaper_schedule}". `let c = ctx; c.db.player()...` is the same
// hole. The Rust twin (accounts_tests.rs) shares the `ctx.db.` key, so there is
// no backstop.
//
// Fixing it inside the accessor walk is not possible — the walk cannot know
// which identifiers are contexts. Instead, pin the SPELLING: in accounts.rs the
// context is always named `ctx` and is never aliased. That is true of every fn
// in the file today and is a one-word constraint on future code.
const CTX_PARAM_TYPE = ':&ReducerContext';
const CTX_ALIAS_FORMS = ['=ctx;', '=ctx,', '=&ctx;', '=&ctx,', '=ctx.clone()'];

/**
 * Detect a `ReducerContext` reachable under a name other than `ctx`.
 * @param {string} flat Whitespace-compacted, string/comment-stripped source.
 * @returns {string|null} The offending spelling, or null when none.
 */
export function findAliasedContext(flat) {
  // Parameters: walk back from `:&ReducerContext` over the identifier.
  for (let i = flat.indexOf(CTX_PARAM_TYPE); i !== -1; i = flat.indexOf(CTX_PARAM_TYPE, i + 1)) {
    let s = i;
    while (s > 0 && isWordChar(flat[s - 1])) s--;
    const name = flat.slice(s, i);
    if (name !== 'ctx' && name !== '_ctx') return `${name}${CTX_PARAM_TYPE}`;
  }
  // Locals: `let c = ctx;` and friends.
  for (const form of CTX_ALIAS_FORMS) {
    if (flat.indexOf(form) !== -1) return form;
  }
  return null;
}

/**
 * True if the compacted source lets the `Local` handle escape `ctx.db.` form.
 * @param {string} flat Whitespace-compacted, string/comment-stripped source.
 * @returns {boolean} True when a bare `ctx.db` is not a chained accessor.
 */
export function hasEscapedDbHandle(flat) {
  for (let i = flat.indexOf(DB_ROOT); i !== -1; i = flat.indexOf(DB_ROOT, i + 1)) {
    if (isWordChar(flat[i - 1])) continue; // e.g. `my_ctx.db` — not our root
    if (flat[i + DB_ROOT.length] !== '.') return true;
  }
  return false;
}

// accounts.rs may WRITE only these three tables (D0 is WRITE-scoped, not
// table-scoped). Bare READS of `player` are explicitly permitted — there is no
// single owning module for it.
const OWNED_TABLES = ['account', 'guest_claim', 'guest_claim_reaper_schedule'];
const DB_ACCESSOR = 'ctx.db.';
const WRITE_VERBS = ['.insert(', '.update(', '.delete('];
const UFCS_WRITE_VERBS = ['::insert(', '::update(', '::delete('];
const HANDLE_SUFFIXES = ['__TableHandle', '__ViewHandle'];
const BATTLE_LITERAL = 'ctx.db.battle(';
// The only sanctioned TERMINALS of a foreign-table chain. A foreign accessor
// whose statement reaches none of these is producing a table handle or a column
// handle as a VALUE, which is the split-binding family (see [W/split-binding]).
const FOREIGN_READ_TERMINALS = ['.find(', '.filter(', '.iter(', '.count(', '.len('];

/**
 * Is `ch` part of a method-chain expression once whitespace has been removed?
 * Bounding the accessor -> verb span to these characters is what makes
 * `ctx.db.player().identity().find(g); ids.insert(0, x);` a bare READ (the `;`
 * ends the span) while keeping the UFCS form — where the verb PRECEDES the
 * accessor — inside a single scannable span.
 * @param {string|undefined} ch Single character.
 * @returns {boolean} True for a chain character.
 */
function isChainChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_.()&,:<>]/.test(ch);
}

/**
 * Every `ctx.db.<table>()` accessor in whitespace-compacted, stripped source.
 * @param {string} flat Compacted, stripped source.
 * @returns {Array<{table:string, start:number, accEnd:number}>} Accessors.
 */
export function findDbAccessors(flat) {
  const out = [];
  for (let at = flat.indexOf(DB_ACCESSOR); at !== -1; at = flat.indexOf(DB_ACCESSOR, at + 1)) {
    const s = at + DB_ACCESSOR.length;
    let e = s;
    while (e < flat.length && isWordChar(flat[e])) e++;
    if (e === s || flat[e] !== '(') continue;
    const close = matchParen(flat, e);
    if (close === -1) continue;
    out.push({ table: flat.slice(s, e), start: at, accEnd: close + 1 });
  }
  return out;
}

/**
 * G5 MODULE_WRITE_ISOLATION — accounts.rs writes ONLY account / guest_claim /
 * guest_claim_reaper_schedule; every other table's write goes through a
 * `rekey_*` helper in that table's owning module (ADR-0179 D0).
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkModuleWriteIsolation(accountsSrc) {
  const desync = assertStripperSound(accountsSrc, ACCOUNTS_PATH);
  if (desync) return desync;

  const flat = compactWs(stripRustSource(accountsSrc));

  // [W/battle-literal] — first, so a battle touch always reports the clause that
  // names the sanctioned indirection.
  if (flat.indexOf(BATTLE_LITERAL) !== -1) {
    return (
      `[W/battle-literal] ${ACCOUNTS_PATH} contains \`${BATTLE_LITERAL}\` — battle liveness must ` +
      'reuse `guards::is_in_ongoing_battle` (the SSOT predicate, ADR-0122 D1), never a direct ' +
      'battle-table reach. ADR-0179 D0/G5 makes this a LITERAL ban rather than a write-only ban: ' +
      'the whole point of the indirection is that accounts.rs has no battle coupling at all, so ' +
      'even a read here is a new edge in the module graph'
    );
  }

  // [W/ctx-binding] — first: an aliased context blinds the ENTIRE family,
  // including [W/db-binding], because every clause keys on the literal `ctx.db`.
  const aliased = findAliasedContext(flat);
  if (aliased !== null) {
    return (
      `[W/ctx-binding] ${ACCOUNTS_PATH} reaches the \`ReducerContext\` under a name other than ` +
      `\`ctx\` (found \`${aliased}\`). Every clause in this family — [W/write-target], ` +
      '[W/split-binding], [W/handle-type], [W/battle-literal] and even [W/db-binding] — keys on ' +
      'the literal string `ctx.db`, and deliberately skips prefixed spellings so `my_ctx.db` is ' +
      'not mistaken for the root. So a helper written `fn purge(context: &ReducerContext, id: ' +
      'Identity) { context.db.player().identity().delete(id); }` performs a FOREIGN-table delete ' +
      'that NOTHING here can see, and the Rust twin (accounts_tests.rs) shares the same key, so ' +
      'there is no backstop. Measured green end-to-end by the M21c merge-gate verifier. In ' +
      'accounts.rs the context is always `ctx` and is never aliased — keep it that way, or the ' +
      'whole write-isolation gate is decorative'
    );
  }

  // [W/db-binding] — before the accessor walk, because an escaped `Local`
  // handle makes that walk blind rather than wrong.
  if (hasEscapedDbHandle(flat)) {
    return (
      `[W/db-binding] ${ACCOUNTS_PATH} uses \`${DB_ROOT}\` somewhere it is not immediately ` +
      'followed by `.` — the `Local` database handle escaped into a binding or an argument. ' +
      '`ReducerContext.db` is a PUBLIC field, so `let db = &ctx.db; db.monster()...update(m);` ' +
      'is a foreign-table write that EVERY other clause in this family misses: [W/write-target], ' +
      '[W/split-binding] and [W/handle-type] all key on the literal `ctx.db.<table>(`, and ' +
      '[W/battle-literal] keys on `ctx.db.battle(`. The Rust twin (accounts_tests.rs) shares the ' +
      'same key, so there is no backstop. accounts.rs reaches the database only through inline ' +
      '`ctx.db.<table>()` chains — keep it that way'
    );
  }

  const accessors = findDbAccessors(flat);
  let ownedWrites = 0;

  for (const a of accessors) {
    const owned = OWNED_TABLES.indexOf(a.table) !== -1;

    // Forward chain span: bounded at the first non-chain character, which for
    // compacted source is `;`, `{`, `}`, `=`, `?`, `|` and friends.
    let f = a.accEnd;
    while (f < flat.length && isChainChar(flat[f])) f++;
    const forward = flat.slice(a.accEnd, f);

    // Backward chain span, scanned ONLY for the UFCS `Type::verb(` form —
    // `UniqueColumn::delete(&ctx.db.player().identity(), from)` puts the verb
    // BEFORE the accessor, so a forward-only scan mis-parses it as a bare read.
    // Restricting the backward direction to the `::` spelling is what keeps a
    // legitimate nested read inside an OWNED table's `.insert(...)` argument
    // from being misattributed.
    let b = a.start;
    while (b > 0 && isChainChar(flat[b - 1])) b--;
    const backward = flat.slice(b, a.start);

    const chainedVerb = WRITE_VERBS.find((v) => forward.indexOf(v) !== -1);
    const ufcsVerb = UFCS_WRITE_VERBS.find((v) => backward.indexOf(v) !== -1);
    const verb = chainedVerb ?? ufcsVerb;

    if (verb !== undefined) {
      if (owned) {
        ownedWrites++;
      } else {
        return (
          `[W/write-target] ${ACCOUNTS_PATH} writes the FOREIGN table \`${a.table}\` ` +
          `(\`${verb}\` ${chainedVerb === undefined ? 'via the UFCS form, where the verb precedes the accessor' : 'chained off the accessor'}). ` +
          `This module may write only {${OWNED_TABLES.join(', ')}}; every other table's write goes ` +
          'through a `pub(crate) fn rekey_*` helper in that table\u2019s OWNING module ' +
          '(monster_mgmt / inventory / npc / raising / economy / ranking), which is what keeps the ' +
          're-key manifest (D6) a single SSOT instead of two divergent copies. Bare READS of ' +
          '`player` are permitted; this is a WRITE'
        );
      }
    }

    // [W/split-binding] — the foreign chain never reaches a READ, so the value
    // it produces is a table / column / index HANDLE. MANDATORY companion to
    // [W/write-target]: with the span bounded at `;`,
    //   let presence = ctx.db.player(); presence.identity().delete(from);
    // goes from MISATTRIBUTED to UNDETECTED — a net regression versus the Rust
    // twin's unbounded rfind (accounts_tests.rs:1569). Same needle family as
    // ranking-security.eval.mjs:827 (`= ctx.db.profile()`).
    //
    // Stated as "the forward span reaches a READ TERMINAL" rather than the
    // earlier "the accessor is not followed by a `.`", because the adversarial
    // pass found that binding ONE HOP LATER beats the dot form completely — the
    // accessor IS followed by a dot, and the write verb is still outside the
    // statement:
    //   let col = ctx.db.player().identity();   // no write verb in this span
    //   col.delete(from);                       // no accessor in this statement
    // That evades [W/write-target] (the span ends at the `;`), the dot spelling
    // of THIS clause, and [W/handle-type] (no type name is ever written).
    // Requiring a read terminal collapses the whole family — table handle,
    // column handle, index handle — into one clause. The LEGITIMATE
    // `let Some(player) = ctx.db.player().identity().find(me)` at accounts.rs:349
    // and `if ctx.db.player().identity().find(guest).is_some()` at :410 both
    // reach `.find(` inside their own statement, so both stay green.
    if (!owned && !FOREIGN_READ_TERMINALS.some((t) => forward.indexOf(t) !== -1)) {
      return (
        `[W/split-binding] ${ACCOUNTS_PATH} evaluates \`ctx.db.${a.table}()\` for the FOREIGN ` +
        `table \`${a.table}\` without reaching a read terminal ` +
        `(${FOREIGN_READ_TERMINALS.join(' / ')}) in the same statement. The value it produces is ` +
        'a table / column / index HANDLE that escapes into a local, an argument or a return, ' +
        'carrying the write verb out of the accessor\u2019s own statement where no span-bounded ' +
        'scan can see it:\n' +
        '  let presence = ctx.db.player();        presence.identity().delete(from);\n' +
        '  let col = ctx.db.player().identity();  col.delete(from);\n' +
        'Both are real, proven evasions of [W/write-target]; the second also evades the earlier ' +
        '`accessor not followed by a dot` spelling of this clause AND [W/handle-type]. Chain inline ' +
        '(`ctx.db.player().identity().find(id)`) for the permitted bare reads, and route every ' +
        'write through the owning module\u2019s `rekey_*` helper'
      );
    }
  }

  // [W/handle-type] — a generated handle passed through a signature reaches a
  // table without the accessor ever appearing in that fn's body (the shape
  // wallet-privacy.eval.mjs:242 bans for player_wallet).
  for (const suffix of HANDLE_SUFFIXES) {
    for (let at = flat.indexOf(suffix); at !== -1; at = flat.indexOf(suffix, at + 1)) {
      let s = at;
      while (s > 0 && isWordChar(flat[s - 1])) s--;
      const table = flat.slice(s, at);
      if (table === '' || OWNED_TABLES.indexOf(table) !== -1) continue;
      return (
        `[W/handle-type] ${ACCOUNTS_PATH} names the generated handle type ` +
        `\`${table}${suffix}\` for the FOREIGN table \`${table}\`. A handle taken as a parameter ` +
        '(or returned) reaches that table without `ctx.db.<t>()` ever appearing in the reaching ' +
        'fn\u2019s body, so both [W/write-target] and [W/split-binding] are blind to it. Delegate ' +
        'to the owning module instead of passing table handles across module boundaries'
      );
    }
  }

  // [W/non-vacuous] — the empty-target blind spot. A checker that only inspects
  // the writes it happens to find is GREEN on a file with no writes at all,
  // which is indistinguishable from a scan that reached the wrong text.
  if (ownedWrites === 0) {
    return (
      `[W/non-vacuous] no write to any of {${OWNED_TABLES.join(', ')}} was found in ` +
      `${ACCOUNTS_PATH}. This module\u2019s entire job is to insert / update / delete those three ` +
      'tables, so zero owned writes means the scan reached the wrong text, the accessor spelling ' +
      'changed, or the stripper blanked the code — in every case the ban clauses above passed ' +
      'VACUOUSLY and prove nothing'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// G11 — SINGLE_USE_CONSUMED.
// ---------------------------------------------------------------------------

const CLAIM_FN = 'complete_guest_claim';
const CONSUME_CALL = 'consume_claim_and_disarm(';
const CONSUME_PINNED = 'consume_claim_and_disarm(ctx,guest)';
const REKEY_CALL = 'rekey_all(';
const PROVENANCE_UPDATE = 'account().identity().update(';
const TRAILING_OK = 'Ok(())';

/**
 * G11 SINGLE_USE_CONSUMED — the claim row AND its armed reaper are consumed
 * exactly once, for the GUEST, on the success path (AUTH-34/35).
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkSingleUseConsumed(accountsSrc) {
  const desync = assertStripperSound(accountsSrc, ACCOUNTS_PATH);
  if (desync) return desync;

  const stripped = stripRustSource(accountsSrc);
  const span = findFnBody(stripped, CLAIM_FN);
  if (span === null) {
    return (
      `[S/count] fn \`${CLAIM_FN}\` was not found in ${ACCOUNTS_PATH} — the single-use scan has NO ` +
      'scope, so every clause below would pass vacuously. Fail loud rather than skip'
    );
  }
  const body = compactWs(stripped.slice(span.start, span.end));

  // [S/count]
  const n = countOccurrences(body, CONSUME_CALL);
  if (n !== 1) {
    return (
      `[S/count] \`${CLAIM_FN}\` calls \`${CONSUME_CALL}\` ${n} time(s); exactly 1 is required. ` +
      'Zero means the 64-hex code stays redeemable until its TTL and the guest\u2019s data can be ' +
      're-keyed onto a SECOND account (AUTH-34/35 dead). More than one means the success path is ' +
      'split across branches, which this scan cannot reason about — refusing to classify is the ' +
      'fail-loud direction'
    );
  }

  // [S/arg-pin] — the load-bearing clause. A red-team PROVED a ONE-TOKEN swap:
  // `consume_claim_and_disarm(ctx, me)` deletes nothing (the CALLER has no
  // guest_claim row), so the claim row and its armed reaper both survive and
  // [S/count], [S/depth0] and [S/success-region] all stay green.
  if (body.indexOf(CONSUME_PINNED) === -1) {
    const at = body.indexOf(CONSUME_CALL);
    const end = matchParen(body, at + CONSUME_CALL.length - 1);
    const asWritten = end === -1 ? body.slice(at) : body.slice(at, end + 1);
    return (
      `[S/arg-pin] \`${CLAIM_FN}\` calls \`${asWritten}\` but the sanctioned call is EXACTLY ` +
      `\`${CONSUME_PINNED}\`. The claim row is keyed by the GUEST identity, so consuming \`me\` ` +
      '(the caller) deletes NOTHING: the guest\u2019s `guest_claim` row and its armed reaper both ' +
      'survive `rekey_all`, and the 64-hex code stays redeemable until its TTL — a second account ' +
      'can replay it against a guest whose data has already moved. This exact one-token swap was ' +
      'PROVEN to leave [S/count], [S/depth0] and [S/success-region] green, which is why the ' +
      'ARGUMENT is pinned and not merely the call'
    );
  }

  // [S/depth0] — closes the dead-branch variant
  // `if account_has_game_data(ctx, guest) { consume... }`, whose condition is
  // always FALSE at this point (rekey_all has just moved the guest's rows away),
  // so the consume never executes while every needle-based clause is satisfied.
  const consumeAt = body.indexOf(CONSUME_PINNED);

  // [S/reachable] — REACHABILITY, not just position. Runs BEFORE the
  // depth/statement clauses so that this shape reports the clause that actually
  // describes it (the statement-position check would otherwise catch it first
  // and blame brace depth for a control-flow defect).
  //
  // Every other clause here reasons about WHERE the consume sits, never about
  // whether control reaches it. The red-team pass built a patch that satisfied
  // [S/count], [S/arg-pin], [S/depth0] AND [S/success-region] while the consume
  // never executed, at 80/80 evals and 547/547 Rust tests green:
  //
  //     rekey_all(ctx, guest, me)?;
  //     // "post-rekey belt: only an account holder may finalise provenance"
  //     if is_account_holder(ctx, me) {
  //         return Ok(());
  //     }
  //     consume_claim_and_disarm(ctx, guest);
  //
  // Guard 2 already bound `account` from `ctx.db.account().identity().find(me)`
  // and `rekey_all` never deletes it, so `is_account_holder(ctx, me)` is ALWAYS
  // true here: the early return always fires, the consume is dead code the
  // compiler cannot prove unreachable (no `unreachable_code` lint), and both
  // AUTH-34 single-use AND AUTH-21 provenance silently stop happening. The
  // guest's claim row and its armed reaper survive, so the 64-hex code stays
  // redeemable by a SECOND account until TTL.
  //
  // The success path is straight-line by design (ADR-0179: the entire reject
  // region is guards 1-11, all of which precede `rekey_all`), so ANY `return`
  // between the re-key and the consume is either dead code or a new early exit
  // that skips it. Banning the token outright is exact here, and a legitimate
  // future early exit is a PR-visible change to this gate.
  const rekeyAtEarly = body.indexOf(REKEY_CALL);
  if (consumeAt > rekeyAtEarly && rekeyAtEarly !== -1) {
    if (body.slice(rekeyAtEarly, consumeAt).indexOf('return') !== -1) {
      return (
        `[S/reachable] \`${CLAIM_FN}\` contains a \`return\` between \`${REKEY_CALL}\` and the ` +
        `\`${CONSUME_PINNED}\` call. After the re-key the success path is straight-line by ` +
        'design — every reject guard runs BEFORE `rekey_all` — so a `return` here either makes ' +
        'the consume dead code or adds an exit that skips it. Both leave the claim code ' +
        'redeemable until TTL (AUTH-34/35 dead) while [S/count], [S/arg-pin], [S/depth0] and ' +
        '[S/success-region] all stay green, because those clauses reason about POSITION, never ' +
        'REACHABILITY. Proven live by the M21c red-team pass at 80/80 evals green'
      );
    }
  }

  let depth = 0;
  for (let k = 0; k < consumeAt; k++) {
    if (body[k] === '{') depth++;
    else if (body[k] === '}') depth--;
  }
  // Statement position. Brace depth alone is NOT enough: the adversarial pass
  // found two depth-ZERO forms that never run, because they wrap the call in a
  // closure instead of a block —
  //     let _reap = || consume_claim_and_disarm(ctx, guest);          // never called
  //     std::iter::empty().for_each(|_| consume_claim_and_disarm(ctx, guest));
  // Both use only parentheses and pipes, so the `{`/`}` counter stays at 0, and
  // [S/count], [S/arg-pin] and [S/success-region] are all satisfied. Requiring
  // the call to be a bare STATEMENT — `;` immediately before, `;` immediately
  // after, in compacted text — kills the whole closure family in one line. The
  // shipped shape is `rekey_all(ctx, guest, me)?;` then the consume, so the
  // leading `;` always exists.
  const CONSUME_STATEMENT = `;${CONSUME_PINNED};`;
  if (depth === 0 && body.indexOf(CONSUME_STATEMENT) === -1) {
    return (
      `[S/depth0] the \`${CONSUME_PINNED}\` call in \`${CLAIM_FN}\` is at brace-depth 0 but is not ` +
      `a STATEMENT: the compacted body does not contain \`${CONSUME_STATEMENT}\`. The call is an ` +
      'operand of something else — almost always a closure body, which is depth-0 and never runs:\n' +
      '  let _reap = || consume_claim_and_disarm(ctx, guest);\n' +
      '  std::iter::empty().for_each(|_| consume_claim_and_disarm(ctx, guest));\n' +
      'Both compile, are clippy-clean, and satisfy [S/count], [S/arg-pin] and ' +
      '[S/success-region] while the claim code stays redeemable until its TTL (AUTH-34/35 dead). ' +
      'The success path is straight-line by design'
    );
  }

  if (depth !== 0) {
    return (
      `[S/depth0] the \`${CONSUME_PINNED}\` call sits at brace-depth ${depth} inside \`${CLAIM_FN}\`, ` +
      'not at the top level of the fn body. A conditional consume is a conditional single-use: ' +
      '`if account_has_game_data(ctx, guest) { consume_claim_and_disarm(ctx, guest); }` satisfies ' +
      'every count-, argument- and region-based clause while the branch is ALWAYS FALSE at that ' +
      'point (rekey_all has just moved the guest\u2019s rows onto the caller), so the code is never ' +
      'consumed. The success path is straight-line by design'
    );
  }

  // [S/success-region]
  const rekeyAt = body.indexOf(REKEY_CALL);
  const updateAt = body.indexOf(PROVENANCE_UPDATE);
  const okAt = body.lastIndexOf(TRAILING_OK);
  if (rekeyAt === -1 || updateAt === -1 || okAt === -1) {
    return (
      `[S/success-region] \`${CLAIM_FN}\` is missing one of the success-path anchors ` +
      `(\`${REKEY_CALL}\` at ${rekeyAt}, \`${PROVENANCE_UPDATE}\` at ${updateAt}, trailing ` +
      `\`${TRAILING_OK}\` at ${okAt}; -1 means absent). Without all three the region this clause ` +
      'constrains does not exist, so it would pass vacuously'
    );
  }
  if (!(consumeAt > rekeyAt && consumeAt < updateAt && consumeAt < okAt)) {
    return (
      `[S/success-region] in \`${CLAIM_FN}\` the consume at compacted offset ${consumeAt} is not ` +
      `inside the success region: it must follow \`${REKEY_CALL}\` (${rekeyAt}) and precede both ` +
      `\`${PROVENANCE_UPDATE}\` (${updateAt}) and the trailing \`${TRAILING_OK}\` (${okAt}). ` +
      'Ordering is load-bearing: `rekey_all` is fallible and its `?` rolls the whole transaction ' +
      'back, so a consume placed BEFORE it can be undone (or, in a future non-transactional ' +
      'refactor, can burn the code without moving the data), and a consume placed after the ' +
      'provenance stamp leaves a window where the account is marked claimed while the code is ' +
      'still live'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// G6 — REKEY_COMPLETENESS.
//
// ADR-0179 D6's manifest table is the SSOT, transcribed here as a const: M21a
// deliberately shipped NO Rust manifest const, so this is the only mechanical
// copy. Every `Identity` / `Option<Identity>` COLUMN in the whole module must
// have an entry, every entry must still resolve to a live column, and every
// REKEY entry must be CONSUMED at both call sites.
//
// Deliberately NOT tied to the ADR's markdown: D6's table has merged rows, an
// N/A row and TWO rows keyed `account`, so a heading/row-count doc-tie fails on
// a legitimate reword and passes on a wrong manifest.
// ---------------------------------------------------------------------------

/**
 * "table.field" -> 'EXEMPT: <reason>' | 'BLOCKED: <reason>' |
 * {rekey: '<helper>(', exists: '<predicate>('}.
 * @type {Record<string, string|{rekey:string, exists:string}>}
 */
const REKEY_MANIFEST = {
  // --- REKEY: moved from the guest identity onto the caller by rekey_all, and
  // counted as "game data" by account_has_game_data. ---
  'monster.owner_identity': { rekey: 'rekey_monsters(', exists: 'has_monsters(' },
  'monster_pub.owner_identity': { rekey: 'rekey_monsters(', exists: 'has_monsters(' },
  'inventory.owner_identity': { rekey: 'rekey_inventory(', exists: 'has_items(' },
  'player_quest.owner_identity': {
    rekey: 'rekey_npc_state(',
    exists: 'has_quest_or_dialogue_state(',
  },
  'player_dialogue_state.owner_identity': {
    rekey: 'rekey_npc_state(',
    exists: 'has_quest_or_dialogue_state(',
  },
  'heal_cooldown.owner_identity': { rekey: 'rekey_heal_cooldown(', exists: 'has_heal_cooldown(' },
  'player_wallet.owner_identity': { rekey: 'rekey_wallet(', exists: 'wallet_exists(' },
  'profile.identity': { rekey: 'rekey_profile(', exists: 'profile_exists(' },

  // --- BLOCKED: a guard rejects the claim while such a row exists, so there is
  // nothing to carry forward. ---
  'player.identity': 'BLOCKED: guard 1 (AUTH-18) rejects while the guest presence row exists',
  'player_conversation.owner_identity': 'BLOCKED: transitively covered by guards 1/3',
  // CORRECTED during the M21c security audit — ADR-0179 D6 records these as
  // "BLOCKED — guard 2", but `guards::is_in_ongoing_battle` (guards.rs:302-307)
  // filters `outcome == Ongoing`, so it blocks only LIVE battles. Terminal PvP
  // rows demonstrably persist: `settle_pvp_battle` (pvp.rs:491-533) updates the
  // row and never deletes it, and battle.rs:1119-1156 GCs prior terminals only
  // lazily on the next battle write-back. A guest who disconnects mid-PvP is
  // forfeited and leaves a TERMINAL row naming the guest identity; guard 10
  // passes, the claim succeeds, and that row is orphaned. Still not REKEY (a
  // finished battle's participants are history, not owned state) and not EXEMPT
  // (it is a real dangling reference), so the policy value stands — but the
  // REASON must be truthful, because M22 consumes this manifest as its
  // deletion-cascade SSOT and "BLOCKED" otherwise reads as "no cascade needed".
  'battle.player_identity':
    'BLOCKED: guard 2 (AUTH-19) blocks ONLY Ongoing rows — terminal rows survive and orphan; ' +
    'M22 cascade MUST sweep this column',
  'battle.opponent_identity':
    'BLOCKED: guard 2 (AUTH-19) blocks ONLY Ongoing rows — terminal rows survive and orphan; ' +
    'M22 cascade MUST sweep this column',
  'battle_action.player_identity': 'BLOCKED: transitively covered (requires an ongoing battle)',
  'trade_offer.initiator': 'BLOCKED: transitively covered by guards 1/3',
  'trade_offer.counterparty': 'BLOCKED: transitively covered by guards 1/3',
  'battle_challenge.challenger': 'BLOCKED: transitively covered by guards 1/3',
  // CORRECTED during the M21c security audit — `cancel_challenges_on_disconnect`
  // (pvp.rs:638-651) filters `challenge_id().challenger().filter(player)` only,
  // so an INCOMING pending challenge (guest is the `target`) survives the
  // guest's disconnect until the CHALLENGE_TTL_MS reaper fires. Guards 9, 10 and
  // 11 all pass — `account_has_game_data` (accounts.rs:209-216) never consults
  // `battle_challenge`. Low impact in M21 (a stale challenge that TTL-expires),
  // but the row is a real dangling reference and M22 inherits this table.
  // Contrast `battle_challenge.challenger` above, which IS genuinely blocked.
  'battle_challenge.target':
    'BLOCKED: only the CHALLENGER half is swept on disconnect (pvp.rs:638-651) — an incoming ' +
    'challenge survives until the TTL reaper; M22 cascade MUST sweep this column',

  // --- EXEMPT: never a foreign reference to re-key. ---
  'playtest_event.identity': 'EXEMPT: dev telemetry, deliberately stays under the guest identity',
  'config.owner_identity': 'EXEMPT: module-owner sentinel, defaults to the zero identity',
  'account.identity': "EXEMPT: this milestone's own primary key, always the caller's own identity",
  'account.claimed_from': 'EXEMPT: write target, not a rekey source (AUTH-21 records the guest)',
  'guest_claim.guest_identity': 'EXEMPT: consumed, not rekeyed (AUTH-34 / AUTH-27)',
  'guest_claim_reaper_schedule.guest_identity': 'EXEMPT: consumed, not rekeyed (AUTH-34 / AUTH-27)',
};

// Hardcoded INDEPENDENTLY of the manifest: four columns that must resolve for
// the scan to be believable at all. `playtest_event.identity` additionally
// carries its policy inline, because it is the one row of D6 that no
// brainstormer enumerated by memory — if the manifest silently loses it, the
// scan must not be able to pass.
const G6_ANCHORS = [
  'account.identity',
  'playtest_event.identity',
  'profile.identity',
  'player_wallet.owner_identity',
];
const G6_EXEMPT_ANCHOR = 'playtest_event.identity';

const REKEY_ALL_FN = 'rekey_all';
const HAS_GAME_DATA_FN = 'account_has_game_data';

/**
 * Every `Identity` / `Option<Identity>` COLUMN across a set of sources, keyed
 * "table.field". Uses battle-schema-snapshot's `parseTableSchemas`, which reads
 * ONLY `#[spacetimedb::table(...)] pub struct` field lists — a whole-file
 * `: Identity,` line match false-positives on the ~17 pre-existing FUNCTION
 * PARAMETER sites (ADR-0179 D6, finalization-pass note).
 * @param {Array<{path:string, src:string}>} treeSrcs Non-test server sources.
 * @returns {Map<string, {path:string, type:string}>} column key -> declaration.
 */
export function findIdentityColumns(treeSrcs) {
  const cols = new Map();
  for (const f of treeSrcs) {
    // Stripped, not raw: a `#[spacetimedb::table(` quoted inside a string
    // literal must not be able to inject a phantom table into the manifest scan.
    const tables = parseTableSchemas(stripRustSource(f.src));
    for (const table of Object.keys(tables)) {
      const columns = tables[table].columns ?? {};
      for (const field of Object.keys(columns)) {
        const type = compactWs(columns[field]);
        if (!containsIdent(type, 'Identity')) continue;
        cols.set(`${table}.${field}`, { path: f.path, type });
      }
    }
  }
  return cols;
}

/**
 * G6 REKEY_COMPLETENESS — the D6 manifest is complete, live, and consumed.
 * @param {Array<{path:string, src:string}>} treeSrcs Every non-test server source.
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @param {Record<string, string|{rekey:string, exists:string}>} [manifest]
 *   Injected policy table (defaults to REKEY_MANIFEST; the teeth inject
 *   deliberately wrong manifests so [G6/anchors] is provably not always-green).
 * @returns {string|null} Error string, or null on pass.
 */
export function checkRekeyCompleteness(treeSrcs, accountsSrc, manifest = REKEY_MANIFEST) {
  for (const f of treeSrcs) {
    const desync = assertStripperSound(f.src, f.path);
    if (desync) return desync;
  }

  // [G6/parse] — PARSER non-vacuity, the [STRIP/anchors] idea applied to
  // parseTableSchemas. [G6/declared] can only classify columns the parser
  // RETURNS, so a table declaration the parser cannot read hides every Identity
  // column in that struct — silently, and from the schema-snapshot baseline too
  // (a table absent from BOTH parsed and baseline is in neither side of the
  // union, so it reports no drift). Two live-legal spellings do exactly that:
  //   #[spacetimedb::table(name = t, index(btree, name = i, columns = [a, b]))]
  //     — the parser's `[^\]]*\)\]` sub-pattern cannot span the `]` of `[a, b]`;
  //   #[spacetimedb::table(public, name = t)]
  //     — the parser requires `name =` as the FIRST attribute argument.
  // So: every `#[spacetimedb::table(` in each stripped source must yield exactly
  // one parsed table. Verified equal across the live tree (37 attributes in the
  // 6 non-test files that declare tables, 37 parsed, 37 baseline entries).
  const TABLE_ATTR = '#[spacetimedb::table(';
  for (const f of treeSrcs) {
    const stripped = stripRustSource(f.src);
    const declared = countOccurrences(stripped, TABLE_ATTR);
    const parsed = Object.keys(parseTableSchemas(stripped)).length;
    if (declared !== parsed) {
      return (
        `[G6/parse] ${f.path} contains ${declared} \`${TABLE_ATTR}\` attribute(s) but ` +
        `parseTableSchemas returned ${parsed} table(s). A table the parser cannot read is a table ` +
        'whose Identity columns [G6/declared] never sees, so the re-key manifest would silently ' +
        'stop covering it — and the battle-schema-snapshot baseline would not notice either, ' +
        'because a table missing from BOTH parsed and baseline appears in neither side of that ' +
        'union. The two known unreadable spellings are a multi-column index inside the attribute ' +
        '(`index(btree, name = i, columns = [a, b])` — the parser cannot span the inner `]`) and ' +
        '`name =` not being the first attribute argument. Fix the declaration, or teach ' +
        'parseTableSchemas the new form in the same PR'
      );
    }
  }

  const columns = findIdentityColumns(treeSrcs);

  // [G6/declared] — forward direction: a NEW Identity column with no policy.
  for (const key of [...columns.keys()].sort()) {
    if (key in manifest) continue;
    const decl = columns.get(key);
    return (
      `[G6/declared] the column \`${key}\` (type \`${decl.type}\`, declared in ${decl.path}) has no ` +
      'entry in the ADR-0179 D6 re-key manifest. EVERY Identity column in the module needs an ' +
      'explicit policy — REKEY (carried from the guest onto the claiming account), BLOCKED (a ' +
      'guard rejects the claim while such a row exists) or EXEMPT (never a foreign reference). An ' +
      'unclassified column is data that a successful claim SILENTLY ORPHANS under the abandoned ' +
      'guest identity. Add it to REKEY_MANIFEST in the same PR that adds the column, and to D6'
    );
  }

  // [G6/live] — reverse direction: a stale policy for a column that is gone.
  for (const key of Object.keys(manifest)) {
    if (columns.has(key)) continue;
    return (
      `[G6/live] the manifest entry \`${key}\` does not resolve to any live table column. The check ` +
      'is BIDIRECTIONAL on purpose: a deleted or renamed column must not leave a stale policy ' +
      'behind, because a stale entry is indistinguishable from a live one when the next reviewer ' +
      'reads the manifest, and (for a REKEY entry) it keeps [G6/consumed] green for a helper that ' +
      'no longer re-keys anything'
    );
  }

  // [G6/anchors] — non-vacuity, hardcoded independently of the manifest.
  for (const key of G6_ANCHORS) {
    if (!columns.has(key)) {
      return (
        `[G6/anchors] the anchor column \`${key}\` was not found in the scanned tree. These four ` +
        'columns are hardcoded INDEPENDENTLY of the manifest precisely so that an empty scan set, ' +
        'a wrong glob or a parser regression cannot leave [G6/declared] and [G6/live] both ' +
        `passing vacuously (they are trivially satisfied when the column set is empty). Anchors: ` +
        `${G6_ANCHORS.join(', ')}`
      );
    }
  }
  const exemptPolicy = manifest[G6_EXEMPT_ANCHOR];
  if (typeof exemptPolicy !== 'string' || !exemptPolicy.startsWith('EXEMPT')) {
    return (
      `[G6/anchors] the manifest policy for \`${G6_EXEMPT_ANCHOR}\` is not EXEMPT (got ` +
      `${JSON.stringify(exemptPolicy)}). ADR-0179 D6 pins it as dev telemetry that deliberately ` +
      'STAYS under the guest identity — M22\u2019s cascade erases it. It is also the one row of D6 ' +
      'that no brainstormer enumerated by memory, which is the whole reason this manifest is ' +
      'gated mechanically rather than maintained by hand, so its policy is asserted by value here'
    );
  }

  // [G6/consumed] — every REKEY entry is actually wired into BOTH call sites.
  const desync = assertStripperSound(accountsSrc, ACCOUNTS_PATH);
  if (desync) return desync;
  const stripped = stripRustSource(accountsSrc);
  const sites = [
    { fn: REKEY_ALL_FN, kind: 'rekey' },
    { fn: HAS_GAME_DATA_FN, kind: 'exists' },
  ];
  const bodies = {};
  for (const site of sites) {
    const span = findFnBody(stripped, site.fn);
    if (span === null) {
      return (
        `[G6/consumed] fn \`${site.fn}\` was not found in ${ACCOUNTS_PATH} — the consumption scan ` +
        'has NO scope and would pass vacuously. Fail loud rather than skip'
      );
    }
    const body = compactWs(stripped.slice(span.start, span.end));
    if (body === '') {
      return (
        `[G6/consumed] fn \`${site.fn}\` in ${ACCOUNTS_PATH} has an EMPTY body — it cannot be both ` +
        'implemented and empty'
      );
    }
    bodies[site.kind] = body;
  }

  for (const key of Object.keys(manifest)) {
    const policy = manifest[key];
    if (typeof policy === 'string') continue;
    if (bodies.rekey.indexOf(policy.rekey) === -1) {
      return (
        `[G6/consumed] the manifest marks \`${key}\` as REKEY via \`${policy.rekey}\` but that ` +
        `helper is never called from \`${REKEY_ALL_FN}\` (${ACCOUNTS_PATH}:221-229). A table with ` +
        'a policy but no call is silently ORPHANED on every successful claim: the guest\u2019s rows ' +
        'stay under an identity the player can no longer authenticate as'
      );
    }
    if (bodies.exists.indexOf(policy.exists) === -1) {
      return (
        `[G6/consumed] the manifest marks \`${key}\` as REKEY, but its existence predicate ` +
        `\`${policy.exists}\` is never called from \`${HAS_GAME_DATA_FN}\` ` +
        `(${ACCOUNTS_PATH}:209-216). This half of the clause is the ONLY part of G6 that nothing ` +
        'else in the repo covers — accounts_tests.rs:1320 pins the six `rekey_all` delegations in ' +
        'D6 order but never enumerates the exists-helpers. A missing predicate breaks guard 11 ' +
        '(AUTH-20, D5.3 fail-closed): a destination account that already owns rows in THAT table ' +
        'is no longer detected, so the claim proceeds and either clobbers or PK-collides the ' +
        "caller's own data"
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH FIXTURES (FG1-FG59) — inline sources, run BEFORE the live-tree
// checks. Returns the first tooth failure (string) or null.
//
// The Rust fixtures below are STRING LITERALS in a .mjs file; the live scan
// globs server-module/src/**/*.rs only, so they can never be picked up as real
// source. Fixtures that contain backslashes use String.raw so the Rust text
// reaches the checker byte-for-byte.
// ---------------------------------------------------------------------------

/**
 * Assert that a checker fired the EXPECTED clause (by tag), not merely that it
 * failed — a fixture that only asserts "some error" cannot tell a live clause
 * from a deleted one whose neighbour happens to catch the fixture.
 * @param {string|null} err Checker output.
 * @param {string} tag Expected clause tag.
 * @param {string} label Fixture label for the failure message.
 * @returns {string|null} Tooth failure, or null when the tag matches.
 */
function expectTag(err, tag, label) {
  if (!err) return `${label}: expected clause ${tag} to fire, but the checker returned PASS`;
  if (err.indexOf(tag) === -1) {
    return `${label}: expected clause ${tag} to fire, but a different clause did: ${err}`;
  }
  return null;
}

/**
 * Substitute fixture text, failing loudly when the target is absent — a silent
 * no-op substitution turns a BAD fixture into a second GOOD one.
 * @param {string} src Fixture source.
 * @param {string} from Literal target.
 * @param {string} to Replacement.
 * @returns {string} Mutated source.
 */
function mut(src, from, to) {
  if (src.indexOf(from) === -1) {
    throw new Error(`fixture substitution target not found: ${JSON.stringify(from)}`);
  }
  return src.replace(from, to);
}

// A GOOD accounts.rs stand-in: the shipped shape, deliberately HOSTILE. `rng`,
// `Identity::from_hex(` and `ctx.db.battle(` all appear — in a doc comment and
// in string literals ONLY — plus a zero-hash raw string, char literals and a
// lifetime for the lexer. Every checker in this file must PASS it.
const GOOD_ACCOUNTS = String.raw`
//! WRITE-ISOLATION: writes only account / guest_claim /
//! guest_claim_reaper_schedule. Battle liveness reuses guards::is_in_ongoing_battle
//! rather than touching ctx.db.battle() and the module never calls ctx.rng().

use crate::guards::{is_in_ongoing_battle, log_reject};
use crate::schema::{account, guest_claim, player, Account, GuestClaim};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, Timestamp};

pub(crate) const ALLOWED_ISSUERS: &[&str] = &[concat!("https:/", "/auth.monster-realm.invalid/")];
pub(crate) const ALLOWED_AUDIENCE: &[&str] = &["monster-realm"];
const REJECT_UNRECOGNIZED_ISSUER: &str = "unrecognized issuer";
const REJECT_UNRECOGNIZED_AUDIENCE: &str = "unrecognized audience";
pub const PROSE: &str = "ctx.rng() and Identity::from_hex(h) and ctx.db.battle() are DATA here";
pub const WIN_PATH: &str = r"C:\";
const TICK: char = '\'';
const GRIN: char = '\u{1F600}';

fn hexy<'a>(s: &'a str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn account_has_game_data(ctx: &ReducerContext, identity: Identity) -> bool {
    crate::monster_mgmt::has_monsters(ctx, identity)
        || crate::inventory::has_items(ctx, identity)
        || crate::economy::wallet_exists(ctx, identity)
        || crate::ranking::profile_exists(ctx, identity)
        || crate::npc::has_quest_or_dialogue_state(ctx, identity)
        || crate::raising::has_heal_cooldown(ctx, identity)
}

pub(crate) fn rekey_all(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
    crate::monster_mgmt::rekey_monsters(ctx, from, to)?;
    crate::inventory::rekey_inventory(ctx, from, to);
    crate::npc::rekey_npc_state(ctx, from, to);
    crate::raising::rekey_heal_cooldown(ctx, from, to);
    crate::economy::rekey_wallet(ctx, from, to);
    crate::ranking::rekey_profile(ctx, from, to);
    Ok(())
}

fn delete_claim(ctx: &ReducerContext, guest: Identity) {
    ctx.db.guest_claim().guest_identity().delete(guest);
}

pub(crate) fn consume_claim_and_disarm(ctx: &ReducerContext, guest: Identity) {
    delete_claim(ctx, guest);
    let ids: Vec<u64> = ctx
        .db
        .guest_claim_reaper_schedule()
        .guest_identity()
        .filter(guest)
        .map(|s| s.scheduled_id)
        .collect();
    for id in ids {
        ctx.db
            .guest_claim_reaper_schedule()
            .scheduled_id()
            .delete(id);
    }
}

pub(crate) fn provision_or_touch_account(ctx: &ReducerContext) -> Result<(), String> {
    let Some(claims) = ctx.sender_auth().jwt() else {
        return Ok(());
    };
    let issuer = claims.issuer();
    if !issuer_allowed(issuer, ALLOWED_ISSUERS) {
        log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_ISSUER);
        return Ok(());
    }
    if !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {
        log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_AUDIENCE);
        return Err(REJECT_UNRECOGNIZED_AUDIENCE.to_string());
    }
    let now = now_ms(ctx);
    match ctx.db.account().identity().find(ctx.sender) {
        Some(existing) => {
            ctx.db
                .account()
                .identity()
                .update(touch_login(existing, now));
        }
        None => {
            ctx.db
                .account()
                .insert(new_account_row(ctx.sender, issuer.to_string(), now));
        }
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn start_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let me = ctx.sender;
    let Some(player) = ctx.db.player().identity().find(me) else {
        return reject("start_guest_claim", me, "not joined");
    };
    consume_claim_and_disarm(ctx, me);
    let now = now_ms(ctx);
    let row = claim_row(me, code, player.name, now);
    let expires_at_ms = row.expires_at_ms;
    ctx.db.guest_claim().insert(row);
    ctx.db
        .guest_claim_reaper_schedule()
        .insert(GuestClaimReaperSchedule {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(
                expires_at_ms.saturating_mul(1_000),
            )),
            guest_identity: me,
        });
    Ok(())
}

#[spacetimedb::reducer]
pub fn complete_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let me = ctx.sender;
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("complete_guest_claim", me, "no account");
    };
    let Some(claim) = ctx.db.guest_claim().code().find(&code) else {
        return reject("complete_guest_claim", me, ERR_INVALID_CODE);
    };
    let guest = claim.guest_identity;
    if ctx.db.player().identity().find(guest).is_some() {
        return reject("complete_guest_claim", me, "close your other tab, then retry");
    }
    if is_in_ongoing_battle(ctx, guest) || is_in_ongoing_battle(ctx, me) {
        return reject("complete_guest_claim", me, "already in an ongoing battle");
    }
    if account_has_game_data(ctx, me) {
        return reject("complete_guest_claim", me, "already has game data");
    }
    rekey_all(ctx, guest, me)?;
    consume_claim_and_disarm(ctx, guest);
    ctx.db
        .account()
        .identity()
        .update(claimed_account(account, guest, now_ms(ctx)));
    Ok(())
}

#[spacetimedb::reducer]
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender;
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("delete_account", me, "no account");
    };
    ctx.db
        .account()
        .identity()
        .update(requested_deletion(account, now_ms(ctx)));
    Ok(())
}

#[spacetimedb::reducer]
pub fn cancel_account_deletion(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender;
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("cancel_account_deletion", me, "no account");
    };
    ctx.db
        .account()
        .identity()
        .update(cancelled_deletion(account));
    Ok(())
}

#[spacetimedb::table(name = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
pub struct GuestClaimReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub guest_identity: Identity,
}

#[spacetimedb::reducer]
pub fn guest_claim_reaper(
    ctx: &ReducerContext,
    args: GuestClaimReaperSchedule,
) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("guest_claim_reaper is scheduler-only".to_string());
    }
    delete_claim(ctx, args.guest_identity);
    Ok(())
}
`;

// A GOOD lib.rs stand-in: the shipped connect hook.
const GOOD_LIB = `
#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String> {
    if !ctx.sender_auth().has_jwt() {
        return Ok(());
    }
    accounts::provision_or_touch_account(ctx)
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    ctx.db.player().identity().delete(ctx.sender);
}
`;

// E1, verbatim from the red-team PoC (compiles; clippy-clean).
const E1_STRUCT_REDUCER = `
#[derive(spacetimedb::SpacetimeType)]
pub struct ClaimTarget {
    pub guest_identity: Identity,
}

#[spacetimedb::reducer]
pub fn complete_guest_claim_for(ctx: &ReducerContext, target: ClaimTarget) -> Result<(), String> {
    rekey_all(ctx, target.guest_identity, ctx.sender)
}
`;

// E2, verbatim from the red-team PoC (compiles; clippy-clean).
const E2_FROM_HEX_REDUCER = `
#[spacetimedb::reducer]
pub fn adopt_guest(ctx: &ReducerContext, guest_hex: String) -> Result<(), String> {
    let g = Identity::from_hex(&guest_hex).map_err(|_| "bad hex".to_string())?;
    rekey_all(ctx, g, ctx.sender)
}
`;

/**
 * A DELIBERATELY BROKEN stripper: quote-uniform and raw-string-blind, exactly
 * the shape the red-team defeated. Injected into assertStripperSound so the
 * self-check is provably not always-green.
 * @param {string} src Raw source.
 * @returns {string} Same-length, WRONGLY stripped source.
 */
function fakeRawBlindStrip(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (src[i] === DQ) {
      let j = i + 1;
      while (j < src.length && src[j] !== DQ) {
        if (src[j] === '\\') j++;
        j++;
      }
      for (let k = i + 1; k < Math.min(j, src.length); k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Build a schema stand-in declaring exactly the given "table.field" columns as
 * Identity columns, one `#[spacetimedb::table(...)] pub struct` per table.
 * Deriving the GOOD tree from the manifest keeps the fixture readable; the teeth
 * come from the BAD mutations below and from the LIVE tree scan, which is the
 * only genuinely independent bidirectional test.
 * @param {string[]} keys "table.field" keys to declare.
 * @returns {string} Fixture Rust source.
 */
function synthSchemaSrc(keys) {
  const byTable = new Map();
  for (const key of keys) {
    const dot = key.indexOf('.');
    const table = key.slice(0, dot);
    const field = key.slice(dot + 1);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(field);
  }
  let out = '// synthesized schema fixture\n';
  for (const [table, fields] of byTable) {
    out += `#[spacetimedb::table(name = ${table})]\npub struct Row_${table} {\n`;
    for (const field of fields) {
      // `claimed_from` is the one Option<Identity> column in the live schema —
      // spelled that way here so the Option path is genuinely exercised.
      const type = field === 'claimed_from' ? 'Option<Identity>' : 'Identity';
      out += `    pub ${field}: ${type},\n`;
    }
    out += '    pub note: String,\n}\n\n';
  }
  return out;
}

// The scheduled table (and its guest_identity column) is declared by
// GOOD_ACCOUNTS itself, exactly as in the live tree, so the synthesized schema
// deliberately omits it.
const SYNTH_KEYS = Object.keys(REKEY_MANIFEST).filter(
  (k) => k !== 'guest_claim_reaper_schedule.guest_identity',
);
const GOOD_TREE = [
  { path: 'fixture/schema.rs', src: synthSchemaSrc(SYNTH_KEYS) },
  { path: 'fixture/accounts.rs', src: GOOD_ACCOUNTS },
];

function runTeeth() {
  // --- stripper machinery -------------------------------------------------

  // FG1 — direct behavioural pin on the stripper.
  // Kills: a comments-before-strings stripper (a slash-slash inside a URL
  // literal truncates the line and unbalances every quote after it), and a
  // stripper that lets a code needle quoted inside a literal reach the clauses.
  {
    const src = String.raw`
pub const URL: &str = "https://auth.example.invalid/x";
pub const OPENER: &str = "SLASH_STAR_PLACEHOLDER";
pub const DECOY: &str = "ctx.rng() and ctx.db.battle() and Identity::from_hex(h)";
pub const WIN: &str = r"C:\";
pub struct Probe;
fn probe(ctx: &Ctx) {
    ctx.db.player().identity().delete(victim);
}
`.replace('SLASH_STAR_PLACEHOLDER', SLASH_STAR + ' not a comment ' + STAR_SLASH);
    const flat = compactWs(stripRustSource(src));
    if (flat.indexOf('ctx.db.player().identity().delete(victim)') === -1) {
      return (
        'FG1: real code AFTER the hostile literals was blanked — the stripper desynced on a ' +
        'slash-slash inside a literal, a block-comment opener inside a literal, or the zero-hash ' +
        'raw string'
      );
    }
    for (const quoted of ['ctx.rng(', 'ctx.db.battle(', 'Identity::from_hex(']) {
      if (flat.indexOf(quoted) !== -1) {
        return `FG1: the needle ${quoted} quoted INSIDE a string literal survived stripping`;
      }
    }
    if (stripRustSource(src).length !== src.length) {
      return 'FG1: the stripper is not length-preserving, so every downstream offset is wrong';
    }
  }

  // FG2 — the self-check must FIRE for a raw-string-blind stripper, on all
  // three proven raw-string forms. Each puts a hostile const BEFORE the
  // scheduled-table anchors: a stripper that mis-lexes it inverts quote polarity
  // and blanks the declarations that follow, which is exactly the desync that
  // GREENS every ban clause in this file while reding only presence clauses.
  // Kills: an always-green desync self-check (the only clause able to see a
  // desync at all), and a stripper hardened for only one of the three forms.
  {
    const forms = [
      String.raw`pub const A: &str = r"C:\";`,
      String.raw`pub const B: &str = r##"use "code" or "CODE"##;`,
      String.raw`pub const C: &[u8] = br##"a"b"##;`,
    ];
    for (let k = 0; k < forms.length; k++) {
      const src = `${forms[k]}
#[spacetimedb::table(name = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
pub struct GuestClaimReaperSchedule {
    pub guest_identity: Identity,
}
`;
      // The REAL stripper must find this source SOUND ...
      const good = assertStripperSound(src, `FG2.${k + 1}`);
      if (good) return `FG2.${k + 1}: the real stripper was reported unsound: ${good}`;
      // ... and the raw-string-blind one must be caught.
      const bad = expectTag(
        assertStripperSound(src, 'fixture', fakeRawBlindStrip),
        '[STRIP/anchors]',
        `FG2.${k + 1}`,
      );
      if (bad) return `${bad} (raw-string form: ${forms[k]})`;
    }
  }

  // FG3 — the self-check must FIRE for a length-changing stripper.
  {
    const bad = expectTag(
      assertStripperSound('pub struct A;\n', 'fixture', (s) => s.replace('pub struct A;', '')),
      '[STRIP/length]',
      'FG3',
    );
    if (bad) return bad;
  }

  // FG4 — the self-check must FIRE for a non-idempotent stripper (each pass
  // blanks one more character, exactly as an unbalanced quote pair does).
  {
    const bad = expectTag(
      assertStripperSound('pub struct Xxx;\n', 'fixture', (s) => s.replace('x', ' ')),
      '[STRIP/idempotent]',
      'FG4',
    );
    if (bad) return bad;
  }
  // FG5 — GOOD: the REAL stripper on the hostile-but-correct sources must PASS.
  // Kills: an always-red self-check (indistinguishable from a working one) —
  // a stripper that reports every source unsound is not a gate, it is an outage.
  {
    const goodSources = [
      ['GOOD_ACCOUNTS', GOOD_ACCOUNTS],
      ['GOOD_LIB', GOOD_LIB],
    ];
    for (const [label, src] of goodSources) {
      const err = assertStripperSound(src, label);
      if (err) return `FG5: the real stripper was reported unsound on ${label}: ${err}`;
    }
  }

  // --- G2: NO_CLIENT_IDENTITY ---------------------------------------------

  // FG6 — GOOD: the shipped reducer surface, INCLUDING the real scheduled-reducer
  // shape (a table struct carrying `guest_identity: Identity`, a
  // `fn guest_claim_reaper(ctx, args: GuestClaimReaperSchedule)` signature and
  // the `ctx.sender != ctx.identity()` guard) must PASS.
  // Kills: an always-red G2 checker, and a blanket "no struct arguments" rule
  // that would false-RED the legitimate scheduled reducer on arrival.
  {
    const err = checkNoClientIdentity(GOOD_ACCOUNTS);
    if (err) return `FG6: the GOOD (hostile) accounts source was incorrectly flagged: ${err}`;
  }

  // FG7 — the direct form: a reducer takes an Identity from the wire.
  // Kills: a G2 checker that only looks at reducer NAMES.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      'pub fn complete_guest_claim(ctx: &ReducerContext, code: String)',
      'pub fn complete_guest_claim(ctx: &ReducerContext, code: String, guest: Identity)',
    );
    const bad = expectTag(checkNoClientIdentity(src), '[R/identity-param]', 'FG7');
    if (bad) return bad;
  }

  // FG8 — the same, wrapped in Option (a type-text equality check would miss it).
  {
    const src = mut(
      GOOD_ACCOUNTS,
      'pub fn delete_account(ctx: &ReducerContext)',
      'pub fn delete_account(ctx: &ReducerContext, on_behalf_of: Option<Identity>)',
    );
    const bad = expectTag(checkNoClientIdentity(src), '[R/identity-param]', 'FG8');
    if (bad) return bad;
  }

  // FG9 — E1's struct argument grafted onto an EXISTING reducer name, so
  // [R/name-set] cannot be the clause that catches it.
  // Kills: a G2 checker whose only additive defence is the name set.
  {
    const src =
      mut(
        GOOD_ACCOUNTS,
        'pub fn complete_guest_claim(ctx: &ReducerContext, code: String)',
        'pub fn complete_guest_claim(ctx: &ReducerContext, target: ClaimTarget)',
      ) +
      `
#[derive(spacetimedb::SpacetimeType)]
pub struct ClaimTarget {
    pub guest_identity: Identity,
}
`;
    const bad = expectTag(checkNoClientIdentity(src), '[R/param-types]', 'FG9');
    if (bad) return bad;
  }

  // FG10 (red-team E1, CRITICAL) — the PoC verbatim: an ADDED reducer taking a
  // SpacetimeType struct whose field is an Identity. Declares no `: Identity`
  // parameter, compiles, passes clippy, and is a code-less transfer of any
  // identity's monsters/inventory/wallet/NPC-state/profile.
  // Kills: the naive "no reducer declares an `: Identity` parameter" clause.
  {
    const bad = expectTag(
      checkNoClientIdentity(GOOD_ACCOUNTS + E1_STRUCT_REDUCER),
      '[R/param-types]',
      'FG10',
    );
    if (bad) return bad;
  }

  // FG11 — the scheduled carve-out abused: the reaper's argument type is swapped
  // for an attacker-shaped struct while the table/guard stay put.
  // Kills: a carve-out keyed on the reducer NAME alone.
  {
    const src =
      mut(GOOD_ACCOUNTS, '    args: GuestClaimReaperSchedule,\n', '    args: ClaimTarget,\n') +
      `
#[derive(spacetimedb::SpacetimeType)]
pub struct ClaimTarget {
    pub guest_identity: Identity,
}
`;
    const bad = expectTag(checkNoClientIdentity(src), '[R/param-types]', 'FG11');
    if (bad) return bad;
  }

  // FG12 — the scheduled reducer keeps its struct argument but LOSES the
  // scheduler guard, so any client can invoke it with a hand-built row.
  // Kills: a carve-out that checks only "is this a scheduled target".
  {
    const src = mut(
      GOOD_ACCOUNTS,
      `    if ctx.sender != ctx.identity() {
        return Err("guest_claim_reaper is scheduler-only".to_string());
    }
`,
      '',
    );
    const bad = expectTag(checkNoClientIdentity(src), '[R/param-types]', 'FG12');
    if (bad) return bad;
  }

  // FG13 (red-team E2, CRITICAL) — the PoC verbatim: a wire-safe String
  // parameter parsed back into an Identity. Parameter-type analysis alone is
  // green on it. Kills: a G2 checker with no constructor ban.
  {
    const bad = expectTag(
      checkNoClientIdentity(GOOD_ACCOUNTS + E2_FROM_HEX_REDUCER),
      '[R/identity-ctor]',
      'FG13',
    );
    if (bad) return bad;
  }

  // FG14 — the byte-array constructor variant, inside an EXISTING reducer.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    rekey_all(ctx, guest, me)?;',
      '    let forged = Identity::from_byte_array([7u8; 32]);\n    rekey_all(ctx, forged, me)?;',
    );
    const bad = expectTag(checkNoClientIdentity(src), '[R/identity-ctor]', 'FG14');
    if (bad) return bad;
  }

  // FG15 — an ADDED reducer whose parameters are entirely wire-safe and which
  // constructs nothing: only the exact NAME SET can see it.
  // Kills: a `>= 5` count check, and an "each expected name is present" check.
  {
    const src =
      GOOD_ACCOUNTS +
      `
#[spacetimedb::reducer]
pub fn adopt_guest_by_code(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let claim = ctx.db.guest_claim().code().find(&code).ok_or("no")?;
    rekey_all(ctx, claim.guest_identity, ctx.sender)
}
`;
    const bad = expectTag(checkNoClientIdentity(src), '[R/name-set]', 'FG15');
    if (bad) return bad;
  }

  // FG16 — a sanctioned reducer LEAVES the surface (renamed). A one-sided "no
  // NEW reducers" check stays green while a client entry point disappears.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      'pub fn cancel_account_deletion(ctx: &ReducerContext)',
      'pub fn undo_account_deletion(ctx: &ReducerContext)',
    );
    const bad = expectTag(checkNoClientIdentity(src), '[R/name-set]', 'FG16');
    if (bad) return bad;
  }

  // FG17 — the empty-target blind spot: no reducers parsed at all.
  // Kills: a checker that "passes" when its scan set vanishes.
  {
    const bad = expectTag(
      checkNoClientIdentity('// every reducer moved to another module\n'),
      '[R/name-set]',
      'FG17',
    );
    if (bad) return bad;
  }

  // --- G3: ANON_PASSTHROUGH ------------------------------------------------

  // FG18 — GOOD: the shipped connect hook must PASS. Note `ctx.sender_auth()`
  // legitimately precedes `has_jwt(`, which is why [I/anon-first] names an
  // explicit token set instead of "first statement".
  {
    const err = checkAnonPassthrough(GOOD_LIB);
    if (err) return `FG18: the GOOD connect hook was incorrectly flagged: ${err}`;
  }

  // FG19 — provisioning runs BEFORE the anonymous early-out, so every tokenless
  // connection pays for (and can be rejected by) the account path.
  {
    const src = mut(
      GOOD_LIB,
      `    if !ctx.sender_auth().has_jwt() {
        return Ok(());
    }
    accounts::provision_or_touch_account(ctx)`,
      `    accounts::provision_or_touch_account(ctx)?;
    if !ctx.sender_auth().has_jwt() {
        return Ok(());
    }
    Ok(())`,
    );
    const bad = expectTag(checkAnonPassthrough(src), '[I/anon-first]', 'FG19');
    if (bad) return bad;
  }

  // FG20 — the vendor's canonical "reject JWT-less connections" pattern, which
  // DISCONNECTS every anonymous player. Kills: an ordering-only G3 check.
  {
    const src = mut(
      GOOD_LIB,
      '        return Ok(());\n',
      '        return Err("sign in".into());\n',
    );
    const bad = expectTag(checkAnonPassthrough(src), '[I/anon-no-err]', 'FG20');
    if (bad) return bad;
  }

  // FG21 — the JWT branch is deleted outright: the hook provisions
  // unconditionally. Kills: a clause that only compares two indices it found.
  {
    const src = mut(
      GOOD_LIB,
      `    if !ctx.sender_auth().has_jwt() {
        return Ok(());
    }
`,
      '',
    );
    const bad = expectTag(checkAnonPassthrough(src), '[I/anon-first]', 'FG21');
    if (bad) return bad;
  }

  // --- G3: ISSUER_AND_AUDIENCE_CHECKED ------------------------------------

  // FG22 — GOOD: the shipped provisioning path must PASS (rustfmt-wrapped
  // `ctx.db` / `.account()` / `.insert(` chains included).
  {
    const err = checkIssuerAndAudience(GOOD_ACCOUNTS);
    if (err) return `FG22: the GOOD provisioning path was incorrectly flagged: ${err}`;
  }

  // FG23 — the issuer allowlist check is deleted: ANY OIDC provider on the
  // internet can mint a token that provisions an account.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      `    if !issuer_allowed(issuer, ALLOWED_ISSUERS) {
        log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_ISSUER);
        return Ok(());
    }
`,
      '',
    );
    const bad = expectTag(checkIssuerAndAudience(src), '[I/iss]', 'FG23');
    if (bad) return bad;
  }

  // FG24 (red-team B8/F9) — THE empty-`aud` short-circuit. Inverts AUTH-3
  // (accounts.rs:89-90: an empty `aud` MUST reject) so an audience-less token
  // provisions an account. Compiles, clippy-clean, and every presence-based
  // [I/*] clause stays green. Kills: any presence-only spelling of [I/aud].
  {
    const src = mut(
      GOOD_ACCOUNTS,
      'if !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {',
      'if !claims.audience().is_empty() && !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {',
    );
    const bad = expectTag(checkIssuerAndAudience(src), '[I/aud]', 'FG24');
    if (bad) return bad;
  }

  // FG25 — the audience block deleted outright (the same-issuer cross-app
  // confused-deputy token now provisions an account).
  {
    const src = mut(
      GOOD_ACCOUNTS,
      `    if !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {
        log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_AUDIENCE);
        return Err(REJECT_UNRECOGNIZED_AUDIENCE.to_string());
    }
`,
      '',
    );
    const bad = expectTag(checkIssuerAndAudience(src), '[I/aud]', 'FG25');
    if (bad) return bad;
  }

  // FG26 (red-team B8 variant) — the allowlist consts are SWAPPED on the issuer
  // side. Both are `&[&str]`, so it type-checks; [I/iss] and [I/aud] both stay
  // green because the issuer predicate is still called and the audience guard
  // shape is untouched. Kills: a presence-only const check.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      'if !issuer_allowed(issuer, ALLOWED_ISSUERS) {',
      'if !issuer_allowed(issuer, ALLOWED_AUDIENCE) {',
    );
    const bad = expectTag(checkIssuerAndAudience(src), '[I/const-pin]', 'FG26');
    if (bad) return bad;
  }

  // FG27 — the row is inserted first and validated afterwards.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    let issuer = claims.issuer();\n',
      `    let issuer = claims.issuer();
    ctx.db
        .account()
        .insert(new_account_row(ctx.sender, issuer.to_string(), now_ms(ctx)));
`,
    );
    const bad = expectTag(checkIssuerAndAudience(src), '[I/before-insert]', 'FG27');
    if (bad) return bad;
  }

  // --- G4: NO_SERVER_RNG ---------------------------------------------------

  // FG28 — GOOD: `rng` appears in a doc comment AND inside a string literal in
  // GOOD_ACCOUNTS and must NOT be flagged. Kills: a raw-text grep.
  {
    const err = checkNoServerRng(GOOD_ACCOUNTS);
    if (err) return `FG28: a hostile-but-clean source was incorrectly flagged: ${err}`;
  }

  // FG29 — the server mints the claim code from the module RNG (AUTH-11 dead).
  // Written rustfmt-WRAPPED, so it also proves the compaction is load-bearing.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    let now = now_ms(ctx);\n    let row = claim_row(me, code, player.name, now);',
      `    let code = ctx
        .rng()
        .gen::<[u8; 32]>();
    let now = now_ms(ctx);
    let row = claim_row(me, hex(code), player.name, now);`,
    );
    const bad = expectTag(checkNoServerRng(src), '[N/rng]', 'FG29');
    if (bad) return bad;
  }

  // FG30 — the `ctx.random(` spelling.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    let now = now_ms(ctx);\n    let row = claim_row',
      '    let salt = ctx.random();\n    let now = now_ms(ctx);\n    let row = claim_row',
    );
    const bad = expectTag(checkNoServerRng(src), '[N/random]', 'FG30');
    if (bad) return bad;
  }

  // --- G5: MODULE_WRITE_ISOLATION -----------------------------------------

  // FG31 — GOOD: the shipped module (owned writes in rustfmt-wrapped chains,
  // two bare `player` READS, `ctx.db.battle(` and `rng` only in prose) must PASS.
  {
    const err = checkModuleWriteIsolation(GOOD_ACCOUNTS);
    if (err) return `FG31: the GOOD accounts source was incorrectly flagged: ${err}`;
  }

  // FG32 — GOOD: an explicit bare READ of the foreign `player` table alongside
  // owned writes. Kills: a table-scoped (rather than WRITE-scoped) rule, which
  // would false-RED accounts.rs:349 and :410 on arrival.
  {
    const src = `
fn probe(ctx: &ReducerContext, g: Identity) {
    let present = ctx.db.player().identity().find(g).is_some();
    ctx.db.guest_claim().guest_identity().delete(g);
    let _ = present;
}
`;
    const err = checkModuleWriteIsolation(src);
    if (err) return `FG32: a bare READ of player alongside an owned write was flagged: ${err}`;
  }

  // FG33 — GOOD: a `Vec::insert` in the statement AFTER a foreign read. The
  // accessor -> verb span must stop at the `;`, or an unrelated `.insert(` is
  // misattributed to `player`. Kills: an unbounded rfind/indexOf span.
  {
    const src = `
fn probe(ctx: &ReducerContext, g: Identity, x: u64) {
    let mut ids: Vec<u64> = Vec::new();
    ctx.db.player().identity().find(g);
    ids.insert(0, x);
    ctx.db.account().identity().update(touch(g));
}
`;
    const err = checkModuleWriteIsolation(src);
    if (err) return `FG33: a Vec::insert after an unrelated read was misattributed: ${err}`;
  }

  // FG34 — a chained foreign delete.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    ctx.db.player().identity().delete(from);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/write-target]', 'FG34');
    if (bad) return bad;
  }

  // FG35 — the same write in this repo's OWN rustfmt style (the chain broken
  // across four lines). Kills: any contiguous needle — this is the A2 corollary
  // that reddened the draft on day one.
  {
    const src = `
fn probe(ctx: &ReducerContext, row: Profile) {
    ctx.db.account().insert(row.account);
    ctx.db
        .profile()
        .identity()
        .update(row);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/write-target]', 'FG35');
    if (bad) return bad;
  }

  // FG36 — the UFCS form, where the write verb PRECEDES the accessor. Kills: a
  // forward-only span scan, which reads this as a bare read.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    UniqueColumn::delete(&ctx.db.player().identity(), from);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/write-target]', 'FG36');
    if (bad) return bad;
  }

  // FG37 (red-team B5/F5, HIGH) — THE split binding. With the accessor -> verb
  // span bounded at `;` this write is UNDETECTED by [W/write-target] alone,
  // which is a net regression versus the Rust twin's unbounded rfind
  // (accounts_tests.rs:1569). Kills: shipping the `;`-bound without its
  // mandatory companion clause.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    let presence = ctx.db.player();
    presence.identity().delete(from);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/split-binding]', 'FG37');
    if (bad) return bad;
  }

  // FG37b (merge-gate verifier, BLOCKER) — the context itself aliased by NAME.
  // Every [W/*] clause keys on the literal `ctx.db`, so a helper whose context
  // parameter is spelled `context` performs a foreign-table delete that the
  // whole family is blind to. Measured green end-to-end (fmt, clippy, 80/80
  // evals, 1662/1662 Rust tests) before this clause existed. Kills: adding
  // [W/db-binding] for `let db = &ctx.db;` and stopping there.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
}
fn purge_stale_player(context: &ReducerContext, id: Identity) {
    context.db.player().identity().delete(id);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/ctx-binding]', 'FG37b');
    if (bad) return bad;
  }

  // FG37c — the local-alias spelling of the same escape.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    let c = ctx;
    c.db.player().identity().delete(from);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/ctx-binding]', 'FG37c');
    if (bad) return bad;
  }

  // FG37d (GOOD) — the sanctioned spelling must PASS: several fns, every one
  // taking `ctx: &ReducerContext`, plus an `_ctx: &ReducerContext` placeholder.
  // Without this an always-red [W/ctx-binding] is indistinguishable from a
  // working one, and the clause would red the live tree on arrival.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
}
fn helper(ctx: &ReducerContext, id: Identity) -> bool {
    ctx.db.player().identity().find(id).is_some()
}
fn unused(_ctx: &ReducerContext) {}
`;
    const good = checkModuleWriteIsolation(src);
    if (good !== null) {
      return `TEETH FAILED (FG37d): the sanctioned \`ctx\`-named GOOD fixture was flagged — ${good}`;
    }
  }

  // FG38 — a generated handle crossing a module boundary: the table is reached
  // without `ctx.db.<t>()` ever appearing in the reaching fn's body.
  {
    const src = `
fn probe(ctx: &ReducerContext, wallets: player_wallet__TableHandle, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    wallets.owner_identity().delete(from);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/handle-type]', 'FG38');
    if (bad) return bad;
  }

  // FG39 — a bare READ of the battle table. Neither the write-target nor the
  // split-binding clause fires on a read, which is exactly why the literal ban
  // exists (ADR-0179 D0/G5 forces the `guards::is_in_ongoing_battle` seam).
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    let live = ctx.db.battle().player_identity().find(from).is_some();
    let _ = live;
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/battle-literal]', 'FG39');
    if (bad) return bad;
  }

  // FG40 — the empty-target blind spot: a source with reads only. Every ban
  // clause above passes VACUOUSLY on it.
  {
    const src = `
fn probe(ctx: &ReducerContext, g: Identity) -> bool {
    ctx.db.player().identity().find(g).is_some()
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/non-vacuous]', 'FG40');
    if (bad) return bad;
  }

  // --- G11: SINGLE_USE_CONSUMED -------------------------------------------

  // FG41 — GOOD: the shipped success path must PASS.
  {
    const err = checkSingleUseConsumed(GOOD_ACCOUNTS);
    if (err) return `FG41: the GOOD success path was incorrectly flagged: ${err}`;
  }

  // FG42 (red-team B3/F3, CRITICAL) — THE one-token argument swap. `me` has no
  // guest_claim row, so nothing is deleted: the claim row and its armed reaper
  // survive and the 64-hex code stays redeemable until TTL (AUTH-34/35 dead).
  // [S/count], [S/depth0] and [S/success-region] ALL stay green.
  // Kills: any spelling of G11 that does not pin the ARGUMENT.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    rekey_all(ctx, guest, me)?;\n    consume_claim_and_disarm(ctx, guest);',
      '    rekey_all(ctx, guest, me)?;\n    consume_claim_and_disarm(ctx, me);',
    );
    const bad = expectTag(checkSingleUseConsumed(src), '[S/arg-pin]', 'FG42');
    if (bad) return bad;
  }

  // FG43 — the consume is deleted outright.
  {
    const src = mut(GOOD_ACCOUNTS, '    consume_claim_and_disarm(ctx, guest);\n', '');
    const bad = expectTag(checkSingleUseConsumed(src), '[S/count]', 'FG43');
    if (bad) return bad;
  }

  // FG44 — the success path is split across two consumes, which this scan
  // cannot reason about; refusing to classify is the fail-loud direction.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    consume_claim_and_disarm(ctx, guest);\n    ctx.db',
      '    consume_claim_and_disarm(ctx, guest);\n    consume_claim_and_disarm(ctx, guest);\n    ctx.db',
    );
    const bad = expectTag(checkSingleUseConsumed(src), '[S/count]', 'FG44');
    if (bad) return bad;
  }

  // FG45 — the dead-branch variant: the condition is ALWAYS false right after
  // rekey_all has moved the guest's rows away, so the code is never consumed
  // while the count, the argument and the region all check out.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    consume_claim_and_disarm(ctx, guest);\n    ctx.db',
      `    if account_has_game_data(ctx, guest) {
        consume_claim_and_disarm(ctx, guest);
    }
    ctx.db`,
    );
    const bad = expectTag(checkSingleUseConsumed(src), '[S/depth0]', 'FG45');
    if (bad) return bad;
  }

  // FG46 — the consume moved BEFORE the fallible rekey_all, whose `?` rolls the
  // transaction back (and, after any future non-transactional refactor, burns
  // the code without moving the data).
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    rekey_all(ctx, guest, me)?;\n    consume_claim_and_disarm(ctx, guest);',
      '    consume_claim_and_disarm(ctx, guest);\n    rekey_all(ctx, guest, me)?;',
    );
    const bad = expectTag(checkSingleUseConsumed(src), '[S/success-region]', 'FG46');
    if (bad) return bad;
  }

  // --- G6: REKEY_COMPLETENESS ---------------------------------------------

  // FG47 — GOOD: a tree declaring exactly the manifest's columns, with both
  // consumption sites fully wired, must PASS.
  {
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS);
    if (err) return `FG47: the GOOD manifest/tree pair was incorrectly flagged: ${err}`;
  }

  // FG48 — a NEW table with an Identity column and no policy: exactly the
  // "future table" case the manifest exists to catch.
  {
    const tree = [
      {
        path: 'fixture/schema.rs',
        src:
          GOOD_TREE[0].src +
          `#[spacetimedb::table(name = guild_member)]
pub struct GuildMember {
    pub owner_identity: Identity,
    pub guild_id: u64,
}
`,
      },
      GOOD_TREE[1],
    ];
    const bad = expectTag(checkRekeyCompleteness(tree, GOOD_ACCOUNTS), '[G6/declared]', 'FG48');
    if (bad) return bad;
  }

  // FG49 — a manifest key whose column is GONE (the wallet table is DELETED
  // from the tree, not renamed: a rename would leave a NEW unclassified column
  // behind and [G6/declared] would be the clause that fired, so this fixture
  // would not prove the reverse direction bites).
  // Kills: a one-directional "every column has a policy" check, which leaves a
  // stale policy looking authoritative to the next reviewer and keeps
  // [G6/consumed] green for a helper that no longer re-keys anything.
  {
    const tree = [
      {
        path: 'fixture/schema.rs',
        src: synthSchemaSrc(SYNTH_KEYS.filter((k) => k !== 'player_wallet.owner_identity')),
      },
      GOOD_TREE[1],
    ];
    const bad = expectTag(checkRekeyCompleteness(tree, GOOD_ACCOUNTS), '[G6/live]', 'FG49');
    if (bad) return bad;
  }

  // FG50 (the one invariant nothing else in the repo covers) —
  // `has_quest_or_dialogue_state` is dropped from `account_has_game_data` while
  // `rekey_all` stays fully wired. accounts_tests.rs:1320 pins the six rekey_all
  // delegations in D6 order and NEVER enumerates the exists-helpers, so this is
  // green everywhere else. Guard 11 (AUTH-20) silently stops fail-closing for
  // player_quest / player_dialogue_state.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '        || crate::npc::has_quest_or_dialogue_state(ctx, identity)\n',
      '',
    );
    const err = checkRekeyCompleteness(GOOD_TREE, src);
    const bad = expectTag(err, '[G6/consumed]', 'FG50');
    if (bad) return bad;
    // The `exists` half must be what fired, not the `rekey` half: rekey_all is
    // untouched here, so a message naming a rekey_* helper would mean the two
    // halves are not independently wired.
    if (err.indexOf('has_quest_or_dialogue_state(') === -1) {
      return `FG50: the message must name the missing EXISTENCE predicate: ${err}`;
    }
    if (err.indexOf(HAS_GAME_DATA_FN) === -1) {
      return `FG50: the message must name ${HAS_GAME_DATA_FN} as the site that lost it: ${err}`;
    }
  }

  // FG51 — the rekey half: a REKEY-policy table whose helper is never called
  // from rekey_all, so a successful claim orphans that table's rows.
  {
    const src = mut(GOOD_ACCOUNTS, '    crate::economy::rekey_wallet(ctx, from, to);\n', '');
    const bad = expectTag(checkRekeyCompleteness(GOOD_TREE, src), '[G6/consumed]', 'FG51');
    if (bad) return bad;
  }

  // FG52 — an INJECTED manifest that reclassifies the dev-telemetry anchor as
  // REKEY. [G6/declared] and [G6/live] are both satisfied (the key still exists
  // and still resolves), so only the value-pinned anchor clause can see it.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'playtest_event.identity': { rekey: 'rekey_monsters(', exists: 'has_monsters(' },
    };
    const bad = expectTag(
      checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
      '[G6/anchors]',
      'FG52',
    );
    if (bad) return bad;
  }

  // FG53 — the empty-target blind spot for G6: an empty manifest over an empty
  // tree satisfies BOTH directional clauses vacuously. Only the hardcoded,
  // manifest-independent anchors can fail it.
  {
    const bad = expectTag(
      checkRekeyCompleteness(
        [{ path: 'fixture/empty.rs', src: '// no tables\n' }],
        GOOD_ACCOUNTS,
        {},
      ),
      '[G6/anchors]',
      'FG53',
    );
    if (bad) return bad;
  }

  // --- adversarial pass (FG54-FG59) ----------------------------------------

  // FG54 — the C-STRING prefixes `cr"..."` / `cr##"..."##` (stable Rust 1.77+).
  // In `cr"C:\"` the `r` is preceded by the WORD CHARACTER `c`, so the raw-string
  // branch's `!isWordChar(src[i-1])` guard skipped it and the literal was lexed
  // as an ORDINARY string whose `\"` was eaten as an escape — quote polarity
  // inverted for the rest of the file, exactly like the r/br forms, in a
  // spelling the r/br hardening never enumerated.
  // GOOD half: a C-string const must not make a clean source look dirty.
  // BAD half: with the const in front of a REAL `ctx.rng()` call, the rng call
  // must still be seen. A C-prefix-blind stripper blanks it and checkNoServerRng
  // returns PASS (or reds under a DIFFERENT tag) — either way this fixture bites.
  {
    const forms = [
      String.raw`pub const CP: &core::ffi::CStr = cr"C:\";`,
      String.raw`pub const CQ: &core::ffi::CStr = cr##"use "code" or "CODE"##;`,
    ];
    const rngSrc = mut(
      GOOD_ACCOUNTS,
      '    let now = now_ms(ctx);\n    let row = claim_row(me, code, player.name, now);',
      `    let code = ctx.rng().gen::<[u8; 32]>();
    let now = now_ms(ctx);
    let row = claim_row(me, hex(code), player.name, now);`,
    );
    for (let k = 0; k < forms.length; k++) {
      const clean = `${forms[k]}\n${GOOD_ACCOUNTS}`;
      const cleanErr = checkNoServerRng(clean);
      if (cleanErr) {
        return `FG54.${k + 1}: a C-string const made a clean source look dirty: ${cleanErr}`;
      }
      const bad = expectTag(checkNoServerRng(`${forms[k]}\n${rngSrc}`), '[N/rng]', `FG54.${k + 1}`);
      if (bad) return `${bad} (C-string form: ${forms[k]})`;
    }
  }

  // FG55 (adversarial pass) — bind the COLUMN, not the table handle. The
  // accessor IS followed by a `.`, so the pre-hardening [W/split-binding]
  // (`flat[accEnd] !== '.'`) was silent; the write verb sits in the NEXT
  // statement, so [W/write-target]'s `;`-bounded span was silent; and no handle
  // TYPE is ever named, so [W/handle-type] was silent. A foreign write with all
  // three clauses green.
  // Kills: any [W/split-binding] keyed on the accessor's immediate next char.
  {
    const src = `
fn probe(ctx: &ReducerContext, from: Identity) {
    ctx.db.guest_claim().guest_identity().delete(from);
    let col = ctx.db.player().identity();
    col.delete(from);
}
`;
    const bad = expectTag(checkModuleWriteIsolation(src), '[W/split-binding]', 'FG55');
    if (bad) return bad;
  }

  // FG56 — GOOD: the read terminals other than `.find(` must stay legal, or the
  // hardened [W/split-binding] false-REDs the first legitimate `player` scan.
  // Kills: a read-terminal list narrowed to `.find(` alone.
  {
    const src = `
fn probe(ctx: &ReducerContext, row: GuestClaim, g: Identity) -> usize {
    ctx.db.guest_claim().insert(row);
    let n = ctx.db.player().iter().count();
    let m = ctx.db.player().identity().filter(g).count();
    n + m
}
`;
    const err = checkModuleWriteIsolation(src);
    if (err) return `FG56: a legitimate foreign READ terminal was flagged: ${err}`;
  }

  // FG57 (adversarial pass) — a depth-ZERO consume that never executes: the call
  // is a CLOSURE BODY, so the `{`/`}` counter stays at 0 while the code is never
  // run. [S/count], [S/arg-pin] and [S/success-region] are all satisfied.
  // Kills: a brace-depth check with no statement-position pin.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      '    consume_claim_and_disarm(ctx, guest);\n    ctx.db',
      '    let _reap = || consume_claim_and_disarm(ctx, guest);\n    ctx.db',
    );
    const bad = expectTag(checkSingleUseConsumed(src), '[S/depth0]', 'FG57');
    if (bad) return bad;
  }

  // FG58 (adversarial pass) — the scheduled-reducer carve-out abused from the
  // GUARD side: the reaper keeps its scheduled struct argument and still
  // CONTAINS `ctx.sender != ctx.identity()`, but only as an audit-only binding
  // that rejects nobody. Any client can then invoke the scheduled reducer with a
  // hand-built row naming any victim identity — the exact client-supplied
  // Identity hole the carve-out assumes is closed.
  // Kills: a carve-out that substring-matches the comparison instead of pinning
  // it as a rejecting early return.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      `    if ctx.sender != ctx.identity() {
        return Err("guest_claim_reaper is scheduler-only".to_string());
    }
`,
      `    let scheduler_only = ctx.sender != ctx.identity();
    let _ = scheduler_only;
`,
    );
    const bad = expectTag(checkNoClientIdentity(src), '[R/param-types]', 'FG58');
    if (bad) return bad;
  }

  // FG59 (adversarial pass) — a NEW Identity column inside a table declaration
  // parseTableSchemas CANNOT READ: a multi-column index in the attribute puts a
  // `]` inside the parser's `[^\]]*\)\]` window, so the whole struct is invisible
  // and [G6/declared] has nothing to complain about. Note the tag: this fixture
  // must fire [G6/parse], NOT [G6/declared] — if [G6/declared] fired, the parser
  // saw the table after all and the fixture would be proving nothing.
  {
    const tree = [
      {
        path: 'fixture/schema.rs',
        src:
          GOOD_TREE[0].src +
          `#[spacetimedb::table(name = guild_member, index(btree, name = by_owner, columns = [owner_identity, guild_id]))]
pub struct GuildMember {
    pub owner_identity: Identity,
    pub guild_id: u64,
}
`,
      },
      GOOD_TREE[1],
    ];
    const bad = expectTag(checkRekeyCompleteness(tree, GOOD_ACCOUNTS), '[G6/parse]', 'FG59');
    if (bad) return bad;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: teeth first, then live-tree checks (all failures aggregated
// so the implementer sees the full to-do list in one run).
// ---------------------------------------------------------------------------

export default async function guestClaimIntegrityEval() {
  const name =
    'guest-claim-integrity (no client-supplied identity, anonymous connect passthrough, ' +
    'issuer+audience allowlists, no server RNG, module write isolation, single-use claim codes, ' +
    're-key manifest completeness)';

  let toothErr;
  try {
    toothErr = runTeeth();
  } catch (e) {
    return { name, pass: false, detail: `TEETH threw: ${e?.message ?? String(e)}` };
  }
  if (toothErr) {
    return { name, pass: false, detail: `TEETH: ${toothErr}` };
  }

  // ---- live tree: non-test server sources (a *_tests.rs file is cfg(test) and
  // never published; excluding them also removes every self-red hazard from the
  // .concat()-assembled needles those files are full of). ----
  const rsPaths = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      const rel = f.replace(/\\/g, '/');
      if (rel.endsWith('_tests.rs')) continue;
      rsPaths.push(rel);
    }
  } catch (e) {
    return { name, pass: false, detail: `Failed to glob server-module/src/**/*.rs: ${e.message}` };
  }
  if (rsPaths.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'No non-test .rs files found under server-module/src/ — is the worktree set up correctly?',
    };
  }
  rsPaths.sort();

  const treeSrcs = [];
  for (const p of rsPaths) {
    try {
      treeSrcs.push({ path: p, src: readFileSync(p, 'utf8') });
    } catch (e) {
      return { name, pass: false, detail: `Failed to read ${p}: ${e.message}` };
    }
  }
  const byPath = (suffix) => treeSrcs.find((f) => f.path.endsWith(suffix));

  const failures = [];

  // The desync self-check runs on EVERY live source: a desync anywhere in the
  // tree silently greens the ban clauses of any checker that reads that file.
  for (const f of treeSrcs) {
    const err = assertStripperSound(f.src, f.path);
    if (err) failures.push(err);
  }

  const accountsFile = byPath('/accounts.rs');
  const libFile = byPath('/lib.rs');

  if (!accountsFile) {
    failures.push(
      `[R/name-set] ${ACCOUNTS_PATH} is missing from the scanned tree — G2, G3(issuer/audience), ` +
        'G4, G5, G11 and G6 cannot run',
    );
  } else {
    for (const [label, check] of [
      ['G2 no-client-identity', checkNoClientIdentity],
      ['G3 issuer-and-audience', checkIssuerAndAudience],
      ['G4 no-server-rng', checkNoServerRng],
      ['G5 module-write-isolation', checkModuleWriteIsolation],
      ['G11 single-use-consumed', checkSingleUseConsumed],
    ]) {
      const err = check(accountsFile.src);
      if (err) failures.push(`[${label}] ${err}`);
    }

    const errG6 = checkRekeyCompleteness(treeSrcs, accountsFile.src);
    if (errG6) failures.push(`[G6 rekey-completeness] ${errG6}`);
  }

  if (!libFile) {
    failures.push(
      `[I/anon-first] ${LIB_PATH} is missing from the scanned tree — the anonymous-passthrough ` +
        'check cannot run',
    );
  } else {
    const errAnon = checkAnonPassthrough(libFile.src);
    if (errAnon) failures.push(`[G3 anon-passthrough] ${errAnon}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  const rekeyEntries = Object.keys(REKEY_MANIFEST).filter(
    (k) => typeof REKEY_MANIFEST[k] !== 'string',
  ).length;
  return {
    name,
    pass: true,
    detail:
      `${treeSrcs.length} non-test server source file(s) scanned (stripper soundness proven on ` +
      `each); accounts.rs declares EXACTLY [${SANCTIONED_REDUCERS.join(', ')}] with wire-safe ` +
      'arguments and no Identity constructor, on_connect takes the anonymous path first and never ' +
      'returns Err, the issuer and audience allowlists are both checked (with the right consts) ' +
      `before any account insert, no server RNG, writes confined to {${OWNED_TABLES.join(', ')}}, ` +
      'the claim code is consumed exactly once for the guest at brace-depth 0 of the success ' +
      `region, and all ${Object.keys(REKEY_MANIFEST).length} Identity columns carry a D6 policy ` +
      `(${rekeyEntries} REKEY entries consumed by both rekey_all and account_has_game_data) ` +
      '(59 teeth verified)',
  };
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): `node evals/guest-claim-integrity.eval.mjs`
// runs standalone with a non-zero exit on failure. No-op when imported by
// evals/run.mjs (process.argv[1] is run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await guestClaimIntegrityEval();
    } catch (e) {
      return {
        name: 'guest-claim-integrity',
        pass: false,
        detail: `threw: ${e?.message ?? String(e)}`,
      };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
