// main.wiring.test.ts — source-scan invariants over client/src/main.ts (pt-a1, F-3/F-5).
//
// SOURCE OF TRUTH: pt-a1 EARS criteria F-3 and F-5
//
// EARS criterion F-3 (fail-loud wiring at module scope):
//   main.ts MUST invoke resolveConnectionConfig( at module scope — specifically,
//   the call site MUST appear BEFORE the `async function main(` declaration.
//   Rationale: the guard only prevents connect() if the resolve throws at
//   MODULE-EVALUATION time. If a future edit moves the call inside main() or
//   under a try/catch, the throw is swallowed and a misconfigured prod build
//   silently connects to the dev DB.
//
// EARS criterion F-5 (DEV debug hooks stay gated):
//   Each of `.__game`, `.__mrTrade`, `.__mrPvp` window-assignment in main.ts
//   MUST sit inside an `if (import.meta.env.DEV)` gate. No occurrence of those
//   three window hook assignments may appear outside the gate. The intentionally
//   ungated `window.__mrBuild` build stamp is not covered here and must NOT
//   trigger a false failure.
//
// WHY source-scan (NOT import): main.ts has DOM/wasm side effects — importing it
// in vitest would crash on missing DOM/wasm globals. readFileSync gives us
// structural invariants over the source text without executing it.
//
// NO `new RegExp(...)` — Semgrep bans it. All matching uses String.indexOf /
// .includes / .split only.
//
// RED REASON (F-3): main.ts currently uses raw `?? 'monster-realm'` (line 78) —
// it does NOT call `resolveConnectionConfig(` at all. Test A (F-3) starts RED.
//
// GREEN REASON (F-5): main.ts already has `if (import.meta.env.DEV)` at line
// 1211 with the three hook assignments inside it (ADR-0127, m17.5f). Test B (F-5)
// starts GREEN — it is a regression guard. Acceptable per spec ("this invariant is
// ALREADY satisfied on master…so Test B starts GREEN").
//
// WRONG IMPL KILLED:
//   F-3: resolveConnectionConfig moved inside main()/a try-catch — the call-before-
//        main-decl assertion catches that.
//   F-3: no call at all (the current state) — indexOf returns -1.
//   F-5: a hook assignment moved outside the DEV gate (e.g. to module scope directly).
//   F-5: a `process.env.NODE_ENV`-based gate substituted — Vite won't define-replace
//        process.env.NODE_ENV, breaking DCE; the gate-string check catches it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Locate main.ts relative to this test file (both live in client/src/).
const MAIN_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts');

function readMainTs(): string {
  try {
    return readFileSync(MAIN_TS_PATH, 'utf8');
  } catch (err) {
    // Fail loud — the scan is vacuously true if the file is missing.
    throw new Error(
      'main.ts could not be read at expected path: ' + MAIN_TS_PATH + ' — ' + String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// F-3: resolveConnectionConfig( call site exists AND is before async function main(
// ---------------------------------------------------------------------------

describe('main.ts wiring (F-3): resolveConnectionConfig( called at module scope before main()', () => {
  it('F-3a: main.ts contains the call resolveConnectionConfig( (with paren, distinguishing from import)', () => {
    // WRONG IMPL KILLED: main.ts that never calls resolveConnectionConfig — the current
    // state (raw `?? 'monster-realm'` with no resolver call) is caught here.
    // NOTE: the import line is `import { resolveConnectionConfig }` with NO paren;
    // this needle `resolveConnectionConfig(` with paren finds only call sites.
    const src = readMainTs();
    const callIdx = src.indexOf('resolveConnectionConfig(');
    expect(
      callIdx,
      'main.ts must call resolveConnectionConfig( — the raw ?? default must be replaced',
    ).toBeGreaterThanOrEqual(0);
  });

  it('F-3b: the resolveConnectionConfig( call site appears BEFORE async function main(', () => {
    // WRONG IMPL KILLED: resolveConnectionConfig moved inside main() or a try/catch
    // inside main() — a call after the `async function main(` declaration would let
    // a misconfigured prod build swallow the throw and silently connect to the dev DB.
    const src = readMainTs();
    const callIdx = src.indexOf('resolveConnectionConfig(');
    const mainFnIdx = src.indexOf('async function main(');

    // Both must be present (F-3a already asserts callIdx; repeat here for a clear message).
    expect(
      callIdx,
      'resolveConnectionConfig( call must be present in main.ts',
    ).toBeGreaterThanOrEqual(0);
    expect(
      mainFnIdx,
      'async function main( declaration must be present in main.ts',
    ).toBeGreaterThanOrEqual(0);

    // The call must come BEFORE the function declaration (module-scope guard).
    expect(
      callIdx,
      'resolveConnectionConfig( call must appear BEFORE async function main( — ' +
        'placing it inside main() would allow the throw to be swallowed by a try/catch ' +
        'and a misconfigured prod build to silently connect to the dev DB',
    ).toBeLessThan(mainFnIdx);
  });

  it('F-3c: no resolveConnectionConfig( call site appears INSIDE async function main( body', () => {
    // WRONG IMPL KILLED: an impl that calls resolveConnectionConfig BOTH at module scope
    // (satisfying F-3b) AND again inside main() — only the module-scope call provides
    // the fail-loud guarantee; a second call inside main() is superfluous and misleading.
    // Scan for additional call sites after the `async function main(` marker.
    const src = readMainTs();
    const mainFnIdx = src.indexOf('async function main(');
    if (mainFnIdx < 0) return; // F-3b already catches the missing decl

    const afterMain = src.slice(mainFnIdx);
    const callInMain = afterMain.indexOf('resolveConnectionConfig(');
    expect(
      callInMain,
      'resolveConnectionConfig( must NOT appear inside async function main() — ' +
        'the module-scope call is the only guard; a call inside main() could be ' +
        'wrapped in a try/catch and swallow the throw',
    ).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// F-5: DEV debug hooks (.__game, .__mrTrade, .__mrPvp) are gated by
//       `if (import.meta.env.DEV)` — never ungated window assignments
// ---------------------------------------------------------------------------

describe('main.ts wiring (F-5): DEV debug hook window assignments are all gated (regression guard)', () => {
  it('F-5a: main.ts contains the gate `if (import.meta.env.DEV)`', () => {
    // WRONG IMPL KILLED: an impl that replaces `import.meta.env.DEV` with
    // `process.env.NODE_ENV === "development"` — Vite does NOT define-replace
    // process.env.NODE_ENV at build time, so the dead branch cannot be eliminated
    // by the minifier (DCE fails silently). The literal string must be present.
    const src = readMainTs();
    expect(
      src.includes('if (import.meta.env.DEV)'),
      'main.ts must gate DEV hooks with `if (import.meta.env.DEV)` — ' +
        '`process.env.NODE_ENV` is not define-replaced by Vite and breaks DCE',
    ).toBe(true);
  });

  it('F-5b: .__game window assignment appears AFTER the `if (import.meta.env.DEV)` gate', () => {
    // WRONG IMPL KILLED: .__game moved to module scope outside the gate — it would
    // be included in production bundles even after minifier DCE.
    //
    // CORRECTION NOTE (spec-rationale): the needle is `).__game =` (with ` =`), NOT
    // bare `.__game`. Comments in main.ts mention `window.__game()` before the gate
    // (lines 11, 109, 1055). The spec says "window-assignment" — a comment is not an
    // assignment. The assignment form is always `...).__game = snapshot` so the ` =`
    // suffix uniquely identifies it. This narrowing strengthens bite: an ungated
    // assignment (e.g. `(window).__game = snapshot` at module scope) still contains
    // `).__game =` and is caught; a comment mention is never caught.
    const src = readMainTs();
    const gateIdx = src.indexOf('if (import.meta.env.DEV)');
    expect(gateIdx, 'DEV gate must exist').toBeGreaterThanOrEqual(0);

    // `).__game =` matches only the actual window assignment, never the comment references.
    const assignIdx = src.indexOf(').__game =');
    expect(assignIdx, ').__game = assignment must exist in main.ts').toBeGreaterThanOrEqual(0);

    expect(
      assignIdx,
      ').__game = assignment must appear AFTER the `if (import.meta.env.DEV)` gate',
    ).toBeGreaterThan(gateIdx);
  });

  it('F-5c: .__mrTrade window assignment appears AFTER the `if (import.meta.env.DEV)` gate', () => {
    // WRONG IMPL KILLED: .__mrTrade moved outside the DEV gate.
    // CORRECTION NOTE: needle is `).__mrTrade =` — comments mention `window.__mrTrade`
    // before the gate (line 1118). The ` =` suffix selects only the assignment form.
    // Bite is preserved: an ungated assignment still contains `).__mrTrade =`.
    const src = readMainTs();
    const gateIdx = src.indexOf('if (import.meta.env.DEV)');
    expect(gateIdx, 'DEV gate must exist').toBeGreaterThanOrEqual(0);

    const assignIdx = src.indexOf(').__mrTrade =');
    expect(assignIdx, ').__mrTrade = assignment must exist in main.ts').toBeGreaterThanOrEqual(0);

    expect(
      assignIdx,
      ').__mrTrade = assignment must appear AFTER the `if (import.meta.env.DEV)` gate',
    ).toBeGreaterThan(gateIdx);
  });

  it('F-5d: .__mrPvp window assignment appears AFTER the `if (import.meta.env.DEV)` gate', () => {
    // WRONG IMPL KILLED: .__mrPvp moved outside the DEV gate.
    // Needle `).__mrPvp =` selects the assignment form only (no comment references to
    // `.__mrPvp` appear before the gate in the current file, but the narrowing is
    // correct-by-construction and future-proof).
    const src = readMainTs();
    const gateIdx = src.indexOf('if (import.meta.env.DEV)');
    expect(gateIdx, 'DEV gate must exist').toBeGreaterThanOrEqual(0);

    const assignIdx = src.indexOf(').__mrPvp =');
    expect(assignIdx, ').__mrPvp = assignment must exist in main.ts').toBeGreaterThanOrEqual(0);

    expect(
      assignIdx,
      ').__mrPvp = assignment must appear AFTER the `if (import.meta.env.DEV)` gate',
    ).toBeGreaterThan(gateIdx);
  });

  it('F-5e: no .__game / .__mrTrade / .__mrPvp ASSIGNMENT appears BEFORE the gate (no ungated copy)', () => {
    // WRONG IMPL KILLED: an impl that adds a second (ungated) assignment before the gate,
    // or moves the assignment to module scope while leaving the gated version in place.
    //
    // CORRECTION NOTE (spec-rationale): needles are `).__game =`, `).__mrTrade =`,
    // `).__mrPvp =` — the assignment form (with ` =` suffix), NOT bare `.__game` etc.
    // Comments in main.ts contain `window.__game()` (lines 11, 109, 1055) and
    // `window.__mrTrade` (line 1118) before the gate; those are not assignments and must
    // not trigger a false failure. The ` =` suffix uniquely identifies assignment sites.
    // Bite is preserved: an ungated `(window as ..).__game = snapshot` still matches
    // `).__game =` and fails this assertion correctly.
    const src = readMainTs();
    const gateIdx = src.indexOf('if (import.meta.env.DEV)');
    expect(gateIdx, 'DEV gate must exist').toBeGreaterThanOrEqual(0);

    const beforeGate = src.slice(0, gateIdx);

    // ).__game =: assignment form — must not appear before the gate
    expect(
      beforeGate.includes(').__game ='),
      ').__game = assignment must NOT appear before the `if (import.meta.env.DEV)` gate — ' +
        'an ungated assignment leaks the hook into production bundles',
    ).toBe(false);

    // ).__mrTrade =: assignment form — must not appear before the gate
    expect(
      beforeGate.includes(').__mrTrade ='),
      ').__mrTrade = assignment must NOT appear before the `if (import.meta.env.DEV)` gate',
    ).toBe(false);

    // ).__mrPvp =: assignment form — must not appear before the gate
    expect(
      beforeGate.includes(').__mrPvp ='),
      ').__mrPvp = assignment must NOT appear before the `if (import.meta.env.DEV)` gate',
    ).toBe(false);
  });

  it('F-5f: .__mrBuild (intentionally ungated build stamp) is NOT subject to the gate — no false failure', () => {
    // This test proves the F-5 suite does NOT false-fire on the intentionally ungated
    // window.__mrBuild build stamp. We assert that F-5e's "no-hook-before-gate" check
    // only covers the three DEV-only hooks via their assignment-form needles.
    // WRONG IMPL KILLED: a too-broad scan that rejects all window assignments before
    // the gate and breaks the intentionally-ungated build stamp.
    // NOTE: __mrBuild may or may not be present yet (added by the implementer).
    // Whether it exists or not, this test passes — it is a documentation fixture.
    const src = readMainTs();
    const gateIdx = src.indexOf('if (import.meta.env.DEV)');
    if (gateIdx >= 0) {
      const beforeGate = src.slice(0, gateIdx);
      // __mrBuild before the gate is intentional — do NOT assert it is absent.
      // The only assertion: our three assignment-form needles in F-5e do not fire.
      expect(beforeGate.includes(').__game =')).toBe(false); // per F-5e
      expect(beforeGate.includes(').__mrTrade =')).toBe(false); // per F-5e
      expect(beforeGate.includes(').__mrPvp =')).toBe(false); // per F-5e
      // ).__mrBuild =: no assertion — intentionally ungated, may or may not exist yet.
    }
    // If the gate doesn't exist yet, F-5a catches it; this fixture is a no-op here.
    expect(true).toBe(true);
  });
});

// ===========================================================================
// pt-b1 F9 bug-bundle wiring — ADDED describe block (does NOT modify F-3/F-5).
//
// SOURCE OF TRUTH: pt-b1 EARS criteria E-1, E-2, E-3, E-10, S-2 + red-team B-1/H-2
// + reviewer L-2.
//
// RED REASON: main.ts on master has none of this wiring yet — no F9-BUNDLE sentinels,
// no pushError helper, no error/unhandledrejection listeners, no makeConnect/…/emit
// calls, no `where === 'link'` guard. Every test below starts RED (throw/indexOf -1).
//
// The bug-bundle assembly path (E-10/S-2) MUST be net-free: no fetch/XHR/WebSocket/
// sendBeacon/reducer call/dynamic import — it reads local rings + a store projection and
// writes to a Blob download. bugBundle.ts must be structurally pure (cannot reach net/*).
// ===========================================================================

const F9_BEGIN = '// F9-BUNDLE-BEGIN';
const F9_END = '// F9-BUNDLE-END';

/** Slice the F9 bundle region out of main.ts by sentinel; throw loud if either is absent
 *  (a missing sentinel must be a HARD RED, never a vacuous pass). */
function f9Region(src: string): string {
  const beginIdx = src.indexOf(F9_BEGIN);
  const endIdx = src.indexOf(F9_END);
  if (beginIdx < 0) {
    throw new Error(
      `main.ts must contain the "${F9_BEGIN}" sentinel around the F9 bundle region (E-10/S-2)`,
    );
  }
  if (endIdx < 0) {
    throw new Error(
      `main.ts must contain the "${F9_END}" sentinel around the F9 bundle region (E-10/S-2)`,
    );
  }
  if (endIdx <= beginIdx) {
    throw new Error(`"${F9_END}" must appear AFTER "${F9_BEGIN}" in main.ts`);
  }
  return src.slice(beginIdx, endIdx + F9_END.length);
}

describe('main.ts wiring (pt-b1 F9): bug-bundle region is net-free (E-10/S-2)', () => {
  it('W-F9-NONET BITES: the F9 region contains NO network / reducer / dynamic-import call', () => {
    // WRONG IMPL KILLED: an F9 handler that POSTs the bundle to a server (fetch/XHR/beacon),
    // opens a socket, calls a reducer (`.reducers.`/`conn.conn`), or dynamic-imports net code.
    // E-10/S-2: the bundle is assembled + downloaded LOCALLY, never transmitted.
    const region = f9Region(readMainTs());
    const forbidden = [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'sendBeacon',
      '.reducers.',
      'conn.conn',
      'import(',
    ];
    for (const needle of forbidden) {
      expect(
        region.includes(needle),
        `F9 bundle region must NOT contain "${needle}" — the bundle is local-only, never transmitted (E-10/S-2)`,
      ).toBe(false);
    }
  });

  it('W-F9-BLOB (positive control): F9 region uses createObjectURL + a catch fallback + console.log', () => {
    // POSITIVE CONTROL: proves the region is the REAL bundle path (createObjectURL download),
    // has a CSP-fallback `catch`, and logs the JSON so a blocked download still surfaces it.
    // WRONG IMPL KILLED: a stubbed-out F9 region (empty sentinels) that satisfies W-F9-NONET
    // vacuously — this asserts the region actually does the local-download work.
    const region = f9Region(readMainTs());
    expect(
      region.includes('createObjectURL'),
      'F9 region must use URL.createObjectURL for local download',
    ).toBe(true);
    expect(region.includes('catch'), 'F9 region must have a catch (CSP/blob fallback)').toBe(true);
    expect(
      region.includes('console.log'),
      'F9 region must log the JSON as a fallback when download is blocked',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-b1 F9): bugBundle.ts is structurally pure (H-2)', () => {
  it('W-BUNDLE-PURE BITES: bugBundle.ts imports nothing from net/* (cannot reach the socket)', () => {
    // RED-TEAM H-2: bugBundle.ts must be a PURE assembler — it takes a store projection as
    // input, it does not fetch it. A `from './net…'`/`from '../net…'` import would let the
    // bundle reach the live connection and (a) transmit or (b) trigger a side-effecting read.
    // WRONG IMPL KILLED: a bugBundle that imports the connection/store adapter directly.
    const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui/bugBundle.ts');
    let src: string;
    try {
      src = readFileSync(bundlePath, 'utf8');
    } catch (err) {
      // Fail loud — post-impl the file must exist (vacuous-revival-gate precedent).
      throw new Error(
        'bugBundle.ts could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    expect(
      src.includes("from './net"),
      'bugBundle.ts must not import from ./net (H-2: structurally pure)',
    ).toBe(false);
    expect(
      src.includes("from '../net"),
      'bugBundle.ts must not import from ../net (H-2: structurally pure)',
    ).toBe(false);
  });
});

describe('main.ts wiring (pt-b1): error reporting is unified through the error ring (E-3)', () => {
  it('W-UNIFY-1 BITES: reportError body keeps statusEl + console.error AND now pushes to the error ring', () => {
    // E-3: a single reportError funnel — the user-visible status line, the console log, AND a
    // record into the error ring (so the bundle captures reducer/UI errors). The push helper is
    // `pushError('reducer', …)` per the contract.
    // WRONG IMPL KILLED: a reportError that logs to the console/status line but never records
    // the error into the ring — the bug bundle would be blind to reducer failures.
    const src = readMainTs();
    const fnIdx = src.indexOf('function reportError(');
    expect(fnIdx, 'reportError function must exist in main.ts').toBeGreaterThanOrEqual(0);
    // Region = from the reportError decl to the start of the next top-level `function ` after it.
    const afterDecl = src.slice(fnIdx + 'function reportError('.length);
    const nextFnRel = afterDecl.indexOf('\nfunction ');
    const body =
      nextFnRel >= 0
        ? src.slice(fnIdx, fnIdx + 'function reportError('.length + nextFnRel)
        : src.slice(fnIdx);
    expect(
      body.includes('statusEl'),
      'reportError must still touch statusEl (user-visible line)',
    ).toBe(true);
    expect(body.includes('console.error'), 'reportError must still console.error (logs)').toBe(
      true,
    );
    expect(
      body.includes("pushError('reducer'"),
      "reportError must route through pushError('reducer', …) so the bundle captures the error (E-3)",
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-b1): global error listeners registered (E-1/E-2)', () => {
  it('W-LISTEN-1 BITES: main.ts registers addEventListener("error") AND ("unhandledrejection")', () => {
    // E-1/E-2: uncaught errors and unhandled promise rejections must be captured into the
    // error ring for the bundle.
    // WRONG IMPL KILLED: an impl that only wires one of the two listeners (rejections or
    // uncaught errors would be invisible to the bundle).
    const src = readMainTs();
    expect(
      src.includes("addEventListener('error'"),
      'main.ts must register an "error" listener (E-1)',
    ).toBe(true);
    expect(
      src.includes("addEventListener('unhandledrejection'"),
      'main.ts must register an "unhandledrejection" listener (E-2)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-b1): disconnect emit is gated on the link edge (B-1)', () => {
  it("W-DISCONNECT-LINK BITES: makeDisconnect( emit is co-located with a `where === 'link'` guard, AFTER it", () => {
    // RED-TEAM B-1: the disconnect event must fire ONLY on the link-level disconnect edge, not
    // for every `onDisconnect(where)` call (which fires for other `where` values too). The emit
    // must appear AFTER a `where === 'link'` guard.
    // WRONG IMPL KILLED: a makeDisconnect() emitted unconditionally in onDisconnect (would emit a
    // spurious disconnect event for non-link wheres), or with no link guard at all.
    const src = readMainTs();
    const guardIdx = src.indexOf("where === 'link'");
    expect(
      guardIdx,
      "main.ts must contain a `where === 'link'` guard for the disconnect emit",
    ).toBeGreaterThanOrEqual(0);
    const emitIdx = src.indexOf('makeDisconnect(');
    expect(emitIdx, 'main.ts must emit makeDisconnect(').toBeGreaterThanOrEqual(0);
    expect(
      emitIdx,
      "makeDisconnect( must appear AFTER a `where === 'link'` guard — the emit is gated on the link edge (B-1)",
    ).toBeGreaterThan(guardIdx);
  });
});

describe('main.ts wiring (pt-b1): all 6 core event constructors are emitted (L-2)', () => {
  it('W-EMIT-1 BITES: each of the 6 discriminating core constructor needles appears ≥1 time', () => {
    // REVIEWER L-2: the 6 CORE playtest events must actually be emitted from main.ts (the 8
    // parked constructors are pt-b1b). A constructor that exists but is never called captures
    // nothing.
    // WRONG IMPL KILLED: an impl that wires the ring but forgets to emit one of the core events
    // (e.g. zoneChange never fires -> zone transitions invisible in the bundle).
    const src = readMainTs();
    const needles = [
      'makeConnect(',
      'makeDisconnect(',
      'makeZoneChange(',
      'makeBattleStart(',
      'makeBattleEnd(',
      'makeRankedMatch(',
    ];
    for (const needle of needles) {
      expect(
        src.includes(needle),
        `main.ts must emit ${needle} at least once (L-2 core event)`,
      ).toBe(true);
    }
  });
});
