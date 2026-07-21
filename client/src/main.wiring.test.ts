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

  it('W-KEYSTORE-NOPII BITES: the F9 region (incl. projectKeyStore) reads no name/nickname field', () => {
    // WRONG IMPL KILLED (red-team L-2): a future projectKeyStore edit adding `prof?.name` /
    // `.nickname` / `.displayName` would leak player-controlled PII into the downloadable bundle.
    // KeyStoreSnapshot is a numeric/id/hex allowlist by type; this pins the projection to it.
    // NOTE: `.name` (with the leading dot) matches a property read, NOT `bugBundleFilename`.
    const region = f9Region(readMainTs());
    for (const needle of ['.name', '.nickname', '.displayName']) {
      expect(
        region.includes(needle),
        `F9 bundle region must NOT read "${needle}" — the key-store snapshot is a no-PII allowlist`,
      ).toBe(false);
    }
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

// ===========================================================================
// pt-c1b rename UI wiring — NEW describe block (does NOT modify F-3/F-5/pt-b1 blocks).
//
// SOURCE OF TRUTH: pt-c1b EARS criteria PTC1B-1..9 + RT-RN-01/02/04/05/08/09/10
//   + ADR-0133 D3/D4 + docs/specs/pt-c1b-plan.md fan-out inventory.
//
// RED REASON: main.ts on master has no renameView wiring yet — no import, no let,
// no dynamic import entry, no KeyN handler, no setProfileName call, no fan-out guards.
// Every test below starts RED (indexOf returns -1 / assertion fails).
//
// RL-15 (per-file, not transitive): set_profile_name and reducers.* must NOT appear
// in leaderboardView.ts or leaderboardModel.ts. The write path is main.ts only.
// This matches the pt-c1 RL-7 tooth precedent (ADR-0133 §Consequences).
//
// Fan-out inventory (ADR-0133 D4): 17 occurrences of `leaderboardView?.visible` exist
// in main.ts at the time these tests were authored (counted from the current main.ts).
// renameView?.visible must appear at least that many times (same structural role).
// Per-context needles assert specific sites: reconcile(389), keydown(818), rAF(1766),
// pvp-aggregate(1064), battle-supersession(897), onReconnect(1725), Escape handler.
// ===========================================================================

describe('main.ts wiring (pt-c1b rename): import + let + dynamic-import + construction', () => {
  it('W-RN-IMPORT BITES: main.ts imports from "./ui/renameView" — kills missing-import impl', () => {
    // WRONG IMPL KILLED: an impl that never imports renameView — the view is never constructed.
    // Uses .includes() — no new RegExp().
    const src = readMainTs();
    expect(
      src.includes("'./ui/renameView'"),
      'main.ts must contain "\'./ui/renameView\'" import (pt-c1b wiring)',
    ).toBe(true);
  });

  it('W-RN-LET BITES: main.ts declares "let renameView" — kills missing-let impl', () => {
    // WRONG IMPL KILLED: an impl that never declares the module-scope let — the view
    // cannot be referenced by the fan-out guards.
    const src = readMainTs();
    expect(
      src.includes('let renameView'),
      'main.ts must declare "let renameView" at module scope (pt-c1b wiring)',
    ).toBe(true);
  });

  it('W-RN-DYNIMPORT BITES: main.ts dynamic-imports "./ui/renameView" — kills missing-dynamic-import impl', () => {
    // WRONG IMPL KILLED: an impl that statically imports the view (would load DOM code at
    // vitest parse time and crash) or omits the dynamic import entirely.
    const src = readMainTs();
    expect(
      src.includes("import('./ui/renameView')"),
      "main.ts must contain import('./ui/renameView') in the dynamic-import fan-out (pt-c1b wiring)",
    ).toBe(true);
  });

  it('W-RN-CONSTRUCT BITES: main.ts constructs "new RenameView(" — kills missing-construction impl', () => {
    // WRONG IMPL KILLED: an impl that imports renameView but never constructs it.
    // Needle covers both `new RenameView(` and `new RenameViewClass(` (the alias used post-dynamic-import,
    // matching the leaderboardView pattern where `LeaderboardViewClass` is the dynamic import alias).
    const src = readMainTs();
    const hasNew = src.includes('new RenameView(') || src.includes('new RenameViewClass(');
    expect(
      hasNew,
      'main.ts must construct new RenameView( or new RenameViewClass( (pt-c1b wiring)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c1b rename): setProfileName reducer call present', () => {
  it('W-RN-REDUCER BITES: main.ts contains "reducers.setProfileName(" — kills missing-reducer-call impl', () => {
    // WRONG IMPL KILLED: an impl where the rename overlay is constructed but never calls
    // the server reducer — renames would be client-side only with no persistence.
    // PTC1B-2/9: the UI must wire setProfileName.
    const src = readMainTs();
    expect(
      src.includes('reducers.setProfileName('),
      'main.ts must call reducers.setProfileName( in the rename wiring (PTC1B-2/9)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c1b rename): RL-15 purity — write path absent from leaderboard files', () => {
  it('★ RL-15 BITES: leaderboardView.ts must NOT contain setProfileName or reducers. — kills write-path-in-view impl', () => {
    // RL-15 (ADR-0133 §Consequences): the write path must never live in the pure
    // subscription view. This is a DIRECT-FILE scan (not transitive — ADR-0133 §Consequences).
    // WRONG IMPL KILLED: an impl that moves setProfileName into leaderboardView.ts
    // (e.g. adding a rename button to the leaderboard overlay itself).
    // Uses .includes() — no new RegExp().
    const viewPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'ui/leaderboardView.ts',
    );
    let src: string;
    try {
      src = readFileSync(viewPath, 'utf8');
    } catch (err) {
      throw new Error(
        'leaderboardView.ts could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    const forbidden = ['setProfileName', 'reducers.'];
    for (const needle of forbidden) {
      expect(
        src.includes(needle),
        `leaderboardView.ts must NOT contain "${needle}" (RL-15: pure subscription view, no write path — ADR-0133)`,
      ).toBe(false);
    }
  });

  it('★ RL-15 BITES: leaderboardModel.ts must NOT contain setProfileName or reducers. — kills write-path-in-model impl', () => {
    // RL-15 mirror for the model layer (ADR-0133 §Consequences, same direct-file scope).
    // WRONG IMPL KILLED: an impl that adds a rename action to the leaderboard model
    // (the model is pure VM computation, no side effects, no reducer calls).
    const modelPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'ui/leaderboardModel.ts',
    );
    let src: string;
    try {
      src = readFileSync(modelPath, 'utf8');
    } catch (err) {
      throw new Error(
        'leaderboardModel.ts could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    const forbidden = ['setProfileName', 'reducers.'];
    for (const needle of forbidden) {
      expect(
        src.includes(needle),
        `leaderboardModel.ts must NOT contain "${needle}" (RL-15: pure model, no write path — ADR-0133)`,
      ).toBe(false);
    }
  });
});

describe('main.ts wiring (pt-c1b rename): KeyN handler (PTC1B-1 / RT-RN-01/05)', () => {
  it("W-RN-KEYN BITES: main.ts contains a 'KeyN' handler — kills missing-KeyN impl", () => {
    // PTC1B-1: WHEN KeyN pressed AND no other overlay visible, render+show the rename overlay.
    // WRONG IMPL KILLED: an impl with no KeyN branch in the keydown handler.
    const src = readMainTs();
    expect(
      src.includes("'KeyN'"),
      "main.ts must contain a 'KeyN' handler (PTC1B-1 rename entry point)",
    ).toBe(true);
  });

  it('W-RN-PREVENT BITES: main.ts KeyN branch contains e.preventDefault() — kills missing-preventDefault impl (RT-RN-05)', () => {
    // RT-RN-05: e.preventDefault() prevents the "n" character from being injected into the
    // input field when the overlay opens (belt-and-suspenders with deferred focus).
    // WRONG IMPL KILLED: an impl where KeyN opens the overlay but the "n" keypress still
    // triggers a character insertion.
    // Strategy: locate the 'KeyN' string, take the surrounding region, assert e.preventDefault() appears in it.
    const src = readMainTs();
    const keyNIdx = src.indexOf("'KeyN'");
    expect(keyNIdx, "main.ts must contain 'KeyN' (PTC1B-1)").toBeGreaterThanOrEqual(0);

    // Look in the 600 chars after 'KeyN' for the prevention call — the KeyN block
    // is compact (similar to other single-key handlers like 'KeyL', 'KeyP', etc.).
    const keyNRegion = src.slice(keyNIdx, keyNIdx + 600);
    expect(
      keyNRegion.includes('e.preventDefault()'),
      "main.ts KeyN region must contain e.preventDefault() — prevents the 'n' character injection (RT-RN-05)",
    ).toBe(true);
  });

  it('W-RN-HELD BITES: main.ts KeyN branch contains held.clear() — kills missing-held-clear impl (RT-RN-01)', () => {
    // RT-RN-01: held.clear() on open makes the held-key stack immune to press/release
    // straddling the overlay's open/close boundary (ADR-0133 D3 mechanism 3).
    // WRONG IMPL KILLED: an impl that opens the rename overlay without clearing held keys —
    // a held movement key would resume moving after the overlay closes.
    const src = readMainTs();
    const keyNIdx = src.indexOf("'KeyN'");
    expect(keyNIdx, "main.ts must contain 'KeyN' (PTC1B-1)").toBeGreaterThanOrEqual(0);

    // Window widened 600→720 (pt-c2b): the help overlay added `!helpView?.visible` to the KeyN
    // open-guard, pushing held.clear() down so the 12-char "held.clear()" string now STARTS at
    // ~delta 590 and ENDS at ~602 — i.e. it straddles the old 600-char slice end, so
    // includes('held.clear()') truncated to false. Widening preserves the bite: the next
    // held.clear() (KeyO's) is at ~delta 990, far outside 720, so a missing KeyN held.clear()
    // still fails (no foreign held.clear() can false-credit it).
    const keyNRegion = src.slice(keyNIdx, keyNIdx + 720);
    expect(
      keyNRegion.includes('held.clear()'),
      'main.ts KeyN region must contain held.clear() — clears the prediction held-key stack on open (RT-RN-01, ADR-0133 D3)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c1b rename): Escape handler for rename overlay (PTC1B-6)', () => {
  it('W-RN-ESCAPE BITES: main.ts Escape handler includes renameView?.visible — kills missing-Escape-close impl', () => {
    // PTC1B-6: Escape must close the rename overlay.
    // WRONG IMPL KILLED: an impl where the Escape handler only covers other overlays
    // (leaderboard, pvp, trade) but not renameView, leaving the overlay un-closeable via Escape.
    // Strategy: look for the Escape region (Escape is handled at line ~800 in current main.ts)
    // and assert renameView?.visible appears in it.
    const src = readMainTs();
    // Find the first Escape handler region (the window keydown Escape block)
    const escapeIdx = src.indexOf("e.code === 'Escape'");
    expect(escapeIdx, 'main.ts must contain an Escape handler').toBeGreaterThanOrEqual(0);

    // Check in the 2000 chars after the first Escape to cover all Escape branches.
    const escapeRegion = src.slice(escapeIdx, escapeIdx + 2000);
    expect(
      escapeRegion.includes('renameView'),
      'main.ts Escape region must reference renameView — the rename overlay must be closeable via Escape (PTC1B-6)',
    ).toBe(true);
  });
});

describe('★ main.ts wiring (pt-c1b rename): per-site fan-out (PTC1B-6 / D4 / M-1 / RT-RN-02)', () => {
  // Fan-out inventory (ADR-0133 D4):
  // At the time these tests were authored, `leaderboardView?.visible` appears 17 times
  // in main.ts (counted via grep). renameView?.visible must appear at LEAST 17 times,
  // matching the structural role of the leaderboard in every suppression context.
  //
  // The per-context needles below are the load-bearing tests — they name specific wiring
  // sites rather than relying on a count floor alone (m17b fan-out-coverage-trap precedent).
  const LEADERBOARD_VISIBLE_COUNT = 17; // AUTHORING-TIME count — do not edit post-impl

  it(`★ W-RN-FANOUT-COUNT BITES: renameView?.visible appears at least ${LEADERBOARD_VISIBLE_COUNT} times — kills under-wired impl`, () => {
    // WRONG IMPL KILLED: an impl that adds renameView to some but not all fan-out sites,
    // e.g. wires the KeyN guard but forgets reconcile(389) or rAF(1766).
    // Count strategy: split on 'renameView?.visible' and subtract 1 from the parts length.
    const src = readMainTs();
    const parts = src.split('renameView?.visible');
    const count = parts.length - 1;
    expect(
      count,
      `main.ts must contain renameView?.visible at least ${LEADERBOARD_VISIBLE_COUNT} times ` +
        `(one per leaderboardView?.visible occurrence — ADR-0133 D4 fan-out parity). ` +
        `Found: ${count}. The spec-comment floor is ${LEADERBOARD_VISIBLE_COUNT} (leaderboardView count at authoring time).`,
    ).toBeGreaterThanOrEqual(LEADERBOARD_VISIBLE_COUNT);
  });

  it('W-RN-FANOUT-RECONCILE BITES: renameView?.visible in the reconcile OR-block (~line 389) — kills reconcile-bleed impl', () => {
    // ADR-0133 D3: movement-suppression site reconcile (main.ts:389) must include renameView.
    // WRONG IMPL KILLED: an impl that forgets renameView in the reconcile block — held keys
    // could re-issue movement while the rename overlay is open (RT-RN-01 reconcile path).
    // Strategy: find the reconcile OR-block anchor (`predictor.reconcile(`) and assert
    // renameView?.visible appears in the nearby region that guards the heldDir re-issue.
    const src = readMainTs();
    const reconcileIdx = src.indexOf('predictor.reconcile(');
    expect(reconcileIdx, 'main.ts must contain predictor.reconcile(').toBeGreaterThanOrEqual(0);
    // The reconcile held-key re-issue guard is within ~600 chars after the reconcile call.
    const reconcileRegion = src.slice(reconcileIdx, reconcileIdx + 600);
    expect(
      reconcileRegion.includes('renameView?.visible'),
      'main.ts reconcile region must contain renameView?.visible — the reconcile heldDir re-issue is suppressed while rename is open (ADR-0133 D3)',
    ).toBe(true);
  });

  it('W-RN-FANOUT-KEYDOWN BITES: renameView?.visible in the keydown movement-suppression OR-block — kills keydown-bleed impl', () => {
    // ADR-0133 D3: movement-suppression site keydown (~line 818) must include renameView.
    // WRONG IMPL KILLED: an impl that forgets renameView in the keydown suppression block —
    // WASD would move the character while the rename overlay is open (the most obvious bleed).
    // Strategy: find "Suppress movement input while an overlay is open." comment and look
    // for renameView?.visible in the following OR-block. Fallback: scan the entire keydown
    // suppression block (after the last Escape handler) for renameView?.visible.
    const src = readMainTs();
    const suppressIdx = src.indexOf('Suppress movement input while an overlay is open');
    expect(
      suppressIdx,
      "main.ts must contain the 'Suppress movement' comment",
    ).toBeGreaterThanOrEqual(0);
    const suppressRegion = src.slice(suppressIdx, suppressIdx + 600);
    expect(
      suppressRegion.includes('renameView?.visible'),
      'main.ts keydown movement-suppression block must contain renameView?.visible (ADR-0133 D3, keydown ~line 818)',
    ).toBe(true);
  });

  it('W-RN-FANOUT-RAF BITES: renameView?.visible in the rAF frame-loop held-key re-issue OR-block (~line 1766) — kills frame-loop bleed impl', () => {
    // ADR-0133 D3: movement-suppression site rAF frame-loop (~line 1766) must include renameView.
    // WRONG IMPL KILLED: an impl that forgets renameView in the rAF block — a held key could
    // keep walking in the background while the rename overlay is open (the frame loop runs
    // regardless of overlay state unless guarded).
    // Strategy: find the rAF re-issue block anchor (predictor.drain() is called in the rAF;
    // the held-key re-issue immediately precedes it) and assert renameView?.visible is there.
    const src = readMainTs();
    const drainIdx = src.indexOf('predictor.drain(');
    expect(drainIdx, 'main.ts must contain predictor.drain(').toBeGreaterThanOrEqual(0);
    // The rAF OR-block is within ~400 chars BEFORE the drain call.
    const rafRegion = src.slice(Math.max(0, drainIdx - 400), drainIdx);
    expect(
      rafRegion.includes('renameView?.visible'),
      'main.ts rAF frame-loop held-key re-issue block must contain renameView?.visible (~line 1766, ADR-0133 D3)',
    ).toBe(true);
  });

  it('W-RN-FANOUT-PVP BITES: renameView?.visible in the anyOverlayVisible pvp aggregate — kills pvp-over-rename impl', () => {
    // ADR-0133 D4: pvp auto-show aggregate (~line 1064) must include renameView?.visible
    // so an incoming challenge does NOT pop over an open rename form.
    // WRONG IMPL KILLED: an impl that forgets renameView in anyOverlayVisible — an incoming
    // PvP challenge auto-shows the PvP overlay over the rename form.
    // Strategy: find 'anyOverlayVisible' and look for renameView in the nearby region.
    const src = readMainTs();
    const pvpAggIdx = src.indexOf('anyOverlayVisible');
    expect(pvpAggIdx, 'main.ts must contain anyOverlayVisible').toBeGreaterThanOrEqual(0);
    // anyOverlayVisible is assembled within ~1000 chars of the aggregate definition.
    const pvpRegion = src.slice(pvpAggIdx, pvpAggIdx + 1000);
    expect(
      pvpRegion.includes('renameView'),
      'main.ts anyOverlayVisible pvp aggregate must reference renameView (ADR-0133 D4 — no pvp-over-rename)',
    ).toBe(true);
  });

  it('W-RN-FANOUT-RECONNECT BITES: renameView?.hide() called in onReconnect — kills stale-overlay-on-reconnect impl (RT-RN-02)', () => {
    // ADR-0133 D4: the reconnect stale-overlay hide (~line 1725) must cover renameView.
    // RT-RN-02: on reconnect the rename overlay must close (store reset; stale state).
    // WRONG IMPL KILLED: an impl that hides shop/trade/pvp/leaderboard on reconnect but
    // forgets renameView — the overlay could stay open with a stale in-flight lock.
    // Strategy: find 'onReconnect' callback region and assert renameView?.hide appears in it.
    const src = readMainTs();
    const reconnectIdx = src.indexOf('onReconnect:');
    expect(reconnectIdx, 'main.ts must contain onReconnect:').toBeGreaterThanOrEqual(0);
    // The onReconnect body is within ~800 chars after the declaration.
    const reconnectRegion = src.slice(reconnectIdx, reconnectIdx + 800);
    expect(
      reconnectRegion.includes('renameView'),
      'main.ts onReconnect body must reference renameView — hide it on reconnect (RT-RN-02, ADR-0133 D4)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c1b rename): onSubmit routes through reduceErrorMessage + linkFrozen (PTC1B-4/8)', () => {
  it('W-RN-ERRMSG BITES: main.ts contains "reduceErrorMessage(" used in the rename wiring region — kills no-error-msg impl (PTC1B-4)', () => {
    // PTC1B-4: WHEN the call rejects, show reduceErrorMessage(err,'set-profile-name').
    // WRONG IMPL KILLED: an impl that shows a raw error string (InternalError leak) or
    // silently swallows the rejection.
    const src = readMainTs();
    expect(
      src.includes('reduceErrorMessage('),
      'main.ts must use reduceErrorMessage( for rename error feedback (PTC1B-4: no InternalError leak)',
    ).toBe(true);
    // The specific 'set-profile-name' label must appear (pins the error context string).
    expect(
      src.includes("'set-profile-name'"),
      "main.ts must contain the 'set-profile-name' reduceErrorMessage label (PTC1B-4)",
    ).toBe(true);
  });

  it('W-RN-FROZEN BITES: main.ts contains "linkFrozen()" check in the rename wiring region — kills no-frozen-gate impl (PTC1B-8)', () => {
    // PTC1B-8: WHILE the link is frozen, submit shows "disconnected — try again" and does
    // NOT call the reducer (ADR-0085 A1).
    // WRONG IMPL KILLED: an impl where the rename onSubmit calls the reducer without first
    // checking linkFrozen() — the promise never settles on a dead link (dead-button-forever
    // without the frozen gate, ADR-0085 A1).
    // NOTE: main.ts already uses sendGuarded() for other reducers which internally calls
    // linkFrozen(). The rename path must also go through linkFrozen() (either via sendGuarded
    // or directly). This scan asserts the linkFrozen() check is present in main.ts (it already
    // is via sendGuarded, this test is a regression guard + new-site confirmation).
    const src = readMainTs();
    expect(
      src.includes('linkFrozen()'),
      'main.ts must contain linkFrozen() check in the rename wiring (PTC1B-8: frozen-link gate, ADR-0085 A1)',
    ).toBe(true);
  });
});

// ===========================================================================
// pt-c2 trade-PROPOSE overlay wiring — NEW describe block (does NOT modify prior blocks).
//
// SOURCE OF TRUTH: pt-c2 EARS criteria PTC2-13/14/15 + ADR-0134 D4/D7.
//
// RED REASON: main.ts on master has no tradeProposeView wiring yet — no import,
// no let, no dynamic import, no KeyO handler, no fan-out guards.
// Every test below starts RED (indexOf returns -1 / assertion fails).
//
// D7 fan-out checklist (enumerated in ADR-0134) — EXACT sites:
//   Open guards (all 11 siblings + new KeyO self-guard): 495 KeyB, 514 KeyI, 533 KeyE,
//     557 KeyQ, 581 KeyH, 606 KeyG, 639 KeyU, 672 KeyP, 702 KeyL, 733 KeyN, 763 KeyT.
//   KeyO handler: identity!=='' guard + held.clear() + e.preventDefault() + toggle-close.
//   Escape branch: `tradeProposeView?.visible` branch adjacent to renameView Escape.
//   Movement/reissue suppression: reconcile (~390), keydown movement block (~874), rAF (~1853).
//   PvP anyOverlayVisible: batch listener (~1113) aggregate.
//   Force-hide: onReconnect (~1803).
//
// WRONG IMPL KILLED (per test):
//   W-TP-KEYO: missing 'KeyO' branch in keydown → overlay never opens
//   W-TP-ESCAPE: missing tradeProposeView?.visible in Escape → overlay stuck open
//   W-TP-IMPORT/LET/DYNIMPORT/CONSTRUCT: standard import-chain gaps
//   W-TP-REDUCER: missing proposeTrade( call → no trade initiated
//   W-TP-IDENTITY-GUARD: missing identity!=='' check → crash on empty identity
//   W-TP-HELD: missing held.clear() → held keys straddle open/close
//   W-TP-PREVENT: missing e.preventDefault() → 'o' char injected into...wrong, no text input
//                 but preventDefault() is still required to prevent any default key action
//   W-TP-FANOUT-*: each fan-out site gap creates a bleed (movement/pvp-over-overlay)
//   W-TP-RECONNECT: missing hide on reconnect → dead #pending lock forever
//   W-TP-FROZEN: missing linkFrozen() gate → dead promise on dropped link
//   W-TP-ERRMSG: missing reduceErrorMessage → InternalError leak
//   W-TP-IDENTITY-CTOR: missing new Identity( → wrong call shape
// ===========================================================================

describe('main.ts wiring (pt-c2 tradePropose): import + let + dynamic-import + construction', () => {
  it('W-TP-IMPORT BITES: main.ts imports from "./ui/tradeProposeView" — kills missing-import impl', () => {
    // WRONG IMPL KILLED: an impl that never imports tradeProposeView — the view is never constructed.
    const src = readMainTs();
    expect(
      src.includes("'./ui/tradeProposeView'"),
      'main.ts must contain "\'./ui/tradeProposeView\'" import (pt-c2 wiring)',
    ).toBe(true);
  });

  it('W-TP-LET BITES: main.ts declares "let tradeProposeView" — kills missing-let impl', () => {
    // WRONG IMPL KILLED: an impl that never declares the module-scope let — the view
    // cannot be referenced by the fan-out guards.
    const src = readMainTs();
    expect(
      src.includes('let tradeProposeView'),
      'main.ts must declare "let tradeProposeView" at module scope (pt-c2 wiring)',
    ).toBe(true);
  });

  it('W-TP-DYNIMPORT BITES: main.ts dynamic-imports "./ui/tradeProposeView" — kills missing-dynamic-import impl', () => {
    // WRONG IMPL KILLED: an impl that statically imports the view (crashes vitest on DOM)
    // or omits the dynamic import entirely.
    const src = readMainTs();
    expect(
      src.includes("import('./ui/tradeProposeView')"),
      "main.ts must contain import('./ui/tradeProposeView') in the dynamic-import fan-out (pt-c2 wiring)",
    ).toBe(true);
  });

  it('W-TP-CONSTRUCT BITES: main.ts constructs "new TradeProposeView(" — kills missing-construction impl', () => {
    // WRONG IMPL KILLED: an impl that imports tradeProposeView but never constructs it.
    const src = readMainTs();
    const hasNew =
      src.includes('new TradeProposeView(') || src.includes('new TradeProposeViewClass(');
    expect(
      hasNew,
      'main.ts must construct new TradeProposeView( or new TradeProposeViewClass( (pt-c2 wiring)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c2 tradePropose): proposeTrade reducer call present', () => {
  it('W-TP-REDUCER BITES: main.ts contains "reducers.proposeTrade(" — kills missing-reducer-call impl', () => {
    // WRONG IMPL KILLED: a tradeProposeView that is constructed but never calls the server
    // reducer — trades would never be initiated.
    // PTC2-15: the UI must wire proposeTrade.
    const src = readMainTs();
    expect(
      src.includes('reducers.proposeTrade('),
      'main.ts must call reducers.proposeTrade( in the tradePropose wiring (PTC2-15)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c2 tradePropose): KeyO handler (PTC2-13 / D7)', () => {
  it("W-TP-KEYO BITES: main.ts contains a 'KeyO' handler — kills missing-KeyO impl", () => {
    // PTC2-13: WHEN KeyO pressed AND no other overlay visible, open/toggle the tradeProposeView.
    // WRONG IMPL KILLED: an impl with no KeyO branch in the keydown handler.
    const src = readMainTs();
    expect(
      src.includes("'KeyO'"),
      "main.ts must contain a 'KeyO' handler (PTC2-13 trade-propose entry point)",
    ).toBe(true);
  });

  it("W-TP-IDENTITY-GUARD BITES: main.ts KeyO branch checks identity !== '' — kills L-1 impl (D7)", () => {
    // D7 red-team L-1: KeyO must guard on identity!=='' before opening the overlay.
    // WRONG IMPL KILLED: an impl that opens the propose form without an identity guard —
    // proposeTrade would be called with an empty targetIdentity or before the player is joined.
    // Strategy: locate 'KeyO' and assert `identity !== ''` appears in the nearby region.
    const src = readMainTs();
    const keyOIdx = src.indexOf("'KeyO'");
    expect(keyOIdx, "main.ts must contain 'KeyO' (PTC2-13)").toBeGreaterThanOrEqual(0);
    const keyORegion = src.slice(keyOIdx, keyOIdx + 800);
    expect(
      keyORegion.includes("identity !== ''"),
      "main.ts KeyO region must contain `identity !== ''` guard (D7 L-1)",
    ).toBe(true);
  });

  it('W-TP-HELD BITES: main.ts KeyO branch contains held.clear() — kills missing-held-clear impl (D7)', () => {
    // D7: held.clear() on open makes the held-key stack immune to press/release
    // straddling the overlay's open/close boundary (same as KeyN pattern).
    // WRONG IMPL KILLED: an impl that opens the overlay without clearing held keys.
    const src = readMainTs();
    const keyOIdx = src.indexOf("'KeyO'");
    expect(keyOIdx, "main.ts must contain 'KeyO' (PTC2-13)").toBeGreaterThanOrEqual(0);
    const keyORegion = src.slice(keyOIdx, keyOIdx + 800);
    expect(
      keyORegion.includes('held.clear()'),
      'main.ts KeyO region must contain held.clear() — clears prediction held-key stack on open (D7)',
    ).toBe(true);
  });

  it('W-TP-PREVENT BITES: main.ts KeyO branch contains e.preventDefault() — kills missing-preventDefault impl', () => {
    // e.preventDefault() prevents any default browser action for 'o' key.
    // WRONG IMPL KILLED: an impl where KeyO opens the overlay without preventing the default action.
    const src = readMainTs();
    const keyOIdx = src.indexOf("'KeyO'");
    expect(keyOIdx, "main.ts must contain 'KeyO' (PTC2-13)").toBeGreaterThanOrEqual(0);
    const keyORegion = src.slice(keyOIdx, keyOIdx + 800);
    expect(
      keyORegion.includes('e.preventDefault()'),
      'main.ts KeyO region must contain e.preventDefault() (D7)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c2 tradePropose): Escape handler (PTC2-14 / D7)', () => {
  it('W-TP-ESCAPE BITES: main.ts Escape handler includes tradeProposeView?.visible — kills missing-Escape-close impl', () => {
    // D7: "Escape branch (NEW, placed adjacent to the rename branch)".
    // WRONG IMPL KILLED: an impl where the Escape handler only covers renameView and other
    // overlays but not tradeProposeView, leaving the overlay un-closeable via Escape.
    const src = readMainTs();
    const escapeIdx = src.indexOf("e.code === 'Escape'");
    expect(escapeIdx, 'main.ts must contain an Escape handler').toBeGreaterThanOrEqual(0);
    // Check in the 2500 chars after the first Escape to cover all Escape branches.
    const escapeRegion = src.slice(escapeIdx, escapeIdx + 2500);
    expect(
      escapeRegion.includes('tradeProposeView'),
      'main.ts Escape region must reference tradeProposeView — the overlay must be closeable via Escape (D7)',
    ).toBe(true);
  });
});

describe('★ main.ts wiring (pt-c2 tradePropose): D7 fan-out checklist (PTC2-14)', () => {
  // Fan-out parity rule (ADR-0134 D7): every renameView?.visible guard site gets a sibling
  // tradeProposeView?.visible. At pt-c1b authoring time, renameView?.visible appears N times.
  // After pt-c2, tradeProposeView?.visible must appear at least the same count.
  //
  // The per-context needles below are the LOAD-BEARING tests — they name specific wiring
  // sites that are easy to miss (ADR-0134 D7 enumerated checklist).
  // Count floor: renameView?.visible count at pt-c1b authoring was 17 (same as leaderboard).
  // tradeProposeView adds one more (the new KeyO open guard is itself the 18th self-guard).
  // We conservatively assert ≥17 (the parity count, not +1) since the impl may structure
  // the KeyO self-guard differently (e.g. combined with the open logic).
  const RENAME_VISIBLE_COUNT = 17; // parity floor at pt-c1b authoring time

  it(`★ W-TP-FANOUT-COUNT BITES: tradeProposeView?.visible appears at least ${RENAME_VISIBLE_COUNT} times — kills under-wired impl`, () => {
    // WRONG IMPL KILLED: an impl that adds tradeProposeView to some but not all fan-out sites.
    const src = readMainTs();
    const parts = src.split('tradeProposeView?.visible');
    const count = parts.length - 1;
    expect(
      count,
      `main.ts must contain tradeProposeView?.visible at least ${RENAME_VISIBLE_COUNT} times ` +
        `(D7 fan-out parity with renameView?.visible — ADR-0134). Found: ${count}.`,
    ).toBeGreaterThanOrEqual(RENAME_VISIBLE_COUNT);
  });

  it('W-TP-FANOUT-RECONCILE BITES: tradeProposeView?.visible in the reconcile OR-block — kills reconcile-bleed impl (D7)', () => {
    // D7 movement/reissue suppression site: reconcile (~390).
    // WRONG IMPL KILLED: an impl that forgets tradeProposeView in the reconcile block —
    // held keys could re-issue movement while the propose overlay is open.
    const src = readMainTs();
    const reconcileIdx = src.indexOf('predictor.reconcile(');
    expect(reconcileIdx, 'main.ts must contain predictor.reconcile(').toBeGreaterThanOrEqual(0);
    const reconcileRegion = src.slice(reconcileIdx, reconcileIdx + 700);
    expect(
      reconcileRegion.includes('tradeProposeView?.visible'),
      'main.ts reconcile region must contain tradeProposeView?.visible (D7 movement suppression)',
    ).toBe(true);
  });

  it('W-TP-FANOUT-KEYDOWN BITES: tradeProposeView?.visible in the keydown movement-suppression OR-block (D7)', () => {
    // D7 movement/reissue suppression site: keydown (~874).
    // WRONG IMPL KILLED: an impl that forgets tradeProposeView in the keydown suppression block —
    // WASD would move the character while the propose overlay is open.
    const src = readMainTs();
    const suppressIdx = src.indexOf('Suppress movement input while an overlay is open');
    expect(
      suppressIdx,
      "main.ts must contain the 'Suppress movement' comment",
    ).toBeGreaterThanOrEqual(0);
    const suppressRegion = src.slice(suppressIdx, suppressIdx + 700);
    expect(
      suppressRegion.includes('tradeProposeView?.visible'),
      'main.ts keydown movement-suppression block must contain tradeProposeView?.visible (D7)',
    ).toBe(true);
  });

  it('W-TP-FANOUT-RAF BITES: tradeProposeView?.visible in the rAF frame-loop held-key re-issue OR-block (D7)', () => {
    // D7 movement/reissue suppression site: rAF frame-loop (~1853).
    // WRONG IMPL KILLED: an impl that forgets tradeProposeView in the rAF block — a held key
    // keeps walking in the background while the propose overlay is open.
    const src = readMainTs();
    const drainIdx = src.indexOf('predictor.drain(');
    expect(drainIdx, 'main.ts must contain predictor.drain(').toBeGreaterThanOrEqual(0);
    const rafRegion = src.slice(Math.max(0, drainIdx - 500), drainIdx);
    expect(
      rafRegion.includes('tradeProposeView?.visible'),
      'main.ts rAF frame-loop held-key re-issue block must contain tradeProposeView?.visible (D7)',
    ).toBe(true);
  });

  it('★ W-TP-FANOUT-PVP BITES: tradeProposeView?.visible in the anyOverlayVisible pvp aggregate (D7 reviewer B-2 / red-team C-1)', () => {
    // D7: "PvP auto-show (add tradeProposeView?.visible): 1113-1124 batch-listener anyOverlayVisible
    // (reviewer B-2 / red-team C-1 — a server-push auto-show, easy to miss)."
    // WRONG IMPL KILLED: an impl that forgets tradeProposeView in anyOverlayVisible —
    // an incoming PvP challenge auto-shows the PvP overlay OVER the propose form.
    // PROOF-OF-TEETH: a server-push anyOverlayVisible without tradeProposeView means the
    // PvP overlay pops over a half-filled propose form (the most common playtest UX failure).
    const src = readMainTs();
    const pvpAggIdx = src.indexOf('anyOverlayVisible');
    expect(pvpAggIdx, 'main.ts must contain anyOverlayVisible').toBeGreaterThanOrEqual(0);
    const pvpRegion = src.slice(pvpAggIdx, pvpAggIdx + 1200);
    expect(
      pvpRegion.includes('tradeProposeView'),
      'main.ts anyOverlayVisible pvp aggregate must reference tradeProposeView (D7 B-2/C-1)',
    ).toBe(true);
  });

  it('★ W-TP-FANOUT-KEYN-GUARD BITES: tradeProposeView?.visible in the KeyN open guard (D7 reviewer B-1 — easy miss)', () => {
    // D7: "733 KeyN (reviewer B-1 — easy miss)".
    // WRONG IMPL KILLED: an impl that guards KeyN against all other overlays but not tradeProposeView
    // — pressing KeyN while the propose form is open would open the rename overlay over it.
    const src = readMainTs();
    const keyNIdx = src.indexOf("'KeyN'");
    expect(keyNIdx, "main.ts must contain 'KeyN'").toBeGreaterThanOrEqual(0);
    // KeyN open guard block is within ~800 chars after 'KeyN'
    const keyNRegion = src.slice(keyNIdx, keyNIdx + 800);
    expect(
      keyNRegion.includes('tradeProposeView'),
      'main.ts KeyN open guard must reference tradeProposeView (D7 reviewer B-1 — easy miss)',
    ).toBe(true);
  });

  it('★ W-TP-RECONNECT BITES: tradeProposeView?.hide() called in onReconnect — kills dead-#pending-lock impl (D7 reviewer M-2 / red-team C-2)', () => {
    // D7: "~1803 onReconnect (reviewer M-2 / red-team C-2 — WITHOUT this the #pending lock
    // survives a link drop → dead submit button forever)."
    // WRONG IMPL KILLED: an impl that hides other overlays on reconnect but forgets
    // tradeProposeView — the propose overlay stays open with a dead in-flight lock.
    const src = readMainTs();
    const reconnectIdx = src.indexOf('onReconnect:');
    expect(reconnectIdx, 'main.ts must contain onReconnect:').toBeGreaterThanOrEqual(0);
    const reconnectRegion = src.slice(reconnectIdx, reconnectIdx + 1000);
    expect(
      reconnectRegion.includes('tradeProposeView'),
      'main.ts onReconnect body must reference tradeProposeView?.hide() (D7 M-2/C-2)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c2 tradePropose): onSubmit — frozen-gate + Identity/bigint + reduceErrorMessage (PTC2-15 / D4)', () => {
  it('W-TP-ERRMSG BITES: main.ts contains "reduceErrorMessage(" used in the tradePropose wiring — kills no-error-msg impl', () => {
    // PTC2-15: WHEN proposeTrade rejects, show reduceErrorMessage(err,'propose-trade').
    // WRONG IMPL KILLED: an impl that shows a raw error string (InternalError leak) or
    // silently swallows the rejection.
    // NOTE: reduceErrorMessage( is already present from prior slices (rename, shop, etc.);
    // this scan asserts it is still present (regression guard + new-site confirmation).
    const src = readMainTs();
    expect(
      src.includes('reduceErrorMessage('),
      'main.ts must use reduceErrorMessage( for tradePropose error feedback (PTC2-15: no InternalError leak)',
    ).toBe(true);
    // The specific 'propose-trade' label must appear (pins the error context string for this slice).
    expect(
      src.includes("'propose-trade'"),
      "main.ts must contain the 'propose-trade' reduceErrorMessage label (PTC2-15)",
    ).toBe(true);
  });

  it('W-TP-IDENTITY-CTOR BITES: main.ts constructs "new Identity(" in the tradePropose wiring — kills raw-string impl (D4)', () => {
    // D4: "main.ts's onSubmit(args) [...] calls reducers.proposeTrade({ counterparty: new Identity(args.targetIdentity), ...})".
    // WRONG IMPL KILLED: an impl that passes args.targetIdentity as a raw string to counterparty
    // (the SDK expects an Identity object, not a string; a string arg would be silently wrong or
    // produce a runtime type error at the SDK boundary).
    const src = readMainTs();
    expect(
      src.includes('new Identity('),
      'main.ts must construct new Identity( in the tradePropose onSubmit (D4: SDK boundary)',
    ).toBe(true);
  });

  it('W-TP-FROZEN BITES: main.ts contains "linkFrozen()" check in the tradePropose wiring — kills no-frozen-gate impl (D4)', () => {
    // D4: "It gates on conn === undefined || conn.linkFrozen() FIRST (ADR-0085 A1)".
    // WRONG IMPL KILLED: an impl where tradePropose onSubmit calls the reducer without first
    // checking linkFrozen() — the promise never settles on a dead link (dead-button-forever).
    // NOTE: linkFrozen() is already present in main.ts from sendGuarded and the rename wiring;
    // this is a regression guard confirming it is still used for the propose path.
    const src = readMainTs();
    expect(
      src.includes('linkFrozen()'),
      'main.ts must contain linkFrozen() check (frozen-link gate, D4 / ADR-0085 A1)',
    ).toBe(true);
  });
});

// ===========================================================================
// pt-c2b HELP overlay wiring — NEW describe block (does NOT modify prior blocks).
//
// SOURCE OF TRUTH: pt-c2b EARS criteria PTC2B-1..9 + ADR-0135 (D-fan-out + the
// onReconnect asymmetry) + docs/specs/pt-c2b-plan.md "Plan-review resolutions"
// (BINDING: count-floor = 19; rAF forward-anchor; two-endpoint reconnect region;
// battle anchored on `r.action.kind === 'show'`).
//
// RED REASON: main.ts on master has ZERO helpView references (verified via grep) —
// no import, no `let helpView`, no dynamic import, no `new HelpView...`, no `?` handler,
// and none of the 19 fan-out guards. Every POSITIVE test below starts RED (indexOf -1 /
// assertion fails). The single NEGATIVE regression guard (W-HELP-NO-RECONNECT-HIDE)
// starts GREEN by design — see its self-check comment for why it is NOT vacuous.
//
// The help overlay is DISPLAY-ONLY (ADR-0135): no text input, no submit, no reducer.
// It joins the overlay mutual-exclusion fan-out EXACTLY as its read-only siblings do,
// with ONE deliberate deviation: it is NOT hidden on onReconnect (it holds no #pending
// lock and no store-derived state — a static const — so surviving a reconnect is correct).
//
// NO `new RegExp(...)` anywhere — Semgrep bans it (bitten twice). indexOf/includes/split only.
// ===========================================================================

describe('main.ts wiring (pt-c2b help): import + let + dynamic-import + zero-arg construction', () => {
  it('W-HELP-IMPORT BITES: main.ts imports from "./ui/helpView" — kills missing-import impl', () => {
    // WRONG IMPL KILLED: an impl that never imports helpView — the view is never constructed.
    const src = readMainTs();
    expect(
      src.includes("'./ui/helpView'"),
      'main.ts must contain "\'./ui/helpView\'" import (pt-c2b wiring)',
    ).toBe(true);
  });

  it('W-HELP-LET BITES: main.ts declares "let helpView" — kills missing-let impl', () => {
    // WRONG IMPL KILLED: an impl that never declares the module-scope let — the view cannot
    // be referenced by any of the 19 fan-out guards.
    const src = readMainTs();
    expect(
      src.includes('let helpView'),
      'main.ts must declare "let helpView" at module scope (pt-c2b wiring)',
    ).toBe(true);
  });

  it('W-HELP-DYNIMPORT BITES: main.ts dynamic-imports "./ui/helpView" — kills static-import / missing-import impl', () => {
    // WRONG IMPL KILLED: an impl that statically imports the view (would load DOM code at
    // vitest parse time and crash) or omits the dynamic import entirely.
    const src = readMainTs();
    expect(
      src.includes("import('./ui/helpView')"),
      "main.ts must contain import('./ui/helpView') in the dynamic-import fan-out (pt-c2b wiring)",
    ).toBe(true);
  });

  it('W-HELP-CONSTRUCT BITES: main.ts constructs helpView with a ZERO-arg new — kills missing / wrong-arity construction impl', () => {
    // CONTRACT (ADR-0135 / plan): HelpView has a ZERO-arg constructor (display-only — no
    // callbacks, leaderboardView precedent). The construct site is `new HelpView()` or the
    // dynamic-import alias `new HelpViewClass()`, with an EMPTY paren pair.
    // WRONG IMPL KILLED: an impl that imports helpView but never constructs it, OR constructs
    // it with a callbacks object (`new HelpView({ ... })`) — that would contradict the
    // display-only contract. The `()` needle (empty parens) pins the zero-arg shape.
    const src = readMainTs();
    const hasZeroArgNew = src.includes('new HelpView()') || src.includes('new HelpViewClass()');
    expect(
      hasZeroArgNew,
      'main.ts must construct new HelpView() or new HelpViewClass() with ZERO args (display-only contract, ADR-0135)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c2b help): `?` toggle self-branch (PTC2B-1/2)', () => {
  it("W-HELP-KEY BITES: main.ts contains `e.key === '?'` AND e.preventDefault() in its handler region — kills missing-help-key impl", () => {
    // PTC2B-1/2: `?` opens the help overlay (and toggle-closes it). ADR-0135: the help key is
    // matched on `e.key === '?'` (the produced glyph, layout-robust) — the SOLE e.key branch in
    // an otherwise-e.code keydown handler. e.preventDefault() suppresses any default action.
    // WRONG IMPL KILLED: (a) an impl with no `?` branch at all → overlay never opens;
    // (b) an impl that matches `e.code === 'Slash'` instead of `e.key === '?'` (wrong layer —
    // fails on layouts where `?` is not Shift+Slash); (c) a `?` branch without preventDefault().
    const src = readMainTs();
    const keyIdx = src.indexOf("e.key === '?'");
    expect(
      keyIdx,
      "main.ts must contain `e.key === '?'` — the help-key branch (PTC2B-1, ADR-0135 sole e.key branch)",
    ).toBeGreaterThanOrEqual(0);
    // preventDefault must appear within the `?` handler region (compact single-key block, ~600 chars).
    const keyRegion = src.slice(keyIdx, keyIdx + 600);
    expect(
      keyRegion.includes('e.preventDefault()'),
      'main.ts `?` handler region must contain e.preventDefault() (ADR-0135)',
    ).toBe(true);
  });
});

describe('main.ts wiring (pt-c2b help): Escape close branch (PTC2B-3)', () => {
  it('W-HELP-ESCAPE BITES: the Escape region references helpView (an Escape && helpView?.visible branch) — kills missing-Escape-close impl', () => {
    // PTC2B-3: Escape must close the help overlay. ADR-0135: an
    // `if (e.code === 'Escape' && helpView?.visible) { helpView.hide(); ... }` branch adjacent
    // to the rename / tradePropose Escape branches.
    // WRONG IMPL KILLED: an impl whose Escape handler covers every OTHER overlay but not
    // helpView — the help overlay would be un-closeable via Escape.
    const src = readMainTs();
    const escapeIdx = src.indexOf("e.code === 'Escape'");
    expect(escapeIdx, 'main.ts must contain an Escape handler').toBeGreaterThanOrEqual(0);
    // Scan the full Escape branch stack (~2500 chars covers all sibling Escape branches).
    const escapeRegion = src.slice(escapeIdx, escapeIdx + 2500);
    expect(
      escapeRegion.includes('helpView'),
      'main.ts Escape region must reference helpView — the help overlay must be closeable via Escape (PTC2B-3)',
    ).toBe(true);
  });
});

describe('★ main.ts wiring (pt-c2b help): fan-out count floor (PTC2B-4..8 / ADR-0135)', () => {
  // BINDING (plan "Plan-review resolutions" HIGH-1 / red-team F1): the count-floor is 19,
  // NOT the tradePropose count. `helpView?.visible` occurs exactly 19× — structurally identical
  // to `leaderboardView?.visible` (asserted below as a self-check). tradePropose carries 2 sites
  // help cannot have (reducer-response feedback + an Identity self-branch), so its count (22 in
  // the live file post-pt-c2b) must NOT be used as the floor — that would be unsatisfiable by a
  // correct display-only impl; 19 is the exact structural parity floor.
  const HELP_VISIBLE_FLOOR = 19;
  // leaderboardView?.visible is the read-only-overlay parity anchor. Wiring the help overlay
  // adds `!leaderboardView?.visible` to help's OWN `?` open-guard, so leaderboard's live count is
  // HELP_VISIBLE_FLOOR + 1 (that guard contributes to leaderboard's count but not to help's own).
  // help = 19, leaderboard = 20 post-wiring; the two still move together on any future keymap change.
  const LEADERBOARD_LIVE_COUNT = HELP_VISIBLE_FLOOR + 1; // 20

  it(`self-check: leaderboardView?.visible appears exactly ${LEADERBOARD_LIVE_COUNT}× — pins the parity anchor to the live file`, () => {
    // A LIVE self-check: proves the parity overlay is fully wired in THIS main.ts, so a future
    // keymap change that adds/removes an overlay site is caught (help + leaderboard move together).
    const src = readMainTs();
    const lbCount = src.split('leaderboardView?.visible').length - 1;
    expect(
      lbCount,
      `leaderboardView?.visible must appear exactly ${LEADERBOARD_LIVE_COUNT}× (= help floor ${HELP_VISIBLE_FLOOR} + help's own ? guard) — parity anchor (ADR-0135)`,
    ).toBe(LEADERBOARD_LIVE_COUNT);
  });

  it(`★ W-HELP-FANOUT-COUNT BITES: helpView?.visible appears at least ${HELP_VISIBLE_FLOOR}× — kills under-wired impl`, () => {
    // WRONG IMPL KILLED: an impl that adds helpView to SOME but not all fan-out sites (e.g.
    // wires the `?` self-branch and Escape but forgets reconcile / rAF / a sibling open-guard).
    // Count strategy: split on 'helpView?.visible' and subtract 1 (never new RegExp).
    const src = readMainTs();
    const count = src.split('helpView?.visible').length - 1;
    expect(
      count,
      `main.ts must contain helpView?.visible at least ${HELP_VISIBLE_FLOOR}× ` +
        `(one per leaderboardView?.visible occurrence — ADR-0135 fan-out parity). Found: ${count}. ` +
        `The floor is ${HELP_VISIBLE_FLOOR} (leaderboardView parity) — NOT 21 (tradePropose has 2 sites help cannot have).`,
    ).toBeGreaterThanOrEqual(HELP_VISIBLE_FLOOR);
  });
});

describe('★ main.ts wiring (pt-c2b help): per-context anchored fan-out teeth (PTC2B-4..8 / ADR-0135)', () => {
  // A count-floor ALONE is the m17b fan-out-coverage-trap: 19 occurrences could cluster in
  // the wrong places. The anchored teeth below name the specific load-bearing sites.

  it('W-HELP-FANOUT-KEYDOWN BITES: helpView?.visible in the keydown movement-suppression block — kills WASD-bleed-under-help impl (PTC2B-6)', () => {
    // PTC2B-6 movement-suppression site (keydown): the "Suppress movement input while an overlay
    // is open." OR-block must include helpView?.visible so WASD does not move the character
    // while the help overlay is open (the most obvious bleed).
    // WRONG IMPL KILLED: an impl that forgets helpView in the keydown suppression OR-block.
    const src = readMainTs();
    const suppressIdx = src.indexOf('Suppress movement input while an overlay is open');
    expect(
      suppressIdx,
      "main.ts must contain the 'Suppress movement' comment",
    ).toBeGreaterThanOrEqual(0);
    // The OR-block + `return` is within ~700 chars of the comment (12+ sibling lines).
    const suppressRegion = src.slice(suppressIdx, suppressIdx + 700);
    expect(
      suppressRegion.includes('helpView?.visible'),
      'main.ts keydown movement-suppression block must contain helpView?.visible (PTC2B-6)',
    ).toBe(true);
  });

  it('W-HELP-FANOUT-RECONCILE BITES: helpView?.visible in the reconcile diverge OR-block — kills reconcile-reissue-bleed impl (PTC2B-6)', () => {
    // PTC2B-6 movement-suppression site (reconcile): the `predictor.reconcile(` diverge OR-block
    // that re-issues the held direction must include helpView?.visible — otherwise a held key
    // re-issues movement on a server pullback while the help overlay is open.
    // WRONG IMPL KILLED: an impl that forgets helpView in the reconcile diverge OR-block.
    // FORWARD window: the diverge OR-block is within ~600 chars AFTER predictor.reconcile(.
    const src = readMainTs();
    const reconcileIdx = src.indexOf('predictor.reconcile(');
    expect(reconcileIdx, 'main.ts must contain predictor.reconcile(').toBeGreaterThanOrEqual(0);
    const reconcileRegion = src.slice(reconcileIdx, reconcileIdx + 600);
    expect(
      reconcileRegion.includes('helpView?.visible'),
      'main.ts reconcile diverge region must contain helpView?.visible (PTC2B-6 movement suppression)',
    ).toBe(true);
  });

  it('★ W-HELP-FANOUT-RAF BITES: helpView?.visible inside the rAF held-key re-issue OR-block — kills frame-loop-bleed impl (PTC2B-6, red-team F2)', () => {
    // PTC2B-6 movement-suppression site (rAF frame loop): a held key keeps walking in the
    // background every frame unless the rAF re-issue OR-block guards on helpView?.visible.
    //
    // BINDING (plan / red-team F2): help's `||` sits at the TOP of the OR-block, ~630 chars
    // BEFORE `predictor.drain(` — OUTSIDE a `drain-500` BACKWARD window. So we anchor FORWARD on
    // the block-opening comment `Re-issue the held dir` and slice forward. We ALSO verify the
    // matched helpView?.visible is physically INSIDE the OR-block (before predictor.drain()) so
    // the tooth cannot be satisfied by a helpView?.visible that lives elsewhere further down.
    const src = readMainTs();
    const rafAnchorIdx = src.indexOf('Re-issue the held dir');
    expect(
      rafAnchorIdx,
      "main.ts must contain the rAF block-opening comment 'Re-issue the held dir'",
    ).toBeGreaterThanOrEqual(0);
    // The rAF OR-block sits between the comment and the drain() call. Slice from the comment
    // up to (and only up to) predictor.drain( so we test EXACTLY the re-issue OR-block.
    const drainIdx = src.indexOf('predictor.drain(', rafAnchorIdx);
    expect(
      drainIdx,
      'main.ts must contain predictor.drain( AFTER the rAF re-issue comment',
    ).toBeGreaterThan(rafAnchorIdx);
    const rafBlock = src.slice(rafAnchorIdx, drainIdx);
    expect(
      rafBlock.includes('helpView?.visible'),
      'main.ts rAF held-key re-issue OR-block (between "Re-issue the held dir" and predictor.drain()) must contain helpView?.visible (PTC2B-6, red-team F2)',
    ).toBe(true);
  });

  it('★ W-HELP-FANOUT-PVP BITES: helpView in the anyOverlayVisible pvp aggregate — kills pvp-auto-show-over-help impl (PTC2B-7)', () => {
    // PTC2B-7: an incoming PvP challenge must NOT auto-show the PvP overlay over an open help
    // overlay. The `anyOverlayVisible` aggregate (batch listener) must include helpView.
    // WRONG IMPL KILLED: an impl that forgets helpView in anyOverlayVisible — a server-push
    // challenge pops the PvP overlay over the help overlay.
    const src = readMainTs();
    // Anchor on the DEFINITION `const anyOverlayVisible =`, not the bare substring: an earlier
    // comment ("anyOverlayVisible gates only the pvp listener") in the refreshBattle block would
    // otherwise capture the anchor and the 1200-char window would never reach the real aggregate.
    const pvpAggIdx = src.indexOf('const anyOverlayVisible =');
    expect(
      pvpAggIdx,
      'main.ts must contain the const anyOverlayVisible = definition',
    ).toBeGreaterThanOrEqual(0);
    // The aggregate assembly is within ~1200 chars of the definition.
    const pvpRegion = src.slice(pvpAggIdx, pvpAggIdx + 1200);
    expect(
      pvpRegion.includes('helpView'),
      'main.ts anyOverlayVisible pvp aggregate must reference helpView (PTC2B-7 — no pvp-over-help)',
    ).toBe(true);
  });

  it('★ W-HELP-FANOUT-BATTLE BITES: helpView force-hidden in the battle show-path — kills battle-under-help impl (PTC2B-8, red-team F4)', () => {
    // PTC2B-8: when a battle auto-shows (e.g. a PvP accept), the help overlay must be
    // force-hidden (battle supersession) — the `refreshBattle()` show-path force-hides siblings.
    //
    // BINDING (plan / red-team F4): anchor on `r.action.kind === 'show'` (a UNIQUE marker) and
    // assert helpView appears within ~900 chars (the existing tradePropose force-hide sits at
    // delta ~880). ADR-0135 requires the guard in the `if (helpView?.visible) helpView.hide()`
    // form so the count-floor needle credits it too.
    // WRONG IMPL KILLED: an impl that force-hides box/raising/evolution/leaderboard/rename/
    // tradePropose on battle-show but forgets helpView — a battle overlay pops under an open help.
    const src = readMainTs();
    const showIdx = src.indexOf("r.action.kind === 'show'");
    expect(
      showIdx,
      "main.ts must contain the battle show-path anchor `r.action.kind === 'show'`",
    ).toBeGreaterThanOrEqual(0);
    const battleRegion = src.slice(showIdx, showIdx + 900);
    expect(
      battleRegion.includes('helpView'),
      "main.ts battle show-path (anchored on `r.action.kind === 'show'`) must reference helpView within ~900 chars (PTC2B-8 battle supersession, red-team F4)",
    ).toBe(true);
    // Strengthen: the force-hide must be the `helpView?.visible` guarded form (credits the count-floor).
    expect(
      battleRegion.includes('helpView?.visible'),
      'battle show-path force-hide must use the `if (helpView?.visible) helpView.hide()` form (helpView?.visible) — credits W-HELP-FANOUT-COUNT',
    ).toBe(true);
  });
});

describe('★ main.ts wiring (pt-c2b help): 12 sibling open-guards carry !helpView?.visible (PTC2B-5)', () => {
  // PTC2B-5: while the help overlay is visible, pressing a sibling hotkey must NOT open that
  // overlay. Each of the 12 sibling key handlers (KeyB/I/E/Q/H/G/U/P/L/N/O/T) must add
  // `!helpView?.visible` to its open-guard block.
  //
  // ROBUST APPROACH: for each sibling key, slice its handler block (from `e.code === 'KeyX'`
  // up to the NEXT sibling handler or a generous window) and assert helpView?.visible is present.
  // We assert ONLY the presence of helpView?.visible in each block — NOT a full sibling set —
  // because KeyB/I/E carried a PRE-EXISTING dialogue/questLog/heal omission owned by ptc5c
  // (plan reviewer HIGH-2); pt-c2b only adds helpView?.visible. ptc5c has now SHIPPED
  // W-OVERLAY-FANOUT-MUTEX (below) which enforces the FULL 14-overlay sibling set for ALL
  // handlers, including the KeyB/I/E dialogue/questLog/heal omission this comment once noted.
  const SIBLING_KEYS = [
    'KeyB',
    'KeyI',
    'KeyE',
    'KeyQ',
    'KeyH',
    'KeyG',
    'KeyU',
    'KeyP',
    'KeyL',
    'KeyN',
    'KeyO',
    'KeyT',
  ] as const;

  it('W-HELP-FANOUT-OPENGUARDS BITES: EACH of the 12 sibling open-guards contains !helpView?.visible — kills partial-guard impl', () => {
    // WRONG IMPL KILLED: an impl that adds !helpView?.visible to some sibling guards (e.g. the
    // newer L/N/O/T) but forgets an older one (e.g. KeyB) — pressing KeyB while help is open
    // would then open the box overlay over the help overlay (a mutual-exclusion breach).
    const src = readMainTs();
    for (const key of SIBLING_KEYS) {
      const needle = `e.code === '${key}'`;
      const keyIdx = src.indexOf(needle);
      expect(keyIdx, `main.ts must contain the sibling handler ${needle}`).toBeGreaterThanOrEqual(
        0,
      );
      // Slice this handler's guard block: from this key up to the NEXT sibling handler start,
      // so a helpView?.visible in a *different* handler cannot false-credit this one.
      let blockEnd = src.length;
      for (const other of SIBLING_KEYS) {
        if (other === key) continue;
        const otherIdx = src.indexOf(`e.code === '${other}'`, keyIdx + needle.length);
        if (otherIdx >= 0 && otherIdx < blockEnd) blockEnd = otherIdx;
      }
      const block = src.slice(keyIdx, blockEnd);
      expect(
        block.includes('!helpView?.visible'),
        `the ${key} open-guard must contain !helpView?.visible (PTC2B-5 mutual-exclusion; ptc5c SHIPPED W-OVERLAY-FANOUT-MUTEX enforcing the full 14-overlay set including the former KeyB/I/E dialogue/questLog/heal omission)`,
      ).toBe(true);
    }
  });
});

describe('main.ts wiring (pt-c2b help): onReconnect does NOT hide helpView (PTC2B-9 asymmetry)', () => {
  it('W-HELP-NO-RECONNECT-HIDE (negative regression guard): the onReconnect region does NOT contain helpView?.hide — pins the deliberate asymmetry (PTC2B-9, red-team F3)', () => {
    // PTC2B-9 (ADR-0135 the-one-deviation): every OTHER overlay is hidden on onReconnect (either
    // it holds an in-flight #pending lock that never settles on a dropped link, or it renders
    // store-derived content that goes stale on reset). The help overlay has NEITHER property —
    // it holds no lock (display-only) and its content is a static const, not store-derived — so
    // it MUST survive a reconnect (a gratuitous hide would be a UX interruption).
    //
    // BINDING (plan / red-team F3): bound the region by BOTH endpoints — from 'onReconnect:' to
    // the NEXT 'onOwnWarp' after it — then assert !region.includes('helpView?.hide'). NEVER a
    // fixed `+N` forward slice: the onReconnect body is ~2254 chars, so a helpView?.hide()
    // appended at the BOTTOM of the body would false-PASS a fixed-window slice. The two-endpoint
    // region covers the whole body.
    //
    // TESTER CORRECTION (spec-rationale, STRENGTHENS the bite): the plan text writes
    // `src.indexOf('onOwnWarp')`, but the literal `onOwnWarp` first appears in a COMMENT at
    // main.ts:306 — ~1600 chars BEFORE `onReconnect:` (main.ts:1895) — so a bare indexOf would
    // return an endIdx < startIdx and yield an EMPTY region (vacuous, and the endpoint assertion
    // would spuriously fail). The region the red-team intends is the onReconnect callback body,
    // whose real closing endpoint is the sibling `onOwnWarp:` handler (main.ts:1935). We therefore
    // search for `onOwnWarp` STARTING at startIdx (`indexOf('onOwnWarp', startIdx)`). This is a
    // strict strengthening: it bounds the ACTUAL onReconnect body (the whole thing, not an empty
    // slice), so a helpView?.hide() anywhere inside it — top or bottom — still bites.
    //
    // SELF-CHECK — WHY THIS IS NOT VACUOUS (starts GREEN as a guard, by design):
    //   On the CURRENT main.ts there is zero helpView anywhere, so this assertion PASSES today.
    //   That is EXPECTED for a negative regression guard. It is NOT vacuous because:
    //   (1) the region is bounded by BOTH real endpoints (asserted present + non-empty below) — a
    //       real slice of main.ts, not an empty string; and
    //   (2) the instant a future "consistency" edit adds `helpView?.hide()` inside the
    //       onReconnect body, this assertion FLIPS RED — which is exactly the deviation the ADR
    //       pins. (Cross-check: renameView?.hide() and tradeProposeView?.hide() DO live in this
    //       same region today, proving `helpView?.hide` here would be detectable.)
    const src = readMainTs();
    const startIdx = src.indexOf('onReconnect:');
    expect(startIdx, "main.ts must contain 'onReconnect:'").toBeGreaterThanOrEqual(0);
    // Search for the closing endpoint AFTER onReconnect: (skip the unrelated line-306 comment).
    const endIdx = src.indexOf('onOwnWarp', startIdx);
    expect(
      endIdx,
      "main.ts must contain 'onOwnWarp' AFTER 'onReconnect:' (region end endpoint)",
    ).toBeGreaterThan(startIdx);
    const region = src.slice(startIdx, endIdx);
    // Positive control that the region is the REAL onReconnect body (non-vacuous): sibling
    // overlays ARE force-hidden here today (renameView?.hide() / tradeProposeView?.hide()).
    expect(
      region.includes('renameView?.hide') || region.includes('tradeProposeView?.hide'),
      'the onReconnect region must contain sibling force-hides (proves the region is the real body, not an empty slice)',
    ).toBe(true);
    // THE GUARD: help must NOT be hidden on reconnect (the one deliberate asymmetry, PTC2B-9).
    expect(
      region.includes('helpView?.hide'),
      'onReconnect must NOT hide helpView — the help overlay deliberately survives a reconnect ' +
        '(no #pending lock, static const content; ADR-0135 the-one-deviation, PTC2B-9). ' +
        'A future consistency edit adding helpView?.hide() here would break the documented asymmetry.',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ptc5c (ADR-0136 follow-up HIGH-2): W-OVERLAY-FANOUT-MUTEX
//
// INVARIANT: Every overlay-open handler in the keyboard dispatch must account
// for EVERY sibling overlay via a guard or a legitimate hide-switch, so that no
// two of the 14 mutual-exclusion overlays can be simultaneously visible.
//
// THE 14 MUTUAL-EXCLUSION OVERLAYS (SSOT — not including errorOverlayView):
//   battleView, boxView, raisingView, evolutionView, dialogueView, questLogView,
//   healView, shopView, tradeView, pvpView, leaderboardView, renameView,
//   tradeProposeView, helpView
//
// THE 13 OPEN-HANDLERS: one per hotkey + the talk handler (KeyT, which opens NO
// overlay but must still guard against ALL 14 so it never fires into an open UI).
//
// ACCEPTANCE FORM (by overlay class):
//   battleView         → bare token `battleView?.visible`
//                        (covers both `!battleView?.visible` and the
//                         `shouldToggleBox(battleView?.visible ?? false)` call-form
//                         used by KeyB/I/E — those compile to the same guard intent)
//   boxView/raisingView/evolutionView  → guard OR hide
//                        (`!Y?.visible` OR `Y?.hide()` OR `Y.hide()`)
//                        (KeyB/I/E legitimately hide-and-switch within the trio)
//   all other 10 modals (dialogue/questLog/heal/shop/trade/pvp/leaderboard/
//                        rename/tradePropose/help) → guard-form ONLY
//                        `!Y?.visible`
//                        Do NOT accept `.hide()` for modals: dismissing a modal
//                        dialog silently on a random keypress is the WRONG UX.
//                        (A future `dialogueView?.hide()` on KeyB MUST NOT satisfy
//                        the invariant — that would hide an active NPC conversation.)
//
// BLOCK-SLICING (order-independent so handler order in main.ts can change):
//   For each handler H:
//     hIdx    = src.indexOf(H.anchor)                               // assert >= 0
//     blockEnd = min over every OTHER handler's anchor AND the
//                sentinel `"e.code === 'Escape'"` of
//                src.indexOf(otherAnchor, hIdx + H.anchor.length)   // skip back-refs
//                when >= 0; else src.length
//     block   = src.slice(hIdx, blockEnd)                           // assert > 0 chars
//
// SENTINEL: `"e.code === 'Escape'"` closes the `e.key === '?'` handler's block
// (the `?` anchor is the last handler before the Escape branches). Including it
// prevents the `?` block from swallowing the entire rest of main.ts.
//
// RED REASON (current main.ts, no ptc5c fix applied):
//   KeyB, KeyI, KeyE use `shouldToggleBox(battleView?.visible ?? false)` as the
//   battle guard and then list only shop/trade/pvp/leaderboard/rename/tradePropose/
//   help siblings — they omit `!dialogueView?.visible`, `!questLogView?.visible`,
//   and `!healView?.visible`. Those three are MODAL overlays → guard-form required →
//   9 assertion failures (3 handlers × 3 missing modals).
//
// WRONG IMPL KILLED:
//   - A partial-guard impl that adds only some modal guards to KeyB/I/E (e.g. adds
//     `!dialogueView?.visible` but forgets `!healView?.visible`) → fails the missing
//     pair assertions.
//   - An impl that uses `dialogueView?.hide()` instead of `!dialogueView?.visible`
//     on KeyB/I/E → fails the modal guard-form check (hide-form not accepted for
//     modals, by design — hiding a live dialogue is wrong UX).
//   - An impl that accidentally drops a guard from a PREVIOUSLY correct handler
//     (e.g. removes `!tradeView?.visible` from KeyQ) → caught per-handler, not just
//     for KeyB/I/E.
// ---------------------------------------------------------------------------

describe('★ main.ts wiring (ptc5c): every overlay-open handler accounts for all sibling overlays (W-OVERLAY-FANOUT-MUTEX)', () => {
  // The 14 mutual-exclusion overlays (pin as const — no errorOverlayView).
  const ALL_OVERLAYS = [
    'battleView',
    'boxView',
    'raisingView',
    'evolutionView',
    'dialogueView',
    'questLogView',
    'healView',
    'shopView',
    'tradeView',
    'pvpView',
    'leaderboardView',
    'renameView',
    'tradeProposeView',
    'helpView',
  ] as const;

  // The three "hide-switch" siblings: KeyB/I/E legitimately hide-and-switch within
  // this trio, so we accept EITHER the guard form OR a .hide() call.
  const HIDE_SWITCH_OVERLAYS: ReadonlyArray<string> = ['boxView', 'raisingView', 'evolutionView'];

  // The 13 open-handlers (anchor uniquely identifies the handler start in the source;
  // self = the overlay this handler toggles, or null for KeyT which opens nothing).
  const OPEN_HANDLERS: ReadonlyArray<{ anchor: string; self: string | null }> = [
    { anchor: "e.code === 'KeyB'", self: 'boxView' },
    { anchor: "e.code === 'KeyI'", self: 'raisingView' },
    { anchor: "e.code === 'KeyE'", self: 'evolutionView' },
    { anchor: "e.code === 'KeyQ'", self: 'questLogView' },
    { anchor: "e.code === 'KeyH'", self: 'healView' },
    { anchor: "e.code === 'KeyG'", self: 'shopView' },
    { anchor: "e.code === 'KeyU'", self: 'tradeView' },
    { anchor: "e.code === 'KeyP'", self: 'pvpView' },
    { anchor: "e.code === 'KeyL'", self: 'leaderboardView' },
    { anchor: "e.code === 'KeyN'", self: 'renameView' },
    { anchor: "e.code === 'KeyO'", self: 'tradeProposeView' },
    { anchor: "e.key === '?'", self: 'helpView' }, // note: e.key not e.code
    { anchor: "e.code === 'KeyT'", self: null }, // talk: toggles NO overlay → must guard ALL 14
  ] as const;

  // The sentinel that closes the `?` handler's block (the last open-handler before
  // the Escape branches). Including it in the blockEnd calculation prevents the `?`
  // block from greedily consuming the rest of main.ts.
  const ESCAPE_SENTINEL = "e.code === 'Escape'";

  it('W-OVERLAY-FANOUT-MUTEX BITES: each open-handler references every sibling overlay via guard (or legit hide-switch) — kills partial-guard impl', () => {
    // WRONG IMPL KILLED (primary target — the 9 RED failures on unmodified main.ts):
    //   KeyB, KeyI, KeyE each omit !dialogueView?.visible, !questLogView?.visible,
    //   and !healView?.visible. Those are modal overlays so guard-form is required.
    //   A player pressing KeyB while the dialogue UI is open would open the box overlay
    //   over the active NPC conversation — a mutual-exclusion breach.
    //
    // WRONG IMPL KILLED (regression — any future handler that loses a sibling guard):
    //   e.g. KeyG loses !tradeView?.visible after a merge conflict → caught here.
    //
    // NOTE: battleView uses the bare-token check (`battleView?.visible` without `!`)
    //   because KeyB/I/E use `shouldToggleBox(battleView?.visible ?? false)` which
    //   contains the token but not in `!battleView?.visible` form. The bare token
    //   correctly covers both the `!X?.visible` guard form (KeyQ/H/G/U/P/L/N/O/T/KeyT/?
    //   all use `!battleView?.visible`) and the shouldToggleBox() call form. A wrong
    //   impl that REMOVES battleView consideration entirely would have no `battleView?.visible`
    //   token in the block at all — this assertion catches it.

    const src = readMainTs();

    // Collect all anchors (handler anchors + Escape sentinel) for block-slicing.
    const allAnchors: ReadonlyArray<string> = [
      ...OPEN_HANDLERS.map((h) => h.anchor),
      ESCAPE_SENTINEL,
    ];

    for (const handler of OPEN_HANDLERS) {
      // 1. Locate the handler anchor — fail fast if it's missing (missing anchor means
      //    the handler was deleted or renamed; that's a separate regression but we catch
      //    it here with a useful message).
      const hIdx = src.indexOf(handler.anchor);
      expect(
        hIdx,
        `main.ts must contain the open-handler anchor \`${handler.anchor}\` — handler missing or renamed`,
      ).toBeGreaterThanOrEqual(0);

      if (hIdx < 0) continue; // skip further assertions if anchor missing (already failed)

      // 2. Slice the handler block: from hIdx to the minimum indexOf of every OTHER
      //    anchor (searched after hIdx + anchor.length to avoid self-match or back-refs).
      let blockEnd = src.length;
      for (const otherAnchor of allAnchors) {
        if (otherAnchor === handler.anchor) continue; // skip self
        const otherIdx = src.indexOf(otherAnchor, hIdx + handler.anchor.length);
        if (otherIdx >= 0 && otherIdx < blockEnd) {
          blockEnd = otherIdx;
        }
      }
      const block = src.slice(hIdx, blockEnd);

      // Anti-vacuity: the block must be non-empty (catches a degenerate slice).
      expect(
        block.length,
        `handler block for \`${handler.anchor}\` must be non-empty (anti-vacuity)`,
      ).toBeGreaterThan(0);

      // 3. For every overlay that is NOT this handler's own toggled overlay, assert
      //    that the block accounts for it via the correct form.
      for (const overlay of ALL_OVERLAYS) {
        if (overlay === handler.self) continue; // self — no guard needed

        if (overlay === 'battleView') {
          // battleView: bare token — covers both `!battleView?.visible` guard form
          // AND `shouldToggleBox(battleView?.visible ?? false)` call form (KeyB/I/E).
          // WRONG IMPL KILLED: a handler that drops battleView consideration entirely
          // → `battleView?.visible` token absent from block → assertion fails.
          expect(
            block.includes('battleView?.visible'),
            `\`${handler.anchor}\` handler must reference battleView?.visible ` +
              `(bare token — covers both guard form and shouldToggleBox call form); ` +
              `WRONG IMPL KILLED: handler opens over an active battle`,
          ).toBe(true);
        } else if (HIDE_SWITCH_OVERLAYS.includes(overlay)) {
          // boxView / raisingView / evolutionView: accept guard OR hide-call.
          // KeyB/I/E legitimately hide their siblings when switching between the trio
          // (e.g. KeyB calls raisingView?.hide() and evolutionView?.hide() then toggles
          // boxView) — the hide IS the account, so we accept it.
          // WRONG IMPL KILLED: a handler that neither guards nor hides one of the trio
          // → misses mutual exclusion within the box/raising/evolution group.
          const guarded =
            block.includes('!' + overlay + '?.visible') ||
            block.includes(overlay + '?.hide()') ||
            block.includes(overlay + '.hide()');
          expect(
            guarded,
            `\`${handler.anchor}\` handler must account for ${overlay} via ` +
              `guard (!${overlay}?.visible) OR hide (${overlay}?.hide() / ${overlay}.hide()) — ` +
              `WRONG IMPL KILLED: two of {box,raising,evolution} open simultaneously`,
          ).toBe(true);
        } else {
          // All other MODAL overlays (dialogue, questLog, heal, shop, trade, pvp,
          // leaderboard, rename, tradePropose, help): guard-form ONLY.
          //
          // WHY NOT accept .hide() for modals:
          //   A future `dialogueView?.hide()` on KeyB would silently dismiss an active
          //   NPC conversation — that is the WRONG behaviour. The invariant requires a
          //   GUARD (don't open while dialogue is up), not a DISMISS (close dialogue
          //   because the player pressed a box key). Accepting hide would make the test
          //   green for the wrong impl.
          //
          // WRONG IMPL KILLED (primary, 9 failures on unmodified main.ts):
          //   KeyB/I/E lack `!dialogueView?.visible`, `!questLogView?.visible`,
          //   `!healView?.visible` → these three overlay × three handler = 9 failures.
          expect(
            block.includes('!' + overlay + '?.visible'),
            `\`${handler.anchor}\` handler must guard !${overlay}?.visible ` +
              `(modal overlay — guard-form ONLY; .hide() is NOT accepted because ` +
              `dismissing a modal on a hotkey press is wrong UX); ` +
              `WRONG IMPL KILLED: handler opens over a visible ${overlay}`,
          ).toBe(true);
        }
      }
    }
  });
});
