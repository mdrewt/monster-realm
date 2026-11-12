// @vitest-environment happy-dom
/**
 * main.worldReveal.test.ts: when the booted main.ts draws the world's characters.
 *
 * `character` rows arrive in stages on a new connection: the own row first (its own query set),
 * the rest of its zone one round trip later (the zone's set). main.ts draws no character until
 * the connection reports the scope settled, so a login or a reconnect never shows the player
 * standing alone in an empty zone. A warp is different: the world is already drawn, the own
 * character is held, and the destination zone fills in while it stays drawn.
 *
 * What is read: `__game().rendered`, the entities the frame loop resolved on its last frame, and
 * `__game().characters`, the store's rows, which the gate never touches.
 *
 * Harness: main.zoneCue.test.ts's, reduced (a fresh import per test, recorded listeners detached
 * in afterEach, one controllable clock, a stubbed wasm pkg and SDK connection, the real
 * index.html shell, a pumped rAF, rows through the REAL AuthoritativeStore).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  frame,
  mountIndexHtmlShell,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { Connection, ConnectionOptions } from './net/connection';
import type { AuthoritativeStore, StoreCharacter } from './net/store';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock());

vi.mock('./net/connection', () => {
  const reducers = new Proxy({}, { get: () => (): Promise<void> => Promise.resolve() });
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
    worldScope: () => ({ own: null, zones: [], settled: false }),
    continueAnonymously: () => undefined,
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

interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

/** Record module-scope listeners so afterEach can detach them. */
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

let opts: ConnectionOptions;

/** Boot main.ts up to the captured connect() options. No lifecycle callback has run yet. */
async function boot(): Promise<void> {
  H.connectOpts = null;
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
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

const OWN = 7n;
const NPC = 40n;

function character(entityId: bigint, zoneId: number, tileX: number, tileY: number): StoreCharacter {
  return {
    entityId,
    zoneId,
    tileX,
    tileY,
    facing: 'East',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [],
    ackedSeq: 0n,
  };
}

/** Write rows into the REAL store and deliver them as one batch at clock `t`. */
function batch(t: number, rows: (store: AuthoritativeStore) => void): void {
  clock.t = t;
  rows(opts.store);
  opts.store.flushBatch();
}

function ownRows(store: AuthoritativeStore, t: number, zoneId = 0): void {
  store.upsertPlayer({
    identity: H.identity,
    entityId: OWN,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
  });
  store.upsertCharacter(character(OWN, zoneId, 2, 6), t);
}

interface GameHook {
  readonly rendered: readonly { readonly entityId: string }[];
  readonly characters: readonly { readonly entityId: string; readonly zoneId: number }[];
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
const renderedIds = (): string[] =>
  game()
    .rendered.map((e) => e.entityId)
    .sort();
const storeIds = (): string[] =>
  game()
    .characters.map((c) => c.entityId)
    .sort();

function settled(value: boolean): void {
  const edge = opts.onScopeSettled;
  if (edge === undefined) throw new Error('main.ts must pass connect() an onScopeSettled');
  edge(value);
}

describe('main.ts draws the world once its scope has settled', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('login: the own character alone is not drawn; after the settled edge the whole zone is, on the next frame [WS-REVEAL-LOGIN]', async () => {
    // WRONG IMPL KILLED: no gate (the player is drawn alone in an empty zone for a round trip);
    // a gate that never opens; a gate that edits the store instead of the draw list.
    await boot();
    // The connection opens its scope unsettled, before any row, then reports ready.
    settled(false);
    opts.onReady(H.identity);
    frame(1050);
    expect(renderedIds()).toEqual([]);

    // The own-row set applied: the own character is in the store, its zone is not.
    batch(1100, (s) => ownRows(s, 1100));
    frame(1150);
    expect(storeIds(), 'the store holds the row').toEqual(['7']);
    expect(renderedIds(), 'and nothing is drawn yet').toEqual([]);

    // The zone's set applied: the edge comes first, its rows in the same burst.
    settled(true);
    batch(1200, (s) => s.upsertCharacter(character(NPC, 0, 4, 6), 1200));
    frame(1250);
    expect(renderedIds()).toEqual(['40', '7']);
  });

  it('a warp into a zone not yet applied keeps the world drawn: the own character shows at once and the zone fills in [WS-REVEAL-WARP]', async () => {
    // WRONG IMPL KILLED: a gate that follows `settled` level for level (every warp would blank
    // the player for a round trip).
    await boot();
    settled(false);
    opts.onReady(H.identity);
    batch(1100, (s) => {
      ownRows(s, 1100);
      s.upsertCharacter(character(NPC, 0, 4, 6), 1100);
    });
    settled(true);
    frame(1150);
    expect(renderedIds()).toEqual(['40', '7']);

    // The own row moves to zone 1; its set is pending, so the scope is unsettled.
    opts.onOwnWarp?.(1);
    batch(1200, (s) => s.upsertCharacter(character(OWN, 1, 1, 5), 1200));
    settled(false);
    frame(1250);
    expect(renderedIds(), 'the own character in the new zone; zone 0 is filtered out').toEqual([
      '7',
    ]);

    settled(true);
    batch(1300, (s) => s.upsertCharacter(character(41n, 1, 3, 5), 1300));
    frame(1350);
    expect(renderedIds()).toEqual(['41', '7']);
  });

  it('a reconnect hides the world again until the new connection settles [WS-REVEAL-RECONNECT]', async () => {
    // WRONG IMPL KILLED: a latch opened once per page (after a drop the player would be drawn
    // alone until the zone set of the rebuilt connection applied).
    await boot();
    settled(false);
    opts.onReady(H.identity);
    batch(1100, (s) => {
      ownRows(s, 1100);
      s.upsertCharacter(character(NPC, 0, 4, 6), 1100);
    });
    settled(true);
    frame(1150);
    expect(renderedIds()).toEqual(['40', '7']);

    // The drop: the scope ends (the rows are still held at that instant), then the store resets.
    settled(false);
    opts.store.reset();
    opts.store.flushBatch();
    frame(1200);
    expect(renderedIds()).toEqual([]);
    // The rebuilt connection opens its scope, then reports the reconnect.
    settled(false);
    opts.onReconnect(H.identity);
    batch(1300, (s) => ownRows(s, 1300));
    frame(1350);
    expect(storeIds()).toEqual(['7']);
    expect(renderedIds(), 'the own character alone is not drawn').toEqual([]);

    settled(true);
    batch(1400, (s) => s.upsertCharacter(character(NPC, 0, 4, 6), 1400));
    frame(1450);
    expect(renderedIds()).toEqual(['40', '7']);
  });

  it('losing the own character while unsettled hides the rest: no character is drawn around a player who is not there [WS-REVEAL-OWN-LOST]', async () => {
    await boot();
    settled(false);
    opts.onReady(H.identity);
    batch(1100, (s) => {
      ownRows(s, 1100);
      s.upsertCharacter(character(NPC, 0, 4, 6), 1100);
    });
    settled(true);
    frame(1150);
    expect(renderedIds()).toEqual(['40', '7']);

    batch(1200, (s) => s.removeCharacter(OWN));
    settled(false);
    frame(1250);
    expect(storeIds()).toEqual(['40']);
    expect(renderedIds()).toEqual([]);
  });
});
