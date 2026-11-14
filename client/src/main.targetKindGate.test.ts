// @vitest-environment happy-dom
/**
 * main.targetKindGate.test.ts: the booted client sends telemetry and offers account sign-in only
 * toward an official or test server. A single-player world (`local`) and a friends server
 * (`private`) get neither, whatever the build's telemetry and OIDC variables hold.
 *
 * Every case boots the REAL main.ts, over the real client/index.html shell with the real views,
 * under a shell document on the page global that names the target kind, with the build env
 * stubbed to a valid https telemetry origin and a configured OIDC issuer and client id. It reads
 * two things: how often the telemetry SDK loader main.ts imports was called, and with what
 * exporter URL; and the `authIssuer` / `authClientId` main.ts handed `connect()`.
 *
 * The telemetry module is the real one with only `loadOtelSdk` replaced by a recording spy, so
 * the real `startClientTelemetry` decides whether the loader runs. It calls the loader
 * synchronously, before its first await, and main.ts starts telemetry before it calls
 * `connect()`: once `connect()` has been observed, the loader count is final.
 *
 * Harness: main.shopBalance.test.ts's boot (vi.resetModules + a fresh import per boot, recorded
 * window / document listeners detached in teardown, a stubbed wasm pkg, SDK connection and
 * renderer), plus main.claimCode.test.ts's shell document on the page global.
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
import type { ConnectionOptions } from './net/connection';
import {
  SHELL_CONFIG_GLOBAL,
  type ShellDocument,
  TARGET_KINDS,
  type TargetKind,
} from './net/shellDocument';
import type { TelemetryInit, TelemetryMeter } from './observability/telemetry';

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
  };
});

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once.
vi.mock('./net/connection', () => connectionRecordingMock(H));

// The real telemetry module, with only the SDK loader replaced: startClientTelemetry is real.
vi.mock('./observability/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./observability/telemetry')>()),
  loadOtelSdk: H.loadSdk,
}));

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus.
vi.mock('./render/world', () => worldRendererMock());

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
/** The OIDC issuer and client id the build env carries; different from each other on purpose. */
const OIDC_ISSUER = 'https://auth.example/realms/monster-realm';
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
async function bootUnder(kind: TargetKind): Promise<ConnectionOptions> {
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = documentFor(kind);
  vi.stubEnv('VITE_MR_OTLP_ENDPOINT', OTLP_ORIGIN);
  vi.stubEnv('VITE_MR_OTLP_INTERVAL_MS', '60000');
  vi.stubEnv('VITE_MR_OIDC_ISSUER', OIDC_ISSUER);
  vi.stubEnv('VITE_MR_OIDC_CLIENT_ID', OIDC_CLIENT_ID);
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
  const target = documentFor(kind).connection;
  expect(opts.uri, `connect() uri under a ${kind} document`).toBe(target.uri);
  expect(opts.db, `connect() db under a ${kind} document`).toBe(target.db);
  await drainPendingWork();
  return opts;
}

beforeEach(() => {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.loadSdk.mockClear();
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
  }
});
