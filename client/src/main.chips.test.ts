// @vitest-environment happy-dom
/**
 * main.chips.test.ts: the Start / Select hint-bar chips through a booted main.ts (ctl-7a,
 * CTL7A.4): a chip click presses its button, opening the menu (or help) releases every held key,
 * and the chip labels follow the negotiated locale.
 *
 * The chip markup and its catalog keys are gated in indexShell.smoke.test.ts and
 * ui/i18n/catalog.test.ts; main.a11yFocus.test.ts proves that a click opens the right overlay.
 * This file proves the two behaviours that need a movement harness: the held-key release and the
 * French boot.
 *
 * Harness: main.input.test.ts's pattern, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a
 * controllable rAF, a stubbed wasm pkg and SDK connection, the real client/index.html shell
 * mounted first, a renderer stub that appends a focusable canvas).
 *
 * Positions: the stubbed apply_move steps one tile, North is y - 1. Each case seeds the character
 * at (2, 7) and acks every send with the tile the predictor already holds, so a reconcile never
 * diverges and the only intents sent are the ones the input path issues.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import { CATALOG_FR } from './ui/i18n/catalog.fr';

interface Sent {
  readonly input: { readonly tag: string; readonly value?: { readonly tag: string } };
  readonly seq: bigint;
}

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. Reset by every boot. */
  sends: [] as Sent[],
  /** What the stubbed connection's sessionState() returns; 'hidden' is the ordinary case, any
   *  other value is the session terminal (expired / unreachable). Reset by every boot. */
  session: 'hidden' as string,
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

// The connection: capture the options; enqueueMove never settles, every other reducer resolves.
vi.mock('./net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') {
          return (args: { input: Sent['input']; seq: bigint }) =>
            new Promise<void>(() => {
              H.sends.push({ input: args.input, seq: args.seq });
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
    sessionState: () => H.session,
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

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus.
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

/** Record module-scope listeners so afterEach can detach them; otherwise keydown handlers from
 *  earlier module generations stack up and double-send. */
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

async function boot(url = '/'): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.session = 'hidden';
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  window.history.replaceState(null, '', url);
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

async function bootReady(url = '/'): Promise<void> {
  await boot(url);
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
 *  Only valid for North-only walks: after n sends it stands at (2, startY - n). */
function ackAllNorth(t: number, startY: number): void {
  const n = H.sends.length;
  server(t, { x: 2, y: startY - n, ack: n });
}

/** Dispatch one cancelable, bubbling key event at clock `t` on window (where main.ts listens). */
function fire(type: 'keydown' | 'keyup', code: string, t: number): KeyboardEvent {
  clock.t = t;
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

const shown = (id: string): boolean => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the shell`);
  return el.style.display !== 'none';
};

const Y0 = 7;

/** A chip element from the mounted shell; throws (a named failure) when it is missing. */
function chipEl(chipId: string): HTMLElement {
  const el = document.getElementById(chipId);
  if (el === null) throw new Error(`#${chipId} must exist (client/index.html)`);
  return el;
}

/** Escape is Start: it pops the top overlay back toward the world base. */
function closeWithEscape(t: number): void {
  fire('keydown', 'Escape', t);
  fire('keyup', 'Escape', t + 5);
}

/** Hold W until the continuation is proven live, click `chipId`, close what it opened with
 *  Escape, ack the server, then run frames well past the hold-commit window. Returns the send
 *  count before and after those frames. */
async function holdThenClickChipThenFrames(
  chipId: string,
  overlayId: string,
): Promise<{ readonly before: number; readonly after: number }> {
  await bootReady();
  server(1000, { x: 2, y: Y0, ack: 0 });
  fire('keydown', 'KeyW', 1000);
  expect(
    H.sends.map((s) => s.input.value?.tag),
    'precondition: W stepped North',
  ).toEqual(['North']);
  ackAllNorth(1050, Y0);

  // Control: the hold is live and continues. Without this the post-click silence below could be
  // a hold that never committed in the first place.
  frame(1160);
  expect(H.sends.length, 'control: a committed hold keeps walking').toBeGreaterThan(1);
  ackAllNorth(1200, Y0);

  const chip = document.getElementById(chipId);
  expect(chip, `#${chipId} must exist (client/index.html)`).not.toBeNull();
  (chip as HTMLElement).click();
  expect(shown(overlayId), `the #${chipId} click must open #${overlayId}`).toBe(true);

  // Close it again (Escape is Start: it pops back to the world base).
  fire('keydown', 'Escape', 1210);
  fire('keyup', 'Escape', 1215);
  expect(shown(overlayId), 'Escape closes the overlay the chip opened').toBe(false);

  // The server owes nothing and W was never released by a keyup: a held set that survived the
  // click would walk again on these frames.
  ackAllNorth(1250, Y0);
  const before = H.sends.length;
  frame(1360);
  frame(1500);
  return { before, after: H.sends.length };
}

describe('main.ts Start / Select hint-bar chips (runtime, ctl-7a)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rafCallback = null;
    window.history.replaceState(null, '', '/');
    document.body.replaceChildren();
  });

  it('CTL7A-4-START-CLEARS-HELD: clicking the Start chip opens the menu and releases every held key, so closing it does not resume the walk', async () => {
    // WRONG IMPL KILLED: a chip that opens the menu through a path that skips the existing
    // [data-menu-launcher] branch (the held set survives, and the character walks on by itself
    // the moment the menu closes, because the keyup was never delivered); a chip that does not
    // open the menu at all (the shown() precondition inside the helper).
    const { before, after } = await holdThenClickChipThenFrames('chip-start', 'menu-overlay');
    expect(after, 'no step may be issued after the click released the held key').toBe(before);
  });

  it('CTL7A-4-SELECT-CLEARS-HELD: clicking the Select chip opens help and releases every held key, so closing it does not resume the walk', async () => {
    // WRONG IMPL KILLED: a [data-help-launcher] branch that opens help without clearing the held
    // set (the same stuck-walk defect as the Start chip); a chip that opens the menu instead
    // (the shown('help-overlay') precondition inside the helper).
    const { before, after } = await holdThenClickChipThenFrames('chip-select', 'help-overlay');
    expect(after, 'no step may be issued after the click released the held key').toBe(before);
  });

  it('CTL7A-4-CHIP-FR-AIDE: under fr the Select chip reads the French catalog verb, not the English one', async () => {
    // WRONG IMPL KILLED: chip labels hard-coded in the markup or in main.ts (an English "Help"
    // under fr); labels resolved once before the locale is negotiated; the two keys swapped.
    await bootReady('/?locale=fr');
    expect(document.documentElement.lang, 'precondition: the fr locale was negotiated').toBe('fr');
    const FR = CATALOG_FR as unknown as Record<string, string>;
    expect(FR['chrome.chip.help'], 'fixture: the French verb differs from the English').toBe(
      'Aide',
    );
    const select = document.getElementById('chip-select');
    const start = document.getElementById('chip-start');
    expect(select, '#chip-select must exist (client/index.html)').not.toBeNull();
    expect(start, '#chip-start must exist (client/index.html)').not.toBeNull();
    expect(select?.textContent).toBe('Aide');
    expect(select?.textContent, 'not the English verb').not.toBe('Help');
    expect(start?.textContent).toBe('Menu');
  });

  it('CTL7A-4-CHIPS-SESSION-GATED: while the session terminal shows, neither chip opens its overlay; once it is hidden again the same clicks do', async () => {
    // WRONG IMPL KILLED: a chip branch that opens the menu / help without consulting
    // sessionGateBlocks() (it would open a Start menu over the expired / unreachable terminal);
    // a gate applied to only one of the two chips; a gate that blocks always (the anti-vacuity
    // half: with sessionState 'hidden' the same clicks must open).
    await bootReady();
    server(1000, { x: 2, y: Y0, ack: 0 });
    expect(shown('menu-overlay'), 'precondition: the menu starts closed').toBe(false);
    expect(shown('help-overlay'), 'precondition: help starts closed').toBe(false);

    H.session = 'expired';
    chipEl('chip-start').click();
    expect(shown('menu-overlay'), 'Start chip must not open the menu over the terminal').toBe(
      false,
    );
    chipEl('chip-select').click();
    expect(shown('help-overlay'), 'Select chip must not open help over the terminal').toBe(false);

    // Same boot, terminal gone: the clicks are live again.
    H.session = 'hidden';
    chipEl('chip-select').click();
    expect(shown('help-overlay'), 'anti-vacuity: Select opens help once hidden').toBe(true);
    closeWithEscape(1210);
    expect(shown('help-overlay'), 'Escape closes help').toBe(false);
    chipEl('chip-start').click();
    expect(shown('menu-overlay'), 'anti-vacuity: Start opens the menu once hidden').toBe(true);
  });

  it('CTL7A-4-SELECT-NO-IDENTITY: before the identity is known Select still opens help (like the ? hotkey) while Start does not open the menu', async () => {
    // WRONG IMPL KILLED: a Select branch that copies the Start identity guard (help is static
    // text, the hotkey has no such guard); a Start branch that drops the identity guard (the menu
    // reads store rows keyed by identity, which is '' before the first onReady). The post-onReady
    // clicks prove the pre-identity refusal was the identity, not a dead chip.
    await boot(); // connect() reached, onReady NOT delivered: identity is still ''
    expect(shown('menu-overlay'), 'precondition: the menu starts closed').toBe(false);
    expect(shown('help-overlay'), 'precondition: help starts closed').toBe(false);

    chipEl('chip-start').click();
    expect(shown('menu-overlay'), 'Start must not open the menu before identity').toBe(false);

    chipEl('chip-select').click();
    expect(shown('help-overlay'), 'Select opens help even before identity').toBe(true);

    // Identity arrives; close help the ordinary way; Start now opens the menu.
    opts.onReady(H.identity);
    server(1000, { x: 2, y: Y0, ack: 0 });
    closeWithEscape(1210);
    expect(shown('help-overlay'), 'Escape closes help').toBe(false);
    chipEl('chip-start').click();
    expect(shown('menu-overlay'), 'anti-vacuity: Start opens the menu once identity is known').toBe(
      true,
    );
  });

  it('CTL7A-4-CHIP-TWICE: the Start chip opens the menu again after it was closed', async () => {
    // WRONG IMPL KILLED: a one-shot latch on the chip (a "launched" flag, a { once: true }
    // listener, a handler that removes itself): the first click works and every later one is dead.
    await bootReady();
    server(1000, { x: 2, y: Y0, ack: 0 });
    const start = chipEl('chip-start');
    start.click();
    expect(shown('menu-overlay'), 'first click opens the menu').toBe(true);
    closeWithEscape(1210);
    expect(shown('menu-overlay'), 'Escape closes the menu').toBe(false);
    start.click();
    expect(shown('menu-overlay'), 'second click opens it again').toBe(true);
    closeWithEscape(1300);
    expect(shown('menu-overlay'), 'Escape closes it again').toBe(false);
    start.click();
    expect(shown('menu-overlay'), 'third click opens it again').toBe(true);
  });
});
