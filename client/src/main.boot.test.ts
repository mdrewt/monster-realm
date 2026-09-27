// @vitest-environment happy-dom
/**
 * main.boot.test.ts: runtime tests that import the real main.ts and drive its boot,
 * connect and movement wiring through a stubbed SDK connection and a stubbed wasm pkg.
 *
 * Replaces the source-scan pins in the deleted main.wiring.test.ts
 * (ledger CT-src-main.wiring#netcode-seams). What it drives:
 *   - boot: connect() receives the real store and the status line surfaces onError;
 *   - keydown sends one enqueueMove, and a second key for a held direction does not (14r-e);
 *   - both continuation emitters (frame loop and reconcile divergence) respect the
 *     hold-commit threshold (mvi) and the outstanding-steps gate (nh2);
 *   - the post-warp seq floor, and same-epoch rejection repair (nh3);
 *   - a held key survives a warp rebuild but not a reconnect (nh5).
 *
 * Harness: the main.reducedMotionWiring.test.ts pattern (vi.resetModules + a fresh
 * import per test, recorded window/document listeners detached in afterEach, a
 * controllable rAF). performance.now is one controllable clock for the whole test,
 * because the keydown stamp, the reconcile baseline and the frame all read it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { ResolveInput } from './render/renderResolver';

interface Sent {
  readonly input: { readonly tag: string; readonly value?: { readonly tag: string } };
  readonly seq: bigint;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
}

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued, with its promise controls. */
  sends: [] as Sent[],
  /** The predicted position main.ts handed the resolver on each frame. */
  predicted: [] as Array<{ x: number; y: number } | undefined>,
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open
// grid so the predictor produces observable positions.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  const DELTA: Record<string, [number, number]> = {
    North: [0, -1],
    South: [0, 1],
    East: [1, 0],
    West: [-1, 0],
  };
  return {
    apply_move: (
      state: { pos: { x: number; y: number } },
      input: 'Jump' | { Step: string },
      now: number,
    ) => {
      const stamp = Math.floor(now);
      if (input === 'Jump') return { ...state, action: 'Jumping', move_started_at: stamp };
      const [dx, dy] = DELTA[input.Step];
      return {
        ...state,
        facing: input.Step,
        action: 'Walking',
        pos: { x: state.pos.x + dx, y: state.pos.y + dy },
        move_started_at: stamp,
      };
    },
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
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

// The connection: capture the options, expose reducers whose enqueueMove promise the test
// settles by hand. Every other reducer resolves immediately.
vi.mock('./net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') {
          return (args: { input: Sent['input']; seq: bigint }) =>
            new Promise<void>((resolve, reject) => {
              H.sends.push({ input: args.input, seq: args.seq, resolve, reject });
            });
        }
        return () => Promise.resolve();
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
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
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

vi.mock('./render/world', () => {
  class WorldRenderer {
    init(): Promise<void> {
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

// Observation channel: a subclass of the REAL resolver built from importOriginal (a spy on a
// statically imported class would watch a stale module generation after resetModules).
vi.mock('./render/renderResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render/renderResolver')>();
  class RecordingRenderResolver extends actual.RenderResolver {
    override resolve(input: ResolveInput) {
      const p = input.predicted?.pos;
      H.predicted.push(p === undefined ? undefined : { x: p.x, y: p.y });
      return super.resolve(input);
    }
  }
  return { ...actual, RenderResolver: RecordingRenderResolver };
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

/** Record module-scope listeners so afterEach can detach them; otherwise keydown handlers
 *  from earlier module generations stack up and double-send. */
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

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.predicted = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  recordListeners(window);
  recordListeners(document);
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
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
  await boot();
  opts.onReady(H.identity);
}

/** Run one frame at clock `t`. Throws if the frame did not re-arm (it re-arms in `finally`). */
function frame(t: number): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = t;
  cb(t);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

const EID = 7n;
/** Deliver one authoritative batch: own player + character row at clock `t`. */
function server(
  t: number,
  s: { x: number; y: number; ack: number; zone?: number; queue?: WasmMoveInput[] },
): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: BigInt(s.ack),
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: s.zone ?? 0,
      tileX: s.x,
      tileY: s.y,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: s.queue ?? [],
    },
    t,
  );
  opts.store.flushBatch();
}

function key(code: string, t: number, type: 'keydown' | 'keyup' = 'keydown'): void {
  clock.t = t;
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
}

const step = (s: Sent): string | undefined =>
  s.input.tag === 'Step' ? s.input.value?.tag : s.input.tag;
const lastPredicted = () => H.predicted[H.predicted.length - 1];
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('main.ts boot + movement wiring (runtime)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rafCallback = null;
    document.body.innerHTML = '';
  });

  it('BOOT-CONNECT: connect() gets the real store, and onError reaches the #status line', async () => {
    await boot();
    expect(opts.name).toBe('Player');
    expect(typeof opts.uri === 'string' && opts.uri.length > 0).toBe(true);
    expect(typeof opts.db === 'string' && opts.db.length > 0).toBe(true);
    expect(typeof opts.store.onBatchApplied).toBe('function');
    const status = document.getElementById('status');
    expect(status, '#status must exist before any lifecycle callback can fire').not.toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    opts.onError('link', 'socket closed');
    expect(status?.textContent).toBe('link: socket closed');
    expect(H.sends).toHaveLength(0);
  });

  it('BOOT-MOVE: a movement keydown sends ONE enqueueMove and the predictor walks the tile', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    expect(H.sends.map(step)).toEqual(['East']);
    expect(H.sends[0].seq).toBe(1n);
    frame(1010);
    expect(lastPredicted()).toEqual({ x: 3, y: 2 });
  });

  it('14R-E: a second key code for an already-held direction sends nothing; a re-press after release does', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    key('KeyD', 1005);
    expect(H.sends).toHaveLength(1);
    key('ArrowRight', 1020, 'keyup');
    key('KeyD', 1021, 'keyup');
    key('ArrowRight', 1030);
    expect(H.sends.map((s) => s.seq)).toEqual([1n, 2n]);
  });

  it('MVI-FRAME: the frame-loop continuation waits for the hold-commit threshold', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    server(1050, { x: 3, y: 2, ack: 1 }); // acked, nothing outstanding
    frame(1100);
    frame(1149);
    expect(H.sends, 'held < 150 ms is still a tap: no continuation').toHaveLength(1);
    frame(1150);
    expect(H.sends.map(step)).toEqual(['East', 'East']);
    expect(H.sends[1].seq).toBe(2n);
  });

  it('NH2-FRAME: the frame-loop continuation is gated while the server still owes a step', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    frame(1200); // committed and drained, but seq 1 is unacked
    frame(1400);
    expect(H.sends).toHaveLength(1);
    server(1450, { x: 3, y: 2, ack: 1 });
    frame(1460);
    expect(H.sends.map(step)).toEqual(['East', 'East']);
  });

  it('MVI-RECONCILE: a divergence re-issue waits for the hold-commit threshold too', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    frame(1010); // predicted (3,2)
    server(1050, { x: 2, y: 2, ack: 1 }); // pullback: diverged, but held only 50 ms
    expect(H.sends).toHaveLength(1);
  });

  it('NH2-RECONCILE: a committed divergence re-issues once; an owed server queue blocks it', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    frame(1010);
    server(1200, { x: 2, y: 2, ack: 1, queue: [{ Step: 'North' }] }); // diverged, 1 step owed
    expect(H.sends, 'outstanding authoritative step must block the re-issue').toHaveLength(1);
    server(1210, { x: 2, y: 2, ack: 1 }); // queue drained server-side: now diverged + free
    expect(H.sends.map(step)).toEqual(['East', 'East']);
  });

  it('NH3-SAME-EPOCH: a rejected move is dropped and the prediction snaps back to the server, silently', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    frame(1010);
    expect(lastPredicted()).toEqual({ x: 3, y: 2 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    H.sends[0].reject(new Error('rejected'));
    await flushMicrotasks();
    frame(1020);
    expect(lastPredicted(), 'the phantom step must be repaired by a forced reconcile').toEqual({
      x: 2,
      y: 2,
    });
    expect(document.getElementById('status')?.textContent ?? '').toBe('');
  });

  it('NH3-SEQ-FLOOR: after a warp rebuild the next move never reuses an in-flight seq, and the stale rejection spares it', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    key('ArrowRight', 1001, 'keyup');
    server(1100, { zone: 1, x: 5, y: 5, ack: 0 }); // warp while seq 1 is still in flight
    key('ArrowUp', 1110);
    expect(H.sends.map((s) => s.seq)).toEqual([1n, 2n]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    H.sends[0].reject(new Error('rejected')); // pre-warp rejection lands after the rebuild
    await flushMicrotasks();
    frame(1400);
    expect(lastPredicted(), 'the post-warp North step must survive the stale rejection').toEqual({
      x: 5,
      y: 4,
    });
  });

  it('NH5-WARP: a committed hold keeps walking across a warp rebuild', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    server(1100, { x: 3, y: 2, ack: 1 });
    server(1300, { zone: 1, x: 5, y: 5, ack: 1 }); // warp; no frame ran since the press
    frame(1310);
    expect(H.sends.map(step)).toEqual(['East', 'East']);
  });

  it('NH5-RECONNECT: a reconnect rebuild clears the hold (only the warp path preserves it)', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    server(1100, { x: 3, y: 2, ack: 1 });
    opts.onReconnect(H.identity);
    server(1300, { x: 3, y: 2, ack: 1 });
    frame(1310);
    frame(1500);
    expect(H.sends).toHaveLength(1);
  });
});
