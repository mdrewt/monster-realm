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
 * The store also holds the zone the player has just left, for as long as that zone's set lingers.
 * Those rows are not drawn, so the last test pins that the interp-gap sample leaves them out.
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
import { adaptiveInterpDelayMs } from './render/interpolation';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every value main.ts handed to telemetry.recordInterpGap, oldest first. */
  gaps: [] as (number | undefined)[],
  /** The zone id of every `zone_map` call, oldest first. */
  zoneMaps: [] as number[],
}));

// wasm pkg: the walking mock, with a warp in each of zones 0 and 1 (into the other) and no map
// at all for zone 9. Zone 0's 8x8 grid has one wall, at (6,2); zone 1's has one, at (6,4), where
// zone 0 is open (and zone 1 is open at (6,2)). The remote-continuation wiring tests walk remotes
// toward them, so the predicate main.ts hands the resolver must be the drawn zone's.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const base = wasmPkgWalkingMock();
  return {
    ...base,
    zone_map: (zoneId: number) => {
      H.zoneMaps.push(zoneId);
      if (zoneId === 9) throw new Error('no map for zone 9');
      const warps =
        zoneId === 0 || zoneId === 1
          ? [{ from: { x: 1, y: 5 }, to_zone: 1 - zoneId, to_tile: { x: 1, y: 5 } }]
          : [];
      const map = base.zone_map(zoneId);
      const wall = zoneId === 0 ? 2 * map.width + 6 : zoneId === 1 ? 4 * map.width + 6 : -1;
      const walkable = map.walkable.map((w, i) => w && i !== wall);
      return { ...map, walkable, warps };
    },
  };
});

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

vi.mock('./observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./observability/telemetry')>();
  return {
    ...telemetryMock(actual),
    startClientTelemetry: () =>
      Promise.resolve({
        ...actual.NOOP_TELEMETRY,
        recordInterpGap: (gapMs: number | undefined) => {
          H.gaps.push(gapMs);
        },
      }),
  };
});

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
  H.gaps = [];
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
    discriminator: 0,
    leadLevel: 0,
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

  it("connect() is given each zone's warps from the content, by the zone asked for and read once per zone; a zone the content lacks has none [WS-ZONE-WARPS]", async () => {
    // WRONG IMPL KILLED: no zoneWarps (nothing is prefetched, every warp shows an empty zone for
    // a round trip); the warps of the drawn map (rawMap) whatever zone is asked for; a zone_map
    // call per scope run; a throw out of the scope run for an unknown zone.
    await boot();
    const zoneWarps = opts.zoneWarps;
    if (zoneWarps === undefined) throw new Error('main.ts must pass connect() a zoneWarps');
    H.zoneMaps = [];
    // The drawn map is zone 0; the scope asks by the authoritative row's zone.
    expect(zoneWarps(1).map((w) => [w.from, w.to_zone])).toEqual([[{ x: 1, y: 5 }, 0]]);
    expect(zoneWarps(0).map((w) => [w.from, w.to_zone])).toEqual([[{ x: 1, y: 5 }, 1]]);
    expect(zoneWarps(2)).toEqual([]);
    expect(zoneWarps(9), 'no such zone: no warps, and no throw').toEqual([]);
    for (let i = 0; i < 50; i += 1) {
      zoneWarps(0);
      zoneWarps(1);
      zoneWarps(9);
    }
    expect(H.zoneMaps, 'one content read per zone').toEqual([1, 0, 2, 9]);
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
  it('the interp-gap sample is the worst remote of the zone being drawn; a held zone that is not drawn does not count [WS-GAP-ZONE]', async () => {
    // WRONG IMPL KILLED: the sample taken over every character in the store, or over a fixed
    // zone: a jittery remote in the zone just left would be reported as stutter nobody sees.
    await boot();
    settled(false);
    opts.onReady(H.identity);
    batch(1100, (s) => {
      ownRows(s, 1100);
      s.upsertCharacter(character(NPC, 0, 4, 6), 1100);
    });
    settled(true);
    opts.onOwnWarp?.(1);
    batch(1200, (s) => {
      s.upsertCharacter(character(OWN, 1, 1, 5), 1200);
      s.upsertCharacter(character(41n, 1, 3, 5), 1200);
    });
    // Zone 1's remote steps on the step; the zone-0 one, still held, steps off it. Only position
    // changes feed the jitter estimate (a same-tile row does not), so both step between
    // adjacent tiles: 41n every 200 ms (estimate 0), NPC at 1600 and 2000 (intervals 500 and
    // 400: estimate 37.5, then 57.8125, delay 315.625).
    for (const [t, x] of [
      [1400, 4],
      [1600, 3],
      [1800, 4],
      [2000, 3],
    ] as const) {
      batch(t, (s) => s.upsertCharacter(character(41n, 1, x, 5), t));
    }
    batch(1600, (s) => s.upsertCharacter(character(NPC, 0, 5, 6), 1600));
    batch(2000, (s) => s.upsertCharacter(character(NPC, 0, 4, 6), 2000));

    const delayOf = (entityId: bigint): number => {
      const held = Array.from(opts.store.characters()).find((c) => c.row.entityId === entityId);
      if (held === undefined) throw new Error(`no character ${entityId}`);
      return adaptiveInterpDelayMs(held.jitterEwma, 200);
    };
    expect(delayOf(NPC), 'the held zone-0 remote is the jittery one').toBeGreaterThan(delayOf(41n));

    // One frame past the one-second sample window that opened at boot.
    expect(H.gaps).toEqual([]);
    frame(2050);
    expect(H.gaps).toEqual([delayOf(41n)]);
  });

  it('a remote on a straight walk is drawn past its newest tile toward a walkable tile, and never into a wall of the drawn zone [np-a.2]', async () => {
    // WRONG IMPL KILLED: main.ts not handing the resolver a walkability predicate (never
    // continued: OPEN_WALKER never passes x = 5); a predicate that is not the drawn zone's map,
    // e.g. always true (WALL_WALKER is drawn into the wall at (6,2)).
    // Both remotes step east in zone 0 at 1100, 1300, 1500 (x = 3, 4, 5): steps exactly 200 ms
    // apart keep the jitter estimate at 0, the delay at 200. The render clock passes 1500 at
    // 1700; OPEN_WALKER, heading for (6,4), is then continued at one tile per 200 ms to x = 5.5
    // (1800) until the window ends at 2100. WALL_WALKER is heading for (6,2), a wall.
    await boot();
    settled(false);
    opts.onReady(H.identity);
    batch(1100, (s) => ownRows(s, 1100));
    settled(true);
    walkPair({ zoneId: 0, firstAt: 1100, openRow: 4, wallRow: 2 });
  });

  it("after a warp, the walls a remote is held short of are the new zone's [np-a.2]", async () => {
    // WRONG IMPL KILLED: a predicate built once from the map drawn at boot (zone 0). Zone 1 is
    // open at (6,2), where zone 0 has its wall, and walled at (6,4), where zone 0 is open: the
    // boot predicate holds OPEN_WALKER short of (6,2) and draws WALL_WALKER into (6,4).
    // Same timing as the zone-0 test, shifted: steps at 1300, 1500, 1700; continued from 1900 to
    // x = 5.5 by 2000; the window ends at 2300.
    await boot();
    settled(false);
    opts.onReady(H.identity);
    batch(1100, (s) => ownRows(s, 1100));
    settled(true);
    frame(1150);
    // The own character warps to zone 1 (the WS-REVEAL-WARP sequence); the world stays drawn.
    opts.onOwnWarp?.(1);
    batch(1200, (s) => s.upsertCharacter(character(OWN, 1, 1, 5), 1200));
    settled(false);
    frame(1250);
    settled(true);
    walkPair({ zoneId: 1, firstAt: 1300, openRow: 2, wallRow: 4 });
  });

  /**
   * Two remotes in `zoneId` step east from x = 3 to 5, 200 ms apart from `firstAt` (jitter 0,
   * delay 200): OPEN_WALKER on `openRow` toward the zone's open (6, openRow), WALL_WALKER on
   * `wallRow` toward its wall (6, wallRow). Frames every 16 ms until 700 ms after the last step.
   * OPEN_WALKER is continued past x = 5 (to 5.5); WALL_WALKER is never drawn past 5.
   */
  function walkPair(o: {
    zoneId: number;
    firstAt: number;
    openRow: number;
    wallRow: number;
  }): void {
    const OPEN_WALKER = 50n;
    const WALL_WALKER = 51n;
    interface Drawn {
      readonly entityId: string;
      readonly x: number;
      readonly y: number;
    }
    const drawn = (id: bigint): Drawn | undefined =>
      (window as unknown as { __game: () => { rendered: readonly Drawn[] } })
        .__game()
        .rendered.find((e) => e.entityId === id.toString());

    const steps: readonly [number, number][] = [
      [o.firstAt, 3],
      [o.firstAt + 200, 4],
      [o.firstAt + 400, 5],
    ];
    let next = 0;
    const open: number[] = [];
    const wall: number[] = [];
    for (let t = o.firstAt + 16; t <= o.firstAt + 1100; t += 16) {
      while (next < steps.length && steps[next]![0] <= t) {
        const [at, x] = steps[next]!;
        batch(at, (s) => {
          s.upsertCharacter(character(OPEN_WALKER, o.zoneId, x, o.openRow), at);
          s.upsertCharacter(character(WALL_WALKER, o.zoneId, x, o.wallRow), at);
        });
        next++;
      }
      frame(t);
      const op = drawn(OPEN_WALKER);
      const wp = drawn(WALL_WALKER);
      expect(op, `OPEN_WALKER drawn at ${t}`).toBeDefined();
      expect(wp, `WALL_WALKER drawn at ${t}`).toBeDefined();
      expect(op!.y).toBeCloseTo(o.openRow, 9);
      expect(wp!.y).toBeCloseTo(o.wallRow, 9);
      open.push(op!.x);
      wall.push(wp!.x);
    }
    expect(next, 'every step was delivered').toBe(steps.length);
    expect(
      Math.max(...open),
      `drawn past (5,${o.openRow}) toward the open (6,${o.openRow}) of zone ${o.zoneId}`,
    ).toBeGreaterThan(5.25);
    expect(Math.max(...open)).toBeLessThanOrEqual(5.5 + 1e-9);
    expect(
      Math.max(...wall),
      `never drawn past (5,${o.wallRow}) toward the wall (6,${o.wallRow}) of zone ${o.zoneId}`,
    ).toBeLessThanOrEqual(5 + 1e-9);
    expect(wall[wall.length - 1], 'WALL_WALKER rests on its newest tile').toBeCloseTo(5, 9);
  }
});
