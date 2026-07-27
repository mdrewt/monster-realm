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

// ---------------------------------------------------------------------------
// W-NH4-SAVE-WIRED — the token is captured on connect, under the stale guard.
// ---------------------------------------------------------------------------

describe('connection.ts wiring (nh4): W-NH4-SAVE-WIRED — onConnect saves the token via auth.onConnected(token), guarded', () => {
  it('BITES: onConnect callback takes a third param named token, calls auth.onConnected(token) exactly once file-wide, AFTER the stale guard', () => {
    const src = readConnectionTs();
    const squashedWhole = squashWhitespace(stripLineComments(src));

    // WRONG IMPL KILLED (a): onConnect((c, id) => ...) — the token discarded entirely,
    // the bug today. The exact three-param signature pin catches this.
    expect(
      squashedWhole.includes('.onConnect((c, id, token) => {'),
      'the onConnect callback must have the exact contiguous signature ' +
        '".onConnect((c, id, token) => {" — RED today: connection.ts has ' +
        '".onConnect((c, id) => {" with only two params, discarding the token entirely',
    ).toBe(true);

    // WRONG IMPL KILLED (b): auth.onConnected(id.toHexString()) — saving the IDENTITY
    // instead of the token. The exact-argument pin (token, not id.toHexString()) rejects it.
    // WRONG IMPL KILLED (c): a duplicate, UNGUARDED auth.onConnected(token) added ABOVE
    // the stale guard in addition to the compliant guarded one — killed by the
    // exactly-once file-wide count, which a mere "appears after the guard" check would
    // miss (it would find the LATER, compliant occurrence and never notice the earlier
    // rogue one).
    const savedCount = squashedWhole.split('auth.onConnected(token)').length - 1;
    expect(
      savedCount,
      'auth.onConnected(token) must occur EXACTLY once in connection.ts — RED today: it ' +
        'does not occur at all (0 times); a duplicated unguarded call above the stale ' +
        'guard would also fail this count',
    ).toBe(1);

    // WRONG IMPL KILLED (d): the single call placed ABOVE the stale guard, letting a
    // superseded build clobber the live build's token.
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
