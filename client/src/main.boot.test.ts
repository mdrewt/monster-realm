// @vitest-environment happy-dom
/**
 * main.boot.test.ts: runtime tests that import the real main.ts and drive its boot,
 * connect and movement wiring through a stubbed SDK connection and a stubbed wasm pkg.
 *
 * Replaces the source-scan pins in the deleted main.wiring.test.ts
 * (ledger CT-src-main.wiring#netcode-seams). What it drives:
 *   - boot: connect() receives the real store and the status line surfaces onError;
 *   - keydown sends one enqueueMove (a Face; the rows face East, so an ArrowRight press steps),
 *     and a second key for a held direction does not;
 *   - both continuation emitters (frame loop and reconcile divergence) respect the
 *     hold-commit threshold (mvi) and the outstanding-steps gate (nh2);
 *   - the post-warp seq floor, and same-epoch rejection repair (nh3);
 *   - a held key survives a warp rebuild but not a reconnect (nh5);
 *   - an input sent on a dropped socket is not owed after the reconnect.
 *
 * Harness: the main.reducedMotionWiring.test.ts pattern (vi.resetModules + a fresh
 * import per test, recorded window/document listeners detached in afterEach, a
 * controllable rAF). performance.now is one controllable clock for the whole test,
 * because the keydown stamp, the reconcile baseline and the frame all read it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
} from '../test-util/mainBootHarness';
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
  /** The predicted facing main.ts handed the resolver on each frame (index-aligned with
   *  `predicted`). */
  predictedFacing: [] as Array<string | undefined>,
  /** Every renderer.resize(w, h, dpr) main.ts's resize seam issued (uif-2). */
  resizes: [] as Array<{ w: number; h: number; dpr: number }>,
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open
// grid so the predictor produces observable positions.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock({ interact: () => [] }));

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

vi.mock('./render/world', () => {
  class WorldRenderer {
    init(): Promise<void> {
      return Promise.resolve();
    }
    setMap(): void {}
    render(): void {}
    resize(w: number, h: number, dpr: number): void {
      H.resizes.push({ w, h, dpr });
    }
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
      H.predictedFacing.push(input.predicted?.facing);
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

let opts: ConnectionOptions;

/** Set window.innerWidth/innerHeight/devicePixelRatio; each original own descriptor is
 *  restored by afterEach through `restorers` (first change per field only). */
const touched = new Set<string>();
function setWindowBox(w: number, h: number, dpr: number): void {
  const values: Record<string, number> = { innerWidth: w, innerHeight: h, devicePixelRatio: dpr };
  for (const [field, value] of Object.entries(values)) {
    if (!touched.has(field)) {
      touched.add(field);
      const own = Object.getOwnPropertyDescriptor(window, field);
      restorers.push(() => {
        touched.delete(field);
        if (own !== undefined) Object.defineProperty(window, field, own);
        else delete (window as unknown as Record<string, unknown>)[field];
      });
    }
    Object.defineProperty(window, field, { value, configurable: true, writable: true });
  }
}
const uiScaleVar = (): string => document.documentElement.style.getPropertyValue('--mr-ui-scale');

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.predicted = [];
  H.predictedFacing = [];
  H.resizes = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
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

async function bootReady(): Promise<void> {
  await boot();
  opts.onReady(H.identity);
}

const EID = 7n;
/** Deliver one authoritative batch: own player + character row at clock `t`. `ack` is the
 *  character row's `ackedSeq`; the row faces `facing` (East when omitted, so an ArrowRight press,
 *  a Face of East, steps exactly as a Step does). */
function server(
  t: number,
  s: {
    x: number;
    y: number;
    ack: number;
    zone?: number;
    queue?: WasmMoveInput[];
    facing?: 'North' | 'South' | 'East' | 'West';
  },
): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: s.zone ?? 0,
      tileX: s.x,
      tileY: s.y,
      facing: s.facing ?? 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: s.queue ?? [],
      ackedSeq: BigInt(s.ack),
    },
    t,
  );
  opts.store.flushBatch();
}

function key(code: string, t: number, type: 'keydown' | 'keyup' = 'keydown'): void {
  clock.t = t;
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
}

/** One send as text: a Step reads as its direction ('East'), a Jump as 'Jump', and a Face as
 *  'Face:' + its direction ('Face:East'), so a list tells the three inputs apart. */
const step = (s: Sent): string | undefined => {
  if (s.input.tag === 'Step') return s.input.value?.tag;
  if (s.input.tag === 'Face') return `Face:${s.input.value?.tag}`;
  return s.input.tag;
};
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
    raf.cb = null;
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--mr-ui-scale');
  });

  it('UIF2.3 boot writes --mr-ui-scale on the real documentElement and hands the renderer the same triple', async () => {
    document.documentElement.style.removeProperty('--mr-ui-scale');
    setWindowBox(1920, 1080, 1);
    mountIndexHtmlShell();
    await boot();
    await vi.waitFor(() => expect(H.resizes.length).toBeGreaterThan(0), { timeout: 5_000 });
    expect(uiScaleVar()).toBe('1.5');
    expect(H.resizes.at(-1)).toEqual({ w: 1920, h: 1080, dpr: 1 });
  });

  it('UIF2.3 a real resize event rewrites --mr-ui-scale and re-sizes the renderer with the new triple', async () => {
    document.documentElement.style.removeProperty('--mr-ui-scale');
    setWindowBox(1920, 1080, 1);
    mountIndexHtmlShell();
    await boot();
    await vi.waitFor(() => expect(H.resizes.length).toBeGreaterThan(0), { timeout: 5_000 });
    expect(uiScaleVar()).toBe('1.5');

    setWindowBox(1280, 720, 1);
    window.dispatchEvent(new Event('resize'));
    expect(uiScaleVar()).toBe('1');
    expect(H.resizes.at(-1)).toEqual({ w: 1280, h: 720, dpr: 1 });

    setWindowBox(1536, 864, 1.25);
    window.dispatchEvent(new Event('resize'));
    expect(uiScaleVar()).toBe('1.2');
    expect(H.resizes.at(-1)).toEqual({ w: 1536, h: 864, dpr: 1.25 });

    setWindowBox(960, 540, 1);
    window.dispatchEvent(new Event('resize'));
    expect(uiScaleVar()).toBe('0.875');
    expect(H.resizes.at(-1)).toEqual({ w: 960, h: 540, dpr: 1 });
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
    server(1000, { x: 2, y: 2, ack: 0, facing: 'East' });
    key('ArrowRight', 1000);
    // np-c2 (named intentional change): the press sends a Face of East; the row faces East, so
    // the predictor still walks the tile below. Was: ['East'].
    expect(H.sends.map(step)).toEqual(['Face:East']);
    expect(H.sends[0].seq).toBe(1n);
    frame(1010);
    expect(lastPredicted()).toEqual({ x: 3, y: 2 });
  });

  it('a movement keydown from a character facing another way sends ONE Face and the predictor turns it on its tile', async () => {
    // WRONG IMPL KILLED: a press that sends Step (the predictor would walk to (3, 2)), a predictor
    // or rule that treats every Face as a step, and one that drops the Face without turning (the
    // facing would stay North). BOOT-MOVE's twin from a row facing North: the batch at 1000
    // rebases the baseline to 600, so the Face is due at 800 and the frame at 1010 drains it.
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0, facing: 'North' });
    key('ArrowRight', 1000);
    expect(H.sends.map(step)).toEqual(['Face:East']);
    expect(H.sends[0].seq).toBe(1n);
    frame(1010);
    expect(H.sends.map(step), 'the frame sends nothing more').toEqual(['Face:East']);
    expect(lastPredicted(), 'the predicted tile is unchanged: a turn in place').toEqual({
      x: 2,
      y: 2,
    });
    expect(H.predictedFacing.at(-1), 'and the predicted facing turned to East').toBe('East');
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
    // np-c2 (named intentional change): the press's Face of East (the row faces East, so it
    // stepped), then the continuation's Step. Was: ['East', 'East'].
    expect(H.sends.map(step)).toEqual(['Face:East', 'East']);
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
    // np-c2 (named intentional change): the press's Face of East (the row faces East, so it
    // stepped), then the continuation's Step. Was: ['East', 'East'].
    expect(H.sends.map(step)).toEqual(['Face:East', 'East']);
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
    // np-c2 (named intentional change): the press's Face of East (the row faces East, so the
    // predictor stepped it to (3, 2)), then the divergence re-issue's Step. Was: ['East', 'East'].
    expect(H.sends.map(step)).toEqual(['Face:East', 'East']);
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
    // np-c2 (named intentional change): the warp row faces North, so the post-warp ArrowUp press (a
    // Face of North) steps to (5, 4) exactly as a Step did; the subject is the seq floor, not the
    // turn. Was: the warp row faced East (the default).
    server(1100, { zone: 1, x: 5, y: 5, ack: 0, facing: 'North' }); // warp while seq 1 in flight
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
    // np-c2 (named intentional change): the press's Face of East (the row faces East, so it
    // stepped), then the continuation's Step across the warp. Was: ['East', 'East'].
    expect(H.sends.map(step)).toEqual(['Face:East', 'East']);
  });

  it('OWED-FRAME: an input in flight across a warp keeps the frame-loop continuation shut until the row acks it', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    // The NH5-WARP shape, except the warp row does NOT ack seq 1: it is still on the wire.
    server(1300, { zone: 1, x: 5, y: 5, ack: 0 });
    frame(1310);
    frame(1500);
    expect(
      H.sends,
      'the rebuilt predictor reads nothing outstanding, but seq 1 is still owed',
    ).toHaveLength(1);
    server(1510, { zone: 1, x: 5, y: 5, ack: 1, queue: [{ Step: 'East' }] });
    frame(1520);
    expect(H.sends, 'acked, and now the server queue holds the step').toHaveLength(1);
    server(1700, { zone: 1, x: 6, y: 5, ack: 1 });
    frame(1710);
    // np-c2 (named intentional change): the press's Face of East, then the continuation's Step.
    // Was: ['East', 'East'].
    expect(H.sends.map(step)).toEqual(['Face:East', 'East']);
    expect(H.sends[1].seq, 'the continuation is issued above the in-flight seq').toBe(2n);
  });

  it('OWED-REJECT: a rejection of the in-flight input settles it, even though its predictor is gone', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    server(1300, { zone: 1, x: 5, y: 5, ack: 0 });
    frame(1310);
    expect(H.sends).toHaveLength(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    H.sends[0].reject(new Error('rejected')); // addressed to the pre-warp predictor
    await flushMicrotasks();
    frame(1320);
    // np-c2 (named intentional change): the press's Face of East, then the continuation's Step.
    // Was: ['East', 'East'].
    expect(
      H.sends.map(step),
      'nothing is owed once the call has rejected, so the held key continues',
    ).toEqual(['Face:East', 'East']);
  });

  it('OWED-RECONCILE: the divergence re-issue stays shut while an input is owed', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000);
    server(1300, { zone: 1, x: 5, y: 5, ack: 0 }); // warp; seq 1 in flight
    frame(1310);
    // A server reposition the client did not predict: diverged, the hold is committed and
    // the rebuilt predictor has nothing outstanding — only the owed input blocks.
    server(1320, { zone: 1, x: 7, y: 5, ack: 0 });
    expect(H.sends, 'diverged with an input still owed: no re-issue').toHaveLength(1);
    server(1330, { zone: 1, x: 9, y: 5, ack: 1 });
    // np-c2 (named intentional change): the press's Face of East, then the divergence re-issue's
    // Step. Was: ['East', 'East'].
    expect(
      H.sends.map(step),
      'the same divergence with the input acked re-issues from the reconcile, no frame needed',
    ).toEqual(['Face:East', 'East']);
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

  it('OWED-RECONNECT: an input lost on the dropped socket is not owed on the new one', async () => {
    await bootReady();
    server(1000, { x: 2, y: 2, ack: 0 });
    key('ArrowRight', 1000); // seq 1: its call never settles, the socket drops under it
    key('ArrowRight', 1001, 'keyup');
    opts.onReconnect(H.identity);
    server(1300, { x: 2, y: 2, ack: 0 }); // the new connection's rows never ack seq 1
    key('ArrowRight', 1310);
    expect(H.sends.map((s) => s.seq)).toEqual([1n, 2n]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    H.sends[1].reject(new Error('rejected')); // so no ack at or above seq 1 arrives
    await flushMicrotasks();
    frame(1459);
    expect(H.sends, 'held < 150 ms is still a tap: no continuation').toHaveLength(2);
    frame(1460);
    // np-c2 (named intentional change): the two presses' Faces of East (the rows face East), then
    // the continuation's Step. Was: ['East', 'East', 'East'].
    expect(
      H.sends.map(step),
      'seq 1 was sent on the dropped socket; it must not keep the held key from continuing',
    ).toEqual(['Face:East', 'Face:East', 'East']);
    expect(H.sends[2].seq).toBe(3n);
  });
});
