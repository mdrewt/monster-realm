// @vitest-environment happy-dom
/**
 * main.input.test.ts: the booted keyboard path through main.ts (ctl-1, CTL1.1 to CTL1.4).
 *
 * The router, the keyboard source and the binding table are proven in their own pure
 * suites. This file proves the SHELL: that main.ts actually routes key events through them.
 * Every case dispatches real KeyboardEvents at the real keydown/keyup/blur/visibilitychange
 * listeners of a freshly imported main.ts and reads the observable result: the intents sent
 * to the (stubbed) enqueueMove reducer, `defaultPrevented`, and which overlay is shown.
 *
 * Harness: main.boot.test.ts's pattern, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a
 * controllable rAF, a stubbed wasm pkg and SDK connection), with ONE delta: the real
 * client/index.html shell is mounted before main.ts imports, so the real overlay views
 * exist (the PvP and rename overlays are subjects of these tests). The renderer stub
 * appends a focusable canvas, as main.a11yFocus.test.ts does.
 *
 * Positions: the stubbed apply_move steps one tile, North is y - 1. Each test seeds the
 * character at (2, 6) and acks every send with the tile the predictor already holds, so a
 * reconcile never diverges and the only intents sent are the ones the input path issues.
 *
 * The contract proven here: the keyboard feeds the router through one binding table; two keys
 * of one direction are refcounted (the walk ends when the last is released); Ctrl/Alt/Meta
 * chords belong to the browser (no hotkey, no movement, no preventDefault) yet a chorded
 * keyup still releases; a key a text field or native button owns is not routed or prevented
 * (also on the key-repeat path); blur and a hidden visibilitychange release every held key;
 * a consumed D-pad or Space press is prevented, an unbound key is not.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreBattle, StoreBattleMonster, StoreMonsterPub, StoreNpcRow } from './net/store';
import { HOLD_COMMIT_MS } from './prediction/heldKeys';
import type { NavInput } from './ui/nav';

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
  /** What the connection stub's `sessionState()` answers. Reset to 'hidden' by every boot, so
   *  only a case that sets it sees a session terminal (ctl-2's CTL2-3-BOOT-SESSION). */
  sessionState: 'hidden' as string,
  /** The name of every reducer called other than enqueueMove, oldest first (ctl-2 asserts on
   *  `talk`). Reset by every boot. */
  calls: [] as string[],
  /** The screen-adapter table main.ts's host reads: a mutable copy of the real one, re-made by the
   *  module mock below on every fresh import, so a ctl-7c case can swap ONE frame's adapter. */
  adapters: {} as Record<string, unknown>,
  /** ctl-10a: every reducer call other than enqueueMove with the exact argument object it got,
   *  oldest first (talk's npcEntityId, healParty's locationId). Reset by every boot. */
  callArgs: [] as Array<{ name: string; args: unknown }>,
  /** ctl-10a: every call main.ts made to the wasm `interact_candidates_coded` export, with its
   *  arguments verbatim, oldest first. Reset by every boot. */
  interactCalls: [] as unknown[][],
  /** ctl-10a: what the stubbed export answers. The stub IS the interaction rule (CTL10A.1): each
   *  case installs its own through `useRule`. Reset to "no candidate" by every boot. */
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
  /** ctl-10a: tiles ("x,y") the stubbed apply_move will not enter: a step into one turns the
   *  character to face it and moves nothing (a facing-only change). Reset by every boot. */
  blocked: new Set<string>(),
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open grid.
// ctl-10a: named fixture change. A step into an `H.blocked` tile only turns the character (no
// existing case blocks a tile), and the new interact export is a recording stub driven by
// `H.interact`.
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
      const to = { x: state.pos.x + dx, y: state.pos.y + dy };
      if (H.blocked.has(`${to.x},${to.y}`)) {
        return { ...state, facing: input.Step, move_started_at: stamp };
      }
      return {
        ...state,
        facing: input.Step,
        action: 'Walking',
        pos: to,
        move_started_at: stamp,
      };
    },
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
    talk_range: () => 2,
    // ctl-10a: named fixture change — the new interact export
    interact_candidates_coded: (...args: unknown[]) => {
      H.interactCalls.push(args);
      return H.interact(...args);
    },
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
// settles by hand (never, here). Every other reducer resolves immediately.
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
        // ctl-10a: named fixture change — the argument object is recorded too.
        return (args: unknown) => {
          H.calls.push(String(name));
          H.callArgs.push({ name: String(name), args });
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
    sessionState: () => H.sessionState,
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

// The screen-adapter table: the real module with SCREEN_ADAPTERS replaced by a mutable copy of
// itself (every entry the same legacy adapter, so nothing changes until a case swaps one).
vi.mock('./ui/screens/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/screens/index')>();
  H.adapters = { ...actual.SCREEN_ADAPTERS };
  return { ...actual, SCREEN_ADAPTERS: H.adapters };
});

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world
// focus target (main.a11yFocus.test.ts's delta 2).
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
    // ctl-10a: named fixture change — the identity mapping (was a constant origin), so the chip's
    // position names the world anchor main.ts handed it (CTL10A-3-BOOT-CHIP-ANCHOR). No other case
    // reads a position.
    screenFor(p: { x: number; y: number }): { x: number; y: number } {
      return { x: p.x, y: p.y };
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

/** Mount the REAL client/index.html shell (minus its module script) into the live document,
 *  so main.ts builds the real overlay views against the real static shells. */
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
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.sessionState = 'hidden';
  H.calls = [];
  H.callArgs = [];
  H.interactCalls = [];
  H.interact = () => [];
  H.blocked = new Set<string>();
  clock.t = 1000;
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
function server(t: number, s: { x: number; y: number; ack: number }): void {
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
      zoneId: 0,
      tileX: s.x,
      tileY: s.y,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
  opts.store.flushBatch();
}

/** Ack everything sent so far, the character standing where the predictor already put it.
 *  Only valid for North-only walks from (2, 6): after n sends it stands at (2, 6 - n). */
function ackAllNorth(t: number, startY = 6): void {
  const n = H.sends.length;
  server(t, { x: 2, y: startY - n, ack: n });
}

interface FireOpts {
  readonly target?: EventTarget;
  readonly init?: KeyboardEventInit;
}
/** Dispatch one cancelable, bubbling key event at clock `t` and return it. Default target is
 *  `window` (where main.ts listens); a DOM target bubbles up to it. */
function fire(type: 'keydown' | 'keyup', code: string, t: number, o: FireOpts = {}): KeyboardEvent {
  clock.t = t;
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...o.init });
  (o.target ?? window).dispatchEvent(event);
  return event;
}

const step = (s: Sent): string | undefined =>
  s.input.tag === 'Step' ? s.input.value?.tag : s.input.tag;
const dirs = (): Array<string | undefined> => H.sends.map(step);

const overlayShown = (id: string): boolean => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the shell`);
  return el.style.display !== 'none';
};
const pvpShown = (): boolean => overlayShown('pvp-challenge-overlay');
const renameShown = (): boolean => overlayShown('rename-overlay');

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('main.ts keyboard routing (runtime)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL1-1-BOOT-JUMP: Space at the world sends exactly one Jump and is prevented; Space on a focused button sends nothing and is left alone', async () => {
    // WRONG IMPL KILLED: a router that takes Space everywhere (a focused button never
    // activates), one that ignores the target (the focused-button Space regression), one that
    // jumps on the up edge or on every repeat, and one that forgets preventDefault (the page
    // scrolls).
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    const onButton = fire('keydown', 'Space', 1000, { target: button });
    expect(H.sends, 'Space on a focused <button> must not jump').toHaveLength(0);
    expect(onButton.defaultPrevented, 'native activation must stay uncancelled').toBe(false);
    fire('keyup', 'Space', 1005, { target: button });
    expect(H.sends).toHaveLength(0);
    button.remove();
    document.body.focus();

    // Control: the very same key at the world jumps, so the button case above was not
    // silent for an unrelated reason.
    const atWorld = fire('keydown', 'Space', 1020);
    expect(dirs()).toEqual(['Jump']);
    expect(atWorld.defaultPrevented).toBe(true);
    // OS key-repeat and the keyup add no further jump.
    fire('keydown', 'Space', 1040, { init: { repeat: true } });
    fire('keyup', 'Space', 1060);
    expect(dirs(), 'exactly one Jump for one press').toEqual(['Jump']);
  });

  it('CTL1-1-BOOT-RELEASE: blur and a hidden visibilitychange release every held key; a visible visibilitychange releases nothing', async () => {
    // WRONG IMPL KILLED: no visibilitychange listener at all (the new behaviour), a listener
    // that releases on any visibilitychange (tab-switch back would drop a real hold), a
    // release that clears the shell's held set but not the router/source (the next press
    // would be eaten as a duplicate), and a blur that releases nothing.
    // Counts are snapshotted before each action instead of asserted absolutely: a server
    // batch that lands while a key is committed-held can legitimately re-issue a step through
    // the reconcile-divergence emitter, so only growth / no growth across an action is the
    // contract. The server is acked at the tile the predictor holds (start y = 7 leaves room
    // for the handful of North steps this walk can issue).
    const Y0 = 7;
    await bootReady();
    server(1000, { x: 2, y: Y0, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    expect(dirs()).toEqual(['North']);
    ackAllNorth(1050, Y0);

    // Control: a VISIBLE visibilitychange keeps the hold alive, so the continuation fires.
    setVisibility('visible');
    const beforeVisible = H.sends.length;
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    frame(1160);
    expect(H.sends.length, 'visible visibilitychange must not release').toBeGreaterThan(
      beforeVisible,
    );
    ackAllNorth(1200, Y0);

    // Hidden: everything is released, the walk stops. After the dispatch the server is
    // acked, so a still-held key WOULD send on the next frame.
    const beforeHidden = H.sends.length;
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    setVisibility('visible');
    ackAllNorth(1300, Y0);
    frame(1310);
    frame(1400);
    expect(H.sends.length, 'hidden visibilitychange must stop the continuation').toBe(beforeHidden);

    // The release reset the router and the source: a fresh press steps again, then holds.
    fire('keydown', 'KeyW', 1500);
    expect(H.sends.length, 'a fresh press after the release steps').toBe(beforeHidden + 1);
    ackAllNorth(1550, Y0);
    const beforeContinuation = H.sends.length;
    frame(1660);
    expect(H.sends.length, 'control: the fresh hold continues').toBeGreaterThan(beforeContinuation);
    ackAllNorth(1700, Y0);

    // Blur releases too.
    const beforeBlur = H.sends.length;
    window.dispatchEvent(new Event('blur'));
    ackAllNorth(1750, Y0);
    frame(1800);
    frame(1900);
    expect(H.sends.length, 'blur must stop the continuation').toBe(beforeBlur);
  });

  it('CTL1-2-BOOT-REFCOUNT: holding W while pressing and releasing ArrowUp keeps walking north until W is released', async () => {
    // WRONG IMPL KILLED: the ArrowUp keyup releasing North (today's defect, KEY_DIR keyed by
    // direction), a router that releases on the first up, and one that never releases (the
    // walk would not stop when W finally lets go).
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    expect(dirs()).toEqual(['North']);
    fire('keydown', 'ArrowUp', 1005);
    expect(dirs(), 'a second key of a held direction sends nothing').toEqual(['North']);
    fire('keyup', 'ArrowUp', 1020);
    ackAllNorth(1050);

    frame(1160); // W has been held 160 ms: committed, and the server owes nothing.
    expect(dirs(), 'W is still held, so the walk continues').toEqual(['North', 'North']);
    ackAllNorth(1200);
    frame(1210);
    expect(dirs(), 'and keeps continuing while W stays down').toHaveLength(3);
    ackAllNorth(1250);

    fire('keyup', 'KeyW', 1260);
    frame(1400);
    frame(1600);
    expect(dirs(), 'W released: no further North').toHaveLength(3);
  });

  it('CTL1-3-BOOT-CTRL-P: a Ctrl, Alt or Meta chord opens nothing, moves nothing and is left to the browser; the bare key still works', async () => {
    // WRONG IMPL KILLED: no chord filter (Ctrl+P opens PvP and swallows the browser's print,
    // Ctrl+W steps and is cancelled, Alt+Space jumps), a filter only on movement, and one
    // only on hotkeys.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    expect(pvpShown(), 'precondition: PvP starts hidden').toBe(false);
    expect(renameShown(), 'precondition: rename starts hidden').toBe(false);

    let t = 1000;
    const next = (): number => {
      t += 10;
      return t;
    };
    for (const flag of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      for (const code of ['KeyP', 'KeyN']) {
        const e = fire('keydown', code, next(), { init: { [flag]: true } });
        expect(e.defaultPrevented, `${flag}+${code} must reach the browser`).toBe(false);
        fire('keyup', code, next(), { init: { [flag]: true } });
      }
      expect(pvpShown(), `${flag}+P must not open PvP`).toBe(false);
      expect(renameShown(), `${flag}+N must not open rename`).toBe(false);
    }

    const ctrlW = fire('keydown', 'KeyW', next(), { init: { ctrlKey: true } });
    expect(ctrlW.defaultPrevented, 'Ctrl+W (close tab) must not be cancelled').toBe(false);
    fire('keyup', 'KeyW', next(), { init: { ctrlKey: true } });
    const altSpace = fire('keydown', 'Space', next(), { init: { altKey: true } });
    expect(altSpace.defaultPrevented).toBe(false);
    fire('keyup', 'Space', next(), { init: { altKey: true } });
    const metaArrow = fire('keydown', 'ArrowUp', next(), { init: { metaKey: true } });
    expect(metaArrow.defaultPrevented).toBe(false);
    fire('keyup', 'ArrowUp', next(), { init: { metaKey: true } });
    expect(H.sends, 'no chord may step or jump').toHaveLength(0);

    // Control: the bare key opens PvP in this very state, so the hidden overlay above is
    // the chord filter's doing and not a harness that cannot open it.
    fire('keydown', 'KeyP', next());
    expect(pvpShown(), 'bare KeyP must open PvP').toBe(true);
  });

  it('CTL1-3-BOOT-PREVENT: preventDefault is called for consumed D-pad edges (held, repeated or gated) and never for unbound keys or chords', async () => {
    // WRONG IMPL KILLED: preventDefault on every key (an unbound key's default is
    // swallowed), none on repeat or under an overlay (the page scrolls under a held arrow),
    // and preventDefault on a chord.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });

    const w = fire('keydown', 'KeyW', 1000);
    expect(w.defaultPrevented, 'a consumed D-pad press is prevented').toBe(true);
    expect(dirs()).toEqual(['North']);
    const repeat = fire('keydown', 'KeyW', 1020, { init: { repeat: true } });
    expect(repeat.defaultPrevented, 'an OS repeat of a D-pad key is still prevented').toBe(true);
    fire('keyup', 'KeyW', 1040);

    const z = fire('keydown', 'KeyZ', 1060);
    expect(z.defaultPrevented, 'an unbound key is not prevented').toBe(false);
    fire('keyup', 'KeyZ', 1070);
    const tab = fire('keydown', 'Tab', 1080);
    expect(tab.defaultPrevented, 'Tab (reserved) is not prevented').toBe(false);
    fire('keyup', 'Tab', 1085);
    const ctrlD = fire('keydown', 'KeyD', 1090, { init: { ctrlKey: true } });
    expect(ctrlD.defaultPrevented, 'a chord is not prevented').toBe(false);
    fire('keyup', 'KeyD', 1095, { init: { ctrlKey: true } });
    expect(dirs(), 'only the bare W stepped').toEqual(['North']);

    // Gated: with an overlay open the D-pad press is still consumed (no page scroll) but
    // sends nothing.
    fire('keydown', 'KeyP', 1100);
    expect(pvpShown(), 'precondition: PvP is open').toBe(true);
    const gated = fire('keydown', 'ArrowDown', 1120);
    expect(gated.defaultPrevented, 'a D-pad press under an overlay is prevented').toBe(true);
    expect(dirs(), 'and moves nothing').toEqual(['North']);
    fire('keyup', 'ArrowDown', 1140);
  });

  it('CTL1-4-BOOT-INPUT: a movement key or Space typed into a text field, select or textarea moves nothing and is not prevented', async () => {
    // WRONG IMPL KILLED: the router ignoring the event target (typing "w" into a field walks
    // the character and eats the character), ownership applied to the window only, and a
    // field-owned keyup that is mistaken for a release of a world key.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    expect(pvpShown() || renameShown(), 'precondition: no overlay is open').toBe(false);

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement, 'precondition: the input has focus').toBe(input);

    const w = fire('keydown', 'KeyW', 1000, { target: input });
    expect(w.defaultPrevented, 'typing w must not be cancelled').toBe(false);
    fire('keyup', 'KeyW', 1010, { target: input });
    const space = fire('keydown', 'Space', 1020, { target: input });
    expect(space.defaultPrevented, 'typing a space must not be cancelled').toBe(false);
    fire('keyup', 'Space', 1030, { target: input });
    expect(H.sends, 'nothing typed in a field may move or jump').toHaveLength(0);

    const select = document.createElement('select');
    const textarea = document.createElement('textarea');
    document.body.append(select, textarea);
    for (const [target, code] of [
      [select, 'ArrowLeft'],
      [textarea, 'KeyD'],
    ] as const) {
      const e = fire('keydown', code, 1040, { target });
      expect(e.defaultPrevented, `${target.tagName} ${code}`).toBe(false);
      fire('keyup', code, 1050, { target });
    }
    expect(H.sends).toHaveLength(0);

    // Control: the same keys on the world (focus left the field) do move and jump.
    input.remove();
    select.remove();
    textarea.remove();
    document.body.focus();
    const atWorld = fire('keydown', 'KeyW', 1100);
    expect(atWorld.defaultPrevented).toBe(true);
    expect(dirs()).toEqual(['North']);
    fire('keyup', 'KeyW', 1110);
    fire('keydown', 'Space', 1120);
    expect(dirs()).toEqual(['North', 'Jump']);
  });

  it('a keydown whose keyup is lost does not leave the key held: down, down again, up ends the walk', async () => {
    // WRONG IMPL KILLED: a source that counts the second non-repeat down as a second holder
    // (the one up that follows would leave the direction held forever).
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    ackAllNorth(1005);
    fire('keydown', 'KeyW', 1010, { init: { repeat: false } }); // the first keyup was lost
    expect(dirs(), 'the re-press is a fresh press and steps at once').toEqual(['North', 'North']);
    ackAllNorth(1015);
    const sentBeforeUp = H.sends.length;
    expect(sentBeforeUp, 'the walk started').toBeGreaterThan(0);
    fire('keyup', 'KeyW', 1020);
    frame(1300);
    frame(1500);
    expect(H.sends.length, 'one keyup must end the hold').toBe(sentBeforeUp);
  });

  it('a key released while an overlay owns the screen is not left held', async () => {
    // WRONG IMPL KILLED: dropping the keyup because an overlay (or a focused field inside
    // it) is up, so the direction's count stays 1 and a LATER release of another key of that
    // direction no longer ends the walk.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    expect(dirs()).toEqual(['North']);
    ackAllNorth(1005);

    fire('keydown', 'KeyN', 1010);
    expect(renameShown(), 'precondition: the rename overlay opened').toBe(true);
    await vi.waitFor(
      () => {
        if (document.activeElement?.tagName !== 'INPUT') throw new Error('focus not in field yet');
      },
      { timeout: 2_000, interval: 5 },
    );
    const field = document.activeElement as HTMLElement;
    fire('keyup', 'KeyW', 1020, { target: field });
    fire('keydown', 'Escape', 1030);
    expect(renameShown(), 'precondition: the rename overlay closed').toBe(false);

    // Nothing is held now: a fresh ArrowUp tap steps once and does not keep walking.
    fire('keydown', 'ArrowUp', 1100);
    expect(dirs(), 'a fresh press steps').toEqual(['North', 'North']);
    fire('keyup', 'ArrowUp', 1120);
    ackAllNorth(1130);
    frame(1400);
    frame(1600);
    expect(dirs(), 'the tap must not continue: North has no holder left').toHaveLength(2);
  });

  it('a blur resets the router as well: press, blur, press, release ends the walk', async () => {
    // WRONG IMPL KILLED: a release-all that clears the shell's held set and the source but
    // not the router's counts (the pre-blur press stays counted, so the one release after the
    // post-blur press leaves the direction held forever).
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    ackAllNorth(1005);
    window.dispatchEvent(new Event('blur'));
    fire('keydown', 'KeyW', 1100);
    ackAllNorth(1105);
    fire('keyup', 'KeyW', 1110);
    const sent = H.sends.length;
    expect(sent, 'the post-blur press stepped').toBeGreaterThan(1);
    frame(1400);
    ackAllNorth(1410);
    frame(1600);
    expect(H.sends.length, 'the release after the blur must end the walk').toBe(sent);
  });

  it('a keyup carrying Meta or Ctrl still releases the key it presses up', async () => {
    // WRONG IMPL KILLED: a keyup handler that drops chorded events (macOS reports Cmd while
    // a key is released; the direction would stay held and the character walk on).
    await bootReady();
    server(1000, { x: 2, y: 7, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    ackAllNorth(1005, 7);
    fire('keyup', 'KeyW', 1010, { init: { metaKey: true } });
    const afterMeta = H.sends.length;
    frame(1400);
    ackAllNorth(1410, 7);
    frame(1600);
    expect(H.sends.length, 'a Meta keyup must release').toBe(afterMeta);

    fire('keydown', 'KeyW', 1700);
    expect(H.sends.length, 'a fresh press after the release steps').toBe(afterMeta + 1);
    ackAllNorth(1705, 7);
    fire('keyup', 'KeyW', 1710, { init: { ctrlKey: true } });
    const afterCtrl = H.sends.length;
    frame(2000);
    ackAllNorth(2010, 7);
    frame(2200);
    expect(H.sends.length, 'a Ctrl keyup must release').toBe(afterCtrl);
  });

  it('releasing one direction does not release another: hold W and D, release D, W keeps walking', async () => {
    // WRONG IMPL KILLED: a direction release that clears the whole held set.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    fire('keydown', 'KeyD', 1005);
    fire('keyup', 'KeyD', 1010);
    expect(dirs(), 'both presses stepped').toEqual(['North', 'East']);
    server(1020, { x: 3, y: 5, ack: 2 }); // North then East, as predicted
    frame(1200); // W has been held 200 ms: committed
    expect(
      dirs().filter((d) => d === 'North').length,
      'W is still held: North continues',
    ).toBeGreaterThan(1);
    expect(
      dirs().filter((d) => d === 'East'),
      'D was released: no East continuation',
    ).toHaveLength(1);
  });

  it('key repeat honours ownership and the consumed set: not prevented on a field or for Enter or a chord, prevented for a D-pad key at the world', async () => {
    // WRONG IMPL KILLED: a repeat path that prevents every bound key (Enter on a focused
    // control, arrows inside a select), or that ignores the chord filter.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });

    // Control: a repeated D-pad key at the world is consumed.
    const atWorld = fire('keydown', 'ArrowDown', 1000, { init: { repeat: true } });
    expect(atWorld.defaultPrevented, 'control: repeat ArrowDown at the world').toBe(true);

    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    const onSelect = fire('keydown', 'ArrowDown', 1010, { target: select, init: { repeat: true } });
    expect(onSelect.defaultPrevented, 'repeat ArrowDown inside a <select>').toBe(false);
    select.remove();
    document.body.focus();

    const enter = fire('keydown', 'Enter', 1020, { init: { repeat: true } });
    expect(enter.defaultPrevented, 'repeat Enter is not a consumed edge').toBe(false);
    const chord = fire('keydown', 'ArrowDown', 1030, { init: { repeat: true, ctrlKey: true } });
    expect(chord.defaultPrevented, 'a chord is never prevented, repeat or not').toBe(false);
    expect(H.sends, 'none of these moves anything').toHaveLength(0);
  });

  it('a chord while the main menu is open is left alone: it neither navigates nor is prevented', async () => {
    // WRONG IMPL KILLED: the chord check sitting below the menu intercept (Ctrl+ArrowDown
    // would move the menu cursor and be cancelled).
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyM', 1000);
    expect(overlayShown('menu-overlay'), 'precondition: the menu opened').toBe(true);
    const rows = document.getElementById('menu-rows');
    if (rows === null) throw new Error('#menu-rows missing');
    const cursor = (): string | null => rows.getAttribute('aria-activedescendant');
    const start = cursor();
    expect(start, 'precondition: the menu has a selected row').not.toBeNull();

    // Control: a bare ArrowDown navigates and is consumed.
    const bare = fire('keydown', 'ArrowDown', 1010);
    expect(bare.defaultPrevented, 'control: bare ArrowDown is consumed by the menu').toBe(true);
    const moved = cursor();
    expect(moved, 'control: bare ArrowDown moves the cursor').not.toBe(start);
    fire('keyup', 'ArrowDown', 1015);

    const chord = fire('keydown', 'ArrowDown', 1020, { init: { ctrlKey: true } });
    expect(chord.defaultPrevented, 'Ctrl+ArrowDown must reach the browser').toBe(false);
    expect(cursor(), 'Ctrl+ArrowDown must not move the cursor').toBe(moved);
    fire('keyup', 'ArrowDown', 1025, { init: { ctrlKey: true } });
  });

  it('after an overlay open clears the held set, a second key of the still-held direction steps again', async () => {
    // WRONG IMPL KILLED: a router that emits dirDown only for the first holder (count 0 to 1).
    // Opening an overlay clears the shell's held set but not the physical key, so the next
    // press of ANY key of that direction must start the walk again.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    fire('keydown', 'KeyW', 1000);
    ackAllNorth(1005);
    fire('keydown', 'KeyN', 1010);
    expect(renameShown(), 'precondition: the rename overlay opened').toBe(true);
    fire('keydown', 'Escape', 1020);
    expect(renameShown(), 'precondition: the rename overlay closed').toBe(false);
    ackAllNorth(1050);
    const before = H.sends.length;
    fire('keydown', 'ArrowUp', 1100);
    expect(H.sends.length, 'ArrowUp steps although W is still physically down').toBe(before + 1);
    expect(step(H.sends[before])).toBe('North');
  });
});

// ==========================================================================================
// ctl-2: the context stack behind the legacy show/hide, the one movement gate, push clears held
// ==========================================================================================
//
// Same harness as above, one fresh main.ts per case. What is observed is only the outputs a
// player or a server can see: the intents sent to the stubbed enqueueMove reducer, which
// overlays are on screen, the on-world interact prompt, and the read-only `__game().stack`
// hook. `__game()` is never used to drive state, and the held-key cases do not read it between
// an open and the next frame (it must stay a pure observer).
//
// The held-key fixture: the character stands at (2, 6) and every server batch echoes (2, 6) with
// every send acked, so the predictor holds (2, 6) too. A batch therefore never diverges (no
// reconcile re-issue), the server owes nothing (`outstandingSteps` is 0), and the only steps
// sent are the ones the input path issues. A case that WANTS a server pullback delivers a tile
// the predictor does not hold, (2, 7). One NPC stands one tile east of the spawn, so the world
// shows an interact prompt from every tile used here, which makes "the prompt stays hidden"
// a real observation rather than an empty one. (ctl-10a: what the world offers is now whatever
// the stubbed wasm interact rule answers, `H.interact`; a case that reads the prompt installs a
// rule that names the NPC.)

const WILD_IDENTITY = '0'.repeat(64);
const BATTLE_ID = 101n;
const NPC_ENTITY = 11n;

const BATTLE_MONSTER: StoreBattleMonster = {
  speciesId: 1,
  affinity: 'Neutral',
  level: 5,
  currentHp: 20,
  maxHp: 20,
  statHp: 20,
  statAttack: 5,
  statDefense: 5,
  statSpeed: 5,
  statSpAttack: 5,
  statSpDefense: 5,
  knownSkillIds: [1],
  status: null,
};

/** A wild battle row for the booted player. Wild: no owned opponent party. */
function battleRow(battleId: bigint, outcome: string): StoreBattle {
  return {
    battleId,
    playerIdentity: H.identity,
    opponentIdentity: WILD_IDENTITY,
    outcome,
    turnNumber: 1,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [1n],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
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
  server(t, { x: 2, y: 6, ack: 0 });
}

/** A batch that acks every send so far with the character where the predictor already holds it
 *  (2, 6): no divergence, nothing owed, so the reconcile re-issue never fires. */
function settle(t: number): void {
  server(t, { x: 2, y: 6, ack: H.sends.length });
}

/** Start a FRESH committed hold of W at the world and return the time it is settled at. The keyup
 *  first clears any hold an earlier phase left behind; the fresh press steps at once; the hold
 *  then commits and takes exactly one continuation step; both are acked. Every precondition is
 *  asserted, so a later "no further step" cannot be vacuous. */
function committedHold(t: number): number {
  fire('keyup', 'KeyW', t);
  const before = H.sends.length;
  fire('keydown', 'KeyW', t + 1);
  expect(H.sends.length, 'precondition: a fresh W press at the world steps at once').toBe(
    before + 1,
  );
  settle(t + 20);
  frame(t + 1 + HOLD_COMMIT_MS + 10);
  expect(H.sends.length, 'precondition: a committed hold continues').toBe(before + 2);
  const settledAt = t + 1 + HOLD_COMMIT_MS + 20;
  settle(settledAt);
  return settledAt;
}

/** Display of the element and every ancestor: shown unless some inline `display` is `none`. */
const isShown = (el: Element): boolean => {
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
};
const shownById = (id: string): boolean => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return isShown(el);
};
const shownByTestId = (testId: string): boolean => {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`[data-testid="${testId}"] is not in the document`);
  return isShown(el);
};
const boxShown = (): boolean => shownByTestId('box-title');
const battleShown = (): boolean => shownByTestId('battle-title');
const promptShown = (): boolean => shownById('interact-prompt');
/** How many times the interact (talk) reducer has been called. */
const talkCalls = (): number => H.calls.filter((name) => name === 'talk').length;

interface FrameJson {
  readonly kind: string;
  readonly [key: string]: unknown;
}
/** The read-only DEV hook. Never used to drive state. */
const stack = (): FrameJson[] =>
  (window as unknown as { __game: () => { stack: FrameJson[] } }).__game().stack;

describe('main.ts context stack (runtime, ctl-2)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL2-2-BOOT-STACK: __game().stack lists the live frames base-first as overlays open and close; a click-opened overlay appears with the next frame, not on a read', async () => {
    // WRONG IMPL KILLED: no stack on the hook, a stack without the base (length > 1 must mean
    // "something is above the base"), a mirror that never pops, an open path that is never
    // mirrored, and a hook that performs the sync itself (it must be a pure observer: the push
    // and its held-key clear belong to the input path and the frame loop, never to a read).
    await bootReady();
    seedWorld(1000);
    expect(stack(), 'a fresh world is the bare base').toEqual([{ kind: 'world' }]);

    fire('keydown', 'KeyB', 1010);
    expect(boxShown(), 'precondition: the box opened').toBe(true);
    expect(stack(), 'the box is a screen frame above the base').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'boxView' },
    ]);
    fire('keydown', 'KeyB', 1020);
    expect(boxShown(), 'precondition: the box closed').toBe(false);
    expect(stack(), 'closing pops the frame').toEqual([{ kind: 'world' }]);

    // A click opens the menu with no keydown. Nothing between the click and the next frame
    // syncs the stack, and reading the hook (twice) must not either.
    const launcher = document.querySelector('[data-menu-launcher]');
    if (launcher === null) throw new Error('[data-menu-launcher] is not in the shell');
    clock.t = 1100;
    launcher.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(overlayShown('menu-overlay'), 'precondition: the click opened the menu').toBe(true);
    expect(stack(), 'no frame has run yet: the stack has not seen the menu').toEqual([
      { kind: 'world' },
    ]);
    expect(stack(), 'a second read still does not sync').toEqual([{ kind: 'world' }]);
    frame(1110);
    expect(stack(), 'the frame loop mirrors the click-opened menu').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
    ]);

    fire('keydown', 'Escape', 1200);
    expect(overlayShown('menu-overlay'), 'precondition: Escape closed the menu').toBe(false);
    expect(stack(), 'and the close is mirrored').toEqual([{ kind: 'world' }]);
  });

  it('CTL2-3-BOOT-B17: an Ongoing battle row makes movement dead from the very batch it arrives in, and Escape opens the main menu over the battle and never hides it; with the menu closed again the bare battle base still walks nowhere and A does not interact', async () => {
    // WRONG IMPL KILLED (B17): a gate that is only "no overlay visible" (Escape hides battleView
    // and the character predicts a step the server rejects, then rubber-bands back); a base
    // derived one batch late, or by a listener that runs after the reconcile re-issue (the
    // pullback batch that carries the battle row still sends a step); a prompt computed from
    // the overlay probe instead of the gate (it advertises a target A would refuse); and a
    // base that does not return to the world when the battle row goes.
    // ctl-6c: Escape never HIDES the battle: Start opens the main menu above an Ongoing battle
    // (CTL6C.1) and the second Escape below closes it, after which the bare battle base keeps every
    // movement and interact assertion that follows. A Start that hid the battle, or left the menu
    // open (the A / W gates would then read a menu frame instead of the bare base), fails here.
    // ctl-10a: T retired — the interact presses are A (Enter) now (CTL10A.3: T does nothing), and
    // the stubbed interact rule names the NPC from every tile this case uses (the pullback leaves
    // the character off the NPC's row), so the controls below still observe a live interaction.
    await bootReady();
    useRule(everyNpc);
    seedWorld(1000);
    frame(1005);
    expect(promptShown(), 'control: at the world the NPC in range shows the interact prompt').toBe(
      true,
    );
    fire('keydown', 'Enter', 1006);
    fire('keyup', 'Enter', 1007);
    expect(talkCalls(), 'control: A at the world talks to the NPC the rule names').toBe(1);

    fire('keydown', 'KeyW', 1010);
    expect(dirs()).toEqual(['North']);
    settle(1030);
    frame(1010 + HOLD_COMMIT_MS + 10);
    expect(dirs(), 'control: the committed hold continues').toEqual(['North', 'North']);
    const sent = H.sends.length;

    // ONE batch carries the battle row AND a server pullback to a tile the predictor does not
    // hold, with every send acked and nothing owed. At the world that is exactly what makes a
    // held, committed key re-issue a step from the corrected baseline.
    opts.store.upsertBattle(battleRow(BATTLE_ID, 'Ongoing'));
    server(1180, { x: 2, y: 7, ack: sent });
    expect(H.sends.length, 'no step is sent in the batch that brings the battle in').toBe(sent);
    frame(1190);
    frame(1400);
    frame(1600);
    expect(H.sends.length, 'and none in the frames after it').toBe(sent);
    expect(battleShown(), 'the battle overlay shows').toBe(true);
    expect(stack()[0], 'the base is the battle').toEqual({ kind: 'battle', battleId: '101' });

    // INTENTIONAL CHANGE (ctl-6c CTL6C.1): Escape is Start, and Start over an Ongoing battle now
    // opens the main menu above it (ctl-6b made it do nothing; B17 still holds: it never hides the
    // overlay). The battle stays shown, the base stays the battle and the menu is a frame above it;
    // a second Escape closes the menu again, so the gate below is checked on the bare battle base.
    fire('keydown', 'Escape', 1700);
    fire('keyup', 'Escape', 1702);
    expect(battleShown(), 'precondition: Escape leaves the Ongoing battle overlay up').toBe(true);
    expect(
      stack(),
      'Escape over the Ongoing battle opens the menu: the base is still the battle, the menu above',
    ).toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);
    expect(shownById('menu-overlay'), 'the menu is on screen above the battle').toBe(true);
    fire('keydown', 'Escape', 1704);
    fire('keyup', 'Escape', 1706);
    expect(shownById('menu-overlay'), 'a second Escape closes the menu').toBe(false);
    expect(battleShown(), 'the battle is still shown after the menu closes').toBe(true);
    expect(stack(), 'the bare battle base again').toEqual([{ kind: 'battle', battleId: '101' }]);
    frame(1710);
    expect(stack(), 'the base is still the battle, with nothing above it').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    expect(promptShown(), 'the interact prompt stays hidden over a battle base').toBe(false);
    // A at the bare battle base belongs to the battle's own adapter, never to the world interact:
    // it must refuse what the prompt hides, and refusing must not disturb the stack.
    // ctl-10a: T retired — this press was KeyT.
    fire('keydown', 'Enter', 1715);
    fire('keyup', 'Enter', 1716);
    expect(talkCalls(), 'A over a battle base does not dispatch the interact').toBe(1);
    expect(stack(), 'and the stack is unchanged').toEqual([{ kind: 'battle', battleId: '101' }]);
    fire('keyup', 'KeyW', 1720);
    fire('keydown', 'KeyW', 1730);
    expect(H.sends.length, 'a D-pad press over a battle base sends nothing').toBe(sent);
    frame(1740);
    frame(1900);
    frame(2100);
    expect(H.sends.length, 'and the hold it left behind walks nowhere').toBe(sent);
    expect(promptShown(), 'the prompt is still hidden').toBe(false);

    // The battle row goes: the base returns to the world.
    opts.store.removeBattle(BATTLE_ID);
    server(2200, { x: 2, y: 7, ack: sent });
    frame(2210);
    frame(2400);
    expect(stack(), 'the base is the world again').toEqual([{ kind: 'world' }]);
    expect(H.sends.length, 'nothing walks on its own when the battle ends').toBe(sent);
    expect(promptShown(), 'control: the prompt is back at the world').toBe(true);
    // ctl-10a: T retired — this press was KeyT.
    fire('keydown', 'Enter', 2450);
    fire('keyup', 'Enter', 2451);
    expect(talkCalls(), 'control: A talks again once the battle is over').toBe(2);

    // Anti-vacuity: the world walks again for a fresh press.
    fire('keyup', 'KeyW', 2500);
    fire('keydown', 'KeyW', 2510);
    expect(dirs(), 'a fresh W press at the world steps once').toEqual(['North', 'North', 'North']);
  });

  it('CTL2-3-BOOT-BATTLE-HELD: a hold that was live when a battle began does not resume when the battle ends', async () => {
    // WRONG IMPL KILLED: a battle base that gates movement but never clears the held keys (the
    // base edge world to battle is the ONLY push-like event here: the battle overlay is the
    // base's own presentation, not a frame above it). The key stays physically down and is never
    // released, so a stale hold would walk the instant the battle row goes. The batch that brings
    // the battle in deliberately does not diverge, so this isolates the clear from the reconcile
    // re-issue that CTL2-3-BOOT-B17 covers.
    await bootReady();
    seedWorld(1000);
    const t0 = committedHold(1010);
    const sent = H.sends.length;

    opts.store.upsertBattle(battleRow(BATTLE_ID, 'Ongoing'));
    settle(t0 + 10);
    frame(t0 + 100);
    frame(t0 + 300);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(H.sends.length, 'no step walks into a battle').toBe(sent);

    opts.store.removeBattle(BATTLE_ID);
    settle(t0 + 500);
    expect(battleShown(), 'precondition: the battle overlay is gone').toBe(false);
    frame(t0 + 510);
    frame(t0 + 700);
    frame(t0 + 900);
    expect(
      H.sends.length,
      'W was never released, yet the hold from before the battle must not resume',
    ).toBe(sent);

    // Anti-vacuity: the world walks again for a fresh press.
    fire('keyup', 'KeyW', t0 + 1000);
    fire('keydown', 'KeyW', t0 + 1010);
    expect(H.sends.length, 'a fresh press steps once').toBe(sent + 1);
  });

  it('CTL2-3-BOOT-NO-HELD: a direction pressed while an overlay is open is never held, so nothing walks when the overlay closes', async () => {
    // WRONG IMPL KILLED: a router fed a world-active flag that ignores the open frame (the press
    // would register in the held set, and the walk would start the moment the box closes), and a
    // gate that lets the continuation run under an open overlay.
    await bootReady();
    seedWorld(1000);
    fire('keydown', 'KeyB', 1010);
    expect(boxShown(), 'precondition: the box is open').toBe(true);
    fire('keydown', 'KeyW', 1020);
    expect(H.sends.length, 'a D-pad press under an overlay sends nothing').toBe(0);
    frame(1100);
    frame(1300);
    frame(1500);
    expect(H.sends.length, 'and the hold walks nowhere under it').toBe(0);

    fire('keydown', 'KeyB', 1600);
    expect(boxShown(), 'precondition: the box closed').toBe(false);
    frame(1600 + HOLD_COMMIT_MS + 10);
    frame(1600 + HOLD_COMMIT_MS + 200);
    frame(1600 + HOLD_COMMIT_MS + 400);
    expect(H.sends.length, 'W is still physically down, but it was never held: nothing walks').toBe(
      0,
    );

    // Anti-vacuity: the world walks for a fresh press.
    fire('keyup', 'KeyW', 2500);
    fire('keydown', 'KeyW', 2510);
    expect(dirs(), 'a fresh W press at the world steps once').toEqual(['North']);
  });

  it('CTL2-3-BOOT-SESSION: a server pullback sends no re-issued step while a session terminal owns the screen', async () => {
    // WRONG IMPL KILLED: a reconcile re-issue that does not consult the session gate (the
    // session terminal is registry-external, so an overlay probe cannot see it: today only the
    // keydown handler and the frame loop check it), one movement gate that forgets the session
    // gate, and one that holds the session gate permanently (the control below must still send).
    await bootReady();
    seedWorld(1000);
    fire('keydown', 'KeyW', 1010);
    settle(1030);
    frame(1010 + HOLD_COMMIT_MS + 10);
    expect(dirs(), 'precondition: the committed hold is live').toEqual(['North', 'North']);

    // Control: with the session live, a pullback batch re-issues the held step.
    server(1200, { x: 2, y: 7, ack: 2 });
    expect(dirs(), 'control: a pullback re-issues the held step').toEqual([
      'North',
      'North',
      'North',
    ]);

    H.sessionState = 'expired';
    server(1300, { x: 2, y: 5, ack: 3 });
    expect(H.sends.length, 'no step while the session is expired').toBe(3);
    frame(1400);
    frame(1600);
    expect(H.sends.length, 'and none from the frame loop').toBe(3);
  });

  it('CTL2-4-BOOT-CLEAR: opening a screen clears the held direction, so nothing walks while it is open or after it closes', async () => {
    // WRONG IMPL KILLED (B14): a push that does not clear the held keys. Of the hotkey open
    // paths only N, O, ?, M and C cleared them; B, I, E, Q, U, P and L left the hold latched,
    // so it resumed on close. Each opener below is one the defect covers. The hold is committed
    // and acked before the open, so a surviving hold WOULD walk the moment the gate reopens.
    const openers: ReadonlyArray<{ readonly code: string; readonly shown: () => boolean }> = [
      { code: 'KeyB', shown: () => shownByTestId('box-title') },
      { code: 'KeyI', shown: () => shownByTestId('raising-title') },
      { code: 'KeyE', shown: () => shownByTestId('evolution-title') },
      { code: 'KeyQ', shown: () => shownById('quest-log-list') },
      { code: 'KeyL', shown: () => shownById('leaderboard-title') },
      { code: 'KeyU', shown: () => shownById('trade-status') },
      { code: 'KeyP', shown: () => shownById('pvp-challenge-status') },
    ];
    await bootReady();
    seedWorld(1000);
    let t = 1010;
    for (const opener of openers) {
      const settledAt = committedHold(t);
      const sent = H.sends.length;

      fire('keydown', opener.code, settledAt + 10);
      expect(opener.shown(), `${opener.code}: precondition: the screen opened`).toBe(true);
      frame(settledAt + 200);
      frame(settledAt + 400);
      frame(settledAt + 600);
      expect(H.sends.length, `${opener.code}: nothing walks under the open screen`).toBe(sent);

      fire('keydown', opener.code, settledAt + 700);
      expect(opener.shown(), `${opener.code}: precondition: the screen closed`).toBe(false);
      frame(settledAt + 800);
      frame(settledAt + 1000);
      expect(
        H.sends.length,
        `${opener.code}: the hold from before the open must not resume when the screen closes`,
      ).toBe(sent);
      t = settledAt + 1100;
    }
  });

  it('CTL2-4-BOOT-SERVER-OPEN: an overlay the server opens clears the held direction too, with no keydown involved', async () => {
    // WRONG IMPL KILLED: a push edge that only the keydown path emits (the box case above is
    // key-driven): a conversation row opens the dialogue with no key at all, so the held
    // direction stays latched and walks when the conversation ends. The open batch does not
    // diverge, so no reconcile re-issue can send in it, and the expectation is exactly zero
    // steps; a batch that DID diverge could send at most one before the overlay is mirrored,
    // because the reconcile listener runs ahead of the dialogue listener within one batch.
    await bootReady();
    seedWorld(1000);
    const settledAt = committedHold(1010);
    const sent = H.sends.length;

    opts.store.upsertConversation({
      ownerIdentity: H.identity,
      npcEntityId: NPC_ENTITY,
      currentNodeId: 'start',
    });
    settle(settledAt + 10);
    expect(shownById('dialogue-overlay'), 'precondition: the server opened the dialogue').toBe(
      true,
    );
    // No frame has run since the batch: the batch's own tail must already have mirrored the
    // dialogue (the last batch listener syncs), so a hold cannot slip past in the gap.
    expect(
      stack(),
      'the batch itself mirrors the server-opened dialogue, before any frame',
    ).toEqual([{ kind: 'world' }, { kind: 'screen', id: 'dialogueView' }]);
    frame(settledAt + 200);
    frame(settledAt + 400);
    expect(H.sends.length, 'nothing walks under the server-opened dialogue').toBe(sent);

    opts.store.removeConversation(H.identity);
    settle(settledAt + 500);
    expect(shownById('dialogue-overlay'), 'precondition: the server closed the dialogue').toBe(
      false,
    );
    frame(settledAt + 600);
    frame(settledAt + 800);
    expect(H.sends.length, 'the hold from before the dialogue must not resume when it ends').toBe(
      sent,
    );

    // Anti-vacuity: the world walks again for a fresh press.
    fire('keyup', 'KeyW', settledAt + 900);
    fire('keydown', 'KeyW', settledAt + 910);
    expect(H.sends.length, 'a fresh press steps once').toBe(sent + 1);
  });

  it('CTL2-3-BOOT-TERMINAL-ROW: a finished battle row left in the store does not hold the battle base', async () => {
    // WRONG IMPL KILLED: a base derived from the latest battle row of ANY outcome (the store keeps
    // finished rows, so the base would stay "battle" for the rest of the session and movement
    // would be dead for good), and one that keeps the battle base until the outcome frame is
    // dismissed. The base follows the row's outcome: Ongoing is a battle, anything else is the
    // world, and a finished outcome is only a screen frame over the world.
    await bootReady();
    seedWorld(1000);
    frame(1005);

    opts.store.upsertBattle(battleRow(BATTLE_ID, 'Ongoing'));
    settle(1010);
    frame(1020);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(stack(), 'an Ongoing row is a battle base').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);

    // The SAME battle finishes: the row stays in the store with a terminal outcome.
    opts.store.upsertBattle(battleRow(BATTLE_ID, 'SideAWins'));
    settle(1030);
    frame(1040);
    expect(battleShown(), 'precondition: the outcome frame is on screen').toBe(true);
    expect(stack()[0], 'a finished row is not a battle base').toEqual({ kind: 'world' });

    // Escape dismisses the outcome frame; the finished row is still in the store.
    fire('keydown', 'Escape', 1100);
    expect(battleShown(), 'precondition: Escape dismissed the outcome frame').toBe(false);
    frame(1110);
    expect(stack(), 'nothing is left on the stack').toEqual([{ kind: 'world' }]);

    // The world walks: one press, one step.
    expect(H.sends.length, 'precondition: nothing has been sent yet').toBe(0);
    fire('keydown', 'KeyW', 1200);
    expect(dirs(), 'a fresh W press at the world steps once').toEqual(['North']);
  });

  it('CTL2-4-BOOT-CLICK-OPEN: an overlay opened by a connection callback (no key, no batch) still clears the held direction when it is closed before any frame', async () => {
    // WRONG IMPL KILLED: a stack synced only at the TAIL of a keydown (and in frames and
    // batches). The sign-in-failed callback shows the claim overlay without touching held; the
    // overlay is then closed by its toggle key before any frame runs, so a tail-only sync sees
    // nothing visible, never sees the push, and the hold survives to walk on after the close. The
    // keydown must sync at its TOP as well, before the handler closes the overlay.
    // Paths checked for an open that is neither a keydown nor a store batch and does not clear
    // held itself: the sign-in-failed callback (this one; it shows the claim overlay directly),
    // and the menu launcher click, which already clears held. A menu leaf click opens its target,
    // but the menu's open cleared held and the menu swallows the D-pad, so nothing is held then.
    await bootReady();
    seedWorld(1000);
    const settledAt = committedHold(1010);
    const sent = H.sends.length;

    opts.onSignInFailed?.('denied');
    expect(shownById('claim-overlay'), 'precondition: the callback opened the claim overlay').toBe(
      true,
    );
    // No frame, no batch, no read of the hook: straight to the closing keydown.
    fire('keydown', 'KeyC', settledAt + 10);
    expect(shownById('claim-overlay'), 'precondition: KeyC closed it').toBe(false);

    frame(settledAt + 200);
    frame(settledAt + 400);
    frame(settledAt + 600);
    expect(
      H.sends.length,
      'the hold from before the overlay must not resume, though no frame saw the overlay open',
    ).toBe(sent);

    // Anti-vacuity: the world walks again for a fresh press.
    fire('keyup', 'KeyW', settledAt + 700);
    fire('keydown', 'KeyW', settledAt + 710);
    expect(H.sends.length, 'a fresh press steps once').toBe(sent + 1);
  });

  it('CTL2-5-BOOT-HOLD-THROUGH: a direction held while the box opens and closes does not walk until it is pressed again', async () => {
    // WRONG IMPL KILLED: a hold that survives an overlay (the old "a held key resumes after an
    // overlay closes" contract). The ack lands WHILE the box is open, so the server owes
    // nothing when it closes and a surviving hold would walk on the first frame after.
    await bootReady();
    seedWorld(1000);
    fire('keydown', 'KeyW', 1000);
    expect(dirs()).toEqual(['North']);
    settle(1020);
    frame(1000 + HOLD_COMMIT_MS + 10);
    expect(dirs(), 'precondition: the committed hold continues').toEqual(['North', 'North']);

    fire('keydown', 'KeyB', 1200);
    expect(boxShown(), 'precondition: the box opened').toBe(true);
    settle(1220);
    frame(1300);
    fire('keydown', 'KeyB', 1400);
    expect(boxShown(), 'precondition: the box closed').toBe(false);
    const sent = H.sends.length;
    frame(1400 + HOLD_COMMIT_MS + 10);
    frame(1400 + HOLD_COMMIT_MS + 200);
    frame(1400 + HOLD_COMMIT_MS + 400);
    expect(
      H.sends.length,
      'the direction was held through the box: it must not walk on close',
    ).toBe(sent);

    // Anti-vacuity: pressed again, it steps at once and then keeps walking.
    fire('keyup', 'KeyW', 2300);
    fire('keydown', 'KeyW', 2310);
    expect(H.sends.length, 'a fresh press steps immediately').toBe(sent + 1);
    expect(step(H.sends[sent])).toBe('North');
    settle(2330);
    frame(2310 + HOLD_COMMIT_MS + 10);
    expect(H.sends.length, 'and the fresh hold walks on once it commits').toBe(sent + 2);
  });
});

// ==========================================================================================
// ctl-3: server truth reconciled into the stack; a dropped overlay closes through its OWN hide()
// ==========================================================================================
//
// Same harness, one fresh main.ts per case. What is observed: which overlays are on screen, the
// read-only `__game().stack` hook, and (for the hide path) the one effect only an overlay's own
// `hide()` produces: the a11y close (`closeOverlayA11y`) strips `role`, `aria-modal` and `aria-label`
// from the root the overlay was opened with, while a bare `display:none` leaves them standing. The
// "not shown, so not hidden" half is a sentinel text in a feedback node that `hide()` clears.
//
// Every case is synchronous after boot (no awaits), so no overlay's deferred initial focus ever
// fires and `worldHasFocus()` stays true for the next open.

/** The server opens a conversation with the NPC, in one batch at clock `t`. */
function startConversation(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: NPC_ENTITY,
    currentNodeId: 'start',
  });
  settle(t);
}
/** The server ends the conversation, in one batch at clock `t`. */
function endConversation(t: number): void {
  opts.store.removeConversation(H.identity);
  settle(t);
}
/** An Ongoing wild battle row arrives, in one batch at clock `t`. */
function startBattle(battleId: bigint, t: number): void {
  opts.store.upsertBattle(battleRow(battleId, 'Ongoing'));
  settle(t);
}
/** The battle row goes, in one batch at clock `t`. */
function endBattle(battleId: bigint, t: number): void {
  opts.store.removeBattle(battleId);
  settle(t);
}
const rootOf = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};
const dismissCalls = (): number => H.calls.filter((name) => name === 'dismissDialogue').length;

/** Open the shop the one way the shell does: a conversation, a click on the shop button inside it,
 *  and the batch that ends the conversation (which performs the deferred open). */
function openShopViaDialogue(t: number): void {
  startConversation(t);
  expect(shownById('dialogue-overlay'), 'precondition: the server opened the dialogue').toBe(true);
  const before = dismissCalls();
  const button = document.createElement('button');
  button.dataset.shopId = '1';
  document.body.appendChild(button);
  clock.t = t + 5;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
  expect(dismissCalls(), 'precondition: the shop click sent a dismiss').toBe(before + 1);
  endConversation(t + 10);
  expect(shownById('shop-overlay'), 'precondition: the deferred open showed the shop').toBe(true);
}

describe('main.ts reconcile server truth (runtime, ctl-3)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL3-1-BOOT-BATCH: after a battle batch with an overlay open, the stack is exactly the battle base with nothing above it, read straight after the batch', async () => {
    // WRONG IMPL KILLED: a reconcile that never runs on the batch (the quest log, which a battle
    // auto-show never hid, stays on the stack above the battle base), one that runs but leaves the
    // frame it popped on the stack, one that only runs from the frame loop (the stack read here
    // happens before any frame), and one that keeps the battle base but forgets to return to the
    // world when the battle row goes.
    await bootReady();
    seedWorld(1000);
    fire('keydown', 'KeyQ', 1010);
    expect(shownById('quest-log-overlay'), 'precondition: the quest log opened').toBe(true);
    expect(stack(), 'precondition: the quest log is a frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'questLogView' },
    ]);

    startBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(stack(), 'exactly the battle base, no frame above it, before any frame ran').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);

    // A further batch that carries nothing new leaves the stack alone.
    settle(1200);
    expect(stack(), 'a no-op batch keeps the bare battle base').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);

    endBattle(BATTLE_ID, 1300);
    expect(stack(), 'the battle row goes: the bare world again').toEqual([{ kind: 'world' }]);
  });

  it('CTL3-2-BOOT-SHOP-UNDER-BATTLE: a shop opened through the dialogue is closed when a battle row arrives, and does not come back when the battle ends', async () => {
    // WRONG IMPL KILLED (RED today): the battle auto-show force-hid only a fixed list of eight
    // overlays and left the shop painted under the battle (a second aria-modal root, a second
    // focus trap, a buy button reachable behind a fight). Also: a reconcile that closes the shop
    // but re-opens it when the battle ends, and one that hides the shop but leaves its frame on
    // the stack.
    await bootReady();
    seedWorld(1000);
    openShopViaDialogue(1010);
    expect(stack(), 'precondition: the shop is a frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'shopView' },
    ]);

    startBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(shownById('shop-overlay'), 'the shop is hidden once the battle row arrives').toBe(false);
    expect(stack(), 'and only the battle base is left').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);

    endBattle(BATTLE_ID, 1200);
    expect(battleShown(), 'precondition: the battle is gone').toBe(false);
    expect(shownById('shop-overlay'), 'the shop does not come back by itself').toBe(false);
    expect(stack()).toEqual([{ kind: 'world' }]);
  });

  it('CTL3-3-BOOT-HIDE-PATH: every dropped overlay closes through its OWN hide() (its a11y close runs), and an overlay that was not shown is not hidden', async () => {
    // WRONG IMPL KILLED: a close that only sets display:none (the root keeps role="dialog",
    // aria-modal="true" and its label while hidden, and its focus trap and live-region custody
    // leak: overlayA11y.ts's A13 note), a close that calls hide() on every overlay in the table
    // whether or not it is shown (a hidden overlay's hide() clears its feedback and resets its
    // in-flight lock for nothing), and a close that handles only the overlays the old force-hide
    // list covered. The overlays here are exactly ones that old list did NOT cover.
    await bootReady();
    seedWorld(1000);

    // The inverse first: only the quest log is shown; the shop, trade and pvp overlays are hidden
    // with a sentinel in the feedback node their hide() clears. A battle must leave them alone.
    fire('keydown', 'KeyQ', 1010);
    expect(shownById('quest-log-overlay'), 'precondition: the quest log opened').toBe(true);
    const sentinels = ['shop-feedback', 'trade-feedback', 'pvp-challenge-feedback'];
    for (const id of sentinels) {
      expect(shownById(id), `precondition: the overlay holding #${id} is hidden`).toBe(false);
      rootOf(id).textContent = 'sentinel';
    }
    startBattle(BATTLE_ID, 1100);
    expect(shownById('quest-log-overlay'), 'the shown quest log is closed').toBe(false);
    for (const id of sentinels) {
      expect(
        rootOf(id).textContent,
        `#${id}: its overlay was not shown, so its hide() must not have run`,
      ).toBe('sentinel');
    }
    endBattle(BATTLE_ID, 1150);
    expect(battleShown(), 'precondition: the battle ended').toBe(false);

    const overlays: ReadonlyArray<{
      readonly name: string;
      readonly rootId: string;
      readonly open: (t: number) => void;
    }> = [
      {
        name: 'questLogView',
        rootId: 'quest-log-overlay',
        open: (t) => void fire('keydown', 'KeyQ', t),
      },
      { name: 'tradeView', rootId: 'trade-overlay', open: (t) => void fire('keydown', 'KeyU', t) },
      {
        name: 'pvpView',
        rootId: 'pvp-challenge-overlay',
        open: (t) => void fire('keydown', 'KeyP', t),
      },
      { name: 'claimView', rootId: 'claim-overlay', open: () => opts.onSignInFailed?.('denied') },
      { name: 'shopView', rootId: 'shop-overlay', open: (t) => openShopViaDialogue(t) },
    ];
    let t = 1200;
    let checked = 0;
    for (const [i, overlay] of overlays.entries()) {
      const root = rootOf(overlay.rootId);
      const battleId = BATTLE_ID + BigInt(i + 1);
      overlay.open(t);
      expect(isShown(root), `${overlay.name}: precondition: opened`).toBe(true);
      expect(
        root.getAttribute('aria-modal'),
        `${overlay.name}: precondition: opened through its own a11y path`,
      ).toBe('true');

      startBattle(battleId, t + 50);
      expect(battleShown(), `${overlay.name}: precondition: the battle is on screen`).toBe(true);
      expect(isShown(root), `${overlay.name}: hidden once the battle row arrives`).toBe(false);
      expect(
        root.getAttribute('aria-modal'),
        `${overlay.name}: closed through its OWN hide(): the a11y close strips aria-modal`,
      ).toBeNull();
      expect(root.hasAttribute('role'), `${overlay.name}: the a11y close strips role as well`).toBe(
        false,
      );
      expect(stack(), `${overlay.name}: only the battle base is left`).toEqual([
        { kind: 'battle', battleId: battleId.toString() },
      ]);

      endBattle(battleId, t + 100);
      expect(battleShown(), `${overlay.name}: precondition: the battle ended`).toBe(false);
      t += 200;
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all five overlays were driven').toBe(5);
  });

  it('CTL3-4-BOOT-CONV-POPS-PLAYER: a server conversation hides every open player overlay, and the stack ends [world, dialogueView]', async () => {
    // WRONG IMPL KILLED (RED today for all but the menu): only the menu was preempted by a
    // conversation, so a help, box, leaderboard or quest-log overlay stayed painted behind the
    // dialogue (two aria-modal roots, two traps, Escape closing the wrong one first). Also: a
    // reconcile that pops the player frame but leaves the overlay visible, and one that pops the
    // dialogue frame the mirror then has to push again.
    await bootReady();
    seedWorld(1000);
    const openers: ReadonlyArray<{
      readonly name: string;
      readonly open: (t: number) => void;
      readonly shown: () => boolean;
    }> = [
      {
        name: 'helpView',
        open: (t) => void fire('keydown', 'Slash', t, { init: { key: '?' } }),
        shown: () => shownById('help-overlay'),
      },
      { name: 'boxView', open: (t) => void fire('keydown', 'KeyB', t), shown: boxShown },
      {
        name: 'leaderboardView',
        open: (t) => void fire('keydown', 'KeyL', t),
        shown: () => shownById('leaderboard-overlay'),
      },
      {
        name: 'questLogView',
        open: (t) => void fire('keydown', 'KeyQ', t),
        shown: () => shownById('quest-log-overlay'),
      },
      {
        name: 'menuView (control: the one overlay a conversation already preempted)',
        open: (t) => void fire('keydown', 'KeyM', t),
        shown: () => shownById('menu-overlay'),
      },
    ];
    let t = 1100;
    let checked = 0;
    for (const opener of openers) {
      opener.open(t);
      expect(opener.shown(), `${opener.name}: precondition: opened`).toBe(true);

      startConversation(t + 50);
      expect(shownById('dialogue-overlay'), `${opener.name}: the dialogue is on screen`).toBe(true);
      expect(opener.shown(), `${opener.name}: hidden by the conversation`).toBe(false);
      expect(stack(), `${opener.name}: the stack ends [world, dialogueView]`).toEqual([
        { kind: 'world' },
        { kind: 'screen', id: 'dialogueView' },
      ]);

      endConversation(t + 100);
      expect(
        shownById('dialogue-overlay'),
        `${opener.name}: precondition: the dialogue ended`,
      ).toBe(false);
      expect(stack(), `${opener.name}: the bare world again`).toEqual([{ kind: 'world' }]);
      t += 200;
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all five overlays were driven').toBe(5);
  });
});

// ==========================================================================================
// ctl-3 round 2: the gaps a red-team measured (greet-then-shop gating, either-role battles,
// every dropped overlay, the same-batch outcome, close-before-show)
// ==========================================================================================

const CHALLENGER_IDENTITY = 'cd'.repeat(32);
/** A PvP battle row where the booted player is the OPPONENT (the accepter), not `playerIdentity`. */
function accepterBattleRow(battleId: bigint, outcome: string): StoreBattle {
  return {
    ...battleRow(battleId, outcome),
    playerIdentity: CHALLENGER_IDENTITY,
    opponentIdentity: H.identity,
    opponentMonsterIds: [2n],
  };
}
/** Click a greet-then-shop button, as the dialogue renders one; asserts the dismiss was sent. */
function clickShop(t: number, shopId = '1'): void {
  const before = dismissCalls();
  const button = document.createElement('button');
  button.dataset.shopId = shopId;
  document.body.appendChild(button);
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
  expect(dismissCalls(), 'precondition: the shop click sent a dismiss').toBe(before + 1);
}
/** Let queued microtasks and zero-delay timers run (an overlay's deferred initial focus). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('main.ts reconcile gaps (runtime, ctl-3 round 2)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL3-5-BOOT-OPEN-BLOCKED: a pending shop open is dropped, and consumed, when the batch that ends the conversation also brings a battle or a terminal outcome', async () => {
    // WRONG IMPL KILLED: a deferred open that does not consult the stack at all (the shop pops
    // over the battle it was dropped for: the reconcile has already run, and the tail sync only
    // mirrors it), one that blocks only on a battle BASE (an outcome over the world is a
    // battleView frame, not a base, so the shop would pop over the outcome), and a drop that
    // RETAINS the pending id (a later no-conversation batch would open a stale shop).
    // (b) is constructible: a first battle makes the session "synced", so a terminal row that
    // arrives afterwards is a mid-session outcome and is shown (decideBattleOverlay), over the
    // world base.
    await bootReady();
    seedWorld(1000);

    // (a) one batch: the conversation row goes AND an Ongoing battle row arrives.
    startConversation(1010);
    expect(shownById('dialogue-overlay'), 'precondition: the dialogue is open').toBe(true);
    clickShop(1020);
    opts.store.removeConversation(H.identity);
    opts.store.upsertBattle(battleRow(BATTLE_ID, 'Ongoing'));
    settle(1100);
    expect(battleShown(), 'a: precondition: the battle is on screen').toBe(true);
    expect(shownById('shop-overlay'), 'a: no shop opens over a battle').toBe(false);
    expect(stack(), 'a: only the battle base').toEqual([{ kind: 'battle', battleId: '101' }]);
    endBattle(BATTLE_ID, 1200);
    expect(battleShown(), 'a: precondition: the battle is gone').toBe(false);
    settle(1250);
    expect(shownById('shop-overlay'), 'a: the pending id was consumed: nothing opens later').toBe(
      false,
    );
    expect(stack(), 'a: the bare world').toEqual([{ kind: 'world' }]);

    // (b) one batch: the conversation row goes AND a TERMINAL battle row arrives and is shown as
    // the outcome. The base is the world: only the outcome (battleView) frame blocks the open.
    startConversation(1300);
    expect(shownById('dialogue-overlay'), 'precondition: the dialogue is open again').toBe(true);
    clickShop(1310);
    opts.store.removeConversation(H.identity);
    opts.store.upsertBattle(battleRow(BATTLE_ID + 1n, 'SideAWins'));
    settle(1400);
    expect(battleShown(), 'b: precondition: the outcome is on screen').toBe(true);
    expect(stack()[0], 'b: precondition: the base is the world, not a battle').toEqual({
      kind: 'world',
    });
    expect(shownById('shop-overlay'), 'b: no shop opens over the outcome').toBe(false);
    expect(stack(), 'b: the outcome is the only frame').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'battleView' },
    ]);
    fire('keydown', 'Escape', 1500);
    expect(battleShown(), 'b: precondition: Escape dismissed the outcome').toBe(false);
    settle(1600);
    expect(shownById('shop-overlay'), 'b: the pending id was consumed: nothing opens later').toBe(
      false,
    );
    expect(stack(), 'b: the bare world').toEqual([{ kind: 'world' }]);
  });

  it('CTL3-2-BOOT-PVP-ACCEPTER: a battle where the player is the opponent identity closes the open overlay, and the stack is the battle base', async () => {
    // WRONG IMPL KILLED: a reconcile fed the battle only when the player is `playerIdentity`
    // (a PvP accepter is stored in `opponentIdentity`): the shell's own base derivation still
    // sees the battle, so the base is right and the stack looks plausible while the overlay the
    // battle should have dropped stays painted over the accepter's fight.
    await bootReady();
    seedWorld(1000);
    const overlays: ReadonlyArray<{
      readonly name: string;
      readonly rootId: string;
      readonly code: string;
    }> = [
      { name: 'questLogView', rootId: 'quest-log-overlay', code: 'KeyQ' },
      { name: 'tradeView', rootId: 'trade-overlay', code: 'KeyU' },
    ];
    let t = 1010;
    let checked = 0;
    for (const [i, overlay] of overlays.entries()) {
      const root = rootOf(overlay.rootId);
      const battleId = 201n + BigInt(i);
      fire('keydown', overlay.code, t);
      expect(isShown(root), `${overlay.name}: precondition: opened`).toBe(true);

      opts.store.upsertBattle(accepterBattleRow(battleId, 'Ongoing'));
      settle(t + 50);
      expect(
        opts.store.ongoingBattle(H.identity)?.battleId,
        `${overlay.name}: precondition: the store sees the battle in the accepter role`,
      ).toBe(battleId);
      expect(battleShown(), `${overlay.name}: precondition: the battle is on screen`).toBe(true);
      expect(isShown(root), `${overlay.name}: closed when the accepter's battle arrives`).toBe(
        false,
      );
      expect(
        root.getAttribute('aria-modal'),
        `${overlay.name}: closed through its hide()`,
      ).toBeNull();
      expect(stack(), `${overlay.name}: only the battle base`).toEqual([
        { kind: 'battle', battleId: battleId.toString() },
      ]);

      endBattle(battleId, t + 100);
      t += 200;
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: both overlays were driven').toBe(2);
  });

  it('CTL3-3-BOOT-HIDE-ALL: rename, tradePropose, heal, raising, evolution and privacy each close through their own hide() when a battle arrives', async () => {
    // WRONG IMPL KILLED: a close command that skips some overlays (the six here were measured
    // as skipped by a mutant while every other boot case stayed green: the overlay is left
    // standing under the battle and, for privacy, its dismissal never runs). Each opens by its
    // own real path: N, A then A on Trade (face to face with the rival: ctl-10b retired O), A (the
    // stubbed interact rule names the heal NPC on the player's own tile), I and E, and the claim
    // overlay's privacy button.
    // ctl-10a: T retired — the heal frame opener was KeyT (the nearest-in-range rule picked the
    // heal NPC); it is A now, with the wasm rule stub naming that NPC.
    // Not separately observed: privacy's onDismissed effect (it disarms an armed delete
    // confirmation). Arming needs an Active account row plus the frame loop's account pump, and
    // the batch's own export listener repaints the overlay before the reconcile, so no cheap
    // sentinel survives. hide() is onDismissed's ONLY caller, and the aria-modal strip below is
    // written by the same hide(), so it proves the call that carries it.
    // Raising and evolution build their own roots, whose ids this suite does not know: they are
    // checked for visibility and the stack only, not for the a11y strip.
    await bootReady();
    useRule(pick(['npc', '12']));
    seedWorld(1000);
    opts.store.upsertNpc({
      entityId: 12n,
      npcId: 'healer',
      zoneId: 0,
      homeX: 2,
      homeY: 6,
      wanderRadius: 0,
      dialogueTreeId: 'no-such-tree',
      interaction: { kind: 'heal', locationId: 1 },
    });
    opts.store.upsertCharacter(
      {
        entityId: 12n,
        zoneId: 0,
        tileX: 2,
        tileY: 6,
        facing: 'South',
        action: 'Idle',
        moveStartedAtMs: 0n,
        moveQueue: [] as WasmMoveInput[],
      },
      1005,
    );
    // ctl-10b: the rival the tradeProposeView opener faces (online, with a character row).
    placeRival(3, 6, 1005);
    settle(1010);

    const overlays: ReadonlyArray<{
      readonly name: string;
      readonly rootId?: string;
      readonly open: (t: number) => void;
      readonly shown: () => boolean;
    }> = [
      {
        name: 'renameView',
        rootId: 'rename-overlay',
        open: (t) => void fire('keydown', 'KeyN', t),
        shown: () => shownById('rename-overlay'),
      },
      {
        // ctl-10b (named intentional change): O is retired; the wizard opens face to face. The rule is
        // switched to the rival (a new batch invalidates the memoised candidates), A opens the
        // picker and A on its first row (Trade) opens the wizard.
        name: 'tradeProposeView',
        rootId: 'tradepropose-overlay',
        open: (t) => {
          useRule(pick(['player', '20']));
          settle(t);
          tapKey('Enter', t + 10);
          tapKey('Enter', t + 20);
        },
        shown: () => shownById('tradepropose-overlay'),
      },
      {
        name: 'healView',
        rootId: 'heal-overlay',
        open: (t) => {
          // ctl-10b: the rule is switched back to the healer (a new batch for the memo).
          useRule(pick(['npc', '12']));
          settle(t);
          tapKey('Enter', t + 10);
        },
        shown: () => shownById('heal-overlay'),
      },
      {
        name: 'raisingView',
        open: (t) => void fire('keydown', 'KeyI', t),
        shown: () => shownByTestId('raising-title'),
      },
      {
        name: 'evolutionView',
        open: (t) => void fire('keydown', 'KeyE', t),
        shown: () => shownByTestId('evolution-title'),
      },
      {
        name: 'privacyView',
        rootId: 'privacy-overlay',
        open: () => {
          opts.onSignInFailed?.('denied');
          rootOf('claim-privacy-btn').click();
        },
        shown: () => shownById('privacy-overlay'),
      },
    ];
    let t = 1100;
    let checked = 0;
    for (const [i, overlay] of overlays.entries()) {
      const battleId = 301n + BigInt(i);
      overlay.open(t);
      expect(overlay.shown(), `${overlay.name}: precondition: opened`).toBe(true);
      if (overlay.rootId !== undefined) {
        expect(
          rootOf(overlay.rootId).getAttribute('aria-modal'),
          `${overlay.name}: precondition: opened through its own a11y path`,
        ).toBe('true');
      }

      startBattle(battleId, t + 50);
      expect(battleShown(), `${overlay.name}: precondition: the battle is on screen`).toBe(true);
      expect(overlay.shown(), `${overlay.name}: hidden once the battle row arrives`).toBe(false);
      if (overlay.rootId !== undefined) {
        expect(
          rootOf(overlay.rootId).getAttribute('aria-modal'),
          `${overlay.name}: closed through its OWN hide(): the a11y close strips aria-modal`,
        ).toBeNull();
      }
      expect(stack(), `${overlay.name}: only the battle base`).toEqual([
        { kind: 'battle', battleId: battleId.toString() },
      ]);

      endBattle(battleId, t + 100);
      expect(battleShown(), `${overlay.name}: precondition: the battle ended`).toBe(false);
      t += 200;
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all six overlays were driven').toBe(6);
  });

  it('CTL3-2-BOOT-OUTCOME-SAME-BATCH: an overlay left up over an Ongoing battle is closed by the very batch that turns the row terminal, before any frame runs', async () => {
    // WRONG IMPL KILLED (the reviewer's finding): a reconcile that knows only the battle BASE.
    // When the row turns terminal the base returns to the world and the outcome is about to be
    // shown by a later listener, so with no outcome knowledge the overlay survives this batch
    // (the outcome frame would only appear, and only then drop it, a batch later) and the
    // outcome takes focus over a still-painted overlay.
    // ctl-6b CTL6B.2: Escape no longer hides an Ongoing battle (B17), so the overlay is no longer
    // left up "under an Escape-hidden battle". The claim overlay's sign-in-failed callback shows it
    // with no verdict, over the still-shown battle, and no batch runs before the terminal one.
    await bootReady();
    seedWorld(1000);
    startBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    opts.onSignInFailed?.('denied');
    expect(
      shownById('claim-overlay'),
      'precondition: the claim overlay is up over the battle',
    ).toBe(true);
    expect(battleShown(), 'precondition: the Ongoing battle is still shown').toBe(true);
    frame(1210); // mirrors the callback-opened overlay onto the stack; not a batch
    // ctl-6c stamps a screen frame pushed over a battle base that was already the base with overBattle.
    expect(stack(), 'precondition: it is a frame over the battle base').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'claimView', overBattle: '101' },
    ]);

    // No frame runs between here and the assertions: the batch alone must do it.
    opts.store.upsertBattle(battleRow(BATTLE_ID, 'SideAWins'));
    settle(1300);
    expect(battleShown(), 'the outcome is on screen').toBe(true);
    expect(shownById('claim-overlay'), 'the claim overlay is closed in that same batch').toBe(
      false,
    );
    expect(rootOf('claim-overlay').getAttribute('aria-modal'), 'through its own hide()').toBeNull();
    expect(stack(), 'the world base with the outcome frame only').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'battleView' },
    ]);
  });

  it('CTL3-1-BOOT-CLOSE-BEFORE-SHOW: the overlay a battle drops is closed before the battle shows, so the battle remembers the world, not the closed overlay, as its focus return', async () => {
    // BEST EFFORT (mutant 7). WRONG IMPL KILLED: a reconcile registered after the battle's
    // listener. The battle then opens while the quest log still owns focus and records the
    // quest log's anchor as its return target; when the battle ends, focus is handed back INTO
    // the closed overlay instead of the world. The order is observed through that return
    // target: the world canvas is focused before the quest log opens, the quest log's deferred
    // focus moves into it (precondition), and after the battle has come and gone focus must be
    // back on the canvas. Final focus is the same on both orders only if the environment's
    // focus() ignores a hidden element; the precondition asserts focus really moved so a silent
    // non-discrimination reads as a failed precondition, never as a pass.
    await bootReady();
    seedWorld(1000);
    const canvas = document.querySelector('canvas');
    if (canvas === null) throw new Error('the renderer stub did not mount a canvas');
    canvas.focus();
    expect(document.activeElement, 'precondition: the world canvas has focus').toBe(canvas);

    fire('keydown', 'KeyQ', 1010);
    expect(shownById('quest-log-overlay'), 'precondition: the quest log opened').toBe(true);
    await flush();
    expect(
      document.activeElement?.id,
      'precondition: the quest log took focus (its deferred initial focus ran)',
    ).toBe('quest-log-list');

    startBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(shownById('quest-log-overlay'), 'precondition: the quest log was closed').toBe(false);
    endBattle(BATTLE_ID, 1200);
    expect(battleShown(), 'precondition: the battle is gone').toBe(false);
    expect(
      document.activeElement,
      'focus is back on the world canvas, not inside the closed quest log',
    ).toBe(canvas);
  });
});

// ==========================================================================================
// ctl-7c: a nav-capable screen frame takes the D-pad (CTL7C.1)
// ==========================================================================================
//
// Same harness, one fresh main.ts per case. The adapter table main.ts hands its screen host is the
// module mock's mutable copy (`H.adapters`), so a case swaps ONE frame's adapter for a recording
// stand-in while every other frame stays legacy. The subject is the quest log: Q opens it at the
// world, and the main menu's Journal entry opens it above the menu. Observed: the buttons the
// stand-in is asked, the menu cursor (`__game().navActive`, read-only), the intents sent to the
// stubbed enqueueMove reducer, and `defaultPrevented`. Every case is synchronous after boot, so no
// overlay's deferred focus runs and `worldHasFocus()` stays true for the next open.

/** Swap one frame's adapter for this boot; afterEach (the `restorers` drain) puts it back. */
function swapAdapter(id: string, adapter: unknown): void {
  const previous = H.adapters[id];
  H.adapters[id] = adapter;
  restorers.push(() => {
    H.adapters[id] = previous;
  });
}

/** A stand-in adapter that records every button it is asked. Nav-capable when `nav`. It consumes
 *  the D-pad and LB, answers B / Start / Select as the legacy adapter does (so the frame still
 *  closes), and leaves everything else unhandled. Its state is whatever it was handed. */
function recordingAdapter(seen: NavInput[], nav: boolean): unknown {
  const legacy: Readonly<Record<string, unknown>> = {
    B: { kind: 'pop' },
    Start: { kind: 'popToBase' },
    Select: { kind: 'toggleHelp' },
  };
  const answer = (btn: NavInput): unknown => {
    if (['Up', 'Down', 'Left', 'Right', 'LB'].includes(btn.button)) return 'consumed';
    const result = legacy[btn.button];
    if (result === undefined) return 'unhandled';
    return btn.repeat ? 'consumed' : result;
  };
  return {
    ...(nav ? { nav: true } : {}),
    viewModel: () => undefined,
    init: () => undefined,
    onButton: (_vm: unknown, state: unknown, btn: NavInput) => {
      seen.push(btn);
      return { state, result: answer(btn) };
    },
  };
}

/** A keydown at `t` and its keyup 5 ms later; returns the keydown. */
function tapKey(code: string, t: number): KeyboardEvent {
  const down = fire('keydown', code, t);
  fire('keyup', code, t + 5);
  return down;
}

/** The main menu's active entry while it is open (under a child too), else null. */
const menuCursor = (): string | null =>
  (window as unknown as { __game: () => { navActive: string | null } }).__game().navActive;
const questShown = (): boolean => shownById('quest-log-overlay');

describe('main.ts D-pad on a nav-capable screen (runtime, ctl-7c)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL7C-1-BOOT-DPAD: a nav-capable quest log takes ArrowDown and S as Down (opened at the world and over the open main menu): the press is prevented, nothing walks, the menu cursor stays, and a held arrow repeats into it at +350 then every 100 ms on the frame loop; a Down held when B pops it never repeats into the menu; the menu on top still takes the D-pad; the legacy quest log and a stand-in without nav get no D-pad edge', async () => {
    // WRONG IMPL KILLED: a nav screen whose D-pad still goes to the world or is swallowed (red
    // today: a dialogue, shop or heal screen gets no Up/Down), one wired from the menu's place
    // alone (the quest log over the covered main menu would move the HIDDEN menu's cursor, or
    // nothing), a `routeCtx` that checks the covered menu before the nav screen (the frame the
    // player sees gets nothing), repeats that never reach the screen or arrive unflagged, a
    // repeat armed under the quest log that survives its pop and runs the menu cursor on with no
    // key pressed in the menu (the mirror edge must reset it), a host that hands the D-pad to a
    // frame whose adapter is NOT nav-capable (every legacy frame would get arrows it never asked
    // for), and a menu that loses the D-pad while a nav adapter is merely registered for another
    // frame. NOT killed here: a pre-ladder intercept that ignores nav screens (the tail route
    // still delivers and prevents the D-pad press itself); the OS-repeat Enter assertion in
    // main.controls.test.ts `CTL7C-2-BOOT-STATE` pins that.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    const legacyQuestLog = H.adapters.questLogView;
    expect(
      legacyQuestLog,
      'precondition: the mocked table carries the quest log entry',
    ).toBeDefined();
    const seen: NavInput[] = [];
    swapAdapter('questLogView', recordingAdapter(seen, true));

    // --- (a) the quest log opened at the world ----------------------------------------------
    tapKey('KeyQ', 1010);
    expect(questShown(), 'a, precondition: Q opened the quest log').toBe(true);
    expect(stack(), 'a, precondition: one frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'questLogView' },
    ]);
    expect(seen, 'a, precondition: opening asked the adapter nothing').toEqual([]);

    const arrow = fire('keydown', 'ArrowDown', 1100);
    expect(seen, 'a: ArrowDown reaches the quest log adapter as a fresh Down').toEqual([
      { button: 'Down', repeat: false },
    ]);
    expect(arrow.defaultPrevented, 'a: the press is prevented').toBe(true);
    expect(H.sends, 'a: nothing walks').toHaveLength(0);
    expect(menuCursor(), 'a: no menu is open to move').toBeNull();
    expect(stack(), 'a: the frame is unchanged').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'questLogView' },
    ]);

    // Held: the first repeat 350 ms after the press, then one every 100 ms, on the frame loop.
    frame(1449);
    expect(seen, 'a: nothing repeats before +350').toHaveLength(1);
    frame(1450);
    expect(seen, 'a: the first repeat at +350').toEqual([
      { button: 'Down', repeat: false },
      { button: 'Down', repeat: true },
    ]);
    frame(1549);
    expect(seen).toHaveLength(2);
    frame(1550);
    expect(seen, 'a: the next at +450').toHaveLength(3);
    expect(seen.at(-1)).toEqual({ button: 'Down', repeat: true });
    // An OS key-repeat of the held arrow is prevented and is not a second press.
    const osRepeat = fire('keydown', 'ArrowDown', 1560, { init: { repeat: true } });
    expect(osRepeat.defaultPrevented, 'a: the OS repeat is prevented').toBe(true);
    expect(seen).toHaveLength(3);
    fire('keyup', 'ArrowDown', 1600);
    frame(1700);
    frame(2000);
    expect(seen, 'a: the release stops the repeat and asks nothing').toHaveLength(3);

    // S is Down and W is Up too.
    const s = tapKey('KeyS', 2100);
    expect(seen.at(-1), 'a: S is Down').toEqual({ button: 'Down', repeat: false });
    expect(s.defaultPrevented).toBe(true);
    const w = tapKey('KeyW', 2200);
    expect(seen.at(-1), 'a: W is Up').toEqual({ button: 'Up', repeat: false });
    expect(w.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(5);
    expect(H.sends, 'a: no D-pad press under the screen walked').toHaveLength(0);

    // B closes it through the adapter's own pop.
    tapKey('Backspace', 2300);
    expect(seen.at(-1)).toEqual({ button: 'B', repeat: false });
    expect(questShown(), 'a: B closed the quest log').toBe(false);
    expect(stack()).toEqual([{ kind: 'world' }]);

    // --- (b) the quest log opened over the open main menu, through the menu --------------------
    tapKey('KeyM', 2400);
    expect(overlayShown('menu-overlay'), 'b, precondition: M opened the menu').toBe(true);
    expect(menuCursor(), 'b, precondition: on the first entry').toBe('monsters');
    // The menu on top still takes the D-pad while a nav adapter is registered for another frame.
    tapKey('ArrowDown', 2500);
    expect(menuCursor(), 'b: the menu on top moves').toBe('bag');
    tapKey('ArrowDown', 2600);
    expect(menuCursor(), 'b, precondition: the cursor is on Journal').toBe('journal');
    const asked = seen.length;
    expect(asked, 'b: the quest log adapter was not asked for the menu`s presses').toBe(6);
    tapKey('Enter', 2700);
    expect(questShown(), 'b, precondition: A on Journal opened the quest log').toBe(true);
    expect(stack(), 'b, precondition: the quest log is above the covered menu').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
      { kind: 'screen', id: 'questLogView' },
    ]);

    const over = fire('keydown', 'ArrowDown', 2800);
    expect(seen.slice(asked), 'b: ArrowDown reaches the quest log over the menu').toEqual([
      { button: 'Down', repeat: false },
    ]);
    expect(over.defaultPrevented, 'b: the press is prevented').toBe(true);
    expect(menuCursor(), 'b: the covered menu cursor does not move').toBe('journal');
    frame(3149);
    expect(seen.length - asked).toBe(1);
    frame(3150);
    expect(seen.slice(asked), 'b: the repeat at +350 reaches the quest log').toEqual([
      { button: 'Down', repeat: false },
      { button: 'Down', repeat: true },
    ]);
    frame(3249);
    frame(3250);
    expect(seen.length - asked, 'b: and the next at +450').toBe(3);
    expect(menuCursor(), 'b: the covered menu never moved').toBe('journal');
    fire('keyup', 'ArrowDown', 3260);
    frame(3400);
    expect(seen.length - asked).toBe(3);
    expect(H.sends, 'b: nothing walked').toHaveLength(0);

    // Down held under the quest log, then B pops it: the held Down never repeats into the menu.
    fire('keydown', 'ArrowDown', 3800);
    expect(seen.at(-1), 'b: a fresh Down').toEqual({ button: 'Down', repeat: false });
    tapKey('Backspace', 3900);
    expect(seen.at(-1)).toEqual({ button: 'B', repeat: false });
    expect(questShown(), 'b: B popped the quest log').toBe(false);
    expect(stack(), 'b: the menu is on top again').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
    ]);
    const afterPop = seen.length;
    frame(4150);
    frame(4250);
    frame(4500);
    expect(menuCursor(), 'b: the Down held from the quest log does not walk the menu').toBe(
      'journal',
    );
    expect(seen.length, 'b: nor reach the closed quest log').toBe(afterPop);
    fire('keyup', 'ArrowDown', 4600);
    // Control: a fresh press on the menu, now on top, does move it.
    tapKey('ArrowDown', 4700);
    expect(menuCursor(), 'b, control: the menu on top moves for a fresh press').toBe('social');
    expect(seen.length, 'b, control: and the quest log adapter is not asked').toBe(afterPop);

    // --- (c) the shipped legacy quest log adapter: today's behaviour ---------------------------
    tapKey('Escape', 4800);
    expect(overlayShown('menu-overlay'), 'c, precondition: Escape closed the menu').toBe(false);
    swapAdapter('questLogView', legacyQuestLog);
    tapKey('KeyQ', 4900);
    expect(questShown(), 'c, precondition: Q opened the quest log').toBe(true);
    const legacyArrow = fire('keydown', 'ArrowDown', 5000);
    expect(legacyArrow.defaultPrevented, 'c: still prevented (no page scroll)').toBe(true);
    frame(5350);
    frame(5450);
    fire('keyup', 'ArrowDown', 5460);
    expect(questShown(), 'c: the quest log is still open').toBe(true);
    expect(stack()).toEqual([{ kind: 'world' }, { kind: 'screen', id: 'questLogView' }]);
    expect(seen.length, 'c: the swapped-out stand-in is not asked').toBe(afterPop);
    tapKey('KeyQ', 5500);
    expect(questShown(), 'c: Q closed it').toBe(false);

    // --- (c') a recording stand-in WITHOUT nav: the D-pad never reaches it ----------------------
    const plain: NavInput[] = [];
    swapAdapter('questLogView', recordingAdapter(plain, false));
    tapKey('KeyQ', 5600);
    expect(questShown(), "c', precondition: Q opened the quest log").toBe(true);
    const plainArrow = fire('keydown', 'ArrowDown', 5700);
    expect(plainArrow.defaultPrevented, "c': the arrow is still prevented").toBe(true);
    frame(6050);
    frame(6150);
    fire('keyup', 'ArrowDown', 6160);
    const plainS = tapKey('KeyS', 6200);
    expect(plainS.defaultPrevented).toBe(true);
    expect(plain, "c': a frame without a nav-capable adapter gets no D-pad edge").toEqual([]);
    // Control: the stand-in is live and is asked for a button it does own.
    tapKey('PageUp', 6300);
    expect(plain, "c', control: PageUp reaches it as LB").toEqual([
      { button: 'LB', repeat: false },
    ]);
    expect(H.sends, 'no D-pad press in this whole case walked').toHaveLength(0);
  });
});

// ==========================================================================================
// ctl-7c round 2: a held D-pad key never repeats across a context change (red-team findings)
// ==========================================================================================
//
// The router's synthesized repeat belongs to the frame the key was pressed in. Every way the
// context can change under a held key must stop it: a frame pushed above (the mirror edge), and a
// base that changes kind under a frame that stays (no frame is pushed or popped then).

describe('main.ts held D-pad and context changes (runtime, ctl-7c)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL7C-1-BOOT-BASE-RESET: a D-pad key held on a nav-capable dialogue stops repeating into it when a battle row arrives (the dialogue stays on the stack, suspended, over the new battle base); with no battle the same hold does repeat', async () => {
    // WRONG IMPL KILLED (red-team, a real bug): a base change of kind that clears the world's held
    // set but leaves the router's repeat armed. The stack goes from [world, dialogueView] to
    // [battle, dialogueView]: no frame is pushed or popped (no mirror edge) and the reconcile drops
    // nothing (the conversation suspends), so nothing else resets it, and the arrow held from
    // before the battle keeps driving the dialogue's cursor at 10 Hz under the fight.
    await bootReady();
    seedWorld(1000);
    const seen: NavInput[] = [];
    swapAdapter('dialogueView', recordingAdapter(seen, true));
    const repeats = (): NavInput[] => seen.filter((b) => b.repeat);
    startConversation(1100);
    expect(shownById('dialogue-overlay'), 'precondition: the server opened the dialogue').toBe(
      true,
    );
    expect(stack(), 'precondition: the dialogue is the one frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'dialogueView' },
    ]);

    // Control: with no battle, the held arrow repeats into the dialogue at +350 and +450.
    fire('keydown', 'ArrowDown', 1200);
    expect(seen, 'control: the press reaches the dialogue').toEqual([
      { button: 'Down', repeat: false },
    ]);
    frame(1549);
    expect(repeats(), 'control: nothing before +350').toEqual([]);
    frame(1550);
    frame(1650);
    expect(repeats(), 'control: the held arrow repeats into the dialogue').toEqual([
      { button: 'Down', repeat: true },
      { button: 'Down', repeat: true },
    ]);
    fire('keyup', 'ArrowDown', 1700);

    // The same hold, and a battle row arrives 100 ms into it.
    fire('keydown', 'ArrowDown', 2000);
    expect(seen.at(-1), 'precondition: a fresh press reaches the dialogue').toEqual({
      button: 'Down',
      repeat: false,
    });
    const before = repeats().length;
    startBattle(BATTLE_ID, 2100);
    expect(stack(), 'precondition: the dialogue is kept, suspended over the battle base').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'dialogueView' },
    ]);
    frame(2350);
    frame(2450);
    frame(2550);
    expect(
      repeats().length,
      'the arrow held from before the battle never repeats into the suspended dialogue',
    ).toBe(before);
    fire('keyup', 'ArrowDown', 2600);
    expect(H.sends, 'nothing walked').toHaveLength(0);
  });

  it('CTL7C-1-BOOT-PUSH-RESET: Up held on the open main menu, A opens the nav-capable Journal above it while Up is still down: the held Up never repeats into the Journal and the covered menu does not move; a fresh Up press in the Journal does reach it', async () => {
    // WRONG IMPL KILLED (M5d): a push mirror edge that no longer resets the repeat (or resets it
    // only for a pop). The Up pressed on the menu stays armed, the Journal takes the D-pad, and
    // 350 ms after the press the player's cursor in a screen they just opened moves with no key
    // pressed in it.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    const seen: NavInput[] = [];
    swapAdapter('questLogView', recordingAdapter(seen, true));
    tapKey('KeyM', 1010);
    tapKey('ArrowDown', 1100);
    tapKey('ArrowDown', 1200);
    tapKey('ArrowDown', 1300);
    expect(menuCursor(), 'precondition: the cursor is on Social').toBe('social');

    fire('keydown', 'ArrowUp', 2000);
    expect(menuCursor(), 'precondition: Up moved the cursor to Journal').toBe('journal');
    fire('keydown', 'Enter', 2050); // A opens the Journal; Up is still down (its repeat: 2350)
    fire('keyup', 'Enter', 2055);
    expect(questShown(), 'precondition: A on Journal opened the quest log').toBe(true);
    expect(stack(), 'precondition: the Journal is above the covered menu').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
      { kind: 'screen', id: 'questLogView' },
    ]);
    for (const t of [2349, 2350, 2450, 2700]) frame(t);
    expect(seen, 'the Up held since before the Journal opened never reaches it').toEqual([]);
    expect(menuCursor(), 'and the covered menu did not move').toBe('journal');
    fire('keyup', 'ArrowUp', 2800);

    // Control: a fresh Up in the Journal is the Journal's.
    tapKey('ArrowUp', 2900);
    expect(seen, 'control: a fresh press reaches the Journal').toEqual([
      { button: 'Up', repeat: false },
    ]);
    expect(H.sends, 'nothing walked').toHaveLength(0);
  });
});

// ==========================================================================================
// ctl-10a: world A and Y act on what the wasm rule says you face; T retired (CTL10A.1-3)
// ==========================================================================================
//
// Same harness, one fresh main.ts per case. The interaction RULE is the wasm export
// `interact_candidates_coded(ownX, ownY, facingCode /* N0 S1 E2 W3 */, zone, entities)`, stubbed
// here (`H.interact`) and recorded (`H.interactCalls`). `entities` is the marshalled list
// `{ kind: 'npc' | 'heal' | 'player', x, y, zone, id: decimal string }` (an NPC at its
// character-row tile, a heal location, another player; the own character excluded) and the answer
// is a list of indices into it. Each case installs the rule it needs: `pick(...)` names entities
// by kind and id whatever their tile (the stub is the ONLY rule, so a TS rule left in main.ts shows
// up as a disagreement), `facedTileRule` transcribes game-core's faced-tile-then-own-tile rule.
//
// Observed: the reducers called and their arguments (`H.callArgs`), which frames are shown, the
// read-only `__game().stack`, the `#status` line, and the chip `#interact-prompt` (its exact text,
// or the picker / action-sheet rows rendered inside it as nav rows). The chip is repainted by the
// frame loop, so a case runs a frame before it reads the chip. A case that changes the rule mid-way
// delivers a store batch after it: the candidates are memoised per batch, position and facing.

const EM_DASH = String.fromCharCode(0x2014);
const ELLIPSIS = String.fromCharCode(0x2026);
const RIVAL_IDENTITY = 'ef'.repeat(32);
const RIVAL_ENTITY = 20n;

/** One marshalled entity, as main.ts hands it to the wasm rule. */
interface WireEntity {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly zone: number;
  readonly id: string;
}

/** A stand-in for the wasm rule: the indices of the candidates, from the export's arguments. */
type InteractRule = (
  ownX: number,
  ownY: number,
  facing: number,
  zone: number,
  entities: readonly WireEntity[],
) => number[];

/** Install `rule` as the stubbed `interact_candidates_coded` for this boot. */
function useRule(rule: InteractRule): void {
  H.interact = (...args: unknown[]) => {
    const [x, y, facing, zone, entities] = args;
    if (!Array.isArray(entities)) return [];
    return rule(
      x as number,
      y as number,
      facing as number,
      zone as number,
      entities as WireEntity[],
    );
  };
}

/** A rule that names exactly these entities (by kind and id), in this order, wherever they stand. */
function pick(...keys: ReadonlyArray<readonly [string, string]>): InteractRule {
  return (_x, _y, _facing, _zone, entities) =>
    keys.flatMap(([kind, id]) => {
      const at = entities.findIndex((e) => e.kind === kind && e.id === id);
      return at === -1 ? [] : [at];
    });
}

/** A rule that names every NPC in the list, wherever it stands. */
function everyNpc(
  _x: number,
  _y: number,
  _facing: number,
  _zone: number,
  entities: readonly WireEntity[],
): number[] {
  return entities.flatMap((e, i) => (e.kind === 'npc' ? [i] : []));
}

const FACING_DELTA: Readonly<Record<number, readonly [number, number]>> = {
  0: [0, -1],
  1: [0, 1],
  2: [1, 0],
  3: [-1, 0],
};
const KIND_ORDER: Readonly<Record<string, number>> = { npc: 0, heal: 1, player: 2 };

/** game-core's rule (CTL9.1), transcribed as a stub: the entities on the faced tile, else on the
 *  own tile; same zone only; by kind (NPC, heal, player), then by numeric id. */
function facedTileRule(
  x: number,
  y: number,
  facing: number,
  zone: number,
  entities: readonly WireEntity[],
): number[] {
  const delta = FACING_DELTA[facing];
  if (delta === undefined) return [];
  const on = (tx: number, ty: number): number[] =>
    entities
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.zone === zone && e.x === tx && e.y === ty)
      .sort(
        (a, b) =>
          (KIND_ORDER[a.e.kind] ?? 9) - (KIND_ORDER[b.e.kind] ?? 9) ||
          Number(a.e.id) - Number(b.e.id),
      )
      .map(({ i }) => i);
  const front = on(x + delta[0], y + delta[1]);
  return front.length > 0 ? front : on(x, y);
}

/** One NPC row and its character at (`x`, `y`), with no flush. */
function placeNpc(
  entityId: bigint,
  npcId: string,
  x: number,
  y: number,
  interaction: StoreNpcRow['interaction'],
  t: number,
): void {
  opts.store.upsertNpc({
    entityId,
    npcId,
    zoneId: 0,
    homeX: x,
    homeY: y,
    wanderRadius: 0,
    dialogueTreeId: 'no-such-tree',
    interaction,
  });
  opts.store.upsertCharacter(
    {
      entityId,
      zoneId: 0,
      tileX: x,
      tileY: y,
      facing: 'South',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
}

/** A heal location row, free and with no cooldown, with no flush. */
function healLocation(locationId: number, tileX: number, tileY: number): void {
  opts.store.upsertHealLocation({
    locationId,
    zoneId: 0,
    tileX,
    tileY,
    costQty: 0,
    cooldownMs: 0,
    costCurrency: 0n,
  });
}

/** Another player (online unless `online` is false) and its character at (`x`, `y`), with no flush. */
function placeRival(x: number, y: number, t: number, online = true): void {
  placePlayer(RIVAL_IDENTITY, RIVAL_ENTITY, 'Rival', x, y, t, online);
}

/** One other player and its character at (`x`, `y`), with no flush (ctl-10b: any number may stand
 *  about, each with its own identity and entity id). */
function placePlayer(
  identity: string,
  entityId: bigint,
  name: string,
  x: number,
  y: number,
  t: number,
  online = true,
): void {
  opts.store.upsertPlayer({ identity, entityId, name, online, lastInputSeq: 0n });
  opts.store.upsertCharacter(
    {
      entityId,
      zoneId: 0,
      tileX: x,
      tileY: y,
      facing: 'West',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
}

const chip = (): HTMLElement => rootOf('interact-prompt');
/** The picker / action-sheet rows rendered inside the chip. */
const chipOptions = (): HTMLElement[] => [
  ...chip().querySelectorAll<HTMLElement>('[role="option"]'),
];
const chipRowTexts = (): string[] => chipOptions().map((row) => (row.textContent ?? '').trim());
const chipText = (): string => (chip().textContent ?? '').trim();
const talkArgs = (): unknown[] => H.callArgs.filter((c) => c.name === 'talk').map((c) => c.args);
const healArgs = (): unknown[] =>
  H.callArgs.filter((c) => c.name === 'healParty').map((c) => c.args);
/** The location ids the heal frame's list is bound to. */
const healListIds = (): Array<string | undefined> =>
  [...document.querySelectorAll<HTMLElement>('#heal-list li')].map((li) => li.dataset.locationId);
const healShown = (): boolean => shownById('heal-overlay');
const statusLine = (): string => document.getElementById('status')?.textContent ?? '';
const WORLD_ONLY = [{ kind: 'world' }];
const HEAL_STACK = [{ kind: 'world' }, { kind: 'screen', id: 'healView' }];

describe('main.ts world A / Y act on the wasm candidates; T retired (runtime, ctl-10a)', {
  sequential: true,
}, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL10A-1-BOOT-A-TALK: A at the world with one dialogue NPC candidate sends talk once with that NPC`s entity id; a shop NPC candidate is talked to the same way; nothing else is sent and no frame opens', async () => {
    // WRONG IMPL KILLED: A at the world doing nothing (today), a talk sent with the wrong id or a
    // dropped argument, two talks for one press, a shop NPC that opens the shop directly instead of
    // the greet-then-shop talk, and an A that also pushes a frame.
    await bootReady();
    useRule(pick(['npc', '11']));
    seedWorld(1000);
    frame(1005);
    tapKey('Enter', 1010);
    expect(talkArgs(), 'one talk, to the candidate').toEqual([{ npcEntityId: NPC_ENTITY }]);
    expect(H.calls, 'and nothing else').toEqual(['talk']);
    expect(stack(), 'no frame is pushed by the talk itself').toEqual(WORLD_ONLY);
    expect(H.sends, 'A walks nowhere').toHaveLength(0);

    // A shop NPC: the shop opens through the greet-then-shop conversation, so A talks to it.
    placeNpc(13n, 'keeper', 2, 5, { kind: 'shop', shopId: 3 }, 1020);
    useRule(pick(['npc', '13']));
    settle(1020);
    frame(1030);
    tapKey('Enter', 1040);
    expect(talkArgs(), 'the shop NPC is talked to by its own id').toEqual([
      { npcEntityId: NPC_ENTITY },
      { npcEntityId: 13n },
    ]);
    expect(shownById('shop-overlay'), 'no shop opens without the conversation').toBe(false);
    expect(stack()).toEqual(WORLD_ONLY);
  });

  it('CTL10A-1-BOOT-WASM-RULE: the wasm export is the ONLY rule: it is asked with the own x, y, facing code, zone and the marshalled entities, A talks to an NPC five tiles away when the rule names it, and sends nothing with an NPC directly ahead when the rule names none', async () => {
    // WRONG IMPL KILLED: a TypeScript range or facing rule kept in main.ts (it would refuse the NPC
    // five tiles away, or talk to the one directly ahead the rule rejected); arguments in another
    // order, the facing as a name instead of its code, the NPC at its HOME instead of its character
    // tile, ids as numbers or bigints instead of decimal strings, the own character in the list, and
    // a client-side range filter that drops the far NPC from the list.
    await bootReady();
    useRule(pick(['npc', '13']));
    seedWorld(1000);
    // The far NPC's home is elsewhere: only its character row says where it stands.
    opts.store.upsertNpc({
      entityId: 13n,
      npcId: 'far',
      zoneId: 0,
      homeX: 0,
      homeY: 0,
      wanderRadius: 3,
      dialogueTreeId: 'no-such-tree',
      interaction: { kind: 'dialogue' },
    });
    opts.store.upsertCharacter(
      {
        entityId: 13n,
        zoneId: 0,
        tileX: 7,
        tileY: 6,
        facing: 'West',
        action: 'Idle',
        moveStartedAtMs: 0n,
        moveQueue: [] as WasmMoveInput[],
      },
      1010,
    );
    settle(1010);
    frame(1020);
    tapKey('Enter', 1030);
    expect(talkArgs(), 'the rule named the NPC five tiles away: A talks to it').toEqual([
      { npcEntityId: 13n },
    ]);

    const args = H.interactCalls.at(-1);
    expect(args, 'precondition: the rule was consulted').toBeDefined();
    expect(
      args?.slice(0, 4),
      'own x, own y, the facing code (East is 2), the zone of the own row',
    ).toEqual([2, 6, 2, 0]);
    const wire = args?.[4] as WireEntity[];
    expect(wire, 'two NPCs, no heal location, no other player, not the own character').toHaveLength(
      2,
    );
    expect(wire).toEqual(
      expect.arrayContaining([
        { kind: 'npc', x: 3, y: 6, zone: 0, id: '11' },
        { kind: 'npc', x: 7, y: 6, zone: 0, id: '13' },
      ]),
    );

    // The rule names nobody while a dialogue NPC stands directly ahead: A sends nothing.
    useRule(() => []);
    settle(1040);
    frame(1050);
    tapKey('Enter', 1060);
    expect(talkArgs(), 'no candidate: no talk, whatever stands ahead').toEqual([
      { npcEntityId: 13n },
    ]);
    expect(H.calls, 'and nothing else').toEqual(['talk']);
    expect(stack()).toEqual(WORLD_ONLY);
  });

  it('CTL10A-1-BOOT-BEHIND: with an NPC directly behind the character neither KeyT nor A talks and the chip is hidden; once that NPC`s character stands on the faced tile, A talks to it', async () => {
    // WRONG IMPL KILLED (r2-024, RED today): the nearest-in-range rule that ignores facing (KeyT
    // talks to the NPC behind), a KeyT kept as an interact key, and an A that interacts with
    // something the rule did not name. The control proves the rule stub and A are live here.
    await bootReady();
    useRule(facedTileRule);
    placeNpc(NPC_ENTITY, 'guide', 1, 6, { kind: 'dialogue' }, 1000);
    server(1000, { x: 2, y: 6, ack: 0 }); // the character faces East; the guide stands West
    frame(1005);
    fire('keydown', 'KeyT', 1010);
    fire('keyup', 'KeyT', 1012);
    expect(talkCalls(), 'KeyT: no talk to an NPC behind').toBe(0);
    tapKey('Enter', 1020);
    expect(talkCalls(), 'A: no talk either').toBe(0);
    expect(H.interactCalls.length, 'precondition: the rule was consulted').toBeGreaterThan(0);
    frame(1030);
    expect(promptShown(), 'the chip advertises nothing').toBe(false);

    // Control: the same NPC's character moves onto the faced tile.
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
      1040,
    );
    settle(1040);
    frame(1050);
    tapKey('Enter', 1060);
    expect(talkArgs(), 'control: faced, A talks to it').toEqual([{ npcEntityId: NPC_ENTITY }]);
  });

  it('CTL10A-1-BOOT-HEAL: A on a heal location candidate opens the heal frame alone, bound to THAT location (its Yes sends healParty with that id, not the first location loaded); a heal NPC candidate binds its own location the same way', async () => {
    // WRONG IMPL KILLED (B13): a heal bound to the first location in the store (7 is loaded first),
    // a heal that sends healParty at once instead of opening the frame, a frame opened together
    // with something else, a heal NPC treated as a talk, and an open that binds no location (Yes
    // would be disabled and send nothing).
    await bootReady();
    useRule(pick(['heal', '9']));
    healLocation(7, 1, 1);
    healLocation(9, 3, 6);
    server(1000, { x: 2, y: 6, ack: 0 });
    frame(1005);
    tapKey('Enter', 1010);
    expect(healShown(), 'A opened the heal frame').toBe(true);
    expect(stack(), 'alone, over the world').toEqual(HEAL_STACK);
    expect(healListIds(), 'bound to the candidate location').toEqual(['9']);
    expect(H.calls, 'opening the frame sends no reducer').toEqual([]);
    tapKey('Enter', 1100); // Yes is the default
    expect(healArgs(), 'Yes heals at THAT location').toEqual([{ locationId: 9 }]);
    expect(H.calls).toEqual(['healParty']);

    // A heal NPC (location 7) is the next candidate.
    tapKey('Escape', 1200);
    expect(stack(), 'precondition: Start closed the heal frame').toEqual(WORLD_ONLY);
    placeNpc(12n, 'nurse', 2, 5, { kind: 'heal', locationId: 7 }, 1210);
    useRule(pick(['npc', '12']));
    settle(1210);
    frame(1220);
    tapKey('Enter', 1230);
    expect(stack(), 'the heal NPC opens the heal frame').toEqual(HEAL_STACK);
    expect(healListIds(), 'bound to the NPC`s own location').toEqual(['7']);
    expect(talkCalls(), 'a heal NPC is not talked to').toBe(0);
    tapKey('Enter', 1300);
    expect(healArgs(), 'its Yes heals at the NPC`s location').toEqual([
      { locationId: 9 },
      { locationId: 7 },
    ]);
  });

  it('CTL10A-1-BOOT-PICKER: with two actionable candidates A opens a picker of entity x action as nav rows inside #interact-prompt; ArrowDown then A runs the SECOND row; while it is open the D-pad walks nowhere; B closes it; a row whose candidate is gone runs nothing; movement is live after', async () => {
    // WRONG IMPL KILLED: A running the first candidate when there are two (no picker), rows rendered
    // anywhere but the chip, rows without the nav kit's listbox / is-active / aria-selected marking,
    // rows in another order or with another text, a picker that ignores the cursor (the first row
    // runs), a picker under which W still walks, a B that leaves it open, a picker that runs a row
    // whose candidate a batch removed, and a picker that leaves movement dead after it closes.
    await bootReady();
    useRule(pick(['npc', '11'], ['heal', '9']));
    healLocation(9, 2, 5);
    seedWorld(1000);
    frame(1005);
    expect(chipOptions(), 'precondition: no picker before A').toEqual([]);

    tapKey('Enter', 1010);
    frame(1015);
    expect(chip().querySelector('[role="listbox"]'), 'the picker is a nav listbox').not.toBeNull();
    expect(chipRowTexts(), 'one row per entity x action, in candidate order').toEqual([
      `Talk ${EM_DASH} guide`,
      `Heal ${EM_DASH} Healer`,
    ]);
    expect(
      chipOptions().map((row) => row.getAttribute('aria-selected')),
      'the first row is selected',
    ).toEqual(['true', 'false']);
    expect(chipOptions().map((row) => row.classList.contains('is-active'))).toEqual([true, false]);
    expect(promptShown(), 'the chip holding the picker is shown').toBe(true);
    expect(H.calls, 'opening the picker sends nothing').toEqual([]);

    tapKey('ArrowDown', 1020);
    frame(1025);
    expect(
      chipOptions().map((row) => row.getAttribute('aria-selected')),
      'Down moves to the second row',
    ).toEqual(['false', 'true']);
    expect(chipOptions().map((row) => row.classList.contains('is-active'))).toEqual([false, true]);
    expect(H.sends, 'Down under the picker walks nowhere').toHaveLength(0);

    tapKey('Enter', 1030);
    expect(stack(), 'A ran the SECOND row: the heal frame').toEqual(HEAL_STACK);
    expect(healListIds()).toEqual(['9']);
    expect(talkCalls(), 'and not the first').toBe(0);

    tapKey('Escape', 1040);
    expect(stack(), 'precondition: Start closed the heal frame').toEqual(WORLD_ONLY);
    frame(1050);
    expect(chipOptions(), 'the picker is gone').toEqual([]);

    // Reopened: W under it walks nowhere; B closes it.
    tapKey('Enter', 1060);
    frame(1065);
    expect(chipOptions(), 'precondition: A reopened the picker').toHaveLength(2);
    tapKey('KeyW', 1070);
    frame(1075);
    expect(H.sends, 'W under the picker sends no move').toHaveLength(0);
    expect(chipOptions(), 'and the picker is still open').toHaveLength(2);
    tapKey('Backspace', 1080);
    frame(1085);
    expect(chipOptions(), 'B closed the picker').toEqual([]);
    expect(H.calls, 'closing runs nothing').toEqual([]);

    // A row whose candidate is gone runs nothing.
    tapKey('Enter', 1090);
    tapKey('ArrowDown', 1095);
    frame(1100);
    expect(chipOptions(), 'precondition: the picker is open again').toHaveLength(2);
    useRule(() => []);
    settle(1110);
    tapKey('Enter', 1120);
    expect(healShown(), 'the heal row is no longer a candidate: no heal frame').toBe(false);
    expect(H.calls, 'and nothing is sent').toEqual([]);
    expect(stack()).toEqual(WORLD_ONLY);
    frame(1130);
    expect(chipOptions(), 'the picker does not stay open').toEqual([]);

    // Movement is live again.
    tapKey('KeyW', 1140);
    expect(dirs(), 'a W press with no picker walks').toEqual(['North']);
  });

  it('CTL10A-1-BOOT-NONE: with no candidate A consults the rule and does nothing: no reducer, no frame, an empty #status, no chip; Y does nothing either', async () => {
    // WRONG IMPL KILLED: an A that never asks the wasm rule (it decides nothing at all, today), a
    // "nothing here" toast on the status line, an A that falls back to a TS rule and talks to the
    // NPC standing ahead (the rule named none), and an empty picker or sheet left in the chip.
    await bootReady();
    useRule(() => []);
    seedWorld(1000); // a dialogue NPC stands on the faced tile; the rule names nobody
    tapKey('Enter', 1010);
    expect(H.interactCalls.length, 'A consulted the wasm rule').toBeGreaterThan(0);
    expect(H.calls, 'no reducer').toEqual([]);
    expect(stack(), 'no frame').toEqual(WORLD_ONLY);
    expect(statusLine(), 'no toast').toBe('');
    frame(1020);
    expect(promptShown(), 'no chip').toBe(false);
    expect(chipOptions(), 'no picker').toEqual([]);

    tapKey('KeyF', 1030);
    frame(1040);
    expect(H.calls, 'Y: no reducer').toEqual([]);
    expect(chipOptions(), 'Y: no sheet').toEqual([]);
    expect(stack()).toEqual(WORLD_ONLY);
    expect(statusLine()).toBe('');
  });

  it('CTL10A-1-BOOT-LONE-PLAYER: another player is marshalled as a player entity; a lone ONLINE player candidate offers Trade and Challenge (the chip reads Choose, A and Y open a two-row picker / sheet and send nothing), while an OFFLINE player offers nothing: A and Y do nothing and the chip is hidden', async () => {
    // INTENTIONAL CHANGE (ctl-10b, CTL10B.1): a lone player used to have no action until ctl-10b
    // (the case asserted "A and Y do nothing"); an online player now offers Trade then Challenge, so
    // that half is retargeted to the picker rows, and the "nothing" half is kept for an OFFLINE
    // player (eligibility: only an online player offers actions).
    // WRONG IMPL KILLED: other players left out of the list (ctl-10b's trade and challenge could
    // never find them), a player candidate given no action, an action sent by merely opening the
    // picker, a player offered Challenge before Trade, an offline player offered anything, a chip
    // hidden for an actionable player, and a status-line toast for it.
    await bootReady();
    useRule(pick(['player', '20']));
    placeRival(3, 6, 1000);
    server(1000, { x: 2, y: 6, ack: 0 });
    frame(1005);
    const wire = H.interactCalls.at(-1)?.[4] as WireEntity[] | undefined;
    expect(wire, 'precondition: the rule was consulted').toBeDefined();
    expect(wire, 'the other player is marshalled').toEqual([
      { kind: 'player', x: 3, y: 6, zone: 0, id: '20' },
    ]);
    expect(promptShown(), 'a lone online player: the chip shows').toBe(true);
    expect(chipText(), 'two actions: Choose').toBe(`[Enter] Choose${ELLIPSIS}`);

    tapKey('Enter', 1010);
    frame(1015);
    expect(chipRowTexts(), 'A: Trade first, then Challenge').toEqual([
      `Trade ${EM_DASH} Rival`,
      `Challenge ${EM_DASH} Rival`,
    ]);
    expect(H.calls, 'opening the picker sends nothing').toEqual([]);
    tapKey('Backspace', 1020);
    frame(1025);
    expect(chipOptions(), 'B closes the picker').toEqual([]);
    tapKey('KeyF', 1030);
    frame(1035);
    expect(chipRowTexts(), 'Y: the same two rows').toEqual([
      `Trade ${EM_DASH} Rival`,
      `Challenge ${EM_DASH} Rival`,
    ]);
    expect(H.calls, 'Y sends nothing').toEqual([]);
    tapKey('Backspace', 1040);
    frame(1045);
    expect(chipOptions()).toEqual([]);

    // An offline player offers nothing.
    placeRival(3, 6, 1100, false);
    settle(1100);
    frame(1105);
    expect(promptShown(), 'an offline player: no chip').toBe(false);
    tapKey('Enter', 1110);
    frame(1115);
    expect(H.calls, 'A: nothing').toEqual([]);
    expect(chipOptions(), 'A: no picker').toEqual([]);
    tapKey('KeyF', 1120);
    frame(1125);
    expect(H.calls, 'Y: nothing').toEqual([]);
    expect(chipOptions(), 'Y: no sheet').toEqual([]);
    expect(stack()).toEqual(WORLD_ONLY);
    expect(statusLine()).toBe('');
    expect(promptShown()).toBe(false);
  });

  it('CTL10A-1-BOOT-HELD-A: an Enter held after it opened the heal frame (OS key-repeat and the frame loop`s repeat clock) never answers Yes; a fresh press does', async () => {
    // WRONG IMPL KILLED: a held Enter that reaches the heal frame it just opened and pays for a heal
    // the player never confirmed (an A delivered on every repeat, or a router repeat armed for A).
    await bootReady();
    useRule(pick(['heal', '9']));
    healLocation(9, 3, 6);
    server(1000, { x: 2, y: 6, ack: 0 });
    frame(1005);
    fire('keydown', 'Enter', 1010); // held: no keyup
    expect(stack(), 'precondition: the press opened the heal frame').toEqual(HEAL_STACK);
    fire('keydown', 'Enter', 1040, { init: { repeat: true } });
    fire('keydown', 'Enter', 1070, { init: { repeat: true } });
    for (const t of [1100, 1360, 1460, 1700]) frame(t);
    expect(healArgs(), 'the held Enter heals nothing').toEqual([]);
    expect(stack(), 'and the frame stays open').toEqual(HEAL_STACK);

    fire('keyup', 'Enter', 1800);
    tapKey('Enter', 1900);
    expect(healArgs(), 'control: a fresh A on Yes heals').toEqual([{ locationId: 9 }]);
  });

  it('CTL10A-1-BOOT-IN-FRAME: A on an open heal frame, with the healer still faced, confirms that frame once and never re-opens or re-binds it; A at a battle base with an NPC faced sends no talk', async () => {
    // WRONG IMPL KILLED: a world interact that also runs above the base (A on the heal frame would
    // re-bind it to the location the rule names now, or re-open it, instead of answering Yes), and
    // one that runs at a battle base (a talk sent from inside a fight).
    await bootReady();
    useRule(pick(['heal', '9']));
    healLocation(7, 1, 1);
    healLocation(9, 3, 6);
    placeNpc(NPC_ENTITY, 'guide', 3, 6, { kind: 'dialogue' }, 1000);
    server(1000, { x: 2, y: 6, ack: 0 });
    frame(1005);
    tapKey('Enter', 1010);
    expect(stack(), 'precondition: A opened the heal frame').toEqual(HEAL_STACK);
    expect(healListIds()).toEqual(['9']);

    // The rule now names the OTHER location, under a fresh batch.
    useRule(pick(['heal', '7']));
    settle(1020);
    frame(1030);
    tapKey('Enter', 1040);
    expect(healArgs(), 'A confirmed the open frame`s own location, once').toEqual([
      { locationId: 9 },
    ]);
    expect(healListIds(), 'the frame was not re-bound').toEqual(['9']);
    expect(stack(), 'nor re-opened').toEqual(HEAL_STACK);

    tapKey('Escape', 1100);
    expect(stack(), 'precondition: Start closed the heal frame').toEqual(WORLD_ONLY);

    // A battle base with the guide named by the rule.
    useRule(pick(['npc', '11']));
    startBattle(BATTLE_ID, 1200);
    frame(1210);
    expect(stack()[0], 'precondition: the base is the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    tapKey('Enter', 1220);
    expect(talkCalls(), 'A at a battle base sends no talk').toBe(0);

    endBattle(BATTLE_ID, 1300);
    frame(1310);
    tapKey('Enter', 1320);
    expect(talkArgs(), 'control: at the world the same A talks').toEqual([
      { npcEntityId: NPC_ENTITY },
    ]);
  });

  it('CTL10A-1-BOOT-MEMO: the wasm rule is called once per change of batch, position or facing: five quiet frames make one call, A and Y reuse it, a facing-only turn makes one more, and every applied batch makes one more', async () => {
    // WRONG IMPL KILLED: a call per frame (the spec forbids it), a call per press (A and Y must
    // reuse the frame's answer), a memo keyed on position only (a turn in place would keep a stale
    // candidate list: the chip would name what the character no longer faces), a memo keyed on the
    // AUTHORITATIVE facing (the turn below is predicted, not yet acked), and a memo with no batch in
    // its key (a batch that changes the world around a standing character would not be seen).
    await bootReady();
    useRule(facedTileRule);
    seedWorld(1000);
    const calls = (): number => H.interactCalls.length;
    for (const t of [1010, 1020, 1030, 1040, 1050]) frame(t);
    expect(calls(), 'five frames with nothing changed: one call').toBe(1);

    tapKey('Enter', 1060);
    expect(talkCalls(), 'precondition: A acted on the memoised candidate').toBe(1);
    tapKey('KeyF', 1070);
    frame(1075);
    expect(chipOptions(), 'precondition: Y opened the guide`s sheet').toHaveLength(1);
    tapKey('Backspace', 1080);
    frame(1085);
    expect(calls(), 'A, Y and the frames after them reuse the memo').toBe(1);

    // A facing-only change: North is blocked, so W turns the character and moves nothing.
    H.blocked.add('2,5');
    tapKey('KeyW', 1100);
    expect(dirs(), 'precondition: the turn was sent as a step').toEqual(['North']);
    for (const t of [1110, 1120, 1130]) frame(t);
    expect(calls(), 'the predicted facing changed, the position did not: one more call').toBe(2);
    expect(H.interactCalls.at(-1)?.slice(0, 3), 'asked about the same tile, facing North').toEqual([
      2, 6, 0,
    ]);

    // A batch that acks the turn (the row still faces East): one more call.
    settle(1200);
    frame(1210);
    frame(1220);
    expect(calls(), 'an applied batch: one more call').toBe(3);
    // A batch that changes nothing the character can see: still one more call.
    settle(1300);
    frame(1310);
    frame(1320);
    expect(calls(), 'every applied batch: one more call').toBe(4);
    expect(H.interactCalls.at(-1)?.slice(0, 4)).toEqual([2, 6, 2, 0]);
  });

  it('CTL10A-1-BOOT-SHEET-LIFETIME: a picker left open closes when a frame pushes (KeyB opens the Box) and never comes back when the Box closes; movement works after', async () => {
    // WRONG IMPL KILLED: a picker that survives under the Box (and reappears over the world when the
    // Box closes, eating the next A), one that keeps the D-pad after the push (the world stays dead),
    // and an accelerator swallowed by the picker (KeyB would not open the Box).
    await bootReady();
    useRule(pick(['npc', '11'], ['heal', '9']));
    healLocation(9, 2, 5);
    seedWorld(1000);
    frame(1005);
    tapKey('Enter', 1010);
    frame(1015);
    expect(chipOptions(), 'precondition: the picker is open').toHaveLength(2);

    tapKey('KeyB', 1020);
    expect(boxShown(), 'the accelerator under the picker opens the Box').toBe(true);
    expect(stack()).toEqual([{ kind: 'world' }, { kind: 'screen', id: 'boxView' }]);
    frame(1030);
    expect(promptShown(), 'no picker and no chip over the Box').toBe(false);

    tapKey('KeyB', 1040);
    expect(boxShown(), 'precondition: the Box closed').toBe(false);
    expect(stack()).toEqual(WORLD_ONLY);
    frame(1050);
    expect(chipOptions(), 'the picker never comes back').toEqual([]);
    expect(chipText(), 'the chip is the plain choose prompt again').toBe(
      `[Enter] Choose${ELLIPSIS}`,
    );
    tapKey('KeyW', 1060);
    expect(dirs(), 'movement works after').toEqual(['North']);
  });

  it('CTL10A-1-BOOT-PREDICTED: the rule is asked about the PREDICTED position and facing (what is drawn), not the authoritative row, with the zone from the row', async () => {
    // WRONG IMPL KILLED: candidates read from the authoritative row (it still faces the guide, so A
    // would talk to an NPC the player sees behind them until the server acks the step).
    await bootReady();
    useRule(facedTileRule);
    seedWorld(1000); // the authoritative row: (2, 6) facing East, the guide on the faced tile
    frame(1005);
    expect(H.interactCalls.at(-1)?.slice(0, 4), 'precondition: asked about the row').toEqual([
      2, 6, 2, 0,
    ]);
    tapKey('KeyS', 1010);
    expect(dirs(), 'precondition: one step South').toEqual(['South']);
    frame(1020); // the predictor draws (2, 7) facing South; no batch has acked it
    expect(
      H.interactCalls.at(-1)?.slice(0, 4),
      'asked about the predicted tile and facing (South is 1)',
    ).toEqual([2, 7, 1, 0]);
    tapKey('Enter', 1030);
    expect(talkCalls(), 'facing away from the guide, as drawn: A talks to nobody').toBe(0);
  });

  it('CTL10A-2-BOOT-Y: Y with one NPC candidate opens its one-row action sheet in the chip and sends nothing; A runs the row (talk) and closes the sheet; with two candidates Y opens only the PRIMARY (first) candidate`s sheet', async () => {
    // WRONG IMPL KILLED: Y doing nothing (today), Y acting at once instead of opening the sheet, a
    // sheet that is the picker of every candidate instead of the primary candidate's actions, a
    // sheet of the last candidate, and a sheet that stays open after its row ran.
    await bootReady();
    useRule(pick(['npc', '11']));
    seedWorld(1000);
    frame(1005);
    tapKey('KeyF', 1010);
    frame(1015);
    expect(chipRowTexts(), 'the guide`s sheet: Talk').toEqual([`Talk ${EM_DASH} guide`]);
    expect(chipOptions()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(H.calls, 'Y sends nothing').toEqual([]);
    expect(H.sends, 'and walks nowhere').toHaveLength(0);

    tapKey('Enter', 1020);
    expect(talkArgs(), 'A on the row talks').toEqual([{ npcEntityId: NPC_ENTITY }]);
    frame(1025);
    expect(chipOptions(), 'the sheet closed after running its row').toEqual([]);

    // Two candidates: the heal location first.
    useRule(pick(['heal', '9'], ['npc', '11']));
    healLocation(9, 2, 5);
    settle(1030);
    frame(1035);
    tapKey('KeyF', 1040);
    frame(1045);
    expect(chipRowTexts(), 'only the primary candidate`s actions').toEqual([
      `Heal ${EM_DASH} Healer`,
    ]);
    tapKey('Enter', 1050);
    expect(stack(), 'its row opens the heal frame').toEqual(HEAL_STACK);
    expect(healListIds()).toEqual(['9']);
    expect(talkArgs(), 'no second talk').toEqual([{ npcEntityId: NPC_ENTITY }]);
  });

  it('CTL10A-3-BOOT-T-NOOP: KeyT does nothing at all, with an NPC or a heal location faced: no reducer, no frame, the stack stays [world], no toast; A in the same state does act', async () => {
    // WRONG IMPL KILLED (B6, RED today): the legacy KeyT interact (it talks whenever no overlay is
    // visible), a KeyT left as an alias of A, and a KeyT that opens the heal frame.
    await bootReady();
    useRule(pick(['npc', '11']));
    seedWorld(1000);
    frame(1005);
    fire('keydown', 'KeyT', 1010);
    fire('keyup', 'KeyT', 1015);
    expect(H.calls, 'T sends nothing').toEqual([]);
    expect(stack(), 'and pushes nothing').toEqual(WORLD_ONLY);
    expect(statusLine(), 'and says nothing').toBe('');
    frame(1020);
    expect(chipOptions(), 'T opens no sheet').toEqual([]);
    tapKey('Enter', 1030);
    expect(talkArgs(), 'control: A talks to the same candidate').toEqual([
      { npcEntityId: NPC_ENTITY },
    ]);

    useRule(pick(['heal', '9']));
    healLocation(9, 2, 5);
    settle(1040);
    frame(1050);
    fire('keydown', 'KeyT', 1060);
    fire('keyup', 'KeyT', 1065);
    expect(healShown(), 'T opens no heal frame').toBe(false);
    expect(stack()).toEqual(WORLD_ONLY);
    expect(H.calls, 'T sends nothing').toEqual(['talk']);
    tapKey('Enter', 1070);
    expect(stack(), 'control: A opens the heal frame').toEqual(HEAL_STACK);
  });

  it('CTL10A-3-BOOT-CHIP-TEXT: the chip reads exactly "[Enter] {verb} — {name}" (Talk / Shop / Heal; the npcId, or Healer for a heal location) for one actionable candidate, "[Enter] Choose…" for two, counts only actionable candidates, and is hidden over a battle base and while a frame is open', async () => {
    // WRONG IMPL KILLED: today's "Talk [T]" glyph chip, a keycap that is not the live A binding's
    // catalog name, the verb and name swapped, a heal location named by its id, a heal NPC called
    // Healer, a Choose chip for one actionable candidate plus a player (players have no action until
    // ctl-10b), a chip shown over a battle base, and a chip left over an open frame.
    await bootReady();
    useRule(pick(['npc', '11']));
    seedWorld(1000);
    frame(1005);
    expect(promptShown(), 'one dialogue NPC: the chip shows').toBe(true);
    expect(chipText()).toBe(`[Enter] Talk ${EM_DASH} guide`);

    const phase = (rule: InteractRule, t: number): void => {
      useRule(rule);
      settle(t);
      frame(t + 5);
    };
    placeNpc(13n, 'keeper', 2, 5, { kind: 'shop', shopId: 3 }, 1010);
    phase(pick(['npc', '13']), 1010);
    expect(chipText(), 'a shop NPC').toBe(`[Enter] Shop ${EM_DASH} keeper`);

    healLocation(9, 1, 6);
    phase(pick(['heal', '9']), 1020);
    expect(chipText(), 'a heal location is the Healer').toBe(`[Enter] Heal ${EM_DASH} Healer`);

    placeNpc(12n, 'nurse', 2, 7, { kind: 'heal', locationId: 9 }, 1030);
    phase(pick(['npc', '12']), 1030);
    expect(chipText(), 'a heal NPC is named by its npcId').toBe(`[Enter] Heal ${EM_DASH} nurse`);

    phase(pick(['npc', '11'], ['heal', '9']), 1040);
    expect(chipText(), 'two actionable candidates').toBe(`[Enter] Choose${ELLIPSIS}`);

    // INTENTIONAL CHANGE (ctl-10b, CTL10B.1): an ONLINE player now offers Trade and Challenge, so a
    // guide plus an online player is Choose (this step expected the single Talk chip); the "a
    // candidate with no action does not count" half is kept with an OFFLINE player.
    placeRival(1, 5, 1050);
    phase(pick(['npc', '11'], ['player', '20']), 1050);
    expect(chipText(), 'a guide and an online player: three actions, Choose').toBe(
      `[Enter] Choose${ELLIPSIS}`,
    );
    placeRival(1, 5, 1055, false);
    phase(pick(['npc', '11'], ['player', '20']), 1055);
    expect(chipText(), 'one actionable candidate and an offline player: still the one').toBe(
      `[Enter] Talk ${EM_DASH} guide`,
    );

    phase(pick(['npc', '11'], ['heal', '9']), 1060);
    expect(chipText(), 'precondition: the choose chip').toBe(`[Enter] Choose${ELLIPSIS}`);
    startBattle(BATTLE_ID, 1070);
    frame(1075);
    expect(promptShown(), 'hidden over a battle base').toBe(false);
    endBattle(BATTLE_ID, 1080);
    frame(1085);
    expect(promptShown(), 'back at the world').toBe(true);

    tapKey('KeyB', 1090);
    frame(1095);
    expect(boxShown(), 'precondition: the Box is open').toBe(true);
    expect(promptShown(), 'hidden while a frame is open').toBe(false);
    tapKey('KeyB', 1100);
    frame(1105);
    expect(promptShown(), 'shown again when it closes').toBe(true);
    expect(chipText()).toBe(`[Enter] Choose${ELLIPSIS}`);
  });

  // ---------------------------------------------------------------------------------------------
  // ctl-10a round 2: kill tests for CI-clean bypasses the code red-team measured.
  // ---------------------------------------------------------------------------------------------

  it('CTL10A-1-BOOT-ERROR-SURFACED: a wasm rule that throws is reported once on console.error as "[interact] candidates error" over three frames, never crashes a frame, and leaves A with nothing to do', async () => {
    // WRONG IMPL KILLED (red-team, CI-clean): main.ts dropping resolveCandidates' onError argument
    // (a real wasm Err, an unparseable id or an unknown kind, becomes a silently dead A), and a
    // report repeated on every frame (the memo keeps one answer per key).
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await bootReady();
      H.interact = () => {
        throw new Error('malformed entity');
      };
      seedWorld(1000);
      for (const t of [1005, 1020, 1040]) frame(t); // frame() fails if a frame did not re-arm
      const hits = errors.mock.calls.filter((call) => call[0] === '[interact] candidates error');
      expect(hits, 'the throw is reported exactly once').toHaveLength(1);
      expect(H.interactCalls.length, 'precondition: the rule was asked').toBeGreaterThan(0);
      tapKey('Enter', 1060);
      expect(H.calls, 'A has nothing to act on').toEqual([]);
      expect(stack()).toEqual(WORLD_ONLY);
      frame(1080);
      expect(promptShown(), 'and no chip').toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('CTL10A-1-BOOT-HELD-REPEAT-DEFAULT: after a fresh Enter acted at the world (opened the heal frame, or talked), the OS repeats of that held Enter are default-prevented', async () => {
    // WRONG IMPL KILLED (red-team, CI-clean): a world A that is consumed without recording its
    // key as a held nav key, so the browser's default for each repeat runs: the native buttons of
    // the frame A just opened (the heal Yes / No, a dialogue choice the talk opens) are clicked by
    // a held Enter the player never meant as a second press.
    await bootReady();
    useRule(pick(['heal', '9']));
    healLocation(9, 3, 6);
    server(1000, { x: 2, y: 6, ack: 0 });
    frame(1005);
    fire('keydown', 'Enter', 1010); // held
    expect(stack(), 'precondition: A opened the heal frame').toEqual(HEAL_STACK);
    const healRepeat = fire('keydown', 'Enter', 1040, { init: { repeat: true } });
    expect(healRepeat.defaultPrevented, 'heal: the held Enter`s repeat is prevented').toBe(true);
    fire('keyup', 'Enter', 1050);
    tapKey('Escape', 1060);
    expect(stack(), 'precondition: Start closed the heal frame').toEqual(WORLD_ONLY);

    placeNpc(NPC_ENTITY, 'guide', 3, 6, { kind: 'dialogue' }, 1100);
    useRule(pick(['npc', '11']));
    settle(1100);
    frame(1110);
    fire('keydown', 'Enter', 1120); // held
    expect(talkArgs(), 'precondition: A talked').toEqual([{ npcEntityId: NPC_ENTITY }]);
    const talkRepeat = fire('keydown', 'Enter', 1150, { init: { repeat: true } });
    expect(talkRepeat.defaultPrevented, 'talk: the held Enter`s repeat is prevented').toBe(true);
    expect(talkArgs(), 'and it talks no second time').toEqual([{ npcEntityId: NPC_ENTITY }]);
    fire('keyup', 'Enter', 1160);
  });

  it('CTL10A-1-BOOT-SHEET-BATTLE: a picker open when a battle row arrives is gone over the battle base (chip hidden, no rows) and does not come back when the battle ends: A with one candidate then talks at once', async () => {
    // WRONG IMPL KILLED (red-team, CI-clean): a sheet closed only on a frame push (a battle is a
    // base change, no push), so the picker paints over the fight or reappears over the world
    // afterwards and eats the next A.
    await bootReady();
    useRule(pick(['npc', '11'], ['heal', '9']));
    healLocation(9, 2, 5);
    seedWorld(1000);
    frame(1005);
    tapKey('Enter', 1010);
    frame(1015);
    expect(chipOptions(), 'precondition: the picker is open').toHaveLength(2);

    startBattle(BATTLE_ID, 1200);
    frame(1210);
    expect(stack()[0], 'precondition: the base is the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    expect(promptShown(), 'no picker or chip over the battle').toBe(false);
    expect(chipOptions(), 'no rows over the battle').toEqual([]);

    endBattle(BATTLE_ID, 1300);
    frame(1310);
    expect(chipOptions(), 'the picker does not come back after the battle').toEqual([]);

    useRule(pick(['npc', '11']));
    settle(1320);
    frame(1330);
    expect(chipOptions(), 'still no sheet').toEqual([]);
    tapKey('Enter', 1340);
    expect(talkArgs(), 'A with one candidate talks at once: no stale sheet ate it').toEqual([
      { npcEntityId: NPC_ENTITY },
    ]);
  });

  it('CTL10A-3-BOOT-CHIP-ANCHOR: the chip hangs over its candidate (tile-centre x, tile-top y): the single candidate, the FIRST actionable candidate for Choose (a player before it is skipped), and the open picker`s first entry wherever its cursor is', async () => {
    // WRONG IMPL KILLED (red-team, CI-clean): a chip positioned on the character, on the first
    // candidate whatever its actions (a player), on the last one, or on the picker row under the
    // cursor; and a chip that keeps the previous candidate's position after the candidates change.
    const TILE = 32; // render/config.ts TILE_PX, transcribed
    const at = (tileX: number, tileY: number): [string, string] => [
      `${(tileX + 0.5) * TILE}px`,
      `${tileY * TILE}px`,
    ];
    const chipAt = (): [string, string] => [chip().style.left, chip().style.top];
    await bootReady();
    useRule(pick(['npc', '11']));
    seedWorld(1000); // the guide at (3, 6)
    frame(1005);
    expect(promptShown(), 'precondition: the single chip shows').toBe(true);
    expect(chipAt(), 'single: over the guide').toEqual(at(3, 6));

    // ctl-10b (named intentional change): the skipped first candidate is an OFFLINE player (an online
    // one now offers Trade and Challenge and would be the first actionable candidate).
    placeRival(1, 1, 1010, false);
    healLocation(9, 5, 2);
    useRule(pick(['player', '20'], ['heal', '9'], ['npc', '11']));
    settle(1010);
    frame(1015);
    expect(chipText(), 'precondition: the choose chip').toBe(`[Enter] Choose${ELLIPSIS}`);
    expect(chipAt(), 'Choose: over the first ACTIONABLE candidate (the heal location)').toEqual(
      at(5, 2),
    );

    tapKey('Enter', 1020);
    frame(1025);
    expect(chipOptions(), 'precondition: the picker is open').toHaveLength(2);
    expect(chipAt(), 'the picker: over its first entry').toEqual(at(5, 2));
    tapKey('ArrowDown', 1030);
    frame(1035);
    expect(
      chipOptions().map((row) => row.getAttribute('aria-selected')),
      'precondition: the cursor is on the guide`s row',
    ).toEqual(['false', 'true']);
    expect(chipAt(), 'still over the first entry, not the cursor row').toEqual(at(5, 2));
  });

  it('CTL10A-1-BOOT-SHEET-HELD-CLEAR: a direction held when A opens the picker never walks while it is open nor after B closes it, until it is pressed afresh', async () => {
    // WRONG IMPL KILLED (red-team, CI-clean): a sheet open that does not clear the held keys (the
    // sheet is not a frame, so no push edge clears them): the D held from before the picker walks
    // the moment B closes it, although the player never pressed it again.
    await bootReady();
    useRule(() => []);
    server(1000, { x: 2, y: 6, ack: 0 }); // nothing faced
    fire('keydown', 'KeyD', 1010); // held: no keyup
    expect(dirs(), 'precondition: the press stepped East').toEqual(['East']);
    frame(1015); // the predictor draws (3, 6)

    placeNpc(NPC_ENTITY, 'guide', 4, 6, { kind: 'dialogue' }, 1020);
    healLocation(9, 3, 5);
    useRule(pick(['npc', '11'], ['heal', '9']));
    server(1020, { x: 3, y: 6, ack: 1 }); // the step acked where it was drawn: nothing owed
    tapKey('Enter', 1030);
    frame(1035);
    expect(chipOptions(), 'precondition: A opened the picker').toHaveLength(2);
    for (const t of [1300, 1500, 1700]) frame(t);
    expect(H.sends.length, 'nothing walks while the picker is open').toBe(1);

    tapKey('Backspace', 1800);
    frame(1805);
    expect(chipOptions(), 'precondition: B closed the picker').toEqual([]);
    for (const t of [1900, 2100, 2300]) frame(t);
    expect(H.sends.length, 'the D held since before the picker does not resume').toBe(1);

    fire('keyup', 'KeyD', 2400);
    fire('keydown', 'KeyD', 2410);
    expect(dirs(), 'control: a fresh D press walks').toEqual(['East', 'East']);
  });

  it('CTL10A-1-BOOT-SHEET-NAME: the open picker`s listbox is named exactly "[Enter] Choose…"', async () => {
    // WRONG IMPL KILLED (red-team, CI-clean): an unnamed sheet listbox (a screen reader announces a
    // bare "list"), or one named by a literal that ignores the live A keycap.
    await bootReady();
    useRule(pick(['npc', '11'], ['heal', '9']));
    healLocation(9, 2, 5);
    seedWorld(1000);
    frame(1005);
    tapKey('Enter', 1010);
    frame(1015);
    const listbox = chip().querySelector('[role="listbox"]');
    expect(listbox, 'precondition: the picker is open').not.toBeNull();
    expect(listbox?.getAttribute('aria-label')).toBe(`[Enter] Choose${ELLIPSIS}`);
  });
});

// ==========================================================================================
// ctl-10b: face-to-face trade and challenge; O retired (CTL10B.1-2)
// ==========================================================================================
//
// Same harness, one fresh main.ts per case. TWO other online players stand about, each with a
// character row, and the stubbed wasm rule names the SECOND one (the faced player): a build that
// takes "the first other player" (store order, or the first in the picker's entity list) acts on
// the wrong identity and is caught by the reducer argument and the pre-selected target. The faced
// player offers Trade then Challenge (the picker rows `Trade — <name>`, `Challenge — <name>`).
// A on Trade opens the trade wizard on Offer with that player pre-selected and its select
// disabled; A on Challenge opens a Yes / No confirm (Yes selected), and only A on Yes sends
// `challengePvp` once.

const FACED_IDENTITY = 'fe'.repeat(32);
const FACED_ENTITY = 21n;
const FACED_NAME = 'Zed';

/** The hex of an SDK Identity (or the string itself). */
function identityHex(identity: unknown): string {
  const withHex = identity as { toHexString?: () => string };
  return typeof withHex.toHexString === 'function' ? withHex.toHexString() : String(identity);
}

/** One own monster in the party slot `slot`: a challenge sends the party ids. */
function partyMonster(monsterId: bigint, slot: number): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 20,
    statHp: 20,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot: slot,
    tier: 0,
    essence: {} as StoreMonsterPub['essence'],
    trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

/** Boot with the own character at (2, 6) facing East, a FIRST rival (entity 20) at (1, 5), the FACED
 *  player (entity 21, the second) on the faced tile (3, 6), one party monster, and a rule that names
 *  only the faced player. One frame has run. */
async function bootFacingTheSecondPlayer(): Promise<void> {
  await bootReady();
  useRule(pick(['player', FACED_ENTITY.toString()]));
  server(1000, { x: 2, y: 6, ack: 0 });
  placeRival(1, 5, 1005);
  placePlayer(FACED_IDENTITY, FACED_ENTITY, FACED_NAME, 3, 6, 1005);
  opts.store.upsertMonster(partyMonster(61n, 0));
  settle(1010);
  frame(1015);
}

const challengeCalls = (): Array<{ name: string; args: unknown }> =>
  H.callArgs.filter((c) => c.name === 'challengePvp');
const selectedFlags = (): Array<string | null> =>
  chipOptions().map((row) => row.getAttribute('aria-selected'));
const CHALLENGE_PROMPT = `Challenge ${FACED_NAME}?`;

describe('main.ts face-to-face trade and challenge; O retired (runtime, ctl-10b)', {
  sequential: true,
}, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.sessionState = 'hidden';
    rafCallback = null;
    document.body.replaceChildren();
  });

  it('CTL10B-1-BOOT-TRADE: with two other online players and the SECOND one faced, A opens the picker (Trade, Challenge for that player), A on Trade opens the trade wizard on Offer with the faced player (not the first) pre-selected and the select disabled, focus inside the Offer list, and nothing is sent', async () => {
    // WRONG IMPL KILLED: openPropose(first other player) (the pre-selected target and the wizard's
    // counterparty would be the first rival, not the faced one), a Trade row that opens the wizard
    // with no target (the select is the placeholder, a Target step), a pre-selected but ENABLED
    // select (the mouse or Tab could retarget it), a Trade that sends proposeTrade at once, a
    // wizard opened on the Target step or with a five-step header, focus left on the world or on
    // the select (the D-pad would never reach the Offer list), a player that offers Challenge
    // before Trade, and a picker that does not list the faced player's two actions.
    await bootFacingTheSecondPlayer();
    expect(chipText(), 'precondition: the faced player offers two actions: Choose').toBe(
      `[Enter] Choose${ELLIPSIS}`,
    );
    const wire = H.interactCalls.at(-1)?.[4] as WireEntity[] | undefined;
    expect(
      wire?.filter((e) => e.kind === 'player').map((e) => e.id),
      'precondition: both other players are marshalled',
    ).toEqual(expect.arrayContaining(['20', '21']));

    tapKey('Enter', 1020);
    frame(1025);
    expect(chipRowTexts(), 'A: the picker lists Trade then Challenge for the faced player').toEqual(
      [`Trade ${EM_DASH} ${FACED_NAME}`, `Challenge ${EM_DASH} ${FACED_NAME}`],
    );
    expect(selectedFlags(), 'the cursor is on Trade').toEqual(['true', 'false']);
    expect(H.calls, 'opening the picker sends nothing').toEqual([]);
    expect(shownById('tradepropose-overlay'), 'and opens no wizard yet').toBe(false);

    tapKey('Enter', 1030); // A on Trade
    expect(shownById('tradepropose-overlay'), 'A on Trade opens the wizard').toBe(true);
    expect(stack(), 'as one frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'tradeProposeView' },
    ]);
    const select = rootOf('tradepropose-target') as HTMLSelectElement;
    expect(select.value, 'the FACED player is pre-selected, not the first rival').toBe(
      FACED_IDENTITY,
    );
    expect(select.value, 'precondition: and that is not the first rival').not.toBe(RIVAL_IDENTITY);
    expect(select.disabled, 'the select is locked: no retarget').toBe(true);
    const steps = [
      ...rootOf('tradepropose-overlay').querySelectorAll<HTMLElement>(
        '[data-testid="tradepropose-steps"] li',
      ),
    ];
    expect(
      steps.map((li) => li.getAttribute('data-step')),
      'no Target step',
    ).toEqual(['offer', 'coins', 'ask', 'review']);
    expect(
      steps.filter((li) => li.getAttribute('aria-current') === 'step').map((li) => li.dataset.step),
      'the wizard is on Offer',
    ).toEqual(['offer']);

    await flush(); // the overlay's deferred initial focus runs
    const list = rootOf('tradepropose-monsters');
    expect(list.contains(document.activeElement), 'focus is inside the Offer list').toBe(true);
    expect(document.activeElement, 'and not on the select').not.toBe(select);
    expect(H.calls, 'nothing was sent').toEqual([]);
  });

  it('CTL10B-1-BOOT-CHALLENGE-YES: A on the Challenge row opens a confirm (prompt "Challenge Zed?", rows Yes and No, Yes selected) and sends nothing; A on Yes sends challengePvp exactly once with the FACED (second) player and the party ids; a held Enter repeat sends no second challenge', async () => {
    // WRONG IMPL KILLED: a Challenge row that sends challengePvp at once (no confirm), a confirm whose
    // cursor starts on No (Yes is the default), a challenge sent to the first rival or with no
    // target / no party, a Yes that sends twice (two A edges for one press, or an OS key-repeat of
    // the held Enter), a sheet that stays open after the send, and a confirm that names no player
    // (the prompt must carry the faced player's name).
    await bootFacingTheSecondPlayer();
    tapKey('Enter', 1020);
    frame(1025);
    expect(chipRowTexts(), 'precondition: the picker is open').toHaveLength(2);
    tapKey('ArrowDown', 1030);
    frame(1035);
    expect(selectedFlags(), 'precondition: the cursor is on Challenge').toEqual(['false', 'true']);

    tapKey('Enter', 1040); // A on Challenge: the confirm, no send
    frame(1045);
    expect(H.calls, 'A on Challenge sends nothing: the confirm comes first').toEqual([]);
    expect(chipText(), 'the confirm names the faced player').toContain(CHALLENGE_PROMPT);
    expect(chipRowTexts(), 'the confirm rows are Yes and No').toEqual(['Yes', 'No']);
    expect(selectedFlags(), 'Yes is selected').toEqual(['true', 'false']);
    expect(
      chip().querySelector('[role="listbox"]')?.getAttribute('aria-label'),
      'the listbox is named by the prompt',
    ).toBe(CHALLENGE_PROMPT);
    expect(stack(), 'the confirm is the chip, not a frame').toEqual(WORLD_ONLY);

    fire('keydown', 'Enter', 1050); // A on Yes, held
    expect(challengeCalls(), 'A on Yes sends exactly one challenge').toHaveLength(1);
    const args = challengeCalls()[0]?.args as { target: unknown; partyIds: bigint[] };
    expect(identityHex(args.target), 'to the FACED player, not the first rival').toBe(
      FACED_IDENTITY,
    );
    expect(args.partyIds, 'with the party').toEqual([61n]);
    expect(H.calls, 'and nothing else was sent').toEqual(['challengePvp']);
    fire('keydown', 'Enter', 1080, { init: { repeat: true } }); // the OS repeats the held key
    fire('keydown', 'Enter', 1110, { init: { repeat: true } });
    fire('keyup', 'Enter', 1120);
    expect(challengeCalls(), 'a held Enter sends no second challenge').toHaveLength(1);
    frame(1130);
    expect(chipOptions(), 'the confirm is closed after the send').toEqual([]);
    expect(stack()).toEqual(WORLD_ONLY);
    expect(shownById('tradepropose-overlay'), 'no wizard opened').toBe(false);
  });

  it('CTL10B-1-BOOT-CHALLENGE-NO: in the confirm Down moves to No and A on No returns to the picker rows with nothing sent; B in the confirm also returns to the rows (Yes selected again on re-entry); B on the rows closes the picker; no challenge is ever sent', async () => {
    // WRONG IMPL KILLED: a No that sends (or that closes the whole picker instead of returning to
    // the rows), a B in the confirm that closes everything or sends, a confirm that does not reset
    // to Yes on re-entry (a stale No cursor makes the next A a silent cancel), a Down that does
    // not move the confirm cursor, and a B on the rows that leaves the picker open.
    await bootFacingTheSecondPlayer();
    tapKey('Enter', 1020);
    tapKey('ArrowDown', 1030);
    tapKey('Enter', 1040); // the confirm
    frame(1045);
    expect(chipRowTexts(), 'precondition: the confirm is shown').toEqual(['Yes', 'No']);
    expect(selectedFlags(), 'precondition: Yes selected').toEqual(['true', 'false']);

    tapKey('ArrowDown', 1050);
    frame(1055);
    expect(selectedFlags(), 'Down moves to No').toEqual(['false', 'true']);
    expect(H.calls, 'moving sends nothing').toEqual([]);
    tapKey('Enter', 1060); // A on No
    frame(1065);
    expect(H.calls, 'A on No sends nothing').toEqual([]);
    expect(chipRowTexts(), 'A on No returns to the picker rows').toEqual([
      `Trade ${EM_DASH} ${FACED_NAME}`,
      `Challenge ${EM_DASH} ${FACED_NAME}`,
    ]);

    tapKey('Enter', 1070); // the row cursor was kept on Challenge: the confirm again
    frame(1075);
    expect(chipRowTexts(), 'the confirm is shown again').toEqual(['Yes', 'No']);
    expect(selectedFlags(), 'with Yes selected again').toEqual(['true', 'false']);
    tapKey('Backspace', 1080); // B in the confirm
    frame(1085);
    expect(H.calls, 'B in the confirm sends nothing').toEqual([]);
    expect(chipRowTexts(), 'B returns to the picker rows').toEqual([
      `Trade ${EM_DASH} ${FACED_NAME}`,
      `Challenge ${EM_DASH} ${FACED_NAME}`,
    ]);

    tapKey('Backspace', 1090); // B on the rows
    frame(1095);
    expect(chipOptions(), 'B on the rows closes the picker').toEqual([]);
    expect(H.calls, 'no reducer was ever called').toEqual([]);
    expect(stack()).toEqual(WORLD_ONLY);
    expect(shownById('tradepropose-overlay'), 'and no wizard opened').toBe(false);
  });

  it('CTL10B-2-BOOT-O-NOOP: KeyO does nothing at a bare world and with a faced online player: no overlay, no frame, no reducer, no picker, and the event is NOT default-prevented', async () => {
    // WRONG IMPL KILLED: the old O handler kept (it opens the wizard for the first other player:
    // openPropose(first other player)), an O block kept but gated on "a player is near", an O that
    // opens nothing but still swallows the key (preventDefault left on), an O that sends a
    // reducer, and an O that opens the picker. The faced player below makes every one of those
    // reachable, so a gate that merely needs a target to be present still fails.
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    frame(1005);
    const bare = fire('keydown', 'KeyO', 1010);
    fire('keyup', 'KeyO', 1015);
    expect(bare.defaultPrevented, 'bare world: O is not prevented').toBe(false);
    expect(shownById('tradepropose-overlay'), 'bare world: no wizard').toBe(false);
    expect(stack(), 'bare world: no frame').toEqual(WORLD_ONLY);
    expect(H.calls, 'bare world: no reducer').toEqual([]);
    expect(H.sends, 'bare world: nothing walks').toHaveLength(0);

    // With a faced online player and a rule naming him, O still does nothing.
    useRule(pick(['player', FACED_ENTITY.toString()]));
    placePlayer(FACED_IDENTITY, FACED_ENTITY, FACED_NAME, 3, 6, 1100);
    settle(1100);
    frame(1105);
    expect(chipText(), 'precondition: the faced player is a candidate').toBe(
      `[Enter] Choose${ELLIPSIS}`,
    );
    const faced = fire('keydown', 'KeyO', 1110);
    fire('keyup', 'KeyO', 1115);
    frame(1120);
    expect(faced.defaultPrevented, 'facing a player: O is not prevented').toBe(false);
    expect(shownById('tradepropose-overlay'), 'facing a player: no wizard').toBe(false);
    expect(stack(), 'facing a player: no frame').toEqual(WORLD_ONLY);
    expect(chipOptions(), 'and no picker').toEqual([]);
    expect(H.calls, 'facing a player: no reducer').toEqual([]);

    // Control: A in the same state does open the picker, so the harness could have opened it.
    tapKey('Enter', 1130);
    frame(1135);
    expect(chipOptions(), 'control: A opens the picker').toHaveLength(2);
  });

  it('CTL10B-1-BOOT-BUSY: a player in a Pending challenge (as challenger OR target, and the own player as challenger) offers only Trade: the chip reads "Trade — <name>" with no Challenge row, A runs it at once; once the challenge is Declined both players offer Trade and Challenge again (Choose)', async () => {
    // WRONG IMPL KILLED: a busy set that is always empty (the target of a Pending challenge is still
    // offered Challenge), challenger only (the target is offered it), target only (the challenger is),
    // one with no Pending filter (a Declined challenge keeps both players busy for good), an inverted
    // filter (only the NON-Pending challenges make players busy, so the Pending pair offers
    // Challenge and the Declined pair does not), and one that leaves the own player out (the own
    // outgoing challenge would not hide Challenge for a third player).
    await bootReady();
    server(1000, { x: 2, y: 6, ack: 0 });
    const P2 = { identity: RIVAL_IDENTITY, entity: RIVAL_ENTITY, name: 'Rival' };
    const P3 = { identity: FACED_IDENTITY, entity: FACED_ENTITY, name: FACED_NAME };
    placePlayer(P2.identity, P2.entity, P2.name, 1, 5, 1000);
    placePlayer(P3.identity, P3.entity, P3.name, 3, 6, 1000);
    const challenge = (id: bigint, challenger: string, target: string, status: string): void =>
      opts.store.upsertChallenge({
        challengeId: id,
        challenger,
        target,
        challengerPartyIds: [],
        status,
        createdAtMs: 0n,
      });
    challenge(1n, P2.identity, P3.identity, 'Pending');
    let t = 1010;
    /** Face `who` under a fresh batch and read the chip after a frame. */
    const faceAndRead = (who: typeof P2): string => {
      useRule(pick(['player', who.entity.toString()]));
      settle(t);
      frame(t + 5);
      t += 20;
      return chipText();
    };
    const tradeOnly = (who: typeof P2): string => `[Enter] Trade ${EM_DASH} ${who.name}`;
    const choose = `[Enter] Choose${ELLIPSIS}`;

    // P3 is the TARGET of the Pending P2 -> P3 challenge: only Trade, so A runs it at once.
    expect(faceAndRead(P3), 'the target of a Pending challenge offers only Trade').toBe(
      tradeOnly(P3),
    );
    tapKey('Enter', t);
    t += 20;
    expect(shownById('tradepropose-overlay'), 'A runs the lone Trade row at once').toBe(true);
    expect(chipOptions(), 'no picker, so no Challenge row').toEqual([]);
    expect(H.calls, 'nothing was sent').toEqual([]);
    tapKey('Escape', t); // Start closes the wizard
    t += 20;
    expect(stack(), 'precondition: the wizard closed').toEqual(WORLD_ONLY);

    // P2 is the CHALLENGER of that challenge: only Trade.
    expect(faceAndRead(P2), 'the challenger of a Pending challenge offers only Trade').toBe(
      tradeOnly(P2),
    );

    // The challenge is Declined: nobody is busy, both offer Trade and Challenge.
    challenge(1n, P2.identity, P3.identity, 'Declined');
    expect(faceAndRead(P3), 'a Declined challenge no longer hides Challenge (target)').toBe(choose);
    expect(faceAndRead(P2), 'nor for the challenger').toBe(choose);

    // The own player is the challenger of a Pending challenge to P2: a third player (P3) offers only
    // Trade, because the own player is busy.
    challenge(2n, H.identity, P2.identity, 'Pending');
    expect(faceAndRead(P3), 'the own player is busy: a third player offers only Trade').toBe(
      tradeOnly(P3),
    );
    expect(faceAndRead(P2), 'the own target of that challenge offers only Trade too').toBe(
      tradeOnly(P2),
    );
  });
});
