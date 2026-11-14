// @vitest-environment happy-dom
/**
 * main.claimCode.test.ts: the booted main.ts clears the stored guest-claim code when the
 * connection reports a SUCCEEDED claim (polish-1 P4).
 *
 * EARS: WHEN a guest claim succeeds, THE CLIENT SHALL clear the stored claim code, so the next
 * account-build connect does not re-issue `complete_guest_claim`.
 *
 * The decision is `ui/claimModel.ts`'s `claimStep` (claimModel.test.ts POLISH1-P4-SUCCEEDED-DELETES);
 * the storage delete is main.ts's `applyClaim`, which runs `claimCode.clear(globalThis, URI, DB)`
 * exactly when the step's effect is `delete-code-and-permit-join`. This file proves the wiring from
 * the connection callback to the real session storage, through the real net/claimCode.ts API:
 * each boot runs under a shell document on the page global (`DOC_A` unless a case says otherwise),
 * a code is minted for that document's target, the connection handler `onClaimResult({ ok: true })`
 * is driven, and the stored code must be gone (`read` undefined, `hasUnconsumed` false). The
 * controls prove the harness can see a clear (a dead-code reject, which already deletes) and that a
 * retain-bucket reject keeps the code.
 *
 * The target cases prove main.ts hands `connect()` exactly the document's `uri` and `db`, and that
 * the claim-code and first-run-nudge storage keys it reads and writes are the ones net/claimCode.ts
 * derives from that pair; a second boot under another document touches no key of the first.
 *
 * RED REASON today: a `claim-succeeded` step has effect 'none', so `onClaimResult({ ok: true })`
 * leaves the consumed code in session storage.
 *
 * Harness: main.dispatch.test.ts's (the views are recording stand-ins, the wasm pkg and the SDK
 * connection are stubbed, the real client/index.html shell is mounted, one fresh main.ts per test),
 * cut down to what this file reads: the connection options the booted main.ts handed `connect()`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  telemetryMock,
  wasmPkgIdentityMoveMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import { claimCode, claimCodeStorageKey } from './net/claimCode';
import type { Connection, ConnectionOptions } from './net/connection';
import { SHELL_CONFIG_GLOBAL, type ShellDocument } from './net/shellDocument';
import { buildClaimViewModel, CLAIM_INITIAL } from './ui/claimModel';

const H = vi.hoisted(() => {
  const h = {
    identity: 'ab'.repeat(32),
    connectOpts: null as ConnectionOptions | null,
    /** The handler object main.ts handed the ClaimView constructor (its last argument). */
    claimHandlers: null as Record<string, unknown> | null,
    /** Every view model main.ts rendered into the ClaimView stand-in, oldest first. */
    claimRenders: [] as unknown[],
    /** A recording stand-in for a view class: it exposes every method main.ts calls on a view.
     *  Only the one named 'ClaimView' records its handlers and renders. */
    makeStub: (name = '') =>
      class {
        visible = false;
        constructor(...args: unknown[]) {
          if (name === 'ClaimView')
            h.claimHandlers = args[args.length - 1] as Record<string, unknown>;
        }
        show(): void {
          this.visible = true;
        }
        hide(): void {
          this.visible = false;
        }
        toggle(): void {
          this.visible = !this.visible;
        }
        render(vm?: unknown): void {
          if (name === 'ClaimView') h.claimRenders.push(vm);
        }
        refresh(): void {}
        hostChrome(): void {}
        showFeedback(): void {}
        // uif-16b: the Profile frame's own surface (ui/profileView.ts), which main.ts calls on the
        // one ProfileView it builds over the three section stand-ins.
        focusSection(): void {}
        sectionOf(): undefined {
          return undefined;
        }
        readonly closeRow: HTMLButtonElement = document.createElement('button');
      },
  };
  return h;
});

// bt-17 (named fixture change, BT17.1): the `./ui/battleView` stand-in is dropped with the module
// (the 1v1 view is purged; the tactical battle roots are built lazily and never at boot).
vi.mock('./ui/boxView', () => ({ BoxView: H.makeStub() }));
vi.mock('./ui/raisingView', () => ({ RaisingView: H.makeStub() }));
vi.mock('./ui/evolutionView', () => ({ EvolutionView: H.makeStub() }));
vi.mock('./ui/shopView', () => ({ ShopView: H.makeStub() }));
vi.mock('./ui/tradeView', () => ({ TradeView: H.makeStub() }));
vi.mock('./ui/pvpView', () => ({ PvpView: H.makeStub() }));
vi.mock('./ui/claimView', () => ({ ClaimView: H.makeStub('ClaimView') }));
vi.mock('./ui/privacyView', () => ({ PrivacyView: H.makeStub() }));
vi.mock('./ui/renameView', () => ({ RenameView: H.makeStub() }));
// uif-16b (named intentional change): main.ts builds one ProfileView over the three section views;
// over these stand-in sections the real frame would read members they do not have, so it is a
// stand-in too.
vi.mock('./ui/profileView', () => ({ ProfileView: H.makeStub() }));
// ts-3 (named intentional change, the Strangler rename): the wizard module is deleted; its stand-in
// becomes the session editor's (the shell's `#tradepropose-overlay` root is not this suite's).
vi.mock('./ui/tradeSessionView', () => ({ TradeSessionView: H.makeStub() }));

vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgIdentityMoveMock({ interact: () => [] }),
);

// The connection: capture the options. main.ts's claim callbacks run against the REAL claim model
// and the REAL session storage; nothing here touches either.
vi.mock('./net/connection', () => {
  const reducers = new Proxy({}, { get: () => () => Promise.resolve() });
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    join: () => undefined,
    worldScope: () => ({ own: null, zones: [], settled: false }),
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  } as unknown as Connection;
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

// --- harness ------------------------------------------------------------------------------
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

/** Mount the REAL client/index.html shell (minus its module script) into the live document. */
function mountIndexHtmlShell(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  expect(parsed.querySelectorAll('[id]').length, 'index.html must yield a body').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 1000 };
let opts: ConnectionOptions;

/** The shell document every boot runs under unless a case names another. Neither target is the
 *  development default (`ws://127.0.0.1:3000` / `monster-realm`). */
const DOC_A: ShellDocument = {
  connection: { uri: 'wss://alpha.example:4443/', db: 'realm-alpha', kind: 'test' },
};
/** A second target differing from DOC_A in both `uri` and `db`. */
const DOC_B: ShellDocument = {
  connection: { uri: 'ws://bravo.example:5050/', db: 'realm-bravo', kind: 'test' },
};

/** Put `doc` on the page global the way `/shell-config.js` does. */
function setShellDocument(doc: ShellDocument): void {
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = doc;
}

/** Boot a fresh main.ts under `doc` and wait for its `connect()` call; no `onReady` yet. */
async function bootUnder(doc: ShellDocument): Promise<void> {
  H.connectOpts = null;
  H.claimHandlers = null;
  H.claimRenders = [];
  setShellDocument(doc);
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  vi.resetModules();
  await import('./main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
}

async function bootReady(): Promise<void> {
  await bootUnder(DOC_A);
  opts.onReady(H.identity);
}

/** Remove a boot's listeners and shell, so a second boot in the same case starts clean. */
function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  document.body.replaceChildren();
}

/** Narrow an optional connection-option callback; a missing one fails loudly rather than skipping. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} was not wired by main.ts`);
  return v;
}

// The target `bootReady` boots under: DOC_A's pair.
const { uri: URI, db: DB } = DOC_A.connection;

/** The deterministic code `seed` mints: 32 bytes of 0xab, hex-encoded (64 lowercase characters). */
const SEEDED_CODE = 'ab'.repeat(32);

/** Mint a claim code for this boot's target through the REAL storage primitive, with an injected
 *  deterministic CSPRNG so the code is known; the storage is the live session storage main.ts reads. */
function seed(): void {
  const host = {
    sessionStorage: globalThis.sessionStorage,
    crypto: {
      getRandomValues: (bytes: Uint8Array): Uint8Array => {
        bytes.fill(0xab);
        return bytes;
      },
    },
  };
  const minted = claimCode.mint(host, URI, DB);
  expect(minted, 'fixture: the code was minted and persisted').toBe(SEEDED_CODE);
  expect(claimCode.read(globalThis, URI, DB), 'fixture: main.ts`s host reads it back').toBe(
    SEEDED_CODE,
  );
}

const stored = (): string | undefined => claimCode.read(globalThis, URI, DB);

describe('main.ts clears the stored claim code on a succeeded claim (polish-1 P4)', () => {
  beforeEach(() => {
    globalThis.sessionStorage.clear();
  });
  afterEach(() => {
    teardownBoot();
    delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    globalThis.sessionStorage.clear();
  });

  it('POLISH1-P4-MAIN-CLEARS: onClaimResult({ ok: true }) removes the stored claim code (read is undefined, hasUnconsumed is false)', async () => {
    // WRONG IMPL KILLED: the current claim-succeeded effect 'none' (the consumed code stays stored;
    // the next account-build connect re-issues complete_guest_claim and the join veto reads a live
    // code); a clear of the nudge slot instead of the code slot; a clear for another target key.
    await bootReady();
    seed();
    expect(
      claimCode.hasUnconsumed(globalThis, URI, DB),
      'precondition: a code is outstanding',
    ).toBe(true);

    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);

    expect(stored(), 'the code is gone').toBeUndefined();
    expect(claimCode.hasUnconsumed(globalThis, URI, DB), 'and no longer vetoes the next join').toBe(
      false,
    );
  });

  it('POLISH1-P4-MAIN-CLEARS-FLOW: the reconnect-driven flow (pending, awaiting the account, then success) ends with the code cleared, and it stays stored until the success arrives', async () => {
    // WRONG IMPL KILLED: a clear on the way (at claim-pending or awaiting-account, before the server
    // answered: a failed claim would have lost its code); no clear at the end.
    await bootReady();
    seed();

    must(opts.onClaimPending, 'onClaimPending')(SEEDED_CODE);
    expect(stored(), 'pending: the code is still stored').toBe(SEEDED_CODE);
    must(opts.onClaimAwaitingAccount, 'onClaimAwaitingAccount')();
    expect(stored(), 'awaiting the account: the code is still stored').toBe(SEEDED_CODE);

    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);
    expect(stored(), 'the success clears it').toBeUndefined();
    expect(claimCode.hasUnconsumed(globalThis, URI, DB)).toBe(false);
  });

  it('POLISH1-P4-MAIN-RETAINS-CONTROL: a rejected claim in a retain bucket (or an unrecognised message) leaves the stored code in place', async () => {
    // CONTROL for the clearing case: an impl that clears on EVERY claim result passes it. The
    // messages are the exact accounts.rs strings of the three retain buckets, plus one unknown.
    await bootReady();
    seed();
    const retain = [
      'already has game data',
      'account already claimed',
      'cannot claim your own session',
      'close your other tab, then retry',
      'already in an ongoing battle',
      'sign in required',
      'no account',
      'account pending deletion',
      'a message the client has never seen',
    ];
    for (const message of retain) {
      must(opts.onClaimResult, 'onClaimResult')({ ok: false, message } as never);
      expect(stored(), `${message}: the code is retained`).toBe(SEEDED_CODE);
      expect(claimCode.hasUnconsumed(globalThis, URI, DB), message).toBe(true);
    }
  });

  it('POLISH1-P4-MAIN-DEAD-CODE-CONTROL: a dead-code reject (invalid / expired) clears the stored code, which proves this harness observes a clear', async () => {
    // CONTROL that makes the red of POLISH1-P4-MAIN-CLEARS mean something: the delete bucket
    // already clears today, so a harness that could not see a clear would fail this too.
    await bootReady();
    for (const message of ['code expired', 'invalid or already-used code']) {
      seed();
      must(opts.onClaimResult, 'onClaimResult')({ ok: false, message } as never);
      expect(stored(), `${message}: the dead code is cleared`).toBeUndefined();
    }
  });

  const claimHandler = (name: string): (() => void) => {
    const handlers = H.claimHandlers;
    if (handlers === null) throw new Error('ClaimView was never constructed by main.ts');
    const fn = handlers[name];
    if (typeof fn !== 'function') throw new Error(`ClaimView received no ${name} handler`);
    return (fn as () => void).bind(handlers);
  };
  const lastClaimVm = (): ReturnType<typeof buildClaimViewModel> => {
    const vm = H.claimRenders.at(-1);
    if (vm === undefined) throw new Error('main.ts rendered nothing into the claim view');
    return vm as ReturnType<typeof buildClaimViewModel>;
  };

  it('POLISH1-P4-MAIN-NON-SUCCESS-KEEPS-CODE: a failed sign-in, an armed-but-unconfirmed decline (and its cancel), and a join refused by the veto all leave the stored code in place', async () => {
    // CONTROL for the clearing case, through the main.ts paths that are NOT a success: an impl that
    // clears the code on any claim UI event passes POLISH1-P4-MAIN-CLEARS and fails here.
    await bootReady();
    seed();

    must(opts.onSignInFailed, 'onSignInFailed')('sign-in-rejected');
    expect(stored(), 'sign-in-failed keeps the code').toBe(SEEDED_CODE);

    must(opts.onClaimPending, 'onClaimPending')(SEEDED_CODE);
    expect(stored(), 'claim-pending keeps the code').toBe(SEEDED_CODE);

    claimHandler('onDeclineRequested')();
    expect(lastClaimVm().actions.declineConfirm, 'precondition: the decline is armed').toBe(true);
    expect(stored(), 'an armed decline deletes nothing').toBe(SEEDED_CODE);
    claimHandler('onDeclineCancelled')();
    expect(lastClaimVm().actions.declineConfirm, 'precondition: the decline is disarmed').toBe(
      false,
    );
    expect(stored(), 'a cancelled decline deletes nothing').toBe(SEEDED_CODE);

    claimHandler('onJoin')();
    expect(lastClaimVm().actions.join, 'precondition: join is vetoed while the claim is out').toBe(
      false,
    );
    expect(stored(), 'a vetoed join deletes nothing').toBe(SEEDED_CODE);
    expect(claimCode.hasUnconsumed(globalThis, URI, DB)).toBe(true);
  });

  it('POLISH1-P4-MAIN-DECLINE-CONFIRMED-CONTROL: an armed, confirmed decline on a live link clears the stored code (the harness sees a clear through the claim view path too)', async () => {
    await bootReady();
    seed();
    must(opts.onClaimPending, 'onClaimPending')(SEEDED_CODE);
    claimHandler('onDeclineRequested')();
    claimHandler('onDeclineConfirmed')();
    expect(stored(), 'the confirmed decline cleared it').toBeUndefined();
    expect(lastClaimVm().actions.join, 'and join is offered').toBe(true);
  });

  it('POLISH1-P4-MAIN-CLAIMED-UI: after onClaimResult({ ok: true }) the claim view is rendered the claimed model (visible, claimed title and body, only Join offered), the code is cleared, and nothing else is cleared early', async () => {
    // WRONG IMPL KILLED: a bare claimCode.clear() in the onClaimResult callback in place of the
    // model step (the storage is cleared, but the claim UI keeps showing the pending claim and the
    // veto: the player is told nothing and join stays unoffered); a step that updates the model
    // but renders nothing.
    await bootReady();
    seed();
    must(opts.onClaimPending, 'onClaimPending')(SEEDED_CODE);
    expect(lastClaimVm().actions.join, 'precondition: pending, join is not offered').toBe(false);

    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);

    expect(stored(), 'the code is cleared').toBeUndefined();
    const claimed = buildClaimViewModel({
      ...CLAIM_INITIAL,
      phase: 'claimed',
      joinPermitted: true,
    });
    expect(claimed.actions, 'fixture: the claimed model offers Join only').toEqual({
      signIn: false,
      join: true,
      decline: false,
      declineConfirm: false,
      declineCancel: false,
    });
    expect(lastClaimVm(), 'the claim view shows the claimed state').toEqual(claimed);
  });
});

// --- the connection target comes from the shell document ------------------------------------

/** Mint the deterministic code for `(uri, db)` into the live session storage. */
function mintFor(uri: string, db: string): void {
  const host = {
    sessionStorage: globalThis.sessionStorage,
    crypto: {
      getRandomValues: (bytes: Uint8Array): Uint8Array => {
        bytes.fill(0xab);
        return bytes;
      },
    },
  };
  expect(claimCode.mint(host, uri, db), 'fixture: the code was minted').toBe(SEEDED_CODE);
}

/** The first-run-nudge key net/claimCode.ts derives for `(uri, db)`, observed on a recording host
 *  (the derivation is private to claimCode, so the test asks claimCode itself). */
function nudgeKeyOf(uri: string, db: string): string {
  const keys: string[] = [];
  const recordingHost = {
    sessionStorage: {
      setItem: (key: string): void => {
        keys.push(key);
      },
    },
  };
  claimCode.markFirstRunNudgeSeen(recordingHost, uri, db);
  expect(keys, 'fixture: claimCode wrote exactly one nudge key').toHaveLength(1);
  return keys[0] as string;
}

/** Record every key the page's session and local storage are asked to get, set or remove.
 *  The spies sit on the two storage INSTANCES: happy-dom's Storage binds `getItem` / `setItem` /
 *  `removeItem` onto an instance at its first access, so a spy on `Storage.prototype` installed
 *  after any earlier access is never called. An instance spy sees every later call, including one
 *  through a `.bind(storage)` copy taken after the spy is installed. */
function spyStorage() {
  const stores = [globalThis.sessionStorage, globalThis.localStorage];
  const gets = stores.map((s) => vi.spyOn(s, 'getItem'));
  const sets = stores.map((s) => vi.spyOn(s, 'setItem'));
  const removes = stores.map((s) => vi.spyOn(s, 'removeItem'));
  const callsOf = (spies: ReadonlyArray<{ mock: { calls: unknown[][] } }>): unknown[][] =>
    spies.flatMap((spy) => spy.mock.calls);
  return {
    gets: (): string[] => callsOf(gets).map((c) => String(c[0])),
    sets: (): Array<readonly [string, string]> =>
      callsOf(sets).map((c) => [String(c[0]), String(c[1])] as const),
    removes: (): string[] => callsOf(removes).map((c) => String(c[0])),
    keys: (): string[] =>
      [...callsOf(gets), ...callsOf(sets), ...callsOf(removes)].map((c) => String(c[0])),
    clear: (): void => {
      for (const spy of [...gets, ...sets, ...removes]) spy.mockClear();
    },
  };
}

/** One press of a physical key on the page (keydown then keyup on window). */
function pressKey(code: string): void {
  for (const type of ['keydown', 'keyup']) {
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  }
}

describe('main.ts connects to and keys its claim storage by the shell document`s target', () => {
  const A = DOC_A.connection;
  const B = DOC_B.connection;

  beforeEach(() => {
    globalThis.sessionStorage.clear();
  });
  afterEach(() => {
    teardownBoot();
    delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    globalThis.sessionStorage.clear();
  });

  it('hands connect() exactly the document`s uri and db, and reads and writes the nudge key and clears the claim-code key claimCode derives from that pair', async () => {
    // WRONG IMPL KILLED: a client that ignores the page global (connect gets the development
    // target and every claim key is the development target's); a target read from the document
    // for connect but from the build env for the claim storage (or the reverse).
    const storage = spyStorage();
    await bootUnder(DOC_A);
    expect({ uri: opts.uri, db: opts.db }, 'connect() receives the document`s pair').toEqual({
      uri: A.uri,
      db: A.db,
    });

    const nudgeA = nudgeKeyOf(A.uri, A.db);
    pressKey('KeyC'); // Profile on Account: the first-run nudge is read, then marked seen
    expect(storage.gets(), 'the nudge read names target A`s key').toContain(nudgeA);
    expect(storage.sets(), 'the nudge mark is written under target A`s key').toContainEqual([
      nudgeA,
      '1',
    ]);
    expect(claimCode.hasSeenFirstRunNudge(globalThis, A.uri, A.db)).toBe(true);

    opts.onReady(H.identity);
    mintFor(A.uri, A.db);
    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);
    expect(storage.removes(), 'the clear names target A`s claim-code key').toContain(
      claimCodeStorageKey(A.uri, A.db),
    );
    expect(claimCode.read(globalThis, A.uri, A.db), 'target A`s code is gone').toBeUndefined();
  });

  it('a second boot under another document connects to that target and touches no key of the first', async () => {
    // WRONG IMPL KILLED: a target cached across boots (the second boot connects to or keys by the
    // first document); claim keys built from a mix of the two documents.
    const storage = spyStorage();
    await bootUnder(DOC_A);
    pressKey('KeyC');
    opts.onReady(H.identity);
    mintFor(A.uri, A.db);
    const codeKeyA = claimCodeStorageKey(A.uri, A.db);
    const nudgeKeyA = nudgeKeyOf(A.uri, A.db);
    expect(globalThis.sessionStorage.getItem(codeKeyA), 'precondition: A`s code is stored').toBe(
      SEEDED_CODE,
    );
    expect(globalThis.sessionStorage.getItem(nudgeKeyA), 'precondition: A`s nudge is marked').toBe(
      '1',
    );

    teardownBoot();
    storage.clear();
    await bootUnder(DOC_B);
    expect({ uri: opts.uri, db: opts.db }, 'connect() receives the second document`s pair').toEqual(
      { uri: B.uri, db: B.db },
    );
    pressKey('KeyC');
    opts.onReady(H.identity);
    mintFor(B.uri, B.db);
    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);
    const touched = storage.keys();

    // Anti-vacuity: the spies saw the second boot's own claim traffic.
    expect(touched, 'the second boot read its nudge key').toContain(nudgeKeyOf(B.uri, B.db));
    expect(storage.removes(), 'the second boot cleared its code key').toContain(
      claimCodeStorageKey(B.uri, B.db),
    );

    const ofA = (key: string): boolean =>
      key.includes(encodeURIComponent(A.uri)) || key.includes(A.db);
    expect(touched.filter(ofA), 'no storage call of the second boot names target A').toEqual([]);
    expect(globalThis.sessionStorage.getItem(codeKeyA), 'A`s code is unchanged').toBe(SEEDED_CODE);
    expect(globalThis.sessionStorage.getItem(nudgeKeyA), 'A`s nudge mark is unchanged').toBe('1');
  });
});
