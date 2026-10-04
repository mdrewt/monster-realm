// @vitest-environment happy-dom
/**
 * main.dialogueDismiss.test.ts: the booted Escape-in-dialogue path through main.ts (ctl-3, CTL3.6).
 *
 * Escape in a server conversation sends `dismissDialogue`, guarded so one press is one call while
 * the dismiss is in flight. The defect this slice closes: the in-flight flag used to be set BEFORE
 * it was known whether any reducer call was made. A press while the live handle was momentarily
 * `undefined` (the link not frozen, the handle simply not there yet) set the flag with no call in
 * flight, and every later Escape was a silent no-op for the rest of the conversation: a dead
 * button. A frozen link was always fine (the send guard short-circuits before the flag is touched).
 *
 * Every case dispatches real KeyboardEvents at the real keydown listener of a freshly imported
 * main.ts and reads the only observable that matters: how many times the (stubbed) `dismissDialogue`
 * reducer was called. The connection stub's `live()` and `linkFrozen()` are controllable, and the
 * dismiss promise can be left unsettled and settled by hand.
 *
 * Harness: main.input.test.ts's pattern, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a controllable
 * rAF, a stubbed wasm pkg and SDK connection, the real client/index.html shell mounted before
 * main.ts imports).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** What the connection stub's `live()` answers: the handle, or `undefined` when false. */
  linkLive: true,
  /** What the connection stub's `linkFrozen()` answers. */
  frozen: false,
  /** The name of every reducer called, oldest first. */
  calls: [] as string[],
  /** When true, `dismissDialogue` returns a promise the test settles by hand. */
  manualDismiss: false,
  /** The controls of every unsettled `dismissDialogue` promise, oldest first. */
  dismissPromises: [] as Array<{ resolve: () => void; reject: (err: unknown) => void }>,
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open grid.
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

// The connection: capture the options; `live()` and `linkFrozen()` answer from the hoisted
// controls; every reducer resolves immediately except a manual `dismissDialogue`.
vi.mock('./net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => (): Promise<void> => {
        H.calls.push(String(name));
        if (name === 'dismissDialogue' && H.manualDismiss) {
          return new Promise<void>((resolve, reject) => {
            H.dismissPromises.push({ resolve, reject });
          });
        }
        return Promise.resolve();
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => (H.linkLive ? live : undefined),
    identity: () => H.identity,
    linkFrozen: () => H.frozen,
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

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus target.
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

/** Mount the REAL client/index.html shell (minus its module script) into the live document. */
function mountIndexHtmlShell(): void {
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

const clock = { t: 0 };
let opts: ConnectionOptions;

async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.linkLive = true;
  H.frozen = false;
  H.calls = [];
  H.manualDismiss = false;
  H.dismissPromises = [];
  clock.t = 1000;
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

const EID = 7n;
const NPC_ENTITY = 11n;

/** Deliver one authoritative batch: own player + character row at clock `t`. */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
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
    t,
  );
  opts.store.flushBatch();
}

/** Seed the world: the own player at (2, 6) plus one dialogue NPC at (3, 6), in one batch. */
function seedWorld(t: number): void {
  opts.store.upsertNpc({
    entityId: NPC_ENTITY,
    npcId: 'guide',
    zoneId: 0,
    homeX: 3,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId: 'no-such-tree',
    interaction: { kind: 'dialogue' },
  });
  opts.store.upsertCharacter(
    {
      entityId: NPC_ENTITY,
      zoneId: 0,
      tileX: 3,
      tileY: 6,
      facing: 'South',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
  server(t);
}

/** The server opens a conversation with the NPC, in one batch. */
function startConversation(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: NPC_ENTITY,
    currentNodeId: 'start',
  });
  server(t);
}

/** Dispatch one cancelable, bubbling Escape keydown at clock `t` and return it. */
function pressEscape(t: number): KeyboardEvent {
  clock.t = t;
  const event = new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

const dismissCalls = (): number => H.calls.filter((name) => name === 'dismissDialogue').length;
const dialogueShown = (): boolean => {
  const el = document.getElementById('dialogue-overlay');
  if (el === null) throw new Error('#dialogue-overlay is not in the shell');
  return el.style.display !== 'none';
};
const shopShown = (): boolean => {
  const el = document.getElementById('shop-overlay');
  if (el === null) throw new Error('#shop-overlay is not in the shell');
  return el.style.display !== 'none';
};
/** The server ends the conversation, in one batch at clock `t`. */
function endConversation(t: number): void {
  opts.store.removeConversation(H.identity);
  server(t);
}
/** Click a greet-then-shop button, as the dialogue renders one. ctl-15 (named intentional change):
 *  the document-level delegate is absorbed by the #game-screen pointer dispatcher, so the button
 *  sits inside the dialogue overlay (in #game-screen); it was appended to document.body. */
function clickShop(t: number, shopId = '1'): void {
  const button = document.createElement('button');
  button.dataset.shopId = shopId;
  const host =
    document.getElementById('dialogue-overlay') ?? document.getElementById('game-screen');
  if (host === null) throw new Error('the shell must ship #dialogue-overlay inside #game-screen');
  host.appendChild(button);
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
}
/** Let queued microtasks and zero-delay timers run (a rejection handler, a deferred focus). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('main.ts Escape-in-dialogue dismiss (runtime, ctl-3)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.linkLive = true;
    H.frozen = false;
    H.manualDismiss = false;
    document.body.replaceChildren();
  });

  it('CTL3-6-BOOT-RECOVERS: an Escape pressed while the live handle is missing sends nothing, and once the handle is back the next Escape sends exactly one dismissDialogue', async () => {
    // WRONG IMPL KILLED: an in-flight flag set before it is known whether any reducer call was
    // made (a press on a missing handle latches the flag with nothing in flight, and every later
    // Escape is a silent no-op: a dead button for the rest of the conversation), and a recovery
    // that sends more than once.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    expect(dismissCalls(), 'precondition: nothing dismissed yet').toBe(0);

    H.linkLive = false; // live() === undefined; the link is NOT frozen
    expect(H.frozen, 'precondition: the link is not frozen').toBe(false);
    pressEscape(1100);
    expect(dismissCalls(), 'no live handle: no reducer call').toBe(0);
    expect(dialogueShown(), 'and the conversation is still on screen').toBe(true);

    H.linkLive = true;
    pressEscape(1200);
    expect(dismissCalls(), 'the handle is back: the next Escape sends exactly once').toBe(1);
  });

  it('CTL3-6-BOOT-FROZEN: an Escape pressed on a frozen link sends nothing, and once the link is unfrozen the next Escape sends exactly one dismissDialogue', async () => {
    // WRONG IMPL KILLED: a frozen-link press that calls the reducer anyway (a call against a dead
    // conn is queued and never settles: the dead-button black hole), and one that latches the
    // in-flight flag so the unfrozen press is swallowed. Regression guard: this held before ctl-3
    // and must keep holding through the shop-open model.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);

    H.frozen = true;
    pressEscape(1100);
    expect(dismissCalls(), 'a frozen link: the reducer is never called').toBe(0);

    H.frozen = false;
    pressEscape(1200);
    expect(dismissCalls(), 'unfrozen: the next Escape sends exactly once').toBe(1);
  });

  it('CTL3-6-BOOT-SINGLE-SEND: Escape pressed twice while the first dismiss is unsettled calls dismissDialogue once; a rejection frees the next press; a settled-but-unanswered dismiss does not', async () => {
    // WRONG IMPL KILLED: no in-flight guard (the second press double-sends), a guard that is never
    // released by a rejection (the button is dead after one failed dismiss), and one released by a
    // resolution alone (the server has not ended the conversation yet: that is the batch's job).
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    H.manualDismiss = true;

    pressEscape(1100);
    pressEscape(1110);
    expect(dismissCalls(), 'two presses, one call while the first is unsettled').toBe(1);
    expect(H.dismissPromises, 'precondition: the first dismiss is unsettled').toHaveLength(1);

    // The reducer rejects: the flight is over, so the next press sends again.
    H.dismissPromises[0]?.reject(new Error('boom'));
    await flush();
    pressEscape(1200);
    expect(dismissCalls(), 'after a rejection the next press sends').toBe(2);
    expect(H.dismissPromises, 'precondition: the second dismiss is unsettled').toHaveLength(2);

    // The reducer resolves but the conversation row is still there: still in flight, no resend.
    H.dismissPromises[1]?.resolve();
    await flush();
    pressEscape(1300);
    expect(dismissCalls(), 'resolved, but the conversation has not ended: no third call').toBe(2);
  });

  it('CTL3-5-BOOT-SHOP-REJECT: a Shop click whose dismiss REJECTS drops its own pending open, so no shop opens when the conversation later ends', async () => {
    // WRONG IMPL KILLED: a rejection handler that always reports the Escape path (a rejected Shop
    // click would then keep its pending shop, and the shop would pop up on the first
    // no-conversation batch although the player's click visibly failed).
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    H.manualDismiss = true;

    clickShop(1100);
    expect(dismissCalls(), 'precondition: the Shop click sent a dismiss').toBe(1);
    expect(H.dismissPromises, 'precondition: it is unsettled').toHaveLength(1);
    H.dismissPromises[0]?.reject(new Error('boom'));
    await flush();

    endConversation(1200);
    expect(dialogueShown(), 'precondition: the conversation ended').toBe(false);
    expect(shopShown(), 'the rejected click opens no shop').toBe(false);
  });

  it('CTL3-6-BOOT-SHOP-NOT-SENT: a Shop click with no live handle sends nothing and leaves the button alive: the next click after the handle returns sends exactly one dismissDialogue', async () => {
    // WRONG IMPL KILLED: the not-sent report wired to the Escape path only (a Shop click on a
    // missing handle would latch the in-flight flag, and the Shop button would be dead for the
    // rest of the conversation: B8 on the shop path). The link is NOT frozen here.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);

    H.linkLive = false;
    expect(H.frozen, 'precondition: the link is not frozen').toBe(false);
    clickShop(1100);
    expect(dismissCalls(), 'no live handle: the Shop click calls no reducer').toBe(0);

    H.linkLive = true;
    clickShop(1200);
    expect(dismissCalls(), 'the handle is back: the next Shop click sends exactly once').toBe(1);

    endConversation(1300);
    expect(shopShown(), 'and the shop opens once the conversation ends').toBe(true);
  });

  it('CTL3-5-BOOT-RECONNECT: a reconnect clears the in-flight dismiss, so an Escape after it sends again', async () => {
    // WRONG IMPL KILLED: a reconnect that does not reset the dismiss step (the SDK never settles
    // the in-flight promise of a dropped link, and an overlapping reconnect re-delivers the
    // conversation row: Escape would be a dead button, and a pending shop a stale open).
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    H.manualDismiss = true;

    pressEscape(1100);
    pressEscape(1110);
    expect(
      dismissCalls(),
      'precondition: the first dismiss is in flight and guards the second',
    ).toBe(1);

    opts.onReconnect?.(H.identity);
    expect(dialogueShown(), 'precondition: the conversation row is still there').toBe(true);
    pressEscape(1200);
    expect(dismissCalls(), 'after the reconnect the next Escape sends again').toBe(2);
  });
});
