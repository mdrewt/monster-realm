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
// uxd3 (ADR-0162): W-ONE-CORNER-AFFORDANCE parses the REAL client/index.html with a real HTML
// parser (both target divs spread `id`/`style` across several lines, so a line regex would miss
// them — see plan A10 / reviewer L5). This file's vitest environment is `node`, and the
// `@vitest-environment happy-dom` docblock is FILE-scoped — flipping it would change the
// environment for all ~90 pre-existing node-only source-scan teeth in this file for the sake of
// one test. Importing the detached `Window` gives us the same `DOMParser` that
// client/src/indexShell.test.ts uses, with zero blast radius. (indexShell.test.ts is OUT of this
// slice's touch-set; its parseIndexHtml()/normalisedStyle() helpers are re-implemented locally
// below rather than exported/shared, deliberately.)
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
// uxd3-b (ADR-0163): W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY Part B needs the manifest as a
// STATIC import so the probe-table check is BIDIRECTIONAL and cannot drift — a 16th OVERLAY_IDS
// member with no probe entry reds, and a 16th probe entry with no manifest member reds too.
// A static import is safe here where W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST (~:4810) had to use
// a dynamic one: that tooth was authored while `./ui/overlayRegistry` did not exist yet, so a
// static import would have failed module RESOLUTION and reded the COLLECTION of this whole file.
// uxd3-a landed the module, so the resolution hazard is gone.
// uxd3-c (ADR-0164): W-UXD3C-HANDLE-TABLE needs NEVER_FORCE_HIDE as a second static import,
// bidirectional alongside OVERLAY_IDS, for the same reason OVERLAY_IDS is static (see above).
import { NEVER_FORCE_HIDE, OVERLAY_IDS } from './ui/overlayRegistry';

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
  // uxd3-b (ADR-0163): the five OR-list fan-out teeth that used to live here retired with the
  // surfaces they scanned — those reads now go through the ONE probe table
  // (W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY). The reconnect tooth below is unaffected: it
  // scans onReconnect, which uxd3-b does not touch.
  it('W-RN-FANOUT-RECONNECT BITES: renameView?.hide() called in onReconnect — kills stale-overlay-on-reconnect impl (RT-RN-02)', () => {
    // ADR-0133 D4: the reconnect stale-overlay hide must cover renameView.
    // RT-RN-02: on reconnect the rename overlay must close (store reset; stale state).
    // WRONG IMPL KILLED: an impl that hides shop/trade/pvp/leaderboard on reconnect but
    // forgets renameView — the overlay could stay open with a stale in-flight lock.
    //
    // uxd3-c re-anchor (ADR-0163 D7, task T1a — lands BEFORE any main.ts edit, and MUST stay
    // GREEN on the UNMODIFIED tree). The OLD anchor sliced a FIXED `reconnectIdx + 800` window
    // (~131 chars of headroom on the pre-uxd3-c tree). uxd3-c's E3 handle table introduces new
    // `renameView?.hide()`-shaped call sites elsewhere in the file and a future insertion above
    // this call inside onReconnect is exactly the class of edit a fixed window cannot survive.
    // Re-anchored onto the SAME two endpoints `W-HELP-NO-RECONNECT-HIDE` (:1259) and
    // `W-RECONNECT-HIDES-MENU` (:4443) already use: `onReconnect:` -> the NEXT `onOwnWarp`
    // searched FROM startIdx (a bare `indexOf('onOwnWarp')` resolves to an unrelated comment
    // BEFORE `onReconnect:` and would yield an empty/negative region).
    const src = readMainTs();
    const startIdx = src.indexOf('onReconnect:');
    expect(startIdx, "main.ts must contain 'onReconnect:'").toBeGreaterThanOrEqual(0);
    const endIdx = src.indexOf('onOwnWarp', startIdx);
    expect(
      endIdx,
      "main.ts must contain 'onOwnWarp' AFTER 'onReconnect:' (region end endpoint) — a bare " +
        'indexOf would resolve to the unrelated comment BEFORE onReconnect and yield an empty region',
    ).toBeGreaterThan(startIdx);
    const reconnectRegion = src.slice(startIdx, endIdx);
    // Strengthened from the bare identifier `renameView` to the CALL form `renameView?.hide()`:
    // a guard-only `!renameView?.visible` living in this region would not satisfy this positive
    // control, and the region now spans the WHOLE onReconnect body so this bites regardless of
    // where in the body the call lives.
    expect(
      reconnectRegion.includes('renameView?.hide()'),
      'main.ts onReconnect body must call renameView?.hide() — hide it on reconnect (RT-RN-02, ' +
        'ADR-0133 D4)',
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
    //
    // uxd3-c re-anchor (ADR-0163 D7, task T1a — lands BEFORE any main.ts edit, and MUST stay
    // GREEN on the UNMODIFIED tree). The OLD anchor sliced a FIXED `reconnectIdx + 1000` window.
    // `tradeProposeView?.hide()` sits at delta ~978 on the pre-uxd3-c tree — ~22 characters of
    // headroom — and on failure it named *tradePropose* rather than the real culprit (an
    // insertion ABOVE it inside onReconnect, e.g. uxd3's `menuView?.hide()` line). Re-anchored
    // onto the SAME two endpoints `W-HELP-NO-RECONNECT-HIDE` (:1259) and `W-RECONNECT-HIDES-MENU`
    // (:4443) already use: `onReconnect:` -> the NEXT `onOwnWarp` searched FROM startIdx (a bare
    // `indexOf('onOwnWarp')` resolves to an unrelated comment BEFORE `onReconnect:` and would
    // yield an empty/negative region).
    const src = readMainTs();
    const startIdx = src.indexOf('onReconnect:');
    expect(startIdx, "main.ts must contain 'onReconnect:'").toBeGreaterThanOrEqual(0);
    const endIdx = src.indexOf('onOwnWarp', startIdx);
    expect(
      endIdx,
      "main.ts must contain 'onOwnWarp' AFTER 'onReconnect:' (region end endpoint) — a bare " +
        'indexOf would resolve to the unrelated comment BEFORE onReconnect and yield an empty region',
    ).toBeGreaterThan(startIdx);
    const reconnectRegion = src.slice(startIdx, endIdx);
    // Strengthened from the bare identifier `tradeProposeView` to the CALL form
    // `tradeProposeView?.hide()` — the region now spans the WHOLE onReconnect body so this bites
    // regardless of where in the body the call lives, and no longer fails by naming an unrelated
    // overlay when an unrelated edit merely lengthens the body above the old fixed window.
    expect(
      reconnectRegion.includes('tradeProposeView?.hide()'),
      'main.ts onReconnect body must call tradeProposeView?.hide() (D7 M-2/C-2)',
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
// (BINDING: rAF forward-anchor; two-endpoint reconnect region; battle anchored on
// `r.action.kind === 'show'`). The count-floor = 19 clause retired with the OR-lists it
// counted (uxd3-b / ADR-0163 D2) — those reads now go through the ONE probe table.
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

describe('★ main.ts wiring (pt-c2b help): per-context anchored fan-out teeth (PTC2B-4..8 / ADR-0135)', () => {
  // uxd3-b (ADR-0163): the four keydown/reconcile/rAF/pvp teeth that lived here retired with
  // the OR-list surfaces they scanned — W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY covers those
  // reads structurally now. The battle force-hide below is untouched by uxd3-b (refreshBattle
  // is a WRITE surface, deferred to uxd3-c), so it stays exactly as authored.

  it('★ W-HELP-FANOUT-BATTLE BITES: helpView force-hidden in the battle show-path — kills battle-under-help impl (PTC2B-8, red-team F4)', () => {
    // PTC2B-8: when a battle auto-shows (e.g. a PvP accept), the help overlay must be
    // force-hidden (battle supersession) — the `refreshBattle()` show-path force-hides siblings.
    //
    // BINDING (plan / red-team F4): anchor on `r.action.kind === 'show'` (a UNIQUE marker) and
    // assert helpView appears within ~900 chars (the existing tradePropose force-hide sits at
    // delta ~880). ADR-0135 requires the guard in the `if (helpView?.visible) helpView.hide()`
    // form — the same form W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST's extractor requires.
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
      'battle show-path force-hide must use the `if (helpView?.visible) helpView.hide()` form (helpView?.visible) — the guarded form W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST extracts',
    ).toBe(true);
  });
});

describe('★ main.ts wiring (pt-c2b help): 11 sibling open-guards carry !helpView?.visible (PTC2B-5)', () => {
  // PTC2B-5: while the help overlay is visible, pressing a sibling hotkey must NOT open that
  // overlay. Each of the 11 sibling key handlers (KeyB/I/E/Q/U/P/L/N/O/T/M — uxd3 added M) must
  // add `!helpView?.visible` to its open-guard block.
  //
  // uxd2 EDIT (ADR-0161 D5 / plan AC-10′ — list maintenance, NOT a weakening): 'KeyH' and
  // 'KeyG' were removed from SIBLING_KEYS because uxd2 DELETES both handlers outright (the
  // shop opens from a shopkeeper interaction, the heal from a heal tile). Leaving them in
  // would make this suite fail post-impl for the wrong reason — `src.indexOf("e.code ===
  // 'KeyG'")` returns -1 and the anchor assertion fires, masking the real invariant. The
  // ABSENCE of those two handlers is asserted positively by W-INTERACT-NO-GH at the foot of
  // this file, so nothing is lost: the pair moved from "must be guarded" to "must not exist".
  // ALL_OVERLAYS (W-OVERLAY-FANOUT-MUTEX) deliberately KEEPS shopView and healView at 14 —
  // both overlays still exist; they simply have no hotkey of their own any more, so EVERY
  // remaining handler must now guard both of them.
  //
  // ROBUST APPROACH: for each sibling key, slice its handler block (from `e.code === 'KeyX'`
  // up to the NEXT sibling handler or a generous window) and assert helpView?.visible is present.
  // We assert ONLY the presence of helpView?.visible in each block — NOT a full sibling set —
  // because KeyB/I/E carried a PRE-EXISTING dialogue/questLog/heal omission owned by ptc5c
  // (plan reviewer HIGH-2); pt-c2b only adds helpView?.visible. ptc5c has now SHIPPED
  // W-OVERLAY-FANOUT-MUTEX (below) which enforces the FULL 14-overlay sibling set for ALL
  // handlers, including the KeyB/I/E dialogue/questLog/heal omission this comment once noted.
  //
  // uxd3 EDIT (ADR-0162 / plan §8 T3.2 — list GROWTH, 10 -> 11): 'KeyM' joins the sibling set.
  // The new menu front-door is a full open-handler, so it must carry `!helpView?.visible` like
  // every other sibling (pressing M while the help overlay is open must NOT stack the menu on
  // top of it). Adding it also TIGHTENS every other key's block bound: the KeyM anchor becomes a
  // candidate `blockEnd`, so a stray helpView?.visible living in the KeyM block can no longer
  // false-credit the handler that precedes it.
  const SIBLING_KEYS = [
    'KeyB',
    'KeyI',
    'KeyE',
    'KeyQ',
    'KeyU',
    'KeyP',
    'KeyL',
    'KeyN',
    'KeyO',
    'KeyT',
    'KeyM',
  ] as const;

  it('W-HELP-FANOUT-OPENGUARDS BITES: EACH of the 11 sibling open-guards contains !helpView?.visible — kills partial-guard impl', () => {
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
// THE 15 MUTUAL-EXCLUSION OVERLAYS (SSOT — not including errorOverlayView):
//   battleView, boxView, raisingView, evolutionView, dialogueView, questLogView,
//   healView, shopView, tradeView, pvpView, leaderboardView, renameView,
//   tradeProposeView, helpView, menuView          (uxd3/ADR-0162 added menuView)
//
// THE 12 OPEN-HANDLERS (uxd2: was 13 — KeyG/KeyH deleted, ADR-0161 D5 → 11; uxd3:
// +KeyM → 12): one per remaining hotkey + the interact handler (KeyT, which opens NO
// overlay of its own but must still guard against ALL 15 so it never fires into an
// open UI).
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
  // The 15 mutual-exclusion overlays (pin as const — no errorOverlayView).
  //
  // uxd3 EDIT (ADR-0162 / plan §8 T3.2 — list GROWTH, 14 -> 15): `menuView` is a full
  // mutual-exclusion member (GUARD_ONLY tier — see overlayRegistry's OVERLAY_TIERS). Adding it
  // here is what forces the eleven existing handlers to each carry `!menuView?.visible`: without
  // it, pressing B/I/E/Q/U/P/L/N/O/T/? while the menu is open would stack an overlay UNDER a
  // modal menu that still swallows the arrow keys. This list stays the SSOT that
  // overlayRegistry.OVERLAY_IDS is checked against (OR-MANIFEST-COMPLETE, 15 ids).
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
    'menuView',
  ] as const;

  // The three "hide-switch" siblings: KeyB/I/E legitimately hide-and-switch within
  // this trio, so we accept EITHER the guard form OR a .hide() call.
  const HIDE_SWITCH_OVERLAYS: ReadonlyArray<string> = ['boxView', 'raisingView', 'evolutionView'];

  // The 11 open-handlers (anchor uniquely identifies the handler start in the source;
  // self = the overlay this handler toggles, or null for KeyT which opens nothing).
  //
  // uxd2 EDIT (ADR-0161 D5 / plan AC-10′ — list maintenance): the KeyH (self healView) and
  // KeyG (self shopView) entries were removed because uxd2 deletes both handlers. This
  // STRENGTHENS the invariant rather than weakening it: with no handler claiming healView or
  // shopView as its `self`, EVERY remaining handler must now carry `!healView?.visible` AND
  // `!shopView?.visible` (previously each of those two was exempted in its own handler).
  // ALL_OVERLAYS stayed at 14 — both overlays still exist, they are just hotkey-less now.
  //
  // uxd3 EDIT (ADR-0162 / plan §8 T3.2 — list GROWTH, 11 -> 12): the `KeyM` menu front-door is
  // the 12th open-handler, `self: 'menuView'`. It therefore must guard the OTHER 14 overlays
  // (W-KEYM-HANDLER, at the foot of this file, states the same 14-guard requirement
  // list-independently, so a future mis-edit of THIS list cannot silently un-pin it).
  // ⚠ ANCHOR DISCIPLINE (plan anti-pattern 14): the literal `e.code === 'KeyM'` must appear in
  // main.ts EXACTLY ONCE — the slicing below uses first-`indexOf`, so the same string in a
  // comment above the handler would anchor the block at the comment and let the real guard list
  // fall outside it. W-KEYM-HANDLER asserts that uniqueness explicitly.
  const OPEN_HANDLERS: ReadonlyArray<{ anchor: string; self: string | null }> = [
    { anchor: "e.code === 'KeyB'", self: 'boxView' },
    { anchor: "e.code === 'KeyI'", self: 'raisingView' },
    { anchor: "e.code === 'KeyE'", self: 'evolutionView' },
    { anchor: "e.code === 'KeyQ'", self: 'questLogView' },
    { anchor: "e.code === 'KeyU'", self: 'tradeView' },
    { anchor: "e.code === 'KeyP'", self: 'pvpView' },
    { anchor: "e.code === 'KeyL'", self: 'leaderboardView' },
    { anchor: "e.code === 'KeyN'", self: 'renameView' },
    { anchor: "e.code === 'KeyO'", self: 'tradeProposeView' },
    { anchor: "e.key === '?'", self: 'helpView' }, // note: e.key not e.code
    { anchor: "e.code === 'KeyT'", self: null }, // talk: toggles NO overlay → must guard ALL 15
    { anchor: "e.code === 'KeyM'", self: 'menuView' }, // uxd3: the menu front-door (ADR-0162)
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

// ===========================================================================
// nh1 movement-suppress-default fix — NEW describe block (does NOT modify prior blocks).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-netcode-hardening.spec.md nh1 +
//   ADR-0146 (playtest-gate 2026-07-25 movement bug): "movement-suppression must call
//   preventDefault(), or arrow keys get hijacked by the browser once any overlay opens."
//
// BUG (current master): both early-return paths in the `keydown` handler —
// `if (e.repeat) return;` and the 14-overlay `Suppress movement input while an overlay
// is open` block — omit `e.preventDefault()`. With an overlay open (or on OS key-repeat),
// ArrowUp/Down/Left/Right/Space fall through to the browser's native page-scroll/
// button-activate default.
//
// THE FIX (ADR-0146) main.ts must ship, verbatim in shape:
//   - two NEW non-exported helpers, `targetOwnsKey` and `suppressNativeMovementDefault`,
//     declared AFTER `KEY_DIR` and BEFORE `window.addEventListener('keydown'`.
//   - `suppressNativeMovementDefault(e);` called on BOTH early-return paths, before the
//     `return;`.
//
// RED REASON (ALL five tests below): none of this exists on the current main.ts — no
// `targetOwnsKey`, no `suppressNativeMovementDefault`, and neither early-return path
// calls it. `regionOrThrow` throws (helper/target regions have no start anchor at all);
// the repeat/suppression region tests find their regions fine but the call-needle search
// inside them comes up empty. See the per-test RED comment for the exact failure.
//
// ANCHOR-SLICING STRATEGY (documented once, applies to all 4 regions below):
//   All four regions are located using RAW main.ts text — including the suppression
//   region's START anchor, which is itself inside a `//` comment
//   (`// Suppress movement input while an overlay is open.`). We do NOT run
//   stripLineComments() over the whole file first and then re-locate anchors in the
//   stripped text (that would require re-deriving every offset and is exactly the kind
//   of raw-vs-stripped index mismatch this comment is warning about). Instead:
//     1. Anchor indices (start/end) are always found via indexOf on the RAW source.
//     2. The region is sliced out of the RAW source using those raw indices.
//     3. stripLineComments() is applied to that ALREADY-SLICED region substring — never
//        to the whole file, never to relocate an anchor — purely so a needle that lives
//        only inside a `//` comment WITHIN the region cannot satisfy a tooth.
//   Because stripping happens strictly after slicing, there is no offset-mismatch risk:
//   we never need a stripped-text index to correspond to a raw-text index.
//
// KNOWN LIMITATION of stripLineComments/stripBlockComments (line-based / marker-scan, not
// a real tokenizer): a `//` or `/*` living INSIDE a string/template literal would be
// mistaken for a real comment marker and truncate/eat real code (e.g. a line like
// `const s = "http://example.com";` or `const s = "/* not a comment */";`). No such
// literal exists in any of the 4 regions scanned below (verified by reading main.ts lines
// 472-490 and 1006-1035, and by inspection of the ADR-0146 helper bodies quoted in the
// spec) — the regions are plain control-flow/object-literal code with ordinary comments
// only, so this limitation is disclosed but does not bite here.
//
// DISCLOSED RESIDUALS (accepted, NOT closed by these source-scan teeth — do not attempt
// to close via more string-matching; see rationale below): a dead-code wrapper such as
// `if (false) { if ((KEY_DIR[e.code] ...) && !targetOwnsKey(e)) e.preventDefault(); }`, or
// `targetOwnsKey` starting with an unconditional early `return true;` before its real
// checks, would still contain every needle these teeth look for and would PASS this whole
// suite while suppressing nothing (or suppressing everything). These are caught
// downstream, not here: `just lint` (biome `noConstantCondition`) flags `if (false)`/
// `if (true)`, and `tsc` flags the resulting unreachable-code paths in strict mode. A
// fully behavioural (not source-scan) test would need `targetOwnsKey`/
// `suppressNativeMovementDefault` extracted into an importable, DOM-light pure module (so
// vitest can call them directly with a fake KeyboardEvent), or a Playwright e2e that
// actually dispatches keydown and observes `preventDefault` — both are outside this
// slice's touch-set (this file only, per the coordinator's instruction).
// ===========================================================================

// Drop `/* ... */` block comments (multi-line-aware, marker-scan not regex) THEN `//` line
// comments, so a needle that only appears in a comment — including one hidden by
// block-commenting out the real body (red-team Mutant 2) — cannot satisfy a tooth. Order
// matters: block comments are stripped FIRST so no `//` living inside a `/* */` block can
// be mis-parsed by the line-comment pass afterward (it's simply gone by then).
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
      // Unterminated block comment — drop the remainder defensively (should not occur in
      // the well-formed regions this file scans; see KNOWN LIMITATION above).
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

/** Generic "slice from START needle to END needle" region extractor for the nh1 teeth
 *  below. Mirrors the file's existing `f9Region` pattern: throws loud (never returns an
 *  empty/negative slice) if either needle is missing or END does not follow START, so a
 *  missing implementation is a HARD RED (thrown error), never a vacuous pass. `fromIdx`
 *  lets a caller anchor the END search past an earlier duplicate occurrence (see the
 *  suppression region: `const dir = KEY_DIR[e.code];` appears twice in main.ts — once in
 *  the keydown handler we want, once in the keyup handler at ~line 1039 — searching END
 *  FROM startIdx resolves to the nearer, correct occurrence today). */
function regionOrThrow(src: string, startNeedle: string, endNeedle: string, fromIdx = 0): string {
  const startIdx = src.indexOf(startNeedle, fromIdx);
  if (startIdx < 0) {
    throw new Error(`main.ts must contain "${startNeedle}" (nh1/ADR-0146 region start)`);
  }
  const endIdx = src.indexOf(endNeedle, startIdx);
  if (endIdx < 0) {
    throw new Error(
      `main.ts must contain "${endNeedle}" AFTER "${startNeedle}" (nh1/ADR-0146 region end)`,
    );
  }
  if (endIdx <= startIdx) {
    throw new Error(`"${endNeedle}" must appear AFTER "${startNeedle}" (nh1/ADR-0146 region)`);
  }
  return src.slice(startIdx, endIdx);
}

describe('main.ts wiring (nh1/ADR-0146): movement default is suppressed under overlay + key-repeat', () => {
  it('W-NH1-SUPPRESS BITES: overlay-suppression block calls suppressNativeMovementDefault(e) before its return', () => {
    // WRONG IMPL KILLED (primary): the CURRENT unfixed code — the 14-overlay
    // `Suppress movement input while an overlay is open` block is a bare
    // `if (...) return;` with no call at all. RED today: callIdx === -1.
    // WRONG IMPL KILLED (secondary): a call placed AFTER the `return;` (dead code) —
    // e.g. `if (...) { return; suppressNativeMovementDefault(e); }` would satisfy a
    // naive "does the region contain the string" check but never actually run; the
    // before-return ordering assertion below catches it.
    const src = readMainTs();
    const rawRegion = regionOrThrow(
      src,
      'Suppress movement input while an overlay is open',
      'const dir = KEY_DIR[e.code];',
    );
    // Anti-vacuity: this must be the keydown-handler occurrence, not the keyup one.
    expect(
      rawRegion.includes("addEventListener('keyup'"),
      'suppression region must not have widened past the keydown block into the keyup handler',
    ).toBe(false);

    const region = stripLineComments(rawRegion);
    const callIdx = region.indexOf('suppressNativeMovementDefault(e)');
    expect(
      callIdx,
      'the overlay-suppression block must call suppressNativeMovementDefault(e) — ' +
        'RED today: the current block is a bare `if (...) return;` with no such call ' +
        '(ArrowUp/Down/Left/Right/Space fall through to the browser default while any ' +
        'overlay is open, e.g. native page-scroll)',
    ).toBeGreaterThanOrEqual(0);

    const returnIdx = region.indexOf('return;');
    expect(returnIdx, 'suppression region must contain a return;').toBeGreaterThanOrEqual(0);
    expect(
      callIdx,
      'suppressNativeMovementDefault(e) must be called BEFORE the return; in the ' +
        'suppression block — a call placed after `return;` is dead code and never runs',
    ).toBeLessThan(returnIdx);
  });

  it('W-NH1-REPEAT BITES: the e.repeat early-return calls suppressNativeMovementDefault(e) before its return', () => {
    // WRONG IMPL KILLED (primary): the CURRENT unfixed code — `if (e.repeat) return;`
    // has no call at all. RED today: callIdx === -1.
    // WRONG IMPL KILLED (secondary, the dominant real-world case): a "first-keydown-only"
    // fix that adds suppressNativeMovementDefault ONLY to the overlay block and skips the
    // e.repeat path — every OS key-repeat keydown event carries its OWN default action, so
    // a held arrow key over an open overlay would keep scrolling the page on every repeat
    // tick even if the very first keydown was suppressed. This is the tooth that catches
    // exactly that half-fix.
    const src = readMainTs();
    const rawRegion = regionOrThrow(src, 'if (e.repeat)', "if (e.code === 'F9')");
    const region = stripLineComments(rawRegion);

    const callIdx = region.indexOf('suppressNativeMovementDefault(e)');
    expect(
      callIdx,
      'the `if (e.repeat)` early return must call suppressNativeMovementDefault(e) — ' +
        'RED today: the current line is `if (e.repeat) return;` with no such call ' +
        '(a held arrow key over an open overlay would keep triggering the native ' +
        'page-scroll on every OS key-repeat tick)',
    ).toBeGreaterThanOrEqual(0);

    const returnIdx = region.indexOf('return;');
    expect(returnIdx, 'e.repeat region must contain a return;').toBeGreaterThanOrEqual(0);
    expect(
      callIdx,
      'suppressNativeMovementDefault(e) must be called BEFORE the return; in the ' +
        'e.repeat early-return — a call placed after `return;` is dead code',
    ).toBeLessThan(returnIdx);
  });

  it('W-NH1-HELPER BITES: suppressNativeMovementDefault checks KEY_DIR OR Space, negates targetOwnsKey, and calls preventDefault', () => {
    // WRONG IMPL KILLED (the &&-for-|| swap, the sneakiest failure mode): a helper body
    // written as `if (KEY_DIR[e.code] !== undefined && e.code === 'Space')` is ALWAYS
    // false (e.code cannot simultaneously be a movement key AND 'Space') — it would
    // satisfy any test that only checks the three substrings appear SEPARATELY anywhere
    // in the helper region, while suppressing nothing. This test requires the CONTIGUOUS
    // substring `KEY_DIR[e.code] !== undefined ||` (the `||` glued directly onto the
    // condition, not merely present somewhere else in the region) to rule that out.
    // WRONG IMPL KILLED: a movement-only fix that drops the `e.code === 'Space'` disjunct
    // — Space (jump) would still leak to native scroll/button-activate under an overlay.
    // WRONG IMPL KILLED: a helper that never calls e.preventDefault() at all (a no-op stub).
    // WRONG IMPL KILLED: a helper that doesn't consult targetOwnsKey (see W-NH1-TARGET for
    // why that guard matters) — checked here via the negated-call substring `!targetOwnsKey(`.
    // RED today: 'const suppressNativeMovementDefault' does not exist in main.ts at all —
    // regionOrThrow throws before any substring check runs.
    const src = readMainTs();
    const rawRegion = regionOrThrow(
      src,
      'const suppressNativeMovementDefault',
      "window.addEventListener('keydown'",
    );
    const region = stripLineComments(rawRegion);

    expect(
      region.includes('KEY_DIR[e.code] !== undefined ||'),
      'suppressNativeMovementDefault must check `KEY_DIR[e.code] !== undefined ||` as a ' +
        'CONTIGUOUS substring (the || glued directly onto the condition) — an && swap ' +
        "(`KEY_DIR[e.code] !== undefined && e.code === 'Space'`) is always false and " +
        'would suppress nothing, while still containing the three needles separately',
    ).toBe(true);
    expect(
      region.includes("e.code === 'Space'"),
      "suppressNativeMovementDefault must also gate on e.code === 'Space' — dropping " +
        'this disjunct would leave Space (jump) leaking to the native default under an overlay',
    ).toBe(true);
    expect(
      region.includes('e.preventDefault()'),
      'suppressNativeMovementDefault must actually call e.preventDefault() — a stub that ' +
        'checks the condition but never calls preventDefault() suppresses nothing',
    ).toBe(true);
    expect(
      region.includes('!targetOwnsKey('),
      'suppressNativeMovementDefault must negate targetOwnsKey(e) as a guard — without it, ' +
        "a blanket preventDefault would break arrow-key selection inside battleView's " +
        '<select> elements and Space-activation of focused overlay buttons',
    ).toBe(true);
  });

  it("W-NH1-NONEGATION BITES: suppressNativeMovementDefault opens with the exact, non-negated guard `if ((KEY_DIR[e.code] !== undefined || e.code === 'Space') && !targetOwnsKey(e))`", () => {
    // WRONG IMPL KILLED (red-team finding, CRITICAL — this mutant survived all 4 other nh1
    // teeth AND `just lint` (biome) AND `tsc`): wrapping the whole condition in an outer
    // negation —
    //   if (!((KEY_DIR[e.code] !== undefined || e.code === 'Space') && !targetOwnsKey(e)))
    //     e.preventDefault();
    // — is De Morgan's-law-legal TypeScript: it type-checks and lints clean, but it fires
    // e.preventDefault() for every NON-movement key and for every form-control target,
    // leaving the ORIGINAL native-scroll bug completely unfixed while ALSO breaking
    // arrow-key use inside battleView's <select> elements and Space-activation of overlay
    // buttons — i.e. it is the exact behavioural inverse of the fix.
    // Every substring W-NH1-HELPER checks ('KEY_DIR[e.code] !== undefined ||',
    // "e.code === 'Space'", 'e.preventDefault()', '!targetOwnsKey(') is still present
    // verbatim inside this negated mutant, so W-NH1-HELPER (and W-NH1-TARGET, which never
    // looks at this line at all) both pass it. Only an assertion on the CONTIGUOUS,
    // un-negated `if ((...) && !targetOwnsKey(e))` opening — which the mutant's
    // `if (!((...` does not contain — closes this gap.
    //
    // BRITTLENESS TRADEOFF (accepted, stated per coordinator instruction): this pins the
    // EXACT guard text verbatim. A behaviour-preserving reordering of the guard (e.g.
    // swapping the `||` operands to `e.code === 'Space' || KEY_DIR[e.code] !== undefined`,
    // or reformatting whitespace) WILL red this tooth even though it changes nothing
    // wrong. That brittleness is the deliberate, disclosed price of killing a mutant that
    // otherwise survives lint + typecheck + every substring-only tooth in this file. If a
    // future refactor legitimately changes the guard's shape, the expected string here
    // must be corrected FROM THE SPEC (ADR-0146) by the tester role, never silently
    // deleted or loosened back to a substring check that the negated mutant would re-pass.
    const src = readMainTs();
    const rawRegion = regionOrThrow(
      src,
      'const suppressNativeMovementDefault',
      "window.addEventListener('keydown'",
    );
    const region = stripLineComments(rawRegion);
    const guard = "if ((KEY_DIR[e.code] !== undefined || e.code === 'Space') && !targetOwnsKey(e))";
    expect(
      region.includes(guard),
      `suppressNativeMovementDefault must open with the exact, non-negated guard \`${guard}\` ` +
        '— an outer negation (De Morgan-equivalent `if (!(... && !targetOwnsKey(e)))`) fires ' +
        'preventDefault() for every non-movement key / form-control target, leaving the ' +
        'original bug unfixed while breaking form controls, and still contains every needle ' +
        'the other nh1 teeth check — only this exact-contiguous, un-negated form catches it',
    ).toBe(true);
  });

  it('W-NH1-TARGET BITES: targetOwnsKey recognizes INPUT/TEXTAREA/SELECT/contentEditable, and gates BUTTON/A on Space only', () => {
    // WRONG IMPL KILLED (a): omitting the target check entirely (suppressNativeMovementDefault
    // calling e.preventDefault() unconditionally whenever KEY_DIR/Space matches, regardless
    // of focused element) — a blanket preventDefault would break arrow-key selection on
    // battleView's two <select> elements (bait-selector, cure-item-selector) and break
    // Space-activation of every focused overlay button, since only renameView/
    // tradeProposeView stopPropagation their own focusables. The INPUT/TEXTAREA/SELECT/
    // isContentEditable needles below catch the "no target check at all" impl (none of
    // these strings would exist in the helper region).
    // WRONG IMPL KILLED (b): a blanket target-skip that exempts BUTTON/A for EVERY key
    // (not just Space) — e.g. `if (tag === 'BUTTON' || tag === 'A') return true;` with no
    // Space gate — would reopen the ORIGINAL arrow-scroll bug in the single commonest
    // focus state (a <button> retains focus after a click, and arrow keys are not
    // BUTTON/A's native key, so exempting them unconditionally defeats the whole fix for
    // that focus state). The contiguous substring `e.code === 'Space' &&` requires the
    // BUTTON/A exemption to be conditioned on Space specifically.
    // RED today: 'const targetOwnsKey' does not exist in main.ts at all — regionOrThrow
    // throws before any substring check runs.
    const src = readMainTs();
    const rawRegion = regionOrThrow(
      src,
      'const targetOwnsKey',
      'const suppressNativeMovementDefault',
    );
    const region = stripLineComments(rawRegion);

    expect(
      region.includes("'INPUT'"),
      "targetOwnsKey must name 'INPUT' — omitting it would let a blanket preventDefault " +
        'break arrow-key/Space use inside any future text <input>',
    ).toBe(true);
    expect(region.includes("'TEXTAREA'"), "targetOwnsKey must name 'TEXTAREA'").toBe(true);
    expect(
      region.includes("'SELECT'"),
      "targetOwnsKey must name 'SELECT' — omitting it breaks arrow-key selection on " +
        "battleView's bait-selector / cure-item-selector <select> elements",
    ).toBe(true);
    expect(region.includes('isContentEditable'), 'targetOwnsKey must check isContentEditable').toBe(
      true,
    );
    expect(
      region.includes("e.code === 'Space' &&"),
      "targetOwnsKey must gate the BUTTON/A exemption on `e.code === 'Space' &&` as a " +
        'CONTIGUOUS substring — an unconditional BUTTON/A exemption (no Space gate) would ' +
        'reopen the original arrow-scroll bug for the commonest focus state (a <button> ' +
        'keeps focus after being clicked, and arrow keys are not native to BUTTON/A)',
    ).toBe(true);
  });

  it('W-NH1-NOVACUITY BITES: every nh1 anchor is found and every region is non-degenerate (anti-vacuity positive control)', () => {
    // This is the tooth that fails LOUDLY if a future refactor renames a comment, reorders
    // the handler, or otherwise moves one of the 4 anchors, instead of silently reducing
    // every test above to a pass-on-empty-slice. Independent of regionOrThrow (does its
    // own raw indexOf + expect calls) so a bug in the shared helper can't hide a break here.
    const src = readMainTs();

    const suppressStart = src.indexOf('Suppress movement input while an overlay is open');
    const suppressEnd = src.indexOf('const dir = KEY_DIR[e.code];', suppressStart);
    expect(suppressStart, 'suppression region START anchor must be found').toBeGreaterThanOrEqual(
      0,
    );
    expect(suppressEnd, 'suppression region END anchor must be found').toBeGreaterThanOrEqual(0);
    expect(suppressEnd, 'suppression region END must come strictly after START').toBeGreaterThan(
      suppressStart,
    );
    // Defensive: the region must not have silently widened into the keyup handler (the
    // END needle appears twice in main.ts; this proves indexOf(needle, startIdx) is still
    // resolving to the nearer, keydown-handler occurrence and not the keyup one).
    const suppressRegion = src.slice(suppressStart, suppressEnd);
    expect(
      suppressRegion.includes("addEventListener('keyup'"),
      'suppression region must NOT contain the keyup handler registration — if it does, ' +
        'a future edit has silently widened this region past the intended block',
    ).toBe(false);

    const repeatStart = src.indexOf('if (e.repeat)');
    const repeatEnd = src.indexOf("if (e.code === 'F9')", repeatStart);
    expect(repeatStart, 'e.repeat region START anchor must be found').toBeGreaterThanOrEqual(0);
    expect(repeatEnd, 'e.repeat region END anchor must be found').toBeGreaterThanOrEqual(0);
    expect(repeatEnd, 'e.repeat region END must come strictly after START').toBeGreaterThan(
      repeatStart,
    );

    // Helper regions: these do NOT exist yet on unmodified main.ts (post-impl anchors),
    // so we only assert them >= 0 when present; their absence is already the RED reason
    // for W-NH1-HELPER / W-NH1-TARGET above. Here we additionally prove the ORDERING
    // invariant once they DO exist: targetOwnsKey must be declared before
    // suppressNativeMovementDefault, which must be declared before the keydown listener.
    const targetStart = src.indexOf('const targetOwnsKey');
    const helperStart = src.indexOf('const suppressNativeMovementDefault');
    const listenerStart = src.indexOf("window.addEventListener('keydown'");
    expect(listenerStart, 'keydown listener anchor must always be found').toBeGreaterThanOrEqual(0);
    if (targetStart >= 0 && helperStart >= 0) {
      expect(
        targetStart,
        'targetOwnsKey must be declared BEFORE suppressNativeMovementDefault (the latter calls the former)',
      ).toBeLessThan(helperStart);
      expect(
        helperStart,
        'suppressNativeMovementDefault must be declared BEFORE the keydown listener that calls it',
      ).toBeLessThan(listenerStart);
    }
  });
});

// ---------------------------------------------------------------------------
// nh2 / ADR-0148 — press-teleport fix: drain-first (R1) + outstanding-steps gate
// ---------------------------------------------------------------------------
//
// SOURCE OF TRUTH: nh2 spec / ADR-0148. Three source-level changes, all in main.ts:
//   R1  `const { snapped } = predictor.drain(now);` moves to IMMEDIATELY below
//       `const now = performance.now();` — i.e. ABOVE the held-key re-issue block
//       (today it sits BELOW it, which is the press-teleport bug: the frame emits a
//       fresh step from a queue that has not yet been drained for this frame).
//   R2  the rAF 14-overlay guard gains a leading conjunct:
//       `if (predictor.outstandingSteps === 0 && !( ...14 flags... )) {`
//   R3  the reconcile-divergence guard gains the SAME conjunct:
//       `if (diverged && predictor.outstandingSteps === 0 && !( ...14 flags... ))`
//
// ANCHOR DISCIPLINE (nh1 post-mortem): every region below is needle-bounded via
// `regionOrThrow` and every anchor's UNIQUENESS in main.ts is asserted inline. A region
// that can silently widen passes vacuously; a fixed-width window (`src.slice(i, i + 400)`)
// is banned outright. No `new RegExp` anywhere — indexOf/includes/split only.

/** rAF held-key re-issue block. START = the block-opening comment, END = the first
 *  statement after the block. Verified unique in main.ts at authoring time (each appears
 *  exactly once: the comment at ~line 2063, `const ownEntityId =` at ~line 2089); the
 *  uniqueness is RE-asserted at runtime by `expectUniqueAnchor` in every tooth that uses
 *  them, so a future duplicate reds loudly instead of widening the region. */
const NH2_RAF_START = 'Re-issue the held dir';
const NH2_RAF_END = 'const ownEntityId =';

/** Reconcile divergence re-issue block. START = the ADR-0013 rationale comment above the
 *  `if (diverged && ...)` guard (~line 401), END = the outer catch's error log (~line 427).
 *  END is chosen with its trailing quote glued on (`... uncaught error'`) precisely so it
 *  does NOT also match the sibling `'[reconcile] uncaught error in batch listener'` log 10
 *  lines further down — that is what keeps it unique, and `expectUniqueAnchor` proves it. */
const NH2_RECONCILE_START = "Honor reconcile's documented divergence return";
const NH2_RECONCILE_END = "console.error('[reconcile] uncaught error'";

/** rAF frame-body region: spans the drain call AND the re-issue comment, so the ordering
 *  tooth can compare their positions. START = the frame closure declaration (~line 2060). */
const NH2_FRAME_START = 'const frame = ';

/** Anti-vacuity: an anchor that occurs more than once means `indexOf` may resolve to the
 *  wrong occurrence and the region silently covers the wrong code (or nothing); an anchor
 *  that occurs zero times means the region is gone. Both are hard reds, never a pass. */
function expectUniqueAnchor(src: string, needle: string): void {
  expect(
    src.split(needle).length - 1,
    `nh2 anchor "${needle}" must appear EXACTLY once in main.ts — a duplicated or deleted ` +
      'anchor lets a needle-bounded region silently cover the wrong code (or collapse), ' +
      'which is how a source-scan tooth goes vacuously green (nh1 post-mortem)',
  ).toBe(1);
}

/** Needle-bounded region BODY, comment-stripped.
 *  Sliced from RAW source (so comment anchors still resolve), then:
 *   1. the anchor's OWN line is dropped — the slice starts INSIDE a `//` comment, so that
 *      first line has no visible `//` marker and `stripLineComments` cannot strip it; a
 *      needle parked in the anchor comment would otherwise satisfy a tooth;
 *   2. `stripLineComments` (which strips block comments first) removes the rest, so no
 *      commented-out code can satisfy a tooth either. */
function bodyRegion(src: string, startNeedle: string, endNeedle: string): string {
  const raw = regionOrThrow(src, startNeedle, endNeedle);
  const nl = raw.indexOf('\n');
  if (nl === -1) {
    throw new Error(
      `nh2 region "${startNeedle}" → "${endNeedle}" collapsed to a single line — the block ` +
        'body is missing; refusing to scan a degenerate region',
    );
  }
  return stripLineComments(raw.slice(nl + 1));
}

/** Collapse every run of whitespace to ONE space so a contiguous-substring assertion is
 *  immune to prettier/biome line-wrapping (the gate may be formatted on one line or split
 *  across three). Hand-rolled scan — `new RegExp` is Semgrep-banned in this file. */
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

describe('★ main.ts wiring (nh2/ADR-0148): drain-first + outstanding-steps gate', () => {
  it('★ W-NH2-GATE-WIRED BITES: BOTH re-issue sites gate on `predictor.outstandingSteps === 0 &&`', () => {
    // RED AT AUTHORING TIME (pre-ADR-0148 main.ts): `predictor.outstandingSteps` did not appear
    // in main.ts at all (0 occurrences), so both assertions below failed on the unfixed source.
    // The landed fix satisfies it; it is retained as a permanent regression guard. This is the
    // primary tooth for R2 + R3.
    //
    // WRONG IMPL KILLED (1): today's unfixed code — a held key re-issues a Step every frame
    // regardless of how many steps are still outstanding in the predictor queue, which is the
    // press-teleport bug ADR-0148 fixes.
    // WRONG IMPL KILLED (2): gating only ONE of the two sites (the rAF frame loop but not the
    // reconcile-divergence path, or vice versa). The reconcile path re-issues on a server
    // pullback and reproduces the same over-queueing; both regions are asserted separately so
    // a half fix reds.
    // WRONG IMPL KILLED (3): a mutant that "mentions" the gate as a bare expression statement
    // (`predictor.outstandingSteps === 0;`) and then emits unguarded. That form has no trailing
    // `&&`, so the CONTIGUOUS needle `predictor.outstandingSteps === 0 &&` — the operator glued
    // directly onto the comparison, exactly as the &&-for-|| tooth in nh1 does it — reds.
    // WRONG IMPL KILLED (4) — THE M12 HOISTED-CONST-OR MUTANT, the one that nearly shipped:
    //     const serverOwesNothing = predictor.outstandingSteps === 0 && conn !== undefined;
    //     const walking = held.active() !== undefined;
    //     if ((serverOwesNothing || walking) && !( ...overlay flags... )) { ... }
    //   This is a COMPLETE revert of the fix (measured on the mutant build: 65.2 sends/s, 600
    //   rejects in 10s, 59.3% of presses teleport — i.e. exact baseline behaviour), yet it kept
    //   the entire 1365-test suite green and passed `tsc --noEmit` + `biome check`. It survived
    //   because a mere-presence needle is satisfied by the hoisted `const` DECLARATION, and the
    //   `reissueDir(` anti-vacuity probe still passes. The kill is the `opensWith(...)`
    //   assertion below: the gate must be the GUARD'S OWN LEADING CONJUNCT, and this mutant's
    //   guard opens `if ( (serverOwesNothing || walking) &&`, which matches neither spelling.
    //
    // WHY squashWhitespace IS LOAD-BEARING (a `/simplify` lens previously flagged it as inert):
    // the shipped guards are multi-line — `if (\n        predictor.outstandingSteps === 0 &&\n
    // !(` — so the leading-conjunct needle only exists as a contiguous substring AFTER runs of
    // whitespace collapse to one space. Without the squash this tooth could not check the
    // guard's opening at all, and the M12 mutant would still be alive.
    //
    // BRITTLENESS TRADEOFF (accepted + disclosed, same posture as W-NH1-NONEGATION): pinning the
    // guard's OPENING supersedes this tooth's original "position is not the invariant" stance. A
    // behaviour-preserving refactor to `const d = reissueDir(...); if (d !== undefined && <gate>)`
    // WILL red this tooth even though it is correct. That is the deliberate price of killing a
    // mutant that survives lint + typecheck + 1365 tests. If such a refactor ever lands, the
    // needle must be corrected FROM THE SPEC (ADR-0148) by the tester role — never loosened back
    // to the bare-presence check, which the M12 mutant re-passes.
    //
    // HONEST RESIDUAL — what this tooth still does NOT kill (red-team enumerated; parked as a
    // known gap, closed by the parked `nh2-e2e` Playwright tooth, NOT by any source scan):
    //   (a) `if (true || predictor.outstandingSteps === 0 && ...)` — and symmetrically any
    //       trailing `|| <other predicate>` appended after the required prefix; the opening
    //       matches, the semantics are reverted. Reachable only by evaluating the expression.
    //   (b) a SECOND, ungated emitter added BELOW the region end (outside both anchors).
    //   (c) a second `store.onBatchApplied` listener that re-issues ungated.
    // No source scan can reach (a)-(c); do not read this tooth as proving their absence.
    const src = readMainTs();
    expectUniqueAnchor(src, NH2_RECONCILE_START);
    expectUniqueAnchor(src, NH2_RECONCILE_END);
    expectUniqueAnchor(src, NH2_RAF_START);
    expectUniqueAnchor(src, NH2_RAF_END);

    const gate = 'predictor.outstandingSteps === 0 &&';

    /** Does the region contain an `if (` whose FIRST conjunct(s) are exactly `conjuncts`?
     *  Both spellings are the SAME code under the two layouts biome can produce: the shipped
     *  multi-line guard squashes to `if ( <conjuncts>` (newline+indent -> one space), while a
     *  hypothetical single-line reflow gives `if (<conjuncts>`. Accepting both removes a pure-
     *  formatting false red WITHOUT admitting any wrong impl — the M12 mutant's guard opens
     *  `if ( (serverOwesNothing || walking) &&` and matches neither. */
    const opensWith = (region: string, conjuncts: string): boolean =>
      region.includes(`if ( ${conjuncts}`) || region.includes(`if (${conjuncts}`);

    const reconcileRegion = squashWhitespace(
      bodyRegion(src, NH2_RECONCILE_START, NH2_RECONCILE_END),
    );
    // Anti-vacuity: prove the region really bounds a held-dir re-issue site before judging it.
    expect(
      reconcileRegion.includes('reissueDir('),
      'the reconcile-divergence region must contain the held-dir re-issue call reissueDir( — ' +
        'if it does not, the anchors no longer bound the block this tooth is about',
    ).toBe(true);
    expect(
      reconcileRegion.includes(gate),
      `the reconcile-divergence re-issue guard must contain the CONTIGUOUS conjunct \`${gate}\` ` +
        '(ADR-0148 R3: `if (diverged && predictor.outstandingSteps === 0 && !( ...overlays... ))`) ' +
        '— without it a server pullback re-queues a Step while steps are still outstanding, ' +
        'which is the press-teleport bug',
    ).toBe(true);
    // THE BITING ASSERTION (kills the M12 hoisted-const-OR mutant): leading conjunct, not
    // merely present. Weak needle above is retained only for a clearer message on a plain
    // gate-is-missing failure; it does NOT kill M12 on its own.
    expect(
      opensWith(reconcileRegion, `diverged && ${gate}`),
      'the reconcile-divergence guard must OPEN with `if (diverged && ' +
        'predictor.outstandingSteps === 0 && ...)` (ADR-0148 R3) — the gate must be the ' +
        "GUARD'S OWN LEADING CONJUNCT, not merely present somewhere in the block. A hoisted " +
        '`const serverOwesNothing = predictor.outstandingSteps === 0 && ...` that the guard ' +
        'then ORs with a second predicate (`(serverOwesNothing || walking) && !(...)`) ' +
        'satisfies mere presence while completely reverting the fix',
    ).toBe(true);

    const rafRegion = squashWhitespace(bodyRegion(src, NH2_RAF_START, NH2_RAF_END));
    expect(
      rafRegion.includes('reissueDir('),
      'the rAF held-key re-issue region must contain the held-dir re-issue call reissueDir( — ' +
        'if it does not, the anchors no longer bound the block this tooth is about',
    ).toBe(true);
    expect(
      rafRegion.includes(gate),
      `the rAF held-key re-issue guard must contain the CONTIGUOUS conjunct \`${gate}\` ` +
        '(ADR-0148 R2: `if (predictor.outstandingSteps === 0 && !( ...14 overlay flags... ))`) ' +
        '— without it the frame loop emits a Step every frame while steps are still ' +
        'outstanding, teleporting the player on a single press',
    ).toBe(true);
    // THE BITING ASSERTION (kills the M12 hoisted-const-OR mutant at the site it was built
    // against — the rAF loop, measured 65.2 sends/s / 59.3% press teleports while green).
    expect(
      opensWith(rafRegion, gate),
      'the rAF held-key re-issue guard must OPEN with `if (predictor.outstandingSteps === 0 ' +
        "&& !( ...14 overlay flags... ))` (ADR-0148 R2) — the gate must be the GUARD'S OWN " +
        'LEADING CONJUNCT, not merely present somewhere in the block. The M12 mutant ' +
        '(`const serverOwesNothing = predictor.outstandingSteps === 0 && conn !== undefined; ' +
        'if ((serverOwesNothing || walking) && !(...))`) satisfies mere presence, passes tsc ' +
        'and biome, and is an exact revert of the fix — only this opening check reds it',
    ).toBe(true);
  });

  it('★ W-NH2-DRAIN-FIRST BITES: predictor.drain( runs BEFORE the held-key re-issue block in the rAF frame body', () => {
    // RED AT AUTHORING TIME (pre-ADR-0148 main.ts): `predictor.drain(` sat BELOW the re-issue
    // block, so this ordering assertion failed on the unfixed source. It is the tooth for R1 —
    // the landed fix satisfies it, and it stays in place as a PERMANENT regression guard.
    //
    // WRONG IMPL KILLED (1): the pre-fix order — the frame emits a held-key Step against a
    // queue that has not been drained for this frame, so the predictor over-queues and the
    // render snaps forward (press-teleport).
    // WRONG IMPL KILLED (2): a future "tidy-up" that moves the drain back below the emit,
    // silently restoring the bug while every other tooth in this file stays green.
    //
    // RAW region ON PURPOSE (no comment stripping): the re-issue block's position is marked by
    // its opening COMMENT, which stripping would delete. That is safe here because BOTH needles
    // are asserted globally unique in main.ts — a `predictor.drain(` hidden in a comment, or a
    // second copy of either needle, reds via expectUniqueAnchor instead of skewing the compare.
    const src = readMainTs();
    expectUniqueAnchor(src, NH2_FRAME_START);
    expectUniqueAnchor(src, NH2_RAF_END);
    expectUniqueAnchor(src, NH2_RAF_START);
    expectUniqueAnchor(src, 'predictor.drain(');

    const frameBody = regionOrThrow(src, NH2_FRAME_START, NH2_RAF_END);
    const drainIdx = frameBody.indexOf('predictor.drain(');
    const reissueIdx = frameBody.indexOf(NH2_RAF_START);
    expect(
      drainIdx,
      'the rAF frame body (const frame = … → const ownEntityId =) must contain predictor.drain(',
    ).toBeGreaterThanOrEqual(0);
    expect(
      reissueIdx,
      `the rAF frame body must contain the re-issue block comment "${NH2_RAF_START}"`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      drainIdx,
      'ADR-0148 R1: `const { snapped } = predictor.drain(now);` must run BEFORE the held-key ' +
        're-issue block (immediately below `const now = performance.now();`). With the drain ' +
        'below the emit, the frame queues a fresh Step against an undrained queue and a single ' +
        'press teleports the player — moving the drain back down silently restores that bug',
    ).toBeLessThan(reissueIdx);
  });

  it('W-NH2-NO-CANCEL: no queue-cancel / setMove escape hatch anywhere in main.ts (GREEN regression guard)', () => {
    // GREEN REGRESSION GUARD — NOT red today. None of the four needles below exist in main.ts
    // at authoring time (0 occurrences each); this tooth exists to keep it that way, and is
    // labelled GREEN deliberately (mislabelling a green guard as RED is itself a defect).
    //
    // WRONG IMPL KILLED (ADR-0148 §Alternatives, both REJECTED designs):
    //   (a) "cancel the queue on keyup" — clearing the server/predictor move queue when the key
    //       is released was MEASURED to teleport the player BACKWARD by up to 1.75 tiles, because
    //       the renderer's divergence-snap path (ADR-0141) snaps to the now-shorter authoritative
    //       path. `predictor.clearQueue` / `reducers.clearQueue` are the shapes that would take.
    //   (b) "local-only clear" — dropping the local queue without telling the server (or
    //       overwriting it via a setMove-style reducer) desynchronises predictor and server and
    //       permanently FREEZES movement. `predictor.setMove` / `reducers.setMove` cover that.
    // The accepted design gates the EMIT (R2/R3) and reorders the drain (R1); it never cancels
    // or rewrites an already-queued move. Any reappearance of these call shapes means someone
    // re-implemented a rejected alternative.
    const src = readMainTs();
    const stripped = stripLineComments(src);
    // Anti-vacuity: `stripBlockComments` bails out and DROPS the remainder if it ever sees an
    // unterminated `/*` (e.g. one living inside a string literal). If that happened, the tail of
    // main.ts would go unscanned and this guard would pass vacuously. Comments are a small
    // fraction of main.ts, so a stripped body under half the raw size means the strip ate the file.
    expect(
      stripped.length,
      'comment-stripped main.ts collapsed to under half its raw size — the block-comment strip ' +
        'bailed early (unterminated `/*`), so this ban-list scan would cover only a prefix',
    ).toBeGreaterThan(src.length / 2);
    const banned = [
      'predictor.clearQueue',
      'predictor.setMove',
      'reducers.clearQueue',
      'reducers.setMove',
    ];
    for (const needle of banned) {
      expect(
        stripped.includes(needle),
        `main.ts must NOT contain \`${needle}\` — ADR-0148 §Alternatives rejected both the ` +
          'keyup queue-cancel (measured: up to 1.75 tiles of BACKWARD teleport via the ' +
          "renderer's snap path) and the local-only clear (permanently freezes movement). " +
          'The accepted fix gates the emit and reorders the drain; it never cancels a queued move',
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ux1 (ADR-0151) — source-scan pins backing EARS ux1-1 / ux1-2.
//
// EARS ux1-2: "Battle-result states specifically (victory / flee / defeat) SHALL
//   show a persistent 'Press Esc to continue' (or equivalent) hint for as long as
//   that overlay is showing."
// EARS ux1-1: the on-screen controls hint SHALL be "visible during normal play
//   (not just on first load)".
//
// Both pins below are whole-FILE `indexOf` checks over main.ts — one positive
// (over comment-stripped source), one negative (over raw source; see each test
// for why the two differ). NO `new RegExp(...)` (Semgrep bans it repo-wide) and,
// deliberately, NO fixed-width `slice(idx, idx + N)` window: that slice is this
// repo's documented repeat vacuity trap (nh1 and nh2 post-mortems both shipped a
// scan whose window was shorter than the region it claimed to cover, so the tooth
// passed on the very source it was written to red). Whole-file indexOf has no
// window to be wrong about; do not "optimise" either of these into a windowed form.
// ---------------------------------------------------------------------------

describe('main.ts wiring (ux1, ADR-0151): the Esc-to-continue promise and its zero-JS sibling', () => {
  it('W-UX1-ESCAPE-BATTLE (regression pin, GREEN before AND after the slice by design): main.ts keeps the `Escape && battleView?.visible` branch that the new hint advertises', () => {
    // WRONG IMPL KILLED: any refactor that removes, renames or re-conditions the Escape
    // battle-dismiss branch (e.g. folding it into a generic `anyOverlayVisible` dispatch, or
    // renaming `battleView` in the guard) AFTER the slice ships the hint that names Esc. The
    // hint then advertises a keybinding that no longer exists — a UI that lies to the player.
    //
    // SELF-CHECK — WHY THIS IS NOT VACUOUS (starts GREEN as a guard, by design):
    //   (a) This branch is OTHERWISE WHOLLY UNTESTED. main.ts is coverage-excluded in
    //       client/vite.config.ts, so no unit test executes it, and no e2e spec presses Escape
    //       against a battle-RESULT overlay — nothing anywhere currently proves the branch
    //       exists. Deleting it today would be caught by zero tests.
    //   (b) The slice ships a UI element whose entire content is an ASSERTION THAT THIS
    //       KEYBINDING EXISTS ("Press Esc to continue"). The DOM tooth in
    //       ui/battleView.test.ts proves the hint is SHOWN; only this pin proves the hint is
    //       TRUE. Without it, the two halves of ux1-2 can drift apart silently: the hint keeps
    //       rendering, the key stops working, and every test stays green.
    //   (c) Nothing pinned this before. The pre-existing ESCAPE_SENTINEL constant in this same
    //       file (`"e.code === 'Escape'"`, used by W-OVERLAY-FANOUT-MUTEX) is only ever used as
    //       a block-slicing endpoint — it is never asserted `>= 0` and is not battleView-
    //       specific, so it would happily keep slicing against some OTHER Escape branch after
    //       the battle one was deleted.
    //
    // SECOND-PASS FIX (review battery) — SCAN COMMENT-STRIPPED SOURCE, not raw. Scanning
    // readMainTs() raw meant that block-commenting the Escape branch OUT left this pin GREEN:
    // the needle still occurs, inside the comment. This file already defines
    // stripBlockComments/stripLineComments for exactly that reason ("a needle that only appears
    // in a comment cannot satisfy a tooth"), and the adjacent nh2 tooth (W-NH2-NO-CANCEL) uses
    // stripLineComments(src) — which block-strips first, so it is the strictly stronger of the
    // two and the closer local precedent. Matched here. (Its sibling W-UX1-HINT-NO-JS-OWNER
    // below stays on RAW source on purpose: for a NEGATIVE pin, raw is the conservative
    // direction — a commented-out `help-hint` reference should still trip it.)
    const src = stripLineComments(readMainTs());
    // Diagnostic guard (nh2 precedent): stripBlockComments BAILS and drops the remainder on an
    // unterminated `/*`. For a positive pin that would red loudly rather than pass vacuously, but
    // it would red for the WRONG reason — this assertion separates "the Escape branch was
    // deleted" from "the comment strip ate the tail of main.ts".
    expect(
      src.length,
      'comment-stripped main.ts collapsed to under half its raw size — the block-comment strip ' +
        'bailed early (unterminated `/*`); the Escape-branch pin below would then red for the ' +
        'wrong reason',
    ).toBeGreaterThan(readMainTs().length / 2);
    expect(
      src.indexOf("e.code === 'Escape' && battleView?.visible"),
      "main.ts must retain the branch `e.code === 'Escape' && battleView?.visible` (main.ts:964), " +
        'as live code and not as a comment. ' +
        'EARS ux1-2 puts a persistent "Press Esc to continue" hint on every battle-result ' +
        'overlay; that hint is only truthful while this keybinding exists. main.ts is ' +
        'coverage-excluded and no e2e presses Escape on a result overlay, so this pin is the ' +
        'only thing standing between a refactor of this branch and a UI that lies',
    ).toBeGreaterThanOrEqual(0);
  });

  it('W-UX1-HINT-NO-JS-OWNER (negative pin): the controls hint has NO main.ts owner — `help-hint` must not appear in main.ts', () => {
    // ADR-0151 D2: the `#help-hint` controls badge is deliberately ZERO-JS STATIC MARKUP in
    // client/index.html. Nothing in main.ts creates, queries, shows, hides or re-renders it.
    //
    // WHY THIS IS THE TOOTH FOR ux1-1's "(not just on first load)" QUALIFIER: that qualifier
    // cannot be proven by a DOM test — a rendered-at-load element looks identical to a
    // permanently-visible one at t=0. It is proven STRUCTURALLY instead: an element with no JS
    // owner has nobody who CAN hide it, re-render it away, or drop it on a reconnect/zone
    // switch. The absence of the identifier from main.ts IS the persistence guarantee.
    //
    // WRONG IMPL KILLED: a "helpful" refactor that pulls the hint into a main.ts-managed
    // element (e.g. `document.getElementById('help-hint')`, a `helpHintView`, or a
    // show/hide toggle wired into the overlay mutual-exclusion fan-out). The moment the badge
    // acquires a JS owner it acquires a code path that can hide it, and ux1-1's
    // "during normal play" qualifier stops being structurally guaranteed. This flips RED there.
    //
    // STATUS UPDATE (second pass — the slice landed): at authoring time this pin was green for
    // a TRIVIAL reason (the badge did not exist yet, so the identifier was absent for want of a
    // feature rather than for want of a JS owner). It is now green for the REAL reason: the
    // badge SHIPPED as static markup in client/index.html (covered there by indexShell.test.ts)
    // and main.ts still does not name it. From here on the pin is load-bearing exactly as
    // designed.
    //
    // STATUS UPDATE (uxd3-b / ADR-0163 D4 — the AC-12 click front door): the badge is now
    // CLICKABLE, and main.ts does react to a click on it. It still has no OWNER: the binding is
    // DELEGATED on the `[data-menu-launcher]` attribute inside the pre-existing document click
    // listener, so main.ts never names the id, never resolves the element, and never holds a
    // reference it could hide, re-render or remove. This pin therefore stays green VERBATIM and
    // keeps proving exactly what it always proved. Its companion on the mutation axis is
    // W-UXD3B-LAUNCHER-BRANCH-IS-READ-ONLY, which allow-lists the calls the branch may make.
    //
    // It stays on RAW source: for a negative pin raw is the conservative direction —
    // even a commented-out `help-hint` reference in main.ts should trip it, because it signals
    // that someone started giving the badge a JS owner. Do not weaken this into an
    // index.html-conditional or comment-stripped assertion.
    const src = readMainTs();
    expect(
      src.indexOf('help-hint'),
      'main.ts must NOT reference `help-hint` — ADR-0151 D2 keeps the controls hint as zero-JS ' +
        'static markup in client/index.html precisely so that no code path can hide, re-render ' +
        'or remove it. That is the only structural proof of EARS ux1-1\'s "visible during ' +
        'normal play (not just on first load)" qualifier; giving the badge a JS owner in ' +
        'main.ts destroys it',
    ).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// nh3 (ADR-0152) — the epoch capture at the rejection seam + the send-seq FLOOR.
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-netcode-hardening.spec.md §nh3.
//
// EARS nh3-1 (VERBATIM): "`Predictor` SHALL carry an epoch/generation identifier,
//   bumped on every `resetPredictionState()` rebuild. A rejection `.catch`'s captured
//   epoch SHALL be compared against the live predictor's current epoch before calling
//   `dropRejected(seq)`; a mismatch SHALL no-op instead of evicting."
// PLUS the supervisor-added Case-M2 send-seq FLOOR (nh3 plan §1 mechanism 2): main.ts
//   keeps `let lastSentSeq` updated at the single send site and `resetPredictionState()`
//   calls `predictor.seedSeq(lastSentSeq)` on the fresh instance, so a rebuilt predictor
//   can never re-issue a seq the server has already seen ("stale seq" rejection of the
//   player's first post-warp move — the arm no rejection-side guard can close).
//
// SPEC CONFORMANCE: the epoch COMPARISON lives inside `dropRejected` (the callee), not
// literally in the `.catch` — sanctioned by spec §3, and it is the only placement a
// required parameter can enforce. What main.ts owes is the CAPTURE and the pass-through.
//
// TOOTH -> CLAIM map (correctness vs style, stated honestly):
//   W-NH3-EPOCH-CAPTURED  (a) STYLE pin: ADR-0085 A2 posture — the closure captures
//                             PRIMITIVES at send time (`const epoch = intent.epoch;`),
//                             never the predictor instance, and captures before the
//                             closure exists. Not a correctness proof on its own.
//   W-NH3-DROP-GUARDED    (b) CORRECTNESS: the 2-arg guarded call is the ONLY predictor
//                             touch in the rejection `.catch`.
//   W-NH3-FLOOR-SEND      (c) CORRECTNESS: the floor is recorded at the send site and
//                             its `let` is NOT function-local (a function-local one
//                             resets every call → the floor silently does nothing).
//   W-NH3-FLOOR-SEED      (c) CORRECTNESS: the floor is applied AFTER the rebuild.
// The remaining correctness pins live outside this file: the required-param + brand
// SIGNATURE scan and the N1-N6 behaviour teeth in prediction/predictor.test.ts.
//
// WHY stripLineComments (NOT raw, and NOT stripBlockComments alone): the ADR-0085 A2
// comment block at main.ts:457-470 is `//`-style and its nh3 rewrite WILL mention
// `dropRejected(`, `epoch`, `seedSeq(lastSentSeq)` in prose. Scanning raw source would
// let that comment satisfy every needle below — the classic vacuous-green. `bodyRegion`
// drops the anchor's own line and then strips block comments FIRST, then line comments.
//
// ANCHOR DISCIPLINE (nh1 post-mortem): needle-bounded regions only, every anchor's
// uniqueness re-asserted at runtime, no fixed-width `slice(i, i + N)` windows, and no
// `new RegExp` (Semgrep-banned repo-wide).
// ---------------------------------------------------------------------------

/** The single movement send site (`sendIntent`). START is the enqueue call — verified
 *  unique in main.ts (one occurrence, ~line 453); END is the arrow directly below the
 *  function (~line 474). The region therefore covers the seq/epoch capture, the reducer
 *  call and the whole rejection `.catch` body, and nothing else. */
const NH3_SEND_START = 'const intent = predictor.enqueue(input);';
const NH3_SEND_END = 'const step = (dir';

/** The predictor rebuild (`resetPredictionState`). START is the declaration (unique —
 *  the two CALL sites have no `function ` prefix); END is the next declaration. */
const NH3_RESET_START = 'function resetPredictionState';
const NH3_RESET_END = 'function switchZone';

describe('★ main.ts wiring (nh3/ADR-0152): epoch captured at the rejection seam + seq floor', () => {
  it('★ W-NH3-EPOCH-CAPTURED BITES: sendIntent captures `const epoch = intent.epoch;` before the .catch', () => {
    // RED AT AUTHORING TIME: main.ts:455 captures only `const seq = intent.seq;` — the
    // needle does not exist (0 occurrences), so this reds on the unfixed source.
    //
    // WRONG IMPL KILLED (1): reading `intent.epoch` INSIDE the `.catch` closure. That
    // retains the whole intent object (and, transitively, whatever it references) on a
    // promise that may never settle after a socket drop — the exact retention ADR-0085
    // A2 forbids ("capture primitives, never the instance"). The ordering assertion
    // below (capture before `.catch(`) is what catches it.
    // WRONG IMPL KILLED (2): capturing the epoch from somewhere OTHER than the intent
    // just issued (e.g. a module-level `let currentEpoch` mutated elsewhere) — the
    // whole-statement needle `const epoch = intent.epoch;` plus the "exactly one
    // `epoch =` assignment in the region" count rules that out.
    const src = readMainTs();
    expectUniqueAnchor(src, NH3_SEND_START);
    expectUniqueAnchor(src, NH3_SEND_END);
    const region = bodyRegion(src, NH3_SEND_START, NH3_SEND_END);

    // ADR-0116 bail-guards: a collapsed region, or one that no longer contains the
    // eviction seam, must red LOUDLY rather than pass vacuously.
    expect(
      region.trim().length,
      'the sendIntent region collapsed to nothing — the anchors no longer bound the send site',
    ).toBeGreaterThan(0);
    expect(
      region.includes('dropRejected('),
      'the sendIntent region must still contain the eviction call dropRejected( — if it does ' +
        'not, these anchors no longer bound the rejection seam and every needle below is vacuous',
    ).toBe(true);

    expect(
      region.includes('const epoch = intent.epoch;'),
      'sendIntent must capture the epoch as the WHOLE statement `const epoch = intent.epoch;` ' +
        'beside `const seq = intent.seq;` (ADR-0152 / ADR-0085 A2: capture primitives at send ' +
        'time). RED today: main.ts captures only the seq',
    ).toBe(true);
    expect(
      region.split('epoch =').length - 1,
      'the sendIntent region must contain EXACTLY ONE `epoch =` assignment — a second one ' +
        'means the epoch passed to dropRejected may not be the one this intent was stamped ' +
        'with (e.g. re-derived from a mutable module-level variable at fire time)',
    ).toBe(1);

    const capIdx = region.indexOf('const epoch = intent.epoch;');
    const catchIdx = region.indexOf('.catch(');
    expect(
      catchIdx,
      'the sendIntent region must contain the rejection `.catch(` — without it there is no ' +
        'rejection seam to guard',
    ).toBeGreaterThanOrEqual(0);
    expect(
      capIdx,
      'the epoch must be captured BEFORE the `.catch(` closure is created — reading ' +
        '`intent.epoch` inside the closure retains the intent object on a promise that may ' +
        'never settle after a socket drop (ADR-0085 A2 forbids holding non-primitives there)',
    ).toBeLessThan(catchIdx);
  });

  it('★ W-NH3-DROP-GUARDED BITES: the rejection .catch calls predictor.dropRejected(seq, epoch) and touches the predictor nowhere else', () => {
    // RED AT AUTHORING TIME: main.ts:471 is `if (predictor.dropRejected(seq))` — the
    // 2-arg needle has 0 occurrences on the unfixed source.
    //
    // WRONG IMPL KILLED (1): a revert of the call site to the 1-arg form (tsc also
    // catches that once the param is required — this is the belt).
    // WRONG IMPL KILLED (2): the SELF-APPROVING call — passing anything read from the
    // LIVE predictor instead of the captured epoch (`predictor.dropRejected(seq,
    // predictor.<something>)`). Such a call always matches, i.e. the guard is deleted
    // at the call site while every behaviour test in prediction/ stays green. The
    // "exactly as many `predictor.` references as guarded calls" count is the kill;
    // predictor.test.ts's W-NH3-NO-GETTER closes the same hole from the other side by
    // banning the getter that would make it writable.
    // WRONG IMPL KILLED (3): a second, UNGUARDED predictor mutation smuggled into the
    // same `.catch` (e.g. `predictor.seedSeq(...)` on a rejection).
    const src = readMainTs();
    expectUniqueAnchor(src, NH3_SEND_START);
    expectUniqueAnchor(src, NH3_SEND_END);
    const region = bodyRegion(src, NH3_SEND_START, NH3_SEND_END);
    const catchIdx = region.indexOf('.catch(');
    expect(
      catchIdx,
      'the sendIntent region must contain the rejection `.catch(` (ADR-0085 D3 send seam)',
    ).toBeGreaterThanOrEqual(0);
    // squashWhitespace so the needle survives any biome line-wrapping of the call.
    const catchBody = squashWhitespace(region.slice(catchIdx));

    // ADR-0116 bail-guard: the slice must really contain the eviction seam.
    expect(
      catchBody.includes('dropRejected('),
      'the `.catch` body must contain dropRejected( — otherwise this scan is judging the ' +
        'wrong slice of main.ts',
    ).toBe(true);

    const guardedCalls = catchBody.split('predictor.dropRejected(seq, epoch)').length - 1;
    expect(
      guardedCalls,
      'the rejection `.catch` must call `predictor.dropRejected(seq, epoch)` — the CAPTURED ' +
        'epoch, passed positionally as the second argument (ADR-0152). RED today: the call ' +
        'site is still the 1-arg `predictor.dropRejected(seq)`',
    ).toBeGreaterThanOrEqual(1);

    const predictorRefs = catchBody.split('predictor.').length - 1;
    expect(
      predictorRefs,
      'the rejection `.catch` must touch `predictor.` ONLY through the guarded ' +
        'dropRejected(seq, epoch) call. Any additional reference is either a self-approving ' +
        'epoch read from the live instance (which deletes the guard at the call site while ' +
        'every unit test stays green) or an unguarded predictor mutation on a rejection path',
    ).toBe(guardedCalls);
  });

  it('★ W-NH3-FLOOR-SEND BITES: the send site records the seq floor, and `lastSentSeq` is not function-local', () => {
    // RED AT AUTHORING TIME: `lastSentSeq` does not exist in main.ts (0 occurrences).
    //
    // WRONG IMPL KILLED (1): the floor is never recorded — Case M2 stays open (the
    // rebuilt predictor re-issues a seq the server already acked, that op is rejected as
    // "stale seq", and the player's first post-warp move is swallowed). The epoch guard
    // cannot close this arm: that rejection carries the LIVE epoch and is correct.
    // WRONG IMPL KILLED (2, the sneaky one): `let lastSentSeq = 0;` declared INSIDE
    // sendIntent. Both needles above would still be present, the code compiles, lint is
    // clean — and the variable resets to 0 on every call, so `seedSeq(0)` is a no-op and
    // the floor does nothing at all. The scope assertion below is the only thing that
    // reds it.
    const src = readMainTs();
    expectUniqueAnchor(src, NH3_SEND_START);
    expectUniqueAnchor(src, NH3_SEND_END);
    expectUniqueAnchor(src, 'function sendIntent(');
    const region = bodyRegion(src, NH3_SEND_START, NH3_SEND_END);

    expect(
      region.includes('lastSentSeq = seq;'),
      'the single send site must record the floor with `lastSentSeq = seq;` beside ' +
        '`const seq = intent.seq;` (nh3 plan §1 mechanism 2) — this is the value ' +
        'resetPredictionState() seeds the rebuilt predictor with',
    ).toBe(true);

    const stripped = stripLineComments(src);
    // Anti-vacuity (nh2 precedent): stripBlockComments BAILS and drops the remainder on an
    // unterminated `/*`; a stripped body under half the raw size means the strip ate the file.
    expect(
      stripped.length,
      'comment-stripped main.ts collapsed to under half its raw size — the block-comment strip ' +
        'bailed early (unterminated `/*`), so the scope scan below would cover only a prefix',
    ).toBeGreaterThan(src.length / 2);
    expect(
      stripped.includes('let lastSentSeq'),
      'main.ts must DECLARE the floor accumulator (`let lastSentSeq = 0;` per nh3 plan §1) ' +
        'as live code, not only assign to it',
    ).toBe(true);

    // The declaration must live at MODULE scope, i.e. anywhere except inside sendIntent.
    const sendFnBody = bodyRegion(src, 'function sendIntent(', NH3_SEND_END);
    expect(
      sendFnBody.includes('let lastSentSeq'),
      'the `let lastSentSeq` declaration must NOT be inside sendIntent — a function-local ' +
        'accumulator is re-initialised on every send, so `predictor.seedSeq(lastSentSeq)` ' +
        'would always seed 0 and the Case-M2 floor would silently do nothing while both ' +
        'needles above still match',
    ).toBe(false);
  });

  it('★ W-NH3-FLOOR-SEED BITES: resetPredictionState() seeds the FRESH predictor with the floor, after constructing it', () => {
    // RED AT AUTHORING TIME: resetPredictionState() constructs the predictor and never
    // calls seedSeq (0 occurrences of the needle in main.ts).
    //
    // WRONG IMPL KILLED (1): no seeding at all — Case M2 stays open (see W-NH3-FLOOR-SEND).
    // WRONG IMPL KILLED (2, the ordering mutant): `predictor.seedSeq(lastSentSeq);` placed
    // BEFORE `predictor = new Predictor(...)`. That seeds the DEAD instance — the one about
    // to be discarded — so the fresh predictor still starts at #nextSeq = 0 and re-issues
    // the colliding seq. Every needle-presence check would pass; only the position compare
    // reds it.
    // WRONG IMPL KILLED (3): seeding with something other than the floor (e.g.
    // `seedSeq(0)`) — the contiguous needle includes the argument.
    const src = readMainTs();
    expectUniqueAnchor(src, NH3_RESET_START);
    expectUniqueAnchor(src, NH3_RESET_END);
    const region = squashWhitespace(bodyRegion(src, NH3_RESET_START, NH3_RESET_END));

    // ADR-0116 bail-guard: prove this really is the rebuild body before judging it.
    expect(
      region.includes('new Predictor('),
      'the resetPredictionState region must contain the `new Predictor(` rebuild — if it does ' +
        'not, these anchors no longer bound the rebuild and the pin below is vacuous',
    ).toBe(true);

    const seedIdx = region.indexOf('predictor.seedSeq(lastSentSeq);');
    expect(
      seedIdx,
      'resetPredictionState() must call `predictor.seedSeq(lastSentSeq);` on the freshly ' +
        'constructed predictor (nh3 plan §1 mechanism 2) — without it the rebuilt instance ' +
        "restarts #nextSeq at 0 and re-issues seqs the server has already acked (Case M2's " +
        'swallowed first post-warp move)',
    ).toBeGreaterThanOrEqual(0);

    const ctorIdx = region.indexOf('new Predictor(');
    expect(
      ctorIdx,
      'the seedSeq(lastSentSeq) call must come AFTER `predictor = new Predictor(...)` — placed ' +
        'before it, the floor is applied to the DEAD instance and the fresh predictor still ' +
        'starts at 0 (a needle-presence-only tooth would not notice)',
    ).toBeLessThan(seedIdx);
  });
});

// ===========================================================================
// dev-observability (ADR-0157) — W-DEVLOG-EAGER. APPENDED block; nothing above
// is modified.
//
// SOURCE OF TRUTH: plan §A8 + §D (gate `W-DEVLOG-EAGER`), ADR-0157 §2.
//
// TWO HALVES, both required:
//   (a) EAGER: `resolveDevLogLevel(` is called at MODULE scope — i.e. BEFORE the
//       `async function main(` declaration and never inside its body. This is the
//       existing F-3 idiom, for the same reason: the resolver is fail-loud in DEV, and
//       a throw from inside main() (or from inside a try/catch there) is swallowed.
//   (b) THREADED: the connect({ … }) call passes the EXACT token sequence
//       `onSend: sendLogger` (§A8, verbatim), and the `sendLogger` binding is the whole
//       result of a module-scope `makeSendLogger(…)` whose injected sink writes to
//       console.log and touches NO ring. A resolved level and a constructed sink that
//       nobody consumes is dead config — the feature would look wired and log nothing.
//
// WHY (b) PINS THE VALUE, NOT JUST THE KEY (red-team, PROVEN bypass of the first draft of
// this gate): main.ts already imports and uses `eventRing` (:74-82, :229, :2023), so an
// inline arrow satisfied a mere `onSend:`-is-present check while re-opening exactly the
// hazard ADR-0157 §4 exists to prevent:
//     onSend: (name, args) => {
//       sendLogger?.(name, args);
//       eventRing.push({ kind: 'reducerCall', name, args, ts: Date.now() } as any);
//     },
// devLog.ts's own eval cannot see that — the violation lives in main.ts. Requiring the
// value to be the BARE IDENTIFIER `sendLogger` makes an inline sink structurally
// impossible, and the balanced-paren scan of the `makeSendLogger(` call arguments closes
// the same hole one level down (a ring push smuggled into the injected `out` closure).
//
// NOTE on scope: the ring-needle ban is applied to the makeSendLogger ARGUMENT LIST, not
// to the whole connect({ … }) region. The connect options legitimately contain
// `eventRing.push(makeConnect(identity))` in onReady/onReconnect (pt-b1, ADR-0130) — a
// region-wide ban would red CORRECT code. The pins above are what close the send path.
//
// RED AT AUTHORING TIME: main.ts contains neither `resolveDevLogLevel(` nor
// `makeSendLogger(` nor `onSend:` (0 occurrences each).
//
// Uses the file's existing helpers (expectUniqueAnchor / bodyRegion / stripLineComments /
// squashWhitespace) — function declarations, so definition order above is irrelevant.
// NO `new RegExp(...)`.
// ===========================================================================

/** The `connect({ … })` options-object region: START is the single call site, END is the
 *  comment that immediately follows the closing `});`. Needle-bounded (NOT a fixed-width
 *  window — the nh1 post-mortem anti-pattern) so `onSend:` is found wherever in the option
 *  list the implementer puts it, but NOT if it drifts outside the connect() call entirely. */
const DEVLOG_CONNECT_START = 'conn = connect({';
const DEVLOG_CONNECT_END = '12.5c-4: frame loop is wrapped';

/** The shared-artifact substrate devlog content must never reach (ADR-0157 §4 / obs-e).
 *  A local copy of the eval's needle list: the eval can only see devLog.ts, so the main.ts
 *  side of the same firewall has to be checked here. */
const DEVLOG_RING_NEEDLES = ['eventRing', 'errorRing', 'bugBundle', 'pushError'];

/** Return the ARGUMENT LIST of the first `needle` call in `src`, by balanced-paren scan
 *  from the `(` that terminates the needle. Throws loud when the call is absent or the
 *  parens never balance — a missing implementation must be a HARD RED, never a vacuous
 *  pass. Hand-rolled scan; `new RegExp` is Semgrep-banned in this file. */
function callArgs(src: string, needle: string): string {
  const idx = src.indexOf(needle);
  if (idx < 0) {
    throw new Error(`main.ts must contain the call "${needle}" (ADR-0157 §A8 wiring)`);
  }
  let i = idx + needle.length - 1; // the needle ends with '('
  let depth = 0;
  const start = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  throw new Error(`unbalanced parentheses after "${needle}" in main.ts — refusing to scan`);
}

describe('★ main.ts wiring (ADR-0157): W-DEVLOG-EAGER — module-scope resolve + onSend threaded into connect()', () => {
  it('★ W-DEVLOG-EAGER BITES (a): resolveDevLogLevel( is called at MODULE scope, BEFORE `async function main(`', () => {
    // WRONG IMPL KILLED (1): no call at all — the flag is never read and the whole feature
    // is dead (indexOf returns -1).
    // WRONG IMPL KILLED (2): the resolve moved INSIDE main() (or into a try/catch there).
    // resolveDevLogLevel RETHROWS in dev by design; swallowed, a developer's flag typo
    // silently produces "the feature is broken" instead of an instant, named error — which
    // is the entire justification for §A3's asymmetry.
    const src = readMainTs();
    const callIdx = src.indexOf('resolveDevLogLevel(');
    expect(
      callIdx,
      'main.ts must call resolveDevLogLevel( — RED today: it does not appear at all (ADR-0157 §2)',
    ).toBeGreaterThanOrEqual(0);

    const mainFnIdx = src.indexOf('async function main(');
    expect(
      mainFnIdx,
      'async function main( declaration must be present in main.ts',
    ).toBeGreaterThanOrEqual(0);
    expect(
      callIdx,
      'the resolveDevLogLevel( call must appear BEFORE `async function main(` — at module ' +
        'scope, beside the pt-a1 resolveConnectionConfig call (§A8), so the DEV rethrow is ' +
        'not swallowed by a try/catch inside main()',
    ).toBeLessThan(mainFnIdx);

    // No SECOND call inside main() (the F-3c precedent): only the module-scope call is
    // eager, and a duplicate there is either dead or a second, divergent SSOT.
    const afterMain = stripLineComments(src.slice(mainFnIdx));
    expect(
      afterMain.indexOf('resolveDevLogLevel('),
      'resolveDevLogLevel( must NOT appear inside async function main() — the module-scope ' +
        'call is the only eager one',
    ).toBe(-1);
  });

  it('★ W-DEVLOG-EAGER BITES (b): the connect({ … }) call passes the BARE identifier — `onSend: sendLogger`, never an inline sink', () => {
    // WRONG IMPL KILLED (1): the level is resolved and a logger constructed, but `onSend:`
    // is never passed to connect( — DEAD CONFIG. The flag would parse, the resolver would
    // fail loud on a typo, and not one reducer call would ever be logged. Nothing else in
    // this slice's gates can see that: devLog.test.ts proves the module works in isolation
    // and connection.test.ts proves build() wraps whatever it is given.
    // WRONG IMPL KILLED (2): `onSend:` present somewhere else in main.ts (e.g. on an unrelated
    // options object) but not inside the connect({ … }) call — the region is needle-bounded to
    // that call, so a stray occurrence elsewhere cannot credit it.
    // WRONG IMPL KILLED (3, red-team PROVEN): an INLINE arrow that calls the sendLogger and
    // ALSO pushes the call into eventRing — main.ts already has eventRing in scope, so the
    // shared, downloadable F9 bundle would start carrying `joinGame({name})` /
    // `setNickname({nickname})` / `setProfileName({name})` free text (pt-b1 U-3, ADR-0157 §4).
    // A key-only `onSend:` check waves that through; requiring the value to be the BARE
    // identifier makes any inline body structurally impossible.
    // WRONG IMPL KILLED (4): passing a raw `console.log` or a hand-rolled closure instead of
    // makeSendLogger's result — the level filter and the 'off' ⇒ undefined ⇒ strict-identity
    // path would both be bypassed, so the default prod build would install a live Proxy.
    const src = readMainTs();
    expect(
      src.includes('makeSendLogger('),
      'main.ts must construct the sink with makeSendLogger(DEV_LOG_LEVEL, (line) => …) (§A8) — ' +
        "it is what returns undefined at level 'off', which is what makes wrapReducerLogging " +
        'strict identity in the default production build',
    ).toBe(true);

    expectUniqueAnchor(src, DEVLOG_CONNECT_START);
    expectUniqueAnchor(src, DEVLOG_CONNECT_END);
    const region = bodyRegion(src, DEVLOG_CONNECT_START, DEVLOG_CONNECT_END);

    // Anti-vacuity bail-guard: prove the region really is the connect() options object
    // before judging it (a collapsed/wrong region would make the pin below meaningless).
    expect(
      region.includes('onReady:'),
      'the connect({ … }) region must still contain onReady: — if it does not, these anchors ' +
        'no longer bound the connect call and the onSend: pin below is vacuous',
    ).toBe(true);

    expect(
      region.includes('onSend:'),
      'the connect({ … }) call must pass `onSend:` (§A8) — without it the resolved level and ' +
        'the constructed logger are dead config and no outbound reducer call is ever logged ' +
        '(EARS-1 never fires)',
    ).toBe(true);

    // squashWhitespace so the pin survives any biome line-wrapping of the option list.
    expect(
      squashWhitespace(region).includes('onSend: sendLogger'),
      'the option must be the VERBATIM `onSend: sendLogger` (§A8) — a bare identifier, never ' +
        'an inline arrow. main.ts has eventRing in scope, so an inline sink can push reducer ' +
        'args (player free text) into the shared, downloadable F9 bundle — the one thing ' +
        'ADR-0157 §4 forbids, and something the devLog.ts eval structurally cannot see',
    ).toBe(true);

    // The binding must be the module-scope makeSendLogger result (not a wrapper around it).
    // Comment-stripped + squashed, so neither a prose mention nor line-wrapping can credit
    // or defeat the pin.
    const live = squashWhitespace(stripLineComments(src));
    expect(
      live.indexOf('const sendLogger = makeSendLogger('),
      'main.ts must bind `const sendLogger = makeSendLogger(…)` (§A8) — the identifier passed ' +
        'to onSend: must be the logger itself, not a closure wrapping it',
    ).toBeGreaterThanOrEqual(0);
    expect(
      live.indexOf('makeSendLogger('),
      'the makeSendLogger( construction must sit at MODULE scope, before `async function ' +
        'main(` — beside the eager resolve (§A8)',
    ).toBeLessThan(live.indexOf('async function main('));
  });

  it('★ W-DEVLOG-EAGER BITES (c): the injected sink writes to console.log and touches NO ring (ADR-0157 §4 firewall, main.ts side)', () => {
    // WRONG IMPL KILLED (1, red-team PROVEN one level down): the ring push moved OUT of the
    // connect option and INTO the injected `out` closure —
    //     makeSendLogger(DEV_LOG_LEVEL, (line) => { console.log(line); eventRing.push(…); })
    // — which satisfies `onSend: sendLogger` while still shipping devlog content into the
    // shared F9 bundle. Scanning the makeSendLogger ARGUMENT LIST (balanced-paren, not a
    // fixed-width window) is what closes it. This is deliberately scoped to the argument
    // list and NOT to the whole connect region: the connect options legitimately contain
    // `eventRing.push(makeConnect(identity))` (pt-b1/ADR-0130), so a region-wide ring ban
    // would red correct code.
    // WRONG IMPL KILLED (2): `console.debug` instead of `console.log` — Chrome hides debug
    // behind the Verbose level by default, so the feature would read as broken (ADR-0157 §2).
    // Comments are stripped BEFORE the balanced-paren scan so a prose mention of
    // `makeSendLogger(...)` cannot capture the scan (and so a commented-out ring push
    // cannot red a clean impl).
    const args = callArgs(stripLineComments(readMainTs()), 'makeSendLogger(');

    // Anti-vacuity: the argument list must actually contain the sink, or this scan is
    // judging the wrong slice.
    expect(
      args.includes('=>'),
      'the makeSendLogger( argument list must contain the injected sink arrow `(line) => …` — ' +
        'if it does not, this scan is not looking at the sink and the ban below is vacuous',
    ).toBe(true);
    expect(
      args.includes('console.log'),
      'the injected sink must write to console.log (§A8) — NOT console.debug, which Chrome ' +
        'hides behind the Verbose level so the feature reads as broken',
    ).toBe(true);

    for (const needle of DEVLOG_RING_NEEDLES) {
      expect(
        args.includes(needle),
        `the makeSendLogger( sink must NOT reference "${needle}" — reducer-call records are ` +
          'CONSOLE-ONLY (ADR-0157 §4). The args carry player free text (joinGame({name}), ' +
          'setNickname, setProfileName) and the ring is serialised into the F9 bundle Drew ' +
          'SHARES (pt-b1 U-3). Deferred as obs-e',
      ).toBe(false);
    }
  });
});

// ===========================================================================
// mvi (movement-investigation) — hold-commit threshold wiring
// ===========================================================================
//
// SOURCE OF TRUTH: the movement-investigation spec. THREE source-level changes, all in
// main.ts, all one-liners:
//   M1  keydown movement branch (:1096): `held.press(dir);`
//         → `held.press(dir, performance.now());`
//       The FIRST step (`step(dir);`) stays UNGATED — the whole point of the fix is that
//       a tap still moves exactly one tile, immediately.
//   M2  reconcile divergence emitter (:449) and
//   M3  rAF frame-loop emitter (:2137): `reissueDir(held.active(), predictor.lastQueuedDir)`
//         → `reissueDir(held.committedActive(now), predictor.lastQueuedDir)`
//       BOTH sites, or the defect survives via whichever one was missed.
//   `const held = new HeldDirections();` (:153) stays ARGLESS — the shipped threshold is
//   the module default HOLD_COMMIT_MS.
//
// WHY a source scan at all: the BEHAVIOUR is proven node-only in
// client/src/prediction/movementSim.test.ts, over a model of exactly these lines. That
// model is worthless if main.ts does not actually carry the shape it models — main.ts is
// not importable under vitest (module-scope DOM/PIXI/wasm side effects), so this file is
// the only thing that binds the two together.
//
// ANCHOR DISCIPLINE (nh1 post-mortem, unchanged): every region is needle-bounded via
// bodyRegion/regionOrThrow, every anchor's uniqueness in main.ts is asserted inline with
// expectUniqueAnchor, and no fixed-width windows. No `new RegExp` — indexOf/includes/split
// only; whole-file counts use split(), never a global regex.
//
// INHERITED UN-KILLABLE CLASS (disclosed exactly as W-NH2-GATE-WIRED does; unchanged by
// this slice and NOT claimed as closed):
//   (a) `if (true || <predicate>)` — and symmetrically any `|| <other predicate>` appended
//       after a required prefix: the text matches, the semantics are reverted. Reachable
//       only by EVALUATING the expression.
//   (b) a SECOND, ungated emitter added BELOW a region end (outside both anchors), or a
//       second `store.onBatchApplied` listener that re-issues ungated.
// The `held.active(` === 0 whole-file count in W-MVI-COMMITTED-WIRED narrows (b) for the
// specific mutant "a new emitter grabs the UNGATED accessor" (that is the ADR-0148
// residual (b) this slice partially closes), but it cannot see an emitter that calls
// `committedActive` and then ignores the result, nor one that re-derives held state some
// other way. Closing (a)/(b) properly needs the parked nh2-e2e Playwright tooth — do not
// read these teeth as proving their absence.

/** The keydown MOVEMENT branch. START is the two-line `const dir = KEY_DIR[e.code];` +
 *  `if (dir !== undefined) {` pair, which is what makes it unique: the SAME `const dir =`
 *  line also opens the keyup handler (~:1108), but there it is followed by
 *  `if (dir !== undefined) held.release(dir);` — a different second line. END is the Space
 *  branch that immediately follows the movement branch. Deliberately NOT reusing
 *  W-NH1-SUPPRESS's anchors ('Suppress movement input while an overlay is open' /
 *  'const dir = KEY_DIR[e.code];'): sharing an anchor couples two teeth's regions, and this
 *  one must bound the branch BODY, not the block above it.
 *  BRITTLENESS (accepted + disclosed): the START needle carries the branch's two-space
 *  indentation, so a re-indentation of the keydown listener reds this tooth with a loud
 *  `regionOrThrow` throw rather than a silent pass. Correct the needle FROM THE SPEC if
 *  that ever happens — never widen it to a bare `const dir =`, which matches the keyup
 *  handler too. */
const MVI_KEYDOWN_START = 'const dir = KEY_DIR[e.code];\n  if (dir !== undefined) {';
const MVI_KEYDOWN_END = "if (e.code === 'Space') {";

/** Count NON-OVERLAPPING occurrences of `needle` in `src` via split (no `new RegExp`). */
function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('★ main.ts wiring (mvi): the hold-commit threshold is wired into BOTH continuation emitters', () => {
  it('★ W-MVI-COMMITTED-WIRED BITES: both re-issue sites call reissueDir(held.committedActive(now), predictor.lastQueuedDir) and held.active( is gone', () => {
    // RED AT AUTHORING TIME: `held.committedActive(` appears 0 times in main.ts and
    // `held.active(` appears twice (:449 and :2137). Every assertion below fails on the
    // unfixed source.
    //
    // WRONG IMPL KILLED (1): the unfixed code — a held key becomes eligible for
    // CONTINUATION the instant it goes down, so the first frame after the server's
    // movement_tick drain is observed re-issues a second step. Inside a 50-150ms tap that
    // is a coin flip on the tick phase, which is Drew's r2 "one tap moves 2 tiles".
    // WRONG IMPL KILLED (2): fixing ONE site only. The rAF loop is the obvious emitter, but
    // the reconcile-divergence site emits the identical extra step on any authoritative
    // reposition landing mid-tap. Both regions are asserted separately, so a half fix reds
    // (movementSim S9a/S9b are the behavioural halves of this same pair).
    // WRONG IMPL KILLED (3): calling committedActive with the WRONG clock — the CONTIGUOUS
    // needle pins the argument to the frame's own `now`. `committedActive(Date.now())`
    // compares a wall-clock instant against a performance.now() press stamp (an offset of
    // ~1.7e12 ms), so every held key would read as "committed since the Unix epoch" and the
    // fix would be a no-op. `committedActive()` (argless) would not type-check, but
    // `committedActive(performance.now())` would — and would silently re-read the clock
    // AFTER the drain, which is not the frame's decision time.
    // WRONG IMPL KILLED (4) — THE RESIDUAL THIS SLICE PARTIALLY CLOSES (ADR-0148 residual
    // (b)): a future third emitter that grabs the UNGATED accessor. `held.active(` === 0
    // over the WHOLE FILE means the ungated accessor has no call site left at all, so such
    // an emitter cannot be written without also reding this tooth. (It does NOT see an
    // emitter that calls committedActive and ignores the answer — see the disclosure above.)
    const src = readMainTs();
    expectUniqueAnchor(src, NH2_RECONCILE_START);
    expectUniqueAnchor(src, NH2_RECONCILE_END);
    expectUniqueAnchor(src, NH2_RAF_START);
    expectUniqueAnchor(src, NH2_RAF_END);

    const emitter = 'reissueDir(held.committedActive(now), predictor.lastQueuedDir)';

    const reconcileRegion = squashWhitespace(
      bodyRegion(src, NH2_RECONCILE_START, NH2_RECONCILE_END),
    );
    // Anti-vacuity: prove the region still bounds a held-dir re-issue site before judging it.
    expect(
      reconcileRegion.includes('reissueDir('),
      'the reconcile-divergence region must contain the held-dir re-issue call reissueDir( — ' +
        'if it does not, the anchors no longer bound the block this tooth is about',
    ).toBe(true);
    expect(
      reconcileRegion.includes(emitter),
      `the reconcile-divergence re-issue must read the COMMITTED held dir: \`${emitter}\`. ` +
        'Without it, a server reposition landing during a 50-150ms tap re-commits the tapped ' +
        'direction and the player moves a second tile (movementSim S9b)',
    ).toBe(true);

    const rafRegion = squashWhitespace(bodyRegion(src, NH2_RAF_START, NH2_RAF_END));
    expect(
      rafRegion.includes('reissueDir('),
      'the rAF held-key re-issue region must contain the held-dir re-issue call reissueDir( — ' +
        'if it does not, the anchors no longer bound the block this tooth is about',
    ).toBe(true);
    expect(
      rafRegion.includes(emitter),
      `the rAF held-key continuation must read the COMMITTED held dir: \`${emitter}\`. This is ` +
        "the primary site of Drew's r2 double-move: the frame after the drain snapshot lands " +
        're-issues a step while the tap key is still physically down (movementSim S1)',
    ).toBe(true);

    // [red-team hardening] occurrence-count discipline: EXACTLY ONE `reissueDir(` call per
    // region. `bodyRegion` strips comments but NOT string/template-literal contents, so a dead
    // decoy such as `` const _sig = `reissueDir(held.committedActive(now), predictor.lastQueuedDir)`; ``
    // sitting next to a REVERTED real call satisfies the `.includes(emitter)` checks above by
    // itself while the actual re-issue reads the ungated accessor via bracket-notation
    // (`held['active']()`), which ALSO dodges the whole-file `held.active(` ban below (no
    // literal dot-notation substring). Any decoy that reproduces the emitter text necessarily
    // reproduces its `reissueDir(` prefix too, so a lone "region must contain the emitter"
    // check cannot see the duplication — this count can. PoC verified (scratch, not committed):
    // both sites reverted to `held['active']()` plus one decoy string per region passed every
    // other assertion in this tooth (the whole 135-test gating suite stayed green) before this
    // check was added.
    expect(
      countOccurrences(reconcileRegion, 'reissueDir('),
      'the reconcile-divergence region must contain EXACTLY ONE reissueDir( call — a second ' +
        'occurrence (e.g. a decoy string literal duplicating the emitter text) means the ' +
        'emitter check above can be satisfied by dead data while the REAL call reverts',
    ).toBe(1);
    expect(
      countOccurrences(rafRegion, 'reissueDir('),
      'the rAF held-key re-issue region must contain EXACTLY ONE reissueDir( call — same ' +
        'decoy-string closure as the reconcile-region count above',
    ).toBe(1);

    // WHOLE-FILE counts (comment-stripped, so prose cannot credit or defeat them).
    const live = stripLineComments(src);
    expect(
      live.length,
      'comment-stripped main.ts collapsed to under half its raw size — the block-comment strip ' +
        'bailed early (unterminated `/*`), so these whole-file counts would cover only a prefix',
    ).toBeGreaterThan(src.length / 2);
    expect(
      countOccurrences(live, 'held.committedActive('),
      'main.ts must have EXACTLY TWO held.committedActive( call sites — the rAF continuation ' +
        'and the reconcile-divergence continuation. Fewer means a site was missed; more means ' +
        'a third continuation emitter exists that no behavioural tooth in this slice models',
    ).toBe(2);
    expect(
      countOccurrences(live, 'held.active('),
      'main.ts must have ZERO held.active( call sites after this slice: the UNGATED accessor ' +
        'is what re-issues a continuation for a key that has been down for 2ms. Leaving a live ' +
        'call site (or adding one back later) is exactly the ADR-0148 residual (b) mutant — a ' +
        'second emitter that reaches past the gate. HeldDirections.active() itself stays ' +
        'exported and unit-tested; it just has no call site in the integration loop',
    ).toBe(0);
  });

  it('★ W-MVI-KEYDOWN-UNGATED BITES: the keydown movement branch is `step(dir); held.press(dir, performance.now());` — first step UNGATED, press timestamped', () => {
    // RED AT AUTHORING TIME: main.ts:1096 reads `held.press(dir);` with no timestamp.
    //
    // WRONG IMPL KILLED (1): GATING THE FIRST STEP. The single most tempting wrong fix is to
    // move the threshold onto the keydown itself ("don't move until the key has been held
    // 150ms"). That trades a rare double-move for 150ms of input lag on EVERY tap — the
    // exact regression ADR-0013's immediate-first-step design exists to avoid. The negative
    // assertions below (no `committedActive`, no `outstandingSteps` in this region) are what
    // make that unwriteable here.
    // WRONG IMPL KILLED (2): `held.press(dir, e.timeStamp)`. It type-checks, it looks more
    // "correct" than reading the clock, and it is a silent revert: e.timeStamp is 0 for
    // synthetic events and is measured from a DIFFERENT origin than performance.now(), so
    // `now - pressedAtMs` reads as "held since page load" and every key commits instantly.
    // WRONG IMPL KILLED (3): `held.press(dir, Date.now())` — a wall-clock instant compared
    // against performance.now() at the emitters; ~1.7e12ms of "hold time", same instant
    // commit, same defect.
    // WRONG IMPL KILLED (4): dropping the press entirely (`step(dir);` alone) — continuous
    // movement dies silently; the contiguous two-statement needle catches it.
    //
    // The needle is checked CONTIGUOUSLY (comment-stripped, whitespace-squashed) so the two
    // statements must be adjacent: nothing may be interposed between the immediate step and
    // the press that records when it happened.
    const src = readMainTs();
    expectUniqueAnchor(src, MVI_KEYDOWN_START);
    expectUniqueAnchor(src, MVI_KEYDOWN_END);
    const region = squashWhitespace(bodyRegion(src, MVI_KEYDOWN_START, MVI_KEYDOWN_END));

    // Anti-vacuity: prove the region really is the keydown movement branch.
    expect(
      region.includes('step(dir);'),
      'the keydown movement region must contain the immediate first step `step(dir);` — if it ' +
        'does not, these anchors no longer bound the branch this tooth is about',
    ).toBe(true);

    expect(
      region.includes('step(dir); held.press(dir, performance.now());'),
      'the keydown movement branch must be exactly `step(dir); held.press(dir, ' +
        'performance.now());` — the immediate first step, then the press stamped with the ' +
        'SAME clock the two continuation emitters read. e.timeStamp (0 in synthetic events, ' +
        'different time origin) and Date.now() (wall clock) both make every key read as ' +
        '"held since page load", which reverts the fix while type-checking cleanly',
    ).toBe(true);

    expect(
      region.includes('committedActive'),
      'the keydown movement branch must NOT consult committedActive: the FIRST step is ' +
        'deliberately UNGATED (ADR-0013). Gating it would add 150ms of input lag to every ' +
        'single tap — a far worse defect than the one being fixed',
    ).toBe(false);
    expect(
      region.includes('outstandingSteps'),
      'the keydown movement branch must NOT consult predictor.outstandingSteps either — the ' +
        'nh2/ADR-0148 gate applies to the CONTINUATION emitters only. sendIntent already ' +
        'declines an over-cap enqueue (ADR-0052); gating the keypress itself drops the ' +
        "player's deliberate input on the floor",
    ).toBe(false);
  });

  it('W-MVI-HELD-ARGLESS: `const held = new HeldDirections();` appears exactly once, with NO threshold argument (GREEN regression guard)', () => {
    // GREEN REGRESSION GUARD — NOT red today, and labelled so deliberately (the W-NH2-NO-CANCEL
    // precedent: mislabelling a green guard as RED is itself a defect). The argless line already
    // exists on master; what this slice CHANGES is that `HeldDirections` gains an optional
    // `holdCommitMs` constructor parameter, which is what makes the mutant below writeable for
    // the first time. The guard is authored now so the threshold can never be forked at the one
    // call site that ships.
    //
    // WRONG IMPL KILLED (1): `new HeldDirections(0)` — the threshold is disabled at the
    // single call site that matters while heldKeys.ts still exports HOLD_COMMIT_MS = 150 and
    // every unit tooth in heldKeys.test.ts (which constructs its own instances) stays green.
    // movementSim.test.ts uses holdCommitMs=0 as its documented ANTI-VACUITY control, so the
    // behavioural suite would stay green too. This is the one place that sees it.
    // WRONG IMPL KILLED (2): any hand-tuned literal (`new HeldDirections(120)`) that forks
    // the shipped threshold away from the one U-H8's budget pin protects.
    // WRONG IMPL KILLED (3): a SECOND HeldDirections instance constructed elsewhere in
    // main.ts (e.g. a per-view tracker) — two held-key stacks means one of them never sees
    // keyup and the "exactly once" count reds.
    const src = readMainTs();
    const live = squashWhitespace(stripLineComments(src));
    expect(
      countOccurrences(live, 'const held = new HeldDirections();'),
      'main.ts must construct the held-key tracker ARGLESS, exactly once: ' +
        '`const held = new HeldDirections();`. The threshold SSOT is heldKeys.ts ' +
        'HOLD_COMMIT_MS; passing a literal here forks it invisibly (`new HeldDirections(0)` ' +
        'disables the whole fix while every other gate in this slice stays green)',
    ).toBe(1);
    expect(
      countOccurrences(live, 'new HeldDirections('),
      'main.ts must construct EXACTLY ONE HeldDirections — a second instance means keydown ' +
        'and keyup (or the two continuation emitters) would read different held-key state',
    ).toBe(1);
  });

  it('★ W-MVI-HELDKEYS-IMPORT-SEALED BITES: main.ts imports ONLY { HeldDirections, reissueDir } from heldKeys.ts, via exactly one static import', () => {
    // RED-TEAM FINDING: a module-mutable "internal default" back door in heldKeys.ts — e.g. a
    // `let`-based constructor default the class reads instead of `HOLD_COMMIT_MS` directly,
    // plus an exported setter — is invisible to every OTHER tooth in this file and to
    // heldKeys.test.ts / movementSim.test.ts, because neither test file ever imports or
    // executes main.ts. A one-line addition to main.ts's import + one module-scope call
    // (`__setSomeInternalDefault(0)`) would silently disable the entire hold-commit fix at
    // runtime while every other assertion in this 135-test gating suite stays green.
    // PoC verified in a scratch copy (not committed): heldKeys.ts exported
    // `_internalDefaultHoldCommitMs` (a `let`, initialized from `HOLD_COMMIT_MS`) and
    // `__setInternalDefaultHoldCommitMs`, the constructor default read the mutable `let`, and
    // main.ts added `__setInternalDefaultHoldCommitMs(0)` at module scope — the full gating
    // suite (heldKeys.test.ts + movementSim.test.ts + this file) passed 135/135.
    // This tooth closes the main.ts-side half of that mutant by sealing the import surface:
    // only `HeldDirections` and `reissueDir` may ever be pulled from heldKeys.ts, and only via
    // one static import statement (no second import, no dynamic `import(...)`).
    const src = readMainTs();
    const exactImport = "import { HeldDirections, reissueDir } from './prediction/heldKeys';";
    expect(
      src.includes(exactImport),
      `main.ts must import EXACTLY \`${exactImport}\` — no additional named imports (e.g. a ` +
        'mutable internal-default setter) may be pulled in from heldKeys.ts',
    ).toBe(true);
    expect(
      countOccurrences(src, "from './prediction/heldKeys'"),
      'main.ts must import from ./prediction/heldKeys via exactly ONE static import statement ' +
        '— a second import (or a dynamic import(...)) could pull in additional exports unseen ' +
        'by the exact-match check above',
    ).toBe(1);
  });
});

// ===========================================================================
// feel-polish D1: care feedback wiring (ADR-0159, ledger item 087).
//
// SOURCE OF TRUTH: EARS criterion "WHEN the player presses the care-button/action,
// THE UI SHALL show a visible confirmation (toast, animation, or stat-delta
// feedback)." + docs/adr/0159-feel-polish-care-feedback-npc-wander.md D1.
//
// RED-TEAM CORRECTION (post-authoring): the original 4-test version of this block
// was pure `.includes()` string-presence scanning and did NOT test the ADR's central
// claim — "the await genuinely reflects the server outcome, so the confirmation can
// never lie." Red-team demonstrated two working cheats that passed all 4 original
// scans: (A) an OPTIMISTIC impl that calls showFeedback('Cared!') BEFORE awaiting the
// reducer call (lies on every rejected click — and CARE_COOLDOWN_MS is 6h, so MOST
// real clicks are rejections); (B) a QUOTE-SWAP + dead-decoy impl
// (`sendGuarded("care", ...)` with double quotes dodging the single-quoted literal,
// plus `if (false) { ... }` decoy blocks) that changed NOTHING behaviourally.
//
// FIX: the ordering/no-lie property is untestable against main.ts directly (it is
// coverage-excluded and onCare is a non-exported closure), so main.ts's onCare is
// now wired to route through `performCare` — an exported, directly-testable function
// in `client/src/ui/careAction.ts` (see careAction.test.ts for the REAL behavioural
// gate: order-of-operations, resolve/reject/frozen arms, exactly-once). This block
// stays as a cheap STRUCTURAL frame over the wiring only — it can no longer be the
// only line of defense, per the two PoCs above.
//
// STATUS UPDATE (post-implementation code review): the implementer has since shipped
// careAction.ts and rewired main.ts's onCare through `performCare`. Re-verified against
// the current source: W-CARE-NO-SENDGUARDED-CARE / W-CARE-PERFORMCARE / W-CARE-IMPORT /
// W-CARE-REDUCER-CALL / W-CARE-SHOWFEEDBACK-WIRING / W-CARE-ERRMSG-CAREACTION are all
// GREEN today — they now function as regression guards (same role as this file's
// pre-existing F-5 GREEN guards), not red gates. Only ONE test in this block is
// genuinely RED against the current implementation:
//   W-CARE-SHOWFEEDBACK-VISIBLE-GUARD — code review's MAJOR finding. main.ts's
//   `showFeedback` dependency is currently `(message) =>
//   raisingView?.showFeedback(message)` with NO `.visible` guard (every sibling —
//   onBuy/onSell — guards it). This is the new, load-bearing tooth in this block.
//
// WRONG IMPL KILLED (per test):
//   W-CARE-NO-SENDGUARDED-CARE: a revert to sendGuarded(...'care'...) in EITHER quote
//     style (kills PoC B's quote-swap dodge, not just the single-quoted literal).
//   W-CARE-PERFORMCARE: an onCare wiring site that keeps the old inline logic (or a
//     PoC-B-style dead-decoy shim) instead of routing through performCare.
//   W-CARE-IMPORT: a locally-redefined decoy `function performCare() {}` inside
//     main.ts that satisfies W-CARE-PERFORMCARE's string scan without ever importing
//     the real, tested module.
//   W-CARE-REDUCER-CALL: an onCare wiring site that never calls the care reducer.
//   W-CARE-SHOWFEEDBACK-WIRING: an onCare wiring site whose performCare deps never
//     actually connect to raisingView.showFeedback (e.g. a stub `showFeedback: () =>
//     {}`) — the EARS criterion is unmet even if performCare itself is correct.
//   W-CARE-SHOWFEEDBACK-VISIBLE-GUARD: an unguarded `raisingView?.showFeedback(...)`
//     forward (the PRE-FIX shape this test now guards against, code-review MAJOR finding) — a care call
//     that settles after the overlay is force-hidden (KeyB/KeyE) writes a stale
//     message the player sees with no click behind it on the NEXT open.
//   W-CARE-ERRMSG-CAREACTION: careAction.ts's catch arm shows a raw err.message
//     (InternalError leak) instead of routing through reduceErrorMessage(err, 'care').
//     NOTE: this is a cheap structural pin only — the load-bearing behavioural gate
//     (showFeedback called with exactly this text, exactly once, never 'Cared!') is
//     careAction.test.ts's reject-arm test.
//
// Do NOT edit these tests to match a buggy implementation — corrections must trace
// to ADR-0159 D1 (as amended by the red-team finding above) only.
// ===========================================================================

/**
 * Quote-insensitive scan for a `sendGuarded(` call site whose first argument names
 * "care" (kills PoC B's dodge: `sendGuarded("care", ...)` uses double quotes to slip
 * past a single-quoted `sendGuarded('care'` literal check). Scans every
 * `sendGuarded(` call site in the source and checks the following ~24 chars for the
 * bare substring `care`, regardless of quote character. Returns the index of the
 * first offending call site, or -1 if none exists. No `new RegExp` — plain
 * indexOf/slice/includes only.
 */
function findSendGuardedCareCallSite(src: string): number {
  const needle = 'sendGuarded(';
  let searchFrom = 0;
  for (;;) {
    const idx = src.indexOf(needle, searchFrom);
    if (idx === -1) return -1;
    const argWindow = src.slice(idx + needle.length, idx + needle.length + 24);
    if (argWindow.includes('care')) return idx;
    searchFrom = idx + needle.length;
  }
}

describe('main.ts wiring (feel-polish D1): care feedback (ADR-0159, hardened against PoC A/B)', () => {
  it("W-CARE-NO-SENDGUARDED-CARE BITES (quote-insensitive): no sendGuarded( call site names 'care' in its first arg, in EITHER quote style — kills the PoC B quote-swap dodge", () => {
    // ADR-0159 D1: onCare must be rewritten to the onBuy/onSell await+showFeedback shape.
    // sendGuarded attaches ONLY a .catch (no success branch at all) — a revert back to it,
    // in ANY quote style, would silently drop the success confirmation.
    const src = readMainTs();
    const idx = findSendGuardedCareCallSite(src);
    expect(
      idx,
      "main.ts must NOT contain any sendGuarded(...) call site whose first argument is 'care' " +
        '(single OR double quoted) — sendGuarded has no success branch, so routing care through ' +
        'it in ANY quote style silently drops the success confirmation (ADR-0159 D1)',
    ).toBe(-1);
  });

  it('W-CARE-PERFORMCARE BITES: the onCare wiring region calls performCare( — kills a wiring that silently keeps the old inline path (or a PoC-B-style dead-decoy shim)', () => {
    // WRONG IMPL KILLED: an impl that keeps the pre-fix inline sendGuarded/catch-only
    // shape (or PoC B's quote-swapped/dead-decoy variant) instead of routing through the
    // tested performCare module — the ordering/no-lie property is unenforceable otherwise.
    const src = readMainTs();
    const onCareIdx = src.indexOf('onCare:');
    expect(onCareIdx, 'main.ts must contain an onCare: wiring site').toBeGreaterThanOrEqual(0);
    const region = src.slice(onCareIdx, onCareIdx + 1200);
    expect(
      region.includes('performCare('),
      'main.ts onCare wiring region must call performCare( — the ordering/no-lie property ' +
        '(ADR-0159 D1) is only guaranteed by routing through the tested performCare module ' +
        '(see careAction.test.ts), not a hand-rolled inline path',
    ).toBe(true);
  });

  it("W-CARE-IMPORT BITES: main.ts references './ui/careAction' naming performCare — kills a locally-redefined decoy performCare() that dodges the tested module", () => {
    // WRONG IMPL KILLED: a decoy `function performCare(...) { ... }` defined LOCALLY inside
    // main.ts (never imported from careAction.ts) would satisfy W-CARE-PERFORMCARE's bare
    // string scan alone. This test additionally requires main.ts to actually reference the
    // './ui/careAction' module path, with 'performCare' named near that reference.
    const src = readMainTs();
    const pathIdx = src.indexOf("'./ui/careAction'");
    expect(
      pathIdx,
      "main.ts must reference './ui/careAction' (static or dynamic import)",
    ).toBeGreaterThanOrEqual(0);
    const region = src.slice(Math.max(0, pathIdx - 150), pathIdx + 40);
    expect(
      region.includes('performCare'),
      "the './ui/careAction' reference in main.ts must name performCare",
    ).toBe(true);
  });

  it('W-CARE-REDUCER-CALL BITES: the onCare wiring region calls reducers.care( — kills missing-reducer-call impl', () => {
    // WRONG IMPL KILLED: an impl that guts the reducer call entirely while adding UI text —
    // care would stop functioning even though the overlay claims success. main.ts is the
    // only place with access to `conn`, so this call site necessarily still lives here
    // (inside the `callCare` closure handed to performCare).
    const src = readMainTs();
    const onCareIdx = src.indexOf('onCare:');
    expect(onCareIdx, 'main.ts must contain an onCare: wiring site').toBeGreaterThanOrEqual(0);
    const region = src.slice(onCareIdx, onCareIdx + 1200);
    expect(
      region.includes('reducers.care('),
      'main.ts onCare wiring region must call reducers.care( (ADR-0159 D1)',
    ).toBe(true);
  });

  it('W-CARE-SHOWFEEDBACK-WIRING BITES: the onCare wiring region connects the performCare deps to raisingView.showFeedback( — kills a stub/no-op showFeedback dependency', () => {
    // EARS criterion: "THE UI SHALL show a visible confirmation". WRONG IMPL KILLED: an impl
    // that correctly calls performCare( with a `showFeedback` dependency that is a no-op
    // stub (e.g. `showFeedback: () => {}`) — performCare's own tests would still pass (they
    // only see the mock), but the player would see nothing. main.ts is the only place with
    // access to `raisingView`, so the real forwarding call necessarily lives here.
    const src = readMainTs();
    const onCareIdx = src.indexOf('onCare:');
    expect(onCareIdx, 'main.ts must contain an onCare: wiring site').toBeGreaterThanOrEqual(0);
    const region = src.slice(onCareIdx, onCareIdx + 1200);
    expect(
      region.includes('raisingView'),
      'main.ts onCare wiring region must reference raisingView (the showFeedback dependency ' +
        'must actually forward to the view, ADR-0159 D1)',
    ).toBe(true);
    expect(
      region.includes('showFeedback('),
      'main.ts onCare wiring region must call showFeedback( — the performCare `showFeedback` ' +
        'dependency must forward to raisingView.showFeedback(...), not a no-op stub',
    ).toBe(true);
  });

  it('★ W-CARE-SHOWFEEDBACK-VISIBLE-GUARD BITES: the onCare wiring region gates the showFeedback dependency on raisingView?.visible — kills the stale-feedback-into-hidden-overlay regression (code-review MAJOR finding)', () => {
    // MAJOR finding (code review): main.ts wires `showFeedback: (message) =>
    // raisingView?.showFeedback(message)` with NO visibility guard, unlike every
    // sibling (onBuy/onSell do `if (shopView?.visible) shopView.showFeedback(...)`).
    // REACHABLE FAILURE: raisingView.hide() clears the feedback line and releases
    // #pending immediately; main.ts calls `raisingView?.hide()` unconditionally on
    // KeyB (Box) and KeyE (Evolution). So: click Care -> reducer in flight -> press
    // B -> hide() clears feedback + releases the lock -> the promise later settles
    // -> showFeedback fires anyway into the now-hidden node -> the player reopens
    // Raising later and sees a stale "Cared!" (or a stale error) with no click
    // behind it — exactly the "click #2 looks identical to click #1" confusion
    // ADR-0159 exists to remove.
    // WRONG IMPL KILLED: the PRE-FIX shape (now fixed; this test keeps it fixed) — an unguarded
    // `raisingView?.showFeedback(message)` forward with no `.visible` check.
    const src = readMainTs();
    const onCareIdx = src.indexOf('onCare:');
    expect(onCareIdx, 'main.ts must contain an onCare: wiring site').toBeGreaterThanOrEqual(0);
    const region = src.slice(onCareIdx, onCareIdx + 1200);
    expect(
      region.includes('raisingView?.visible'),
      'main.ts onCare wiring region must gate the showFeedback dependency on ' +
        'raisingView?.visible (mirroring the onBuy/onSell `if (shopView?.visible) ' +
        'shopView.showFeedback(...)` idiom) — otherwise a care call that settles after ' +
        'the overlay is force-hidden (KeyB/KeyE) writes a stale message the player sees ' +
        'on the NEXT open, with no click behind it',
    ).toBe(true);
  });

  it("W-CARE-ERRMSG-CAREACTION BITES: careAction.ts routes rejection through reduceErrorMessage(err, 'care') — kills InternalError-leak/silent-catch impl (cheap structural pin; the REAL behavioural gate is careAction.test.ts's reject-arm test)", () => {
    // This assertion moved from main.ts to careAction.ts (red-team fix): once onCare routes
    // through performCare, the reject-arm error-message logic lives in careAction.ts, not
    // inline in main.ts. This is a CHEAP structural pin only — the load-bearing behavioural
    // gate (that showFeedback is called with exactly this text, exactly once, and NEVER with
    // 'Cared!') lives in careAction.test.ts.
    const careActionPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'ui/careAction.ts',
    );
    let src: string;
    try {
      src = readFileSync(careActionPath, 'utf8');
    } catch (err) {
      // Fail loud — post-impl the file must exist (vacuous-revival-gate precedent).
      throw new Error(
        'careAction.ts could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    expect(
      src.includes("reduceErrorMessage(err, 'care')"),
      "careAction.ts must call reduceErrorMessage(err, 'care') on rejection (ADR-0159 D1)",
    ).toBe(true);
  });
});

// ===========================================================================
// uxd2 — context-sensitive interact wiring (W-INTERACT). NEW describe block; the
// only edits to the blocks ABOVE are the two list shrinks (SIBLING_KEYS,
// OPEN_HANDLERS), each annotated in place.
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md I6/I6b/I7 (ACs 1,2,3,5,6,10′,12) +
//                  docs/adr/0161-npc-interaction-context-interact.md D3/D4/D5/D6.
//
// RED REASON (every case below): master's main.ts still has the global KeyG/KeyH
// handlers, still calls nearestTalkableNpcId, has no [data-shop-id] branch, no
// pendingShopId, no interactPrompt/screenFor in the frame loop, and no
// #interact-prompt element. Each case fails with either a thrown missing-anchor
// error (regionOrThrow / expectUniqueAnchor) or a false/-1 assertion.
//
// TWO SENTINEL PAIRS ARE REQUIRED OF THE IMPLEMENTER (`// F9-BUNDLE-BEGIN/END`
// precedent, main.wiring.test.ts:283):
//     // UXD2-SHOPBTN-BEGIN  … the [data-shop-id] click branch …  // UXD2-SHOPBTN-END
//     // UXD2-SHOPOPEN-BEGIN … the deferred shop-open arm …       // UXD2-SHOPOPEN-END
// WHY: both are NEW code with no pre-existing stable neighbour to bound a region
// against. A fixed-width `src.slice(i, i + N)` window is the nh1-post-mortem
// anti-pattern (it silently widens/narrows with every legitimate edit and goes
// vacuously green), and an unbounded forward slice would let a needle anywhere later
// in the file satisfy the tooth. The sentinels make the region exact and un-widenable;
// a missing sentinel is a HARD RED (thrown), never a vacuous pass.
//
// NO `new RegExp` anywhere (Semgrep ban, this file's rule): indexOf/includes/split only.
// ===========================================================================

const UXD2_SHOPBTN_BEGIN = '// UXD2-SHOPBTN-BEGIN';
const UXD2_SHOPBTN_END = '// UXD2-SHOPBTN-END';
const UXD2_SHOPOPEN_BEGIN = '// UXD2-SHOPOPEN-BEGIN';
const UXD2_SHOPOPEN_END = '// UXD2-SHOPOPEN-END';

/** KeyT handler block: from its own anchor to the NEXT open-handler (`e.key === '?'`).
 *  Both anchors are asserted UNIQUE at runtime, so the block cannot silently widen. */
const UXD2_KEYT_START = "e.code === 'KeyT'";
// uxd3 (ADR-0162) RE-ANCHOR — NOT a weakening. uxd2's dispatch body moved out of the KeyT
// block into `interactAtNearest()` so the interact HOTKEY and the menu's Interact leaf share
// ONE exhaustive `switch (target.kind)`; duplicating it into the menu route would have
// destroyed exactly the single-site compiler flag ADR-0161 built these teeth to protect.
// The assertions below are unchanged in content — they now slice the function that holds the
// dispatch, and W-INTERACT-KEYT-DISPATCH additionally pins that the KeyT block still ROUTES
// through it, which the pre-uxd3 form could not check.
const UXD2_INTERACT_FN_START = 'function interactAtNearest';
const UXD2_INTERACT_FN_END = 'function menuAvailability';
const UXD2_KEYT_END = "e.key === '?'";

/** Escape-dialogue branch: bounded by the two adjacent Escape branches (both unique). */
const UXD2_ESC_DLG_START = "e.code === 'Escape' && dialogueView?.visible";
const UXD2_ESC_DLG_END = "e.code === 'Escape' && questLogView?.visible";

/** rAF frame body: the frame closure declaration to its OWN error log.
 *  END is the frame handler's unique log line — NOT `} catch (err) {`, which occurs ~26× in
 *  main.ts and therefore cannot be uniqueness-checked (an inner try/catch added inside the
 *  frame body would silently truncate the region, which is exactly how a needle-bounded scan
 *  goes vacuously green — nh1 post-mortem). Both anchors are asserted unique at runtime. */
const UXD2_FRAME_START = 'const frame = ';
const UXD2_FRAME_END = "console.error('[frame] uncaught error'";

/** The LIVE document click listener the Shop branch must live inside, and the existing
 *  data-choice-idx branch it must sit ABOVE. Both anchors are CODE-SHAPED on purpose
 *  (`closest('[data-choice-idx]')`, not the bare attribute name): uniqueness is checked
 *  against RAW source — which the `//` sentinels require — so a prose mention of
 *  "data-choice-idx" in a new comment must not be able to red these teeth spuriously. */
const UXD2_CLICK_LISTENER = "document.addEventListener('click'";
const UXD2_CHOICE_BRANCH = "closest('[data-choice-idx]')";

/** Read a sibling module under client/src by relative path; fail LOUD if absent so a
 *  deleted file can never make a direct-file scan vacuously green (RL-15 precedent). */
function readClientSrc(relPath: string): string {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), relPath);
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`${relPath} could not be read at ${p} — ` + String(err));
  }
}

describe('★ main.ts wiring (uxd2): the global KeyG/KeyH hotkeys are GONE (AC-10′)', () => {
  it("★ W-INTERACT-NO-GH BITES: no `e.code === 'KeyG'` and no `e.code === 'KeyH'` anywhere in main.ts", () => {
    // AC-10′ / ADR-0161 D5. RED TODAY: main.ts:671 (`KeyH`) and :697 (`KeyG`) both exist.
    //
    // WRONG IMPL KILLED (1): an impl that adds the interact system but LEAVES the global
    //   hotkeys "for convenience" — the world-unconnected shop open is the exact defect
    //   Drew's 2026-07-25 playtest raised, and a surviving KeyG re-opens it.
    // WRONG IMPL KILLED (2): an impl that empties the handler body but keeps the branch
    //   (`if (e.code === 'KeyG') { e.preventDefault(); return; }`) — G would still swallow
    //   the keypress, so the key remains reserved and undocumented-but-live.
    // Comment-stripped first: main.ts:2089 carries a stale "Escape/KeyG already recover it"
    // COMMENT which the plan requires fixing; a comment must never fail this tooth (and,
    // symmetrically, must never satisfy one).
    const src = stripLineComments(readMainTs());
    expect(
      src.includes("e.code === 'KeyG'"),
      "main.ts must NOT contain an `e.code === 'KeyG'` branch — the global shop hotkey is " +
        'deleted in uxd2; the shop opens only from a shopkeeper interaction (ADR-0161 D5)',
    ).toBe(false);
    expect(
      src.includes("e.code === 'KeyH'"),
      "main.ts must NOT contain an `e.code === 'KeyH'` branch — the global heal hotkey is " +
        'deleted in uxd2; heal opens only from a heal tile interaction (ADR-0161 D5)',
    ).toBe(false);
  });

  it('★ W-INTERACT-NO-GH-HELP BITES: helpModel.ts documents no G / H row', () => {
    // Direct-file scan (RL-15 precedent). RED TODAY: helpModel.ts:32-33.
    // WRONG IMPL KILLED: an impl that deletes the handlers but leaves the help rows — the
    // onboarding overlay would teach a playtester two keys that do nothing.
    // The needle is the SSOT row form `{ key: 'G'`, not a bare 'G', so the letter appearing
    // inside another row's action text cannot false-fire this.
    const src = readClientSrc('ui/helpModel.ts');
    expect(
      src.includes("{ key: 'G'"),
      "helpModel.ts must NOT contain a `{ key: 'G'` controls row (AC-10′)",
    ).toBe(false);
    expect(
      src.includes("{ key: 'H'"),
      "helpModel.ts must NOT contain a `{ key: 'H'` controls row (AC-10′)",
    ).toBe(false);
    expect(
      src.includes("{ key: 'T'"),
      "helpModel.ts must STILL contain the `{ key: 'T'` interact row (the one key uxd2 is about)",
    ).toBe(true);
  });

  it('★ W-INTERACT-NO-OLD-RESOLVER BITES: main.ts no longer imports/calls nearestTalkableNpcId', () => {
    // Plan I6: nearestInteractable REPLACES nearestTalkableNpcId; the old symbol is deleted
    // from dialogueModel.ts (pinned by interactModel.test.ts G1).
    // WRONG IMPL KILLED: an impl that adds the new resolver for the PROMPT but leaves the
    // KeyT dispatch on the old one — the prompt would advertise "Shop"/"Heal" on targets
    // KeyT then refuses to act on (the two would disagree on every non-dialogue target).
    const src = stripLineComments(readMainTs());
    expect(
      src.includes('nearestTalkableNpcId'),
      'main.ts must NOT reference nearestTalkableNpcId — nearestInteractable replaces it (plan I6)',
    ).toBe(false);
  });
});

describe('★ main.ts wiring (uxd2): the KeyT handler dispatches through nearestInteractable (AC-1/3/6)', () => {
  it('★ W-INTERACT-KEYT-DISPATCH BITES: the KeyT block calls nearestInteractable( and reducers.talk(', () => {
    // AC-1: dialogue AND shop NPCs share one dispatch arm — the existing `talk` reducer
    // (greet-then-shop, ADR-0161 D4).
    // WRONG IMPL KILLED (1): a KeyT that keeps calling the old resolver (see the sibling
    //   tooth) or that resolves inline with a hand-rolled loop — the ordering rules proven
    //   in interactModel.test.ts would then not govern the actual dispatch.
    // WRONG IMPL KILLED (2): a KeyT that opens the shop overlay directly for a Shop NPC
    //   (the spec's pre-adjudication default) — Drew's answer is GREET-THEN-SHOP, so the
    //   shop arm MUST send `talk`; `reducers.talk(` must be present in the block.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD2_KEYT_START);
    expectUniqueAnchor(src, UXD2_KEYT_END);
    const block = stripLineComments(regionOrThrow(src, UXD2_KEYT_START, UXD2_KEYT_END));
    // uxd3: the hotkey must ROUTE through the shared dispatch — an inlined second copy of
    // the switch would satisfy the old body-scan while breaking the one-site guarantee.
    expect(
      block.includes('interactAtNearest()'),
      'the KeyT block must dispatch via interactAtNearest() (uxd3/ADR-0162 re-anchor)',
    ).toBe(true);
    const fn = stripLineComments(regionOrThrow(src, UXD2_INTERACT_FN_START, UXD2_INTERACT_FN_END));
    expect(
      fn.includes('nearestInteractable('),
      'the KeyT block must resolve its target via nearestInteractable( (plan I7.2)',
    ).toBe(true);
    expect(
      fn.includes('reducers.talk('),
      'the KeyT block must send the talk reducer for the dialogue/shop arms (AC-1/AC-2 greet-then-shop)',
    ).toBe(true);
  });

  it('★ W-INTERACT-KEYT-SWITCH BITES: the KeyT block has an exhaustive dialogue/shop/heal switch with a BOUND heal render', () => {
    // AC-3: the heal arm binds the OVERLAY to the resolved locationId and calls NO reducer.
    // WRONG IMPL KILLED (1): a KeyT that handles only NPCs and ignores heal targets — the
    //   heal overlay becomes unreachable once KeyH is deleted (the whole heal affordance).
    // WRONG IMPL KILLED (2): a heal arm that renders the DEFAULT (all-locations)
    //   buildHealViewModel instead of the bound one — the overlay would list every pad in
    //   the world and the ADR-0161 D5 "never silently swap a bound view" rule is broken.
    const src = readMainTs();
    const block = stripLineComments(
      regionOrThrow(src, UXD2_INTERACT_FN_START, UXD2_INTERACT_FN_END),
    );
    for (const needle of ["case 'dialogue'", "case 'shop'", "case 'heal'"]) {
      expect(
        block.includes(needle),
        `the KeyT block must contain \`${needle}:\` — the dispatch is an EXHAUSTIVE switch on ` +
          'the descriptor kind (no `default:`/`_ =>`, so a 4th variant compiler-flags this site)',
      ).toBe(true);
    }
    expect(
      block.includes('buildHealViewModelForLocation('),
      'the KeyT heal arm must render buildHealViewModelForLocation( — the BOUND location, not ' +
        'the first-location default (AC-3, ADR-0161 D5)',
    ).toBe(true);
  });

  it('★ W-INTERACT-KEYT-NO-REDUCER BITES: the KeyT block calls NEITHER reducers.buy( NOR reducers.healParty(', () => {
    // AC-3 / AC-11: KeyT never spends and never heals. The heal arm is a VIEW bind only
    // (adjudication 2: binding the SEND waits for a second heal location), and the shop arm
    // opens a greeting, not a purchase.
    // WRONG IMPL KILLED: a "helpful" KeyT that fires heal_party on a heal tile — the player
    //   would consume a cooldown (and, once heal locations cost items, an item) by walking
    //   past a pad and pressing the interact key, with no confirmation step. Also kills a
    //   KeyT that shortcuts a purchase for a shop NPC.
    const src = readMainTs();
    const block = stripLineComments(regionOrThrow(src, UXD2_KEYT_START, UXD2_KEYT_END));
    for (const needle of ['reducers.buy(', 'reducers.healParty(', 'reducers.sellItem(']) {
      expect(
        block.includes(needle),
        `the KeyT block must NOT contain ${needle} — interact opens UI, it never transacts ` +
          '(AC-3; the buy/heal_party reducers are byte-identical to master in this slice)',
      ).toBe(false);
    }
  });

  it('★ W-INTERACT-KEYT-GUARD BITES: the KeyT block still guards on !anyOverlayVisible() && identity !== "" (AC-6)', () => {
    // AC-6: the interact key must never fire into an open UI. This duplicates the coverage of
    // the retired W-OVERLAY-FANOUT-MUTEX / the new W-UXD3C-OPENGUARDS-ROUTE-THROUGH-CANOPEN
    // DELIBERATELY — that shared block-slicer's OPEN_HANDLERS-equivalent list is edited by every
    // uxd3-c slice, so a second, list-independent statement of the KeyT guard keeps the
    // invariant pinned even if the shared list is ever mis-edited again (this tooth STAYS —
    // plan §C3 / adjudication §C).
    //
    // uxd3-c re-anchor (ADR-0164, plan §C3): KeyT is NOT a canOpen() site (it opens no overlay
    // of its own — plan §0), so its 15-term inline guard collapses to
    // `!anyOverlayVisible() && identity !== ''`, byte-identical to the AC-12 click branch (E15).
    // WRONG IMPL KILLED: a rewritten KeyT that drops the guard while restructuring the body into
    // a switch (the easiest thing to lose in this refactor) — pressing T with the shop open
    // would send `talk` behind the overlay. ALSO KILLED: a residual hand-rolled per-id guard
    // term surviving ALONGSIDE the collapsed call (a copy-paste leftover from the pre-migration
    // 14-term list).
    const src = readMainTs();
    const block = stripLineComments(regionOrThrow(src, UXD2_KEYT_START, UXD2_KEYT_END));
    const squashed = squashWhitespace(block);
    expect(
      squashed.includes("!anyOverlayVisible() && identity !== ''"),
      "the KeyT block must guard on the CONTIGUOUS `!anyOverlayVisible() && identity !== ''` — " +
        "the SAME shape the AC-12 click branch uses (E15); a `.kind === 'deny'`-style inversion " +
        'or a dropped `!` would fall through this exact-substring check',
    ).toBe(true);
    for (const overlay of [
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
      'menuView',
    ]) {
      expect(
        block.includes(`!${overlay}?.visible`),
        `the KeyT block must NOT contain a residual hand-rolled guard !${overlay}?.visible — ` +
          'the 15-way exclusion now routes exclusively through !anyOverlayVisible()',
      ).toBe(false);
    }
  });
});

describe('★ main.ts wiring (uxd2): the Shop button defers the open through dismissDialogue (AC-2)', () => {
  it('★ W-INTERACT-SHOPBTN BITES: a sentinel-bounded [data-shop-id] click branch exists, sends dismissDialogue under the dismissPending guard, and sets pendingShopId', () => {
    // ADR-0161 D4. RED TODAY: no `data-shop-id` in main.ts at all → regionOrThrow throws.
    //
    // WRONG IMPL KILLED (1): a Shop button wired onto `data-choice-idx` — the existing
    //   dialogue click handler would send advance_dialogue with a bogus choice index.
    // WRONG IMPL KILLED (2): a click branch that opens the shop IMMEDIATELY — that stacks two
    //   overlays for a server round-trip, during which Escape hits the DIALOGUE branch instead
    //   of the shop branch, and a frozen link pins the overlap permanently (ADR-0161 D4,
    //   adjudication 1). The deferred open is the whole design; `pendingShopId` is its proof.
    // WRONG IMPL KILLED (3): a branch that sends dismissDialogue WITHOUT the dismissPending
    //   guard — a double-click would double-send while the first dismiss is in flight (C6).
    const region = stripLineComments(
      regionOrThrow(readMainTs(), UXD2_SHOPBTN_BEGIN, UXD2_SHOPBTN_END),
    );
    expect(
      region.includes('data-shop-id'),
      'the UXD2-SHOPBTN region must select on [data-shop-id] (the Shop button carries no ' +
        'data-choice-idx, so it must have its own click branch)',
    ).toBe(true);
    expect(
      region.includes('dismissDialogue'),
      'the Shop-button branch must end the conversation via dismissDialogue (ADR-0161 D4)',
    ).toBe(true);
    expect(
      region.includes('dismissPending'),
      'the Shop-button branch must respect the dismissPending in-flight guard (ADR-0085 C6)',
    ).toBe(true);
    expect(
      region.includes('pendingShopId'),
      'the Shop-button branch must record pendingShopId — the open is DEFERRED to the ' +
        'dialogue batch listener, never performed inline (adjudication 1)',
    ).toBe(true);
    expect(
      region.includes('closest('),
      'the UXD2-SHOPBTN region must contain the actual click-delegation code — a `closest(...)` ' +
        'target test (anti-vacuity: an empty sentinel pair would satisfy every needle below)',
    ).toBe(true);
  });

  it('★ W-INTERACT-SHOPBTN-LIVE BITES: the branch sits INSIDE the live document click listener, ABOVE the data-choice-idx branch — kills a never-invoked dead-code wrapper', () => {
    // RED-TEAM (HIGH): every needle in the sibling test is satisfied by a function that is
    // DECLARED and never CALLED — e.g. `function wireShopButton() { /* sentinels + needles */ }`
    // parked at module scope. The suite would go green while clicking the Shop button did
    // nothing at all. Structural position is the cheapest proof of liveness available to a
    // source scan: pin the region between two anchors that are ALREADY PROVEN LIVE by an
    // existing shipped behaviour (the dialogue-choice click path, gated by dialogue.spec.ts).
    //
    // WRONG IMPL KILLED (1): a dead wrapper function anywhere in the file — its sentinels
    //   cannot be both after `document.addEventListener('click'` and before the
    //   `[data-choice-idx]` closest() call unless they are literally inside that listener.
    // WRONG IMPL KILLED (2): a SECOND `document.addEventListener('click', …)` registered for
    //   the shop button — the uniqueness assertion on the listener anchor reds, and a second
    //   listener is a real hazard (ordering with the dismiss round-trip becomes undefined).
    // WRONG IMPL KILLED (3): the shop branch placed BELOW the choice branch — the choice
    //   branch would `return` on a non-matching target before the shop branch is reached only
    //   if written carelessly, and the ordering pin removes the whole class.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD2_CLICK_LISTENER);
    expectUniqueAnchor(src, UXD2_CHOICE_BRANCH);
    expectUniqueAnchor(src, UXD2_SHOPBTN_BEGIN);
    expectUniqueAnchor(src, UXD2_SHOPBTN_END);

    const listenerIdx = src.indexOf(UXD2_CLICK_LISTENER);
    const choiceIdx = src.indexOf(UXD2_CHOICE_BRANCH);
    const beginIdx = src.indexOf(UXD2_SHOPBTN_BEGIN);
    const endIdx = src.indexOf(UXD2_SHOPBTN_END);

    expect(
      beginIdx,
      `${UXD2_SHOPBTN_BEGIN} must appear AFTER \`${UXD2_CLICK_LISTENER}\` — the Shop branch must ` +
        'live INSIDE the one live document click listener, not in a dead module-scope wrapper',
    ).toBeGreaterThan(listenerIdx);
    expect(
      endIdx,
      `${UXD2_SHOPBTN_END} must appear BEFORE the \`${UXD2_CHOICE_BRANCH}\` branch — the Shop ` +
        'branch belongs in the same listener, above the (already e2e-proven-live) choice branch',
    ).toBeLessThan(choiceIdx);
  });

  it('★ W-INTERACT-SHOPBTN-NO-WRAPPER BITES: the sentinel region declares no function and registers no listener of its own', () => {
    // The second half of the dead-code defence (red-team HIGH). Even correctly positioned,
    // an implementer could nest `document.addEventListener('click', () => { …sentinels… })`
    // or a helper `function` declaration inside the region, re-opening the dead/deferred-code
    // hole. The region must be STRAIGHT-LINE branch code in the enclosing live listener.
    // WRONG IMPL KILLED: a nested listener registration (double-handling every click, and
    //   undefined ordering against the choice branch) or a declared-but-uncalled helper.
    // NOTE: an ARROW callback passed to an existing call is unaffected — only the `function `
    //   keyword and a fresh `addEventListener(` registration are rejected.
    const region = stripLineComments(
      regionOrThrow(readMainTs(), UXD2_SHOPBTN_BEGIN, UXD2_SHOPBTN_END),
    );
    expect(
      region.includes('addEventListener('),
      'the UXD2-SHOPBTN region must NOT register its own listener — it is a BRANCH inside the ' +
        'existing document click listener (a nested registration double-handles every click)',
    ).toBe(false);
    expect(
      region.includes('function '),
      'the UXD2-SHOPBTN region must NOT declare a function — a declared-but-never-called ' +
        'wrapper satisfies every needle while the Shop button does nothing (red-team HIGH)',
    ).toBe(false);
  });

  it('★ W-INTERACT-SHOPBTN-NO-REDUCER BITES: the [data-shop-id] branch calls no shop/buy reducer', () => {
    // AC-2 / AC-11: "no shop reducer is called anywhere". The Shop button is pure UI routing.
    // WRONG IMPL KILLED: a branch that fires `reducers.buy(...)` or a new server-side
    //   open_shop reducer — the shop overlay is a pure subscription projection and adding a
    //   write here would break the byte-identical economy.rs guarantee.
    const region = stripLineComments(
      regionOrThrow(readMainTs(), UXD2_SHOPBTN_BEGIN, UXD2_SHOPBTN_END),
    );
    for (const needle of ['reducers.buy(', 'reducers.sellItem(', 'reducers.healParty(']) {
      expect(
        region.includes(needle),
        `the Shop-button branch must NOT contain ${needle} (AC-2/AC-11)`,
      ).toBe(false);
    }
    // Positive control: the region is the REAL branch, not an empty sentinel pair.
    expect(
      region.includes('closest('),
      'the UXD2-SHOPBTN region must contain the actual click-delegation code (anti-vacuity: ' +
        'an empty sentinel pair would satisfy every negative assertion above)',
    ).toBe(true);
  });

  it('★ W-INTERACT-DEFERRED-OPEN BITES: the deferred-open arm consumes pendingShopId gated on anyOverlayVisible and binds the shop by id', () => {
    // ADR-0161 D4: the open is consumed-and-cleared atomically in the dialogue batch
    // listener's `if (!conv)` arm, and ONLY when no overlay is visible at consumption time
    // (a battle that opened meanwhile drops the pending open silently).
    // WRONG IMPL KILLED (1): an ungated consumption — a wild encounter during the dismiss
    //   round-trip would pop the shop over the battle overlay, puncturing the 14-way
    //   mutual-exclusion invariant from a code path no hotkey guard covers.
    // WRONG IMPL KILLED (2): a consumption that opens `buildShopViewModel` (first-shop
    //   default) instead of the bound `buildShopViewModelForShop(...)` — the player would
    //   greet the Tideglass shopkeeper and be shown the Pebble Town catalogue.
    // WRONG IMPL KILLED (3): a consumption that does not CLEAR pendingShopId — the next
    //   unrelated dialogue dismissal would spontaneously re-open the shop.
    const region = stripLineComments(
      regionOrThrow(readMainTs(), UXD2_SHOPOPEN_BEGIN, UXD2_SHOPOPEN_END),
    );
    expect(
      region.includes('pendingShopId'),
      'the UXD2-SHOPOPEN region must read pendingShopId (the deferred open)',
    ).toBe(true);
    expect(
      region.includes('if (!anyOverlayVisible()) {'),
      'the deferred open must be gated on the CONTIGUOUS `if (!anyOverlayVisible()) {` — an ' +
        'overlay that opened during the dismiss round-trip must drop the pending open ' +
        "(ADR-0161 D4). STRENGTHENED in uxd3-b (red-team F5): a bare `includes('anyOverlayVisible')` " +
        'presence check was MEASURED green against the one-character inversion ' +
        '`if (anyOverlayVisible()) {`, which makes the shop open ONLY while another overlay is up ' +
        '— i.e. never on the normal path, and directly over a live battle on the encounter path. ' +
        'uxd3-b made this the SIXTH consumer of a now-shared predicate, so presence alone is no ' +
        'longer meaningful.',
    ).toBe(true);
    expect(
      region.includes('buildShopViewModelForShop('),
      'the deferred open must bind the overlay to the pending shopId via ' +
        'buildShopViewModelForShop( — never the first-shop default (ADR-0161 D5)',
    ).toBe(true);
    expect(
      squashWhitespace(region).includes('pendingShopId = null'),
      'the deferred open must CLEAR pendingShopId (`pendingShopId = null`) as it consumes it — ' +
        'consume-and-clear is atomic (ADR-0161 D4); without the clear, the next unrelated ' +
        'dialogue dismissal spontaneously re-opens the shop',
    ).toBe(true);
  });

  it('★ W-INTERACT-PENDING-ESCAPE BITES: the Escape-dialogue branch clears pendingShopId (last-intent-wins)', () => {
    // ADR-0161 D4: Escape CANCELS a pending shop-open. Without this, the sequence
    // "click Shop → change your mind → Escape" still pops the shop when the dismiss lands.
    // WRONG IMPL KILLED: an impl that wires the deferred open but never cancels it — the
    // player's last expressed intent (Escape) loses to their previous one.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD2_ESC_DLG_START);
    expectUniqueAnchor(src, UXD2_ESC_DLG_END);
    const region = stripLineComments(regionOrThrow(src, UXD2_ESC_DLG_START, UXD2_ESC_DLG_END));
    expect(
      region.includes('pendingShopId'),
      'the Escape-while-dialogue-visible branch must clear pendingShopId (ADR-0161 D4 ' +
        'last-intent-wins). Region is bounded by the two adjacent Escape branches, so a ' +
        'pendingShopId clear living elsewhere cannot satisfy this.',
    ).toBe(true);
  });

  it('★ W-INTERACT-PENDING-RECONNECT BITES: onReconnect clears pendingShopId AND boundShopId', () => {
    // ADR-0161 D4 / plan I7.8: the store was reset, so any pending or bound shop id refers to
    // rows that may no longer exist.
    // WRONG IMPL KILLED: an impl that hides shopView on reconnect (already there) but leaves
    // the two ids set — the first post-reconnect dialogue dismissal would open a shop the
    // player never asked for, bound to a possibly-deleted shop row.
    // Region: onReconnect: → the sibling onOwnWarp handler (this file's existing precedent —
    // the END is searched FROM startIdx so the unrelated line-306 comment cannot capture it).
    const src = readMainTs();
    const startIdx = src.indexOf('onReconnect:');
    expect(startIdx, "main.ts must contain 'onReconnect:'").toBeGreaterThanOrEqual(0);
    const endIdx = src.indexOf('onOwnWarp', startIdx);
    expect(
      endIdx,
      "main.ts must contain 'onOwnWarp' AFTER 'onReconnect:' (region end endpoint)",
    ).toBeGreaterThan(startIdx);
    const region = stripLineComments(src.slice(startIdx, endIdx));
    // Anti-vacuity: this really is the onReconnect body (siblings are force-hidden here).
    expect(
      region.includes('shopView?.hide()'),
      'the onReconnect region must contain the existing shopView?.hide() (proves the region ' +
        'is the real body, not an empty slice)',
    ).toBe(true);
    expect(
      region.includes('pendingShopId'),
      'onReconnect must clear pendingShopId (plan I7.8)',
    ).toBe(true);
    expect(region.includes('boundShopId'), 'onReconnect must clear boundShopId (plan I7.8)').toBe(
      true,
    );
  });
});

describe('★ main.ts wiring (uxd2): the on-world prompt is driven from the frame loop (AC-7/AC-12)', () => {
  it('★ W-INTERACT-FRAME BITES: the rAF frame body calls interactPrompt( and renderer screenFor(', () => {
    // ADR-0161 D6 / plan I7.9: the prompt is recomputed EVERY FRAME (so it self-heals on zone
    // switch, reconnect and overlay open) and its screen position comes from
    // WorldRenderer.screenFor — the exact camera offset + stageScale the stage applied THIS
    // frame.
    // WRONG IMPL KILLED (1): a prompt updated only on a store batch — it would freeze in place
    //   mid-slide and lag a zone switch by a whole transaction.
    // WRONG IMPL KILLED (2): a prompt positioned from a PARALLEL camera computation
    //   (`offsetFor(...)` recomputed locally, or lastCamX/lastCamY with no stageScale) — the
    //   DOM label swims against the canvas during every slide, and the mixed-unit bug (CSS px
    //   into a device-px offset) is invisible until a non-1 DPR machine runs it.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD2_FRAME_START);
    // BOTH endpoints are uniqueness-checked (file discipline; the START alone is not enough).
    // The END was `} catch (err) {` at authoring time — ~26 occurrences in main.ts, so an inner
    // try/catch added anywhere in the frame body would silently truncate the region and this
    // tooth would pass on a prompt wired nowhere. The frame handler's own error log is unique.
    expectUniqueAnchor(src, UXD2_FRAME_END);
    const region = stripLineComments(regionOrThrow(src, UXD2_FRAME_START, UXD2_FRAME_END));
    // Anti-vacuity: this really is the frame body.
    expect(
      region.includes('renderer?.render('),
      'the frame region must contain the existing renderer?.render( call (proves the region is ' +
        'the real rAF body)',
    ).toBe(true);
    expect(
      region.includes('interactPrompt('),
      'the frame body must call interactPrompt( each frame (plan I7.9 — recomputed per frame ' +
        'so the prompt self-heals on zone switch / reconnect / overlay open)',
    ).toBe(true);
    expect(
      region.includes('screenFor('),
      'the frame body must position the prompt via renderer.screenFor( — the ONE tested ' +
        'world→screen transform, reusing the offset the stage actually applied (ADR-0161 D6)',
    ).toBe(true);
    expect(
      region.includes('nearestInteractable('),
      'the frame body must resolve the prompt target with nearestInteractable( — the SAME ' +
        'resolver KeyT dispatches on, so the prompt can never advertise a target KeyT refuses',
    ).toBe(true);
  });

  it('★ W-INTERACT-PROMPT-EL BITES: main.ts CREATES the #interact-prompt element (the #status precedent)', () => {
    // ADR-0161 D6 / plan I7.9: created inline in main.ts next to the `status.id = 'status'`
    // precedent, `position:fixed`, `pointer-events:none`.
    // WRONG IMPL KILLED (1): no element at all — interactPrompt would compute a VM nothing
    //   renders, and the e2e's `#interact-prompt` locator would never resolve.
    // WRONG IMPL KILLED (2): a prompt element WITHOUT pointer-events:none — it would shadow
    //   the document-level dialogue/shop click handlers wherever it floats, and a player
    //   standing next to an NPC could not click a dialogue choice underneath it.
    // Needle is the ASSIGNMENT form `.id = 'interact-prompt'` (mirrors `status.id = 'status'`),
    // so a mere getElementById lookup of an element shipped in index.html does not satisfy it.
    const src = readMainTs();
    expect(
      src.includes(".id = 'interact-prompt'"),
      "main.ts must create the prompt element and assign `.id = 'interact-prompt'` (the " +
        "`status.id = 'status'` precedent, plan I7.9)",
    ).toBe(true);
    const squashed = squashWhitespace(stripLineComments(src));
    expect(
      squashed.includes('pointer-events: none') ||
        squashed.includes('pointer-events:none') ||
        squashed.includes('pointerEvents'),
      'the #interact-prompt element must be pointer-events:none — it floats over the canvas ' +
        'and must never shadow the document-level dialogue/shop click delegation (ADR-0161 D6)',
    ).toBe(true);
  });

  it('★ W-INTERACT-SCREENFOR BITES: WorldRenderer exposes screenFor( built on the tested worldToScreen', () => {
    // ADR-0161 D6 / plan I6b. world.ts is Pixi-bound and coverage-excluded, so it is pinned
    // by a direct-file source scan rather than a unit test (the composed pure pieces —
    // offsetFor + worldToScreen — are already unit-tested in render/viewport.test.ts).
    // WRONG IMPL KILLED (1): no screenFor at all (the frame tooth above would then fail for a
    //   second, confusing reason — this one names the real cause).
    // WRONG IMPL KILLED (2): a screenFor that recomputes the camera offset from scratch
    //   instead of reusing the one `render()` actually applied — that is a PARALLEL camera and
    //   it desynchronises by exactly the sub-tile slide amount every frame.
    // WRONG IMPL KILLED (3): a screenFor that forgets stageScale — correct at DPR 1 and
    //   wrong everywhere else (the uxd1/ADR-0160 device-integer scaling).
    const src = readClientSrc('render/world.ts');
    expect(
      src.includes('screenFor('),
      'world.ts must expose screenFor( on WorldRenderer (plan I6b)',
    ).toBe(true);
    expect(
      src.includes('worldToScreen('),
      'screenFor must be built on the tested worldToScreen( (render/viewport.ts) — not a ' +
        'hand-rolled second transform (ADR-0161 D6)',
    ).toBe(true);
    expect(
      src.includes('stageScale'),
      'screenFor must apply stageScale — a DPR-1-only transform is the uxd1/ADR-0160 ' +
        'mixed-unit bug re-introduced',
    ).toBe(true);
  });
});

describe('★ main.ts wiring (uxd2): the dialogue view renders the enum-derived Shop button (AC-2)', () => {
  it('★ W-INTERACT-DLGVIEW BITES: dialogueView.ts renders a [data-shop-id] button from vm.shopAction', () => {
    // ADR-0161 D4. Direct-file scan (dialogueView.ts is a coverage-excluded DOM shell, so it
    // has no unit test of its own — this is the only structural gate on it).
    // WRONG IMPL KILLED (1): a Shop button rendered from CHOICE TEXT rather than from
    //   vm.shopAction — un-pinnable string coupling that breaks the moment the greeting is
    //   reworded, and that would render a Shop button for any NPC whose dialogue mentions one.
    // WRONG IMPL KILLED (2): a Shop button that carries `data-choice-idx` — the existing
    //   dialogue click delegation would fire advance_dialogue with a nonsense index.
    // NOTE the needle is `shopId` on the dataset (the DOM API camel-cases `data-shop-id`), so
    // either literal spelling satisfies it, but the shopAction read is asserted separately.
    const src = readClientSrc('ui/dialogueView.ts');
    expect(
      src.includes('shopAction'),
      'dialogueView.ts must render the Shop button from vm.shopAction (the enum-derived ' +
        'affordance), never from choice text (ADR-0161 D4)',
    ).toBe(true);
    expect(
      src.includes('shopId') || src.includes('data-shop-id'),
      'dialogueView.ts must stamp the shop id onto the button (dataset.shopId / data-shop-id) ' +
        'so the main.ts click branch can read it',
    ).toBe(true);
  });
});

// ===========================================================================
// uxd3 (ADR-0162) — registry-backed two-level main menu: the main.ts wiring gate.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd3 (the 20 EARS
// criteria at spec `:138-157`), as amended by docs/uxd3-plan.md §A (BINDING — §A overrides
// §1-§9 wherever they conflict). Each tooth below names the AC it proves.
//
// SCOPE: this block gates `client/src/main.ts` ONLY (plus `client/index.html` for the single
// corner-affordance invariant). The pure cores land with their own suites and are NOT
// re-proved here: `OR-*` → client/src/ui/overlayRegistry.test.ts, `MM-*` → menuModel.test.ts,
// `MV-*` → menuView.test.ts.
//
// RED REASON (all 14 teeth, at authoring time): `menuView` appears 0× in main.ts, there is no
// `e.code === 'KeyM'` handler, no `openMenu`/`activateMenuLeaf`/`menuAvailability`, and
// `client/src/ui/overlayRegistry.ts` does not exist. The two whole-file NEGATIVE guards
// (W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE, W-ESCAPE-NEVER-REOPENS-MENU) are GREEN-BY-DESIGN today
// — they are regression guards against the single most likely refactor mistake — and each
// therefore carries a documented, live positive control proving it is not vacuous.
//
// ---------------------------------------------------------------------------------------
// ⚠⚠ READ BEFORE EDITING main.ts — FIXED-WINDOW HAZARD STATUS (uxd3-c update) ⚠⚠
// ---------------------------------------------------------------------------------------
// uxd3-b left FOUR fixed-`+N`-window hazards live against uxd3-c's own edits. uxd3-c resolves
// three of them outright and re-states the one that survives, plus one new H4 concern of its
// own. Read this before touching KeyB/I/E, the handle table, or refreshBattle.
//
//  H1. RESOLVED by T1a. `W-TP-RECONNECT` and `W-RN-FANOUT-RECONNECT` no longer slice a fixed
//      `+1000`/`+800` window from `reconnectIdx` — both are re-anchored onto the SAME
//      two-endpoint region `W-HELP-NO-RECONNECT-HIDE` and `W-RECONNECT-HIDES-MENU` already use
//      (`onReconnect:` -> the NEXT `onOwnWarp` searched FROM startIdx), and both now assert the
//      CALL form (`tradeProposeView?.hide()` / `renameView?.hide()`) rather than the bare
//      identifier. `W-RECONNECT-HIDES-MENU` clause 2b (the `tpDelta < 1000` restatement that
//      existed ONLY to make H1's fixed window fail legibly) is retired by the orchestrator in
//      T3 alongside it — there is no fixed window left to protect.
//
//  H2. RESOLVED by E17. `W-HELP-FANOUT-BATTLE` slices `showIdx + 900` over the EIGHT hand-written
//      `if (X?.visible) X.hide();` lines in refreshBattle's show-arm; E17 deletes all eight in
//      favour of the `hideAllExceptPlan('battleView', visibleIds(overlayProbes))` loop (surface 7
//      below), so the `helpView` token this tooth anchors on is GONE and it goes red BY DESIGN —
//      the orchestrator retires it in T3 (pre-assessed: genuinely subsumed by `OR-FORCEHIDE-EXACT`
//      + `W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST`'s rewritten shape assertion, not a
//      would-have-stayed-green deletion).
//
//  H3. STILL LIVE. THREE teeth — `W-RN-ESCAPE` (+2000), `W-TP-ESCAPE` (+2500), `W-HELP-ESCAPE`
//      (+2500) — still locate their region with the FIRST `src.indexOf("e.code === 'Escape'")`
//      in the whole file. uxd3-c does not touch the Escape branch stack or the menu-nav
//      intercept, so the hazard is UNCHANGED IN KIND. The mitigating fact that emerged in this
//      slice: post-migration, KeyB/I/E no longer contain the `renameView`/`tradeProposeView`/
//      `helpView` tokens at all (their guard lists collapse into a single
//      `overlayVerdict('boxView')` etc. call), so a future mis-anchored `+2000/+2500` window
//      would land in a block that satisfies NONE of the three teeth's needles — H3's "silently
//      re-anchor and stay falsely green forever" failure mode now fails LOUDLY instead. The
//      hazard is REDUCED, not eliminated: the boy-scout re-anchor itself (ADR-0163 D8, ~73 lines
//      / 4 hunks against a ~40-line / <=3-hunk cap, atomic and therefore untrimmable) is deferred
//      a THIRD time, to the named follow-up **uxd3-d**.
//
//  H4. STILL LIVE, and now also uxd3-c's own concern. Anti-pattern 14b: uxd3-c's TWO new blocks
//      (`// UXD3C-HANDLES-BEGIN`/`-END` and `// UXD3C-CANOPEN-BEGIN`/`-END`) land, like uxd3-b's
//      probe table before them, ABOVE `window.addEventListener('keydown'` — i.e. before the
//      first-`indexOf` anchors of every hotkey tooth in this file. A quoted hotkey literal in
//      either block (in code OR in a comment) re-anchors those teeth onto the wrong region.
//      `W-UXD3-HOTKEY-ANCHORS-AFTER-KEYDOWN` (below) still makes that loud. Describe the keys in
//      prose in both new blocks, exactly as the probe table already does.
//
//  H5. RESOLVED (headroom improved, not eliminated). `W-RN-HELD` slices `indexOf("'KeyN'") + 720`
//      for `held.clear()`. uxd3-c's collapse SHRINKS the KeyN block (the 12-term guard list
//      becomes one `overlayVerdict('renameView').kind === 'allow'` call), so `held.clear()` moves
//      CLOSER to the anchor, not farther — headroom improves by roughly 430 characters instead of
//      shrinking. The same improvement applies to `W-RN-PREVENT` (+600), `W-TP-HELD` (+800),
//      `W-TP-PREVENT` (+800) and `W-TP-IDENTITY-GUARD` (+800). None of these fixed windows is
//      re-anchored in this slice (that remains uxd3-d's Escape boy-scout territory per D8) — they
//      are simply no longer the "next to go".
//
// NO `new RegExp(...)` anywhere (Semgrep ban, this file's rule): indexOf/includes/split only.
// ===========================================================================

/** The KeyM open-handler anchor (plan edit 18). MUST be unique in main.ts — see H4. */
const UXD3_KEYM_ANCHOR = "e.code === 'KeyM'";

/** The Escape branch-stack sentinel. Used ONLY to bound the KeyM block from below and to
 *  enumerate the Escape branches for W-ESCAPE-NEVER-REOPENS-MENU — this file never asks
 *  main.ts to ADD an occurrence of it (see H3: an extra earlier occurrence is the hazard). */
const UXD3_ESCAPE_SENTINEL = "e.code === 'Escape'";

/** The eleven pre-uxd3 open-handler anchors, used to bound the KeyM block from ABOVE regardless
 *  of where the implementer places the new handler. Deliberately a SECOND, independent copy of
 *  W-OVERLAY-FANOUT-MUTEX's `OPEN_HANDLERS` list (plan §6 AC-8 precedent, and the same reason
 *  W-INTERACT-KEYT-GUARD duplicates the KeyT guard): this slice EDITS that shared list, so a
 *  list-independent statement of the KeyM invariant keeps it pinned even if the shared list is
 *  ever mis-edited. */
const UXD3_OTHER_HANDLER_ANCHORS: readonly string[] = [
  "e.code === 'KeyB'",
  "e.code === 'KeyI'",
  "e.code === 'KeyE'",
  "e.code === 'KeyQ'",
  "e.code === 'KeyU'",
  "e.code === 'KeyP'",
  "e.code === 'KeyL'",
  "e.code === 'KeyN'",
  "e.code === 'KeyO'",
  "e.code === 'KeyT'",
  "e.key === '?'",
];

/** The 14 siblings the KeyM handler must guard (every mutual-exclusion overlay EXCEPT its own
 *  `menuView`). Hard-coded rather than derived from `ALL_OVERLAYS` on purpose: plan A4's lesson
 *  is that a loop domain derived from the table under test goes tautological the moment the
 *  table is mutated (drop an id from ALL_OVERLAYS and a derived list simply stops checking it).
 *  This literal is the independent statement of "all 14". */
const UXD3_KEYM_SIBLINGS: readonly string[] = [
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
];

/** `anyOverlayVisible()` — fan-out surface #1 (plan edit 3). Two-endpoint bounded on the two
 *  function DECLARATIONS around it, never a `+N` window: the OR-list is 14 lines long today and
 *  a fixed window would silently stop covering it as members are added. */
const UXD3_ANYOVERLAY_START = 'function anyOverlayVisible(';
const UXD3_ANYOVERLAY_END = 'function characterTileMap(';

/** The keydown movement-suppression block (fan-out surface #3, plan edit 19). Same two anchors
 *  W-NH1-SUPPRESS uses — the START is nh1/ADR-0146's start-anchor COMMENT and must be preserved
 *  verbatim (anti-pattern 16). */
const UXD3_SUPPRESS_START = 'Suppress movement input while an overlay is open';
const UXD3_SUPPRESS_END = 'const dir = KEY_DIR[e.code];';

/** The pvp batch listener's local aggregate (fan-out surface #4, plan edit 23). Bounded by the
 *  NEXT `const` in the same listener rather than the pre-existing `+1200` window — a real
 *  endpoint cannot drift, and `const anyOverlayVisible =` must stay verbatim (anti-pattern 18:
 *  four teeth anchored on it pre-uxd3-b; W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY now does). */
const UXD3_PVPAGG_START = 'const anyOverlayVisible =';
const UXD3_PVPAGG_END = 'const forceVisible =';

/** `refreshBattle`'s show-arm (plan edit 20 / AC-4 / AC-19). */
const UXD3_BATTLE_SHOW_START = "r.action.kind === 'show'";
const UXD3_BATTLE_SHOW_END = 'const baitItems';

/** The M12d dialogue batch listener (plan edit 21 / AC-19 dialogue half). END is the listener's
 *  OWN unique error log, NOT `} catch (err) {` — that occurs ~26× in main.ts, so it cannot be
 *  uniqueness-checked and an inner try/catch would silently truncate the region (the exact way
 *  a needle-bounded scan goes vacuously green — nh1 post-mortem, UXD2_FRAME_END precedent). */
const UXD3_M12D_START = 'const conv = store.ownConversation(identity);';
const UXD3_M12D_END = "console.error('[M12d] dialogue batch listener error'";

/** The three NEW top-level menu helpers in main.ts (plan edit 4). They MUST be `function`
 *  DECLARATIONS at column 0, not `const` arrows: (a) these teeth slice on the declaration form,
 *  (b) hoisting is what lets the KeyM handler at ~:983 call `openMenu()` declared at ~:262
 *  without an ordering hazard, and (c) it matches every existing helper in the file. */
const UXD3_OPENMENU_DECL = 'function openMenu(';
const UXD3_ACTIVATE_DECL = 'function activateMenuLeaf(';
const UXD3_MENUAVAIL_DECL = 'function menuAvailability(';

/** Slice ONE top-level function declaration: from its `function name(` anchor to the NEXT
 *  column-0 `function ` in the file. Deliberately does NOT fall back to end-of-file when no
 *  following declaration exists — a to-EOF slice would make "the region contains X" satisfiable
 *  by an X living ANYWHERE later in main.ts (e.g. `MENU_INITIAL` in the module-scope
 *  `let menuState = MENU_INITIAL;`), which is precisely the vacuity these teeth exist to avoid.
 *  Throws loud instead. */
function uxd3FunctionBody(src: string, declNeedle: string): string {
  const startIdx = src.indexOf(declNeedle);
  if (startIdx < 0) {
    throw new Error(
      `main.ts must declare \`${declNeedle}…\` as a TOP-LEVEL function declaration ` +
        '(uxd3/ADR-0162 plan edit 4 — a `const x = () => {}` arrow does not satisfy this ' +
        'anchor, and would also lose the hoisting the KeyM handler relies on)',
    );
  }
  const endIdx = src.indexOf('\nfunction ', startIdx + declNeedle.length);
  if (endIdx < 0) {
    throw new Error(
      `no top-level \`function \` declaration follows \`${declNeedle}\` in main.ts — refusing ` +
        'to slice to end-of-file, which would let a needle anywhere later in the file satisfy ' +
        'the assertion vacuously. Place the uxd3 menu helpers in the helper block after ' +
        'characterTileMap() (plan edit 4), where many further declarations follow.',
    );
  }
  return stripLineComments(src.slice(startIdx, endIdx));
}

/** The KeyM handler block: from its anchor to the nearest FOLLOWING open-handler anchor or the
 *  Escape sentinel (order-independent, the W-OVERLAY-FANOUT-MUTEX idiom), so a guard living in
 *  a DIFFERENT handler can never false-credit KeyM. */
function uxd3KeyMBlock(src: string): string {
  const keyMIdx = src.indexOf(UXD3_KEYM_ANCHOR);
  expect(
    keyMIdx,
    `main.ts must contain the menu front-door handler \`if (${UXD3_KEYM_ANCHOR})\` ` +
      '(uxd3 AC-11 / plan edit 18 — KeyM is the self-owned, zero-DOM front door)',
  ).toBeGreaterThanOrEqual(0);
  let blockEnd = src.length;
  for (const other of [...UXD3_OTHER_HANDLER_ANCHORS, UXD3_ESCAPE_SENTINEL]) {
    const otherIdx = src.indexOf(other, keyMIdx + UXD3_KEYM_ANCHOR.length);
    if (otherIdx >= 0 && otherIdx < blockEnd) blockEnd = otherIdx;
  }
  return stripLineComments(src.slice(keyMIdx, blockEnd));
}

describe('★ main.ts wiring (uxd3): the KeyM menu front-door handler (AC-11 / AC-8)', () => {
  it('★ W-KEYM-HANDLER BITES: a UNIQUE `e.code === KeyM` handler gates on overlayVerdict(\'menuView\') AND identity !== ""', () => {
    // AC-11 (spec :148): "WHEN the player presses KeyM AND canOpen('menuView') returns allow,
    // THE client SHALL open the menu at the top-level category list; AND THIS SHALL function
    // with NO persistent launcher element present."
    //
    // uxd3-c re-anchor (ADR-0164, plan §C3 / adjudication §C): the 14-term inline guard list is
    // GONE — KeyM now asks the ONE shared reducer `overlayVerdict('menuView')` (E16), which is
    // exhaustively node-tested in overlayRegistry.test.ts (`OR-CANOPEN-*`). Restating all 14
    // guards here would be tautological against a table that no longer exists in main.ts; the
    // CONTIGUOUS call-shape assertion below is what a wrong tier assignment, a `.kind === 'deny'`
    // inversion, or an extra conjunct spliced inside the parens cannot survive.
    //
    // WRONG IMPL KILLED (1): no KeyM handler at all — the RED state pre-uxd3 (`menuView` appears
    //   0× in main.ts). The menu would be unreachable: KeyM is the ONLY hotkey front door.
    // WRONG IMPL KILLED (2): `.kind === 'deny'` inverted, or an extra conjunct spliced INSIDE the
    //   parens (`overlayVerdict('menuView').kind === 'allow' && somethingElse`). The CONTIGUOUS
    //   needle below requires the exact shape with nothing between `'allow'` and `&&`.
    // WRONG IMPL KILLED (3): the `identity !== ''` omission (plan A12 / reviewer H3). KeyM would
    //   otherwise be the ONLY open-handler without it. `menuAvailability()` calls
    //   `nearestInteractable(store.ownCharacter(identity)!.row, …)`; pre-join `ownCharacter('')`
    //   is `undefined`, so the non-null assertion throws INSIDE an uncaught window keydown
    //   listener — pressing M on the loading screen breaks input handling for the session.
    // WRONG IMPL KILLED (4): the literal `e.code === 'KeyM'` written twice (typically once in a
    //   rationale comment above the handler). The block slicer takes the FIRST indexOf, so the
    //   comment would become the block start and the real guard would fall outside the block —
    //   anti-pattern 14. The uniqueness assertion below is the only thing standing between that
    //   and a silently mis-anchored gate.
    // WRONG IMPL KILLED (5): a residual hand-rolled per-id guard term surviving ALONGSIDE the
    //   canOpen() call (a copy-paste leftover from the pre-migration 14-term list) — harmless on
    //   its own, but evidence the migration was not a clean collapse, and a future edit to ONLY
    //   the residual term would silently diverge from the real gate.
    const src = readMainTs();
    // (4): exactly once, in RAW source — a comment occurrence counts and must fail.
    expectUniqueAnchor(src, UXD3_KEYM_ANCHOR);
    const block = uxd3KeyMBlock(src);
    // ANTI-VACUITY: the slice is a real, non-degenerate handler body that names its own overlay.
    // A collapsed/empty block would otherwise pass nothing and fail everything for the wrong
    // reason; an over-wide block would credit guards from a neighbouring handler.
    expect(
      block.length,
      'the KeyM handler block must be a non-empty slice (anti-vacuity)',
    ).toBeGreaterThan(0);
    expect(
      block.includes('menuView'),
      'the KeyM block must reference menuView — proves the region really is the menu handler ' +
        'and not a degenerate/mis-anchored slice (anti-vacuity)',
    ).toBe(true);

    const squashed = squashWhitespace(block);
    expect(
      squashed.includes("overlayVerdict('menuView').kind === 'allow' && identity !== ''"),
      "the KeyM block must gate on the CONTIGUOUS `overlayVerdict('menuView').kind === 'allow' " +
        "&& identity !== ''` — the ONE call that reproduces the full 15-way mutual exclusion AND " +
        'the pre-join guard; both halves are exhaustively proved node-side (OR-CANOPEN-*).',
    ).toBe(true);

    // (5): no residual hand-rolled guard term may survive alongside the canOpen() call.
    for (const overlay of UXD3_KEYM_SIBLINGS) {
      expect(
        block.includes(`!${overlay}?.visible`),
        `the KeyM block must NOT contain a residual hand-rolled guard !${overlay}?.visible — ` +
          "mutual exclusion now routes exclusively through overlayVerdict('menuView')",
      ).toBe(false);
    }
  });

  it('★ W-KEYM-PREVENTDEFAULT BITES: KeyM calls e.preventDefault() UNCONDITIONALLY, before its guard list', () => {
    // AC-8 (spec :145): "IF canOpen returns deny, THE handler SHALL no-op while still calling
    // e.preventDefault()." Plan edit 18 puts the call as the handler's FIRST statement, outside
    // the guard, exactly like the `?` handler (main.ts:958) does.
    //
    // WRONG IMPL KILLED (1): no preventDefault at all — M is a plain letter key, so the browser
    //   default is comparatively benign, but the keypress then also falls through to the rest of
    //   the keydown listener; the gate's uniform "every handler suppresses its own key" contract
    //   is what keeps that reasoning unnecessary.
    // WRONG IMPL KILLED (2 — the real target): preventDefault called only INSIDE the allow-arm.
    //   With a battle up, the guard list is false, so M would fall through to the movement
    //   suppression block and (post-nh1) be swallowed there instead — behaviour that depends on
    //   an unrelated block's ordering. The ordering assertion below (call BEFORE the first guard
    //   token) is what distinguishes the two impls; a bare `block.includes('e.preventDefault()')`
    //   would pass both.
    const src = readMainTs();
    const block = uxd3KeyMBlock(src);
    // ANTI-VACUITY: real block (same control as W-KEYM-HANDLER).
    expect(
      block.includes('menuView'),
      'the KeyM block must reference menuView (anti-vacuity — proves this is the real handler)',
    ).toBe(true);
    const preventIdx = block.indexOf('e.preventDefault()');
    expect(
      preventIdx,
      'the KeyM handler must call e.preventDefault() (AC-8 — a denied open still consumes the key)',
    ).toBeGreaterThanOrEqual(0);
    // uxd3-c re-anchor (ADR-0164, plan §C3): the OLD anchor `!battleView?.visible` no longer
    // exists in the KeyM block (the 14-term guard list collapsed into ONE overlayVerdict() call
    // — W-KEYM-HANDLER). Re-anchored onto the call itself; the AC-8 ordering claim is unchanged.
    const firstGuardIdx = block.indexOf("overlayVerdict('menuView')");
    expect(
      firstGuardIdx,
      "the KeyM handler must contain its overlayVerdict('menuView') gate (W-KEYM-HANDLER " +
        'states this too; repeated here so the ordering assertion below cannot compare against -1)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      preventIdx,
      'e.preventDefault() must appear BEFORE the KeyM guard — i.e. unconditionally, on the ' +
        'DENY path too (AC-8). A preventDefault nested inside the allow-arm lets a KeyM press ' +
        'during a battle fall through to the movement-suppression block instead of being ' +
        'consumed by its own handler.',
    ).toBeLessThan(firstGuardIdx);
  });
});

describe('★ main.ts wiring (uxd3): refreshBattle force-hide set === the overlayRegistry manifest (AC-4 / AC-19)', () => {
  /** Extract every `if (X?.visible) X.hide();` force-hide pair from a comment-stripped region.
   *  Hand-rolled scan (no `new RegExp` — Semgrep ban). Accepts the optional braced form
   *  `if (X?.visible) { X.hide(); }`; REJECTS a guard-only `if (!X?.visible)` and rejects a
   *  mismatched pair such as `if (helpView?.visible) menuView.hide();` — the name before
   *  `?.visible)` must be the same name that is hidden immediately after. */
  function extractForceHidePairs(region: string): string[] {
    const found: string[] = [];
    const chunks = region.split('if (');
    for (const chunk of chunks.slice(1)) {
      const vIdx = chunk.indexOf('?.visible)');
      if (vIdx < 0) continue;
      const name = chunk.slice(0, vIdx);
      // A real identifier ending in `View` — screens out `!X`, multi-line conditions and
      // compound guards (`a?.visible || b?.visible)`).
      if (!name.endsWith('View')) continue;
      if (name.includes(' ') || name.includes('\n') || name.includes('!') || name.includes('|')) {
        continue;
      }
      let after = chunk.slice(vIdx + '?.visible)'.length).trimStart();
      if (after.startsWith('{')) after = after.slice(1).trimStart();
      if (after.startsWith(`${name}.hide()`)) found.push(name);
    }
    return found;
  }

  it('★ W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST BITES: the show-arm force-hide loop matches the manifest exactly, and the manifest excludes dialogueView', async () => {
    // AC-4 (spec :141) + AC-19 battle half (spec :156): a battle auto-show must force-hide
    // exactly the declared subset — and, now that the menu is a registry member, it must close
    // the menu too ("the menu never occludes a battle").
    //
    // uxd3-c re-anchor (ADR-0164, plan §C3): the eight hand-written `if (X?.visible) X.hide();`
    // pairs `extractForceHidePairs` (above) used to scan are GONE — E17 replaces all eight with
    // `hideAllExceptPlan('battleView', visibleIds(overlayProbes))` (surface 7). Set-drift between
    // refreshBattle and BATTLE_FORCE_HIDE is therefore STRUCTURALLY UNREPRESENTABLE: the manifest
    // DRIVES the loop directly at runtime, so there is no second hand-authored list left to drift
    // out of sync with it. `extractForceHidePairs` is KEPT (the orchestrator removes it in T3 once
    // it is confirmed orphaned, not the tester) and repurposed below as a "the old form is
    // COMPLETELY gone" sanity check.
    //
    // WHAT IS LOST, stated honestly (plan §C3): the one-line GUARDED FORM pin
    // (`if (X?.visible) X.hide();`) `extractForceHidePairs` used to verify is gone; what remains
    // is the loop's own contiguous SHAPE (surface 7 in the uxd3-b/uxd3-c Part A block, restated
    // here as an independent statement) plus the two invariants below, neither of which is
    // re-proved by surface 7 alone: the manifest's LENGTH and its exclusion of dialogueView. The
    // ORDERED exact-literal content pin lives in the registry's own suite (`OR-FORCEHIDE-EXACT`,
    // `OR-NEVER-FORCE-HIDE`), both node-tested — so the *content* of the set is, if anything,
    // BETTER covered after this change than the guarded-pair scan ever was.
    //
    // WRONG IMPL KILLED (1): a `refreshBattle` that force-hides the old 7 and forgets the menu —
    //   BATTLE_FORCE_HIDE.length !== 8 catches a shrunken manifest.
    // WRONG IMPL KILLED (2): dialogueView added to the manifest (force-hiding a live conversation
    //   strands the server player_conversation row, ptc5c/ADR-0139) — the disjointness assertion
    //   states that invariant directly.
    // WRONG IMPL KILLED (3): the loop rewritten with the WRONG keep id, or NOT reading
    //   `visibleIds(overlayProbes)` — the exact-equality region check catches any deviation from
    //   the pinned contiguous shape.
    // WRONG IMPL KILLED (4): a leftover hand-written `if (X?.visible) X.hide();` pair surviving
    //   ALONGSIDE the loop (an incomplete collapse) — the `extractForceHidePairs` sanity check at
    //   the end requires exactly ZERO pairs in the show-arm region.
    //
    // WHY A DYNAMIC import(): `client/src/ui/overlayRegistry.ts` does not exist yet at authoring
    // time. A STATIC top-level import of a missing module fails module RESOLUTION, which reds the
    // COLLECTION of this entire multi-thousand-line file. The dynamic import confines the RED to
    // this one test while still being a real import.
    const { BATTLE_FORCE_HIDE } = await import('./ui/overlayRegistry');
    expect(
      BATTLE_FORCE_HIDE.length,
      'BATTLE_FORCE_HIDE must have exactly 8 members (the pre-existing 7 + menuView, AC-19)',
    ).toBe(8);
    expect(
      [...BATTLE_FORCE_HIDE].includes('dialogueView'),
      'BATTLE_FORCE_HIDE must NEVER contain dialogueView — force-hiding a live conversation ' +
        'strands the server player_conversation row (ptc5c/ADR-0139; NEVER_FORCE_HIDE)',
    ).toBe(false);

    const src = readMainTs();
    expectUniqueAnchor(src, UXD3C_BATTLEHIDE_BEGIN);
    expectUniqueAnchor(src, UXD3C_BATTLEHIDE_END);
    const region = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3C_BATTLEHIDE_BEGIN, UXD3C_BATTLEHIDE_END)),
    ).trim();
    expect(
      region.length,
      'ANTI-VACUITY: the battle force-hide loop region is empty after comment-stripping — the ' +
        'region collapsed and the equality below would fail for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      region,
      "refreshBattle's show-arm force-hide must be EXACTLY " +
        "`for (const id of hideAllExceptPlan('battleView', visibleIds(overlayProbes))) { " +
        'overlayHandles[id]?.(); }` (E17) — the manifest now DRIVES this loop directly, so a ' +
        'hand-added extra hide or a dropped one is invisible to a source scan by construction ' +
        '(it would have to change the MANIFEST, which is separately pinned by OR-FORCEHIDE-EXACT ' +
        'and OR-NEVER-FORCE-HIDE). Region=' +
        JSON.stringify(region),
    ).toBe(
      "for (const id of hideAllExceptPlan('battleView', visibleIds(overlayProbes))) { overlayHandles[id]?.(); }",
    );

    // Old-form sanity: extractForceHidePairs (retained, orphaned — the orchestrator removes it in
    // T3) must now find ZERO of the old guarded-hide pairs in the show-arm — proves the collapse
    // is total and no leftover hand-written pair survives alongside the loop.
    expectUniqueAnchor(src, UXD3_BATTLE_SHOW_START);
    expectUniqueAnchor(src, UXD3_BATTLE_SHOW_END);
    const showRegion = bodyRegion(src, UXD3_BATTLE_SHOW_START, UXD3_BATTLE_SHOW_END);
    const pairs = extractForceHidePairs(showRegion);
    expect(
      pairs.length,
      'the old `if (X?.visible) X.hide();` guarded-pair form must be COMPLETELY gone from the ' +
        `show-arm — found ${pairs.length}: ${JSON.stringify(pairs)}. A nonzero count means the ` +
        'E17 collapse is incomplete (a hand-written pair survives alongside the loop).',
    ).toBe(0);
  });
});

describe('★ main.ts wiring (uxd3): context overlays PREEMPT the menu (AC-19) and reconnect closes it (AC-10)', () => {
  it('★ W-DIALOGUE-PREEMPTS-MENU BITES: the M12d dialogue batch listener hides the menu on an incoming conversation', () => {
    // AC-19 dialogue half (spec :156): "WHEN a battle auto-shows OR the server pushes a dialogue
    // WHILE the menu is visible, THE registry SHALL close the menu and show the context overlay."
    // The spec's own residual (:173) asked for this teardown to be SITED exactly; plan edit 21
    // sites it in the M12d listener, immediately after `const conv = …`, because dialogue
    // visibility is STORE-DERIVED (there is no canOpen call site to hang it on — the row simply
    // appears in a batch).
    //
    // WRONG IMPL KILLED (1): no teardown — an NPC that starts a conversation (a talk round-trip
    //   the player initiated just before opening the menu, or any server push) renders the
    //   dialogue UNDER the full-screen menu. The player sees a menu, the server sees an open
    //   conversation, and the menu's arrow-key intercept swallows the dialogue choice keys.
    // WRONG IMPL KILLED (2): an UNCONDITIONAL `menuView?.hide();` at the top of the listener.
    //   This listener runs on EVERY store batch, so the menu would close within milliseconds of
    //   opening — a feature that appears to be "randomly broken" and that no other tooth here
    //   catches. Hence the guarded-form assertion: the hide must be conditioned on a
    //   conversation actually existing.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD3_M12D_START);
    expectUniqueAnchor(src, UXD3_M12D_END);
    const region = bodyRegion(src, UXD3_M12D_START, UXD3_M12D_END);
    // ANTI-VACUITY: this really is the dialogue listener body.
    expect(
      region.includes('buildDialogueViewModel('),
      'the M12d region must contain buildDialogueViewModel( — proves the region is the real ' +
        'dialogue batch listener, not an empty or mis-anchored slice',
    ).toBe(true);
    expect(
      region.includes('menuView?.hide'),
      'the M12d dialogue batch listener must hide the menu when a conversation is present ' +
        '(AC-19, plan edit 21 — the spec residual asked for this exact site)',
    ).toBe(true);
    const squashed = squashWhitespace(region);
    expect(
      squashed.includes('conv !== undefined && menuView?.visible') ||
        squashed.includes('menuView?.visible && conv !== undefined'),
      'the menu teardown must be GUARDED on the conversation existing — plan edit 21 prescribes ' +
        '`if (conv !== undefined && menuView?.visible) menuView.hide();` (either conjunct order ' +
        'is accepted). An unconditional hide in a per-batch listener closes the menu on the very ' +
        'next store batch, i.e. almost immediately after the player opens it.',
    ).toBe(true);
  });

  it('★ W-RECONNECT-HIDES-MENU BITES: onReconnect hides menuView, placed AFTER tradeProposeView?.hide()', () => {
    // AC-10 (spec :147): "WHEN the connection reconnects, THE onReconnect handler SHALL hide
    // renameView/tradeProposeView/shopView/tradeView/pvpView/leaderboardView AND menuView, AND
    // SHALL NOT hide helpView." The menu is hidden because its grey-out (`available()`) is
    // computed from store state that the reconnect reset invalidates.
    //
    // Region: the SAME two-endpoint slice W-HELP-NO-RECONNECT-HIDE uses — `onReconnect:` to the
    // NEXT `onOwnWarp` searched FROM startIdx (a bare indexOf would find the unrelated comment
    // at main.ts:386, which sits BEFORE onReconnect, and yield an empty region). NEVER a fixed
    // `+N` window here: the body is ~2250 chars, so a fixed slice would miss a hide appended at
    // the bottom. W-HELP-NO-RECONNECT-HIDE must stay GREEN alongside this tooth — the deliberate
    // help asymmetry (PTC2B-9) is untouched by uxd3.
    //
    // WRONG IMPL KILLED (1): no hide — after a reconnect the menu is still up, rendering
    //   grey-out flags derived from a store that was just cleared (Interact/PvP/Offer leaves
    //   would advertise availability for rows that no longer exist, and activating one would
    //   fire a reducer against a stale target).
    // WRONG IMPL KILLED (2 — the placement half, plan A8 / red-team F6): `menuView?.hide();`
    //   inserted ABOVE `tradeProposeView?.hide();`. W-TP-RECONNECT slices `reconnectIdx + 1000`
    //   and tradePropose currently sits at delta 978 — TWENTY-TWO characters of headroom. The
    //   suite would go red naming *tradePropose*, and with a house-style 2-line comment added it
    //   would also red W-RN-FANOUT-RECONNECT (+800) naming *rename* — sending the implementer to
    //   debug two overlays this slice never touched. Both assertions below exist to make that
    //   failure mode announce itself HERE, with the real cause, instead.
    // WRONG IMPL KILLED (3): a `RECONNECT_HIDE.forEach(...)` loop refactor (anti-pattern 17) —
    //   it would delete the literal hides that are W-HELP-NO-RECONNECT-HIDE's positive control.
    const src = readMainTs();
    const startIdx = src.indexOf('onReconnect:');
    expect(startIdx, "main.ts must contain 'onReconnect:'").toBeGreaterThanOrEqual(0);
    const endIdx = src.indexOf('onOwnWarp', startIdx);
    expect(
      endIdx,
      "main.ts must contain 'onOwnWarp' AFTER 'onReconnect:' (region end endpoint)",
    ).toBeGreaterThan(startIdx);
    const region = stripLineComments(src.slice(startIdx, endIdx));
    // ANTI-VACUITY: the real onReconnect body force-hides its siblings here today.
    const tpIdx = region.indexOf('tradeProposeView?.hide()');
    expect(
      tpIdx,
      'the onReconnect region must contain tradeProposeView?.hide() (proves the region is the ' +
        'real body, not an empty slice — anti-vacuity)',
    ).toBeGreaterThanOrEqual(0);
    const menuIdx = region.indexOf('menuView?.hide');
    expect(
      menuIdx,
      'onReconnect must hide the menu (AC-10, plan edit 25) — its grey-out reads store state ' +
        'that the reconnect reset just invalidated',
    ).toBeGreaterThanOrEqual(0);
    // (2a) ordering — strictly after the tradePropose hide.
    expect(
      menuIdx,
      'menuView?.hide() must be placed STRICTLY AFTER tradeProposeView?.hide() in onReconnect ' +
        '(plan A8). W-TP-RECONNECT slices a FIXED reconnectIdx+1000 window and tradePropose ' +
        'sits at delta 978 — 22 characters of headroom. Inserting above it reds a test that ' +
        'names tradePropose, not the menu.',
    ).toBeGreaterThan(tpIdx);
    // (2b) headroom — re-state W-TP-RECONNECT's fixed window HERE, so an over-long insertion
    // fails with the real cause instead of as a mystery tradePropose regression.
    const tpDelta = src.indexOf('tradeProposeView?.hide()', startIdx) - startIdx;
    expect(
      tpDelta,
      `tradeProposeView?.hide() now sits ${tpDelta} chars after 'onReconnect:' — W-TP-RECONNECT ` +
        '(this file, ~:1125) slices a FIXED reconnectIdx+1000 window, so it must stay under ' +
        '1000. uxd3 added lines ABOVE it inside onReconnect: put `menuView?.hide();` below the ' +
        'tradePropose line, with any rationale comment on the SAME line or omitted (plan A8). ' +
        'Re-anchoring W-TP-RECONNECT on two endpoints is deferred to uxd3-b (plan A17).',
    ).toBeLessThan(1000);
  });
});

describe('★ main.ts wiring (uxd3): Escape stays a pure close/back key (AC-9 / AC-17)', () => {
  it('★ W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE BITES: `dialogueView?.hide` / `dialogueView.hide` occur ZERO times in main.ts', () => {
    // AC-9 (spec :146): "WHEN Escape is pressed AND dialogueView is visible, THE handler SHALL
    // send dismissDialogue (never a bare registry hide) so the server player_conversation row is
    // cleared."
    //
    // PLAN A7 — this is the WHOLE-FILE form, deliberately replacing the region-scoped version in
    // plan §6. Strictly stronger, and the strengthening is load-bearing for THIS slice: uxd3 adds
    // new imperative sites (`activateMenuLeaf`'s force-hide loop, the menu preempt, openMenu) and
    // a region-scoped tooth around the Escape branch would not see any of them. A7 also DELETED
    // the `hideById` lookup table that would have introduced main.ts's first-ever
    // `dialogueView?.hide` call site (red-team F4) — this tooth is what keeps that decision
    // enforced rather than merely documented.
    //
    // WRONG IMPL KILLED: the single most likely registry-refactor regression — "unify every
    //   close path through `overlays.hide(id)`" / "give the force-hide plan a hideById table".
    //   A client-side dialogue hide leaves the server `player_conversation` row OPEN: the NPC
    //   stays locked in conversation, `talk` refuses to re-open it, and the only recovery is a
    //   reconnect. That is the ptc5c/ADR-0139 defect, and it is invisible in the client UI.
    // NOTE the two needles are independent — `dialogueView.hide` is NOT a substring of
    //   `dialogueView?.hide` — so both spellings must be counted separately.
    // Comment-stripped first: prose about `dialogueView.hide()` in a rationale comment must
    //   never red this tooth (and, symmetrically, must never satisfy one).
    const stripped = stripLineComments(readMainTs());

    // ANTI-VACUITY / positive control: the counter demonstrably finds `X?.hide` occurrences in
    // THIS file. Without this, a broken read or an over-eager strip would make both zero-counts
    // pass on an empty string. renameView?.hide() lives in onReconnect and is asserted present
    // by W-RECONNECT-HIDES-MENU's sibling control, so this control is itself pinned.
    expect(
      countOccurrences(stripped, 'renameView?.hide'),
      'positive control: `renameView?.hide` must occur at least once in main.ts — it proves the ' +
        'zero-counts below are measuring real, comment-stripped source and not an empty string',
    ).toBeGreaterThan(0);

    expect(
      countOccurrences(stripped, 'dialogueView?.hide'),
      'main.ts must NEVER call dialogueView?.hide() (AC-9 / plan A7). The dialogue closes ONLY ' +
        'by sending dismissDialogue and letting the server delete the player_conversation row; ' +
        'a client-side hide desyncs that row and locks the NPC in conversation until reconnect.',
    ).toBe(0);
    expect(
      countOccurrences(stripped, 'dialogueView.hide'),
      'main.ts must NEVER call dialogueView.hide() either (the non-optional spelling — AC-9 / ' +
        'plan A7). Same desync; both spellings are banned.',
    ).toBe(0);

    // The POSITIVE half of AC-9, on the branch that owns it (existing anchors, both unique).
    const src = readMainTs();
    expectUniqueAnchor(src, UXD2_ESC_DLG_START);
    expectUniqueAnchor(src, UXD2_ESC_DLG_END);
    const branch = stripLineComments(regionOrThrow(src, UXD2_ESC_DLG_START, UXD2_ESC_DLG_END));
    expect(
      branch.includes('dismissDialogue'),
      'the Escape-while-dialogue-visible branch must send dismissDialogue (AC-9) — the zero-count ' +
        'above only proves nothing hides it locally; this proves the correct close path exists',
    ).toBe(true);
  });

  it('★ W-ESCAPE-NEVER-REOPENS-MENU BITES: no Escape branch re-opens the menu (menuView?.show / menuView.show / openMenu()', () => {
    // AC-17 (spec :154): "WHERE an overlay opened via the menu is visible, WHEN Escape THE
    // handler SHALL close it directly to the world in one press AND SHALL NOT re-open the menu."
    //
    // The MODEL half is proved in menuModel.test.ts (MM-ACTIVATE-RESETS-STATE: an `activate`
    // effect always returns MENU_INITIAL, so nothing remembers a pending menu). This is the
    // WIRING half: no Escape branch may re-open it imperatively either.
    //
    // WRONG IMPL KILLED: the classic console-menu instinct — "closing a menu-launched screen
    //   should return you to the menu you launched it from". It is a 3-line change in one Escape
    //   branch, it feels helpful, and it breaks today's muscle memory for every veteran player
    //   (spec: one press to world). It also creates an Escape loop the player cannot exit
    //   without a second, differently-timed press.
    //
    // Region strategy: enumerate EVERY `e.code === 'Escape'` occurrence in the comment-stripped
    // source and slice each to the next one; the final branch is bounded by the keydown
    // handler's `const dir = KEY_DIR[e.code];`. All index arithmetic happens inside the stripped
    // string (never mixing raw and stripped offsets — the nh1 post-mortem rule).
    const stripped = stripLineComments(readMainTs());
    const starts: number[] = [];
    for (let i = stripped.indexOf(UXD3_ESCAPE_SENTINEL); i >= 0; ) {
      starts.push(i);
      i = stripped.indexOf(UXD3_ESCAPE_SENTINEL, i + UXD3_ESCAPE_SENTINEL.length);
    }
    // ANTI-VACUITY: main.ts has carried 14 Escape branches since uxd2 (rename, tradePropose,
    // help, battle, box, raising, evolution, dialogue, questLog, heal, shop, trade, pvp,
    // leaderboard). A zero/one-element list would make the loop below pass without testing
    // anything.
    expect(
      starts.length,
      `found ${starts.length} \`${UXD3_ESCAPE_SENTINEL}\` branches in main.ts — expected at ` +
        'least 14 (anti-vacuity: an empty branch list makes this negative tooth meaningless)',
    ).toBeGreaterThanOrEqual(14);
    const tailEnd = stripped.indexOf(UXD3_SUPPRESS_END, starts[starts.length - 1]);
    expect(
      tailEnd,
      'the LAST Escape branch must be followed by the keydown movement dispatch ' +
        '(`const dir = KEY_DIR[e.code];`) — the end bound for the final region',
    ).toBeGreaterThan(starts[starts.length - 1]);
    // ANTI-VACUITY (region content): the branch stack really is the Escape stack.
    const wholeStack = stripped.slice(starts[0], tailEnd);
    expect(
      wholeStack.includes('dismissDialogue'),
      'the Escape branch stack must contain the dialogue dismiss — proves these regions are the ' +
        'real Escape branches (anti-vacuity)',
    ).toBe(true);

    for (let n = 0; n < starts.length; n += 1) {
      const end = n + 1 < starts.length ? starts[n + 1] : tailEnd;
      const region = stripped.slice(starts[n], end);
      expect(region.length, `Escape branch #${n} must be a non-empty slice`).toBeGreaterThan(0);
      for (const needle of ['menuView?.show', 'menuView.show', 'openMenu(']) {
        expect(
          region.includes(needle),
          `Escape branch #${n} (starting "${region.slice(0, 60).split('\n')[0]}…") must NOT ` +
            `contain ${needle} — AC-17: Escape closes a menu-opened overlay straight to the ` +
            'world in ONE press and never re-opens the menu. Reopening is the console-menu ' +
            'instinct the spec explicitly rejects (plan anti-pattern 4).',
        ).toBe(false);
      }
    }
  });
});

describe('★ main.ts wiring (uxd3): the menu open path and its availability sources (AC-11 / AC-15 / AC-16)', () => {
  it('★ W-OPENMENU-RESETS-STATE BITES: openMenu() resets menuState to MENU_INITIAL', () => {
    // AC-11 (spec :148): KeyM "SHALL open the menu at the TOP-LEVEL CATEGORY LIST".
    // Plan A5 (red-team F3) — a real 30-second repro, not a theoretical one:
    //   press M → Enter (descend into Party) → M (toggle-close) → M
    // and the menu re-opens INSIDE the Party submenu. Four separate paths hide the view without
    // routing through `menuStep`: the KeyM toggle-close arm, refreshBattle's force-hide, the
    // dialogue preempt, and onReconnect. §3's "activate always resets" covers only ONE of them.
    // The fix is to make `openMenu()` the single choke point:
    //   `menuState = MENU_INITIAL; renderMenu(); menuView?.show();`
    //
    // WRONG IMPL KILLED (1): `function openMenu() { renderMenu(); menuView?.show(); }` — no
    //   reset. Every one of the four non-menuStep hide paths leaves stale nav state behind, and
    //   the next open lands wherever the player last was. Nothing else in the suite sees this:
    //   menuModel is pure and correct, and every source-scan tooth about KeyM is satisfied.
    // WRONG IMPL KILLED (2): resetting in the KeyM handler only — that fixes exactly one of the
    //   four paths, and the reset then lives outside the function every future open path calls.
    //
    // Region is ONE function declaration (never a `+N` window, never to-EOF): `MENU_INITIAL`
    // also appears at the module-scope `let menuState: MenuNavState = MENU_INITIAL;`, so a
    // sloppy region would be satisfied by the DECLARATION rather than the reset.
    const body = uxd3FunctionBody(readMainTs(), UXD3_OPENMENU_DECL);
    // ANTI-VACUITY: this is the real openMenu body, and it actually shows the view.
    expect(
      body.includes('menuView'),
      'the openMenu() body must reference menuView (anti-vacuity — proves the slice is the real ' +
        'function body and not a degenerate one-line region)',
    ).toBe(true);
    expect(
      body.includes('MENU_INITIAL'),
      'openMenu() must reset the nav state to MENU_INITIAL before showing (plan A5). Repro it ' +
        'kills: M → Enter → M (toggle-close) → M re-opens INSIDE the submenu instead of at the ' +
        'category list, because refreshBattle / the dialogue preempt / onReconnect / the ' +
        'toggle-close arm all hide the view without going through menuStep. openMenu() is the ' +
        'single choke point: `menuState = MENU_INITIAL; renderMenu(); menuView?.show();`',
    ).toBe(true);
  });

  it('★ W-ACTIVATE-LEAF-IDENTITY-GUARD BITES: activateMenuLeaf early-returns before join (identity !== "")', () => {
    // Plan A12 (reviewer H3 / red-team F7), grounded in ADR-0134 red-team L-1: main.ts:872/:916
    // gate KeyO/KeyT on `identity !== ''` so the client can never `proposeTrade`/`talk` before
    // the join round-trip completes. `activateMenuLeaf` is a SECOND route to those same actions
    // and must carry the same guard.
    //
    // WRONG IMPL KILLED: an `activateMenuLeaf` that trusts the KeyM guard alone. The KeyM guard
    //   protects the OPEN; activation happens later, on Enter, and the menu can outlive a state
    //   change. Concretely: the Interact leaf calls
    //   `nearestInteractable(store.ownCharacter(identity)!.row, …)` — pre-join that non-null
    //   assertion throws inside an uncaught listener; the Offer leaf would send proposeTrade with
    //   an empty Identity. This is the whole reason A12 exists, and it is why the leaf switch is
    //   NOT allowed to be a bare re-dispatch of the hotkey bodies.
    const body = uxd3FunctionBody(readMainTs(), UXD3_ACTIVATE_DECL);
    // ANTI-VACUITY: the real activation adapter — it closes the menu first (AC-15) and dispatches.
    expect(
      body.includes('menuView'),
      'the activateMenuLeaf body must reference menuView (it closes the menu BEFORE opening the ' +
        'target — AC-15). Anti-vacuity: proves this is the real function body.',
    ).toBe(true);
    expect(
      body.includes("identity !== ''"),
      "activateMenuLeaf must guard on `identity !== ''` (plan A12) — leaf activation is a second " +
        'route to talk/proposeTrade and to store.ownCharacter(identity)!, all of which throw or ' +
        'send garbage before the join round-trip completes',
    ).toBe(true);
  });

  it('★ W-MENU-AVAILABILITY-SOURCES BITES: menuAvailability reads existence, not proximity, for PvP/Offer', () => {
    // AC-16 (spec :153): "THE Talk leaf available() SHALL be true iff nearestTalkableNpcId(...)
    // !== undefined; THE Offer/PvP leaves available() SHALL be true iff at least one
    // challengeable/target player row exists, AND SHALL NOT be a proximity check."
    // (uxd2/ADR-0161 retired `nearestTalkableNpcId` in favour of `nearestInteractable` — plan §3.)
    //
    // WRONG IMPL KILLED — the SSOT-copy trap, and it is a genuinely easy mistake: the help
    //   CONTROLS text this menu pulls its key glyphs from says "Challenge a NEARBY player" (P)
    //   and "Offer a trade to a NEARBY player" (O). An implementer reading that copy while
    //   writing `menuAvailability()` implements a distance check — and the PvP/Offer leaves then
    //   render permanently GREYED, because the server's challenge/trade reducers have no
    //   proximity requirement at all and players are essentially never adjacent. The feature
    //   would look "implemented but broken", and the spec calls this reconciliation out
    //   explicitly in its own residual (:173).
    // WRONG IMPL KILLED (2): a hand-rolled interact-range check instead of the shared resolver —
    //   the prompt (W-INTERACT-FRAME) and KeyT (W-INTERACT-KEYT-DISPATCH) both go through
    //   `nearestInteractable(`, so a parallel implementation here would let the menu advertise
    //   an Interact target that KeyT then refuses (or vice versa).
    const body = uxd3FunctionBody(readMainTs(), UXD3_MENUAVAIL_DECL);
    // ANTI-VACUITY: the real builder returns the menuModel MenuAvailability contract.
    expect(
      body.includes('hasPvpTargets'),
      'menuAvailability() must build the MenuAvailability record (hasInteractTarget / ' +
        'hasTradeTargets / hasPvpTargets — menuModel §3). Anti-vacuity: proves the slice is the ' +
        'real builder body.',
    ).toBe(true);
    expect(
      body.includes('nearestInteractable('),
      'menuAvailability() must resolve the Interact leaf through nearestInteractable( — the SAME ' +
        'resolver KeyT and the on-world prompt use (AC-16), so the menu can never advertise a ' +
        'target KeyT refuses',
    ).toBe(true);
    expect(
      body.includes('challengeablePlayers'),
      'menuAvailability() must derive the PvP leaf from challengeablePlayers (the pvpModel VM ' +
        'field) — online-player EXISTENCE, per AC-16',
    ).toBe(true);
    for (const banned of ['Math.abs', 'CLIENT_INTERACT_RANGE']) {
      expect(
        body.includes(banned),
        `menuAvailability() must NOT contain ${banned} — PvP/Offer availability is online-player ` +
          'EXISTENCE, never proximity (AC-16, plan anti-pattern 9). The help SSOT copy says ' +
          '"nearby"; the spec residual (:173) scopes the SSOT pull to the KEY TOKEN only, ' +
          'precisely so that prose cannot leak into this predicate. Interact proximity belongs ' +
          'inside nearestInteractable(), which already owns and unit-tests it.',
      ).toBe(false);
    }
  });
});

describe('★ index.html (uxd3): exactly ONE persistent corner affordance (AC-12)', () => {
  /** Direct-`<body>`-child `<div id=…>` elements of the REAL client/index.html, with their
   *  whitespace-normalised inline style. Real attribute parsing (happy-dom's DOMParser), NOT a
   *  line scan: BOTH target divs spread `id` and `style` across several lines (index.html:93-96
   *  and :101-106), so any line-oriented match would silently miss them — plan A10 / reviewer L5.
   *  There is no CSS file anywhere in this repo; the inline `style` attribute IS the complete
   *  styling contract (indexShell.test.ts's documented premise). */
  async function bodyDivs(): Promise<Array<{ id: string; style: string }>> {
    const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
    let html: string;
    try {
      html = readFileSync(htmlPath, 'utf8');
    } catch (err) {
      // Fail loud — every assertion is vacuous if the file cannot be read.
      throw new Error(`index.html could not be read at expected path: ${htmlPath} — ${err}`);
    }
    const win = new Window();
    try {
      const doc = new win.DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('body > div')].map((el) => ({
        id: el.getAttribute('id') ?? '',
        style: (el.getAttribute('style') ?? '')
          .split(' ')
          .join('')
          .split('\n')
          .join('')
          .split('\t')
          .join(''),
      }));
    } finally {
      await win.happyDOM.close();
    }
  }

  it('★ W-ONE-CORNER-AFFORDANCE BITES: the fixed, non-full-screen body divs are EXACTLY {build-stamp, help-hint}', async () => {
    // AC-12 (spec :149): "at most ONE persistent corner affordance SHALL exist AND a test SHALL
    // fail if a second competing always-on menu/help corner element is added." uxd3-a lands the
    // NEGATIVE half of AC-12 (the click-launcher half belongs to uxd3-b, which owns
    // indexShell.test.ts and will RELABEL #help-hint rather than add a sibling).
    //
    // Today's expected set is `{build-stamp, help-hint}` — two elements, which is already the
    // documented status quo (a build-provenance stamp is not a competing affordance; ux1/ADR-0151
    // deliberately stacked the hint above it). What this tooth pins is that the set does not
    // GROW.
    //
    // FILTER (plan A10, correcting plan §6): `position:fixed` AND NOT `inset:0`. The §6 text said
    // `position:fixed` AND `bottom:` — that filter is BLIND to a launcher at `top:8px;right:8px`,
    // which is exactly the element uxd3-b will add and exactly the element this tooth exists to
    // catch (red-team F10). `inset:0` identifies the full-screen modal shells (#help-overlay
    // today, #menu-overlay after plan edit T2.2) — those are not corner affordances and both are
    // `display:none` by default.
    //
    // WRONG IMPL KILLED (1): shipping `#menu-launcher` as a SECOND always-on corner element
    //   instead of relabelling the existing hint. Two competing badges in the corners of a
    //   viewport-filling canvas is precisely the "always-on rail" the spec rejects (:126), and
    //   it is the natural thing to do because #help-hint is `pointer-events:none` and cannot
    //   host a click without failing indexShell H4.
    // WRONG IMPL KILLED (2): a launcher positioned at the TOP corners — passes the plan's
    //   original `bottom:`-based filter, fails this one.
    // WRONG IMPL KILLED (3): deleting/renaming #help-hint while adding a launcher (the set would
    //   still have size 2 but different membership) — the exact-set comparison catches it, and
    //   ux1-1's hint is a shipped acceptance criterion that uxd3 may not silently retire.
    const divs = await bodyDivs();

    // ANTI-VACUITY #1 (the parser works): index.html has carried 13 direct-body divs since ux1
    // (app + 10 overlay shells + build-stamp + help-hint); uxd3 adds #menu-overlay → 14. A
    // broken parse yields [] and every set assertion below would pass vacuously — the documented
    // vacuity trap of this file.
    expect(
      divs.length,
      `parsed ${divs.length} direct <body> > div children from index.html — expected at least ` +
        '12. A near-empty parse makes every assertion below vacuous (parser/path failure, not a ' +
        'markup regression).',
    ).toBeGreaterThanOrEqual(12);

    const corner = divs
      .filter((d) => d.style.includes('position:fixed') && !d.style.includes('inset:0'))
      .map((d) => d.id)
      .sort();

    // ANTI-VACUITY #2 (the FILTER works, not just the parser): the two known corner elements are
    // fixed-and-not-inset today, so an empty/singleton result means the style filter broke.
    expect(
      corner.length,
      `the position:fixed / NOT inset:0 filter matched ${corner.length} element(s) ` +
        `(${JSON.stringify(corner)}) — expected at least 2 (#build-stamp and #help-hint). ` +
        'Fewer means the filter or the style normalisation broke, not that markup regressed.',
    ).toBeGreaterThanOrEqual(2);

    expect(
      corner,
      'exactly ONE persistent corner affordance may exist alongside the build stamp (AC-12). ' +
        `Found: ${JSON.stringify(corner)}. If this failed because #menu-launcher was added: ` +
        'do not add a second badge — uxd3-a ships KeyM as the self-owned, zero-DOM front door ' +
        '(spec :148), and uxd3-b OWNS indexShell.test.ts and will RELABEL #help-hint into the ' +
        'launcher (flipping pointer-events there is what makes it clickable, and that edit fails ' +
        'indexShell H4 today). Plan A9 already updated the hint TEXT to advertise M — a ' +
        'text-node-only change that keeps every indexShell tooth green.',
    ).toEqual(['build-stamp', 'help-hint']);
  });
});

describe('★ main.ts wiring (uxd3): anchor discipline — new code must not re-anchor the fixed-window teeth', () => {
  // These two teeth have no EARS criterion of their own. They exist because uxd3 inserts code
  // ABOVE several pre-existing first-`indexOf` anchors, and the failure mode is not a red test —
  // it is a test that stays GREEN while measuring the wrong region FOREVER. Re-anchoring those
  // teeth properly is deferred to uxd3-b (plan A17); until then, these guard the anchors.

  it('★ W-UXD3-ESCAPE-ANCHOR-FIRST BITES: the FIRST `e.code === Escape` in main.ts is still the rename branch', () => {
    // HAZARD H3 (plan A16, correcting anti-pattern 15's rationale — red-team F8). Three teeth
    // locate their region as `src.indexOf("e.code === 'Escape'") + a fixed window`:
    //   W-RN-ESCAPE (+2000), W-TP-ESCAPE (+2500), W-HELP-ESCAPE (+2500).
    // The new menu-nav intercept (plan edit 6) sits ~12.5k characters EARLIER in the file, just
    // after the F8 branch and before KeyB. If it spells the literal `e.code === 'Escape'` — or
    // if a comment near it does — all three re-anchor onto the KeyB/I/E guard lists, which
    // happen to mention renameView / tradeProposeView / helpView, so all three keep PASSING.
    // They would no longer test Escape at all, and nothing would say so.
    //
    // WRONG IMPL KILLED: `if (menuView?.visible) { if (e.code === 'Escape') { … } … }` in the
    //   nav intercept. The correct shape routes Escape through the pure mapper —
    //   `const i = menuKeyInput(e.code, e.key); if (i !== undefined) { handleMenuInput(i);
    //   e.preventDefault(); return; }` — which needs no Escape literal at all.
    // RAW source deliberately (not comment-stripped): the three victim teeth read RAW source, so
    // an Escape literal inside a COMMENT breaks them just as thoroughly.
    const src = readMainTs();
    const firstEscape = src.indexOf(UXD3_ESCAPE_SENTINEL);
    expect(
      firstEscape,
      "main.ts must contain an Escape handler (`e.code === 'Escape'`)",
    ).toBeGreaterThanOrEqual(0);
    const renameEscape = src.indexOf("e.code === 'Escape' && renameView?.visible");
    expect(
      renameEscape,
      "main.ts must contain the rename Escape branch (`e.code === 'Escape' && " +
        'renameView?.visible`) — the highest-priority Escape branch and the de-facto anchor of ' +
        'W-RN-ESCAPE / W-TP-ESCAPE / W-HELP-ESCAPE',
    ).toBeGreaterThanOrEqual(0);
    expect(
      firstEscape,
      `the FIRST occurrence of \`${UXD3_ESCAPE_SENTINEL}\` in main.ts is at offset ` +
        `${firstEscape}, but the rename Escape branch is at ${renameEscape} — something now ` +
        'writes that literal EARLIER in the file (the uxd3 menu-nav intercept, most likely). ' +
        'W-RN-ESCAPE (+2000), W-TP-ESCAPE (+2500) and W-HELP-ESCAPE (+2500) all slice a fixed ' +
        'window from that first occurrence: they would silently re-anchor onto the KeyB/I/E ' +
        'guard lists and stay FALSELY GREEN forever. Route Escape through menuKeyInput(e.code, ' +
        'e.key) instead of writing the literal (plan edit 6 / anti-pattern 15).',
    ).toBe(renameEscape);
  });

  it('★ W-UXD3-HOTKEY-ANCHORS-AFTER-KEYDOWN BITES: no quoted hotkey anchor appears before the keydown listener', () => {
    // HAZARD H4 (plan A16, anti-pattern 14b). uxd3's new helper block (plan edit 4) lands at
    // ~main.ts:262 — BEFORE `window.addEventListener('keydown'` at :600, and therefore before the
    // first-`indexOf` anchor of every hotkey tooth in this file. `menuAvailability`, `renderMenu`,
    // `handleMenuInput`, `activateMenuLeaf` and `openMenu` are exactly the functions most likely
    // to name a hotkey in a comment ("mirrors the KeyO handler") or in code (a leaf → key map
    // written with quoted `e.code` strings).
    //
    // WRONG IMPL KILLED: a leaf table or rationale comment in the helper block containing
    //   `'KeyN'` / `"e.code === 'KeyO'"` / `"e.key === '?'"` / `"e.code === 'KeyM'"`. Victims:
    //   W-RN-KEYN / W-RN-PREVENT (+600) / W-RN-HELD (+720) / W-TP-FANOUT-KEYN-GUARD (+800) all
    //   slice forward from the first `'KeyN'`; W-OVERLAY-FANOUT-MUTEX slices every handler block
    //   from its first anchor; W-KEYM-HANDLER's own uniqueness check covers KeyM. All would
    //   measure the helper block instead of the handler — some going red for an unrelated
    //   reason, others staying green on the wrong region.
    //   The leaf → key-glyph mapping belongs in menuModel's MENU_TREE (`keyGlyph: 'N'`, a bare
    //   glyph, pinned to the help SSOT by MM-KEYGLYPH-FROM-HELP-SSOT), never as an `e.code`
    //   literal in main.ts.
    // RAW source: a comment occurrence is just as damaging as a code occurrence.
    const src = readMainTs();
    const listenerIdx = src.indexOf("window.addEventListener('keydown'");
    expect(
      listenerIdx,
      "main.ts must register the keydown listener (`window.addEventListener('keydown'`) — the " +
        'boundary this tooth measures against',
    ).toBeGreaterThanOrEqual(0);
    for (const anchor of ["'KeyN'", "e.code === 'KeyO'", "e.key === '?'", UXD3_KEYM_ANCHOR]) {
      const idx = src.indexOf(anchor);
      // ANTI-VACUITY: each anchor must actually exist, or "no occurrence before the listener"
      // would be satisfied by an anchor that exists nowhere at all.
      expect(
        idx,
        `main.ts must contain the hotkey anchor ${anchor} (anti-vacuity: a missing anchor would ` +
          'make the ordering assertion below vacuously true)',
      ).toBeGreaterThanOrEqual(0);
      expect(
        idx,
        `the FIRST occurrence of ${anchor} must come AFTER window.addEventListener('keydown' ` +
          `(offset ${listenerIdx}), but it is at ${idx}. uxd3's new helper block sits above the ` +
          'listener, and every hotkey tooth in this file slices forward from a FIRST indexOf — ' +
          'a quoted hotkey literal up there (in code OR in a comment) re-anchors those teeth ' +
          'onto the helper block (plan anti-pattern 14/14b). Describe keys in prose, and keep ' +
          'leaf key glyphs in menuModel MENU_TREE as bare glyphs.',
      ).toBeGreaterThan(listenerIdx);
    }
  });
});

// ===========================================================================
// uxd3-b (ADR-0163) — the ONE probe table, the five fan-out surfaces that read through it,
// and the AC-12 click front door.
//
// ⚠ client/src/main.ts is COVERAGE-EXCLUDED (client/vite.config.ts:97). These source-scan
// teeth are therefore the ONLY executable guard on the probe table and on the launcher
// branch — there is no unit test that can ever observe them running.
// ===========================================================================

/** Marker-comment bounds of the probe table (adjudication §B3 E2). The markers are the
 *  contract: they are what lets a region-bounded scan pin the table's SHAPE without
 *  importing main.ts (which has DOM/wasm side effects and cannot be imported in vitest). */
const UXD3B_PROBES_BEGIN = '// UXD3B-PROBES-BEGIN';
const UXD3B_PROBES_END = '// UXD3B-PROBES-END';

/** Marker-comment bounds of the AC-12 click front door (adjudication §B3 E8). */
const UXD3B_LAUNCHER_BEGIN = '// UXD3B-LAUNCHER-BEGIN';
const UXD3B_LAUNCHER_END = '// UXD3B-LAUNCHER-END';

/** uxd3-c (ADR-0164) marker-comment bounds — the canOpen() gate binder (plan E4). */
const UXD3C_CANOPEN_BEGIN = '// UXD3C-CANOPEN-BEGIN';
const UXD3C_CANOPEN_END = '// UXD3C-CANOPEN-END';

/** uxd3-c (ADR-0164) marker-comment bounds — the force-hide handle table (plan E3). */
const UXD3C_HANDLES_BEGIN = '// UXD3C-HANDLES-BEGIN';
const UXD3C_HANDLES_END = '// UXD3C-HANDLES-END';

/** uxd3-c (ADR-0164) marker-comment bounds — refreshBattle's collapsed force-hide loop (E17). */
const UXD3C_BATTLEHIDE_BEGIN = '// UXD3C-BATTLEHIDE-BEGIN';
const UXD3C_BATTLEHIDE_END = '// UXD3C-BATTLEHIDE-END';

describe('★ main.ts wiring (uxd3-b/ADR-0163): all five fan-out surfaces route through ONE probe table (AC-7)', () => {
  it('★ W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY-ROUTES BITES: each of the 5 surfaces carries the EXACT registry call shape', () => {
    // AC-7 (spec :144) mechanism half. Replaces the five uxd3-a anti-collapse teeth
    // (W-MENU-FANOUT-ANYOVERLAY/-KEYDOWN/-RECONCILE/-RAF/-PVP) and the sixteen legacy
    // per-overlay fan-out floors, which the orchestrator retires AFTER this goes green.
    //
    // RED AT AUTHORING TIME: all five surfaces still hold hand-written OR-lists
    // (main.ts:246-260, :699-715, :1313-1329, :1609-1623, :2492-2508). The tokens
    // `anyVisible(` and `overlayProbes` appear ZERO times in main.ts, so all five shape
    // assertions below fail. Surfaces 1 and 4 fail on a missing call; 2, 3 and 5 fail
    // because their guard is a 15-term `!(a || b || …)` and not the collapsed form.
    //
    // WHY EXACT CONTIGUOUS SHAPES AND NOT TOKEN PRESENCE (red-team F1 — the reason this
    // tooth is not five `.includes('anyOverlayVisible')` checks):
    // WRONG IMPL KILLED (1): a ONE-CHARACTER inversion.
    //   `if (!anyOverlayVisible()) { suppressNativeMovementDefault(e); return; }` contains
    //   every token a presence check looks for, and kills ALL movement in the game — the
    //   suppression block would fire whenever NO overlay is open. Identically for surfaces
    //   2/5: dropping the `!` from `!anyOverlayVisible()` re-issues held movement ONLY while
    //   an overlay is up, i.e. exactly the walking-under-the-menu bug inverted.
    // WRONG IMPL KILLED (2): the result DISCARDED — `anyOverlayVisible();` as a bare
    //   statement (or `void anyOverlayVisible();`) beside an untouched OR-list, or beside no
    //   guard at all. A presence-only tooth is green; the surface does nothing.
    // WRONG IMPL KILLED (3): a PARTIAL collapse — four surfaces routed, one left hand-rolled.
    //   Each surface is asserted separately with its own message, so a half-migration names
    //   the surface that was missed instead of failing once, ambiguously.
    // WRONG IMPL KILLED (4): surface 4 collapsed WITHOUT the exempt argument, or exempting
    //   the wrong id — `anyVisible(overlayProbes)` there makes a manually-opened pvpView veto
    //   its own refresh, so an incoming challenge silently stops updating the open overlay.
    //   No pre-existing tooth checks that the exempt id is `pvpView`.
    // WRONG IMPL KILLED (5): the nh1/ADR-0146 regression — a "tidy" of surface 3 that drops
    //   `suppressNativeMovementDefault(e);` or moves it after the `return;`. That silently
    //   reverts the playtest-BLOCKING movement bug (arrow keys and Space fall through to the
    //   browser's native page-scroll / button-activate the moment any overlay opens). The nh1
    //   half below is copied CHARACTER-FOR-CHARACTER from W-MENU-FANOUT-KEYDOWN (:4661-4679),
    //   which this tooth replaces — it is the highest-risk carry-over in the slice.
    // WRONG IMPL KILLED (6): a surface-3 region widened past the keydown block into the
    //   keyup handler, where any needle can be satisfied by unrelated code.
    //
    // NO per-region "zero residue" clause is needed: every needle below requires the `)` of
    // the call to be IMMEDIATELY followed by ` {` or `;`, so an appended `|| x?.visible` term
    // cannot survive. The whole-file ceiling is Part C.
    const src = readMainTs();

    // ---- SURFACE 1: the shared anyOverlayVisible() predicate (E3) --------------------
    // ANTI-VACUITY: both function-declaration anchors unique — the `characterTileMap` bound
    // is what stops the region running to end-of-file and swallowing unrelated code.
    expectUniqueAnchor(src, UXD3_ANYOVERLAY_START);
    expectUniqueAnchor(src, UXD3_ANYOVERLAY_END);
    const s1 = squashWhitespace(bodyRegion(src, UXD3_ANYOVERLAY_START, UXD3_ANYOVERLAY_END));
    expect(
      s1.trim().length,
      'ANTI-VACUITY (surface 1): the anyOverlayVisible() body region is empty after ' +
        'comment-stripping — the region collapsed and any needle would fail for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      s1.trim(),
      'surface 1 (anyOverlayVisible(), E3) must be EXACTLY `return anyVisible(overlayProbes);` ' +
        'and nothing else (keep the FUNCTION NAME and its JSDoc — W-INTERACT-DEFERRED-OPEN and ' +
        'three region scans anchor on the literal `anyOverlayVisible`, anti-pattern 18). ' +
        'EXACT EQUALITY, not containment (red-team F1, measured GREEN under a ' +
        "containment check): a prefixed early-out such as `if (identity !== '') return false;` " +
        'leaves the pinned return in place while making this predicate — the SSOT for FOUR of ' +
        'the five surfaces PLUS the deferred shop-open gate PLUS the AC-12 launcher PLUS the ' +
        'frame-loop prompt — return a constant. That single mutation removes mutual exclusion ' +
        'everywhere at once, or kills all movement. ' +
        'It also rejects `return !anyVisible(overlayProbes);` and a stray appended `|| x?.visible`. ' +
        "NOTE the trailing `}` is the function's own closing brace: bodyRegion drops the " +
        '`function anyOverlayVisible(` line and runs to the next declaration, so the whole ' +
        'squashed body is exactly `return anyVisible(overlayProbes); }`. Region=' +
        JSON.stringify(s1),
    ).toBe('return anyVisible(overlayProbes); }');

    // ---- SURFACE 2: the reconcile divergence re-issue (E4) ---------------------------
    expectUniqueAnchor(src, NH2_RECONCILE_START);
    expectUniqueAnchor(src, NH2_RECONCILE_END);
    const s2 = squashWhitespace(bodyRegion(src, NH2_RECONCILE_START, NH2_RECONCILE_END));
    expect(
      s2.includes('reissueDir('),
      'ANTI-VACUITY (surface 2): the reconcile region must still contain `reissueDir(` — its ' +
        'own identity marker. Without it the region is mis-anchored and every needle is vacuous.',
    ).toBe(true);
    expect(
      s2.includes('predictor.outstandingSteps === 0 && !anyOverlayVisible()) {'),
      'surface 2 (reconcile divergence emitter, E4) must gate on the CONTIGUOUS ' +
        '`predictor.outstandingSteps === 0 && !anyOverlayVisible()`. The leading conjunct is ' +
        "W-NH2-GATE-WIRED's `opensWith` anchor and must stay FIRST (nh2/ADR-0148); the `!` is " +
        'load-bearing — dropping it re-issues held movement ONLY while an overlay is up, i.e. ' +
        'the character walks under the open overlay on every server pullback. The needle is ' +
        'CLOSE-PAREN BOUNDED (red-team F4, measured GREEN without it): an appended conjunct such ' +
        "as `&& identity === ''` is false for the whole post-join session, silently killing the " +
        'ADR-0085/nh2 repair path while an unbounded needle stayed green. Region=' +
        JSON.stringify(s2),
    ).toBe(true);

    // ---- SURFACE 3: the keydown movement-suppression block (E6) ----------------------
    // ⚠ The END anchor `const dir = KEY_DIR[e.code];` LEGITIMATELY occurs TWICE in main.ts
    // (the keydown handler we want, and the keyup handler ~15 lines later — documented at
    // :1974-1981). So `expectUniqueAnchor` must NOT be applied to it: it would red on correct
    // source. `regionOrThrow` searches END forward FROM START, so it resolves to the nearer,
    // correct occurrence — and W-NH1-SUPPRESS's control (the region must not contain
    // `addEventListener('keyup'`) is carried verbatim below to prove that resolution held.
    expectUniqueAnchor(src, UXD3_SUPPRESS_START);
    const s3raw = regionOrThrow(src, UXD3_SUPPRESS_START, UXD3_SUPPRESS_END);
    expect(
      s3raw.includes("addEventListener('keyup'"),
      'ANTI-VACUITY (surface 3): the suppression region must not have widened past the keydown ' +
        'block into the keyup handler — a widened region can satisfy any needle ' +
        "(W-NH1-SUPPRESS's control, carried verbatim)",
    ).toBe(false);
    const s3body = bodyRegion(src, UXD3_SUPPRESS_START, UXD3_SUPPRESS_END);
    const s3 = squashWhitespace(s3body);
    expect(
      s3body.includes('suppressNativeMovementDefault(e);'),
      'ANTI-VACUITY (surface 3): the region must still contain suppressNativeMovementDefault(e); ' +
        '— its own identity marker (nh1/ADR-0146)',
    ).toBe(true);
    expect(
      s3.includes('if (anyOverlayVisible()) { suppressNativeMovementDefault(e); return; }'),
      'surface 3 (keydown movement suppression, E6) must be exactly ' +
        '`if (anyOverlayVisible()) { suppressNativeMovementDefault(e); return; }`. ⚠ Do NOT ' +
        'reword the START comment `// Suppress movement input while an overlay is open.` — ' +
        'W-NH1-SUPPRESS anchors on it (anti-pattern 16). The contiguous shape is the ONLY thing ' +
        'standing between the correct code and `if (!anyOverlayVisible()) {…}`, a one-character ' +
        'mutation that passes every presence check and kills ALL movement in the game. Region=' +
        JSON.stringify(s3),
    ).toBe(true);
    // nh1 / ADR-0146 preservation — copied CHARACTER-FOR-CHARACTER from the retiring
    // W-MENU-FANOUT-KEYDOWN (:4661-4679). Losing this pair silently reverts the
    // playtest-blocking movement bug, which is why it is asserted independently of the
    // contiguous shape above (the shape could be reformatted; these two facts cannot move).
    const callIdx = s3body.indexOf('suppressNativeMovementDefault(e);');
    expect(
      callIdx,
      'the suppression block must STILL call suppressNativeMovementDefault(e); (nh1/ADR-0146, ' +
        'AC-7). uxd3-b collapses this block to a single registry call and touches nothing else ' +
        'in it — if this is RED, the block was restructured and arrow keys are hijacked by the ' +
        'browser again.',
    ).toBeGreaterThanOrEqual(0);
    const returnIdx = s3body.indexOf('return;');
    expect(
      returnIdx,
      'the suppression block must STILL early-`return;` after suppressing (nh1/ADR-0146)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      callIdx,
      'suppressNativeMovementDefault(e); must come BEFORE the `return;` — a call placed after it ' +
        'is dead code that satisfies a substring check while suppressing nothing (nh1 ' +
        'post-mortem, W-NH1-SUPPRESS secondary target)',
    ).toBeLessThan(returnIdx);

    // ---- SURFACE 4: the pvp auto-show aggregate (E7) ---------------------------------
    // ⚠ regionOrThrow, NOT bodyRegion. bodyRegion drops the region's FIRST LINE by design
    // (:2337, `raw.slice(nl + 1)`) because its START anchors are usually comments — but this
    // START anchor is CODE, and after the collapse the first line IS the entire surface. Using
    // bodyRegion here would return whitespace (or throw on a single-line region), i.e. a
    // vacuously green surface. stripLineComments is therefore applied explicitly instead.
    expectUniqueAnchor(src, UXD3_PVPAGG_START);
    expectUniqueAnchor(src, UXD3_PVPAGG_END);
    const s4 = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3_PVPAGG_START, UXD3_PVPAGG_END)),
    );
    expect(
      s4.trim().length,
      'ANTI-VACUITY (surface 4): the pvp aggregate region is empty after comment-stripping — ' +
        'if this fires, bodyRegion was used instead of regionOrThrow and the first line (the ' +
        'whole surface) was dropped',
    ).toBeGreaterThan(0);
    expect(
      s4.includes("const anyOverlayVisible = anyVisible(overlayProbes, 'pvpView');"),
      'surface 4 (pvp auto-show aggregate, E7) must be exactly ' +
        "`const anyOverlayVisible = anyVisible(overlayProbes, 'pvpView');`. The `const " +
        'anyOverlayVisible =` literal must stay verbatim (anti-pattern 18 — it is this ' +
        "region's START anchor). The exempt argument must be 'pvpView': without it a " +
        'manually-opened PvP overlay vetoes its own refresh and an incoming challenge stops ' +
        'updating it; with the wrong id a server-pushed challenge pops the PvP overlay over a ' +
        'live battle. Region=' +
        JSON.stringify(s4),
    ).toBe(true);

    // ---- SURFACE 5: the rAF held-key re-issue (E9) -----------------------------------
    expectUniqueAnchor(src, NH2_RAF_START);
    expectUniqueAnchor(src, NH2_RAF_END);
    const s5 = squashWhitespace(bodyRegion(src, NH2_RAF_START, NH2_RAF_END));
    expect(
      s5.includes('reissueDir('),
      'ANTI-VACUITY (surface 5): the rAF re-issue region must still contain `reissueDir(` — its ' +
        'own identity marker',
    ).toBe(true);
    expect(
      s5.includes('if (predictor.outstandingSteps === 0 && !anyOverlayVisible())'),
      'surface 5 (rAF held-key re-issue, E9) must gate on the CONTIGUOUS ' +
        '`if (predictor.outstandingSteps === 0 && !anyOverlayVisible())`. ⚠ Do NOT touch the ' +
        '`// Re-issue the held dir` comment (NH2_RAF_START) or `const ownEntityId =` ' +
        "(NH2_RAF_END). The leading conjunct is W-NH2-GATE-WIRED's `opensWith` anchor. Without " +
        'the `!`, a key held down when an overlay opens keeps re-issuing a Step EVERY FRAME — ' +
        'the "I opened the menu while walking and my character kept walking" bug. Region=' +
        JSON.stringify(s5),
    ).toBe(true);

    // ---- SURFACE 6 (uxd3-c, E4): the canOpen() gate binder ---------------------------
    // Required by this test's OWN "raise the ceiling only together with a new Part A surface"
    // rule (Part B, below): E4 is the FIRST new `visibleIds(overlayProbes)` call site added by
    // uxd3-c, so the whole-file `overlayProbes` ceiling raise (3 -> 5, Part B) needs this surface.
    expectUniqueAnchor(src, UXD3C_CANOPEN_BEGIN);
    expectUniqueAnchor(src, UXD3C_CANOPEN_END);
    const s6 = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3C_CANOPEN_BEGIN, UXD3C_CANOPEN_END)),
    ).trim();
    expect(
      s6.length,
      'ANTI-VACUITY (surface 6): the canOpen() gate-binder region is empty after comment-' +
        'stripping — the region collapsed and the equality below would fail for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      s6,
      'surface 6 (the canOpen() gate binder, uxd3-c E4) must be EXACTLY ' +
        '`function overlayVerdict(id: OverlayId): CanOpenVerdict { return canOpen(id, ' +
        "visibleIds(overlayProbes)); }` — EXACT EQUALITY, per surface 1's precedent (adjudication " +
        "B1): a prefixed `if (...) return { kind: 'allow', forceHide: [] };` would disable all " +
        'eleven canOpen-routed gates while leaving the pinned `return canOpen(...)` in place, ' +
        'satisfying any containment check. Region=' +
        JSON.stringify(s6),
    ).toBe(
      'function overlayVerdict(id: OverlayId): CanOpenVerdict { return canOpen(id, visibleIds(overlayProbes)); }',
    );

    // ---- SURFACE 7 (uxd3-c, E17): refreshBattle's collapsed force-hide loop ----------
    // Required by the SAME "new surface per ceiling raise" rule: E17 is the SECOND new
    // `visibleIds(overlayProbes)` call site.
    expectUniqueAnchor(src, UXD3C_BATTLEHIDE_BEGIN);
    expectUniqueAnchor(src, UXD3C_BATTLEHIDE_END);
    const s7 = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3C_BATTLEHIDE_BEGIN, UXD3C_BATTLEHIDE_END)),
    ).trim();
    expect(
      s7.length,
      'ANTI-VACUITY (surface 7): the battle force-hide loop region is empty after comment-' +
        'stripping',
    ).toBeGreaterThan(0);
    expect(
      s7,
      "surface 7 (refreshBattle's force-hide loop, uxd3-c E17) must be EXACTLY " +
        "`for (const id of hideAllExceptPlan('battleView', visibleIds(overlayProbes))) { " +
        'overlayHandles[id]?.(); }` — EXACT EQUALITY (adjudication B3): a containment check was ' +
        'MEASURED to pass on a region with a nonsensical `if (menuView?.visible) { ' +
        'menuView.show(); }` appended inside the same markers. Region=' +
        JSON.stringify(s7),
    ).toBe(
      "for (const id of hideAllExceptPlan('battleView', visibleIds(overlayProbes))) { overlayHandles[id]?.(); }",
    );
  });

  it('★ W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY-PROBE-TABLE BITES: one byte-identical probe per OVERLAY_IDS member, and nothing else', () => {
    // THE tooth this slice cannot ship without. `client/src/main.ts` is COVERAGE-EXCLUDED
    // (client/vite.config.ts:97), so no unit test can ever observe the probe table executing.
    // This scan is the ONLY guard on it, and the table now feeds ALL FIVE fan-out surfaces —
    // one wrong entry corrupts every one of them at once while every other tooth stays green.
    //
    // RED AT AUTHORING TIME: this test THROWS. `// UXD3B-PROBES-BEGIN` does not exist in
    // main.ts yet, so `regionOrThrow` raises `main.ts must contain "// UXD3B-PROBES-BEGIN"`
    // before any assertion runs. That is a HARD red, never a vacuous pass — the whole reason
    // the region helper throws instead of returning an empty slice.
    //
    // WRONG IMPL KILLED (1) — the one that costs the most: `?? true` instead of `?? false`
    //   on any single entry. Every probe would read TRUE before its view is constructed, so at
    //   boot: ALL movement suppressed, the reconcile AND rAF re-issues both dead, the PvP
    //   auto-show dead, and the AC-12 launcher a permanently dead button. The exact-literal
    //   assertion catches it; a "the key equals the identifier read" parser does not.
    // WRONG IMPL KILLED (2): a COPY-PASTE probe — `raisingView: () => boxView?.visible ?? false`.
    //   It type-checks perfectly, and the box and raising overlays become indistinguishable to
    //   mutual exclusion. Only a `${id}: () => ${id}?.visible` literal sees it.
    // WRONG IMPL KILLED (3): a NEGATED or reshaped probe — `!x?.visible`, `x?.visible === false`,
    //   `x !== undefined` (true forever once the view is built), `x?.visible ?? false === true`
    //   and every other precedence trap, all in one assertion.
    // WRONG IMPL KILLED (4): a SPREAD base — `{ ...BASE_PROBES, menuView: () => false }` would
    //   show fifteen correct-looking literals in this region and still ship a poisoned table,
    //   because the spread's contents live outside the markers. Hence the no-`...` clause.
    // WRONG IMPL KILLED (5): a 16th smuggled entry (an id not in the manifest, or a duplicate)
    //   — the `?.visible ?? false` count must equal OVERLAY_IDS.length exactly.
    // WRONG IMPL KILLED (6): a SHADOW table — a second `const overlayProbes` later in the file
    //   that some surfaces close over instead. The whole-file count clause kills it.
    // WRONG IMPL KILLED (7): a 16th overlay added to the manifest with no probe entry. The
    //   manifest is a STATIC import, so this loop grows automatically and reds — that is what
    //   "bidirectional" buys, and it is why the loop domain is OVERLAY_IDS and not a literal.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD3B_PROBES_BEGIN);
    expectUniqueAnchor(src, UXD3B_PROBES_END);
    // Comment-stripped so the rationale comment INSIDE the markers (which necessarily quotes
    // the entry template) can never satisfy a needle; squashed so biome re-wrapping cannot.
    const region = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3B_PROBES_BEGIN, UXD3B_PROBES_END)),
    );

    // ANTI-VACUITY, ASSERTED FIRST: a real, non-degenerate region over the real 15-id manifest.
    expect(
      OVERLAY_IDS.length,
      'the imported manifest must hold 15 overlays (anti-vacuity: a shrunken manifest would ' +
        'make the per-id loop below trivially satisfiable by an under-wired table)',
    ).toBe(15);
    expect(
      region.includes('overlayProbes'),
      'ANTI-VACUITY: the marked region must actually contain the `overlayProbes` declaration — ' +
        'an empty marker pair (or markers wrapped around the wrong code) would satisfy every ' +
        'deny-list clause below vacuously',
    ).toBe(true);

    for (const id of OVERLAY_IDS) {
      const needle = `${id}: () => ${id}?.visible ?? false`;
      expect(
        region.includes(needle),
        `the probe table must contain the EXACT entry \`${needle},\` — byte-identical to the ` +
          'template, in OVERLAY_IDS declaration order. main.ts is coverage-excluded, so this ' +
          'literal is the only thing distinguishing a correct probe from `?? true` (every ' +
          'overlay reads visible before its view exists ⇒ movement dead, both re-issue paths ' +
          'dead, PvP auto-show dead, the AC-12 launcher a dead button), from a copy-pasted ' +
          'sibling identifier, and from a negated read. Region=' +
          JSON.stringify(region),
      ).toBe(true);
    }

    expect(
      countOccurrences(region, '?.visible ?? false'),
      'the probe table must hold EXACTLY one `?.visible ?? false` per manifest id ' +
        `(${OVERLAY_IDS.length}). A higher count means a 16th entry was smuggled in for an id ` +
        'that is not a registry member (it would be invisible to canOpen and to every manifest ' +
        'tooth); a lower count means the region no longer covers the whole table.',
    ).toBe(OVERLAY_IDS.length);

    expect(
      region.includes('...'),
      'the probe table must be a FLAT object literal with no `...` spread. ' +
        '`{ ...BASE_PROBES, menuView: () => false }` would show fifteen correct literals inside ' +
        'these markers and still ship a poisoned table, because the spread source lives outside ' +
        'the region this tooth can see.',
    ).toBe(false);

    expect(
      countOccurrences(stripLineComments(src), 'const overlayProbes'),
      'main.ts must declare `const overlayProbes` EXACTLY once (whole file, comment-stripped). ' +
        'A second, shadowing table that some fan-out surfaces close over instead would leave ' +
        'this region green while half the surfaces read a different, unguarded set of probes.',
    ).toBe(1);

    // --- F2: the probes must be consumed by the REAL module, not a local decoy ---------
    // Red-team F2, MEASURED GREEN before this clause: replacing the value import with a
    // type-only one and declaring `function anyVisible(_p, _e) { return false; }` locally left
    // every source-scan needle satisfied (`return anyVisible(overlayProbes);` and
    // `anyVisible(overlayProbes, 'pvpView')` still read verbatim) and both OR-ANYVISIBLE-* teeth
    // green — because they test the MODULE, which production code no longer references. All five
    // surfaces plus the launcher went dead. Same defect class as W-CARE-IMPORT (:3228), which
    // exists in this file for exactly this reason; the pattern simply had not been applied here.
    // uxd3-c (ADR-0164, adjudication Part B / E1): squashWhitespace is now applied ALONGSIDE
    // stripLineComments (the original single-line-only check did not need it). The import list
    // grows to cover the write substrate and is likely to wrap across multiple lines under this
    // repo's line-length rule, exactly as the pre-existing battleModel/menuModel imports already
    // do — a raw-single-line needle would false-red a correctly-wrapped import.
    const stripped = squashWhitespace(stripLineComments(src));
    const UXD3C_OVERLAYREGISTRY_IMPORT =
      "import { anyVisible, canOpen, type CanOpenVerdict, hideAllExceptPlan, type OverlayHandles, type OverlayId, type OverlayProbes, visibleIds } from './ui/overlayRegistry';";
    expect(
      countOccurrences(stripped, UXD3C_OVERLAYREGISTRY_IMPORT),
      'main.ts must import `anyVisible`, `canOpen`, `hideAllExceptPlan` and `visibleIds` AS ' +
        'VALUES from ./ui/overlayRegistry (plus the three types) — the module the OR-* teeth ' +
        'actually exercise. A type-only import plus a locally-defined decoy satisfies every ' +
        'source-scan needle in this file and silently disconnects every fan-out surface, every ' +
        'hotkey open-guard and the force-hide handle table from the tested implementation.',
    ).toBe(1);
    expect(
      countOccurrences(stripped, 'function anyVisible'),
      'main.ts must NOT declare its own `anyVisible` — the name must resolve to the imported ' +
        'registry function. A local declaration shadows the import and is invisible to every ' +
        'other tooth here (red-team F2).',
    ).toBe(0);
    // uxd3-c: the SAME W-CARE-IMPORT decoy defect (:3241) now applies to TWO further imported
    // values — `visibleIds` and `canOpen` — since both now feed production call sites
    // (`overlayVerdict()` and refreshBattle's force-hide loop). A locally-redefined decoy for
    // either would satisfy every source-scan needle that merely checks for the NAME.
    expect(
      countOccurrences(stripped, 'function visibleIds'),
      'main.ts must NOT declare its own `visibleIds` — it must resolve to the imported registry ' +
        'function (W-CARE-IMPORT pattern, applied to a second value)',
    ).toBe(0);
    expect(
      countOccurrences(stripped, 'function canOpen'),
      'main.ts must NOT declare its own `canOpen` — it must resolve to the imported registry ' +
        'function (W-CARE-IMPORT pattern, applied to a third value)',
    ).toBe(0);

    // --- F3: the table must be READ, not mutated, and read only where we pinned it -----
    // Red-team F3, MEASURED GREEN before this clause: `Reflect.set(overlayProbes, 'battleView',
    // () => false)` one line AFTER the END marker poisoned the live object — `Readonly<Record<>>`
    // is compile-time only — and put battleView permanently outside mutual exclusion on all five
    // surfaces at once. A region-bounded tooth structurally cannot see that; only a whole-file
    // ceiling on USES can.
    //
    // uxd3-c raises this ceiling 3 -> 5 (adjudication Part B): E4's canOpen() gate binder
    // (surface 6) and E17's refreshBattle collapse (surface 7) each add ONE new
    // `visibleIds(overlayProbes)` call site. This test's own comment demands a new Part A surface
    // for any raise — surfaces 6 and 7 above supply exactly that.
    expect(
      countOccurrences(stripped, 'overlayProbes'),
      'the identifier `overlayProbes` must occur EXACTLY 5 times in main.ts (the declaration, ' +
        'surfaces 1 and 4 from uxd3-b, and surfaces 6 and 7 from uxd3-c). A 6th occurrence means ' +
        'something else touches the table: a runtime mutation such as ' +
        '`Reflect.set(overlayProbes, ...)` (Readonly is erased at runtime), or a 7th hand-wired ' +
        'consumer that this file has not pinned. Raise this number ONLY together with a new ' +
        'surface assertion in Part A.',
    ).toBe(5);
  });

  it('★ W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY-NO-HAND-ROLLED-OR-LIST BITES: zero hand-rolled `View?.visible ||` fan-out terms survive anywhere in main.ts', () => {
    // The CEILING that replaces the sixteen retired per-overlay FLOORS. A floor ("renameView
    // appears at least 17 times") can only ever detect an overlay being dropped from an
    // EXISTING list; it is structurally blind to a NEW sixth hand-written fan-out surface, and
    // it needs recalibrating every time an overlay is added. A ceiling of zero needs no
    // recalibration and fails the moment anyone hand-rolls a list again.
    //
    // RED AT AUTHORING TIME: the residual is 69, not 0 — the five OR-lists at main.ts:246-260
    // (14 terms with `||`), :699-715 (14), :1313-1329 (14), :1609-1623 (13) and :2492-2508 (14).
    // MEASURED on this tree: 75 total `View?.visible ||`, minus the 6 exempted below.
    //
    // THE NAMED EXEMPTION: `if (!xView?.visible || identity === '') return;` is the
    // refresh-listener early-out idiom, NOT a fan-out list — it names ONE overlay and asks
    // "is my own overlay closed, or am I not joined yet?". Six sites, all batch listeners:
    //   main.ts:1357 boxView, :1371 raisingView, :1383 evolutionView,
    //   main.ts:1557 shopView, :1589 tradeView, :1637 leaderboardView.
    // It is EXCISED FIRST so the ceiling is a true 0 that stays stable as overlays are added.
    // A bare `toBe(6)` would need recalibrating the day a 16th overlay gets a batch listener —
    // exactly the recalibration treadmill this tooth exists to end.
    //
    // WRONG IMPL KILLED (1): a collapse that leaves ONE list behind (the pvp aggregate is the
    //   likeliest, being the only one that is not a boolean guard). 13 residual ⇒ RED.
    // WRONG IMPL KILLED (2): a "helpful" 15-term OR-list added to a NEW sixth surface later —
    //   the failure mode no retired floor could see.
    // WRONG IMPL KILLED (3): a partial collapse that keeps a couple of terms appended to the
    //   registry call, e.g. `anyOverlayVisible() || settingsView?.visible`.
    //
    // HONEST SCOPE LIMIT (red-team F9 — recorded in ADR-0163 D3, and NOT to be overstated in
    // the PR body): this ceiling sees ONLY the `||` spelling. All of these are invisible to it:
    //   • a de-Morgan `&&` chain — `!a?.visible && !b?.visible && …`. This is the MOST likely
    //     shape a future author reaches for, because all 12 hotkey guard lists already use it.
    //   • `[a, b].some((v) => v?.visible)`
    //   • a `||=` accumulator
    //   • an alias — `const h = helpView; … h?.visible || …`
    //   • a ternary chain
    // The claim this tooth supports is "no hand-rolled `||` fan-out list survives", not "a new
    // sixth surface is impossible".
    const stripped = squashWhitespace(stripLineComments(readMainTs()));

    // ANTI-VACUITY FLOOR, ASSERTED FIRST: the six exempted sites must actually be found. If a
    // future edit reshapes that idiom, the excision below silently removes nothing (fine) — but
    // if the SCAN is broken (bad path, over-eager stripper, squash changing the spacing) the
    // exemption count collapses to 0 and the `toBe(0)` ceiling would pass on an empty string.
    expect(
      countOccurrences(stripped, "?.visible || identity === ''"),
      "main.ts must still contain the refresh-listener idiom `?.visible || identity === ''` at " +
        'least 6 times (box/raising/evolution/shop/trade/leaderboard batch listeners, ' +
        'main.ts:1330, 1344, 1356, 1530, 1562, 1596 post-collapse). A count of 0 means the source scan itself ' +
        'is broken and the ceiling below would pass vacuously — this is a scan failure, not a ' +
        'fan-out regression.',
    ).toBeGreaterThanOrEqual(6);

    const exempted = stripped.split("?.visible || identity === ''").join('');
    expect(
      countOccurrences(exempted, 'View?.visible ||'),
      'main.ts must contain ZERO hand-rolled `View?.visible ||` fan-out terms once the six ' +
        "named refresh-listener early-outs (`?.visible || identity === ''`) are excised. Every " +
        'mutual-exclusion read goes through the ONE probe table now (anyOverlayVisible() / ' +
        'anyVisible(overlayProbes, …)). RED at authoring time with 69 — the five OR-lists. If ' +
        'this reds AFTER the collapse, someone hand-wrote a new fan-out list; route it through ' +
        "the registry instead. NOTE the honest limit in this test's comment: a de-Morgan `&&` " +
        'chain is invisible to this ceiling.',
    ).toBe(0);
  });
});

/** Every `.<identifier>(` method-call token in a region, hand-scanned (no `new RegExp` —
 *  Semgrep's detect-non-literal-regexp is banned repo-wide and has broken CI twice).
 *  Deliberately returns the tokens rather than answering a yes/no question, so the caller can
 *  ALLOW-LIST them: a deny-list of forbidden verbs is unclosable (see the tooth below). */
function dotMethodTokens(region: string): string[] {
  const IDENT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';
  const found: string[] = [];
  for (const part of region.split('.').slice(1)) {
    let i = 0;
    while (i < part.length && IDENT.indexOf(part.charAt(i)) >= 0) i += 1;
    if (i > 0 && part.charAt(i) === '(') found.push(part.slice(0, i));
  }
  return found;
}

/** Every BARE `identifier(` call token in `region` — i.e. a call NOT preceded by a `.`, so it is
 *  a free function rather than a method. Control-flow keywords are excluded (biome always emits
 *  `if (`/`return ` with a space, but the filter costs nothing and keeps the failure message
 *  honest). Companion to dotMethodTokens: an allow-list over methods alone is one indirection
 *  from useless, because a bare call can reach a DOM-owning helper defined elsewhere in the
 *  file (red-team F7). Hand-rolled scan — `new RegExp` is Semgrep-banned in this file. */
function bareCallTokens(region: string): string[] {
  const IDENT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';
  const KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function'];
  const found: string[] = [];
  let i = 0;
  while (i < region.length) {
    if (IDENT.indexOf(region.charAt(i)) < 0) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < region.length && IDENT.indexOf(region.charAt(i)) >= 0) i += 1;
    const token = region.slice(start, i);
    const precededByDot = start > 0 && region.charAt(start - 1) === '.';
    if (!precededByDot && region.charAt(i) === '(' && KEYWORDS.indexOf(token) < 0) {
      found.push(token);
    }
  }
  return found;
}

describe('★ main.ts wiring (uxd3-b/ADR-0163): the AC-12 click front door is a READ-ONLY delegated branch', () => {
  it('★ W-UXD3B-LAUNCHER-BRANCH-IS-READ-ONLY BITES: the launcher branch gates on the SSOT, owns no DOM, and has exactly one binding site', () => {
    // AC-12 (spec :149) positive half: the persistent corner badge becomes the click front door
    // for the main menu. The whole design rests on the branch being DELEGATED and READ-ONLY —
    // main.ts must never NAME, resolve, mutate, hide or remove `#help-hint`, so
    // W-UX1-HINT-NO-JS-OWNER (:2640) stays green VERBATIM and ADR-0151 D2's "no owner that can
    // hide or remove it" survives the amendment.
    //
    // RED AT AUTHORING TIME: this test THROWS. `// UXD3B-LAUNCHER-BEGIN` does not exist in
    // main.ts yet, so `regionOrThrow` raises before any assertion runs — a hard red.
    //
    // uxd3-c (ADR-0163 D6 CLOSED, adjudication B5): UNIFIED onto canOpen('menuView') — the
    // divergence D6 recorded ("the click gate is the stricter of the two") is deliberately
    // resolved here rather than blessed with its own tooth. The ONE behavioural difference,
    // recorded plainly rather than glossed: canOpen exempts self, so with ONLY menuView visible
    // this branch now calls openMenu() (resetting menuState to MENU_INITIAL) where it previously
    // dead-clicked under the old `!anyOverlayVisible()` guard. Both branches are unreachable in
    // practice — `#menu-overlay` sits at `inset:0;z-index:100` over `#help-hint`'s `z-index:50`,
    // so a click while the menu is open lands on the menu overlay and
    // `closest('[data-menu-launcher]')` returns null — but the IMPLEMENTER MUST VERIFY that
    // z-index claim by direct grep of index.html BEFORE landing this needle. If it does not hold,
    // STOP: keep the OLD `!anyOverlayVisible() && identity !== ''` divergence (and restore a
    // `W-UXD3C-FRONT-DOORS-DIVERGE-BY-DESIGN`-shaped blessing tooth) instead of shipping a
    // reachable behaviour change on the strength of this comment alone. Record which branch was
    // taken in ADR-0164 D4 either way.
    //
    // WRONG IMPL KILLED (1) — red-team F4, the headline: a branch that CALLS the gate and
    //   ignores it. `void overlayVerdict('menuView'); held.clear(); openMenu();` contains
    //   `overlayVerdict`, `held.clear()` and `openMenu(` — every token a presence-only tooth
    //   looks for — and opens the modal menu OVER a live battle or a live NPC dialogue, AND
    //   pre-join (where `menuAvailability()` reads `store.ownCharacter(identity)` and
    //   inside a listener with no try/catch, breaking the click handler for the session).
    //   W-KEYM-HANDLER cannot help: it slices only the KeyM block, ~500 lines above this
    //   listener. Hence the FULL GUARD as ONE contiguous needle.
    // WRONG IMPL KILLED (2): the identity guard dropped — `if (overlayVerdict('menuView').kind
    //   === 'allow')` alone. Same pre-join throw, and the contiguous needle rejects it.
    // WRONG IMPL KILLED (3): the branch keyed on the ELEMENT ID (`closest('#help-hint')` or
    //   `document.getElementById('help-hint')`) instead of the data attribute. That reds
    //   W-UX1-HINT-NO-JS-OWNER, but only AFTER this branch exists; the positive needle here
    //   states the intended mechanism up front.
    // WRONG IMPL KILLED (4) — red-team F5, why this is an ALLOW-LIST and not a deny-list: a
    //   deny-list of nine DOM verbs misses `.removeAttribute(` (note `.remove(` does NOT
    //   substring-match it), `.dataset`, `.replaceWith(`, `.append(`, `.insertAdjacentHTML(`,
    //   `.toggleAttribute(`, `.setHTMLUnsafe(` and `el['style']`. Any one of them turns the
    //   zero-owner badge into an owned element and quietly voids ADR-0151 D2. An allow-list is
    //   closed by construction: anything not named fails, including verbs invented later.
    // WRONG IMPL KILLED (5): a SECOND binding site for the attribute (a duplicate branch, or a
    //   `setAttribute('data-menu-launcher')` that creates a second launcher). The whole-file
    //   count is the clause carrying the "ux1-1's structural guarantee is now DOUBLE-guarded"
    //   claim — it must not be the first thing dropped under budget pressure.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD3B_LAUNCHER_BEGIN);
    expectUniqueAnchor(src, UXD3B_LAUNCHER_END);
    const region = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3B_LAUNCHER_BEGIN, UXD3B_LAUNCHER_END)),
    );

    // ANTI-VACUITY, ASSERTED FIRST: a real, non-degenerate branch. An empty marker pair would
    // satisfy every deny-list clause and the allow-list subset check below for free.
    expect(
      region.trim().length,
      'ANTI-VACUITY: the launcher region is empty after comment-stripping — the markers wrap ' +
        'nothing, and every deny-list/allow-list clause below would pass vacuously',
    ).toBeGreaterThan(0);
    const methods = dotMethodTokens(region);
    expect(
      methods.length,
      'ANTI-VACUITY: the region must contain at least one `.method(` call (the delegation ' +
        '`closest(` at minimum) — an empty token set makes the allow-list subset check below ' +
        `vacuously true. Found: ${JSON.stringify(methods)}`,
    ).toBeGreaterThanOrEqual(1);

    // --- POSITIVE: the intended mechanism, stated as code, not as prose ---------------
    expect(
      region.includes("closest('[data-menu-launcher]')"),
      'the launcher branch must delegate on the DATA ATTRIBUTE — ' +
        "`closest('[data-menu-launcher]')`, the house idiom of this very listener " +
        '(`[data-shop-id]`, `[data-choice-idx]`). Keying on `#help-hint` instead would make ' +
        'main.ts an owner of the badge and red W-UX1-HINT-NO-JS-OWNER.',
    ).toBe(true);
    expect(
      region.includes("if (overlayVerdict('menuView').kind === 'allow' && identity !== '')"),
      'the launcher branch must carry the FULL guard as ONE contiguous expression: ' +
        "`if (overlayVerdict('menuView').kind === 'allow' && identity !== '')` — the SAME shape " +
        'KeyM uses (adjudication B5, unifying the two front doors onto canOpen). Asserting the ' +
        "tokens separately is not enough — `void overlayVerdict('menuView'); held.clear(); " +
        'openMenu();` contains every token and opens the modal menu over a live battle AND ' +
        'before join, where menuAvailability() reads store.ownCharacter(identity) against an ' +
        'un-joined identity, inside a listener with no try/catch. ' +
        'Region=' +
        JSON.stringify(region),
    ).toBe(true);
    expect(
      region.includes('held.clear()'),
      'the launcher branch must call held.clear() — the player can be HOLDING a movement key ' +
        'when they click the badge, and a held direction survives into the open menu and keeps ' +
        'the character walking underneath it (the same class of bug nh2 fixed for the rAF loop)',
    ).toBe(true);
    expect(
      region.includes('openMenu('),
      'the launcher branch must call openMenu( — the shared top-level helper the KeyM front ' +
        'door uses. Re-implementing the open inline would give AC-11 and AC-12 two divergent ' +
        'open paths.',
    ).toBe(true);

    // --- NEGATIVE: an ALLOW-LIST over method calls, plus the two non-call escapes -----
    // uxd3-c (adjudication B5): `anyOverlayVisible` -> `overlayVerdict` — the branch no longer
    // calls the former, and an allow-list should name only what is actually called (a dead
    // allowance is a small crack the same class of hole B5 just closed could reopen through).
    const ALLOWED = ['closest', 'clear', 'openMenu', 'overlayVerdict'];
    // Red-team F7, MEASURED GREEN before bare calls were included: `hideCornerBadge();` inside
    // the branch, with `function hideCornerBadge() { ...querySelectorAll('body > div')...remove() }`
    // defined ELSEWHERE in main.ts, removed the badge at runtime while W-UX1-HINT-NO-JS-OWNER
    // stayed green (the literal `help-hint` never appears). A method-only allow-list cannot see
    // an undotted call, so the escape hatch is one indirection away. Both token kinds are
    // collected here, against the SAME allow-list.
    const methodsAndBare = methods.concat(bareCallTokens(region));
    const disallowed = methodsAndBare.filter((m) => !ALLOWED.includes(m));
    expect(
      disallowed,
      'the launcher branch may call ONLY ' +
        JSON.stringify(ALLOWED) +
        ' — it is a READ-ONLY delegated branch. Anything else means main.ts acquired an ' +
        'imperative handle on the badge (or on some other element) inside the one listener ' +
        'that is allowed to see it, which voids ADR-0151 D2 ("no owner that can hide or remove ' +
        'it") while W-UX1-HINT-NO-JS-OWNER stays green because the literal `help-hint` never ' +
        'appears. Found disallowed: ' +
        JSON.stringify(disallowed),
    ).toEqual([]);
    expect(
      region.includes('.dataset'),
      'the launcher branch must not touch `.dataset` — it is a property, not a call, so the ' +
        'method allow-list above cannot see it, and `el.dataset.menuLauncher = ...` mutates the ' +
        'badge just as thoroughly as removeAttribute would',
    ).toBe(false);
    // Indexed member access (`el['style']`, `el[prop]`) is the other way past a method
    // allow-list. The ONLY legitimate `[` in this branch is inside the attribute-selector
    // STRING `'[data-menu-launcher]'`, where the bracket is immediately preceded by a quote.
    let indexedAccess = 0;
    for (let i = 0; i < region.length; i += 1) {
      if (region.charAt(i) !== '[') continue;
      const prev = i === 0 ? '' : region.charAt(i - 1);
      if (prev !== "'" && prev !== '"') indexedAccess += 1;
    }
    expect(
      indexedAccess,
      'the launcher branch must contain no INDEXED member access — the only `[` allowed is the ' +
        "one inside the attribute selector string '[data-menu-launcher]'. `el['style']` / " +
        '`el[prop]` is the standard way past a method allow-list. Region=' +
        JSON.stringify(region),
    ).toBe(0);
    expect(
      region.length,
      'the launcher branch must stay SMALL (< 400 chars after comment-stripping and whitespace ' +
        'squashing). It is a four-line delegated guard; anything larger is logic that belongs in ' +
        `a named helper where it can be unit-tested. Got ${region.length}: ` +
        JSON.stringify(region),
    ).toBeLessThan(400);

    // --- WHOLE FILE: exactly one binding site ------------------------------------------
    // RAW source deliberately (not comment-stripped): a rationale comment that spells the
    // attribute is a second textual site and would make this count ambiguous for any future
    // reader. Describe the mechanism in prose instead of quoting the literal.
    expect(
      countOccurrences(src, 'data-menu-launcher'),
      'the literal `data-menu-launcher` must appear EXACTLY once in main.ts — one delegated ' +
        'binding site, nothing else. Two occurrences means either a duplicate branch (two ' +
        'competing open paths for one click) or, worse, main.ts writing the attribute onto some ' +
        'element at runtime — which would create a second launcher that ' +
        'W-ONE-CORNER-AFFORDANCE (a markup-only scan of index.html) can never see. This clause ' +
        "is what carries the claim that ux1-1's structural guarantee is now double-guarded. " +
        'NOTE: this counts RAW source, so a comment quoting the attribute also fails — write ' +
        'the rationale in prose.',
    ).toBe(1);
  });
});

// ===========================================================================
// uxd3-c (ADR-0164, pending) — the WRITE substrate: every hotkey open-guard routes through
// canOpen(), the force-hide handle table mirrors OverlayHandles, and the ADR-0163 D3
// de-Morgan landmine is closed generically.
//
// SOURCE OF TRUTH: /tmp/uxd3c-adjudication.md (BINDING over the plan wherever they conflict)
// + /tmp/uxd3c-plan.md §B (E1-E18) and §C. ADR number reserved: 0164.
//
// This section's teeth are the DIRECT REPLACEMENT for `W-OVERLAY-FANOUT-MUTEX`,
// `W-HELP-FANOUT-OPENGUARDS`, `W-HELP-FANOUT-BATTLE` and `W-TP-FANOUT-KEYN-GUARD`. Per the
// coordinator's explicit instruction, ALL FOUR of those pre-existing teeth are LEFT UNTOUCHED
// here; the orchestrator retires them in T3 AFTER capturing a RED receipt against the migrated
// main.ts. Until that migration lands, every tooth below is RED for the obvious reason: none of
// `overlayVerdict(`, `// UXD3C-HANDLES-BEGIN`, `// UXD3C-CANOPEN-BEGIN`, `visibleIds(`,
// `canOpen(` or `hideAllExceptPlan(` exist in main.ts yet, and `overlayHandles` does not exist
// either.
// ===========================================================================

describe('★ main.ts wiring (uxd3-c/ADR-0164): every hotkey open-guard routes through canOpen() (replaces W-OVERLAY-FANOUT-MUTEX)', () => {
  // The SAME 12 open-handler anchors W-OVERLAY-FANOUT-MUTEX uses, plus the Escape sentinel, feed
  // the SAME order-independent block-slicer (main.wiring.test.ts, the W-OVERLAY-FANOUT-MUTEX
  // idiom): slice each handler from its own anchor to the MINIMUM forward indexOf of every OTHER
  // anchor (or the Escape sentinel), so handler ORDER in main.ts can change without breaking this
  // tooth.
  const UXD3C_ESCAPE_SENTINEL = "e.code === 'Escape'";

  const UXD3C_OPEN_HANDLERS: ReadonlyArray<{
    anchor: string;
    selfAnchor: string;
    carriesIdentity: boolean;
    expectedRaw: string;
  }> = [
    {
      anchor: "e.code === 'KeyB'",
      selfAnchor: "'boxView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyB') {
    const boxVerdict = overlayVerdict('boxView');
    if (boxVerdict.kind === 'allow') {
      for (const id of boxVerdict.forceHide) overlayHandles[id]?.();
      boxView?.toggle();
      if (boxView?.visible) refreshBox();
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyI'",
      selfAnchor: "'raisingView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyI') {
    const raisingVerdict = overlayVerdict('raisingView');
    if (raisingVerdict.kind === 'allow') {
      for (const id of raisingVerdict.forceHide) overlayHandles[id]?.();
      raisingView?.toggle();
      if (raisingView?.visible) refreshRaising();
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyE'",
      selfAnchor: "'evolutionView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyE') {
    const evolutionVerdict = overlayVerdict('evolutionView');
    if (evolutionVerdict.kind === 'allow') {
      for (const id of evolutionVerdict.forceHide) overlayHandles[id]?.();
      evolutionView?.toggle();
      if (evolutionView?.visible) refreshEvolution();
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyQ'",
      selfAnchor: "'questLogView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyQ') {
    if (overlayVerdict('questLogView').kind === 'allow') {
      if (questLogView?.visible) {
        questLogView.hide();
      } else {
        openQuestLog();
      }
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyU'",
      selfAnchor: "'tradeView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyU') {
    if (overlayVerdict('tradeView').kind === 'allow') {
      if (tradeView?.visible) {
        tradeView.hide();
      } else {
        openTrade();
      }
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyP'",
      selfAnchor: "'pvpView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyP') {
    if (overlayVerdict('pvpView').kind === 'allow') {
      if (pvpView?.visible) {
        pvpView.hide();
      } else {
        openPvp();
      }
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyL'",
      selfAnchor: "'leaderboardView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyL') {
    if (overlayVerdict('leaderboardView').kind === 'allow') {
      if (leaderboardView?.visible) {
        leaderboardView.hide();
      } else {
        openLeaderboard();
      }
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyN'",
      selfAnchor: "'renameView'",
      carriesIdentity: false,
      expectedRaw: `e.code === 'KeyN') {
    e.preventDefault();
    if (overlayVerdict('renameView').kind === 'allow') {
      if (renameView?.visible) {
        renameView.hide();
      } else {
        held.clear();
        openRename();
      }
    }
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyO'",
      selfAnchor: "'tradeProposeView'",
      carriesIdentity: true,
      expectedRaw: `e.code === 'KeyO') {
    e.preventDefault();
    if (overlayVerdict('tradeProposeView').kind === 'allow' && identity !== '') {
      if (tradeProposeView?.visible) {
        tradeProposeView.hide();
      } else {
        held.clear();
        openPropose();
      }
    }
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyT'",
      selfAnchor: 'anyOverlayVisible()',
      carriesIdentity: true,
      expectedRaw: `e.code === 'KeyT') {
    if (!anyOverlayVisible() && identity !== '') {
      interactAtNearest();
    }
    e.preventDefault();
    return;
  }
  if (`,
    },
    {
      anchor: "e.key === '?'",
      selfAnchor: "'helpView'",
      carriesIdentity: false,
      expectedRaw: `e.key === '?') {
    e.preventDefault();
    if (overlayVerdict('helpView').kind === 'allow') {
      if (helpView?.visible) {
        helpView.hide();
      } else {
        held.clear();
        openHelp();
      }
    }
    return;
  }
  if (`,
    },
    {
      anchor: "e.code === 'KeyM'",
      selfAnchor: "'menuView'",
      carriesIdentity: true,
      expectedRaw: `e.code === 'KeyM') {
    e.preventDefault();
    if (overlayVerdict('menuView').kind === 'allow' && identity !== '') {
      if (menuView?.visible) {
        menuView.hide();
      } else {
        held.clear();
        openMenu();
      }
    }
    return;
  }
  if (`,
    },
  ] as const;

  it('★ W-UXD3C-OPENGUARDS-ROUTE-THROUGH-CANOPEN BITES: each handler EQUALS its exact post-migration body — replaces W-OVERLAY-FANOUT-MUTEX', () => {
    // ADJUDICATION B1 (kills red-team F1/F3): the retired W-OVERLAY-FANOUT-MUTEX read RAW
    // source and asked "does the block CONTAIN every sibling guard token" — a containment check.
    // Red-team MEASURED three HIGH survivors against that shape, ALL ZERO assertion failures:
    //   (1) wrong-view body: overlayVerdict('boxView') computed correctly, then
    //       raisingView?.toggle() — KeyB silently drives the wrong overlay forever, and the old
    //       tooth's own anti-vacuity ("block contains its own overlay id") is satisfied by the
    //       overlayVerdict('boxView') ARGUMENT alone.
    //   (2) dead-wrap: the whole correct body inside `if (false) { … }` — needle found verbatim.
    //   (3) an early `return;` inserted ABOVE the pinned prefix.
    // EXACT EQUALITY on the comment-stripped, whitespace-squashed block is what closes all three:
    // there is no room left for a wrong view, a dead wrapper or an early return without changing
    // the string.
    //
    // ADJUDICATION B2 (kills red-team F2): expectUniqueAnchor on ALL 12 anchors. The reused
    // slicer does `src.indexOf(anchor)` — first occurrence only. A duplicate EARLIER shadow block
    // (e.g. a stray `if (e.code === 'KeyB') { e.preventDefault(); return; }` copy-pasted above the
    // real handler) is invisible to a slice that spans both blocks; the needle is still found
    // while the FIRST `if` wins at runtime and KeyB is permanently dead. MEASURED: 0 assertion
    // failures without the uniqueness check. Kept ALONGSIDE the equality check (belt-and-braces):
    // a doubled slice also fails equality, but only the uniqueness check gives the CORRECT
    // diagnosis ("duplicate anchor"), where equality alone would just say "unexpected block text".
    //
    // ADJUDICATION B7 clause (b): the identity census — `block.includes("identity !== ''") ===
    // carriesIdentity`, asserted as an EQUALITY IN BOTH DIRECTIONS. Carries it: KeyO, KeyT, KeyM.
    // Does not: KeyB/I/E/Q/U/P/L/N/'?'. Kept independently of the equality check above (the
    // file's own "state it independently, don't just derive it" precedent — UXD3_KEYM_SIBLINGS)
    // despite being formally redundant with it: its failure mode (a pre-join
    // `store.ownCharacter(identity)` throw inside an uncaught listener) is silent, and it costs
    // ~5 lines. Clause (a) from the plan (per-id "no `!<id>?.visible`") is CUT (adjudication B7)
    // — fully subsumed by the equality check and by the whole-file `W-UXD3C-NO-DEMORGAN-FANOUT`
    // ceiling below.
    //
    // BOUNDARY RESIDUE (state it, don't hide it): every `expectedRaw` ends in `  if (` — the
    // slicer's blockEnd is the index of the NEXT handler anchor, e.g. `e.code === 'KeyI'`, which
    // sits inside `  if (e.code === 'KeyI') {` in main.ts. The slice therefore STOPS one token
    // short of that anchor, capturing the closing `}` of the PREVIOUS handler's `if` statement
    // plus the bare `if (` that opens the next one — uniformly, for every handler including the
    // KeyM -> Escape-sentinel boundary (`  if (e.code === 'Escape' && renameView?.visible) {`).
    // This is NOT a bug in the expectation: it is the same residue W-OVERLAY-FANOUT-MUTEX's own
    // slicer has always left; pinning it explicitly (rather than trimming it away) is what proves
    // the slicer's behaviour is understood rather than papered over.
    const src = readMainTs();

    const allAnchors: readonly string[] = [
      ...UXD3C_OPEN_HANDLERS.map((h) => h.anchor),
      UXD3C_ESCAPE_SENTINEL,
    ];

    let handlersChecked = 0;
    for (const handler of UXD3C_OPEN_HANDLERS) {
      // B2: uniqueness FIRST — a duplicated anchor gives the correct diagnosis on its own,
      // before the slicer or the equality check can misattribute the failure.
      expectUniqueAnchor(src, handler.anchor);

      const hIdx = src.indexOf(handler.anchor);
      expect(
        hIdx,
        `main.ts must contain the open-handler anchor \`${handler.anchor}\` — handler missing or renamed`,
      ).toBeGreaterThanOrEqual(0);

      let blockEnd = src.length;
      for (const otherAnchor of allAnchors) {
        if (otherAnchor === handler.anchor) continue;
        const otherIdx = src.indexOf(otherAnchor, hIdx + handler.anchor.length);
        if (otherIdx >= 0 && otherIdx < blockEnd) blockEnd = otherIdx;
      }
      const block = src.slice(hIdx, blockEnd);

      // ANTI-VACUITY (raw block, before any processing): non-empty, and really is this
      // handler's own block (names its own overlay id, or `anyOverlayVisible()` for KeyT).
      expect(
        block.length,
        `handler block for \`${handler.anchor}\` must be non-empty (anti-vacuity)`,
      ).toBeGreaterThan(0);
      expect(
        block.includes(handler.selfAnchor),
        `handler block for \`${handler.anchor}\` must reference ${handler.selfAnchor} — proves ` +
          'this is the real handler, not a degenerate/mis-anchored slice (anti-vacuity)',
      ).toBe(true);

      const actual = squashWhitespace(stripLineComments(block));
      const expected = squashWhitespace(stripLineComments(handler.expectedRaw));

      // ANTI-VACUITY (the expectation itself): a near-empty expected literal would make the
      // equality below trivially easy to satisfy by accident. Every real handler body here is
      // well over 100 characters once squashed.
      expect(
        expected.length,
        `the expected literal for \`${handler.anchor}\` collapsed to ${expected.length} chars — ` +
          'refusing to gate on a near-empty expectation (anti-vacuity)',
      ).toBeGreaterThan(80);

      expect(
        actual,
        `\`${handler.anchor}\` handler body must equal, EXACTLY (comment-stripped, whitespace-` +
          `squashed):\n${expected}\n\nGot:\n${actual}\n\n` +
          'Containment is NOT enough here (adjudication B1) — a wrong-view body, a dead `if ' +
          '(false) { … }` wrapper and an early `return;` all CONTAIN every needle a presence ' +
          'check looks for while changing behaviour completely; only exact equality on the whole ' +
          'block closes all three.',
      ).toBe(expected);

      // B7(b): the identity census, as an equality in BOTH directions.
      expect(
        actual.includes("identity !== ''"),
        `\`${handler.anchor}\` handler must ${handler.carriesIdentity ? '' : 'NOT '}carry ` +
          `\`identity !== ''\` — expected carriesIdentity=${handler.carriesIdentity}. Adding it ` +
          'to a handler that never carried it silently no-ops six overlays pre-join; dropping it ' +
          'from KeyO/KeyT/KeyM re-opens the pre-join store.ownCharacter(identity) throw inside an ' +
          'uncaught listener.',
      ).toBe(handler.carriesIdentity);

      handlersChecked += 1;
    }
    expect(handlersChecked, 'ANTI-VACUITY: all 12 open-handlers must have been exercised').toBe(12);
  });
});

describe('★ main.ts wiring (uxd3-c/ADR-0164): the force-hide handle table mirrors OverlayHandles', () => {
  it('★ W-UXD3C-HANDLE-TABLE BITES: overlayHandles is bidirectional against OVERLAY_IDS and NEVER_FORCE_HIDE, dialogueView undefined, all others the exact hide-call thunk', () => {
    // ADJUDICATION B4: the shipped type is a BARE optional-thunk table —
    // `Readonly<Record<OverlayId, (() => void) | undefined>>` — NOT the plan's `{ hide?: () =>
    // void }` wrapper. Call sites read `overlayHandles[id]?.()`; the table entry for the one
    // NEVER_FORCE_HIDE member is the explicit, self-explaining `dialogueView: undefined,` (not
    // `{}`, which reads as "config TBD").
    //
    // WHY presence-only would not bite (Part B's own measured wrong impl, replayed on the write
    // side): `raisingView: () => boxView?.hide()` type-checks perfectly and makes the KeyB/I/E
    // switch hide the WRONG overlay; only the byte-identical per-id literal sees it.
    const src = readMainTs();
    expectUniqueAnchor(src, UXD3C_HANDLES_BEGIN);
    expectUniqueAnchor(src, UXD3C_HANDLES_END);
    const region = squashWhitespace(
      stripLineComments(regionOrThrow(src, UXD3C_HANDLES_BEGIN, UXD3C_HANDLES_END)),
    );

    // ANTI-VACUITY, ASSERTED FIRST.
    expect(OVERLAY_IDS.length, 'the imported manifest must hold 15 overlays').toBe(15);
    expect(
      NEVER_FORCE_HIDE.length,
      'the imported NEVER_FORCE_HIDE must hold exactly 1 member',
    ).toBe(1);
    expect(
      region.includes('overlayHandles'),
      'ANTI-VACUITY: the marked region must actually contain the `overlayHandles` declaration',
    ).toBe(true);

    for (const id of OVERLAY_IDS) {
      if (NEVER_FORCE_HIDE.includes(id)) {
        expect(
          region.includes(`${id}: undefined,`),
          `the handle table must contain \`${id}: undefined,\` — ${id} is the sole ` +
            'NEVER_FORCE_HIDE member and must NEVER get a hide thunk (a client-side hide strands ' +
            'the server player_conversation row)',
        ).toBe(true);
        expect(
          region.includes(`${id}: () =>`),
          `the handle table must NOT give ${id} a hide thunk of any form`,
        ).toBe(false);
      } else {
        const needle = `${id}: () => ${id}?.hide(),`;
        expect(
          region.includes(needle),
          `the handle table must contain the EXACT entry \`${needle}\` — byte-identical, so a ` +
            `copy-pasted sibling thunk (e.g. \`${id}: () => boxView?.hide(),\`) cannot satisfy ` +
            'this tooth',
        ).toBe(true);
      }
    }

    expect(
      countOccurrences(region, '?.hide(),'),
      'the handle table must contain EXACTLY 14 `?.hide(),` thunks — one per non-dialogue ' +
        'manifest member. A different count means an id was smuggled in, dropped, or given a ' +
        'malformed thunk.',
    ).toBe(14);
    expect(
      region.includes('...'),
      'the handle table must be a FLAT object literal with no `...` spread — a spread source ' +
        'would hide a poisoned entry outside this region, exactly as the probe table tooth pins',
    ).toBe(false);

    const stripped = stripLineComments(src);
    expect(
      countOccurrences(stripped, 'const overlayHandles'),
      'main.ts must declare `const overlayHandles` EXACTLY once',
    ).toBe(1);

    // Whole-file ceiling: closes the Reflect.set poisoning hole (Part B's own precedent) — no
    // reflection API reaches a module-scope binding without NAMING it, so a bounded whole-file
    // count of every occurrence of the identifier is a complete guard. RED-TEAM MEASURED exactly
    // 5 on the fully-migrated tree: the declaration + the KeyB/KeyI/KeyE force-hide loops + the
    // refreshBattle force-hide loop (surface 7).
    expect(
      countOccurrences(stripped, 'overlayHandles'),
      'the identifier `overlayHandles` must occur EXACTLY 5 times in main.ts (whole file, ' +
        'comment-stripped): the declaration, the KeyB/KeyI/KeyE force-hide loops, and the ' +
        'refreshBattle force-hide loop. A 6th occurrence means something else touches the table ' +
        '(e.g. `Reflect.set(overlayHandles, ...)`, which erases `Readonly` at runtime).',
    ).toBe(5);
  });
});

describe('★ main.ts wiring (uxd3-c/ADR-0164): no de-Morgan-&&-spelled hand-rolled fan-out survives (closes ADR-0163 D3)', () => {
  it('★ W-UXD3C-NO-DEMORGAN-FANOUT BITES: zero de-Morgan `&&` hand-rolled fan-out terms survive anywhere in main.ts', () => {
    // ADJUDICATION B9. ADR-0163 D3 named the de-Morgan `&&` chain as the shape a future author
    // is MOST LIKELY to reach for (all 12 pre-migration hotkey guard lists already use it), and
    // demonstrated a hand-rolled 13-term sixth surface passing the whole suite. Part C's ceiling
    // (`W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY-NO-HAND-ROLLED-OR-LIST`) closes only the `||`
    // spelling; this tooth closes the `&&` spelling.
    //
    // TODO(orchestrator-measure): the plan's needle is
    // `countOccurrences(stripped, '?.visible && !') === 0` (measured 148 -> 0 across the red-team's
    // full migration). Re-measure `countOccurrences(stripped, '?.visible &&')` (WITHOUT the
    // trailing `!`) on the FULLY-MIGRATED tree — if THAT is also 0, ship the stricter needle
    // instead (it additionally kills a single-term guard like `!x?.visible && identity !== ''`,
    // which the `&& !` needle cannot see because there is no second negated term to glue onto).
    // Command: run the project's vitest invocation for this file after T2 lands
    // (`just ci` per AGENTS.md, or scoped: `npx vitest run client/src/main.wiring.test.ts` from
    // `client/`) with this tooth temporarily using the stricter needle, and inspect PASS/FAIL —
    // or grep main.ts directly, comments included: `grep -c '?\.visible &&' client/src/main.ts`
    // (a manual grep will read slightly higher than this test's own comment-stripped scan).
    // Record the measurement in this comment AND in ADR-0164 D6.
    //
    // Chosen needle for THIS commit (the plan's, proven to measure 148->0 by red-team's full
    // migration): may be tightened by the orchestrator once the TODO above is resolved.
    const NEEDLE = '?.visible && !';

    const stripped = squashWhitespace(stripLineComments(readMainTs()));

    // ANTI-VACUITY, ASSERTED FIRST: the probe table's own `?.visible ?? false` idiom is a named,
    // stable control — if the scan itself breaks (bad path, over-eager comment strip, a squash
    // that eats the `?`), this floor collapses to 0 and the ceiling below would pass vacuously.
    expect(
      countOccurrences(stripped, '?.visible ?? false'),
      'main.ts must still contain at least 15 `?.visible ?? false` occurrences (the probe table) ' +
        '— a count under 15 means the SCAN itself is broken, not that the probe table shrank',
    ).toBeGreaterThanOrEqual(15);

    expect(
      countOccurrences(stripped, NEEDLE),
      `main.ts must contain ZERO \`${NEEDLE}\` fan-out terms once every hotkey guard routes ` +
        'through overlayVerdict()/canOpen(). RED AT AUTHORING TIME: ~148 (measured on the ' +
        'pre-migration tree — 160 guard terms across the 12 hotkey lists, minus the 12 terminal ' +
        'conjuncts that have no following `!`). If this reds AFTER migration, a hand-rolled ' +
        'de-Morgan `&&` chain was written somewhere — route it through the registry instead. ' +
        "HONEST SCOPE (state, don't overclaim): together with Part C's `View?.visible ||` " +
        'ceiling, this closes both the `||` and the de-Morgan `&&` spellings ADR-0163 D3 named as ' +
        'most likely. It does NOT see `[a,b].some(v => v?.visible)`, a `||=` accumulator, an ' +
        'aliased local, or a ternary chain.',
    ).toBe(0);
  });
});
