// net/devLog.ts — dev-console outbound reducer log (ADR-0157, slice dev-observability).
//
// ZERO runtime imports by design (gated by evals/dev-observability-gating.eval.mjs, E1):
// a module that imports nothing at run time cannot reach the eventRing / errorRing /
// bugBundle, so a reducer argument — joinGame({name}), setNickname({nickname}),
// setProfileName({name}) all carry player free text — can never land in the shared,
// downloadable F9 bug bundle (pt-b1 U-3; ADR-0157 §4, revisit only under obs-e). It also
// cannot drag a dependency into the production bundle (spec criterion 2).
//
// The sink is INJECTED, never owned here: main.ts passes `(line) => console.log(line)` —
// console.log, NOT console.debug (Chrome hides debug behind the Verbose level, so the
// feature would read as broken). That injection is also what keeps this whole module
// unit-testable with no globals and no SDK.

/** Line cap. Mirrors ERROR_MSG_MAX_LEN (client/src/ui/errorRing.ts:12) so the repo keeps
 *  ONE truncation rule (the ADR-0130 discipline reuse of ADR-0157 §4). */
export const MAX_LINE_LEN = 512;

export type DevLogLevel = 'off' | 'send' | 'send-move';

/** The injected outbound sink: called once per LOGGED reducer call. */
export type SendLogger = (reducerName: string, args: readonly unknown[]) => void;

/** The accepted token set — the single source for the parser's rejection message. */
const DEV_LOG_LEVELS: readonly DevLogLevel[] = ['off', 'send', 'send-move'];

/** Excluded at 'send' (~5 calls/second while walking), included at 'send-move' (§A4). */
const NOISY_REDUCERS: ReadonlySet<string> = new Set(['enqueueMove']);

/**
 * Parse the `VITE_MR_DEVLOG` token. Pure, trim + lowercase, unset/empty ⇒ 'off'.
 * Reject-don't-clamp: an unknown token THROWS, naming the accepted set, so a
 * misconfiguration can never masquerade as "the feature is broken" (§A3/§A5).
 */
export function parseDevLogLevel(raw: string | undefined): DevLogLevel {
  switch ((raw ?? '').trim().toLowerCase()) {
    case '':
    case 'off':
      return 'off';
    case 'send':
      return 'send';
    case 'send-move':
      return 'send-move';
    default:
      throw new Error(
        `VITE_MR_DEVLOG=${JSON.stringify(raw)} is not a recognised level — accepted: ` +
          DEV_LOG_LEVELS.join(' | '),
      );
  }
}

/**
 * Shell-facing resolver with the fail-loud asymmetry INVERTED relative to pt-a1's
 * resolveConnectionConfig (§A3, ADR-0157 §2): rethrow in DEV, degrade to 'off' plus exactly
 * one call to the INJECTED `warn` sink in PROD (main.ts wires that sink to console.error —
 * this module never names a sink of its own). The eager resolve sits at main.ts module
 * scope, BEFORE the onerror / unhandledrejection listeners are registered, so a throw there
 * would blank the whole playtest session and kill the F9 bug-bundle path built to diagnose
 * exactly that. Fail loud where it is free; degrade safely where it is expensive.
 */
export function resolveDevLogLevel(
  raw: string | undefined,
  isDev: boolean,
  /** The misconfiguration sink. Injected — main.ts passes console.error. */
  warn: (msg: string) => void,
): DevLogLevel {
  try {
    return parseDevLogLevel(raw);
  } catch (err) {
    if (isDev) throw err;
    warn(`${(err as Error).message} — the outbound dev log stays off for this build`);
    return 'off';
  }
}

/** Level policy. Exhaustive switch: adding a union member is a compile error here. */
export function shouldLogReducer(level: DevLogLevel, name: string): boolean {
  switch (level) {
    case 'off':
      return false;
    case 'send':
      return !NOISY_REDUCERS.has(name);
    case 'send-move':
      return true;
  }
}

/**
 * The repo's EXISTING bigint-total answer (bugBundle.ts:67), plus `toHexString()` which is
 * TOTAL on Identity/ConnectionId (their fields are private, so they would otherwise render
 * as `{}`). `toISOString()`/`toDate()` are deliberately NOT duck-typed: they are PARTIAL on
 * the SDK's Timestamp (RangeError out of range), so calling them would turn a debug line
 * into a crash (§A7 / ADR-0157 §5).
 */
function devLogReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  const hex = (value as { toHexString?: () => string } | null | undefined)?.toHexString;
  if (typeof hex === 'function') return hex.call(value);
  return value;
}

/** TOTAL: the try/catch is the totality guarantee (cycles, throwing getters, throwing
 *  toJSON). JSON.stringify handles arbitrary NESTING natively, which is what keeps
 *  enqueueMove's two-level sum-type payload legible instead of `[Object]`. */
function formatArgs(args: readonly unknown[]): string {
  try {
    return JSON.stringify(args, devLogReplacer);
  } catch {
    return '<unserializable>';
  }
}

/** One outbound line: `-> <reducerName> <args>`, capped at MAX_LINE_LEN. */
export function formatSendLine(name: string, args: readonly unknown[]): string {
  return `-> ${name} ${formatArgs(args)}`.slice(0, MAX_LINE_LEN);
}

/**
 * The sink factory. Returns `undefined` at level 'off' so the disabled path allocates
 * nothing at all — that undefined is what makes `wrapReducerLogging` strict identity in
 * the default production build (spec criterion 2).
 */
export function makeSendLogger(
  level: DevLogLevel,
  out: (line: string) => void,
): SendLogger | undefined {
  if (level === 'off') return undefined;
  return (reducerName, args) => {
    if (!shouldLogReducer(level, reducerName)) return;
    out(formatSendLine(reducerName, args));
  };
}

/** The ONE wrapped reducers view, built once per wrap; per-name method wrappers are
 *  memoized so `w.reducers.enqueueMove` has stable identity across the movement hot path
 *  (~5 reads/second). Non-function properties pass through raw and unlogged. */
function wrapReducers(rawReducers: object, log: SendLogger): object {
  // ASSUMPTION (true today): every OWN property of `rawReducers` is set once and never
  // reassigned — the SDK builds the object in #makeReducers and assigns `reducers` once in
  // the __DbConnectionImpl constructor (db_connection_impl.ts:316/376). The memo captures
  // `value` at first read, so a later reassignment would keep invoking the stale closure.
  const memo = new Map<PropertyKey, unknown>();
  return new Proxy(rawReducers, {
    get(target, prop): unknown {
      const value = Reflect.get(target, prop, target);
      // INHERITED members pass through RAW and unlogged. The SDK builds `reducers` as a
      // plain `{}` literal (db_connection_impl.ts:376 — #makeDbView at :360 uses
      // Object.create(null), #makeReducers does not), so toString / hasOwnProperty /
      // valueOf / constructor are all reachable FUNCTIONS. A typeof-only test would wrap
      // them and fabricate lines like `-> hasOwnProperty ["enqueueMove"]` in the one
      // artifact whose whole purpose is to be a trustworthy record of what the client sent.
      if (!Object.hasOwn(target, prop)) return value;
      if (typeof value !== 'function') return value;
      const cached = memo.get(prop);
      if (cached !== undefined) return cached;
      const wrapped = (...args: unknown[]): unknown => {
        try {
          log(String(prop), args);
        } catch {
          // A throwing sink must NEVER take the game down: this sits on the critical
          // path of every outbound reducer call (§A2, anti-pattern #3).
        }
        // .apply(target, …) so a REGULAR (non-arrow) reducers member still gets its
        // `this`; today's SDK reducers are lexically-bound arrow class fields.
        return value.apply(target, args);
      };
      memo.set(prop, wrapped);
      return wrapped;
    },
  });
}

/**
 * Install the outbound log at the connection seam. STRICT IDENTITY when `log` is
 * undefined — the default production build allocates no Proxy and pays no trap.
 *
 * Generic over `T extends object` so this module needs no runtime import of DbConnection.
 *
 * The `get` trap returns every non-`reducers` FUNCTION property `.bind(target)`.
 * `Reflect.get(target, prop, target)` alone does NOT fix `this` for a later `obj.method()`
 * call — the receiver argument only affects accessor evaluation — and __DbConnectionImpl
 * has real `#private` fields read by regular prototype methods (disconnect, callReducer,
 * getTablesMap, registerSubscription), so an unbound pass-through throws a private-field
 * brand-check TypeError, and ONLY when the flag is on (§A2, anti-pattern #2).
 */
export function wrapReducerLogging<T extends object>(target: T, log: SendLogger | undefined): T {
  if (log === undefined) return target;
  const reducersView = wrapReducers(Reflect.get(target, 'reducers') as object, log);
  return new Proxy(target, {
    get(t, prop): unknown {
      if (prop === 'reducers') return reducersView;
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}
