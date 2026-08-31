// Guest-claim integrity eval (M21c T3/T4/T5 — ADR-0179 G2 NO_CLIENT_IDENTITY,
// G3 ANON_PASSTHROUGH + ISSUER_AND_AUDIENCE_CHECKED, G4 NO_SERVER_RNG,
// G5 MODULE_WRITE_ISOLATION, G11 SINGLE_USE_CONSUMED, G6 REKEY_COMPLETENESS).
//
// The accounts subsystem derives identity ONLY from `ctx.sender()`, never from a
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
//     guest_claim_reaper. They are the REQUIRED entries of REDUCER_SANCTIONS,
//     the sanction ledger [R/name-set] reads (ADR-0210). The ledger replaced a
//     flat array compared by exact set equality: correct, but a six-name array
//     false-REDs the CURRENT tree, and ADR-0207 D5 commits M22 S3 to declaring
//     account_deletion_reaper atomically with its scheduled table while S3
//     cannot edit this file. [R/name-set] is now MEMBERSHIP (an own key of the
//     ledger) plus REQUIRED-PRESENCE, and the permissive PLANNED category is
//     itself pinned by exact set equality in [R/planned-set]. Neither half may
//     be dropped, because a red-team proved two ADDITIVE reducers that are
//     unauthenticated, code-less transfers of any identity's monsters,
//     inventory, wallet, NPC state and profile — both compile and both pass
//     `clippy --all-targets -D warnings`:
//       E1  #[derive(spacetimedb::SpacetimeType)] pub struct ClaimTarget {
//               pub guest_identity: Identity }
//           #[spacetimedb::reducer] pub fn complete_guest_claim_for(
//               ctx: &ReducerContext, target: ClaimTarget) -> Result<(),String> {
//               rekey_all(ctx, target.guest_identity, ctx.sender()) }
//       E2  #[spacetimedb::reducer] pub fn adopt_guest(
//               ctx: &ReducerContext, guest_hex: String) -> Result<(),String> {
//               let g = Identity::from_hex(&guest_hex)?;
//               rekey_all(ctx, g, ctx.sender()) }
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
//     `ctx.sender() != ctx.database_identity()` guard rejects any client that calls it.
//     [R/param-types] carves out exactly that shape — same-file scheduled table,
//     param type EQUAL to the scheduled struct, guard present — which is narrow
//     enough that E1's `ClaimTarget` is still rejected. The GUARD half is pinned
//     as a REJECTING EARLY RETURN (`if ctx.sender() != ctx.database_identity() { return`),
//     not as a bare comparison: the adversarial pass showed that
//       let scheduler_only = ctx.sender() != ctx.database_identity();
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
// THE STRIPPER: imported from the SHARED `evals/rust-scan.mjs` (13r-c, ADR-0181
// D1). This file used to carry a ~450-line VERBATIM copy of account-privacy's
// scanner, justified as "the repo convention"; ADR-0179 §9 flagged that
// duplication (the two copies' `splitArgs` had already silently diverged) and
// ADR-0181 consolidates them. The old rationale — "an eval that imports its
// scanner from a neighbour can be blinded tree-wide by one edit" — is answered,
// not ignored: `assertStripperSound` runs on EVERY live source in this file, so
// a bad edit to the shared module reds here loudly rather than blinding this
// eval silently. (It also cited ci-gate-wiring.eval.mjs as rejecting a shared
// stripper module; that note is about a different, much narrower helper
// (`extractRecipeBodyLocal`), not a blanket prohibition.) Strings are lexed FIRST (never comments first — a slash-slash
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
//       [R/sanction-shape] every REDUCER_SANCTIONS entry is an own-property
//                          object of exactly {status, why} whose status is one
//                          of the CLOSED set {REQUIRED, PLANNED}. Runs FIRST.
//                          Left open, a THIRD status string is a free, silent
//                          whitelist slot — admitted by membership, never
//                          demanded by required-presence, invisible to the
//                          PLANNED pin. MEASURED as a working bypass (ADR-0210).
//       [R/planned-set]    the PLANNED key set equals EXACTLY PLANNED_PIN, in
//                          BOTH directions — a subset test is green on an empty
//                          set and blind to a REQUIRED→PLANNED demotion.
//       [R/planned-shape]  a PLANNED name that is PRESENT must carry the shape
//                          that was pre-reviewed (same-file scheduled target,
//                          argument type IS the scheduled struct, scheduler
//                          guard in the body). MEASURED: without it, a reducer
//                          merely REUSING the planned name with a wire-safe
//                          argument is silent to every other clause here.
//       [R/name-set]       every enumerated reducer is an OWN key of the ledger
//                          (Object.hasOwn, never `in` — a reducer named
//                          `constructor` resolves through Object.prototype),
//                          AND every REQUIRED key is enumerated (also the
//                          non-vacuity guard).
// The G2 success DETAIL additionally prints three plain progress markers —
// `[R/shape-closed]`, `[R/planned-pinned]`, `[R/s3-ready]`. They are NOT clause
// tags (no clause emits them and no fixture asserts them); they are the strings
// this slice's acceptance ledger joins on to prove WHICH version of the gate
// produced a green, and they are listed here so a reader grepping for a clause
// by that name is not left hunting for one that does not exist.
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
//       [G6/policy]        every manifest entry is an object whose explicit
//                          `policy` field is exactly REKEY / BLOCKED / EXEMPT
//                          with that kind's closed field set (rb-2 — the
//                          discriminator is read by ONE function, never
//                          inferred from typeof or needle presence). Runs
//                          before the manifest is compared to the tree.
//       [G6/parse]         every `#[spacetimedb::table(` in each source yields
//                          exactly one PARSED table — a declaration
//                          parseTableSchemas cannot read hides its Identity
//                          columns from [G6/declared] (and from the schema
//                          baseline, which compares a union of both sides).
//       [G6/alias]         no source declares a `type` item from inside a
//                          `macro_rules!` body, binds a name to a macro
//                          metavariable or invocation, or binds the name
//                          `Identity` itself — bindings the alias resolver
//                          cannot read (rb-4; FG73n, FG73p).
//       [G6/declared]      every `Identity`/`Option<Identity>` COLUMN in the tree
//                          has an OWN manifest entry — membership is asked of
//                          the Map classifyManifest derives from Object.keys,
//                          never of the manifest object, so a key reachable
//                          only through the prototype chain does not count
//                          (rb-3, residual R-m22-s0-X2; FG72a-f). A column's
//                          declared type is RESOLVED through every `type` item
//                          and `use … as` rename in the scanned tree before the
//                          Identity test, fail-closed on ambiguity (rb-4,
//                          residual R-m22-s0-X3; FG73a-p).
//       [G6/live]          every manifest key still resolves to a live column
//                          (bidirectional — a deleted column must not leave a
//                          stale policy behind).
//       [G6/anchors]       {account.identity, playtest_event.identity,
//                          profile.identity, player_wallet.owner_identity} all
//                          resolve, playtest_event.identity is EXEMPT, and the
//                          D6 REKEY columns are REKEY by value.
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
// Proof-of-teeth fixtures (FG1-FG73) run BEFORE the live-tree checks so a broken
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
// Shared structural parsers: findFnBody / findCalls / splitArgs are IMPORTED from
// evals/rust-scan.mjs (13r-c, ADR-0181); parseReducers and parseScheduledTargets
// below are local to this eval.
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

// The sanctioned reducer surface, keyed by name, with an explicit CLOSED status
// discriminator (ADR-0210). It replaces a flat five-name array compared by exact
// set equality, which was correct but unschedulable: `game_core::STATE_TRANSITION_OWNERS`
// and ADR-0207 D5 already commit M22 S3 to declaring `account_deletion_reaper`
// ATOMICALLY with its scheduled table (SpacetimeDB forbids adding the
// `scheduled(...)` attribute to an existing table), and S3 cannot edit this file.
// A six-name array would false-RED the CURRENT five-reducer tree, so a
// permitted-when-present notion is structurally required.
//
//   REQUIRED  shipped today; MUST be found. A missing one is a client entry
//             point that silently disappeared.
//   PLANNED   declared in advance and pre-reviewed HERE; permitted when present,
//             never required. Bounded to exactly PLANNED_PIN below.
//
// The status is NOT advisory. Left open, a third status string is admitted by
// the membership rule, never demanded by the required-presence rule, and
// invisible to the PLANNED pin — a free, silent, optional whitelist slot,
// MEASURED by red-team as a working bypass (ADR-0210). Hence SANCTION_SHAPES.
const SANCTION_SHAPES = [
  { status: 'REQUIRED', fields: 'status,why' },
  { status: 'PLANNED', fields: 'status,why' },
];

// The permissive category, pinned by EXACT SET EQUALITY in BOTH directions — the
// same device the flat array used, moved onto the only part of the surface that
// is now permissive. Widening it therefore still costs a conscious,
// separately-spelled diff in THIS file, reviewed HERE, which is the property
// ADR-0179 G2 actually cared about.
const PLANNED_PIN = ['account_deletion_reaper'];

/**
 * @typedef {{status:'REQUIRED'|'PLANNED', why:string}} ReducerSanction
 */

/** @type {Record<string, ReducerSanction>} */
export const REDUCER_SANCTIONS = freezeManifest({
  account_deletion_reaper: {
    status: 'PLANNED',
    why: 'M22 S3, ADR-0207 D5: the scheduled deletion reaper. Its table carries the scheduled(...) attribute, which SpacetimeDB cannot add to an existing table, so table and reducer must land in one publish. Named by game_core::STATE_TRANSITION_OWNERS since M22 S1.',
  },
  cancel_account_deletion: {
    status: 'REQUIRED',
    why: 'AUTH-3x: clears deletion_requested_at_ms for ctx.sender().',
  },
  complete_guest_claim: {
    status: 'REQUIRED',
    why: 'AUTH-34/35: redeems a 64-hex claim code and re-keys the guest onto the caller.',
  },
  delete_account: {
    status: 'REQUIRED',
    why: 'AUTH-3x: arms deletion for ctx.sender().',
  },
  guest_claim_reaper: {
    status: 'REQUIRED',
    why: 'The scheduled TTL sweep; scheduler-only via the ctx.sender() != ctx.database_identity() guard.',
  },
  start_guest_claim: {
    status: 'REQUIRED',
    why: 'AUTH-33: mints a client-supplied claim code for the calling guest.',
  },
});

/**
 * The REQUIRED half of the ledger, derived rather than transcribed, so the
 * required-presence clause and the success detail can never drift apart (the
 * old flat array was named in the detail string by hand).
 * @param {Record<string, ReducerSanction>} ledger The sanction ledger.
 * @returns {string[]} Sorted REQUIRED reducer names.
 */
function requiredReducerNames(ledger) {
  return Object.keys(ledger)
    .filter((name) => ledger[name].status === 'REQUIRED')
    .sort();
}

/**
 * [R/sanction-shape] — the discriminator is CLOSED. Every ledger value must be
 * an own-property object whose OWN field set is exactly one shape's, and whose
 * OWN `status` is that shape's status.
 *
 * An ARRAY searched with `.find`, never an object keyed by the status word:
 * `status: 'constructor'` must be an UNKNOWN status, not a hit on
 * `Object.prototype` (the rb-2 / `[G6/policy]` rule). Fields are compared as a
 * sorted, comma-joined OWN key set, so a new field is a failure until it is
 * added HERE, on purpose — and an entry that merely INHERITS a well-formed
 * `status` owns no fields at all and is rejected.
 * @param {Record<string, unknown>} ledger The sanction ledger.
 * @returns {string|null} Error string, or null on pass.
 */
export function assertSanctionShape(ledger) {
  const bad = (why) =>
    `[R/sanction-shape] ${why}. Every entry in the sanctioned-reducer ledger must be an ` +
    "own-property object of exactly {status, why} whose status is one of {'REQUIRED','PLANNED'}. " +
    'Left open, a THIRD status string is a free, silent whitelist slot: membership admits it (it ' +
    'IS an own key), required-presence never demands it (it is not REQUIRED) and the PLANNED pin ' +
    'cannot see it (it is not PLANNED). A red-team MEASURED that exact bypass carrying a ' +
    'wire-safe, constructor-free takeover reducer past every other clause in this file (ADR-0210)';

  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return bad(
      `the ledger is ${Array.isArray(ledger) ? 'an array' : String(ledger)}, not an object`,
    );
  }
  const names = Object.keys(ledger);
  if (names.length === 0) {
    return bad('the ledger is EMPTY, so every membership test below would pass vacuously');
  }
  for (const name of names) {
    const entry = ledger[name];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return bad(`entry \`${name}\` is ${Array.isArray(entry) ? 'an array' : typeof entry}`);
    }
    const fields = Object.keys(entry).sort().join(',');
    const status = Object.hasOwn(entry, 'status') ? entry.status : undefined;
    const shape = SANCTION_SHAPES.find((k) => k.status === status && k.fields === fields);
    if (shape === undefined) {
      return bad(
        `entry \`${name}\` has own field set {${fields}} and own status ` +
          `${JSON.stringify(status)}, which matches no legal shape`,
      );
    }
    if (typeof entry.why !== 'string' || entry.why.trim() === '') {
      return bad(`entry \`${name}\` carries no \`why\`; an unjustified entry is an unreviewed one`);
    }
  }
  return null;
}

/**
 * [R/planned-set] — the permissive category is pinned by EXACT SET EQUALITY in
 * BOTH directions against PLANNED_PIN. A one-sided subset test is satisfied by
 * an EMPTY planned set, and a one-sided superset test never notices a
 * REQUIRED-to-PLANNED DEMOTION — which silently un-requires a shipped client
 * entry point, a shape the flat array could not even express.
 * @param {Record<string, unknown>} ledger The sanction ledger.
 * @returns {string|null} Error string, or null on pass.
 */
export function assertPlannedSet(ledger) {
  const planned = Object.keys(ledger)
    .filter((name) => {
      const entry = ledger[name];
      if (entry === null || typeof entry !== 'object') return false;
      return Object.hasOwn(entry, 'status') && entry.status === 'PLANNED';
    })
    .sort();
  const same =
    planned.length === PLANNED_PIN.length && planned.every((n, k) => n === PLANNED_PIN[k]);
  if (!same) {
    return (
      `[R/planned-set] the PLANNED reducer set is [${planned.join(', ')}] but is pinned to EXACTLY ` +
      `[${PLANNED_PIN.join(', ')}]. Equality in BOTH directions, never a subset: a subset-only ` +
      'test is green on an EMPTY planned set, and it never sees a REQUIRED entry DEMOTED to ' +
      'PLANNED — which un-requires a shipped client entry point while every other clause stays ' +
      'quiet. Admitting one more pre-declared reducer is a security-relevant event that must be ' +
      're-reviewed right here, so it costs a deliberate edit to this pin (ADR-0210)'
    );
  }
  return null;
}

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
// handles arrives from `ctx.sender()` or from a row it read. `Identity::from_hex`
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
//     let scheduler_only = ctx.sender() != ctx.database_identity();
//     let _ = scheduler_only;
// which contains the comparison, compiles, is clippy-clean — and lets ANY client
// invoke the scheduled reducer with a hand-built row naming any victim identity,
// i.e. exactly the client-supplied-Identity hole the carve-out assumes is
// closed. `{return` (not `{returnErr(`) so a future refactor to the equally
// valid `{ return Ok(()); }` silent-ignore form does not false-RED.
const SCHEDULER_GUARD = 'ifctx.sender()!=ctx.database_identity(){return';

/**
 * Is a live, complete scheduler guard present in this squashed reducer body?
 *
 * rb-24 hardening (red-team, MEASURED on the shipped guest reaper arm too):
 * the bare needle stops at `{return`, and squashing fuses the token with
 * whatever follows it, so the needle is a forgeable PREFIX — a guard branch
 * opening with a helper call whose NAME merely starts with those six letters
 * (`returned_scheduler_reject(ctx);`) contains the whole needle, compiles, is
 * clippy-clean, and rejects nobody. A guard therefore counts only in one of
 * its two COMPLETE forms: the rejecting `return Err(..)` or the silent-ignore
 * `return Ok(())`.
 * @param {string} body Squashed reducer body text.
 * @returns {boolean} True when a complete guard form is present.
 */
function schedulerGuardIsLive(body) {
  return (
    body.indexOf(`${SCHEDULER_GUARD}Err(`) !== -1 || body.indexOf(`${SCHEDULER_GUARD}Ok(())`) !== -1
  );
}

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
 * G2 NO_CLIENT_IDENTITY — the server derives identity from `ctx.sender()`, never
 * from a client-supplied value.
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoClientIdentity(accountsSrc) {
  // The ledger is validated BEFORE the source is read: every clause below
  // reasons about it, so a malformed ledger makes them all unfounded.
  const shapeErr = assertSanctionShape(REDUCER_SANCTIONS);
  if (shapeErr) return shapeErr;
  const plannedErr = assertPlannedSet(REDUCER_SANCTIONS);
  if (plannedErr) return plannedErr;

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
      `— the sanctioned ledger names {${Object.keys(REDUCER_SANCTIONS).sort().join(', ')}}. The scan reached the ` +
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
        '`ctx.sender()` and nothing else (ADR-0179 G2 / AUTH-6)'
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
        if (schedulerGuardIsLive(body)) continue;
        return (
          `[R/param-types] reducer \`${r.name}\` takes the scheduled struct \`${t}\` but its body ` +
          `does not contain the scheduler guard \`${SCHEDULER_GUARD}...\` — without it ANY client ` +
          'can invoke the scheduled reducer directly and hand it a hand-built row, which is ' +
          'precisely the client-supplied-Identity hole the carve-out assumes is closed. The guard ' +
          'is pinned as a REJECTING EARLY RETURN, not as a bare comparison: `let scheduler_only = ' +
          'ctx.sender() != ctx.database_identity(); let _ = scheduler_only;` contains the comparison, ' +
          'compiles, passes clippy — and rejects nobody'
        );
      }

      return (
        `[R/param-types] reducer \`${r.name}\` declares the parameter \`${p.name}: ${t}\`, which is ` +
        'not a wire-safe scalar (String / u8..u128 / i8..i128 / f32 / f64 / bool / Vec<..> / ' +
        'Option<..> of those). A red-team PROVED this exact shape:\n' +
        '  #[derive(spacetimedb::SpacetimeType)] pub struct ClaimTarget { pub guest_identity: Identity }\n' +
        '  #[spacetimedb::reducer] pub fn complete_guest_claim_for(ctx: &ReducerContext, target: ClaimTarget)\n' +
        '      -> Result<(),String> { rekey_all(ctx, target.guest_identity, ctx.sender()) }\n' +
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
      'CONSTRUCTS an Identity; every identity it handles comes from `ctx.sender()` or from a row it ' +
      'read. A red-team PROVED the constructor is the whole attack:\n' +
      '  #[spacetimedb::reducer] pub fn adopt_guest(ctx: &ReducerContext, guest_hex: String)\n' +
      '      -> Result<(),String> { let g = Identity::from_hex(&guest_hex)?; rekey_all(ctx, g, ctx.sender()) }\n' +
      'The parameter is a wire-safe String, so a parameter-type analysis alone never sees it. ' +
      '`Identity::from_hex` is `pub` in spacetimedb-lib'
    );
  }

  // [R/name-set] — MEMBERSHIP plus REQUIRED-PRESENCE, the two halves the flat
  // exact-set pin used to collapse into one comparison. Both are load-bearing:
  // membership catches an ADDED reducer (E1/E2 and FG15 are all additive, so a
  // `>= 5` count or an "each expected name is present" check is green on every
  // one of them), and required-presence catches a sanctioned name LEAVING the
  // surface. `Object.hasOwn`, never `name in` and never a truthiness test: a
  // reducer named `constructor` resolves through `Object.prototype` on any plain
  // object and would otherwise be admitted with no ledger entry at all.
  const found = reducers.map((r) => r.name).sort();
  for (const name of found) {
    if (Object.hasOwn(REDUCER_SANCTIONS, name)) continue;
    return (
      `[R/name-set] reducer \`${name}\` in ${ACCOUNTS_PATH} is not in the sanctioned ledger, ` +
      `whose entries are [${Object.keys(REDUCER_SANCTIONS).sort().join(', ')}]. Membership, not a ` +
      'count and not containment: the two proven takeover bypasses (E1 `complete_guest_claim_for`, ' +
      'E2 `adopt_guest`) are ADDITIVE, and FG15’s `adopt_guest_by_code` declares no Identity ' +
      'parameter and constructs no Identity, so THIS is the only clause that sees it. Every reducer ' +
      'in this module is a client-reachable entry point into the re-key machinery, so adding one is ' +
      'a security-relevant event that must be re-reviewed right here — declare it in the ledger, ' +
      'with a `why`, in the same PR (ADR-0210)'
    );
  }
  // [R/planned-shape] — a PLANNED name is admitted because a SPECIFIC shape was
  // pre-reviewed, so the SHAPE is pinned here, not merely the name.
  // MEASURED (red-team, this slice): without this clause a reducer that merely
  // REUSES the planned name passes every other clause in this function while
  // the pre-fix exact-set pin red it —
  //   #[spacetimedb::reducer]
  //   pub fn account_deletion_reaper(ctx: &ReducerContext, code: String) -> Result<(),String> {
  //       let claim = ctx.db.guest_claim().code().find(&code).ok_or("no")?;
  //       rekey_all(ctx, claim.guest_identity, ctx.sender()) }
  // — no scheduled table anywhere, a wire-safe `String` parameter, and the
  // victim identity read out of an existing ROW rather than constructed, so
  // [R/identity-param], [R/identity-ctor] and [R/name-set] are all silent.
  // [R/param-types]'s scheduled carve-out CANNOT cover it: that carve-out is
  // reached only after `isWireSafeType(t)` fails, so a wire-safe impostor never
  // arrives there. Admitting a name without its shape is exactly the weakening
  // this slice exists NOT to introduce.
  // The one PLANNED entry is a scheduled reaper (ADR-0207 D5). A future PLANNED
  // entry of a DIFFERENT shape must extend this clause CONSCIOUSLY — that is
  // the category's whole purpose, and a silent widening here would undo it.
  for (const r of reducers) {
    if (!Object.hasOwn(REDUCER_SANCTIONS, r.name)) continue;
    if (REDUCER_SANCTIONS[r.name].status !== 'PLANNED') continue;
    const schedStruct = scheduled.get(r.name);
    const argTypes = [];
    for (let k = 0; k < r.params.length; k++) {
      const t = compactWs(r.params[k].type);
      if (k === 0 && t.endsWith('ReducerContext')) continue;
      argTypes.push(t);
    }
    const span = findFnBody(stripped, r.name);
    const body = span === null ? '' : compactWs(stripped.slice(span.start, span.end));
    const wellShaped =
      schedStruct !== undefined &&
      argTypes.length === 1 &&
      argTypes[0] === schedStruct &&
      schedulerGuardIsLive(body);
    if (wellShaped) continue;
    // Plain bindings, never a NESTED template literal in the message below: a
    // brace matcher that skips string spans (this repo's mutation probes, and
    // `matchBrace` in several evals) resyncs on the INNER backtick and then
    // counts a `}` that is really inside a string, ending the function span
    // early. Measured on this very clause.
    const schedNote = schedStruct === undefined ? 'NONE' : schedStruct;
    const guardNote = schedulerGuardIsLive(body) ? 'present' : 'ABSENT-OR-INERT';
    return (
      `[R/planned-shape] reducer \`${r.name}\` is a PLANNED ledger entry, so it is admitted ONLY ` +
      'in the shape that was pre-reviewed: a same-file `scheduled(...)` target whose sole ' +
      'argument type IS the scheduled struct and whose body carries the scheduler guard ' +
      `\`${SCHEDULER_GUARD}...\`. Found scheduled struct ${schedNote}, argument types ` +
      `[${argTypes.join(', ')}], guard ${guardNote}. ` +
      'A red-team MEASURED that a reducer merely REUSING this name — wire-safe `String` argument, ' +
      'victim identity read from an existing row, no scheduled table at all — is silent to every ' +
      'other clause here while the pre-fix exact-set pin red it. The ledger admits a name because ' +
      'a shape was reviewed; the shape is what is admitted (ADR-0210)'
    );
  }

  const requiredNames = requiredReducerNames(REDUCER_SANCTIONS);
  for (const name of requiredNames) {
    if (found.indexOf(name) !== -1) continue;
    return (
      `[R/name-set] the REQUIRED reducer \`${name}\` is absent from ${ACCOUNTS_PATH}, whose ` +
      `surface is [${found.join(', ')}]. A MISSING name means a client entry point silently ` +
      'disappeared — renamed, moved to another module, or deleted — and every downstream ' +
      'clause that reasons about it goes quiet at the same moment. Relaxing the ledger to bare ' +
      'membership loses exactly this half'
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

// accounts.rs may WRITE only these four tables (D0 is WRITE-scoped, not
// table-scoped). Bare READS of `player` are explicitly permitted — there is no
// single owning module for it. FOUR as of rb-24 (ADR-0221): the deletion
// reaper's own schedule table is colocated under the ADR-0056 exception, and
// the widening is paid for by the Rust twin's rb24_owned_write_set_covers /
// rb24_schedule_table_sole_writers teeth (a widened allowlist alone is a
// permanently open slot).
const OWNED_TABLES = [
  'account',
  'guest_claim',
  'guest_claim_reaper_schedule',
  'account_deletion_reaper_schedule',
];
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
 * Freeze a manifest RECURSIVELY — every reachable object/function value, then
 * the container.
 *
 * `Object.freeze` is shallow, and the half that matters here is the entries:
 * `evals/run.mjs` imports every eval into ONE process, so this module — and
 * therefore this object — is a single instance shared by every co-resident
 * eval. A stray write to an entry's `rekey`/`exists` needle silently GREENS
 * the [G6/consumed] clause, which this file's own header notes is the only
 * part of G6 that nothing else in the repo covers. Note the polarity: writing
 * an ABSENT needle (`'noop('`) reds the clause, which is loud and harmless.
 * The dangerous write is a needle present in EVERY body — `'ctx.'`, `'('` —
 * which makes the substring test pass trivially for a helper that is no longer
 * called at all. Frozen, both writes are a loud TypeError (ESM is strict).
 *
 * Recursion is not speculative generality: it is what makes the guarantee this
 * file advertises TRUE for a nested value. A one-level freeze reports
 * `Object.isFrozen(entry) === true` while an array or record held BY that entry
 * stays writable, which is the shape a richer policy entry takes. Cycles are
 * handled via `seen` so a self-referential entry cannot spin.
 *
 * Consumers spread-copy to build a variant; they never mutate.
 * @param {Record<string, unknown>} manifest The policy table to freeze in place.
 * @param {WeakSet<object>} [seen] Cycle guard; callers omit it.
 * @returns {Record<string, unknown>} The same object, deeply frozen.
 */
function freezeManifest(manifest, seen = new WeakSet()) {
  if (seen.has(manifest)) return manifest;
  seen.add(manifest);
  for (const key of Object.keys(manifest)) {
    const entry = manifest[key];
    // `typeof null === 'object'`, and Object.freeze(null) is a no-op returning
    // null, so the null guard is for the recursive descent, not the freeze.
    if (entry !== null && (typeof entry === 'object' || typeof entry === 'function')) {
      freezeManifest(entry, seen);
    }
  }
  return Object.freeze(manifest);
}

/**
 * "table.field" -> { policy: 'REKEY', rekey: '<helper>(', exists: '<predicate>(' }
 *               |  { policy: 'BLOCKED', reason: '<the guard that rejects the claim>' }
 *               |  { policy: 'EXEMPT', reason: '<why it is never a foreign reference>' }.
 *
 * EVERY entry is an object carrying an explicit `policy` discriminator (rb-2,
 * residual R-m22-s0-X1). Until rb-2 the BLOCKED/EXEMPT entries were bare
 * strings and `checkRekeyCompleteness` inferred REKEY from
 * `typeof policy === 'string'`, so ANY object-valued entry was REKEY by
 * definition — MEASURED: rewriting one BLOCKED string as a record kept the S0
 * contract eval green and redded this file with `[G6/consumed] … as REKEY via
 * undefined`, and the only green workaround was to borrow another table's
 * needles, i.e. to advertise a BLOCKED column as re-keyed. The discriminator is
 * now a FIELD, read by exactly one function (`classifyPolicy` below, which owns
 * the rules and their failure text). Objects-only on purpose: a dual form (strings still
 * legal via their prefix) would keep the prefix parse as a second, implicit
 * discriminator, and a one-letter `BLOKED:` slip would silently un-police a
 * column. Literal objects rather than constructor helpers on purpose:
 * accounts_tests.rs reads this file as TEXT (the T9 cross-manifest proof), and a
 * helper would hide the policy word from that reader while adding a second place
 * to lie. The `reason` text is the ADR-0179 D6 justification VERBATIM, minus the
 * retired `BLOCKED: ` / `EXEMPT: ` prefix — M22 consumes it as the
 * deletion-cascade SSOT, so it must stay truthful (see the corrections below).
 *
 * EXPORTED as the M22 slice-0 contract surface: a second gate file consumes
 * this policy table and the `findIdentityColumns` walker below rather than
 * transcribing a third copy of either, so there stays exactly one walk of the
 * Rust sources with two gate files reading it.
 *
 * This module is NOT a re-export barrel — import the other two halves of the
 * scan from their canonical owners, not from here: `stripRustSource` /
 * `assertStripperSound` / `compactWs` / `containsIdent` from
 * `evals/rust-scan.mjs` (ADR-0181 D1 consolidated them there), and
 * `parseTableSchemas` from `evals/battle-schema-snapshot.eval.mjs`. Every eval
 * in one `run.mjs` process resolves those to the same function objects, so a
 * barrel would add a second spelling and buy nothing.
 *
 * THE INPUT-SET RULE — glob, normalise separators, skip `_tests.rs`, fail loud
 * if empty, sort, read — is built inline in this file's default export, and it
 * is CWD-RELATIVE to the repo root. It is NOT exported yet only because
 * widening the frozen contract past slice 0's scope is a follow-up, not a
 * seam-freeze. **Do not transcribe it.** A second consumer needs the same input
 * set, and a prose copy of it here would be exactly the ungated second source of
 * truth this whole surface exists to abolish — a narrower glob makes a
 * completeness gate pass vacuously over a smaller column set, and a transcribed
 * rule drifts silently the first time the real one moves. The slice that needs
 * it EXPORTS it from here and imports it, the same way it does the manifest.
 *
 * ALIAS RESOLUTION, stated because this contract advertises it (rb-4, residual
 * R-m22-s0-X3; THE ALIAS RESOLUTION RULE above `findIdentityColumns`): the
 * walker classifies a column by its RESOLVED type, expanding every `type` item
 * and `use … as` rename declared anywhere in the scanned tree, so an aliased
 * Identity column is seen by this walker and by every consumer of it, and the
 * record carries both the declared text (`type`) and the expansion
 * (`resolved`) — a consumer reads Option-ness from the latter and never
 * resolves anything itself. What is STILL not seen, routed to the residual
 * backlog: a SpacetimeType product column carrying an Identity, a field
 * declared without `pub`, and a binding declared outside the scanned input set
 * — a consumer that must be exhaustive over those has to gate them out at the
 * schema, not here.
 * @type {Record<string, RekeyPolicyEntry>}
 */
export const REKEY_MANIFEST = freezeManifest({
  // --- REKEY: moved from the guest identity onto the caller by rekey_all, and
  // counted as "game data" by account_has_game_data. ---
  'monster.owner_identity': { policy: 'REKEY', rekey: 'rekey_monsters(', exists: 'has_monsters(' },
  'monster_pub.owner_identity': {
    policy: 'REKEY',
    rekey: 'rekey_monsters(',
    exists: 'has_monsters(',
  },
  'inventory.owner_identity': { policy: 'REKEY', rekey: 'rekey_inventory(', exists: 'has_items(' },
  'player_quest.owner_identity': {
    policy: 'REKEY',
    rekey: 'rekey_npc_state(',
    exists: 'has_quest_or_dialogue_state(',
  },
  'player_dialogue_state.owner_identity': {
    policy: 'REKEY',
    rekey: 'rekey_npc_state(',
    exists: 'has_quest_or_dialogue_state(',
  },
  'heal_cooldown.owner_identity': {
    policy: 'REKEY',
    rekey: 'rekey_heal_cooldown(',
    exists: 'has_heal_cooldown(',
  },
  'player_wallet.owner_identity': {
    policy: 'REKEY',
    rekey: 'rekey_wallet(',
    exists: 'wallet_exists(',
  },
  'profile.identity': { policy: 'REKEY', rekey: 'rekey_profile(', exists: 'profile_exists(' },

  // --- BLOCKED: a guard rejects the claim while such a row exists, so there is
  // nothing to carry forward. ---
  'player.identity': {
    policy: 'BLOCKED',
    reason: 'guard 1 (AUTH-18) rejects while the guest presence row exists',
  },
  'player_conversation.owner_identity': {
    policy: 'BLOCKED',
    reason: 'transitively covered by guards 1/3',
  },
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
  'battle.player_identity': {
    policy: 'BLOCKED',
    reason:
      'guard 2 (AUTH-19) blocks ONLY Ongoing rows — terminal rows survive and orphan; ' +
      'M22 cascade MUST sweep this column',
  },
  'battle.opponent_identity': {
    policy: 'BLOCKED',
    reason:
      'guard 2 (AUTH-19) blocks ONLY Ongoing rows — terminal rows survive and orphan; ' +
      'M22 cascade MUST sweep this column',
  },
  'battle_action.player_identity': {
    policy: 'BLOCKED',
    reason: 'transitively covered (requires an ongoing battle)',
  },
  'trade_offer.initiator': { policy: 'BLOCKED', reason: 'transitively covered by guards 1/3' },
  'trade_offer.counterparty': { policy: 'BLOCKED', reason: 'transitively covered by guards 1/3' },
  'battle_challenge.challenger': {
    policy: 'BLOCKED',
    reason: 'transitively covered by guards 1/3',
  },
  // CORRECTED during the M21c security audit — `cancel_challenges_on_disconnect`
  // (pvp.rs:638-651) filters `challenge_id().challenger().filter(player)` only,
  // so an INCOMING pending challenge (guest is the `target`) survives the
  // guest's disconnect until the CHALLENGE_TTL_MS reaper fires. Guards 9, 10 and
  // 11 all pass — `account_has_game_data` (accounts.rs:209-216) never consults
  // `battle_challenge`. Low impact in M21 (a stale challenge that TTL-expires),
  // but the row is a real dangling reference and M22 inherits this table.
  // Contrast `battle_challenge.challenger` above, which IS genuinely blocked.
  'battle_challenge.target': {
    policy: 'BLOCKED',
    reason:
      'only the CHALLENGER half is swept on disconnect (pvp.rs:638-651) — an incoming ' +
      'challenge survives until the TTL reaper; M22 cascade MUST sweep this column',
  },

  // --- EXEMPT: never a foreign reference to re-key. ---
  'playtest_event.identity': {
    policy: 'EXEMPT',
    reason: 'dev telemetry, deliberately stays under the guest identity',
  },
  'config.owner_identity': {
    policy: 'EXEMPT',
    reason: 'module-owner sentinel, defaults to the zero identity',
  },
  'account.identity': {
    policy: 'EXEMPT',
    reason: "this milestone's own primary key, always the caller's own identity",
  },
  'account.claimed_from': {
    policy: 'EXEMPT',
    reason: 'write target, not a rekey source (AUTH-21 records the guest)',
  },
  'guest_claim.guest_identity': {
    policy: 'EXEMPT',
    reason: 'consumed, not rekeyed (AUTH-34 / AUTH-27)',
  },
  'guest_claim_reaper_schedule.guest_identity': {
    policy: 'EXEMPT',
    reason: 'consumed, not rekeyed (AUTH-34 / AUTH-27)',
  },
  // rb-24 (ADR-0221). VERIFIED not an export_bundle-style honest-limit case:
  // the column can never name a retired guest identity, because the arm is
  // reachable only from delete_account (which requires an existing account
  // row for the caller) and start_guest_claim rejects account holders
  // (AUTH-7) — so a claim never retires an identity this column references.
  'account_deletion_reaper_schedule.account_identity': {
    policy: 'EXEMPT',
    reason:
      'never a foreign or retiring reference: armed only by delete_account for the ' +
      'calling account holder, disarmed by cancel_account_deletion, and the fired ' +
      'one-shot row is deleted by the runtime itself',
  },
  // CORRECTED during the m22-s2 security audit — the first draft said "the M22 cascade
  // sweeps this column", which is FALSE in exactly the case EXEMPT creates: the cascade
  // keys on the deleting account identity, and a pre-claim chunk sits under the retired
  // guest identity where that key cannot reach it. The reason must be truthful (the
  // battle.player_identity precedent above): this is the one EXEMPT entry that leaves
  // live personal data under a dead identity, and S3 owns closing it.
  'export_bundle.owner_identity': {
    policy: 'EXEMPT',
    reason:
      'TTL-bound M22 export snapshot, not re-keyed across a claim. HONEST LIMIT: ' +
      'pre-claim chunks orphan under the guest identity (the cascade keys on the deleting ' +
      'identity and cannot reach them) — S3 MUST close this: delete chunks at claim time, or ' +
      'sweep owner_identity == account.claimed_from in the cascade; the S4 TTL reaper does ' +
      'not exist yet and a TTL is not a substitute for cascade erasure anyway (the ' +
      'playtest_event doctrine)',
  },
});

// ---------------------------------------------------------------------------
// THE POLICY DISCRIMINATOR (rb-2). One reader, one closed set, one closed field
// set per kind. Anti-patterns this replaces — MEASURED green-and-wrong on the
// fork tree: `typeof entry === 'string'` (the residual's own repro) and needle
// presence (`'rekey' in entry`); pinned by the ledger's X3 mutants and the
// FG60-FG71 teeth: `entry.policy || 'BLOCKED'`, a `switch` with a silent
// default, `startsWith('REKEY')` (blesses a REKEY_TODO placeholder), a
// case-insensitive compare, an empty anchor list; and, structurally,
// classifying in two places.
// Forward path: when a second file must interpret entry shape, EXPORT
// `classifyPolicy` and freeze it in rekey-contract-surface — never re-implement.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE OWN-PROPERTY BOUNDARY (rb-3, residual R-m22-s0-X2). Inside
// checkRekeyCompleteness the manifest's KEY SPACE is read exactly once — by
// classifyManifest, over Object.keys, into a Map — and every later clause reads
// that Map. Object.freeze does not seal the prototype chain, and every eval
// shares ONE realm under evals/run.mjs, so a co-resident eval's
// `Object.prototype['table.col']` would otherwise classify a genuinely
// unpoliced column while Object.keys and the detail counts stay at 24. Until
// rb-2 the declared clause was literally a `key in manifest` test — MEASURED on
// the fork: a poisoned prototype key greened an unclassified column. rb-2
// replaced it INCIDENTALLY (the Map) and nothing pinned it until FG72a-f.
// Banned, each measured green-and-wrong and pinned by the ledger's X2 mutants:
// the `in` operator or a bare property read as a membership test, an own-key
// test widened with a chain fallback, `for…in` over the manifest in ANY clause,
// reading the frozen export instead of the injected parameter, and preferring
// an inherited entry over an own one. The same rule holds for the classifier's
// RESULT records: an absent own key is read with Object.hasOwn, never
// `!== undefined` — an ambient `Object.prototype.error` otherwise turns a
// correct tree/manifest pair into a failure no clause produced (FG72c is RED on
// exactly that). The second consumer applies the same rule on its side
// (rekey-contract-surface.eval.mjs, Object.hasOwn over the manifest). Quirk,
// noted rather than fixed here: a table NAMED `__proto__` vanishes from
// parseTableSchemas' plain-object map; [G6/parse] fail-closes on it (declared
// 1, parsed 0) — but that count is over TABLES, so a FIELD named `__proto__`
// (a legal Rust identifier) vanishes from the column map with no fail-close:
// an Identity column this gate never sees. Accepted, unpinned, and routed with
// battle-schema-snapshot's own `in`-based table reads to the ledger (rb-3 X10)
// — that parser is outside this slice's touches.
// ---------------------------------------------------------------------------

/**
 * @typedef {{policy:'REKEY', rekey:string, exists:string}
 *   | {policy:'BLOCKED'|'EXEMPT', reason:string}} RekeyPolicyEntry
 */

/**
 * The three legal entry shapes. `fields` is the sorted, comma-joined OWN key
 * set an entry of that kind must carry EXACTLY — a closed set, so a new field
 * (M22 S3's `deletion_policy` / `basis` / `exportable`) is a [G6/policy]
 * failure until it is added HERE, in the same PR, on purpose. An array searched
 * with `.find`, never an object keyed by the policy word: `policy: 'constructor'`
 * must be an UNKNOWN kind, not a hit on Object.prototype.
 */
const POLICY_SHAPES = [
  { kind: 'REKEY', fields: 'exists,policy,rekey' },
  { kind: 'BLOCKED', fields: 'policy,reason' },
  { kind: 'EXEMPT', fields: 'policy,reason' },
];

// A needle is a helper-CALL prefix (`rekey_wallet(`, `crate::economy::rekey_wallet(`).
// A token present in every fn body — `ctx`, a bare paren — would make the
// [G6/consumed] substring test vacuous for a helper nobody calls.
const NEEDLE_SHAPE = /^[a-z][a-z0-9_:]{3,}\($/;
// The retired string spelling must not creep back INSIDE a reason: `policy` is
// the only discriminator, and two spellings of one fact is the defect rb-2 closed.
const REASON_PREFIX_LIES = ['blocked:', 'exempt:', 'rekey:'];

/**
 * @typedef {{kind:'REKEY'|'BLOCKED'|'EXEMPT', rekey:string|undefined, exists:string|undefined}} ClassifiedPolicy
 */

/**
 * Parse ONE manifest entry into its policy kind (parse-don't-validate: the
 * needles are copied out HERE, and [G6/consumed] reads the parsed record, never
 * the raw entry again). Returns a tagged error string for every malformed shape
 * and NEVER throws — `typeof null === 'object'` and arrays are objects, so a
 * classifier that trusts `typeof` dereferences null and the whole eval dies as
 * `TEETH threw`, naming no key.
 * @param {string} key "table.field".
 * @param {unknown} entry The manifest value.
 * @returns {ClassifiedPolicy|{error:string}} Parsed policy, or a [G6/policy] error.
 */
function classifyPolicy(key, entry) {
  const bad = (why) => ({
    error:
      `[G6/policy] the manifest entry \`${key}\` ${why}. Every entry is an object carrying an ` +
      "explicit `policy` of exactly 'REKEY', 'BLOCKED' or 'EXEMPT' — that field is the ONLY " +
      'discriminator (never typeof, never needle presence). A REKEY entry carries exactly ' +
      '{policy, rekey, exists}; a BLOCKED or EXEMPT entry exactly {policy, reason}, and every ' +
      'field value is a non-blank string. A new field (the M22 S3 deletion_policy / basis / ' +
      'exportable extension) is added to POLICY_SHAPES in this file, in the same PR, ' +
      'deliberately — and a non-string field needs the non-blank-string rule relaxed here too',
  });
  if (entry === null) return bad('is null');
  if (Array.isArray(entry)) return bad('is an array');
  if (typeof entry !== 'object') return bad(`is of type ${typeof entry}, not an object`);
  const shape = POLICY_SHAPES.find((s) => s.kind === entry.policy);
  if (shape === undefined) {
    return bad(
      `declares policy ${JSON.stringify(entry.policy)}, which is not exactly REKEY, BLOCKED or EXEMPT`,
    );
  }
  const fields = Object.keys(entry).sort().join(',');
  if (fields !== shape.fields) {
    return bad(
      `is ${shape.kind} but declares the fields [${fields}] where exactly [${shape.fields}] are legal`,
    );
  }
  for (const f of Object.keys(entry)) {
    if (typeof entry[f] !== 'string' || entry[f].trim() === '') {
      return bad(`has a \`${f}\` that is not a non-blank string`);
    }
  }
  if (shape.kind === 'REKEY') {
    for (const f of ['rekey', 'exists']) {
      if (!NEEDLE_SHAPE.test(entry[f])) {
        return bad(
          `has a \`${f}\` needle ${JSON.stringify(entry[f])} that is not a helper-call prefix ` +
            'such as rekey_wallet( — a token found in every fn body would make the consumption ' +
            'scan pass for a helper nobody calls. A legal helper spelling this rejects means ' +
            'NEEDLE_SHAPE in this file is widened in the same PR',
        );
      }
    }
    return { kind: shape.kind, rekey: entry.rekey, exists: entry.exists };
  }
  const lowered = entry.reason.trimStart().toLowerCase();
  if (REASON_PREFIX_LIES.some((p) => lowered.startsWith(p))) {
    return bad('restates a policy word inside its reason — `policy` is the only discriminator');
  }
  return { kind: shape.kind, rekey: undefined, exists: undefined };
}

/**
 * Classify EVERY entry of a manifest exactly once. First failure wins.
 * This is the ONLY read of the manifest's key space on the G6 path — own
 * enumerable keys via Object.keys (THE OWN-PROPERTY BOUNDARY above); the Map
 * it returns is what every clause consults, so no clause ever asks the
 * manifest object a membership question.
 * @param {Record<string, unknown>} manifest The policy table.
 * @returns {{kinds: Map<string, ClassifiedPolicy>}|{error:string}} Parsed table, or the error.
 */
function classifyManifest(manifest) {
  const kinds = new Map();
  for (const key of Object.keys(manifest)) {
    const parsed = classifyPolicy(key, manifest[key]);
    if (Object.hasOwn(parsed, 'error')) return { error: parsed.error };
    kinds.set(key, parsed);
  }
  return { kinds };
}

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
// The REKEY columns of ADR-0179 D6, pinned as REKEY BY VALUE. A SUBSET pin,
// not an equality: a ninth REKEY column needs no edit here, but demoting one of
// these to BLOCKED — the reverse of the lie rb-2 closed, and a shape [G6/policy]
// cannot see because it is well-formed — reds [G6/anchors] instead of silently
// dropping the column out of [G6/consumed]. Accepted limit, by design: a NEW
// REKEY column added later is consumption-checked but not demotion-pinned until
// it is appended here.
const G6_REKEY_ANCHORS = [
  'monster.owner_identity',
  'monster_pub.owner_identity',
  'inventory.owner_identity',
  'player_quest.owner_identity',
  'player_dialogue_state.owner_identity',
  'heal_cooldown.owner_identity',
  'player_wallet.owner_identity',
  'profile.identity',
];

const REKEY_ALL_FN = 'rekey_all';
const HAS_GAME_DATA_FN = 'account_has_game_data';

// ---------------------------------------------------------------------------
// THE ALIAS RESOLUTION RULE (rb-4, residual R-m22-s0-X3). Until rb-4 the walker
// classified a column by the LITERAL text of its declared type, so a column
// typed through a Rust `type` item, or through a `use … as` rename, that
// resolves to Identity was invisible to G6/declared, G6/live AND G6/anchors —
// MEASURED on the fork for every spelling (direct, transitive, Option-wrapped
// in either direction, renamed, cross-file, any visibility, qualified RHS,
// rustfmt-wrapped, `r#`-prefixed, non-ASCII). The rule now: every `type`
// item and every rename in the WHOLE scanned tree is collected ONCE, from
// STRIPPED source, into one name -> bindings Map — a UNION with duplicates
// KEPT and no per-file precedence, because the collector is namespace-blind
// and a same-file associated item (`impl … { type X = u64; }`) would
// otherwise overwrite a module-level binding (a measured, CI-clean hide). A
// column's declared type is split into identifier TOKENS and every bound token
// is expanded recursively, a name already on the current expansion path being
// terminal (a self-referential re-export resolves to a fixed point; a cycle
// merely stops). An Identity-bearing expansion WINS (fail-closed on
// ambiguity), and the G6/declared message renders every binding consulted with
// its file, or the over-report is unactionable. The record keeps the DECLARED
// text unchanged and adds the expansion plus the bindings consulted; a
// consumer reads Option-ness from `resolved`, never resolving anything itself.
// Banned, each measured green-and-wrong: classifying on the declared text;
// per-file precedence; a single-level expansion; matching by SUBSTRING instead
// of by token (a name that merely begins with a bound name is fabricated into
// an Identity column, and a bound name that is a prefix of a longer one
// corrupts every real column); collecting over RAW source (a declaration
// quoted inside a string literal becomes a binding); a plain-object binding
// table (an ambient non-enumerable prototype value answers for an unbound
// name); resolving only the WHOLE type text; a first-binding tie-break. A
// declaration the resolver cannot read — a macro that GENERATES a `type` item
// (`type $`), a binding whose right-hand side carries a metavariable or a
// macro invocation, or a binding of the name `Identity` itself (which the
// resolver keeps terminal) — is DETECTED by G6/alias and reported by file,
// never skipped. Every binding is rendered in the one shape `type NAME = RHS`
// with its file, a rename included. Expansion is memoised per column, so a
// name bound k ways over a d-deep chain costs k·d rather than k^d.
// Accepted limits, each routed to the residual backlog (rb-4 ledger X10-X12):
// a SpacetimeType product column carrying an Identity (a named-field struct,
// an enum payload, a generic wrapper, a Vec of any of these — live-reachable
// through encounter.entries); a field declared without `pub`, two fields on
// one line, or a rustfmt::skip-wrapped type (G6/parse counts tables, not
// fields); a binding declared OUTSIDE the scanned input set (game-core carries
// an optional spacetimedb dependency); a proc-macro-generated item from an
// external crate, or a paste-style generated NAME, which leave no readable
// text at all; and two collector truncations that are fail-open only for
// types that are not legal columns — a right-hand side containing `;` (an
// array) is cut there, and a right-hand side of unbounded width is expanded
// without a size cap.
// ---------------------------------------------------------------------------

/**
 * Every `use … ;` span in ONE stripped source, whole (a multi-line brace
 * group is one span), so a rename can be found wherever rustfmt put it.
 * @param {string} stripped Stripped Rust source.
 * @returns {string[]} Each span from its `use` keyword up to (not including) `;`.
 */
function useItems(stripped) {
  const items = [];
  const text = rustWs(stripped);
  // Built per call on purpose: a module-scope global regex keeps `lastIndex`
  // across calls and would silently skip items in the next file.
  const USE_ITEM = /\buse\s/g;
  for (const m of text.matchAll(USE_ITEM)) {
    const end = text.indexOf(';', m.index);
    if (end === -1) break;
    items.push(text.slice(m.index, end));
  }
  return items;
}

/**
 * Map the three Rust Pattern_White_Space code points that JavaScript's `\s`
 * does NOT match — U+0085 NEL, U+200E LRM, U+200F RLM — to a plain space,
 * length-preserving. rustc treats them as whitespace between `type` and a name
 * (or after `use`), so a `#[rustfmt::skip]` item spelled with one of them
 * compiles clean and would otherwise bind nothing (measured, red-team).
 * @param {string} s Stripped Rust source.
 * @returns {string} The same text with those code points spaced.
 */
function rustWs(s) {
  return s.replace(/[\u0085\u200e\u200f]/g, ' ');
}

/**
 * Every `type NAME … = RHS;` item (any visibility, generics and where-clauses
 * swallowed, RHS spanning newlines) and every `TOKEN as NAME` rename inside a
 * `use` span, as binding records. A rename binds NAME to the LAST path segment
 * it renames, so a renamed name that is itself bound resolves through both.
 * @param {string} stripped Stripped (never compacted — compaction destroys the
 *   keyword boundary) Rust source of one file.
 * @param {string} path The file, for the failure message.
 * @returns {Array<{name:string, rhs:string, path:string}>} Bindings, in order.
 */
function collectAliasBindings(stripped, path) {
  const out = [];
  const text = rustWs(stripped);
  const ALIAS_ITEM = /\btype\s+(?:r#)?([\p{XID_Start}_][\p{XID_Continue}]*)[^=;]*=\s*([^;]*);/gu;
  for (const m of text.matchAll(ALIAS_ITEM)) {
    // Whitespace COLLAPSED, never removed: `&'a Identity` compacted would read
    // `&'aIdentity`, one token, and the Identity inside it would be lost.
    out.push({ name: m[1], rhs: m[2].trim().replace(/\s+/g, ' '), path });
  }
  const RENAME =
    /((?:r#)?[\p{XID_Start}_][\p{XID_Continue}]*)\s+as\s+(?:r#)?([\p{XID_Start}_][\p{XID_Continue}]*)/gu;
  for (const item of useItems(stripped)) {
    for (const m of item.matchAll(RENAME)) {
      if (m[2] === '_') continue;
      out.push({ name: m[2], rhs: m[1].startsWith('r#') ? m[1].slice(2) : m[1], path });
    }
  }
  return out;
}

/**
 * The tree-wide binding table: name -> EVERY binding of that name, in tree
 * order, duplicates kept (see the rule above). A Map, never a plain object —
 * `constructor` and `__proto__` are legal Rust identifiers, and the
 * own-property boundary applies to derived structures too.
 * @param {Array<{path:string, stripped:string}>} treeStripped Every source, stripped once.
 * @returns {Map<string, Array<{name:string, rhs:string, path:string}>>} The table.
 */
function indexAliasBindings(treeStripped) {
  const aliases = new Map();
  for (const t of treeStripped) {
    for (const b of collectAliasBindings(t.stripped, t.path)) {
      if (!aliases.has(b.name)) aliases.set(b.name, []);
      aliases.get(b.name).push(b);
    }
  }
  return aliases;
}

/**
 * Expand every bound identifier TOKEN of `text` recursively. Termination is
 * structural: a name already on `onPath` is left as it is. Every binding
 * consulted is appended to `via` once; where a name has several bindings the
 * Identity-bearing expansion is the one substituted (fail-closed).
 * @param {string} text A (compacted) type text, or a binding's RHS.
 * @param {Map<string, Array<{name:string, rhs:string, path:string}>>} aliases The table.
 * @param {string[]} onPath Names being expanded on the current path.
 * @param {Array<{name:string, rhs:string, path:string}>} via Accumulator.
 * @param {Map<string, string>} memo Per-column cache of each name's chosen
 *   expansion — without it a name bound k ways over a d-deep chain costs k^d
 *   (measured: three `mod` blocks re-declaring a 16-hop chain took 40 s).
 * @returns {string} The expanded text.
 */
function expandTokens(text, aliases, onPath, via, memo) {
  const tokens = text.match(/(?:r#)?[\p{XID_Start}_][\p{XID_Continue}]*/gu) ?? [];
  let out = '';
  let cursor = 0;
  for (const raw of tokens) {
    // Tokens come back in order and only separators lie between them, so the
    // first occurrence at or after the cursor is this token itself.
    const at = text.indexOf(raw, cursor);
    out += text.slice(cursor, at);
    cursor = at + raw.length;
    const name = raw.startsWith('r#') ? raw.slice(2) : raw;
    const bindings = aliases.get(name);
    // `Identity` itself is TERMINAL: it is the token this gate classifies on,
    // and a tree-wide binding of that name is reported by G6/alias, never
    // expanded away underneath every literally-typed column.
    if (bindings === undefined || name === 'Identity' || onPath.indexOf(name) !== -1) {
      out += raw;
      continue;
    }
    const hit = memo.get(name);
    if (hit !== undefined) {
      out += hit;
      continue;
    }
    const expansions = [];
    for (const b of bindings) {
      if (via.indexOf(b) === -1) via.push(b);
      const inner = expandTokens(b.rhs, aliases, onPath.concat(name), via, memo);
      expansions.push(inner);
    }
    const chosen = expansions.find((e) => containsIdent(e, 'Identity')) ?? expansions[0];
    memo.set(name, chosen);
    out += chosen;
  }
  return out + text.slice(cursor);
}

/**
 * Resolve one column's declared type text through the binding table.
 * @param {string} text The compacted declared type text.
 * @param {Map<string, Array<{name:string, rhs:string, path:string}>>} aliases The table.
 * @returns {{resolved:string, via:Array<{name:string, rhs:string, path:string}>}}
 *   The expansion (equal to `text` when no binding applied) and the bindings consulted.
 */
function resolveType(text, aliases) {
  const via = [];
  const resolved = expandTokens(text, aliases, [], via, new Map());
  return { resolved, via };
}

/**
 * Render a column record's alias chain for the G6/declared message: nothing for
 * a directly-typed column; otherwise the expansion, every binding consulted
 * with its file, and a fail-closed note per name bound to more than one DISTINCT
 * right-hand side (two agreeing declarations are not an ambiguity). Every
 * binding — a `type` item or a `use … as` rename alike — is rendered in the
 * one shape `type NAME = RHS`, with the declaring file beside it.
 * @param {{type:string, resolved:string, via:Array<{name:string, rhs:string, path:string}>}} decl
 *   The column record.
 * @returns {string} A clause fragment beginning with `, `, or `''`.
 */
function aliasNote(decl) {
  if (decl.via.length === 0) return '';
  const rendered = decl.via.map((b) => `\`type ${b.name} = ${b.rhs}\` in ${b.path}`).join(' and ');
  const perName = new Map();
  for (const b of decl.via) {
    if (!perName.has(b.name)) perName.set(b.name, new Set());
    perName.get(b.name).add(b.rhs);
  }
  let ambiguous = '';
  for (const [name, rhss] of perName) {
    if (rhss.size < 2) continue;
    ambiguous += ` — \`${name}\` is bound ${rhss.size} ways in the tree; reported fail-closed, rename one`;
  }
  return `, which resolves to \`${decl.resolved}\` via ${rendered}${ambiguous}`;
}

/**
 * Every COLUMN across a set of sources whose declared type RESOLVES to
 * `Identity` / `Option<Identity>` (see THE ALIAS RESOLUTION RULE above), keyed
 * "table.field". Uses battle-schema-snapshot's `parseTableSchemas`, which reads
 * ONLY `#[spacetimedb::table(...)] pub struct` field lists — a whole-file
 * `: Identity,` line match false-positives on the ~17 pre-existing FUNCTION
 * PARAMETER sites (ADR-0179 D6, finalization-pass note). Two passes over the
 * tree: every source is stripped ONCE, the binding table is built over all of
 * them, then the tables are walked.
 * @param {Array<{path:string, src:string}>} treeSrcs Non-test server sources.
 * @returns {Map<string, {path:string, type:string, resolved:string,
 *   via:Array<{name:string, rhs:string, path:string}>}>} column key -> declaration:
 *   `type` is the DECLARED text, `resolved` its expansion (equal when direct),
 *   `via` the bindings consulted (empty when direct). The field set is CLOSED.
 */
export function findIdentityColumns(treeSrcs) {
  const cols = new Map();
  // Stripped, not raw: a `#[spacetimedb::table(` quoted inside a string
  // literal must not be able to inject a phantom table into the manifest scan,
  // and a `type` item quoted inside one must not become a binding.
  const treeStripped = [];
  for (const f of treeSrcs) {
    treeStripped.push({ path: f.path, stripped: stripRustSource(f.src) });
  }
  const aliases = indexAliasBindings(treeStripped);
  for (const f of treeStripped) {
    const tables = parseTableSchemas(f.stripped);
    for (const table of Object.keys(tables)) {
      const columns = tables[table].columns ?? {};
      for (const field of Object.keys(columns)) {
        const type = compactWs(columns[field]);
        const { resolved, via } = resolveType(type, aliases);
        if (!containsIdent(resolved, 'Identity')) continue;
        cols.set(`${table}.${field}`, { path: f.path, type, resolved, via });
      }
    }
  }
  return cols;
}

/**
 * G6 REKEY_COMPLETENESS — the D6 manifest is complete, live, and consumed.
 * @param {Array<{path:string, src:string}>} treeSrcs Every non-test server source.
 * @param {string} accountsSrc Raw server-module/src/accounts.rs source.
 * @param {Record<string, RekeyPolicyEntry>} [manifest]
 *   Injected policy table (defaults to REKEY_MANIFEST; the teeth inject
 *   deliberately wrong manifests so [G6/anchors] is provably not always-green).
 * @returns {string|null} Error string, or null on pass.
 */
export function checkRekeyCompleteness(treeSrcs, accountsSrc, manifest = REKEY_MANIFEST) {
  for (const f of treeSrcs) {
    const desync = assertStripperSound(f.src, f.path);
    if (desync) return desync;
  }

  // [G6/policy] — every entry parses to exactly one policy kind. Runs before
  // the manifest is compared to the tree, so a manifest defect is never
  // reported as a tree defect.
  const classified = classifyManifest(manifest);
  if (Object.hasOwn(classified, 'error')) return classified.error;
  const kinds = classified.kinds;

  // [G6/parse] — PARSER non-vacuity, the [STRIP/anchors] idea applied to
  // parseTableSchemas. [G6/declared] can only classify columns the parser
  // RETURNS, so a table declaration the parser cannot read hides every Identity
  // column in that struct — silently, and from the schema-snapshot baseline too
  // (a table absent from BOTH parsed and baseline is in neither side of the
  // union, so it reports no drift). Two live-legal spellings do exactly that:
  //   #[spacetimedb::table(accessor = t, index(btree, accessor = i, columns = [a, b]))]
  //     — the parser's `[^\]]*\)\]` sub-pattern cannot span the `]` of `[a, b]`;
  //   #[spacetimedb::table(public, accessor = t)]
  //     — the parser requires `accessor =` as the FIRST attribute argument.
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
        'whose Identity columns G6/declared never sees, so the re-key manifest would silently ' +
        'stop covering it — and the battle-schema-snapshot baseline would not notice either, ' +
        'because a table missing from BOTH parsed and baseline appears in neither side of that ' +
        'union. The two known unreadable spellings are a multi-column index inside the attribute ' +
        '(`index(btree, accessor = i, columns = [a, b])` — the parser cannot span the inner `]`) and ' +
        '`accessor =` not being the first attribute argument. Fix the declaration, or teach ' +
        'parseTableSchemas the new form in the same PR'
      );
    }
    // [G6/alias] — three binding shapes the resolver cannot read, each fail
    // loud by file rather than walked past (zero hits on the live tree):
    //   a macro that GENERATES a `type` item leaves only a metavariable where
    //   the resolver expects a name (the byte string `type $`), so the binding
    //   is never collected;
    //   a binding whose right-hand side carries a metavariable or a macro
    //   INVOCATION (`type X = $t;` inside a macro body, `type X = mk!();`) is
    //   collected but expands to nothing Identity-bearing (measured, red-team);
    //   a binding of the name `Identity` itself shadows the token this gate
    //   classifies on — the resolver keeps that token terminal, and this clause
    //   is what turns a silent 0-column walk into a named diagnosis.
    if (stripped.indexOf('macro_rules!') !== -1 && stripped.indexOf('type $') !== -1) {
      return (
        `[G6/alias] ${f.path} declares a \`type\` item from inside a \`macro_rules!\` body ` +
        '(the byte string `type $`). The alias resolver reads declarations by SHAPE and a ' +
        'macro metavariable has none, so any column typed through that generated name would ' +
        'be an Identity column this gate never sees. Declare the item directly, or teach the ' +
        'resolver the macro in the same PR'
      );
    }
    for (const b of collectAliasBindings(stripped, f.path)) {
      if (b.name === 'Identity') {
        return (
          `[G6/alias] ${f.path} binds the name \`Identity\` itself (\`type Identity = ${b.rhs}\` ` +
          'or a `use … as Identity` rename). That is the token every column is classified on, ' +
          'so a tree-wide binding of it would rewrite the resolved type of EVERY literally-typed ' +
          'column at once; the resolver refuses to expand it and this clause names the file. ' +
          'Rename the binding'
        );
      }
      if (b.rhs.indexOf('$') !== -1 || b.rhs.indexOf('!') !== -1) {
        return (
          `[G6/alias] ${f.path} binds \`${b.name}\` to \`${b.rhs}\`, a right-hand side carrying a ` +
          'macro metavariable or a macro invocation. The alias resolver expands identifier ' +
          'tokens and a macro leaves it nothing to expand, so a column typed through this name ' +
          'would be an Identity column this gate never sees. Spell the type out, or teach the ' +
          'resolver the macro in the same PR'
        );
      }
    }
  }

  const columns = findIdentityColumns(treeSrcs);

  // [G6/declared] — forward direction: a NEW Identity column with no policy.
  // Membership is asked of the derived Map, never of the manifest object (THE
  // OWN-PROPERTY BOUNDARY; FG72a/c/e pin it, X2's M1-M4/M11 are the cheats).
  for (const key of [...columns.keys()].sort()) {
    if (kinds.has(key)) continue;
    const decl = columns.get(key);
    return (
      `[G6/declared] the column \`${key}\` (type \`${decl.type}\`, declared in ${decl.path}` +
      `${aliasNote(decl)}) has no ` +
      'entry in the ADR-0179 D6 re-key manifest. EVERY Identity column in the module needs an ' +
      'explicit policy — REKEY (carried from the guest onto the claiming account), BLOCKED (a ' +
      'guard rejects the claim while such a row exists) or EXEMPT (never a foreign reference). An ' +
      'unclassified column is data that a successful claim SILENTLY ORPHANS under the abandoned ' +
      'guest identity. Add it to REKEY_MANIFEST in the same PR that adds the column, and to D6'
    );
  }

  // [G6/live] — reverse direction: a stale policy for a column that is gone.
  for (const key of kinds.keys()) {
    if (columns.has(key)) continue;
    return (
      `[G6/live] the manifest entry \`${key}\` does not resolve to any live table column. The check ` +
      'is BIDIRECTIONAL on purpose: a deleted or renamed column must not leave a stale policy ' +
      'behind, because a stale entry is indistinguishable from a live one when the next reviewer ' +
      'reads the manifest, and (for a REKEY entry) it keeps G6/consumed green for a helper that ' +
      'no longer re-keys anything'
    );
  }

  // [G6/anchors] — non-vacuity, hardcoded independently of the manifest.
  for (const key of G6_ANCHORS) {
    if (!columns.has(key)) {
      return (
        `[G6/anchors] the anchor column \`${key}\` was not found in the scanned tree. These four ` +
        'columns are hardcoded INDEPENDENTLY of the manifest precisely so that an empty scan set, ' +
        'a wrong glob or a parser regression cannot leave G6/declared and G6/live both ' +
        `passing vacuously (they are trivially satisfied when the column set is empty). Anchors: ` +
        `${G6_ANCHORS.join(', ')}`
      );
    }
  }
  const exemptPolicy = kinds.get(G6_EXEMPT_ANCHOR)?.kind;
  if (exemptPolicy !== 'EXEMPT') {
    return (
      `[G6/anchors] the manifest policy for \`${G6_EXEMPT_ANCHOR}\` is not EXEMPT (got ` +
      `${JSON.stringify(exemptPolicy)}). ADR-0179 D6 pins it as dev telemetry that deliberately ` +
      'STAYS under the guest identity — M22\u2019s cascade erases it. It is also the one row of D6 ' +
      'that no brainstormer enumerated by memory, which is the whole reason this manifest is ' +
      'gated mechanically rather than maintained by hand, so its policy is asserted by value here'
    );
  }
  for (const key of G6_REKEY_ANCHORS) {
    const kind = kinds.get(key)?.kind;
    if (kind !== 'REKEY') {
      return (
        `[G6/anchors] the manifest policy for \`${key}\` is ${JSON.stringify(kind)}, not REKEY. ` +
        'ADR-0179 D6 re-keys this column through rekey_all, so demoting it to BLOCKED or EXEMPT ' +
        'is the reverse of the lie rb-2 closed: a well-formed entry that G6/policy cannot see, ' +
        'which silently drops the column out of the consumption scan while its rows orphan on ' +
        'every successful claim'
      );
    }
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

  for (const [key, policy] of kinds) {
    if (policy.kind !== 'REKEY') continue;
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
// PROOF-OF-TEETH FIXTURES (FG1-FG73) — inline sources, run BEFORE the live-tree
// checks. Returns the first tooth failure (string) or null.
//
// The Rust fixtures below are STRING LITERALS in a .mjs file; the live scan
// globs server-module/src/**/*.rs only, so they can never be picked up as real
// source. Fixtures that contain backslashes use String.raw so the Rust text
// reaches the checker byte-for-byte.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The T9 CO-SCAN TWIN (fixture FG70).
//
// accounts_tests.rs:3313-3433 reads THIS file as TEXT — it is the only thing
// tying the JS re-key manifest to the Rust data-lifecycle manifest — and it does
// so with a scanner that is deliberately naive in four ways: it blanks
// slash-slash-to-end-of-line comments (inside string literals too), it takes the
// FIRST `REKEY_MANIFEST = freezeManifest(...)` anchor, it brace-walks counting
// EVERY brace byte (inside strings too), and its single-quote span walk has NO
// escape handling, so one backslash-quote swallows every key up to the next
// quote. Its only guard is a 20-key floor, so all four failure modes degrade
// SILENTLY while the Rust test stays green.
//
// Re-implemented here byte-for-byte so that a manifest edit which blinds the
// Rust scan reds in JS, loudly, in the same run that introduces it. It is
// deliberately NOT hardened: it must stay exactly as blind as the Rust one,
// which is what FG70b proves.
//
// The anchor is spelled in two halves so this twin's own source cannot add a
// SECOND occurrence of it to the file (accounts_tests.rs:3368 uses concat! for
// the same reason).
// ---------------------------------------------------------------------------
const T9_ANCHOR = 'REKEY_MAN' + 'IFEST = freezeManifest({';
const T9_QUOTE = String.fromCharCode(0x27);

/**
 * Is `s` shaped like a `table.column` manifest key? Twin of
 * accounts_tests.rs:3339 `m22_is_table_column_key`.
 * @param {string} s Candidate span.
 * @returns {boolean} True for exactly one dot with a non-empty side on each end.
 */
function t9IsColumnKey(s) {
  let dots = 0;
  for (const ch of s) {
    if (ch === '.') {
      dots++;
      continue;
    }
    if (!isWordChar(ch)) return false;
  }
  if (dots !== 1) return false;
  const dot = s.indexOf('.');
  return dot > 0 && dot < s.length - 1;
}

/**
 * Every `'table.column':` key the Rust T9 scan reads out of `src`, in source
 * order and WITHOUT de-duplication (a duplicated key must be visible as a
 * length mismatch against `Object.keys`, not silently collapsed).
 * @param {string} src Raw JS source.
 * @returns {string[]|null} The raw key list, or null when the block is unreadable.
 */
function t9TwinKeys(src) {
  const kept = [];
  let inComment = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') {
      inComment = false;
      kept.push('\n');
      continue;
    }
    if (!inComment && ch === '/' && src[i + 1] === '/') {
      inComment = true;
      i++;
      continue;
    }
    if (!inComment) kept.push(ch);
  }
  const stripped = kept.join('');

  const at = stripped.indexOf(T9_ANCHOR);
  if (at === -1) return null;
  const open = at + T9_ANCHOR.length - 1;
  if (stripped[open] !== '{') return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end <= open) return null;

  const block = stripped.slice(open, end);
  const keys = [];
  let k = 0;
  while (k < block.length) {
    if (block[k] !== T9_QUOTE) {
      k++;
      continue;
    }
    let j = k + 1;
    while (j < block.length && block[j] !== T9_QUOTE) j++;
    if (j >= block.length) break;
    const span = block.slice(k + 1, j);
    const after = j + 1 < block.length ? block[j + 1] : ' ';
    if (after === ':' && t9IsColumnKey(span)) keys.push(span);
    k = j + 1;
  }
  return keys;
}

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
        || crate::monster_mgmt::monster_rows_present(ctx, identity)
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
        log_reject("client_connected", ctx.sender(), REJECT_UNRECOGNIZED_ISSUER);
        return Ok(());
    }
    if !audience_allowed(claims.audience(), ALLOWED_AUDIENCE) {
        log_reject("client_connected", ctx.sender(), REJECT_UNRECOGNIZED_AUDIENCE);
        return Err(REJECT_UNRECOGNIZED_AUDIENCE.to_string());
    }
    let now = now_ms(ctx);
    match ctx.db.account().identity().find(ctx.sender()) {
        Some(existing) => {
            ctx.db
                .account()
                .identity()
                .update(touch_login(existing, now));
        }
        None => {
            ctx.db
                .account()
                .insert(new_account_row(ctx.sender(), issuer.to_string(), now));
        }
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn start_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let me = ctx.sender();
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
    let me = ctx.sender();
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
    let me = ctx.sender();
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
    let me = ctx.sender();
    let Some(account) = ctx.db.account().identity().find(me) else {
        return reject("cancel_account_deletion", me, "no account");
    };
    ctx.db
        .account()
        .identity()
        .update(cancelled_deletion(account));
    Ok(())
}

#[spacetimedb::table(accessor = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
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
    if ctx.sender() != ctx.database_identity() {
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
    ctx.db.player().identity().delete(ctx.sender());
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
    rekey_all(ctx, target.guest_identity, ctx.sender())
}
`;

// E2, verbatim from the red-team PoC (compiles; clippy-clean).
const E2_FROM_HEX_REDUCER = `
#[spacetimedb::reducer]
pub fn adopt_guest(ctx: &ReducerContext, guest_hex: String) -> Result<(), String> {
    let g = Identity::from_hex(&guest_hex).map_err(|_| "bad hex".to_string())?;
    rekey_all(ctx, g, ctx.sender())
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

// ---------------------------------------------------------------------------
// THE SHARED RE-KEY HELPER LIBRARY the manifest needles name (rb-25). Emitted as
// the tail of every synthesized schema fixture, because a clause that RESOLVES a
// needle to a fn definition has nothing to resolve against a tree that declares
// only table structs — every GOOD control would red.
//
// HAND-WRITTEN, never derived from REKEY_MANIFEST. A generated library satisfies
// whatever the manifest happens to say, which makes every control below
// tautological: the join it is supposed to prove would be true by construction.
//
// Each body mirrors the TABLE ACCESS of its shipped twin
// (server-module/src/{monster_mgmt,inventory,npc,raising,economy,ranking}.rs),
// including the one asymmetry that forces the mirror exception to exist:
// `rekey_monsters` writes BOTH `monster` and `monster_pub`, while `has_monsters`
// reads `monster` ALONE — the public projection carries no row the private table
// does not, so the existence predicate never needs to look at it.
//
// EXACTLY ONE definition per fn name: two manifest keys share `has_monsters(`
// and two share `has_quest_or_dialogue_state(`, and a duplicate definition is
// itself a fail-closed condition. AUTHORING CONSTRAINT for later fixtures: a
// tree that both concatenates GOOD_TREE[0].src into a file AND lists GOOD_TREE[0]
// in the same array declares every fn here twice.
//
// `monster_rows_present` is the deliberate SPARE: a second, legal
// monster-existence predicate that `account_has_game_data` also calls, so the
// mirror same-needle clause has something to be wrongly re-pointed at.
// ---------------------------------------------------------------------------
const GOOD_HELPERS = `
pub(crate) fn rekey_monsters(ctx: &ReducerContext, from: Identity, to: Identity) -> Result<(), String> {
    let ids: Vec<u64> = ctx.db.monster().owner_identity().filter(from).map(|m| m.monster_id).collect();
    for id in ids {
        let Some(mut m) = ctx.db.monster().monster_id().find(id) else { continue; };
        let Some(twin) = ctx.db.monster_pub().monster_id().find(id) else { continue; };
        m.owner_identity = to;
        let pub_row = pub_from_monster(&m, twin.tier);
        ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(pub_row);
    }
    Ok(())
}

pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.monster().owner_identity().filter(owner).next().is_some()
}

pub(crate) fn monster_rows_present(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.monster().owner_identity().filter(owner).count() > 0
}

pub(crate) fn rekey_inventory(ctx: &ReducerContext, from: Identity, to: Identity) {
    let ids: Vec<u64> = ctx.db.inventory().owner_identity().filter(from).map(|r| r.inv_id).collect();
    for id in ids {
        if let Some(mut row) = ctx.db.inventory().inv_id().find(id) {
            row.owner_identity = to;
            ctx.db.inventory().inv_id().update(row);
        }
    }
}

pub(crate) fn has_items(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.inventory().owner_identity().filter(owner).next().is_some()
}

pub(crate) fn rekey_npc_state(ctx: &ReducerContext, from: Identity, to: Identity) {
    let pq_ids: Vec<u64> = ctx.db.player_quest().owner_identity().filter(from).map(|q| q.pq_id).collect();
    for id in pq_ids {
        if let Some(mut q) = ctx.db.player_quest().pq_id().find(id) {
            q.owner_identity = to;
            ctx.db.player_quest().pq_id().update(q);
        }
    }
    if let Some(row) = ctx.db.player_dialogue_state().owner_identity().find(from) {
        ctx.db.player_dialogue_state().owner_identity().delete(from);
        ctx.db.player_dialogue_state().insert(carried_dialogue_state(row, to));
    }
}

pub(crate) fn has_quest_or_dialogue_state(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.player_quest().owner_identity().filter(owner).next().is_some()
        || ctx.db.player_dialogue_state().owner_identity().find(owner).is_some()
}

pub(crate) fn rekey_heal_cooldown(ctx: &ReducerContext, from: Identity, to: Identity) {
    if let Some(row) = ctx.db.heal_cooldown().owner_identity().find(from) {
        ctx.db.heal_cooldown().owner_identity().delete(from);
        ctx.db.heal_cooldown().insert(carried_cooldown(row, to));
    }
}

pub(crate) fn has_heal_cooldown(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.heal_cooldown().owner_identity().find(owner).is_some()
}

pub(crate) fn rekey_wallet(ctx: &ReducerContext, from: Identity, to: Identity) {
    if let Some(row) = ctx.db.player_wallet().owner_identity().find(from) {
        grant_currency(ctx, to, row.balance);
        ctx.db.player_wallet().owner_identity().update(zeroed_wallet(row));
    }
}

pub(crate) fn wallet_exists(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.player_wallet().owner_identity().find(owner).is_some()
}

pub(crate) fn rekey_profile(ctx: &ReducerContext, from: Identity, to: Identity) {
    let guest = match ctx.db.profile().identity().find(from) {
        Some(g) => g,
        None => return,
    };
    let dest = get_or_init_profile(ctx, to);
    ctx.db.profile().identity().update(carried_stats(dest, guest.rating));
    ctx.db.profile().identity().update(tombstoned(guest));
}

pub(crate) fn profile_exists(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.profile().identity().find(identity).is_some()
}
`;

/**
 * Build a schema stand-in declaring exactly the given "table.field" columns as
 * Identity columns, one `#[spacetimedb::table(...)] pub struct` per table, AND
 * — appended after the last struct — the shared re-key helper library
 * (GOOD_HELPERS above) that the manifest's `rekey` / `exists` needles resolve
 * to. Both halves are part of the GOOD fixture: without the library a tree
 * declaring only table structs names no helper at all, so a clause that resolves
 * a needle to a fn DEFINITION has nothing to read and reds every control here.
 * The library is emitted from inside this function rather than spliced into
 * GOOD_TREE[0] because several fixtures call synthSchemaSrc directly and would
 * otherwise inherit a tree with no helpers.
 * Deriving the GOOD tree's COLUMNS from the manifest keeps the fixture readable
 * (the helper bodies are hand-written for the opposite reason — see above); the
 * teeth come from the BAD mutations below and from the LIVE tree scan, which is
 * the only genuinely independent bidirectional test.
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
    out += `#[spacetimedb::table(accessor = ${table})]\npub struct Row_${table} {\n`;
    for (const field of fields) {
      // `claimed_from` is the one Option<Identity> column in the live schema —
      // spelled that way here so the Option path is genuinely exercised.
      const type = field === 'claimed_from' ? 'Option<Identity>' : 'Identity';
      out += `    pub ${field}: ${type},\n`;
    }
    out += '    pub note: String,\n}\n\n';
  }
  return out + GOOD_HELPERS;
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
#[spacetimedb::table(accessor = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
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
  // the `ctx.sender() != ctx.database_identity()` guard) must PASS.
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
      `    if ctx.sender() != ctx.database_identity() {
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
    rekey_all(ctx, claim.guest_identity, ctx.sender())
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

  // FG74a (ADR-0010 proof-of-teeth, THE RESIDUAL'S OWN CRITERION, R-m22-s1-X1)
  // — the M22-S3-shaped source: GOOD_ACCOUNTS plus the `account_deletion_reaper`
  // scheduled table/reducer pair, carrying the SAME scheduler-guard shape as
  // the shipped `guest_claim_reaper`. Must PASS post-fix. The pre-fix
  // exact-set-equality classifier is recomputed INLINE below, on every run
  // (never asserted once at authoring time), against this SAME source, and
  // must RED — so the fixture can never decay into a shape that passes either
  // way. Self-checks first, because this fixture is built by CONCATENATION so
  // `mut()`'s throw-on-missing protection does not apply.
  // Kills: reverting [R/name-set] to exact-set equality over REQUIRED names
  // (the residual this whole slice exists to fix — mutant M1/"prefix"), and a
  // bare zero-parameter `account_deletion_reaper` stub that would satisfy a
  // weaker self-check but prove nothing about the scheduler guard.
  {
    const s3Src =
      GOOD_ACCOUNTS +
      `
#[spacetimedb::table(accessor = account_deletion_reaper_schedule, scheduled(account_deletion_reaper))]
pub struct AccountDeletionReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub target_identity: Identity,
}

#[spacetimedb::reducer]
pub fn account_deletion_reaper(
    ctx: &ReducerContext,
    args: AccountDeletionReaperSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("account_deletion_reaper is scheduler-only".to_string());
    }
    ctx.db.account().identity().delete(args.target_identity);
    Ok(())
}
`;

    const parsedCount = parseReducers(stripRustSource(s3Src)).length;
    if (parsedCount !== 6) {
      return (
        'FG74a self-check: expected exactly 6 reducers parsed out of the S3-shaped fixture (the ' +
        `5 shipped plus account_deletion_reaper), got ${parsedCount} — the concatenation did not ` +
        'land as intended, so this fixture would prove nothing about the residual'
      );
    }
    if (compactWs(stripRustSource(s3Src)).indexOf(SCHEDULER_GUARD) === -1) {
      return (
        'FG74a self-check: the scheduler-guard needle is missing from the built S3-shaped fixture ' +
        'text — a bare zero-parameter account_deletion_reaper stub was measured to yield the ' +
        'identical PASS verdict, so without this check the fixture proves less than its prose claims'
      );
    }

    const err = checkNoClientIdentity(s3Src);
    if (err) {
      return (
        'FG74a: the legitimately-declared, pre-reviewed account_deletion_reaper (table + reducer + ' +
        `scheduler guard) was incorrectly flagged on a tree that still carries its five REQUIRED ` +
        `reducers: ${err}`
      );
    }

    const requiredNames = Object.keys(REDUCER_SANCTIONS)
      .filter((n) => REDUCER_SANCTIONS[n].status === 'REQUIRED')
      .sort();
    const parsedNames = parseReducers(stripRustSource(s3Src))
      .map((r) => r.name)
      .sort();
    const preFixSameSet =
      parsedNames.length === requiredNames.length &&
      parsedNames.every((n, k) => n === requiredNames[k]);
    if (preFixSameSet) {
      return (
        'FG74a RED-control decayed: the pre-fix exact-set-equality classifier (sorted parsed names ' +
        '=== sorted REQUIRED names) ALSO passes the S3-shaped fixture, so this fixture no longer ' +
        "proves the residual's own criterion — the gate must RED before the fix and PASS after, and " +
        'a fixture that passes either way proves nothing'
      );
    }
  }

  // FG74b — an UNDECLARED name smuggled into the PLANNED category (here:
  // `adopt_guest`, FG15's attack reducer name) with status PLANNED. The
  // permissive category is supposed to be bounded to exactly one
  // conscious-in-this-file entry.
  // Kills: [R/planned-set] accepting ANY superset of the sanctioned PLANNED
  // set (mutant "delete the [R/planned-set] call", which neuters the check
  // into always-PASS and is caught here because this fixture drives the
  // function directly).
  {
    const ledger = {
      ...REDUCER_SANCTIONS,
      adopt_guest: { status: 'PLANNED', why: 'forged for FG74b' },
    };
    const bad = expectTag(assertPlannedSet(ledger), '[R/planned-set]', 'FG74b');
    if (bad) return bad;
  }

  // FG74c — the REQUIRED-to-PLANNED demotion attack: `delete_account` is
  // silently un-required. The old flat array had no way to express "optional"
  // at all, so it had no way to catch a shipped entry point being quietly
  // downgraded either.
  // Kills: [R/planned-set] treating the PLANNED set as append-only / growing
  // it by any means other than a conscious, separately-reviewed edit here.
  {
    const ledger = {
      ...REDUCER_SANCTIONS,
      delete_account: { status: 'PLANNED', why: 'forged demotion for FG74c' },
    };
    const bad = expectTag(assertPlannedSet(ledger), '[R/planned-set]', 'FG74c');
    if (bad) return bad;
  }

  // FG74d — GOOD: the shipped ledger's PLANNED set is EXACTLY
  // ['account_deletion_reaper'] today, before S3 ships. Non-vacuity control:
  // kills an always-red [R/planned-set], which would otherwise be
  // indistinguishable from a working one.
  {
    const err = assertPlannedSet(REDUCER_SANCTIONS);
    if (err) return `FG74d: the shipped ledger's PLANNED set was incorrectly flagged: ${err}`;
  }

  // FG74e — a ONE-SIDED subset check (found PLANNED keys subset-of expected,
  // with no reverse direction) is trivially satisfied by an EMPTY PLANNED set
  // and by a ledger with no PLANNED entries at all. Both sub-cases must RED.
  // Kills: mutant "[R/planned-set] relaxed to a one-sided subset".
  {
    const bad1 = expectTag(assertPlannedSet({}), '[R/planned-set]', 'FG74e-empty');
    if (bad1) return bad1;

    const noPlanned = {
      account_deletion_reaper: { status: 'REQUIRED', why: 'forged for FG74e' },
    };
    const bad2 = expectTag(assertPlannedSet(noPlanned), '[R/planned-set]', 'FG74e-norequired');
    if (bad2) return bad2;
  }

  // FG74f — `guest_claim_reaper` (REQUIRED) is renamed to `account_deletion_reaper`
  // (the one PLANNED name), moving the `scheduled(...)` target along with it so
  // [R/param-types]'s carve-out still applies and [R/name-set] is the first
  // clause that can fire. The NEW name IS a ledger key (own property), so a
  // membership-only checker is silent here — REQUIRED's own entry (and its
  // client entry point) disappeared all the same.
  // Kills: mutant "drop the REQUIRED-present half of [R/name-set]" — the
  // ownership half alone would wrongly call this source sanctioned.
  {
    let src = mut(
      GOOD_ACCOUNTS,
      'scheduled(guest_claim_reaper)',
      'scheduled(account_deletion_reaper)',
    );
    src = mut(src, 'pub fn guest_claim_reaper(', 'pub fn account_deletion_reaper(');
    const bad = expectTag(checkNoClientIdentity(src), '[R/name-set]', 'FG74f');
    if (bad) return bad;
  }

  // FG74g — THE MEASURED BYPASS (ADR-0210). A ledger entry with a THIRD status
  // string is admitted by membership (it is an own key), never demanded
  // (it is not REQUIRED) and invisible to [R/planned-set] (it is not
  // PLANNED) — a free, silent, optional whitelist slot for a wire-safe,
  // constructor-free takeover reducer of the same name
  // (`migrate_legacy_account`, ADR-0210's worked example). Deliberately a
  // THIRD status, not REQUIRED or PLANNED, so this fixture is not redundant
  // with FG74b/c/e.
  // Kills: deleting [R/sanction-shape] outright, and "status compared with
  // `!==` against only 'REQUIRED'" (a third status silently treated as fine).
  {
    const ledger = {
      ...REDUCER_SANCTIONS,
      migrate_legacy_account: {
        status: 'LEGACY',
        why: 'kept for back-compat, not client-facing',
      },
    };
    const bad = expectTag(assertSanctionShape(ledger), '[R/sanction-shape]', 'FG74g');
    if (bad) return bad;
  }

  // FG74h — [R/sanction-shape] must RED on every OTHER malformed entry shape,
  // not only an open third status: a non-object entry, a missing `status`, a
  // non-string `status`, an unknown extra field, and a `status` reachable
  // ONLY through the prototype chain (the injected entry owns NOTHING — same
  // device as FG72d's inherited-policy fixture).
  // Kills: a classifier that trusts `typeof` on the entry, or that reads
  // `.status` without first confirming the entry OWNS it.
  {
    const notObject = { ...REDUCER_SANCTIONS, not_an_object: 'REQUIRED' };
    const bad1 = expectTag(assertSanctionShape(notObject), '[R/sanction-shape]', 'FG74h-notobject');
    if (bad1) return bad1;

    const missingStatus = {
      ...REDUCER_SANCTIONS,
      no_status: { why: 'no status field at all' },
    };
    const bad2 = expectTag(
      assertSanctionShape(missingStatus),
      '[R/sanction-shape]',
      'FG74h-missing',
    );
    if (bad2) return bad2;

    const numericStatus = {
      ...REDUCER_SANCTIONS,
      numeric_status: { status: 1, why: 'status is a number, not a string' },
    };
    const bad3 = expectTag(
      assertSanctionShape(numericStatus),
      '[R/sanction-shape]',
      'FG74h-numeric',
    );
    if (bad3) return bad3;

    const extraField = {
      ...REDUCER_SANCTIONS,
      extra_field: { status: 'REQUIRED', why: 'ok', deletion_policy: 'soft' },
    };
    const bad4 = expectTag(
      assertSanctionShape(extraField),
      '[R/sanction-shape]',
      'FG74h-extrafield',
    );
    if (bad4) return bad4;

    const viaProto = Object.create({ status: 'REQUIRED', why: 'inherited, never owned' });
    if (Object.keys(viaProto).length !== 0 || viaProto.status !== 'REQUIRED') {
      return (
        'FG74h-proto: the fixture is broken — the injected entry must own NOTHING and inherit a ' +
        `well-formed status (own fields: [${Object.keys(viaProto).join(', ')}], status resolved ` +
        `through the chain: ${JSON.stringify(viaProto.status)})`
      );
    }
    const protoLedger = { ...REDUCER_SANCTIONS, proto_only: viaProto };
    const bad5 = expectTag(assertSanctionShape(protoLedger), '[R/sanction-shape]', 'FG74h-proto');
    if (bad5) return bad5;
  }

  // FG74j — a reducer literally named `constructor`, wire-safe, no Identity
  // parameter and no Identity constructor call — the only thing wrong with it
  // is that it is not in the ledger.
  // Kills: `[R/name-set]` implemented as `if (LEDGER[name])` or any other
  // prototype-chain-reachable lookup. `LEDGER.constructor` resolves to
  // `Object`'s constructor function (truthy) for EVERY plain object, so a
  // naive membership test admits the name with zero ledger entry for it.
  {
    const src =
      GOOD_ACCOUNTS +
      `
#[spacetimedb::reducer]
pub fn constructor(ctx: &ReducerContext) -> Result<(), String> {
    Ok(())
}
`;
    const bad = expectTag(checkNoClientIdentity(src), '[R/name-set]', 'FG74j');
    if (bad) return bad;
  }

  // FG74k — THE MEASURED WEAKENING (red-team, this slice; ADR-0210). A reducer
  // that merely REUSES the PLANNED ledger name while having NONE of the shape
  // that name was admitted for: no scheduled table, a wire-safe `String`
  // argument, and the victim identity read out of an EXISTING ROW rather than
  // constructed. It is FG15's `adopt_guest_by_code` body under a sanctioned
  // name. MEASURED: before [R/planned-shape] it returned PASS here while the
  // pre-fix exact-set pin RED it — a real regression, not a hypothetical.
  // Kills: admitting a PLANNED name on the NAME alone; and the belief that
  // [R/param-types]'s scheduled carve-out already covers this (it is reached
  // only after `isWireSafeType` FAILS, so a wire-safe impostor never arrives).
  {
    const src =
      GOOD_ACCOUNTS +
      `
#[spacetimedb::reducer]
pub fn account_deletion_reaper(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let claim = ctx.db.guest_claim().code().find(&code).ok_or("no")?;
    rekey_all(ctx, claim.guest_identity, ctx.sender())
}
`;
    if (parseReducers(stripRustSource(src)).length !== 6) {
      return 'FG74k self-check: the impostor reducer did not parse, so this fixture proves nothing';
    }
    const bad = expectTag(checkNoClientIdentity(src), '[R/planned-shape]', 'FG74k');
    if (bad) return bad;
  }

  // FG74l — the BARE STUB: the PLANNED name declared with NO arguments at all
  // and no scheduled table. [R/param-types] iterates the parameter list, so a
  // reducer with no parameters is silent to it entirely; the red-team measured
  // that this stub yields the IDENTICAL verdict to the real S3 shape under a
  // name-only admission rule. Only the arity/struct half of [R/planned-shape]
  // sees it.
  // Kills: an [R/planned-shape] that checks only the scheduler guard, or that
  // treats "no parameters" as trivially well-shaped.
  // (The scheduled-struct-WITHOUT-guard spelling is deliberately NOT re-tested
  // here: [R/param-types] owns it and fires first, as FG12 already pins. The
  // guard half of [R/planned-shape] is defence in depth behind that clause.)
  {
    const src =
      GOOD_ACCOUNTS +
      `
#[spacetimedb::reducer]
pub fn account_deletion_reaper(ctx: &ReducerContext) -> Result<(), String> {
    Ok(())
}
`;
    const bad = expectTag(checkNoClientIdentity(src), '[R/planned-shape]', 'FG74l');
    if (bad) return bad;
  }

  // FG74m — an entry whose `why` is blank or is not a string. A ledger entry
  // with no justification is an unreviewed one, and the closed field set alone
  // cannot see it: {status, why} is satisfied by `why: ''` and by `why: 42`.
  {
    const blank = { ...REDUCER_SANCTIONS, blank_why: { status: 'REQUIRED', why: '   ' } };
    const bad1 = expectTag(assertSanctionShape(blank), '[R/sanction-shape]', 'FG74m-blank');
    if (bad1) return bad1;

    const numeric = { ...REDUCER_SANCTIONS, numeric_why: { status: 'PLANNED', why: 42 } };
    const bad2 = expectTag(assertSanctionShape(numeric), '[R/sanction-shape]', 'FG74m-numeric');
    if (bad2) return bad2;
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
        log_reject("client_connected", ctx.sender(), REJECT_UNRECOGNIZED_ISSUER);
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
        log_reject("client_connected", ctx.sender(), REJECT_UNRECOGNIZED_AUDIENCE);
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
        .insert(new_account_row(ctx.sender(), issuer.to_string(), now_ms(ctx)));
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
          `#[spacetimedb::table(accessor = guild_member)]
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
      'playtest_event.identity': {
        policy: 'REKEY',
        rekey: 'rekey_monsters(',
        exists: 'has_monsters(',
      },
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
  // CONTAINS `ctx.sender() != ctx.database_identity()`, but only as an audit-only binding
  // that rejects nobody. Any client can then invoke the scheduled reducer with a
  // hand-built row naming any victim identity — the exact client-supplied
  // Identity hole the carve-out assumes is closed.
  // Kills: a carve-out that substring-matches the comparison instead of pinning
  // it as a rejecting early return.
  {
    const src = mut(
      GOOD_ACCOUNTS,
      `    if ctx.sender() != ctx.database_identity() {
        return Err("guest_claim_reaper is scheduler-only".to_string());
    }
`,
      `    let scheduler_only = ctx.sender() != ctx.database_identity();
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
          `#[spacetimedb::table(accessor = guild_member, index(btree, accessor = by_owner, columns = [owner_identity, guild_id]))]
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

  // FG60 — a BLOCKED entry that ALSO carries a pair of REKEY needles.
  // Kills: a classifier that infers the policy from needle PRESENCE
  // (`'rekey' in entry`, `Boolean(entry.rekey)`), and any OPEN entry shape that
  // lets an explicit `policy` and a contradicting pair of needles coexist — the
  // manifest would then say two different things and the reader would believe
  // the wrong one.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'player.identity': {
        policy: 'BLOCKED',
        reason: 'a guard rejects the claim while such a row exists',
        rekey: 'rekey_monsters(',
        exists: 'has_monsters(',
      },
    };
    const bad = expectTag(
      checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
      '[G6/policy]',
      'FG60',
    );
    if (bad) return bad;
  }

  // FG61 — GOOD: the residual's own repro, as the control this slice exists for.
  // A well-formed BLOCKED entry (a reason, no needles) must PASS.
  // Kills: a checker that reads `.rekey`/`.exists` off EVERY object entry — the
  // undefined needles are then coerced to the literal 'undefined', miss both
  // bodies, and red [G6/consumed] on a perfectly legal BLOCKED row. Deliberately
  // manifest-TEXT-independent: it survives any future re-wording of the shipped
  // reasons, so it can never be quietly "fixed" by editing the manifest.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'battle.player_identity': { policy: 'BLOCKED', reason: 'terminal rows survive' },
    };
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    if (err) return `FG61: a well-formed BLOCKED entry was incorrectly flagged: ${err}`;
  }

  // FG62 — REKEY entries whose needles are missing, degenerate, EMPTY or blank.
  // Kills: (a) silently skipping a needle-less REKEY entry, and the
  // `indexOf(undefined)` coercion that reds it under the WRONG tag; (b) a needle
  // that is present in every fn body ever written (`ctx`), which makes the
  // substring test pass for a helper nobody calls; (c) the MEASURED guard-11
  // fail-open — `body.indexOf('') === 0`, so an EMPTY needle reads as consumed;
  // (d) MEASURED: a classifier that applies the needle rule to `exists` ONLY —
  // (b) and (c) BOTH degrade `exists`, so a one-sided rule passed them both.
  // (d) degrades `rekey` alone and leaves a perfectly good `exists` behind;
  // (e) a WHITESPACE-only needle, which clears a `!== ''` emptiness test and
  // then cannot match anything, because both bodies are whitespace-COMPACTED.
  {
    const cases = [
      { label: 'FG62a', entry: { policy: 'REKEY' } },
      { label: 'FG62b', entry: { policy: 'REKEY', rekey: 'ctx', exists: 'ctx' } },
      { label: 'FG62c', entry: { policy: 'REKEY', rekey: 'rekey_profile(', exists: '' } },
      { label: 'FG62d', entry: { policy: 'REKEY', rekey: 'ctx', exists: 'profile_exists(' } },
      { label: 'FG62e', entry: { policy: 'REKEY', rekey: 'rekey_profile(', exists: '   ' } },
    ];
    for (const probe of cases) {
      const manifest = { ...REKEY_MANIFEST, 'profile.identity': probe.entry };
      const bad = expectTag(
        checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
        '[G6/policy]',
        probe.label,
      );
      if (bad) return bad;
    }
  }

  // FG63 — the legacy STRING form, which the objects-only shape retires.
  // Kills: a dual-form classifier (parsing the `BLOCKED: ` prefix IS the same
  // implicit inference this slice removes), an else-branch that treats any
  // non-object as BLOCKED, and with them the whole `'BLOKED: '` typo class — a
  // one-letter slip that would silently un-police a column while every other
  // clause stayed green.
  {
    const manifest = { ...REKEY_MANIFEST, 'player.identity': 'BLOCKED: legacy string form' };
    const bad = expectTag(
      checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
      '[G6/policy]',
      'FG63',
    );
    if (bad) return bad;
  }

  // FG64 — `policy` values that are NOT exactly one of the three kinds.
  // Kills: a case-insensitive compare (a), a `startsWith('REKEY')` prefix test
  // (b), and a `switch` with a silent default.
  // PINS (deliberately weaker than "kills"): 'constructor' (c) and '__proto__'
  // (d) must be UNKNOWN policy values. Under a `.find` over a shape array — or a
  // Map — they already land in [G6/policy] for free, so these two are a
  // REGRESSION PIN against a future rewrite to a plain-object policy lookup,
  // not evidence that today's classifier had to do anything to be prototype-safe.
  {
    const cases = [
      { label: 'FG64a', entry: { policy: 'Blocked', reason: 'wrong case' } },
      {
        label: 'FG64b',
        entry: { policy: 'REKEYED', rekey: 'rekey_monsters(', exists: 'has_monsters(' },
      },
      { label: 'FG64c', entry: { policy: 'constructor', reason: 'prototype reach' } },
      { label: 'FG64d', entry: { policy: '__proto__', reason: 'prototype reach' } },
    ];
    for (const probe of cases) {
      const manifest = { ...REKEY_MANIFEST, 'player.identity': probe.entry };
      const bad = expectTag(
        checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
        '[G6/policy]',
        probe.label,
      );
      if (bad) return bad;
    }
  }

  // FG65 — a MISSING `policy` field (a) and a present-but-undefined one (b).
  // Kills: `entry.policy ?? infer(entry)`, the `entry.policy` fallback to
  // 'BLOCKED', and any else-branch that defaults an unclassified entry to
  // BLOCKED. The safest-LOOKING default is the dangerous one: it reports "a
  // guard covers this" about a column nobody ever classified.
  {
    const cases = [
      { label: 'FG65a', entry: { reason: 'no policy field' } },
      { label: 'FG65b', entry: { policy: undefined, reason: 'undefined policy' } },
    ];
    for (const probe of cases) {
      const manifest = { ...REKEY_MANIFEST, 'player.identity': probe.entry };
      const bad = expectTag(
        checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
        '[G6/policy]',
        probe.label,
      );
      if (bad) return bad;
    }
  }

  // FG66 — the REVERSE lie: every REKEY column in turn demoted to a WELL-FORMED
  // BLOCKED entry. The shape is legal, so [G6/policy] cannot see it, and a
  // demotion dodges [G6/consumed] entirely (that clause walks REKEY entries
  // only), so the rows silently orphan on every successful claim.
  // Kills: presence-only anchors, and a G6_REKEY_ANCHORS list that covers fewer
  // REKEY columns than the manifest ships. The list below is transcribed here
  // INDEPENDENTLY of the checker's own — a shared const could be emptied on both
  // sides at once — and the guard after it asserts that this hand-written list
  // COVERS the shipped REKEY set, so "eight" is a fact re-derived from the DATA
  // on every run rather than a number in a comment that ages badly.
  {
    const rekeyAnchors = [
      'monster.owner_identity',
      'monster_pub.owner_identity',
      'inventory.owner_identity',
      'player_quest.owner_identity',
      'player_dialogue_state.owner_identity',
      'heal_cooldown.owner_identity',
      'player_wallet.owner_identity',
      'profile.identity',
    ];
    // NON-CIRCULAR superset guard. It reads the shipped DATA (`.policy` on each
    // manifest entry), never the checker's G6_REKEY_ANCHORS — that const is what
    // this tooth exists to gate, so comparing against it would prove nothing. A
    // ninth REKEY column added without a matching name here would otherwise
    // leave the demotion loop silently short.
    for (const key of Object.keys(REKEY_MANIFEST)) {
      if (REKEY_MANIFEST[key].policy !== 'REKEY') continue;
      if (rekeyAnchors.indexOf(key) !== -1) continue;
      return (
        `FG66: the manifest classifies \`${key}\` as REKEY but this fixture's own demotion ` +
        'list does not name it, so the reverse-lie loop would never try to demote that column. ' +
        'Add it here AND to G6_REKEY_ANCHORS in the same PR'
      );
    }
    for (const key of rekeyAnchors) {
      const manifest = {
        ...REKEY_MANIFEST,
        [key]: { policy: 'BLOCKED', reason: 'nothing to carry' },
      };
      const bad = expectTag(
        checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
        '[G6/anchors]',
        `FG66/${key}`,
      );
      if (bad) return bad;
    }
  }

  // FG67 — non-object entries must produce a TAGGED RETURN, never a throw.
  // `typeof entry === 'object'` is TRUE for null and for an array, so a
  // classifier that trusts it dereferences null and the whole suite dies as
  // `TEETH threw: ...`, naming no key and no clause — a manifest typo would then
  // look like a broken eval rather than a broken manifest.
  // Kills: an object-ness test written as bare `typeof`, and any classifier that
  // signals a malformed entry by throwing instead of returning its tag.
  {
    const cases = [
      { label: 'FG67a', entry: null },
      { label: 'FG67b', entry: [] },
      { label: 'FG67c', entry: () => 'not an entry' },
      { label: 'FG67d', entry: 7 },
    ];
    for (const probe of cases) {
      const manifest = { ...REKEY_MANIFEST, 'player.identity': probe.entry };
      let err;
      try {
        err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
      } catch (e) {
        return (
          `${probe.label}: the checker THREW on a malformed entry instead of returning a ` +
          `tagged [G6/policy] failure: ${e?.message ?? String(e)}`
        );
      }
      const bad = expectTag(err, '[G6/policy]', probe.label);
      if (bad) return bad;
    }
  }

  // FG68 — an unjustified or self-contradicting reason, and an extra field.
  // Kills: (a) accepting an EMPTY reason — a BLOCKED row with no justification
  // is precisely the row no later reviewer re-derives; (b) the old prefix
  // smuggled back INSIDE the reason text, which is the second spelling of the
  // discriminator this slice abolished; (c) a REKEY entry carrying a `reason`,
  // i.e. the open shape that would let M22 S3's deletion_policy/basis/exportable
  // fields drift in ungated instead of through POLICY_SHAPES.
  {
    const cases = [
      { label: 'FG68a', entry: { policy: 'BLOCKED', reason: '' } },
      { label: 'FG68b', entry: { policy: 'BLOCKED', reason: 'EXEMPT: second spelling' } },
      {
        label: 'FG68c',
        entry: {
          policy: 'REKEY',
          rekey: 'rekey_monsters(',
          exists: 'has_monsters(',
          reason: 'extra field',
        },
      },
    ];
    for (const probe of cases) {
      const manifest = { ...REKEY_MANIFEST, 'player.identity': probe.entry };
      const bad = expectTag(
        checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
        '[G6/policy]',
        probe.label,
      );
      if (bad) return bad;
    }
  }

  // FG69 — TOTALITY, over every key and SEVEN defect shapes. Kills the cheats
  // that no single-key fixture can see:
  //   (1) a classifier that accepts ONLY the shipped entry objects — part 1
  //       re-runs the whole check over a fresh per-entry copy, so accepting an
  //       object by IDENTITY is not a substitute for validating its shape.
  //       HONEST LIMIT, stated because this tooth is easy to over-read:
  //       `{ ...entry }` is a ONE-LEVEL copy. It is total here only because the
  //       closed shape is FLAT (three string fields) — it is not a deep clone,
  //       and a classifier memoised on a DEEP-EQUAL comparison against the
  //       shipped data survives this tooth completely. That cheat is killed by
  //       the ledger's X3 DATA mutants (M6 / M7 / M9), which corrupt the shipped
  //       manifest itself, and by nothing in this file.
  //   (2) a classifier that only validates the handful of keys the fixtures
  //       above happen to name — part 2 defects EVERY key of the manifest.
  // Note the tag: a well-formed DEMOTION is [G6/anchors] (FG66's job); all seven
  // shapes here are MALFORMED, so [G6/policy] must fire first, for all 24 keys,
  // including the anchors themselves.
  // The ~7x24 checker calls are DELIBERATE: totality over the whole key set is
  // the point, and each call re-runs only the two small GOOD_TREE fixtures.
  {
    const copy = {};
    for (const key of Object.keys(REKEY_MANIFEST)) {
      copy[key] = { ...REKEY_MANIFEST[key] };
    }
    const copyErr = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, copy);
    if (copyErr) {
      return `FG69/copy: a per-entry copy of the shipped manifest was flagged: ${copyErr}`;
    }

    const shapes = [
      {
        name: 'blocked-with-needles',
        entry: {
          policy: 'BLOCKED',
          reason: 'x',
          rekey: 'rekey_monsters(',
          exists: 'has_monsters(',
        },
      },
      { name: 'rekey-without-needles', entry: { policy: 'REKEY' } },
      {
        name: 'rekey-empty-exists',
        entry: { policy: 'REKEY', rekey: 'rekey_monsters(', exists: '' },
      },
      {
        name: 'rekey-with-reason',
        entry: {
          policy: 'REKEY',
          rekey: 'rekey_monsters(',
          exists: 'has_monsters(',
          reason: 'x',
        },
      },
      { name: 'string-form', entry: 'BLOCKED: legacy string form' },
      // MEASURED: a classifier that checks "the required fields are present and
      // no BANNED cross-field is" passed all 120 cases above while M22 S3's
      // deletion_policy / basis / exportable drifted in green. The field set is
      // CLOSED, not a blocklist.
      {
        name: 'blocked-with-extra-field',
        entry: { policy: 'BLOCKED', reason: 'x', deletion_policy: 'ERASE' },
      },
      // MEASURED green: `reason !== ''` accepts three spaces, and a blank
      // justification is exactly the row no later reviewer re-derives. Only the
      // X8 fork byte-compare objected, and X8 does not run on injected manifests.
      { name: 'blocked-whitespace-reason', entry: { policy: 'BLOCKED', reason: '   ' } },
    ];
    for (const key of Object.keys(REKEY_MANIFEST)) {
      for (const shape of shapes) {
        const manifest = { ...REKEY_MANIFEST, [key]: shape.entry };
        const bad = expectTag(
          checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
          '[G6/policy]',
          `FG69/${key}/${shape.name}`,
        );
        if (bad) return bad;
      }
    }
  }

  // FG70 — the T9 CO-SCAN. accounts_tests.rs:3366 `m22_rekey_manifest_keys`
  // reads THIS FILE as TEXT with a naive, escape-blind scanner, and its only
  // guard is a `>= 20` key floor — so every way of blinding it degrades
  // SILENTLY, above the floor, with the Rust test still green.
  // Kills: a SECOND `freezeManifest(...)` anchor anywhere in the file (the Rust
  // scan takes the FIRST hit and never strips block comments); a `//`, `{` or
  // `}` inside any manifest string (the comment strip and the brace walk both
  // run inside string literals); a duplicated manifest key; and above all a
  // biome-emitted `\'` in a reason — MEASURED to truncate the Rust key list to
  // 22 of 24, which still clears the floor.
  {
    const raw = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const anchors = countOccurrences(raw, T9_ANCHOR);
    if (anchors !== 1) {
      return (
        `FG70: the byte string \`${T9_ANCHOR}\` occurs ${anchors} time(s) in the RAW text of ` +
        'this file; exactly one is required. This count is over RAW text and is deliberately ' +
        'STRICTER than the Rust twin, which strips slash-slash comments before it searches but ' +
        'does NOT strip block comments: a duplicate inside a LINE comment is invisible to Rust ' +
        'and harmless, while a duplicate inside a BLOCK comment (or in code) silently points ' +
        'accounts_tests.rs:3369 at the wrong object, because it takes the FIRST hit. One rule ' +
        'covers both without anyone having to reason about which kind of comment it landed in: ' +
        'spell it freezeManifest(...) in prose'
      );
    }
    const keys = t9TwinKeys(raw);
    if (keys === null) {
      return (
        'FG70: the T9 twin could not extract the manifest block (anchor missing, not landing on ' +
        'the opening brace, or not brace-balanced from it). The Rust twin would panic, or read ' +
        'an arbitrary suffix of this file instead of the manifest'
      );
    }
    const expected = Object.keys(REKEY_MANIFEST);
    if (keys.join(' ') !== expected.join(' ')) {
      // Counts are reported ONLY when they differ: on an ORDER or CONTENT
      // mismatch the old wording read "read 24 ... declares 24", which invites
      // the reader to conclude the tooth is broken rather than the manifest.
      const sizes =
        keys.length === expected.length
          ? 'both lists are the same LENGTH, so they differ in content or in ORDER'
          : `the twin read ${keys.length} key(s); this file declares ${expected.length}`;
      return (
        'FG70: the T9 text twin and the manifest object DISAGREE about this file. ' +
        `${sizes}.\n  Rust (text scan) sees: [${keys.join(', ')}]\n  this file declares: ` +
        `[${expected.join(', ')}]\nA key the text scan cannot see is a table the M22 ` +
        'cross-manifest proof never checks, and it fails SILENTLY above its 20-key floor'
      );
    }
  }

  // FG70b — POSITIVE CONTROL for FG70: the twin must stay exactly as ESCAPE-BLIND
  // as the Rust one. A twin quietly hardened to understand `\'` would report all
  // 24 keys for a manifest the Rust scan reads as 22 — FG70 would go green on
  // precisely the hazard it exists to catch, and the co-scan would be theatre.
  {
    const synth = [
      'const M = ',
      T9_ANCHOR,
      "\n  'alpha.one': 'a\\'b',\n  'beta.two': 'plain',\n  'gamma.three': 'plain',\n});\n",
    ].join('');
    const keys = t9TwinKeys(synth);
    if (keys === null) {
      return 'FG70b: the twin failed to read a well-formed synthetic manifest block at all';
    }
    if (keys.join(' ') !== 'alpha.one') {
      return (
        `FG70b: the T9 twin read [${keys.join(', ')}] from a THREE-key synthetic block whose ` +
        'first value carries a backslash-escaped apostrophe. It must lose every key after that ' +
        'escape, exactly as accounts_tests.rs:3409-3431 does; an escape-AWARE twin is blind to ' +
        'the biome hazard FG70 exists to detect'
      );
    }
  }

  // FG71 — the NINTH-REKEY hole. MEASURED: a [G6/consumed] clause that walks
  // `G6_REKEY_ANCHORS` instead of the CLASSIFIED REKEY set passed every other
  // tooth in this file, because today the eight REKEY columns ARE the eight
  // anchors — the two sets are accidentally equal, so nothing else here can tell
  // them apart. The day a ninth REKEY column is added, that clause stops
  // checking it and the column orphans on every successful claim.
  // Kills: iterating the anchor list (or any other hardcoded list) in the
  // consumption clause. This entry is a NON-anchor column promoted to a
  // well-formed REKEY entry whose helpers exist nowhere in accounts.rs: the
  // shape is legal so [G6/policy] cannot see it, and the key is not an anchor so
  // [G6/anchors] cannot see it either.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'player.identity': {
        policy: 'REKEY',
        rekey: 'rekey_player_rows(',
        exists: 'has_player_rows(',
      },
    };
    const bad = expectTag(
      checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest),
      '[G6/consumed]',
      'FG71',
    );
    if (bad) return bad;
  }

  // FG72 — THE OWN-PROPERTY BOUNDARY (rb-3, residual R-m22-s0-X2). Inside
  // checkRekeyCompleteness the manifest KEY SPACE is read exactly ONCE — by
  // classifyManifest, over Object.keys(manifest), into a Map — and every later
  // clause reads that derived Map. The COLUMN key space is read exactly once
  // too, by findIdentityColumns, into a second Map. BOTH sides of that join are
  // membership questions, and both must be asked with own-property semantics.
  // Until rb-2, [G6/declared] was literally `key in manifest`, which answers YES
  // for a key that exists only on the PROTOTYPE CHAIN: an inherited (or ambient)
  // policy silently satisfied the completeness check for a column nobody ever
  // classified, which is precisely the silent-orphan defect G6 exists to
  // prevent. rb-2 closed it INCIDENTALLY, as a side effect of introducing the
  // Map, and nothing pinned it. These six fixtures are that pin, from both
  // sides: an inherited key must be INVISIBLE to the key-space reads (a, c, f),
  // and merely being inherited must not by itself be an error (b; d is the
  // entry-side twin). FG72c additionally pins the COLUMNS side (round 2,
  // red-team F1): a membership test rebuilt over Object.fromEntries of the
  // column Map keeps every other gate in this file GREEN, and with one ambient
  // key per manifest column it passes G6 on an EMPTY tree.
  // FG72a/b/d/e/f are REGRESSION PINS — green before the rb-3 code change, red
  // under the ledger's X2 mutants. FG72c is RED before it.
  const GUILD_COL = 'guild_member.owner_identity';
  // FG48's table, re-declared here so that fixture stays untouched: an Identity
  // column the manifest does not classify, which [G6/declared] must report.
  const guildTree = [
    {
      path: 'fixture/schema.rs',
      src:
        GOOD_TREE[0].src +
        `#[spacetimedb::table(accessor = guild_member)]
pub struct GuildMember {
    pub owner_identity: Identity,
    pub guild_id: u64,
}
`,
    },
    GOOD_TREE[1],
  ];

  // FG72a — an INHERITED manifest entry must NOT satisfy the completeness
  // clause. Object.assign copies the shipped key set onto a fresh object whose
  // PROTOTYPE carries the guild column, and the tree really declares that
  // column, so the only question is which key space the checker reads.
  // Kills: `key in manifest`, `manifest[key] !== undefined`,
  // `kinds.has(key) || key in manifest`, and a classifyManifest that walks
  // `for (const key in manifest)` (which greens the clause one step earlier, by
  // classifying the inherited entry INTO the Map). Green before the fix.
  {
    const manifest = Object.assign(
      Object.create({
        [GUILD_COL]: { policy: 'EXEMPT', reason: 'inherited, never owned' },
      }),
      REKEY_MANIFEST,
    );
    if (!(GUILD_COL in manifest)) {
      return (
        `FG72a: the fixture is broken — \`${GUILD_COL}\` is not reachable on the injected ` +
        'manifest at all, so nothing here would exercise the prototype chain'
      );
    }
    if (Object.hasOwn(manifest, GUILD_COL)) {
      return (
        `FG72a: the fixture is broken — \`${GUILD_COL}\` is an OWN key of the injected ` +
        'manifest, so the completeness clause would be satisfied for the ordinary reason and ' +
        'the inherited-entry case would go untested'
      );
    }
    const err = checkRekeyCompleteness(guildTree, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/declared]', 'FG72a');
    if (bad) return bad;
    if (err.indexOf(GUILD_COL) === -1) {
      return `FG72a: the failure must NAME the unclassified column ${GUILD_COL}: ${err}`;
    }
  }

  // FG72b — the GOOD CONTROL for the same boundary: own-property membership is a
  // BOUNDARY, not "detect a prototype key and red". An entry that is ONLY
  // inherited names no live column, and the checker must still PASS — it is not
  // part of the manifest at all, so there is no stale policy to report.
  // Kills: an over-correction in the reverse direction, i.e. a [G6/live] loop
  // rewritten as `for (const key in manifest)`, which would report this phantom
  // as a manifest entry that no longer resolves. Green before the fix.
  {
    const PHANTOM = 'phantom_table.owner_identity';
    const manifest = Object.assign(
      Object.create({
        [PHANTOM]: { policy: 'EXEMPT', reason: 'inherited phantom' },
      }),
      REKEY_MANIFEST,
    );
    if (!(PHANTOM in manifest) || Object.hasOwn(manifest, PHANTOM)) {
      return (
        `FG72b: the fixture is broken — \`${PHANTOM}\` must be REACHABLE on the injected ` +
        'manifest and NOT owned by it, or this control proves nothing about inherited keys'
      );
    }
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    if (err) {
      return `FG72b: an inherited-only phantom entry was incorrectly flagged: ${err}`;
    }
  }

  // FG72c — AMBIENT prototype pollution: the residual's LITERAL repro, and the
  // only fixture here that exercises the DEFAULT `manifest = REKEY_MANIFEST`
  // parameter. Every other FG72 fixture INJECTS a manifest, so the shapes they
  // cannot see are the key-space reads on a DERIVED object — `kinds` rebuilt as
  // a plain object asked `key in kinds`, or the column Map rebuilt with
  // Object.fromEntries and asked the same way — which is the residual's own
  // class applied one step downstream. MEASURED: FG72a/b/d/e/f pass both cheats.
  // FOUR directions run inside ONE pollution window (the defect is ambient
  // rather than injected, so every direction needs the same window):
  //   declared  an unclassified column must still be reported;
  //   verdict   a CORRECT pair must still PASS — `parsed.error` and
  //             `classified.error` resolve an ABSENT own key through the chain,
  //             which is why this fixture was RED before the rb-3 change and is
  //             green only now that both reads are `Object.hasOwn`;
  //   live      a manifest entry whose column is GONE must still be reported;
  //   anchors   a missing ANCHOR column must still be reported.
  // The last two are the COLUMNS side of the join (round 2, red-team F1).
  // ANCHOR_COL is `account.identity` on purpose: it is the only G6 anchor that
  // is neither the EXEMPT anchor nor one of the REKEY anchors, so the PRESENCE
  // check is the only clause that can fire for it — for profile.identity the
  // by-value REKEY pin would red first and the columns-side cheat would survive.
  // FOUR keys are polluted: the unclassified column, `error`, and the two live
  // columns. Never `then` — a thenable Object.prototype makes evals/run.mjs
  // await every eval result forever; never `path` — node's own module resolver
  // reads it; never `constructor`. And nothing inside the window may write to
  // stdout or call fs: node's error path reads `error` through the chain
  // (`handleErrorFromBinding` tests `ctx.error !== undefined`), so a write made
  // during the window can be silently truncated when stdout is a file. That is
  // also why the cleanup deletes `error` FIRST — the LEAKED diagnostic below
  // must stay printable even if one of the column keys leaks.
  // WHY THE REAL WRITE, against append-only-ids.eval.mjs:1653 ("this tooth must
  // never assign to Object.prototype"): that rule was written for a tooth that
  // HAS an Object.create alternative — it hands one function an object whose
  // prototype carries the data, which is exactly what FG72a does above. Ambient
  // pollution has no such stand-in: the defect is a read through a chain this
  // fixture does not own and cannot inject, because the manifest under test is
  // this module's own frozen export. So the write is real and the hygiene is
  // MECHANICAL rather than assumed: a pre-existence check that refuses to
  // clobber (or to delete) a co-resident eval's state; the assignment INSIDE the
  // try, so a frozen-intrinsics runtime lands in a named failure instead of
  // `TEETH threw`; Reflect.deleteProperty in `finally`, before any return; and a
  // post-assert that PROVES in-process that all four keys are gone (the X2
  // ledger deletes one cleanup line and requires this fixture to red).
  // runTeeth() is synchronous and evals/run.mjs:30 awaits the evals one at a
  // time, so no other eval can observe the window.
  {
    const COL = GUILD_COL;
    const FIELD = 'error';
    const LIVE_COL = 'player_wallet.owner_identity';
    const ANCHOR_COL = 'account.identity';
    const POLLUTED = [COL, FIELD, LIVE_COL, ANCHOR_COL];
    const AMBIENT = 'an ambient value that no clause in this file ever returns';
    // The COLUMNS-side trees, built OUTSIDE the window (they parse Rust; nothing
    // inside the window may do work that reads `error` through the chain).
    // FG49's shape: one manifest column deleted from the synthesized schema.
    const liveTree = [
      {
        path: 'fixture/schema.rs',
        src: synthSchemaSrc(SYNTH_KEYS.filter((k) => k !== LIVE_COL)),
      },
      GOOD_TREE[1],
    ];
    const anchorTree = [
      {
        path: 'fixture/schema.rs',
        src: synthSchemaSrc(SYNTH_KEYS.filter((k) => k !== ANCHOR_COL)),
      },
      GOOD_TREE[1],
    ];
    // The anchor column's ENTRY goes too: leaving it would red [G6/live] first
    // (a stale policy), and the presence clause under test would never run.
    const anchorManifest = Object.fromEntries(
      Object.entries(REKEY_MANIFEST).filter(([k]) => k !== ANCHOR_COL),
    );
    if (findIdentityColumns(liveTree).has(LIVE_COL)) {
      return `FG72c: the fixture is broken — the live tree still declares ${LIVE_COL}`;
    }
    if (findIdentityColumns(anchorTree).has(ANCHOR_COL)) {
      return `FG72c: the fixture is broken — the anchor tree still declares ${ANCHOR_COL}`;
    }
    if (Object.hasOwn(anchorManifest, ANCHOR_COL)) {
      return `FG72c: the fixture is broken — the anchor manifest still owns ${ANCHOR_COL}`;
    }
    if (POLLUTED.some((k) => k in {}) || Object.keys(Object.prototype).length !== 0) {
      return (
        `FG72c: one of [${POLLUTED.join(', ')}] — or some other enumerable property — is already ` +
        'on Object.prototype BEFORE this fixture ran (keys: ' +
        `[${Object.keys(Object.prototype).join(', ')}]) — refusing to overwrite the state of a ` +
        'co-resident eval, and refusing to delete it either. Something else in this process ' +
        'pollutes the base prototype; that is the bug, and not one for this fixture to fix'
      );
    }
    let bad = null;
    try {
      try {
        Object.prototype[COL] = { policy: 'EXEMPT', reason: 'ambient, never owned' };
        Object.prototype[FIELD] = AMBIENT;
        Object.prototype[LIVE_COL] = { policy: 'EXEMPT', reason: 'ambient live-column shadow' };
        Object.prototype[ANCHOR_COL] = { policy: 'EXEMPT', reason: 'ambient anchor shadow' };
      } catch (e) {
        bad = `FG72c: could not write Object.prototype: ${e?.message ?? String(e)}`;
      }
      if (bad === null && !POLLUTED.every((k) => k in {})) {
        bad =
          'FG72c: the pollution did not take — none of the four directions below would then be ' +
          'testing anything, and a silently-failed injection is the one way this fixture goes ' +
          'vacuous while still printing green';
      }
      if (bad === null) {
        // WINDOW GUARD, opening half (round 2, red-team F2). The four directions
        // are teeth only while the pollution is LIVE: hoisted above the `try`
        // they all pass on a clean prototype, X2 and X3 stay green, and the
        // derived-object cheats are re-admitted. These two asserts are glued to
        // the directions precisely so that moving that hunk moves them out of
        // the window too, and the fixture reds.
        let windowBad = null;
        if (!(COL in {} && FIELD in {} && LIVE_COL in {} && ANCHOR_COL in {})) {
          windowBad = 'FG72c: the pollution window closed early — a direction ran outside it';
        }

        // Declared direction: an AMBIENT policy for a real, unclassified column
        // must not satisfy the completeness clause.
        const declaredErr = checkRekeyCompleteness(guildTree, GOOD_ACCOUNTS);
        let declaredBad = expectTag(declaredErr, '[G6/declared]', 'FG72c');
        if (declaredBad === null && declaredErr.indexOf(COL) === -1) {
          declaredBad = `FG72c: the failure must NAME the unclassified column ${COL}: ${declaredErr}`;
        }

        // Verdict direction: the same pollution must not change the verdict on a
        // pair that is CORRECT.
        const goodErr = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS);
        let goodBad = null;
        if (goodErr !== null) {
          goodBad =
            'FG72c: ambient Object.prototype.error pollution changed the GOOD verdict — an ' +
            `absent own key resolved through the chain: ${String(goodErr)}`;
        }

        // Live direction, COLUMNS side: the entry is shipped, the column is
        // DELETED, and an ambient key of the same name must not make it look
        // present. Kills a membership test rebuilt over Object.fromEntries.
        const liveErr = checkRekeyCompleteness(liveTree, GOOD_ACCOUNTS);
        let liveBad = expectTag(liveErr, '[G6/live]', 'FG72c');
        if (liveBad === null && liveErr.indexOf(LIVE_COL) === -1) {
          liveBad = `FG72c: the stale-policy failure must NAME the deleted column ${LIVE_COL}: ${liveErr}`;
        }

        // Anchors direction, COLUMNS side: the non-vacuity check that exists so
        // an EMPTY column set cannot satisfy the two directions above must not
        // be satisfiable by an ambient key either.
        // The name check is on the BACKTICKED form: that clause ends by listing
        // every anchor, so a plain indexOf would be satisfied by the list even
        // when a different anchor was the one that fired.
        const anchorErr = checkRekeyCompleteness(anchorTree, GOOD_ACCOUNTS, anchorManifest);
        let anchorBad = expectTag(anchorErr, '[G6/anchors]', 'FG72c');
        if (anchorBad === null && anchorErr.indexOf(`\`${ANCHOR_COL}\``) === -1) {
          anchorBad = `FG72c: the anchor failure must NAME the missing column ${ANCHOR_COL}: ${anchorErr}`;
        }

        // WINDOW GUARD, closing half. Same assertion, after the last direction.
        if (!(COL in {} && FIELD in {} && LIVE_COL in {} && ANCHOR_COL in {})) {
          windowBad = 'FG72c: the pollution window closed early — a direction ran outside it';
        }

        // Report order. A broken window invalidates every direction under it, so
        // it comes first; then the verdict, because a changed verdict on a
        // CORRECT input is the deepest fact and EXPLAINS the other three (the
        // same chain read swallows their clauses before they can run).
        bad = windowBad ?? goodBad ?? declaredBad ?? liveBad ?? anchorBad;
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, FIELD);
      Reflect.deleteProperty(Object.prototype, COL);
      Reflect.deleteProperty(Object.prototype, LIVE_COL);
      Reflect.deleteProperty(Object.prototype, ANCHOR_COL);
    }
    if (POLLUTED.some((k) => k in {}) || Object.keys(Object.prototype).length !== 0) {
      return (
        'FG72c: LEAKED — this fixture left an enumerable own property on Object.prototype after ' +
        `its finally block ran (keys: [${Object.keys(Object.prototype).join(', ')}]). Every ` +
        'later eval in this run would see it, so a leak is a HARD failure here, not a note'
      );
    }
    if (bad) return bad;
  }

  // FG72d — the ENTRY side of the boundary, and an ORDER-dependent invariant.
  // `entry.policy` is the FIRST prototype-walking read in classifyPolicy, and
  // what makes it SAFE is the field-set equality over `Object.keys(entry)` that
  // runs next: an entry that owns nothing has the field set [], which is not the
  // closed set of any policy kind, so [G6/policy] fires. The later reads
  // (`entry[f]` in the non-blank-string loop, `entry.rekey` / `entry.exists`,
  // `entry.reason`) walk the chain too and are safe only because that same
  // equality has already run. Reorder or drop it and an entry with an INHERITED
  // policy word classifies as a real BLOCKED entry.
  // Kills: a short-circuit that returns as soon as `typeof entry.policy` is a
  // string, and `'policy' in entry && 'reason' in entry` as the shape test.
  // Green before the fix.
  {
    const entry = Object.create({ policy: 'BLOCKED', reason: 'inherited' });
    if (Object.keys(entry).length !== 0 || entry.policy !== 'BLOCKED') {
      return (
        'FG72d: the fixture is broken — the injected entry must own NOTHING and inherit a ' +
        `well-formed policy (own fields: [${Object.keys(entry).join(', ')}], policy resolved ` +
        `through the chain: ${JSON.stringify(entry.policy)})`
      );
    }
    const manifest = { ...REKEY_MANIFEST, 'player.identity': entry };
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/policy]', 'FG72d');
    if (bad) return bad;
    if (err.indexOf('player.identity') === -1 || err.indexOf('the fields []') === -1) {
      return (
        'FG72d: the failure must name `player.identity` AND report the EMPTY own field set ' +
        `(the fields []) — an entry that owns nothing is not a BLOCKED entry: ${err}`
      );
    }
  }

  // FG72e — the completeness clause must read the manifest it was HANDED, not
  // this module's frozen export. A copy of the shipped manifest with one live
  // column dropped must red, naming that column. `battle.player_identity` is
  // deliberately a NON-anchor: dropping an anchor's entry reds [G6/anchors]
  // first, which would let this fixture pass without the clause under test
  // having run at all.
  // Kills: `Object.hasOwn(REKEY_MANIFEST, key)` (or any other read of the module
  // constant) in place of the `manifest` parameter — a shape that passes every
  // other injected-manifest fixture in this file and quietly makes all of them
  // TAUTOLOGICAL. Green before the fix.
  {
    const DROPPED = 'battle.player_identity';
    const manifest = Object.fromEntries(
      Object.entries(REKEY_MANIFEST).filter(([k]) => k !== DROPPED),
    );
    if (Object.hasOwn(manifest, DROPPED)) {
      return `FG72e: the fixture is broken — ${DROPPED} was not dropped from the copy`;
    }
    if (Object.keys(manifest).length !== Object.keys(REKEY_MANIFEST).length - 1) {
      return (
        `FG72e: the copy owns ${Object.keys(manifest).length} key(s); it must differ from the ` +
        `shipped ${Object.keys(REKEY_MANIFEST).length} by EXACTLY the one dropped key`
      );
    }
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/declared]', 'FG72e');
    if (bad) return bad;
    if (err.indexOf(DROPPED) === -1) {
      return `FG72e: the failure must NAME the column the injected manifest left out: ${err}`;
    }
  }

  // FG72f — the INVERSE of FG72a: classifyManifest must classify the OWN entry,
  // never a well-formed one shadowed on the prototype. Here the own entry is
  // malformed (BLOCKED with no `reason`) and the prototype carries a complete
  // entry for the same key, so a checker that prefers the inherited value goes
  // green on a manifest that ships a broken row.
  // Kills: an entry read of the form
  // `const base = Object.getPrototypeOf(manifest); key in base ? base[key] : manifest[key]`
  // — which passes every other fixture in this file. Green before the fix.
  {
    const KEY = 'player.identity';
    const manifest = Object.assign(
      Object.create({
        [KEY]: { policy: 'BLOCKED', reason: 'inherited shadow entry' },
      }),
      REKEY_MANIFEST,
      { [KEY]: { policy: 'BLOCKED' } },
    );
    if (!Object.hasOwn(manifest, KEY)) {
      return `FG72f: the fixture is broken — ${KEY} must be an OWN key of the injected manifest`;
    }
    const own = manifest[KEY];
    const shadow = Object.getPrototypeOf(manifest)[KEY];
    if (Object.keys(own).length !== 1 || own.policy !== 'BLOCKED') {
      return (
        'FG72f: the fixture is broken — the OWN entry must carry exactly one field, its policy, ' +
        'so that only the missing `reason` separates it from the shadow (own fields: ' +
        `[${Object.keys(own).join(', ')}])`
      );
    }
    if (Object.keys(shadow).length !== 2) {
      return (
        'FG72f: the fixture is broken — the INHERITED shadow entry must itself be WELL-FORMED, ' +
        'or a checker that wrongly reads it would red for a reason this fixture is not about'
      );
    }
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/policy]', 'FG72f');
    if (bad) return bad;
    if (err.indexOf(KEY) === -1 || err.indexOf('the fields [policy]') === -1) {
      return (
        `FG72f: the failure must name \`${KEY}\` and report the OWN field set (the fields ` +
        `[policy]) — the shadowed, well-formed entry must be invisible to the classifier: ${err}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // FG73 — THE ALIAS RESOLUTION RULE (rb-4, residual R-m22-s0-X3).
  //
  // Until this slice the column walker classified a column by the LITERAL text
  // of its declared type, so a column whose type is a one-line Rust `type` item
  // resolving to Identity was invisible to the completeness clause, to the
  // reverse live clause AND to the anchor clause — MEASURED on the fork for
  // every spelling (direct, transitive, Option-wrapped, renamed by a `use ...
  // as` item, cross-file, any visibility, qualified right-hand side). An
  // invisible Identity column is a column with no D6 policy and no reviewer to
  // notice it, which is exactly the silent-orphan defect G6 exists to prevent.
  //
  // THE RULE THESE FIXTURES PIN. Every `type` item and every `use ... as`
  // rename in the WHOLE scanned tree is collected ONCE, from STRIPPED source,
  // into one name -> bindings table: a UNION, duplicates KEPT, no per-file
  // precedence (a same-file associated item must not overwrite a module-level
  // binding). A column's declared type is split into identifier tokens and
  // every bound token is expanded RECURSIVELY, a name already on the current
  // expansion path being terminal — so a fixed point resolves and a cycle merely
  // stops. An Identity-bearing expansion WINS (fail-closed), and the failure
  // then names every binding consulted and the file each one came from, or the
  // over-report is unactionable. The record keeps the DECLARED text unchanged
  // and adds the expansion plus the bindings consulted. A spelling the resolver
  // cannot read at all — a macro that GENERATES a type item — is DETECTED and
  // reported by name rather than silently skipped.
  //
  // Fixture letters: a direct (plus a wrapped declaration) · b transitive ·
  // c Option in both directions · d the three rename spellings · e cross-file ·
  // f the GOOD control, exact key set, in two legs · g ambiguity in both
  // directions · h termination (GOOD) · i the join direction · j the record
  // shape · k a declaration that exists only inside a string literal (GOOD) ·
  // l ambient prototype pollution, both directions · m raw and non-ASCII names ·
  // n the macro detector · o this file's own text above the teeth.
  //
  // EVERY fixture SELF-ASSERTS its shape before the call: the declaration is
  // present in the STRIPPED fixture source (so a stripper change cannot quietly
  // turn a BAD fixture into a vacuous one), and the aliased column is NOT
  // declared with a literal Identity type — the needle for that second check is
  // spelled in two halves so this file's own text cannot satisfy it. Every
  // failing fixture additionally asserts that the failure NAMES the column.
  // ---------------------------------------------------------------------------
  const RB4_SCHEMA_PATH = 'fixture/schema.rs';
  const RB4_IDS_PATH = 'fixture/ids.rs';
  const RB4_OTHER_PATH = 'fixture/other.rs';
  const RB4_ALIAS_PATH = 'fixture/aliases.rs';
  const RB4_COL = 'guild_member.delegate';
  // TWO HALVES on purpose: written contiguously, this file's own source would
  // contain the very needle the honesty check below searches its fixtures for.
  const RB4_LITERAL = 'delegate:' + 'Identity';

  const rb4Table = (fieldType) => `#[spacetimedb::table(accessor = guild_member)]
pub struct GuildMember {
    pub delegate: ${fieldType},
    pub guild_id: u64,
}
`;

  // The synthesized GOOD schema (FG47's tree) is the BASE of every fixture
  // below, exactly as FG48 does it: the default manifest stays satisfiable, so
  // the completeness clause is the FIRST clause that can fire for the new
  // column. Declarations sit OUTSIDE every struct body — the table parser ends a
  // body at the first newline-brace, so a declaration inside one would truncate
  // the column list and red the parse clause instead of the clause under test.
  const rb4Schema = (decls, fieldType) => GOOD_TREE[0].src + decls + rb4Table(fieldType);

  const rb4SelfCheck = (label, declSrc, decls, colSrc) => {
    const strippedDecls = stripRustSource(declSrc);
    for (const decl of decls) {
      if (strippedDecls.indexOf(decl) !== -1) continue;
      return (
        `${label}: the fixture is broken — the declaration \`${decl}\` is not present in the ` +
        'STRIPPED fixture source, so this fixture exercises no alias resolution at all and would ' +
        'be green for a reason that has nothing to do with the walker'
      );
    }
    if (compactWs(stripRustSource(colSrc)).indexOf(RB4_LITERAL) !== -1) {
      return (
        `${label}: the fixture is broken — the column is declared with a LITERAL Identity type ` +
        `(compacted needle \`${RB4_LITERAL}\`), so the FORK walker would classify it without ` +
        'resolving anything and this fixture would prove nothing about aliases'
      );
    }
    return null;
  };

  // FG73a — the residual's LITERAL repro: a declaration binding a name to
  // Identity, and a column declared with that name. RED before the fix (the
  // checker returns PASS, because the column is invisible to it), and the
  // failure must RENDER the chain: a reader told that a column has no policy,
  // while the type text in front of them is a name that says nothing about
  // Identity, cannot act on the report without the binding and its file.
  // Kills: classifying on the DECLARED text, and a message that drops the alias
  // rendering. The second leg is the rustfmt-WRAPPED declaration — a collector
  // whose pattern cannot span a newline is blind to a line rustfmt itself wrote.
  {
    const DECL = 'pub type OwnerId = Identity;';
    const src = rb4Schema(`${DECL}\n`, 'OwnerId');
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const broken = rb4SelfCheck('FG73a', src, [DECL], src);
    if (broken) return broken;

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/declared]', 'FG73a');
    if (bad) return bad;
    if (err.indexOf(RB4_COL) === -1) {
      return `FG73a: the failure must NAME the unclassified column ${RB4_COL}: ${err}`;
    }
    // NOT the bare word Identity: the G6/declared boilerplate already contains
    // it, so an assertion on it is vacuous (measured by the red-team pass). The
    // rendered CHAIN is the assertion — the binding, its right-hand side, and
    // the file that declares it.
    const rendersVia = err.indexOf('via ') !== -1;
    const rendersBinding = err.indexOf('type OwnerId = Identity') !== -1;
    if (!rendersVia || !rendersBinding) {
      return (
        'FG73a: the failure must RENDER the alias chain — the substring `via ` and the binding ' +
        '`type OwnerId = Identity`. A fail-closed over-report is actionable only when it names ' +
        `the binding that made this column an Identity column: ${err}`
      );
    }
    if (err.indexOf(RB4_SCHEMA_PATH) === -1) {
      return `FG73a: the failure must name the file that DECLARES the binding: ${err}`;
    }

    const WRAP = 'pub type OwnerId =\n    Identity;';
    const wrapSrc = rb4Schema(`${WRAP}\n`, 'OwnerId');
    const wrapTree = [{ path: RB4_SCHEMA_PATH, src: wrapSrc }, GOOD_TREE[1]];
    const wrapBroken = rb4SelfCheck('FG73a/wrapped', wrapSrc, [WRAP], wrapSrc);
    if (wrapBroken) return wrapBroken;
    const wrapErr = checkRekeyCompleteness(wrapTree, GOOD_ACCOUNTS);
    const wrapBad = expectTag(wrapErr, '[G6/declared]', 'FG73a/wrapped');
    if (wrapBad) return wrapBad;
    const wrapNames = wrapErr.indexOf(RB4_COL) !== -1;
    const wrapBinding = wrapErr.indexOf('type OwnerId = Identity') !== -1;
    if (!wrapNames || !wrapBinding) {
      return (
        'FG73a/wrapped: rustfmt wraps a long declaration onto the next line, so the collector ' +
        'must span newlines and the rendered right-hand side must be the same one the unwrapped ' +
        `leg produces: ${wrapErr}`
      );
    }
  }

  // FG73b — TRANSITIVITY. Two hops, so a resolver that expands exactly one
  // level reports nothing at all. The rendering assertion additionally pins that
  // EVERY binding consulted reaches the message, not only the last one: a reader
  // shown one hop of a two-hop chain still cannot see why the column is an
  // Identity column.
  {
    const BASE = 'pub type Owner = Identity;';
    const MID = 'pub type OwnerId = Owner;';
    const src = rb4Schema(`${BASE}\n${MID}\n`, 'OwnerId');
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const broken = rb4SelfCheck('FG73b', src, [BASE, MID], src);
    if (broken) return broken;

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/declared]', 'FG73b');
    if (bad) return bad;
    if (err.indexOf(RB4_COL) === -1) {
      return `FG73b: the failure must NAME the unclassified column ${RB4_COL}: ${err}`;
    }
    const hopOne = err.indexOf('type OwnerId = Owner') !== -1;
    const hopTwo = err.indexOf('type Owner = Identity') !== -1;
    if (!hopOne || !hopTwo) {
      return (
        'FG73b: the failure must render BOTH hops of the chain — `type OwnerId = Owner` and ' +
        '`type Owner = Identity`. A one-level expansion reports nothing here at all, and a ' +
        `message that shows one hop of two is a report the reader cannot follow: ${err}`
      );
    }
  }

  // FG73c — the Option spellings, in BOTH directions: the wrapper written at the
  // COLUMN, and the wrapper written in the BINDING. Kills a resolver that looks
  // the WHOLE declared type text up in the binding table (which resolves the
  // second leg and is blind to the first), and any resolver that only
  // understands a bare, unwrapped type name.
  {
    const DECL = 'pub type OwnerId = Identity;';
    const src = rb4Schema(`${DECL}\n`, 'Option<OwnerId>');
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const broken = rb4SelfCheck('FG73c/wrapped-column', src, [DECL], src);
    if (broken) return broken;
    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/declared]', 'FG73c/wrapped-column');
    if (bad) return bad;
    if (err.indexOf(RB4_COL) === -1) {
      return `FG73c/wrapped-column: the failure must NAME the column ${RB4_COL}: ${err}`;
    }

    const MAYBE = 'pub type MaybeOwner = Option<Identity>;';
    const maybeSrc = rb4Schema(`${MAYBE}\n`, 'MaybeOwner');
    const maybeTree = [{ path: RB4_SCHEMA_PATH, src: maybeSrc }, GOOD_TREE[1]];
    const maybeBroken = rb4SelfCheck('FG73c/wrapped-binding', maybeSrc, [MAYBE], maybeSrc);
    if (maybeBroken) return maybeBroken;
    const maybeErr = checkRekeyCompleteness(maybeTree, GOOD_ACCOUNTS);
    const maybeBad = expectTag(maybeErr, '[G6/declared]', 'FG73c/wrapped-binding');
    if (maybeBad) return maybeBad;
    if (maybeErr.indexOf(RB4_COL) === -1) {
      return `FG73c/wrapped-binding: the failure must NAME the column ${RB4_COL}: ${maybeErr}`;
    }
  }

  // FG73d — the THREE rename spellings a `use` item can carry: a multi-line
  // brace group (the rustfmt shape), the plain single-item form, and a `pub use`
  // re-export that renames a name which is ITSELF a bound name — a chain that
  // resolves only when renames and type items live in ONE table.
  {
    const USE_GROUP = 'use spacetimedb::{\n    Identity as WhoRef,\n    Table,\n};';
    const groupSrc = rb4Schema(`${USE_GROUP}\n`, 'WhoRef');
    const groupTree = [{ path: RB4_SCHEMA_PATH, src: groupSrc }, GOOD_TREE[1]];
    const groupBroken = rb4SelfCheck('FG73d/group', groupSrc, [USE_GROUP], groupSrc);
    if (groupBroken) return groupBroken;
    const groupErr = checkRekeyCompleteness(groupTree, GOOD_ACCOUNTS);
    const groupBad = expectTag(groupErr, '[G6/declared]', 'FG73d/group');
    if (groupBad) return groupBad;
    const groupNames = groupErr.indexOf(RB4_COL) !== -1;
    const groupBinding = groupErr.indexOf('type WhoRef = Identity') !== -1;
    if (!groupNames || !groupBinding) {
      return (
        'FG73d/group: a rename inside a brace group IS a binding, so the failure must name the ' +
        `column and render it as one (\`type WhoRef = Identity\`): ${groupErr}`
      );
    }

    const USE_PLAIN = 'use spacetimedb::Identity as Owner;';
    const plainSrc = rb4Schema(`${USE_PLAIN}\n`, 'Owner');
    const plainTree = [{ path: RB4_SCHEMA_PATH, src: plainSrc }, GOOD_TREE[1]];
    const plainBroken = rb4SelfCheck('FG73d/plain', plainSrc, [USE_PLAIN], plainSrc);
    if (plainBroken) return plainBroken;
    const plainErr = checkRekeyCompleteness(plainTree, GOOD_ACCOUNTS);
    const plainBad = expectTag(plainErr, '[G6/declared]', 'FG73d/plain');
    if (plainBad) return plainBad;
    if (plainErr.indexOf(RB4_COL) === -1) {
      return `FG73d/plain: the failure must NAME the column ${RB4_COL}: ${plainErr}`;
    }

    const EXPORT = 'pub use crate::ids::OwnerId as Handoff;';
    const DECL = 'pub type OwnerId = Identity;';
    const chainSrc = rb4Schema(`${DECL}\n${EXPORT}\n`, 'Handoff');
    const chainTree = [{ path: RB4_SCHEMA_PATH, src: chainSrc }, GOOD_TREE[1]];
    const chainDecls = [DECL, EXPORT];
    const chainBroken = rb4SelfCheck('FG73d/re-export', chainSrc, chainDecls, chainSrc);
    if (chainBroken) return chainBroken;
    const chainErr = checkRekeyCompleteness(chainTree, GOOD_ACCOUNTS);
    const chainBad = expectTag(chainErr, '[G6/declared]', 'FG73d/re-export');
    if (chainBad) return chainBad;
    const chainNames = chainErr.indexOf(RB4_COL) !== -1;
    const chainVia = chainErr.indexOf('via ') !== -1;
    if (!chainNames || !chainVia) {
      return (
        'FG73d/re-export: a rename of a name that is ITSELF bound must resolve through BOTH ' +
        `bindings, and the failure must name the column and render the chain: ${chainErr}`
      );
    }
  }

  // FG73e — CROSS-FILE: the binding is declared in a file that declares NO table
  // at all, and the column lives in another file. This is the shape that keeps
  // every single-file fixture above green while a real module split hides the
  // column. The declaring file is deliberately NOT the first element of the
  // tree, so a collector that reads only the first source fails here too, and
  // the failure must name the DECLARING file, which is not the column's own.
  {
    const DECL = 'pub type GuildRef = Identity;';
    const idsSrc = `// an alias-only module: no table is declared here\n${DECL}\n`;
    const src = rb4Schema('', 'GuildRef');
    const idsFile = { path: RB4_IDS_PATH, src: idsSrc };
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1], idsFile];
    const broken = rb4SelfCheck('FG73e', idsSrc, [DECL], src);
    if (broken) return broken;
    if (idsSrc.indexOf('#[spacetimedb::table(') !== -1) {
      return (
        'FG73e: the fixture is broken — the declaring file must declare NO table, or a per-file ' +
        'collector could find the binding while it walks the column’s own file and this fixture ' +
        'would prove nothing about a tree-wide table'
      );
    }
    if (tree.findIndex((f) => f.path === RB4_IDS_PATH) < 1) {
      return (
        'FG73e: the fixture is broken — the declaring file must NOT be the FIRST element of the ' +
        'tree, or a collector that reads only the first source would pass by accident'
      );
    }

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/declared]', 'FG73e');
    if (bad) return bad;
    if (err.indexOf(RB4_COL) === -1) {
      return `FG73e: the failure must NAME the unclassified column ${RB4_COL}: ${err}`;
    }
    if (err.indexOf(RB4_IDS_PATH) === -1) {
      return (
        `FG73e: the failure must name ${RB4_IDS_PATH} — the file that DECLARES the binding, which ` +
        'is not the file that declares the column. Without it the reader has to grep the whole ' +
        `tree for a name they have never seen: ${err}`
      );
    }
  }

  // FG73f — the GOOD CONTROL, and the only fixture that pins the walk's EXACT
  // key set. Two legs, because two wrong resolvers need two different trees:
  //   controls  four columns typed by bindings that resolve to NON-Identity
  //             (u64, u32, a Vec-shaped binding, u8), plus a binding that DOES
  //             resolve to Identity and that no column references. This kills
  //             "any column whose type is a bound name is an Identity column";
  //             it kills a classifier that tests for the SUBSTRING Identity (one
  //             control is NAMED IdentityTag and resolves to u32); and — because
  //             one binding's right-hand side is literally Identity — it kills
  //             an identifier-BLIND substitution resolver, which rewrites every
  //             real Identity column in the tree into text the whole-identifier
  //             test no longer matches, losing 24 columns at once.
  //   decoy     a column typed by a name NOTHING binds, whose spelling merely
  //             BEGINS with a bound name. A substring substitution rewrites it
  //             into Identity-bearing text and fabricates a column the schema
  //             does not declare; token-driven expansion leaves it alone. The
  //             decoy is a real declared struct, so the fixture reads like
  //             source rather than like a typo.
  // Both legs must walk to the SAME key set as the GOOD tree — an EXACT set
  // equality, so a fabricated column shows up as a surplus and a mangled one as
  // a loss — and both must PASS the whole checker, before AND after the fix.
  {
    const CONTROL_SRC = `pub type Coins = u64;
pub type IdentityTag = u32;
pub type NpcSyncPlan = Vec<NpcSyncAction>;
pub type Id = Identity;
pub type IdKind = u8;

#[spacetimedb::table(accessor = guild_ledger)]
pub struct GuildLedger {
    pub balance: Coins,
    pub tag: IdentityTag,
    pub plan: NpcSyncPlan,
    pub kind: IdKind,
    pub note: String,
}
`;
    const CONTROLS = [
      { field: 'balance', name: 'Coins', rhs: 'u64' },
      { field: 'tag', name: 'IdentityTag', rhs: 'u32' },
      { field: 'plan', name: 'NpcSyncPlan', rhs: 'Vec<NpcSyncAction>' },
      { field: 'kind', name: 'IdKind', rhs: 'u8' },
    ];
    const controlStripped = stripRustSource(CONTROL_SRC);
    for (const c of CONTROLS) {
      const decl = `pub type ${c.name} = ${c.rhs};`;
      if (controlStripped.indexOf(decl) === -1) {
        return `FG73f/controls: the fixture is broken — \`${decl}\` is not in the stripped source`;
      }
      if (containsIdent(c.rhs, 'Identity')) {
        return (
          `FG73f/controls: the fixture is broken — the control binding \`${c.name}\` resolves to ` +
          `\`${c.rhs}\`, which IS Identity-bearing, so its column belongs in the reported set and ` +
          'this control would be asserting the wrong thing'
        );
      }
      if (CONTROL_SRC.indexOf(`pub ${c.field}: ${c.name},`) === -1) {
        return (
          `FG73f/controls: the fixture is broken — no column is declared \`pub ${c.field}: ` +
          `${c.name},\`, so this control name is never looked up at all`
        );
      }
    }
    if (CONTROL_SRC.indexOf('pub type Id = Identity;') === -1) {
      return (
        'FG73f/controls: the fixture is broken — the tree must ALSO bind a name to Identity that ' +
        'no column references, or an identifier-blind substitution has nothing to corrupt and ' +
        'this leg loses half its teeth'
      );
    }

    const DECOY_SRC = `pub type MaybeOwner = Option<Identity>;

pub struct MaybeOwnerRef {
    pub inner: u8,
}

#[spacetimedb::table(accessor = guild_scope)]
pub struct GuildScope {
    pub scope: MaybeOwnerRef,
    pub note: String,
}
`;
    if (DECOY_SRC.indexOf('pub type MaybeOwner = Option<Identity>;') === -1) {
      return 'FG73f/decoy: the fixture is broken — the bound PREFIX name is not declared';
    }
    if (DECOY_SRC.indexOf('pub type MaybeOwnerRef') !== -1) {
      return (
        'FG73f/decoy: the fixture is broken — the decoy name must be UNBOUND (a struct, never an ' +
        'alias), or the column is legitimately resolvable and nothing is being decoyed'
      );
    }
    const decoyStruct = DECOY_SRC.indexOf('pub struct MaybeOwnerRef {') !== -1;
    const decoyColumn = DECOY_SRC.indexOf('pub scope: MaybeOwnerRef,') !== -1;
    if (!decoyStruct || !decoyColumn) {
      return (
        'FG73f/decoy: the fixture is broken — the decoy must be a real declared type AND the ' +
        'column must be declared with it'
      );
    }

    const want = [...findIdentityColumns(GOOD_TREE).keys()].sort();
    if (want.length !== Object.keys(REKEY_MANIFEST).length) {
      return (
        `FG73f: the fixture is broken — the GOOD tree walks to ${want.length} column(s) but the ` +
        `manifest owns ${Object.keys(REKEY_MANIFEST).length}; an exact key-set comparison against ` +
        'a wrong (or empty) baseline proves nothing at all'
      );
    }

    const controlFile = { path: RB4_ALIAS_PATH, src: CONTROL_SRC };
    const controlTree = [GOOD_TREE[0], GOOD_TREE[1], controlFile];
    const gotControls = [...findIdentityColumns(controlTree).keys()].sort();
    if (gotControls.join(',') !== want.join(',')) {
      return (
        'FG73f/controls: a file of NON-Identity bindings changed the walk. Those columns resolve ' +
        'to u64 / u32 / a Vec / u8 and must contribute NOTHING, and no column the GOOD tree ' +
        `already declares may be lost. want=[${want.join(', ')}] got=[${gotControls.join(', ')}]`
      );
    }
    const controlErr = checkRekeyCompleteness(controlTree, GOOD_ACCOUNTS);
    if (controlErr) {
      return `FG73f/controls: the GOOD control tree was incorrectly flagged: ${controlErr}`;
    }

    const decoyFile = { path: RB4_ALIAS_PATH, src: DECOY_SRC };
    const decoyTree = [GOOD_TREE[0], GOOD_TREE[1], decoyFile];
    const gotDecoy = [...findIdentityColumns(decoyTree).keys()].sort();
    if (gotDecoy.join(',') !== want.join(',')) {
      return (
        'FG73f/decoy: an UNBOUND type name whose spelling merely BEGINS with a bound name was ' +
        'resolved as if it were that name. A substring substitution turns it into ' +
        'Identity-bearing text and fabricates a column the schema does not declare; expansion is ' +
        `token-driven precisely so it cannot. want=[${want.join(', ')}] ` +
        `got=[${gotDecoy.join(', ')}]`
      );
    }
    const decoyErr = checkRekeyCompleteness(decoyTree, GOOD_ACCOUNTS);
    if (decoyErr) {
      return `FG73f/decoy: the GOOD decoy tree was incorrectly flagged: ${decoyErr}`;
    }
  }

  // FG73g — AMBIGUITY, fail-closed, in both directions.
  //   cross-file  one name bound to Identity in one file and to u64 in another.
  //               The NON-Identity binding is collected FIRST on purpose, so
  //               "the first binding of a name wins" is not accidentally right;
  //               the column must still be reported, and the message must name
  //               BOTH declaring files and say how many ways the name is bound —
  //               an over-report the reader cannot resolve is noise.
  //   same-file   an associated item inside an `impl` block binds the same name
  //               to u64 beside a module-level binding to Identity. A collector
  //               with per-file precedence (or a table that OVERWRITES on a
  //               duplicate key) loses the module-level binding and the column
  //               goes unreported — the measured hide that made the binding
  //               table a union with duplicates KEPT.
  {
    const ID_DECL = 'pub type OwnerId = Identity;';
    const U64_DECL = 'pub type OwnerId = u64;';
    const src = rb4Schema('', 'OwnerId');
    const otherFile = { path: RB4_OTHER_PATH, src: `${U64_DECL}\n` };
    const idsFile = { path: RB4_IDS_PATH, src: `${ID_DECL}\n` };
    const tree = [{ path: RB4_SCHEMA_PATH, src }, otherFile, idsFile, GOOD_TREE[1]];
    const broken =
      rb4SelfCheck('FG73g/cross-file', otherFile.src, [U64_DECL], src) ??
      rb4SelfCheck('FG73g/cross-file', idsFile.src, [ID_DECL], src);
    if (broken) return broken;
    const u64At = tree.findIndex((f) => f.path === RB4_OTHER_PATH);
    const idAt = tree.findIndex((f) => f.path === RB4_IDS_PATH);
    if (u64At > idAt) {
      return (
        'FG73g/cross-file: the fixture is broken — the NON-Identity binding must be collected ' +
        'FIRST, or a resolver that simply takes the first binding of a name would pass here'
      );
    }

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/declared]', 'FG73g/cross-file');
    if (bad) return bad;
    if (err.indexOf(RB4_COL) === -1) {
      return `FG73g/cross-file: the failure must NAME the column ${RB4_COL}: ${err}`;
    }
    const namesIds = err.indexOf(RB4_IDS_PATH) !== -1;
    const namesOther = err.indexOf(RB4_OTHER_PATH) !== -1;
    const namesCount = err.indexOf('bound 2 ways') !== -1;
    if (!namesIds || !namesOther || !namesCount) {
      return (
        'FG73g/cross-file: an ambiguous name is reported FAIL-CLOSED, so the message must name ' +
        `every file that binds it (${RB4_IDS_PATH} and ${RB4_OTHER_PATH}) and say how many ways ` +
        `it is bound; without that the reader cannot tell an over-report from a hole: ${err}`
      );
    }

    const IMPL_DECL = 'impl Tagged for Decoy {\n    type OwnerId = u64;\n}';
    const sameSrc = rb4Schema(`${ID_DECL}\n${IMPL_DECL}\n`, 'OwnerId');
    const sameTree = [{ path: RB4_SCHEMA_PATH, src: sameSrc }, GOOD_TREE[1]];
    const sameDecls = [ID_DECL, IMPL_DECL];
    const sameBroken = rb4SelfCheck('FG73g/same-file', sameSrc, sameDecls, sameSrc);
    if (sameBroken) return sameBroken;
    if (sameSrc.indexOf(ID_DECL) > sameSrc.indexOf(IMPL_DECL)) {
      return (
        'FG73g/same-file: the fixture is broken — the module-level binding must come FIRST, so ' +
        'that only a LAST-WINS collector (never the reading order) can lose it'
      );
    }
    const sameErr = checkRekeyCompleteness(sameTree, GOOD_ACCOUNTS);
    const sameBad = expectTag(sameErr, '[G6/declared]', 'FG73g/same-file');
    if (sameBad) return sameBad;
    if (sameErr.indexOf(RB4_COL) === -1) {
      return (
        'FG73g/same-file: an associated item must not shadow a module-level binding of the same ' +
        `name; the column must still be reported, by name: ${sameErr}`
      );
    }
  }

  // FG73h — TERMINATION, as a GOOD control on the two shapes a substitution
  // fixpoint cannot survive:
  //   fixed point  a binding whose right-hand side mentions the very name being
  //                bound is REAL, ordinary Rust (a re-export of a vendor type
  //                under its own name). Structural termination — a name already
  //                on the current expansion path is terminal — resolves it and
  //                the column is correctly NOT reported; substituting until
  //                nothing changes never ends.
  //   cycle        a mutually recursive pair does not compile, so no verdict is
  //                pinned; the walker must simply RETURN rather than exhaust the
  //                stack, because a gate that throws is a gate whose every
  //                clause is skipped.
  {
    const TS_DECL = 'pub(crate) type Stampish = spacetimedb::Stampish;';
    const tsSrc = `${GOOD_TREE[0].src}${TS_DECL}
#[spacetimedb::table(accessor = audit_log)]
pub struct AuditLog {
    pub at: Stampish,
    pub note: String,
}
`;
    const tsTree = [{ path: RB4_SCHEMA_PATH, src: tsSrc }, GOOD_TREE[1]];
    const tsBroken = rb4SelfCheck('FG73h/fixed-point', tsSrc, [TS_DECL], tsSrc);
    if (tsBroken) return tsBroken;
    if (tsSrc.indexOf('pub at: Stampish,') === -1) {
      return 'FG73h/fixed-point: the fixture is broken — no column is declared with the binding';
    }
    // The load-bearing property, asserted rather than assumed: the right-hand
    // side MENTIONS the name being bound. Rename only the LEFT side and this leg
    // silently becomes an ordinary one-hop alias — still green, and no longer a
    // termination test at all.
    if (!containsIdent(TS_DECL.slice(TS_DECL.indexOf('=')), 'Stampish')) {
      return (
        'FG73h/fixed-point: the fixture is broken — the right-hand side must MENTION the bound ' +
        'name, or this is a one-hop alias and the fixed point it exists to exercise is untested'
      );
    }
    let tsErr = null;
    try {
      tsErr = checkRekeyCompleteness(tsTree, GOOD_ACCOUNTS);
    } catch (e) {
      return (
        'FG73h/fixed-point: a binding whose right-hand side mentions its own name made the ' +
        `walker throw (${e?.message ?? String(e)}). Expansion terminates STRUCTURALLY, on the ` +
        'name already being on the current path, never on a change count'
      );
    }
    if (tsErr) {
      return `FG73h/fixed-point: a NON-Identity fixed point was incorrectly flagged: ${tsErr}`;
    }

    const CYCLE = 'pub type A = B;\npub type B = A;';
    const cycleSrc = `${GOOD_TREE[0].src}${CYCLE}
#[spacetimedb::table(accessor = cycle_row)]
pub struct CycleRow {
    pub x: A,
    pub note: String,
}
`;
    const cycleTree = [{ path: RB4_SCHEMA_PATH, src: cycleSrc }, GOOD_TREE[1]];
    const cycleBroken = rb4SelfCheck('FG73h/cycle', cycleSrc, [CYCLE], cycleSrc);
    if (cycleBroken) return cycleBroken;
    try {
      checkRekeyCompleteness(cycleTree, GOOD_ACCOUNTS);
    } catch (e) {
      return (
        'FG73h/cycle: a mutually recursive pair of bindings made the walker throw ' +
        `(${e?.message ?? String(e)}). That input does not compile and no verdict is pinned here, ` +
        'but the walk must RETURN: a throw skips every clause in this file'
      );
    }
  }

  // FG73i — the JOIN direction, which a forward-only fixture cannot see. The
  // wallet column the shipped manifest already polices is declared THROUGH a
  // binding, so before the fix the walker loses it and the reverse clause
  // reports the shipped entry as stale — a gate telling the reader to DELETE the
  // policy for a column that is right there in the schema. After the fix the
  // pair is correct and the whole checker returns PASS.
  {
    const WALLET = 'player_wallet.owner_identity';
    const DECL = 'pub type WalletOwner = Identity;';
    const base = synthSchemaSrc(SYNTH_KEYS.filter((k) => k !== WALLET));
    const src = `${base}${DECL}
#[spacetimedb::table(accessor = player_wallet)]
pub struct Row_player_wallet {
    pub owner_identity: WalletOwner,
    pub note: String,
}
`;
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const broken = rb4SelfCheck('FG73i', src, [DECL], src);
    if (broken) return broken;
    if (countOccurrences(src, '#[spacetimedb::table(accessor = player_wallet)]') !== 1) {
      return (
        'FG73i: the fixture is broken — the wallet table must be declared EXACTLY once, by hand ' +
        'and through the binding; the synthesized half must not also declare it'
      );
    }
    if (compactWs(stripRustSource(src)).indexOf('pubowner_identity:WalletOwner') === -1) {
      return (
        'FG73i: the fixture is broken — the policed column must be declared with the binding, ' +
        'never with a literal type'
      );
    }

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    if (err) {
      return (
        'FG73i: a manifest entry whose column is declared THROUGH a binding was reported as ' +
        `unresolved (or the tree was flagged for some other reason): ${err}`
      );
    }
  }

  // FG73j — the RECORD SHAPE, asserted by calling the walker DIRECTLY. That
  // record is the seam M22 consumes, so its field set is CLOSED: the declared
  // text keeps its meaning, the expansion is ALWAYS present (equal to the
  // declared text when nothing was resolved), and the bindings consulted are
  // structured data — an array of records — never prose. Every read here is
  // Object.hasOwn and the own key SET is compared exactly, so a fifth field
  // added without a deliberate edit here reds.
  {
    const DECL = 'pub type OwnerId = Identity;';
    const src = rb4Schema(`${DECL}\n`, 'OwnerId');
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const broken = rb4SelfCheck('FG73j', src, [DECL], src);
    if (broken) return broken;

    const cols = findIdentityColumns(tree);
    const direct = cols.get('account.identity');
    const optional = cols.get('account.claimed_from');
    const aliased = cols.get(RB4_COL);
    if (direct === undefined || optional === undefined) {
      return (
        'FG73j: the fixture is broken — the walk lost a column the synthesized GOOD schema ' +
        'declares literally (account.identity / account.claimed_from)'
      );
    }
    if (aliased === undefined) {
      return (
        `FG73j: the walker returned no record for the aliased column ${RB4_COL}, which this ` +
        'fixture declares through a binding that resolves to Identity'
      );
    }
    const literals = [
      ['account.identity', direct],
      ['account.claimed_from', optional],
    ];
    const shapes = literals.concat([[RB4_COL, aliased]]);
    for (const [label, rec] of shapes) {
      const keys = Object.keys(rec).sort().join(',');
      if (keys !== 'path,resolved,type,via') {
        return (
          `FG73j: the record for \`${label}\` owns the fields [${keys}]; the CLOSED set is ` +
          '[path,resolved,type,via]. M22 consumes this record across the seam freeze, so a new ' +
          'field is added here, in the same PR, on purpose'
        );
      }
      if (!Object.hasOwn(rec, 'resolved') || typeof rec.resolved !== 'string') {
        return `FG73j: the record for \`${label}\` has no own \`resolved\` string`;
      }
      if (!Object.hasOwn(rec, 'via') || !Array.isArray(rec.via)) {
        return `FG73j: the record for \`${label}\` has no own \`via\` ARRAY — never prose`;
      }
    }
    for (const [label, rec] of literals) {
      if (rec.resolved !== rec.type || rec.via.length !== 0) {
        return (
          `FG73j: \`${label}\` is declared with a literal type, so its expansion must EQUAL the ` +
          `declared text and no binding may be listed (type=${JSON.stringify(rec.type)}, ` +
          `resolved=${JSON.stringify(rec.resolved)}, via=${rec.via.length})`
        );
      }
    }
    if (optional.type !== 'Option<Identity>') {
      return (
        'FG73j: the fixture is broken — account.claimed_from must carry the Option spelling, or ' +
        `the "expansion equals declaration" pin only ever sees one shape: ${optional.type}`
      );
    }
    if (aliased.type !== 'OwnerId') {
      return (
        `FG73j: \`type\` must stay the DECLARED text (got ${JSON.stringify(aliased.type)}). A ` +
        'walker that overwrites it with the expansion silently rewrites what every consumer — ' +
        'and every G6 failure message — reports as the schema’s own text'
      );
    }
    const expanded = aliased.resolved !== aliased.type;
    const bearing = containsIdent(aliased.resolved, 'Identity');
    if (!expanded || !bearing) {
      return (
        'FG73j: the aliased column’s expansion must DIFFER from its declared text and must be ' +
        `Identity-bearing (type=${JSON.stringify(aliased.type)}, ` +
        `resolved=${JSON.stringify(aliased.resolved)})`
      );
    }
    if (aliased.via.length === 0) {
      return 'FG73j: the aliased column must list the binding(s) consulted; `via` is empty';
    }
    const viaKeys = Object.keys(aliased.via[0]).sort().join(',');
    if (viaKeys !== 'name,path,rhs') {
      return (
        `FG73j: a consulted binding owns the fields [${viaKeys}]; the CLOSED set is ` +
        '[name,path,rhs] — the name, what it resolves to, and the file that declares it are ' +
        'exactly what makes a fail-closed over-report actionable'
      );
    }
  }

  // FG73k — a `type` item that exists ONLY inside a raw string literal, under a
  // name no real declaration binds. The stripper blanks the payload, so the
  // column stays unresolved and the tree PASSES, before and after the fix. This
  // is the binding-side twin of the phantom-table defect the seam eval's walker
  // tooth exists for: a quoted declaration would inject a binding — and through
  // it a policed column — that the compiler never sees. The literal payload
  // carries NO stripper anchor, so the desync self-check stays honest instead of
  // reporting blanked real code.
  {
    const src = `${GOOD_TREE[0].src}pub const DOC: &str = r#"
pub type GhostOwner = Identity;
"#;

#[spacetimedb::table(accessor = ghost_ledger)]
pub struct GhostLedger {
    pub delegate: GhostOwner,
    pub note: String,
}
`;
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const desync = assertStripperSound(src, RB4_SCHEMA_PATH);
    if (desync) {
      return `FG73k: the fixture desynced the stripper, which invalidates it: ${desync}`;
    }
    const stripped = stripRustSource(src);
    if (src.indexOf('pub type GhostOwner = Identity;') === -1) {
      return 'FG73k: the fixture is broken — the quoted declaration is not in the raw source';
    }
    if (stripped.indexOf('GhostOwner = Identity') !== -1) {
      return (
        'FG73k: the fixture is broken — the stripper did not blank the string payload, so this ' +
        'fixture is testing an ordinary declaration rather than a quoted one'
      );
    }
    if (stripped.indexOf('pub delegate: GhostOwner,') === -1) {
      return (
        'FG73k: the fixture is broken — the COLUMN must survive stripping, or the walk has ' +
        'nothing to classify and the pass below is vacuous'
      );
    }

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    if (err) {
      return (
        'FG73k: a declaration that exists only inside a Rust string literal was collected as a ' +
        `real binding, so a column whose type the compiler cannot resolve was policed: ${err}`
      );
    }
  }

  // FG73l — AMBIENT, NON-ENUMERABLE Object.prototype pollution around the
  // resolver's own lookups; the columns-side twin of FG72c, and the regression
  // pin for the decision that the binding table is a Map. Object.defineProperty
  // with `enumerable: false` on purpose: an assignment is visible to
  // Object.keys(Object.prototype) — which the guard below already refuses to
  // clobber — while the shape that actually bites, a PLAIN OBJECT read as
  // table[name], is visible only through a property read. Two directions inside
  // ONE window, because the defect is ambient rather than injected:
  //   phantom  a column typed by a name NOTHING binds, whose prototype value is
  //            the text Identity, must NOT be reported. That is the false
  //            positive a plain-object table produces for every unknown type
  //            name in the tree, and it would put a column into the manifest key
  //            space that no schema declares.
  //   shadow   a name the tree really binds, shadowed on the prototype with a
  //            NON-Identity value, must still be reported — cross-file, so the
  //            binding and the column live in different files.
  // Neither key is `then` (a thenable prototype makes the runner await forever),
  // `path` (node's own resolver reads it), `error` or `constructor`. Cleanup is
  // in `finally`, BEFORE any return, and the post-assert proves in-process that
  // both keys are gone: every eval in this run shares one realm.
  {
    const BOUND = 'GuildRef';
    const UNBOUND = 'PhantomRef';
    const POLLUTED = [BOUND, UNBOUND];
    // Both trees are built OUTSIDE the window: they parse Rust, and nothing
    // inside the window may do work that reads a polluted name by accident.
    const shadowIds = `pub type ${BOUND} = Identity;\n`;
    const shadowSrc = rb4Schema('', BOUND);
    const idsFile = { path: RB4_IDS_PATH, src: shadowIds };
    const shadowTree = [{ path: RB4_SCHEMA_PATH, src: shadowSrc }, GOOD_TREE[1], idsFile];
    const phantomSrc = rb4Schema('', UNBOUND);
    const phantomTree = [{ path: RB4_SCHEMA_PATH, src: phantomSrc }, GOOD_TREE[1]];
    const bindingDecl = `pub type ${BOUND} = Identity;`;
    const broken =
      rb4SelfCheck('FG73l', shadowIds, [bindingDecl], shadowSrc) ??
      rb4SelfCheck('FG73l', phantomSrc, [], phantomSrc);
    if (broken) return broken;
    if (phantomSrc.indexOf(`type ${UNBOUND}`) !== -1) {
      return (
        `FG73l: the fixture is broken — \`${UNBOUND}\` must be bound NOWHERE in the tree, or the ` +
        'phantom direction is testing an ordinary resolvable column'
      );
    }
    if (POLLUTED.some((k) => k in {}) || Object.keys(Object.prototype).length !== 0) {
      return (
        `FG73l: one of [${POLLUTED.join(', ')}] — or some other enumerable property — is already ` +
        'on Object.prototype BEFORE this fixture ran (keys: ' +
        `[${Object.keys(Object.prototype).join(', ')}]) — refusing to overwrite the state of a ` +
        'co-resident eval, and refusing to delete it either'
      );
    }

    let bad = null;
    try {
      try {
        for (const [name, value] of [
          [BOUND, 'u64'],
          [UNBOUND, 'Identity'],
        ]) {
          Object.defineProperty(Object.prototype, name, {
            value,
            configurable: true,
            writable: true,
            enumerable: false,
          });
        }
      } catch (e) {
        bad = `FG73l: could not define the ambient properties: ${e?.message ?? String(e)}`;
      }
      if (bad === null && !POLLUTED.every((k) => k in {})) {
        bad =
          'FG73l: the pollution did not take — both directions below would then be testing ' +
          'nothing, and a silently-failed injection is the one way this fixture goes vacuous ' +
          'while still printing green';
      }
      if (bad === null) {
        let windowBad = null;
        if (!(BOUND in {} && UNBOUND in {})) {
          windowBad = 'FG73l: the pollution window closed early — a direction ran outside it';
        }

        const phantomErr = checkRekeyCompleteness(phantomTree, GOOD_ACCOUNTS);
        let phantomBad = null;
        if (phantomErr !== null) {
          phantomBad =
            'FG73l: a column typed by a name NOTHING in the tree binds was reported, so an ' +
            'ambient prototype value was read as if it were a binding — a plain object is not a ' +
            `binding table: ${String(phantomErr)}`;
        }

        const shadowErr = checkRekeyCompleteness(shadowTree, GOOD_ACCOUNTS);
        let shadowBad = expectTag(shadowErr, '[G6/declared]', 'FG73l');
        if (shadowBad === null && shadowErr.indexOf(RB4_COL) === -1) {
          shadowBad = `FG73l: the failure must NAME the column ${RB4_COL}: ${shadowErr}`;
        }

        if (!(BOUND in {} && UNBOUND in {})) {
          windowBad = 'FG73l: the pollution window closed early — a direction ran outside it';
        }
        bad = windowBad ?? phantomBad ?? shadowBad;
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, UNBOUND);
      Reflect.deleteProperty(Object.prototype, BOUND);
    }
    if (POLLUTED.some((k) => k in {}) || Object.keys(Object.prototype).length !== 0) {
      return (
        'FG73l: LEAKED — this fixture left a property on Object.prototype after its finally block ' +
        `ran (keys: [${Object.keys(Object.prototype).join(', ')}]). Every later eval in this run ` +
        'would see it, so a leak is a HARD failure here, not a note'
      );
    }
    if (bad) return bad;
  }

  // FG73m — the two identifier spellings a `\w`-shaped name class cannot read: a
  // RAW identifier (the escape that lets a keyword be a type name) and a
  // non-ASCII identifier (stable Rust). Both compile, and a name class that
  // stops at the first non-ASCII byte binds a TRUNCATED name that no column ever
  // mentions — a CI-clean hide.
  {
    const RAW_DECL = 'pub type r#Owner = Identity;';
    const rawSrc = rb4Schema(`${RAW_DECL}\n`, 'r#Owner');
    const rawTree = [{ path: RB4_SCHEMA_PATH, src: rawSrc }, GOOD_TREE[1]];
    const rawBroken = rb4SelfCheck('FG73m/raw', rawSrc, [RAW_DECL], rawSrc);
    if (rawBroken) return rawBroken;
    const rawErr = checkRekeyCompleteness(rawTree, GOOD_ACCOUNTS);
    const rawBad = expectTag(rawErr, '[G6/declared]', 'FG73m/raw');
    if (rawBad) return rawBad;
    if (rawErr.indexOf(RB4_COL) === -1) {
      return `FG73m/raw: the failure must NAME the column ${RB4_COL}: ${rawErr}`;
    }

    const WIDE_DECL = 'pub type Ownér = Identity;';
    const wideSrc = rb4Schema(`${WIDE_DECL}\n`, 'Ownér');
    const wideTree = [{ path: RB4_SCHEMA_PATH, src: wideSrc }, GOOD_TREE[1]];
    const wideBroken = rb4SelfCheck('FG73m/non-ascii', wideSrc, [WIDE_DECL], wideSrc);
    if (wideBroken) return wideBroken;
    const wideErr = checkRekeyCompleteness(wideTree, GOOD_ACCOUNTS);
    const wideBad = expectTag(wideErr, '[G6/declared]', 'FG73m/non-ascii');
    if (wideBad) return wideBad;
    if (wideErr.indexOf(RB4_COL) === -1) {
      return (
        'FG73m/non-ascii: a name class that stops at the first non-ASCII byte binds a truncated ' +
        `name, so the column resolves to nothing and is never reported: ${wideErr}`
      );
    }
  }

  // FG73m (continued) — the two Rust Pattern_White_Space code points that
  // JavaScript's `\s` does NOT match: U+0085 NEL and U+200E LRM. rustc accepts
  // either as the whitespace between `type` and the name it binds, or after the
  // `use` keyword, so an item spelled with one COMPILES CLEAN (a
  // `#[rustfmt::skip]` keeps rustfmt from normalising it away) and binds nothing
  // at all in a scanner whose separator class is `\s`-shaped — a CI-clean hide,
  // measured by the red-team. Each leg asserts the code point is really in the
  // fixture AND that `\s` really does not match it: without that second
  // assertion the leg silently becomes an ordinary-space fixture the day someone
  // "cleans up" the constant, and the tooth is gone with no diff to notice.
  {
    const NEL = String.fromCharCode(0x85);
    const LRM = String.fromCharCode(0x200e);
    if (/\s/.test(NEL) || /\s/.test(LRM)) {
      return (
        'FG73m/whitespace: the fixture is broken — this runtime DOES match these code points ' +
        'with `\\s`, so both legs below would pass on a scanner that never learned about them ' +
        'and this whole family would be decorative'
      );
    }

    const NEL_DECL = `#[rustfmt::skip]\npub type${NEL}OwnerId = Identity;`;
    const nelSrc = rb4Schema(`${NEL_DECL}\n`, 'OwnerId');
    const nelTree = [{ path: RB4_SCHEMA_PATH, src: nelSrc }, GOOD_TREE[1]];
    const nelBroken = rb4SelfCheck('FG73m/nel', nelSrc, [NEL_DECL], nelSrc);
    if (nelBroken) return nelBroken;
    if (nelSrc.indexOf(NEL) === -1) {
      return 'FG73m/nel: the fixture is broken — the U+0085 code point is not in the source';
    }
    const nelErr = checkRekeyCompleteness(nelTree, GOOD_ACCOUNTS);
    const nelBad = expectTag(nelErr, '[G6/declared]', 'FG73m/nel');
    if (nelBad) return nelBad;
    if (nelErr.indexOf(RB4_COL) === -1) {
      return (
        'FG73m/nel: rustc reads U+0085 as the whitespace between `type` and the name, so the item ' +
        'BINDS; a scanner whose separator class is `\\s` matches neither the space nor the name ' +
        `and collects nothing, leaving the column unresolved and unpoliced: ${nelErr}`
      );
    }

    const LRM_DECL = `use${LRM}spacetimedb::Identity as Owner;`;
    const lrmSrc = rb4Schema(`${LRM_DECL}\n`, 'Owner');
    const lrmTree = [{ path: RB4_SCHEMA_PATH, src: lrmSrc }, GOOD_TREE[1]];
    const lrmBroken = rb4SelfCheck('FG73m/lrm', lrmSrc, [LRM_DECL], lrmSrc);
    if (lrmBroken) return lrmBroken;
    if (lrmSrc.indexOf(LRM) === -1) {
      return 'FG73m/lrm: the fixture is broken — the U+200E code point is not in the source';
    }
    const lrmErr = checkRekeyCompleteness(lrmTree, GOOD_ACCOUNTS);
    const lrmBad = expectTag(lrmErr, '[G6/declared]', 'FG73m/lrm');
    if (lrmBad) return lrmBad;
    if (lrmErr.indexOf(RB4_COL) === -1) {
      return (
        'FG73m/lrm: the same code-point class after the `use` keyword hides a RENAME rather than a ' +
        '`type` item, so the rename collector has to normalise the separator too — one of the two ' +
        `scans being taught about it is exactly half a fix: ${lrmErr}`
      );
    }
  }

  // FG73n — a macro that GENERATES a type item. The resolver cannot read it (the
  // generated name is a macro metavariable, not an identifier), so the honest
  // answer is to FAIL LOUD and name the file rather than walk past a column
  // whose type is a binding nobody can see. The live tree has zero of these,
  // which is what makes a loud detector affordable.
  {
    const MACRO = `macro_rules! decl_alias {
    ($n:ident) => {
        pub type $n = Identity;
    };
}
decl_alias!(OwnerId);`;
    const src = rb4Schema(`${MACRO}\n`, 'OwnerId');
    const tree = [{ path: RB4_SCHEMA_PATH, src }, GOOD_TREE[1]];
    const stripped = stripRustSource(src);
    const hasMacro = stripped.indexOf('macro_rules!') !== -1;
    const hasGenerated = stripped.indexOf('type $') !== -1;
    if (!hasMacro || !hasGenerated) {
      return (
        'FG73n: the fixture is broken — the stripped source must carry BOTH halves of the ' +
        'macro-generated-declaration signature, or the detector has nothing to detect'
      );
    }
    const broken = rb4SelfCheck('FG73n', src, [], src);
    if (broken) return broken;

    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/alias]', 'FG73n');
    if (bad) return bad;
    if (err.indexOf(RB4_SCHEMA_PATH) === -1) {
      return (
        `FG73n: the failure must NAME the file that declares the macro (${RB4_SCHEMA_PATH}); a ` +
        `fail-closed report the reader cannot locate is a skip with extra steps: ${err}`
      );
    }
  }

  // FG73n (continued) — the two macro shapes the generated-item needle does NOT
  // catch, and that the resolver cannot read either:
  //   rhs-metavar  a macro body binds a REAL name to a metavariable, so the
  //                binding IS collected and its right-hand side expands to
  //                nothing Identity-bearing. The file carries no generated-item
  //                needle at all, so the first detector is blind to it;
  //   rhs-macro    the binding is declared at module level but its right-hand
  //                side is a macro INVOCATION, which leaves the resolver nothing
  //                to expand.
  // Both must be reported by FILE and by BINDING NAME: told only "this file has
  // a macro", a reader cannot find the column that is silently unpoliced, and a
  // fail-closed report nobody can act on is a skip with extra steps.
  {
    const META_MACRO = `macro_rules! mk_alias {
    ($t:ty) => {
        pub type OwnerId = $t;
    };
}
mk_alias!(Identity);`;
    const metaSrc = rb4Schema(`${META_MACRO}\n`, 'OwnerId');
    const metaTree = [{ path: RB4_SCHEMA_PATH, src: metaSrc }, GOOD_TREE[1]];
    const metaStripped = stripRustSource(metaSrc);
    // Two halves on purpose: written contiguously, the needle would appear in
    // this file's own source and this check could not tell it from a decoy.
    const GENERATED = 'type' + ' $';
    if (metaStripped.indexOf('macro_rules!') === -1) {
      return 'FG73n/rhs-metavar: the fixture is broken — the macro is not in the stripped source';
    }
    if (metaStripped.indexOf(GENERATED) !== -1) {
      return (
        'FG73n/rhs-metavar: the fixture is broken — the source carries the GENERATED-ITEM needle, ' +
        'so the first detector would fire and this leg would prove nothing about the second'
      );
    }
    const metaBroken = rb4SelfCheck('FG73n/rhs-metavar', metaSrc, [], metaSrc);
    if (metaBroken) return metaBroken;
    const metaErr = checkRekeyCompleteness(metaTree, GOOD_ACCOUNTS);
    const metaBad = expectTag(metaErr, '[G6/alias]', 'FG73n/rhs-metavar');
    if (metaBad) return metaBad;
    const metaNamesFile = metaErr.indexOf(RB4_SCHEMA_PATH) !== -1;
    const metaNamesBinding = metaErr.indexOf('OwnerId') !== -1;
    if (!metaNamesFile || !metaNamesBinding) {
      return (
        'FG73n/rhs-metavar: the failure must name the FILE and the BINDING whose right-hand side ' +
        `is a metavariable — a file-only report leaves the reader hunting the column: ${metaErr}`
      );
    }

    const CALL_MACRO = `macro_rules! id_ty {
    () => {
        spacetimedb::Identity
    };
}
pub type OwnerId = id_ty!();`;
    const callSrc = rb4Schema(`${CALL_MACRO}\n`, 'OwnerId');
    const callTree = [{ path: RB4_SCHEMA_PATH, src: callSrc }, GOOD_TREE[1]];
    if (callSrc.indexOf('= id_ty!()') === -1) {
      return 'FG73n/rhs-macro: the fixture is broken — the right-hand side is not a macro call';
    }
    const callBroken = rb4SelfCheck('FG73n/rhs-macro', callSrc, [], callSrc);
    if (callBroken) return callBroken;
    const callErr = checkRekeyCompleteness(callTree, GOOD_ACCOUNTS);
    const callBad = expectTag(callErr, '[G6/alias]', 'FG73n/rhs-macro');
    if (callBad) return callBad;
    const callNamesFile = callErr.indexOf(RB4_SCHEMA_PATH) !== -1;
    const callNamesBinding = callErr.indexOf('OwnerId') !== -1;
    if (!callNamesFile || !callNamesBinding) {
      return (
        'FG73n/rhs-macro: the failure must name the FILE and the BINDING whose right-hand side is ' +
        `a macro invocation, for the same reason: ${callErr}`
      );
    }
  }

  // FG73o — SELF-SOURCE ABSENCE. The resolver must be driven by the SHAPE of a
  // declaration, never by the ALIAS NAMES these fixtures happen to bind: a
  // lookup table keyed on those names passes every fixture above and resolves
  // nothing in the real tree. VERIFIED by the red-team pass — without this tooth
  // a name-keyed implementation survives the whole family. So no fixture ALIAS
  // name may appear as an identifier anywhere ABOVE the teeth: not in the
  // checker, not in the contract prose, not in a comment. The tail-side half is
  // the non-vacuity guard: a name that has fallen out of the fixtures falls out
  // of this list in the same edit, and the marker is spelled in two halves so
  // that searching for it does not find this line.
  // ALIAS names only, and deliberately not every identifier a fixture mentions:
  // `A`/`B` (FG73h's cycle) and the vendor names a GOOD control re-exports
  // cannot be listed — they occur in ordinary prose, or in this file's own
  // imports — and a name-keyed resolver could not exploit them anyway, because
  // special-casing a GOOD control's name makes that control PASS, not fail.
  // Some listed names are deliberately SHORT (`Id`, `Coins`, `Owner`): `Id` is
  // load-bearing as the prefix half of FG73f's substitution pair. If one ever
  // collides with new prose above the teeth, the fix is to reword the prose —
  // never to drop the name from this list, and never to rename the fixture.
  {
    const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const MARK = 'function run' + 'Teeth() {';
    const marks = countOccurrences(selfSrc, MARK);
    if (marks !== 1) {
      return (
        `FG73o: this file contains ${marks} occurrence(s) of the teeth function declaration; ` +
        'EXACTLY one is required, or the head/tail split this tooth is built on is undefined'
      );
    }
    const head = selfSrc.slice(0, selfSrc.indexOf(MARK));
    const tail = selfSrc.slice(selfSrc.indexOf(MARK));
    const FIXTURE_NAMES = [
      'OwnerId',
      'Owner',
      'MaybeOwner',
      'MaybeOwnerRef',
      'WhoRef',
      'Handoff',
      'GuildRef',
      'PhantomRef',
      'Coins',
      'IdentityTag',
      'Id',
      'IdKind',
      'NpcSyncPlan',
      'WalletOwner',
      'GhostOwner',
      'Ownér',
      'Stampish',
    ];
    for (const name of FIXTURE_NAMES) {
      if (containsIdent(head, name)) {
        return (
          `FG73o: the fixture ALIAS name \`${name}\` occurs as an identifier in this file ABOVE ` +
          'the ' +
          'teeth. Every name in that list is one a resolver could special-case into a lookup ' +
          'table, pass the whole FG73 family with, and still resolve nothing in the live tree — ' +
          'so the checker, its contract prose and its comments must never mention one. Rename ' +
          'the thing above the teeth (or reword the prose); never the fixture'
        );
      }
      if (!containsIdent(tail, name)) {
        return (
          `FG73o: the fixture ALIAS name \`${name}\` is listed here but is used by NO fixture ` +
          'below, so ' +
          'this tooth is guarding a name that does not exist. A name leaves the fixtures and this ' +
          'list in the same edit'
        );
      }
    }
  }

  // FG73p — the `Identity` SHADOW: a tree-wide binding of the very token this
  // gate classifies on. Two spellings, both ordinary Rust and both ONE line:
  //   type-shadow    a `type` item binding the name Identity to something else;
  //   rename-shadow  a `use … as Identity` rename of another vendor type.
  // Either makes the walker forget every literally-typed Identity column AT ONCE
  // — expand that token and all 24 columns resolve to something that is not
  // Identity, so G6/declared and G6/live both pass VACUOUSLY over an empty
  // column set and the manifest polices nothing. (G6/anchors is the backstop
  // that would eventually notice, which is exactly why the walk is pinned here
  // as an EXACT SET: a shadow that drops one column is the same defect as one
  // that drops all of them, and only the anchors' four names are hardcoded.)
  // The resolver therefore keeps `Identity` TERMINAL. Terminality alone would be
  // a SILENT recovery, so G6/alias additionally names the file: the tree still
  // contains a declaration that means something the gate refuses to honour, and
  // the next reader must be told rather than left with a quietly ignored line.
  // The BACKTICKED token is asserted, not the bare word: all three G6/alias
  // detectors share one tag, and only this one renders `Identity` as the bound
  // NAME — a bare-word check would be satisfied by either of the other two.
  {
    const SHADOW_PATH = 'fixture/shadow.rs';
    const TYPE_SHADOW = 'pub(crate) type Identity = u64;\n';
    const RENAME_SHADOW = 'use spacetimedb::ConnectionId as Identity;\n';
    const want = [...findIdentityColumns(GOOD_TREE).keys()].sort().join(',');
    if (want.split(',').length !== Object.keys(REKEY_MANIFEST).length) {
      return (
        `FG73p: the fixture is broken — the GOOD tree walks to ${want.split(',').length} ` +
        `column(s) but the manifest owns ${Object.keys(REKEY_MANIFEST).length}; an exact key-set ` +
        'comparison against a wrong (or empty) baseline proves nothing at all'
      );
    }
    if (TYPE_SHADOW.indexOf('#[spacetimedb::table(') !== -1) {
      return 'FG73p: the fixture is broken — the type-shadow file must declare no table';
    }
    if (RENAME_SHADOW.indexOf('#[spacetimedb::table(') !== -1) {
      return 'FG73p: the fixture is broken — the rename-shadow file must declare no table';
    }

    const typeTree = [GOOD_TREE[0], GOOD_TREE[1], { path: SHADOW_PATH, src: TYPE_SHADOW }];
    const typeGot = [...findIdentityColumns(typeTree).keys()].sort().join(',');
    if (typeGot !== want) {
      return (
        'FG73p/walk (type-shadow): a tree-wide `type` item binding the name Identity changed the ' +
        'walk. That token is what every column is classified on, so expanding it rewrites the ' +
        'resolved type of EVERY literally-typed column at once and the completeness clauses go ' +
        `vacuous over an empty set. It stays TERMINAL. want=[${want}] got=[${typeGot}]`
      );
    }
    const typeErr = checkRekeyCompleteness(typeTree, GOOD_ACCOUNTS);
    const typeBad = expectTag(typeErr, '[G6/alias]', 'FG73p/type-shadow');
    if (typeBad) return typeBad;
    const typeNamesFile = typeErr.indexOf(SHADOW_PATH) !== -1;
    const typeNamesToken = typeErr.indexOf('`Identity`') !== -1;
    if (!typeNamesFile || !typeNamesToken) {
      return (
        'FG73p/type-shadow: keeping the token terminal is a SILENT recovery on its own, so the ' +
        'failure must name the file AND the shadowed name (backticked, which is what separates ' +
        `this detector from the other two that share its tag): ${typeErr}`
      );
    }

    const renameTree = [GOOD_TREE[0], GOOD_TREE[1], { path: SHADOW_PATH, src: RENAME_SHADOW }];
    const renameGot = [...findIdentityColumns(renameTree).keys()].sort().join(',');
    if (renameGot !== want) {
      return (
        'FG73p/walk (rename-shadow): a `use … as Identity` rename changed the walk. A rename is a ' +
        'binding like any other, so the terminality rule has to be applied where names are ' +
        `EXPANDED, never where one kind of binding is collected. want=[${want}] got=[${renameGot}]`
      );
    }
    const renameErr = checkRekeyCompleteness(renameTree, GOOD_ACCOUNTS);
    const renameBad = expectTag(renameErr, '[G6/alias]', 'FG73p/rename-shadow');
    if (renameBad) return renameBad;
    const renameNamesFile = renameErr.indexOf(SHADOW_PATH) !== -1;
    const renameNamesToken = renameErr.indexOf('`Identity`') !== -1;
    if (!renameNamesFile || !renameNamesToken) {
      return (
        'FG73p/rename-shadow: the rename spelling must be reported by the same clause and with ' +
        `the same two facts — the file, and the shadowed name: ${renameErr}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // FG74 — NEEDLE<->KEY CORRESPONDENCE and IDENTIFIER-BOUNDED CALL MATCHING
  // (rb-25, residual R-rb-2-X10).
  //
  // THE DEFECT. [G6/consumed] asks only "does this needle appear in that body",
  // by plain indexOf, and never asks WHICH table the named helper actually
  // touches. Two measured consequences:
  //   BORROW      re-point `heal_cooldown.owner_identity`'s exists needle at
  //               `has_monsters(` and delete `has_heal_cooldown` from
  //               `account_has_game_data`: the needle is still present (another
  //               table's live helper answers for it), so the eval stays GREEN
  //               while guard 11 stops fail-closing for heal_cooldown;
  //   SUBSTRING   the needle `et_exists(` is a plain substring hit on the live
  //               `wallet_exists(` call, so a manifest can name a helper that
  //               exists nowhere and still read as consumed.
  //
  // THE RULE THESE FIXTURES PIN, in three clauses:
  //   [G6/consumed]       the needle is matched as a CALL: an identifier
  //                       boundary on its left (its own trailing `(` is the
  //                       right boundary), and an immediately-left `.` is
  //                       REJECTED, because a method call on a receiver is not a
  //                       call of the free function the manifest names.
  //   [G6/correspondence] the needle's fn name resolves to EXACTLY ONE
  //                       definition in the scanned tree, that definition has a
  //                       non-empty, cfg-free body, and the body reaches THIS
  //                       key's own table through `db.<table>(` with an
  //                       identifier boundary on `db`. The REKEY half
  //                       additionally requires a write verb in the chain
  //                       segment rooted at that token — presence is not effect.
  //   [G6/mirror]         the ONE pinned exception (monster_pub's existence is
  //                       covered by monster's, because the public projection
  //                       carries no row the private table does not) is a
  //                       SET-pinned Map, must share the covered key's exists
  //                       needle, and must still be NEEDED.
  //
  // Three tags, not one: a shared tag would let a mirror tooth be satisfied by a
  // correspondence failure and vice versa, and expectTag pins by tag alone. Each
  // tooth below therefore ALSO asserts a fragment that only its own clause can
  // produce — a tag-only pin cannot tell a hollowed clause from a neighbour
  // catching the same mutant.
  // ---------------------------------------------------------------------------
  const FIX_SCHEMA_PATH = 'fixture/schema.rs';
  const fixTree = (src) => [{ path: FIX_SCHEMA_PATH, src }, GOOD_TREE[1]];
  // Every helper substitution goes through here: `mut` replaces the FIRST hit
  // only, so a target that occurs 0 or 2 times silently mutates nothing (or the
  // wrong helper) and the tooth then reads as "the clause accepted the cheat".
  const swapHelper = (label, from, to) => {
    const hits = countOccurrences(GOOD_TREE[0].src, from);
    if (hits !== 1) {
      return {
        error:
          `${label}: the fixture substitution target occurs ${hits} time(s) in the GOOD schema ` +
          'fixture; EXACTLY one is required, or String.replace edits the wrong helper and this ' +
          'tooth goes silently vacuous',
      };
    }
    return { tree: fixTree(mut(GOOD_TREE[0].src, from, to)) };
  };

  const H_HAS_MONSTERS = `pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.monster().owner_identity().filter(owner).next().is_some()
}`;
  const H_HAS_ITEMS = `pub(crate) fn has_items(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.inventory().owner_identity().filter(owner).next().is_some()
}`;
  const H_PROFILE_EXISTS = `pub(crate) fn profile_exists(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.profile().identity().find(identity).is_some()
}`;
  const H_WALLET_EXISTS = `pub(crate) fn wallet_exists(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.player_wallet().owner_identity().find(owner).is_some()
}`;
  const H_QUEST_OR_DIALOGUE = `pub(crate) fn has_quest_or_dialogue_state(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.player_quest().owner_identity().filter(owner).next().is_some()
        || ctx.db.player_dialogue_state().owner_identity().find(owner).is_some()
}`;
  const H_REKEY_INVENTORY = `pub(crate) fn rekey_inventory(ctx: &ReducerContext, from: Identity, to: Identity) {
    let ids: Vec<u64> = ctx.db.inventory().owner_identity().filter(from).map(|r| r.inv_id).collect();
    for id in ids {
        if let Some(mut row) = ctx.db.inventory().inv_id().find(id) {
            row.owner_identity = to;
            ctx.db.inventory().inv_id().update(row);
        }
    }
}`;
  const H_PUB_UPDATE = '        ctx.db.monster_pub().monster_id().update(pub_row);\n';

  // FG74/fixture — the helper library must be REAL, SINGLY-DEFINED and
  // ASYMMETRIC before any tooth below means anything. A library that declared a
  // name twice would red every correspondence tooth for the WRONG reason, and one
  // whose `has_monsters` also read `monster_pub` would make FG74n and FG74p
  // vacuous — there would be nothing left for the mirror exception to excuse.
  {
    const stripped = stripRustSource(GOOD_TREE[0].src);
    const helperBody = (name) => {
      const span = findFnBody(stripped, name);
      return span === null ? null : compactWs(stripped.slice(span.start, span.end));
    };
    const NAMES = [
      'rekey_monsters',
      'has_monsters',
      'monster_rows_present',
      'rekey_inventory',
      'has_items',
      'rekey_npc_state',
      'has_quest_or_dialogue_state',
      'rekey_heal_cooldown',
      'has_heal_cooldown',
      'rekey_wallet',
      'wallet_exists',
      'rekey_profile',
      'profile_exists',
    ];
    for (const name of NAMES) {
      const defs = countOccurrences(stripped, `fn ${name}`);
      if (defs !== 1) {
        return (
          `FG74/fixture: the GOOD schema fixture declares \`fn ${name}\` ${defs} time(s); EXACTLY ` +
          'one is required. A helper library missing a name, or declaring one twice, reds every ' +
          'correspondence tooth below for a reason that has nothing to do with the clause'
        );
      }
      const body = helperBody(name);
      if (body === null || body === '') {
        return (
          `FG74/fixture: \`fn ${name}\` in the GOOD schema fixture has no locatable, non-empty ` +
          'body, so the definition-resolving clause would fail-close on the GOOD control'
        );
      }
    }
    const hasMonstersBody = helperBody('has_monsters');
    const rekeyMonstersBody = helperBody('rekey_monsters');
    if (hasMonstersBody.indexOf('db.monster(') === -1) {
      return (
        'FG74/fixture: the fixture `has_monsters` must READ `db.monster(`, or FG74p proves ' +
        'nothing at all'
      );
    }
    if (hasMonstersBody.indexOf('db.monster_pub(') !== -1) {
      return (
        'FG74/fixture: the fixture `has_monsters` must NOT touch `db.monster_pub(`. That ' +
        'asymmetry — the private table carries every row the public projection does, so the ' +
        'existence predicate never needs the projection — is the ENTIRE reason the mirror ' +
        'exception exists; a fixture that erases it makes FG74n and FG74p vacuous'
      );
    }
    if (
      rekeyMonstersBody.indexOf('db.monster(') === -1 ||
      rekeyMonstersBody.indexOf('db.monster_pub(') === -1
    ) {
      return (
        'FG74/fixture: the fixture `rekey_monsters` must write BOTH `db.monster(` and ' +
        '`db.monster_pub(` — the rekey half carries no exception, and FG74m depends on the ' +
        'monster_pub write being there to delete'
      );
    }
    if (compactWs(stripRustSource(GOOD_ACCOUNTS)).indexOf('monster_rows_present(') === -1) {
      return (
        'FG74/fixture: `account_has_game_data` must also call `monster_rows_present(`, or FG74o ' +
        'has no legal alternative predicate to re-point the mirror at and the same-needle clause ' +
        'ships untoothed'
      );
    }
  }

  // FG74a — CONTROL. The shipped manifest, the GOOD tree now carrying the shared
  // helper library, and the GOOD accounts stand-in must PASS. An always-red
  // correspondence clause is indistinguishable from a working one.
  {
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS);
    if (err) {
      return `FG74a: the GOOD tree carrying the shared helper library was flagged: ${err}`;
    }
  }

  // FG74b — ATTACK-1, the X10 criterion VERBATIM. `heal_cooldown.owner_identity`
  // borrows ANOTHER table's live existence predicate and its own delegation is
  // deleted from `account_has_game_data`. The borrowed needle IS present, so
  // [G6/consumed] structurally cannot see this — which is why the tag is asserted
  // NEGATIVELY as well as positively.
  {
    const accounts = mut(
      GOOD_ACCOUNTS,
      '        || crate::raising::has_heal_cooldown(ctx, identity)\n',
      '',
    );
    const manifest = {
      ...REKEY_MANIFEST,
      'heal_cooldown.owner_identity': {
        policy: 'REKEY',
        rekey: 'rekey_heal_cooldown(',
        exists: 'has_monsters(',
      },
    };
    const err = checkRekeyCompleteness(GOOD_TREE, accounts, manifest);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74b');
    if (bad) return bad;
    if (err.indexOf('[G6/consumed]') !== -1) {
      return (
        'FG74b: [G6/consumed] must NOT be the clause that fires here. The borrowed needle IS ' +
        'present in account_has_game_data — that is the whole defect — so a consumption failure ' +
        `would mean the fixture, not the gate, is what changed: ${err}`
      );
    }
    if (err.indexOf('db.heal_cooldown(') === -1) {
      return (
        'FG74b: the failure must name the accessor token the borrowed helper never reaches, ' +
        'db.heal_cooldown( — a report that does not say WHICH table is unproven is not ' +
        `actionable: ${err}`
      );
    }
    if (err.indexOf('has_monsters') === -1 || err.indexOf('heal_cooldown.owner_identity') === -1) {
      return (
        'FG74b: the failure must name BOTH the manifest key `heal_cooldown.owner_identity` and ' +
        `the helper it borrowed, has_monsters: ${err}`
      );
    }
  }

  // FG74c — ATTACK-2, the substring half of the criterion. `et_exists(` is a
  // plain-indexOf hit inside the live `wallet_exists(` call site, so a manifest
  // may name a helper that exists nowhere and still read as consumed.
  // THE TAG IS LOAD-BEARING: a hollowed containsCallOf would still be caught by
  // [G6/correspondence] ("no `fn et_exists` is declared anywhere"), which is a
  // DIFFERENT clause; pinning only "some error" would mask the regression.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'player_wallet.owner_identity': {
        policy: 'REKEY',
        rekey: 'rekey_wallet(',
        exists: 'et_exists(',
      },
    };
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/consumed]', 'FG74c');
    if (bad) return bad;
    // BACKTICKED on purpose: the bare token `et_exists(` is itself a substring of
    // `wallet_exists(`, so a bare-token assertion would be satisfied by a message
    // that quotes the WRONG needle — the same substring bug, inside the tooth.
    if (err.indexOf('`et_exists(`') === -1) {
      return (
        'FG74c: the failure must quote the needle as `et_exists(` — the manifest names a helper ' +
        `that is only a SUBSTRING of the live call, and the reader has to be shown which: ${err}`
      );
    }
  }

  // FG74d — the same substring cheat on the REKEY half (anti-monoculture: two
  // call sites, two indexOf tests, and a fix applied to only one of them is a
  // half-closed hole). `ekey_wallet(` sits inside the live `rekey_wallet(`
  // delegation with the word character `r` on its left.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'player_wallet.owner_identity': {
        policy: 'REKEY',
        rekey: 'ekey_wallet(',
        exists: 'wallet_exists(',
      },
    };
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/consumed]', 'FG74d');
    if (bad) return bad;
    if (err.indexOf('`ekey_wallet(`') === -1) {
      return (
        'FG74d: the failure must quote the REKEY-half needle as `ekey_wallet(`. The two halves ' +
        `are separate tests, so both must be matched as identifier-bounded calls: ${err}`
      );
    }
  }

  // FG74e — a `.`-prefixed hit is not a call of the free function the manifest
  // names. `wallet_probe(ctx).wallet_exists(identity)` invokes SOME method on SOME
  // receiver; the crate-level `economy::wallet_exists` may be gone entirely.
  // Kills: a left-boundary test written with isWordChar alone — `.` is not a word
  // character, so the method call satisfies it.
  {
    const accounts = mut(
      GOOD_ACCOUNTS,
      '        || crate::economy::wallet_exists(ctx, identity)\n',
      '        || wallet_probe(ctx).wallet_exists(identity)\n',
    );
    const err = checkRekeyCompleteness(GOOD_TREE, accounts);
    const bad = expectTag(err, '[G6/consumed]', 'FG74e');
    if (bad) return bad;
    if (err.indexOf('`wallet_exists(`') === -1 || err.indexOf(HAS_GAME_DATA_FN) === -1) {
      return (
        'FG74e: the failure must quote the needle as `wallet_exists(` and name ' +
        `${HAS_GAME_DATA_FN} as the site that no longer calls it: ${err}`
      );
    }
  }

  // FG74f — a needle naming a fn that is declared NOWHERE in the scanned tree.
  // The needle is wired into account_has_game_data on purpose, so [G6/consumed] is
  // satisfied and only the definition-resolving clause can fire. Fail LOUD:
  // "helper not found, skip this entry" is a silent hole the size of the manifest.
  {
    const accounts = mut(
      GOOD_ACCOUNTS,
      '        || crate::raising::has_heal_cooldown(ctx, identity)\n',
      '        || crate::raising::never_wired_helper(ctx, identity)\n',
    );
    const manifest = {
      ...REKEY_MANIFEST,
      'heal_cooldown.owner_identity': {
        policy: 'REKEY',
        rekey: 'rekey_heal_cooldown(',
        exists: 'never_wired_helper(',
      },
    };
    const err = checkRekeyCompleteness(GOOD_TREE, accounts, manifest);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74f');
    if (bad) return bad;
    if (err.indexOf('declared anywhere') === -1 || err.indexOf('never_wired_helper') === -1) {
      return (
        'FG74f: the failure must say the fn is not `declared anywhere` in the scanned sources AND ' +
        `name it (never_wired_helper) — an unresolvable needle is a fail-CLOSED case: ${err}`
      );
    }
  }

  // FG74g — FIRST-HIT ANCHOR FORGERY. A decoy `fn has_monsters` is declared in a
  // file that sits BEFORE the real one in the scanned tree, with a body touching a
  // DIFFERENT table. A resolver that takes the first definition it finds reads the
  // decoy and the real asymmetry becomes invisible; the COUNT is the assertion.
  {
    const DECOY = `pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.heal_cooldown().owner_identity().find(owner).is_some()
}
`;
    const tree = [{ path: 'fixture/decoy.rs', src: DECOY }, GOOD_TREE[0], GOOD_TREE[1]];
    const err = checkRekeyCompleteness(tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74g');
    if (bad) return bad;
    if (err.indexOf('declared 2') === -1 || err.indexOf('has_monsters') === -1) {
      return (
        'FG74g: the failure must report that `has_monsters` is `declared 2` times. A resolver ' +
        'that anchors on the FIRST definition can be steered by a decoy declared earlier in the ' +
        `tree, so the count is asserted, never the hit: ${err}`
      );
    }
  }

  // FG74h — a declared helper with an EMPTY body. `fn X(..) -> bool { }` resolves,
  // has a locatable body, and reaches no table at all; without a distinct
  // empty-body leg the reader is told "does not touch db.profile(" about a
  // function that does not touch ANYTHING.
  {
    const swapped = swapHelper(
      'FG74h',
      H_PROFILE_EXISTS,
      'pub(crate) fn profile_exists(ctx: &ReducerContext, identity: Identity) -> bool { }',
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74h');
    if (bad) return bad;
    if (err.indexOf('EMPTY body') === -1 || err.indexOf('profile_exists') === -1) {
      return (
        'FG74h: an empty helper body must be reported as an `EMPTY body` and by NAME ' +
        `(profile_exists), distinctly from "reaches the wrong table": ${err}`
      );
    }
  }

  // FG74i — a table token that NEVER COMPILES. `#[cfg(any())]` is unconditionally
  // false, so the nested fn is dead text; a scan that only asks "does the token
  // appear in the body" is satisfied by it, and the X10 borrow cheat is restored
  // green by adding four lines that can never run.
  {
    const swapped = swapHelper(
      'FG74i',
      H_HAS_ITEMS,
      `pub(crate) fn has_items(ctx: &ReducerContext, owner: Identity) -> bool {
    #[cfg(any())]
    fn dead_probe(ctx: &ReducerContext, owner: Identity) -> bool {
        ctx.db.inventory().owner_identity().filter(owner).next().is_some()
    }
    false
}`,
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74i');
    if (bad) return bad;
    if (err.indexOf('cfg(') === -1 || err.indexOf('has_items') === -1) {
      return (
        'FG74i: a helper body carrying a `cfg(` attribute must be reported as such, and by NAME ' +
        '(has_items). A token inside a cfg(any()) item is text that never compiles, so it can ' +
        `never satisfy the correspondence rule: ${err}`
      );
    }
  }

  // FG74j — WRONG RECEIVER. `probe.player_wallet()` is a same-named method on
  // some other value, not a table accessor reached from the database handle.
  // Kills: the token spelled `.{table}(`, which ANY receiver satisfies. The token
  // is rooted at `db.` precisely so the aliased `let db = &ctx.db;` form still
  // passes while this one does not.
  {
    const swapped = swapHelper(
      'FG74j',
      H_WALLET_EXISTS,
      `pub(crate) fn wallet_exists(ctx: &ReducerContext, owner: Identity) -> bool {
    let probe = wallet_probe(ctx);
    probe.player_wallet().owner_identity().find(owner).is_some()
}`,
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74j');
    if (bad) return bad;
    if (err.indexOf('db.player_wallet(') === -1 || err.indexOf('wallet_exists') === -1) {
      return (
        'FG74j: the failure must name the db-rooted token `db.player_wallet(` and the helper ' +
        `(wallet_exists) that only reaches a same-named method on another receiver: ${err}`
      );
    }
  }

  // FG74k — the token present ONLY inside a `//` comment and a string literal.
  // Proves the correspondence scan reads STRIPPED source, exactly as every other
  // clause in this file does. `player_quest` is left intact, so the failure must
  // be about `player_dialogue_state` ALONE — the table is resolved per KEY, not
  // per helper.
  {
    const swapped = swapHelper(
      'FG74k',
      H_QUEST_OR_DIALOGUE,
      `pub(crate) fn has_quest_or_dialogue_state(ctx: &ReducerContext, owner: Identity) -> bool {
    // also reads ctx.db.player_dialogue_state().owner_identity()
    let note = "ctx.db.player_dialogue_state().owner_identity()";
    let _ = note;
    ctx.db.player_quest().owner_identity().filter(owner).next().is_some()
}`,
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74k');
    if (bad) return bad;
    if (
      err.indexOf('db.player_dialogue_state(') === -1 ||
      err.indexOf('player_dialogue_state.owner_identity') === -1
    ) {
      return (
        'FG74k: a token that survives only in a comment and a string literal must NOT satisfy the ' +
        'clause; the failure must name the key `player_dialogue_state.owner_identity` and the ' +
        `token db.player_dialogue_state(. A RAW-text scan is green on this fixture: ${err}`
      );
    }
    if (err.indexOf('player_quest.owner_identity') !== -1) {
      return (
        'FG74k: `player_quest.owner_identity` is still genuinely reached by this helper, so it ' +
        `must NOT be the key reported — the table is resolved per KEY, not per helper: ${err}`
      );
    }
  }

  // FG74l — PRESENCE IS NOT EFFECT. `rekey_inventory` reduced to a bare read
  // still mentions its own table, so a token-presence rule passes it while the
  // guest's inventory rows are never moved and orphan on every successful claim.
  // MEASURED as a working bypass against the presence-only draft of this clause.
  {
    const swapped = swapHelper(
      'FG74l',
      H_REKEY_INVENTORY,
      `pub(crate) fn rekey_inventory(ctx: &ReducerContext, from: Identity, to: Identity) {
    let _ = to;
    let _seen = ctx.db.inventory().owner_identity().filter(from).next().is_some();
}`,
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74l');
    if (bad) return bad;
    if (err.toLowerCase().indexOf('write') === -1) {
      return (
        'FG74l: the REKEY half must demand a WRITE, and say so. A re-key helper that only READS ' +
        `its own table carries the rows nowhere: ${err}`
      );
    }
    if (err.indexOf('db.inventory(') === -1 || err.indexOf('rekey_inventory') === -1) {
      return (
        'FG74l: the failure must name the token `db.inventory(` and the helper (rekey_inventory) ' +
        `whose access to it never writes: ${err}`
      );
    }
  }

  // FG74m — the READ/WRITE SPLIT, and the proof that the mirror exception covers
  // the EXISTS half ONLY. `rekey_monsters` keeps its `monster_pub` READ (the
  // dual-write tier lookup) but loses the `.update(`, so the public projection
  // keeps naming the abandoned guest identity while the private row moves.
  // Kills: applying the exception map to the rekey half, and a write-verb search
  // that is not bounded to the chain segment rooted at THIS accessor — the
  // neighbouring `db.monster()....update(` would otherwise be misattributed.
  {
    const swapped = swapHelper('FG74m', H_PUB_UPDATE, '');
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74m');
    if (bad) return bad;
    if (err.indexOf('monster_pub.owner_identity') === -1) {
      return (
        'FG74m: the failure must name `monster_pub.owner_identity` — the mirror exception excuses ' +
        `that key's EXISTS half and NOTHING about its rekey half: ${err}`
      );
    }
    if (err.indexOf('db.monster_pub(') === -1 || err.toLowerCase().indexOf('write') === -1) {
      return (
        'FG74m: the failure must name the token `db.monster_pub(` and report the missing WRITE. A ' +
        'write-verb search that scans the whole body instead of the chain segment rooted at this ' +
        `accessor is satisfied by the neighbouring monster update: ${err}`
      );
    }
  }

  // FG74n — a STALE exception. The fixture `has_monsters` is extended to read
  // `monster_pub` too, so the covered key now passes the strict check on its own
  // and the excuse is dead. An amnesty that outlives its justification is how a
  // one-row exception quietly becomes a general one.
  {
    const swapped = swapHelper(
      'FG74n',
      H_HAS_MONSTERS,
      `pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db.monster().owner_identity().filter(owner).next().is_some()
        || ctx.db.monster_pub().owner_identity().filter(owner).next().is_some()
}`,
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/mirror]', 'FG74n');
    if (bad) return bad;
    if (err.indexOf('no longer need') === -1) {
      return (
        'FG74n: a covered key that now passes the strict check must be reported as one the ' +
        'exception NO LONGER NEEDS — that wording is the instruction to DELETE the map row: ' +
        err
      );
    }
    if (err.indexOf('monster_pub.owner_identity') === -1) {
      return `FG74n: the stale-exception failure must NAME the excused key: ${err}`;
    }
  }

  // FG74o — the SAME-NEEDLE clause, the load-bearing half of the mirror. The
  // exception is sound ONLY because the cover is the SAME predicate: monster and
  // monster_pub share `has_monsters(`, so the excused key is transitively
  // strict-checked by the cover's own entry in the main loop. Re-point the cover
  // at a DIFFERENT (perfectly legal, genuinely wired, genuinely monster-reading)
  // predicate and that argument collapses — monster_pub is then excused by a
  // check nobody performs on its behalf.
  {
    const manifest = {
      ...REKEY_MANIFEST,
      'monster.owner_identity': {
        policy: 'REKEY',
        rekey: 'rekey_monsters(',
        exists: 'monster_rows_present(',
      },
    };
    const err = checkRekeyCompleteness(GOOD_TREE, GOOD_ACCOUNTS, manifest);
    const bad = expectTag(err, '[G6/mirror]', 'FG74o');
    if (bad) return bad;
    if (err.indexOf('share') === -1) {
      return (
        'FG74o: the failure must say the excused key and its cover no longer SHARE an existence ' +
        `predicate — that shared predicate IS the safety argument for the exception: ${err}`
      );
    }
    if (
      err.indexOf('monster_pub.owner_identity') === -1 ||
      err.indexOf('monster_rows_present(') === -1
    ) {
      return (
        'FG74o: the failure must name the excused key `monster_pub.owner_identity` and the ' +
        `predicate its cover was re-pointed at, monster_rows_present(: ${err}`
      );
    }
  }

  // FG74p — THE COVER IS NOT A BLANKET. `has_monsters` loses `db.monster(`
  // entirely. `monster.owner_identity` must red — the exception excuses
  // monster_pub, never the shared NEEDLE, and never the covering key itself.
  // Kills: an exception implemented as "skip any key whose exists needle is
  // has_monsters(", which is what a needle-keyed (rather than key-keyed) map
  // degenerates into.
  {
    const swapped = swapHelper(
      'FG74p',
      H_HAS_MONSTERS,
      `pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    let _ = owner;
    false
}`,
    );
    if (swapped.error) return swapped.error;
    const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
    const bad = expectTag(err, '[G6/correspondence]', 'FG74p');
    if (bad) return bad;
    // The NEGATIVE leg is asserted on the ACCESSOR TOKEN, not on the bare word
    // `monster_pub`: a correspondence message is free to mention the exception in
    // passing, but it can only quote `db.monster_pub(` when monster_pub is the key
    // it is actually reporting.
    if (err.indexOf('db.monster_pub(') !== -1) {
      return (
        'FG74p: `monster_pub.owner_identity` is the EXCUSED key and must not be the one reported ' +
        'here; the covering key `monster.owner_identity` is the one that lost its table: ' +
        err
      );
    }
    if (err.indexOf('monster.owner_identity') === -1 || err.indexOf('db.monster(') === -1) {
      return (
        'FG74p: the failure must name `monster.owner_identity` and the token `db.monster(` it no ' +
        `longer reaches — the exception covers ONE key, not the needle two keys share: ${err}`
      );
    }
  }

  // FG74q — AMBIENT prototype pollution against the exception map. Every eval in
  // a `just ci` run shares ONE realm under evals/run.mjs, so a co-resident eval's
  // `Object.prototype['inventory.owner_identity']` is readable through the chain
  // of any plain object. A Map has no such chain; this fixture is the REGRESSION
  // PIN that keeps it one, and that a future rewrite to an object literal read as
  // `COVER[key]` cannot pass. The key is HOLLOWED at the same time, so an ambient
  // excuse would be the only thing standing between the tree and a failure.
  // The write is REAL, for FG72c's reason: an ambient defect cannot be injected
  // through Object.create — the map under test is this module's own binding. The
  // hygiene is therefore mechanical: refuse to clobber a pre-existing key, assign
  // INSIDE the try, delete in `finally`, and prove in-process that the window was
  // still open when the check ran and closed afterwards.
  {
    const KEY = 'inventory.owner_identity';
    const COVER = 'monster.owner_identity';
    const swapped = swapHelper(
      'FG74q',
      H_HAS_ITEMS,
      `pub(crate) fn has_items(ctx: &ReducerContext, owner: Identity) -> bool {
    let _ = owner;
    false
}`,
    );
    if (swapped.error) return swapped.error;
    if (KEY in {} || Object.keys(Object.prototype).length !== 0) {
      return (
        `FG74q: \`${KEY}\` — or some other enumerable property — is already on Object.prototype ` +
        `BEFORE this fixture ran (keys: [${Object.keys(Object.prototype).join(', ')}]). Refusing ` +
        'to overwrite the state of a co-resident eval, and refusing to delete it either'
      );
    }
    let bad = null;
    try {
      try {
        Object.prototype[KEY] = COVER;
      } catch (e) {
        bad = `FG74q: could not write Object.prototype: ${e?.message ?? String(e)}`;
      }
      if (bad === null && !(KEY in {})) {
        bad =
          'FG74q: the pollution did not take, so this fixture would be testing nothing while ' +
          'still printing green';
      }
      if (bad === null) {
        const err = checkRekeyCompleteness(swapped.tree, GOOD_ACCOUNTS);
        bad = expectTag(err, '[G6/correspondence]', 'FG74q');
        if (bad === null && err.indexOf('inventory.owner_identity') === -1) {
          bad =
            'FG74q: the failure must NAME the hollowed key `inventory.owner_identity` — an ' +
            `ambient prototype entry must not be able to excuse it: ${err}`;
        }
        if (bad === null && !(KEY in {})) {
          bad = 'FG74q: the pollution window closed early — the check above ran outside it';
        }
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, KEY);
    }
    if (KEY in {} || Object.keys(Object.prototype).length !== 0) {
      return (
        'FG74q: LEAKED — this fixture left an enumerable own property on Object.prototype after ' +
        `its finally block ran (keys: [${Object.keys(Object.prototype).join(', ')}]). Every later ` +
        'eval in this run would see it, so a leak is a HARD failure here, not a note'
      );
    }
    if (bad) return bad;
  }

  // FG74r — the exception is pinned as an EXACT SET, not as a membership or a
  // shape. MEASURED on the plan: the manifest carries a SECOND pair of REKEY keys
  // sharing one exists needle (player_quest / player_dialogue_state), so a map
  // that merely "looks right" admits a second row, hollows the other predicate,
  // and passes every policing clause while the detail still says one exception.
  // A one-row amnesty is reviewable; an extensible one is not.
  {
    if (!(EXISTS_COVER instanceof Map)) {
      return (
        'FG74r: EXISTS_COVER must be a Map. A plain object carries a prototype chain, and this ' +
        'file already learned (FG72a-f) that an ambient key on that chain answers membership ' +
        'questions nobody asked'
      );
    }
    const rendered = [...EXISTS_COVER.entries()].map((e) => `${e[0]} => ${e[1]}`).join(' | ');
    const WANT = 'monster_pub.owner_identity => monster.owner_identity';
    if (EXISTS_COVER.size !== 1 || rendered !== WANT) {
      return (
        `FG74r: the mirror exception is pinned to EXACTLY [${WANT}] but reads [${rendered}] ` +
        `(size ${EXISTS_COVER.size}). This is a SET pin, never a membership or a shape test: the ` +
        'manifest has a second REKEY pair sharing one exists needle, so a second row here is a ' +
        'silent, general amnesty. Widening it costs a deliberate edit HERE, reviewed as a set'
      );
    }
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
  // Labels of the LIVE-TREE borrow proofs that actually BIT (built below). The
  // success detail reports this LENGTH, never a literal: a hand-written "N proofs
  // bit" keeps printing after the clause it describes has been deleted, which is
  // exactly the forgeable prose this block exists to replace.
  const borrowProofsBit = [];

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
    if (errG6) {
      failures.push(`[G6 rekey-completeness] ${errG6}`);
    } else {
      // ---------------------------------------------------------------------
      // LIVE-TREE BORROW PROOFS (rb-25).
      //
      // Every FG74 tooth measures the FIXTURE, and the fixture lives in the same
      // file an attacker edits: MEASURED on the plan, one added line in the
      // helper library re-greened the X10 borrow cheat with every tooth still
      // passing. So the criterion is re-proven HERE, against the SHIPPED sources
      // and the SHIPPED manifest, where the only way to make a probe stop biting
      // is to break the real gate or the real tree. Each probe must RED, and must
      // red under its OWN tag; a probe that passes is a failure of this eval.
      //
      // Borrowed manifests are built by spread-copy — the shipped export is
      // frozen and is the input to every other clause in this run.
      // ---------------------------------------------------------------------
      const borrowed = (key, half, needle) => ({
        ...REKEY_MANIFEST,
        [key]: { ...REKEY_MANIFEST[key], [half]: needle },
      });
      // A one-hit-only live-source edit. String.replace rewrites the FIRST match,
      // and `ctx.db.inventory().inv_id().update(row);` occurs TWICE in
      // inventory.rs (consume_one has the same line), so an unanchored target
      // would mutate the wrong function and the probe would read as "the gate
      // accepted the cheat" while nothing under test had changed.
      const mutateLive = (label, suffix, from, to) => {
        const target = treeSrcs.find((f) => f.path.endsWith(suffix));
        if (!target) {
          return {
            error: `${label}: ${suffix} is not in the scanned tree, so this proof cannot run`,
          };
        }
        const hits = countOccurrences(target.src, from);
        if (hits !== 1) {
          return {
            error:
              `${label}: the mutation target occurs ${hits} time(s) in ${target.path}; ` +
              'EXACTLY one is required. A 0-hit target mutates nothing and a 2-hit target mutates ' +
              'the wrong call site — either way the probe stops proving anything while still ' +
              'reporting a bite. Re-anchor the target in the same PR that moves the code',
          };
        }
        return {
          srcs: treeSrcs.map((f) =>
            f === target ? { path: f.path, src: f.src.replace(from, to) } : f,
          ),
        };
      };

      const L4 = mutateLive(
        'L4',
        '/inventory.rs',
        '            row.owner_identity = to;\n            ctx.db.inventory().inv_id().update(row);\n',
        '            row.owner_identity = to;\n',
      );
      const L5 = mutateLive(
        'L5',
        '/monster_mgmt.rs',
        'pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {\n',
        'pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {\n' +
          '    let _twin = ctx.db.monster_pub().owner_identity().filter(owner).next();\n',
      );
      for (const built of [L4, L5]) {
        if (built.error) failures.push(`[G6 borrow-proof] ${built.error}`);
      }

      const probes = [];
      probes.push({
        label:
          'L1 heal_cooldown.owner_identity.exists re-pointed at another table’s live helper ' +
          'has_monsters( (the X10 criterion, verbatim)',
        tag: '[G6/correspondence]',
        srcs: treeSrcs,
        manifest: borrowed('heal_cooldown.owner_identity', 'exists', 'has_monsters('),
      });
      probes.push({
        label: 'L2 inventory.owner_identity.rekey re-pointed at rekey_monsters(',
        tag: '[G6/correspondence]',
        srcs: treeSrcs,
        manifest: borrowed('inventory.owner_identity', 'rekey', 'rekey_monsters('),
      });
      probes.push({
        label:
          'L3 player_wallet.owner_identity.exists set to et_exists(, a bare SUBSTRING of the live ' +
          'wallet_exists( call',
        tag: '[G6/consumed]',
        srcs: treeSrcs,
        manifest: borrowed('player_wallet.owner_identity', 'exists', 'et_exists('),
      });
      if (L4.srcs) {
        probes.push({
          label: 'L4 the LIVE rekey_inventory reduced to a read (its .update( deleted in memory)',
          tag: '[G6/correspondence]',
          srcs: L4.srcs,
          manifest: REKEY_MANIFEST,
        });
      }
      if (L5.srcs) {
        probes.push({
          label:
            'L5 the LIVE has_monsters extended to read monster_pub, which makes the mirror ' +
            'exception stale',
          tag: '[G6/mirror]',
          srcs: L5.srcs,
          manifest: REKEY_MANIFEST,
        });
      }

      for (const probe of probes) {
        let got;
        try {
          got = checkRekeyCompleteness(probe.srcs, accountsFile.src, probe.manifest);
        } catch (e) {
          failures.push(
            `[G6 borrow-proof] ${probe.label}: the checker THREW instead of returning a tagged ` +
              `failure: ${e?.message ?? String(e)}`,
          );
          continue;
        }
        if (got === null) {
          failures.push(
            `[G6 borrow-proof] ${probe.label}: did NOT bite — the gate PASSED a manifest/tree ` +
              `pair it must reject with ${probe.tag}. The FG74 teeth measure the in-file fixture, ` +
              'so this probe is the only thing that proves the clause bites on the SHIPPED tree',
          );
          continue;
        }
        if (got.indexOf(probe.tag) === -1) {
          failures.push(
            `[G6 borrow-proof] ${probe.label}: bit under the WRONG clause (expected ${probe.tag}) ` +
              `— a probe that reds for a neighbouring reason proves nothing about its own: ${got}`,
          );
          continue;
        }
        borrowProofsBit.push(probe.label);
      }

      // L6 CONTROL. Re-asserted here rather than inherited from errG6 above, so
      // that "every probe red" can never be satisfied by a gate that reds on
      // EVERYTHING (which would make L1-L5 unanimous and meaningless).
      const control = checkRekeyCompleteness(treeSrcs, accountsFile.src, { ...REKEY_MANIFEST });
      if (control !== null) {
        failures.push(
          '[G6 borrow-proof] L6 CONTROL: the SHIPPED manifest over the SHIPPED tree must PASS. ' +
            'Without it, an always-red gate satisfies every probe above: ' +
            control,
        );
      }
    }
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

  // G6 passed above, so the shipped manifest classifies cleanly; count REKEY
  // from the classifier's verdicts, never from a second reading of the data
  // (the error branch is unreachable here and exists so a future reordering
  // can never turn this line into a TypeError on the success path).
  const shipped = classifyManifest(REKEY_MANIFEST);
  const rekeyEntries = Object.hasOwn(shipped, 'error')
    ? 0
    : [...shipped.kinds.values()].filter((p) => p.kind === 'REKEY').length;
  return {
    name,
    pass: true,
    detail:
      `${treeSrcs.length} non-test server source file(s) scanned (stripper soundness proven on ` +
      `each); [R/shape-closed] [R/planned-pinned] [R/s3-ready] accounts.rs declares EXACTLY the ` +
      `REQUIRED ledger set [${requiredReducerNames(REDUCER_SANCTIONS).join(', ')}] (plus, when ` +
      `M22 S3 lands it, the ` +
      `PLANNED [${PLANNED_PIN.join(', ')}]) with wire-safe ` +
      'arguments and no Identity constructor, on_connect takes the anonymous path first and never ' +
      'returns Err, the issuer and audience allowlists are both checked (with the right consts) ' +
      `before any account insert, no server RNG, writes confined to {${OWNED_TABLES.join(', ')}}, ` +
      'the claim code is consumed exactly once for the guest at brace-depth 0 of the success ' +
      `region, and all ${Object.keys(REKEY_MANIFEST).length} Identity columns carry a D6 policy ` +
      `(${rekeyEntries} REKEY entries consumed by both rekey_all and account_has_game_data, ` +
      `each REKEY helper proven to touch its own table across ${treeSrcs.length} scanned ` +
      `source(s) and matched as an identifier-bounded call, ` +
      `${borrowProofsBit.length} live-tree borrow proof(s) bit, ` +
      `${EXISTS_COVER.size} mirror-covered exception(s) pinned) ` +
      '(118 teeth verified)',
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
