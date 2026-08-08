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
// None of the four exist on the file as of this writing (see connection.ts:485,
// 567 read at authoring time — `.onConnect((c, id) => {` with NO third `token` param,
// and no `.withToken(` call at all in the builder chain). This is the RED reason.
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
// RED REASON (all 5 gates): none of the four wiring points exist in connection.ts
// today. `.withToken(` occurs ZERO times in the file as of this writing; `onConnect(`
// takes only two params `(c, id)`, not three; `authToken` does not appear anywhere
// (no such module exists yet). Every gate below fails for the right reason — a
// missing implementation — not a typo in this test.

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

  it('BITES (CRITICAL): createAuthTokenGate( is constructed at connect() SCOPE, BEFORE `function build(): DbConnection {` — NOT re-created inside build() — mutant killed: "gate recreated per build ⇒ counter resets every attempt ⇒ suppression never engages ⇒ permanent auth-reject loop"', () => {
    // WRONG IMPL KILLED: `const auth = createAuthTokenGate(opts.uri, opts.db,
    // globalThis);` moved INSIDE `function build(): DbConnection {`. build() is
    // re-invoked by scheduleRebuild() on every reconnect attempt, so a per-build
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
    expectUniqueAnchor(src, 'function build(): DbConnection {');
    expectUniqueAnchor(src, 'wireTables(conn);');

    const gateIdx = src.indexOf('createAuthTokenGate(');
    const buildIdx = src.indexOf('function build(): DbConnection {');
    expect(
      gateIdx,
      'createAuthTokenGate( must be constructed BEFORE `function build(): DbConnection ' +
        '{` (i.e. at connect() scope, read fresh per rebuild via a closure, not ' +
        're-created on every build() invocation) — a gate built inside build() gets a ' +
        'fresh in-memory rejection counter on every reconnect attempt, so suppression ' +
        'never engages',
    ).toBeLessThan(buildIdx);

    const body = bodyRegion(src, 'function build(): DbConnection {', 'wireTables(conn);');
    expect(
      body.includes('createAuthTokenGate('),
      'createAuthTokenGate( must NOT be called anywhere inside build() — gate recreated ' +
        'per build ⇒ counter resets every attempt ⇒ suppression never engages ⇒ permanent ' +
        'auth-reject loop',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W-NH4-TOKEN-SUPPLIED — the builder chain supplies the token, read freshly per build.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4): W-NH4-TOKEN-SUPPLIED — builder chain calls .withToken(auth.tokenForNextAttempt())', () => {
  it('BITES: build() region contains the exact contiguous .withToken(auth.tokenForNextAttempt()) and .withToken( occurs exactly once file-wide', () => {
    // Region-bound to build(): both anchors must be unique first (anti-vacuity).
    const src = readConnectionTs();
    expectUniqueAnchor(src, 'function build(): DbConnection {');
    expectUniqueAnchor(src, 'wireTables(conn);');

    const body = bodyRegion(src, 'function build(): DbConnection {', 'wireTables(conn);');
    const squashedBody = squashWhitespace(body);

    // WRONG IMPL KILLED (a): no .withToken( at all — the bug today.
    // WRONG IMPL KILLED (b): .withToken(undefined) / .withToken('') / .withToken(void 0)
    //   — the exact-argument pin rejects all of them.
    // WRONG IMPL KILLED (c): .withToken(auth.tokenForNextAttempt() && '') — a truthy-left
    //   short-circuit that silently disables persistence while keeping both tokens
    //   textually present; this exact-contiguous pin rejects the extra ` && ''`.
    expect(
      squashedBody.includes('.withToken(auth.tokenForNextAttempt())'),
      'build() builder chain must call .withToken(auth.tokenForNextAttempt()) exactly as ' +
        'written — RED today: connection.ts has no .withToken( call at all',
    ).toBe(true);

    // WRONG IMPL KILLED (d): the read hoisted to connect() scope with a closed-over
    // variable passed instead — e.g. `const token = auth.tokenForNextAttempt();` at
    // connect() scope, with `.withToken(token)` inside build(). A dead
    // `auth.tokenForNextAttempt()` call left inside build() (to satisfy a naive
    // presence needle) would NOT satisfy this contiguous-argument pin, because the
    // call must appear literally as the argument to .withToken(.
    // WRONG IMPL KILLED (e): a second, later .withToken(...) overriding the first —
    // killed by the exactly-once file-wide count below.
    const wholeSquashed = squashWhitespace(stripLineComments(src));
    const withTokenCount = wholeSquashed.split('.withToken(').length - 1;
    expect(
      withTokenCount,
      '.withToken( must occur exactly once in connection.ts — a second later call would ' +
        'silently override the first, and zero occurrences is the RED-today bug',
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
// ★★ CONSEQUENCE FOR THE GATING TESTS ★★
// `W-NH4-TOKEN-SUPPLIED` above is therefore NOT re-pinned — it stands byte-for-byte
// as it shipped, and `.withToken(auth.tokenForNextAttempt())` stays byte-identical
// in connection.ts. That is what makes AUTH-31's "no behaviour change to the
// anonymous path" claim literally true rather than merely asserted. Exactly ONE
// pre-existing tooth changes this slice — `W-NH4-SAVE-WIRED` — and its written
// justification is directly above it. `W-NH4-GATE-CONSTRUCTED`,
// `W-NH4-FAILURE-WIRED`, `W-NH4-NO-CLEAR-ON-DROP`, `SDK-DRIFT` and
// `W-DEVLOG-WRAP` are NOT touched.
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

/** `readAuthKind(host, uri, db)` — host FIRST (unlike `createAuthTokenGate(uri, db, host)`);
 *  the exact-argument-list pin is what kills a marker keyed on one axis only, which would
 *  let an `'account'` marker written for the playtest database refuse the connection to
 *  production. Bound to a NAMED const — `buildKind` — because W-NH4-SAVE-WIRED's guard must
 *  read the value THIS build decided on, not re-derive it later from mutable storage. */
const M21B_KIND_READ = 'const buildKind = readAuthKind(globalThis, opts.uri, opts.db);';

/** The kind-guarded save. `=== 'anon'` (not `!== 'account'`) is the FAIL-CLOSED direction:
 *  if `AuthKind` ever gains a third member, a `!==` guard would start writing that kind's
 *  credential into the anonymous slot by default. */
const M21B_SAVE_GUARDED = "if (buildKind === 'anon') auth.onConnected(token);";

// ---------------------------------------------------------------------------
// W-M21B-KIND-READ (NEW) — the discriminator the save guard depends on is read
// ONCE PER BUILD, inside build(), from BOTH key axes.
//
// This is the companion tooth to W-NH4-SAVE-WIRED below: that tooth pins the
// GUARD, this one pins the BINDING the guard reads. Neither is sufficient alone
// — a guard on a stale or wrongly-scoped binding is a guard in name only.
// ---------------------------------------------------------------------------

describe('★ connection.ts wiring (M21b / AUTH-31): W-M21B-KIND-READ — build() binds `const buildKind = readAuthKind(globalThis, opts.uri, opts.db)`', () => {
  it('★ BITES: the marker read is contiguous, bound to buildKind, INSIDE build(), and occurs exactly once file-wide', () => {
    // WRONG IMPL KILLED (a): no marker read at all — RED TODAY. `readAuthKind` appears
    //   nowhere in connection.ts, so W-NH4-SAVE-WIRED's guard has nothing to read and the
    //   anonymous token slot stays unguarded.
    // WRONG IMPL KILLED (b): ★ THE READ HOISTED TO connect() SCOPE. This is the same
    //   defect W-NH4-GATE-CONSTRUCTED guards for the gate itself, and it matters here for
    //   the mirror-image reason: the gate must be built ONCE (its counter must survive
    //   rebuilds), whereas the marker must be re-read on EVERY build (it is mutable
    //   sessionStorage that M21b-2's return leg will write mid-session). A connect()-scope
    //   read pins one value for the page lifetime, so a marker that flips to 'account'
    //   before a rebuild is ignored and the very next reconnect writes the account JWT
    //   into the anon slot — precisely the hole this slice exists to close. The region
    //   bound is the only thing that sees it.
    // WRONG IMPL KILLED (c): a one-axis read — `readAuthKind(globalThis, opts.db)` or
    //   `readAuthKind(globalThis, opts.uri)`. The contiguous argument-list pin requires
    //   BOTH key axes, in this order. A db-only key would let a marker written for the
    //   playtest database govern the production connection.
    // WRONG IMPL KILLED (d): the host argument swapped or dropped —
    //   `readAuthKind(opts.uri, opts.db, globalThis)` (the createAuthTokenGate order,
    //   which is the natural copy-paste slip). It would typecheck as `unknown` in some
    //   shapes and silently always return 'anon', permanently disarming the guard.
    // WRONG IMPL KILLED (e): a SECOND read somewhere else in the file — the exactly-once
    //   count. A second read is by construction a chance to disagree with the first, and
    //   the TOCTOU variant of that (a re-read inside the onConnect callback) is the exact
    //   mutant W-NH4-SAVE-WIRED's guard needle also rejects. Both teeth red on it.
    const src = readConnectionTs();
    expectUniqueAnchor(src, 'function build(): DbConnection {');
    expectUniqueAnchor(src, 'wireTables(conn);');

    const squashedBody = squashWhitespace(
      bodyRegion(src, 'function build(): DbConnection {', 'wireTables(conn);'),
    );
    const wholeSquashed = squashWhitespace(stripLineComments(src));

    expect(
      squashedBody.includes(M21B_KIND_READ),
      `build() must contain the contiguous \`${M21B_KIND_READ}\` — read fresh per build, ` +
        'from BOTH key axes, bound to `buildKind` so the onConnect guard reads the value ' +
        'THIS build decided on. RED TODAY: readAuthKind appears nowhere in connection.ts',
    ).toBe(true);
    expect(
      countOccurrences(wholeSquashed, 'readAuthKind('),
      'readAuthKind( must be INVOKED from EXACTLY ONE site in connection.ts (the import ' +
        'specifier carries no paren and is not a call site). A second call is a second, ' +
        'divergent answer to "which kind is this build?"',
    ).toBe(1);

    // The read must live INSIDE build(), not at connect() scope. Asserted as an explicit
    // ordering fact as well as a region membership, mirroring W-NH4-GATE-CONSTRUCTED's
    // shape so the two scope rules read as one family rather than two idioms.
    const readIdx = src.indexOf('readAuthKind(globalThis');
    const buildIdx = src.indexOf('function build(): DbConnection {');
    expect(
      readIdx,
      'connection.ts must call readAuthKind(globalThis, …). RED TODAY',
    ).toBeGreaterThanOrEqual(0);
    expect(
      readIdx,
      'the readAuthKind( call must appear AFTER `function build(): DbConnection {` — i.e. ' +
        'INSIDE build(), re-read on every rebuild. Hoisted to connect() scope it pins one ' +
        'marker value for the whole page lifetime',
    ).toBeGreaterThan(buildIdx);

    // `readAuthKind` and its module must be imported, not locally re-declared: authToken.ts
    // is the SSOT and authToken.test.ts is the ONLY place its behaviour is ever proven
    // (this file can prove wiring, never behaviour — see this file's header).
    expectUniqueAnchor(wholeSquashed, "from './authToken';");
    const importEnd = wholeSquashed.indexOf("from './authToken';");
    expect(
      wholeSquashed.indexOf('readAuthKind'),
      "readAuthKind must be IMPORTED from './authToken' — its first occurrence has to sit " +
        'inside that import statement, not in a local re-declaration further down the file',
    ).toBeLessThan(importEnd);
    expect(
      countOccurrences(wholeSquashed, 'function readAuthKind'),
      'connection.ts must not re-declare readAuthKind locally — a local copy would be ' +
        'invisible to authToken.test.ts, the only proof of this function’s behaviour',
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W-NH4-SAVE-WIRED (RE-PINNED, M21b) — the token is captured on connect, under
// the stale guard AND under the build's kind.
//
// ★★ RE-PIN JUSTIFICATION (tester-owned; reviewer checklist item) ★★
// WAS: "exactly one UNCONDITIONAL `auth.onConnected(token)` call site, under the
// stale guard". NOW: "exactly one call site, GUARDED on the build's kind, under
// the stale guard."
//
// WHY IT HAD TO CHANGE, and why the change is a STRENGTHENING and not a
// loosening: probe P3 (spacetimedb dist/index.mjs:5765 sets `this.token` from
// `.withToken(...)`; :6226-6231 adopts the host's token ONLY `if (!this.token …)`
// before `emit("connect", this, this.identity, this.token)`) proves that a
// client-supplied JWT is echoed back VERBATIM as onConnect's third argument. So
// the pre-M21b UNCONDITIONAL call — the exact shape the old tooth REQUIRED — is
// the mechanism that would write an account JWT into the ANONYMOUS token slot,
// from which authToken.ts:141-155 would re-supply it on every later build for
// the life of the tab. Red-team C4, CONFIRMED not hypothetical. RULING 3 makes
// "never replay an account JWT" STRUCTURAL by guarding this one call site, so
// no marker desync (a quota/private-mode partial write) can produce a replay.
//
// Properties carried forward unchanged: the exact three-param `.onConnect((c,
// id, token) => {` signature; `auth.onConnected(` at EXACTLY ONE call site
// file-wide; that call site strictly AFTER `if (stale()) return;`.
// Property added: the call is reached only when this build decided `'anon'`.
// The tooth still bites an UN-GUARDED call site — that is the plan's named
// mutation "un-guard auth.onConnected(token)".
//
// THIS IS THE ONLY PRE-EXISTING TOOTH THIS SLICE CHANGES. `W-NH4-TOKEN-SUPPLIED`
// was going to be re-pinned too, until the scope ruling above cut the read-side
// guard; it now stands byte-for-byte as it shipped. One justified re-pin, not
// two — please audit this one accordingly.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4, RE-PINNED by M21b): W-NH4-SAVE-WIRED — onConnect saves the token via auth.onConnected(token), stale-guarded AND kind-guarded', () => {
  it('★ BITES: onConnect takes a third param named token and calls auth.onConnected(token) at exactly ONE site — guarded on the build kind, AFTER the stale guard', () => {
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

    // ★ THE ADDED PROPERTY — and the whole of this slice's safety value.
    // WRONG IMPL KILLED (e): the call left UNCONDITIONAL — `auth.onConnected(token);` on
    //   its own line. That is today's shape (connection.ts:542) and it is the C4 replay
    //   mechanism the moment the account branch becomes reachable: the SDK hands back the
    //   very JWT we supplied (P3), and the anon slot swallows it permanently. This is the
    //   plan's named mutation "un-guard auth.onConnected(token)".
    // WRONG IMPL KILLED (f): the guard INVERTED — `if (buildKind === 'account')` or
    //   `if (buildKind !== 'anon')`. Both write the account credential into the anonymous
    //   slot and nothing else in the suite can see it; the contiguous needle admits only
    //   the fail-closed `=== 'anon'` form. (`!== 'account'` is also rejected: it is
    //   behaviourally equal TODAY, but it fails OPEN the moment `AuthKind` gains a third
    //   member, which is exactly what M21b-2 may do.)
    // WRONG IMPL KILLED (g): ★ TOCTOU — a guard that RE-READS the marker inside the
    //   callback rather than using the build-scoped binding, e.g.
    //   `if (readAuthKind(globalThis, opts.uri, opts.db) === 'anon') auth.onConnected(token);`.
    //   onConnect fires asynchronously, an arbitrary time after the build decided; the
    //   marker is mutable sessionStorage that M21b-2's return leg writes mid-session. A
    //   re-read can therefore say 'anon' for a build that supplied an account credential
    //   — the guard would be present, readable, and wrong. The needle pins the closed-over
    //   `buildKind` binding, and W-M21B-KIND-READ pins `readAuthKind(` to exactly ONE call
    //   site inside build(), so this variant reds in BOTH teeth.
    expect(
      squashedWhole.includes(M21B_SAVE_GUARDED),
      `connection.ts must contain the contiguous \`${M21B_SAVE_GUARDED}\` — the anonymous ` +
        'token slot must NEVER receive an account JWT. RED today: connection.ts:542 calls ' +
        'auth.onConnected(token) UNCONDITIONALLY, and the SDK echoes a client-supplied JWT ' +
        "back as onConnect's third argument (probe P3), so the unconditional form persists " +
        'the account credential into the anonymous slot (red-team C4)',
    ).toBe(true);
    expect(
      countOccurrences(squashedWhole, M21B_SAVE_GUARDED),
      'the kind-guarded save must appear exactly once — two guarded sites means two ' +
        'competing writers of the same slot',
    ).toBe(1);

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
    const guardIdx = squashedRegion.indexOf('if (stale()) return;');
    const savedIdx = squashedRegion.indexOf('auth.onConnected(token)');
    expect(guardIdx, 'onConnect region must contain the stale guard').toBeGreaterThanOrEqual(0);
    expect(
      savedIdx,
      'onConnect region must contain auth.onConnected(token)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      savedIdx,
      'auth.onConnected(token) must be called AFTER "if (stale()) return;" within the ' +
        'onConnect callback — a call placed above the guard would let a superseded ' +
        "build's late connect clobber the live build's saved token",
    ).toBeGreaterThan(guardIdx);
    // The kind guard must live in the SAME region (not hoisted somewhere the callback
    // never reaches), and likewise after the stale guard.
    expect(
      squashedRegion.indexOf(M21B_SAVE_GUARDED),
      'the kind-guarded save must sit INSIDE the onConnect callback, AFTER the stale guard',
    ).toBeGreaterThan(guardIdx);
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
// ---------------------------------------------------------------------------

describe('connection.ts wiring (ADR-0157): W-DEVLOG-WRAP — both outbound wrap sites exist', () => {
  it('★ W-DEVLOG-WRAP BITES (build): build() RETURNS wrapReducerLogging(conn, …) AFTER wireTables(conn)', () => {
    // WRONG IMPL KILLED (1): `return conn;` left untouched — 37 of the 38 outbound sites
    // are unlogged and the feature appears "half broken" only at runtime.
    // WRONG IMPL KILLED (2): wrapping BEFORE / instead of `wireTables(conn)` — the inbound
    // row-callback wiring would then be installed against the Proxy rather than the raw
    // connection, putting the trap on the hot inbound path this slice explicitly excludes
    // (EARS-3, obs-b). Region-bounding the assertion to the text AFTER `wireTables(conn);`
    // is what pins the order.
    const src = readConnectionTs();
    expectUniqueAnchor(src, 'wireTables(conn);');
    expectUniqueAnchor(src, 'let current = build();');

    const tail = squashWhitespace(bodyRegion(src, 'wireTables(conn);', 'let current = build();'));
    expect(
      tail.includes('return wrapReducerLogging(conn'),
      'build() must end with `return wrapReducerLogging(conn, opts.onSend);` — placed AFTER ' +
        'wireTables(conn) so the inbound path still sees the RAW connection (§A2). RED today: ' +
        'wrapReducerLogging does not appear in connection.ts at all',
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

    const joinIdx = squashed.indexOf('.reducers.joinGame(');
    const before = squashed.slice(Math.max(0, joinIdx - 140), joinIdx);
    expect(
      before.includes('wrapReducerLogging('),
      'the receiver of .reducers.joinGame( must come from wrapReducerLogging( — expected ' +
        '`wrapReducerLogging(c, opts.onSend).reducers.joinGame({ name })` (§A2)',
    ).toBe(true);

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
    expect(
      countOccurrences(arrayBody, "'SELECT * FROM monster_pub'"),
      'the .subscribe([...]) window must still contain the monster_pub subscription — if it ' +
        'does not, this gate is judging the wrong region and every assertion here is vacuous',
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
