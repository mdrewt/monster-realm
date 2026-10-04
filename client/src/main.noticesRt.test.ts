// @vitest-environment happy-dom
/**
 * main.noticesRt.test.ts: the ctl-13 red-team's mutant-killing cases, promoted beside
 * main.notices.test.ts (a dismissed banner's request is still answerable with Y; a request is
 * announced once; F8 does not relist a dismissed error; a held walk key does not resume across the
 * request sheet; the sheet's chips; and Y then Enter twice answers once). Same harness as
 * main.notices.test.ts:
 *
 * main.notices.test.ts: incoming requests as NOTICES through a booted main.ts (ctl-13, CTL13.2 and
 * CTL13.3). An incoming trade or challenge opens nothing and moves no focus: it shows a banner
 * (`#notice-banner`, in the hint bar) and badges the Start chip and the menu's Social row. Y at the
 * world, with no target, opens that request's action sheet (Accept / Decline / View, on Accept), so
 * Y then Enter answers it; B at the world dismisses the top notice (the error toast, then the
 * banner).
 *
 * SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-13;
 * memory/projects/monster-realm-ctl-13-plan.md (REV 2).
 *
 * The views are the REAL ones (nothing replaced but the wasm pkg, the connection, telemetry and
 * the world renderer): the case reads what a player sees (the shown roots, the banner, the chip
 * badge, the menu rows, the world sheet's rows, the error toast) and what the booted page sends
 * (the stubbed reducers record their name and exact arguments).
 *
 * Harness: main.remap.test.ts's pattern, copied and trimmed (vi.resetModules + a fresh import per
 * boot, recorded window / document listeners detached in teardown, one controllable clock, a
 * controllable rAF, the real client/index.html shell mounted first). Every press is a keydown and
 * its keyup 5 ms later on ONE running clock; the stubbed apply_move is a real one-tile step so a
 * movement press is visible as an `enqueueMove`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreBattleChallenge, StoreTradeOffer } from './net/store';
import { tf } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What the stubbed wasm `interact_candidates_coded` answers: no candidate by default. */
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
}));

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
    max_trade_monsters_per_side: () => 64,
    talk_range: () => 2,
    interact_candidates_coded: (...args: unknown[]) => H.interact(...args),
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

vi.mock('./net/connection', () => {
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
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;
/** The ONE running clock of this file: every press, batch and frame moves it on. */
let T = 1000;
const next = (ms: number): number => {
  T += ms;
  return T;
};

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.interact = () => [];
  T = 1000;
  clock.t = T;
  localStorage.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
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

/** Run one frame on the running clock (it re-arms in `finally`). */
function frame(ms = 50): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = next(ms);
  cb(clock.t);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

const EID = 7n;
const BOB = 'bb'.repeat(32);
const CAROL = 'cc'.repeat(32);

/** Deliver one authoritative batch: the own player + character at (2, 6), every send acked. */
function batch(): void {
  clock.t = next(50);
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: BigInt(H.sends.length),
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: 0,
      tileX: 2,
      tileY: 6,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    clock.t,
  );
  opts.store.flushBatch();
}

function seedPlayer(identity: string, name: string, entityId: bigint): void {
  opts.store.upsertPlayer({ identity, entityId, name, online: true, lastInputSeq: 0n });
}

/** A Pending offer from `from` to the booted player. */
const offerFrom = (from: string, tradeId: bigint, createdAtMs: bigint): StoreTradeOffer => ({
  tradeId,
  initiator: from,
  counterparty: H.identity,
  initiatorMonsterIds: [],
  initiatorItems: [],
  initiatorCurrency: 0n,
  counterpartyMonsterIds: [],
  counterpartyItems: [],
  counterpartyCurrency: 0n,
  initiatorCards: [],
  counterpartyCards: [],
  status: 'Pending',
  createdAtMs,
});

/** A Pending challenge from `from` to the booted player. */
const challengeFrom = (
  from: string,
  challengeId: bigint,
  createdAtMs: bigint,
): StoreBattleChallenge => ({
  challengeId,
  challenger: from,
  target: H.identity,
  challengerPartyIds: [],
  status: 'Pending',
  createdAtMs,
});

/** One keydown and its keyup, on the running clock; returns the keydown. */
function press(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  clock.t = next(50);
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(down);
  clock.t = next(5);
  window.dispatchEvent(
    new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true, ...init }),
  );
  return down;
}

// The default keys: Y is KeyF, A is Enter, B is Backspace.
const Y = 'KeyF';
const A = 'Enter';
const B = 'Backspace';

/** Raise the error toast the way a page error does: an uncaught `error` event on the window. */
function raiseError(message: string): void {
  window.dispatchEvent(new ErrorEvent('error', { message, error: new Error(message) }));
}

/** One zero-delay macrotask: a settled reducer promise and overlayA11y's deferred focus. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const isShown = (el: Element): boolean => {
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none' || n.hidden) return false;
  }
  return true;
};
const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};
const shownById = (id: string): boolean => isShown(byId(id));

/** The banner as the player sees it: its text when it is on screen, else null. */
const bannerText = (): string | null => {
  const el = document.getElementById('notice-banner');
  return el !== null && isShown(el) ? (el.textContent ?? '') : null;
};
/** The world sheet's rows, in order. */
const sheetRows = (): string[] =>
  [...document.querySelectorAll('#interact-prompt [role="option"]')].map(
    (el) => el.textContent ?? '',
  );
const sheetShown = (): boolean => shownById('interact-prompt') && sheetRows().length > 0;

const down = (code: string): void => {
  clock.t = next(50);
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
};
const up = (code: string): void => {
  clock.t = next(5);
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
};

describe('RT extra (ctl-13)', { sequential: true }, () => {
  afterEach(teardown);

  it('RT-M01: Y answers a request whose banner was dismissed', async () => {
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    opts.store.upsertChallenge(challengeFrom(CAROL, 21n, 2_000n));
    batch();
    frame();
    press(B);
    press(B);
    frame();
    expect(bannerText()).toBeNull();
    press(Y);
    frame();
    expect(sheetShown(), 'Y (chip still shown) opens the oldest dismissed request').toBe(true);
    press(A);
    await flush();
    expect(H.calls).toEqual([{ name: 'respondTrade', args: { tradeId: 11n, accepted: true } }]);
  }, 60_000);

  it('RT-M05: a second request arriving does not re-announce the first', async () => {
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    batch();
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame(700);
    frame(700);
    const live = byId('a11y-live');
    expect(live.textContent).toBe(tf('notice.request.trade', { name: 'Bob' }));
    opts.store.upsertChallenge(challengeFrom(CAROL, 21n, 500n)); // older: sorts first
    batch();
    frame(700);
    frame(700);
    const line = tf('notice.request.challenge', { name: 'Carol' });
    expect(live.textContent).toBe(line);
    for (let i = 0; i < 3; i += 1) {
      batch();
      frame(700);
      frame(700);
    }
    expect(live.textContent, 'later batches re-announce nothing').toBe(line);
  }, 60_000);

  it('RT-M15: F8 dismiss does not relist the dismissed error', async () => {
    await bootReady();
    batch();
    raiseError('first problem');
    expect(isShown(byId('mr-error-overlay'))).toBe(true);
    press('F8');
    expect(isShown(byId('mr-error-overlay'))).toBe(false);
    raiseError('second problem');
    expect(byId('mr-error-overlay').textContent).toContain('second problem');
    expect(byId('mr-error-overlay').textContent).not.toContain('first problem');
  }, 60_000);

  it('RT-M41: a held walk key does not resume after the request sheet closes', async () => {
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    batch();
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    const pump = (): void => {
      for (let i = 0; i < 4; i += 1) {
        batch();
        frame(300);
      }
    };
    down('KeyD');
    pump();
    const n0 = H.sends.length;
    pump();
    expect(H.sends.length, 'CONTROL: a held key keeps walking').toBeGreaterThan(n0);
    down(Y);
    pump();
    expect(sheetShown()).toBe(true);
    const n1 = H.sends.length;
    pump();
    expect(H.sends.length, 'no walk under the sheet').toBe(n1);
    press(B);
    pump();
    expect(H.sends.length, 'the held D does not resume after the sheet closes').toBe(n1);
    up('KeyD');
    up(Y);
  }, 60_000);

  it('RT-M55: the hint bar shows OK/Back while the request sheet is open', async () => {
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    batch();
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    press(Y);
    frame();
    const chips = [...document.querySelectorAll('#hint-bar [data-button]')].map((el) =>
      el.getAttribute('data-button'),
    );
    expect(chips).toEqual(['A', 'B', 'Start', 'Select']);
  }, 60_000);

  it('RT-DOUBLE: Y Enter, then Y Enter again before the server row changes, answers once', async () => {
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    batch();
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    press(Y);
    press(A);
    await flush();
    frame();
    press(Y);
    frame();
    press(A);
    await flush();
    expect(H.calls, 'one accept only').toHaveLength(1);
  }, 60_000);

  it('RT-DOUBLE-CH: same for a challenge decline then accept', async () => {
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    batch();
    opts.store.upsertChallenge(challengeFrom(BOB, 21n, 1_000n));
    batch();
    frame();
    press(Y);
    press('ArrowDown');
    press(A);
    await flush();
    frame();
    press(Y);
    press(A);
    await flush();
    expect(H.calls, 'decline then a contradictory accept').toHaveLength(1);
  }, 60_000);
});
