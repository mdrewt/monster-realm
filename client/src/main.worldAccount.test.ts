// @vitest-environment happy-dom
/**
 * main.worldAccount.test.ts: the booted client hands a single-player world or a friends server a
 * ticket source only when the page can name the world, shows the world's account gate in the menu
 * frame when it has that source, and puts the gate's word on the status line when it has none.
 *
 * Every case boots the REAL main.ts over the real client/index.html shell, under a shell document
 * on the page global, with the build's world ticket issuer stubbed in `import.meta.env` or left
 * out. The connection is the recording one: it captures the options main.ts hands `connect()`,
 * counts `checkIn()` and `startSignIn()`, and a case drives the lifecycle through those options'
 * callbacks (`onReady`, `onWorldGate`) and by putting the own player row into the store. `fetch`
 * is a spy on the page global.
 *
 * Harness: main.signInGate.test.ts's boot and frame readers, and main.targetKindGate.test.ts's
 * shell document and stubbed env (vi.resetModules and a fresh import per boot, the recorded
 * window / document listeners detached in teardown).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import { oidcFlowStorageKey } from './net/oidc';
import { SHELL_CONFIG_GLOBAL, type ShellDocument } from './net/shellDocument';
import type { WorldGateEvent } from './net/worldTicket';

const H = vi.hoisted(() => ({
  identity: 'cd'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
  /** How many times the connection is asked to start a claim sign-in. */
  signIns: 0,
  /** How many times the connection is asked to check the account in again. */
  checkIns: 0,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once;
// startSignIn and checkIn are counted on H.
vi.mock('./net/connection', () => {
  const recording = connectionRecordingMock(H);
  return {
    connect: (opts: ConnectionOptions): Connection =>
      ({
        ...(recording.connect(opts) as unknown as Record<string, unknown>),
        startSignIn: () => {
          H.signIns += 1;
        },
        checkIn: () => {
          H.checkIns += 1;
        },
        join: () => undefined,
      }) as unknown as Connection,
  };
});

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

// --- the build and the targets -----------------------------------------------------------------

const TICKET_ISSUER = 'https://auth.example.test';
const LOOPBACK_URI = 'ws://127.0.0.1:3000';
const DB = 'world-a';
const FINGERPRINT = 'AbCd_-0123';
const MOVED_AT_MS = 1_700_000_000_000;

/** A single-player world on loopback whose document carries the certificate fingerprint. */
const LOCAL_DOC: ShellDocument = {
  connection: { uri: LOOPBACK_URI, db: DB, kind: 'local', fingerprint: FINGERPRINT },
};
const DESKTOP_LOCAL_DOC: ShellDocument = { ...LOCAL_DOC, host: 'desktop' };
const PRIVATE_LOOPBACK_DOC: ShellDocument = {
  connection: { uri: LOOPBACK_URI, db: DB, kind: 'private' },
};
const PRIVATE_WSS_DOC: ShellDocument = {
  connection: { uri: 'wss://play.example.test/', db: DB, kind: 'private' },
};
function operatedDoc(kind: 'official' | 'test'): ShellDocument {
  return { connection: { uri: 'wss://gate.example:4443/', db: DB, kind } };
}

// --- harness ----------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

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

function drainPendingWork(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface BootEnv {
  /** VITE_MR_WORLD_TICKET_ISSUER set to TICKET_ISSUER; left out when false. */
  readonly issuer: boolean;
}
const WITH_ISSUER: BootEnv = { issuer: true };
const NO_ISSUER: BootEnv = { issuer: false };

/** Boot a fresh main.ts under `doc` with `env`, the page at `url`, and return the options it
 *  handed `connect()` once the work started before that call has settled. */
async function boot(doc: ShellDocument, env: BootEnv, url = '/'): Promise<ConnectionOptions> {
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = doc;
  if (env.issuer) {
    vi.stubEnv('VITE_MR_WORLD_TICKET_ISSUER', TICKET_ISSUER);
  } else {
    expect(
      import.meta.env.VITE_MR_WORLD_TICKET_ISSUER,
      'precondition: the issuer is unset',
    ).toBeUndefined();
  }
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  recorded = [];
  window.history.replaceState(null, '', url);
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
  expect(opts.uri, 'precondition: the boot took the case`s document').toBe(doc.connection.uri);
  expect(opts.db, 'precondition: the boot took the case`s db').toBe(doc.connection.db);
  await drainPendingWork();
  return opts;
}

/** The resolver main.ts resolves through: the same module registry as the last boot. */
function resolver(): Promise<typeof import('./ui/i18n/resolver')> {
  return import('./ui/i18n/resolver');
}

beforeEach(() => {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.signIns = 0;
  H.checkIns = 0;
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
  sessionStorage.clear();
  localStorage.clear();
  document.body.replaceChildren();
});

// --- what the player sees -----------------------------------------------------------------------

function isShown(node: Element): boolean {
  for (let n: Element | null = node; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
}
const menuShown = (): boolean => {
  const found = document.getElementById('menu-overlay');
  return found !== null && isShown(found);
};
const frameTitle = (): string =>
  document.querySelector('#menu-overlay .mr-frame-title')?.textContent ?? '';
const frameLine = (): string =>
  document.querySelector('#menu-overlay .mr-frame-feedback')?.textContent ?? '';
const rowEls = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('#menu-rows [data-nav-key]'));
const rowKeys = (): string[] => rowEls().map((row) => row.dataset.navKey ?? '');
const rowTexts = (): string[] => rowEls().map((row) => row.textContent ?? '');
const statusText = (): string => document.getElementById('status')?.textContent ?? '';

function tap(code: string): void {
  clock.t += 100;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t += 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** Hand main.ts one world gate event through the callback it gave `connect()`. */
function worldGate(opts: ConnectionOptions, event: WorldGateEvent): void {
  const report = opts.onWorldGate;
  if (report === undefined) throw new Error('main() hands connect() no onWorldGate');
  report(event);
}

/** One authoritative batch holding the own player and character. */
function joinWorld(opts: ConnectionOptions): void {
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
}

/** The moved time as the page formats it, in the locale the page negotiated. */
async function pageTime(ms: number): Promise<string> {
  const { currentLocale } = await resolver();
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

// --- what connect() is handed -------------------------------------------------------------------

describe('the booted client hands connect() a world ticket source only for a world the page can name', () => {
  it('a local loopback document with a fingerprint and the issuer set hands connect() the spki world name, a ticket source, sign-in off and desktop false [lpw-24.1]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    expect(opts.world?.name).toBe(`spki:${FINGERPRINT}/${DB}`);
    expect(typeof opts.world?.tickets.ticket, 'the source answers tickets').toBe('function');
    expect(typeof opts.world?.tickets.signIn, 'the source starts a sign-in').toBe('function');
    expect(opts.signIn).toBe('off');
    expect(opts.desktop).toBe(false);
  });

  it('the same document with host desktop hands connect() desktop true and no world [lpw-24.7]', async () => {
    const opts = await boot(DESKTOP_LOCAL_DOC, WITH_ISSUER);
    expect(opts.desktop).toBe(true);
    expect(opts.world).toBeUndefined();
  });

  it('the local document with no issuer value hands connect() no world [lpw-24.8]', async () => {
    const opts = await boot(LOCAL_DOC, NO_ISSUER);
    expect(opts.world).toBeUndefined();
  });

  it('a private document over ws on loopback hands connect() no world, though the issuer is set [lpw-24.1]', async () => {
    const opts = await boot(PRIVATE_LOOPBACK_DOC, WITH_ISSUER);
    expect(opts.world).toBeUndefined();
  });

  it('a private document over wss hands connect() the dns world name with the default port [lpw-24.1]', async () => {
    const opts = await boot(PRIVATE_WSS_DOC, WITH_ISSUER);
    expect(opts.world?.name).toBe(`dns:play.example.test:443/${DB}`);
  });

  for (const kind of ['official', 'test'] as const) {
    it(`a ${kind} document with the issuer set hands connect() no world [lpw-24.8]`, async () => {
      const opts = await boot(operatedDoc(kind), WITH_ISSUER);
      expect(opts.world).toBeUndefined();
    });
  }
});

// --- no request at boot -------------------------------------------------------------------------

describe('the booted page asks the account service nothing at boot', () => {
  it('a local page with the issuer set, an OIDC return leg in the URL and a stored flow makes no request through boot and the first snapshot [lpw-24.2]', async () => {
    const flow = oidcFlowStorageKey(LOOPBACK_URI, DB);
    sessionStorage.setItem(`${flow}|state`, 'y');
    sessionStorage.setItem(`${flow}|verifier`, 'lpw24-pkce-verifier');
    const fetchSpy = vi.fn((_url: unknown, _init?: unknown) =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const opts = await boot(LOCAL_DOC, WITH_ISSUER, '/?code=x&state=y');
    expect(opts.world?.name, 'precondition: the page built the world source').toBe(
      `spki:${FINGERPRINT}/${DB}`,
    );
    expect(fetchSpy.mock.calls, 'no request through boot').toEqual([]);
    opts.onReady(H.identity);
    await drainPendingWork();
    expect(fetchSpy.mock.calls, 'no request after the first snapshot').toEqual([]);
  });

  for (const kind of ['official', 'test'] as const) {
    it(`a ${kind} page with the issuer set makes no request through boot and the first snapshot [lpw-24.8]`, async () => {
      const fetchSpy = vi.fn((_url: unknown, _init?: unknown) =>
        Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const opts = await boot(operatedDoc(kind), WITH_ISSUER);
      expect(fetchSpy.mock.calls, 'no request through boot').toEqual([]);
      opts.onReady(H.identity);
      await drainPendingWork();
      expect(fetchSpy.mock.calls, 'no request after the first snapshot').toEqual([]);
    });
  }
});

// --- the gate, with a source ------------------------------------------------------------------

describe('the world account gate in the menu frame, with a ticket source', () => {
  it('an unreachable report shows the check title, the first-visit line and one Try again row [lpw-24.3]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    const { t } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'unreachable' });
    expect(menuShown(), 'the menu frame is shown').toBe(true);
    expect(frameTitle()).toBe(t('world.gate.check.title'));
    expect(frameLine()).toBe(t('world.gate.unreachable.body'));
    expect(rowKeys()).toEqual(['signIn']);
    expect(rowTexts()).toEqual([t('world.gate.retry.row')]);
  });

  it('Enter on the Try again row checks the account in once and starts no claim sign-in [lpw-24.3]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'unreachable' });
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    tap('Enter');
    expect(H.checkIns).toBe(1);
    expect(H.signIns).toBe(0);
  });

  it('a not-entitled report shows the not-owned title and body with the Sign in again row then the store row [lpw-24.4]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    const { t } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'not-entitled' });
    expect(menuShown(), 'the menu frame is shown').toBe(true);
    expect(frameTitle()).toBe(t('claim.gate.notOwned.title'));
    expect(frameLine()).toBe(t('claim.gate.notOwned.body'));
    expect(rowKeys()).toEqual(['signIn', 'store']);
    expect(rowTexts()).toEqual([t('world.gate.again.row'), t('claim.gate.store.title')]);
  });

  it('a click on the Sign in again row of the not-owned gate checks the account in once and starts no claim sign-in [lpw-24.4]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'not-entitled' });
    const row = rowEls().find((el) => el.dataset.navKey === 'signIn');
    if (row === undefined) throw new Error('no Sign in again row to click');
    row.click();
    expect(H.checkIns).toBe(1);
    expect(H.signIns).toBe(0);
  });

  it('a moved report shows the moved title and the moved line with the time in the page locale, with one Sign in again row [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    const { t, tf } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'moved', movedAtMs: MOVED_AT_MS });
    expect(menuShown(), 'the menu frame is shown').toBe(true);
    expect(frameTitle()).toBe(t('world.gate.moved.title'));
    expect(frameLine()).toBe(tf('world.gate.moved.body', { time: await pageTime(MOVED_AT_MS) }));
    expect(rowKeys()).toEqual(['signIn']);
    expect(rowTexts()).toEqual([t('world.gate.again.row')]);
  });

  it('Enter on the Sign in again row of the moved gate checks the account in once [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'moved', movedAtMs: MOVED_AT_MS });
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    tap('Enter');
    expect(H.checkIns).toBe(1);
    expect(H.signIns).toBe(0);
  });

  it('an entitled report lowers a raised gate [lpw-24.1]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'unreachable' });
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    worldGate(opts, { kind: 'entitled' });
    expect(menuShown()).toBe(false);
  });

  it('the own player row arriving lowers an unreachable gate [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'unreachable' });
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    joinWorld(opts);
    expect(menuShown()).toBe(false);
  });

  it('the own player row arriving leaves a moved gate up [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    const { t } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'moved', movedAtMs: MOVED_AT_MS });
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    joinWorld(opts);
    expect(menuShown()).toBe(true);
    expect(frameTitle()).toBe(t('world.gate.moved.title'));
  });

  // B on the gate puts the stays line in the frame; showing the gate afresh puts its own line back.
  it('two batches holding the own player row leave the shown moved gate as it stands: the stays line B put up stays [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    const { t } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'moved', movedAtMs: MOVED_AT_MS });
    tap('Backspace');
    expect(frameLine(), 'precondition: B shows the stays line').toBe(t('claim.gate.stays'));
    joinWorld(opts);
    expect(frameLine(), 'after the first batch').toBe(t('claim.gate.stays'));
    joinWorld(opts);
    expect(frameLine(), 'after the second batch').toBe(t('claim.gate.stays'));
    expect(menuShown()).toBe(true);
    expect(frameTitle()).toBe(t('world.gate.moved.title'));
  });

  it('the same batch on an unreachable gate showing the stays line lowers the gate [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, WITH_ISSUER);
    const { t } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'unreachable' });
    tap('Backspace');
    expect(frameLine(), 'precondition: B shows the stays line').toBe(t('claim.gate.stays'));
    joinWorld(opts);
    expect(menuShown()).toBe(false);
  });
});

// --- no source: the status line -----------------------------------------------------------------

describe('the world account gate with no ticket source', () => {
  it('a moved report opens no frame and puts the moved line on the status line [lpw-24.5]', async () => {
    const opts = await boot(LOCAL_DOC, NO_ISSUER);
    const { tf } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'moved', movedAtMs: MOVED_AT_MS });
    expect(menuShown(), 'no frame').toBe(false);
    expect(statusText()).toBe(tf('world.gate.moved.body', { time: await pageTime(MOVED_AT_MS) }));
  });

  it('an unreachable report opens no frame and puts the first-visit line on the status line [lpw-24.3]', async () => {
    const opts = await boot(LOCAL_DOC, NO_ISSUER);
    const { t } = await resolver();
    opts.onReady(H.identity);
    worldGate(opts, { kind: 'unreachable' });
    expect(menuShown(), 'no frame').toBe(false);
    expect(statusText()).toBe(t('world.gate.unreachable.body'));
  });
});
