// Account privacy eval (M21c T1/T2 — ADR-0179 G1 ACCOUNT_TABLES_PRIVATE and
// G12 NO_PII_IN_REJECT_LOGS / AUTH-36).
//
// The three M21 account tables (`account`, `guest_claim`,
// `guest_claim_reaper_schedule`) are PRIVATE, and the client reads exactly ONE
// of them through exactly ONE owner-scoped `#[spacetimedb::view]` named
// `my_account`, whose body is pinned to the sender-keyed unique-index lookup.
// Separately, the connect path may never write a JWT claim (`iss`/`aud`/`sub`)
// into the structured reject log.
//
// VERIFIED SEMANTICS (re-checked against the live tree at authoring time):
//   * `guest_claim_reaper_schedule` is declared in accounts.rs:489, NOT in
//     schema.rs (the ADR-0056 colocation exception, so `scheduled(...)` resolves
//     as a bare ident). Scanning schema.rs alone would leave it ungated, so the
//     two sources are taken SEPARATELY and stripped PER FILE — never as one
//     concatenated blob, where a quote left open in file A silently blanks the
//     whole of file B.
//   * `public` on a `#[spacetimedb::view]` is a mandatory, inert keyword. THE
//     VIEW BODY is the entire security boundary, which is why [A/2c] pins it by
//     EXACT equality: a presence-only check is passed by
//       let _decoy = ctx.db.account().identity().find(ctx.sender);
//       let v = Identity::from_byte_array([7u8; 32]);
//       ctx.db.account().identity().find(v)
//     which compiles, is clippy-clean and rustfmt-clean, and leaks an arbitrary
//     account row.
//   * guards.rs:47 is `log_reject(reducer: &str, sender: Identity, reason: &str)`
//     and its own comment (:48-51) calls the first-argument name literal "an
//     unenforced convention". So a 3rd-argument-only PII check is beaten by
//       let src_tag = claims.issuer();
//       log_reject(src_tag, ctx.sender, REJECT_UNRECOGNIZED_ISSUER);
//     which writes the raw JWT `iss` to the warn log. [G12/not-literal]
//     therefore constrains EVERY argument, not just the reason.
//
// OWNERSHIP / SSOT — what this eval deliberately does NOT do:
//   * The `ViewContext::new(` / `ViewContext{` forged-context ban, the
//     short-form `#[view(` attribute check, and the raw-vs-stripped hidden-view
//     count are ALL owned by wallet-privacy.eval.mjs (:469-481, :343, :327),
//     which already runs them TREE-WIDE over a glob that includes schema.rs and
//     accounts.rs. Duplicating them here would add maintenance surface and zero
//     coverage.
//   * [A/2b] iter-ban, [A/2d] AnonymousViewContext, [A/2e] no-`Vec<` and
//     [A/2f] return-type are CUT: once [A/2c] pins the body to one exact
//     expression the compiler forbids all four. wallet-privacy keeps them as
//     parser guards for `parseViews`' own health — a rationale that only needs
//     to be discharged once, in the file that owns the parser.
//   * Reducer-surface gates (G2), the anonymous-first connect ordering (G3),
//     the RNG ban (G4), write-target confinement (G5), single-use claim codes
//     (G11) and REKEY_COMPLETENESS (G6) belong to the sibling
//     guest-claim-integrity.eval.mjs.
//   * `format!` inside a log_reject argument span is already banned by
//     accounts_tests.rs:913. A body-scoped JS copy would false-RED on
//     accounts.rs:311's legitimate `Err(REJECT_UNRECOGNIZED_AUDIENCE.to_string())`,
//     so it is NOT re-encoded here.
//
// Checks (each exported so the fixtures exercise it directly). Every clause
// carries a [tag] in its message so a fixture can assert WHICH clause fired —
// without that, deleting a clause can leave the suite green because a
// neighbouring clause's message happens to share a word.
//   A  checkAccountViewsSafe({schemaSrc, accountsSrc, treeSrcs}) — per-file strip:
//      [A/0-table]            the `account` table declaration is found (fail loud:
//                             every clause below would otherwise pass vacuously).
//      [A/priv-account]       `account` carries no `public`.
//      [A/missing-guest-claim]`guest_claim` is found at all (empty-target blind
//                             spot: a checker that only inspects tables it finds
//                             is GREEN when the target vanishes).
//      [A/priv-guest-claim]   `guest_claim` carries no `public`.
//      [A/missing-sched]      `guest_claim_reaper_schedule` is found in
//                             accounts.rs (it is NOT in schema.rs).
//      [A/priv-sched]         it carries no `public`.
//      [A/2c]                 the `my_account` view exists AND its
//                             whitespace-compacted body EQUALS the sanctioned
//                             one-expression sender-keyed lookup (this clause
//                             absorbs the old presence-only [A/2a]).
//      [A/view-set]           `parseViews` over the whole non-test tree yields
//                             EXACTLY ['my_account','my_conversation','my_wallet'].
//                             This REPLACES a transitive reader-closure walk,
//                             which a red-team defeated with a function pointer
//                             (`const HOPS: [fn(&ViewContext)->Vec<Row>;1] =
//                             [roster]; ... HOPS[0](ctx)` — the closure only ever
//                             grows on a `name(` token, and a fn VALUE never
//                             emits one). Pinning the inventory makes a
//                             laundering view UNREPRESENTABLE rather than merely
//                             detectable, and any new view becomes a
//                             privacy-relevant event re-reviewed right here.
//   C  checkBindings(fsProbe) — INJECTED path predicate, so the teeth run against
//      deterministic fakes and never the real fs (client/** belongs to a
//      concurrent slice; nothing there is created or deleted by this eval):
//      [C/legacy-account], [C/legacy-guest-claim], [C/legacy-sched] — a private
//      table emits NO client table binding, so each `*_table.ts` must be ABSENT;
//      [C/missing-view] — `my_account_table.ts` must be PRESENT.
//   G  checkNoPiiInRejectLogs({accountsSrc, libSrc}) — scoped to the bodies of
//      `provision_or_touch_account` (accounts.rs) and `on_connect` (lib.rs):
//      [G12/scope]         both bodies were located and are non-empty (fail loud).
//      [G12/not-literal]   EVERY argument of every `log_reject(` / `reject(` call
//                          is a bare "..." literal or an identifier resolving in
//                          a literal-&str-const map built from the source;
//                          argument 2 is exactly `ctx.sender` or `me`.
//      [G12/value-pin]     the resolved reason SET equals exactly
//                          {"unrecognized issuer", "unrecognized audience"}.
//      [G12/claim-binding] no local bound from claims.issuer()/.audience()/
//                          .subject() is later passed to any log/reject call.
//                          The binding NAME is tracked from the source, never
//                          pinned to a spelling — the M21a red-team's finding was
//                          precisely that an identifier-name list is
//                          rename-evadable. The adversarial pass widened it
//                          twice: the taint is a FIXED POINT (`let iss =
//                          claims.issuer(); let tag = iss;` launders a one-hop
//                          rule), and a callee counts as a sink when its NAME
//                          CONTAINS log / warn / reject, or is any panic-family
//                          macro (a panicking reducer's message is logged), so
//                          `fn warn_issuer(..) { log::warn!(..) }` cannot slip
//                          past a whole-segment-equality list. Fixture FA35.
//
// THE STRIPPER (canonical implementation — the sibling M21c eval copies it):
// `stripRustSource` blanks strings and comments IN PLACE, offset- and
// length-preserving, so the imported `parseTables` / `parseViews` consume it
// unchanged (conversation-privacy.eval.mjs:79-81 does the same, which is why
// substituting a different stripper is safe). It is single-pass and
// STRING-AWARE: strings are lexed FIRST, never comments first — a comments-first
// pass truncates a literal containing a slash-slash, unbalances the remaining
// quote pairing, and cascades into unrelated files (this exact bug reddened
// trade-escrow-guards TR-11 and is documented at accounts.rs:41-48).
// A red-team PROVED that handling only "...", r#"..."# and 3-char char literals
// is defeated by three rustfmt-stable, clippy-clean constructs that invert quote
// polarity for the rest of the file (a zero-hash raw string whose backslash-quote
// is wrongly eaten as an escape; a two-hash raw string; a byte raw string). One
// such line blanked 14,572 code characters of accounts.rs and silently zeroed
// every ban needle. THE ASYMMETRY IS THE DANGER: a desync GREENS every ban clause
// and reds only presence clauses.
// A SECOND adversarial pass found a FOURTH form the r/br hardening still missed:
// the C-string prefixes `c"..."` / `cr"..."` / `cr##"..."##` (stable since Rust
// 1.77). In `cr"C:\"` the `r` is preceded by the word character `c`, so the raw
// branch's `!isWordChar(src[i-1])` guard skipped it entirely and the literal was
// lexed as an ORDINARY string whose `\"` was eaten as an escape — identical
// polarity inversion, brand-new spelling. Worse, placed at the END of a file the
// blanked tail carries no `pub struct` / `#[spacetimedb::` anchor, so
// [STRIP/anchors] could not see it either and an entire appended reducer became
// invisible to [R/name-set], [N/rng] and every [W/*] clause. Fixtures FA33/FA34
// pin the fix. Hence: any number of hashes, matched by count; the b / c / br / cr
// prefixes all recognised; no escape processing inside raw strings; properly
// lexed char literals with lifetime disambiguation; nested block comments; and
//   [STRIP/length] / [STRIP/idempotent] / [STRIP/anchors] — a desync SELF-CHECK
// run on every live source, because a desync is invisible to the clauses
// themselves. [STRIP/anchors] compares the anchor count in the stripped text
// against an INDEPENDENT, quote-blind, line-based count of the raw text; the
// comparison is one-sided (`stripped >= independent`) so over-stripping by the
// independent pass can never false-RED.
// HONEST DEVIATION: the anchor set is {`pub struct`, `#[spacetimedb::`} — `fn `
// is excluded because content.rs:1051-1061 carries `fn ` and `pub(crate) fn `
// INSIDE multi-line string literals, which a quote-blind count cannot tell from
// code; including it would false-RED the live tree. Consequence: a file with
// neither anchor gets only the length/idempotency half of the self-check. Both
// files this eval bans tokens in (schema.rs, accounts.rs) are anchor-rich.
//
// Every ordering/count/token clause runs against `compactWs(stripRustSource(src))`.
// THE LIVE TREE IS RUSTFMT-WRAPPED — accounts.rs:316-324 is
// `ctx.db\n.account()\n.identity()\n.update(` — so a contiguous needle matches
// ZERO times against unsquashed source. Every needle here is written in squashed
// form.
//
// NO `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — literal
// /regex/ and String.indexOf only.
//
// Proof-of-teeth fixtures (FA1-FA35) run BEFORE the live-tree checks so a broken
// checker is caught first. Every clause that can fire has a BAD fixture
// asserting its [tag], and every checker has a GOOD fixture that must PASS — an
// always-red checker is indistinguishable from a working one (this repo's ux3
// postmortem found a scan-only gate that let 9 of 19 broken implementations pass
// GREEN).
//
// EXPECTED STATE: GREEN against the current tree. The code these clauses gate is
// already merged and correct (M21a); this file is the structural gate over it.

import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTables, parseViews } from './conversation-privacy.eval.mjs';
import {
  DQ,
  SLASH_STAR,
  STAR_SLASH,
  assertStripperSound,
  compactWs,
  containsIdent,
  countOccurrences,
  findCalls,
  findFnBody,
  isWordChar,
  matchRawString,
  splitArgs,
  stripRustSource,
} from './rust-scan.mjs';


// ---------------------------------------------------------------------------
// Check A: the three account tables are private and `my_account` is the only
// view, with an exactly-pinned body.
// ---------------------------------------------------------------------------

const ACCOUNT_TABLE = 'account';
const GUEST_CLAIM_TABLE = 'guest_claim';
const SCHED_TABLE = 'guest_claim_reaper_schedule';
const VIEW_NAME = 'my_account';
// The whole sanctioned view inventory, sorted. Any addition is a
// privacy-relevant event that must be re-reviewed here.
const EXPECTED_VIEWS = ['my_account', 'my_conversation', 'my_wallet'];
// The ONE sanctioned body, whitespace-compacted. `&ctx.sender` is an
// equally-correct borrow spelling of the same unique-index lookup.
const SANCTIONED_BODY = 'ctx.db.account().identity().find(ctx.sender)';
const SANCTIONED_BODY_REF = 'ctx.db.account().identity().find(&ctx.sender)';

/**
 * @param {{schemaSrc: string, accountsSrc: string,
 *          treeSrcs?: Array<{path: string, src: string}>}} sources
 *   Raw schema.rs and accounts.rs sources, taken SEPARATELY (stripped per file,
 *   never concatenated), plus — for [A/view-set] — every non-test source in the
 *   tree. `treeSrcs` defaults to just the two named files, which is what the
 *   fixtures use; the live run passes the whole tree.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkAccountViewsSafe({ schemaSrc, accountsSrc, treeSrcs }) {
  const named = [
    { path: 'server-module/src/schema.rs', src: schemaSrc },
    { path: 'server-module/src/accounts.rs', src: accountsSrc },
  ];
  for (const f of named) {
    const desync = assertStripperSound(f.src, f.path);
    if (desync) return desync;
  }

  const schemaStripped = stripRustSource(schemaSrc);
  const accountsStripped = stripRustSource(accountsSrc);
  const schemaTables = parseTables(schemaStripped);
  const accountsTables = parseTables(accountsStripped);

  // [A/0-table] NON-VACUITY. Fail loud: with no `account` table in the scanned
  // text every clause below is satisfied by an empty source.
  const account = schemaTables.find((t) => t.name === ACCOUNT_TABLE);
  if (!account) {
    return (
      `[A/0-table] no \`#[spacetimedb::table(name = ${ACCOUNT_TABLE})]\` declaration was ` +
      'found in schema.rs — the scan reached the wrong tree, the table was renamed, or ' +
      'the stripper blanked it. Every privacy clause below would pass VACUOUSLY, so this ' +
      'is a hard failure rather than a skip'
    );
  }
  if (account.isPublic) {
    return (
      `[A/priv-account] the \`${ACCOUNT_TABLE}\` table is declared \`public\` — it is the ` +
      'PRIVATE account record (ADR-0179 D2): a public table is world-readable, exposing ' +
      "every player's auth issuer, login times and deletion state. Drop `public` and read " +
      `through the owner-scoped \`${VIEW_NAME}\` view instead`
    );
  }

  const guestClaim = schemaTables.find((t) => t.name === GUEST_CLAIM_TABLE);
  if (!guestClaim) {
    return (
      `[A/missing-guest-claim] no \`#[spacetimedb::table(name = ${GUEST_CLAIM_TABLE})]\` ` +
      'declaration was found in schema.rs. This is the empty-target blind spot: a checker ' +
      'that only inspects the tables it happens to find is GREEN the moment its target ' +
      'disappears (renamed, moved to another file, or blanked by a stripper desync)'
    );
  }
  if (guestClaim.isPublic) {
    return (
      `[A/priv-guest-claim] the \`${GUEST_CLAIM_TABLE}\` table is declared \`public\` — the ` +
      'row carries the CLIENT-minted 256-bit claim code in plaintext (ADR-0179 D3), so a ' +
      "public table hands every connected client every in-flight guest's claim code and " +
      'lets them steal the account takeover. Drop `public`'
    );
  }

  const sched = accountsTables.find((t) => t.name === SCHED_TABLE);
  if (!sched) {
    return (
      `[A/missing-sched] no \`#[spacetimedb::table(name = ${SCHED_TABLE})]\` declaration ` +
      'was found in accounts.rs. It lives THERE, not in schema.rs (the ADR-0056 ' +
      'colocation exception, so `scheduled(guest_claim_reaper)` resolves as a bare ident) ' +
      '— a checker that scans only schema.rs leaves this table entirely ungated'
    );
  }
  if (sched.isPublic) {
    return (
      `[A/priv-sched] the \`${SCHED_TABLE}\` table is declared \`public\` — its rows name ` +
      'the guest identity of every in-flight claim and its exact TTL instant, which is a ' +
      'per-player activity oracle. Scheduled tables are never client-readable here; drop ' +
      '`public`'
    );
  }

  // [A/2c] LOAD-BEARING (absorbs the old presence-only [A/2a]).
  const views = parseViews(schemaStripped);
  const mine = views.find((v) => v.name === VIEW_NAME || v.fnName === VIEW_NAME);
  if (!mine) {
    return (
      `[A/2c] no \`#[spacetimedb::view(name = ${VIEW_NAME}, public)]\` exists in schema.rs ` +
      `— \`${ACCOUNT_TABLE}\` is PRIVATE, so without the owner-scoped view the client is ` +
      `dark (it can never learn its own account state). Add it with body: ${SANCTIONED_BODY}`
    );
  }
  const body = compactWs(mine.bodyText);
  if (body !== SANCTIONED_BODY && body !== SANCTIONED_BODY_REF) {
    return (
      `[A/2c] view '${VIEW_NAME}' body is not EXACTLY the sanctioned sender-keyed lookup. ` +
      `Expected (whitespace-insensitive): ${SANCTIONED_BODY} — got: ${body}. This clause is ` +
      'exact ON PURPOSE: a presence check is passed by a decoy line (`let _decoy = ' +
      '...find(ctx.sender);` followed by `...find(some_other_identity)`), which compiles ' +
      'clean, passes clippy and rustfmt, and returns an ARBITRARY account row. `public` on ' +
      'the view attribute is inert — this body is the entire security boundary, so any ' +
      'legitimate change to it must be re-reviewed right here'
    );
  }

  // [A/view-set] EXACT view-inventory pin.
  const files = treeSrcs ?? named;
  const found = [];
  for (const f of files) {
    for (const v of parseViews(stripRustSource(f.src))) found.push(v.name);
  }
  found.sort();
  const sameSet =
    found.length === EXPECTED_VIEWS.length && found.every((n, k) => n === EXPECTED_VIEWS[k]);
  if (!sameSet) {
    return (
      `[A/view-set] the module's view inventory is [${found.join(', ')}] but the sanctioned ` +
      `set is exactly [${EXPECTED_VIEWS.join(', ')}]. Views are the ONLY client read path ` +
      'into a private table, so the inventory is pinned rather than audited: a transitive ' +
      'reader-closure walk was proven bypassable by a function pointer (`const HOPS: ' +
      '[fn(&ViewContext)->Vec<Row>;1] = [roster]; ... HOPS[0](ctx)` — the closure only ' +
      'grows on a `name(` token and a fn VALUE never emits one). Pinning makes a ' +
      'laundering view unrepresentable instead of merely detectable. If a new view is ' +
      'genuinely wanted, add it to EXPECTED_VIEWS in the same PR that privacy-reviews it'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check C: generated bindings. The probe is INJECTED so the teeth run against
// deterministic fakes; the live run backs it with existsSync. Nothing under
// client/ is created, deleted or edited by this eval (a concurrent slice owns
// that tree).
// ---------------------------------------------------------------------------

const ACCOUNT_BINDING = 'client/src/module_bindings/account_table.ts';
const GUEST_CLAIM_BINDING = 'client/src/module_bindings/guest_claim_table.ts';
const SCHED_BINDING = 'client/src/module_bindings/guest_claim_reaper_schedule_table.ts';
const VIEW_BINDING = 'client/src/module_bindings/my_account_table.ts';

/**
 * @param {(relPath: string) => boolean} fsProbe Returns true iff the path exists.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBindings(fsProbe) {
  const legacy = [
    ['[C/legacy-account]', ACCOUNT_BINDING, ACCOUNT_TABLE],
    ['[C/legacy-guest-claim]', GUEST_CLAIM_BINDING, GUEST_CLAIM_TABLE],
    ['[C/legacy-sched]', SCHED_BINDING, SCHED_TABLE],
  ];
  for (const [tag, binding, table] of legacy) {
    if (fsProbe(binding)) {
      return (
        `${tag} ${binding} exists — a PRIVATE table emits NO client table binding, so its ` +
        `presence means \`${table}\` was published as public. Revert the table attribute ` +
        'and regenerate (`just gen`); never hand-edit module_bindings/**'
      );
    }
  }
  if (!fsProbe(VIEW_BINDING)) {
    return (
      `[C/missing-view] ${VIEW_BINDING} is missing — the owner-scoped view binding was not ` +
      'generated (`just gen`). Without it the client cannot subscribe to my_account and ' +
      'can never learn its own account state, which is the whole point of the view'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check G (G12 / AUTH-36): no PII in reject logs.
//
// Scope is the BODIES of provision_or_touch_account (accounts.rs) and
// on_connect (lib.rs) — the only two fns on the connect path that see JWT
// claims. The shipped Rust twin (accounts_tests.rs:904-925) is identifier-based
// and a red-team beat it three ways: by renaming the binding, by leaking through
// argument ONE, and by leaking a value the identifier list does not name.
// ---------------------------------------------------------------------------

const EXPECTED_REASONS = ['unrecognized audience', 'unrecognized issuer'];
const CLAIM_ACCESSORS = ['claims.issuer()', 'claims.audience()', 'claims.subject()'];
const SANCTIONED_SENDER_ARGS = ['ctx.sender', 'me'];
// Every callee segment that can put its argument into the module log. The
// panic family is here because a panicking reducer's message IS logged by the
// SpacetimeDB host: `panic!("bad issuer {iss}")` is a G12 violation that a
// macro list of only the `log::*` names walks straight past.
const LOG_MACRO_NAMES = [
  'warn',
  'info',
  'error',
  'debug',
  'trace',
  'println',
  'eprintln',
  'panic',
  'unreachable',
  'todo',
  'unimplemented',
  'assert',
  'assert_eq',
  'assert_ne',
  'expect',
  'dbg',
];


/**
 * Build the literal-`&str`-const map. The DECLARATION is located in the
 * stripped text (so a commented-out const cannot enter the map) and the VALUE is
 * read from the raw text at the same offsets — which only works because
 * stripRustSource is offset-preserving.
 * @param {string} src Raw Rust source.
 * @returns {Record<string, string>} const/static name -> literal value.
 */
export function parseStrConsts(src) {
  const stripped = stripRustSource(src);
  const map = {};
  const decl = /(?:const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"/g;
  for (const m of stripped.matchAll(decl)) {
    const openQuote = m.index + m[0].length - 1;
    const closeQuote = stripped.indexOf(DQ, openQuote + 1);
    if (closeQuote !== -1) map[m[1]] = src.slice(openQuote + 1, closeQuote);
  }
  return map;
}



/**
 * Is this callee the reject logger? Matches `log_reject`, `reject`,
 * `guards::log_reject`, `crate::guards::log_reject` — and NOT the substring hit
 * inside some unrelated identifier.
 * @param {string} callee Dotted/pathed callee text.
 * @returns {boolean} True for a reject-logging call.
 */
function isRejectCallee(callee) {
  const segs = callee.split(/[.:]+/).filter(Boolean);
  const last = segs.length === 0 ? '' : segs[segs.length - 1];
  return last === 'reject' || last === 'log_reject';
}

/**
 * Is this callee anything that could reach a log sink? Deliberately broader
 * than isRejectCallee: `log::warn!`, `eprintln!`, `panic!`, any *reject*
 * helper — and, since the adversarial pass, any segment whose NAME CONTAINS
 * `log`, `warn` or `reject`.
 *
 * The substring rule exists because a whole-segment match is one rename away
 * from silence: `fn warn_issuer(s: &str) { log::warn!("{s}"); }` called as
 * `warn_issuer(claims.issuer())` is a real AUTH-36 leak whose callee segment
 * (`warn_issuer`) equals none of the macro names. Over-classifying a callee as
 * a sink is SAFE here — [G12/claim-binding] only fires when a CLAIM-TAINTED
 * local is one of that call's arguments — so the two live over-matches
 * (`UNRECOGNIZED_ISSUER_LOG_LIMITER.check(..)`, `touch_login(..)`) stay green
 * because neither is handed a tainted name. Residual, accepted: a future
 * helper whose name merely contains `log` (`catalog_lookup(issuer)`) would
 * false-RED; that is the fail-loud direction.
 * @param {string} callee Dotted/pathed callee text.
 * @returns {boolean} True for a log-like call.
 */
function isLogLikeCallee(callee) {
  for (const seg of callee.toLowerCase().split(/[.:]+/).filter(Boolean)) {
    const bare = seg.endsWith('!') ? seg.slice(0, -1) : seg;
    if (bare === 'log' || bare === 'logger') return true;
    if (bare.indexOf('reject') !== -1) return true;
    if (bare.indexOf('log') !== -1 || bare.indexOf('warn') !== -1) return true;
    if (LOG_MACRO_NAMES.indexOf(bare) !== -1) return true;
  }
  return false;
}

/**
 * Names bound (by any `let` pattern) to an expression that reads a raw JWT
 * claim, TRANSITIVELY. The NAME IS OBSERVED, never pinned to a spelling — an
 * identifier-name list is rename-evadable, which is exactly how the shipped Rust
 * twin was beaten.
 *
 * The taint is a fixed point, not a single hop: the adversarial pass found that
 *   let iss = claims.issuer();
 *   let tag = iss;             // <- `tag`'s initializer names no claim accessor
 *   warn_issuer(tag);
 * defeats a one-hop rule while leaking exactly the same bytes. Each round taints
 * every `let` whose initializer names an already-tainted local; the name set only
 * grows, so it terminates.
 * @param {string} bodyStripped Stripped fn body.
 * @returns {string[]} Claim-tainted local names.
 */
export function claimBoundLocals(bodyStripped) {
  /** @type {Array<{names:string[], init:string}>} */
  const lets = [];
  for (let at = bodyStripped.indexOf('let'); at !== -1; at = bodyStripped.indexOf('let', at + 1)) {
    if (isWordChar(bodyStripped[at - 1]) || isWordChar(bodyStripped[at + 3])) continue;

    // Pattern text runs to the `=`; the initializer runs to the depth-0 `;`
    // (a `let ... else { ... };` block therefore stays inside the initializer).
    let eq = -1;
    let depth = 0;
    let semi = -1;
    for (let k = at + 3; k < bodyStripped.length; k++) {
      const ch = bodyStripped[k];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === '=' && depth === 0 && eq === -1 && bodyStripped[k + 1] !== '=') eq = k;
      else if (ch === ';' && depth === 0) {
        semi = k;
        break;
      }
    }
    if (eq === -1) continue;
    const init = compactWs(bodyStripped.slice(eq + 1, semi === -1 ? bodyStripped.length : semi));

    const names = [];
    const pattern = bodyStripped.slice(at + 3, eq);
    for (const ident of pattern.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      // Skip binding modes and type/variant names (`mut`, `ref`, `Some`, `Ok`).
      if (ident === 'mut' || ident === 'ref') continue;
      if (/^[A-Z]/.test(ident)) continue;
      names.push(ident);
    }
    if (names.length > 0) lets.push({ names, init });
  }

  const tainted = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of lets) {
      const direct = CLAIM_ACCESSORS.some((needle) => l.init.indexOf(needle) !== -1);
      const derived = tainted.some((name) => containsIdent(l.init, name));
      if (!direct && !derived) continue;
      for (const name of l.names) {
        if (tainted.indexOf(name) === -1) {
          tainted.push(name);
          changed = true;
        }
      }
    }
  }
  return tainted;
}

/**
 * @param {{accountsSrc: string, libSrc: string}} sources Raw accounts.rs and
 *   lib.rs sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoPiiInRejectLogs({ accountsSrc, libSrc }) {
  const scopes = [
    { file: 'server-module/src/accounts.rs', fn: 'provision_or_touch_account', raw: accountsSrc },
    { file: 'server-module/src/lib.rs', fn: 'on_connect', raw: libSrc },
  ];

  // [G12/scope] — fail loud on an empty extraction. A checker whose scope
  // silently resolves to nothing passes every clause below it.
  const bodies = [];
  for (const s of scopes) {
    const desync = assertStripperSound(s.raw, s.file);
    if (desync) return desync;
    const stripped = stripRustSource(s.raw);
    const span = findFnBody(stripped, s.fn);
    if (!span) {
      return (
        `[G12/scope] fn \`${s.fn}\` was not found in ${s.file} — the PII scan has NO scope, ` +
        'so every clause below it would pass vacuously. Was the fn renamed, moved, or ' +
        'blanked by a stripper desync?'
      );
    }
    const bodyStripped = stripped.slice(span.start, span.end);
    if (compactWs(bodyStripped) === '') {
      return (
        `[G12/scope] fn \`${s.fn}\` in ${s.file} has an EMPTY body — the connect path cannot ` +
        'be both implemented and empty; the extraction is broken or the fn is a stub'
      );
    }
    bodies.push({ ...s, stripped, span, bodyStripped });
  }

  const consts = { ...parseStrConsts(accountsSrc), ...parseStrConsts(libSrc) };

  /**
   * @param {{stripped:string, raw:string}} arg One split argument.
   * @returns {{value: string}|null} Resolved literal value, or null.
   */
  const resolve = (arg) => {
    if (arg.stripped === DQ + DQ) {
      const t = arg.raw;
      if (t.length >= 2 && t.startsWith(DQ) && t.endsWith(DQ)) return { value: t.slice(1, -1) };
      return { value: '' };
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.stripped) && arg.stripped in consts) {
      return { value: consts[arg.stripped] };
    }
    return null;
  };

  // [G12/not-literal] — EVERY argument, not just the reason.
  const reasons = new Set();
  for (const b of bodies) {
    for (const call of findCalls(b.stripped, b.raw, b.span.start, b.span.end)) {
      if (!isRejectCallee(call.callee)) continue;
      if (call.args.length !== 3) {
        return (
          `[G12/not-literal] \`${call.callee}(\` in ${b.file} was called with ` +
          `${call.args.length} argument(s); the sanctioned signature is ` +
          '(reducer: &str, sender: Identity, reason: &str) — this scan cannot classify an ' +
          'unexpected shape, and refusing to classify is the fail-loud direction'
        );
      }
      for (let k = 0; k < call.args.length; k++) {
        const arg = call.args[k];
        if (k === 1) {
          if (SANCTIONED_SENDER_ARGS.indexOf(arg.stripped) === -1) {
            return (
              `[G12/not-literal] argument 2 of \`${call.callee}(\` in ${b.file} is ` +
              `\`${arg.stripped}\` — the logged identity must be exactly the caller ` +
              `(${SANCTIONED_SENDER_ARGS.join(' or ')}). Logging any other identity ` +
              'attributes a reject to someone who did not make the call'
            );
          }
          continue;
        }
        if (resolve(arg) === null) {
          return (
            `[G12/not-literal] argument ${k + 1} of \`${call.callee}(\` in ${b.file} is ` +
            `\`${arg.stripped}\`, which is neither a bare string literal nor a literal &str ` +
            'const declared in the source. EVERY argument is constrained, not just the ' +
            'reason: guards.rs:47 takes the reducer NAME as a `&str` too and its own comment ' +
            '(:48-51) calls a name literal there "an unenforced convention", so ' +
            '`let src_tag = claims.issuer(); log_reject(src_tag, ctx.sender, REASON);` ' +
            'writes the raw JWT `iss` into the structured warn log while a reason-only ' +
            'check stays GREEN'
          );
        }
      }
      const reason = resolve(call.args[2]);
      if (reason !== null) reasons.add(reason.value);
    }
  }

  // [G12/value-pin] — EXACT set equality, never a containment test.
  const found = [...reasons].sort();
  const samePin =
    found.length === EXPECTED_REASONS.length && found.every((v, k) => v === EXPECTED_REASONS[k]);
  if (!samePin) {
    return (
      '[G12/value-pin] the set of reject reasons logged on the connect path is ' +
      `{${found.map((v) => JSON.stringify(v)).join(', ')}} but must be EXACTLY ` +
      `{${EXPECTED_REASONS.map((v) => JSON.stringify(v)).join(', ')}}. The reasons are ` +
      'value-pinned rather than merely required to be static: a static const whose VALUE ' +
      'interpolates the issuer URL, the audience, or any token-derived text is still PII ' +
      'in the log, and an empty set means the reject logging was deleted outright'
    );
  }

  // [G12/claim-binding] — belt to not-literal, covering sinks other than
  // log_reject (log::warn!, eprintln!, ...).
  for (const b of bodies) {
    const bound = claimBoundLocals(b.bodyStripped);
    if (bound.length === 0) continue;
    for (const call of findCalls(b.stripped, b.raw, b.span.start, b.span.end)) {
      if (!isLogLikeCallee(call.callee)) continue;
      for (const arg of call.args) {
        for (const name of bound) {
          if (containsIdent(arg.stripped, name)) {
            return (
              `[G12/claim-binding] the local \`${name}\` in ${b.file} is bound from a raw JWT ` +
              `claim and then passed to \`${call.callee}(\` — that writes the token's ` +
              'issuer/audience/subject into the log (AUTH-36). The binding NAME is read out ' +
              'of the source rather than matched against a list, because renaming the local ' +
              'is exactly how the identifier-list version of this check was beaten. Log a ' +
              'static reason const instead'
            );
          }
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH FIXTURES (FA1-FA35) — inline sources, run BEFORE the live-tree
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

// A GOOD schema.rs stand-in, deliberately HOSTILE: `public`, `iter` and `rng`
// appear as prose and inside literals, a slash-slash and a block-comment opener
// live inside string literals, a whole leaky view is quoted inside a string, and
// a zero-hash raw string sits between the declarations. All of it must PASS.
const GOOD_SCHEMA = String.raw`
/// PRIVATE account record (no public keyword) — ADR-0179 D2.
#[derive(Clone)]
#[spacetimedb::table(name = account)]
pub struct Account {
    #[primary_key]
    pub identity: Identity,
    pub auth_issuer: String,
    pub created_at_ms: i64,
}

/// Owner-scoped read path. Never an iter() here: exactly one row.
#[spacetimedb::view(name = my_account, public)]
fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account> {
    ctx.db
        .account()
        .identity()
        .find(ctx.sender)
}

#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(ctx: &spacetimedb::ViewContext) -> Option<PlayerConversation> {
    ctx.db.player_conversation().player_identity().find(ctx.sender)
}

#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender)
}

#[derive(Clone)]
#[spacetimedb::table(name = guest_claim)]
pub struct GuestClaim {
    #[primary_key]
    pub guest_identity: Identity,
    #[unique]
    pub code: String,
}

pub const DOC_URL: &str = "https://auth.example.invalid/oidc";
pub const OPENER: &str = "SLASH_STAR_PLACEHOLDER";
pub const RNG_NOTE: &str = "the words rng, iter and public are data here";
pub const LEAK_DECOY: &str =
    "#[spacetimedb::view(name = all_accounts, public)] fn all_accounts(c: &V) -> Vec<Account> { c.db.account().iter().collect() }";
pub const WIN_PATH: &str = r"C:\";
`.replace('SLASH_STAR_PLACEHOLDER', SLASH_STAR + ' not a comment ' + STAR_SLASH);

// A GOOD accounts.rs stand-in: the scheduled table lives HERE, plus a byte raw
// string, char literals, byte-char literals and lifetimes for the lexer.
const GOOD_ACCOUNTS = String.raw`
/// PRIVATE scheduled table colocated with its reducer (ADR-0056 exception).
#[spacetimedb::table(name = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
pub struct GuestClaimReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub guest_identity: Identity,
}

pub const SAMPLE: &[u8] = br##"a"b"##;
const TICK: char = '\'';
const NL: char = '\n';
const GRIN: char = '\u{1F600}';

fn hexy<'a>(s: &'a str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f') || b == b'\\')
}

pub struct Holder<'de> {
    pub raw: &'de str,
}
`;

// A GOOD provision_or_touch_account + on_connect pair (the shipped shape).
const GOOD_ACCOUNTS_PII = `
const REJECT_UNRECOGNIZED_ISSUER: &str = "unrecognized issuer";
const REJECT_UNRECOGNIZED_AUDIENCE: &str = "unrecognized audience";

pub(crate) fn provision_or_touch_account(ctx: &ReducerContext) -> Result<(), String> {
    let Some(claims) = ctx.sender_auth().jwt() else {
        return Ok(());
    };
    let issuer = claims.issuer();
    if !issuer_allowed(issuer, ALLOWED_ISSUERS) {
        if UNRECOGNIZED_ISSUER_LOG_LIMITER
            .check(now_ms(ctx), UNRECOGNIZED_ISSUER_LOG_WINDOW_MS)
            .is_some()
        {
            log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_ISSUER);
        }
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
`;

const GOOD_LIB_PII = `
#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String> {
    if !ctx.sender_auth().has_jwt() {
        return Ok(());
    }
    accounts::provision_or_touch_account(ctx)
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
 * Build a schema stand-in whose `guest_claim` table is PUBLIC, preceded by a
 * hostile raw-string const. A raw-string-blind stripper blanks the table
 * declaration and reports "not found"; a correct one reports the leak.
 * @param {string} rawConst The raw-string const line.
 * @returns {string} Fixture source.
 */
function schemaWithRawConstAndPublicClaim(rawConst) {
  return `
#[spacetimedb::table(name = account)]
pub struct Account {
    #[primary_key]
    pub identity: Identity,
}

#[spacetimedb::view(name = my_account, public)]
fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account> {
    ctx.db.account().identity().find(ctx.sender)
}

${rawConst}

#[spacetimedb::table(name = guest_claim, public)]
pub struct GuestClaim {
    #[primary_key]
    pub guest_identity: Identity,
    pub code: String,
}
`;
}

function runTeeth() {
  // --- stripper machinery ------------------------------------------------

  // FA1 — direct behavioural pin on the stripper.
  // Kills: a comments-before-strings stripper (a slash-slash inside a URL
  // literal truncates the line and unbalances every quote after it), and a
  // stripper that lets a code needle quoted inside a literal reach the clauses.
  {
    const src = String.raw`
pub const URL: &str = "https://auth.example.invalid/x";
pub const OPENER: &str = "SLASH_STAR_PLACEHOLDER";
pub const DECOY: &str = "ctx.db.account().identity().find(victim)";
pub const WIN: &str = r"C:\";
pub struct Probe;
fn probe(ctx: &Ctx) {
    ctx.db.account().identity().delete(victim);
}
`.replace('SLASH_STAR_PLACEHOLDER', SLASH_STAR);
    const flat = compactWs(stripRustSource(src));
    if (flat.indexOf('ctx.db.account().identity().delete(victim)') === -1) {
      return (
        'FA1: real code AFTER the hostile literals was blanked — the stripper desynced on ' +
        'a slash-slash inside a literal, a block-comment opener inside a literal, or the ' +
        'zero-hash raw string'
      );
    }
    if (flat.indexOf('find(victim)') !== -1) {
      return 'FA1: a code needle quoted INSIDE a string literal survived stripping';
    }
    if (stripRustSource(src).length !== src.length) {
      return 'FA1: the stripper is not length-preserving, so every downstream offset is wrong';
    }
  }

  // FA2 — the self-check must FIRE for a raw-string-blind stripper.
  // Kills: an always-green desync self-check (the only clause able to see a
  // desync at all).
  {
    const src = schemaWithRawConstAndPublicClaim(String.raw`pub const A: &str = r"C:\";`);
    const bad = expectTag(
      assertStripperSound(src, 'fixture', fakeRawBlindStrip),
      '[STRIP/anchors]',
      'FA2',
    );
    if (bad) return bad;
  }

  // FA3 — the self-check must FIRE for a length-changing stripper.
  {
    const bad = expectTag(
      assertStripperSound('pub struct A;\n', 'fixture', (s) => s.replace('pub struct A;', '')),
      '[STRIP/length]',
      'FA3',
    );
    if (bad) return bad;
  }

  // FA4 — the self-check must FIRE for a non-idempotent stripper (each pass
  // blanks one more character, exactly as an unbalanced quote pair does).
  // Kills: a stripper that leaves a delimiter behind and re-triggers next pass.
  {
    const bad = expectTag(
      assertStripperSound('pub struct Xxx;\n', 'fixture', (s) => s.replace('x', ' ')),
      '[STRIP/idempotent]',
      'FA4',
    );
    if (bad) return bad;
  }

  // FA5 — GOOD: the REAL stripper on hostile-but-correct sources must PASS.
  // Kills: an always-red self-check (indistinguishable from a working one).
  {
    const goodSources = [
      ['GOOD_SCHEMA', GOOD_SCHEMA],
      ['GOOD_ACCOUNTS', GOOD_ACCOUNTS],
      ['GOOD_ACCOUNTS_PII', GOOD_ACCOUNTS_PII],
      ['GOOD_LIB_PII', GOOD_LIB_PII],
    ];
    for (const [label, src] of goodSources) {
      const err = assertStripperSound(src, label);
      if (err) return `FA5: the real stripper was reported unsound on ${label}: ${err}`;
    }
  }

  // --- check A ------------------------------------------------------------

  // FA6 — GOOD: the hostile-but-correct pair must PASS every clause of check A.
  {
    const err = checkAccountViewsSafe({ schemaSrc: GOOD_SCHEMA, accountsSrc: GOOD_ACCOUNTS });
    if (err) return `FA6: the GOOD (hostile) source pair was incorrectly flagged: ${err}`;
  }

  // FA7 — the account table is gone entirely.
  // Kills: a checker that "passes" when its target vanishes (vacuous green).
  {
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc: '// nothing here\n', accountsSrc: GOOD_ACCOUNTS }),
      '[A/0-table]',
      'FA7',
    );
    if (bad) return bad;
  }

  // FA8 — `account` published public.
  {
    const schemaSrc = GOOD_SCHEMA.replace('(name = account)', '(name = account, public)');
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/priv-account]',
      'FA8',
    );
    if (bad) return bad;
  }

  // FA9 — the guest_claim table renamed out from under the clause.
  // Kills: the empty-target blind spot for the SECOND table.
  {
    const schemaSrc = GOOD_SCHEMA.replace('(name = guest_claim)', '(name = claim_ticket)');
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/missing-guest-claim]',
      'FA9',
    );
    if (bad) return bad;
  }

  // FA10 — `guest_claim` published public (the plaintext claim code leaks).
  {
    const schemaSrc = GOOD_SCHEMA.replace('(name = guest_claim)', '(name = guest_claim, public)');
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/priv-guest-claim]',
      'FA10',
    );
    if (bad) return bad;
  }

  // FA11 — the scheduled table is absent from accounts.rs (it was moved to
  // schema.rs). Kills: scanning only schema.rs, which leaves it ungated.
  {
    const bad = expectTag(
      checkAccountViewsSafe({
        schemaSrc: GOOD_SCHEMA,
        accountsSrc: '// the reaper schedule moved elsewhere\n',
      }),
      '[A/missing-sched]',
      'FA11',
    );
    if (bad) return bad;
  }

  // FA12 — the scheduled table published public.
  {
    const accountsSrc = GOOD_ACCOUNTS.replace(
      'name = guest_claim_reaper_schedule,',
      'name = guest_claim_reaper_schedule, public,',
    );
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc: GOOD_SCHEMA, accountsSrc }),
      '[A/priv-sched]',
      'FA12',
    );
    if (bad) return bad;
  }

  // FA13 — the my_account view is missing entirely (client goes dark). BOTH the
  // attr name and the fn identifier are renamed, because the view is looked up
  // by EITHER (a view declared `name = my_account` on `fn account_read` is
  // legitimate, so a fn-name-only match must keep working).
  {
    const schemaSrc = GOOD_SCHEMA.replace(
      '#[spacetimedb::view(name = my_account, public)]\nfn my_account(',
      '#[spacetimedb::view(name = acct_peek, public)]\nfn acct_peek(',
    );
    if (schemaSrc === GOOD_SCHEMA) {
      return 'FA13: the fixture substitution did not apply — the view was never renamed';
    }
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/2c]',
      'FA13',
    );
    if (bad) return bad;
  }

  // FA14 — THE decoy-line leak: a conforming find(ctx.sender) kept alive only to
  // satisfy a presence check, followed by the real read keyed on an arbitrary
  // identity. Compiles, clippy-clean, rustfmt-clean, leaks any account row.
  // Kills: ANY presence-only spelling of [A/2c].
  {
    const schemaSrc = GOOD_SCHEMA.replace(
      `    ctx.db
        .account()
        .identity()
        .find(ctx.sender)`,
      `    let _decoy = ctx.db.account().identity().find(ctx.sender);
    let victim = Identity::from_byte_array([7u8; 32]);
    ctx.db.account().identity().find(victim)`,
    );
    if (schemaSrc === GOOD_SCHEMA) {
      return 'FA14: the fixture substitution did not apply — the decoy body was never injected';
    }
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/2c]',
      'FA14',
    );
    if (bad) return bad;
  }

  // FA15 — GOOD: the `&ctx.sender` borrow spelling is the same lookup and must
  // PASS. Kills: an over-tight pin that would false-RED a legitimate rewrite.
  {
    const schemaSrc = GOOD_SCHEMA.replace('.find(ctx.sender)\n}', '.find(&ctx.sender)\n}');
    const err = checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS });
    if (err) return `FA15: the &ctx.sender borrow spelling was incorrectly flagged: ${err}`;
  }

  // FA16 — a FOURTH view is added (here: one that launders the read through a
  // helper, so its own body never names the account table).
  // Kills: any per-view audit; the inventory pin makes it unrepresentable.
  {
    const schemaSrc = `${GOOD_SCHEMA}
#[spacetimedb::view(name = account_roster, public)]
fn account_roster(ctx: &spacetimedb::ViewContext) -> Vec<Account> {
    const HOPS: [fn(&spacetimedb::ViewContext) -> Vec<Account>; 1] = [roster];
    HOPS[0](ctx)
}
`;
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/view-set]',
      'FA16',
    );
    if (bad) return bad;
  }

  // FA17 — a sanctioned view LEAVES the inventory (here my_wallet is renamed;
  // a deletion reads identically to the pin). Kills: a one-sided "no NEW views"
  // check, which would stay green while the client silently goes dark.
  {
    const schemaSrc = GOOD_SCHEMA.replace('name = my_wallet, public', 'name = my_walet, public');
    const bad = expectTag(
      checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
      '[A/view-set]',
      'FA17',
    );
    if (bad) return bad;
  }

  // FA18 — STRIPPER-DESYNC BAD FIXTURES, all three proven raw-string forms.
  // Each puts a hostile raw const between the view and a PUBLIC guest_claim
  // table. With a correct stripper the leak is reported ([A/priv-guest-claim]);
  // with a desynced one the table is blanked and the checker reports "not
  // found" instead — a different tag, so this fixture cannot be satisfied by
  // the wrong answer.
  {
    const forms = [
      String.raw`pub const A: &str = r"C:\";`,
      String.raw`pub const B: &str = r##"use "code" or "CODE"##;`,
      String.raw`pub const C: &[u8] = br##"a"b"##;`,
    ];
    for (let k = 0; k < forms.length; k++) {
      const schemaSrc = schemaWithRawConstAndPublicClaim(forms[k]);
      const err = checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS });
      const bad = expectTag(err, '[A/priv-guest-claim]', `FA18.${k + 1}`);
      if (bad) return `${bad} (raw-string form: ${forms[k]})`;
    }
  }

  // FA33 (adversarial pass, NEW) — the C-STRING prefixes. `c"..."`, `cr"..."`
  // and `cr##"..."##` are stable Rust (1.77+). In `cr"C:\"` the `r` is preceded
  // by the word character `c`, so the raw-string branch's
  // `!isWordChar(src[i-1])` guard skips it and the ORDINARY-string branch eats
  // the `\"` as an escape — the same polarity inversion as the r/br forms, in a
  // spelling the r/br hardening never enumerated. Behavioural half: real code
  // AFTER each form must survive, and the real stripper must call it SOUND.
  {
    const forms = [
      String.raw`pub const P: &core::ffi::CStr = cr"C:\";`,
      String.raw`pub const Q: &core::ffi::CStr = cr##"use "code" or "CODE"##;`,
      String.raw`pub const R: &core::ffi::CStr = c"plain\"escaped";`,
    ];
    for (let k = 0; k < forms.length; k++) {
      const src = `${forms[k]}
pub struct Probe;
fn probe(ctx: &Ctx) {
    ctx.db.account().identity().delete(victim);
}
`;
      const flat = compactWs(stripRustSource(src));
      if (flat.indexOf('ctx.db.account().identity().delete(victim)') === -1) {
        return (
          `FA33.${k + 1}: real code AFTER \`${forms[k]}\` was blanked — the stripper does not ` +
          'recognise the C-string prefix, so quote polarity is inverted for the rest of the file'
        );
      }
      if (flat.indexOf('code') !== -1 || flat.indexOf('escaped') !== -1) {
        return `FA33.${k + 1}: the C-string payload survived stripping`;
      }
      const err = assertStripperSound(src, `FA33.${k + 1}`);
      if (err) return `FA33.${k + 1}: the real stripper was reported unsound: ${err}`;
    }
  }

  // FA34 — the BITING half of FA33: each C-raw form sits between the view and a
  // PUBLIC guest_claim table. With a C-prefix-blind stripper the table is
  // blanked and the checker reports [A/missing-guest-claim] (or [STRIP/anchors])
  // — a DIFFERENT tag — so this fixture cannot be satisfied by the wrong answer.
  // Kills: reverting the `c`/`cr` arms of matchRawString and the prefix branch.
  {
    const forms = [
      String.raw`pub const A: &core::ffi::CStr = cr"C:\";`,
      String.raw`pub const B: &core::ffi::CStr = cr##"use "code" or "CODE"##;`,
    ];
    for (let k = 0; k < forms.length; k++) {
      const schemaSrc = schemaWithRawConstAndPublicClaim(forms[k]);
      const bad = expectTag(
        checkAccountViewsSafe({ schemaSrc, accountsSrc: GOOD_ACCOUNTS }),
        '[A/priv-guest-claim]',
        `FA34.${k + 1}`,
      );
      if (bad) return `${bad} (C-string form: ${forms[k]})`;
    }
  }

  // --- check C ------------------------------------------------------------

  // FA19 — the private account table emitted a client binding.
  {
    const bad = expectTag(
      checkBindings((p) => p === ACCOUNT_BINDING || p === VIEW_BINDING),
      '[C/legacy-account]',
      'FA19',
    );
    if (bad) return bad;
  }

  // FA20 — the guest_claim binding (path-exact, so it cannot be confused with
  // the reaper-schedule binding, which is a strict superstring of it).
  {
    const bad = expectTag(
      checkBindings((p) => p === GUEST_CLAIM_BINDING || p === VIEW_BINDING),
      '[C/legacy-guest-claim]',
      'FA20',
    );
    if (bad) return bad;
  }

  // FA21 — the reaper-schedule binding.
  {
    const bad = expectTag(
      checkBindings((p) => p === SCHED_BINDING || p === VIEW_BINDING),
      '[C/legacy-sched]',
      'FA21',
    );
    if (bad) return bad;
  }

  // FA22 — the view binding was never generated (client dark).
  {
    const bad = expectTag(
      checkBindings(() => false),
      '[C/missing-view]',
      'FA22',
    );
    if (bad) return bad;
  }

  // FA23 — GOOD: view binding present, all three table bindings absent.
  {
    const err = checkBindings((p) => p === VIEW_BINDING);
    if (err) return `FA23: the GOOD bindings probe was incorrectly flagged: ${err}`;
  }

  // --- check G ------------------------------------------------------------

  // FA24 — GOOD: the shipped connect path must PASS.
  {
    const err = checkNoPiiInRejectLogs({
      accountsSrc: GOOD_ACCOUNTS_PII,
      libSrc: GOOD_LIB_PII,
    });
    if (err) return `FA24: the GOOD connect-path pair was incorrectly flagged: ${err}`;
  }

  // FA25 — the scoped fn is gone, so the scan has NO scope.
  // Kills: a silently-empty extraction, which passes every clause below it.
  {
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc: '// moved away\n', libSrc: GOOD_LIB_PII }),
      '[G12/scope]',
      'FA25',
    );
    if (bad) return bad;
  }

  // FA26 — an EMPTY body for the scoped fn.
  {
    const accountsSrc = `
pub(crate) fn provision_or_touch_account(ctx: &ReducerContext) -> Result<(), String> {}
`;
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII }),
      '[G12/scope]',
      'FA26',
    );
    if (bad) return bad;
  }

  // FA27 (red-team B4/F4, HIGH) — THE argument-ONE leak: the raw JWT `iss` is
  // passed as the "reducer name", which guards.rs:48-51 documents as an
  // unenforced convention. Kills: a reason-only (3rd-argument) PII check, which
  // is what the shipped Rust twin and the drafted JS clause both were.
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      '            log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_ISSUER);',
      `            let src_tag = claims.issuer();
            log_reject(src_tag, ctx.sender, REJECT_UNRECOGNIZED_ISSUER);`,
    );
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII }),
      '[G12/not-literal]',
      'FA27',
    );
    if (bad) return bad;
  }

  // FA28 — a dynamic reason (a local, not a literal const).
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      '        log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_AUDIENCE);',
      `        let detail = claims.audience().join(",");
        log_reject("client_connected", ctx.sender, &detail);`,
    );
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII }),
      '[G12/not-literal]',
      'FA28',
    );
    if (bad) return bad;
  }

  // FA29 — argument TWO is some other identity, misattributing the reject.
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      'log_reject("client_connected", ctx.sender, REJECT_UNRECOGNIZED_AUDIENCE);',
      'log_reject("client_connected", victim, REJECT_UNRECOGNIZED_AUDIENCE);',
    );
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII }),
      '[G12/not-literal]',
      'FA29',
    );
    if (bad) return bad;
  }

  // FA30 — the reason const is still static, but its VALUE now carries the
  // issuer URL. Kills: a "reason must be a const" check with no value pin.
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      'const REJECT_UNRECOGNIZED_ISSUER: &str = "unrecognized issuer";',
      'const REJECT_UNRECOGNIZED_ISSUER: &str = "unrecognized issuer https://acme.invalid/";',
    );
    const err = checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII });
    const bad = expectTag(err, '[G12/value-pin]', 'FA30');
    if (bad) return bad;
    if (err.indexOf('acme.invalid') === -1 || err.indexOf('unrecognized audience') === -1) {
      return `FA30: the value-pin message must print BOTH the found and the expected set: ${err}`;
    }
  }

  // FA31 — a claim bound to a RENAMED local and leaked through a different sink
  // (log::warn!), while both log_reject calls stay perfectly conformant.
  // Kills: an identifier-name list (the M21a red-team's rename evasion) and a
  // check scoped only to log_reject.
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      '    let now = now_ms(ctx);',
      `    let aud_tag = claims.audience().join(",");
    log::warn!("audience {}", aud_tag);
    let now = now_ms(ctx);`,
    );
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII }),
      '[G12/claim-binding]',
      'FA31',
    );
    if (bad) return bad;
  }

  // FA32 — GOOD: binding a claim to a local is LEGITIMATE (the issuer is stored
  // on the account row); only passing it to a log sink is not. Kills: a blanket
  // ban on `claims.issuer()` bindings, which would false-RED the shipped code.
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      '    let issuer = claims.issuer();',
      '    let iss = claims.issuer();',
    )
      .replace('issuer_allowed(issuer, ALLOWED_ISSUERS)', 'issuer_allowed(iss, ALLOWED_ISSUERS)')
      .replace('issuer.to_string()', 'iss.to_string()');
    const err = checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII });
    if (err) return `FA32: a legitimate (non-logged) claim binding was incorrectly flagged: ${err}`;
  }

  // FA35 (adversarial pass, NEW) — TWO evasions of [G12/claim-binding] at once,
  // both of which the pre-hardening clause was green on:
  //   (1) the taint is laundered through a SECOND binding (`let tag = iss;`),
  //       whose own initializer names no claim accessor — a one-hop rule sees
  //       nothing;
  //   (2) the sink is a project helper, `warn_issuer(..)`, whose callee segment
  //       equals none of the log-macro names while its body is `log::warn!`.
  // Kills: a single-hop taint, and a whole-segment-equality sink list.
  {
    const accountsSrc = GOOD_ACCOUNTS_PII.replace(
      '    let now = now_ms(ctx);',
      `    let iss = claims.issuer();
    let tag = iss;
    warn_issuer(tag);
    let now = now_ms(ctx);`,
    );
    if (accountsSrc === GOOD_ACCOUNTS_PII) {
      return 'FA35: the fixture substitution did not apply — the laundered leak was never injected';
    }
    const bad = expectTag(
      checkNoPiiInRejectLogs({ accountsSrc, libSrc: GOOD_LIB_PII }),
      '[G12/claim-binding]',
      'FA35',
    );
    if (bad) return bad;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: teeth first, then live-tree checks (all failures aggregated
// so the implementer sees the full to-do list in one run).
// ---------------------------------------------------------------------------

export default async function accountPrivacyEval() {
  const name =
    'account-privacy (private account/guest_claim/reaper tables, exact my_account view body, ' +
    'pinned view inventory, view-only bindings, no PII in connect-path reject logs)';

  const toothErr = runTeeth();
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

  const schemaFile = byPath('/schema.rs');
  const accountsFile = byPath('/accounts.rs');
  const libFile = byPath('/lib.rs');

  if (!schemaFile || !accountsFile) {
    failures.push(
      '[A/0-table] server-module/src/schema.rs and/or accounts.rs are missing from the ' +
        'scanned tree — check A cannot run',
    );
  } else {
    const errA = checkAccountViewsSafe({
      schemaSrc: schemaFile.src,
      accountsSrc: accountsFile.src,
      treeSrcs,
    });
    if (errA) failures.push(`[A account-views-safe] ${errA}`);
  }

  const errC = checkBindings((rel) => existsSync(rel));
  if (errC) failures.push(`[C bindings] ${errC}`);

  if (!accountsFile || !libFile) {
    failures.push(
      '[G12/scope] server-module/src/accounts.rs and/or lib.rs are missing from the scanned ' +
        'tree — check G cannot run',
    );
  } else {
    const errG = checkNoPiiInRejectLogs({ accountsSrc: accountsFile.src, libSrc: libFile.src });
    if (errG) failures.push(`[G no-pii-in-reject-logs] ${errG}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  return {
    name,
    pass: true,
    detail:
      `${treeSrcs.length} non-test server source file(s) scanned (stripper soundness proven on ` +
      'each); account, guest_claim and guest_claim_reaper_schedule are all private, ' +
      "my_account's body is EXACTLY the sender-keyed unique-index lookup, the module's view " +
      `inventory is exactly [${EXPECTED_VIEWS.join(', ')}], no private table emitted a client ` +
      'binding while my_account_table.ts is present, and every reject-log argument on the ' +
      'connect path is a static literal with reasons pinned to ' +
      `{${EXPECTED_REASONS.join(', ')}} (35 teeth verified)`,
  };
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): `node evals/account-privacy.eval.mjs` runs
// standalone with a non-zero exit on failure. No-op when imported by
// evals/run.mjs (process.argv[1] is run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await accountPrivacyEval();
    } catch (e) {
      return {
        name: 'account-privacy',
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
