// @vitest-environment happy-dom
/**
 * main.protocolCheck.test.ts: the booted client refuses a server it cannot speak to and names the
 * side that must update.
 *
 * Every case but the session-overlay one boots the REAL main.ts over the real client/index.html
 * shell, with the REAL `connect()` (`vi.importActual`) over a faked SDK builder: each build records
 * every subscribe (the `module_info` gate among them), every reducer call, its lifecycle callbacks,
 * its `disconnect()` calls and a `db.moduleInfo` cache the test fills. The client's protocol is the
 * wasm pkg's `protocol_version` export (`wasmPkgWalkingMock({ protocolVersion })`), so what
 * main.ts hands `connect()` is the export's number. The test opens a build (`onConnect`), answers
 * its gate (applied over chosen rows, or refused), drives frames on the harness clock so the live
 * region's pump runs, and reads `#status`, every write to `#a11y-live`, and what the SDK saw.
 *
 * The session-overlay case runs on the recording connection: a session terminal cannot be reached
 * over the real connection from this page (its continue and retry actions need a live link), so it
 * raises the two terminals through the options main.ts handed `connect()`.
 *
 * Harness: main.targetKindGate.test.ts's whole-page boot (vi.resetModules + a fresh import per
 * boot, window / document listeners recorded and detached in teardown after a `pagehide` ends the
 * real connection), main.zoneCue.test.ts's write recorder on `#a11y-live`. Every expected line is
 * typed here, never read off the catalogs under test; French accents are built by code point.
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { Connection, ConnectionOptions } from './net/connection';
import { SHELL_CONFIG_GLOBAL, type ShellDocument } from './net/shellDocument';

const H = vi.hoisted(() => ({
  identity: 'cd'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What the wasm pkg's `protocol_version()` answers for the next boot. */
  protocolVersion: 1,
  /** The REAL `connect`, put here before a whole-page boot; null: the recording connection. */
  realConnect: null as ((opts: ConnectionOptions) => Connection) | null,
  realConn: null as Connection | null,
  /** Every DbConnection the real `connect()` built through the faked SDK builder. */
  sdkBuilds: [] as SdkBuild[],
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgWalkingMock({ interact: () => [], protocolVersion: () => H.protocolVersion }),
);

// The connection: the REAL connect() while H.realConnect is set, else the recording connection.
vi.mock('./net/connection', () => {
  const recording = connectionRecordingMock(H);
  return {
    connect: (opts: ConnectionOptions): Connection => {
      const real = H.realConnect;
      if (real !== null) {
        H.connectOpts = opts;
        H.realConn = real(opts);
        return H.realConn;
      }
      return recording.connect(opts);
    },
  };
});

// The SDK's DbConnection builder for the real connect(). The built connection is what the SDK
// hands onConnect (the test passes `build.conn`).
vi.mock('./module_bindings', () => {
  /** Never a thenable: an awaited table or reducer set must not hang on a `then` the Proxy made. */
  const noThen = (k: string | symbol): boolean => k === 'then';
  const emptyTable = () =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (noThen(k)) return undefined;
          if (k === 'iter') return () => [][Symbol.iterator]();
          return () => undefined;
        },
      },
    );
  return {
    DbConnection: {
      builder: () => {
        const rec: SdkBuild = {
          token: 'UNSET',
          subs: [],
          reducerCalls: [],
          disconnects: 0,
          moduleInfo: { rows: [], insert: [], update: [], delete: [] },
        };
        H.sdkBuilds.push(rec);
        const mi = rec.moduleInfo;
        const moduleInfoTable = {
          iter: () => [...mi.rows][Symbol.iterator](),
          count: () => mi.rows.length,
          onInsert: (cb: SdkCallback) => {
            mi.insert.push(cb);
          },
          onUpdate: (cb: SdkCallback) => {
            mi.update.push(cb);
          },
          onDelete: (cb: SdkCallback) => {
            mi.delete.push(cb);
          },
          removeOnInsert: () => undefined,
          removeOnUpdate: () => undefined,
          removeOnDelete: () => undefined,
        };
        const subscriptionBuilder = () => {
          const sub: SdkSub = { query: undefined };
          const builder = {
            onApplied: (cb: SdkCallback) => {
              sub.onApplied = cb;
              return builder;
            },
            onError: (cb: SdkCallback) => {
              sub.onError = cb;
              return builder;
            },
            subscribe: (query: unknown) => {
              sub.query = query;
              rec.subs.push(sub);
              return { isActive: () => true, unsubscribe: () => undefined };
            },
          };
          return builder;
        };
        const conn = {
          db: new Proxy(
            {},
            {
              get: (_t, k) => {
                if (noThen(k)) return undefined;
                return k === 'moduleInfo' || k === 'module_info' ? moduleInfoTable : emptyTable();
              },
            },
          ),
          reducers: new Proxy(
            {},
            {
              get: (_t, k) =>
                noThen(k)
                  ? undefined
                  : (args: unknown) => {
                      rec.reducerCalls.push({ name: String(k), args });
                      return Promise.resolve();
                    },
            },
          ),
          subscriptionBuilder,
          disconnect: () => {
            rec.disconnects += 1;
          },
        };
        rec.conn = conn;
        const b = {
          withUri: () => b,
          withDatabaseName: () => b,
          withToken: (t: unknown) => {
            rec.token = t;
            return b;
          },
          onConnect: (cb: SdkCallback) => {
            rec.onConnect = cb;
            return b;
          },
          onConnectError: (cb: SdkCallback) => {
            rec.onConnectError = cb;
            return b;
          },
          onDisconnect: (cb: SdkCallback) => {
            rec.onDisconnect = cb;
            return b;
          },
          build: () => conn,
        };
        return b;
      },
    },
  };
});

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

type SdkCallback = (...args: unknown[]) => void;
/** One subscribe call on a built connection. */
interface SdkSub {
  query: unknown;
  onApplied?: SdkCallback;
  onError?: SdkCallback;
}
interface ModuleInfoRow {
  id: number;
  protocol: number;
  minClientProtocol: number;
}
/** One DbConnection the real `connect()` built through the faked SDK builder. */
interface SdkBuild {
  token: unknown;
  conn?: unknown;
  onConnect?: SdkCallback;
  onConnectError?: SdkCallback;
  onDisconnect?: SdkCallback;
  /** Every subscribe, in order, the `module_info` gate included. */
  readonly subs: SdkSub[];
  /** Every reducer call, in order. */
  readonly reducerCalls: Array<{ name: string; args: unknown }>;
  disconnects: number;
  readonly moduleInfo: {
    rows: ModuleInfoRow[];
    readonly insert: SdkCallback[];
    readonly update: SdkCallback[];
    readonly delete: SdkCallback[];
  };
}

// --- the lines under test, typed (never read off the catalogs) -------------------------------
const E_ACUTE = String.fromCharCode(0x00e9);
const A_GRAVE = String.fromCharCode(0x00e0);
const O_CIRCUMFLEX = String.fromCharCode(0x00f4);
const NBSP = String.fromCharCode(0x00a0);
const NEWER_EN = 'This server runs a newer Monster Realm. Update the game to join.';
const OLDER_EN = 'This server runs an older Monster Realm. Its host must update it.';
const NEWER_FR = `Ce serveur utilise une version plus r${E_ACUTE}cente de Monster Realm. Mettez le jeu ${A_GRAVE} jour pour le rejoindre.`;
const OLDER_FR = `Ce serveur utilise une version plus ancienne de Monster Realm. Son h${O_CIRCUMFLEX}te doit le mettre ${A_GRAVE} jour.`;
/** The bug-bundle blocked hint (download-blocked), as main.ts reports it. */
const BUG_BUNDLE_BLOCKED_EN = 'bug bundle: download blocked — copy from console';
const GATE_QUERY = 'SELECT * FROM module_info';

/** A friends-server target: sign-in off, so no OIDC client and no request. */
const DOC: ShellDocument = {
  connection: { uri: 'wss://gate.example:4443/', db: 'realm-gate', kind: 'local' },
};

// --- harness ---------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** main.ts registers window/document listeners at MODULE scope: record each so teardown can detach
 *  it, or a second import leaves a live handler from a dead module instance. */
function recordListeners(target: EventTarget): void {
  const own = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target);
  (target as unknown as { addEventListener: typeof original }).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    recorded.push({ target, type, handler, options });
    original(type, handler, options);
  };
  restorers.push(() => {
    if (own !== undefined) Object.defineProperty(target, 'addEventListener', own);
    else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
  });
}

/** Every value written to #a11y-live's textContent, oldest first: everything it ever said. */
let liveWrites: string[] = [];

/** Wrap `node`'s own `textContent` setter so every write lands in `sink`, then the real one. */
function recordWrites(node: HTMLElement, sink: string[]): void {
  let proto: object | null = Object.getPrototypeOf(node);
  let accessor: PropertyDescriptor | undefined;
  while (proto !== null && accessor === undefined) {
    accessor = Object.getOwnPropertyDescriptor(proto, 'textContent');
    proto = Object.getPrototypeOf(proto);
  }
  const get = accessor?.get;
  const set = accessor?.set;
  if (get === undefined || set === undefined) throw new Error('textContent is not an accessor');
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get() {
      return get.call(this);
    },
    set(value: unknown) {
      sink.push(String(value));
      set.call(this, value);
    },
  });
}

const byId = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`#${id} is not in the document`);
  return node;
};
const statusText = (): string => byId('status').textContent ?? '';

let consoleError: MockInstance<typeof console.error> | undefined;
/** The page clock: every frame and key press moves it forward. */
let T = 1000;

/** Run frames every `stepMs` (default 50 ms) for `ms` of clock. */
function frames(ms: number, stepMs = 50): void {
  const end = T + ms;
  while (T < end) {
    T += stepMs;
    frame(T);
  }
}

/** One key press and its release on `window` (the accelerators' and the router's target). */
function press(code: string): void {
  T += 5;
  clock.t = T;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  T += 5;
  clock.t = T;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** The real connect()'s `index`th build, waited for on real timers. */
function sdkBuild(index: number): Promise<SdkBuild> {
  return vi.waitFor(
    () => {
      const build = H.sdkBuilds[index];
      if (build === undefined) throw new Error(`build ${index} not reached yet`);
      return build;
    },
    { timeout: 5_000, interval: 5 },
  );
}

/** Boot a fresh main.ts that speaks `protocolVersion`, under `search` (e.g. `?locale=fr`); `real`
 *  puts the REAL connect() under it. Resolves once connect() was called, the frame loop is armed
 *  and the boot's own announcements have been pumped. */
async function boot(protocolVersion: number, search = '', real = true): Promise<void> {
  H.protocolVersion = protocolVersion;
  if (real) {
    const { connect } =
      await vi.importActual<typeof import('./net/connection')>('./net/connection');
    H.realConnect = connect;
  }
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', `/${search}`);
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: unknown, _init?: unknown) =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    ),
  );
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = DOC;
  T = 1000;
  clock.t = T;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  recorded = [];
  mountIndexHtmlShell();
  liveWrites = [];
  recordWrites(byId('a11y-live'), liveWrites);
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('./main');
  await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
    },
    { timeout: 5_000, interval: 5 },
  );
  await vi.waitFor(
    () => {
      if (raf.cb === null) throw new Error('the frame loop is not armed yet');
    },
    { timeout: 5_000, interval: 5 },
  );
  // Whatever the boot itself says is said before the server answers.
  frames(2_000);
}

/** The SDK opens build `b`'s socket: onConnect with the built connection. */
function open(b: SdkBuild): void {
  b.onConnect?.(b.conn, { toHexString: () => H.identity }, 'lpw4-anon-token');
}
/** Build `b`'s subscribes other than the gate. */
const otherSubs = (b: SdkBuild): SdkSub[] => b.subs.filter((sub) => sub.query !== GATE_QUERY);
/** Build `b`'s one gate subscribe (failing readably when there is not exactly one). */
function gateOf(b: SdkBuild): SdkSub {
  const gates = b.subs.filter((sub) => sub.query === GATE_QUERY);
  expect(gates, 'onConnect subscribed module_info once').toHaveLength(1);
  return gates[0];
}
/** The server answers the gate: applied, with `rows` in the cache. */
function answer(b: SdkBuild, rows: ModuleInfoRow[]): void {
  const gate = gateOf(b);
  b.moduleInfo.rows = rows;
  gate.onApplied?.({});
}
/** The server refuses the gate, as a module that has no module_info table does. */
function refuse(b: SdkBuild): void {
  gateOf(b).onError?.({ event: new Error('no such table: module_info') });
}

/** What the SDK saw on build `b`: nothing subscribed but the gate, no reducer call at all. */
function expectSilent(b: SdkBuild, label: string): void {
  expect(
    b.subs.map((sub) => sub.query),
    `${label}: no subscribe but the gate`,
  ).toEqual([GATE_QUERY]);
  expect(b.reducerCalls, `${label}: no reducer call`).toEqual([]);
}

/** End the real connection while its listeners are still attached: no timer outlives the case. */
function endRealConnection(): void {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  H.realConnect = null;
  H.realConn = null;
}

beforeEach(() => {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.protocolVersion = 1;
  H.realConnect = null;
  H.realConn = null;
  H.sdkBuilds = [];
  consoleError = undefined;
});

afterEach(() => {
  endRealConnection();
  delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

describe('the booted client refuses a server it cannot speak to (lpw-4)', () => {
  // --------------------------------------------------------------------------- a newer server
  it('shows the update-the-game line and sends nothing when the server floor is above the client, also after movement and action keys and more frames [lpw-4.1]', async () => {
    // WRONG IMPL KILLED: main.ts passing no clientProtocol (an undefined number is judged an
    // older server) or a literal; the two message ids swapped; the line routed to the toast; a
    // refused connection left live so a key press still sends.
    await boot(2);
    const b = await sdkBuild(0);
    open(b);
    expect(otherSubs(b), 'before the verdict: the gate alone').toEqual([]);
    answer(b, [{ id: 0, protocol: 5, minClientProtocol: 3 }]);
    frames(1_000);
    expect(statusText()).toBe(NEWER_EN);
    expectSilent(b, 'after the refusal');
    // Movement (Right, Down) and the world's A action (Enter): each sends in a joined session.
    for (const code of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'KeyD', 'Enter']) {
      press(code);
      frames(300);
    }
    frames(2_000);
    expectSilent(b, 'after key presses and frames');
    expect(statusText(), 'the line still stands').toBe(NEWER_EN);
    expect(H.sdkBuilds, 'one connection').toHaveLength(1);
  }, 30_000);

  it('refuses a client booted with protocol 2 against a server of protocol 4 and floor 3, with the update-the-game line [lpw-4.1]', async () => {
    // The admitting half of this pair is the protocol-3 case below: the same server admits a client
    // booted with protocol 3, so the verdict follows the wasm export, not a number main.ts typed.
    await boot(2);
    const b = await sdkBuild(0);
    open(b);
    answer(b, [{ id: 0, protocol: 4, minClientProtocol: 3 }]);
    frames(1_000);
    expect(statusText()).toBe(NEWER_EN);
    expectSilent(b, 'client 2, floor 3');
  }, 30_000);

  // --------------------------------------------------------------------------- an older server
  it('shows the host-must-update line and sends nothing when the server protocol is below the client [lpw-4.2]', async () => {
    await boot(3);
    const b = await sdkBuild(0);
    open(b);
    answer(b, [{ id: 0, protocol: 2, minClientProtocol: 1 }]);
    frames(1_000);
    expect(statusText()).toBe(OLDER_EN);
    expectSilent(b, 'protocol 2 below client 3');
  }, 30_000);

  it('shows the host-must-update line and sends nothing when module_info applies with no row [lpw-4.2]', async () => {
    await boot(1);
    const b = await sdkBuild(0);
    open(b);
    answer(b, []);
    frames(1_000);
    expect(statusText()).toBe(OLDER_EN);
    expectSilent(b, 'no row');
  }, 30_000);

  it('shows the host-must-update line and sends nothing when the server refuses the module_info subscription [lpw-4.2]', async () => {
    await boot(1);
    const b = await sdkBuild(0);
    open(b);
    refuse(b);
    frames(1_000);
    expect(statusText()).toBe(OLDER_EN);
    expectSilent(b, 'the gate refused');
  }, 30_000);

  // --------------------------------------------------------------------------- admitted
  it('opens the base set and joins when the server numbers equal the client protocol, and shows neither mismatch line [lpw-4.3]', async () => {
    await boot(2);
    const b = await sdkBuild(0);
    open(b);
    answer(b, [{ id: 0, protocol: 2, minClientProtocol: 2 }]);
    const base = otherSubs(b)[0];
    expect(Array.isArray(base?.query), 'the base set opened after the gate').toBe(true);
    expect(base?.query as readonly string[], 'its 30 queries').toHaveLength(30);
    base?.onApplied?.({});
    frames(1_000);
    expect(
      b.reducerCalls.filter((call) => call.name === 'joinGame'),
      'joined once',
    ).toHaveLength(1);
    expect(statusText()).not.toBe(NEWER_EN);
    expect(statusText()).not.toBe(OLDER_EN);
    expect(b.disconnects, 'the connection stays open').toBe(0);
  }, 30_000);

  it('admits a client booted with protocol 3 against a server of protocol 4 and floor 3, and joins [lpw-4.3]', async () => {
    // WRONG IMPL KILLED: main.ts handing connect() a literal protocol (1 or 2 is refused here, as
    // the protocol-2 case above shows for 2) instead of the wasm export's number.
    await boot(3);
    const b = await sdkBuild(0);
    open(b);
    answer(b, [{ id: 0, protocol: 4, minClientProtocol: 3 }]);
    const base = otherSubs(b)[0];
    expect(base?.query as readonly string[], 'the base set opened').toHaveLength(30);
    base?.onApplied?.({});
    frames(1_000);
    expect(b.reducerCalls.filter((call) => call.name === 'joinGame')).toHaveLength(1);
    expect(statusText()).not.toBe(NEWER_EN);
    expect(statusText()).not.toBe(OLDER_EN);
  }, 30_000);

  // ------------------------------------------------------- announced once, kept until reload
  it('announces the mismatch line through the live region exactly once across seconds of frames [lpw-4.4]', async () => {
    // WRONG IMPL KILLED: a line re-announced every frame or on every repaint (a repeat shows as
    // the line plus a trailing U+00A0); a line painted on #status but never said.
    await boot(2);
    const b = await sdkBuild(0);
    open(b);
    const before = liveWrites.length;
    answer(b, [{ id: 0, protocol: 5, minClientProtocol: 3 }]);
    frames(1_000);
    expect(byId('a11y-live').textContent, 'the live region says the line').toBe(NEWER_EN);
    frames(6_000);
    const said = liveWrites.slice(before);
    expect(
      said.filter((w) => w === NEWER_EN),
      'said once',
    ).toHaveLength(1);
    expect(
      said.filter((w) => w === `${NEWER_EN}${NBSP}`),
      'never repeated',
    ).toEqual([]);
  }, 30_000);

  it('keeps the mismatch line through a minute of frames and the SDK disconnect that follows the refusal, building no other connection [lpw-4.4]', async () => {
    // WRONG IMPL KILLED: the line cleared by the disconnect (a "connection lost" or reconnect
    // path that resets the hints); the line on the toast (gone after its timer); a rebuild.
    await boot(2);
    const b = await sdkBuild(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    open(b);
    answer(b, [{ id: 0, protocol: 5, minClientProtocol: 3 }]);
    frames(1_000);
    expect(statusText(), 'precondition: the line is up').toBe(NEWER_EN);
    frames(60_000, 250);
    expect(statusText(), 'after a minute of frames').toBe(NEWER_EN);
    b.onDisconnect?.();
    await vi.advanceTimersByTimeAsync(120_000);
    frames(2_000);
    expect(statusText(), 'after the SDK disconnect').toBe(NEWER_EN);
    expect(H.sdkBuilds, 'no connection built again').toHaveLength(1);
    expectSilent(b, 'after the disconnect');
  }, 60_000);

  it('replaces a connect-failure line reported on an earlier build with the mismatch line, and keeps it [lpw-4.4]', async () => {
    await boot(2);
    const b0 = await sdkBuild(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    b0.onConnectError?.({}, new Error('refused'));
    frames(500);
    expect(statusText(), 'precondition: the connect failure is up').toBe('connect: refused');
    // The backoff's rebuild (at most 30 s) is the build the server refuses.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(H.sdkBuilds, 'precondition: the retry built').toHaveLength(2);
    const b1 = H.sdkBuilds[1];
    open(b1);
    answer(b1, [{ id: 0, protocol: 5, minClientProtocol: 3 }]);
    frames(1_000);
    expect(statusText(), 'the mismatch replaces the failure').toBe(NEWER_EN);
    await vi.advanceTimersByTimeAsync(120_000);
    frames(10_000, 250);
    expect(statusText(), 'and stays').toBe(NEWER_EN);
    expect(H.sdkBuilds, 'no connection built after the refusal').toHaveLength(2);
    expectSilent(b1, 'the refused build');
  }, 60_000);

  it('keeps the mismatch line over a later download-blocked hint from a blocked F9 bug bundle [lpw-4.4]', async () => {
    // WRONG IMPL KILLED: the mismatch ranked with the other action-required hints (the blocked
    // download paints over it for the rest of the page, and uncovering it says it again).
    await boot(2);
    const b = await sdkBuild(0);
    open(b);
    answer(b, [{ id: 0, protocol: 5, minClientProtocol: 3 }]);
    frames(1_000);
    expect(statusText(), 'precondition: the line is up').toBe(NEWER_EN);
    const own = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (): string => {
        throw new Error('blocked by the test');
      },
    });
    restorers.push(() => {
      if (own !== undefined) Object.defineProperty(URL, 'createObjectURL', own);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const saidBefore = liveWrites.filter((w) => w === NEWER_EN || w === `${NEWER_EN}${NBSP}`);
    press('F9');
    frames(2_000);
    expect(
      (consoleError?.mock.calls ?? []).some((call) => call[1] === BUG_BUNDLE_BLOCKED_EN),
      'precondition: the blocked download was reported',
    ).toBe(true);
    expect(statusText(), 'the mismatch line still stands').toBe(NEWER_EN);
    expect(
      liveWrites.filter((w) => w === NEWER_EN || w === `${NEWER_EN}${NBSP}`),
      'and is not said again',
    ).toEqual(saidBefore);
    expect(H.sdkBuilds).toHaveLength(1);
  }, 30_000);

  // --------------------------------------------------------------------------- French
  it('shows the French update-the-game line under the French locale [lpw-4.5]', async () => {
    await boot(2, '?locale=fr');
    const b = await sdkBuild(0);
    open(b);
    answer(b, [{ id: 0, protocol: 5, minClientProtocol: 3 }]);
    frames(1_000);
    expect(statusText()).toBe(NEWER_FR);
    expect(statusText()).not.toBe(NEWER_EN);
  }, 30_000);

  it('shows the French host-must-update line under the French locale [lpw-4.5]', async () => {
    await boot(1, '?locale=fr');
    const b = await sdkBuild(0);
    open(b);
    answer(b, []);
    frames(1_000);
    expect(statusText()).toBe(OLDER_FR);
    expect(statusText()).not.toBe(OLDER_EN);
  }, 30_000);
});

describe('the booted client clears a session overlay on a protocol refusal (lpw-4, recording connection)', () => {
  it('hides a session-expired overlay that was showing when the refusal arrives, and shows the mismatch line [lpw-4.4]', async () => {
    // WRONG IMPL KILLED: the refusal leaving the session overlay up (its Retry and Continue can
    // do nothing on a refused page) over the line that says what to do.
    await boot(1, '', false);
    const opts = H.connectOpts;
    if (opts === null) throw new Error('connect() was not called');
    opts.onSessionExpired?.();
    frames(500);
    expect(byId('session-overlay').style.display, 'precondition: the overlay is up').toBe('block');
    const onMismatch = (opts as unknown as { onProtocolMismatch?: (side: string) => void })
      .onProtocolMismatch;
    if (onMismatch === undefined) throw new Error('main.ts handed connect() no onProtocolMismatch');
    onMismatch('update-game');
    frames(1_000);
    expect(byId('session-overlay').style.display, 'the overlay is hidden').toBe('none');
    expect(statusText()).toBe(NEWER_EN);
  }, 30_000);
});
