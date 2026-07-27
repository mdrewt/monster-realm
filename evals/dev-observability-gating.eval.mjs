// dev-observability-gating.eval.mjs — slice `dev-observability` (ADR-0157)
//
// ONE architecture gate over `client/src/net/devLog.ts`, covering two EARS criteria
// mechanically (plan §D, gates E1 + T-NO-RING):
//
//   E1 — the module has ZERO runtime imports (`import type` permitted) and never names
//        `console`. This subsumes three v1 checks:
//          * criterion 4's PII firewall — a module that imports nothing at runtime CANNOT
//            reach eventRing / errorRing / bugBundle, so a reducer arg (joinGame({name}),
//            setNickname({nickname}), setProfileName({name}) all carry player free text)
//            can never land in the downloadable F9 bug bundle Drew SHARES (pt-b1 U-3);
//          * criterion 2's real bundle-bloat risk — bloat comes from dragging a dependency
//            into the prod bundle, not from ~110 lines of formatter;
//          * criterion 4's "no second logging mechanism" — the module cannot own a console
//            sink; the sink stays INJECTED (`out`/`warn` parameters), which is also what
//            keeps the whole module unit-testable with no globals.
//
//   T-NO-RING — belt-and-braces: the source must not name `eventRing`, `errorRing`,
//        `bugBundle` or `pushError` at all. This BITES WHERE E1 CANNOT: a `import type
//        { EventRing } from '../ui/eventRing'` is a legal type-only import that E1 permits,
//        yet it signals the module is being wired into the shared-artifact path (obs-e must
//        re-open pt-b1 U-3 before that is allowed).
//
//   NO-GLOBAL-SCOPE — the source must not name `globalThis` or `window`. T-NO-RING is a
//        FIXED VOCABULARY, so it cannot see a module that builds its OWN durable ring:
//        a module-level buffer published as `globalThis.__mrSideChannel = BUF` has zero
//        runtime imports, trips no ring needle, and is exactly the "second logging
//        mechanism" (anti-pattern #9) plus the latent PII-in-a-shared-artifact risk that
//        criterion 4 forbids. devLog.ts has NO legitimate reason to touch either global:
//        every input arrives as a parameter (`raw`, `isDev`, `warn`, `out`, `target`,
//        `log`) and all state lives in module consts and closures reached only through the
//        exported functions. Banning the two global roots also closes the string-indexed
//        console bypasses (`globalThis['console'].log(line)`).
//
//   NO-AMBIENT-CLOCK-OR-RNG — the source must not name `Date`, `Math.random`,
//        `performance` or `crypto`. Those are BAREWORDS, so NO-GLOBAL-SCOPE (which only
//        catches named global OBJECTS) cannot see them — on a module that runs
//        synchronously in front of every outbound reducer dispatch, i.e. the determinism
//        axis ADR-0003 guards hardest. A future increment that genuinely needs a clock
//        must INJECT it (`now: () => number`), the way `warn`/`out` already are.
//
// RED STATE AT AUTHORING TIME: `client/src/net/devLog.ts` does not exist. The eval FAILS
// (pass:false, "cannot read") — it does NOT skip. A missing module must be red, never green.
//
// Implementation notes (house style, copied from dev-reducer-gating.eval.mjs):
//   - NO `new RegExp(...)` / dynamic regex ANYWHERE. Semgrep's detect-non-literal-regexp has
//     bitten master three times. All matching is String.indexOf / .includes / .startsWith
//     / .split on literal needles.
//   - Comments (`/* */` and `//`) are stripped BEFORE every scan, so prose cannot trip a
//     check. This is load-bearing here: devLog.ts is expected to CARRY a comment naming
//     `errorRing.ts` (the MAX_LINE_LEN=512 provenance) and one naming console.log vs
//     console.debug — neither may be flagged.
//   - Every predicate is pure and exported. Every predicate has GOOD + BAD fixtures that run
//     UNCONDITIONALLY before any real-source scan; a fixture failure aborts the eval (a
//     broken predicate must never gate production code).

import { readFileSync } from 'node:fs';

const DEVLOG_PATH = 'client/src/net/devLog.ts';

// ============================================================================
// Shared helper — comment stripping (block then line), literal scans only
// ============================================================================

/**
 * Drop block comments (open/close marker scan, multi-line aware) then line comments.
 * NOT a regex — Semgrep bans dynamic RegExp and this needs no regex at all.
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let withoutBlocks = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      withoutBlocks += src.slice(i);
      break;
    }
    withoutBlocks += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) break; // unterminated block comment: drop the remainder
    i = end + 2;
  }
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const c = line.indexOf('//');
      return c === -1 ? line : line.slice(0, c);
    })
    .join('\n');
}

// ============================================================================
// Check E1a — zero RUNTIME imports (`import type` permitted)
// ============================================================================
//
// A runtime import is any of:
//   * a statement-initial `import ...` that is not `import type ...`
//     (this covers `import { X } from 'y'`, `import X from 'y'`, `import 'y'` and the
//      multi-line `import {\n  X,\n} from 'y'` form — the first line still starts the
//      statement and still is not `import type`)
//   * a dynamic `import(` anywhere
//   * a CommonJS `require(` anywhere
//   * a re-export `export ... from ...` (a re-export IS a runtime import of the source
//     module), unless it is `export type ...`
//
// Kills: an impl that imports the event ring, the error ring, the bug bundle, a
// formatting helper, or anything else — the module must stand alone.

/**
 * @param {string} stripped  Comment-stripped source.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkNoRuntimeImports(stripped) {
  const lines = stripped.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (line.startsWith('import')) {
      // Allowed: type-only imports (erased at build time, zero runtime cost).
      if (line.startsWith('import type ') || line.startsWith('import type{')) continue;
      return (
        `${DEVLOG_PATH}:${n + 1}: runtime import "${line}" — devLog.ts must have ZERO runtime ` +
        'imports (only `import type` is permitted). A runtime import can reach the shared F9 ' +
        'bug bundle (PII, pt-b1 U-3) and drags a dependency into the prod bundle (criterion 2)'
      );
    }
    // Re-export forms only (`export { x } from '…'` / `export * from '…'`). A narrow
    // needle on purpose: a broad "any exported line containing ' from '" rule would
    // false-positive on an ordinary string literal such as `'derived from the level'`.
    const isReExport = line.startsWith('export {') || line.startsWith('export *');
    if (isReExport && line.includes(' from ')) {
      return (
        `${DEVLOG_PATH}:${n + 1}: re-export "${line}" — a re-export is a runtime import of the ` +
        'source module; devLog.ts must have ZERO runtime imports'
      );
    }
  }
  if (stripped.indexOf('import(') !== -1) {
    return (
      `${DEVLOG_PATH}: dynamic import( found — a dynamic import is still a runtime import ` +
      '(and would let the module reach eventRing/bugBundle at run time despite a clean import ' +
      'header). devLog.ts must have ZERO runtime imports'
    );
  }
  if (stripped.indexOf('require(') !== -1) {
    return (
      `${DEVLOG_PATH}: require( found — devLog.ts must have ZERO runtime imports (ESM-only ` +
      'repo; a require() is a runtime import through a side door)'
    );
  }
  return null;
}

// ============================================================================
// Check E1b — the bareword `console` never appears
// ============================================================================
//
// The sink is INJECTED (`out: (line: string) => void`, `warn: (msg: string) => void`).
// A module that owns a console sink is (a) untestable without globals, (b) a second
// logging mechanism (criterion 4), and (c) unable to honor "zero additional console
// output" (criterion 2) by construction.
//
// THE NEEDLE IS THE BAREWORD `console`, NOT `console.` — a red-team pass built four
// implementations that pass every unit gate AND emit a second, uninjected log stream
// while containing no `console.` substring at all:
//     globalThis.console['log'](line)      globalThis['console'].log(line)
//     const { log } = console; log(line)   const c = console; c.log(line)
// Each of them still contains the bareword. (`globalThis['console']` is additionally
// caught by checkNoGlobalScope below — the two predicates overlap on purpose.)
//
// FALSE-POSITIVE NOTE for the implementer: comments are stripped before this scan, so a
// rationale comment about console.log-vs-console.debug is fine. A user-facing MESSAGE
// STRING containing the word "console" WOULD trip it — reword the message; devLog.ts has
// no reason to say "console" in live code (the parse/resolve errors name the FLAG and the
// accepted token set, not the sink).

/**
 * @param {string} stripped  Comment-stripped source.
 * @returns {string|null}
 */
export function checkNoConsole(stripped) {
  const idx = stripped.indexOf('console');
  if (idx === -1) return null;
  const lineNo = stripped.slice(0, idx).split('\n').length;
  return (
    `${DEVLOG_PATH}:${lineNo}: the bareword "console" appears in live code — the sink must be ` +
    'INJECTED (`out`/`warn` parameters, wired in main.ts). Owning a console sink makes the ' +
    'module untestable without globals and is the "second logging mechanism" criterion 4 ' +
    'forbids. Note the needle is the BAREWORD, so `globalThis.console["log"](x)`, ' +
    '`const { log } = console` and `const c = console` are caught too'
  );
}

// ============================================================================
// Check NO-GLOBAL-SCOPE — `globalThis` / `window` are never named
// ============================================================================
//
// T-NO-RING is a FIXED VOCABULARY and therefore cannot see a module that builds its OWN
// durable ring. A red-team implementation that keeps a module-level array of every logged
// call and publishes it as `globalThis.__mrSideChannel = SIDE_BUFFER` has zero runtime
// imports, hits no ring needle, passes every unit gate — and is a second logging mechanism
// holding player free text in a place a future bundle/screenshot can reach.
//
// devLog.ts is a PURE policy module: `raw`, `isDev`, `warn`, `out`, `target`, `log` all
// arrive as parameters. There is no legitimate `globalThis`/`window` reference in it. (The
// runtime toggle that WOULD need one is deferred as obs-d, and must land with its own ADR.)
//
// Kills: the side-channel buffer; `window.__mrDevLog = …`; `globalThis['console'].log(…)`;
// any other reach for ambient state that makes the module untestable-without-globals.

const GLOBAL_NEEDLES = ['globalThis', 'window'];

/**
 * @param {string} stripped  Comment-stripped source.
 * @returns {string|null}
 */
export function checkNoGlobalScope(stripped) {
  for (const needle of GLOBAL_NEEDLES) {
    const idx = stripped.indexOf(needle);
    if (idx !== -1) {
      const lineNo = stripped.slice(0, idx).split('\n').length;
      return (
        `${DEVLOG_PATH}:${lineNo}: references "${needle}" in live code — devLog.ts must not ` +
        'touch ambient global scope. Every input is a parameter and all state belongs in ' +
        'module consts/closures reached only through the exported functions; a global ' +
        'side-channel (e.g. `globalThis.__mrSideChannel = BUF`) is a SECOND logging mechanism ' +
        "(anti-pattern #9) that T-NO-RING's fixed vocabulary cannot see, and a latent " +
        'PII-in-a-shared-artifact risk. A runtime toggle is deferred as obs-d'
      );
    }
  }
  return null;
}

// ============================================================================
// Check T-NO-RING — the source never names the shared-artifact substrate
// ============================================================================
//
// Bites where E1 cannot: `import type { EventRing } from '../ui/eventRing'` is a
// type-only import E1 permits, but it means devLog records are being shaped for the
// durable, SHARED bug bundle — which carries player free text (joinGame({name}),
// setNickname, setProfileName). ADR-0157 §4: console-only, obs-e must re-open pt-b1 U-3
// before any devlog content goes near the bundle.

const RING_NEEDLES = ['eventRing', 'errorRing', 'bugBundle', 'pushError'];

/**
 * @param {string} stripped  Comment-stripped source.
 * @returns {string|null}
 */
export function checkNoRingReferences(stripped) {
  for (const needle of RING_NEEDLES) {
    const idx = stripped.indexOf(needle);
    if (idx !== -1) {
      const lineNo = stripped.slice(0, idx).split('\n').length;
      return (
        `${DEVLOG_PATH}:${lineNo}: references "${needle}" in live code — reducer-call records ` +
        'are CONSOLE-ONLY and must never enter the shared F9 bug bundle (ADR-0157 §4; reducer ' +
        'args carry player free text, pt-b1 U-3). Deferred as obs-e. (Comments are stripped ' +
        'before this scan, so a prose mention of errorRing.ts is NOT what tripped this.)'
      );
    }
  }
  return null;
}

// ============================================================================
// Check NO-AMBIENT-CLOCK-OR-RNG — `Date` / `Math.random` / `performance` / `crypto`
// ============================================================================
//
// checkNoGlobalScope only catches named global OBJECTS. The ambient CLOCK and RNG are
// barewords: `Date.now()`, `Math.random()`, `performance.now()`, `crypto.getRandomValues()`
// would all sail through every other predicate — on a module that sits SYNCHRONOUSLY in
// front of every outbound reducer dispatch, i.e. exactly the determinism axis ADR-0003
// guards hardest. A timestamped or sampled log line also makes formatSendLine
// non-deterministic, so its own property test (`T-FMT-TOTAL`) could no longer pin it.
//
// devLog.ts needs neither: the console already timestamps lines, and every input arrives
// as a parameter. If a future increment genuinely needs a clock it must be INJECTED
// (`now: () => number`), the way `warn` and `out` already are — which keeps the module
// unit-testable and keeps this predicate honest.
//
// `Math.random` (not bare `Math`) on purpose: Math.max/Math.min are deterministic and
// perfectly legitimate; only the RNG is banned. The GOOD fixture exercises `Math.max` to
// prove this predicate does not over-reach.

const CLOCK_RNG_NEEDLES = ['Date', 'Math.random', 'performance', 'crypto'];

/**
 * @param {string} stripped  Comment-stripped source.
 * @returns {string|null}
 */
export function checkNoAmbientClockOrRng(stripped) {
  for (const needle of CLOCK_RNG_NEEDLES) {
    const idx = stripped.indexOf(needle);
    if (idx !== -1) {
      const lineNo = stripped.slice(0, idx).split('\n').length;
      return (
        `${DEVLOG_PATH}:${lineNo}: references "${needle}" in live code — devLog.ts must read no ` +
        'ambient clock and no RNG. It runs synchronously in front of every outbound reducer ' +
        'dispatch, so a hidden Date.now()/Math.random() reading puts non-determinism on the ' +
        'send path (ADR-0003) and makes the pure formatter untestable. Inject it instead ' +
        '(`now: () => number`), the way `warn` and `out` already are. NOTE: comments are ' +
        'stripped before this scan, so the toISOString()/toDate() rationale prose is fine; ' +
        'Math.max/Math.min are NOT banned, only Math.random'
      );
    }
  }
  return null;
}

// ============================================================================
// Positive control — the file is the real module, not an empty stub
// ============================================================================
//
// Anti-vacuity: every check above is an ABSENCE check, so an empty (or deleted-content)
// devLog.ts would satisfy all three. This pins that the file actually exports the pinned
// API surface (plan §A1).

const REQUIRED_NAMES = [
  'MAX_LINE_LEN',
  'parseDevLogLevel',
  'resolveDevLogLevel',
  'shouldLogReducer',
  'formatSendLine',
  'makeSendLogger',
  'wrapReducerLogging',
];

/**
 * @param {string} stripped  Comment-stripped source.
 * @returns {string|null}
 */
export function checkIsRealModule(stripped) {
  const missing = REQUIRED_NAMES.filter((n) => stripped.indexOf(n) === -1);
  if (missing.length > 0) {
    return (
      `${DEVLOG_PATH}: missing pinned export(s) ${missing.join(', ')} — the absence checks above ` +
      'would pass vacuously on an empty file, so the module must be proven present (plan §A1)'
    );
  }
  const exportCount = stripped.split('export').length - 1;
  if (exportCount < 6) {
    return (
      `${DEVLOG_PATH}: only ${exportCount} "export" occurrences — plan §A1 pins 7 exported ` +
      'values plus 2 exported types; a file this thin cannot be the real module'
    );
  }
  return null;
}

// ============================================================================
// Internal proof-of-teeth fixtures (run UNCONDITIONALLY, before real scanning)
// ============================================================================

const GOOD_DEVLOG = `
// net/devLog.ts — dev-console outbound reducer log (ADR-0157).
//
// ZERO runtime imports by design (see evals/dev-observability-gating.eval.mjs E1):
// a module that imports nothing cannot reach the eventRing / errorRing / bugBundle,
// so a reducer arg can never land in the shared F9 bundle. The console sink is
// INJECTED: main.ts passes (line) => console.log(line) — console.log, not
// console.debug (Chrome hides debug behind the Verbose level).
/* MAX_LINE_LEN mirrors ERROR_MSG_MAX_LEN (client/src/ui/errorRing.ts:12).
   A block comment naming pushError and bugBundle must NOT trip the scan.
   Neither may a comment quoting the banned FORMS themselves:
     import { EventRing } from '../ui/eventRing';
     const ring = await import('../ui/eventRing');
     const fs = require('node:fs');
     export { eventRing } from '../ui/eventRing';
     globalThis.__mrSideChannel = BUF;  window.__mrDevLog = 'send';
     Date.now();  Math.random();  performance.now();  crypto.getRandomValues(a);
   toISOString()/toDate() are NOT duck-typed (they are PARTIAL on the SDK Timestamp) —
   that rationale comment names Date and must stay legal.
   All of the above are PROSE here — they must be stripped, not flagged. */
import type { SomeSdkThing } from './sdkTypes';
export type { SomeSdkThing } from './sdkTypes';

export const MAX_LINE_LEN = 512;
// Deterministic Math is NOT banned — only the RNG is. This live call proves the
// clock/RNG predicate does not over-reach.
export function clampLen(n) { return Math.max(0, n); }
export type DevLogLevel = 'off' | 'send' | 'send-move';
export type SendLogger = (reducerName: string, args: readonly unknown[]) => void;
export function parseDevLogLevel(raw) { return 'off'; }
export function resolveDevLogLevel(raw, isDev, warn) { warn('x'); return 'off'; }
export function shouldLogReducer(level, name) { return false; }
export function formatSendLine(name, args) { return '-> ' + name; }
export function makeSendLogger(level, out) { return (n, a) => out(formatSendLine(n, a)); }
export function wrapReducerLogging(target, log) { return target; }
`;
// Must pass ALL SIX predicates. It exercises every PERMITTED form (a type-only import, a
// type-only re-export, an injected sink, and a DETERMINISTIC Math.max call) and quotes
// every BANNED form — the ring names, the bareword console, globalThis/window, a plain
// import, a dynamic import, a require, a value re-export, Date.now/Math.random/
// performance.now/crypto.getRandomValues, and the toISOString()/toDate() rationale prose
// the real module carries — exclusively inside comments (the comment-immunity proof;
// Tooth G2 asserts they are all still really there).

const BAD_RUNTIME_IMPORT = `
import { formatThing } from './fmt';
export const MAX_LINE_LEN = 512;
export function parseDevLogLevel() {}
export function resolveDevLogLevel() {}
export function shouldLogReducer() {}
export function formatSendLine() {}
export function makeSendLogger() {}
export function wrapReducerLogging() {}
`;
// Kills: any impl with a plain runtime import (the dependency-into-the-bundle risk),
// even one that names nothing ring-related — checkNoRingReferences must NOT flag it,
// proving the two predicates are independent.

const BAD_MULTILINE_IMPORT = `
import {
  EventRing,
} from '../ui/eventRing';
export function wrapReducerLogging() {}
`;
// Kills: an impl hiding a runtime import behind biome's multi-line specifier wrapping.

const BAD_DYNAMIC_IMPORT = `
export async function pushIt(rec) {
  const ring = await import('../ui/eventRing');
  ring.eventRing.push(rec);
}
`;
// Kills: a lazy runtime import — a clean import header with a dynamic import in the body.

const BAD_REEXPORT = `
export { eventRing } from '../ui/eventRing';
export function wrapReducerLogging() {}
`;
// Kills: a re-export, which is a runtime import of the source module.

const BAD_CONSOLE = `
import type { SendLogger } from './types';
export function makeSendLogger(level, out) {
  return (n, a) => {
    console.log(formatSendLine(n, a));
  };
}
`;
// Kills: a module that owns its console sink instead of taking it as a parameter.
// checkNoRuntimeImports must NOT flag it (it only has a type import), proving the
// console predicate is what bites.

const BAD_TYPE_ONLY_RING = `
import type { EventRecord } from '../ui/eventRing';
export function toRingRecord(name, args): EventRecord {
  return { kind: 'reducerCall', name, args };
}
`;
// Kills: the case E1 CANNOT catch — a legal type-only import that nevertheless wires the
// devlog into the shared-artifact path. checkNoRuntimeImports must PASS it (type-only) and
// checkNoRingReferences must FLAG it; that asymmetry is the whole reason T-NO-RING exists.

const BAD_CONSOLE_BRACKET = `
export function makeSendLogger(level, out) {
  return (n, a) => {
    const line = formatSendLine(n, a);
    out(line);
    globalThis.console['log'](line);
  };
}
`;
// Kills (red-team, PROVEN bypass of the old `console.` needle): an impl that correctly
// calls the injected sink AND ALSO emits its own stream through bracket access. It passes
// every unit gate — `out` is called exactly once — while doubling console output in a build
// where the operator asked for one line. Contains no `console.` substring; the BAREWORD
// needle is what catches it (and checkNoGlobalScope catches it independently).

const BAD_CONSOLE_DESTRUCTURE = `
const { log } = console;
export function makeSendLogger(level, out) {
  return (n, a) => {
    out(formatSendLine(n, a));
    log('devlog: ' + n);
  };
}
`;
// Kills (red-team, PROVEN): the destructure-alias form. No `console.` substring, no
// globalThis, no ring needle — the bareword `console` is the ONLY thing that sees it.

const BAD_GLOBAL_SIDE_CHANNEL = `
const SIDE_BUFFER = [];
export function makeSendLogger(level, out) {
  return (n, a) => {
    SIDE_BUFFER.push({ n, a, t: Date.now() });
    out(formatSendLine(n, a));
  };
}
globalThis.__mrSideChannel = SIDE_BUFFER;
`;
// Kills (red-team, PROVEN): the module builds its OWN durable ring and publishes it on the
// global object. Zero runtime imports, no ring needle, no console reference, all 25 unit
// gates green — a second logging mechanism (anti-pattern #9) retaining player free text.
// checkNoGlobalScope is the ONLY predicate that sees it; the teeth below assert exactly
// that asymmetry (the other four must all return null on this fixture).

const BAD_WINDOW_TOGGLE = `
export function makeSendLogger(level, out) {
  const live = window.__mrDevLog ?? level;
  return live === 'off' ? undefined : (n, a) => out(formatSendLine(n, a));
}
`;
// Kills: the obs-d runtime toggle smuggled in early — a second configuration source (a
// second SSOT) that also makes the module untestable without a DOM global.

const BAD_AMBIENT_CLOCK = `
export function makeSendLogger(level, out) {
  return (n, a) => {
    out('[' + Date.now() + '] ' + formatSendLine(n, a));
  };
}
`;
// Kills: a timestamped line. It reads the ambient clock on the synchronous send path
// (ADR-0003 determinism) and makes formatSendLine's own property test unable to pin the
// output. Invisible to every other predicate — no import, no console, no global object,
// no ring needle.

const BAD_AMBIENT_RNG = `
export function makeSendLogger(level, out) {
  return (n, a) => {
    if (Math.random() < 0.1) return;
    out(formatSendLine(n, a));
  };
}
`;
// Kills: sampling the log. Non-deterministic OUTPUT from a module the whole slice treats
// as pure — and a log that silently drops 10% of the calls it exists to record.

const BAD_AMBIENT_PERF = `
export function formatSendLine(name, args) {
  return '-> ' + performance.now() + ' ' + name;
}
`;
// Kills: the same defect via the other clock. `performance` is a bareword, so neither the
// global-object ban nor the ring vocabulary sees it.

const BAD_AMBIENT_CRYPTO = `
export function makeSendLogger(level, out) {
  const id = crypto.getRandomValues(new Uint8Array(4)).join('');
  return (n, a) => out(id + ' ' + formatSendLine(n, a));
}
`;
// Kills: a per-session correlation id minted from the ambient CSPRNG — non-deterministic,
// and (unlike everything else in this module) an unreviewed new identifier in the log.

const BAD_EMPTY_STUB = `
// devLog.ts — nothing here yet.
`;
// Kills: an empty/gutted file that satisfies all three ABSENCE checks vacuously.

// ============================================================================
// Default export — eval entry point
// ============================================================================

export default async function () {
  const name =
    'dev-observability-gating (ADR-0157 E1: client/src/net/devLog.ts has ZERO runtime imports, ' +
    'no bareword console, no globalThis/window, no ambient clock/RNG; T-NO-RING: no ' +
    'eventRing/errorRing/bugBundle/pushError)';

  // ==========================================================================
  // PROOFS-OF-TEETH — a fixture failure means the PREDICATE is broken, so the
  // eval must abort rather than judge production code with a broken ruler.
  // ==========================================================================

  const good = stripComments(GOOD_DEVLOG);
  for (const [label, result] of [
    ['checkNoRuntimeImports', checkNoRuntimeImports(good)],
    ['checkNoConsole', checkNoConsole(good)],
    ['checkNoRingReferences', checkNoRingReferences(good)],
    ['checkNoGlobalScope', checkNoGlobalScope(good)],
    ['checkNoAmbientClockOrRng', checkNoAmbientClockOrRng(good)],
    ['checkIsRealModule', checkIsRealModule(good)],
  ]) {
    if (result) {
      return {
        name,
        pass: false,
        detail:
          `TEETH G1: GOOD_DEVLOG (type-only import + a permitted \`export type … from\`, an ` +
          `injected sink, and every banned FORM quoted only inside comments) was incorrectly ` +
          `flagged by ${label}: ${result}`,
      };
    }
  }

  // --- Tooth G2: comment immunity is REAL (not an accident of the fixture) --
  {
    // The raw GOOD fixture DOES contain every banned string AND every banned FORM
    // (a plain import, a dynamic import, a require, a re-export, globalThis, window);
    // only comment-stripping saves it. If this stops holding, Tooth G1 proves nothing
    // about comment immunity — which is the property that lets the real devLog.ts carry
    // its `errorRing.ts` provenance note and its console.log-vs-console.debug rationale.
    const rawHasBanned = [
      'console.',
      'eventRing',
      'pushError',
      'bugBundle',
      "import { EventRing } from '../ui/eventRing';",
      "await import('../ui/eventRing')",
      "require('node:fs')",
      "export { eventRing } from '../ui/eventRing';",
      'globalThis',
      'window',
      'Date.now()',
      'Math.random()',
      'performance.now()',
      'crypto.getRandomValues(',
      'toDate()',
    ].every((needle) => GOOD_DEVLOG.indexOf(needle) !== -1);
    if (!rawHasBanned) {
      return {
        name,
        pass: false,
        detail:
          'TEETH G2: GOOD_DEVLOG no longer contains the banned strings in its comments, so ' +
          'Tooth G1 no longer proves comment-immunity — the fixture has lost its teeth',
      };
    }
  }

  // --- Tooth B1: a plain runtime import must be flagged --------------------
  {
    const stripped = stripComments(BAD_RUNTIME_IMPORT);
    if (!checkNoRuntimeImports(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B1: BAD_RUNTIME_IMPORT (`import { formatThing } from "./fmt";`) was NOT flagged ' +
          'by checkNoRuntimeImports — devLog.ts must have zero runtime imports',
      };
    }
    if (checkNoRingReferences(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B1b: BAD_RUNTIME_IMPORT was flagged by checkNoRingReferences — the two ' +
          'predicates must be independent, or B1 proves nothing about the import check',
      };
    }
  }
  if (!checkNoRuntimeImports(stripComments(BAD_MULTILINE_IMPORT))) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B2: BAD_MULTILINE_IMPORT (biome-wrapped specifier list) was NOT flagged — a ' +
        'line-oriented scan must still catch the statement-initial `import {` line',
    };
  }
  if (!checkNoRuntimeImports(stripComments(BAD_DYNAMIC_IMPORT))) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B3: BAD_DYNAMIC_IMPORT (`await import("../ui/eventRing")`) was NOT flagged — a ' +
        'clean import header with a lazy import in the body still reaches the ring at run time',
    };
  }
  if (!checkNoRuntimeImports(stripComments(BAD_REEXPORT))) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B4: BAD_REEXPORT (`export { eventRing } from "../ui/eventRing";`) was NOT ' +
        'flagged — a re-export is a runtime import of the source module',
    };
  }

  // --- Tooth B5: an owned console sink must be flagged ---------------------
  {
    const stripped = stripComments(BAD_CONSOLE);
    if (!checkNoConsole(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B5: BAD_CONSOLE (`console.log(...)` inside makeSendLogger) was NOT flagged by ' +
          'checkNoConsole — the sink must stay injected',
      };
    }
    if (checkNoRuntimeImports(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B5b: BAD_CONSOLE (whose only import is `import type`) was flagged by ' +
          'checkNoRuntimeImports — a type-only import must be PERMITTED, and the console ' +
          'predicate must be the thing that bites here',
      };
    }
  }

  // --- Tooth B6: the type-only ring import — E1 permits it, T-NO-RING kills it ---
  {
    const stripped = stripComments(BAD_TYPE_ONLY_RING);
    if (checkNoRuntimeImports(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B6a: BAD_TYPE_ONLY_RING was flagged by checkNoRuntimeImports — `import type` ' +
          'must be permitted; if E1 flagged it, T-NO-RING adds nothing and this eval is ' +
          'testing the wrong thing',
      };
    }
    if (!checkNoRingReferences(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B6b: BAD_TYPE_ONLY_RING (a legal type-only import of ../ui/eventRing) was NOT ' +
          'flagged by checkNoRingReferences — this is the exact case E1 cannot see, and it is ' +
          'the whole reason T-NO-RING exists (ADR-0157 §4 / obs-e)',
      };
    }
  }
  if (!checkIsRealModule(stripComments(BAD_EMPTY_STUB))) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B7: BAD_EMPTY_STUB (a file with only a comment) was NOT flagged by ' +
        'checkIsRealModule — every other check is an ABSENCE check and would pass it ' +
        'vacuously, so deleting the module would turn this eval green',
    };
  }

  // --- Tooth B8: the BAREWORD console bypasses (red-team, both PROVEN) ------
  {
    const bracket = stripComments(BAD_CONSOLE_BRACKET);
    if (!checkNoConsole(bracket)) {
      return {
        name,
        pass: false,
        detail:
          "TEETH B8a: BAD_CONSOLE_BRACKET (`globalThis.console['log'](line)` alongside a correct " +
          'out(line)) was NOT flagged by checkNoConsole — this impl passes every unit gate and ' +
          'emits a SECOND, uninjected console stream while containing no "console." substring. ' +
          'The needle must be the BAREWORD "console"',
      };
    }
    const destructured = stripComments(BAD_CONSOLE_DESTRUCTURE);
    if (!checkNoConsole(destructured)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B8b: BAD_CONSOLE_DESTRUCTURE (`const { log } = console; log(...)`) was NOT ' +
          'flagged by checkNoConsole — no "console." substring, no globalThis, no ring needle: ' +
          'the bareword is the only thing that sees this one',
      };
    }
    if (checkNoGlobalScope(destructured)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B8c: BAD_CONSOLE_DESTRUCTURE was flagged by checkNoGlobalScope — it names no ' +
          'global root, so if the global predicate fires here then B8b proves nothing about ' +
          'the bareword-console widening',
      };
    }
  }

  // --- Tooth B9: the global side-channel — ONLY checkNoGlobalScope sees it --
  {
    const side = stripComments(BAD_GLOBAL_SIDE_CHANNEL);
    if (!checkNoGlobalScope(side)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B9a: BAD_GLOBAL_SIDE_CHANNEL (a module-level buffer published as ' +
          '`globalThis.__mrSideChannel = SIDE_BUFFER`) was NOT flagged by checkNoGlobalScope — ' +
          'that is a SECOND logging mechanism (anti-pattern #9) retaining player free text, ' +
          "and T-NO-RING's fixed vocabulary structurally cannot see it",
      };
    }
    for (const [label, result] of [
      ['checkNoRuntimeImports', checkNoRuntimeImports(side)],
      ['checkNoConsole', checkNoConsole(side)],
      ['checkNoRingReferences', checkNoRingReferences(side)],
    ]) {
      if (result) {
        return {
          name,
          pass: false,
          detail:
            `TEETH B9b: BAD_GLOBAL_SIDE_CHANNEL was flagged by ${label} — it must be invisible ` +
            'to every OTHER predicate, otherwise B9a does not prove that checkNoGlobalScope is ' +
            `load-bearing: ${result}`,
        };
      }
    }
    const win = stripComments(BAD_WINDOW_TOGGLE);
    if (!checkNoGlobalScope(win)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH B9c: BAD_WINDOW_TOGGLE (`window.__mrDevLog ?? level`) was NOT flagged by ' +
          'checkNoGlobalScope — a runtime toggle is a second configuration source (obs-d) and ' +
          'makes the module untestable without a DOM global',
      };
    }
  }
  for (const [label, fixture] of [
    ['BAD_AMBIENT_CLOCK (Date.now() in the line)', BAD_AMBIENT_CLOCK],
    ['BAD_AMBIENT_RNG (Math.random() sampling)', BAD_AMBIENT_RNG],
    ['BAD_AMBIENT_PERF (performance.now() in the line)', BAD_AMBIENT_PERF],
    ['BAD_AMBIENT_CRYPTO (crypto.getRandomValues() session id)', BAD_AMBIENT_CRYPTO],
  ]) {
    const stripped = stripComments(fixture);
    if (!checkNoAmbientClockOrRng(stripped)) {
      return {
        name,
        pass: false,
        detail:
          `TEETH B10: ${label} was NOT flagged by checkNoAmbientClockOrRng — an ambient clock ` +
          'or RNG on the synchronous outbound send path is non-determinism (ADR-0003) that ' +
          'every other predicate is blind to: it needs no import, no console, no global ' +
          'object and no ring name',
      };
    }
    // Independence: if another predicate happened to catch it, B10 proves nothing.
    for (const [other, result] of [
      ['checkNoRuntimeImports', checkNoRuntimeImports(stripped)],
      ['checkNoConsole', checkNoConsole(stripped)],
      ['checkNoRingReferences', checkNoRingReferences(stripped)],
      ['checkNoGlobalScope', checkNoGlobalScope(stripped)],
    ]) {
      if (result) {
        return {
          name,
          pass: false,
          detail:
            `TEETH B10b: ${label} was also flagged by ${other} — it must be invisible to every ` +
            `OTHER predicate, otherwise B10 does not prove the clock/RNG check is ` +
            `load-bearing: ${result}`,
        };
      }
    }
  }
  // Over-reach guard: deterministic Math must NOT be banned (the GOOD fixture calls
  // Math.max). Covered by Tooth G1, asserted explicitly here so the intent is recorded.
  if (checkNoAmbientClockOrRng(stripComments('export const f = (n) => Math.max(0, n);'))) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B10c: `Math.max(0, n)` was flagged by checkNoAmbientClockOrRng — only the RNG ' +
        'is banned; Math.max/Math.min are deterministic and legitimate. Over-reaching here ' +
        'would push the implementer to work around the gate rather than obey it',
    };
  }

  // ==========================================================================
  // REAL SOURCE CHECK — scan client/src/net/devLog.ts.
  // Expected RED at authoring time: the module does not exist yet. A missing
  // module FAILS (it must never skip — fail-open is a silent blind spot).
  // ==========================================================================

  let raw;
  try {
    raw = readFileSync(DEVLOG_PATH, 'utf8');
  } catch (e) {
    return {
      name,
      pass: false,
      detail:
        `cannot read ${DEVLOG_PATH}: ${e.message} — the module must exist (RED until the ` +
        'implementer creates it; a missing file is a failure, never a skip)',
    };
  }

  const stripped = stripComments(raw);
  const failures = [];

  {
    const r = checkIsRealModule(stripped);
    if (r) failures.push(`[positive-control] ${r}`);
  }
  {
    const r = checkNoRuntimeImports(stripped);
    if (r) failures.push(`[E1:no-runtime-imports] ${r}`);
  }
  {
    const r = checkNoConsole(stripped);
    if (r) failures.push(`[E1:no-console] ${r}`);
  }
  {
    const r = checkNoRingReferences(stripped);
    if (r) failures.push(`[T-NO-RING] ${r}`);
  }
  {
    const r = checkNoGlobalScope(stripped);
    if (r) failures.push(`[NO-GLOBAL-SCOPE] ${r}`);
  }
  {
    const r = checkNoAmbientClockOrRng(stripped);
    if (r) failures.push(`[NO-AMBIENT-CLOCK-OR-RNG] ${r}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      `${DEVLOG_PATH} exports the pinned API and has ZERO runtime imports, no bareword ` +
      '"console", no globalThis/window, no ambient Date/Math.random/performance/crypto, and ' +
      'no eventRing/errorRing/bugBundle/pushError reference — criterion 2 (no dependency ' +
      'dragged into the prod bundle), criterion 4 (console-only; both the shared F9 bundle ' +
      'AND any self-built second ring are structurally unreachable) and ADR-0003 determinism ' +
      'on the send path all hold. Teeth verified (46 fixture assertions).',
  };
}
