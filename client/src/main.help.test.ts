// @vitest-environment happy-dom
/**
 * main.help.test.ts: How to Play through a booted main.ts (uif-14, UIF14.1 / UIF14.4 / UIF14.5 /
 * UIF14.6). Select (or Options > How to play) opens Help on Introduction with two tabs; RB shows the
 * Encyclopedia, a D-pad list of sixteen terms; A opens an entry's detail as a modal sheet over the list,
 * B closes the sheet back to the same entry and the next B closes Help; the tab change and the opened
 * entry are announced through the page's live region.
 *
 * INTENTIONAL CHANGE (uif-14): the ctl-14 cases that read `#help-screen` (the hint-bar chips of the
 * context beneath Help), the 24 All controls rows, the three goals and the keys-vs-buttons note are
 * RETIRED with those tabs (Help no longer lists chips, so the battle / deploy / trade-request chip
 * cases that only differed in that list went too). What stays: Select / Escape / the Select chip open
 * and close it, a remap moves the key, Options > How to play, and a reopen starts over.
 *
 * SOURCE OF TRUTH: specs/monster-realm-v2/M-ui-foundation.spec.md §uif-14;
 * memory/projects/monster-realm-uif-14-plan.md (`main.ts`: `openHelp()` renders
 * `buildHelpViewModel()` with no arguments; `new HelpView({ announce: announceNow })`).
 *
 * DOM CONTRACT read here (see helpView.test.ts for the unit-level statement of it): the tab strip is
 * `#help-tabs` (role=tablist) of two role=tab; the panels are `#help-intro` (two <p>) and
 * `#help-encyclopedia` (sixteen `[data-nav-key]` rows, the cursor `.is-active`), the inactive one
 * `hidden`; the detail is the `[data-context-sheet]` inside #help-overlay. Live-region text is read from
 * `#a11y-live` after a frame pumps the coalescing window (ui/liveRegion.ts: trailing edge, 500 ms).
 *
 * Harness: main.hintBar.test.ts's pattern, copied (vi.resetModules + a fresh import per boot, the
 * real client/index.html shell, one controllable clock and rAF, a stubbed wasm pkg and SDK
 * connection). A stored remap is the boot-time path (`mr.controls` in localStorage).
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
import { DEFAULT_BINDINGS } from './input/bindings';
import type { ConnectionOptions } from './net/connection';
import type { StoreBattle, StoreBattleMonster } from './net/store';
import { t as i18nT } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
}));

// bt-12 B (named intentional change, BT12.2 / R-bt-12-DEPLOYHINT): the factory gains the 16
// `tactics_*` exports the rules port binds (`bindTacticsRules` refuses a pkg missing any), so a
// Deploying battle's deploy panel can render here; nothing else in this file reads them.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => ({
  ...wasmPkgWalkingMock({ interact: (...args: unknown[]) => H.interact(...args) }),
  tactics_map: () => ({
    width: 7,
    height: 5,
    tiles: [],
    spawn_a: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    spawn_b: [],
  }),
  tactics_fresh_budget: () => ({ ap: 6, strides_used: 0, attacks: 0, last: null }),
  tactics_unit: (row: unknown) => row,
  tactics_targets: () => ({ Ok: [] }),
  tactics_path: () => ({ Err: 'Unreachable' }),
  tactics_disengage: () => ({ Ok: false }),
  tactics_flank: () => false,
  tactics_forecast: () => ({}),
  tactics_recruit_odds: () => ({ Err: { UnknownUnit: { id: 0 } } }),
  tactics_ai_plan: () => [],
  tactics_recruit_targets: () => [],
  tactics_is_exhausted: () => false,
  tactics_plan: () => ({ Err: 'ZeroStrides' }),
  tactics_overlays: () => ({
    reach1: [],
    reach2: [],
    range: [],
    aoe: [],
    danger: [],
    shield: [],
    intents: [],
  }),
  tactics_tuning: () => ({ surge_start_round: 9, wild_round_cap: 30, max_pack: 3 }),
  tactics_next_initiative: () => [],
}));

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

const STORAGE_KEY = 'mr.controls';

/** Boot a fresh main.ts; `stored` is written to `mr.controls` BEFORE the import (a saved table). */
async function bootReady(stored?: string): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.interact = () => [];
  T = 1000;
  clock.t = T;
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(STORAGE_KEY, stored);
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
  opts.onReady(H.identity);
}

function frame(ms = 50): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = next(ms);
  cb(clock.t);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

const EID = 7n;

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

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
}
interface GameHook {
  readonly stack: FrameJson[];
  readonly navActive: string | null;
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
const stackNames = (): string[] =>
  game().stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

/** A stored `mr.controls` table: the defaults with `change` applied. */
const storedTable = (
  change: (raw: { buttons: Record<string, string[]>; accels: Record<string, string[]> }) => void,
): string => {
  const raw = JSON.parse(
    JSON.stringify({ buttons: DEFAULT_BINDINGS.buttons, accels: DEFAULT_BINDINGS.accels }),
  );
  change(raw);
  return JSON.stringify({ v: 1, ...raw });
};

// --- what a player sees of Help ---------------------------------------------------------------
const helpOverlay = (): HTMLElement => {
  const el = document.getElementById('help-overlay');
  if (el === null) throw new Error('index.html ships #help-overlay');
  return el;
};
const helpOpen = (): boolean => helpOverlay().style.display !== 'none';
const part = (selector: string): HTMLElement => {
  const el = helpOverlay().querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`Help has no ${selector}`);
  return el;
};
/** Out of sight by `hidden` or `display:none`, on the node or any ancestor; a missing node is hidden. */
function isHidden(start: Element | null): boolean {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none') return true;
  }
  return !(start instanceof HTMLElement);
}
/** The tab strip as read: { label, selected }. */
const tabsNow = (): Array<{ label: string; selected: boolean }> =>
  Array.from(helpOverlay().querySelectorAll('[role="tablist"] [role="tab"]')).map((el) => ({
    label: el.textContent ?? '',
    selected: el.getAttribute('aria-selected') === 'true',
  }));
const activeTab = (): string | undefined => tabsNow().find((x) => x.selected)?.label;
/** The Encyclopedia's rows as text, in order. */
const rowTexts = (): string[] =>
  Array.from(part('#help-encyclopedia').querySelectorAll('[data-nav-key]')).map(
    (r) => r.textContent ?? '',
  );
/** The key of the Encyclopedia row carrying the cursor. */
const cursorKey = (): string | null =>
  part('#help-encyclopedia').querySelector('.is-active')?.getAttribute('data-nav-key') ?? null;
/** The detail sheet: the one [data-context-sheet] in Help (shown or not). */
const sheet = (): HTMLElement => part('[data-context-sheet]');
const sheetOpen = (): boolean => !isHidden(sheet());
const sheetTitle = (): string => sheet().querySelector('.mr-sheet-title')?.textContent ?? '';
const sheetProse = (): string => sheet().querySelector('.mr-sheet-prose')?.textContent ?? '';
/** What the live region says now (the node is re-parented into an open overlay; found by id). */
const liveText = (): string => document.getElementById('a11y-live')?.textContent ?? '';

/** A catalog message read through the test's own resolver (default English), by literal id. */
const say = (id: string): string => i18nT(id as never) as string;

const TITLE_INTRO = 'Introduction';
const TITLE_ENC = 'Encyclopedia';

/** Boot to the bare world and open Help with Select (KeyR). */
async function openHelp(stored?: string): Promise<void> {
  await bootReady(stored);
  batch();
  frame();
  press('KeyR');
  frame();
  expect(stackNames(), 'Select opened the help frame').toEqual(['world', 'helpView']);
  expect(helpOpen(), 'and showed the overlay').toBe(true);
}

describe('main.ts How to Play over the real shell (runtime, uif-14)', { sequential: true }, () => {
  afterEach(teardown);

  it('UIF14.1 Select opens How to Play on Introduction with exactly two tabs, Introduction selected and its two paragraphs shown, the Encyclopedia hidden, and none of the retired panels (#help-controls, #help-goals, #help-screen, #help-note); RB shows the Encyclopedia and LB returns', async () => {
    // WRONG IMPL KILLED: the old three-tab Help still booted (All controls kept: 110); an opening on
    // the Encyclopedia; a tab strip painted once at boot (the second open would keep the last tab);
    // both panels shown at once; RB / LB that never reach the screen (the page keeps them); the
    // retired DOM nodes still in the shell.
    expect(say('help.tab.intro'), 'fixture: the English title').toBe(TITLE_INTRO);
    expect(say('help.tab.encyclopedia'), 'fixture: the English title').toBe(TITLE_ENC);
    await openHelp();

    expect(
      tabsNow().map((x) => x.label),
      'exactly two tabs, the catalog titles',
    ).toEqual([TITLE_INTRO, TITLE_ENC]);
    expect(activeTab(), 'it opens on Introduction').toBe(TITLE_INTRO);
    expect(
      Array.from(part('#help-intro').querySelectorAll('p')).map((p) => p.textContent),
      'the two catalog paragraphs',
    ).toEqual([say('help.intro.p1'), say('help.intro.p2')]);
    expect(isHidden(part('#help-intro')), 'Introduction is shown').toBe(false);
    expect(isHidden(part('#help-encyclopedia')), 'the Encyclopedia is hidden').toBe(true);
    for (const id of ['help-controls', 'help-goals', 'help-screen', 'help-note']) {
      expect(document.getElementById(id), `#${id} is gone`).toBeNull();
    }

    press('KeyE'); // RB
    expect(stackNames(), 'RB is Help`s, not the page`s: Help stays open').toEqual([
      'world',
      'helpView',
    ]);
    expect(activeTab(), 'RB: the Encyclopedia').toBe(TITLE_ENC);
    expect(isHidden(part('#help-encyclopedia')), 'its panel is shown').toBe(false);
    expect(isHidden(part('#help-intro')), 'Introduction is hidden').toBe(true);
    expect(rowTexts(), 'sixteen rows').toHaveLength(16);

    press('KeyQ'); // LB
    expect(activeTab(), 'LB: back to Introduction').toBe(TITLE_INTRO);
    expect(stackNames(), 'the bumpers never closed Help').toEqual(['world', 'helpView']);
  }, 120_000);

  it('UIF14.4 on the Encyclopedia ArrowDown walks the sixteen terms (the cursor row .is-active), and the cursor is remembered per tab: Down three times, LB to Introduction, RB back, still the fourth term', async () => {
    // WRONG IMPL KILLED: a D-pad that never reaches the Help screen (the cursor never moves); a list
    // whose rows are not the terms; a cursor reset by the tab switch (the nav kit's per-tab memory
    // unused); a cursor that moves while Introduction is shown.
    await openHelp();
    press('KeyE');
    const terms = rowTexts();
    expect(terms, 'sixteen non-empty terms').toHaveLength(16);
    expect(
      terms.every((x) => x.trim() !== ''),
      'every row reads a term',
    ).toBe(true);
    expect(new Set(terms).size, 'all different').toBe(16);
    expect(cursorKey(), 'the cursor opens on the first entry').toBe('party');
    press('ArrowDown');
    expect(cursorKey(), 'Down: the second entry').toBe('storage');
    press('ArrowDown');
    press('ArrowDown');
    expect(cursorKey(), 'Down x3: the fourth entry').toBe('bait');
    press('KeyQ'); // LB
    expect(activeTab()).toBe(TITLE_INTRO);
    press('ArrowDown');
    press('KeyE'); // RB
    expect(activeTab()).toBe(TITLE_ENC);
    expect(cursorKey(), 'the cursor is remembered per tab').toBe('bait');
  }, 120_000);

  it('UIF14.5 A opens the entry under the cursor as a detail sheet over the still-rendered list (heading = its term, prose holds its definition), B closes the sheet with Help still open and the same entry active, and the next B closes Help; the tabs and the D-pad are inert while the sheet is up', async () => {
    // WRONG IMPL KILLED: an A that opens nothing, or the first entry whatever the cursor; a sheet
    // showing another entry's text; the list hidden or emptied under the modal; a B that closes
    // Help with the sheet (stack drops to the world); a close that resets the cursor to the first
    // entry (feedback 114); a close that leaves the sheet shown; an RB while the detail is open that
    // switches the tab behind the modal; a second B that does not pop.
    await openHelp();
    press('KeyE');
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    expect(cursorKey(), 'fixture: on the fourth entry').toBe('bait');
    const baitTerm = say('help.entry.bait.term');
    const baitDef = say('help.entry.bait.def');
    expect(sheetOpen(), 'precondition: no sheet yet').toBe(false);

    press('Enter'); // A
    expect(sheetOpen(), 'A opened the detail sheet').toBe(true);
    expect(sheet().dataset.sheetVariant, 'the detail variant').toBe('detail');
    expect(sheetTitle(), 'heading = the entry`s term').toBe(baitTerm);
    expect(sheetProse(), 'prose holds its definition').toContain(baitDef);
    expect(isHidden(part('#help-encyclopedia')), 'the list stays rendered behind it').toBe(false);
    expect(rowTexts(), 'with all sixteen rows').toHaveLength(16);
    expect(stackNames(), 'still the help frame').toEqual(['world', 'helpView']);

    press('KeyE'); // RB while the detail is up
    press('ArrowDown');
    expect(activeTab(), 'RB did nothing behind the modal').toBe(TITLE_ENC);
    expect(cursorKey(), 'nor did Down').toBe('bait');
    expect(sheetTitle(), 'and the sheet still names the same entry').toBe(baitTerm);

    press('Backspace'); // B
    expect(sheetOpen(), 'B closed the sheet').toBe(false);
    expect(helpOpen(), 'Help is still open').toBe(true);
    expect(stackNames(), 'the help frame is still on the stack').toEqual(['world', 'helpView']);
    expect(cursorKey(), 'the same entry is active').toBe('bait');
    expect(activeTab(), 'on the same tab').toBe(TITLE_ENC);
    expect(sheet().textContent, 'nothing the sheet named stays in the document').toBe('');

    press('Backspace'); // B again
    frame();
    expect(helpOpen(), 'the next B closes Help').toBe(false);
    expect(stackNames(), 'back to the bare world').toEqual(['world']);
  }, 120_000);

  it('UIF14.6 a tab change and an opened entry reach the live region: RB says the Encyclopedia title, A says the entry`s term, opening Help says neither', async () => {
    // WRONG IMPL KILLED: no announce handler wired into the view (R-ctl-14-HELPA11Y stays open: the
    // region keeps its old text); the tab announced as a key or a catalog id; the opening
    // Introduction announced on show (the region would read the tab on every open); the term never
    // announced; announcing only the first change. Each message is flushed through a frame past the
    // 500 ms coalescing window (ui/liveRegion.ts), so a missing pump would also red here.
    await openHelp();
    frame(600);
    expect(liveText(), 'opening Help does not announce the opening tab').not.toBe(TITLE_INTRO);

    press('KeyE'); // RB
    frame(600);
    expect(liveText(), 'RB: the new tab`s title').toBe(TITLE_ENC);

    press('ArrowDown');
    frame(600);
    expect(liveText(), 'a cursor move leaves the tab announcement as it was').toBe(TITLE_ENC);

    press('Enter'); // A on the second entry
    frame(600);
    expect(liveText(), 'A: the entry`s term').toBe(say('help.entry.storage.term'));

    press('Backspace'); // B closes the sheet
    frame(600);
    expect(liveText(), 'closing the sheet announces nothing new').toBe(
      say('help.entry.storage.term'),
    );

    press('KeyQ'); // LB
    frame(600);
    expect(liveText(), 'LB: the Introduction title').toBe(TITLE_INTRO);
  }, 120_000);

  it('Select closes Help (also with a detail open), and a reopen starts over on Introduction with no sheet; Escape closes it too', async () => {
    // WRONG IMPL KILLED: a Select that does not toggle over a detail (the sheet swallows it); a
    // reopen that resumes the last tab or the open detail (state kept in module state); an Escape
    // that leaves Help (or the stack) behind.
    await openHelp();
    press('KeyE');
    press('Enter');
    expect(sheetOpen(), 'precondition: a detail is open').toBe(true);
    press('KeyR'); // Select
    frame();
    expect(helpOpen(), 'Select closes Help even from a detail').toBe(false);
    expect(stackNames(), 'back to the bare world').toEqual(['world']);

    press('KeyR');
    frame();
    expect(helpOpen(), 'reopened').toBe(true);
    expect(activeTab(), 'a reopen starts on Introduction, not the last tab').toBe(TITLE_INTRO);
    expect(sheetOpen(), 'with no sheet').toBe(false);
    expect(isHidden(part('#help-intro'))).toBe(false);

    press('Escape');
    frame();
    expect(helpOpen(), 'Escape closes Help').toBe(false);
    expect(stackNames(), 'and leaves the bare world, not the menu').toEqual(['world']);
  }, 120_000);

  it('a saved Select remap moves the key: the old key opens nothing, the new key opens How to Play on Introduction and closes it again', async () => {
    // WRONG IMPL KILLED: a Select still opening on KeyR (the remap would be cosmetic); a Help that
    // only opens through the default key.
    await bootReady(
      storedTable((raw) => {
        raw.buttons.Select = ['KeyZ'];
      }),
    );
    batch();
    frame();
    press('KeyR');
    frame();
    expect(helpOpen(), 'the old Select key is unbound, nothing opens').toBe(false);
    press('KeyZ');
    frame();
    expect(helpOpen(), 'the new Select key opens Help').toBe(true);
    expect(activeTab()).toBe(TITLE_INTRO);
    press('KeyZ');
    frame();
    expect(helpOpen(), 'the new key also closes it').toBe(false);
  }, 120_000);

  it('Options > How to play opens the same Help over the menu: two tabs on Introduction, B closes only Help and the menu stays', async () => {
    // WRONG IMPL KILLED: a menu leaf that still opens an old Help; a B that closes the menu with it.
    await bootReady();
    batch();
    frame();
    press('Escape');
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    for (let i = 0; i < 8 && game().navActive !== 'options'; i += 1) press('ArrowDown');
    expect(game().navActive, 'precondition: the menu cursor is on options').toBe('options');
    press('Enter');
    expect(game().navActive, 'precondition: the Options list opens on How to play').toBe('help');
    press('Enter');
    frame();
    expect(stackNames(), 'How to play opened Help above the menu').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);
    expect(tabsNow().map((x) => x.label)).toEqual([TITLE_INTRO, TITLE_ENC]);
    expect(activeTab()).toBe(TITLE_INTRO);

    press('Backspace'); // B
    frame();
    expect(helpOpen(), 'B closes Help').toBe(false);
    expect(stackNames(), 'and only Help: the menu stays').toEqual(['world', 'menuView']);
  }, 120_000);

  it('clicking the Select chip opens the same two-tab Help as the key, and clicking it while Help is open closes it like Select does', async () => {
    // WRONG IMPL KILLED: a launcher path that opens a Help with no model rendered (empty panels); a
    // launcher that calls openHelp() unconditionally (a click on an open Help would re-render and
    // leave it open).
    await bootReady();
    batch();
    frame();
    (document.getElementById('chip-select') as HTMLElement).click();
    frame();
    expect(helpOpen(), 'the click opened Help').toBe(true);
    expect(tabsNow().map((x) => x.label)).toEqual([TITLE_INTRO, TITLE_ENC]);
    expect(part('#help-intro').querySelectorAll('p'), 'two paragraphs rendered').toHaveLength(2);
    expect(rowTexts(), 'the Encyclopedia is rendered too').toHaveLength(16);

    (document.getElementById('chip-select') as HTMLElement).click();
    frame();
    expect(helpOpen(), 'the second click closed Help').toBe(false);
    expect(stackNames(), 'back to the base').toEqual(['world']);
  }, 120_000);
});

// --- over a battle ---------------------------------------------------------------------------

const WILD_IDENTITY = '0'.repeat(64);
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
  statSpDefense: 5,
  statSpAttack: 5,
  knownSkillIds: [1],
  status: null,
};
/** A wild battle row for the booted player (main.accel.test.ts's fixture). */
function battleRow(battleId: bigint): StoreBattle {
  return {
    battleId,
    playerIdentity: H.identity,
    opponentIdentity: WILD_IDENTITY,
    outcome: 'Ongoing',
    turnNumber: 1,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [1n],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

describe('main.ts How to Play over a battle (uif-14)', { sequential: true }, () => {
  afterEach(teardown);

  it('over a bare battle, Select opens the same two-tab How to Play and the Encyclopedia detail opens and closes there; Select closes it and the battle stays', async () => {
    // WRONG IMPL KILLED: an openHelp that builds a Help from the world base only (nothing renders over
    // a battle), or a detail sheet that cannot open when a battle is the base.
    await bootReady();
    batch();
    opts.store.upsertBattle(battleRow(101n));
    batch();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    frame();
    expect(stackNames(), 'precondition: a bare battle base').toEqual(['battle']);
    press('KeyR');
    frame();
    expect(stackNames(), 'Select opened Help over the battle').toEqual(['battle', 'helpView']);
    expect(tabsNow().map((x) => x.label)).toEqual([TITLE_INTRO, TITLE_ENC]);
    press('KeyE');
    press('Enter');
    expect(sheetOpen(), 'a detail opens over the battle too').toBe(true);
    expect(sheetTitle()).toBe(say('help.entry.party.term'));
    press('Backspace');
    expect(sheetOpen(), 'B closes the sheet').toBe(false);
    expect(stackNames(), 'Help is still open').toEqual(['battle', 'helpView']);
    press('KeyR');
    frame();
    expect(stackNames(), 'Select closes it, the battle stays').toEqual(['battle']);
  }, 120_000);
});
