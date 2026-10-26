// client/test-util/mainBootHarness.ts — shared TEST helper (never production code).
//
// The boot harness the main.*.test.ts runtime suites had each copied from
// main.input.test.ts, extracted to a single owner (precedent: test-util/stripComments.ts).
// It lives OUTSIDE client/src on purpose: vitest never collects it
// (test.include = src/**/*.test.ts) and it stays out of the coverage denominator
// (coverage.include = src/**/*.ts).
//
// What lives here: the real-index.html shell mounters, the controllable clock + rAF
// driver, and the duplicated vi.mock FACTORY bodies (wasm pkg, connection, telemetry,
// renderer). The vi.mock REGISTRATIONS stay in each test file — vitest hoists them
// per module, so they cannot move. Each file's divergent server()/batch() builders
// also stay per-file ON PURPOSE: unifying genuinely different fixtures is the
// fixture-monoculture pathology, not deduplication.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import type { Connection, ConnectionOptions } from '../src/net/connection';

// --- real-shell mounters ---------------------------------------------------------------------

/** Mount the REAL client/index.html shell (minus its module script) into the live document. */
export function mountIndexHtmlShell(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

/** The same real-shell mount, as the feedback/partyFull suites phrase it (no #app assert). */
export function buildAppShellFromRealIndexHtml(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.children).filter((e) => e.tagName !== 'SCRIPT');
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'parsed index.html yielded almost no id-bearing elements').toBeGreaterThan(5);
  document.body.replaceChildren(...bodyChildren.map((e) => document.adoptNode(e)));
}

// --- controllable clock + rAF driver ---------------------------------------------------------

/** The one controllable clock; boots point performance.now at `clock.t`. */
export const clock = { t: 0 };

/** The armed requestAnimationFrame callback (null = not armed). */
export const raf: { cb: FrameRequestCallback | null } = { cb: null };

/** Stub requestAnimationFrame so each armed callback lands in `raf.cb` (cleared first). */
export function stubRaf(): void {
  raf.cb = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    raf.cb = cb;
    return 0;
  });
}

/** Run one frame at clock `t`. Throws if the frame did not re-arm (it re-arms in `finally`). */
export function frame(t: number): void {
  const cb = raf.cb;
  if (cb === null) throw new Error('no rAF callback armed');
  raf.cb = null;
  clock.t = t;
  cb(t);
  expect(raf.cb, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

// --- vi.mock factory bodies ------------------------------------------------------------------

/** What a test file's stubbed wasm `interact_candidates_coded` answers. */
export type InteractStub = (...args: unknown[]) => unknown;

/** What a test file's stubbed wasm `care_remaining_ms` answers (qf-3). */
export type CareRemainingStub = (lastCareAtMs: bigint, nowMs: bigint) => bigint;

/**
 * wasm pkg factory: every name main.ts imports. apply_move is a real one-tile step on an open
 * 8x8 grid. `interact` (when given) becomes the `interact_candidates_coded` export; when absent
 * the key is absent, exactly as in the files that predate the ctl-10a interact export.
 * qf-3: `careRemaining` (when given) becomes the `care_remaining_ms` export, so a boot test can
 * observe the arguments the Monsters sheet passes it; absent, the export answers 0n (ready).
 */
export function wasmPkgWalkingMock(
  opts: {
    interact?: InteractStub;
    /** qf-3: the care-readiness export; default always-ready. */
    careRemaining?: CareRemainingStub;
  } = {},
) {
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
    // qf-3: named fixture change: the care-readiness export (`-> i64` crosses as a BigInt).
    care_remaining_ms: opts.careRemaining ?? ((): bigint => 0n),
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
    talk_range: () => 2,
    ...(opts.interact === undefined ? {} : { interact_candidates_coded: opts.interact }),
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
}

/**
 * wasm pkg factory: movement fully stubbed (apply_move yields {}), tiny 3x3 map. `interact`
 * defaults to the no-candidates stub; `grace` is read lazily so a test can drive it.
 */
export function wasmPkgStubMock(opts: { interact?: InteractStub; grace?: () => bigint } = {}) {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    // qf-3: named fixture change: the care-readiness export, always ready (0n).
    care_remaining_ms: (): bigint => 0n,
    // `-> i64` crosses as a BigInt, so the stub is `1n`, not `1`.
    deletion_grace_ms_default: opts.grace ?? (() => 1n),
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
    talk_range: () => 2,
    // ctl-10a: named fixture change — the new interact export
    interact_candidates_coded: opts.interact ?? (() => []),
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
}

/**
 * wasm pkg factory: apply_move is the identity (movement irrelevant), 8x8 map, and the
 * trade cap is the 37 the trade suites pin. `interact` as in wasmPkgWalkingMock.
 */
export function wasmPkgIdentityMoveMock(opts: { interact?: InteractStub } = {}) {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: (state: unknown) => state,
    // qf-3: named fixture change: the care-readiness export, always ready (0n).
    care_remaining_ms: (): bigint => 0n,
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 37,
    talk_range: () => 2,
    ...(opts.interact === undefined ? {} : { interact_candidates_coded: opts.interact }),
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
}

/** Renderer factory: init(mount) appends a focusable canvas so main.ts resolves its world focus. */
export function worldRendererMock() {
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
}

/** Renderer factory: like worldRendererMock, but init() appends nothing (no world focus). */
export function worldRendererNoCanvasMock() {
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
}

type TelemetryModule = typeof import('../src/observability/telemetry');

/** Telemetry factory body: the real module with the SDK loader fenced off and a no-op start. */
export function telemetryMock(actual: TelemetryModule): TelemetryModule {
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
}

/** The hoisted state the recording connection factory writes into (each file's `H`). */
export interface ConnectionRecordingHoisted {
  identity: string;
  connectOpts: ConnectionOptions | null;
  /** Every enqueueMove the client issued. */
  sends: unknown[];
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: Array<{ name: string; args: unknown }>;
}

/**
 * Connection factory body: capture the connect options in `H.connectOpts`; enqueueMove never
 * settles and lands in `H.sends`, every other reducer records into `H.calls` and resolves.
 */
export function connectionRecordingMock(H: ConnectionRecordingHoisted): {
  connect: (opts: ConnectionOptions) => Connection;
} {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') {
          return (args: unknown) =>
            new Promise<void>(() => {
              H.sends.push(args);
            });
        }
        return (args: unknown) => {
          H.calls.push({ name: String(name), args });
          return Promise.resolve();
        };
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
}
