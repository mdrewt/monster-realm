// @vitest-environment happy-dom
/**
 * main.targetKindGate.test.ts: the booted client loads the telemetry SDK, and hands `connect()`
 * the build's OIDC issuer and client id, only toward an official or test server. Toward a
 * single-player world (`local`) or a friends server (`private`) it does neither, whatever the
 * build's telemetry and OIDC variables hold: the loader is never called and `connect()` receives
 * an empty issuer and client id. A production build whose document names no kind is `private`.
 *
 * Every case boots the REAL main.ts, over the real client/index.html shell with the real views,
 * under a shell document on the page global that names the target kind, with the build env
 * stubbed to a valid https telemetry origin and a configured OIDC issuer and client id. It reads
 * two things: how often the telemetry SDK loader main.ts imports was called, and with what
 * exporter URL; and the `authIssuer` / `authClientId` main.ts handed `connect()`. The Sign In
 * cases also join the world, press C to open Profile on Account, and read the Sign In control, the
 * prompt body and how often the connection's `startSignIn` was called.
 *
 * The telemetry module is the real one with only `loadOtelSdk` replaced by a recording spy, so
 * the real `startClientTelemetry` decides whether the loader runs. It calls the loader
 * synchronously, before its first await, and main.ts starts telemetry before it calls
 * `connect()`: once `connect()` has been observed, the loader count is final.
 *
 * Harness: main.shopBalance.test.ts's boot (vi.resetModules + a fresh import per boot, recorded
 * window / document listeners detached in teardown, a stubbed wasm pkg, SDK connection and
 * renderer), plus main.claimCode.test.ts's shell document on the page global.
 *
 * The boot also hands `connect()` a sign-in mode: `'oidc'` only toward an official or test server
 * built with an issuer, `'off'` otherwise; the sign-in mode cases read `opts.signIn`. The
 * whole-page cases boot over the REAL `connect()` (a case puts it on `H.realConnect` before the
 * boot; only the SDK's `DbConnection.builder` is faked) and the real OIDC client, with `fetch`
 * stubbed by a spy and an OIDC return leg and an account marker left on the page, and count the
 * requests from boot through an SDK drop's reconnect and `reconnectNow()`, the reconnect driven on
 * fake timers once the boot is done. Each of those cases dispatches `pagehide` before the teardown
 * below detaches the connection's listeners, so no rebuild timer outlives it. Every other case
 * uses the recording connection and never loads the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import {
  SHELL_CONFIG_GLOBAL,
  type ShellDocument,
  TARGET_KINDS,
  type TargetKind,
} from './net/shellDocument';
import type { TelemetryInit, TelemetryMeter } from './observability/telemetry';
import { t, tf } from './ui/i18n/resolver';

const H = vi.hoisted(() => {
  /** A meter whose instruments accept every record / add and keep nothing. */
  const meter: TelemetryMeter = {
    createHistogram: () => ({ record: () => {} }),
    createCounter: () => ({ add: () => {} }),
  };
  return {
    identity: 'cd'.repeat(32),
    connectOpts: null as ConnectionOptions | null,
    /** Every enqueueMove the client issued. */
    sends: [] as unknown[],
    /** Every other reducer call, oldest first, with the exact argument object it received. */
    calls: [] as Array<{ name: string; args: unknown }>,
    /** The telemetry SDK loader main.ts imports: records each init and resolves the meter. */
    loadSdk: vi.fn((_init: TelemetryInit): Promise<TelemetryMeter> => Promise.resolve(meter)),
    /** How many times the connection was asked to start a sign-in. */
    signIns: 0,
    /** The REAL `connect`, put here by a whole-page case before its boot; null: the recording
     *  connection below answers. */
    realConnect: null as ((opts: ConnectionOptions) => Connection) | null,
    /** The real connection the boot built, while `realConnect` is set. */
    realConn: null as Connection | null,
    /** Every DbConnection the real `connect()` built through the faked SDK builder. */
    sdkBuilds: [] as SdkBuild[],
  };
});

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once; and
// startSignIn is counted on H. While a case has put the real `connect` on H.realConnect, the
// options are captured the same way and that real connect() runs instead.
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
      return {
        ...(recording.connect(opts) as unknown as Record<string, unknown>),
        startSignIn: () => {
          H.signIns += 1;
        },
      } as unknown as Connection;
    },
  };
});

// The SDK's DbConnection builder, for the real connect() of the whole-page cases (the recording
// connection never loads these bindings). Each build records the token it was handed and its
// lifecycle callbacks; the built connection's tables accept every handler and iterate nothing,
// every reducer resolves, and a subscription's builder chains.
vi.mock('./module_bindings', () => {
  /** Never a thenable: an awaited table or reducer set must not hang on a `then` the Proxy made. */
  const noThen = (k: string | symbol): boolean => k === 'then';
  const table = () =>
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
        const rec: SdkBuild = { token: 'UNSET' };
        H.sdkBuilds.push(rec);
        const handle = { isActive: () => true, unsubscribe: () => undefined };
        const subscriptionBuilder = () => {
          const sub = { onApplied: () => sub, onError: () => sub, subscribe: () => handle };
          return sub;
        };
        const conn = {
          db: new Proxy({}, { get: (_t, k) => (noThen(k) ? undefined : table()) }),
          reducers: new Proxy(
            {},
            { get: (_t, k) => (noThen(k) ? undefined : () => Promise.resolve()) },
          ),
          subscriptionBuilder,
          disconnect: () => undefined,
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

// The real telemetry module, with only the SDK loader replaced: startClientTelemetry is real.
vi.mock('./observability/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./observability/telemetry')>()),
  loadOtelSdk: H.loadSdk,
}));

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus.
vi.mock('./render/world', () => worldRendererMock());

/** One SDK lifecycle callback as the faked builder records it. */
type SdkCallback = (...args: unknown[]) => void;

/** One DbConnection the real `connect()` built through the faked SDK builder. */
interface SdkBuild {
  /** What `.withToken()` was handed ('UNSET' if it was never called). */
  token: unknown;
  /** The connection `build()` returned: what the SDK hands `onConnect` as its first argument. */
  conn?: unknown;
  onConnect?: SdkCallback;
  onConnectError?: SdkCallback;
  onDisconnect?: SdkCallback;
}

// --- what each target kind gets ----------------------------------------------------------------

/** Which target kinds receive telemetry and offer account sign-in. Typed over every TargetKind,
 *  so a kind added to TARGET_KINDS does not compile here until it is classified. */
const EXPECTED: Record<TargetKind, { readonly telemetry: boolean; readonly signIn: boolean }> = {
  official: { telemetry: true, signIn: true },
  test: { telemetry: true, signIn: true },
  local: { telemetry: false, signIn: false },
  private: { telemetry: false, signIn: false },
};

/** A valid telemetry origin in every build mode: an absolute https origin with no path. */
const OTLP_ORIGIN = 'https://otlp.example:8443';
/** The exporter URL the loader receives for OTLP_ORIGIN: the origin plus the OTLP metrics path. */
const OTLP_EXPORTER_URL = 'https://otlp.example:8443/v1/metrics';
/** The OIDC issuer and client id the build env carries; different from each other on purpose.
 *  The issuer ends in `/`, as real issuer URLs do, so a client that tidied the slash away before
 *  handing it on (to `connect()` or to the Sign In label) fails the exact comparisons below. */
const OIDC_ISSUER = 'https://auth.example/realms/monster-realm/';
const OIDC_CLIENT_ID = 'monster-realm-web-client';

/** The shell document for `kind`: a target that is not the development default. */
function documentFor(kind: TargetKind): ShellDocument {
  return { connection: { uri: 'wss://gate.example:4443/', db: 'realm-gate', kind } };
}

// --- harness ------------------------------------------------------------------------------
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

/** Let every pending promise reaction run, so the telemetry facade has settled. */
function drainPendingWork(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Boot a fresh main.ts under a shell document of `kind` and return the options it handed
 *  `connect()`, after the work it started before that call has settled. */
function bootUnder(kind: TargetKind): Promise<ConnectionOptions> {
  return bootWith(documentFor(kind), `a ${kind} document`);
}

/** Which groups of build variables a boot sets. A group left out is absent from
 *  `import.meta.env` for that boot, not an empty string. */
interface BuildEnv {
  /** `VITE_MR_OTLP_ENDPOINT` (the valid origin) and `VITE_MR_OTLP_INTERVAL_MS`. */
  readonly telemetry: boolean;
  /** `VITE_MR_OIDC_ISSUER` and `VITE_MR_OIDC_CLIENT_ID`. */
  readonly oidc: boolean;
  /** `VITE_MR_OIDC_PROVIDER_NAME` (PROVIDER_NAME); left out when absent. */
  readonly providerName?: boolean;
  /** With `oidc`, `VITE_MR_OIDC_ISSUER` is set to the EMPTY string (the client id stays
   *  set), so the variable is present but names no issuer. Left out: the issuer as `oidc` says. */
  readonly emptyIssuer?: boolean;
}

const FULL_BUILD_ENV: BuildEnv = { telemetry: true, oidc: true };

/** The provider name a build may set beside its issuer, for the Sign In label. */
const PROVIDER_NAME = 'Gate ID';
/** Every build variable, the provider name included. */
const SIGN_IN_BUILD_ENV: BuildEnv = { telemetry: true, oidc: true, providerName: true };

/** Boot a fresh main.ts under `doc` (described by `label` in failure messages), with the build
 *  variable groups `env` names set, and return the options it handed `connect()` once the boot is
 *  known to have taken `doc`'s target and the work it started before `connect()` has settled. */
async function bootWith(
  doc: ShellDocument,
  label: string,
  env: BuildEnv = FULL_BUILD_ENV,
): Promise<ConnectionOptions> {
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = doc;
  if (env.telemetry) {
    vi.stubEnv('VITE_MR_OTLP_ENDPOINT', OTLP_ORIGIN);
    vi.stubEnv('VITE_MR_OTLP_INTERVAL_MS', '60000');
  } else {
    expect(import.meta.env.VITE_MR_OTLP_ENDPOINT, 'the endpoint is unset').toBeUndefined();
  }
  if (env.oidc) {
    vi.stubEnv('VITE_MR_OIDC_ISSUER', OIDC_ISSUER);
    vi.stubEnv('VITE_MR_OIDC_CLIENT_ID', OIDC_CLIENT_ID);
  } else {
    expect(import.meta.env.VITE_MR_OIDC_ISSUER, 'the issuer is unset').toBeUndefined();
    expect(import.meta.env.VITE_MR_OIDC_CLIENT_ID, 'the client id is unset').toBeUndefined();
  }
  if (env.emptyIssuer === true) {
    vi.stubEnv('VITE_MR_OIDC_ISSUER', '');
    expect(import.meta.env.VITE_MR_OIDC_ISSUER, 'the issuer is set and empty').toBe('');
  }
  if (env.providerName === true) {
    vi.stubEnv('VITE_MR_OIDC_PROVIDER_NAME', PROVIDER_NAME);
  } else {
    expect(
      import.meta.env.VITE_MR_OIDC_PROVIDER_NAME,
      'the provider name is unset',
    ).toBeUndefined();
  }
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('./main');
  const opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  // The boot took this case's document, not the development default (which is kind `test`).
  expect(opts.uri, `connect() uri under ${label}`).toBe(doc.connection.uri);
  expect(opts.db, `connect() db under ${label}`).toBe(doc.connection.db);
  await drainPendingWork();
  return opts;
}

beforeEach(() => {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.loadSdk.mockClear();
  H.signIns = 0;
  H.realConnect = null;
  H.realConn = null;
  H.sdkBuilds = [];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
  vi.unstubAllEnvs();
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
});

describe('the booted client gates telemetry and account sign-in on the target kind', () => {
  for (const kind of TARGET_KINDS) {
    const expected = EXPECTED[kind];

    if (expected.telemetry) {
      it(`loads the telemetry SDK once, exporting to <origin>/v1/metrics, toward a ${kind} server`, async () => {
        await bootUnder(kind);
        expect(H.loadSdk, `the SDK loader under a ${kind} document`).toHaveBeenCalledTimes(1);
        const init = H.loadSdk.mock.calls[0]?.[0];
        expect(init?.exporterUrl).toBe(OTLP_EXPORTER_URL);
      });
    } else {
      it(`never loads the telemetry SDK toward a ${kind} server, though the endpoint is valid`, async () => {
        await bootUnder(kind);
        expect(H.loadSdk, `the SDK loader under a ${kind} document`).not.toHaveBeenCalled();
      });
    }

    if (expected.signIn) {
      it(`hands connect() the configured OIDC issuer and client id toward a ${kind} server`, async () => {
        const opts = await bootUnder(kind);
        expect(opts.authIssuer, `authIssuer under a ${kind} document`).toBe(OIDC_ISSUER);
        expect(opts.authClientId, `authClientId under a ${kind} document`).toBe(OIDC_CLIENT_ID);
      });
    } else {
      it(`hands connect() an empty OIDC issuer and client id toward a ${kind} server`, async () => {
        const opts = await bootUnder(kind);
        expect(opts.authIssuer, `authIssuer under a ${kind} document`).toBe('');
        expect(opts.authClientId, `authClientId under a ${kind} document`).toBe('');
      });
    }

    // Each gate holds whatever the other gate's build variable is: the OIDC config does not
    // depend on a telemetry endpoint being set, nor telemetry on the OIDC variables.
    if (expected.signIn) {
      it(`hands connect() the configured OIDC issuer and client id toward a ${kind} server built without a telemetry endpoint`, async () => {
        const label = `a ${kind} document, no telemetry endpoint`;
        const opts = await bootWith(documentFor(kind), label, { telemetry: false, oidc: true });
        expect(opts.authIssuer, `authIssuer under ${label}`).toBe(OIDC_ISSUER);
        expect(opts.authClientId, `authClientId under ${label}`).toBe(OIDC_CLIENT_ID);
        expect(H.loadSdk, `the SDK loader under ${label}`).not.toHaveBeenCalled();
      });
    }

    if (expected.telemetry) {
      it(`loads the telemetry SDK once toward a ${kind} server built without the OIDC variables`, async () => {
        const label = `a ${kind} document, no OIDC variables`;
        const opts = await bootWith(documentFor(kind), label, { telemetry: true, oidc: false });
        expect(H.loadSdk, `the SDK loader under ${label}`).toHaveBeenCalledTimes(1);
        const init = H.loadSdk.mock.calls[0]?.[0];
        expect(init?.exporterUrl, `the exporter URL under ${label}`).toBe(OTLP_EXPORTER_URL);
        expect(opts.authIssuer, `authIssuer under ${label}`).toBe('');
        expect(opts.authClientId, `authClientId under ${label}`).toBe('');
      });
    }
  }

  it('gives a production build whose document names no kind neither telemetry nor the OIDC config', async () => {
    // A production build resolves an omitted kind to `private`, the most restricted kind; a
    // development build resolves it to `test`. The document has no `kind` key at all.
    vi.stubEnv('DEV', false);
    const doc: ShellDocument = {
      connection: { uri: 'wss://gate.example:4443/', db: 'realm-gate' },
    };
    expect(Object.hasOwn(doc.connection, 'kind')).toBe(false);
    const opts = await bootWith(doc, 'a production document with no kind');
    expect(
      H.loadSdk,
      'the SDK loader under a production document with no kind',
    ).not.toHaveBeenCalled();
    expect(opts.authIssuer, 'authIssuer under a production document with no kind').toBe('');
    expect(opts.authClientId, 'authClientId under a production document with no kind').toBe('');
  });
});

// --- the Account section's Sign In, as a player opens it -------------------------------------

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} must be in the document`);
  return found;
}

/** Shown unless the element or an ancestor has an inline `display:none`. */
function isShown(node: Element): boolean {
  for (let n: Element | null = node; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
}

/** One key press and its release, aimed at `window` (the accelerators' target). */
function pressWindow(code: string): void {
  clock.t += 100;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t += 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** Join the world (onReady, then one authoritative batch with the own player and character), then
 *  press C: Profile opens on its Account section. */
function openAccount(opts: ConnectionOptions, label: string): void {
  opts.onReady(H.identity);
  clock.t += 100;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: 7n,
    name: 'P',
    online: true,
    discriminator: 0,
    leadLevel: 0,
  });
  opts.store.upsertCharacter(
    {
      entityId: 7n,
      zoneId: 0,
      tileX: 2,
      tileY: 2,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
      ackedSeq: 0n,
    },
    clock.t,
  );
  opts.store.flushBatch();
  pressWindow('KeyC');
  expect(isShown(el('profile-overlay')), `${label}: C opened Profile`).toBe(true);
  expect(isShown(el('claim-overlay')), `${label}: with its Account section shown`).toBe(true);
}

describe('the booted client offers Sign In only toward a kind it hands the OIDC issuer to', () => {
  for (const kind of TARGET_KINDS) {
    if (EXPECTED[kind].signIn) {
      it(`toward a ${kind} server built with an issuer and a provider name, Profile on Account shows Sign In labelled with that provider, and a click on it starts one sign-in [ih-4.5]`, async () => {
        const label = `a ${kind} document, issuer and provider name set`;
        const opts = await bootWith(documentFor(kind), label, SIGN_IN_BUILD_ENV);
        openAccount(opts, label);
        const button = el('claim-signin-btn');
        expect(isShown(button), `${label}: Sign In is shown`).toBe(true);
        expect(button.textContent, `${label}: the provider label`).toBe(
          tf('claim.signInWithProvider', { provider: PROVIDER_NAME }),
        );
        expect(el('claim-body').textContent, `${label}: the prompt body`).toBe(
          t('claim.pending.body'),
        );
        button.click();
        expect(H.signIns, `${label}: one sign-in started`).toBe(1);
      });

      it(`toward a ${kind} server built with an issuer and no provider name, the Sign In label names exactly the issuer connect() received [ih-4.5]`, async () => {
        const label = `a ${kind} document, issuer set, no provider name`;
        const opts = await bootWith(documentFor(kind), label, FULL_BUILD_ENV);
        expect(opts.authIssuer, `${label}: connect() received the build issuer`).toBe(OIDC_ISSUER);
        openAccount(opts, label);
        const button = el('claim-signin-btn');
        expect(isShown(button), `${label}: Sign In is shown`).toBe(true);
        const issuer = opts.authIssuer;
        if (issuer === undefined) {
          throw new Error(`${label}: connect() received no authIssuer`);
        }
        expect(button.textContent, `${label}: the label names connect()'s issuer`).toBe(
          tf('claim.signInWithProvider', { provider: issuer }),
        );
      });
    } else {
      it(`toward a ${kind} server built with an issuer and a provider name, Profile on Account shows no Sign In, reads the no-provider prompt, and a click on the hidden Sign In starts no sign-in [ih-4.5]`, async () => {
        const label = `a ${kind} document, issuer and provider name set`;
        const opts = await bootWith(documentFor(kind), label, SIGN_IN_BUILD_ENV);
        expect(opts.authIssuer, `${label}: connect() received no issuer`).toBe('');
        openAccount(opts, label);
        const button = el('claim-signin-btn');
        expect(button.style.display, `${label}: Sign In is not shown`).toBe('none');
        expect(el('claim-body').textContent, `${label}: the no-provider prompt body`).toBe(
          t('claim.prompt.noProvider'),
        );
        button.click();
        expect(H.signIns, `${label}: no sign-in started`).toBe(0);
      });
    }
  }

  it('toward an official server built without the OIDC variables, Profile on Account shows no Sign In and a click on it starts no sign-in [ih-4.5]', async () => {
    const label = 'an official document, no OIDC variables';
    const opts = await bootWith(documentFor('official'), label, { telemetry: true, oidc: false });
    expect(opts.authIssuer, `${label}: connect() received no issuer`).toBe('');
    openAccount(opts, label);
    const button = el('claim-signin-btn');
    expect(button.style.display, `${label}: Sign In is not shown`).toBe('none');
    expect(el('claim-body').textContent, `${label}: the no-provider prompt body`).toBe(
      t('claim.prompt.noProvider'),
    );
    button.click();
    expect(H.signIns, `${label}: no sign-in started`).toBe(0);
  });
});

// --- the sign-in mode the booted client hands connect() ---------------------------------------

describe('the booted client hands connect() sign-in off unless an official or test server names an issuer', () => {
  // WRONG IMPL KILLED: the mode derived from the build's issuer alone (a local or private server
  // built with an issuer gets 'oidc'); the mode derived from the kind alone (an official server
  // built with no issuer, or an empty one, gets 'oidc'); no mode handed at all (undefined).
  for (const kind of ['local', 'private'] as const) {
    it(`hands connect() sign-in off toward a ${kind} server built with an OIDC issuer and client id [lpw-1.4]`, async () => {
      const opts = await bootUnder(kind);
      expect(opts.signIn, `signIn under a ${kind} document`).toBe('off');
    });

    it(`hands connect() sign-in off toward a ${kind} server built without the OIDC variables [lpw-1.4]`, async () => {
      const label = `a ${kind} document, no OIDC variables`;
      const opts = await bootWith(documentFor(kind), label, { telemetry: true, oidc: false });
      expect(opts.signIn, `signIn under ${label}`).toBe('off');
    });
  }

  it('hands connect() sign-in off under a production build whose document names no kind, though the build has an OIDC issuer [lpw-1.4]', async () => {
    // A production build resolves an omitted kind to `private`.
    vi.stubEnv('DEV', false);
    const doc: ShellDocument = {
      connection: { uri: 'wss://gate.example:4443/', db: 'realm-gate' },
    };
    expect(Object.hasOwn(doc.connection, 'kind')).toBe(false);
    const opts = await bootWith(doc, 'a production document with no kind');
    expect(opts.signIn, 'signIn under a production document with no kind').toBe('off');
  });

  for (const kind of ['official', 'test'] as const) {
    it(`hands connect() sign-in oidc, with the configured issuer, toward a ${kind} server built with an OIDC issuer [lpw-1.5]`, async () => {
      const opts = await bootUnder(kind);
      expect(opts.signIn, `signIn under a ${kind} document`).toBe('oidc');
      expect(opts.authIssuer, `authIssuer under a ${kind} document`).toBe(OIDC_ISSUER);
    });

    it(`hands connect() sign-in off toward a ${kind} server built without the OIDC variables [lpw-1.5]`, async () => {
      const label = `a ${kind} document, no OIDC variables`;
      const opts = await bootWith(documentFor(kind), label, { telemetry: true, oidc: false });
      expect(opts.signIn, `signIn under ${label}`).toBe('off');
    });
  }

  it('hands connect() sign-in off toward an official server whose build sets the OIDC issuer to an empty string [lpw-1.5]', async () => {
    // The variable is PRESENT and empty: a mode keyed on the variable being set (rather than on
    // the issuer connect() receives being non-empty) answers 'oidc' here.
    const label = 'an official document, an empty OIDC issuer';
    const opts = await bootWith(documentFor('official'), label, {
      telemetry: true,
      oidc: true,
      emptyIssuer: true,
    });
    expect(opts.authIssuer, `${label}: connect() received the empty issuer`).toBe('');
    expect(opts.signIn, `signIn under ${label}`).toBe('off');
  });
});

// --- the whole booted page, over the real connection ------------------------------------------

/** documentFor's connection target: the OIDC flow and the kind marker are keyed on it. */
const DOC_URI = 'wss://gate.example:4443/';
const DOC_DB = 'realm-gate';
const RETURN_CODE = 'lpw1-authorization-code';
const RETURN_STATE = '7c'.repeat(32);
const RETURN_VERIFIER = 'lpw1-pkce-verifier-ABCDEFGHIJKLMNOPQRSTUVWXYZ0';
const STORED_REFRESH = 'lpw1-refresh-token';
/** The real OIDC client's first request for OIDC_ISSUER: the issuer, its trailing slash dropped,
 *  plus the discovery path (oidc.ts getDiscovery). */
const OIDC_DISCOVERY_URL =
  'https://auth.example/realms/monster-realm/.well-known/openid-configuration';
/** The longest reconnect backoff rung: advancing the fake clock this far fires a pending rebuild
 *  whichever rung it is on. */
const LONGEST_BACKOFF_MS = 30_000;

/**
 * Prepare a whole-page boot: put the REAL `connect` on H for the next boot, leave an OIDC sign-in
 * on the page for the document's target (a `?code&state` return leg in the URL, the matching
 * state, the PKCE verifier and a refresh token stored, the `account` kind marker stored), and stub
 * fetch with a spy that answers every request with a bare 503. The real connection, auth-token and
 * OIDC modules are loaded here, so no other case loads them. Each seed is asserted in place, so a
 * seeding mistake fails HERE. Returns the fetch spy and the OIDC flow's storage key for a slot.
 */
async function prepareWholePage() {
  const { connect } = await vi.importActual<typeof import('./net/connection')>('./net/connection');
  const { wasEverAuthenticated, writeAuthKind } = await import('./net/authToken');
  const { oidcFlowStorageKey } = await import('./net/oidc');
  /** One slot of the OIDC flow's storage for the document's target (oidc.ts:
   *  `<oidcFlowStorageKey>|<slot>` in sessionStorage). */
  const flowKey = (slot: 'state' | 'verifier' | 'refresh'): string =>
    `${oidcFlowStorageKey(DOC_URI, DOC_DB)}|${slot}`;
  expect(
    documentFor('local').connection,
    'precondition: the seeded target is the document target',
  ).toEqual({ uri: DOC_URI, db: DOC_DB, kind: 'local' });
  // Nothing an earlier case stored (an anon token, a claim code) rides into this one.
  sessionStorage.clear();
  localStorage.clear();
  const search = `?code=${RETURN_CODE}&state=${RETURN_STATE}`;
  window.history.replaceState(null, '', `/${search}`);
  sessionStorage.setItem(flowKey('state'), RETURN_STATE);
  sessionStorage.setItem(flowKey('verifier'), RETURN_VERIFIER);
  sessionStorage.setItem(flowKey('refresh'), STORED_REFRESH);
  writeAuthKind(globalThis, DOC_URI, DOC_DB, 'account');
  expect(globalThis.location.search, 'precondition: the page URL carries a code and state').toBe(
    search,
  );
  expect(sessionStorage.getItem(flowKey('state')), 'precondition: the stored state').toBe(
    RETURN_STATE,
  );
  expect(sessionStorage.getItem(flowKey('verifier')), 'precondition: the stored verifier').toBe(
    RETURN_VERIFIER,
  );
  expect(
    wasEverAuthenticated(globalThis, DOC_URI, DOC_DB),
    'precondition: the account kind marker',
  ).toBe(true);
  const fetchSpy = vi.fn((_url: unknown, _init?: unknown) =>
    Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  H.realConnect = connect;
  return { fetchSpy, flowKey };
}

/** The real connect()'s `index`th build, waited for on real timers. */
function sdkBuild(index: number): Promise<SdkBuild> {
  return vi.waitFor(
    () => {
      const build = H.sdkBuilds[index];
      if (build === undefined) throw new Error(`build ${index} not reached yet`);
      return build;
    },
    { timeout: 5_000, interval: 10 },
  );
}

/** End the real connection while its listeners are still attached (the afterEach detaches them):
 *  pagehide clears a pending rebuild (on whichever clock holds it) and stops every later one, so no
 *  timer outlives the case; then the real timers are back. */
function endRealConnection(): void {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  H.realConnect = null;
  H.realConn = null;
  sessionStorage.clear();
  localStorage.clear();
}

describe('the booted page makes no OIDC request toward a local or private server', () => {
  for (const kind of ['local', 'private'] as const) {
    it(`makes zero OIDC requests from boot through an SDK drop's reconnect and reconnectNow toward a ${kind} server built with an issuer, though the URL carries an OIDC code and state and storage holds the account marker, the state and the verifier [lpw-1.1]`, async () => {
      // WRONG IMPL KILLED: main.ts handing 'oidc' (or no mode) to a local or private target while
      // connect() still constructs the OIDC client: the return leg and the marker send the
      // discovery request at boot, to the page's own origin when the issuer is empty.
      const { fetchSpy, flowKey } = await prepareWholePage();
      try {
        const label = `a ${kind} document, an OIDC sign-in left on the page`;
        await bootWith(documentFor(kind), label, FULL_BUILD_ENV);
        expect(fetchSpy.mock.calls, `${label}: no request through boot`).toEqual([]);
        const b0 = await sdkBuild(0);
        const real = H.realConn;
        if (real === null) throw new Error(`${label}: the boot built no real connection`);
        // The boot is done: the reconnect below runs on a fake clock.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        b0.onConnect?.(b0.conn, { toHexString: () => H.identity }, 'lpw1-anon-token');
        b0.onDisconnect?.();
        await vi.advanceTimersByTimeAsync(LONGEST_BACKOFF_MS);
        await vi.advanceTimersByTimeAsync(0);
        expect(H.sdkBuilds, `${label}: the SDK drop was rebuilt`).toHaveLength(2);
        expect(
          fetchSpy.mock.calls,
          `${label}: no request through the drop and its reconnect`,
        ).toEqual([]);
        real.reconnectNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(H.sdkBuilds, `${label}: reconnectNow built`).toHaveLength(3);
        expect(fetchSpy.mock.calls, `${label}: no request through reconnectNow`).toEqual([]);
        // Liveness: three real builds, the first connection's token handed back on each rebuild.
        expect(
          H.sdkBuilds.map((b) => b.token),
          `${label}: anonymous builds, the handed-back token re-supplied`,
        ).toEqual([undefined, 'lpw1-anon-token', 'lpw1-anon-token']);
        expect(sessionStorage.getItem(flowKey('state')), `${label}: the state is untouched`).toBe(
          RETURN_STATE,
        );
        expect(
          sessionStorage.getItem(flowKey('verifier')),
          `${label}: the verifier is untouched`,
        ).toBe(RETURN_VERIFIER);
      } finally {
        endRealConnection();
      }
    }, 30_000);
  }

  it('requests the issuer discovery document from the same page toward an official server built with an issuer [lpw-1.1]', async () => {
    // The control: the same OIDC sign-in left on the page DOES reach the issuer toward a server
    // that signs in, so the zero-request result above is the target kind's doing.
    const { fetchSpy } = await prepareWholePage();
    try {
      const label = 'an official document, an OIDC sign-in left on the page';
      await bootWith(documentFor('official'), label, FULL_BUILD_ENV);
      const firstUrl = await vi.waitFor(
        () => {
          const first = fetchSpy.mock.calls[0];
          if (first === undefined) throw new Error(`${label}: no request yet`);
          return first[0];
        },
        { timeout: 5_000, interval: 10 },
      );
      expect(firstUrl, `${label}: the first request is the issuer discovery`).toBe(
        OIDC_DISCOVERY_URL,
      );
    } finally {
      endRealConnection();
    }
  }, 30_000);
});
