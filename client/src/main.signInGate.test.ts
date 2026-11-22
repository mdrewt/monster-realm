// @vitest-environment happy-dom
/**
 * main.signInGate.test.ts: the booted client puts a sign-in screen in front of play on a server
 * that admits only players who own the game, and shows none toward a single-player world or a
 * friends server.
 *
 * Every case boots the REAL main.ts over the real client/index.html shell, under a shell document
 * on the page global that names the target kind, with the build's OIDC variables stubbed (an
 * issuer, a client id and a provider name). The connection is the recording one: it captures the
 * options main.ts hands `connect()`, and a case drives the lifecycle by calling those options'
 * callbacks (`onAccountRequired`, `onReady`, `onOwnershipRefused`, `onSignInFailed`,
 * `onReconnect`) and by putting the own player row into the store and flushing a batch. It reads
 * what a player sees: the menu frame (`#menu-overlay`, its title, its rows `[data-nav-key]` in
 * `#menu-rows`, the line under them), the status line, the Profile overlay, how often the
 * connection is asked to start a sign-in, and what `window.open` receives.
 *
 * Harness: main.targetKindGate.test.ts's boot (vi.resetModules and a fresh import per boot, the
 * recorded window / document listeners detached in teardown, the shell document on the page
 * global, the stubbed build env), and main.menu.test.ts's real key events at `window`.
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
import { SHELL_CONFIG_GLOBAL, type ShellDocument, type TargetKind } from './net/shellDocument';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';
import { MENU_ENTRIES } from './ui/menuModel';

const H = vi.hoisted(() => ({
  identity: 'cd'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** How many times the connection is asked to start a sign-in. */
  signIns: 0,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

// The connection: capture the options; every reducer records its call and resolves at once;
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
        join: () => undefined,
      }) as unknown as Connection,
  };
});

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

// --- the build and the target -----------------------------------------------------------------

const OIDC_ISSUER = 'https://auth.example/realms/monster-realm/';
const OIDC_CLIENT_ID = 'monster-realm-web-client';
const PROVIDER_NAME = 'Gate ID';
/** Where the store row leads (the plan's OWNERSHIP_STORE_URL). */
const STORE_URL = 'https://store.steampowered.com/';
/** The raw error join_game answers a caller that does not own the game with. */
const RAW_REFUSAL = 'ownership required';

function documentFor(kind: TargetKind): ShellDocument {
  return { connection: { uri: 'wss://gate.example:4443/', db: 'realm-gate', kind } };
}

const EN = CATALOG_EN as unknown as Record<string, unknown>;
const FR = CATALOG_FR as unknown as Record<string, unknown>;

/** `catalog[key]`, which must be an own plain string: a missing key throws here, naming it. */
function str(catalog: Record<string, unknown>, key: string): string {
  const value = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (typeof value !== 'string') throw new Error(`the catalog has no plain string for ${key}`);
  return value;
}

/** The sign-in row's label for PROVIDER_NAME, from `catalog`. */
function signInLabel(catalog: Record<string, unknown>): string {
  const fn = catalog['claim.signInWithProvider'] as (p: { provider: string }) => string;
  return fn({ provider: PROVIDER_NAME });
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

interface BuildEnv {
  /** VITE_MR_OIDC_ISSUER, VITE_MR_OIDC_CLIENT_ID and VITE_MR_OIDC_PROVIDER_NAME. */
  readonly oidc: boolean;
}
const SIGN_IN_BUILD: BuildEnv = { oidc: true };

/** Boot a fresh main.ts toward a `kind` server with the build `env` names, the page at `url`, and
 *  return the options it handed `connect()`. */
async function boot(
  kind: TargetKind,
  env: BuildEnv = SIGN_IN_BUILD,
  url = '/',
): Promise<ConnectionOptions> {
  const doc = documentFor(kind);
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = doc;
  if (env.oidc) {
    vi.stubEnv('VITE_MR_OIDC_ISSUER', OIDC_ISSUER);
    vi.stubEnv('VITE_MR_OIDC_CLIENT_ID', OIDC_CLIENT_ID);
    vi.stubEnv('VITE_MR_OIDC_PROVIDER_NAME', PROVIDER_NAME);
  } else {
    expect(import.meta.env.VITE_MR_OIDC_ISSUER, 'the issuer is unset').toBeUndefined();
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
  expect(opts.uri, `the boot took the ${kind} document`).toBe(doc.connection.uri);
  await drainPendingWork();
  return opts;
}

beforeEach(() => {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
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

// --- what the player sees -----------------------------------------------------------------------

/** Shown unless the element or an ancestor has an inline `display: none`. */
function isShown(node: Element): boolean {
  for (let n: Element | null = node; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
}
const shownById = (id: string): boolean => {
  const found = document.getElementById(id);
  return found !== null && isShown(found);
};
const menuShown = (): boolean => shownById('menu-overlay');
const profileShown = (): boolean => shownById('profile-overlay');
const frameTitle = (): string =>
  document.querySelector('#menu-overlay .mr-frame-title')?.textContent ?? '';
const frameLine = (): string =>
  document.querySelector('#menu-overlay .mr-frame-feedback')?.textContent ?? '';
const rowEls = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('#menu-rows [data-nav-key]'));
const rowKeys = (): string[] => rowEls().map((row) => row.dataset.navKey ?? '');
const rowTexts = (): string[] => rowEls().map((row) => row.textContent ?? '');
const cursor = (): string | null =>
  document.getElementById('menu-rows')?.getAttribute('aria-activedescendant') ?? null;
const statusText = (): string => document.getElementById('status')?.textContent ?? '';
const MENU_KEYS = MENU_ENTRIES.map((entry) => entry.key);

/** One key press and its release, at `window`. */
function tap(code: string): KeyboardEvent {
  clock.t += 100;
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  window.dispatchEvent(down);
  clock.t += 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
  return down;
}

/** The withheld join, then the applied snapshot: what an official server's first connect does. */
function raiseGate(opts: ConnectionOptions): void {
  opts.onAccountRequired?.();
  opts.onReady(H.identity);
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

/** The sign-in screen, as the player should see it in `catalog`'s language. */
function expectSignInScreen(catalog: Record<string, unknown>, label: string): void {
  expect(menuShown(), `${label}: the menu frame is shown`).toBe(true);
  expect(frameTitle(), `${label}: the sign-in title`).toBe(str(catalog, 'claim.gate.signIn.title'));
  expect(rowKeys(), `${label}: exactly one row, sign-in`).toEqual(['signIn']);
  expect(rowTexts(), `${label}: labelled with the provider`).toEqual([signInLabel(catalog)]);
}

/** The not-owned screen, as the player should see it in `catalog`'s language. */
function expectNotOwnedScreen(catalog: Record<string, unknown>, label: string): void {
  expect(menuShown(), `${label}: the menu frame is shown`).toBe(true);
  expect(frameTitle(), `${label}: the not-owned title`).toBe(
    str(catalog, 'claim.gate.notOwned.title'),
  );
  expect(rowKeys(), `${label}: sign-in, then the store`).toEqual(['signIn', 'store']);
  expect(rowTexts(), `${label}: the row labels`).toEqual([
    signInLabel(catalog),
    str(catalog, 'claim.gate.store.title'),
  ]);
}

// --- the cases ----------------------------------------------------------------------------------

describe('the booted client tells connect() an account is required only toward an official server built with an issuer', () => {
  it('hands connect() accountRequired true toward an official server built with an issuer [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the flag never set (the official server is probed with an anonymous
    // join_game); set from the kind alone.
    const opts = await boot('official');
    expect(opts.accountRequired).toBe(true);
  });

  for (const kind of ['official', 'test', 'local', 'private'] as const) {
    it(`hands connect() the onAccountRequired and onOwnershipRefused callbacks toward a ${kind} server [acs-7.1]`, async () => {
      // WRONG IMPL KILLED: the callbacks wired for official alone (a test server's refusal would
      // reach nothing, a local one's would show the raw string).
      const opts = await boot(kind);
      expect(typeof opts.onAccountRequired, `${kind}: onAccountRequired`).toBe('function');
      expect(typeof opts.onOwnershipRefused, `${kind}: onOwnershipRefused`).toBe('function');
    });
  }

  it('does not require an account up front toward a test server, though its build names an issuer [acs-7.1]', async () => {
    // Control: a test server may be open, so its first join is the probe.
    const opts = await boot('test');
    expect(opts.accountRequired ?? false).toBe(false);
  });

  it('does not require an account up front toward an official server built without an issuer [acs-7.1]', async () => {
    // Control: a build that cannot sign in must not withhold the join.
    const opts = await boot('official', { oidc: false });
    expect(opts.accountRequired ?? false).toBe(false);
  });

  for (const kind of ['local', 'private'] as const) {
    it(`does not require an account toward a ${kind} server [acs-7.3]`, async () => {
      // Control: a single-player world or a friends server is never gated here.
      const opts = await boot(kind);
      expect(opts.accountRequired ?? false).toBe(false);
    });
  }
});

describe('the sign-in screen on an official server', () => {
  it('a withheld join then the applied snapshot shows the sign-in screen: its title, one row naming the provider, the standing line, and no menu entry [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the ordinary menu opened instead; the store row offered before any
    // refusal; a main-menu entry reachable; nothing shown at all (the player walks into a world the
    // server never admitted them to).
    const opts = await boot('official');
    raiseGate(opts);
    expectSignInScreen(EN, 'official');
    expect(frameLine()).toBe(str(EN, 'claim.gate.signIn.body'));
    expect(rowKeys().filter((key) => MENU_KEYS.includes(key))).toEqual([]);
    expect(cursor(), 'the cursor is on the sign-in row').toBe('menu-root-signIn');
    expect(H.signIns, 'nothing started on its own').toBe(0);
  });

  it('Enter starts one sign-in from the sign-in row [acs-7.4]', async () => {
    // WRONG IMPL KILLED: A on the gate reaching the menu's own activate (nothing starts).
    const opts = await boot('official');
    raiseGate(opts);
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    const enter = tap('Enter');
    expect(H.signIns).toBe(1);
    expect(enter.defaultPrevented, 'the consumed press is prevented').toBe(true);
  });

  it('a click on the sign-in row starts one sign-in [acs-7.4]', async () => {
    const opts = await boot('official');
    raiseGate(opts);
    const row = rowEls().find((el) => el.dataset.navKey === 'signIn');
    if (row === undefined) throw new Error('no sign-in row to click');
    row.click();
    expect(H.signIns).toBe(1);
  });

  it('Backspace and Escape leave the screen up and show the stays line, starting nothing [acs-7.4]', async () => {
    // WRONG IMPL KILLED: B closing the gate; Escape (Start, close every frame) closing it.
    const opts = await boot('official');
    raiseGate(opts);
    for (const code of ['Backspace', 'Escape']) {
      tap(code);
      expectSignInScreen(EN, code);
      expect(frameLine(), `${code}: the stays line`).toBe(str(EN, 'claim.gate.stays'));
    }
    expect(H.signIns).toBe(0);
  });

  it('M (Start) and the C accelerator leave the screen up and open nothing [acs-7.4]', async () => {
    // WRONG IMPL KILLED: an accelerator opening Profile over the gate; M closing the gate as Start.
    const opts = await boot('official');
    raiseGate(opts);
    tap('KeyM');
    expectSignInScreen(EN, 'after M');
    tap('KeyC');
    expectSignInScreen(EN, 'after C');
    expect(profileShown(), 'the C accelerator opened no Profile').toBe(false);
    expect(H.signIns).toBe(0);
  });

  it('F (Y) shows the sign-in row`s description on the line [acs-7.4]', async () => {
    const opts = await boot('official');
    raiseGate(opts);
    tap('KeyF');
    expect(frameLine()).toBe(str(EN, 'claim.gate.signIn.desc'));
    expectSignInScreen(EN, 'after F');
  });

  it('an ownership refusal after the snapshot shows the not-owned screen at once, with the sign-in and store rows, and the page never shows the raw refusal [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the screen shown only at the next onReady (a refusal settles after it);
    // the store row missing; the raw reducer string on the status line or the error overlay.
    const opts = await boot('official');
    raiseGate(opts);
    opts.onOwnershipRefused?.();
    expectNotOwnedScreen(EN, 'refused');
    expect(frameLine()).toBe(str(EN, 'claim.gate.notOwned.body'));
    expect(document.body.textContent ?? '').not.toContain(RAW_REFUSAL);
  });

  it('the arrows move between the two rows of the not-owned screen, and Enter on the sign-in row starts a sign-in [acs-7.4]', async () => {
    const opts = await boot('official');
    raiseGate(opts);
    opts.onOwnershipRefused?.();
    expect(cursor()).toBe('menu-root-signIn');
    tap('ArrowDown');
    expect(cursor()).toBe('menu-root-store');
    tap('ArrowUp');
    expect(cursor()).toBe('menu-root-signIn');
    tap('Enter');
    expect(H.signIns).toBe(1);
  });

  it('Down then Enter on the store row opens the Steam store in a new tab and starts no sign-in [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the store row starting a sign-in; a store URL other than the Steam store;
    // the new tab opened with access to this page (no noopener).
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const opts = await boot('official');
    raiseGate(opts);
    opts.onOwnershipRefused?.();
    tap('ArrowDown');
    tap('Enter');
    expect(open.mock.calls).toEqual([[STORE_URL, '_blank', 'noopener']]);
    expect(H.signIns).toBe(0);
    expectNotOwnedScreen(EN, 'after the store row');
  });

  it('a failed sign-in puts its catalog line on the screen and opens no Profile [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the failure taking the claim overlay's path (Profile opens over or instead
    // of the gate); the failure line not shown on the gate.
    const opts = await boot('official');
    raiseGate(opts);
    opts.onSignInFailed?.('sign-in-rejected');
    expectSignInScreen(EN, 'after the failure');
    expect(frameLine()).toBe(str(EN, 'claim.signInFailed.rejected'));
    expect(profileShown(), 'no Profile').toBe(false);
  });

  it('a sign-in that failed before the first snapshot shows its line when the screen comes up [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the failure dropped because the gate is not up yet; cleared by the
    // withheld join that follows it.
    const opts = await boot('official');
    opts.onSignInFailed?.('sign-in-expired');
    raiseGate(opts);
    expectSignInScreen(EN, 'after the failed return');
    expect(frameLine()).toBe(str(EN, 'claim.signInFailed.expired'));
    expect(profileShown(), 'no Profile').toBe(false);
  });

  it('a reconnect that withholds its join again leaves the sign-in screen up [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the reconnect sweep closing the menu frame and nothing reopening it.
    const opts = await boot('official');
    raiseGate(opts);
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    opts.onAccountRequired?.();
    opts.onReconnect(H.identity);
    expectSignInScreen(EN, 'after the reconnect');
  });

  it('the own player row arriving in a batch lowers the screen, and the next M opens the ordinary menu [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the gate never lowered; lowered but the menu state left in gate mode (the
    // next M would show the gate again).
    const opts = await boot('official');
    raiseGate(opts);
    expect(menuShown(), 'precondition: the gate is up').toBe(true);
    joinWorld(opts);
    expect(menuShown(), 'the gate is down').toBe(false);
    tap('KeyM');
    expect(menuShown(), 'M opens the menu').toBe(true);
    expect(frameTitle()).toBe(str(EN, 'menu.title'));
    expect(rowKeys()).toEqual(MENU_KEYS);
    tap('Backspace');
    expect(menuShown(), 'and B closes it as ever').toBe(false);
  });

  it('under the French locale the screen reads the French catalog: title, row, standing line, stays line, the not-owned title and the store row [acs-7.4]', async () => {
    // WRONG IMPL KILLED: gate strings resolved in English whatever the locale; a French key missing.
    const opts = await boot('official', SIGN_IN_BUILD, '/?locale=fr');
    raiseGate(opts);
    expectSignInScreen(FR, 'fr');
    expect(frameLine()).toBe(str(FR, 'claim.gate.signIn.body'));
    expect(frameTitle()).not.toBe(str(EN, 'claim.gate.signIn.title'));
    opts.onOwnershipRefused?.();
    expectNotOwnedScreen(FR, 'fr refused');
    expect(frameLine()).toBe(str(FR, 'claim.gate.notOwned.body'));
    expect(rowTexts()[1]).not.toBe(str(EN, 'claim.gate.store.title'));
    tap('Backspace');
    expect(frameLine()).toBe(str(FR, 'claim.gate.stays'));
    expect(frameLine()).not.toBe(str(EN, 'claim.gate.stays'));
  });
});

describe('the not-owned screen on a test server', () => {
  it('a test server joins first and shows nothing; its ownership refusal then shows the not-owned screen at once [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the refusal wired for official alone; a gate raised before any refusal.
    const opts = await boot('test');
    opts.onReady(H.identity);
    expect(menuShown(), 'no screen before the refusal').toBe(false);
    opts.onOwnershipRefused?.();
    expectNotOwnedScreen(EN, 'test refused');
    expect(document.body.textContent ?? '').not.toContain(RAW_REFUSAL);
  });
});

describe('no sign-in screen toward a single-player world, a friends server, or a build with no issuer', () => {
  for (const kind of ['local', 'private'] as const) {
    it(`toward a ${kind} server the gate callbacks open no menu and the status line reads the catalog's not-owned line, never the raw refusal [acs-7.3]`, async () => {
      // WRONG IMPL KILLED: the gate shown on a server whose host binds its players; the refusal
      // left as the raw reducer string; the callbacks reporting nothing.
      const opts = await boot(kind);
      opts.onReady(H.identity);
      opts.onAccountRequired?.();
      opts.onOwnershipRefused?.();
      expect(menuShown(), `${kind}: no menu`).toBe(false);
      expect(statusText(), `${kind}: the catalog line`).toBe(str(EN, 'claim.gate.notOwned.title'));
      expect(document.body.textContent ?? '').not.toContain(RAW_REFUSAL);
    });
  }

  it('toward an official server built without an issuer the gate callbacks open no menu and the status line reads the catalog`s not-owned line [acs-7.3]', async () => {
    // WRONG IMPL KILLED: a gate whose one row starts a sign-in the build cannot do.
    const opts = await boot('official', { oidc: false });
    opts.onReady(H.identity);
    opts.onAccountRequired?.();
    opts.onOwnershipRefused?.();
    expect(menuShown(), 'no menu').toBe(false);
    expect(statusText()).toBe(str(EN, 'claim.gate.notOwned.title'));
  });
});
