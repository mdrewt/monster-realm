// @vitest-environment happy-dom
/**
 * main.menu.test.ts: the booted main menu on the nav core (ctl-5, CTL5.1 to CTL5.5).
 *
 * The reducer (`screens/mainMenuScreen`), the router, the overlay a11y stack and the thin view are
 * proven in their own suites. This file proves the SHELL: that a freshly imported main.ts routes
 * real key events through the router into the menu, opens the child above it, returns to it, and
 * drives hold-repeat from its frame loop. Every case dispatches real KeyboardEvents at the real
 * listeners and reads only what a player or a server can see: which overlays are shown, the nav
 * container's `aria-activedescendant`, the feedback line, the intents sent to the (stubbed)
 * enqueueMove reducer, `defaultPrevented`, and the read-only `__game()` hook (`stack`, `navActive`).
 *
 * Harness: main.input.test.ts's pattern, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a controllable
 * rAF, a stubbed wasm pkg and SDK connection, the real client/index.html shell mounted first).
 * The entries (uif-15c, UIF15C.1: Options is gone, Help and Controls are root leaves): Monsters,
 * Bag, Journal, Social, Profile, Help, Controls, Close, so from a fresh menu two Downs stand on
 * Journal and three on Social.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import { t } from './ui/a11yCopy';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';
import { MENU_ENTRIES } from './ui/menuModel';
import { OVERLAY_A11Y } from './ui/overlayRegistry';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open grid.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => wasmPkgWalkingMock());

// The connection: capture the options, expose reducers whose enqueueMove never settles.
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

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

// The renderer: init(mount) appends a focusable canvas so main.ts can resolve its world focus.
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

let opts: ConnectionOptions;

async function boot(url = '/'): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  window.history.replaceState(null, '', url);
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
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

const EID = 7n;
/** Deliver one authoritative batch: the own player + character at (2, 6), nothing owed. */
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
      ackedSeq: 0n,
    },
    t,
  );
  opts.store.flushBatch();
}

interface FireOpts {
  readonly target?: EventTarget;
  readonly init?: KeyboardEventInit;
}
/** Dispatch one cancelable, bubbling key event at clock `t` and return it. */
function fire(type: 'keydown' | 'keyup', code: string, t: number, o: FireOpts = {}): KeyboardEvent {
  clock.t = t;
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...o.init });
  (o.target ?? window).dispatchEvent(event);
  return event;
}

/** A tap: keydown at `t`, keyup 5 ms later. Returns the keydown. */
function tap(code: string, t: number): KeyboardEvent {
  const down = fire('keydown', code, t);
  fire('keyup', code, t + 5);
  return down;
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
const menuShown = (): boolean => shownById('menu-overlay');
const journalShown = (): boolean => shownById('quest-log-list');
const socialRootShown = (): boolean => shownById('leaderboard-overlay');

const rowsEl = (): HTMLElement => document.getElementById('menu-rows') as HTMLElement;
const cursor = (): string | null => rowsEl().getAttribute('aria-activedescendant');
const menuTitle = (): string =>
  document.querySelector('#menu-overlay .mr-frame-title')?.textContent ?? '';
const menuCrumbs = (): string[] =>
  Array.from(document.querySelectorAll('#menu-overlay .mr-frame-crumb')).map(
    (c) => c.textContent ?? '',
  );
const feedbackText = (): string =>
  document.querySelector('#menu-overlay .mr-frame-feedback')?.textContent ?? '';
const optionTexts = (): string[] =>
  Array.from(rowsEl().querySelectorAll('[role="option"]')).map((o) => o.textContent ?? '');

interface GameHook {
  readonly stack: ReadonlyArray<{ readonly kind: string; readonly id?: string }>;
  readonly navActive: string | null;
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
/** The stack as base-first names: the base kind, then each screen frame's overlay id. */
const stackNames = (): string[] =>
  game().stack.map((f) => (f.kind === 'screen' ? (f.id as string) : f.kind));
const navActive = (): string | null => game().navActive;

// uif-15c (named intentional change, UIF15C.1): 7 -> 8 root keys: `options` is gone, `help` and
// `controls` are root entries. Was: [..., 'profile', 'options', 'close'].
const ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'help', 'controls', 'close'];
const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;

/** Boot, join, open the menu with M and walk the cursor down `downs` entries. */
async function bootAtMenu(downs = 0): Promise<void> {
  await bootReady();
  server(1000);
  tap('KeyM', 1010);
  expect(menuShown(), 'precondition: M opened the menu').toBe(true);
  for (let i = 0; i < downs; i += 1) tap('ArrowDown', 1100 + i * 100);
}

describe('main.ts main menu on the nav core (runtime, ctl-5)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    raf.cb = null;
    window.history.replaceState(null, '', '/');
    document.body.replaceChildren();
  });

  it('CTL5-2-MAIN-A-PUSHES: A on Journal opens the quest log above the menu, which stays open beneath it; the stack ends menuView then questLogView', async () => {
    // WRONG IMPL KILLED: an A that closes the menu before opening the child (the old
    // activateMenuLeaf: B could never come back), a menu that is hidden (display) instead of
    // covered, a child opened without being mirrored onto the stack, a router with no driver for
    // the menu (A reaches no handler), and an Enter that is not prevented.
    await bootAtMenu(2);
    expect(navActive(), 'precondition: the cursor is on Journal').toBe('journal');
    expect(journalShown(), 'precondition: the journal starts closed').toBe(false);
    expect(stackNames()).toEqual(['world', 'menuView']);

    const enter = tap('Enter', 1400);
    expect(enter.defaultPrevented, 'the consumed A press is prevented').toBe(true);
    expect(journalShown(), 'the quest log opened').toBe(true);
    expect(menuShown(), 'and the menu is still open beneath it').toBe(true);
    expect(stackNames(), 'the child is pushed above the menu').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    expect(navActive(), 'the menu cursor is where it was').toBe('journal');
    expect(
      (document.getElementById('menu-overlay') as HTMLElement).style.visibility,
      'the covered menu does not paint over the child',
    ).toBe('hidden');
  });

  it('CTL5-2-MAIN-B-RETURNS: B (Backspace) with the child open closes only the child and returns to the menu with the cursor on its entry; a second B at the menu root closes the menu', async () => {
    // WRONG IMPL KILLED: a B that is not routed (the child stays), a pop that closes the menu with
    // it, a return that resets the cursor to the first entry, a menu left covered after the
    // return, a stack that keeps the child's frame, and a root B that does not close.
    await bootAtMenu(2);
    tap('Enter', 1400);
    expect(journalShown(), 'precondition: the child is open').toBe(true);

    const back = tap('Backspace', 1500);
    expect(back.defaultPrevented, 'the consumed B press is prevented').toBe(true);
    expect(journalShown(), 'the child closed').toBe(false);
    expect(menuShown(), 'the menu is open again').toBe(true);
    expect(
      (document.getElementById('menu-overlay') as HTMLElement).style.visibility,
      'and uncovered',
    ).not.toBe('hidden');
    expect(cursor(), 'the cursor names the Journal entry').toBe('menu-root-journal');
    expect(navActive()).toBe('journal');
    expect(stackNames()).toEqual(['world', 'menuView']);

    const close = tap('Backspace', 1600);
    expect(close.defaultPrevented).toBe(true);
    expect(menuShown(), 'B at the menu root closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);
    expect(navActive(), 'a closed menu has no active entry').toBeNull();
  });

  it('CTL5-2-MAIN-ESCAPE-RETURNS: Escape with the child open is Start and pops to the world base, closing the child and the menu together; the next Escape opens the menu again', async () => {
    // WRONG IMPL KILLED: an Escape that closes only the child (the ctl-5 reading, retired by ctl-6b),
    // an Escape that leaves the child or the menu open, a pop that leaves the stack mirroring a
    // closed overlay, and an Escape at the world that cannot open the menu again.
    // ctl-6b CTL6B.2: Escape is Start now, so with a child over the menu it pops to the base (it used
    // to close only the child); Backspace (B) keeps returning to the menu (CTL5-2-MAIN-B-RETURNS).
    await bootAtMenu(2);
    tap('Enter', 1400);
    expect(journalShown(), 'precondition: the child is open').toBe(true);

    const esc = tap('Escape', 1500);
    expect(esc.defaultPrevented).toBe(true);
    expect(journalShown(), 'the child closed').toBe(false);
    expect(menuShown(), 'and the menu with it').toBe(false);
    expect(stackNames()).toEqual(['world']);
    expect(navActive(), 'a closed menu has no active entry').toBeNull();

    // Control: Escape at the world base (Start) opens the menu again.
    tap('Escape', 1600);
    expect(menuShown(), 'the next Escape opens the menu').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView']);
    tap('Escape', 1700);
    expect(menuShown(), 'and Escape over the menu closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('CTL5-3-MAIN-NAVACTIVE: reopening the menu in the same session puts the cursor on the last entry used and __game().navActive reports its key', async () => {
    // WRONG IMPL KILLED: a reopen that resets to the first entry, a navActive that is a constant,
    // an index instead of the entry key, one that reports a stale entry after a close, and one
    // that is not null while the menu is closed.
    await bootReady();
    server(1000);
    expect(navActive(), 'no menu yet: nothing is active').toBeNull();

    tap('KeyM', 1010);
    expect(navActive(), 'a fresh menu starts on the first entry').toBe('monsters');
    tap('ArrowDown', 1100);
    tap('ArrowDown', 1200);
    expect(navActive()).toBe('journal');

    tap('KeyM', 1300);
    expect(menuShown(), 'precondition: M closed the menu').toBe(false);
    expect(navActive(), 'closed: nothing is active').toBeNull();

    tap('KeyM', 1400);
    expect(menuShown(), 'precondition: M reopened it').toBe(true);
    expect(navActive(), 'the last entry used').toBe('journal');
    expect(cursor()).toBe('menu-root-journal');

    tap('ArrowDown', 1500);
    tap('KeyM', 1600);
    tap('KeyM', 1700);
    expect(navActive(), 'the most recent cursor wins').toBe('social');
  });

  it('CTL5-4-MAIN-Y: Y (F) on a menu entry shows its description on the feedback line and a cursor move clears it', async () => {
    // WRONG IMPL KILLED: a Y that is not routed to the menu, one that shows the entry title or
    // another entry's text, a feedback line that survives a move, and a Y that also activates.
    await bootAtMenu(2);
    expect(feedbackText(), 'control: nothing is shown before Y').toBe('');
    const y = tap('KeyF', 1400);
    expect(y.defaultPrevented, 'the consumed Y press is prevented').toBe(true);
    expect(feedbackText()).toBe(EN['menu.journal.desc']);
    expect(feedbackText()).toBe('Review your quests and their progress.');
    expect(journalShown(), 'Y does not open the entry').toBe(false);
    expect(navActive(), 'Y does not move the cursor').toBe('journal');

    tap('ArrowDown', 1500);
    expect(feedbackText(), 'a move clears the line').toBe('');
    tap('KeyF', 1600);
    expect(feedbackText()).toBe(EN['menu.social.desc']);
  });

  it('CTL5-5-MAIN-TICK-REPEAT: a held ArrowDown moves the cursor once at the press, again 350 ms later, then every 100 ms from the frame loop, clamps at Close, and stops on release; OS key-repeat drives nothing', async () => {
    // WRONG IMPL KILLED: a frame loop that never ticks the router (a held key never repeats), a
    // first repeat at 349 or 351 ms, an interval of 99 or 101 ms, a repeat that wraps from Close
    // to Monsters (repeat edges clamp), a repeat that outlives the release, a repeat driven by the
    // OS key-repeat keydown, and a held D-pad that also walks the character.
    await bootAtMenu();
    const t0 = 2000;
    fire('keydown', 'ArrowDown', t0);
    expect(navActive(), 'the press itself moves one entry').toBe('bag');
    fire('keydown', 'ArrowDown', t0 + 100, { init: { repeat: true } });
    fire('keydown', 'ArrowDown', t0 + 200, { init: { repeat: true } });
    expect(navActive(), 'OS key-repeat moves nothing').toBe('bag');

    const schedule: ReadonlyArray<readonly [number, string]> = [
      [349, 'bag'],
      [350, 'journal'],
      [449, 'journal'],
      [450, 'social'],
      [549, 'social'],
      [550, 'profile'],
      [649, 'profile'],
      // uif-15c (named intentional change, UIF15C.1): the walk continues Help (650), Controls (750)
      // because the root has two more entries before Close. Was: [650, 'options'] then the
      // release at +660 stood on Options.
      [650, 'help'],
      [749, 'help'],
      [750, 'controls'],
    ];
    for (const [dt, expected] of schedule) {
      frame(t0 + dt);
      expect(navActive(), `${dt} ms after the press`).toBe(expected);
    }

    fire('keyup', 'ArrowDown', t0 + 760);
    frame(t0 + 850);
    frame(t0 + 2000);
    expect(navActive(), 'a released key stops repeating').toBe('controls');

    // A fresh hold from Controls: the press steps onto Close, then repeat edges clamp there.
    const t1 = t0 + 3000;
    fire('keydown', 'ArrowDown', t1);
    expect(navActive()).toBe('close');
    frame(t1 + 349);
    frame(t1 + 350);
    expect(navActive(), 'a repeat at the last entry clamps (a fresh press would wrap)').toBe(
      'close',
    );
    frame(t1 + 450);
    frame(t1 + 1000);
    expect(navActive()).toBe('close');
    fire('keyup', 'ArrowDown', t1 + 1010);
    expect(H.sends, 'a held D-pad under the menu walks nothing').toHaveLength(0);

    // A fresh press after the clamp wraps (contrast).
    fire('keydown', 'ArrowDown', t1 + 2000);
    expect(navActive(), 'a fresh press wraps').toBe('monsters');
    fire('keyup', 'ArrowDown', t1 + 2005);
  });

  it('CTL5-1-MAIN-FR: under fr the menu title, entries, sub-list and descriptions render the French catalog text, not the English', async () => {
    // WRONG IMPL KILLED: titles resolved once in English or hard-coded English literals (today's
    // defect: MENU_TREE titles, 'Menu' and the back hints were English under fr), a sub-list that
    // falls back to English, a breadcrumb that is not the translated Menu, and a feedback line
    // that is not translated.
    await bootReady('/?locale=fr');
    expect(document.documentElement.lang, 'precondition: the fr locale was negotiated').toBe('fr');
    expect(FR['menu.monsters.title'], 'fixture: fr differs from en').not.toBe(
      EN['menu.monsters.title'],
    );
    server(1000);
    tap('KeyM', 1010);
    expect(menuShown()).toBe(true);

    expect(menuTitle()).toBe(FR['menu.title']);
    expect(optionTexts()).toEqual(ROOT_KEYS.map((k) => FR[`menu.${k}.title`]));
    expect(optionTexts(), 'not the English labels').not.toEqual(
      ROOT_KEYS.map((k) => EN[`menu.${k}.title`]),
    );

    tap('KeyF', 1100);
    expect(feedbackText(), 'the description is French too').toBe(FR['menu.monsters.desc']);

    // uif-15b (UIF15B.1, named intentional change): the sub-list that proves French is Profile
    // (Social is a root leaf with no sub-list). Was: Social's Trades, Challenges, Rankings.
    // uif-16b (UIF16B.1, named intentional change): Profile is a root leaf too (one frame, no
    // sub-list), so the sub-list that proves French was Options (Help, Controls).
    // uif-15c (UIF15C.1, named intentional change): Options is gone, no sub-list remains; Help and
    // Controls are root entries (already French in the optionTexts check above), so the French
    // proof past the first entry is Y on Help, five Downs from Monsters. Was: five Downs onto
    // Options, Enter, the French sub-list rows, title menu.options.title, the crumb [menu.title]
    // and the menu.options.help.desc line.
    for (let i = 0; i < 5; i += 1) tap('ArrowDown', 1200 + i * 100);
    expect(navActive()).toBe('help');
    tap('KeyF', 1800);
    expect(feedbackText()).toBe(FR['menu.help.desc']);
    expect(menuCrumbs(), 'no breadcrumb at the one level').toEqual([]);
  });

  it('UIF15C.1 the menu is one flat level of eight rows in order, Close last, with no Options row and no menuOptions element; A on Help opens helpView and A on Controls opens controlsView above the menu, B returns to the same root row, and Escape closes the whole menu', async () => {
    // uif-15c (named intentional change, UIF15C.1): replaces "a sub-list is a level inside the one
    // menu frame" (A enters Options, A on a child opens it, B backs out a level, Escape closes):
    // Options is gone, so Help and Controls are root rows, A on one opens its screen straight away
    // and B returns to the root row (no sub-list level to back out of). Was: Options' sub-list,
    // `menuOptions-root-*` ids, title menu.options.title and the crumb ['Menu'].
    // WRONG IMPL KILLED: a root that still carries an Options row or group (the row list is not
    // the eight), a sub-list frame id `menuOptions*` left in the DOM, Help or Controls that are not
    // wired as open leaves (A does nothing or lands in a sub-list), a B from a child that lands on
    // a stale group level (the title would read Options and a crumb would be painted), and an
    // Escape that only pops a level.
    await bootAtMenu();
    const rowIds = Array.from(rowsEl().querySelectorAll('[id^="menu-root-"]')).map((r) => r.id);
    expect(rowIds, 'eight root rows in order').toEqual(ROOT_KEYS.map((k) => `menu-root-${k}`));
    expect(rowIds[rowIds.length - 1], 'Close is last').toBe('menu-root-close');
    expect(optionTexts()).toEqual(ROOT_KEYS.map((k) => EN[`menu.${k}.title`]));
    expect(optionTexts(), 'no Options row').not.toContain('Options');
    expect(document.querySelector('[id^="menuOptions"]'), 'no menuOptions element').toBeNull();
    expect(menuTitle()).toBe(EN['menu.title']);
    expect(menuCrumbs(), 'no breadcrumb').toEqual([]);

    for (let i = 0; i < 5; i += 1) tap('ArrowDown', 1100 + i * 100);
    expect(navActive()).toBe('help');
    expect(cursor()).toBe('menu-root-help');
    tap('Enter', 1700);
    expect(stackNames(), 'A on Help opens helpView straight above the menu').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);
    tap('Backspace', 1800);
    expect(stackNames(), 'B closes only the Help screen').toEqual(['world', 'menuView']);
    expect(navActive(), 'back on the Help entry').toBe('help');
    expect(cursor()).toBe('menu-root-help');
    expect(menuTitle(), 'the root level').toBe(EN['menu.title']);

    tap('ArrowDown', 1900);
    expect(navActive()).toBe('controls');
    expect(cursor()).toBe('menu-root-controls');
    tap('Enter', 2000);
    expect(menuShown(), 'the menu stays open beneath it').toBe(true);
    expect(stackNames(), 'A on Controls opens controlsView above the menu').toEqual([
      'world',
      'menuView',
      'controlsView',
    ]);

    tap('Backspace', 2100);
    expect(stackNames(), 'B closes the child').toEqual(['world', 'menuView']);
    expect(navActive(), 'back on the Controls entry').toBe('controls');
    expect(cursor()).toBe('menu-root-controls');
    expect(menuCrumbs(), 'still no breadcrumb').toEqual([]);
    expect(document.querySelector('[id^="menuOptions"]')).toBeNull();

    tap('Enter', 2200);
    tap('Escape', 2300);
    expect(menuShown(), 'Escape closes the whole menu').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('UIF15C.3 the Close rule: A on Close then Start reopens the menu on Monsters; B with the cursor on Controls then Start reopens it on Controls; Up-wrapping to Close then B then Start reopens on Monsters', async () => {
    // WRONG IMPL KILLED: a reopen that restores the remembered Close cursor (the player lands on
    // the leave-the-menu row and a stray A closes it again), a rule that resets EVERY cursor to the
    // first entry (Controls would come back as Monsters), a rule that fires only for A on Close
    // (the Up-wrap-then-B route still reopens on Close), and a B that moves the cursor off the row
    // it was on.
    await bootAtMenu(7);
    expect(navActive(), 'precondition: the cursor is on Close').toBe('close');
    tap('Enter', 1900);
    expect(menuShown(), 'precondition: A on Close closed the menu').toBe(false);
    tap('Escape', 2000);
    expect(menuShown(), 'Start reopens the menu').toBe(true);
    expect(cursor(), 'on the first entry, not Close').toBe('menu-root-monsters');
    expect(navActive()).toBe('monsters');

    for (let i = 0; i < 6; i += 1) tap('ArrowDown', 2100 + i * 100);
    expect(navActive(), 'precondition: the cursor is on Controls').toBe('controls');
    tap('Backspace', 2800);
    expect(menuShown(), 'precondition: B closed the menu').toBe(false);
    tap('Escape', 2900);
    expect(menuShown()).toBe(true);
    expect(cursor(), 'a non-Close cursor is remembered').toBe('menu-root-controls');
    expect(navActive()).toBe('controls');

    // Up-wrap route: walk to Monsters, one Up wraps onto Close, B closes, Start reopens.
    for (let i = 0; i < 6; i += 1) tap('ArrowUp', 3000 + i * 100);
    expect(navActive(), 'precondition: the cursor is on Monsters').toBe('monsters');
    tap('ArrowUp', 3700);
    expect(navActive(), 'precondition: Up wrapped onto Close').toBe('close');
    tap('Backspace', 3800);
    expect(menuShown(), 'precondition: B closed the menu').toBe(false);
    tap('Escape', 3900);
    expect(menuShown()).toBe(true);
    expect(cursor(), 'the wrapped-onto-Close cursor is not restored').toBe('menu-root-monsters');
  });

  it('UIF15B.5 every root leaf (Monsters, Inventory, Journal, Social, Profile) opens from the root and B returns to the menu root with the cursor on that same entry; a second B closes the menu', async () => {
    // WRONG IMPL KILLED: a leaf whose B closes the whole menu (the child's pop takes the menu with
    // it); a return that lands on the first entry or on the group-less default (the cursor is
    // forgotten across the child); a Social leaf whose B lands in a Social sub-list (the old
    // two-level detour: the title would read Social with a Menu crumb); a menu left covered or
    // hidden after the return; a leaf list that is a literal here instead of the table's `open`
    // rows (a new root leaf would escape the check: the ANTI-VACUITY count pins the roster).
    const leaves = MENU_ENTRIES.filter((e) => e.kind === 'open').map((e) => e.key);
    // uif-16b (named intentional change): 4 -> 5 root leaves: profile joined (one Profile frame,
    // no sub-list, UIF16B.1).
    // uif-15c (named intentional change, UIF15C.1): 5 -> 7 root leaves: help and controls joined
    // as open entries (no Options group). Was: [..., 'profile'].
    expect(leaves, 'ANTI-VACUITY: the root leaves, from the table').toEqual([
      'monsters',
      'bag',
      'journal',
      'social',
      'profile',
      'help',
      'controls',
    ]);
    await bootAtMenu();
    let at = 1200;
    const step = (code: string): void => {
      tap(code, at);
      at += 100;
    };
    let checked = 0;
    for (const key of leaves) {
      for (let i = 0; i < 8 && navActive() !== key; i += 1) step('ArrowDown');
      expect(navActive(), `${key}: precondition: the cursor is on it`).toBe(key);
      step('Enter');
      expect(stackNames().length, `${key}: A opened exactly one frame above the menu`).toBe(3);
      expect(stackNames().slice(0, 2), `${key}: over the menu`).toEqual(['world', 'menuView']);
      step('Backspace');
      expect(stackNames(), `${key}: B closed only the child`).toEqual(['world', 'menuView']);
      expect(menuShown(), `${key}: the menu shows again`).toBe(true);
      expect(
        (document.getElementById('menu-overlay') as HTMLElement).style.visibility,
        `${key}: uncovered`,
      ).not.toBe('hidden');
      expect(navActive(), `${key}: the cursor is on the same entry`).toBe(key);
      expect(cursor(), `${key}: the menu paints it`).toBe(`menu-root-${key}`);
      expect(menuTitle(), `${key}: the root level, not a sub-list`).toBe('Menu');
      expect(menuCrumbs(), `${key}: no breadcrumb`).toEqual([]);
      checked += 1;
    }
    // uif-16b (named intentional change): 4 -> 5 leaves driven (profile joined).
    // uif-15c (named intentional change, UIF15C.1): 5 -> 7 leaves driven (help, controls joined).
    expect(checked, 'ANTI-VACUITY: all seven leaves were driven').toBe(7);
    expect(socialRootShown(), 'the Social root is closed after its B').toBe(false);

    step('Backspace');
    expect(menuShown(), 'B at the menu root closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('an Enter that nav consumed does not activate the child through its OS key-repeat: the repeat keydowns are prevented until that key is released, and only that key', async () => {
    // WRONG IMPL KILLED (plan A2): a held Enter whose repeats fall through to the child's focused
    // button (the claim overlay's sign-in button would be activated by the same press that opened
    // it), a prevent-all-repeats-of-Enter rule that outlives the keyup, and one that prevents the
    // repeats of keys nav never consumed.
    await bootAtMenu(2);
    const button = document.createElement('button');
    // ctl-11b: inside #game-screen, where a child's buttons live; focus on a body-level control
    // outside it leaves every key to the browser (CTL11B.1).
    (document.getElementById('game-screen') ?? document.body).appendChild(button);
    button.focus();

    fire('keydown', 'Enter', 1400);
    expect(journalShown(), 'precondition: the press opened the child').toBe(true);
    const repeat1 = fire('keydown', 'Enter', 1450, { target: button, init: { repeat: true } });
    expect(repeat1.defaultPrevented, 'the OS repeat of a nav-consumed Enter is prevented').toBe(
      true,
    );
    const repeat2 = fire('keydown', 'Enter', 1500, { target: button, init: { repeat: true } });
    expect(repeat2.defaultPrevented, 'and every later repeat').toBe(true);

    // Control: a repeat of a code nav never consumed is left alone.
    const other = fire('keydown', 'KeyZ', 1510, { target: button, init: { repeat: true } });
    expect(other.defaultPrevented, 'an unconsumed key keeps its default').toBe(false);

    fire('keyup', 'Enter', 1600);
    const after = fire('keydown', 'Enter', 1700, { target: button, init: { repeat: true } });
    expect(after.defaultPrevented, 'after the keyup the rule is gone').toBe(false);
  });

  // uif-16b (named intentional change): "Profile > Privacy from the menu opens the privacy overlay"
  // and "Profile > Account opens the claim overlay over the menu" are REPLACED by the two UIF16B
  // cases below: Profile has no sub-list, A on it opens ONE frame (`profileView`) holding all three
  // sections, and B / Start close that frame. The overlay-verdict pin of the first (the open menu
  // must not refuse the child) is kept by the UIF16B.1 case: one A must open the frame.

  it('UIF16B.1 A on Profile opens ONE frame above the menu with no second A: the stack ends menuView then profileView, the frame and its Name, Account and Privacy sections are all shown, and the menu stays on Profile beneath it', async () => {
    // WRONG IMPL KILLED: a Profile entry that is still a group (A enters a sub-list: the stack stays
    // [world, menuView] and the cursor reads `name`); a leaf that opens one section alone (the old
    // renameView / claimView / privacyView frame ids, or a frame with the other sections hidden);
    // an `overlayVerdict` that does not filter the open menu out (the GUARD_ONLY menu refuses the
    // child and A on Profile does nothing); and a menu cursor reset by the open.
    await bootAtMenu(4);
    expect(navActive(), 'precondition: the cursor is on Profile').toBe('profile');
    expect(stackNames(), 'precondition: no child yet').toEqual(['world', 'menuView']);

    tap('Enter', 1500);
    expect(stackNames(), 'one A: the Profile frame above the menu').toEqual([
      'world',
      'menuView',
      'profileView',
    ]);
    expect(
      ['profile-overlay', 'rename-overlay', 'claim-overlay', 'privacy-overlay'].map(shownById),
      'the frame and its three sections are shown together',
    ).toEqual([true, true, true, true]);
    const frameRoot = document.getElementById('profile-overlay') as HTMLElement;
    expect(
      ['rename-overlay', 'claim-overlay', 'privacy-overlay'].map((id) =>
        frameRoot.contains(document.getElementById(id)),
      ),
      'every section lives inside the one frame',
    ).toEqual([true, true, true]);
    expect(menuShown(), 'the menu stays open beneath it').toBe(true);
    expect(navActive(), 'with its cursor on Profile').toBe('profile');
    expect(cursor()).toBe('menu-root-profile');
  });

  it('UIF16B.2 B on the Profile frame pops it back to the menu with the cursor on Profile (uncovered, at the root); Start (Escape) pops the frame and the menu together', async () => {
    // WRONG IMPL KILLED: a B that does not pop the frame, a B that pops the menu with it, a return
    // that lands on the first entry or inside a stale Profile sub-list (the menu title and cursor id
    // would name `menuProfile`), a menu left covered, an Escape that closes only the frame, and a
    // frame left on screen behind a closed stack.
    await bootAtMenu(4);
    tap('Enter', 1500);
    expect(stackNames(), 'precondition: Profile is above the menu').toEqual([
      'world',
      'menuView',
      'profileView',
    ]);

    tap('Backspace', 1600);
    expect(stackNames(), 'B pops the frame back to the menu').toEqual(['world', 'menuView']);
    expect(shownById('profile-overlay'), 'the frame is closed').toBe(false);
    expect(menuShown()).toBe(true);
    expect(
      (document.getElementById('menu-overlay') as HTMLElement).style.visibility,
      'and the menu is uncovered',
    ).not.toBe('hidden');
    expect(navActive(), 'the cursor is on Profile').toBe('profile');
    expect(cursor(), 'on the root row').toBe('menu-root-profile');
    expect(menuTitle(), 'at the root level').toBe(EN['menu.title']);

    tap('Enter', 1700);
    expect(stackNames(), 'precondition: Profile is above the menu again').toEqual([
      'world',
      'menuView',
      'profileView',
    ]);
    tap('Escape', 1800);
    expect(stackNames(), 'Start pops the frame and the menu together').toEqual(['world']);
    expect(menuShown(), 'the menu is closed').toBe(false);
    expect(
      ['profile-overlay', 'rename-overlay', 'claim-overlay', 'privacy-overlay'].map(shownById),
      'and so are the frame and every section',
    ).toEqual([false, false, false, false]);
  });

  it('UIF16B.3 a screen opened over the menu is announced: after A on Profile and the 500 ms live-region window, #a11y-live reads the one Profile frame`s label, not the menu label', async () => {
    // uif-16b (named intentional change): was "after A on Profile > Account ... reads the claim
    // label": the frame announced is the one Profile dialog (its single title), not a section.
    // WRONG IMPL KILLED: an announcement top derived from the overlay registry order alone (a
    // registry-first pick lands on the covered menu beneath the child instead of the screen the
    // player is actually on), and a frame that announces nothing (no a11y record of its own).
    await bootAtMenu(4);
    tap('Enter', 1500);
    expect(stackNames(), 'precondition: Profile is above the menu').toEqual([
      'world',
      'menuView',
      'profileView',
    ]);
    const profileLabel = t(OVERLAY_A11Y.profileView.labelKey);
    const menuLabel = t(OVERLAY_A11Y.menuView.labelKey);
    expect(profileLabel, 'fixture: the two labels differ').not.toBe(menuLabel);

    // Frames spaced past the 500 ms live-region window (ui/liveRegion.ts flush).
    for (const at of [2300, 2900, 3500, 4100]) frame(at);
    const region = document.getElementById('a11y-live');
    expect(region, '#a11y-live must exist (client/index.html)').not.toBeNull();
    expect(region?.textContent).toBe(profileLabel);
    expect(region?.textContent).not.toBe(menuLabel);
  });

  it('UIF15C.1 a held ArrowDown does not keep scrolling the menu under the screen that Enter just opened: Down held onto Help, Enter opens helpView, and frames move nothing', async () => {
    // uif-15c (named intentional change, UIF15C.1): replaces "a level change resets the repeat"
    // (Down held onto Options, Enter entered its sub-list on Help, no scroll without a new press).
    // No menu level exists any more, so the repeat reset that remains is the child push: Enter on
    // Help opens helpView and the Down still held must not scroll the covered menu. Was: Options'
    // sub-list, cursor id `menuOptions-root-help`, and a fresh press moving to Controls in it.
    // WRONG IMPL KILLED: a push that does not reset the router's repeat (the Down still held keeps
    // scrolling the covered menu: Help drifts onto Controls with no new press).
    await bootAtMenu(4);
    expect(navActive(), 'precondition: the cursor is on Profile').toBe('profile');
    const t0 = 2000;
    fire('keydown', 'ArrowDown', t0);
    expect(navActive(), 'the held Down moved onto Help').toBe('help');
    fire('keydown', 'Enter', t0 + 100);
    expect(stackNames(), 'Enter (Down still held) opened helpView').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);

    for (const dt of [349, 350, 449, 450, 550, 1000]) {
      frame(t0 + dt);
      expect(navActive(), `${dt} ms after the Down press, with no new press`).toBe('help');
    }

    // Contrast: after the screen closes, a fresh press still moves the cursor.
    fire('keyup', 'ArrowDown', t0 + 1100);
    fire('keyup', 'Enter', t0 + 1105);
    tap('Backspace', t0 + 1150);
    expect(stackNames(), 'precondition: B closed helpView').toEqual(['world', 'menuView']);
    fire('keydown', 'ArrowDown', t0 + 1200);
    expect(navActive(), 'a new press moves').toBe('controls');
    fire('keyup', 'ArrowDown', t0 + 1205);
  });

  it('a held D-pad does not repeat into a re-opened menu: Down held at the menu, Escape closes it, KeyM reopens it, and a second of frames moves nothing', async () => {
    // WRONG IMPL KILLED: a syncStack that does not reset the router's repeat on a stack push/pop
    // (the schedule armed under the first menu survives the close, and the reopened menu scrolls
    // by itself the moment the nav frame is uncovered again).
    await bootAtMenu();
    const t0 = 2000;
    fire('keydown', 'ArrowDown', t0);
    expect(navActive(), 'the held Down moved onto Bag').toBe('bag');
    tap('Escape', t0 + 100);
    expect(menuShown(), 'precondition: Escape closed the menu (Down is still held)').toBe(false);
    tap('KeyM', t0 + 200);
    expect(menuShown(), 'precondition: M reopened the menu').toBe(true);
    expect(navActive(), 'precondition: the cursor is on the last entry used').toBe('bag');

    for (let dt = 300; dt <= 1300; dt += 100) {
      frame(t0 + dt);
      expect(navActive(), `${dt} ms after the press, Down still held`).toBe('bag');
    }
    fire('keyup', 'ArrowDown', t0 + 1400);
  });

  it('POLISH1-P5-MENU-ANNOUNCES: Y on a menu entry announces its description through #a11y-live once, a repeat Y on the same entry is not announced again, another entry`s Y is, and the same entry`s Y after the line was cleared is', async () => {
    // EARS: WHEN a menu entry's Y description ... is rendered, THE CLIENT SHALL announce it through
    // the live region, once per change. The feedback line stays a non-live node (CTL5-4-MAIN-Y reads
    // it as text); `#a11y-live` is the page's one live region, fed by liveRegion.announce(text, now).
    //
    // WRONG IMPL KILLED: the current silence (the description shows on the line only: a screen-reader
    // user hears nothing after Y); an announcement made on EVERY menu step that carries feedback (a
    // repeat Y, or any key that repaints, would re-announce the same line: counted below by the
    // announce calls, because the region's own dedup hides a repeat from the DOM); one that
    // announces the entry TITLE or another entry's text; a cursor move that announces its cleared
    // (empty) line; a "once ever" latch (Y after a move away and back must announce again); and an
    // announcement timed off anything but performance.now().
    await bootAtMenu(2);
    expect(navActive(), 'precondition: the cursor is on Journal').toBe('journal');
    const liveRegionModule = await import('./ui/liveRegion');
    const announce = vi.spyOn(liveRegionModule.LiveRegion.prototype, 'announce');
    const region = (): string => document.getElementById('a11y-live')?.textContent ?? '';
    const callsWith = (text: string): unknown[][] =>
      announce.mock.calls.filter(([message]) => message === text);
    const journalDesc = EN['menu.journal.desc'];
    const socialDesc = EN['menu.social.desc'];
    expect(journalDesc, 'fixture: the Journal description is real text').toBeTruthy();
    expect(socialDesc, 'fixture: the Social description is real text').toBeTruthy();
    expect(journalDesc).not.toBe(socialDesc);

    // Let the menu's own open announcement land first (frames past the 500 ms window), so the Y
    // description is not coalesced into it.
    frame(1300);
    frame(1900);
    expect(document.getElementById('a11y-live'), '#a11y-live must exist').not.toBeNull();
    expect(
      region(),
      'precondition: the open announcement landed and is not the description',
    ).not.toBe(journalDesc);

    // Y on Journal.
    tap('KeyF', 2000);
    expect(feedbackText(), 'precondition: Y shows the description on the line').toBe(journalDesc);
    expect(
      callsWith(journalDesc),
      'Y announces the description once, stamped with performance.now()',
    ).toEqual([[journalDesc, 2000]]);
    frame(2600);
    expect(region(), 'after the 500 ms window #a11y-live reads the description').toBe(journalDesc);

    // A repeat Y with no move: the same visible line, so no second announcement.
    tap('KeyF', 2700);
    expect(feedbackText()).toBe(journalDesc);
    frame(3300);
    expect(callsWith(journalDesc), 'a repeat Y is not announced again').toHaveLength(1);
    expect(region()).toBe(journalDesc);

    // A move clears the line (nothing to announce), and Y on another entry announces its own text.
    tap('ArrowDown', 3400);
    expect(navActive()).toBe('social');
    expect(feedbackText(), 'a move clears the line').toBe('');
    tap('KeyF', 3500);
    expect(feedbackText()).toBe(socialDesc);
    expect(callsWith(socialDesc), 'the new entry`s description is announced once').toEqual([
      [socialDesc, 3500],
    ]);
    frame(4100);
    expect(region()).toBe(socialDesc);

    // Back to Journal and Y again: the line was cleared in between, so this is a new change.
    tap('ArrowUp', 4200);
    expect(navActive()).toBe('journal');
    expect(feedbackText()).toBe('');
    tap('KeyF', 4300);
    expect(callsWith(journalDesc), 'Y after a clear is announced again').toEqual([
      [journalDesc, 2000],
      [journalDesc, 4300],
    ]);
    frame(4900);
    expect(region()).toBe(journalDesc);

    // Clearing the line (a cursor move) is never announced as an empty message.
    expect(callsWith(''), 'no empty announcement').toEqual([]);
  });
});
