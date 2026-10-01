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
import type { StoreBattle, StoreBattleMonster } from './net/store';
import { HOLD_COMMIT_MS } from './prediction/heldKeys';

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
        return () => {
          H.calls.push(String(name));
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

/** Mount the REAL client/index.html shell (minus its module script) into the live document,
 *  so main.ts builds the real overlay views against the real static shells. */
function mountIndexHtmlShell(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  expect(children.length, 'index.html must yield a body to mount').toBeGreaterThan(5);
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
// a real observation rather than an empty one.

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

  it('CTL2-3-BOOT-B17: an Ongoing battle row makes movement dead from the very batch it arrives in, even after Escape hides the battle overlay', async () => {
    // WRONG IMPL KILLED (B17): a gate that is only "no overlay visible" (Escape hides battleView
    // and the character predicts a step the server rejects, then rubber-bands back); a base
    // derived one batch late, or by a listener that runs after the reconcile re-issue (the
    // pullback batch that carries the battle row still sends a step); a prompt computed from
    // the overlay probe instead of the gate (it advertises a target KeyT would refuse); and a
    // base that does not return to the world when the battle row goes.
    await bootReady();
    seedWorld(1000);
    frame(1005);
    expect(promptShown(), 'control: at the world the NPC in range shows the interact prompt').toBe(
      true,
    );
    fire('keydown', 'KeyT', 1006);
    expect(talkCalls(), 'control: KeyT at the world talks to the NPC in range').toBe(1);

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

    // Escape hides the overlay (the battle is still Ongoing: the next batch would re-show it).
    fire('keydown', 'Escape', 1700);
    expect(battleShown(), 'precondition: Escape hid the battle overlay').toBe(false);
    frame(1710);
    expect(stack(), 'the base is still the battle, with nothing above it').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    expect(promptShown(), 'the interact prompt stays hidden over a battle base').toBe(false);
    // KeyT shares the movement gate with the prompt: it must refuse what the prompt hides, and
    // refusing must not disturb the stack.
    fire('keydown', 'KeyT', 1715);
    expect(talkCalls(), 'KeyT over a battle base does not dispatch the interact').toBe(1);
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
    fire('keydown', 'KeyT', 2450);
    expect(talkCalls(), 'control: KeyT talks again once the battle is over').toBe(2);

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
    // own real path: N, O and T (a heal NPC on the player's own tile, which outranks the guide
    // one tile away), I and E, and the claim overlay's privacy button.
    // Not separately observed: privacy's onDismissed effect (it disarms an armed delete
    // confirmation). Arming needs an Active account row plus the frame loop's account pump, and
    // the batch's own export listener repaints the overlay before the reconcile, so no cheap
    // sentinel survives. hide() is onDismissed's ONLY caller, and the aria-modal strip below is
    // written by the same hide(), so it proves the call that carries it.
    // Raising and evolution build their own roots, whose ids this suite does not know: they are
    // checked for visibility and the stack only, not for the a11y strip.
    await bootReady();
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
        name: 'tradeProposeView',
        rootId: 'tradepropose-overlay',
        open: (t) => void fire('keydown', 'KeyO', t),
        shown: () => shownById('tradepropose-overlay'),
      },
      {
        name: 'healView',
        rootId: 'heal-overlay',
        open: (t) => void fire('keydown', 'KeyT', t),
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

  it('CTL3-2-BOOT-OUTCOME-SAME-BATCH: an overlay left up under an Escape-hidden battle is closed by the very batch that turns the row terminal, before any frame runs', async () => {
    // WRONG IMPL KILLED (the reviewer's finding): a reconcile that knows only the battle BASE.
    // When the row turns terminal the base returns to the world and the outcome is about to be
    // shown by a later listener, so with no outcome knowledge the overlay survives this batch
    // (the outcome frame would only appear, and only then drop it, a batch later) and the
    // outcome takes focus over a still-painted overlay.
    await bootReady();
    seedWorld(1000);
    startBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    fire('keydown', 'Escape', 1200);
    expect(battleShown(), 'precondition: Escape hid the Ongoing battle view').toBe(false);
    fire('keydown', 'KeyQ', 1210);
    expect(shownById('quest-log-overlay'), 'precondition: the quest log opened over it').toBe(true);
    expect(stack(), 'precondition: it is a frame over the battle base').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'questLogView' },
    ]);

    // No frame runs between here and the assertions: the batch alone must do it.
    opts.store.upsertBattle(battleRow(BATTLE_ID, 'SideAWins'));
    settle(1300);
    expect(battleShown(), 'the outcome is on screen').toBe(true);
    expect(shownById('quest-log-overlay'), 'the quest log is closed in that same batch').toBe(
      false,
    );
    expect(
      rootOf('quest-log-overlay').getAttribute('aria-modal'),
      'through its own hide()',
    ).toBeNull();
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
