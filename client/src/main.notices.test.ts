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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectionRecordingMock,
  mountIndexHtmlShell,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { ConnectionOptions } from './net/connection';
import type { StoreBattleChallenge, StoreTradeSession } from './net/store';
import { HOLD_COMMIT_MS } from './prediction/heldKeys';
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

vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgWalkingMock({ interact: (...args: unknown[]) => H.interact(...args) }),
);

vi.mock('./net/connection', () => connectionRecordingMock(H));

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

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
  sessions.clear();
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

/** An incoming trade request: a SESSION (`my_trade_session`) `from` opened with the booted player,
 *  untouched on the booted player's side. */
const sessionFrom = (
  from: string,
  sessionId: bigint,
  createdAtMs: bigint,
  over: Partial<StoreTradeSession> = {},
): StoreTradeSession => ({
  sessionId,
  opener: from,
  partner: H.identity,
  openerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
  partnerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
  openerConfirmed: false,
  partnerConfirmed: false,
  revision: 1n,
  createdAtMs,
  ...over,
});

/** The session rows this boot's store holds: the view is PK-less, so every change reconciles the
 *  whole set (as the connection's flush does). Applied on the next `batch()`. */
const sessions = new Map<bigint, StoreTradeSession>();
function putSession(row: StoreTradeSession): void {
  sessions.set(row.sessionId, row);
  opts.store.reconcileTradeSessionsFromView([...sessions.values()]);
}
function dropSession(sessionId: bigint): void {
  sessions.delete(sessionId);
  opts.store.reconcileTradeSessionsFromView([...sessions.values()]);
}

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
        label: 'a trade session in a later batch',
        initial: false,
        seed: () => {
          seedPlayer(CAROL, 'Carol', 9n);
          putSession(sessionFrom(CAROL, 11n, 1_000n));
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
      expect(shownById('tradepropose-overlay'), `${s.label}: not the session editor`).toBe(false);
      expect(shownById('menu-overlay'), `${s.label}: not the menu`).toBe(false);
      expect(document.activeElement, `${s.label}: focus did not move`).toBe(focusBefore);
      expect(H.calls, `${s.label}: nothing was sent`).toEqual([]);

      // ANTI-VACUITY: the request really is in the store and really is announced.
      expect(
        opts.store.allChallenges().length + opts.store.allTradeSessions().length,
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
    putSession(sessionFrom(BOB, 11n, 1_000n));
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
      // uif-15c (named intentional change, UIF15C.1): Options is gone; the root lists How to Play and
      // Controls in its place (7 -> 8 rows). Was: i18nT('menu.options.title').
      i18nT('menu.help.title'),
      i18nT('menu.controls.title'),
      i18nT('menu.close.title'),
    ]);
    // The request is withdrawn while the menu is open: the row follows the BATCH (no frame).
    dropSession(11n);
    batch();
    expect(menuRows()[3], 'the Social row lost its badge on the batch').toBe(social);
    // And a request that arrives while it is open badges it again.
    putSession(sessionFrom(BOB, 12n, 3_000n));
    batch();
    expect(menuRows()[3], 'a new request badges the open menu').toBe(`${social} (${badge})`);

    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Start closed the menu').toEqual(['world']);
    expect(bannerText(), 'the banner is back at the bare world').toBe(tradeLine);

    // --- a challenge reads its own line -------------------------------------------------------
    dropSession(12n);
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

  it('CTL13-3-BOOT-Y-ENTER: Y with a request pending and no target opens its sheet (Accept / Decline / View, on Accept) over the bare world with no focus move; while it is open a movement key sends no move; Enter answers Accept for that request (a trade session opens its editor with no reducer, ts-3; acceptChallenge), Down then Enter sends the Decline reducer (cancelTradeSession, declineChallenge), and View opens Social on the request`s tab sending nothing; a request withdrawn or replaced under the open sheet sends nothing', async () => {
    // WRONG IMPL KILLED: a Y that does nothing without a target (the criterion); a sheet whose
    // cursor starts on Decline or View (Y then Enter would not accept); a sheet that opens a
    // frame, takes focus or lets the character walk on a D-pad press; an Enter that sends the
    // wrong reducer, the opposite `accepted`, the wrong id, or more than one call; a View that
    // sends a reducer or opens the wrong tab; and a stale sheet that acts on a request that was
    // withdrawn or replaced by another id (a stale id sent).
    const sheetTrade = tf('notice.request.trade', { name: 'Bob' });
    const sheetChallenge = tf('notice.request.challenge', { name: 'Bob' });
    // uif-12 (UIF12.2, named intentional change): the request sheet ends with a Close row.
    const ROWS = [
      i18nT('notice.sheet.accept'),
      i18nT('notice.sheet.decline'),
      i18nT('notice.sheet.view'),
      i18nT('kit.sheet.close'),
    ];

    /** Boot, seed one request from Bob, press Y and read the open sheet. */
    async function openSheet(kind: 'trade' | 'challenge'): Promise<void> {
      teardown();
      await bootReady();
      seedPlayer(BOB, 'Bob', 8n);
      batch();
      if (kind === 'trade') putSession(sessionFrom(BOB, 11n, 1_000n));
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
    // A trade's Accept is `openTradeEditor` — no reducer; the editor opens on that session.
    press(A);
    await flush();
    expect(H.calls, 'Enter on Accept: no reducer for a trade session').toEqual([]);
    frame();
    expect(sheetShown(), 'the sheet closed').toBe(false);
    expect(stackNames(), 'Accept opened the session editor').toEqual(['world', 'tradeSessionView']);
    expect(byId('tradepropose-overlay').getAttribute('data-session-id'), 'on that session').toBe(
      '11',
    );
    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Escape closed the editor').toEqual(['world']);
    press(A);
    await flush();
    expect(H.calls, 'a second Enter at the world sends nothing').toEqual([]);
    press('KeyD');
    expect(H.sends, 'control: with the sheet closed the same key walks').toHaveLength(1);

    // --- the other three answers --------------------------------------------------------------
    const answers: ReadonlyArray<{
      readonly kind: 'trade' | 'challenge';
      readonly downs: number;
      readonly calls: Array<{ name: string; args: unknown }>;
    }> = [
      // A trade's Decline cancels the session.
      {
        kind: 'trade',
        downs: 1,
        calls: [{ name: 'cancelTradeSession', args: { sessionId: 11n } }],
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
    // ts-3 (named intentional change, C): Accept sends no reducer now, so "sends nothing" alone is
    // vacuous; each stale step also pins that NO editor opened (neither on the stale id nor
    // re-pointed onto the replacement), and the last step reads the editor's session id.
    await openSheet('trade');
    seedPlayer(CAROL, 'Carol', 9n);
    dropSession(11n);
    putSession(sessionFrom(CAROL, 12n, 1_500n));
    batch();
    press(A); // no frame in between: the press itself must refuse a stale id
    await flush();
    expect(H.calls, 'replaced by another session: Enter sends nothing (no stale id)').toEqual([]);
    frame();
    expect(sheetShown(), 'and the sheet is closed').toBe(false);
    expect(stackNames(), 'and no editor opened, on either session').toEqual(['world']);

    press(Y);
    frame();
    expect(sheetShown(), 'Y opens the sheet of the live request').toBe(true);
    dropSession(12n);
    batch();
    frame();
    expect(sheetShown(), 'the withdrawn request closes its sheet on the next frame').toBe(false);
    press(A);
    await flush();
    expect(H.calls, 'withdrawn: Enter sends nothing').toEqual([]);
    expect(stackNames(), 'withdrawn: and opens nothing').toEqual(['world']);

    putSession(sessionFrom(CAROL, 13n, 5_000n));
    batch();
    frame();
    press(Y);
    press(A);
    await flush();
    frame();
    expect(H.calls, 'a request that arrives afterwards: Accept sends no reducer').toEqual([]);
    expect(stackNames(), 'it opens the editor').toEqual(['world', 'tradeSessionView']);
    expect(byId('tradepropose-overlay').getAttribute('data-session-id'), 'on ITS session id').toBe(
      '13',
    );
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
    putSession(sessionFrom(BOB, 11n, 1_000n));
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
    dropSession(11n);
    putSession(sessionFrom(BOB, 12n, 3_000n));
    batch();
    frame();
    expect(bannerText(), 'a new session (another id) is not dismissed').toBe(tradeLine);

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

// ==========================================================================================
// uif-12: the world sheets on the ContextSheet kit, pointer-live (UIF12.1, UIF12.4, UIF12.5)
// ==========================================================================================

const worldCanvas = (): Promise<HTMLElement> =>
  vi.waitFor(
    () => {
      const c = document.querySelector<HTMLElement>('#game-screen canvas');
      if (c === null) throw new Error('the world canvas is not mounted yet');
      return c;
    },
    { timeout: 5_000, interval: 5 },
  );
/** A bubbling left click (the pointer dispatcher on #game-screen reads `click`). */
const leftClick = (el: Element): void => {
  clock.t = next(50);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
};
const sheetRow = (navKey: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(
    `#interact-prompt [role="option"][data-nav-key="${navKey}"]`,
  );
  if (el === null) throw new Error(`no world-sheet row ${navKey}`);
  return el;
};
const sheetRoot = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#interact-prompt [data-context-sheet]');

/** Boot, seed one request from Bob, press Y and leave the request sheet open (no frame after the
 *  last press other than the one that paints it). */
async function openRequestSheet(kind: 'trade' | 'challenge'): Promise<void> {
  await bootReady();
  seedPlayer(BOB, 'Bob', 8n);
  batch();
  if (kind === 'trade') putSession(sessionFrom(BOB, 11n, 1_000n));
  else opts.store.upsertChallenge(challengeFrom(BOB, 21n, 2_000n));
  batch();
  frame();
  press(Y);
  frame();
  expect(sheetShown(), `${kind}: precondition: the request sheet is up`).toBe(true);
}

describe('main.ts world sheets on the kit (runtime, uif-12)', { sequential: true }, () => {
  afterEach(teardown);

  it('UIF12.1 the request sheet`s heading and rows are inside the kit`s shown #interact-prompt [data-context-sheet] (.mr-sheet)', async () => {
    // WRONG IMPL KILLED: the world sheet still painted with bare renderNav into a plain div (no
    // [data-context-sheet] root, so the pointer source never sees it); a root left `hidden` while
    // the rows show; a title painted outside the sheet root; a root that is not the kit's.
    await openRequestSheet('trade');
    const root = sheetRoot();
    expect(
      root,
      'the request sheet has a [data-context-sheet] root inside #interact-prompt',
    ).not.toBeNull();
    const sheet = root as HTMLElement;
    expect(sheet.classList.contains('mr-sheet'), 'the root is the ContextSheet kit`s').toBe(true);
    expect(sheet.hidden, 'the root is not hidden').toBe(false);
    expect(isShown(sheet), 'and shows').toBe(true);
    const rows = [...document.querySelectorAll('#interact-prompt [role="option"]')];
    // uif-12 (UIF12.2, named intentional change): + the trailing Close row.
    expect(rows.length, 'Accept / Decline / View / Close').toBe(4);
    for (const row of rows) {
      expect(sheet.contains(row), `row ${row.textContent} is inside the sheet root`).toBe(true);
    }
    const line = tf('notice.request.trade', { name: 'Bob' });
    const heading = [...sheet.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent === line,
    );
    expect(heading.length, 'the request line is the sheet`s own heading, inside the root').toBe(1);
    expect(
      sheet.querySelector('[role="option"]') !== null && sheet.contains(heading[0] as Element),
      'heading and rows share the one root',
    ).toBe(true);
  }, 60_000);

  it('UIF12.1 a pointer click on the non-cursor Decline row sends exactly the decline reducer with no frame in between and closes the sheet; a click on View opens Social and sends nothing', async () => {
    // WRONG IMPL KILLED: rows with no pointer path (the prompt is pointer-events:none / no
    // [data-context-sheet], so the click does nothing); a world sheet that repaints only in the rAF
    // tick (the pointer seek reads the cursor from the DOM straight after each press, so a click on
    // a non-cursor row probes, misses, undoes and never presses A: review finding #1); a click that
    // answers the CURSOR row (Accept) instead of the clicked one; a click on View that sends a
    // reducer.
    const answers: ReadonlyArray<{
      readonly kind: 'trade' | 'challenge';
      readonly call: { name: string; args: unknown };
    }> = [
      // A trade's Decline cancels the session.
      { kind: 'trade', call: { name: 'cancelTradeSession', args: { sessionId: 11n } } },
      { kind: 'challenge', call: { name: 'declineChallenge', args: { challengeId: 21n } } },
    ];
    for (const a of answers) {
      teardown();
      await openRequestSheet(a.kind);
      expect(sheetCursor(), `${a.kind}: precondition: the cursor is on Accept`).toBe('accept');
      leftClick(sheetRow('decline'));
      // NO frame between the click and the read: the press itself must have repainted the sheet.
      await flush();
      expect(H.calls, `${a.kind}: exactly the decline reducer for that request`).toEqual([a.call]);
      frame();
      expect(sheetShown(), `${a.kind}: the sheet closed`).toBe(false);
      expect(stackNames(), `${a.kind}: still the bare world`).toEqual(['world']);
    }

    for (const [kind, root] of [
      ['trade', 'trade-overlay'],
      ['challenge', 'pvp-challenge-overlay'],
    ] as const) {
      teardown();
      await openRequestSheet(kind);
      leftClick(sheetRow('view'));
      await flush();
      frame();
      expect(H.calls, `${kind}: View sends nothing`).toEqual([]);
      expect(stackNames().at(-1), `${kind}: View opened Social`).toBe('social');
      expect(shownById(root), `${kind}: on the request's own root`).toBe(true);
      expect(sheetShown(), `${kind}: the sheet closed`).toBe(false);
    }
  }, 120_000);

  it('UIF12.4 a click on the world canvas outside the open request sheet closes it and sends nothing: no accept, no decline, the stack stays the bare world', async () => {
    // WRONG IMPL KILLED: a world sheet with no [data-context-sheet] root (an outside click never
    // closes it, so it hangs on); an outside click that is read as a canvas press of A (the faced
    // action or the CURSOR row, Accept, runs); a close that also opens the menu or a frame.
    await openRequestSheet('trade');
    const canvas = await worldCanvas();
    leftClick(canvas);
    await flush();
    expect(H.calls, 'an outside click answers nothing').toEqual([]);
    frame();
    expect(sheetShown(), 'the sheet is gone').toBe(false);
    expect(stackNames(), 'the stack is the bare world').toEqual(['world']);
    expect(openDialogs(), 'no dialog opened').toEqual([]);
    // Control: the request still waits, so Y reopens the sheet (the close was not a dismissal).
    press(Y);
    frame();
    expect(sheetShown(), 'control: the request still waits').toBe(true);
  }, 60_000);

  it('UIF12.2 the request sheet`s rows are Accept / Decline / View / Close with Close the LAST option (data-nav-key="close"); Down x3 puts the cursor on it and Enter there does exactly what B does: the sheet closes, nothing is sent, the banner stays, the stack stays the bare world', async () => {
    // WRONG IMPL KILLED: no Close row painted; a Close row painted with the raw key or another
    // label; a Close row that is not last (Up from Accept would not reach it, Down x3 would land
    // elsewhere); an Enter on Close that answers the request (the row before it, View, opens
    // Social; or the default, Accept, opens the session editor); an Enter on Close that DISMISSES the
    // request (banner gone: B at an open sheet only closes it); an Enter that leaves the sheet up.
    const line = tf('notice.request.trade', { name: 'Bob' });
    await openRequestSheet('trade');
    expect(sheetRows(), 'Accept / Decline / View / Close').toEqual([
      i18nT('notice.sheet.accept'),
      i18nT('notice.sheet.decline'),
      i18nT('notice.sheet.view'),
      i18nT('kit.sheet.close'),
    ]);
    const options = [...document.querySelectorAll('#interact-prompt [role="option"]')];
    expect(
      options.at(-1)?.getAttribute('data-nav-key'),
      'Close is the last option, keyed close',
    ).toBe('close');
    expect(options.at(-1)?.textContent, 'labelled from the catalog').toBe(i18nT('kit.sheet.close'));
    expect(sheetCursor(), 'precondition: the cursor starts on Accept').toBe('accept');

    for (let i = 0; i < 3; i += 1) press('ArrowDown');
    frame();
    expect(sheetCursor(), 'Down x3: the cursor is on Close').toBe('close');
    press(A);
    await flush();
    expect(H.calls, 'Enter on Close sends nothing').toEqual([]);
    frame();
    expect(sheetShown(), 'Enter on Close closes the sheet').toBe(false);
    expect(stackNames(), 'and opens no frame').toEqual(['world']);
    expect(openDialogs(), 'nor a dialog').toEqual([]);
    const afterClose = { banner: bannerText(), stack: stackNames(), calls: [...H.calls] };
    expect(afterClose.banner, 'the request still waits: its banner stays').toBe(line);

    // The reference: B on the same sheet, reopened with Y.
    press(Y);
    frame();
    expect(sheetShown(), 'precondition: Y reopens the request sheet').toBe(true);
    press(B);
    await flush();
    frame();
    expect(sheetShown(), 'B closes the sheet').toBe(false);
    expect(
      { banner: bannerText(), stack: stackNames(), calls: [...H.calls] },
      'Enter on Close had exactly B`s effect',
    ).toEqual(afterClose);

    // ANTI-VACUITY: the sheet was live all along — Y then Enter on Accept answers the request.
    // A trade's Accept opens the session editor (no reducer).
    press(Y);
    frame();
    press(A);
    await flush();
    frame();
    expect(H.calls, 'control: Accept sends no reducer for a session').toEqual([]);
    expect(stackNames(), 'control: Accept still answers: the editor opened').toEqual([
      'world',
      'tradeSessionView',
    ]);
  }, 60_000);

  it('UIF12.2 a pointer click on the request sheet`s Close row (not the cursor row) closes it and sends nothing, for a trade and a challenge; the request still waits', async () => {
    // WRONG IMPL KILLED: a Close row with no pointer path (the very user the row exists for has no
    // way to close the sheet but an outside click); a click that runs the CURSOR row (Accept) or
    // the row before Close (View: Social opens); a click on Close that dismisses the request.
    for (const [kind, line] of [
      ['trade', tf('notice.request.trade', { name: 'Bob' })],
      ['challenge', tf('notice.request.challenge', { name: 'Bob' })],
    ] as const) {
      teardown();
      await openRequestSheet(kind);
      expect(sheetCursor(), `${kind}: precondition: the cursor is on Accept`).toBe('accept');
      leftClick(sheetRow('close'));
      await flush();
      expect(H.calls, `${kind}: a click on Close sends nothing`).toEqual([]);
      frame();
      expect(sheetShown(), `${kind}: the sheet closed`).toBe(false);
      expect(stackNames(), `${kind}: still the bare world (no Social)`).toEqual(['world']);
      expect(bannerText(), `${kind}: the request still waits`).toBe(line);
      press(Y);
      frame();
      expect(sheetShown(), `${kind}: control: Y reopens it`).toBe(true);
    }
  }, 120_000);

  it('UIF12.5 (regression gate, may pass today) while a world sheet is open a held movement key sends no move; a key held while an outside click closes the sheet does not start a walk after the close; the next fresh press walks exactly one step', async () => {
    // WRONG IMPL KILLED: a sheet that lets a held direction through (the character walks under the
    // sheet); a sheet close that does not reset the held input (the key held through it resumes
    // walking on the first frame after the close, with no new press); a reset that also swallows the
    // next FRESH press (it must walk once).
    await openRequestSheet('trade');
    const canvas = await worldCanvas();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true }),
    );
    frame(300);
    frame(300);
    expect(H.sends, 'no movement while the world sheet is open').toEqual([]);

    leftClick(canvas); // W is still held while the sheet closes
    frame();
    expect(sheetShown(), 'precondition: the outside click closed the sheet').toBe(false);
    frame(300);
    frame(300);
    frame(300);
    expect(H.sends, 'the key held through the close does not walk').toEqual([]);

    window.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true, cancelable: true }),
    );
    press('KeyW');
    expect(H.sends, 'the next fresh press walks exactly one step').toHaveLength(1);
    frame(300);
    expect(H.sends, 'and a tapped key does not keep walking').toHaveLength(1);
  }, 60_000);

  it('UIF12.5 a movement key held down (never released) through a KEYBOARD close of the world sheet (B or Start) starts no walk after the close, whether it was pressed before the sheet opened or while it was open; the next fresh press walks exactly one step', async () => {
    // WRONG IMPL KILLED: a sheet open/close edge that does not clear the shell's held keys (the walk
    // holder resumes the moment the sheet closes: the hold is committed and the server owes
    // nothing), or does not reset the router's D-pad auto-repeat (the held direction keeps
    // repeating into the world after the close). The close here is a keyboard B / Start, so the
    // outside-click path (which resets input itself) is not what makes this pass.
    const ackAt = (y: number): void => {
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
          tileY: y,
          facing: 'North',
          action: 'Idle',
          moveStartedAtMs: 0n,
          moveQueue: [] as WasmMoveInput[],
        },
        clock.t,
      );
      opts.store.flushBatch();
    };
    const down = (code: string): void => {
      clock.t = next(50);
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
    };
    const up = (code: string): void => {
      clock.t = next(5);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
    };
    const LONG: readonly number[] = [HOLD_COMMIT_MS + 50, 400, 400, 400];

    let checked = 0;
    for (const closer of [B, 'Escape']) {
      for (const when of ['before', 'during'] as const) {
        const label = `${when} the sheet, closed by ${closer}`;
        teardown();
        await bootReady();
        seedPlayer(BOB, 'Bob', 8n);
        batch();
        putSession(sessionFrom(BOB, 11n, 1_000n));
        batch();
        frame();
        let base = 0;
        if (when === 'before') {
          down('KeyW'); // held since before the sheet opens
          base = 1;
          expect(H.sends, `${label}: precondition: the press stepped once`).toHaveLength(1);
          frame(50);
          ackAt(5); // the step is acked where it was drawn: the server owes nothing
        }
        press(Y);
        frame();
        expect(sheetShown(), `${label}: precondition: the request sheet is up`).toBe(true);
        if (when === 'during') down('KeyW'); // pressed while the sheet is open, then held
        for (const ms of LONG) frame(ms);
        expect(H.sends, `${label}: nothing walks while the sheet is open`).toHaveLength(base);

        press(closer);
        frame();
        expect(sheetShown(), `${label}: precondition: the keyboard closed the sheet`).toBe(false);
        expect(stackNames(), `${label}: still the bare world`).toEqual(['world']);
        for (const ms of LONG) frame(ms);
        expect(
          H.sends,
          `${label}: the held key does not walk after the close (no fresh press)`,
        ).toHaveLength(base);

        up('KeyW');
        down('KeyW');
        up('KeyW');
        expect(H.sends, `${label}: control: a fresh press walks exactly one step`).toHaveLength(
          base + 1,
        );
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: four cases').toBe(4);
  }, 120_000);

  it('UIF12.5 a D-pad key held down (never released) through a world sheet closing and reopening does not repeat into the reopened sheet: its cursor stays on the first row and nothing walks', async () => {
    // WRONG IMPL KILLED: a sheet edge that does not reset the router's D-pad auto-repeat. The
    // repeat is armed only while a sheet owns the D-pad; a held ArrowDown armed before B closes the
    // sheet is stale, and it fires into the NEXT sheet as soon as nav is defined again, walking
    // the new sheet's cursor with no new press.
    await openRequestSheet('trade');
    expect(sheetCursor(), 'precondition: the cursor starts on Accept').toBe('accept');
    clock.t = next(50);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true, cancelable: true }),
    ); // held: no keyup
    frame(10);
    expect(sheetCursor(), 'precondition: the press moved the cursor once').toBe('decline');

    // Close and reopen well inside the repeat delay (no long frame in between).
    // A keyboard press repaints the world sheet on the next frame only: a short frame after each.
    press(B);
    frame(10);
    expect(sheetShown(), 'precondition: B closed the sheet').toBe(false);
    press(Y);
    frame(10);
    expect(sheetShown(), 'precondition: Y reopened the request sheet').toBe(true);
    expect(sheetCursor(), 'precondition: the reopened sheet starts on Accept').toBe('accept');

    // ArrowDown is STILL held. Run far past the repeat delay and several periods.
    for (const ms of [400, 200, 200, 200, 200, 200]) frame(ms);
    expect(sheetCursor(), 'the stale repeat did not walk the reopened sheet`s cursor').toBe(
      'accept',
    );
    expect(
      [...document.querySelectorAll('#interact-prompt [role="option"]')].map((el) =>
        el.getAttribute('aria-selected'),
      ),
      'the first row is the only selected one',
    ).toEqual(['true', 'false', 'false', 'false']); // uif-12 (UIF12.2): + the Close row
    expect(H.sends, 'nothing walks').toEqual([]);
    expect(H.calls, 'nothing was answered').toEqual([]);
  }, 60_000);

  it('UIF12.1 #interact-prompt carries mr-prompt--sheet exactly while a world sheet shows: present over the request sheet, absent after it closes and over the plain faced-target chip, present over the faced target`s action sheet, absent after it closes', async () => {
    // WRONG IMPL KILLED: the class never toggled (the prompt keeps its own border and padding around
    // the kit sheet: two borders); toggled on and never removed; set for the chip-only prompt.
    const cls = (): boolean => byId('interact-prompt').classList.contains('mr-prompt--sheet');
    await openRequestSheet('trade');
    expect(cls(), 'present while the request sheet shows').toBe(true);
    press(B);
    frame();
    expect(sheetShown(), 'precondition: B closed the request sheet').toBe(false);
    expect(cls(), 'absent once it closes').toBe(false);

    // A faced target: the plain chip.
    const NPC = 11n;
    opts.store.upsertNpc({
      entityId: NPC,
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
        entityId: NPC,
        zoneId: 0,
        tileX: 3,
        tileY: 6,
        facing: 'West',
        action: 'Idle',
        moveStartedAtMs: 0n,
        moveQueue: [] as WasmMoveInput[],
      },
      clock.t,
    );
    H.interact = (...args: unknown[]) => {
      const entities = args[4];
      if (!Array.isArray(entities)) return [];
      const at = entities.findIndex(
        (e: { kind?: unknown; id?: unknown }) => e.kind === 'npc' && e.id === NPC.toString(),
      );
      return at === -1 ? [] : [at];
    };
    batch();
    frame();
    expect(shownById('interact-prompt'), 'precondition: the plain chip shows').toBe(true);
    expect(sheetRows(), 'precondition: no rows, only the chip').toEqual([]);
    expect(
      byId('interact-prompt').textContent,
      'precondition: the chip names the target',
    ).toContain('guide');
    expect(cls(), 'absent over the plain faced-target chip').toBe(false);

    press(Y); // a faced target: Y opens its action sheet
    frame();
    // uif-12 (UIF12.2, named intentional change): the one Talk row, then Close.
    expect(sheetRows().length, 'precondition: the action sheet is up').toBe(2);
    expect(cls(), 'present over the action sheet').toBe(true);
    press(B);
    frame();
    expect(sheetRows(), 'precondition: B closed the action sheet').toEqual([]);
    expect(cls(), 'absent once the action sheet closes').toBe(false);
  }, 60_000);
});

// ==========================================================================================
// ts-3: incoming SESSIONS as the non-modal banner (ts-3.5)
// ==========================================================================================
//
// Same harness and real views. An incoming session (the booted player is its `partner`, their side
// empty and unconfirmed) that this client has not opened its editor on waits as a request: one
// banner line; two or more collapse into ONE line with the count; B dismisses the whole line; Y
// opens the sheet whose Accept opens the editor (no reducer) and whose Decline cancels the session.

const DAN = 'dd'.repeat(32);
/** `notice.request.trades` with count 2, en, as the plan transcribes it (literal bytes). */
const TWO_TRADES = '2 trade requests';

describe('main.ts incoming trade sessions as notices (runtime, ts-3)', { sequential: true }, () => {
  afterEach(teardown);

  it('ts-3.5 an incoming untouched session raises the banner with the single-trade line and opens no frame and moves no focus; two raise ONE line with count 2; B on that line dismisses it entirely; a new session after it shows again', async () => {
    // WRONG IMPL KILLED: an incoming session that opens the editor or Social (a frame) or takes
    // focus; no banner for a session (still reading legacy offers); one banner line per session or
    // the oldest's single line with no count; a B that dismisses only the oldest key (the next
    // session's single line would take its place); a dismissal that swallows later sessions.
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    seedPlayer(DAN, 'Dan', 10n);
    batch();
    frame();
    expect(bannerText(), 'control: nothing waits').toBeNull();
    const focusBefore = document.activeElement;

    putSession(sessionFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    await flush();
    frame();
    expect(bannerText(), 'one incoming session: the single-trade line').toBe(
      tf('notice.request.trade', { name: 'Bob' }),
    );
    expect(stackNames(), 'no frame opened').toEqual(['world']);
    expect(openDialogs(), 'no dialog is on screen').toEqual([]);
    expect(shownById('tradepropose-overlay'), 'not the session editor').toBe(false);
    expect(document.activeElement, 'focus did not move').toBe(focusBefore);
    expect(H.calls, 'nothing was sent').toEqual([]);

    putSession(sessionFrom(CAROL, 12n, 2_000n));
    batch();
    frame();
    expect(bannerText(), 'two incoming sessions: ONE line with the count').toBe(TWO_TRADES);
    expect(stackNames(), 'still no frame').toEqual(['world']);

    press(B);
    frame();
    expect(bannerText(), 'B dismisses the whole collapsed line').toBeNull();
    batch();
    frame();
    expect(bannerText(), 'and it stays dismissed on the next batch').toBeNull();
    expect(H.calls, 'B never answers a request').toEqual([]);

    putSession(sessionFrom(DAN, 13n, 3_000n));
    batch();
    frame();
    expect(bannerText(), 'control: a new session after the dismissal shows').toBe(
      tf('notice.request.trade', { name: 'Dan' }),
    );
  }, 60_000);

  it('ts-3.5 nothing is raised for a session whose editor this client opened, for the opener`s own session, nor for a session the viewer already acted in', async () => {
    // WRONG IMPL KILLED: `opened` never consulted (the request returns once the editor closes); a
    // banner for the viewer's OWN session (opener and partner swapped in the filter); a session the
    // viewer already offered into still treated as a fresh request.
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    batch();
    frame();

    // The opener's side: the booted player opened it.
    putSession(sessionFrom(H.identity, 21n, 1_000n, { partner: BOB }));
    batch();
    frame();
    expect(bannerText(), 'the opener sees no banner for its own session').toBeNull();

    // Touched: the viewer's (partner) side already holds coins.
    putSession(
      sessionFrom(CAROL, 22n, 1_100n, {
        partnerOffer: { monsterIds: [], items: [], currency: 5n, cards: [] },
      }),
    );
    batch();
    frame();
    expect(bannerText(), 'a session the viewer already acted in raises nothing').toBeNull();

    // Opened through the client: the request leaves the banner for good.
    putSession(sessionFrom(BOB, 24n, 1_300n));
    batch();
    frame();
    const bobLine = tf('notice.request.trade', { name: 'Bob' });
    expect(bannerText(), 'precondition: the incoming session is announced').toBe(bobLine);
    press(Y);
    frame();
    expect(sheetCursor(), 'precondition: the sheet is on Accept').toBe('accept');
    press(A);
    await flush();
    frame();
    expect(stackNames(), 'precondition: Accept opened the editor').toEqual([
      'world',
      'tradeSessionView',
    ]);
    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Escape closed the editor').toEqual(['world']);
    batch();
    frame();
    expect(bannerText(), 'a session this client opened raises nothing').toBeNull();
    expect(H.calls, 'nothing was ever sent').toEqual([]);
  }, 60_000);

  it('ts-3.5 Y then Accept opens the editor on THAT session and calls no reducer; Y then Decline calls cancelTradeSession once with that id, and a second Y then Decline before the row leaves sends nothing more', async () => {
    // WRONG IMPL KILLED: an Accept that sends a reducer (respondTrade, or a premature confirm) or
    // opens the editor on another session (the older one is listed first); a Decline that sends
    // respondTrade or the wrong id; no optimistic answered key (the request comes back
    // at once and a second Decline sends a duplicate cancel).
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    batch();
    putSession(sessionFrom(CAROL, 30n, 900n, { partner: DAN })); // not the viewer's: never shown
    putSession(sessionFrom(BOB, 31n, 1_000n));
    batch();
    frame();
    press(Y);
    frame();
    expect(sheetCursor(), 'precondition: the sheet is on Accept').toBe('accept');
    press(A);
    await flush();
    frame();
    expect(H.calls, 'Accept calls no reducer').toEqual([]);
    expect(stackNames(), 'Accept opens the editor').toEqual(['world', 'tradeSessionView']);
    expect(byId('tradepropose-overlay').getAttribute('data-session-id'), 'on THAT session').toBe(
      '31',
    );
    press('Escape');
    frame();

    // Decline, on a second incoming session.
    putSession(sessionFrom(CAROL, 32n, 2_000n));
    batch();
    frame();
    expect(bannerText(), 'precondition: Carol`s session waits').toBe(
      tf('notice.request.trade', { name: 'Carol' }),
    );
    press(Y);
    press('ArrowDown');
    frame();
    expect(sheetCursor(), 'precondition: the cursor is on Decline').toBe('decline');
    press(A);
    await flush();
    expect(H.calls, 'Decline cancels that session once').toEqual([
      { name: 'cancelTradeSession', args: { sessionId: 32n } },
    ]);
    frame();
    press(Y);
    press('ArrowDown');
    press(A);
    await flush();
    frame();
    expect(
      H.calls,
      'a second Y then Decline before the row leaves sends nothing more',
    ).toHaveLength(1);
    expect(stackNames(), 'and opens nothing').toEqual(['world']);
  }, 60_000);

  it('ts-3.5 a newly arrived request is always spoken: with an OLDER challenge holding the banner, a trade session that arrives later is announced with ITS OWN line, not the challenge`s again', async () => {
    // RED REASON: the announcement follows the banner's head line; with the older challenge on
    // top the new session re-announces the challenge's line (which the live region then dedupes:
    // the new request is never spoken at all).
    // WRONG IMPL KILLED: announcing the banner's (oldest) line whenever a new key appears; one
    // announcement per banner text change only (the head did not change, so nothing is spoken).
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    batch();
    frame();
    opts.store.upsertChallenge(challengeFrom(BOB, 21n, 1_000n));
    batch();
    frame(700);
    frame(700);
    const live = byId('a11y-live');
    const challengeLine = tf('notice.request.challenge', { name: 'Bob' });
    expect(live.textContent, 'precondition: the challenge was announced').toBe(challengeLine);
    expect(bannerText(), 'precondition: the challenge holds the banner').not.toBeNull();
    live.textContent = '';

    putSession(sessionFrom(CAROL, 11n, 2_000n));
    batch();
    frame(700);
    frame(700);
    const carolLine = tf('notice.request.trade', { name: 'Carol' });
    expect(carolLine, 'fixture: a line of its own').not.toBe(challengeLine);
    expect(live.textContent, 'the new session is spoken with its own line').toBe(carolLine);

    live.textContent = '';
    batch();
    frame(700);
    frame(700);
    expect(live.textContent, 'and only once').toBe('');
    expect(stackNames(), 'nothing opened').toEqual(['world']);
    expect(H.calls, 'nothing was sent').toEqual([]);
  }, 60_000);

  it('ts-3.5 two trade sessions arriving in ONE batch with nothing older are announced once, as the collapsed line', async () => {
    // RED REASON: a per-request announcement would speak the first session's single line (or
    // both singles, the live region keeping the last), not the line the banner shows.
    // WRONG IMPL KILLED: one announcement per arriving key (the second single line replacing the
    // collapsed one); the oldest's single line announced for a collapsed banner; a re-announce on
    // the next batch.
    await bootReady();
    seedPlayer(BOB, 'Bob', 8n);
    seedPlayer(CAROL, 'Carol', 9n);
    batch();
    frame();
    const live = byId('a11y-live');
    live.textContent = '';
    putSession(sessionFrom(BOB, 11n, 1_000n));
    putSession(sessionFrom(CAROL, 12n, 1_100n));
    batch();
    frame(700);
    frame(700);
    expect(bannerText(), 'precondition: the banner collapses the two').toBe(TWO_TRADES);
    expect(live.textContent, 'announced as the collapsed line').toBe(TWO_TRADES);
    live.textContent = '';
    batch();
    frame(700);
    frame(700);
    expect(live.textContent, 'once').toBe('');
  }, 60_000);
});

// ==========================================================================================
// ts-4: an identity change forgets the sessions the previous identity opened (ts-4.7)
// ==========================================================================================
//
// Same harness. The identity changes the way a rebuilt connection mints a new one: `onReconnect`
// then `onReady`, both carrying the NEW identity (the stubbed connection answers it too). Session
// ids are per-database, so the new identity can be the partner of a session with the same id as
// one the old identity opened its editor on.

const NEW_IDENTITY = 'ee'.repeat(32);

describe('main.ts an identity change and opened sessions (runtime, ts-4)', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it.each([
    { wiring: 'onReconnect' as const },
    { wiring: 'onReady' as const },
  ])('ts-4.7 after the identity changes through $wiring alone, an incoming untouched session with the SAME id as one the previous identity opened its editor on raises the request banner and opens no frame', async ({
    wiring,
  }) => {
    // WRONG IMPL KILLED: `resetTradeSessionState()` without `openedTradeSessions.clear()` (the old
    // identity's opened id 41 suppresses the new identity's request 41: the request never shows,
    // and the player is never told a trade waits); the reset called from only one of the two
    // identity-change callbacks (each row fires ONE of them, so the row of the callback that lacks
    // the reset stays silenced). The control before the change proves the opened set is what
    // silenced S, so the banner after it is the clear, not some other reset.
    const OLD_IDENTITY = H.identity;
    const S = 41n;
    try {
      await bootReady();
      seedPlayer(BOB, 'Bob', 8n);
      batch();
      frame();
      putSession(sessionFrom(BOB, S, 1_000n));
      batch();
      frame();
      const bobLine = tf('notice.request.trade', { name: 'Bob' });
      expect(bannerText(), 'precondition: the old identity`s request is announced').toBe(bobLine);
      press(Y);
      frame();
      expect(sheetCursor(), 'precondition: the sheet is on Accept').toBe('accept');
      press(A);
      await flush();
      frame();
      expect(stackNames(), 'precondition: Accept opened the editor').toEqual([
        'world',
        'tradeSessionView',
      ]);
      const boundTo = byId('tradepropose-overlay').getAttribute('data-session-id');
      expect(boundTo, 'precondition: the editor is on S').toBe(S.toString());
      press('Escape');
      frame();
      batch();
      frame();
      expect(stackNames(), 'precondition: Escape closed the editor').toEqual(['world']);
      expect(bannerText(), 'control: the opened session raises nothing').toBeNull();

      // The identity changes through ONE callback; the new identity is the partner of a session
      // with the same id.
      H.identity = NEW_IDENTITY;
      if (wiring === 'onReconnect') opts.onReconnect(NEW_IDENTITY);
      sessions.clear();
      putSession(sessionFrom(BOB, S, 2_000n));
      if (wiring === 'onReady') opts.onReady(NEW_IDENTITY);
      batch();
      frame();
      await flush();
      frame();
      expect(
        opts.store.allTradeSessions().map((s) => [s.sessionId, s.partner]),
        'fixture: the store holds S with the NEW identity as its partner',
      ).toEqual([[S, NEW_IDENTITY]]);
      expect(bannerText(), 'the new identity`s request on S raises the banner').toBe(bobLine);
      expect(stackNames(), 'and opens no frame').toEqual(['world']);
      expect(H.calls, 'and nothing was sent').toEqual([]);
    } finally {
      H.identity = OLD_IDENTITY;
    }
  }, 60_000);
});
