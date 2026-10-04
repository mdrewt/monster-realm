// @vitest-environment happy-dom
/**
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
import { t as i18nT, tf } from './ui/i18n/resolver';

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

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
}
const game = (): { readonly stack: FrameJson[] } =>
  (window as unknown as { __game: () => { stack: FrameJson[] } }).__game();
/** The stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = (): string[] =>
  game().stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

/** The banner as the player sees it: its text when it is on screen, else null. */
const bannerText = (): string | null => {
  const el = document.getElementById('notice-banner');
  return el !== null && isShown(el) ? (el.textContent ?? '') : null;
};
/** The Start chip's badge text, or null when the chip carries none. */
const startBadge = (): string | null =>
  document.querySelector('#chip-start .mr-chip-badge')?.textContent ?? null;
/** Every dialog root a player could see open. */
const openDialogs = (): string[] =>
  [...document.querySelectorAll('[aria-modal="true"]')].filter(isShown).map((el) => el.id);
/** The world sheet's rows, in order, and the one under the cursor. */
const sheetRows = (): string[] =>
  [...document.querySelectorAll('#interact-prompt [role="option"]')].map(
    (el) => el.textContent ?? '',
  );
const sheetCursor = (): string | null =>
  document
    .querySelector('#interact-prompt [role="option"][aria-selected="true"]')
    ?.getAttribute('data-nav-key') ?? null;
const sheetShown = (): boolean => shownById('interact-prompt') && sheetRows().length > 0;
/** The menu's rows as painted. */
const menuRows = (): string[] =>
  [...document.querySelectorAll('#menu-rows [role="option"]')].map((el) => el.textContent ?? '');

describe('main.ts incoming requests as notices (runtime, ctl-13)', { sequential: true }, () => {
  afterEach(teardown);

  it('CTL13-2-BOOT-NO-AUTOOPEN: an incoming challenge (in the first batch or a later one) and an incoming trade open no frame and show no dialog, leave the stack at the bare world, move focus nowhere and send nothing, on the batch and on the frames after it', async () => {
    // LEGACY REPLACED (the Red): an incoming challenge opened Social on Challenges (a dialog over
    // the world, focus moved into it) on the first batch with no overlay up; an incoming trade
    // opened nothing but only because it was never announced at all.
    // WRONG IMPL KILLED: the auto-show left in (`openSocial('challenges')` in the pvp batch
    // listener) for the first batch or a later one; a trade request that opens the trade frame;
    // a banner or badge that takes focus (a focus() on arrival); a request that is answered by
    // itself (a reducer call with no key pressed); and a notice path that only holds back on the
    // first batch (the later-batch and next-frame reads).
    const scenarios: ReadonlyArray<{
      readonly label: string;
      /** The request lands in the same batch that makes the player known (the first batch). */
      readonly initial: boolean;
      readonly seed: () => void;
      readonly bannerName: string;
    }> = [
      {
        label: 'a challenge in the initial batch',
        initial: true,
        seed: () => {
          seedPlayer(BOB, 'Bob', 8n);
          opts.store.upsertChallenge(challengeFrom(BOB, 21n, 2_000n));
        },
        bannerName: 'Bob',
      },
      {
        label: 'a challenge in a later batch',
        initial: false,
        seed: () => {
          seedPlayer(BOB, 'Bob', 8n);
          opts.store.upsertChallenge(challengeFrom(BOB, 21n, 2_000n));
        },
        bannerName: 'Bob',
      },
      {
        label: 'a trade in a later batch',
        initial: false,
        seed: () => {
          seedPlayer(CAROL, 'Carol', 9n);
          opts.store.upsertTradeOffer(offerFrom(CAROL, 11n, 1_000n));
        },
        bannerName: 'Carol',
      },
    ];
    let checked = 0;
    for (const s of scenarios) {
      teardown();
      await bootReady();
      const focusBefore = document.activeElement;
      if (s.initial) {
        s.seed();
        batch();
      } else {
        batch();
        frame();
        expect(stackNames(), `${s.label}: precondition: the bare world`).toEqual(['world']);
        s.seed();
        batch();
      }
      frame();
      await flush();
      frame();

      expect(stackNames(), `${s.label}: no frame opened`).toEqual(['world']);
      expect(openDialogs(), `${s.label}: no dialog is on screen`).toEqual([]);
      expect(shownById('pvp-challenge-overlay'), `${s.label}: not the Challenges root`).toBe(false);
      expect(shownById('trade-overlay'), `${s.label}: not the Trades root`).toBe(false);
      expect(shownById('menu-overlay'), `${s.label}: not the menu`).toBe(false);
      expect(document.activeElement, `${s.label}: focus did not move`).toBe(focusBefore);
      expect(H.calls, `${s.label}: nothing was sent`).toEqual([]);

      // ANTI-VACUITY: the request really is in the store and really is announced.
      expect(
        opts.store.allChallenges().length + opts.store.allTradeOffers().length,
        `${s.label}: precondition: the request is in the store`,
      ).toBe(1);
      expect(bannerText(), `${s.label}: precondition: it is announced by the banner`).toContain(
        s.bannerName,
      );

      // Nor on the next batch, nor the frames after it.
      batch();
      frame();
      frame();
      expect(stackNames(), `${s.label}: nor on the next batch`).toEqual(['world']);
      expect(openDialogs()).toEqual([]);
      expect(document.activeElement).toBe(focusBefore);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: three scenarios').toBe(3);
  }, 60_000);

  it('CTL13-2-BOOT-BANNER: an incoming trade shows a non-modal key-free banner naming the sender and badges the Start chip, announced once through the live region; with the menu open the banner steps aside, the Social row reads "Social (<badge>)" and follows a request that comes or goes on a batch; a challenge reads its own line; a withdrawn request takes banner and badges away', async () => {
    // WRONG IMPL KILLED: no banner (the request is invisible: the criterion); a banner that is a
    // dialog, takes focus or carries role / aria-live / tabindex (ui/liveRegion is the sole
    // announcement owner); a banner text with a key in it (it must survive a remap) or one that
    // lacks the sender; a banner shown over the menu or a frame; no Start badge, a badge that is
    // not text, or one left after the request is gone; a menu whose Social row never carries the
    // badge, carries it on every row, or is not repainted when a request arrives or leaves while it
    // is open; a request announced on every batch (a screen reader would hear it repeated), never
    // announced, or announced with another text than the banner's; and a challenge that reads the
    // trade's line.
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    batch();
    frame();

    // --- control: nothing waits -------------------------------------------------------------
    expect(bannerText(), 'control: no banner with nothing waiting').toBeNull();
    expect(startBadge(), 'control: no badge').toBeNull();

    // --- a trade arrives ------------------------------------------------------------------
    const focusBefore = document.activeElement;
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    const tradeLine = tf('notice.request.trade', { name: 'Bob' });
    expect(bannerText(), 'the banner reads the catalog line with the sender').toBe(tradeLine);
    expect(tradeLine).toContain('Bob');
    const banner = byId('notice-banner');
    for (const name of ['role', 'aria-live', 'aria-modal', 'tabindex']) {
      expect(banner.hasAttribute(name), `the banner has no ${name}`).toBe(false);
    }
    expect(banner.closest('[aria-live]'), 'and sits in no live region').toBeNull();
    expect(banner.closest('#hint-bar'), 'the banner is part of the hint bar').not.toBeNull();
    expect(startBadge(), 'the Start chip carries the badge text').toBe(
      i18nT('chrome.badge.request'),
    );
    expect(document.activeElement, 'focus did not move').toBe(focusBefore);
    expect(stackNames()).toEqual(['world']);

    // --- announced once, through the one live region -----------------------------------------
    frame(700);
    frame(700);
    const live = byId('a11y-live');
    expect(live.textContent, 'the new request is announced with the banner text').toBe(tradeLine);
    live.textContent = '';
    batch();
    frame(700);
    frame(700);
    expect(live.textContent, 'a later batch does not announce the same request again').toBe('');

    // --- the menu: the banner steps aside, Social carries the badge ---------------------------
    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    expect(bannerText(), 'the banner shows only at the bare world base').toBeNull();
    const badge = i18nT('chrome.badge.request');
    const social = i18nT('menu.social.title');
    expect(menuRows(), 'only the Social row is badged').toEqual([
      i18nT('menu.monsters.title'),
      i18nT('menu.bag.title'),
      i18nT('menu.journal.title'),
      `${social} (${badge})`,
      i18nT('menu.profile.title'),
      i18nT('menu.options.title'),
      i18nT('menu.close.title'),
    ]);
    // The request is withdrawn while the menu is open: the row follows the BATCH (no frame).
    opts.store.removeTradeOffer(11n);
    batch();
    expect(menuRows()[3], 'the Social row lost its badge on the batch').toBe(social);
    // And a request that arrives while it is open badges it again.
    opts.store.upsertTradeOffer(offerFrom(BOB, 12n, 3_000n));
    batch();
    expect(menuRows()[3], 'a new request badges the open menu').toBe(`${social} (${badge})`);

    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Start closed the menu').toEqual(['world']);
    expect(bannerText(), 'the banner is back at the bare world').toBe(tradeLine);

    // --- a challenge reads its own line -------------------------------------------------------
    opts.store.removeTradeOffer(12n);
    opts.store.upsertChallenge(challengeFrom(BOB, 21n, 4_000n));
    batch();
    frame();
    const challengeLine = tf('notice.request.challenge', { name: 'Bob' });
    expect(bannerText(), 'the challenge line').toBe(challengeLine);
    expect(challengeLine, 'a different line from the trade`s').not.toBe(tradeLine);
    expect(challengeLine).toContain('Bob');

    // --- withdrawn: banner and badge go ----------------------------------------------------
    opts.store.removeChallenge(21n);
    batch();
    frame();
    expect(bannerText(), 'the banner goes with the request').toBeNull();
    expect(startBadge(), 'and so does the badge').toBeNull();
    expect(H.calls, 'nothing was ever sent').toEqual([]);
  }, 60_000);

  it('CTL13-3-BOOT-Y-ENTER: Y with a request pending and no target opens its sheet (Accept / Decline / View, on Accept) over the bare world with no focus move; while it is open a movement key sends no move; Enter sends exactly the Accept reducer for that request (respondTrade accepted:true, acceptChallenge), Down then Enter the Decline one, and View opens Social on the request`s tab sending nothing; a request withdrawn or replaced under the open sheet sends nothing', async () => {
    // WRONG IMPL KILLED: a Y that does nothing without a target (the criterion); a sheet whose
    // cursor starts on Decline or View (Y then Enter would not accept); a sheet that opens a
    // frame, takes focus or lets the character walk on a D-pad press; an Enter that sends the
    // wrong reducer, the opposite `accepted`, the wrong id, or more than one call; a View that
    // sends a reducer or opens the wrong tab; and a stale sheet that acts on a request that was
    // withdrawn or replaced by another id (a stale id sent).
    const sheetTrade = tf('notice.request.trade', { name: 'Bob' });
    const sheetChallenge = tf('notice.request.challenge', { name: 'Bob' });
    const ROWS = [
      i18nT('notice.sheet.accept'),
      i18nT('notice.sheet.decline'),
      i18nT('notice.sheet.view'),
    ];

    /** Boot, seed one request from Bob, press Y and read the open sheet. */
    async function openSheet(kind: 'trade' | 'challenge'): Promise<void> {
      teardown();
      await bootReady();
      seedPlayer(BOB, 'Bob', 8n);
      batch();
      if (kind === 'trade') opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
      else opts.store.upsertChallenge(challengeFrom(BOB, 21n, 2_000n));
      batch();
      frame();
      expect(bannerText(), `${kind}: precondition: the request is announced`).not.toBeNull();
      expect(sheetShown(), `${kind}: precondition: no sheet before Y`).toBe(false);
      const focusBefore = document.activeElement;
      const y = press(Y);
      expect(y.defaultPrevented, `${kind}: Y is consumed`).toBe(true);
      frame();
      expect(stackNames(), `${kind}: the sheet is not a frame`).toEqual(['world']);
      expect(openDialogs(), `${kind}: and not a dialog`).toEqual([]);
      expect(document.activeElement, `${kind}: focus did not move`).toBe(focusBefore);
      expect(sheetShown(), `${kind}: the sheet is up`).toBe(true);
      expect(sheetRows(), `${kind}: Accept / Decline / View`).toEqual(ROWS);
      expect(sheetCursor(), `${kind}: the cursor starts on Accept`).toBe('accept');
      expect(byId('interact-prompt').textContent, `${kind}: the sheet names the request`).toContain(
        kind === 'trade' ? sheetTrade : sheetChallenge,
      );
    }

    // --- trade: Accept ------------------------------------------------------------------------
    await openSheet('trade');
    // While the sheet is open no movement key walks, jumps or moves the cursor sideways.
    for (const code of ['KeyD', 'KeyA', 'Space']) press(code);
    frame(300);
    expect(H.sends, 'no movement while the request sheet is open').toEqual([]);
    expect(sheetCursor(), 'Left and Right leave the cursor on Accept').toBe('accept');
    expect(H.calls, 'and nothing was sent yet').toEqual([]);
    press(A);
    await flush();
    expect(H.calls, 'Enter on Accept: exactly the accept reducer for that offer').toEqual([
      { name: 'respondTrade', args: { tradeId: 11n, accepted: true } },
    ]);
    frame();
    expect(sheetShown(), 'the sheet closed').toBe(false);
    press(A);
    await flush();
    expect(H.calls, 'a second Enter at the world sends nothing more').toHaveLength(1);
    press('KeyD');
    expect(H.sends, 'control: with the sheet closed the same key walks').toHaveLength(1);

    // --- the other three answers --------------------------------------------------------------
    const answers: ReadonlyArray<{
      readonly kind: 'trade' | 'challenge';
      readonly downs: number;
      readonly calls: Array<{ name: string; args: unknown }>;
    }> = [
      {
        kind: 'trade',
        downs: 1,
        calls: [{ name: 'respondTrade', args: { tradeId: 11n, accepted: false } }],
      },
      {
        kind: 'challenge',
        downs: 0,
        calls: [{ name: 'acceptChallenge', args: { challengeId: 21n, partyIds: [] } }],
      },
      {
        kind: 'challenge',
        downs: 1,
        calls: [{ name: 'declineChallenge', args: { challengeId: 21n } }],
      },
    ];
    for (const a of answers) {
      await openSheet(a.kind);
      for (let i = 0; i < a.downs; i += 1) press('ArrowDown');
      frame();
      expect(sheetCursor(), `${a.kind}: the cursor moved ${a.downs} row(s)`).toBe(
        a.downs === 0 ? 'accept' : 'decline',
      );
      press(A);
      await flush();
      expect(H.calls, `${a.kind} (${a.downs} Down): the exact reducer call`).toEqual(a.calls);
    }

    // --- View: Social on the request's tab, no reducer ----------------------------------------
    for (const [kind, root] of [
      ['trade', 'trade-overlay'],
      ['challenge', 'pvp-challenge-overlay'],
    ] as const) {
      await openSheet(kind);
      press('ArrowDown');
      press('ArrowDown');
      frame();
      expect(sheetCursor(), `${kind}: the cursor is on View`).toBe('view');
      press(A);
      await flush();
      frame();
      expect(H.calls, `${kind}: View sends nothing`).toEqual([]);
      expect(stackNames().at(-1), `${kind}: View opened the Social frame`).toBe('social');
      expect(shownById(root), `${kind}: on that request's own root`).toBe(true);
      expect(sheetShown(), `${kind}: the sheet closed`).toBe(false);
    }

    // --- B and Start close the sheet and send nothing -----------------------------------------
    for (const closer of [B, 'Escape']) {
      await openSheet('trade');
      press(closer);
      frame();
      expect(sheetShown(), `${closer} closes the sheet`).toBe(false);
      expect(stackNames(), `${closer} opens no menu over it`).toEqual(['world']);
      expect(H.calls).toEqual([]);
    }

    // --- stale: withdrawn or replaced under the open sheet ---------------------------------
    await openSheet('trade');
    seedPlayer(CAROL, 'Carol', 9n);
    opts.store.removeTradeOffer(11n);
    opts.store.upsertTradeOffer(offerFrom(CAROL, 12n, 1_500n));
    batch();
    press(A); // no frame in between: the press itself must refuse a stale id
    await flush();
    expect(H.calls, 'replaced by another offer: Enter sends nothing (no stale id)').toEqual([]);
    frame();
    expect(sheetShown(), 'and the sheet is closed').toBe(false);

    press(Y);
    frame();
    expect(sheetShown(), 'Y opens the sheet of the live request').toBe(true);
    opts.store.removeTradeOffer(12n);
    batch();
    frame();
    expect(sheetShown(), 'the withdrawn request closes its sheet on the next frame').toBe(false);
    press(A);
    await flush();
    expect(H.calls, 'withdrawn: Enter sends nothing').toEqual([]);

    opts.store.upsertTradeOffer(offerFrom(CAROL, 13n, 5_000n));
    batch();
    frame();
    press(Y);
    press(A);
    await flush();
    expect(H.calls, 'a request that arrives afterwards is answered with ITS id').toEqual([
      { name: 'respondTrade', args: { tradeId: 13n, accepted: true } },
    ]);
  }, 120_000);

  it('CTL13-3-BOOT-B: B at the world hides the error toast first, then dismisses the request banner (the next request takes its place, a new request id is not dismissed), sends nothing, and leaves the Start badge and Y while the request still waits; a later distinct error shows the toast again; a reconnect forgets the dismissals', async () => {
    // WRONG IMPL KILLED: a B that is swallowed with nothing happening (the legacy "B has no notice
    // to act on"); a B that dismisses the banner before the toast, or both at once; a toast that
    // stays after B; a dismissal that hides every request (a new id must show) or none; a dismissal
    // that also clears the badge or the Y chip (the request still waits); a B that sends a reducer
    // (declining by pressing B); a toast that never shows again after a dismissal; and dismissals
    // that outlive a reconnect (the store was reset: a request must be seen again).
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    opts.store.upsertChallenge(challengeFrom(CAROL, 21n, 2_000n));
    batch();
    frame();
    const tradeLine = tf('notice.request.trade', { name: 'Bob' });
    const challengeLine = tf('notice.request.challenge', { name: 'Carol' });
    const toast = (): HTMLElement => byId('mr-error-overlay');
    expect(bannerText(), 'precondition: the oldest request is the banner').toBe(tradeLine);

    // --- the toast first ----------------------------------------------------------------------
    raiseError('first problem');
    expect(isShown(toast()), 'precondition: the error toast is up').toBe(true);
    expect(toast().textContent, 'precondition: with the error').toContain('first problem');
    press(B);
    frame();
    expect(isShown(toast()), 'B hides the toast').toBe(false);
    expect(bannerText(), 'and leaves the banner').toBe(tradeLine);

    // --- then the banner: the next request takes its place ------------------------------------
    press(B);
    frame();
    expect(bannerText(), 'B dismisses the trade banner: the challenge takes its place').toBe(
      challengeLine,
    );
    press(B);
    frame();
    expect(bannerText(), 'B dismisses the challenge banner too: nothing shows').toBeNull();
    expect(H.calls, 'B never answers a request').toEqual([]);
    expect(stackNames()).toEqual(['world']);
    expect(startBadge(), 'both requests still wait: the Start badge stays').toBe(
      i18nT('chrome.badge.request'),
    );
    const chips = [...document.querySelectorAll('#hint-bar [data-button]')].map((el) =>
      el.getAttribute('data-button'),
    );
    expect(
      chips,
      'Y (view) stays while a request waits, B (dismiss) goes with the notices',
    ).toEqual(['Y', 'Start', 'Select']);
    press(B);
    frame();
    expect(bannerText(), 'a further B with nothing to dismiss is harmless').toBeNull();
    expect(H.calls).toEqual([]);

    // --- a later, distinct error shows the toast again -----------------------------------------
    raiseError('second problem');
    expect(isShown(toast()), 'a later error shows the toast again').toBe(true);
    expect(toast().textContent, 'with the newest error').toContain('second problem');
    expect(toast().textContent, 'and not the dismissed one').not.toContain('first problem');
    press(B);
    frame();
    expect(isShown(toast()), 'B hides it again').toBe(false);

    // --- a dismissal is per request: a new request id shows -----------------------------------
    opts.store.removeTradeOffer(11n);
    opts.store.upsertTradeOffer(offerFrom(BOB, 12n, 3_000n));
    batch();
    frame();
    expect(bannerText(), 'a new offer (another id) is not dismissed').toBe(tradeLine);

    // --- a reconnect forgets the dismissals --------------------------------------------------
    press(B);
    frame();
    expect(bannerText(), 'precondition: the new offer was dismissed too').toBeNull();
    opts.onReconnect(H.identity);
    batch();
    frame();
    expect(
      bannerText(),
      'after a reconnect the dismissals are gone: the request shows again',
    ).not.toBeNull();
  }, 60_000);
});
