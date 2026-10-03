// @vitest-environment happy-dom
/**
 * main.social.test.ts: the Social frame (ctl-8s, CTL8S.3) over the REAL trade, pvp and leaderboard
 * views and the REAL a11y layer (ui/overlayA11y.ts's dialog records, ui/liveRegion.ts's announcer),
 * booted through main.ts. Round 2 of the slice: what the recording stand-ins cannot show, because
 * a stand-in never opens a dialog record, never suspends the dialog beneath it, never moves focus
 * and never shows itself before it renders.
 *
 * - CTL8S-3-ANNOUNCE-SHOWN-PANEL: the frame loop's announcer names the panel the Social frame
 *   shows (U, P and L each alone, and after the adapter switches the panel through its lent view),
 *   and the world region once it closes, with no frame reporting an error meanwhile.
 * - CTL8S-3-PANEL-SWITCH-ORDER: the order of a panel switch, seen through focus and the suspended
 *   (`inert` + `aria-hidden`) attributes: from the menu, a target that throws before it shows, and
 *   the pvp panel, which shows and then renders.
 *
 * Harness: no view is replaced. The real client/index.html shell is mounted, main.ts is imported
 * fresh per boot, and only the wasm pkg, the connection (its options captured), telemetry and the
 * world renderer are stubbed. The screen-adapter table main.ts reads is a mutable copy, so a case
 * puts a stand-in on the `social` frame that records the composite view the open lends it. Keys
 * are real keydown / keyup pairs on the window; frames run on a controlled clock (`frame(at)`
 * stubs `performance.now()` through `clock`). The one real-timer wait is `flush()`, a single
 * zero-delay macrotask: overlayA11y defers each dialog's initial focus by exactly that.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import { t } from './ui/a11yCopy';
import { OVERLAY_A11Y } from './ui/overlayRegistry';
import type { SocialFrameView, SocialPanelId } from './ui/screens/types';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** The screen-adapter table main.ts's host reads: a mutable copy of the real one, re-made by the
   *  module mock below on every fresh import, so a case can swap the Social frame's adapter. */
  adapters: {} as Record<string, unknown>,
}));

// wasm pkg: every name main.ts imports.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: (state: unknown) => state,
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 37,
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

// The connection: capture the options. No reducer is called in this file. sessionState() must be
// 'hidden' or the session gate swallows every key.
vi.mock('./net/connection', () => {
  const stub = {
    conn: undefined,
    live: () => undefined,
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

// The screen-adapter table: the real module with SCREEN_ADAPTERS replaced by a mutable copy of
// itself (nothing changes until a case swaps an entry).
vi.mock('./ui/screens/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/screens/index')>();
  H.adapters = { ...actual.SCREEN_ADAPTERS };
  return { ...actual, SCREEN_ADAPTERS: H.adapters };
});

// The renderer: init appends a focusable canvas to the mount, so main.ts finds its world region.
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

/** Record every listener added to `target`, so the teardown removes main.ts's module-scope ones
 *  (a fresh import per boot would otherwise stack them). */
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

/** Boot a fresh main.ts over the real shell and wait for it to connect. */
async function boot(): Promise<void> {
  H.connectOpts = null;
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

function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

/** Run one frame at clock `at`. Throws if the frame did not re-arm (it re-arms in `finally`). */
function frame(at: number): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = at;
  cb(at);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

/** One zero-delay macrotask: overlayA11y's deferred initial focus fires inside it. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EID = 7n;

/** Deliver one authoritative batch: the own player + character at (2, 6). */
function server(at: number): void {
  clock.t = at;
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
    at,
  );
  opts.store.flushBatch();
}

/** Swap one frame's adapter for this boot; the teardown puts it back. */
function swapAdapter(id: string, adapter: unknown): void {
  const previous = H.adapters[id];
  H.adapters[id] = adapter;
  restorers.push(() => {
    H.adapters[id] = previous;
  });
}

/** A keydown at `at` at the window and its keyup 5 ms later; returns the keydown. */
function press(code: string, at: number): KeyboardEvent {
  clock.t = at;
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  window.dispatchEvent(down);
  clock.t = at + 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
  return down;
}

/** The whole context stack, base first, through the read-only `__game()` DEV hook. */
const stackNow = (): unknown[] =>
  (window as unknown as { __game: () => { stack: unknown[] } }).__game().stack;

/** The main menu's active entry while it is open, else null (the read-only `__game()` hook). */
const menuCursorNow = (): string | null =>
  (window as unknown as { __game: () => { navActive: string | null } }).__game().navActive;

const WORLD_FRAME = { kind: 'world' } as const;
const screenFrame = (id: string): { kind: 'screen'; id: string } => ({ kind: 'screen', id });
const SOCIAL_STACK = [WORLD_FRAME, screenFrame('social')];

interface Pressed {
  readonly button: string;
  readonly repeat: boolean;
}

/** Open the main menu at the world with M and pick Social › `leaf` with the real menu keys (Down
 *  and Enter), walking each level until the entry is active. Returns the clock after the last
 *  press. */
function openSocialLeaf(leaf: 'trades' | 'challenges' | 'rankings', start: number): number {
  press('KeyM', start);
  expect(stackNow(), `${leaf}: precondition: the menu is the one frame`).toEqual([
    WORLD_FRAME,
    screenFrame('menuView'),
  ]);
  let at = start + 10;
  for (let i = 0; i < 8 && menuCursorNow() !== 'social'; i += 1) {
    press('ArrowDown', at);
    at += 10;
  }
  expect(menuCursorNow(), `${leaf}: precondition: the menu cursor is on Social`).toBe('social');
  press('Enter', at);
  at += 10;
  for (let i = 0; i < 4 && menuCursorNow() !== leaf; i += 1) {
    press('ArrowDown', at);
    at += 10;
  }
  expect(menuCursorNow(), `${leaf}: precondition: the sub-list cursor is on ${leaf}`).toBe(leaf);
  press('Enter', at);
  return at + 10;
}

/** Put a stand-in on the `social` frame that records the composite view each paint is lent (the
 *  open seats and paints it, so it is there right after the open), and closes on Start as the
 *  legacy adapter does. */
function lendingSocial(): SocialFrameView[] {
  const lent: SocialFrameView[] = [];
  swapAdapter('social', {
    viewModel: () => undefined,
    init: () => ({}),
    onButton: (_vm: unknown, state: unknown, btn: Pressed) => ({
      state,
      result: btn.button === 'Start' && !btn.repeat ? { kind: 'popToBase' } : 'consumed',
    }),
    paint: (view: unknown) => {
      lent.push(view as SocialFrameView);
    },
  });
  return lent;
}

/** The composite view the last Social open lent its stand-in. */
function lentView(lent: readonly SocialFrameView[]): SocialFrameView {
  const view = lent.at(-1);
  if (view === undefined) throw new Error('precondition: the Social open painted its stand-in');
  return view;
}

/** The three panel roots in the shell, by tab. */
const ROOT_ID = {
  trades: 'trade-overlay',
  challenges: 'pvp-challenge-overlay',
  rankings: 'leaderboard-overlay',
} as const;
const TAB_OF: Readonly<Record<SocialPanelId, keyof typeof ROOT_ID>> = {
  tradeView: 'trades',
  pvpView: 'challenges',
  leaderboardView: 'rankings',
};

function root(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} must be in the shell`);
  return el;
}

/** Which Social roots are on screen (each view shows and hides its root by inline display). */
function shownRoots(): string[] {
  return (Object.keys(ROOT_ID) as Array<keyof typeof ROOT_ID>).filter(
    (tab) => root(ROOT_ID[tab]).style.display !== 'none',
  );
}

/** The suspended-dialog attributes a root carries (overlayA11y's `suspend` sets both). */
const suspendedAttrs = (el: HTMLElement): string[] =>
  ['inert', 'aria-hidden'].filter((name) => el.hasAttribute(name));

describe('main.ts the Social frame over the real panel views and a11y layer (ctl-8s)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8S-3-ANNOUNCE-SHOWN-PANEL: through the frame loop, the live region names the trade dialog when U opens Social, the pvp dialog for P and the leaderboard for L, the pvp then the leaderboard dialog when the adapter switches the shown panel through its lent view, and the world region whenever Social closes; no frame reports an error while it is open', async () => {
    // WRONG IMPL KILLED (three measured round-1 survivors in main.ts's `topOverlay()`): the Social
    // frame announced as its FIRST panel always (P, L and the adapter's switches would all be read
    // out as the trade dialog); as null (nothing names the open dialog: the region stays silent on
    // every open); and as the frame id `social` itself (`OVERLAY_A11Y.social` does not exist, so
    // `announcementsFor` throws on every frame: the region stays silent, every frame logs
    // `[frame] uncaught error`, and the error overlay shows). Also killed: an announcer that names
    // the requested tab instead of the panel shown (the switch to Challenges would be read as
    // Trades).
    await bootReady();
    server(1000);
    const lent = lendingSocial();
    const consoleError = vi.spyOn(console, 'error');
    const frameErrors = (): number =>
      consoleError.mock.calls.filter((call) => call[0] === '[frame] uncaught error').length;
    const errorOverlayDisplay = (): string =>
      document.getElementById('mr-error-overlay')?.style.display ?? 'no error overlay';
    const live = (): string => document.getElementById('a11y-live')?.textContent ?? '';
    // The expected copy, resolved from the registry's label keys (never hand-typed English).
    const named = (panel: SocialPanelId): string => t(OVERLAY_A11Y[panel].labelKey);
    const WORLD = t('a11y.world.region');
    const expected = [named('tradeView'), named('pvpView'), named('leaderboardView'), WORLD];
    expect(new Set(expected).size, 'ANTI-VACUITY: four distinct announcements').toBe(4);

    let at = 2000;
    let settles = 0;
    /** Two frames 600 ms apart (the live region paints a queued message once 500 ms have passed);
     *  returns what the region says afterwards. */
    const settle = (): string => {
      frame(at + 10);
      frame(at + 610);
      at += 1000;
      settles += 1;
      return live();
    };

    // Control: with nothing open the frame loop runs clean and announces none of the four.
    expect(expected, 'control: nothing is announced before any open').not.toContain(settle());
    expect(frameErrors(), 'control: no frame error with nothing open').toBe(0);
    expect(errorOverlayDisplay(), 'control: the error overlay is hidden').toBe('none');

    // U, P and L, each alone: the region names that panel's dialog, then the world on close.
    const keys: ReadonlyArray<readonly [string, SocialPanelId]> = [
      ['KeyU', 'tradeView'],
      ['KeyP', 'pvpView'],
      ['KeyL', 'leaderboardView'],
    ];
    for (const [code, panel] of keys) {
      press(code, at);
      expect(stackNow(), `${code}: precondition: the one Social frame`).toEqual(SOCIAL_STACK);
      expect(shownRoots(), `${code}: precondition: its own root alone`).toEqual([TAB_OF[panel]]);
      expect(settle(), `${code}: the live region names the ${panel} dialog`).toBe(named(panel));
      press(code, at);
      expect(stackNow(), `${code} again: precondition: Social closed`).toEqual([WORLD_FRAME]);
      expect(settle(), `${code} again: closing announces the world region`).toBe(WORLD);
    }

    // The adapter switches the shown panel through its lent view: the region follows it.
    press('KeyU', at);
    expect(settle(), 'switch: precondition: U opened on the trade dialog').toBe(named('tradeView'));
    const view = lentView(lent);
    view.show('pvpView');
    expect(shownRoots(), 'switch: precondition: the pvp root alone').toEqual(['challenges']);
    expect(settle(), 'the switch to Challenges announces the pvp dialog').toBe(named('pvpView'));
    view.show('leaderboardView');
    expect(shownRoots(), 'switch: precondition: the leaderboard root alone').toEqual(['rankings']);
    expect(settle(), 'the switch to Rankings announces the leaderboard').toBe(
      named('leaderboardView'),
    );
    press('Escape', at);
    expect(stackNow(), 'switch: precondition: Start closed Social').toEqual([WORLD_FRAME]);
    expect(settle(), 'closing the switched frame announces the world region').toBe(WORLD);

    expect(frameErrors(), 'no frame reported an error while Social was open').toBe(0);
    expect(errorOverlayDisplay(), 'and the error overlay stayed hidden').toBe('none');
    expect(settles, 'ANTI-VACUITY: eleven settled frame pairs').toBe(11);
  });

  it('CTL8S-3-PANEL-SWITCH-ORDER: over the real views and a11y layer, a switch on Social opened from the menu never sends focus to the menu beneath, leaves one root shown with no inert or aria-hidden left on the hidden one, and keeps the menu suspended until Social closes; a target that throws before it is shown leaves the old panel shown alone, the frame on the stack, and the throw reaching the caller; and the pvp panel, which shows before it renders, ends shown alone with the chrome even when its render throws, the previous panel hidden through its own hide', async () => {
    // WRONG IMPL KILLED, by part.
    // (a) pins current behaviour, killing a measured round-1 survivor: `showSocialPanel` hiding
    //     the other panels BEFORE it shows the target. Closing the top trade dialog first resumes
    //     the menu beneath it, whose list takes focus (`#menu-rows` focusin), and only then does
    //     the pvp dialog open and suspend the menu again: the final DOM is identical, so only the
    //     focus record sees it.
    // (b) pins current behaviour: the same hide-before-show mutant (a target whose model build
    //     throws then leaves NO panel shown, and the next sync pops the Social frame), and a switch
    //     that swallows the throw (the adapter's paint, which the host reports, would never learn
    //     that the switch failed).
    // (c) RED today: `PvpView.refresh` shows its root and THEN renders it, so a render step that
    //     throws escapes `showSocialPanel` after the pvp dialog opened but before the chrome moved
    //     and before the trade panel hid: two dialogs stay displayed, the trade root suspended
    //     under the pvp one. A switch whose target became visible must still finish.

    // --- (a) Social > Trades opened from the menu, then the adapter switches to Challenges -----
    await bootReady();
    server(1000);
    const fromMenu = lendingSocial();
    const end = openSocialLeaf('trades', 1100);
    expect(stackNow(), 'a: precondition: Social above the menu').toEqual([
      WORLD_FRAME,
      screenFrame('menuView'),
      screenFrame('social'),
    ]);
    expect(shownRoots(), 'a: precondition: the trade root').toEqual(['trades']);
    await flush(); // the trade dialog's deferred initial focus: the state a player switches from
    expect(document.activeElement?.id, 'a: precondition: focus is in the trade dialog').toBe(
      'trade-status',
    );
    const menuRoot = root('menu-overlay');
    expect(suspendedAttrs(menuRoot), 'a: precondition: the menu beneath is suspended').toEqual([
      'inert',
      'aria-hidden',
    ]);
    const focusins: string[] = [];
    document.addEventListener(
      'focusin',
      (e) => {
        focusins.push(e.target instanceof Element ? e.target.id : '(not an element)');
      },
      true,
    );
    const viaMenu = lentView(fromMenu);
    viaMenu.show('pvpView');
    await flush(); // the pvp dialog's deferred initial focus
    expect(
      focusins.filter((id) => id === 'menu-rows'),
      'a: focus never visits the menu beneath during the switch',
    ).toEqual([]);
    expect(focusins, 'a: focus moved once, to the pvp dialog`s anchor').toEqual([
      'pvp-challenge-status',
    ]);
    expect(shownRoots(), 'a: exactly one root shown, the pvp one').toEqual(['challenges']);
    expect(
      suspendedAttrs(root('trade-overlay')),
      'a: the hidden trade root keeps no inert or aria-hidden',
    ).toEqual([]);
    expect(
      suspendedAttrs(root('pvp-challenge-overlay')),
      'a: the pvp root is not suspended',
    ).toEqual([]);
    expect(suspendedAttrs(menuRoot), 'a: the menu beneath is still suspended').toEqual([
      'inert',
      'aria-hidden',
    ]);
    expect(
      root('pvp-challenge-overlay').firstElementChild,
      'a: the chrome is in the pvp root',
    ).toBe(viaMenu.chrome);

    // Social closes (P, the shown panel's key): the menu resumes and its list takes focus back.
    press('KeyP', end + 100);
    expect(stackNow(), 'a: precondition: P closed Social, the menu stays').toEqual([
      WORLD_FRAME,
      screenFrame('menuView'),
    ]);
    expect(suspendedAttrs(menuRoot), 'a: once Social closes the menu resumes').toEqual([]);
    expect(
      focusins.at(-1),
      'ANTI-VACUITY: the recorder does see #menu-rows take focus when the menu resumes',
    ).toBe('menu-rows');

    // --- (b) a target that throws BEFORE it is shown (trade and leaderboard render first) -------
    teardownBoot();
    await bootReady();
    server(2000);
    const lent = lendingSocial();
    press('KeyU', 2100);
    expect(stackNow(), 'b: precondition: U opened Social').toEqual(SOCIAL_STACK);
    expect(shownRoots(), 'b: precondition: the trade root').toEqual(['trades']);
    const view = lentView(lent);
    vi.spyOn(opts.store, 'allProfiles').mockImplementationOnce(() => {
      throw new Error('board model boom');
    });
    expect(
      () => view.show('leaderboardView'),
      'b: the leaderboard`s throw reaches the caller of show',
    ).toThrow('board model boom');
    expect(shownRoots(), 'b: the trade root is still shown, alone').toEqual(['trades']);
    expect(view.trades?.visible, 'b: the trade panel was never hidden').toBe(true);
    expect(suspendedAttrs(root('trade-overlay')), 'b: and is still the live dialog').toEqual([]);
    frame(2200); // a sync point
    expect(stackNow(), 'b: the Social frame stays on the stack').toEqual(SOCIAL_STACK);

    view.show('pvpView');
    expect(shownRoots(), 'b, control: a switch that does not throw shows the pvp root').toEqual([
      'challenges',
    ]);
    vi.spyOn(opts.store, 'allTradeOffers').mockImplementationOnce(() => {
      throw new Error('trade model boom');
    });
    expect(() => view.show('tradeView'), 'b: the trade panel`s throw reaches the caller').toThrow(
      'trade model boom',
    );
    expect(shownRoots(), 'b: the pvp root is still shown, alone').toEqual(['challenges']);
    expect(view.challenges?.visible, 'b: the pvp panel was never hidden').toBe(true);
    expect(
      suspendedAttrs(root('pvp-challenge-overlay')),
      'b: and is still the live dialog',
    ).toEqual([]);
    frame(2300);
    expect(stackNow(), 'b: the Social frame stays on the stack').toEqual(SOCIAL_STACK);

    // --- (c) a target that throws AFTER it is shown: the pvp panel shows, then renders ----------
    view.show('tradeView');
    expect(shownRoots(), 'c: precondition: the trade root').toEqual(['trades']);
    const playerList = root('pvp-player-list');
    const listRender = vi.spyOn(playerList, 'replaceChildren').mockImplementationOnce(() => {
      throw new Error('pvp render boom');
    });
    try {
      view.show('pvpView');
    } catch {
      // Whether the failed render still reaches this caller is not this case's question.
    }
    expect(
      listRender,
      'c: precondition: the pvp render reached its throwing step',
    ).toHaveBeenCalled();
    expect(view.challenges?.visible, 'c: precondition: the pvp panel showed before it threw').toBe(
      true,
    );
    expect(shownRoots(), 'c: the pvp root is shown ALONE').toEqual(['challenges']);
    expect(view.trades?.visible, 'c: the trade panel was hidden through its own hide').toBe(false);
    expect(
      suspendedAttrs(root('trade-overlay')),
      'c: the hidden trade root keeps no inert or aria-hidden',
    ).toEqual([]);
    expect(
      suspendedAttrs(root('pvp-challenge-overlay')),
      'c: the pvp root is not suspended',
    ).toEqual([]);
    expect(
      root('pvp-challenge-overlay').firstElementChild,
      'c: the chrome is in the pvp root',
    ).toBe(view.chrome);
    frame(2400); // a sync point
    expect(stackNow(), 'c: still exactly one Social frame').toEqual(SOCIAL_STACK);
  });
});
