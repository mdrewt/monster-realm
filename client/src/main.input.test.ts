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
 * RED TODAY (behaviour deltas of ctl-1): releasing one of two keys of a direction stops the
 * walk, a Ctrl/Alt/Meta chord fires hotkeys and movement and is prevented, a movement key
 * typed into a text field moves the character, and visibilitychange releases nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';

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
});
