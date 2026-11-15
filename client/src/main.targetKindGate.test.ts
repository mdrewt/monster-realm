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
  };
});

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once; and
// startSignIn is counted on H.
vi.mock('./net/connection', () => {
  const recording = connectionRecordingMock(H);
  return {
    connect: (opts: ConnectionOptions): Connection =>
      ({
        ...(recording.connect(opts) as unknown as Record<string, unknown>),
        startSignIn: () => {
          H.signIns += 1;
        },
      }) as unknown as Connection,
  };
});

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
  opts.store.upsertPlayer({ identity: H.identity, entityId: 7n, name: 'P', online: true });
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
