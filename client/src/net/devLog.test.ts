// net/devLog.test.ts — RED gates for the `dev-observability` slice (ADR-0157).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-dev-observability.spec.md EARS 1–4,
// as designed in the authoritative plan §A1–A8 and §D.
//
// RED REASON: `client/src/net/devLog.ts` DOES NOT EXIST. Every test in this file fails at
// module-resolution time ("Failed to resolve import ./devLog") until the implementer creates
// it exporting exactly the API pinned below. That is a missing implementation, not a typo.
//
// API UNDER TEST (plan §A1, verbatim):
//   type DevLogLevel = 'off' | 'send' | 'send-move'
//   type SendLogger  = (reducerName: string, args: readonly unknown[]) => void
//   parseDevLogLevel(raw: string | undefined): DevLogLevel                     // throws on unknown
//   resolveDevLogLevel(raw, isDev, warn): DevLogLevel                          // asymmetric fail-loud
//   shouldLogReducer(level, name): boolean
//   formatSendLine(name, args): string
//   makeSendLogger(level, out): SendLogger | undefined                         // undefined when 'off'
//   wrapReducerLogging<T extends object>(target: T, log): T                    // IDENTITY when log undefined
//   MAX_LINE_LEN = 512
//
// INJECTION DISCIPLINE: nothing here touches the real `console`, the real SpacetimeDB SDK,
// the wasm, or any clock. `warn` and `out` are injected recorders; the Proxy target is a
// hand-built fake that deliberately reproduces the SDK's *shape* (see FakeDbConnection).
//
// GATE MAP (plan §D):
//   EARS-1: T-CFG-ON, T-LOG-EMITS, T-FMT, T-FMT-NESTED, T-FMT-IDENTITY-LIKE, T-FMT-TOTAL,
//           T-PROXY-CALLS, T-PROXY-THIS, T-PROXY-OWN-PROPS, T-PROXY-SINK-THROWS,
//           T-PROXY-STABLE
//   EARS-2: T-CFG-DEFAULT-OFF, T-CFG-REJECT, T-CFG-DEV-THROWS, T-CFG-PROD-DEGRADE,
//           T-LOG-OFF-UNDEFINED, T-PROXY-IDENTITY   (+ E1 in evals/dev-observability-gating.eval.mjs)
//   EARS-3: T-CFG-NO-INBOUND, T-FILTER   (+ T-LOG-FILTER-WIRED, see NOTE below)
//   EARS-4: E1 / T-NO-RING live in the eval (source-level firewall)
//
// POST-LANDING ADDITIONS (review round 2 — the implementation is green on everything above;
// these gates encode defects the earlier suite could not see):
//   * `T-PROXY-OWN-PROPS` (red-team Finding 1, reproduced against the real SDK): the SDK
//     builds `reducers` as a plain `{}` (db_connection_impl.ts:376 — #makeDbView at :360
//     uses Object.create(null), #makeReducers does not), so every Object.prototype member
//     is a reachable FUNCTION and a typeof-only trap wraps and LOGS them.
//   * the MAX_LINE_LEN gate now asserts the MIRROR relationship against the imported
//     ERROR_MSG_MAX_LEN, not just the literal 512 (desync-guard: a literal-only assertion
//     survives a re-tune of the source constant and silently splits the repo's one
//     truncation rule in two).
//
// NOTE — ONE GATE ADDED BEYOND PLAN §D (tester judgement, recorded for the verifier):
//   `T-LOG-FILTER-WIRED`. §D's T-FILTER only exercises `shouldLogReducer` directly, and
//   T-LOG-EMITS only exercises a non-noisy reducer. An implementation whose `makeSendLogger`
//   never CALLS `shouldLogReducer` passes every gate §D names — while `'send'` floods the
//   console with ~5 enqueueMove lines/second (the exact noise EARS-3/A4 exists to prevent)
//   and `shouldLogReducer` becomes dead code. That is a vacuity hole, so the wiring is
//   gated here.

// ---------------------------------------------------------------------------
// 11r-h ADDITIONS (ADR-0172, plan §R5.2/§R5.6) — RED WHEN WRITTEN.
//
// The movement-rejection diagnostics slice adds an INBOUND-fate formatter and a
// pure, generic rate-limit transition to devLog.ts. Neither exists yet, so this
// whole FILE fails to link ("does not provide an export named 'formatFateLine'")
// until the implementer lands them — a missing implementation, not a typo. The
// pre-existing gates above go red with it and turn green together.
//
// API UNDER TEST (plan §R5.6 + the accepted simplify deltas — `type`, not
// `interface`; no `emit.emitted`; no exported ReducerFate):
//   type FateLogger = (reducerName: string, fate: 'rejected', args: readonly unknown[]) => void
//   formatFateLine(name, fate, args): string        // `<- ${name} ${fate} ${formatArgs(args)}`, capped
//   makeFateLogger(level, out): FateLogger | undefined            // undefined when 'off'
//   type RateLimitState  = { lastMs: number; emitted: number; pending: number }
//   RATE_LIMIT_INITIAL: RateLimitState
//   type RateLimitPolicy = { minGapMs: number; cap: number }
//   rateLimitTick(state, nowMs, policy): { state: RateLimitState; emit: { pending: number } | undefined }
//
// GATE MAP (11r-h):
//   E5.4/D2: T-FATE-NOT-FILTERED, T-FATE-SHAPE
//   E5.5:    T-FATE-CAP, T-FATE-TOTAL
//   E5.6:    T-FATE-OFF-UNDEFINED
//   E5.3/D1: T-THROTTLE-FIRST, T-THROTTLE-GAP, T-THROTTLE-CAP, T-THROTTLE-PURE,
//            T-THROTTLE-BACKWARDS-CLOCK, T-THROTTLE-CONSERVATION
//
// WHY THE ARITHMETIC LIVES HERE AT ALL (plan §R5.2): main.ts is coverage-excluded,
// so counters kept there are only ever source-SCANNED. Moving the transition into
// this pure module is what makes the throttle executable-tested; these gates are the
// entire proof that the policy behaves, so none of them may be relaxed to fit an
// implementation — a wrong gate is re-derived from the plan, never from the code.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
// The line cap is DERIVED, not coincidental: ADR-0157 §4 reuses ADR-0130's discipline so
// the repo keeps ONE truncation rule. Importing the source constant is what makes the
// mirror enforceable instead of a comment. (errorRing.ts has zero imports and no DOM
// access, so this stays a node-only unit test. This import lives in the TEST file only —
// devLog.ts itself must keep ZERO runtime imports, gated by the E1 eval.)
import { ERROR_MSG_MAX_LEN } from '../ui/errorRing';
import {
  type DevLogLevel,
  type FateLogger,
  formatFateLine,
  formatSendLine,
  MAX_LINE_LEN,
  makeFateLogger,
  makeSendLogger,
  parseDevLogLevel,
  RATE_LIMIT_INITIAL,
  type RateLimitPolicy,
  type RateLimitState,
  rateLimitTick,
  resolveDevLogLevel,
  shouldLogReducer,
  wrapReducerLogging,
} from './devLog';

// ---------------------------------------------------------------------------
// Injected recorders (no global console / SDK / clock is ever touched)
// ---------------------------------------------------------------------------

function makeOutRecorder(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string) => {
      lines.push(line);
    },
  };
}

function makeWarnRecorder(): { msgs: string[]; warn: (msg: string) => void } {
  const msgs: string[] = [];
  return {
    msgs,
    warn: (msg: string) => {
      msgs.push(msg);
    },
  };
}

/** Non-null-assert a logger with a loud message (an `undefined` here is a real failure). */
function requireLogger(
  logger: ((name: string, args: readonly unknown[]) => void) | undefined,
  level: DevLogLevel,
): (name: string, args: readonly unknown[]) => void {
  if (typeof logger !== 'function') {
    throw new Error(
      `makeSendLogger('${level}', out) must return a SendLogger function (got ${typeof logger}) — ` +
        'only the OFF level may return undefined',
    );
  }
  return logger;
}

// ---------------------------------------------------------------------------
// The Proxy target fake — deliberately reproduces the SDK's SHAPE (plan §A2).
//
// `__DbConnectionImpl` (spacetimedb 2.6) has:
//   - real `#private` class fields,
//   - REGULAR prototype methods that read them (disconnect / callReducer /
//     getTablesMap / registerSubscription),
//   - an own DATA property `reducers` (set once in the constructor, NOT a getter)
//     whose methods are arrow-function class fields (lexically bound).
//
// A hand-rolled plain-object fake CANNOT detect the `this`-binding defect this shape
// exists to catch (a plain object has no brand check), which is why v1's fake was
// vacuous and this one is a real class. `naiveWrap` below proves the teeth bite.
// ---------------------------------------------------------------------------

interface FakeReducers {
  /** Arrow-function class field (SDK shape): lexically bound to the instance. */
  talk: (args: { x: number }) => unknown;
  /** Own data property on `reducers`: must pass through RAW and UNLOGGED. */
  version: number;
  /** Identifies the raw reducers object as the `this` a reducer method must see. */
  tag: string;
  /** REGULAR method (not an arrow): only `fn.apply(rawReducers, args)` gives it a `this`. */
  whoAmI(): string;
}

class FakeDbConnection {
  /** A genuine `#private` field — the brand check that a mis-bound `this` trips. */
  #dbName: string;
  #calls: { name: string; arg: unknown }[] = [];
  /** A non-function own property: must pass through RAW and UNLOGGED. */
  readonly label = 'raw-label';
  /** Own DATA property, set once in the constructor — exactly the SDK's layout. */
  readonly reducers: FakeReducers;
  /** What `talk` returns; swapped per-test to check return-value pass-through. */
  #talkResult: unknown = 'talk-result';

  constructor(dbName: string) {
    this.#dbName = dbName;
    this.reducers = {
      // Arrow field closing over the instance: works even when `this` is a Proxy,
      // which is precisely why the reducers path alone cannot prove `.bind(target)`.
      talk: (args: { x: number }) => {
        this.#calls.push({ name: 'talk', arg: args });
        return this.#talkResult;
      },
      version: 7,
      tag: 'raw-reducers',
      whoAmI(): string {
        return this.tag;
      },
    };
  }

  /** REGULAR prototype method reading a `#private` field (the SDK's `disconnect()` shape). */
  disconnect(): string {
    return `disconnected:${this.#dbName}`;
  }

  /** REGULAR prototype method reading a `#private` field (the SDK's `getTablesMap()` shape). */
  callLog(): readonly { name: string; arg: unknown }[] {
    return this.#calls;
  }

  /** Returns its own receiver so a test can assert `this` is the RAW instance. */
  self(): FakeDbConnection {
    return this;
  }

  setTalkResult(v: unknown): void {
    this.#talkResult = v;
  }
}

/**
 * The DEFECTIVE wrapper the `T-PROXY-THIS` gate exists to kill: a pass-through `get`
 * trap using `Reflect.get(target, prop, proxy)` with no `.bind(target)`. The receiver
 * argument only affects ACCESSOR evaluation — a later `obj.method()` still runs with
 * `this === proxy`, so the private-field brand check throws.
 */
function naiveWrap<T extends object>(target: T): T {
  const proxy: T = new Proxy(target, {
    get(t, p): unknown {
      return Reflect.get(t, p, proxy);
    },
  });
  return proxy;
}

// ===========================================================================
// EARS-2 / EARS-3 — configuration resolver (pure, injected `warn`)
// ===========================================================================

describe('devLog config (EARS-1/2/3): parseDevLogLevel + resolveDevLogLevel', () => {
  it('T-CFG-ON: parseDevLogLevel accepts send / SEND / " send " / send-move (trim + lowercase)', () => {
    // WRONG IMPL KILLED: a parser matching only exact-lowercase-untrimmed tokens — a shell
    // export like `VITE_MR_DEVLOG=SEND ` (trailing space, or a capitalised value) would then
    // be rejected as unknown and, in prod, silently degrade to 'off' (EARS-1 never fires).
    expect(parseDevLogLevel('send')).toBe('send');
    expect(parseDevLogLevel('SEND')).toBe('send');
    expect(parseDevLogLevel(' send ')).toBe('send');
    expect(parseDevLogLevel('send-move')).toBe('send-move');
    expect(parseDevLogLevel('SEND-MOVE')).toBe('send-move');
    expect(parseDevLogLevel('  Send-Move\t')).toBe('send-move');
  });

  it('T-CFG-DEFAULT-OFF: undefined / "" / "   " / off / OFF resolve to "off" and NEVER warn (both isDev values)', () => {
    // WRONG IMPL KILLED (1): a resolver defaulting to 'send' — the default PRODUCTION build
    // would emit a console line per reducer call, violating EARS-2's "zero additional output".
    // WRONG IMPL KILLED (2): a resolver that warns on the unset path — a warn() is itself
    // "additional console output" in the default prod build (EARS-2 again).
    const unsetLike: (string | undefined)[] = [
      undefined,
      '',
      '   ',
      '\t\n ',
      'off',
      'OFF',
      ' Off ',
    ];
    for (const isDev of [true, false]) {
      for (const raw of unsetLike) {
        const { msgs, warn } = makeWarnRecorder();
        expect(
          resolveDevLogLevel(raw, isDev, warn),
          `resolveDevLogLevel(${JSON.stringify(raw)}, ${isDev}) must be 'off'`,
        ).toBe('off');
        expect(
          msgs,
          `resolveDevLogLevel(${JSON.stringify(raw)}, ${isDev}) must NOT warn — a warn on the ` +
            'unset path is additional console output in the default prod build (EARS-2)',
        ).toEqual([]);
      }
    }
    // The pure parser agrees on the same inputs (no divergent second SSOT).
    expect(parseDevLogLevel(undefined)).toBe('off');
    expect(parseDevLogLevel('')).toBe('off');
    expect(parseDevLogLevel('   ')).toBe('off');
    expect(parseDevLogLevel('OFF')).toBe('off');
  });

  it('T-CFG-REJECT: parseDevLogLevel THROWS on "verbose" / "1" / "true", and the message names the accepted set', () => {
    // WRONG IMPL KILLED: clamping an unknown token to 'off' (silent misconfiguration —
    // the developer sets the flag, sees nothing, and cannot tell the flag from the feature).
    for (const bad of ['verbose', '1', 'true']) {
      expect(() => parseDevLogLevel(bad), `parseDevLogLevel('${bad}') must throw`).toThrow();
    }
    let message = '';
    try {
      parseDevLogLevel('verbose');
    } catch (err) {
      message = (err as Error)?.message ?? '';
    }
    // Naming the accepted set is what makes the throw actionable (reject-not-clamp, §A3).
    expect(message, 'the rejection message must name the accepted token "off"').toContain('off');
    expect(
      message,
      'the rejection message must name the accepted token "send-move" (which also proves "send")',
    ).toContain('send-move');
  });

  it('T-CFG-NO-INBOUND: parseDevLogLevel THROWS for inbound / recv / all / verbose (EARS-3 is enforced, not promised)', () => {
    // WRONG IMPL KILLED: a union that silently accepts 'all'/'inbound' (or clamps them to a
    // level) — the noisy inbound NPC-wander stream is then one typo away from being on, and
    // EARS-3 ("inbound stays off even with the flag on") becomes a promise instead of a fact.
    for (const bad of ['inbound', 'recv', 'all', 'verbose']) {
      expect(
        () => parseDevLogLevel(bad),
        `parseDevLogLevel('${bad}') must throw — inbound levels are OUT of this increment (obs-b)`,
      ).toThrow();
    }
  });

  it('T-CFG-DEV-THROWS: resolveDevLogLevel("verbose", isDev=true, warn) THROWS and does not warn', () => {
    // WRONG IMPL KILLED: swallowing the throw in dev (returning 'off' + a warn). In DEV the
    // throw is free — the developer who just set the flag sees it instantly on their own dev
    // server — and it is the only signal that separates "flag typo" from "feature broken".
    const { msgs, warn } = makeWarnRecorder();
    expect(() => resolveDevLogLevel('verbose', true, warn)).toThrow();
    expect(
      msgs,
      'the DEV path must RETHROW, not degrade-and-warn — a warn here means the throw was swallowed',
    ).toEqual([]);
  });

  it('T-CFG-PROD-DEGRADE: resolveDevLogLevel("verbose", isDev=false, warn) returns "off", warns EXACTLY once, naming the bad value and the accepted set', () => {
    // WRONG IMPL KILLED (1): throwing in PROD (the pt-a1 symmetry). The eager resolve sits at
    // main.ts module scope, BEFORE the window.onerror / unhandledrejection listeners are
    // registered — so a debug-flag typo would blank the whole playtest session AND kill the F9
    // bug-bundle path built to diagnose exactly that.
    // WRONG IMPL KILLED (2): degrading SILENTLY — the misconfiguration would be undiagnosable.
    // WRONG IMPL KILLED (3): warning on every read / more than once.
    const { msgs, warn } = makeWarnRecorder();
    expect(resolveDevLogLevel('verbose', false, warn)).toBe('off');
    expect(msgs.length, 'prod must warn EXACTLY once for one bad value').toBe(1);
    expect(msgs[0], 'the warning must name the offending value').toContain('verbose');
    expect(msgs[0], 'the warning must name the accepted set').toContain('send-move');
    expect(msgs[0], 'the warning must name the accepted set').toContain('off');
  });

  it('T-CFG-ON (resolver arm): a valid token resolves to that level in BOTH dev and prod, with no warn', () => {
    // WRONG IMPL KILLED: a resolver that force-disables the log in prod builds. `just
    // playtest-up` IS a production build — disabling there would make the whole feature
    // unreachable in the only environment Drew actually plays in.
    for (const isDev of [true, false]) {
      for (const [raw, want] of [
        ['send', 'send'],
        [' SEND ', 'send'],
        ['send-move', 'send-move'],
      ] as const) {
        const { msgs, warn } = makeWarnRecorder();
        expect(resolveDevLogLevel(raw, isDev, warn)).toBe(want);
        expect(msgs, 'a valid token must never warn').toEqual([]);
      }
    }
  });
});

// ===========================================================================
// EARS-3 — level filter
// ===========================================================================

describe('devLog filter (EARS-3): shouldLogReducer', () => {
  it('T-FILTER: send excludes enqueueMove, includes talk; send-move includes enqueueMove; off excludes everything', () => {
    // WRONG IMPL KILLED (1): inverting the movement exclusion — 'send' would emit ~5 lines/second
    // while walking, drowning the very calls Drew is trying to read (EARS-3's noise axis).
    // WRONG IMPL KILLED (2): `default: return true` instead of the exhaustive `never` default —
    // the 'off' level would log, and the Proxy would be installed with a live sink.
    expect(shouldLogReducer('send', 'enqueueMove')).toBe(false);
    expect(shouldLogReducer('send', 'talk')).toBe(true);
    expect(shouldLogReducer('send', 'joinGame')).toBe(true);
    expect(shouldLogReducer('send-move', 'enqueueMove')).toBe(true);
    expect(shouldLogReducer('send-move', 'talk')).toBe(true);
    for (const name of ['enqueueMove', 'talk', 'joinGame', 'proposeTrade', '']) {
      expect(shouldLogReducer('off', name), `off must never log ${name || '<empty>'}`).toBe(false);
    }
  });
});

// ===========================================================================
// EARS-1 / EARS-2 — the sink factory
// ===========================================================================

describe('devLog sink (EARS-1/2): makeSendLogger', () => {
  it('T-LOG-EMITS: level "send" calls out EXACTLY once with a line containing the name and the args', () => {
    // WRONG IMPL KILLED (1): a logger that drops the `out(...)` call (nothing is ever printed).
    // WRONG IMPL KILLED (2): a logger that prints the reducer name but drops the args — the
    // args are the entire point (EARS-1: "the events the client sends", not just their names).
    const { lines, out } = makeOutRecorder();
    const log = requireLogger(makeSendLogger('send', out), 'send');
    log('talk', [{ npcEntityId: 42 }]);
    expect(lines.length, 'out must be called exactly once per logged reducer call').toBe(1);
    expect(lines[0]).toContain('talk');
    expect(lines[0]).toContain('npcEntityId');
    expect(lines[0]).toContain('42');
  });

  it('T-LOG-OFF-UNDEFINED: makeSendLogger("off", out) === undefined and out is never called', () => {
    // WRONG IMPL KILLED: returning a no-op function instead of undefined. `wrapReducerLogging`
    // is identity only when `log` is undefined, so a no-op sink leaves the Proxy installed on
    // the SDK critical path in the default production build (EARS-2's allocation claim dies).
    const { lines, out } = makeOutRecorder();
    expect(
      makeSendLogger('off', out),
      "makeSendLogger('off', out) must return undefined — the disabled path allocates nothing",
    ).toBeUndefined();
    expect(lines, 'the off path must never call out').toEqual([]);
  });

  it('T-LOG-FILTER-WIRED: the logger APPLIES shouldLogReducer — "send" drops enqueueMove, "send-move" keeps it', () => {
    // (Gate added beyond plan §D — see the file header NOTE.)
    // WRONG IMPL KILLED: a makeSendLogger that formats and prints unconditionally, never
    // calling shouldLogReducer. Every gate §D names still passes, shouldLogReducer becomes
    // dead code, and 'send' floods the console with ~5 enqueueMove lines/second — the exact
    // noise the level split exists to remove.
    const send = makeOutRecorder();
    const sendLog = requireLogger(makeSendLogger('send', send.out), 'send');
    sendLog('enqueueMove', [{ input: { tag: 'Step', value: { tag: 'North' } }, seq: 1n }]);
    expect(
      send.lines,
      "level 'send' must NOT emit enqueueMove — the filter must be applied inside the logger",
    ).toEqual([]);
    sendLog('talk', [{ npcEntityId: 42 }]);
    expect(send.lines.length, "level 'send' must still emit non-noisy reducers").toBe(1);

    const move = makeOutRecorder();
    const moveLog = requireLogger(makeSendLogger('send-move', move.out), 'send-move');
    moveLog('enqueueMove', [{ input: { tag: 'Step', value: { tag: 'North' } }, seq: 1n }]);
    expect(move.lines.length, "level 'send-move' MUST emit enqueueMove").toBe(1);
    expect(move.lines[0]).toContain('enqueueMove');
  });
});

// ===========================================================================
// EARS-1 — the formatter
// ===========================================================================

describe('devLog formatter (EARS-1): formatSendLine', () => {
  it('MAX_LINE_LEN is 512 AND is still equal to ERROR_MSG_MAX_LEN (ui/errorRing.ts) — the ADR-0130 discipline reuse', () => {
    // WRONG IMPL KILLED (1): an arbitrary/absent cap. The 512 value is not free-choice — §A6/§4
    // of ADR-0157 pins it to the existing errorRing constant so the repo has ONE truncation rule.
    expect(MAX_LINE_LEN).toBe(512);
    // WRONG IMPL KILLED (2, the DRIFT case): a literal-only assertion goes on passing after
    // someone re-tunes ERROR_MSG_MAX_LEN, silently splitting the repo's single truncation rule
    // into two divergent ones while devLog.ts's own comment still claims it "mirrors" it. The
    // relationship is the invariant, so the relationship is what is asserted. If this ever
    // fails, the fix is to move BOTH constants together (or to amend ADR-0157 §4 and delete
    // the "mirrors" claim from devLog.ts) — never to loosen this line.
    expect(
      MAX_LINE_LEN,
      'MAX_LINE_LEN must stay equal to ERROR_MSG_MAX_LEN — devLog.ts documents it as MIRRORING ' +
        'that constant (ADR-0157 §4 reusing ADR-0130). devLog.ts cannot import it (zero runtime ' +
        'imports, E1), so this test is the only thing holding the two in sync',
    ).toBe(ERROR_MSG_MAX_LEN);
  });

  it('T-FMT: a bigint arg renders (does not throw) and the line carries the reducer name', () => {
    // WRONG IMPL KILLED: a bare `JSON.stringify(args)` with no bigint replacer — it throws
    // "TypeError: Do not know how to serialize a BigInt", and ONLY when the flag is on
    // (green in CI, exploding in Drew's playtest on the first proposeTrade).
    let line = '';
    expect(() => {
      line = formatSendLine('proposeTrade', [{ tradeId: 123n }]);
    }).not.toThrow();
    expect(typeof line).toBe('string');
    expect(line).toContain('proposeTrade');
    expect(line, 'the bigint value must be rendered, not dropped').toContain('123');
    expect(line, 'the arg key must survive').toContain('tradeId');
    // §A7 pins the line shape: `-> ${name} ${formatArgs(args)}`.
    expect(
      line.startsWith('-> proposeTrade'),
      `line must start with "-> proposeTrade": ${line}`,
    ).toBe(true);
  });

  it('T-FMT-NESTED: the REAL MoveInput payload renders both tags — Step AND North (never "[Object]")', () => {
    // The real shape from client/src/module_bindings/types.ts:314-321 — a two-level sum type.
    // WRONG IMPL KILLED: a depth-1 (or MAX_DEPTH-capped hand-rolled) formatter. It renders
    // `{"input":"[Object]","seq":"1"}` — which LOOKS fine in a synthetic test and is useless in
    // the one mode ('send-move') that exists to show movement. This is the exact v1 near-miss.
    const line = formatSendLine('enqueueMove', [
      { input: { tag: 'Step', value: { tag: 'North' } }, seq: 1n },
    ]);
    expect(line).toContain('enqueueMove');
    expect(line, 'the outer sum-type tag must render').toContain('Step');
    expect(
      line,
      'the NESTED sum-type tag must render — a depth-capped formatter loses it',
    ).toContain('North');
    expect(line, 'no value may be elided as [Object]').not.toContain('[Object]');
    expect(line, 'the bigint seq must render').toContain('1');
  });

  it('T-FMT-IDENTITY-LIKE: toHexString() is used; a THROWING toISOString() never reaches the formatter', () => {
    // WRONG IMPL KILLED (1): not duck-typing `.toHexString()` — Identity/ConnectionId args would
    // render as `{}` (their fields are private), losing the only identifying information.
    // WRONG IMPL KILLED (2): duck-typing `.toISOString()`/`.toDate()`. Those are PARTIAL on the
    // SDK's Timestamp (they throw RangeError out of range), so calling them turns a debug log
    // into a crash. This asserts the formatter does not call it AND survives if something else does.
    const identityLike = { toHexString: () => '0xc0ffee' };
    const hexLine = formatSendLine('joinGame', [{ owner: identityLike }]);
    expect(hexLine, 'a toHexString()-bearing arg must render as its hex').toContain('0xc0ffee');

    const hostileTimestamp = {
      toISOString(): string {
        throw new RangeError('Invalid time value');
      },
      toDate(): Date {
        throw new RangeError('Invalid time value');
      },
      __micros: 9_223_372_036_854_775_807n,
    };
    let line = '';
    expect(() => {
      line = formatSendLine('scheduleThing', [{ at: hostileTimestamp }]);
    }, 'the formatter must not call the PARTIAL toISOString()/toDate() duck-typed').not.toThrow();
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
  });

  it('T-FMT-TOTAL (examples): hostile args never throw and the line is always capped at MAX_LINE_LEN', () => {
    // WRONG IMPL KILLED (1): removing the outer try/catch — a cyclic object or a throwing
    // getter/toJSON takes down every reducer call while the flag is on.
    // WRONG IMPL KILLED (2): removing the `.slice(0, MAX_LINE_LEN)` cap — one 5000-element
    // array argument dumps a screenful per call and buries the log.
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;
    const throwingGetter = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };
    const throwingToJson = {
      toJSON(): never {
        throw new Error('toJSON exploded');
      },
    };
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 60; i++) deep = { nested: deep };

    const cases: readonly (readonly [string, readonly unknown[]])[] = [
      ['a cyclic object', [cyclic]],
      ['a throwing getter', [throwingGetter]],
      ['a throwing toJSON', [throwingToJson]],
      ['60-deep nesting', [deep]],
      ['a 5000-element array', [new Array(5000).fill('xxxxxxxxxx')]],
      ['undefined', [undefined]],
      ['a symbol', [Symbol('sym')]],
      ['a function', [() => 1]],
      ['NaN / Infinity / -0', [Number.NaN, Number.POSITIVE_INFINITY, -0]],
      ['a Map and a Set', [new Map([['k', 'v']]), new Set([1, 2, 3])]],
      ['a null-prototype object', [Object.create(null) as object]],
      ['no args at all', []],
    ];
    for (const [label, args] of cases) {
      let line = '';
      expect(() => {
        line = formatSendLine('hostile', args);
      }, `formatSendLine must be TOTAL for ${label}`).not.toThrow();
      expect(typeof line, 'formatSendLine must always return a string').toBe('string');
      expect(
        line.length,
        `formatSendLine must cap the line at MAX_LINE_LEN=${MAX_LINE_LEN} (got ${line.length})`,
      ).toBeLessThanOrEqual(MAX_LINE_LEN);
    }
  });

  it('T-FMT-TOTAL (property): for arbitrary args, formatSendLine returns a capped string and never throws', () => {
    // fast-check + vitest gotcha: the predicate below MUST use a block-body arrow. With an
    // expression-body arrow (`(name, args) => expect(...)`), fast-check reads the matcher's
    // return value as the property result and can report a spurious failure.
    const hostile = fc.constantFrom<unknown>(
      undefined,
      null,
      Symbol('s'),
      123n,
      -9_007_199_254_740_993n,
      () => 1,
      { toHexString: () => '0xdeadbeef' },
      {
        get boom(): never {
          throw new Error('getter exploded');
        },
      },
      new Array(2000).fill('y'),
    );
    const anyValue = fc.oneof(
      fc.anything({
        maxDepth: 4,
        maxKeys: 5,
        withBigInt: true,
        withDate: true,
        withMap: true,
        withSet: true,
        withNullPrototype: true,
        withObjectString: true,
        withTypedArray: true,
      }),
      hostile,
    );
    fc.assert(
      fc.property(fc.string(), fc.array(anyValue, { maxLength: 6 }), (name, args) => {
        const line = formatSendLine(name, args);
        expect(typeof line).toBe('string');
        expect(line.length).toBeLessThanOrEqual(MAX_LINE_LEN);
      }),
      { numRuns: 300 },
    );
  });
});

// ===========================================================================
// EARS-1 / EARS-2 — the Proxy seam
// ===========================================================================

describe('devLog Proxy (EARS-2): wrapReducerLogging is identity when disabled', () => {
  it('T-PROXY-IDENTITY: wrapReducerLogging(c, undefined) === c (STRICT identity, zero allocation)', () => {
    // WRONG IMPL KILLED: returning a pass-through Proxy when logging is disabled. A Proxy on
    // the SDK critical path in the DEFAULT production build costs an allocation plus a trap on
    // every property read of every reducer call — and re-opens the `this`-binding hazard for
    // every player, not just the developer with the flag on. EARS-2 requires the disabled path
    // to be structurally free, and only `===` proves it.
    const c = new FakeDbConnection('mr-test');
    expect(wrapReducerLogging(c, undefined)).toBe(c);
  });
});

describe('devLog Proxy (EARS-1): wrapReducerLogging logs and forwards', () => {
  it('T-PROXY-CALLS: the reducer runs once with the same arg, the return value passes through, and the call is logged once', () => {
    // WRONG IMPL KILLED (1): a trap that logs but returns undefined instead of the SDK's
    // promise — every `.catch()` in main.ts (the reducer error path) would throw on undefined.
    // WRONG IMPL KILLED (2): a trap that double-invokes the underlying method (e.g. calls it
    // once to inspect the result and once to return it) — every reducer would fire twice.
    // WRONG IMPL KILLED (3): a trap that re-serialises / clones the args — the identity check
    // on the received argument catches it.
    const c = new FakeDbConnection('mr-test');
    const sentinel = { promiseLike: true };
    c.setTalkResult(sentinel);
    const logged: { name: string; args: readonly unknown[] }[] = [];
    const w = wrapReducerLogging(c, (name, args) => {
      logged.push({ name, args });
    });

    const arg = { x: 1 };
    const returned = w.reducers.talk(arg);

    expect(logged.length, 'exactly one log record per reducer call').toBe(1);
    expect(logged[0].name, 'the logged name must be the reducer name').toBe('talk');
    expect(logged[0].args.length, 'the logged args must be the call arguments').toBe(1);
    expect(logged[0].args[0], 'the logged arg must be the SAME object passed by the caller').toBe(
      arg,
    );

    const calls = c.callLog();
    expect(calls.length, 'the underlying reducer must run EXACTLY once').toBe(1);
    expect(calls[0].arg, 'the underlying reducer must receive the caller argument unchanged').toBe(
      arg,
    );
    expect(returned, 'the return value must pass through IDENTICALLY (the SDK promise)').toBe(
      sentinel,
    );
  });

  it('T-PROXY-CALLS: non-"reducers" properties and non-function reducers properties pass through RAW and UNLOGGED', () => {
    // WRONG IMPL KILLED: a trap that wraps EVERY property (so reading `conn.identity` or
    // `conn.reducers.version` emits a bogus log line, or worse returns a function where the
    // SDK returns data).
    const c = new FakeDbConnection('mr-test');
    const logged: string[] = [];
    const w = wrapReducerLogging(c, (name) => {
      logged.push(name);
    });

    expect(w.label, 'a non-reducers data property must pass through raw').toBe('raw-label');
    expect(w.reducers.version, 'a non-function property ON reducers must pass through raw').toBe(7);
    expect(w.reducers.tag, 'a non-function property ON reducers must pass through raw').toBe(
      'raw-reducers',
    );
    expect(logged, 'reading a property must never emit a log line — only CALLS are logged').toEqual(
      [],
    );
  });

  it('T-PROXY-OWN-PROPS (fixture self-check): the fake reducers object really DOES inherit from Object.prototype', () => {
    // PROOF OF TEETH. The SDK builds `reducers` as a plain `{}` object literal
    // (db_connection_impl.ts:376 — note that #makeDbView at :360 uses Object.create(null),
    // but #makeReducers does NOT), so `toString`, `hasOwnProperty`, `valueOf` and
    // `constructor` are all reachable FUNCTIONS on it. If this fixture were ever "cleaned
    // up" to Object.create(null), the gate below would pass vacuously against a wrapper
    // that still wraps every inherited member on the real SDK object.
    const c = new FakeDbConnection('mr-test');
    expect(
      Object.getPrototypeOf(c.reducers),
      'the fake reducers object must be a plain {} literal inheriting Object.prototype — the ' +
        'SDK shape. An Object.create(null) fake makes T-PROXY-OWN-PROPS vacuous',
    ).toBe(Object.prototype);
    expect(
      Object.hasOwn(c.reducers, 'hasOwnProperty'),
      'hasOwnProperty must be INHERITED on the fake, not an own property',
    ).toBe(false);
    expect(typeof (c.reducers as unknown as Record<string, unknown>).hasOwnProperty).toBe(
      'function',
    );
  });

  it('T-PROXY-OWN-PROPS: INHERITED functions (toString / hasOwnProperty / valueOf / constructor) pass through RAW and are NEVER logged', () => {
    // WRONG IMPL KILLED (red-team Finding 1, reproduced against the real SDK): a reducers
    // `get` trap that tests only `typeof value === 'function'` with no own-property check.
    // Every Object.prototype member is a function, so all of them get wrapped, memoized and
    // LOGGED as if they were game reducers:
    //     wrapped.reducers.hasOwnProperty('enqueueMove')  =>  -> hasOwnProperty ["enqueueMove"]
    //     `${wrapped.reducers}`                           =>  -> toString []
    // That fabricates console lines which look exactly like real player actions — in the one
    // artifact whose entire purpose is to be trusted as a record of what the client sent.
    // It also breaks the "only reducer methods are wrapped" invariant, so a future call site
    // (or any library that probes with hasOwnProperty) silently corrupts the log.
    // The fix is an own-property guard, e.g.
    //     if (!Object.prototype.hasOwnProperty.call(target, prop)) return value;
    // placed BEFORE the wrap/memoize.
    const c = new FakeDbConnection('mr-test');
    const logged: string[] = [];
    const w = wrapReducerLogging(c, (name) => {
      logged.push(name);
    });
    const view = w.reducers as unknown as Record<string, unknown>;

    // (a) IDENTITY: an inherited member must come back as the real Object.prototype
    // function, not a logging wrapper around it.
    expect(
      view.hasOwnProperty,
      'w.reducers.hasOwnProperty must be the REAL Object.prototype.hasOwnProperty — an ' +
        'inherited member must pass through raw, never be wrapped',
    ).toBe(Object.prototype.hasOwnProperty);
    expect(view.toString, 'w.reducers.toString must be the REAL Object.prototype.toString').toBe(
      Object.prototype.toString,
    );
    expect(view.valueOf, 'w.reducers.valueOf must be the REAL Object.prototype.valueOf').toBe(
      Object.prototype.valueOf,
    );
    expect(view.constructor, 'w.reducers.constructor must be the REAL Object constructor').toBe(
      Object,
    );

    // (b) SILENCE: reading them, CALLING them through the view, and implicitly stringifying
    // the view must emit no line at all. (The inherited function is captured and invoked
    // via .call so this stays a genuine call-through-the-wrapper, not an Object.hasOwn
    // shortcut that would bypass the get trap entirely and prove nothing.)
    const inheritedHasOwn = view.hasOwnProperty as (this: unknown, key: string) => boolean;
    expect(
      inheritedHasOwn.call(w.reducers, 'talk'),
      'an inherited member must still WORK when called through the wrapped view',
    ).toBe(true);
    expect(`${w.reducers}`, 'implicit stringification must still work').toBe('[object Object]');
    expect(
      logged,
      'no inherited member may be logged — `-> hasOwnProperty [...]` / `-> toString []` are ' +
        'fabricated lines that look like real player actions in the outbound log',
    ).toEqual([]);

    // (c) POSITIVE CONTROL: the fix must NOT be "pass everything through raw" — an OWN
    // reducer method is still wrapped and still logged.
    w.reducers.talk({ x: 1 });
    expect(
      logged,
      'own reducer methods must still be wrapped and logged — a guard that passes everything ' +
        'through raw would disable the feature entirely',
    ).toEqual(['talk']);
    expect(c.callLog().length, 'and the underlying own method must still run exactly once').toBe(1);
  });

  it('T-PROXY-THIS (fixture self-check): the fake really DOES trip a private-field TypeError under a naive Reflect.get pass-through', () => {
    // PROOF OF TEETH. If this assertion ever stops holding, the FakeDbConnection has lost the
    // SDK shape and T-PROXY-THIS below is VACUOUS (v1's plain-object fake could not detect the
    // defect at all). `naiveWrap` is the exact `Reflect.get(t, p, proxy)` pass-through the plan
    // calls out as insufficient.
    const c = new FakeDbConnection('mr-test');
    expect(c.disconnect(), 'the raw instance works').toBe('disconnected:mr-test');
    expect(
      () => naiveWrap(c).disconnect(),
      'the fake must throw a private-field brand-check TypeError under an unbound pass-through — ' +
        'otherwise the T-PROXY-THIS gate has no teeth',
    ).toThrow(TypeError);
  });

  it('T-PROXY-THIS: regular prototype methods reading #private fields still work through the wrapper, with `this` === the RAW instance', () => {
    // WRONG IMPL KILLED: `Reflect.get(target, prop, proxy)` (or a bare pass-through Proxy) with
    // no `.bind(target)`. The receiver argument only affects ACCESSOR evaluation; a later
    // `obj.method()` still runs with `this === proxy`, and __DbConnectionImpl's real #private
    // fields make that a TypeError in disconnect() / callReducer() / getTablesMap() /
    // registerSubscription() — ONLY when the flag is on, i.e. green in CI and broken in the
    // playtest. The fixture self-check above proves this shape actually bites.
    const c = new FakeDbConnection('mr-test');
    const logged: string[] = [];
    const w = wrapReducerLogging(c, (name) => {
      logged.push(name);
    });

    expect(
      () => w.disconnect(),
      'a #private-reading prototype method must not throw',
    ).not.toThrow();
    expect(w.disconnect()).toBe('disconnected:mr-test');
    expect(
      w.self(),
      '`this` inside a pass-through method must be the RAW instance, not the Proxy — ' +
        '.bind(target) is the only thing that guarantees it for current and future SDK methods',
    ).toBe(c);
    expect(logged, 'a non-reducer method call must not be logged (outbound reducers only)').toEqual(
      [],
    );

    // The arrow-field reducer path must also work (and its side effect must land on the RAW
    // instance's #private state, readable through another #private-reading method).
    expect(() => w.reducers.talk({ x: 5 }), 'the arrow-field reducer must not throw').not.toThrow();
    expect(w.callLog().length, 'the reducer side effect must land on the raw instance').toBe(1);
  });

  it('T-PROXY-THIS: a REGULAR (non-arrow) method on reducers receives the RAW reducers object as `this`', () => {
    // WRONG IMPL KILLED: a reducers wrapper that calls `fn(...args)` instead of
    // `fn.apply(target, args)` (plan §A2). Today's SDK reducers are arrow-function class
    // fields, so the defect is invisible — until any reducers member is a regular method,
    // at which point `this` is undefined in strict mode and every call throws with the flag on.
    const c = new FakeDbConnection('mr-test');
    const w = wrapReducerLogging(c, () => {});
    expect(
      w.reducers.whoAmI(),
      'the reducers wrapper must invoke with fn.apply(rawReducers, args) — `this.tag` must resolve',
    ).toBe('raw-reducers');
  });

  it('T-PROXY-SINK-THROWS: a throwing sink never takes the game down — the reducer still runs and its promise is still returned', () => {
    // WRONG IMPL KILLED: no try/catch around `log(...)`. This sits on the critical path of
    // EVERY reducer call; a sink that throws (a serialisation surprise, a detached console in
    // some browser) would turn a debug aid into a total outage of every outbound action.
    const c = new FakeDbConnection('mr-test');
    const promise = Promise.resolve('reducer-ok');
    c.setTalkResult(promise);
    const w = wrapReducerLogging(c, () => {
      throw new Error('sink exploded');
    });

    let returned: unknown;
    expect(() => {
      returned = w.reducers.talk({ x: 2 });
    }, 'a throwing sink must not propagate out of the reducer call').not.toThrow();
    expect(c.callLog().length, 'the underlying reducer must still run exactly once').toBe(1);
    expect(returned, 'the underlying return value (the SDK promise) must still be returned').toBe(
      promise,
    );
    return expect(returned as Promise<string>).resolves.toBe('reducer-ok');
  });

  it('T-PROXY-STABLE: w.reducers and w.reducers.talk have STABLE identity across reads (no per-read allocation on the movement path)', () => {
    // WRONG IMPL KILLED: building a fresh nested Proxy (or a fresh closure) on every `.reducers`
    // / every property read. main.ts reads `conn.conn.reducers.enqueueMove` ~5x/second while
    // walking; per-read allocation is churn on the hot path, and unstable function identity
    // breaks any `===` comparison or handler-caching a future call site might do.
    const c = new FakeDbConnection('mr-test');
    const w = wrapReducerLogging(c, () => {});
    expect(w.reducers, '.reducers must be the ONE pre-built wrapped object').toBe(w.reducers);
    expect(w.reducers.talk, 'each reducer wrapper must be memoized per name').toBe(w.reducers.talk);
    // And the wrapper must not be the raw function (otherwise nothing is logged at all).
    expect(
      w.reducers.talk,
      'the reducers view must be WRAPPED (a raw pass-through logs nothing)',
    ).not.toBe(c.reducers.talk);
  });
});

// ===========================================================================
// 11r-h — the reducer FATE line (ADR-0172 D2; EARS E5.4/E5.5/E5.6)
//
// A "fate" is the settled outcome of an outbound call. This slice needs exactly one:
// `enqueueMove` REJECTED. The line is INBOUND-facing (`<-`), mirroring formatSendLine's
// outbound `->`, and reuses the same total arg renderer.
// ===========================================================================

/** Non-null-assert a fate logger with a loud message (an `undefined` here is a real failure). */
function requireFateLogger(logger: FateLogger | undefined, level: DevLogLevel): FateLogger {
  if (typeof logger !== 'function') {
    throw new Error(
      `makeFateLogger('${level}', out) must return a FateLogger function (got ${typeof logger}) — ` +
        'only the OFF level may return undefined',
    );
  }
  return logger;
}

describe('devLog fate formatter (E5.5): formatFateLine', () => {
  it('T-FATE-SHAPE: the line is exactly `<- <name> <fate> <args>` — inbound arrow, fate token, rendered args', () => {
    // WRONG IMPL KILLED (1): reusing formatSendLine's `->` prefix. The bug bundle and the
    // console then claim the client SENT a "rejected" call; direction is the one thing a
    // wire log must never lie about.
    // WRONG IMPL KILLED (2): dropping the fate token (a line indistinguishable from a send),
    // or dropping the args (seq/dropped are the entire diagnostic payload of E5.2's
    // breadcrumb companion).
    expect(formatFateLine('enqueueMove', 'rejected', [{ seq: 7, dropped: true }])).toBe(
      '<- enqueueMove rejected [{"seq":7,"dropped":true}]',
    );
    expect(formatFateLine('enqueueMove', 'rejected', [])).toBe('<- enqueueMove rejected []');
  });

  it("T-FATE-SHAPE (shared renderer): the args tail is byte-identical to formatSendLine's, including the hostile fallbacks", () => {
    // WRONG IMPL KILLED: a hand-rolled second arg renderer inside formatFateLine. It would
    // pass every shape assertion above and then throw on a bigint (`Do not know how to
    // serialize a BigInt`) or lose `.toHexString()` — ONLY on the rejection path, i.e. only
    // in Drew's playtest, never in CI. The repo keeps ONE renderer (devLog.ts formatArgs);
    // this is what holds the two call sites on it.
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;
    const argSets: readonly (readonly [string, readonly unknown[]])[] = [
      ['a bigint seq', [{ seq: 12n }]],
      ['an Identity-like arg', [{ owner: { toHexString: () => '0xc0ffee' } }]],
      [
        'the real MoveInput payload',
        [{ input: { tag: 'Step', value: { tag: 'North' } }, seq: 3n }],
      ],
      ['a cyclic object (the <unserializable> fallback)', [cyclic]],
    ];
    for (const [label, args] of argSets) {
      const fate = formatFateLine('enqueueMove', 'rejected', args);
      const send = formatSendLine('enqueueMove', args);
      const fateHead = '<- enqueueMove rejected ';
      const sendHead = '-> enqueueMove ';
      expect(fate.startsWith(fateHead), `${label}: fate line must start with "${fateHead}"`).toBe(
        true,
      );
      expect(
        fate.slice(fateHead.length),
        `${label}: the fate line must render args through the SAME total renderer as formatSendLine`,
      ).toBe(send.slice(sendHead.length));
    }
  });

  it('T-FATE-CAP (examples + property): the line is capped at MAX_LINE_LEN', () => {
    // WRONG IMPL KILLED: dropping the `.slice(0, MAX_LINE_LEN)`. One pathological rejection
    // payload then dumps a screenful into the console the developer turned on to READ.
    const huge = formatFateLine('enqueueMove', 'rejected', [new Array(5000).fill('xxxxxxxxxx')]);
    expect(
      huge.length,
      'a 5000-element arg must be truncated to exactly MAX_LINE_LEN, not merely "be a string"',
    ).toBe(MAX_LINE_LEN);
    const longName = formatFateLine('x'.repeat(4000), 'rejected', []);
    expect(longName.length, 'an absurd reducer NAME must be capped too').toBe(MAX_LINE_LEN);
    const longFate = formatFateLine('enqueueMove', 'y'.repeat(4000), []);
    expect(longFate.length, 'an absurd FATE token must be capped too').toBe(MAX_LINE_LEN);

    // fast-check + vitest gotcha: BLOCK-body arrow only — with an expression-body arrow
    // fast-check reads the matcher's return value as the property result.
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.array(fc.oneof(fc.string({ maxLength: 400 }), fc.integer(), fc.bigInt()), {
          maxLength: 40,
        }),
        (name, fate, args) => {
          const line = formatFateLine(name, fate, args);
          expect(typeof line).toBe('string');
          expect(line.length).toBeLessThanOrEqual(MAX_LINE_LEN);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('T-FATE-TOTAL: hostile args never throw — the diagnostics path may not escalate a rejection', () => {
    // WRONG IMPL KILLED: no try/catch around the serialisation (or a renderer that calls the
    // PARTIAL toISOString()/toDate()). formatFateLine runs inside the enqueueMove `.catch`;
    // a throw there rejects the handler's promise, reaches main.ts's unhandledrejection
    // listener, and turns a silently-corrected movement rejection into a user-visible error
    // overlay — the exact failure E5.1 forbids.
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;
    const throwingGetter = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };
    const throwingToJson = {
      toJSON(): never {
        throw new Error('toJSON exploded');
      },
    };
    const hostileTimestamp = {
      toISOString(): string {
        throw new RangeError('Invalid time value');
      },
      toDate(): Date {
        throw new RangeError('Invalid time value');
      },
    };
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 60; i++) deep = { nested: deep };

    const cases: readonly (readonly [string, readonly unknown[]])[] = [
      ['a cyclic object', [cyclic]],
      ['a throwing getter', [throwingGetter]],
      ['a throwing toJSON', [throwingToJson]],
      ['a Timestamp-like arg with PARTIAL toISOString/toDate', [hostileTimestamp]],
      ['60-deep nesting', [deep]],
      ['undefined', [undefined]],
      ['a symbol', [Symbol('sym')]],
      ['a function', [() => 1]],
      ['NaN / Infinity / -0', [Number.NaN, Number.POSITIVE_INFINITY, -0]],
      ['a Map and a Set', [new Map([['k', 'v']]), new Set([1, 2, 3])]],
      ['a null-prototype object', [Object.create(null) as object]],
      ['no args at all', []],
    ];
    for (const [label, args] of cases) {
      let line = '';
      expect(() => {
        line = formatFateLine('enqueueMove', 'rejected', args);
      }, `formatFateLine must be TOTAL for ${label}`).not.toThrow();
      expect(typeof line, 'formatFateLine must always return a string').toBe('string');
      expect(line.length).toBeLessThanOrEqual(MAX_LINE_LEN);
      expect(line, `the fate line must survive ${label} with its subject intact`).toContain(
        'enqueueMove',
      );
      expect(line, `the fate token must survive ${label}`).toContain('rejected');
    }
  });
});

describe('devLog fate sink (E5.4/E5.6/ADR-0172 D2): makeFateLogger', () => {
  it('T-FATE-OFF-UNDEFINED: makeFateLogger("off", out) === undefined and out is never called', () => {
    // WRONG IMPL KILLED: returning a no-op function at 'off'. main.ts calls the fate logger
    // with `fateLogger?.(...)`; a no-op sink means the default production build formats a
    // line (allocating, serialising player-adjacent args) on every rejection and throws it
    // away — the disabled path must allocate nothing at all, exactly as makeSendLogger's does.
    const { lines, out } = makeOutRecorder();
    expect(
      makeFateLogger('off', out),
      "makeFateLogger('off', out) must return undefined — the disabled path allocates nothing",
    ).toBeUndefined();
    expect(lines, 'the off path must never call out').toEqual([]);
  });

  it('T-FATE-NOT-FILTERED: at level "send", the enqueueMove fate line IS emitted — fates ignore NOISY_REDUCERS', () => {
    // ADR-0172 D2. The asymmetry is deliberate: sends of enqueueMove run ~5/s while walking
    // (hence the NOISY_REDUCERS exclusion at 'send'), but a REJECTION is rare and is precisely
    // the event a developer who turned the log on wants to see.
    // WRONG IMPL KILLED: `makeFateLogger` delegating to shouldLogReducer (the copy-paste of
    // makeSendLogger's body). At the DEFAULT non-off level the one interesting enqueueMove
    // line would then be suppressed unless the developer also opted into the 5/s flood — the
    // filter would suppress signal, not noise.
    // ANTI-VACUITY: the first assertion proves enqueueMove really IS filtered for SENDS, so a
    // pass below cannot come from the fixture picking a non-noisy reducer name.
    expect(
      shouldLogReducer('send', 'enqueueMove'),
      "fixture self-check: 'enqueueMove' must still be a NOISY_REDUCER at level 'send', " +
        'otherwise this gate proves nothing',
    ).toBe(false);

    const send = makeOutRecorder();
    const sendFate = requireFateLogger(makeFateLogger('send', send.out), 'send');
    sendFate('enqueueMove', 'rejected', [{ seq: 4, dropped: false }]);
    expect(
      send.lines.length,
      "level 'send' MUST emit the enqueueMove fate line — fates deliberately bypass the " +
        'noisy-reducer filter that applies to sends (ADR-0172 D2)',
    ).toBe(1);
    expect(send.lines[0]).toContain('enqueueMove');
    expect(send.lines[0]).toContain('rejected');

    const move = makeOutRecorder();
    const moveFate = requireFateLogger(makeFateLogger('send-move', move.out), 'send-move');
    moveFate('enqueueMove', 'rejected', [{ seq: 5, dropped: true }]);
    expect(move.lines.length, "level 'send-move' must emit the fate line too").toBe(1);
  });

  it('T-FATE-SHAPE (sink arm): exactly ONE line per call, byte-identical to formatFateLine', () => {
    // WRONG IMPL KILLED (1): a logger that emits nothing (E5.4 never fires) or emits twice
    // (a double-wired sink double-counts every rejection in the console record).
    // WRONG IMPL KILLED (2): a logger that formats its own divergent line, so the format the
    // gates above pin is not the format the console actually receives.
    const { lines, out } = makeOutRecorder();
    const log = requireFateLogger(makeFateLogger('send', out), 'send');
    log('enqueueMove', 'rejected', [{ seq: 9, dropped: true }]);
    expect(lines.length, 'exactly one line per fate call').toBe(1);
    expect(lines[0]).toBe(formatFateLine('enqueueMove', 'rejected', [{ seq: 9, dropped: true }]));
    log('enqueueMove', 'rejected', [{ seq: 10, dropped: false }]);
    expect(lines.length, 'a second fate call must produce exactly one more line').toBe(2);
  });
});

// ===========================================================================
// 11r-h — the pure breadcrumb rate limit (ADR-0172 D1; EARS E5.3)
//
// Generic arithmetic, no ring/bundle vocabulary and no clock: main.ts owns the ONE
// mutable binding and reads performance.now(); every decision is made here, where it
// can actually be executed by a test (main.ts is coverage-excluded).
//
// SEMANTICS PINNED (plan §R5.2):
//   pending  counts events since the last emit, INCLUSIVE of the current one;
//   suppress iff (the current tick is inside minGapMs of lastMs) OR emitted >= cap;
//   on emit    -> emit.pending = that inclusive count; state = { lastMs: nowMs,
//                 emitted: emitted + 1, pending: 0 };
//   on suppress-> state = { lastMs, emitted, pending: pending + 1 }.
// ===========================================================================

describe('devLog rate limit (E5.3/ADR-0172 D1): rateLimitTick', () => {
  const POLICY: RateLimitPolicy = { minGapMs: 3_000, cap: 16 };

  it('T-THROTTLE-FIRST: the FIRST tick from RATE_LIMIT_INITIAL emits, with pending === 1, at ANY clock reading', () => {
    // WRONG IMPL KILLED: `RATE_LIMIT_INITIAL = { lastMs: 0, ... }`. main.ts feeds
    // performance.now(), which starts near 0 — so with lastMs 0 the FIRST rejection of the
    // session (0 - 0 = 0 < minGapMs) is silently swallowed, and a rejection storm in the first
    // 3 seconds after load leaves the bug bundle with no breadcrumb at all. The initial state
    // must be "infinitely long ago", not "at time zero".
    const first = rateLimitTick(RATE_LIMIT_INITIAL, 0, POLICY);
    expect(first.emit, 'the first tick must EMIT').toBeDefined();
    expect(first.emit?.pending, 'pending is INCLUSIVE of the current event').toBe(1);
    expect(first.state.pending, 'an emit resets the pending counter').toBe(0);
    expect(first.state.emitted, 'an emit increments the session counter').toBe(1);
    expect(first.state.lastMs, 'an emit records the clock reading it emitted at').toBe(0);
    // The emit payload carries ONLY the inclusive count — the caller reads state.emitted for
    // the breadcrumb index. WRONG IMPL KILLED: a second, drift-prone copy of `emitted`.
    expect(
      Object.keys(first.emit ?? {}),
      'emit must carry exactly { pending } — the caller reads state.emitted, so a duplicated ' +
        'emit.emitted is a second source of truth that can drift',
    ).toEqual(['pending']);

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (nowMs) => {
        const r = rateLimitTick(RATE_LIMIT_INITIAL, nowMs, POLICY);
        expect(r.emit).toBeDefined();
        expect(r.emit?.pending).toBe(1);
        expect(r.state.emitted).toBe(1);
        expect(r.state.lastMs).toBe(nowMs);
      }),
      { numRuns: 200 },
    );
  });

  it('T-THROTTLE-GAP: inside minGapMs suppresses; the tick at EXACTLY lastMs + minGapMs emits and carries the accumulated inclusive pending', () => {
    // WRONG IMPL KILLED (1): dropping the gap term entirely (`return emit` always) — a 30 s
    // rubber-band episode then floods the 64-slot error ring and evicts every real crash record.
    // WRONG IMPL KILLED (2): an EXCLUSIVE boundary (`gap > minGapMs`), which makes the emit
    // time drift by one tick forever and is invisible to any non-boundary fixture.
    // WRONG IMPL KILLED (3): resetting `pending` on a SUPPRESSED tick (or counting it
    // exclusively) — the emitted breadcrumb would understate the storm's magnitude, which is
    // the whole reason the count is carried at all.
    const emitted1 = rateLimitTick(RATE_LIMIT_INITIAL, 1_000, POLICY);
    expect(emitted1.emit).toBeDefined();

    const inside = rateLimitTick(emitted1.state, 2_000, POLICY);
    expect(inside.emit, 'a tick 1000ms after an emit (minGapMs=3000) must be SUPPRESSED').toBe(
      undefined,
    );
    expect(inside.state.pending, 'a suppressed tick still counts').toBe(1);
    expect(inside.state.lastMs, 'a suppressed tick must NOT move the gap window').toBe(1_000);
    expect(inside.state.emitted, 'a suppressed tick must NOT consume the session cap').toBe(1);

    const alsoInside = rateLimitTick(inside.state, 3_999, POLICY);
    expect(alsoInside.emit, '2999ms after the emit is still inside the gap').toBe(undefined);
    expect(alsoInside.state.pending).toBe(2);

    const atBoundary = rateLimitTick(alsoInside.state, 4_000, POLICY);
    expect(
      atBoundary.emit,
      'nowMs - lastMs === minGapMs is INCLUSIVE — exactly at the boundary the tick must EMIT',
    ).toBeDefined();
    expect(
      atBoundary.emit?.pending,
      'the emitted count must carry the two suppressed events PLUS the current one (inclusive)',
    ).toBe(3);
    expect(atBoundary.state.pending).toBe(0);
    expect(atBoundary.state.lastMs).toBe(4_000);
    expect(atBoundary.state.emitted).toBe(2);
  });

  it('T-THROTTLE-CAP: emitted === cap - 1 emits; emitted === cap suppresses forever (even on a backwards clock)', () => {
    // WRONG IMPL KILLED (1): dropping the `emitted < cap` term. A long session of rejections
    // then owns the whole 64-slot ring; the cap is what guarantees >= 48 slots stay available
    // for genuine crash records (ADR-0172 D1).
    // WRONG IMPL KILLED (2): an off-by-one cap (`emitted > cap`, or `>=` on cap - 1) — the
    // last legitimate breadcrumb is lost, or one extra lands.
    const atCapMinusOne: RateLimitState = { lastMs: 0, emitted: POLICY.cap - 1, pending: 0 };
    const last = rateLimitTick(atCapMinusOne, 1_000_000, POLICY);
    expect(last.emit, 'the cap-th breadcrumb (emitted === cap - 1) must still EMIT').toBeDefined();
    expect(last.state.emitted).toBe(POLICY.cap);

    const over = rateLimitTick(last.state, 2_000_000, POLICY);
    expect(over.emit, 'at emitted === cap the gap no longer matters — SUPPRESS').toBe(undefined);
    expect(over.state.emitted, 'a suppressed tick must not grow the counter past the cap').toBe(
      POLICY.cap,
    );
    expect(over.state.pending, 'post-cap events are still counted').toBe(1);

    const muchLater = rateLimitTick(over.state, 900_000_000, POLICY);
    expect(muchLater.emit, 'the cap is a SESSION cap — no amount of elapsed time reopens it').toBe(
      undefined,
    );
    expect(muchLater.state.pending).toBe(2);

    // The cap term is an OR with the gap term, so the backwards-clock relaxation (below)
    // applies to the GAP only: a non-monotonic jump must never reopen an exhausted cap.
    const backwards = rateLimitTick(muchLater.state, 5, POLICY);
    expect(backwards.emit, 'a clock jump must not resurrect an exhausted session cap').toBe(
      undefined,
    );
    expect(backwards.state.pending).toBe(3);
  });

  it('T-THROTTLE-BACKWARDS-CLOCK: a nowMs BELOW lastMs emits — a non-monotonic jump must never suppress forever', () => {
    // WRONG IMPL KILLED: the naive `if (nowMs - state.lastMs < minGapMs) suppress`. A single
    // backwards clock reading (a clock the shell does not fully control: a resumed tab, a
    // remounted timer origin, a future caller passing Date.now()) makes the difference
    // NEGATIVE, i.e. permanently "inside the gap" — movement diagnostics then go dark for the
    // rest of the session and no test that only walks time FORWARDS can ever see it.
    const state: RateLimitState = { lastMs: 10_000, emitted: 1, pending: 0 };
    const jumped = rateLimitTick(state, 500, POLICY);
    expect(jumped.emit, 'a backwards clock jump must EMIT, not suppress').toBeDefined();
    expect(jumped.emit?.pending).toBe(1);
    expect(jumped.state.lastMs, 'the jump must re-anchor the gap window on the new reading').toBe(
      500,
    );
    expect(jumped.state.emitted).toBe(2);

    // ...and normal throttling resumes from the new anchor (the fix must not be "always emit").
    const after = rateLimitTick(jumped.state, 600, POLICY);
    expect(after.emit, 'after re-anchoring, the gap must apply again from the new lastMs').toBe(
      undefined,
    );
    expect(after.state.pending).toBe(1);
  });

  it('T-THROTTLE-PURE: rateLimitTick mutates nothing — the input state and RATE_LIMIT_INITIAL survive unchanged', () => {
    // WRONG IMPL KILLED: an in-place transition (`state.pending += 1; return { state, ... }`).
    // main.ts holds ONE module-scope binding reassigned from the result; an in-place mutation
    // silently corrupts the shared RATE_LIMIT_INITIAL constant for every later reader and
    // makes the "pure transition" claim (the reason this logic left main.ts) false.
    const state: RateLimitState = { lastMs: 1_000, emitted: 2, pending: 5 };
    const before = { ...state };
    const emitResult = rateLimitTick(state, 9_000, POLICY);
    expect({ ...state }, 'the EMIT path must not mutate its input state').toEqual(before);
    expect(emitResult.state, 'the transition must return a NEW state object').not.toBe(state);

    const suppressResult = rateLimitTick(state, 1_500, POLICY);
    expect({ ...state }, 'the SUPPRESS path must not mutate its input state either').toEqual(
      before,
    );
    expect(suppressResult.state, 'the suppress path must also return a NEW state object').not.toBe(
      state,
    );

    const initialBefore = { ...RATE_LIMIT_INITIAL };
    rateLimitTick(RATE_LIMIT_INITIAL, 50, POLICY);
    rateLimitTick(RATE_LIMIT_INITIAL, 50, POLICY);
    expect(
      { ...RATE_LIMIT_INITIAL },
      'RATE_LIMIT_INITIAL is a shared module constant — ticking it must never move it',
    ).toEqual(initialBefore);
    expect(rateLimitTick(RATE_LIMIT_INITIAL, 50, POLICY).state).not.toBe(RATE_LIMIT_INITIAL);
  });

  it('T-THROTTLE-CONSERVATION (property): no event is ever lost — sum of emitted pending + final pending === tick count', () => {
    // WRONG IMPL KILLED: any counter bookkeeping that drops events — resetting `pending` on a
    // suppressed tick, forgetting to reset it on an emit (double-counting), or reporting the
    // count EXCLUSIVE of the current event. The carried count is the only record of a storm's
    // magnitude once the breadcrumbs are throttled, so "the numbers add up" IS the invariant.
    // The cap is deliberately set out of reach here (cap = ticks + 1); T-THROTTLE-CAP owns the
    // post-cap behaviour.
    // fast-check + vitest gotcha: BLOCK-body arrow only.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5_000, max: 20_000 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 5_000 }),
        (deltas, minGapMs) => {
          const policy: RateLimitPolicy = { minGapMs, cap: deltas.length + 1 };
          // Annotated (not inferred) so a literal-typed `as const` initial state stays legal.
          let state: RateLimitState = RATE_LIMIT_INITIAL;
          let nowMs = 0;
          let carried = 0;
          let emits = 0;
          for (const delta of deltas) {
            nowMs += delta;
            const result = rateLimitTick(state, nowMs, policy);
            if (result.emit !== undefined) {
              carried += result.emit.pending;
              emits += 1;
            }
            state = result.state;
          }
          expect(carried + state.pending).toBe(deltas.length);
          expect(state.emitted).toBe(emits);
          expect(state.emitted).toBeLessThanOrEqual(policy.cap);
        },
      ),
      { numRuns: 300 },
    );
  });
});
