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
 * a code is minted for the SAME target main.ts resolves (the same `resolveConnectionConfig`
 * expression), the connection handler `onClaimResult({ ok: true })` is driven, and the stored code
 * must be gone (`read` undefined, `hasUnconsumed` false). The controls prove the harness can see a
 * clear (a dead-code reject, which already deletes) and that a retain-bucket reject keeps the code.
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
import { claimCode } from './net/claimCode';
import type { Connection, ConnectionOptions } from './net/connection';
import { resolveConnectionConfig } from './net/connectionConfig';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** A recording stand-in for a view class: it exposes every method main.ts calls on a view. */
  makeStub: () =>
    class {
      visible = false;
      show(): void {
        this.visible = true;
      }
      hide(): void {
        this.visible = false;
      }
      toggle(): void {
        this.visible = !this.visible;
      }
      render(): void {}
      refresh(): void {}
      hostChrome(): void {}
      showFeedback(): void {}
    },
}));

vi.mock('./ui/boxView', () => ({ BoxView: H.makeStub() }));
vi.mock('./ui/battleView', () => ({ BattleView: H.makeStub() }));
vi.mock('./ui/raisingView', () => ({ RaisingView: H.makeStub() }));
vi.mock('./ui/evolutionView', () => ({ EvolutionView: H.makeStub() }));
vi.mock('./ui/shopView', () => ({ ShopView: H.makeStub() }));
vi.mock('./ui/tradeView', () => ({ TradeView: H.makeStub() }));
vi.mock('./ui/pvpView', () => ({ PvpView: H.makeStub() }));
vi.mock('./ui/claimView', () => ({ ClaimView: H.makeStub() }));
vi.mock('./ui/privacyView', () => ({ PrivacyView: H.makeStub() }));
vi.mock('./ui/renameView', () => ({ RenameView: H.makeStub() }));
vi.mock('./ui/tradeProposeView', () => ({ TradeProposeView: H.makeStub() }));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: (state: unknown) => state,
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 37,
    talk_range: () => 2,
    interact_candidates_coded: () => [],
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
    zone_map: (zoneId: number) => ({
      zone_id: zoneId,
      width: SIDE,
      height: SIDE,
      walkable: grid(true),
      grass: grid(false),
      warps: [],
    }),
  };
});

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

vi.mock('./observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

vi.mock('./render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      mount.appendChild(canvas);
      return Promise.resolve();
    }
    setMap(): void {}
    render(): void {}
    resize(): void {}
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {}
    destroy(): void {}
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

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

async function bootReady(): Promise<void> {
  H.connectOpts = null;
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
  opts.onReady(H.identity);
}

/** Narrow an optional connection-option callback; a missing one fails loudly rather than skipping. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} was not wired by main.ts`);
  return v;
}

// The SAME target main.ts resolves (its module-scope `resolveConnectionConfig` call).
const { uri: URI, db: DB } = resolveConnectionConfig(
  {
    uri: import.meta.env.VITE_STDB_URI as string | undefined,
    db: import.meta.env.VITE_STDB_DB as string | undefined,
  },
  import.meta.env.DEV,
);

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
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    document.body.replaceChildren();
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
});
