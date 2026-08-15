// net/connection.test.ts — source-scan wiring invariants for nh4/authToken gate
// integration into connection.ts (EARS nh4-1/nh4-2/nh4-3).
//
// SOURCE OF TRUTH: nh4 spec — client/src/net/connection.ts gains exactly FOUR wiring
// points inside `export function connect(opts)`:
//   1. `const auth = createAuthTokenGate(opts.uri, opts.db, globalThis);` at connect()
//      scope (read fresh per rebuild, NOT hoisted to a value captured once).
//   2. `.withToken(auth.tokenForNextAttempt())` in the builder chain inside `build()`.
//   3. `auth.onConnected(token)` inside `.onConnect((c, id, token) => { ... })`, AFTER
//      the `if (stale()) return;` guard.
//   4. `auth.onConnectFailed(err)` inside `.onConnectError((_ctx, err: Error) => { ... })`,
//      AFTER the `if (stale()) return;` guard.
//
// ⚠ AMENDED BY M21b (ADR-0179). Point 3 above describes the nh4 shape, which is NO LONGER
// what this file pins: the save call site is now GUARDED on the build's auth kind
// (`if (buildKind === 'anon') auth.onConnected(token);`), and build() gains a FIFTH wiring
// point — `const buildKind = readAuthKind(globalThis, opts.uri, opts.db);`. Points 1, 2 and
// 4 are unchanged, and `.withToken(auth.tokenForNextAttempt())` stays byte-identical, which
// is what makes AUTH-31's "no behaviour change to the anonymous path" literally true. The
// full reasoning is in the M21b banner above W-M21B-KIND-READ and in the RE-PIN
// JUSTIFICATION directly above W-NH4-SAVE-WIRED. Left here rather than rewritten in place
// so the nh4 → M21b delta stays legible.
//
// ⚠ HISTORICAL — TRUE WHEN THE nh4 BLOCK WAS WRITTEN, FALSE NOW. The paragraph that stood
// here recorded the RED state at nh4 authoring time: "none of the four exist on the file as
// of this writing (connection.ts:485, 567) — `.onConnect((c, id) => {` with NO third
// `token` param, and no `.withToken(` call at all in the builder chain." All four wiring
// points have SHIPPED since; every nh4 gate below is a GREEN regression guard today, not a
// red gate. Corrected in place rather than deleted so the nh4 → M21b provenance survives:
// a stale "RED today" claim in a gating file teaches the next reader to discount failure
// messages that say RED today, which is how a real red gets waved through.
//
// WHY source-scan (NOT import): connection.ts is coverage-excluded in vite.config.ts
// specifically because it has DOM/wasm side effects (window.addEventListener,
// DbConnection.builder() touching the generated bindings) — importing it in vitest
// would crash on missing DOM/wasm globals. readFileSync + string matching proves the
// WIRING (the four call sites exist, in the right place, with the right shape)
// without executing any of it. This is the same idiom main.wiring.test.ts uses for
// main.ts (see F-3/F-5/nh1/nh2 sections there) — the helpers below are copied
// verbatim from that file (stripBlockComments / stripLineComments / regionOrThrow /
// expectUniqueAnchor / bodyRegion / squashWhitespace), adapted to say connection.ts.
//
// SPLIT OF DUTIES: this file proves WIRING ONLY (does connect() call the gate, in the
// right place, with the right shape). A sibling file (authToken.test.ts, a different
// agent) proves BEHAVIOR (does createAuthTokenGate actually classify rejections
// correctly, cap suppression, etc). A source scan structurally CANNOT catch a
// classifier hardcoded to `return true` (or any other behavioral bug) inside
// authToken.ts — it only sees that the call sites exist and are shaped correctly.
// Both files are required; neither substitutes for the other.
//
// NO `new RegExp(...)` anywhere in this file — Semgrep bans it repo-wide. All
// matching uses String.indexOf / .includes / .split / .startsWith only.
//
// ⚠ HISTORICAL — the "RED REASON (all 5 gates)" paragraph that stood here claimed
// `.withToken(` occurred ZERO times, `onConnect(` took two params, and the `authToken`
// module did not exist. All three were true at nh4 authoring time and are FALSE now: the
// nh4 wiring shipped, and the M21b marker wiring shipped on top of it.
//
// ⚠ READ THIS BEFORE TRUSTING ANY "RED today" / "RED TODAY" TEXT IN THIS FILE. This file
// has accreted gating blocks across five slices (nh4, ADR-0157 devlog, 11r-e wallet, EG4
// evolution, M21b marker). Each block's failure messages were written while ITS feature was
// unimplemented, so they say "RED today" about states that are long since shipped. They are
// AUTHORING-TIME PROVENANCE, not current status — every gate in this file is a green
// regression guard unless a specific test says otherwise in its own body. Left in place
// rather than swept, because those sentences also record WHAT THE BUG LOOKED LIKE, which is
// the most useful thing a failure message can tell the person who just re-introduced it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONNECTION_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'connection.ts');

function readConnectionTs(): string {
  try {
    return readFileSync(CONNECTION_TS_PATH, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(
      'connection.ts could not be read at expected path: ' +
        CONNECTION_TS_PATH +
        ' — ' +
        String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers copied verbatim from main.wiring.test.ts (nh1/nh2 idiom).
// ---------------------------------------------------------------------------

// Drop `/* ... */` block comments (multi-line-aware, marker-scan not regex) THEN `//`
// line comments, so a needle parked only in a comment cannot satisfy a tooth.
function stripBlockComments(src: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      out += src.slice(i);
      return out;
    }
    out += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) {
      return out;
    }
    i = end + 2;
  }
}

function stripLineComments(src: string): string {
  const withoutBlocks = stripBlockComments(src);
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/** Generic "slice from START needle to END needle" region extractor. Throws loud
 *  (never returns an empty/negative slice) if either needle is missing or END does
 *  not follow START, so a missing implementation is a HARD RED (thrown error), never
 *  a vacuous pass. */
function regionOrThrow(src: string, startNeedle: string, endNeedle: string, fromIdx = 0): string {
  const startIdx = src.indexOf(startNeedle, fromIdx);
  if (startIdx < 0) {
    throw new Error(`connection.ts must contain "${startNeedle}" (nh4 region start)`);
  }
  const endIdx = src.indexOf(endNeedle, startIdx);
  if (endIdx < 0) {
    throw new Error(
      `connection.ts must contain "${endNeedle}" AFTER "${startNeedle}" (nh4 region end)`,
    );
  }
  if (endIdx <= startIdx) {
    throw new Error(`"${endNeedle}" must appear AFTER "${startNeedle}" (nh4 region)`);
  }
  return src.slice(startIdx, endIdx);
}

/** Anti-vacuity: an anchor that occurs more than once means indexOf may resolve to
 *  the wrong occurrence and the region silently covers the wrong code (or nothing);
 *  an anchor that occurs zero times means the region is gone. Both are hard reds. */
function expectUniqueAnchor(src: string, needle: string): void {
  expect(
    src.split(needle).length - 1,
    `nh4 anchor "${needle}" must appear EXACTLY once in connection.ts — a duplicated or ` +
      'deleted anchor lets a needle-bounded region silently cover the wrong code (or ' +
      'collapse), which is how a source-scan tooth goes vacuously green (nh1 post-mortem)',
  ).toBe(1);
}

/** Needle-bounded region BODY, comment-stripped. Sliced from RAW source (so comment
 *  anchors still resolve), then the anchor's own line is dropped (it may sit inside a
 *  `//` comment and so would not be stripped by stripLineComments), and the rest is
 *  comment-stripped so commented-out code cannot satisfy a tooth. */
function bodyRegion(src: string, startNeedle: string, endNeedle: string): string {
  const raw = regionOrThrow(src, startNeedle, endNeedle);
  const nl = raw.indexOf('\n');
  if (nl === -1) {
    throw new Error(
      `nh4 region "${startNeedle}" -> "${endNeedle}" collapsed to a single line — the ` +
        'block body is missing; refusing to scan a degenerate region',
    );
  }
  return stripLineComments(raw.slice(nl + 1));
}

/** Collapse every run of whitespace to ONE space so a contiguous-substring assertion
 *  is immune to prettier/biome line-wrapping. Hand-rolled scan — new RegExp is banned. */
function squashWhitespace(text: string): string {
  let out = '';
  let inWs = false;
  for (const ch of text) {
    const isWs = ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
    if (isWs) {
      if (!inWs) out += ' ';
      inWs = true;
    } else {
      out += ch;
      inWs = false;
    }
  }
  return out;
}

/** Count NON-OVERLAPPING occurrences of `needle` in `src` via split (no `new RegExp`).
 *  11r-e: added because this file's helper family (copied from main.wiring.test.ts)
 *  omitted it; this is the verbatim main.wiring.test.ts:2557-2560 form, NOT a parallel
 *  helper family. */
function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// STRING-LITERAL-AWARE occurrence finder (M21b-2 hardening — coordinator review).
//
// THE HOLE THIS CLOSES: stripLineComments removes COMMENTS but PRESERVES string- and
// template-literal TEXT verbatim (it must — a literal is code). So every tooth that
// proves "the code does X" with a bare countOccurrences/indexOf/.includes on squashed
// source can be satisfied by an INERT DECOY:
//     const _decoy = 'const outcome = await oidc.renewOrExchange();';
// leaves the needle present, at the right ordinal position, while the REAL call is
// absent. The KeyC handler tooth in main.wiring.test.ts is immune because it uses exact
// whole-block equality; the order/count teeth below were not, until this.
//
// `codeOccurrences` returns the start index of every occurrence of `needle` that BEGINS
// in CODE — i.e. not inside a '…' / "…" / `…` literal — via a single quote-state-aware
// forward pass (backslash-escape-aware; an unescaped newline ends a '…'/"…" literal, as
// JS requires, so a stray apostrophe cannot swallow the file). A needle whose start is
// code but which spans INTO a quote (e.g. `if (credential.kind === 'retry') {`) is still
// matched — only a needle whose START sits inside a literal is excluded, which is exactly
// the decoy class. NO `new RegExp` — this file's standing convention.
//
// NOTE ON APPLICABILITY: use this ONLY for needles that are CODE (statements, method
// calls, identifiers). Needles that are string literals BY NATURE — the
// `'SELECT * FROM my_account'` subscribe strings — must keep plain countOccurrences,
// because their whole point is to be counted INSIDE a string.
function codeOccurrences(code: string, needle: string): number[] {
  const out: number[] = [];
  let mode = 0; // 0 code, 1 single, 2 double, 3 template
  for (let i = 0; i < code.length; i += 1) {
    const ch = code.charAt(i); // charAt (not [i]) — always string, like m20cScan
    if (mode === 0) {
      if (ch === "'") mode = 1;
      else if (ch === '"') mode = 2;
      else if (ch === '`') mode = 3;
      else if (code.startsWith(needle, i)) out.push(i);
    } else {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      const closer = mode === 1 ? "'" : mode === 2 ? '"' : '`';
      if (ch === closer) mode = 0;
      else if (mode !== 3 && ch === '\n') mode = 0; // unterminated '…'/"…": bail to code
    }
  }
  return out;
}

/** Count of occurrences of `needle` that begin in CODE (not inside a string literal). */
function countCodeOccurrences(code: string, needle: string): number {
  return codeOccurrences(code, needle).length;
}

/** True iff `needle` occurs at least once as CODE (not only inside a decoy string). */
function includesAsCode(code: string, needle: string): boolean {
  return codeOccurrences(code, needle).length >= 1;
}

// ---------------------------------------------------------------------------
// M21b-2 (ADR-0182 D13) — THE ONE SHARED build() ANCHOR.
//
// ★★ RE-PIN JUSTIFICATION #1 (tester-owned; reviewer checklist item) ★★
// Master pinned `function build(): DbConnection {` at EIGHT sites in this file
// (265, 269, 279, 297, 300, 454, 458, 479 — three of them `expectUniqueAnchor`).
// ADR-0182 D13 changes that signature to
// `function build(credential: ConnectCredential): DbConnection | undefined {`:
// build() now takes the credential as an EXPLICIT PARAMETER (so staleness is
// structurally impossible — no closure-captured mutable) and may DECLINE to
// return a connection (the read-side guard M21b deliberately parked, see the
// scope ruling below at :341-350, which said in as many words that this cascade
// "belongs with M21b-2").
//
// WHAT CHANGES AND WHAT DOES NOT: only the anchor TEXT. Every assertion those
// eight sites carried — gate-constructed-before-build, the region bound at
// `wireTables(conn);`, the token pin, the region-membership negatives — is
// carried forward unrelaxed against the new anchor. A reviewer auditing this
// re-pin should check exactly that: same assertions, new needle.
//
// WHY A SHARED CONST AND NOT EIGHT LITERALS: eight copies of a signature is
// eight chances for the next re-pin to be done five times out of eight, leaving
// three teeth silently anchored on a string that no longer exists — which
// `expectUniqueAnchor` reports as a HARD RED (count 0), but the bare `indexOf`
// sites would report as `-1`, i.e. an ordering assertion comparing against -1.
// One const makes the next re-pin atomic.
// ---------------------------------------------------------------------------

/** ADR-0182 D13's exact build() signature. RE-PINNED from `function build(): DbConnection {`. */
const M21B2_BUILD_ANCHOR =
  'function build(credential: ConnectCredential): DbConnection | undefined {';

// ---------------------------------------------------------------------------
// W-NH4-GATE-CONSTRUCTED — connect() builds the gate.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4): W-NH4-GATE-CONSTRUCTED — connect() builds the auth token gate', () => {
  it('BITES: contains createAuthTokenGate(opts.uri, opts.db, globalThis) exactly once (squashed, comment-stripped)', () => {
    // WRONG IMPL KILLED: no gate built at all (current state — the needle occurs
    // zero times). RED today.
    // WRONG IMPL KILLED: a gate built from only ONE of uri/db (e.g.
    // `createAuthTokenGate(opts.uri, globalThis)` or `createAuthTokenGate(opts.db,
    // globalThis)`) — the exact-argument-list pin requires BOTH key axes present in
    // this exact order, so a collapsed signature does not satisfy this contiguous
    // substring.
    const src = readConnectionTs();
    const squashed = squashWhitespace(stripLineComments(src));
    const needle = 'const auth = createAuthTokenGate(opts.uri, opts.db, globalThis)';
    const count = squashed.split(needle).length - 1;
    expect(
      count,
      'connection.ts must contain exactly one occurrence of ' +
        `"${needle}" — RED today: createAuthTokenGate does not appear in connection.ts ` +
        'at all',
    ).toBe(1);
  });

  it('authToken appears in an import statement', () => {
    // WRONG IMPL KILLED: createAuthTokenGate used without being imported (would not
    // typecheck, but this is a structural belt-and-suspenders check independent of tsc).
    const src = readConnectionTs();
    const stripped = stripLineComments(src);
    const importIdx = stripped.indexOf('import');
    const authTokenIdx = stripped.indexOf('authToken');
    expect(
      authTokenIdx,
      'connection.ts must reference the authToken module',
    ).toBeGreaterThanOrEqual(0);
    // The import block sits at the top of the file (before `export interface
    // ConnectionOptions`); a reference to 'authToken' found before that marker is
    // necessarily part of an import statement (no other top-of-file code references
    // it pre-impl).
    const beforeInterfaceIdx = stripped.indexOf('export interface ConnectionOptions');
    expect(
      importIdx,
      'connection.ts must have at least one import statement',
    ).toBeGreaterThanOrEqual(0);
    expect(
      authTokenIdx,
      "'authToken' must appear in an import statement (before " +
        '`export interface ConnectionOptions`) — RED today: no such import exists',
    ).toBeLessThan(beforeInterfaceIdx === -1 ? Number.POSITIVE_INFINITY : beforeInterfaceIdx);
  });

  it('BITES (CRITICAL): createAuthTokenGate( is constructed at connect() SCOPE, BEFORE build()`s declaration — NOT re-created inside build() — mutant killed: "gate recreated per build ⇒ counter resets every attempt ⇒ suppression never engages ⇒ permanent auth-reject loop"', () => {
    // WRONG IMPL KILLED: `const auth = createAuthTokenGate(opts.uri, opts.db,
    // globalThis);` moved INSIDE build(). build() is (since ADR-0182 D13, via
    // attemptBuild) re-invoked on every reconnect attempt, so a per-build
    // gate would get a FRESH in-memory rejection counter on every single attempt —
    // AUTH_REJECT_SUPPRESS_THRESHOLD can never be reached across attempts,
    // suppression never engages, and a rejected stored credential produces exactly
    // the permanent, unrecoverable reconnect loop ADR-0150 D2 exists to close. This
    // mutant is invisible to every OTHER gate in this file (all six only check that
    // the needle occurs "somewhere" in the file) and invisible to every behavior
    // test in authToken.test.ts (which only exercises a single gate instance in
    // isolation) — this is the only tooth that pins the declaration's SCOPE.
    const src = readConnectionTs();
    expectUniqueAnchor(src, 'createAuthTokenGate(');
    expectUniqueAnchor(src, M21B2_BUILD_ANCHOR);
    expectUniqueAnchor(src, 'wireTables(conn);');

    const gateIdx = src.indexOf('createAuthTokenGate(');
    const buildIdx = src.indexOf(M21B2_BUILD_ANCHOR);
    expect(
      gateIdx,
      `createAuthTokenGate( must be constructed BEFORE \`${M21B2_BUILD_ANCHOR}\` ` +
        '(i.e. at connect() scope, read fresh per rebuild via a closure, not ' +
        're-created on every build() invocation) — a gate built inside build() gets a ' +
        'fresh in-memory rejection counter on every reconnect attempt, so suppression ' +
        'never engages',
    ).toBeLessThan(buildIdx);

    const body = bodyRegion(src, M21B2_BUILD_ANCHOR, 'wireTables(conn);');
    expect(
      body.includes('createAuthTokenGate('),
      'createAuthTokenGate( must NOT be called anywhere inside build() — gate recreated ' +
        'per build ⇒ counter resets every attempt ⇒ suppression never engages ⇒ permanent ' +
        'auth-reject loop',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W-NH4-TOKEN-SUPPLIED (RE-PINNED by M21b-2 / G13) — the builder chain supplies
// the token for THIS build's credential, read freshly per build.
//
// ★★ RE-PIN JUSTIFICATION #2 (tester-owned; reviewer checklist item) ★★
// M21b's own scope ruling (:341-350 below) said this tooth "stands byte-for-byte
// as it shipped" because the read-side guard was cut from that slice. M21b-2 is
// the slice that ruling deferred it to, and `authToken.ts:263-305`'s doc comment
// prescribes the change VERBATIM: "the discriminator must become the PROVENANCE
// of the credential this build actually supplied... will require re-pinning
// `W-NH4-TOKEN-SUPPLIED`". ADR-0182 D14 spells the new literal out.
//
// WHAT MASTER'S TOOTH ASSERTED (re-read from the file, not from memory): the
// contiguous `.withToken(auth.tokenForNextAttempt())` inside build()'s region,
// and `.withToken(` occurring exactly once file-wide. BOTH are carried forward:
// the count is untouched, and the contiguous pin becomes the D14 ternary — which
// still contains `auth.tokenForNextAttempt()` as the ANON branch, so the
// anonymous path's behaviour is still pinned byte-for-byte (AUTH-31's "no
// behaviour change to the anonymous path" survives this slice too).
//
// WHY `=== 'account'` AND NOT `!== 'anon'` (D14, and the same fail-CLOSED
// argument the save guard below already makes ON THE VALUE): `ConnectCredential`
// has SIX variants, not two. A `!== 'anon'` ternary hands `credential.token` to
// the builder for every future seventh variant by default; `=== 'account'` hands
// it over only for the one variant that is TYPED to carry a string token.
// ---------------------------------------------------------------------------

/** ADR-0182 D14's exact builder-chain token supply. RE-PINNED from
 *  `.withToken(auth.tokenForNextAttempt())`. The anon branch is byte-identical to the
 *  literal master pinned, which is what keeps AUTH-31's anonymous-path claim true. */
const M21B2_WITHTOKEN =
  ".withToken(credential.kind === 'account' ? credential.token : auth.tokenForNextAttempt())";

describe('connection.ts wiring (nh4, RE-PINNED by M21b-2 / G13): W-NH4-TOKEN-SUPPLIED — the builder chain supplies THIS build`s credential', () => {
  it('★ BITES: build() region contains the exact contiguous D14 .withToken(...) ternary and .withToken( occurs exactly once file-wide', () => {
    // Region-bound to build(): both anchors must be unique first (anti-vacuity).
    const src = readConnectionTs();
    expectUniqueAnchor(src, M21B2_BUILD_ANCHOR);
    expectUniqueAnchor(src, 'wireTables(conn);');

    const body = bodyRegion(src, M21B2_BUILD_ANCHOR, 'wireTables(conn);');
    const squashedBody = squashWhitespace(body);

    // WRONG IMPL KILLED (a): no .withToken( at all.
    // WRONG IMPL KILLED (b): .withToken(undefined) / .withToken('') / .withToken(void 0)
    //   — the exact-argument pin rejects all of them.
    // WRONG IMPL KILLED (c): .withToken(auth.tokenForNextAttempt() && '') — a truthy-left
    //   short-circuit that silently disables persistence while keeping both tokens
    //   textually present; this exact-contiguous pin rejects the extra ` && ''`.
    // WRONG IMPL KILLED (d) ★ THE G13 MUTANT: the guard inverted to
    //   `credential.kind !== 'anon' ? credential.token : …`. Behaviourally identical
    //   TODAY (only 'anon' and 'account' ever reach build() — D13's defensive belt
    //   rejects the other four), and fail-OPEN the moment a seventh variant is added:
    //   a variant with no `token` field would supply `undefined` to a builder that has
    //   just been told this connection is authenticated. The contiguous needle admits
    //   only the fail-closed `=== 'account'` form.
    // WRONG IMPL KILLED (e): re-deriving the branch from STORAGE —
    //   `.withToken(readAuthKind(globalThis, opts.uri, opts.db) === 'account' ? …)`.
    //   Rejected here by the contiguous needle AND, independently and at the
    //   argument-region level, by W-M21B2-CREDENTIAL-IS-PROVENANCE (G14) below.
    expect(
      // CODE-AWARE (coordinator review): a decoy `const _x = '….withToken(credential.kind
      // === 'account' …)';` would satisfy a bare .includes while build() supplied the anon
      // token. The whole ternary begins in code, so codeOccurrences excludes the decoy.
      includesAsCode(squashedBody, M21B2_WITHTOKEN),
      `build() builder chain must call ${M21B2_WITHTOKEN} exactly as written (ADR-0182 D14). ` +
        'RED AT AUTHORING TIME: connection.ts still ships the M21b literal ' +
        '`.withToken(auth.tokenForNextAttempt())`, which supplies the ANONYMOUS token on ' +
        'every build — including the builds that just exchanged an OIDC code for an account ' +
        'JWT, i.e. the account population silently connects anonymously forever. Do NOT ' +
        'loosen this needle; re-derive it from ADR-0182 D14 if it ever needs to change',
    ).toBe(true);

    // WRONG IMPL KILLED (f): the read hoisted to connect() scope with a closed-over
    // variable passed instead — e.g. `const token = auth.tokenForNextAttempt();` at
    // connect() scope, with `.withToken(token)` inside build(). A dead
    // `auth.tokenForNextAttempt()` call left inside build() (to satisfy a naive
    // presence needle) would NOT satisfy this contiguous-argument pin, because the
    // call must appear literally as the argument to .withToken(.
    // WRONG IMPL KILLED (g): a second, later .withToken(...) overriding the first —
    // killed by the exactly-once file-wide count below. (CARRIED FORWARD UNCHANGED
    // from master — the count is not relaxed by the re-pin.)
    const wholeSquashed = squashWhitespace(stripLineComments(src));
    expect(
      // CODE-AWARE count: a decoy string containing `.withToken(` must not count, and — the
      // real bypass — a decoy that IS the only `.withToken(` (real builder omits it) must red.
      countCodeOccurrences(wholeSquashed, '.withToken('),
      '.withToken( must occur exactly once AS CODE in connection.ts — a second later call ' +
        'would silently override the first, zero code occurrences is the RED-today bug, and a ' +
        'decoy inside a string literal does not count',
    ).toBe(1);
  });
});

// ===========================================================================
// M21b (ADR-0179 / EARS AUTH-31) — the auth-KIND discriminator and the guard on
// the anonymous token slot.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-M21b-plan.md, ADDENDUM section
// (which SUPERSEDES the body of that memo), plus the coordinator's scope ruling
// recorded below.
//
// ★★ SCOPE RULING (why this slice is the WRITE-SIDE half only) ★★
// The plan's `decideConnectCredential` / `SESSION_EXPIRED_MESSAGE` /
// `onSessionExpired` read-side guard is CUT from this slice and ships with
// M21b-2. It cannot be built here: the guard's early exit needs `build()` to be
// able to decline to return a connection, i.e. `DbConnection | undefined`, which
// cascades into `let current = build()`, the `get conn()` accessor, and every
// `conn.conn.reducers.*` call site in main.ts — a public-surface change far
// outside this slice, and one that belongs with the cold-start contract (parked
// item 6) it depends on. The type system was reporting a real dependency, not a
// puzzle to route around.
//
// WHAT SHIPS HERE is coherent on its own, typechecks trivially, and has zero
// blast radius: the auth-kind marker (authToken.ts, additive) plus ONE guard —
// the anonymous token slot must never receive an account JWT.
//
//     function build(): DbConnection {          // signature UNCHANGED
//       const gen = ++buildGen;
//       const stale = (): boolean => gen !== buildGen;
//       const buildKind = readAuthKind(globalThis, opts.uri, opts.db);
//       ... .withToken(auth.tokenForNextAttempt())   // UNCHANGED from today
//           .onConnect((c, id, token) => {
//             if (stale()) return;
//             if (buildKind === 'anon') auth.onConnected(token);
//
// ★★ CONSEQUENCE FOR THE GATING TESTS — HISTORICAL, SUPERSEDED BY M21b-2 ★★
// The paragraph that stood here recorded M21b's OWN scope ruling: that
// `W-NH4-TOKEN-SUPPLIED` was "NOT re-pinned … stands byte-for-byte as it
// shipped", that `.withToken(auth.tokenForNextAttempt())` "stays byte-identical",
// and that "exactly ONE pre-existing tooth changes this slice". All three
// sentences were TRUE OF M21b and are FALSE OF M21b-2, which is the slice M21b's
// own ruling deferred the read side to. Corrected in place rather than deleted so
// the M21b → M21b-2 provenance survives; the current re-pin ledger is:
//   • W-NH4-GATE-CONSTRUCTED — anchor text only (M21B2_BUILD_ANCHOR), assertions
//     carried forward verbatim.
//   • W-NH4-TOKEN-SUPPLIED  — RE-PINNED (G13, ADR-0182 D14). Justification #2, above.
//   • W-NH4-SAVE-WIRED      — RE-PINNED (G13b, D13/D14). Justification #3, below.
//   • W-M21B-KIND-READ      — RETIRED WHOLESALE (G14). Replacement + justification #4.
//   • W-DEVLOG-WRAP         — RE-PINNED twice (G15 end anchor; G15b joinGame receiver,
//     D16). Justification #5, at the tooth.
// `W-NH4-FAILURE-WIRED`, `W-NH4-NO-CLEAR-ON-DROP`, `SDK-DRIFT`, every `W-UX2B-*`,
// `M13_5C_CONVERSATION_INGEST_CONTROL`, the scheme-literal calibration fixture in
// W-UX2B-SCAN-SOUND and every EG4 tooth are NOT touched by M21b-2.
//
// ⚠ THE HAZARD THIS SLICE KNOWINGLY LEAVES OPEN (named, not hidden): the
// write-side guard alone is NOT sufficient. With the read side parked, a marker
// of `'account'` means the account token is not STORED (correct) while the next
// build still supplies the stale ANON token via the unchanged
// `.withToken(auth.tokenForNextAttempt())` — a silent drop to a different
// identity. Nothing in this slice writes `'account'`, and `writeAuthKind` is
// required to carry that prohibition as a comment, pinned by a source-scan tooth
// in authToken.test.ts so it cannot be silently deleted.
//
// NO `new RegExp(...)` — this file's standing convention.
// ===========================================================================

/** The kind-guarded save, RE-PINNED by M21b-2 (G13b). `=== 'anon'` (not `!== 'account'`) is
 *  still the FAIL-CLOSED direction ON THE VALUE — `ConnectCredential` now has SIX variants,
 *  so a `!==` guard would write five of them into the anonymous slot by default. The only
 *  change from M21b is the DISCRIMINATOR: `buildKind` (a lossy sessionStorage re-read) becomes
 *  `credential.kind` (the in-memory PROVENANCE of the token this build actually supplied),
 *  which is exactly the fix `authToken.ts:263-305` and ADR-0182 D14 prescribe. */
const M21B2_SAVE_GUARDED = "if (credential.kind === 'anon') auth.onConnected(token);";

// ---------------------------------------------------------------------------
// W-M21B-KIND-READ — ★ RETIRED WHOLESALE BY M21b-2 (G14). Replaced by
// W-M21B2-CREDENTIAL-IS-PROVENANCE, directly below.
//
// ★★ RE-PIN JUSTIFICATION #4 (tester-owned; reviewer checklist item) ★★
// The retired tooth pinned `const buildKind = readAuthKind(globalThis, opts.uri,
// opts.db);` inside build(), `readAuthKind(` at exactly one call site, and a
// family of anti-shim identifier counts. Every one of those assertions is about a
// STORAGE RE-READ that ADR-0182 D14 DELETES from connection.ts outright: the
// discriminator is now the `credential` parameter build() is handed, computed in
// memory by resolveCredential() on the same attempt that produced the token.
// There is no binding left to pin, no call site left to count, and no shim left
// to defeat — the identifier is simply gone from the file.
//
// SOFTENING WAS NOT AN OPTION, AND NEITHER WAS SILENCE. Re-pointing the old
// tooth's needles at `wasEverAuthenticated` would have been the WRONG repair: the
// retired tooth's whole thesis is "the save guard must read the value THIS BUILD
// DECIDED ON", and `wasEverAuthenticated` is a storage read with the same TOCTOU
// exposure `buildKind` had. The replacement below therefore asserts the STRONGER,
// D14-shaped property in the opposite direction: `readAuthKind` must not appear in
// connection.ts AT ALL, and nothing storage-derived may reach `.withToken(`'s
// argument. That is a strict strengthening, not a relaxation — the class of
// implementations that pass shrank.
//
// WHAT MOVES WHERE: the "readAuthKind is invoked at exactly one call site" pin is
// not lost, it MIGRATES to authToken.test.ts (G14(ii)), where the one surviving
// call site now lives — inside `wasEverAuthenticated`'s own body. Different file,
// different agent, same invariant. Neither half is sufficient alone.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W-M21B2-CREDENTIAL-IS-PROVENANCE (NEW, G14(i) + addendum §C F3) — the write-side
// discriminator traces to `credential`, never to storage.
//
// THE INVARIANT: connection.ts must contain ZERO storage reach of any kind. The
// attempt-gating hint it IS allowed to consult (`wasEverAuthenticated`) is behind
// authToken.ts's injected-host boundary, and its answer must never reach the token
// supplied to the builder — only `credential` may.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-43/44, G14): W-M21B2-CREDENTIAL-IS-PROVENANCE — the discriminator is the credential, never storage', () => {
  it('★ BITES: readAuthKind is GONE from connection.ts, wasEverAuthenticated is the only storage-backed read, and no AuthKind token reaches .withToken(`s argument', () => {
    // WRONG IMPL KILLED (a) ★ THE HEADLINE G14 MUTANT: the write-guard re-derived from
    //   storage — `.withToken(readAuthKind(globalThis, opts.uri, opts.db) === 'account' ?
    //   … : …)`, or the same read bound to a local and passed in. It is the single most
    //   natural way to "port" the retired M21b tooth's shape into the new signature, and
    //   it re-opens exactly the TOCTOU the retired tooth's own comment describes: the
    //   marker is mutable sessionStorage the OIDC return leg writes mid-session, so a
    //   build that supplied an ANON token can be told it supplied an account one (and
    //   vice-versa). Killed twice below: `readAuthKind` occurs ZERO times file-wide, and
    //   the `.withToken(` ARGUMENT REGION contains no storage-derived identifier at all.
    // WRONG IMPL KILLED (b): `wasEverAuthenticated(...)` smuggled into the ternary —
    //   `.withToken(wasEverAuthenticated(globalThis, opts.uri, opts.db) ? credential.token
    //   : auth.tokenForNextAttempt())`. This one TYPECHECKS, reads plausibly ("we were
    //   authenticated once, so send the account token"), and is wrong in the most
    //   dangerous direction: `wasEverAuthenticated` is STICKY FOR THE TAB'S LIFE (D14), so
    //   every later anonymous rebuild would try to send `credential.token` — `undefined`
    //   on an anon credential. The argument-region scan is the only thing that sees it;
    //   G13's contiguous needle would too, but only because it happens to be exact —
    //   this pin states the RULE rather than relying on the coincidence.
    // WRONG IMPL KILLED (c) — addendum §C F3: storage reached DIRECTLY from
    //   connection.ts, bypassing authToken.ts's injected-host boundary entirely
    //   (`globalThis.sessionStorage?.getItem('mr.authKind.v1|…')`). connection.ts is
    //   COVERAGE-EXCLUDED (vite.config.ts), so any storage logic that migrates here
    //   becomes permanently unprovable — that is authToken.ts's stated charter, and this
    //   is it mechanised. The four bans below are whole-file and deliberately blunt.
    // WRONG IMPL KILLED (d): a namespace import (`import * as authToken from
    //   './authToken'`) used to reach `authToken.readAuthKind(...)` — which every
    //   named-identifier count in this tooth would MISS, because the bare identifier
    //   `readAuthKind` still appears… as a property access. `import *` is banned outright;
    //   named imports only.
    const src = readConnectionTs();
    const wholeSquashed = squashWhitespace(stripLineComments(src));

    // --- (1) readAuthKind is GONE from this file ----------------------------------------
    expect(
      countOccurrences(wholeSquashed, 'readAuthKind'),
      'the readAuthKind IDENTIFIER must occur ZERO times in connection.ts (comment-stripped). ' +
        'ADR-0182 D14 moves the ONE surviving call site inside authToken.ts, behind ' +
        '`wasEverAuthenticated` — where authToken.test.ts (G14(ii)) pins it. A single ' +
        'occurrence here means the write-side discriminator is being re-derived from mutable ' +
        'storage instead of from the credential this build actually supplied. RED AT ' +
        'AUTHORING TIME: connection.ts:25 imports it and :538 calls it',
    ).toBe(0);

    // --- (2) wasEverAuthenticated is the ONLY storage-backed read, and it is ATTEMPT-GATING
    // COUNT DERIVED FROM ADR-0182 D13's NORMATIVE resolveCredential() SNIPPET, NOT from the
    // plan: D13 calls it TWICE and the second call is deliberate —
    //   (i)  `const attemptGateOpen = wasEverAuthenticated(globalThis, opts.uri, opts.db) ||
    //        isReturnLegAttempt;`  — the pre-flight gate (G17 pins this whole statement), and
    //   (ii) the `everAuthenticated` ARGUMENT to `decideConnectCredential(...)`, re-read
    //        AFTER the await so the decision table sees the marker as it stands once the
    //        renewal attempt has settled, not as it stood before the network call.
    // ⚠ The M21b-2 plan's §3 G14 row says `=== 1`. That number predates D13's snippet and
    // would RED a verbatim implementation of the ADR. The ADR is the authority
    // ("implements-as-written"), so the count is 2. Do NOT "fix" connection.ts to make this
    // 1 — if the second read is ever genuinely removed, re-derive this number from D13 and
    // say so here.
    expect(
      countOccurrences(wholeSquashed, 'wasEverAuthenticated('),
      'wasEverAuthenticated( must be INVOKED exactly twice in connection.ts — the ' +
        '`attemptGateOpen` derivation and the `everAuthenticated` argument to ' +
        'decideConnectCredential (ADR-0182 D13). The import specifier carries no paren and ' +
        'is not a call site. RED AT AUTHORING TIME: 0 — the function does not exist yet',
    ).toBe(2);
    expect(
      countOccurrences(wholeSquashed, 'wasEverAuthenticated'),
      'the wasEverAuthenticated IDENTIFIER must occur EXACTLY 3 times: the ./authToken ' +
        'import specifier plus the two call sites above. A 4th occurrence is a local shim, ' +
        'an alias or a third consumer — the same anti-shim reasoning the RETIRED ' +
        'W-M21B-KIND-READ applied to readAuthKind, carried over to the identifier that ' +
        'replaced it',
    ).toBe(3);

    // --- (3) every AuthKind mention is part of writeAuthKind ----------------------------
    // `writeAuthKind` CONTAINS the substring `AuthKind`, so an equality between the two
    // counts is the exact statement "no bare AuthKind type/token appears anywhere" — which
    // is what stops the credential's construction from being typed, annotated or branched
    // on a storage-shaped value. D14 keeps writeAuthKind (the first-paint UX HINT, written
    // in onConnect for account builds); it deletes every READ.
    expect(
      countOccurrences(wholeSquashed, 'writeAuthKind'),
      'writeAuthKind must occur EXACTLY twice: the ./authToken import specifier and the ONE ' +
        "onConnect gate `if (credential.kind === 'account') writeAuthKind(globalThis, " +
        "opts.uri, opts.db, 'account');` (ADR-0182 D13/D14 — a first-paint HINT, superseded " +
        "by my_account's first snapshot, never a security input)",
    ).toBe(2);
    expect(
      countOccurrences(wholeSquashed, 'AuthKind'),
      'every occurrence of the substring `AuthKind` in connection.ts must be part of ' +
        '`writeAuthKind` (2). A third is a bare `AuthKind` type import or annotation, which ' +
        "means a storage-shaped value is being given a name in the credential's own type " +
        'space — the first step of re-deriving provenance from the marker (D14 anti-pattern 2)',
    ).toBe(2);

    // --- (4) addendum §C F3: NO storage reach of any kind from this file ----------------
    // `sessionStorage`/`localStorage` are already banned whole-file by W-NH4-SAVE-WIRED
    // (carried forward there unchanged); `getItem(` and `import *` are the two new bans F3
    // adds, and they close the two spellings that ban could not see: a read (rather than a
    // write) through any host object, and a namespace import that turns every named-identifier
    // count in this file into a false negative.
    for (const reach of ['sessionStorage', 'localStorage', 'getItem(', 'import *']) {
      expect(
        countOccurrences(wholeSquashed, reach),
        `connection.ts must contain NO occurrence of "${reach}" — storage belongs to ` +
          'authToken.ts / claimCode.ts behind an INJECTED host (their module headers: never a ' +
          'globalThis reach from inside), and connection.ts is coverage-excluded, so any ' +
          'storage logic that migrates here can never be behaviourally proven. `import *` is ' +
          'banned for a second, independent reason: a namespace import defeats every ' +
          'named-identifier count in this file at once',
      ).toBe(0);
    }

    // --- (5) the .withToken( ARGUMENT REGION traces only to `credential` ----------------
    // Region = the builder-chain segment from the token supply to the onConnect handler.
    //
    // ⚠ SLICED FROM THE COMMENT-STRIPPED SOURCE, and the uniqueness checks run against THAT
    // SAME STRING — the fix W-NH4-NO-CLEAR-ON-DROP records for itself, and it is load-bearing
    // here: connection.ts's own M21b rationale comment contains the prose "hands straight back
    // to `.withToken()` on the next build", so a RAW-source `expectUniqueAnchor(src,
    // '.withToken(')` finds TWO occurrences and reds on CORRECT code. Strip first, then slice.
    const strippedSrc = stripLineComments(src);
    expectUniqueAnchor(strippedSrc, '.withToken(');
    expectUniqueAnchor(strippedSrc, '.onConnect((c, id, token) => {');
    const tokenArgRegion = squashWhitespace(
      regionOrThrow(strippedSrc, '.withToken(', '.onConnect((c, id, token) => {'),
    );
    // ANTI-VACUITY, ASSERTED FIRST: the region really is the token supply. Without this a
    // mis-resolved region would satisfy all four negatives below by being empty.
    expect(
      tokenArgRegion.includes('credential.token'),
      'ANTI-VACUITY: the .withToken( argument region must contain `credential.token` — if it ' +
        'does not, this scan is judging the wrong region (or the D14 ternary is missing, ' +
        'which G13 reports on its own line) and every negative below is vacuous',
    ).toBe(true);
    for (const forbidden of ['wasEverAuthenticated', 'readAuthKind', 'AuthKind', 'auth.kind']) {
      expect(
        countOccurrences(tokenArgRegion, forbidden),
        `the .withToken( argument must not mention "${forbidden}" — ADR-0182 D14: the token ` +
          'supplied to the builder is decided by `credential` ALONE, computed in memory on ' +
          'this same attempt. Anything storage-derived in this expression re-opens the ' +
          'marker-desync replay M21b could only ever mitigate, and does it on the PERMISSIVE ' +
          'side (a sticky `wasEverAuthenticated` says "yes" forever)',
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// W-NH4-SAVE-WIRED (RE-PINNED TWICE: M21b, then M21b-2 / G13b) — the token is
// captured on connect, under the stale guard AND under the build's credential.
//
// ★★ RE-PIN JUSTIFICATION #3 — M21b-2 / G13b (tester-owned; reviewer checklist) ★★
// The M21b justification that follows is left VERBATIM below, because its closing
// paragraph is the specification for this re-pin: it states, in the file itself,
// that "the discriminator must stop being a storage re-read and become the
// PROVENANCE of the credential this build actually supplied, produced in memory
// alongside the token", and that doing so "WILL require re-pinning
// `W-NH4-TOKEN-SUPPLIED`". ADR-0182 D13/D14 do exactly that. This is a tooth
// changing because the condition IT ITSELF named came true — not a tooth being
// bent to fit an implementation.
//
// WHAT CHANGES: ONE literal. `M21B_SAVE_GUARDED` ("if (buildKind === 'anon') …")
// becomes `M21B2_SAVE_GUARDED` ("if (credential.kind === 'anon') …"). The guard's
// DIRECTION (`=== 'anon'`, fail-closed on the value) is unchanged and now matters
// more, not less: `ConnectCredential` has SIX variants where `AuthKind` had two.
//
// WHAT IS CARRIED FORWARD UNRELAXED — every other assertion in the body below:
// the exact three-param `.onConnect((c, id, token) => {` signature; the
// exactly-once `auth.onConnected(token)` literal count; `.onConnected(` === 1;
// the `onConnected` identifier === 3 with its breakdown; the no-`else`-arm shape
// pin; both after-the-stale-guard ordering assertions; and ALL FOUR whole-file
// storage-reach bans. Nothing was removed, weakened or re-scoped.
//
// WHAT IS ADDED: the region-local `buildKind`-occurs-once count (which pinned the
// M21b anti-shadow property) is replaced by its exact M21b-2 analogue — a
// `credential.kind` count of 3 inside the onConnect region, with the breakdown
// DERIVED from ADR-0182's own normative snippets rather than guessed:
//   (1) D13's anon save guard          — `if (credential.kind === 'anon') …`
//   (2) D13/D14's writeAuthKind gate   — `if (credential.kind === 'account') …`
//   (3) D16's join veto                — `credential.kind !== 'account' || !codeUnconsumed`
// plus a ban on re-DECLARING `credential` inside the callback (the shadow the old
// `const buildKind = 'anon';` cheat used, translated to the new binding). Note the
// structural upgrade this re-pin buys for free: `credential` is now build()'s own
// PARAMETER, so a shadow is the only way to make the guard read a stale value at
// all — the M21b TOCTOU (a storage re-read inside the callback) is not merely
// banned, it is unrepresentable.
//
// ★ THE M21b JUSTIFICATION, VERBATIM, FOLLOWS. Read it as the SPECIFICATION for
// the paragraph above, not as current status.
//
// CORRECTED after review — the first draft of this justification overstated the
// case twice, and both overstatements are recorded here rather than quietly
// edited out, because a re-pin defended by a false argument is worse than no
// re-pin at all.
//
// WHAT MASTER'S TOOTH ACTUALLY ASSERTED (re-read from origin/master, not from
// memory): the exact three-param `.onConnect((c, id, token) => {` signature;
// `auth.onConnected(token)` occurring exactly once file-wide; and that call site
// appearing after `if (stale()) return;`. That is ALL. It did NOT require the
// call to be unconditional — it was simply SILENT on conditionality, and a
// kind-guarded call would have passed it unchanged. (The first draft of this
// note claimed the old tooth "REQUIRED" the unconditional shape. False.)
//
// SO WHAT IS THE RE-PIN? A STRICT SUPERSET. All three original assertions are
// carried forward verbatim below, and the guard requirement is ADDED on top,
// together with identifier-level counts that close re-spelling evasions the
// original literal-count could not see. Nothing was removed or weakened. A
// reviewer auditing this should check exactly that: that each of the three
// original assertions still appears, unrelaxed, in the body below.
//
// WHY THE GUARD IS WORTH ADDING: probe P3 (spacetimedb dist/index.mjs:5765 sets
// `this.token` from `.withToken(...)`; :6226-6231 adopts the host's token ONLY
// `if (!this.token …)` before `emit("connect", this, this.identity, this.token)`)
// proves a client-supplied JWT is echoed back VERBATIM as onConnect's third
// argument. An unconditional save therefore writes an account JWT into the
// ANONYMOUS token slot, from which the gate re-supplies it on every later build
// for the life of the tab. Red-team C4, confirmed against SDK source.
//
// ⚠ AND THE HONEST LIMIT OF WHAT THIS GUARD BUYS (the second overstatement: the
// first draft claimed "no marker desync can produce a replay" — ALSO FALSE).
// The guard is BEST-EFFORT, not structural. Its discriminator is `readAuthKind`,
// a lossy sessionStorage read that FAILS TO 'anon' on every absent/blocked/
// evicted/quota path — and 'anon' is the PERMISSIVE direction for this guard.
// So a marker lost in the marker-MISSING direction re-opens exactly the replay
// this guards against. That fail direction is not a bug: AUTH-31 requires it
// (failing to 'account' would break every existing anonymous tab the moment
// storage is blocked). The two requirements genuinely conflict and one lossy
// boolean cannot satisfy both.
//
// THAT IS A HARD CONSTRAINT ON M21b-2, recorded here because this is the file a
// future author will read before touching the guard: the discriminator must stop
// being a storage re-read and become the PROVENANCE of the credential this build
// actually supplied, produced in memory alongside the token. Doing that WILL
// require re-pinning `W-NH4-TOKEN-SUPPLIED`, which today pins
// `.withToken(auth.tokenForNextAttempt())` byte-for-byte. Budget for it.
//
// ⚠ THE SENTENCE THAT STOOD HERE — "THIS IS THE ONLY PRE-EXISTING TOOTH THIS
// SLICE CHANGES … one justified re-pin, not two" — WAS TRUE OF M21b AND IS FALSE
// OF M21b-2. Corrected in place rather than deleted (this file's standing
// convention for a claim that a later slice invalidates), because a stale "only
// one tooth changes" sentence in a gating file is precisely what teaches the next
// reviewer to wave through a second, unjustified re-pin. M21b-2 changes FIVE
// pre-existing teeth, each with its own numbered justification: see the re-pin
// ledger in the M21b banner above (justifications #1-#5). Audit them as five.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4, RE-PINNED by M21b then M21b-2/G13b): W-NH4-SAVE-WIRED — onConnect saves the token via auth.onConnected(token), stale-guarded AND credential-guarded', () => {
  it('★ BITES: onConnect takes a third param named token and calls auth.onConnected(token) at exactly ONE site — guarded on THIS build`s credential, AFTER the stale guard', () => {
    const src = readConnectionTs();
    const squashedWhole = squashWhitespace(stripLineComments(src));

    // WRONG IMPL KILLED (a): onConnect((c, id) => ...) — the token discarded entirely.
    // The exact three-param signature pin catches this. (Carried forward verbatim.)
    expect(
      squashedWhole.includes('.onConnect((c, id, token) => {'),
      'the onConnect callback must have the exact contiguous signature ' +
        '".onConnect((c, id, token) => {"',
    ).toBe(true);

    // WRONG IMPL KILLED (b): auth.onConnected(id.toHexString()) — saving the IDENTITY
    // instead of the token. The exact-argument pin (token, not id.toHexString()) rejects it.
    // WRONG IMPL KILLED (c): a duplicate, UNGUARDED auth.onConnected(token) added ABOVE
    // the stale guard in addition to the compliant guarded one — killed by the
    // exactly-once file-wide count, which a mere "appears after the guard" check would
    // miss (it would find the LATER, compliant occurrence and never notice the earlier
    // rogue one). (Both carried forward verbatim.)
    expect(
      countOccurrences(squashedWhole, 'auth.onConnected(token)'),
      'auth.onConnected(token) must occur EXACTLY once in connection.ts — a duplicated ' +
        'unguarded call anywhere else would also fail this count',
    ).toBe(1);

    // ★★ THE RE-SPELLING KILLERS. The literal count above is necessary but NOT sufficient:
    // it counts one exact spelling, and a second call spelled ANY other way is invisible to
    // it. Two red-team implementations, both verified biome-clean, walked through it:
    //   CHEAT 1: `if (credential.kind === 'anon') auth.onConnected(token);`
    //            `else auth.onConnected(String(token));`
    //            — the guard is present and contiguous, the literal count is still 1
    //              (`auth.onConnected(String(token))` does not contain `auth.onConnected(token)`),
    //              and the write happens on BOTH branches. The guard is pure decoration.
    //   CHEAT 5: `auth.onConnected(token as string);` on the line BEFORE the guarded call —
    //            an unconditional write followed by a decorative guarded one. Same evasion.
    // Closed at two coarser granularities, so no re-spelling of the ARGUMENT can help:
    //   (i)  `.onConnected(` — every member-call spelling of the gate method, whatever the
    //        argument. Note the leading dot: it deliberately does NOT match the unrelated
    //        `state = onConnected(state)` reconnect-policy call at connection.ts:587.
    //   (ii) the bare IDENTIFIER `onConnected`, which additionally catches spellings that
    //        dodge the dot — `auth?.onConnected(token)`, `auth['onConnected'](token)`, a
    //        second import, a destructured `const { onConnected } = auth`. The expected
    //        total is 3, with the breakdown pinned in the message so the number is
    //        self-documenting (the same idiom this file applies to shouldRemoveOnViewDelete).
    expect(
      countOccurrences(squashedWhole, '.onConnected('),
      'the gate method must be CALLED from exactly one site: `.onConnected(` (with the dot) ' +
        'must occur exactly once in the comment-stripped source. CHEAT 1 (an `else ' +
        'auth.onConnected(String(token));` arm) and CHEAT 5 (an unconditional ' +
        '`auth.onConnected(token as string);` on the preceding line) both leave the exact ' +
        'literal `auth.onConnected(token)` at exactly one occurrence while writing the ' +
        'account JWT into the anonymous slot on every path. This count is what sees them',
    ).toBe(1);
    expect(
      countOccurrences(squashedWhole, 'onConnected'),
      'the onConnected IDENTIFIER must occur EXACTLY 3 times in the comment-stripped source, ' +
        'and the breakdown is: (1) the `onConnected,` specifier in the ./reconnectPolicy ' +
        'import; (2) `state = onConnected(state)` in the subscription onApplied — the ' +
        'reconnect-policy transition, unrelated to auth; (3) the ONE kind-guarded ' +
        '`auth.onConnected(token)`. A 4th occurrence is a second write site in SOME ' +
        'spelling — optional-chained, computed member access, a destructured alias, a ' +
        'second import, or an else-arm — every one of which re-opens the replay this ' +
        'slice exists to close',
    ).toBe(3);

    // ★ THE ADDED PROPERTY — and the whole of this slice's safety value.
    // WRONG IMPL KILLED (e): the call left UNCONDITIONAL — `auth.onConnected(token);` on
    //   its own line. That was the PRE-M21b shape (it shipped that way from nh4 until this
    //   slice), and it is the C4 replay mechanism the moment the account branch becomes
    //   reachable: the SDK hands back the very JWT we supplied (P3), and the anon slot
    //   swallows it permanently. This is the plan's named mutation "un-guard
    //   auth.onConnected(token)", and reverting to it is a one-character-deletion away.
    // WRONG IMPL KILLED (f): the guard INVERTED — `if (credential.kind === 'account')` or
    //   `if (credential.kind !== 'anon')`. Both write the account credential into the
    //   anonymous slot and nothing else in the suite can see it; the contiguous needle
    //   admits only the fail-closed `=== 'anon'` form. (`!== 'account'` is also rejected,
    //   and under M21b-2 it is no longer even behaviourally equal: `ConnectCredential` has
    //   SIX variants, and D13's `sign-in-failed` path REBUILDS AS ANON — so a `!==` guard
    //   would be writing on paths that never carried an anon token at all.)
    // WRONG IMPL KILLED (g): ★ TOCTOU — a guard that RE-DERIVES the discriminator inside
    //   the callback rather than reading build()'s own parameter, e.g.
    //   `if (readAuthKind(globalThis, opts.uri, opts.db) === 'anon') auth.onConnected(token);`.
    //   onConnect fires asynchronously, an arbitrary time after the build decided; the
    //   marker is mutable sessionStorage that the OIDC return leg writes mid-session, so a
    //   re-read can say 'anon' for a build that supplied an account credential — the guard
    //   would be present, readable, and wrong. Under M21b-2 this is closed THREE ways: the
    //   contiguous needle pins `credential.kind`; W-M21B2-CREDENTIAL-IS-PROVENANCE (G14)
    //   makes `readAuthKind` occur ZERO times file-wide; and `credential` is build()'s own
    //   PARAMETER (D13), so there is no mutable closure variable left to go stale.
    expect(
      // CODE-AWARE (coordinator review): the guard is an executable statement, so a decoy
      // string of the same text must not satisfy it.
      includesAsCode(squashedWhole, M21B2_SAVE_GUARDED),
      `connection.ts must contain the contiguous \`${M21B2_SAVE_GUARDED}\` — the anonymous ` +
        'token slot must NEVER receive an account JWT. An unconditional save writes the ' +
        'account credential into the anon slot, because the SDK echoes a client-supplied ' +
        "JWT back as onConnect's third argument (probe P3), and the gate then re-supplies " +
        'it on every later build for the life of the tab (red-team C4)',
    ).toBe(true);
    expect(
      countCodeOccurrences(squashedWhole, M21B2_SAVE_GUARDED),
      'the credential-guarded save must appear exactly once AS CODE — two guarded sites ' +
        'means two competing writers of the same slot',
    ).toBe(1);

    // ★ NO `else` ARM (CHEAT 1, killed a second, independent way). The counts above already
    // exclude it, but this pins the SHAPE directly so the failure message names the defect
    // instead of reporting a surprising number: whatever follows the guarded statement, it
    // is not an else. `if (a) f(); else g();` is a guard that guards nothing.
    // Code-aware index of the (single, code-verified) guard, so a decoy string cannot shift
    // where the no-`else` slice is taken.
    const guardCodeIdx = codeOccurrences(squashedWhole, M21B2_SAVE_GUARDED)[0]!;
    const guardEndIdx = guardCodeIdx + M21B2_SAVE_GUARDED.length;
    expect(
      squashedWhole
        .slice(guardEndIdx, guardEndIdx + 6)
        .trimStart()
        .startsWith('else'),
      'the kind-guarded save must NOT be followed by an `else` arm — an else that also ' +
        'writes (in ANY spelling) makes the guard pure decoration and restores the ' +
        'unconditional write on the account path',
    ).toBe(false);

    // WRONG IMPL KILLED (d): the single call placed ABOVE the stale guard, letting a
    // superseded build clobber the live build's token. (Carried forward verbatim.)
    expectUniqueAnchor(src, '.onConnect((c, id, token) => {');
    expectUniqueAnchor(src, '.onConnectError((_ctx, err: Error) => {');
    const region = bodyRegion(
      src,
      '.onConnect((c, id, token) => {',
      '.onConnectError((_ctx, err: Error) => {',
    );
    const squashedRegion = squashWhitespace(region);
    // Code-aware indices throughout (coordinator review): a decoy string of the stale guard or
    // the saved-token call must not shift the ordering.
    const guardIdx = codeOccurrences(squashedRegion, 'if (stale()) return;')[0] ?? -1;
    const savedIdx = codeOccurrences(squashedRegion, 'auth.onConnected(token)')[0] ?? -1;
    expect(
      guardIdx,
      'onConnect region must contain the stale guard AS CODE',
    ).toBeGreaterThanOrEqual(0);
    expect(
      savedIdx,
      'onConnect region must contain auth.onConnected(token) AS CODE',
    ).toBeGreaterThanOrEqual(0);
    expect(
      savedIdx,
      'auth.onConnected(token) must be called AFTER "if (stale()) return;" within the ' +
        'onConnect callback — a call placed above the guard would let a superseded ' +
        "build's late connect clobber the live build's saved token",
    ).toBeGreaterThan(guardIdx);
    // The credential guard must live in the SAME region (not hoisted somewhere the callback
    // never reaches), and likewise after the stale guard.
    expect(
      codeOccurrences(squashedRegion, M21B2_SAVE_GUARDED)[0] ?? -1,
      'the credential-guarded save must sit INSIDE the onConnect callback, AFTER the stale guard',
    ).toBeGreaterThan(guardIdx);

    // ★ THE DISCRIMINATOR CENSUS INSIDE THIS CALLBACK (M21b-2/G13b — the exact analogue of
    // the M21b `buildKind`-occurs-once count this replaces; CHEAT 2, red-team, biome-clean).
    //
    // COUNT DERIVED FROM ADR-0182's NORMATIVE SNIPPETS, NOT GUESSED. `credential.kind`
    // occurs exactly THREE times inside `.onConnect(…)` → `.onConnectError(…)`:
    //   (1) D13   the anon save guard          — `if (credential.kind === 'anon') …`
    //   (2) D13/D14 the writeAuthKind hint gate — `if (credential.kind === 'account') …`
    //   (3) D16   the join veto, nested inside `.onApplied` (which is INSIDE this region) —
    //             `const shouldJoin = credential.kind !== 'account' || !codeUnconsumed;`
    // build()'s own defensive belt (`if (credential.kind !== 'anon' && credential.kind !==
    // 'account') return undefined;`) sits ABOVE `.onConnect(`, outside this region, and is
    // deliberately not counted here.
    //
    // WHAT A WRONG NUMBER MEANS, so the next reader repairs the CODE and not the count:
    //   2 ⇒ one of the three gates is missing. Most likely (2): the `writeAuthKind` hint is
    //       dropped, and the first paint after a real sign-in shows the anonymous chrome
    //       until `my_account`'s first snapshot lands (D14's first-paint hint).
    //   4 ⇒ a FOURTH consumer of the discriminator inside the callback — which is one more
    //       chance for two branches to disagree about what this build supplied, and is how
    //       the D15 reconciliation rule ("store.ownAccount is the SOLE authoritative
    //       signal") gets quietly re-litigated inside the adapter.
    expect(
      countOccurrences(squashedRegion, 'credential.kind'),
      'credential.kind must occur EXACTLY 3 times inside the onConnect callback — the anon ' +
        'save guard, the writeAuthKind first-paint hint gate, and the D16 join veto nested ' +
        'in .onApplied. Re-derive this number from ADR-0182 D13/D14/D16 if the shape ' +
        'genuinely changes; do NOT bump it to match code',
    ).toBe(3);
    // The discriminator is build()'s own PARAMETER (D13) and is merely READ here. A local
    // re-declaration is the M21b `const buildKind = 'anon';` cheat, translated: it leaves
    // every other needle in this tooth satisfied (the guard text is unchanged, the
    // .onConnected( counts are unchanged) while the guard reads a constant and is inert.
    // Biome reports shadowing as a warning at most, so it ships.
    for (const shadow of ['const credential', 'let credential', 'var credential']) {
      expect(
        countOccurrences(squashedRegion, shadow),
        `the onConnect callback must contain NO "${shadow}" — the credential is decided ONCE ` +
          'per attempt by resolveCredential() and handed to build() as a parameter; anything ' +
          'that re-binds that name inside the callback makes the guard read a value the ' +
          'build never supplied',
      ).toBe(0);
    }

    // ★ NO STORAGE ACCESS AT ALL FROM THIS SHELL (the last way to reach the token slot
    // without going through the guard). Every needle above pins the ONE path into the
    // anonymous credential — `auth.onConnected(token)`. None of them can see a build that
    // simply bypasses the gate module:
    //     globalThis.sessionStorage?.setItem('mr.authToken.v1|…', token);
    // inside onConnect. That leaves `.onConnected(` at exactly one occurrence, keeps the
    // kind guard textually intact, and writes the account JWT into the anon slot anyway.
    //
    // The pin is whole-file, not region-bounded, and it is not an ad-hoc widening: it is
    // authToken.ts's stated charter, mechanised. That module's header says the storage HOST
    // is injected "never a globalThis reach from inside" precisely so every branch is
    // unit-testable in node — and connection.ts is coverage-EXCLUDED, so any storage logic
    // that migrates here becomes permanently unprovable. ADR-0150 D3 additionally forbids
    // localStorage anywhere (an origin-shared token lets closing a second tab forfeit the
    // first tab's live PvP battle and delete its character row).
    //
    // FALSE-RED RISK ASSESSED BEFORE ADDING: connection.ts contains ZERO occurrences of
    // any of these identifiers in shipped code today (its single `sessionStorage` mention
    // is prose in the comment above the kind guard, and comments are stripped here). If a
    // future slice genuinely needs storage in the adapter, that is the conversation this
    // tooth is meant to force, not an inconvenience to route around.
    for (const storageReach of ['sessionStorage', 'localStorage', 'indexedDB', 'document.cookie']) {
      expect(
        countOccurrences(squashedWhole, storageReach),
        `connection.ts must not reference "${storageReach}" — storage belongs to ` +
          'authToken.ts behind an INJECTED host (its module header: never a globalThis ' +
          'reach from inside). A direct write here bypasses the kind guard entirely, ' +
          're-opening the account-JWT replay while every other needle in this tooth stays ' +
          'satisfied — and it would live in a coverage-excluded file, where behaviour ' +
          'cannot be proven at all',
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// W-NH4-FAILURE-WIRED — failures are reported to the gate, under the stale guard,
// riding the existing ADR-0085 backoff ladder (not replacing it).
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4): W-NH4-FAILURE-WIRED — onConnectError reports via auth.onConnectFailed(err), guarded, ladder preserved', () => {
  it('BITES: auth.onConnectFailed(err) occurs exactly once file-wide, AFTER the stale guard, with the ADR-0085 ladder still intact', () => {
    const src = readConnectionTs();
    const squashedWhole = squashWhitespace(stripLineComments(src));

    // WRONG IMPL KILLED (a): no failure reporting at all → suppression never engages
    // → a rejected stored credential loops forever. RED today: 0 occurrences.
    // WRONG IMPL KILLED (b): a duplicate, unguarded call above the stale guard —
    // killed by the exactly-once count.
    const failedCount = squashedWhole.split('auth.onConnectFailed(err)').length - 1;
    expect(
      failedCount,
      'auth.onConnectFailed(err) must occur EXACTLY once in connection.ts — RED today: ' +
        'it does not occur at all',
    ).toBe(1);

    expectUniqueAnchor(src, '.onConnectError((_ctx, err: Error) => {');
    expectUniqueAnchor(src, '.onDisconnect(() => {');
    // NOTE (fix): the end needle here must be the SAME string just validated as
    // unique above ('.onDisconnect(() => {'), not a shorter substring of it
    // ('.onDisconnect(') — a mismatched validated-vs-bounding string means the
    // uniqueness check can report OK while the region silently mis-bounds against a
    // different (or additional) occurrence of the shorter needle.
    const region = bodyRegion(
      src,
      '.onConnectError((_ctx, err: Error) => {',
      '.onDisconnect(() => {',
    );
    const squashedRegion = squashWhitespace(region);

    const guardIdx = squashedRegion.indexOf('if (stale()) return;');
    const failedIdx = squashedRegion.indexOf('auth.onConnectFailed(err)');
    expect(guardIdx, 'onConnectError region must contain the stale guard').toBeGreaterThanOrEqual(
      0,
    );
    expect(
      failedIdx,
      'onConnectError region must contain auth.onConnectFailed(err)',
    ).toBeGreaterThanOrEqual(0);
    // WRONG IMPL KILLED (c): the call placed ABOVE the stale guard.
    expect(
      failedIdx,
      'auth.onConnectFailed(err) must be called AFTER "if (stale()) return;" — a call ' +
        "above the guard would let a superseded build's late failure dirty the live " +
        'build state',
    ).toBeGreaterThan(guardIdx);

    // WRONG IMPL KILLED (d): an added immediate-rebuild shortcut that bypasses the
    // existing ADR-0085 backoff ladder. The new call must RIDE the ladder, not
    // replace it — assert both ladder statements are still present in the region.
    expect(
      squashedRegion.includes('state = onAttemptFailed(state)'),
      'onConnectError must still call state = onAttemptFailed(state) — the new ' +
        'auth.onConnectFailed(err) call must ride the EXISTING ADR-0085 backoff ladder, ' +
        'not replace it',
    ).toBe(true);
    expect(
      squashedRegion.includes('scheduleRebuild()'),
      'onConnectError must still call scheduleRebuild() — the new auth.onConnectFailed(err) ' +
        'call must not add a second, competing retry path',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W-NH4-NO-CLEAR-ON-DROP — the drop path must never discard the credential.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4): W-NH4-NO-CLEAR-ON-DROP — onDisconnect / handleDrop never call auth.onConnectFailed( or auth.onConnected(', () => {
  it('BITES: no auth reporting call appears inside .onDisconnect(...).build(); nor inside handleDrop()', () => {
    // WRONG IMPL KILLED: someone "helpfully" reporting a failure (or a save) on every
    // transient drop — which would let a plain wifi blip advance the suppression
    // counter (or overwrite the saved token with a stale one) and eventually cause
    // the client to fall back to a fresh identity, silently orphaning the player's
    // save. This is the guard that protects the credential from the ORDINARY
    // disconnect path (as opposed to a genuine rejected-token failure, which DOES
    // route through onConnectError/W-NH4-FAILURE-WIRED above).
    const src = readConnectionTs();

    // FIX: uniqueness must be checked against the SAME string bodyRegion() actually
    // slices (raw `src`) — checking a comment-stripped copy while extracting from raw
    // source means a comment containing one of these literal anchors could make the
    // uniqueness check report OK while the region silently mis-bounds against the raw
    // text's own (different) occurrence count.
    expectUniqueAnchor(src, '.onDisconnect(() => {');
    expectUniqueAnchor(src, '.build();');
    const disconnectRegion = bodyRegion(src, '.onDisconnect(() => {', '.build();');
    expect(
      disconnectRegion.includes('auth.onConnectFailed('),
      'the .onDisconnect(...) region must NOT call auth.onConnectFailed( — an ordinary ' +
        'link drop is not a rejected-credential failure and must not advance suppression',
    ).toBe(false);
    expect(
      disconnectRegion.includes('auth.onConnected('),
      'the .onDisconnect(...) region must NOT call auth.onConnected( — a drop is not a ' +
        'fresh successful connect and must not overwrite the saved token',
    ).toBe(false);

    expectUniqueAnchor(src, 'function handleDrop(): void {');
    // handleDrop() body ends at its closing brace; the next top-level anchor after it
    // in the file is the SINGLETON CONSTRAINT comment block leading into the
    // pagehide listener registration.
    expectUniqueAnchor(src, "window.addEventListener('pagehide'");
    const handleDropRegion = bodyRegion(
      src,
      'function handleDrop(): void {',
      "window.addEventListener('pagehide'",
    );
    expect(
      handleDropRegion.includes('auth.onConnectFailed('),
      'handleDrop() must NOT call auth.onConnectFailed( — the shared drop path must never ' +
        'discard or penalize the stored credential on an ordinary disconnect',
    ).toBe(false);
    expect(
      handleDropRegion.includes('auth.onConnected('),
      'handleDrop() must NOT call auth.onConnected( — the shared drop path must never ' +
        'overwrite the saved token',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SDK-DRIFT — the classifier's contract with the SpacetimeDB SDK.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4): SDK-DRIFT — spacetimedb SDK still throws the exact token-rejection message string', () => {
  it('BITES: dist/index.mjs contains the literal substring "Failed to verify token: ${response.statusText}"', () => {
    // Mirrors the load-bearing-SDK-string contract pattern already established at
    // connection.ts:501-510 (the exact-match 'already joined' check) — an SDK string
    // is trusted here the same way, and pinned the same way.
    //
    // WRONG IMPL KILLED: an SDK bump that changes this message's wording (e.g. adding
    // punctuation, changing "verify" to "validate", or dropping the statusText
    // interpolation) would silently disarm isStoredCredentialRejected in
    // authToken.ts, restoring the infinite-reconnect-loop failure mode with EVERY
    // OTHER nh4 test in this suite still green (they only check wiring shape, not
    // that the classifier's string match still resolves against the live SDK). This
    // is the only tooth in the nh4 suite that reads the SDK's own source.
    const sdkPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'node_modules',
      'spacetimedb',
      'dist',
      'index.mjs',
    );
    let sdkSrc: string;
    try {
      sdkSrc = readFileSync(sdkPath, 'utf8');
    } catch (err) {
      // Fail loud — never let a missing/relocated SDK file pass this gate vacuously.
      throw new Error(
        'spacetimedb SDK dist/index.mjs could not be read at expected path: ' +
          sdkPath +
          ' — ' +
          String(err),
      );
    }
    const needle = 'Failed to verify token: ${response.statusText}';
    expect(
      sdkSrc.includes(needle),
      'spacetimedb dist/index.mjs must contain the literal substring ' +
        `"${needle}" — if this fails, the SDK has drifted and ` +
        'isStoredCredentialRejected() in authToken.ts (behavior-tested in ' +
        'authToken.test.ts) is silently disarmed',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dev-observability (ADR-0157) — W-DEVLOG-WRAP. APPENDED block; nothing above is
// modified. Same source-scan idiom + helpers as the nh4 gates above.
//
// SOURCE OF TRUTH: plan §A2/§A8 + §D (gate `W-DEVLOG-WRAP`), ADR-0157 §1.
//
// The outbound surface is 38 call sites, covered by exactly TWO wiring lines:
//   1. `build()`'s RETURN — `return wrapReducerLogging(conn, opts.onSend);` AFTER
//      `wireTables(conn);` (the inbound path must keep seeing the RAW conn). Because
//      `current` is only ever assigned and returned by the `get conn()` accessor, the
//      wrapped instance simply BECOMES the connection, so all 37 `conn.conn.reducers.*`
//      sites in main.ts route through it with no per-read allocation.
//   2. The one site that does NOT go through the getter: `joinGame` inside the
//      subscription's onApplied (connection.ts:516), which calls the local raw `c`.
//
// RED AT AUTHORING TIME: `wrapReducerLogging` occurs ZERO times in connection.ts.
//
// WRONG IMPL KILLED: dropping EITHER site. Dropping (1) unlogs 37 of 38 call sites;
// dropping (2) leaves the single most interesting call (the reconnect re-join, and the
// one that carries the player name) silently invisible — a gap no unit test of devLog.ts
// and no main.ts wiring gate can see.
//
// ★★ RE-PIN JUSTIFICATION #5 — M21b-2 (G15 + G15b) ★★
// TWO of this block's anchors are invalidated by ADR-0182, and BOTH are re-derived
// from the ADR rather than adjusted to fit code:
//
// G15 — the END ANCHOR of the build()-tail region. `let current = build();` ceases to
//   exist: D13 makes the cold start `let current: DbConnection | undefined;` followed by
//   `void attemptBuild();`. The re-pin is to the DECLARATION, which T7's own build order
//   places immediately after build()'s closing brace, so the region ("everything after
//   `wireTables(conn);` up to the declaration") still covers exactly build()'s tail —
//   the assertion is unchanged, only its right-hand fence moved.
//   ⚠ NOT re-pinned to `void attemptBuild();`, which the ADR's prose suggests: that
//   literal occurs THREE times (scheduleRebuild's timer body, the cold start, and
//   continueAnonymously), so `expectUniqueAnchor` would red on CORRECT code — and the
//   region would silently bound against whichever occurrence came first.
//
// G15b — the joinGame RECEIVER check. D16 extracts `attemptJoin(conn, name, onError)`
//   (deliberately: `devLog.ts` builds a fresh Proxy per call with no memoisation, so an
//   inline re-wrap of an already-wrapped connection double-logs every reducer call). The
//   wrap therefore moves from the CALL EXPRESSION to the ARGUMENT at the call site, and
//   the retired "wrapReducerLogging( appears within 140 chars before .reducers.joinGame("
//   window would RED a correct implementation — the 140 chars before it are now
//   attemptJoin's own signature. THIS WAS NOT IN THE ADR'S OR THE PLAN'S RE-PIN LIST; it
//   was found by reading the tooth against D16 and is recorded here as a tester finding.
//   The INVARIANT is unchanged and is re-stated at its new home: the one connection-
//   internal joinGame path must receive a WRAPPED connection, so the exact D16 call
//   `attemptJoin(wrapReducerLogging(c, opts.onSend), name, opts.onError);` is pinned
//   contiguously. That is strictly SHARPER than the 140-char window it replaces (which
//   could be satisfied by any nearby wrap call), not looser.
// ---------------------------------------------------------------------------

/** ADR-0182 D13's cold-start declaration — the new right-hand fence of build()'s tail
 *  region. RE-PINNED from `let current = build();` (G15). */
const M21B2_CURRENT_DECL = 'let current: DbConnection | undefined;';

/** ADR-0182 D16's exact join call site: the ONE connection-internal outbound call, wrapped
 *  at the ARGUMENT rather than at the call expression (G15b). */
const M21B2_ATTEMPT_JOIN_CALL =
  'attemptJoin(wrapReducerLogging(c, opts.onSend), name, opts.onError);';

describe('connection.ts wiring (ADR-0157, RE-PINNED by M21b-2/G15+G15b): W-DEVLOG-WRAP — both outbound wrap sites exist', () => {
  it('★ W-DEVLOG-WRAP BITES (build): build() RETURNS wrapReducerLogging(conn, …) AFTER wireTables(conn)', () => {
    // WRONG IMPL KILLED (1): `return conn;` left untouched — 37 of the 38 outbound sites
    // are unlogged and the feature appears "half broken" only at runtime.
    // WRONG IMPL KILLED (2): wrapping BEFORE / instead of `wireTables(conn)` — the inbound
    // row-callback wiring would then be installed against the Proxy rather than the raw
    // connection, putting the trap on the hot inbound path this slice explicitly excludes
    // (EARS-3, obs-b). Region-bounding the assertion to the text AFTER `wireTables(conn);`
    // is what pins the order.
    // WRONG IMPL KILLED (3, M21b-2): `current` re-declared with an initialiser
    // (`let current = undefined;` / `let current: DbConnection | undefined = undefined;`).
    // Biome's own `noUselessUndefinedInitialization` would flag the second, but the first
    // ships clean and erases the type annotation that makes every `conn?.live()` call site
    // in main.ts a compile error rather than a runtime surprise. The exact declaration text
    // is the fence, so either spelling reds here.
    const src = readConnectionTs();
    expectUniqueAnchor(src, 'wireTables(conn);');
    expectUniqueAnchor(src, M21B2_CURRENT_DECL);

    const tail = squashWhitespace(bodyRegion(src, 'wireTables(conn);', M21B2_CURRENT_DECL));
    expect(
      tail.includes('return wrapReducerLogging(conn'),
      'build() must end with `return wrapReducerLogging(conn, opts.onSend);` — placed AFTER ' +
        'wireTables(conn) so the inbound path still sees the RAW connection (§A2). The region ' +
        `runs from wireTables(conn); to \`${M21B2_CURRENT_DECL}\` (ADR-0182 D13's cold-start ` +
        'declaration, which T7 places immediately after build()`s closing brace)',
    ).toBe(true);
  });

  it('★ W-DEVLOG-WRAP BITES (joinGame): the connection-internal joinGame call goes through wrapReducerLogging, not the raw `c`', () => {
    // WRONG IMPL KILLED: leaving `c.reducers.joinGame({ name })` bare. It is the ONE outbound
    // call that does not go through the `get conn()` accessor, so the build()-return wrap
    // cannot cover it — it would be silently unlogged forever, and it is precisely the call a
    // developer debugging a reconnect wants to see.
    const src = readConnectionTs();
    const stripped = stripLineComments(src);
    const squashed = squashWhitespace(stripped);

    // Anti-vacuity: the call site must still exist at all before we judge its receiver.
    expect(
      squashed.includes('.reducers.joinGame('),
      'connection.ts must still contain the internal .reducers.joinGame( call — if it moved, ' +
        'this gate is judging the wrong file',
    ).toBe(true);

    expect(
      squashed.includes('c.reducers.joinGame('),
      'the bare `c.reducers.joinGame(` receiver must be gone — the joinGame call must be made ' +
        'through wrapReducerLogging(c, opts.onSend) (§A2), otherwise the one outbound site that ' +
        'bypasses the get conn() accessor is never logged',
    ).toBe(false);

    // ★ G15b (RE-PINNED, ADR-0182 D16). The 140-char backward window this replaces asked
    // "is a wrap call textually near the joinGame call?" — a question that stops being
    // answerable once D16 extracts `attemptJoin(conn, name, onError)`, because the wrap now
    // happens at the CALL SITE's argument and the 140 chars before `.reducers.joinGame(` are
    // attemptJoin's own signature. The invariant is unchanged; its statement moves to the
    // one place that still expresses it, and gets SHARPER on the way:
    //   WRONG IMPL KILLED (a): `attemptJoin(c, name, opts.onError);` — the raw connection
    //     handed straight to the joiner. The one outbound call that cannot go through the
    //     get conn() accessor is silently unlogged, exactly the §A2 gap this tooth exists
    //     for. The old 140-char window CANNOT see this (build()'s own
    //     `return wrapReducerLogging(conn, …)` is 100+ chars away from attemptJoin's body,
    //     and the window would simply find nothing — but so would a correct impl).
    //   WRONG IMPL KILLED (b): `attemptJoin(wrapReducerLogging(current, opts.onSend), …)` —
    //     wrapping the module-scope `current` rather than the callback's own `c`. `current`
    //     is a DIFFERENT (and, mid-rebuild, possibly superseded or `undefined`) instance;
    //     the contiguous needle admits only `c`.
    //   WRONG IMPL KILLED (c): a double wrap — killed independently below.
    expect(
      countOccurrences(squashed, M21B2_ATTEMPT_JOIN_CALL),
      'the connection-internal join must be issued as the exact contiguous call ' +
        `\`${M21B2_ATTEMPT_JOIN_CALL}\` (ADR-0182 D16) — the joiner is extracted ONCE (devLog ` +
        'builds a fresh Proxy per call with no "already wrapped" memoisation, so an inline ' +
        're-wrap double-logs every reducer call) and receives a WRAPPED connection, so the one ' +
        'outbound site that bypasses the get conn() accessor is still logged (§A2)',
    ).toBe(1);
    // The extracted joiner is the ONLY place joinGame is issued from: a second call site
    // would be a second, unwrapped (or differently-guarded) re-join path.
    expect(
      countOccurrences(squashed, '.reducers.joinGame('),
      'joinGame must be issued from EXACTLY ONE site in connection.ts — attemptJoin`s body. ' +
        'A second call site is a second re-join path that the D16 claim-code veto does not ' +
        'gate (AUTH-52/F2: while a claim code is outstanding, an ACCOUNT-kind build must not ' +
        're-join)',
    ).toBe(1);
    // ANTI-VACUITY for the pair above: the joiner really is a separate declaration, not an
    // inline arrow that happens to spell the same call.
    expect(
      countOccurrences(squashed, 'function attemptJoin('),
      'attemptJoin must be declared EXACTLY once — the single extraction D16 mandates',
    ).toBe(1);

    // Both sites §A2 specifies must be present. AT LEAST two, not exactly two: a
    // behaviourally identical local helper (`const wrap = () => wrapReducerLogging(conn,
    // opts.onSend)` used at both sites) is a legitimate refactor, and an exact count would
    // red it for no reason. The invariant that actually matters is the one below — no
    // wrap of a wrap.
    const wrapCalls = squashed.split('wrapReducerLogging(').length - 1;
    expect(
      wrapCalls,
      'wrapReducerLogging( must be called at least twice in connection.ts — once at build()`s ' +
        'return and once at the joinGame site (§A2). The import statement is not a call site ' +
        '(no paren), so it is not counted',
    ).toBeGreaterThanOrEqual(2);

    // WRONG IMPL KILLED: layering a second Proxy over an already-wrapped connection
    // (`wrapReducerLogging(wrapReducerLogging(conn, log), log)`). Every reducer call would
    // then be logged TWICE and pay two trap hops on the movement hot path, and the
    // `this`-binding chain would run through a Proxy rather than the raw instance.
    expect(
      squashed.includes('wrapReducerLogging(wrapReducerLogging('),
      'wrapReducerLogging( must never wrap an already-wrapped connection — a double Proxy ' +
        'double-logs every reducer call and puts a Proxy (not the raw instance) in the bind ' +
        'chain',
    ).toBe(false);
  });
});

// ===========================================================================
// 11r-e (ux2b) — the `my_wallet` runtime path: subscription + insert-only ingest
// SOURCE OF TRUTH: docs/adr/0169-wallet-view-runtime-path.md D1/D2, amending
//   docs/adr/0154-owner-scoped-wallet-view.md D4/D6/D7.
//
// EARS COVERED HERE
//   11r-e-1  — the connection SHALL include `SELECT * FROM my_wallet` INSIDE the
//              `.subscribe([...])` array, and SHALL NOT name `player_wallet` inside that
//              array. Additionally the RAW (un-stripped) source SHALL NOT contain the
//              stale phrase `produces no client subscription`.
//   11r-e-3  — WHEN a `my_wallet` row insert arrives, the connection SHALL convert it,
//              call `store.upsertWallet(...)`, and call `batcher.schedule()`.
//   11r-e-3b — the connection SHALL register NO `onDelete` and NO `onUpdate` handler for
//              `my_wallet`, SHALL call no wallet-removal API, and SHALL construct no
//              fallback/default wallet row.
//
// RED REASON (verified by reading client/src/net/connection.ts this session)
//   `my_wallet` appears NOWHERE in connection.ts. The only occurrence of the string
//   `wallet` in the whole file is the comment at :576-577 — "player_wallet is PRIVATE
//   (ADR-0081/0040) and produces no client subscription — excluded". So:
//     * the `.subscribe([...])` array (:544-591) has no `'SELECT * FROM my_wallet'`;
//     * `wireTables` (:300-483) has no `conn.db.my_wallet.*` handler of any kind;
//     * `playerWalletRowToStore` / `SdkPlayerWalletRow` are not imported (the
//       `./rowConvert` import block at :28-62 does not list them — and they do not exist
//       in rowConvert.ts yet either);
//     * the stale phrase IS still present in the raw source.
//   Every gate below therefore reds on a MISSING IMPLEMENTATION, not on a typo here.
//   The THREE calibration fixtures (W-UX2B-SCAN-SOUND) are GREEN today by design — they
//   prove the scanning pipeline itself works, so a red elsewhere cannot be blamed on it.
//
// WHY SOURCE SCAN AND NOT AN IMPORT: unchanged from this file's header — connection.ts
//   is coverage-excluded (vite.config.ts:99-100) because importing it touches DOM/wasm
//   globals. The BEHAVIORAL half of this slice lives in rowConvert.test.ts (a real
//   import of the pure converter) and client/e2e/wallet-balance.spec.ts (a real browser).
//   Per ADR-0169 "Which gate owns what", 11r-e-3's `batcher.schedule()` and 11r-e-3b's
//   absent `onDelete` are STRUCTURALLY UNREACHABLE by any e2e in this slice — with
//   schedule() omitted the next NPC wander tick re-renders and the e2e self-heals, and
//   the D4 delete catastrophe needs a wallet UPDATE, which the 150-gold price floor makes
//   impossible in a 50-gold run. This file is the only gate for both.
//
// COMMENT-STRIPPING ONLY — NO string-literal stripper (plan R1). connection.ts contains
//   ZERO occurrences of `://` (verified by grep this session), so stripLineComments'
//   naive `indexOf('//')` cannot truncate a line at a URL. A string literal containing a
//   needle could only ever INCREASE a count past its pin (a hard red), never mask a
//   missing implementation, so a stripper would defend a false-RED that does not occur.
//
// WHY NO SENTINEL REGION (`// UX2B-WALLET-INGEST-BEGIN/END`) — ADR-0169 D2 rejects it:
//   11r-e-3b is a WHOLE-FILE negative and a region-bounded negative cannot see a handler
//   relocated 200 lines away. Presence-only assertions were rejected for a second reason:
//   they admit a CONDITIONAL ingest — `if (store.ownWallet(identity) === undefined) {
//   …upsertWallet… }` — which compiles, reads as a plausible "insert-wins", FREEZES the
//   balance after the first delivery, and passes every behavioral gate in this slice
//   (the e2e is deliberately designed so the balance never changes). The single
//   contiguous needle below admits no `if` / `?:` / `&&`.
//
// NO `new RegExp(...)` — this file's established convention (see its header and
//   main.wiring.test.ts:2524, 2557, 5186). indexOf / includes / split / startsWith only.
// ===========================================================================

/** The EXACT ingest statement ADR-0169 D2 mandates, as it appears after
 *  stripLineComments + squashWhitespace. One needle pins ALL of: the table
 *  (`my_wallet`, not `player_wallet`), the handler kind (`onInsert`), the callback
 *  signature, the conversion (`playerWalletRowToStore`, not the raw SDK row), the cast
 *  target (`SdkPlayerWalletRow`, imported from rowConvert per ADR-0169 D3), the store
 *  call (`upsertWallet`), the re-render kick (`batcher.schedule()`), their ORDER, and —
 *  via the ===1 count — its uniqueness.
 *
 *  FORMATTER STABILITY: biome.json sets lineWidth 100 and indentWidth 2. At the
 *  `wireTables` indent the longest line here is
 *  `      store.upsertWallet(playerWalletRowToStore(row as unknown as SdkPlayerWalletRow));`
 *  = 86 columns, so biome will not wrap it and will not insert a trailing comma. The
 *  sibling my_conversation statement (connection.ts:331-334) is 97 columns and is
 *  likewise unwrapped — which is exactly what the calibration fixture below proves. */
const UX2B_WALLET_INGEST =
  'conn.db.my_wallet.onInsert((_ctx, row) => { ' +
  'store.upsertWallet(playerWalletRowToStore(row as unknown as SdkPlayerWalletRow)); ' +
  'batcher.schedule(); });';

/** The already-shipped `my_conversation` insert handler (connection.ts:331-334) in the
 *  SAME squashed form. It is the calibration control for UX2B_WALLET_INGEST: if the
 *  strip+squash pipeline ever stops producing this shape, THIS fixture reds and tells us
 *  the harness is broken — so a red on the wallet needle can only mean the wallet
 *  implementation is missing or misshapen. */
const M13_5C_CONVERSATION_INGEST_CONTROL =
  'conn.db.my_conversation.onInsert((_ctx, row) => { ' +
  'store.upsertConversation(playerConversationRowToStore(row as unknown as SdkConversationRow)); ' +
  'batcher.schedule(); });';

/** The whole file, comment-stripped and whitespace-squashed — the surface every
 *  11r-e-3 / 11r-e-3b assertion runs against. */
function squashedStrippedConnectionTs(): string {
  return squashWhitespace(stripLineComments(readConnectionTs()));
}

// ---------------------------------------------------------------------------
// W-UX2B-SCAN-SOUND — calibration fixtures. GREEN today, BY DESIGN.
// These are not feature gates; they are the proof that the two teeth below fail for
// the right reason. Without them, a red on UX2B_WALLET_INGEST is ambiguous between
// "the implementation is missing" and "the tester's needle format is unachievable".
// ---------------------------------------------------------------------------

describe('connection.ts wiring (11r-e): W-UX2B-SCAN-SOUND — the contiguous-needle pipeline is calibrated', () => {
  it('FIXTURE (green today): the shipped my_conversation insert handler matches a contiguous needle of exactly this shape', () => {
    // If this reds, the strip+squash pipeline (or biome's formatting of wireTables)
    // changed and UX2B_WALLET_INGEST's FORM must be re-derived FROM THE SOURCE — never
    // by loosening the wallet assertion to match a buggy implementation.
    const squashed = squashedStrippedConnectionTs();
    expect(
      countOccurrences(squashed, M13_5C_CONVERSATION_INGEST_CONTROL),
      'the my_conversation ingest statement (connection.ts:331-334) must appear EXACTLY ' +
        'once in the comment-stripped, whitespace-squashed source. This fixture calibrates ' +
        'the exact needle FORM that 11r-e-3 requires of my_wallet — if it reds, the harness ' +
        'is broken, not the wallet implementation',
    ).toBe(1);
  });

  it('FIXTURE (green today): connection.ts contains no `://`, so the naive stripLineComments is sound', () => {
    // stripLineComments truncates each line at the first `//`. A protocol URL in a string
    // literal (a websocket scheme followed by `//…`) would therefore silently delete the rest of that line and could
    // make a negative assertion pass vacuously. connectionConfig.ts has such URLs;
    // connection.ts does not. This assertion is the standing guard on that precondition
    // (plan R1) — if a URL is ever added here, this reds loudly instead of the scans
    // going quietly soft.
    expect(
      countOccurrences(readConnectionTs(), '://'),
      'connection.ts must contain no `://` — stripLineComments truncates at the first `//`, ' +
        'so a URL literal would silently eat the rest of its line. If this reds, move the URL ' +
        'to connectionConfig.ts (where it belongs) rather than weakening the scans',
    ).toBe(0);
  });

  it('FIXTURE (green today): comment-stripping removes a TRIPWIRE comment that names onDelete / onUpdate / shouldRemoveOnViewDelete', () => {
    // ADR-0169 D2 requires the implementer to leave a tripwire COMMENT in connection.ts
    // (the profile idiom at connection.ts:470-482) that deliberately NAMES the handlers
    // it is refusing to register. Without comment-stripping, that sanctioned comment
    // would trip every negative below and CORRECT code would red — which is the classic
    // way a tester ends up "fixing" a good implementation to satisfy a bad test.
    // This fixture proves the pipeline eats it, in both the `//` and `/* */` forms.
    const tripwireLine = [
      '    // m17-style TRIPWIRE — deliberately NO conn.db.my_wallet.onDelete and no',
      '    // conn.db.my_wallet.onUpdate handler, and NO shouldRemoveOnViewDelete gate:',
      '    // ADR-0154 D4 (a view update arrives as unordered insert+delete).',
      '    conn.db.my_wallet.onInsert((_ctx, row) => {});',
    ].join('\n');
    const strippedLine = squashWhitespace(stripLineComments(tripwireLine));
    expect(countOccurrences(strippedLine, 'conn.db.my_wallet.onDelete')).toBe(0);
    expect(countOccurrences(strippedLine, 'conn.db.my_wallet.onUpdate')).toBe(0);
    expect(countOccurrences(strippedLine, 'shouldRemoveOnViewDelete')).toBe(0);
    // Anti-vacuity: the stripper must not have eaten the real code on the last line.
    expect(countOccurrences(strippedLine, 'conn.db.my_wallet.onInsert')).toBe(1);

    const tripwireBlock =
      '/* NO conn.db.my_wallet.onDelete, NO shouldRemoveOnViewDelete */\n' +
      '    conn.db.my_wallet.onInsert((_ctx, row) => {});';
    const strippedBlock = squashWhitespace(stripLineComments(tripwireBlock));
    expect(countOccurrences(strippedBlock, 'conn.db.my_wallet.onDelete')).toBe(0);
    expect(countOccurrences(strippedBlock, 'shouldRemoveOnViewDelete')).toBe(0);
    expect(countOccurrences(strippedBlock, 'conn.db.my_wallet.onInsert')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W-UX2B-SUBSCRIBE (EARS 11r-e-1) — `my_wallet` joins the ONE subscribe array.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (11r-e / ADR-0169 D1): W-UX2B-SUBSCRIBE — my_wallet is subscribed INSIDE the .subscribe([...]) array', () => {
  it("★ BITES: the .subscribe([...]) array contains 'SELECT * FROM my_wallet' exactly once", () => {
    // WRONG IMPL KILLED (b): subscribing NOTHING — ship the converter and the ingest
    // handler and leave the client dark. That is today's state, and it is the single most
    // likely way this slice "lands" without working: every other gate in the slice can be
    // satisfied while no row ever arrives.
    // WRONG IMPL KILLED (c): parking 'SELECT * FROM my_wallet' in a dead module-level
    // constant, in a commented-out line, or in a second unreachable .subscribe() call.
    // The window is what kills this — a needle checked against the whole file cannot
    // tell a live subscription from a dead string (the precedent reasoning is
    // evals/conversation-privacy.eval.mjs:394-420, Finding 5).
    // WRONG IMPL KILLED (d): subscribing the view TWICE (an over-eager merge of two
    // branches) — the ===1 count, not a mere `toContain`.
    const src = readConnectionTs();
    // Anti-vacuity (red-team S8): a duplicated or deleted anchor lets a needle-bounded
    // region silently cover the wrong code — the nh1 post-mortem failure mode. Verified
    // this session: `.subscribe([` occurs exactly once in connection.ts (:544).
    expectUniqueAnchor(src, '.subscribe([');

    const arrayBody = bodyRegion(src, '.subscribe([', ']);');

    // Anti-vacuity: the window really is the subscription array. `my_conversation` is
    // the sibling owner-scoped VIEW already subscribed there (:572) and is the closest
    // structural analogue of what we are adding, so its presence proves both that the
    // region resolved and that comment-stripping did not eat the array's contents.
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_conversation'"),
      'the .subscribe([...]) window must still contain the my_conversation subscription — ' +
        'if it does not, this gate is judging the wrong region and every assertion below ' +
        'is vacuous',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_wallet'"),
      "connection.ts's ONE .subscribe([...]) array must contain 'SELECT * FROM my_wallet' " +
        'exactly once (ADR-0169 D1). RED TODAY: `my_wallet` appears nowhere in ' +
        'connection.ts, so the owner-scoped wallet view is never subscribed and ' +
        '#shop-balance renders `unknown` forever — the player still cannot see their gold',
    ).toBe(1);
  });

  it('★ BITES: the .subscribe([...]) array does NOT name player_wallet (windowed, comment-stripped)', () => {
    // WRONG IMPL KILLED (a): subscribing the PRIVATE table `player_wallet` instead of the
    // owner-scoped view. This is not a mild bug: SpacetimeDB rejects the whole
    // subscription BATCH, `onApplied` never fires, and every player gets a blank world —
    // the T0 rollout probe finding recorded in ADR-0087 / conversation-privacy check D.
    //
    // WHY WINDOWED AND NOT WHOLE-FILE (plan R8 / reviewer m2): ADR-0169 D1 REQUIRES the
    // comment at connection.ts:576-577 to be rewritten into the my_conversation form
    // (:569-571), which legitimately NAMES the private table to explain why it is not
    // subscribed. A whole-file `not.toContain('player_wallet')` would go red on correct,
    // sanctioned code — and the natural "fix" would be deleting a security-relevant
    // comment. Scoping the negative to the comment-stripped array body is what makes it
    // both sound and sharp.
    const src = readConnectionTs();
    expectUniqueAnchor(src, '.subscribe([');
    const arrayBody = bodyRegion(src, '.subscribe([', ']);');

    // Anti-vacuity: this negative is meaningless until the positive exists — an array
    // with no wallet subscription at all trivially satisfies it. Asserting the positive
    // first is what makes this test RED TODAY for the right reason (missing subscription)
    // rather than green-and-empty.
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_wallet'"),
      'precondition for the player_wallet negative: the my_wallet subscription must exist ' +
        'first, otherwise "player_wallet is absent" is a vacuous truth. RED TODAY',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, 'player_wallet'),
      'the .subscribe([...]) array must NEVER name the PRIVATE player_wallet table — ' +
        'subscribing it errors the entire subscription batch, onApplied never fires, and ' +
        'EVERY player gets a blank world (ADR-0081/0040 privacy + ADR-0087 rollout probe). ' +
        'Only the owner-scoped my_wallet view may be subscribed',
    ).toBe(0);
  });

  it('★ BITES: the RAW (un-stripped) source no longer claims player_wallet "produces no client subscription"', () => {
    // WRONG IMPL KILLED: wiring the subscription and leaving the comment at
    // connection.ts:576-577 in place. After this slice that sentence is FALSE, in a
    // security-sensitive file, next to the exact list a reviewer reads to decide whether
    // a private table leaked. Comment rot here is not cosmetic: the next person auditing
    // wallet privacy would be told, in the file itself, that no wallet subscription
    // exists.
    //
    // THIS IS THE ONE ASSERTION THAT MUST RUN ON RAW SOURCE. Every other tooth in this
    // section strips comments — and a comment-stripped scan is structurally incapable of
    // seeing comment rot (plan R8 / reviewer m1).
    const raw = readConnectionTs();

    // Anti-vacuity: we are scanning the file we think we are.
    expectUniqueAnchor(raw, '.subscribe([');

    expect(
      countOccurrences(raw, 'produces no client subscription'),
      'connection.ts must no longer contain the phrase "produces no client subscription" — ' +
        'ADR-0169 D1 requires that comment to be REWRITTEN into the my_conversation form ' +
        '(:569-571). RED TODAY: the stale claim is still at connection.ts:576-577',
    ).toBe(0);

    // WRONG IMPL KILLED: satisfying the assertion above by DELETING the comment outright.
    // ADR-0169 D1 says rewritten, not removed: the replacement must still record that
    // player_wallet is private and that the owner-scoped view is subscribed in its place,
    // exactly as my_conversation's comment does. Deleting it would make the next reviewer
    // re-derive the privacy rationale from scratch — in the file where getting it wrong
    // blanks the world for everyone.
    expect(
      countOccurrences(raw, 'player_wallet') >= 1,
      'the rewritten comment must STILL name player_wallet as the private table whose ' +
        'owner-scoped view is subscribed instead (ADR-0169 D1, mirroring connection.ts:' +
        '569-571) — deleting the comment to satisfy the stale-phrase check throws away the ' +
        'ADR-0081/0040 privacy rationale in a security-sensitive file',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W-UX2B-INGEST (EARS 11r-e-3 / 11r-e-3b) — insert-only, exact shape, whole file.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (11r-e / ADR-0169 D2): W-UX2B-INGEST — the my_wallet ingest is insert-only and exactly one statement', () => {
  it('★ BITES (11r-e-3): the EXACT contiguous ingest statement occurs exactly once in the whole comment-stripped file', () => {
    // ONE needle, many teeth. Each of the following wrong implementations fails it:
    //   * `store.upsertWallet(row as unknown as StoreWallet)` — the RAW SDK row, so
    //     ownerIdentity stays an SDK Identity OBJECT and store.ownWallet's `===` filter
    //     never matches. The readout is `unknown` forever and looks like an unwired
    //     feature (ADR-0169 D3 c, seen from the wiring side).
    //   * omitting `batcher.schedule()` — the row lands in the store but nothing
    //     re-renders until some UNRELATED batch happens to flush. No e2e in this slice can
    //     see this (the NPC wander tick re-renders every ~200 ms and the run self-heals),
    //     which is precisely why this assertion is load-bearing (ADR-0169 Consequences).
    //   * a CONDITIONAL upsert — `if (store.ownWallet(identity) === undefined) { … }` or
    //     `store.upsertWallet(existing ?? playerWalletRowToStore(row))`. It compiles, reads
    //     like a plausible "insert-wins", and FREEZES the balance after the first delivery:
    //     buy or sell anything and the readout is stale forever. It passes every
    //     behavioral gate in this slice because the e2e is designed so the balance never
    //     changes. A contiguous needle admits no `if` / `?:` / `&&` (ADR-0169 D2).
    //   * registering the handler TWICE (double schedule per row) — the ===1 count.
    //   * `conn.db.player_wallet.onInsert(...)` — wrong table name, no match.
    const squashed = squashedStrippedConnectionTs();
    expect(
      countOccurrences(squashed, UX2B_WALLET_INGEST),
      'connection.ts must contain EXACTLY this statement, exactly once (ADR-0169 D2):\n  ' +
        UX2B_WALLET_INGEST +
        '\nRED TODAY: `conn.db.my_wallet` appears nowhere in connection.ts. If the ' +
        'implementation is present but this reds, compare it CHARACTER BY CHARACTER — the ' +
        'needle deliberately pins conversion, argument, ordering and batcher.schedule() ' +
        'together, because each of those omitted separately is a real shipped-and-broken ' +
        'outcome. Do NOT loosen this needle to match the code; correct the code, or ' +
        're-derive the needle FROM ADR-0169 D2',
    ).toBe(1);
  });

  it('★ BITES (11r-e-3b): NO conn.db.my_wallet.onDelete and NO conn.db.my_wallet.onUpdate handler exists anywhere in the file', () => {
    // WRONG IMPL KILLED (the single most likely mistake in this slice — ADR-0169 D2 names
    // it, and it is 3 lines away in the same function): copying the my_conversation
    // onDelete block at connection.ts:335-341. Through a VIEW a row UPDATE arrives as
    // unordered onInsert(new) + onDelete(old), so on a buy-then-sell round trip the
    // coalesced sequence `I(50) I(100) D(100) D(50)` makes ANY net-effect delete gate
    // remove the LIVE row: the player's gold vanishes mid-session (ADR-0154 D4). And
    // because no server path ever deletes a player_wallet row
    // (economy_tests.rs::player_wallet_rows_are_never_deleted), the handler is DEAD as
    // well as wrong. store.reset() on disconnect is the sole clearing path — which is why
    // store.ts:981-988 ships upsertWallet with no removeWallet counterpart at all.
    //
    // WHOLE-FILE, not region-bounded (ADR-0169 D2 / red-team S4): a sentinel-delimited
    // region cannot see a delete handler relocated 200 lines down, and a relocated
    // handler is just as fatal as an adjacent one.
    //
    // The negatives are safe against the mandated TRIPWIRE comment because the source is
    // comment-stripped first — proved by W-UX2B-SCAN-SOUND above.
    const squashed = squashedStrippedConnectionTs();

    // Anti-vacuity: "no wallet delete handler" is a vacuous truth while there is no wallet
    // wiring at all. Asserting the insert handler first makes this test RED TODAY for the
    // right reason and keeps it meaningful afterwards.
    expect(
      countOccurrences(squashed, 'conn.db.my_wallet.onInsert'),
      'precondition: the my_wallet insert handler must exist before "no delete handler" ' +
        'means anything. RED TODAY',
    ).toBe(1);

    expect(
      countOccurrences(squashed, 'conn.db.my_wallet.onDelete'),
      'there must be NO conn.db.my_wallet.onDelete handler (ADR-0154 D4): a view UPDATE ' +
        'arrives as unordered insert+delete, so `I(50) I(100) D(100) D(50)` would delete ' +
        "the LIVE row and the player's gold would vanish mid-session. No server path " +
        'deletes a player_wallet row, so the handler is dead as well as wrong',
    ).toBe(0);

    expect(
      countOccurrences(squashed, 'conn.db.my_wallet.onUpdate'),
      'there must be NO conn.db.my_wallet.onUpdate handler (ADR-0087): a VIEW table has ' +
        'no PK for SDK correlation, so onUpdate never fires — wiring one is dead code that ' +
        'implies a delivery guarantee the transport does not make',
    ).toBe(0);

    // 11r-e-3b, second clause: "SHALL call no wallet-removal API". store.ts deliberately
    // ships upsertWallet with NO removeWallet counterpart (store.ts:981-988), so this is
    // currently also a tsc error — but the assertion states the invariant explicitly so a
    // future slice that ADDS removeWallet (for some other reason) cannot quietly wire it
    // here. store.reset() on disconnect remains the sole clearing path.
    expect(
      countOccurrences(squashed, 'removeWallet'),
      'connection.ts must call no wallet-removal API (ADR-0154 D4 / store.ts:981-988): ' +
        'store.reset() on disconnect is the ONLY path that may clear the wallet slot',
    ).toBe(0);

    // 11r-e-3b, third clause: "SHALL construct no fallback/default wallet row". The single
    // contiguous needle already pins the ONE upsert call's argument; this pins that there
    // is no SECOND one — e.g. a `store.upsertWallet({ ownerIdentity: identity, balance: 0n })`
    // seeded on connect "so the UI has something to show". That is exactly the fabricated
    // zero ADR-0154 D1 refused to let `economy::wallet_balance`'s `.unwrap_or(0)` reach the
    // UI, and it would make a dark client render a confident, wrong `Gold: 0`.
    expect(
      countOccurrences(squashed, 'store.upsertWallet('),
      'store.upsertWallet( must be called from EXACTLY ONE site in connection.ts — the ' +
        'my_wallet onInsert handler. A second call site is a fabricated/default wallet row ' +
        '(ADR-0154 D1/D6: "broke" must never be invented from "dark")',
    ).toBe(1);
  });

  it('★ BITES (11r-e-3b): shouldRemoveOnViewDelete is still invoked at exactly ONE call site — my_conversation’s', () => {
    // The free tooth against ADR-0169 D2's named anti-pattern. A copy-pasted wallet delete
    // gate — `if (shouldRemoveOnViewDelete(store.ownWallet(deleted.ownerIdentity),
    // deleted)) { … }` — is the most plausible wrong implementation because the nearest
    // precedent in the same function does exactly that and it reads entirely sensible.
    // The `.onDelete` negative above already catches the standard form; THIS catches a
    // variant that reaches the gate through some other handler or helper.
    //
    // CRITERION CORRECTION (tester, from the spec): the slice brief and plan R3 both
    // specify `countOccurrences(S, 'shouldRemoveOnViewDelete') === 1`. That number is
    // WRONG on the live file and would red on correct code. The identifier occurs TWICE
    // in the comment-stripped source today:
    //   1. connection.ts:58  — the import specifier in the `./rowConvert` block, and
    //   2. connection.ts:337 — the single my_conversation call site.
    //   (A third occurrence at :322 is a `//` comment and IS stripped.)
    // The INTENT — "still ONLY my_conversation's gate" — is preserved exactly by counting
    // INVOCATIONS (the needle carries the open paren, so the import specifier is not a
    // call site). This is the same import-is-not-a-call-site reasoning the W-DEVLOG-WRAP
    // gate uses above. Both numbers are asserted so the correction is self-documenting.
    const squashed = squashedStrippedConnectionTs();

    // Anti-vacuity / RED TODAY: only meaningful once the wallet ingest exists.
    expect(
      countOccurrences(squashed, 'conn.db.my_wallet.onInsert'),
      'precondition: the my_wallet ingest must exist before this gate means anything. ' +
        'RED TODAY',
    ).toBe(1);

    expect(
      countOccurrences(squashed, 'shouldRemoveOnViewDelete('),
      'shouldRemoveOnViewDelete( must be INVOKED exactly once in connection.ts — only the ' +
        'my_conversation view-delete gate at connection.ts:335-341. A second call site ' +
        'means the wallet (or another view) grew a delete gate, which ADR-0154 D4 forbids: ' +
        'the coalesced `I(50) I(100) D(100) D(50)` update pair would wipe the live row',
    ).toBe(1);

    expect(
      countOccurrences(squashed, 'shouldRemoveOnViewDelete'),
      'the shouldRemoveOnViewDelete IDENTIFIER must occur exactly twice in the ' +
        'comment-stripped source: the ./rowConvert import specifier (connection.ts:58) and ' +
        'the one my_conversation call site (:337). A third occurrence is a new gate; a ' +
        'first-only occurrence means the my_conversation gate was deleted',
    ).toBe(2);
  });

  it('★ BITES: playerWalletRowToStore and SdkPlayerWalletRow are imported from ./rowConvert (not re-declared locally)', () => {
    // ADR-0169 D3: SdkPlayerWalletRow is EXPORTED from rowConvert.ts — the dominant
    // convention (SdkProfileRow, SdkTradeOfferRow, …) — rather than re-declared inside
    // wireTables the way the anomalous SdkConversationRow is (connection.ts:326-330).
    // WRONG IMPL KILLED: copying that anomaly. A locally re-declared row type drifts
    // silently from the converter's own parameter type, so the `as unknown as` cast in the
    // ingest statement would stop meaning anything — the compiler would be checking the
    // cast against a hand-written shape rather than against the converter's contract.
    // WRONG IMPL KILLED: an inline `(row: {ownerIdentity:{toHexString():string};
    // balance:bigint})` shape that never touches rowConvert at all.
    //
    // WINDOWING NOTE: `import {` is NOT unique in connection.ts (:12 and :28), so it
    // cannot anchor a region. Instead the needles carry a TRAILING COMMA — which occurs
    // only in an import specifier list, never at the call site `playerWalletRowToStore(`
    // (the same import-is-not-a-call-site discrimination the W-DEVLOG-WRAP gate above
    // relies on) — and each is then required to appear BEFORE the unique
    // `} from './rowConvert';` terminator, which is what pins them into THAT import.
    const squashed = squashedStrippedConnectionTs();
    const rowConvertImportEnd = squashed.indexOf("} from './rowConvert';");
    expect(
      rowConvertImportEnd,
      "connection.ts must still import from './rowConvert' — if this anchor is gone, this " +
        'gate is judging the wrong file',
    ).toBeGreaterThan(0);

    expect(
      countOccurrences(squashed, 'playerWalletRowToStore,'),
      "playerWalletRowToStore must be imported from './rowConvert' (the alphabetized import " +
        'block at connection.ts:28-62). RED TODAY: it is absent — and does not exist in ' +
        'rowConvert.ts yet either',
    ).toBe(1);
    expect(
      squashed.indexOf('playerWalletRowToStore,'),
      "the playerWalletRowToStore specifier must sit INSIDE the './rowConvert' import block " +
        '(i.e. before its closing `} from` terminator), not in some other import',
    ).toBeLessThan(rowConvertImportEnd);

    expect(
      countOccurrences(squashed, 'type SdkPlayerWalletRow,'),
      "SdkPlayerWalletRow must be imported as a type from './rowConvert' (ADR-0169 D3), NOT " +
        're-declared locally the way the anomalous SdkConversationRow is at ' +
        'connection.ts:326-330 — a local re-declaration silently drifts from the ' +
        "converter's own parameter type and hollows out the `as unknown as` cast",
    ).toBe(1);
    expect(
      squashed.indexOf('type SdkPlayerWalletRow,'),
      "the SdkPlayerWalletRow specifier must sit INSIDE the './rowConvert' import block",
    ).toBeLessThan(rowConvertImportEnd);
    // The type must not ALSO be declared locally (belt and braces against a merge that
    // keeps both).
    expect(
      countOccurrences(squashed, 'type SdkPlayerWalletRow = {'),
      'SdkPlayerWalletRow must not be re-declared inside connection.ts',
    ).toBe(0);
    expect(
      countOccurrences(squashed, 'interface SdkPlayerWalletRow'),
      'SdkPlayerWalletRow must not be re-declared inside connection.ts',
    ).toBe(0);
  });
});

// ===========================================================================
// EG4 — the `evolution_path` subscription + ingest REPLACES `fusion`.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-EG4-contract.md §A1, §B
// ("Deleted: … 'SELECT * FROM fusion' …"), §G (EARS EG4-5 + the A1 row).
//
// RED REASON (verified against client/src/net/connection.ts this session):
//   * the ONE `.subscribe([...])` array (:568-619) still carries
//     `'SELECT * FROM fusion'` (:591) and names `evolution_path` nowhere;
//   * `wireTables` still wires `conn.db.fusion.onInsert/onUpdate/onDelete`
//     (:308-317) through `ingestFusion` / `fusionRowToStore`, and
//     `conn.db.evolution_path` appears nowhere in the file.
// Every tooth below fails on a MISSING implementation, not a typo here.
//
// TABLE NAME VERIFIED: client/src/module_bindings/index.ts:162-174 declares
// `name: 'evolution_path'` (snake_case, matching every other table string in the
// array). This matters more than usual: a WRONG table name in a subscription does
// not degrade gracefully — SpacetimeDB rejects the ENTIRE subscription batch,
// `onApplied` never fires, and every player gets a blank world (the T0 rollout
// probe recorded in ADR-0087 / conversation-privacy check D).
//
// NO `new RegExp(...)` — this file's convention. indexOf / includes / split only.
// ===========================================================================

describe('★ connection.ts wiring (EG4): W-EG4-SUBSCRIBE — evolution_path is subscribed INSIDE the ONE .subscribe([...]) array', () => {
  it("★ BITES: the .subscribe([...]) array contains 'SELECT * FROM evolution_path' exactly once", () => {
    // WRONG IMPL KILLED (a): shipping the converter, the store map and the ingest
    // handlers and never subscribing the table. Every other EG4 gate can pass while no
    // row ever arrives — the progress panel renders "no paths" forever and looks like
    // missing CONTENT rather than missing wiring.
    // WRONG IMPL KILLED (b): parking the string in a dead module-level constant, a
    // commented-out line, or a second unreachable .subscribe() call — the WINDOW is
    // what kills this (precedent: evals/conversation-privacy.eval.mjs:394-420).
    // WRONG IMPL KILLED (c): subscribing it twice (an over-eager merge) — the ===1.
    const src = readConnectionTs();
    // Anti-vacuity: a duplicated/deleted anchor lets a needle-bounded region silently
    // cover the wrong code (the nh1 post-mortem failure mode).
    expectUniqueAnchor(src, '.subscribe([');
    const arrayBody = bodyRegion(src, '.subscribe([', ']);');

    // Anti-vacuity: prove the window really is the subscription array before judging it.
    //
    // 13r-e (ADR-0194): RETARGETED from `'SELECT * FROM monster_pub'` to the owner-scoped
    // VIEW. monster_pub is PRIVATE now and its subscription string is deleted outright, so
    // the old anchor would never match again — and an anti-vacuity anchor that can never
    // match does not fail loud here, it makes THIS gate (and the fusion negative below)
    // judge a region it can no longer prove is the subscription array. Retargeting is
    // mandatory, not cosmetic.
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_monster_pub'"),
      'the .subscribe([...]) window must still contain the my_monster_pub subscription (the ' +
        'owner-scoped view that replaced the private monster_pub table in 13r-e/ADR-0194) — ' +
        'if it does not, this gate is judging the wrong region and every assertion here is ' +
        'vacuous',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM evolution_path'"),
      "connection.ts's ONE .subscribe([...]) array must contain 'SELECT * FROM " +
        "evolution_path' exactly once. The table name is EXACT — module_bindings/index.ts:" +
        "162-174 declares name: 'evolution_path'. A wrong name (evolutionPath, " +
        'evolution_paths, EvolutionPath) errors the WHOLE subscription batch and onApplied ' +
        'never fires: every player gets a blank world, not just an empty panel. RED TODAY',
    ).toBe(1);
  });

  it('★ BITES (EG4-5): the .subscribe([...]) array no longer names the fusion table at all', () => {
    // WRONG IMPL KILLED: adding evolution_path and leaving `'SELECT * FROM fusion'`
    // behind. EG4-5 deletes ALL fusion wiring; a surviving subscription keeps a table
    // the client no longer has a store map for streaming rows at every client, and it
    // is exactly the "partial deletion leaving dead wiring" the contract's §G row for
    // EG4-5 names.
    // WINDOWED, comment-stripped, and the POSITIVE is asserted first: "fusion is gone"
    // is a vacuous truth for an array that also lost evolution_path.
    const src = readConnectionTs();
    expectUniqueAnchor(src, '.subscribe([');
    const arrayBody = bodyRegion(src, '.subscribe([', ']);');

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM evolution_path'"),
      'precondition for the fusion negative: the evolution_path subscription must exist ' +
        'first, otherwise "fusion is absent" is a vacuous truth. RED TODAY',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM fusion'"),
      "the .subscribe([...]) array must NOT contain 'SELECT * FROM fusion' — EG4-5 deletes " +
        'the fusion wiring outright (contract §B). RED TODAY: it is still at ' +
        'connection.ts:591',
    ).toBe(0);
    expect(
      countOccurrences(arrayBody, 'fusion'),
      'the comment-stripped .subscribe([...]) array body must not mention `fusion` in ANY ' +
        'form — a renamed-but-still-present subscription is the same dead wiring',
    ).toBe(0);
  });
});

describe('★ connection.ts wiring (EG4/A1): W-EG4-INGEST — the evolution_path row handlers are wired, keyed by pathId', () => {
  it('★ BITES: onInsert, onUpdate and onDelete are each registered EXACTLY once on conn.db.evolution_path', () => {
    // WRONG IMPL KILLED (a): no handlers at all — the subscription delivers rows into
    // the void and the store map stays empty (today's state: `conn.db.evolution_path`
    // appears nowhere in connection.ts).
    // WRONG IMPL KILLED (b): wiring onInsert only. `evolution_path` is a REGULAR public
    // table with a primary key, not a view, so onUpdate fires normally — and
    // `sync_content` (server-module/src/content.rs:268-292) republishes by DELETE +
    // INSERT, so onDelete is not optional either: without it the map only ever grows
    // and stale edges accumulate across republishes.
    // WRONG IMPL KILLED (c): registering a handler twice (double schedule per row).
    const squashed = squashedStrippedConnectionTs();
    expect(
      countOccurrences(squashed, 'conn.db.evolution_path.onInsert'),
      'connection.ts must register exactly one conn.db.evolution_path.onInsert handler. ' +
        'RED TODAY: conn.db.evolution_path appears nowhere in the file',
    ).toBe(1);
    expect(
      countOccurrences(squashed, 'conn.db.evolution_path.onUpdate'),
      'connection.ts must register exactly one conn.db.evolution_path.onUpdate handler',
    ).toBe(1);
    expect(
      countOccurrences(squashed, 'conn.db.evolution_path.onDelete'),
      'connection.ts must register exactly one conn.db.evolution_path.onDelete handler',
    ).toBe(1);
  });

  it('★ BITES: the ingest converts through evolutionPathRowToStore and kicks batcher.schedule()', () => {
    // WRONG IMPL KILLED (a): `store.upsertEvolutionPath(row as unknown as
    // StoreEvolutionPath)` — the RAW SDK row, so `minTrustTier` stays `{tag,value}`,
    // absent options stay `undefined` instead of `null`, and the essence list keeps its
    // tagged-union affinities. Every gate in the eligibility port then silently reads
    // false and NOTHING is ever eligible.
    // WRONG IMPL KILLED (b): omitting `batcher.schedule()` — rows land in the store and
    // nothing re-renders until some UNRELATED table happens to flush. Content arrives
    // once, at subscription time, so in practice the panel stays blank for the session.
    const squashed = squashedStrippedConnectionTs();
    expect(
      countOccurrences(squashed, 'evolutionPathRowToStore('),
      'connection.ts must convert evolution_path rows through evolutionPathRowToStore( — ' +
        'never hand the raw SDK row to the store',
    ).toBeGreaterThanOrEqual(1);

    const insertIdx = squashed.indexOf('conn.db.evolution_path.onInsert');
    expect(
      insertIdx,
      'connection.ts must contain a conn.db.evolution_path.onInsert handler. RED TODAY',
    ).toBeGreaterThanOrEqual(0);

    // RED-TEAM CORRECTION (window sizing, not a loosening): a fixed 300-char forward
    // window from `onInsert` FALSE-REDS the house idiom. Every other table here
    // (item_row :301-306, the fusion block :308-317, my_conversation :332-...) hoists
    // the body into a `const ingestX = (row) => { store.upsertX(...); batcher.schedule(); }`
    // helper declared ABOVE the three registrations, so `batcher.schedule()` sits BEFORE
    // `onInsert`, and the next occurrence after it is inside onDelete — measured at ~344
    // chars past `onInsert` once biome wraps at lineWidth 100. The tooth would have forced
    // a non-idiomatic inline handler or a weakened assertion.
    //
    // The region is therefore anchored on the CONVERSION SITE and bounded by the onDelete
    // registration. This is STRICTLY TIGHTER, not looser: it cannot borrow a neighbouring
    // table's `batcher.schedule()` (the bound stops inside this table's own block), and it
    // still reds for the mutant it was written for — an ingest that writes the store and
    // never kicks the batcher, under EITHER the helper idiom or an inline handler.
    const convIdx = squashed.indexOf('evolutionPathRowToStore(');
    expect(
      convIdx,
      'connection.ts must contain an evolutionPathRowToStore( call site. RED TODAY',
    ).toBeGreaterThanOrEqual(0);
    const ingestEndIdx = squashed.indexOf('conn.db.evolution_path.onDelete');
    expect(
      ingestEndIdx,
      'the evolution_path onDelete registration must exist and FOLLOW the conversion/ingest ' +
        'site — the house idiom is onInsert/onUpdate/onDelete in that order, and this bound ' +
        'is what stops the batcher assertion from borrowing the delete handler’s own ' +
        'schedule() call. RED TODAY',
    ).toBeGreaterThan(convIdx);
    const ingestRegion = squashed.slice(convIdx, ingestEndIdx);
    expect(
      ingestRegion.includes('batcher.schedule()'),
      'the evolution_path INSERT/UPDATE ingest must call batcher.schedule() — without the ' +
        're-render kick the content batch lands silently and the panel never redraws. The ' +
        'scanned region runs from the evolutionPathRowToStore( call site up to (and NOT ' +
        'including) the onDelete registration, so the delete handler’s own schedule() ' +
        'cannot satisfy it',
    ).toBe(true);
  });

  it('★★ BITES (A1): the onDelete handler removes by pathId — it must NOT read edgeId', () => {
    // ★ THE A1 BLOCKER, seen from the wiring side. `sync_content`
    // (server-module/src/content.rs:268-292) clear-and-reinserts `evolution_path` in ONE
    // transaction: N deletes + N inserts, the SAME edge_ids, FRESHLY MINTED path_ids, and
    // the SDK gives NO ordering guarantee between the two halves. A delete handler that
    // keys off `row.edgeId` therefore wipes the row the insert half just wrote, and the
    // client's path map silently empties — no error anywhere, the panel just goes blank
    // until the next republish.
    // Kills: `store.removeEvolutionPath(row.edgeId)` and any `#paths.delete(edgeId)`
    // shape reached from this handler.
    const squashed = squashedStrippedConnectionTs();
    const deleteIdx = squashed.indexOf('conn.db.evolution_path.onDelete');
    expect(
      deleteIdx,
      'connection.ts must contain a conn.db.evolution_path.onDelete handler. RED TODAY',
    ).toBeGreaterThanOrEqual(0);
    // 300 chars — see the sizing note on the insert region above. Deliberately tight:
    // the `.edgeId` NEGATIVE below must not be able to spill into a neighbouring
    // table's wiring and red on unrelated code.
    const deleteRegion = squashed.slice(deleteIdx, deleteIdx + 300);

    expect(
      deleteRegion.includes('store.removeEvolutionPath('),
      'the evolution_path onDelete region must call store.removeEvolutionPath(',
    ).toBe(true);
    expect(
      deleteRegion.includes('.pathId'),
      'the evolution_path onDelete region must remove by `.pathId` — the store is keyed by ' +
        'pathId (contract §A1) precisely so a republish burst cannot delete a row the same ' +
        'transaction just inserted',
    ).toBe(true);
    expect(
      deleteRegion.includes('.edgeId'),
      'the evolution_path onDelete region must NOT read `.edgeId`. sync_content re-mints ' +
        'path_ids while KEEPING edge_ids, and delivers N deletes + N inserts UNORDERED in ' +
        'one transaction — an edgeId-keyed delete wipes the freshly inserted row and the ' +
        'client path map silently empties',
    ).toBe(false);
  });

  it('★ BITES (EG4-5): NO fusion ingest survives anywhere in the file', () => {
    // WHOLE-FILE, not region-bounded: a relocated handler is just as dead as an adjacent
    // one, and a partial deletion (view-model gone, adapter left behind) is the likely
    // shape of a half-done EG4-5.
    // Anti-vacuity: the replacement wiring is asserted first, so "fusion is gone" cannot
    // be satisfied by deleting the feature instead of replacing it.
    const squashed = squashedStrippedConnectionTs();
    expect(
      countOccurrences(squashed, 'conn.db.evolution_path.onInsert'),
      'precondition: the evolution_path ingest must exist before "fusion is gone" means ' +
        'anything. RED TODAY',
    ).toBe(1);

    for (const needle of [
      'conn.db.fusion',
      'ingestFusion',
      'fusionRowToStore',
      'SdkFusionRow',
      'store.upsertFusion',
      'store.removeFusion',
    ]) {
      expect(
        countOccurrences(squashed, needle),
        `connection.ts must contain NO occurrence of "${needle}" — EG4-5 deletes ALL fusion ` +
          'wiring from the adapter (contract §B). RED TODAY: the ingestFusion block is still ' +
          'at connection.ts:308-317 and the two rowConvert import specifiers at :32/:46',
      ).toBe(0);
    }
  });
});

// ===========================================================================
// M21b-2 (ADR-0182 D13/D15/D16/D17) — the async credential ladder, the claim-code
// join veto, the my_account runtime path, and the session-lifecycle terminals.
//
// SOURCE OF TRUTH, in precedence order:
//   1. docs/adr/0182-m21b2-oidc-client-claim-ui-better-auth-deployment.md D13-D17.
//      Its code snippets are NORMATIVE ("implements-as-written") and every literal
//      pinned below is transcribed from them, not paraphrased.
//   2. memory/projects/monster-realm-M21b-2-plan.md §3 (G-gate map) + its ADDENDUM
//      §B (RenewalOutcome) and §C (the binding F1-F19 strengthenings).
//   Where 1 and 2 conflict, 1 wins and the conflict is named at the assertion —
//   see G14's wasEverAuthenticated count above for the one instance in this file.
//
// RED REASON (verified by reading client/src/net/connection.ts this session):
// NONE of `ConnectCredential`, `resolveCredential`, `attemptBuild`,
// `continueAnonymously`, `forcedAnon`, `isReturnLegAttempt`,
// `consecutiveTransientErrors`, `claimCode`, `attemptJoin`, `my_account`,
// `upsertAccount` or `oidc` appears anywhere in connection.ts. Every tooth below
// fails on a MISSING IMPLEMENTATION — most of them by THROWING out of
// `regionOrThrow`/`expectUniqueAnchor`, which is a hard red and never a vacuous
// pass. That is the whole reason those two helpers throw instead of returning an
// empty slice.
//
// WHY SOURCE SCAN AND NOT BEHAVIOUR — restated because this block is where it hurts
// most: connection.ts is coverage-EXCLUDED (client/vite.config.ts:98) because
// importing it executes DOM/wasm side effects. It CANNOT be imported under vitest,
// so no test in this repo can observe `attemptBuild()` actually running. Every
// behavioural claim in this slice is proven in the PURE modules these teeth pin the
// wiring to — credentialDecision.test.ts (the branch table), oidc.test.ts
// (totality), claimCode.test.ts (storage), store.test.ts (own-identity filter),
// reconnectPolicy.test.ts (the linkFrozen invariant). This block proves ONLY that
// the shell calls them, in the right place, in the right order. Both halves are
// required; neither substitutes for the other. G26 states its own version of this
// limit at the tooth, where it is load-bearing.
//
// NO `new RegExp(...)`, and NO scheme literal in any string or comment added here —
// this file's standing conventions, both mechanised (the second by the
// W-UX2B-SCAN-SOUND calibration fixture above, which scans connection.ts itself).
//
// ⚠ ANCHOR HYGIENE, FOR THE IMPLEMENTER: the region fences below are resolved
// against RAW connection.ts source (so that a fence sitting inside a comment still
// resolves — this file's long-standing idiom), which means a COMMENT in
// connection.ts that quotes one of them verbatim makes `expectUniqueAnchor` count
// TWO and reds correct code. Describe these constructs in prose, do not quote them:
//   `function build(credential: ConnectCredential): DbConnection | undefined {`
//   `let current: DbConnection | undefined;`
//   `async function attemptBuild(): Promise<void> {`
//   `async function resolveCredential(): Promise<ConnectCredential> {`
//   `function continueAnonymously(): void {`
//   `.onApplied(() => {`   `.onError((ctx)`   `.subscribe([`   `wireTables(conn);`
// This is not hypothetical: connection.ts's own M21b comment quotes `.withToken()`,
// which is exactly why G14's argument-region scan strips comments BEFORE slicing.
// ===========================================================================

/** D13's `resolveCredential` — the ONE async credential producer. */
const M21B2_RESOLVE_DECL = 'async function resolveCredential(): Promise<ConnectCredential> {';
/** D13's `attemptBuild` — the ONE caller of build(). */
const M21B2_ATTEMPT_DECL = 'async function attemptBuild(): Promise<void> {';
/** D13/D17's `continueAnonymously` — AUTH-49's mechanism, and attemptBuild's region fence. */
const M21B2_CONTINUE_DECL = 'function continueAnonymously(): void {';

/** D13/AUTH-49: the sticky forced-anon short-circuit. ZERO I/O — this is the whole point. */
const M21B2_FORCED_ANON_GUARD =
  "if (forcedAnon) return { kind: 'anon', token: auth.tokenForNextAttempt() };";

/** D13/AUTH-43/44 (addendum §C F8): the FULL attempt-gate derivation, pinned as one unit so
 *  `= true`, `= wasEverAuthenticated(...)` alone, and `|| true` are all excluded. */
const M21B2_ATTEMPT_GATE =
  'const attemptGateOpen = wasEverAuthenticated(globalThis, opts.uri, opts.db) || isReturnLegAttempt;';

/** D16 (addendum §C F2/F18): the FUSED claim-code read. Fused deliberately — the bug this
 *  closes is a read HOISTED out of `.onApplied`, and a bare `claimCode.hasUnconsumed(` needle
 *  cannot tell a fresh per-applied read from a cached connect()-scope one. */
const M21B2_CODE_UNCONSUMED =
  'const codeUnconsumed = claimCode.hasUnconsumed(globalThis, opts.uri, opts.db);';

/** D16: the join veto. The claim code is the SOLE veto; `ownAccount` is NEVER an OR-branch. */
const M21B2_SHOULD_JOIN = "const shouldJoin = credential.kind !== 'account' || !codeUnconsumed;";

/** D13: the two terminal branches that must PARK the connection rather than build one. */
const M21B2_SESSION_EXPIRED_BRANCH =
  "if (credential.kind === 'session-expired') { opts.onSessionExpired?.(); current = undefined; return; }";
const M21B2_UNREACHABLE_BRANCH =
  "if (credential.kind === 'auth-service-unreachable') { opts.onAuthServiceUnreachable?.(); current = undefined; return; }";

/** D13's post-await staleness re-check, in BOTH of its positions (see G27's breakdown). */
const M21B2_STALE_RECHECK = 'if (gen !== buildGen || teardown) return;';

/** D13's retry branch, as ONE exact contiguous block (G24). Any comment inside strips to
 *  whitespace and squashes away, so a conforming implementation collapses to precisely this.
 *  Exact-block equality (the KeyC-handler model) closes the three-independent-`.includes`
 *  decoy bypass a per-needle check could not. */
const M21B2_RETRY_BLOCK =
  "if (credential.kind === 'retry') { state = onAttemptFailed(state); scheduleRebuild(); return; }";

/** D13 (ADR-0182 line 220): the sign-in-failed → anon conversion at the build call site.
 *  A FIRST-time claim-flow sign-in whose exchange fails (`sign-in-failed`, AUTH-48) must still
 *  get a connection — an anonymous one — never be stranded with no connection at all. This is
 *  the exact argument build() is handed; dropping it leaves a first-time claimant unable to
 *  connect or even see the claim UI. */
const M21B2_SIGNIN_FALLTHROUGH_BUILD =
  "current = build(credential.kind === 'sign-in-failed' ? { kind: 'anon', token: auth.tokenForNextAttempt() } : credential);";

/** D15 (addendum §C F4): the two my_account ingest statements, mirroring UX2B_WALLET_INGEST
 *  byte-for-byte in FORM. Formatter stability: the longest inner line is
 *  `      store.upsertAccount(accountRowToStore(row as unknown as SdkAccountRow));` = 78
 *  columns at the wireTables indent, well inside biome's lineWidth 100, so it will not wrap
 *  and will not gain a trailing comma — exactly as the calibrated my_conversation control
 *  above proves for the sibling shape. */
const M21B2_ACCOUNT_INSERT_INGEST =
  'conn.db.my_account.onInsert((_ctx, row) => { ' +
  'store.upsertAccount(accountRowToStore(row as unknown as SdkAccountRow)); ' +
  'batcher.schedule(); });';
const M21B2_ACCOUNT_UPDATE_INGEST =
  'conn.db.my_account.onUpdate((_ctx, _old, row) => { ' +
  'store.upsertAccount(accountRowToStore(row as unknown as SdkAccountRow)); ' +
  'batcher.schedule(); });';

/** attemptBuild's body, comment-stripped and squashed. Both fences are asserted unique by
 *  each caller (anti-vacuity), so no tooth here is parasitic on another's execution order. */
function attemptBuildRegion(src: string): string {
  expectUniqueAnchor(src, M21B2_ATTEMPT_DECL);
  expectUniqueAnchor(src, M21B2_CONTINUE_DECL);
  return squashWhitespace(bodyRegion(src, M21B2_ATTEMPT_DECL, M21B2_CONTINUE_DECL));
}

/** resolveCredential's body, comment-stripped and squashed. The end fence is the function's
 *  own final statement (D13) rather than a following declaration, so this region is immune to
 *  where the implementer chooses to place resolveCredential relative to build(). */
function resolveCredentialRegion(src: string): string {
  expectUniqueAnchor(src, M21B2_RESOLVE_DECL);
  expectUniqueAnchor(src, 'return decideConnectCredential(');
  return squashWhitespace(bodyRegion(src, M21B2_RESOLVE_DECL, 'return decideConnectCredential('));
}

/** The subscription's applied callback, comment-stripped and squashed — D16's join gate. */
function onAppliedRegion(src: string): string {
  expectUniqueAnchor(src, '.onApplied(() => {');
  expectUniqueAnchor(src, '.onError((ctx)');
  return squashWhitespace(bodyRegion(src, '.onApplied(() => {', '.onError((ctx)'));
}

// ---------------------------------------------------------------------------
// W-M21B2-IMPORT-EDGES (NEW — coordinator review item 4) — the three new pure
// modules are IMPORTED, and the objects the wiring calls are the REAL ones.
//
// THE HOLE THIS CLOSES: every needle in G17/G18/G24/etc pins `oidc.renewOrExchange(`,
// `claimCode.hasUnconsumed(`, `decideConnectCredential(` — but a LOCAL SHIM
//     const oidc = { renewOrExchange: async () => ({ kind: 'no-session' }) };
// satisfies all of them while importing NONE of the behaviourally-tested modules, so
// the whole slice's behaviour (proved in oidc.test.ts / claimCode.test.ts /
// credentialDecision.test.ts) is silently disconnected from production. This is the
// exact W-CARE-IMPORT / F2 defect main.wiring.test.ts already guards for its own
// imports; it applies here for the same reason. Modelled on the ./rowConvert
// import-edge tooth below (W-UX2B: `} from './rowConvert';` + specifier-before-terminator).
//
// (`import * as oidc` / `import * as claimCode` — the namespace-shim vector — is ALREADY
// banned whole-file by W-M21B2-CREDENTIAL-IS-PROVENANCE's `import *`===0 pin, so only the
// LOCAL-DECLARATION shim remains to close here.)
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2, G14/G16/G30 edge): W-M21B2-IMPORT-EDGES — oidc / claimCode / credentialDecision are the REAL imported modules', () => {
  it('★ BITES: each module is imported by the exact specifier the wiring calls, and no local shim shadows it', () => {
    const squashed = squashedStrippedConnectionTs();

    // Helper: the import STATEMENT that terminates at `} from '<module>';`, sliced back to its
    // own `import` keyword — robust to biome's specifier ORDERING (unlike a full-line pin).
    const importStmt = (moduleSpec: string): string => {
      const terminator = `} from '${moduleSpec}';`;
      expectUniqueAnchor(squashed, terminator);
      const end = squashed.indexOf(terminator);
      const start = squashed.lastIndexOf('import', end);
      expect(
        start,
        `the \`${terminator}\` clause must be preceded by an \`import\` keyword`,
      ).toBeGreaterThanOrEqual(0);
      return squashed.slice(start, end);
    };

    // --- oidc: imported factory createOidcClient, invoked as code, no object-literal shim ---
    // WRONG IMPL KILLED: `const oidc = { renewOrExchange: async () => ({ kind: 'no-session' }) };`
    //   — every renewOrExchange needle passes, the real oidc.ts (AUTH-39/40/41/42 + totality,
    //   the G27 precondition) is never wired, and the anon population's exchange path is a stub.
    expect(
      importStmt('./oidc').includes('createOidcClient'),
      "the './oidc' import must name `createOidcClient` (the factory that produces the `oidc` " +
        'object whose `.renewOrExchange()` G17 pins). RED AT AUTHORING TIME: oidc.ts does not ' +
        'exist',
    ).toBe(true);
    expect(
      countCodeOccurrences(squashed, 'createOidcClient('),
      'createOidcClient( must be INVOKED as code at least once — the `oidc` binding G17/G14 ' +
        'call through must come from the real module, not a hand-rolled object literal',
    ).toBeGreaterThanOrEqual(1);
    for (const shim of ['const oidc = {', 'let oidc = {', 'var oidc = {']) {
      expect(
        countCodeOccurrences(squashed, shim),
        `connection.ts must contain NO \`${shim}\` — an object-literal shim shadows the ` +
          'imported oidc client and silently disconnects every renewOrExchange needle from the ' +
          'behaviourally-tested module (W-CARE-IMPORT / F2)',
      ).toBe(0);
    }

    // --- claimCode: imported object, no local shim -------------------------------------
    // WRONG IMPL KILLED: `const claimCode = { hasUnconsumed: () => false, read: () => '' };`.
    expect(
      importStmt('./claimCode').includes('claimCode'),
      "the './claimCode' import must name `claimCode` (the object whose `.hasUnconsumed()` / " +
        '`.read()` G18 pins). RED AT AUTHORING TIME: claimCode.ts does not exist',
    ).toBe(true);
    for (const shim of ['const claimCode = {', 'let claimCode = {', 'var claimCode = {']) {
      expect(
        countCodeOccurrences(squashed, shim),
        `connection.ts must contain NO \`${shim}\` — a local shim shadows the imported ` +
          'claimCode module and disconnects the F2 join-veto from the tested storage logic',
      ).toBe(0);
    }

    // --- credentialDecision: decideConnectCredential + type ConnectCredential ----------
    // WRONG IMPL KILLED: a locally-defined `function decideConnectCredential` (the G16 branch
    //   table re-implemented, untested, inside a coverage-excluded file).
    const credImport = importStmt('./credentialDecision');
    expect(
      credImport.includes('decideConnectCredential'),
      "the './credentialDecision' import must name `decideConnectCredential` (the pure branch " +
        'table G16 proves and resolveCredential returns through). RED AT AUTHORING TIME: the ' +
        'module does not exist',
    ).toBe(true);
    // ⚠ NOT a bare `.includes('ConnectCredential')` — that is a SUBSTRING of
    // `decideConnectCredential` and would pass vacuously. The `type ` prefix is what pins the
    // type specifier distinctly (verbatimModuleSyntax requires it for a type-only import; the
    // repo writes `type X` in-line, e.g. main.wiring's `type CanOpenVerdict`). If the impl
    // splits it into a separate `import type { ConnectCredential } from './credentialDecision'`,
    // that is a SECOND `} from './credentialDecision';` and expectUniqueAnchor above reds.
    expect(
      credImport.includes('type ConnectCredential'),
      "the './credentialDecision' import must also bring in `type ConnectCredential` — it is " +
        'build()`s parameter type and resolveCredential`s return type (D13). (`type ` prefix ' +
        'required: a bare ConnectCredential is a substring of decideConnectCredential)',
    ).toBe(true);
    for (const shim of ['function decideConnectCredential', 'const decideConnectCredential =']) {
      expect(
        countCodeOccurrences(squashed, shim),
        `connection.ts must contain NO \`${shim}\` — decideConnectCredential is the SSOT ` +
          'branch table (G16, credentialDecision.test.ts); a local re-implementation is ' +
          'untested and lives in a coverage-excluded file',
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-ANON-NO-NETWORK (G17 + addendum §C F8, AUTH-43/44/49) — a tab that has
// never authenticated, and a tab whose player has declined, make ZERO calls to the
// auth service.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-43/44/49, G17): W-M21B2-ANON-NO-NETWORK — the renewal call sits BEHIND the attempt gate', () => {
  it('★ BITES: oidc.renewOrExchange( occurs once, AFTER the full attempt-gate derivation and its early return, and the forcedAnon short-circuit is resolveCredential`s FIRST statement', () => {
    // THE POPULATION THIS PROTECTS: every anonymous player who has never signed in —
    // today that is ALL of them. AUTH-43/44 require that such a tab never contacts Better
    // Auth at all, on any attempt, including every reconnect in the backoff ladder. A
    // renewal call hoisted above the gate turns one flaky wifi minute into a burst of
    // cross-origin requests from every anonymous tab in the playtest.
    //
    // WRONG IMPL KILLED (a) ★ THE NAMED G17 MUTANT: `const outcome = await
    //   oidc.renewOrExchange();` hoisted above `const attemptGateOpen = …` (or the gate
    //   demoted to a `void`-ed pre-warm). Both leave every needle in this tooth textually
    //   present; only the INDEX ORDERING sees them.
    // WRONG IMPL KILLED (b): the gate stubbed to `const attemptGateOpen = true;`, or
    //   narrowed to `= wasEverAuthenticated(globalThis, opts.uri, opts.db);` (dropping the
    //   return-leg disjunct, which silently breaks the FIRST sign-in: the return leg has
    //   no stored marker yet, so the exchange never runs and the code_verifier is burned
    //   for nothing). Addendum §C F8 is exactly this: the FULL derivation is one anchor.
    // WRONG IMPL KILLED (c): the forcedAnon short-circuit deleted or demoted below the
    //   gate. AUTH-49's promise is that "continue anonymously" STOPS the retrying; a
    //   short-circuit placed after `wasEverAuthenticated` still consults storage whose
    //   'account' marker is sticky for the tab's life, so the very next reconnect
    //   re-arms the ladder the player just dismissed (finalization security review H1).
    // WRONG IMPL KILLED (d): a SECOND renewal call site (e.g. a retry loop inside
    //   resolveCredential) — the exactly-once count. Two call sites means two chances to
    //   consume the single-use code_verifier, and the second always fails.
    // WRONG IMPL KILLED (e) ★ THE DECOY-STRING BYPASS (coordinator review): every needle in
    //   this tooth used to be a bare count/index on comment-stripped-but-string-PRESERVING
    //   source, so an inert `const _x = 'const outcome = await oidc.renewOrExchange();';`
    //   parked AFTER the gate satisfied the ordering and the exactly-once count while the
    //   REAL call was absent — resolveCredential would return before ever renewing, and every
    //   returning player would be dropped to anonymous. Closed by binding the FULL EXECUTABLE
    //   STATEMENT inside resolveCredential's region via codeOccurrences (a string decoy's
    //   start sits inside a literal and is excluded), and by making the file-wide count and
    //   every ordering index code-aware.
    const src = readConnectionTs();
    const wholeSquashed = squashWhitespace(stripLineComments(src));

    // The renewal must appear as the FULL executable statement D13 specifies, not a bare
    // `oidc.renewOrExchange(` substring — an executable statement a string decoy cannot
    // legally reproduce as CODE without also being the real call.
    const RENEW_STMT = 'const outcome = await oidc.renewOrExchange();';

    // Addendum §C F8: the FULL derivation, code-anchored (a decoy-string copy does not count).
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_ATTEMPT_GATE),
      'the full `const attemptGateOpen = wasEverAuthenticated(globalThis, opts.uri, opts.db) ' +
        '|| isReturnLegAttempt;` derivation must occur EXACTLY once AS CODE (F8: the whole ' +
        'statement is one anchor, so `= true` / dropping the return-leg disjunct both red)',
    ).toBe(1);
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_FORCED_ANON_GUARD),
      'the forcedAnon short-circuit must occur EXACTLY once AS CODE',
    ).toBe(1);

    // The renewal call, region-bound to resolveCredential AND code-verified.
    const region = resolveCredentialRegion(src);
    // ANTI-VACUITY, ASSERTED FIRST: the region resolved and really is resolveCredential.
    expect(
      includesAsCode(region, 'wasEverAuthenticated('),
      'ANTI-VACUITY: resolveCredential`s body region must call wasEverAuthenticated( AS CODE — ' +
        'if it does not, the region is mis-anchored (or stubbed) and every pin below is vacuous',
    ).toBe(true);
    const renewInRegion = codeOccurrences(region, RENEW_STMT);
    expect(
      renewInRegion.length,
      `resolveCredential must contain the executable statement \`${RENEW_STMT}\` EXACTLY once ` +
        'AS CODE, INSIDE its own body region (ADR-0182 D13). A file-wide bare-substring pin was ' +
        'satisfiable by a decoy string literal parked anywhere; binding the full statement to ' +
        'this region as code closes that. RED AT AUTHORING TIME: resolveCredential does not exist',
    ).toBe(1);
    // The whole module holds exactly one renewal call site, and it is CODE (no decoy).
    expect(
      countCodeOccurrences(wholeSquashed, 'oidc.renewOrExchange('),
      'oidc.renewOrExchange( must be called from EXACTLY ONE site AS CODE in connection.ts. ' +
        'D13: it takes NO flag argument and branches on storage, so a second caller is a second ' +
        'consumer of the same single-use code_verifier — the second one always loses',
    ).toBe(1);

    // --- ORDERING, all indices code-aware and region-relative --------------------------
    // forcedAnon guard < attemptGate derivation < its early return < the renewal call. All
    // four live in resolveCredential, so bound the ordering to its region (a decoy elsewhere
    // in the file can no longer shift an indexOf).
    const guardIdx = codeOccurrences(region, M21B2_FORCED_ANON_GUARD)[0] ?? -1;
    const gateIdx = codeOccurrences(region, M21B2_ATTEMPT_GATE)[0] ?? -1;
    const earlyReturn = codeOccurrences(region, 'if (!attemptGateOpen) {');
    const renewIdx = renewInRegion[0]!;

    expect(
      guardIdx,
      'the forcedAnon short-circuit must be present in the region',
    ).toBeGreaterThanOrEqual(0);
    expect(
      gateIdx,
      'the attempt-gate derivation must be present in the region',
    ).toBeGreaterThanOrEqual(0);
    expect(
      earlyReturn.length,
      'resolveCredential must contain the contiguous early return `if (!attemptGateOpen) {` AS ' +
        'CODE — without it the gate is computed and then ignored, the most common way a guard ' +
        'ships inert (D13: the closed-gate arm returns an anon credential, ZERO Better Auth calls)',
    ).toBe(1);
    const earlyReturnIdx = earlyReturn[0]!;

    expect(
      guardIdx,
      'the forcedAnon short-circuit must appear BEFORE the attempt-gate derivation — AUTH-49: ' +
        'once the player has declined, this tab must not even ASK storage whether it was ever ' +
        'authenticated, because that answer is sticky and would re-arm the ladder',
    ).toBeLessThan(gateIdx);
    expect(
      gateIdx,
      'the attempt-gate derivation must appear BEFORE its own early return',
    ).toBeLessThan(earlyReturnIdx);
    expect(
      earlyReturnIdx,
      'the renewal call must appear AFTER the `if (!attemptGateOpen) {` early return — a call ' +
        'hoisted above the gate contacts the auth service on behalf of every anonymous tab, on ' +
        'every reconnect attempt (AUTH-43/44). THIS IS THE NAMED G17 MUTANT',
    ).toBeLessThan(renewIdx);

    // --- the short-circuit is the FIRST statement, not merely an early one -------------
    expect(
      region.trimStart().startsWith(M21B2_FORCED_ANON_GUARD),
      `resolveCredential's body must OPEN with \`${M21B2_FORCED_ANON_GUARD}\` — the FIRST ` +
        'statement, before any read, any derivation and any await. Anything hoisted above it ' +
        'runs on a tab whose player has explicitly asked to stop trying (AUTH-49). Region ' +
        'starts: ' +
        JSON.stringify(region.trimStart().slice(0, 160)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-FORCED-ANON-STICKY (G25, AUTH-49) — `forcedAnon` is set once, never
// cleared, and lives at connect() scope like every other cross-rebuild fact.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-49, G25): W-M21B2-FORCED-ANON-STICKY — the decline is sticky and connect()-scoped', () => {
  it('★ BITES: forcedAnon is declared once at connect() scope, read once, set once, and NEVER reset — and all three ladder variables live outside build()/attemptBuild()', () => {
    // WRONG IMPL KILLED (a): `forcedAnon = false;` added anywhere after the declaration —
    //   e.g. "reset the decline on a successful reconnect", which sounds helpful and
    //   silently re-arms the auth ladder the player dismissed. AUTH-49's whole content is
    //   that the decline lasts for the rest of this tab's page life.
    // WRONG IMPL KILLED (b) ★ THE NAMED G25 MUTANT: any of the three ladder variables
    //   declared INSIDE build() or attemptBuild(). This is the identical defect
    //   W-NH4-GATE-CONSTRUCTED was written for and it is worth restating per variable:
    //     • `consecutiveTransientErrors` per-attempt ⇒ it is ALWAYS 0 or 1 at the decision
    //       point, AUTH_SERVICE_TRANSIENT_THRESHOLD is never reached, and a down auth
    //       service produces an infinite silent retry loop instead of D17's
    //       'auth-service-unreachable' terminal.
    //     • `forcedAnon` per-attempt ⇒ "continue anonymously" survives exactly one build.
    //     • `isReturnLegAttempt` per-attempt ⇒ the OIDC return leg's single-use hint is
    //       re-created (as `false`) on the very attempt that needs it, so the first
    //       sign-in never exchanges its code at all.
    // WRONG IMPL KILLED (c): a SECOND reader of forcedAnon that branches differently — the
    //   identifier census below.
    const src = readConnectionTs();
    const wholeSquashed = squashWhitespace(stripLineComments(src));

    // --- (a) sticky (all CODE-AWARE — coordinator review) -------------------------------
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_FORCED_ANON_GUARD),
      `the forcedAnon short-circuit \`${M21B2_FORCED_ANON_GUARD}\` must appear EXACTLY once ` +
        'AS CODE (D13/AUTH-49). Two guards is two policies',
    ).toBe(1);
    // NOTE (the file's own idiom — see the buildKind note the retired W-M21B-KIND-READ
    // carried): a bare `forcedAnon = false` needle would red the CORRECT implementation,
    // because the compliant declaration `let forcedAnon = false;` contains it. So the pin is
    // "EXACTLY ONE occurrence", i.e. the declaration and nothing else.
    expect(
      countCodeOccurrences(wholeSquashed, 'forcedAnon = false'),
      '`forcedAnon = false` must occur EXACTLY once AS CODE in connection.ts — the DECLARATION ' +
        '`let forcedAnon = false;` and nothing else. A second occurrence is a RESET, and a reset ' +
        're-arms the auth ladder the player explicitly declined (AUTH-49). If this reds, ' +
        'delete the reset; do not raise the number',
    ).toBe(1);
    expect(
      countCodeOccurrences(wholeSquashed, 'forcedAnon = true;'),
      '`forcedAnon = true;` must occur EXACTLY once AS CODE — inside continueAnonymously(), ' +
        "which is AUTH-49's only mechanism (D13/D17)",
    ).toBe(1);
    expect(
      countCodeOccurrences(wholeSquashed, 'forcedAnon'),
      'the forcedAnon IDENTIFIER must occur EXACTLY 3 times AS CODE, and the breakdown is: ' +
        '(1) the connect()-scope declaration `let forcedAnon = false;`; (2) the ONE read in ' +
        "resolveCredential's opening short-circuit; (3) the ONE write `forcedAnon = true;` in " +
        'continueAnonymously. A 4th occurrence is a second reader (which can disagree with the ' +
        'short-circuit) or a reset (which breaks AUTH-49); a decoy string does not count',
    ).toBe(3);

    // --- (b) connect() scope, exactly as W-NH4-GATE-CONSTRUCTED pins the gate ------------
    // Ordering computed on CODE-AWARE indices (coordinator review): a decoy string carrying a
    // `let forcedAnon …` declaration must not be able to satisfy the "declared before build()"
    // check while the real declaration sits inside build().
    expectUniqueAnchor(src, M21B2_BUILD_ANCHOR);
    expectUniqueAnchor(src, 'wireTables(conn);');
    const buildIdx = codeOccurrences(wholeSquashed, M21B2_BUILD_ANCHOR)[0] ?? -1;
    expect(buildIdx, 'the build() anchor must resolve AS CODE').toBeGreaterThanOrEqual(0);
    const buildBody = squashWhitespace(bodyRegion(src, M21B2_BUILD_ANCHOR, 'wireTables(conn);'));
    const attemptBody = attemptBuildRegion(src);
    // ANTI-VACUITY: both regions are non-degenerate before any negative is judged.
    expect(
      buildBody.trim().length,
      'ANTI-VACUITY: build()`s body region must be non-empty',
    ).toBeGreaterThan(0);
    expect(
      includesAsCode(attemptBody, '= build('),
      'ANTI-VACUITY: attemptBuild`s body region must contain the `= build(` call AS CODE — if ' +
        'it does not, the region is mis-anchored and every negative below is vacuous',
    ).toBe(true);

    for (const decl of [
      'let isReturnLegAttempt',
      'let consecutiveTransientErrors',
      'let forcedAnon',
    ]) {
      const declIdx = codeOccurrences(wholeSquashed, decl)[0] ?? -1;
      expect(
        declIdx,
        `connection.ts must declare \`${decl}\` at connect() scope AS CODE (D13 declares all ` +
          'three alongside buildGen/state/rebuildTimer/teardown)',
      ).toBeGreaterThanOrEqual(0);
      expect(
        declIdx,
        `\`${decl}\` must be declared BEFORE build() — it is a CROSS-REBUILD fact, and a ` +
          'per-build copy resets on every reconnect attempt (the exact mutant ' +
          'W-NH4-GATE-CONSTRUCTED exists for, restated per variable in this test`s comment)',
      ).toBeLessThan(buildIdx);
    }
    for (const ident of ['isReturnLegAttempt', 'consecutiveTransientErrors', 'forcedAnon']) {
      expect(
        countOccurrences(buildBody, ident),
        `build() must not mention \`${ident}\` — the ladder state belongs to connect(), and ` +
          'build() is handed everything it needs as its `credential` parameter (D13)',
      ).toBe(0);
      expect(
        countOccurrences(attemptBody, ident),
        `attemptBuild() must not mention \`${ident}\` — resolveCredential owns the ladder ` +
          'state; attemptBuild owns only the generation guard and the build call (D13)',
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-RESOLVE-THROW-SAFE (G27 + addendum §C F7, finalization review C1
// CRITICAL) — the ONE await in the reconnect ladder can never strand the ladder.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2, G27 / C1 CRITICAL): W-M21B2-RESOLVE-THROW-SAFE — the await is inside a try whose catch climbs the ladder', () => {
  it('★ BITES: `credential = await resolveCredential();` sits in a try; the catch opens with the stale re-check and then climbs the SAME backoff ladder', () => {
    // THE FAILURE THIS PREVENTS is the worst class this codebase has: a PERMANENT SILENT
    // FREEZE. `attemptBuild` is the only thing that ever calls build(); if the await
    // rejects and nothing catches it, the promise is unhandled, `state` is stranded at
    // 'reconnecting', no timer is pending and no further attempt is ever made — the player
    // sees a frozen world with a hopeful status line, forever. RT-01 (connection.ts:138-141)
    // exists for precisely this shape on build()'s SYNCHRONOUS half; this is its async twin,
    // and the ADR names it C1 CRITICAL.
    //
    // resolveCredential's own I/O is REQUIRED to be total (oidc.renewOrExchange maps every
    // internal fetch/crypto/JSON failure to 'transient-error' — proved behaviourally in
    // oidc.test.ts, which is where that claim belongs). This try/catch is the BELT, not the
    // trust: an ordinary Better Auth hiccup (mid-restart, CORS misconfig, a proxy's HTML
    // error page) must never be able to stop the ladder even if a future edit to oidc.ts
    // breaks totality.
    //
    // WRONG IMPL KILLED (a) ★ THE NAMED G27 MUTANT: the try/catch deleted entirely.
    // WRONG IMPL KILLED (b): a catch that swallows — `catch { /* ignore */ }`. The ladder
    //   never climbs, no rebuild is scheduled: the same permanent freeze, with a comment
    //   claiming it is fine. The catch BODY pin sees it.
    // WRONG IMPL KILLED (c) — addendum §C F7: the stale re-check MISSING or placed AFTER
    //   the ladder calls. A superseded attempt's late rejection would then dirty the LIVE
    //   attempt's state and schedule a competing rebuild — ADR-0085's RT-02 defect, on the
    //   new async path. The body pin requires it to be the block's FIRST statement.
    // WRONG IMPL KILLED (d): a second, unguarded `await` in attemptBuild (e.g. awaiting the
    //   build, or an added `await sleep(...)`) — every await is a fresh window for the
    //   generation to advance, and only the pinned one is re-checked afterwards.
    // WRONG IMPL KILLED (e) ★ THE DECOY-STRING BYPASS (coordinator review): the try prefix
    //   and catch body were bare countOccurrences on string-preserving source, so a decoy
    //   string literal of either text passed while the real await ran unguarded. Both are
    //   pinned AS CODE below (their starts sit in code; a decoy's start sits in a literal).
    const src = readConnectionTs();
    const region = attemptBuildRegion(src);

    // ANTI-VACUITY, ASSERTED FIRST.
    expect(
      includesAsCode(region, '= build('),
      'ANTI-VACUITY: attemptBuild`s region must contain the `= build(` call AS CODE',
    ).toBe(true);

    // The try prefix: the await is INSIDE the try, and the catch closes it immediately.
    // Deliberately binding-AGNOSTIC at the `catch` keyword: this repo writes `catch {` when
    // the binding is unused (helpModel.test.ts:189) and `catch (err)` when it is used
    // (connection.ts:144), and D13's own snippet leaves `err` unused. Pinning either
    // spelling would be pinning a lint outcome, not a behaviour.
    const TRY_PREFIX = 'try { credential = await resolveCredential(); } catch';
    const tryPrefixHits = codeOccurrences(region, TRY_PREFIX);
    expect(
      tryPrefixHits.length,
      `attemptBuild must contain the contiguous \`${TRY_PREFIX}\` AS CODE (ADR-0182 D13). The ` +
        'await must be the ONLY statement in the try, and the catch must close it immediately ' +
        '— a try that also wraps the build() call would route a synchronous build failure into ' +
        "the wrong arm (RT-01's own catch, three lines below, is the right one for that)",
    ).toBe(1);

    const CATCH_BODY =
      '{ ' + M21B2_STALE_RECHECK + ' state = onAttemptFailed(state); scheduleRebuild(); return; }';
    const catchBodyHits = codeOccurrences(region, CATCH_BODY);
    expect(
      catchBodyHits.length,
      'the catch block must be EXACTLY `' +
        CATCH_BODY +
        '` AS CODE — the stale re-check FIRST (addendum §C F7: a superseded attempt`s late ' +
        'rejection must not dirty the live attempt), then the SAME ADR-0085 backoff ladder ' +
        'every other failure path uses, then return. No bare `return;`, no `throw`, and no ' +
        'second retry path may precede the ladder calls',
    ).toBe(1);

    // The catch body must be THIS try's catch — i.e. only the catch BINDING (` ` or ` (err) `)
    // may sit between them. Anything longer means the two matched different statements.
    const tryEnd = tryPrefixHits[0]! + TRY_PREFIX.length;
    const catchStart = catchBodyHits[0]!;
    expect(
      catchStart,
      'the pinned catch body must FOLLOW the pinned try prefix — if it precedes it, the two ' +
        'needles matched different statements and this tooth is judging the wrong pair',
    ).toBeGreaterThan(tryEnd - 1);
    expect(
      catchStart - tryEnd,
      'only the catch BINDING may sit between the try prefix and the pinned catch body (0 ' +
        'characters for `catch {`, 7 for `catch (err) {`). A larger gap means the pinned ' +
        'catch body belongs to some OTHER try in attemptBuild, and the await`s own catch is ' +
        'unpinned',
    ).toBeLessThanOrEqual(10);

    // Exactly one await, and exactly two stale re-checks (D13: the catch's first statement,
    // and the one immediately after the await on the success path). Code-aware, so a decoy
    // string mentioning `await`/the re-check cannot inflate either count into a false pass.
    expect(
      countCodeOccurrences(region, 'await'),
      'attemptBuild must contain EXACTLY ONE `await` AS CODE — the resolveCredential call. ' +
        'Every additional await is another window for buildGen to advance without a re-check',
    ).toBe(1);
    expect(
      countCodeOccurrences(region, M21B2_STALE_RECHECK),
      `\`${M21B2_STALE_RECHECK}\` must occur EXACTLY twice AS CODE in attemptBuild (D13): once ` +
        'as the catch block`s first statement, and once immediately after the await on the ' +
        'success path. Dropping the second lets a superseded attempt build a connection and ' +
        'assign it to `current`, replacing the live one',
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-RETRY-CLIMBS-LADDER (G24 + addendum §C F5, AUTH-45) — an ambiguous
// transient outcome climbs the EXISTING backoff ladder and builds nothing.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-45, G24): W-M21B2-RETRY-CLIMBS-LADDER — the `retry` credential never reaches build()', () => {
  it('★ BITES: the `retry` branch is a unique anchor inside attemptBuild, contains the ladder pair AND a return, and sits BEFORE the build call', () => {
    // WRONG IMPL KILLED (a) ★ THE NAMED G24 MUTANT: the `return;` deleted, so a 'retry'
    //   credential FALLS THROUGH to `build(...)`. build()'s defensive belt returns
    //   `undefined` for that kind (D13), so `current` becomes undefined, the link is never
    //   frozen by any transition, and main.ts's `conn?.live()` guards silently suppress
    //   every action with no status-line explanation — a dead client that looks connected.
    // WRONG IMPL KILLED (b): the branch deleted entirely — 'retry' would reach build() as
    //   above. The unique anchor sees it.
    // WRONG IMPL KILLED (c): a branch that schedules its OWN retry (a bare `setTimeout`)
    //   instead of `scheduleRebuild()`. ADR-0085 A7's single-timer rule is what makes the
    //   double-schedule guard work; a second timer path re-opens the burst-reconnect bug.
    // WRONG IMPL KILLED (d): a branch that returns WITHOUT `state = onAttemptFailed(state)`
    //   — the backoff never advances, so a down auth service is retried at the 1s rung
    //   forever, and `consecutiveTransientErrors` climbs to the D17 threshold in seconds
    //   rather than over a sensible window.
    // WRONG IMPL KILLED (e) ★ THE DECOY-STRING BYPASS (coordinator review): the three ladder
    //   needles used to be `.includes`-checked INDEPENDENTLY, so ONE inert string literal
    //   containing all three — `const _x = 'state = onAttemptFailed(state); scheduleRebuild();
    //   return;';` — satisfied every one while the real branch did none of it and fell through
    //   to build(). Closed by pinning the WHOLE retry block as one exact contiguous statement,
    //   verified AS CODE (the KeyC-handler exact-block model the coordinator named): a decoy
    //   string's start sits inside a literal and codeOccurrences excludes it, and an exact
    //   block leaves no room for a dead `if (false)` wrapper or an early return either.
    const src = readConnectionTs();
    const region = attemptBuildRegion(src);

    const RETRY_ANCHOR = "if (credential.kind === 'retry') {";
    // Addendum §C F5: expectUniqueAnchor, not a bare indexOf — a duplicated branch would
    // let the ordering below bound against the wrong one. (Kept alongside the exact-block
    // check: uniqueness gives the correct diagnosis on its own if the anchor is doubled.)
    expectUniqueAnchor(region, RETRY_ANCHOR);

    // ★ EXACT CONTIGUOUS BLOCK (D13). The retry branch body is EXACTLY these three
    // statements; any comment inside strips to whitespace and squashes away, so a conforming
    // implementation collapses to precisely this. Verified AS CODE so no decoy string wins.
    expect(
      countCodeOccurrences(region, M21B2_RETRY_BLOCK),
      `attemptBuild must contain the retry branch EXACTLY as \`${M21B2_RETRY_BLOCK}\` — one ` +
        'contiguous executable block (AUTH-45: climb the SAME ADR-0085 ladder a socket-level ' +
        'connect failure uses, then STOP). Exact-block equality is what closes the three-decoy ' +
        'bypass a per-needle `.includes` could not; do NOT loosen it back to independent ' +
        'substring checks. RED AT AUTHORING TIME: attemptBuild does not exist. Region=' +
        JSON.stringify(region),
    ).toBe(1);

    // ORDERING: the branch must precede the build call, or its `return;` is decorative.
    // Both indices are code-aware, so a decoy string cannot shift either.
    const retryIdx = codeOccurrences(region, RETRY_ANCHOR)[0]!;
    const buildCall = codeOccurrences(region, '= build(');
    expect(
      buildCall.length,
      'ANTI-VACUITY: attemptBuild must contain the `= build(` call AS CODE — needle chosen over ' +
        'a bare `build(` because `scheduleRebuild(` contains that substring',
    ).toBeGreaterThanOrEqual(1);
    expect(
      retryIdx,
      'the `retry` branch must appear BEFORE the build call in attemptBuild — a branch placed ' +
        'after it has already let the ambiguous credential through',
    ).toBeLessThan(buildCall[0]!);
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-LIVE-IS-CURRENT (G26 + addendum §C F6, AUTH-46/47) — `live()` has ONE
// source of truth, and `current` has exactly three assignment sites.
//
// ★ NAMED RESIDUAL — READ BEFORE TRUSTING THIS TOOTH. ADR-0182 words G26 as
// "exercised across five enumerated states". THAT IS NOT ACHIEVABLE IN THIS REPO
// and this tooth does not claim it: connection.ts cannot be imported under vitest
// at all (DOM/wasm side effects at module scope; it is coverage-EXCLUDED at
// client/vite.config.ts:98 for exactly that reason), so NO test here can observe
// `live()` returning anything. What follows is the strongest MECHANICAL form
// available inside this slice's touches: the accessor has one body, the variable
// has an enumerated set of writers, and the one transition that can report a
// healthy link is region-bound to the callback that only fires on a live socket.
// The behavioural half — `linkFrozen(onConnected(s)) === false` and its two
// siblings over arbitrary states — lives in
// client/src/prediction/reconnectPolicy.test.ts (a real import of a pure module).
// Neither half is sufficient alone, and this comment exists so nobody reads the
// pair as more than it is.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-46/47, G26): W-M21B2-LIVE-IS-CURRENT — one accessor, three writers, and no unfrozen link without a connection', () => {
  it('★ BITES: live() returns `current` and nothing else; current is assigned at exactly 3 enumerated sites; state = onConnected(state) lives INSIDE .onApplied', () => {
    // WRONG IMPL KILLED (a): a `live()` that reconstructs or caches — e.g. `live: () =>
    //   current ?? build({ kind: 'anon', token: auth.tokenForNextAttempt() })`. That turns
    //   a read into a side effect, builds a second connection from a getter, and makes the
    //   "parked" terminals (session-expired / auth-service-unreachable) silently
    //   self-heal into an anonymous session the player never asked for — the exact
    //   opposite of AUTH-46/47, which require the tab to STOP and show a terminal.
    // WRONG IMPL KILLED (b): a SECOND `current = build(...)` outside attemptBuild (the most
    //   likely being a "fast path" left in scheduleRebuild's timer body, which D13 replaces
    //   with `void attemptBuild();`). Two builders means two connections racing for the
    //   same `current` slot with no shared generation discipline.
    // WRONG IMPL KILLED (c) — addendum §C F6, and why this is TWO separately-anchored
    //   needles rather than one count of 2: an aggregate `current = undefined;` count of 2
    //   is satisfied by putting BOTH in the session-expired branch and none in the
    //   auth-service-unreachable branch. The unreachable branch would then leave the
    //   previous (dead) connection in `current`, so `live()` hands main.ts a socket the
    //   ladder has given up on and every send silently fails against it.
    // WRONG IMPL KILLED (d): `state = onConnected(state)` hoisted out of `.onApplied` (say,
    //   into `.onConnect`). onConnect fires BEFORE the initial snapshot applies; the link
    //   would unfreeze with an empty store, and — worse for this slice — it is the only
    //   way `linkFrozen() === false` can be reached while `current === undefined`, which is
    //   the precise invariant `sendGuarded()` (main.ts:664, 20 call sites) relies on.
    const src = readConnectionTs();
    const wholeSquashed = squashWhitespace(stripLineComments(src));

    // --- the accessor -------------------------------------------------------------------
    // Contract: `live: () => current,` — the same arrow-property shape as its two siblings
    // in the SAME returned object literal (`identity: () => identity,` and
    // `linkFrozen: () => linkFrozen(state),`), so the accessor family stays one idiom.
    expect(
      // CODE-AWARE (coordinator review): the accessor is executable — a decoy string of the
      // same text must not satisfy the "one source of truth" pin.
      countCodeOccurrences(wholeSquashed, 'live: () => current,'),
      'the Connection object must expose `live: () => current,` EXACTLY once AS CODE — one ' +
        'source of truth, no caching, no reconstruction (ADR-0182 D13`s Connection interface). ' +
        'It mirrors the two sibling accessors in the same object literal',
    ).toBe(1);
    expect(
      countOccurrences(wholeSquashed, 'linkFrozen: () => linkFrozen(state),'),
      'CARRIED FORWARD UNCHANGED: `linkFrozen: () => linkFrozen(state),` must still occur ' +
        'exactly once — main.ts`s 20 sendGuarded call sites and its 10 live() sites both ' +
        'depend on this staying the one link-state accessor',
    ).toBe(1);

    // --- the writers --------------------------------------------------------------------
    expect(
      countOccurrences(wholeSquashed, M21B2_CURRENT_DECL),
      `\`${M21B2_CURRENT_DECL}\` must appear EXACTLY once — one declaration, at connect() ` +
        'scope, with the annotation that makes every main.ts consumer a compile error rather ' +
        'than a runtime surprise',
    ).toBe(1);
    expect(
      countCodeOccurrences(wholeSquashed, 'current = build('),
      '`current = build(` must occur EXACTLY once AS CODE — inside attemptBuild, under the ' +
        'generation guard. A second assignment site is a second, ungated builder',
    ).toBe(1);

    // ★ D13 (ADR-0182 line 220), G26 + coordinator review item 5: the sign-in-failed → anon
    // CONVERSION at that build call, pinned as the exact executable statement. A first-time
    // claim-flow sign-in whose exchange fails (`sign-in-failed`, AUTH-48) must still be handed
    // an ANON credential to build — never `credential` (whose token field is a reason string,
    // not a token) and never dropped with no connection at all, which would strand a
    // first-time claimant unable to connect or even reach the claim UI.
    // WRONG IMPL KILLED: `current = build(credential);` — the sign-in-failed branch falls
    // through (D13 keeps it in the build path) and build()'s defensive belt returns undefined
    // for that kind, so `current` is undefined and the tab is frozen. The exact conversion is
    // the only shape that reaches an anon connection on that path.
    expect(
      countCodeOccurrences(attemptBuildRegion(src), M21B2_SIGNIN_FALLTHROUGH_BUILD),
      'attemptBuild must build the sign-in-failed path as the exact conversion ' +
        `\`${M21B2_SIGNIN_FALLTHROUGH_BUILD}\` (ADR-0182 D13 line 220) — occurring EXACTLY ` +
        'once AS CODE. This IS the one `current = build(` call site, so it is consistent with ' +
        'the count above; pinning the full ternary is what stops an implementer from dropping ' +
        'the sign-in-failed→anon conversion and stranding a first-time claimant (AUTH-48)',
    ).toBe(1);
    // NOTE (deliberate deviation from the plan's §3 G26 row, which asks for "total identifier
    // occurrences pinned with a written breakdown"): the pin is on ASSIGNMENTS, not on the bare
    // `current` identifier. Reason, measured on the live file: `current` is a SUBSTRING of
    // `currentNodeId`, a real field in the locally-declared SdkConversationRow type
    // (connection.ts:340), so a bare-identifier total is a co-tenanted number that reds when an
    // unrelated conversation-row field is renamed — the recalibration treadmill this repo's
    // ceiling teeth exist to end. Writers are what matter for the `live()` invariant, and they
    // are fully enumerated here; readers are harmless.
    expect(
      countOccurrences(wholeSquashed, 'current ='),
      'the identifier `current` must be ASSIGNED at exactly 3 sites, and the breakdown is: ' +
        '(1) `current = build(...)` in attemptBuild; (2) `current = undefined;` in the ' +
        'session-expired terminal; (3) `current = undefined;` in the auth-service-unreachable ' +
        'terminal. (The declaration `let current: DbConnection | undefined;` carries no `=` ' +
        'and is counted separately above.) A 4th assignment is an unenumerated writer of the ' +
        'ONE slot every main.ts guard reads through',
    ).toBe(3);

    // Addendum §C F6: the two parking branches are pinned SEPARATELY and CONTIGUOUSLY, so
    // neither can borrow the other's `current = undefined;`. CODE-AWARE: each is an executable
    // block, so a decoy string of either cannot satisfy the ===1.
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_SESSION_EXPIRED_BRANCH),
      `the session-expired terminal must be the contiguous \`${M21B2_SESSION_EXPIRED_BRANCH}\` ` +
        'AS CODE (ADR-0182 D13) — notify, PARK the slot, and stop. Dropping `current = ' +
        'undefined;` leaves the dead connection live to every main.ts caller (AUTH-46)',
    ).toBe(1);
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_UNREACHABLE_BRANCH),
      `the auth-service-unreachable terminal must be the contiguous \`${M21B2_UNREACHABLE_BRANCH}\` ` +
        'AS CODE (ADR-0182 D13/D17) — same terminal shape as session-expired, distinct ' +
        'callback, distinct copy (AUTH-47)',
    ).toBe(1);
    expect(
      countCodeOccurrences(wholeSquashed, 'current = undefined;'),
      '`current = undefined;` must occur EXACTLY twice AS CODE — once in EACH of the two ' +
        'terminals pinned above. This count is deliberately asserted ALONGSIDE the two ' +
        'contiguous needles, not instead of them: the count alone is satisfied by putting both ' +
        'in one branch (addendum §C F6)',
    ).toBe(2);

    // --- the one transition that can report a healthy link (code-aware) -----------------
    expect(
      countCodeOccurrences(wholeSquashed, 'state = onConnected(state)'),
      'CARRIED FORWARD: `state = onConnected(state)` must occur exactly once AS CODE in ' +
        'connection.ts',
    ).toBe(1);
    const applied = onAppliedRegion(src);
    // ANTI-VACUITY, ASSERTED FIRST: the region really is the applied callback.
    expect(
      includesAsCode(applied, 'if (stale()) return;'),
      'ANTI-VACUITY: the .onApplied region must contain the stale guard AS CODE — if it does ' +
        'not, the region is mis-anchored and the membership assertion below is vacuous',
    ).toBe(true);
    expect(
      includesAsCode(applied, 'state = onConnected(state)'),
      'the ONE `state = onConnected(state)` transition must live INSIDE the .onApplied ' +
        'callback AS CODE — it is the only place a live socket AND an applied snapshot are ' +
        'both proven. Anywhere else, `linkFrozen()` can report false while `current` is ' +
        'undefined, and every sendGuarded()-protected action in main.ts fires into nothing',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-JOIN-GATE (G18 + addendum §C F2/F18, AUTH-52/53, D16) — the claim-code
// veto is read FRESH per applied snapshot and is the SOLE veto.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-52/53, G18): W-M21B2-JOIN-GATE — the claim-code veto is fresh, sole, and paired with a real re-issue', () => {
  it('★ BITES: the fused hasUnconsumed read lives INSIDE .onApplied, shouldJoin has exactly D16`s shape, and the reissue arm actually calls completeGuestClaim', () => {
    // THE BUG THIS EXISTS FOR (F2, re-opened twice in review): a guest mints a claim code,
    // then signs in on the SAME tab. The account-kind build's first `onApplied` fires
    // `joinGame`, the server creates a FRESH player row for the account identity, and
    // `complete_guest_claim` then fails guard 11 ("already has game data") — permanently.
    // The guest's progress is unreachable, and the failure is indistinguishable from a
    // typo'd code. The veto below is the only thing standing in front of it.
    //
    // WRONG IMPL KILLED (a) ★ NAMED: `|| store.ownAccount(identity) === undefined` appended
    //   to shouldJoin. It reads like defence-in-depth and is the F2 bug wearing a hat: the
    //   `my_account` row has NOT arrived on the first applied snapshot of a fresh account
    //   connection, so the OR is true, joinGame fires, and guard 11 trips. AUTH-52 is
    //   explicit that my_account presence/absence is NEVER consulted in the veto. Killed by
    //   the contiguous needle (which requires the `;` immediately after `!codeUnconsumed`).
    // WRONG IMPL KILLED (b) ★ NAMED (F2/F18): `claimCode.hasUnconsumed(...)` HOISTED to
    //   connect() or build() scope and cached. Across a reconnect the cached answer is
    //   stale in the dangerous direction — the code was consumed on the previous
    //   connection, the cache still says "outstanding", and the tab never re-joins at all.
    //   Killed by region membership: the FUSED statement must be inside .onApplied.
    // WRONG IMPL KILLED (c) ★ NAMED: the reissue arm reduced to a UI notification —
    //   `opts.onClaimPending?.(code);` with no reducer call. This is the defect the ADR's
    //   own completeness review caught in its FIRST draft: AUTH-53 mandates re-issuing
    //   complete_guest_claim on the first applied snapshot, unconditionally, because
    //   ADR-0085 D3 established that a pre-drop promise never settles. Without the reducer
    //   call the claim silently never completes and the UI shows "pending" forever.
    // WRONG IMPL KILLED (d): the reducer call made CONDITIONAL on the callback being
    //   supplied (`if (opts.onClaimPending) { …completeGuestClaim… }`) — production wires
    //   the callback, so this ships green and breaks only for embedders/tests. Killed by
    //   requiring both needles independently inside the same arm.
    const src = readConnectionTs();
    const wholeSquashed = squashWhitespace(stripLineComments(src));
    const applied = onAppliedRegion(src);

    // ANTI-VACUITY, ASSERTED FIRST: the region really is D16's applied callback.
    expect(
      applied.includes('if (stale()) return;'),
      'ANTI-VACUITY: the .onApplied region must contain the stale guard',
    ).toBe(true);

    // --- (a) the fused read, unique file-wide AND inside the region (code-aware) ---------
    // CODE-AWARE (coordinator review): both the fused read and the veto are executable
    // statements; a decoy string of either text must not satisfy the membership/count.
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_CODE_UNCONSUMED),
      `the fused read \`${M21B2_CODE_UNCONSUMED}\` must occur EXACTLY once AS CODE`,
    ).toBe(1);
    expect(
      includesAsCode(applied, M21B2_CODE_UNCONSUMED),
      `the fused read \`${M21B2_CODE_UNCONSUMED}\` must sit INSIDE the .onApplied callback AS ` +
        'CODE — read FRESH on every applied snapshot (D16 / addendum §C F2). A connect()- or ' +
        'build()-scope read caches an answer across reconnects and re-opens F2. The statement ' +
        'is pinned FUSED (declaration + call in one needle) because a bare ' +
        '`claimCode.hasUnconsumed(` needle cannot tell a fresh read from a cached one',
    ).toBe(true);
    expect(
      countCodeOccurrences(wholeSquashed, 'claimCode.hasUnconsumed('),
      'claimCode.hasUnconsumed( must be called from EXACTLY ONE site AS CODE — a second caller ' +
        'is a second answer, and the veto is only as good as its freshest reader',
    ).toBe(1);

    // --- (b) the veto itself (code-aware) -----------------------------------------------
    expect(
      countCodeOccurrences(wholeSquashed, M21B2_SHOULD_JOIN),
      `the join veto \`${M21B2_SHOULD_JOIN}\` must occur EXACTLY once AS CODE`,
    ).toBe(1);
    expect(
      includesAsCode(applied, M21B2_SHOULD_JOIN),
      `the join veto must be the contiguous \`${M21B2_SHOULD_JOIN}\`, INSIDE .onApplied AS CODE ` +
        '(D16). The claim code is the SOLE veto: anon-kind builds are never vetoed (their ' +
        'join is the idempotent "already joined" path AUTH-33 always allowed), and an ' +
        'account-kind build is vetoed exactly while a code is outstanding',
    ).toBe(true);
    // Belt and braces on (a): `ownAccount` must not appear in the veto STATEMENT itself.
    // The contiguous needle above already excludes an appended disjunct (it requires the `;`
    // immediately after `!codeUnconsumed`); this states the RULE separately so the failure
    // message names AUTH-52 rather than reporting a mismatched string.
    const shouldJoinIdx = applied.indexOf(M21B2_SHOULD_JOIN);
    const stmtEnd = applied.indexOf(';', shouldJoinIdx);
    expect(stmtEnd, 'the shouldJoin statement must terminate').toBeGreaterThan(shouldJoinIdx);
    expect(
      countOccurrences(applied.slice(shouldJoinIdx, stmtEnd + 1), 'ownAccount('),
      'the shouldJoin expression must NOT consult store.ownAccount( (AUTH-52 / D16 ' +
        "anti-pattern 4) — my_account's presence only chooses BETWEEN the reissue arm and " +
        'the awaiting-account UX arm; it is never an OR-branch in the veto',
    ).toBe(0);

    // --- (c) the join call is issued exactly once, from the extracted joiner (code-aware) -
    expect(
      countCodeOccurrences(applied, 'attemptJoin('),
      'the .onApplied callback must call attemptJoin( EXACTLY once AS CODE — the single ' +
        'guarded join path. attemptJoin may be DECLARED outside this region (D16 extracts it ' +
        'once to avoid double-wrapping the devLog Proxy); only the CALL is region-bound',
    ).toBe(1);

    // --- (d) the reissue arm does real work (code-aware) --------------------------------
    const REISSUE_ANCHOR = 'else if (store.ownAccount(identity) !== undefined) {';
    const AWAITING_ARM = 'opts.onClaimAwaitingAccount?.();';
    expectUniqueAnchor(applied, REISSUE_ANCHOR);
    expectUniqueAnchor(applied, AWAITING_ARM);
    const reissueArm = regionOrThrow(applied, REISSUE_ANCHOR, AWAITING_ARM);
    const reducerInArm = codeOccurrences(reissueArm, '.reducers.completeGuestClaim({ code })');
    const pendingInArm = codeOccurrences(reissueArm, 'opts.onClaimPending?.(');
    expect(
      reducerInArm.length,
      'the reissue arm must actually CALL the reducer — the contiguous ' +
        '`.reducers.completeGuestClaim({ code })` AS CODE (AUTH-53 / D16). A UI notification ' +
        'alone leaves the claim permanently unfinished, because a pre-drop promise never ' +
        'settles (ADR-0085 D3); a decoy string of the call text would satisfy a bare ' +
        '.includes while nothing is actually re-issued. Arm=' +
        JSON.stringify(reissueArm),
    ).toBeGreaterThanOrEqual(1);
    expect(
      pendingInArm.length,
      'the reissue arm must ALSO fire `opts.onClaimPending?.(` AS CODE — the UX notification ' +
        'is ALONGSIDE the reducer call, never a substitute for it (D16)',
    ).toBeGreaterThanOrEqual(1);
    // The notification must not GATE the reducer call: the reducer must be issued before
    // (and independently of) the optional callback. Indices are code-aware.
    expect(
      reducerInArm[0]!,
      'the reducer call must be issued BEFORE the onClaimPending notification — a reducer ' +
        'call written inside an `if (opts.onClaimPending)` block ships green in production ' +
        '(where the callback is always wired) and silently never claims anywhere else',
    ).toBeLessThan(pendingInArm[0]!);
  });
});

// ---------------------------------------------------------------------------
// W-M21B2-ACCOUNT-SUBSCRIBE / -INGEST (G28 + addendum §C F4, AUTH-50/51, D15) —
// mirrors the my_wallet gate above byte-for-byte, plus the tripwire correction.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b-2 / AUTH-50, G28): W-M21B2-ACCOUNT-SUBSCRIBE — my_account joins the ONE subscribe array', () => {
  it("★ BITES: the .subscribe([...]) array contains 'SELECT * FROM my_account' exactly once", () => {
    // Modelled on W-UX2B-SUBSCRIBE above, deliberately and byte-for-byte: same anchor, same
    // window, same anti-vacuity control, same ===1.
    // WRONG IMPL KILLED (a): shipping rowConvert's accountRowToStore, store.upsertAccount
    //   and both handlers and never subscribing the view — every other G28 needle passes
    //   while no row ever arrives, `store.ownAccount(identity)` is undefined forever, and
    //   AUTH-51's "sole authoritative signal" reports "not signed in" to a signed-in player.
    // WRONG IMPL KILLED (b): parking the string in a module-level const or a second,
    //   unreachable .subscribe() call — the WINDOW is what kills this (the precedent
    //   reasoning is evals/conversation-privacy.eval.mjs:394-420, Finding 5).
    // WRONG IMPL KILLED (c): subscribing it twice — the ===1, not a `toContain`.
    // WRONG IMPL KILLED (d): subscribing the PRIVATE `account` table instead of the
    //   owner-scoped `my_account` view. SpacetimeDB rejects the whole subscription BATCH,
    //   onApplied never fires, and EVERY player gets a blank world.
    const src = readConnectionTs();
    expectUniqueAnchor(src, '.subscribe([');
    const arrayBody = bodyRegion(src, '.subscribe([', ']);');

    // ANTI-VACUITY: prove the window really is the subscription array before judging it.
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_conversation'"),
      'the .subscribe([...]) window must still contain the my_conversation subscription — if ' +
        'it does not, this gate is judging the wrong region and every assertion is vacuous',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_account'"),
      "connection.ts's ONE .subscribe([...]) array must contain 'SELECT * FROM my_account' " +
        'exactly once (ADR-0182 D15). RED AT AUTHORING TIME: `my_account` appears in ' +
        'connection.ts only inside the M21b TRIPWIRE comment that says it is deliberately ' +
        'absent',
    ).toBe(1);

    // The PRIVATE table must never be named inside the array (windowed, comment-stripped —
    // the same soundness argument W-UX2B-SUBSCRIBE makes for player_wallet: the rewritten
    // tripwire comment legitimately names it, and comments are stripped here).
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM account'"),
      'the .subscribe([...]) array must NEVER name the PRIVATE `account` table — subscribing ' +
        'it errors the entire subscription batch, onApplied never fires, and EVERY player ' +
        'gets a blank world. Only the owner-scoped my_account view may be subscribed',
    ).toBe(0);
  });

  it('★ BITES (§0.1(E) tripwire rot): the RAW source no longer claims my_account is DELIBERATELY ABSENT', () => {
    // THE MIRROR-IMAGE OF W-UX2B-SUBSCRIBE's third test, and for the same reason. The M21b
    // tripwire at connection.ts:664-672 says, inside the subscription array a reviewer reads
    // to audit privacy, that `my_account` "is DELIBERATELY ABSENT … M21b-2 adds it". The
    // instant M21b-2 lands that sentence is FALSE, in a security-sensitive file, and the
    // next person auditing account privacy would be told by the file itself that no account
    // subscription exists.
    //
    // THIS IS ONE OF ONLY TWO ASSERTIONS IN THIS FILE THAT MUST RUN ON RAW SOURCE — a
    // comment-stripped scan is structurally incapable of seeing comment rot.
    const raw = readConnectionTs();

    // Anti-vacuity: we are scanning the file we think we are.
    expectUniqueAnchor(raw, '.subscribe([');

    expect(
      countOccurrences(raw, 'DELIBERATELY ABSENT'),
      'connection.ts must no longer contain the phrase "DELIBERATELY ABSENT" — that is the ' +
        'M21b tripwire (connection.ts:664-672) declaring my_account unsubscribed, and this ' +
        'slice subscribes it. RED AT AUTHORING TIME: the stale claim is still there',
    ).toBe(0);

    // WRONG IMPL KILLED: satisfying the assertion above by DELETING the comment outright.
    // D15 mandates a REPLACEMENT tripwire — the my_wallet/profile idiom (connection.ts:448,
    // :507), which deliberately NAMES the handler it is refusing to register so that the
    // next author who "completes the set" trips over the reason first. The exact phrase is
    // the CONTRACT for the implementer: the rewritten comment must contain
    // `no conn.db.my_account.onDelete`.
    //
    // This cannot be satisfied by real code: a genuine `conn.db.my_account.onDelete(`
    // handler reds the comment-stripped ===0 in the ingest tooth below.
    expect(
      countOccurrences(raw, 'no conn.db.my_account.onDelete') >= 1,
      'the rewritten comment must still record WHY there is no my_account delete handler — it ' +
        'must contain the phrase `no conn.db.my_account.onDelete` (D15: a view UPDATE arrives ' +
        'as onInsert(new) + onDelete(old), so any onDelete delivered is the STALE half of an ' +
        'update pair and would wipe the live account slot). Deleting the tripwire to satisfy ' +
        'the stale-phrase check throws away the reason in the file where getting it wrong ' +
        "silently signs the player out of their own account. Mirrors the my_wallet tripwire's " +
        'own idiom at connection.ts:448',
    ).toBe(true);
  });
});

describe('★ connection.ts wiring (M21b-2 / AUTH-50/51, G28): W-M21B2-ACCOUNT-INGEST — insert AND update, never delete', () => {
  it('★ BITES: both my_account ingest statements are exact and contiguous, upsertAccount has exactly 2 call sites, and NO onDelete handler exists', () => {
    // WHY BOTH onInsert AND onUpdate (unlike my_wallet's insert-only shape, D15): `status`
    // and `claimed_from` MUTATE after provisioning — a guest claim re-keys the account row
    // mid-session, and delete_account flips status to PendingDeletion. Wiring only onInsert
    // freezes `store.ownAccount(identity)` at its first snapshot, so the claim UI would show
    // "not claimed" forever immediately after a successful claim.
    //
    // WRONG IMPL KILLED (a): the RAW SDK row handed to the store —
    //   `store.upsertAccount(row as unknown as StoreAccount)`. The identity stays an SDK
    //   Identity OBJECT, so store.ownAccount's `===` own-identity filter never matches and
    //   the player is treated as anonymous forever while the row sits in the store.
    // WRONG IMPL KILLED (b): omitting `batcher.schedule()` on either handler — the row lands
    //   and nothing re-renders until some unrelated batch flushes. On the UPDATE handler
    //   this is the claim-completion repaint, i.e. the one frame the whole claim flow exists
    //   to produce.
    // WRONG IMPL KILLED (c): a CONDITIONAL upsert (`if (store.ownAccount(identity) ===
    //   undefined) { … }`) — compiles, reads like a plausible "insert-wins", and freezes the
    //   account slot at its first value. A contiguous needle admits no `if` / `?:` / `&&`.
    // WRONG IMPL KILLED (d) ★ NAMED (D15): wiring `onDelete`. Through a VIEW an update
    //   arrives as unordered onInsert(new) + onDelete(old), so the delete half wipes the row
    //   the insert half just wrote — and account rows are NEVER truly deleted server-side
    //   (delete_account only flips status), so the handler is dead as well as wrong.
    // WRONG IMPL KILLED (e): registering either handler twice — double schedule per row.
    // ALL FOUR pins below are CODE-AWARE (coordinator review): the ingest statements, the
    // upsert call and the onDelete ban are executable code, so a decoy string of any of them
    // cannot satisfy (or, for the ban, evade) the count.
    const squashed = squashedStrippedConnectionTs();

    expect(
      countCodeOccurrences(squashed, M21B2_ACCOUNT_INSERT_INGEST),
      'connection.ts must contain EXACTLY this statement, exactly once AS CODE (ADR-0182 D15 / ' +
        'addendum §C F4):\n  ' +
        M21B2_ACCOUNT_INSERT_INGEST +
        '\nIt is modelled on UX2B_WALLET_INGEST byte-for-byte, and the calibration fixture ' +
        'W-UX2B-SCAN-SOUND above proves this needle FORM is achievable. If the implementation ' +
        'is present but this reds, compare CHARACTER BY CHARACTER — the needle pins the table, ' +
        'the handler kind, the callback signature, the conversion, the cast target, the store ' +
        'call, the re-render kick AND their order, because each omitted separately is a real ' +
        'shipped-and-broken outcome. Do NOT loosen it; correct the code, or re-derive it from D15',
    ).toBe(1);
    expect(
      countCodeOccurrences(squashed, M21B2_ACCOUNT_UPDATE_INGEST),
      'connection.ts must contain EXACTLY this statement, exactly once AS CODE (ADR-0182 D15):\n  ' +
        M21B2_ACCOUNT_UPDATE_INGEST +
        '\nNote the THREE-parameter callback `(_ctx, _old, row)` — an onUpdate handler written ' +
        'with the two-parameter onInsert signature reads the OLD row as the new one and ' +
        'writes the pre-claim state back into the store on every claim completion',
    ).toBe(1);

    expect(
      countCodeOccurrences(squashed, 'store.upsertAccount('),
      'store.upsertAccount( must be called from EXACTLY 2 sites AS CODE in connection.ts, and ' +
        'the breakdown is: (1) the my_account onInsert handler; (2) the my_account onUpdate ' +
        'handler. A third call site is a fabricated/default account row — the same ' +
        'invented-from-dark failure ADR-0154 D1/D6 refused for the wallet, and here it would ' +
        'make an anonymous tab render as signed in',
    ).toBe(2);

    expect(
      countCodeOccurrences(squashed, 'conn.db.my_account.onDelete'),
      'there must be NO conn.db.my_account.onDelete handler AS CODE (ADR-0182 D15): a view ' +
        'UPDATE arrives as unordered insert+delete, so the delete half of a claim-completion ' +
        'pair would wipe the live account row and sign the player out of an account they still ' +
        'have. No server path ever deletes an account row, so the handler is dead as well as ' +
        'wrong. (Code-aware so the rewritten tripwire COMMENT — which names this handler in ' +
        'prose — cannot trip it; comments are already stripped, and a decoy string cannot ' +
        'satisfy it either)',
    ).toBe(0);
    expect(
      countOccurrences(squashed, 'removeAccount'),
      'connection.ts must call no account-removal API — store.reset() on disconnect is the ' +
        'ONLY path that may clear the account slot (mirroring the wallet rule at ' +
        'store.ts:981-988)',
    ).toBe(0);
  });
});

// ===========================================================================
// M21b-2 UI ENTRY POINTS (ADR-0182 D16/D17) — W-M21B2-ENTRY-POINTS.
//
// TWO reviews found the claim/sign-in flow was fully built (the pure models, the OIDC
// client, the claim-code storage) but NOT reachable: the `Connection` surface had no
// method for the UI to CALL to start a sign-in or to retry a parked connection, so
// main.ts's `conn?.startSignIn()` / `conn?.reconnectNow()` sites pointed at methods that
// did not exist. This block pins the two new entry points onto the Connection surface and
// requires each to do REAL work — not a stub that satisfies the type but silently no-ops.
//
// RED UNTIL connection.ts LANDS: `startSignIn`, `reconnectNow`, `claimCode.mint` and
// `oidc.beginSignIn` all occur ZERO times in connection.ts today, so every tooth below
// reds on a missing implementation (most by THROWING out of the region helpers — a hard
// red, never a vacuous pass).
//
// WHY SOURCE SCAN AND NOT BEHAVIOUR — unchanged from this file's header: connection.ts is
// coverage-EXCLUDED (it touches DOM/wasm on import), so it cannot be imported under vitest.
// The behaviour of `claimCode.mint` / `oidc.beginSignIn` is proven in their own pure-module
// suites; this block proves ONLY that startSignIn/reconnectNow call them, in the right place.
//
// CODE-AWARE THROUGHOUT (the M21b-2 hardening this file already applies): every needle that
// pins "the code does X" uses codeOccurrences/includesAsCode so an inert decoy string cannot
// satisfy it. NO `new RegExp`; NO `://` — this file's standing conventions.
// ===========================================================================

/** The BODY between an opening brace at `openIdx` and its MATCHING closing brace, string- and
 *  template-literal-aware (a `}` inside a literal never closes the body early). `code` must be
 *  comment-stripped. Throws loud on an unbalanced brace — a hard red, never a vacuous pass. */
function braceBodyAt(code: string, openIdx: number): string {
  let depth = 0;
  let mode = 0; // 0 code, 1 single, 2 double, 3 template
  for (let i = openIdx; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (mode === 0) {
      if (ch === "'") mode = 1;
      else if (ch === '"') mode = 2;
      else if (ch === '`') mode = 3;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return code.slice(openIdx + 1, i);
      }
    } else {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      const closer = mode === 1 ? "'" : mode === 2 ? '"' : '`';
      if (ch === closer) mode = 0;
      else if (mode !== 3 && ch === '\n') mode = 0; // unterminated '…'/"…": bail to code
    }
  }
  throw new Error('unbalanced braces in connection.ts — refusing to scan a runaway region');
}

/** The body of a construct whose declaration `declNeedle` (ending in `{`) occurs EXACTLY once
 *  AS CODE — the code-occurrence index is used (never a bare indexOf), so a decoy string cannot
 *  shift where the body is sliced. */
function uniqueCodeBraceBody(squashed: string, declNeedle: string): string {
  const hits = codeOccurrences(squashed, declNeedle);
  if (hits.length !== 1) {
    throw new Error(
      `\`${declNeedle}\` must occur EXACTLY once AS CODE in connection.ts (found ${hits.length}) — ` +
        'M21b-2 UI entry point. RED until connection.ts gains it',
    );
  }
  const start = hits[0]!;
  return braceBodyAt(squashed, start + declNeedle.length - 1); // declNeedle ends with '{'
}

/** The body of a newly-added Connection method, robust to the three shapes the specialist may
 *  legitimately write it in: a top-level `function name(): void {` declaration (the codebase
 *  idiom — cf. `function continueAnonymously(): void {`), an inline object arrow `name: () => {`,
 *  or an object method `name(): void {`. Most-specific first; the first shape that resolves to
 *  exactly one CODE occurrence wins. Throws loud if none does. */
function newMethodBody(squashed: string, name: string): string {
  for (const decl of [`function ${name}(): void {`, `${name}: () => {`, `${name}(): void {`]) {
    if (codeOccurrences(squashed, decl).length === 1) return uniqueCodeBraceBody(squashed, decl);
  }
  throw new Error(
    `connection.ts must declare a UNIQUE body for \`${name}\` in one of the sanctioned shapes ` +
      `(function ${name}(): void { … } | ${name}: () => { … } | ${name}(): void { … }) — M21b-2 ` +
      'UI entry point. RED until connection.ts gains it',
  );
}

/** The BODY of the returned Connection object literal — the `return { get conn() { … } … };` at the
 *  tail of connect() — string-aware. Anchored on the UNIQUE `return { get conn() {` opener (the
 *  only `return {` followed by the getter; resolveCredential`s `return { kind: 'anon', … }` is not),
 *  so it can never bind to the wrong `return {`. The object`s own `{` is exactly `'return '.length`
 *  past the anchor start, and braceBodyAt walks past the nested getter braces. Scanning THIS region
 *  is shorthand-accepting: the object lists `continueAnonymously,` / `startSignIn,` (shorthand,
 *  which biome enforces here) OR the `key: () => …` form — either way the identifier appears in the
 *  region, while a method that is interface-only (never added to the object) is absent and reds. */
function returnedConnectionObject(squashed: string): string {
  const anchor = 'return { get conn() {';
  const hits = codeOccurrences(squashed, anchor);
  if (hits.length !== 1) {
    throw new Error(
      `connection.ts must contain exactly one \`${anchor}\` (the returned Connection object) — ` +
        `found ${hits.length}. If the getter was renamed, re-derive this anchor from the object`,
    );
  }
  return braceBodyAt(squashed, hits[0]! + 'return '.length); // the object`s own opening `{`
}

describe('★ connection.ts wiring (M21b-2 UI entry point): W-M21B2-ENTRY-POINTS — startSignIn/reconnectNow exist and do real work', () => {
  it('★ BITES: both methods are on the Connection INTERFACE and in the returned Connection object', () => {
    // WRONG IMPL KILLED: a method declared on the interface but never added to the returned
    //   object literal — main.ts's `conn?.startSignIn()` becomes a call to `undefined` at
    //   runtime; and the mirror (in the object but not the interface) fails to typecheck main.ts.
    const src = readConnectionTs();
    const squashed = squashWhitespace(stripLineComments(src));

    // The interface region, sliced by its matching brace (string-aware) so a stray `Connection`
    // mention elsewhere cannot masquerade as the interface body.
    const iface = uniqueCodeBraceBody(squashed, 'export interface Connection {');
    // ANTI-VACUITY: the region really is the Connection interface (its existing methods survive).
    expect(
      iface.includes('continueAnonymously(): void;'),
      'ANTI-VACUITY: the Connection interface body must still declare continueAnonymously(): void; ' +
        '— if it does not, this scan is judging the wrong region',
    ).toBe(true);
    expect(
      iface.includes('startSignIn(): void;'),
      'the Connection interface must declare `startSignIn(): void;` (ADR-0182 D17/AUTH-48) — the ' +
        'method the claim UI`s onSignIn calls. RED until connection.ts gains it',
    ).toBe(true);
    expect(
      iface.includes('reconnectNow(): void;'),
      'the Connection interface must declare `reconnectNow(): void;` (ADR-0182 D17) — the method ' +
        'the session overlay`s retry calls. RED until connection.ts gains it',
    ).toBe(true);

    // The returned object literal must WIRE both methods — otherwise `conn?.startSignIn()` in
    // main.ts calls `undefined` at runtime. Scanned in the returned-object REGION (not file-wide)
    // and shorthand-accepting: the impl uses `startSignIn,` / `reconnectNow,` shorthand, exactly
    // like the sibling `continueAnonymously,` in the same object (biome ENFORCES shorthand here).
    // Scoping to the object region is what keeps the BAD fixture biting: a method declared on the
    // interface but NEVER added to the returned object is absent from THIS region → red.
    const objectBody = returnedConnectionObject(squashed);
    // ANTI-VACUITY: this really is the returned object literal (its existing shorthand member,
    // continueAnonymously, survives) — proving we are scanning the object, not the interface.
    expect(
      includesAsCode(objectBody, 'continueAnonymously'),
      'ANTI-VACUITY: the returned Connection object must still list `continueAnonymously` — if it ' +
        'does not, this scan is judging the wrong region (interface, or a mis-bound brace)',
    ).toBe(true);
    expect(
      includesAsCode(objectBody, 'startSignIn'),
      'the returned Connection object must wire `startSignIn` (shorthand or `startSignIn: …`) — a ' +
        'method declared on the interface but not added to the object makes `conn?.startSignIn()` a ' +
        'call to undefined at runtime. RED until connection.ts gains it',
    ).toBe(true);
    expect(
      includesAsCode(objectBody, 'reconnectNow'),
      'the returned Connection object must wire `reconnectNow` (shorthand or `reconnectNow: …`) — ' +
        'an interface-only method makes `conn?.reconnectNow()` a call to undefined at runtime',
    ).toBe(true);
  });

  it('★★ BITES: startSignIn MINTS a claim code AND begins the OIDC redirect, navigates to result.authorizationUrl, and reports failures', () => {
    // THE BUG THIS EXISTS FOR: a sign-in entry point that satisfies the type but silently does
    // half the job. Both halves are load-bearing and each omitted alone is a distinct shipped-
    // and-broken outcome, so the calls are pinned INSIDE startSignIn`s own brace-body (not
    // file-wide), and each is required independently.
    const src = readConnectionTs();
    const squashed = squashWhitespace(stripLineComments(src));
    const body = newMethodBody(squashed, 'startSignIn');

    // WRONG IMPL KILLED (a): REDIRECTS but never MINTS — the guest claim code is never created,
    //   so after the OIDC round-trip there is nothing for the account to complete and the guest`s
    //   progress is stranded behind a claim that can never be made.
    expect(
      includesAsCode(body, 'claimCode.mint('),
      'startSignIn must MINT the guest claim code — `claimCode.mint(…)` inside its body (a stub ' +
        'that redirects but never mints strands the guest`s progress)',
    ).toBe(true);
    // WRONG IMPL KILLED (b): MINTS but never REDIRECTS — the Sign-in button appears to do nothing;
    //   the player is never sent to the identity provider.
    expect(
      includesAsCode(body, 'oidc.beginSignIn('),
      'startSignIn must BEGIN the OIDC sign-in — `oidc.beginSignIn(…)` inside its body (a stub ' +
        'that mints but never redirects leaves the button inert)',
    ).toBe(true);
    // WRONG IMPL KILLED (c): navigating to a hardcoded/wrong URL, or not navigating at all. The
    //   authorization URL the flow just produced must be the navigation target.
    expect(
      body.indexOf('location'),
      'startSignIn must navigate the tab via `location` (the redirect leg of the OIDC flow)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      includesAsCode(body, '.assign(result.authorizationUrl'),
      'startSignIn must navigate to `result.authorizationUrl` via location…assign(…) — the exact ' +
        'authorization URL beginSignIn computed, not a placeholder',
    ).toBe(true);
    // WRONG IMPL KILLED (d): a sign-in whose failure is silently swallowed — the first-time
    //   claimant sees a spinner forever. The error path must route to opts.onSignInFailed
    //   (AUTH-48). Region-bound because attemptBuild ALSO calls opts.onSignInFailed?.( (the D13
    //   fall-through at connection.ts:833), so a file-wide presence check would pass vacuously.
    expect(
      includesAsCode(body, 'opts.onSignInFailed?.('),
      'startSignIn`s error path must call `opts.onSignInFailed?.(…)` (AUTH-48) — a failed first ' +
        'sign-in routes to claimModel, it is never dropped',
    ).toBe(true);

    // The two brand-new calls exist ONLY in startSignIn (a second site is a second, un-guarded
    // sign-in path).
    expect(
      countCodeOccurrences(squashed, 'claimCode.mint('),
      'claimCode.mint( must be called from EXACTLY one site AS CODE in connection.ts',
    ).toBe(1);
    expect(
      countCodeOccurrences(squashed, 'oidc.beginSignIn('),
      'oidc.beginSignIn( must be called from EXACTLY one site AS CODE in connection.ts',
    ).toBe(1);
  });

  it('★★ BITES: reconnectNow kicks a fresh attempt via `void attemptBuild();`, and attemptBuild now has EXACTLY four callers', () => {
    const src = readConnectionTs();
    const squashed = squashWhitespace(stripLineComments(src));
    const body = newMethodBody(squashed, 'reconnectNow');

    // WRONG IMPL KILLED (a): a reconnectNow that does nothing (or only resets a flag). The
    //   session-expired / auth-service-unreachable terminals PARK `current = undefined` with NO
    //   scheduled rebuild (ADR-0182 D13, pinned by G26), so a retry that never re-enters the
    //   ladder leaves the tab permanently dead after the player asks to reconnect. The check is
    //   bound to reconnectNow`s OWN brace-body, so the cold-start `void attemptBuild();` (a
    //   separate statement blocks away) cannot satisfy it vacuously.
    expect(
      includesAsCode(body, 'void attemptBuild();'),
      'reconnectNow must call `void attemptBuild();` — the one total reconnect entry point (D13). ' +
        'RED until connection.ts gains it',
    ).toBe(true);

    // WRONG IMPL KILLED (b): the retry wired to a NEW ad-hoc rebuild path instead of the single
    //   total entry point. `void attemptBuild();` was 3× before this slice — scheduleRebuild`s
    //   timer body, continueAnonymously, and the cold start — and reconnectNow is the 4th and
    //   last sanctioned caller. A 5th is a competing builder with no shared generation
    //   discipline; a 3 means reconnectNow is not routing through attemptBuild at all.
    expect(
      countCodeOccurrences(squashed, 'void attemptBuild();'),
      '`void attemptBuild();` must occur EXACTLY 4 times AS CODE in connection.ts: scheduleRebuild`s ' +
        'timer body, continueAnonymously, the cold start, and reconnectNow (M21b-2 UI entry point). ' +
        'If this reds at 3, reconnectNow is not routing through attemptBuild; re-derive from the ' +
        'four sites, never raise the number to absorb a stray call',
    ).toBe(4);
  });
});

// ===========================================================================
// 13r-e (ADR-0194 D4) — W-13RE-MONSTER-VIEW: the my_monster_pub wiring.
//
// SOURCE OF TRUTH: docs/adr/0194-monster-pub-need-to-know-privacy.md D4.
//
// WHAT CHANGED. `monster_pub` becomes PRIVATE and the client subscribes the
// owner-scoped `my_monster_pub` VIEW instead. A view has NO primary key in
// 1.12.0 bindings, so the SDK never fires onUpdate: every row change arrives as
// unordered `onInsert(new)` + `onDelete(old)` inside one transaction burst.
//
// WHY THE STORE IS RECONCILED FROM THE SDK CACHE RATHER THAN FROM THE EVENTS.
// Neither in-tree precedent is safe at this churn:
//   * `my_wallet`'s insert-only wiring (no onDelete at all) would STRAND a
//     traded-away monster in the box forever;
//   * `my_conversation`'s pairwise content-match delete gate
//     (shouldRemoveOnViewDelete) has a documented coalescing-wipe failure — with
//     a burst coalesced across transactions the delete half removes the row the
//     insert half just wrote.
// So the batcher's FLUSH closure rebuilds membership from
// `conn.db.my_monster_pub.iter()` — the SDK's post-burst row set, which is
// value-precise and authoritative — and the row handlers only SCHEDULE. That
// makes ordering irrelevant by construction.
//
// RED AT AUTHORING TIME (verified against connection.ts this session):
//   * `conn.db.my_monster_pub` appears NOWHERE; `conn.db.monster_pub.onInsert /
//     onUpdate / onDelete` are still wired at :289-296 through `ingestMonster`;
//   * the batcher is `new MicrotaskBatcher(() => store.flushBatch());` (:141),
//     with no reconcile of any kind;
//   * `store.reconcileMonstersFromView(` does not exist in the client at all.
// Every gate below therefore reds on a MISSING IMPLEMENTATION, not on a typo.
//
// CODE-AWARE THROUGHOUT: every needle uses codeOccurrences/includesAsCode, so a
// decoy string (or the sanctioned explanatory comment, already stripped) can
// neither satisfy a positive nor evade a ban.
// ===========================================================================

/** The argument text of `needle(` … `)`, paren-walked from the needle's own open
 *  paren. Throws loud when the needle is absent or unbalanced — a hard red, never
 *  a vacuous pass. `code` must be comment-stripped. */
function parenArgsAt(code: string, needle: string): string {
  const at = code.indexOf(needle);
  if (at < 0) {
    throw new Error(`connection.ts must contain "${needle}" (13r-e region start)`);
  }
  const open = at + needle.length - 1;
  if (code.charAt(open) !== '(') {
    throw new Error(`"${needle}" must end at its own opening paren (13r-e region)`);
  }
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced parens after "${needle}" — refusing to scan a runaway region`);
}

describe('★ connection.ts wiring (13r-e / ADR-0194 D4): W-13RE-SUBSCRIBE — the private table is gone, the view is subscribed', () => {
  it('★ BITES: the ONE .subscribe([...]) array contains the view exactly once and never names monster_pub', () => {
    // WRONG IMPL KILLED (a): subscribing the now-PRIVATE `monster_pub` table.
    //   SpacetimeDB rejects the whole subscription BATCH, `onApplied` never fires,
    //   and EVERY player gets a blank world — not a missing box screen (the T0
    //   rollout probe recorded in ADR-0087, re-confirmed by ADR-0194's live probe).
    // WRONG IMPL KILLED (b): adding the view subscription and leaving the old table
    //   string behind (same blank world).
    // WRONG IMPL KILLED (c): parking the view SQL in a dead module constant — the
    //   WINDOW is what kills that.
    const src = readConnectionTs();
    expectUniqueAnchor(src, '.subscribe([');
    const arrayBody = bodyRegion(src, '.subscribe([', ']);');

    // Anti-vacuity: a sibling owner-scoped VIEW subscription proves the region
    // resolved and that comment-stripping did not eat the array's contents.
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_conversation'"),
      'the .subscribe([...]) window must still contain the my_conversation subscription — if ' +
        'it does not, this gate is judging the wrong region and every assertion below is vacuous',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM my_monster_pub'"),
      "connection.ts's ONE .subscribe([...]) array must contain 'SELECT * FROM my_monster_pub' " +
        'exactly once (ADR-0194 D4). The name is EXACT: a wrong view name errors the WHOLE ' +
        'subscription batch and onApplied never fires — every player gets a blank world, not ' +
        'just an empty box screen. RED AT AUTHORING TIME: my_monster_pub appears nowhere',
    ).toBe(1);

    expect(
      countOccurrences(arrayBody, "'SELECT * FROM monster_pub'"),
      "the .subscribe([...]) array must NOT contain 'SELECT * FROM monster_pub' — the table is " +
        'PRIVATE since ADR-0194, and subscribing a private table errors the entire batch',
    ).toBe(0);
  });
});

describe('★ connection.ts wiring (13r-e / ADR-0194 D4): W-13RE-INGEST — my_monster_pub is insert+delete, NEVER update', () => {
  it('★ BITES: onInsert AND onDelete are each registered exactly once on conn.db.my_monster_pub, and the old monster_pub table wiring is gone', () => {
    // WHY BOTH HANDLERS (unlike my_wallet's insert-only shape): a monster row LEAVES
    //   the view when it is traded away, evolves out of the owner's roster, or the
    //   owner disconnects. With no onDelete the batcher is never scheduled for that
    //   burst, so the reconcile below never runs and the stale row stays on screen.
    // WRONG IMPL KILLED: leaving `conn.db.monster_pub.*` wired. The generated
    //   binding for a private table no longer exists, so this is also a tsc error —
    //   but stating it here means a future slice that re-publishes the table cannot
    //   quietly re-wire the direct handlers.
    const squashed = squashedStrippedConnectionTs();

    expect(
      countCodeOccurrences(squashed, 'conn.db.my_monster_pub.onInsert('),
      'conn.db.my_monster_pub.onInsert( must be registered EXACTLY once AS CODE (ADR-0194 D4). ' +
        'RED AT AUTHORING TIME: conn.db.my_monster_pub appears nowhere in connection.ts',
    ).toBe(1);

    expect(
      countCodeOccurrences(squashed, 'conn.db.my_monster_pub.onDelete('),
      'conn.db.my_monster_pub.onDelete( must be registered EXACTLY once AS CODE. Unlike ' +
        'my_wallet (whose rows are never deleted server-side), a monster row LEAVES this ' +
        'view on every trade/transfer — insert-only wiring strands it in the client forever',
    ).toBe(1);

    expect(
      countCodeOccurrences(squashed, 'conn.db.monster_pub.'),
      'the OLD direct handlers on the private table (conn.db.monster_pub.onInsert/onUpdate/' +
        'onDelete, connection.ts:289-296) must be GONE — monster_pub emits no client binding ' +
        'once it is private',
    ).toBe(0);
  });

  it('★ BITES (tripwire): NO conn.db.my_monster_pub.onUpdate handler exists anywhere in the file', () => {
    // WRONG IMPL KILLED — and it is the single most likely mistake here, because the
    // handler being replaced (conn.db.monster_pub, :289-296) HAS an onUpdate and a
    // copy-paste keeps it: a view has no primary key in 1.12.0 bindings, so the SDK
    // has nothing to correlate old and new rows with and onUpdate NEVER FIRES. Wiring
    // one is dead code that implies a delivery guarantee the transport does not make —
    // and, worse, it invites the author to reason about updates as ordered events when
    // the whole reconcile design exists because they are not.
    //
    // SCOPED to my_monster_pub on purpose: `conn.db.my_account.onUpdate` at
    // connection.ts:580-583 is LEGITIMATE and mandated by ADR-0182 D15 (status and
    // claimed_from mutate after provisioning). A blanket "no view onUpdate" ban would
    // red on correct, shipped code — and the natural "fix" would be deleting the
    // account-claim repaint. The anti-vacuity assertion below pins exactly that.
    const squashed = squashedStrippedConnectionTs();

    // Anti-vacuity #1: the ingest must exist before "no update handler" means anything.
    expect(
      countCodeOccurrences(squashed, 'conn.db.my_monster_pub.onInsert('),
      'precondition: the my_monster_pub insert handler must exist before the onUpdate ban ' +
        'means anything. RED AT AUTHORING TIME',
    ).toBe(1);

    // Anti-vacuity #2: the needle SHAPE demonstrably matches a real, shipped
    // registration — so a zero below is a genuine absence, not a blind scan.
    expect(
      countCodeOccurrences(squashed, 'conn.db.my_account.onUpdate('),
      'the sanctioned my_account onUpdate handler (ADR-0182 D15) must still be wired — it is ' +
        'this gate calibration: it proves a `conn.db.<view>.onUpdate(` needle CAN match, so ' +
        'the zero asserted next is a real absence rather than a broken scan. Do NOT delete ' +
        'the account handler to make anything green',
    ).toBe(1);

    expect(
      countCodeOccurrences(squashed, 'conn.db.my_monster_pub.onUpdate'),
      'there must be NO conn.db.my_monster_pub.onUpdate handler (ADR-0194 D4): the view has no ' +
        'primary key in 1.12.0 bindings, so the SDK never fires onUpdate — every change arrives ' +
        'as unordered onInsert(new) + onDelete(old). A copy-pasted onUpdate (the replaced ' +
        'monster_pub wiring at :289-296 had one) is dead code that misrepresents the transport',
    ).toBe(0);
  });
});

describe('★ connection.ts wiring (13r-e / ADR-0194 D4): W-13RE-RECONCILE — the flush closure reconciles from the SDK cache BEFORE flushBatch', () => {
  it('★★ BITES: the MicrotaskBatcher flush closure reads the view cache, converts via monsterPubRowToStore, and reconciles BEFORE store.flushBatch()', () => {
    // THE ORDER IS THE POINT. `store.flushBatch()` is what notifies every listener
    // (the render loop reads the store on that signal). Reconciling AFTER it means the
    // frame that just rendered used the PRE-burst roster and nothing re-renders until
    // some unrelated table flushes — a traded-away monster stays on screen, and a
    // received one is invisible, for an unbounded time. No e2e in this slice can see
    // that (the NPC wander tick re-renders every ~200 ms and the run self-heals), which
    // is exactly why this source pin is load-bearing.
    //
    // WRONG IMPL KILLED (a): reconciling inside the ROW HANDLERS instead of the flush
    //   closure. That is per-row reconciliation against a mid-burst SDK cache — the
    //   ordering-dependence the whole design exists to avoid, and it re-introduces the
    //   my_conversation coalescing wipe. The region bound (the batcher's own call
    //   arguments) is what kills it.
    // WRONG IMPL KILLED (b): reconciling from the row EVENTS (id-set arithmetic over
    //   inserts and deletes) rather than from the SDK's post-burst row set. The
    //   `my_monster_pub.iter()` needle is what kills it.
    // WRONG IMPL KILLED (c): handing the store RAW SDK rows —
    //   `store.reconcileMonstersFromView([...conn.db.my_monster_pub.iter()])`. The
    //   ownerIdentity would stay an SDK Identity OBJECT, so ownMonsters' `===` filter
    //   never matches and the box screen renders empty while the rows sit in the store.
    //   The `monsterPubRowToStore` needle is what kills it.
    const squashed = squashedStrippedConnectionTs();

    // Region = the batcher construction's OWN argument list (paren-walked). Throws
    // loud if the anchor is missing, so a deleted batcher is a hard red.
    expectUniqueAnchor(squashed, 'new MicrotaskBatcher(');
    const flushClosure = parenArgsAt(squashed, 'new MicrotaskBatcher(');

    const reconcileIdx = flushClosure.indexOf('store.reconcileMonstersFromView(');
    const flushIdx = flushClosure.indexOf('store.flushBatch()');

    expect(
      reconcileIdx,
      'the MicrotaskBatcher flush closure must call `store.reconcileMonstersFromView(…)` ' +
        '(ADR-0194 D4). RED AT AUTHORING TIME: the batcher is ' +
        '`new MicrotaskBatcher(() => store.flushBatch());` with no reconcile at all',
    ).toBeGreaterThanOrEqual(0);
    expect(
      flushIdx,
      'the MicrotaskBatcher flush closure must still call `store.flushBatch()` — if this ' +
        'anchor is gone the whole per-transaction reconcile signal is gone with it',
    ).toBeGreaterThanOrEqual(0);
    expect(
      reconcileIdx,
      'the monster reconcile must run BEFORE store.flushBatch() inside the flush closure ' +
        '(ADR-0194 D4). flushBatch() is what notifies the render loop; reconciling after it ' +
        'means the frame that just rendered used the PRE-burst roster',
    ).toBeLessThan(flushIdx);

    expect(
      includesAsCode(flushClosure, 'my_monster_pub.iter()'),
      "the flush closure must rebuild membership from the SDK's own post-burst row set — " +
        '`[...conn.db.my_monster_pub.iter()]`. Reconstructing it from the insert/delete ' +
        'EVENTS is id-set arithmetic over an unordered burst, which is the ordering ' +
        'dependence this design exists to remove (ADR-0194 D4)',
    ).toBe(true);
    expect(
      includesAsCode(flushClosure, 'monsterPubRowToStore'),
      'the flush closure must map the SDK rows through `monsterPubRowToStore` — a raw SDK row ' +
        'keeps ownerIdentity as an Identity OBJECT, so store.ownMonsters(identity) never ' +
        'matches and the box screen renders empty while the rows sit in the store',
    ).toBe(true);

    // Exactly one reconcile call site in the whole file: a second one is a second,
    // unbatched reconciliation path (typically the per-row handler variant above).
    expect(
      countCodeOccurrences(squashed, 'store.reconcileMonstersFromView('),
      'store.reconcileMonstersFromView( must be called from EXACTLY ONE site AS CODE — the ' +
        'batcher flush closure. A second call site is a per-row reconcile against a mid-burst ' +
        'SDK cache',
    ).toBe(1);

    // The replaced per-row store calls must be gone: with the cache reconcile in place,
    // upsertMonster/removeMonster from connection.ts would race it.
    expect(
      countCodeOccurrences(squashed, 'store.upsertMonster('),
      'store.upsertMonster( must no longer be called from connection.ts — the flush-time ' +
        'reconcile from the SDK cache is the ONE write path for monster rows (ADR-0194 D4)',
    ).toBe(0);
    expect(
      countCodeOccurrences(squashed, 'store.removeMonster('),
      'store.removeMonster( must no longer be called from connection.ts — a per-row delete ' +
        'racing the flush-time reconcile is exactly the my_conversation coalescing wipe',
    ).toBe(0);
  });

  it('★ BITES: the flush closure is stale-build guarded (ADR-0085 C2) — it never reconciles from a superseded connection', () => {
    // WRONG IMPL KILLED: capturing `conn` from the LATEST build in a module-scope
    // variable and reading it unconditionally. ONE batcher serves ALL rebuilds
    // (connection.ts:137-141 says so explicitly), so a flush scheduled by a dying
    // connection can fire AFTER store.reset() and re-seed the store with the dead
    // socket's rows — the exact stale-flush hazard ADR-0085 C2 named when it mandated
    // the single shared batcher. The guard shape is the implementer's choice (an
    // `if (stale())`, a generation compare, or an undefined-check on the live
    // connection); what is pinned is that the closure does not reach the SDK cache
    // unconditionally.
    const squashed = squashedStrippedConnectionTs();
    const flushClosure = parenArgsAt(squashed, 'new MicrotaskBatcher(');

    const guarded =
      includesAsCode(flushClosure, 'if (') ||
      includesAsCode(flushClosure, '?.') ||
      includesAsCode(flushClosure, '!== undefined');
    expect(
      guarded,
      'the MicrotaskBatcher flush closure must GUARD its read of the SDK cache against a ' +
        'superseded/absent connection (ADR-0085 C2): ONE batcher serves ALL rebuilds, so a ' +
        'flush scheduled by a dying connection can fire after store.reset() and re-seed the ' +
        "store from the dead socket's cache. Any of an `if (…)` early return, an optional " +
        'chain, or an explicit `!== undefined` check satisfies this — an UNGUARDED ' +
        '`[...conn.db.my_monster_pub.iter()]` does not',
    ).toBe(true);
  });
});
