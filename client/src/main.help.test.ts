// @vitest-environment happy-dom
/**
 * main.help.test.ts: the GENERATED Help through a booted main.ts (ctl-14, CTL14.1). Select (or
 * Options > How to play) opens Help with the tabs This screen | All controls | Goals, generated from
 * the context table (`hintBar` over the screen BENEATH Help), the live binding table and the
 * catalog; LB / RB switch the tab and Select, B and Start close it.
 *
 * SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-14;
 * memory/projects/monster-realm-ctl-14-plan.md (`main.ts`: `openHelp()` = `helpView.render(
 * buildHelpViewModel(hintBar(beneath, bindings, notices, world), bindings)); helpView.show();
 * seatOpened('helpView')`, `beneath` the stack without the help frame).
 *
 * DOM CONTRACT read here (see helpView.test.ts for the unit-level statement of it): the panels are
 * `#help-screen` (This screen, created at runtime), `#help-controls` (All controls) and
 * `#help-goals` (Goals), one <li> per row; the tab strip is a `role="tablist"` of `role="tab"`s whose
 * active one is `aria-selected="true"`; only the active tab's panel is visible (the others carry
 * `hidden`). A tab's name is read from the strip, never from a literal.
 *
 * Harness: main.hintBar.test.ts's pattern, copied (vi.resetModules + a fresh import per boot, the
 * real client/index.html shell, one controllable clock and rAF, a stubbed wasm pkg and SDK
 * connection). A stored remap is the boot-time path (`mr.controls` in localStorage).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import { DEFAULT_BINDINGS } from './input/bindings';
import { VBUTTONS } from './input/buttons';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreBattle, StoreBattleMonster, StoreTradeOffer } from './net/store';
import { t as i18nT } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
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

const NPC_ENTITY = 11n;
/** A dialogue NPC on (3, 6) (the tile the player on (2, 6) facing East faces), which the stubbed
 *  wasm rule names as the faced candidate, in one batch. */
function seedFacedNpc(): void {
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
      (e: { kind?: unknown; id?: unknown }) => e.kind === 'npc' && e.id === NPC_ENTITY.toString(),
    );
    return at === -1 ? [] : [at];
  };
  batch();
}

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
const SCREEN_PANEL = '#help-screen';
const CONTROLS_PANEL = '#help-controls';
const GOALS_PANEL = '#help-goals';
const PANELS = [SCREEN_PANEL, CONTROLS_PANEL, GOALS_PANEL] as const;

const helpOverlay = (): HTMLElement => {
  const el = document.getElementById('help-overlay');
  if (el === null) throw new Error('index.html ships #help-overlay');
  return el;
};
const helpOpen = (): boolean => helpOverlay().style.display !== 'none';
const panelEl = (selector: string): HTMLElement => {
  const el = helpOverlay().querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`Help has no ${selector} panel`);
  return el;
};
/** The rows of a panel, as text, in order. */
const rowTexts = (selector: string): string[] =>
  Array.from(panelEl(selector).querySelectorAll('li')).map((li) => li.textContent ?? '');
/** The panels a player can see: those with no hidden ancestor-or-self. */
const shownPanels = (): string[] => PANELS.filter((s) => panelEl(s).closest('[hidden]') === null);
/** The tab strip as read: { label, selected }. */
const tabsNow = (): Array<{ label: string; selected: boolean }> =>
  Array.from(helpOverlay().querySelectorAll('[role="tablist"] [role="tab"]')).map((el) => ({
    label: el.textContent ?? '',
    selected: el.getAttribute('aria-selected') === 'true',
  }));
const activeTab = (): string | undefined => tabsNow().find((x) => x.selected)?.label;
/** The overlay's text with every hidden subtree skipped. */
function visibleText(root: Element): string {
  if (root.hasAttribute('hidden')) return '';
  const parts: string[] = [];
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) parts.push(node.textContent ?? '');
    else if (node.nodeType === 1) parts.push(visibleText(node as Element));
  }
  return parts.join('\n');
}

/** Walk the main menu's cursor onto `key` of the current list, with real arrow presses. */
function menuTo(key: string): void {
  for (let i = 0; i < 8 && game().navActive !== key; i += 1) press('ArrowDown');
  expect(game().navActive, `precondition: the menu cursor is on ${key}`).toBe(key);
}

describe('main.ts generated Help over the real shell (runtime, ctl-14)', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('CTL14-1-BOOT-SELECT: Select at the world opens Help on This screen listing the WORLD context`s chips (and not Help`s own Close), the tabs follow LB / RB (RB wraps from Goals, LB from This screen), All controls lists every button and shortcut with the live keys (F9 and F8 included), Goals the three catalog goals and the note shows only on All controls; Select again closes it, and a reopen starts on This screen; Escape closes it', async () => {
    // LEGACY REPLACED (the Red): Select opened the old two-list overlay (English CONTROLS and
    // GOALS rows, no tabs, no chips of the screen, no F8), and LB / RB scrolled the page.
    // WRONG IMPL KILLED: Help built from the stack WITH the help frame (This screen would read
    // OK / Back / Close / Help: the Close chip is the tell) instead of the context beneath; a
    // This-screen tab that is a fixed list; a tab strip painted once at boot (the second open would
    // keep the last tab); LB / RB that never reach the screen (the page keeps them); a panel that
    // does not follow the tab; all panels shown at once; no wrap; the note on every tab or on
    // none; a model without the shortcut rows (F9 / F8 undiscoverable) or with keys that are not
    // the live glyphs; a Select that does not close (a second press must toggle) and an Escape that
    // leaves Help (or the stack) behind.
    const ESC = i18nT('key.escape');
    const menuVerb = i18nT('chrome.chip.menu');
    const helpVerb = i18nT('chrome.chip.help');
    const titles = [i18nT('help.tab.screen'), i18nT('help.tab.controls'), i18nT('help.tab.goals')];
    const note = i18nT('help.note.keysVsButtons');

    await bootReady();
    batch();
    frame();
    expect(helpOpen(), 'precondition: Help starts closed').toBe(false);
    expect(stackNames(), 'precondition: the bare world').toEqual(['world']);

    // --- Select opens Help over the world ----------------------------------------------------
    press('KeyR');
    frame();
    expect(stackNames(), 'Select opened the help frame').toEqual(['world', 'helpView']);
    expect(helpOpen(), 'and showed the overlay').toBe(true);

    // --- This screen: the world's chips, as the hint bar showed them beneath -----------------
    const screenRows = rowTexts(SCREEN_PANEL);
    expect(screenRows, 'the bare world has two chips: Start and Select').toHaveLength(2);
    expect(screenRows[0], 'row 1: Start, its live keycap and its verb').toContain(ESC);
    expect(screenRows[0]).toContain(menuVerb);
    expect(screenRows[1], 'row 2: Select, its live keycap and its verb').toContain('R');
    expect(screenRows[1]).toContain(helpVerb);
    expect(screenRows[0], 'each row carries its own verb only').not.toContain(helpVerb);
    const screenText = screenRows.join('\n');
    for (const own of ['chrome.chip.close', 'chrome.chip.ok', 'chrome.chip.back'] as const) {
      expect(screenText, `Help's own chips (${own}) are not the screen's`).not.toContain(
        i18nT(own),
      );
    }

    // --- the strip: three tabs, This screen selected, only its panel shown -------------------
    expect(
      tabsNow().map((x) => x.label),
      'the tab labels are the catalog titles',
    ).toEqual(titles);
    expect(activeTab(), 'it opens on This screen').toBe(titles[0]);
    expect(shownPanels(), 'only This screen is shown').toEqual([SCREEN_PANEL]);
    expect(visibleText(helpOverlay()), 'no note on This screen').not.toContain(note);

    // --- All controls: every row, the live keys, F9 and F8 ------------------------------------
    const controls = rowTexts(CONTROLS_PANEL);
    expect(controls, '12 buttons then 11 shortcuts').toHaveLength(23);
    const rowFor = (label: string): string => {
      const row = controls.find((text) => text.includes(label));
      if (row === undefined) throw new Error(`no All controls row for ${label}`);
      return row;
    };
    const selectLabel = i18nT('controls.button.select');
    const selectRow = rowFor(selectLabel).replace(selectLabel, '');
    expect(selectRow, 'Select: its primary key').toContain('R');
    expect(selectRow, 'and its alt, by the catalog name').toContain(i18nT('key.slash'));
    expect(rowFor(i18nT('controls.accel.bugReport')), 'the F9 row').toContain('F9');
    expect(rowFor(i18nT('controls.accel.dismissError')), 'the F8 row').toContain('F8');

    // --- RB walks the tabs; the panel and the note follow -------------------------------------
    press('KeyE');
    expect(stackNames(), 'RB is Help`s, not the page`s: Help stays open').toEqual([
      'world',
      'helpView',
    ]);
    expect(activeTab(), 'RB: All controls').toBe(titles[1]);
    expect(shownPanels(), 'only All controls is shown').toEqual([CONTROLS_PANEL]);
    expect(visibleText(helpOverlay()), 'the keys-vs-buttons note shows here').toContain(note);

    press('KeyE');
    expect(activeTab(), 'RB: Goals').toBe(titles[2]);
    expect(shownPanels()).toEqual([GOALS_PANEL]);
    expect(
      rowTexts(GOALS_PANEL).map((text) => text.trim()),
      'the three catalog goals, exactly',
    ).toEqual([i18nT('help.goal.recruit'), i18nT('help.goal.battle'), i18nT('help.goal.trade')]);
    expect(visibleText(helpOverlay()), 'no note on Goals').not.toContain(note);

    press('KeyE');
    expect(activeTab(), 'RB wraps from Goals to This screen').toBe(titles[0]);
    expect(shownPanels()).toEqual([SCREEN_PANEL]);
    press('KeyQ');
    expect(activeTab(), 'LB wraps from This screen to Goals').toBe(titles[2]);
    expect(shownPanels()).toEqual([GOALS_PANEL]);
    press('KeyQ');
    expect(activeTab(), 'LB: All controls').toBe(titles[1]);
    expect(stackNames(), 'the bumpers never closed Help').toEqual(['world', 'helpView']);

    // --- Select closes it, and a reopen starts over on This screen ---------------------------
    press('KeyR');
    frame();
    expect(helpOpen(), 'Select again closes Help').toBe(false);
    expect(stackNames(), 'back to the bare world').toEqual(['world']);
    press('KeyR');
    frame();
    expect(helpOpen(), 'reopened').toBe(true);
    expect(activeTab(), 'a reopen starts on This screen, not the last tab').toBe(titles[0]);
    expect(shownPanels()).toEqual([SCREEN_PANEL]);

    // --- Escape (Start) closes it --------------------------------------------------------------
    press('Escape');
    frame();
    expect(helpOpen(), 'Escape closes Help').toBe(false);
    expect(stackNames(), 'and leaves the bare world, not the menu').toEqual(['world']);

    // --- a saved remap: All controls and the chips show it; Select answers on the NEW key -----
    // WRONG IMPL KILLED: All controls built from DEFAULT_BINDINGS or a hand list (the Select row
    // would still read R and the slash key after the remap); a This-screen chip keycap from the
    // defaults; a Select still opening on KeyR (the remap would be cosmetic); and an unbound alt
    // slot printed as an empty or "undefined" key.
    teardown();
    await bootReady(
      storedTable((raw) => {
        raw.buttons.Select = ['KeyZ'];
      }),
    );
    batch();
    frame();
    press('KeyR');
    frame();
    expect(helpOpen(), 'remap: the old Select key is unbound, nothing opens').toBe(false);
    press('KeyZ');
    frame();
    expect(helpOpen(), 'remap: the new Select key opens Help').toBe(true);
    expect(stackNames()).toEqual(['world', 'helpView']);

    const row = rowTexts(CONTROLS_PANEL).find((text) => text.includes(selectLabel));
    expect(row, 'remap: the Select row exists').toBeDefined();
    const keysPart = (row ?? '').replace(selectLabel, '');
    expect(keysPart, 'remap: All controls shows the remapped key').toContain('Z');
    expect(keysPart, 'remap: not the old primary').not.toContain('R');
    expect(keysPart, 'remap: not the old alt').not.toContain(i18nT('key.slash'));
    expect(keysPart, 'remap: no placeholder for the unbound alt').not.toContain('undefined');

    const helpChip = rowTexts(SCREEN_PANEL).find((text) =>
      text.includes(i18nT('chrome.chip.help')),
    );
    expect(helpChip, 'remap: the world`s Select chip is listed').toBeDefined();
    expect(helpChip, 'remap: with the remapped keycap').toContain('Z');
    expect(helpChip, 'remap: never the old one').not.toContain('R');

    press('KeyZ');
    frame();
    expect(helpOpen(), 'remap: the new key also closes it').toBe(false);
  }, 120_000);

  it('Help names what the world faces: with an NPC in front, This screen adds the A chip with its verb ahead of Start and Select', async () => {
    // WRONG IMPL KILLED: This screen built from the bare stack with no HintWorld (the faced target's
    // A chip, which the hint bar shows, would be missing from the help), and a help built from a
    // stale world read at boot.
    await bootReady();
    batch();
    seedFacedNpc();
    frame();
    press('KeyR');
    frame();
    expect(stackNames()).toEqual(['world', 'helpView']);
    const rows = rowTexts(SCREEN_PANEL);
    expect(rows, 'A, Start, Select').toHaveLength(3);
    expect(rows[0], 'A with its live keycap').toContain(i18nT('key.enter'));
    expect(rows[0], 'and the faced target`s verb').toContain(i18nT('interact.verb.talk'));
    expect(rows[1]).toContain(i18nT('chrome.chip.menu'));
    expect(rows[2]).toContain(i18nT('chrome.chip.help'));
  }, 120_000);

  it('Options > How to play opens the same Help over the menu: This screen lists the menu`s chips, B closes only Help and the menu stays', async () => {
    // WRONG IMPL KILLED: a menu leaf that still opens the old zero-argument help (no tabs); a Help
    // opened from the menu that lists the WORLD's chips (it must read the context beneath, the menu
    // screen's OK / Back / Close / Help); a B that closes the menu with it.
    await bootReady();
    batch();
    frame();
    press('Escape');
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    menuTo('options');
    press('Enter');
    expect(game().navActive, 'precondition: the Options list opens on How to play').toBe('help');
    press('Enter');
    frame();
    expect(stackNames(), 'How to play opened Help above the menu').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);
    expect(helpOpen()).toBe(true);
    expect(
      tabsNow().map((x) => x.label),
      'the tabbed Help',
    ).toEqual([i18nT('help.tab.screen'), i18nT('help.tab.controls'), i18nT('help.tab.goals')]);
    const rows = rowTexts(SCREEN_PANEL);
    expect(rows, 'the menu screen`s four chips: OK, Back, Close, Help').toHaveLength(4);
    for (const [i, verb] of (
      ['chrome.chip.ok', 'chrome.chip.back', 'chrome.chip.close', 'chrome.chip.help'] as const
    ).entries()) {
      expect(rows[i], `row ${i}`).toContain(i18nT(verb));
    }

    press('Backspace'); // B
    frame();
    expect(helpOpen(), 'B closes Help').toBe(false);
    expect(stackNames(), 'and only Help: the menu stays').toEqual(['world', 'menuView']);
  }, 120_000);
});

// --- round 2: the wrong implementations the red-team and the reviewer found ------------------------

const BOB = 'bb'.repeat(32);
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

const controlsActive = (): string | null =>
  document.querySelector('#controls-rows [aria-selected="true"]')?.getAttribute('data-nav-key') ??
  null;

/** An in-session remap through the REAL Options > Controls screen: Select's primary slot -> KeyZ,
 *  then Start pops back to the bare world. */
function remapSelectToZ(): void {
  press('Escape');
  menuTo('options');
  press('Enter');
  for (let i = 0; i < 2 && game().navActive !== 'controls'; i += 1) press('ArrowDown');
  expect(game().navActive, 'precondition: the cursor is on Options > Controls').toBe('controls');
  press('Enter');
  expect(stackNames(), 'precondition: Controls opened above the menu').toEqual([
    'world',
    'menuView',
    'controlsView',
  ]);
  // The Buttons grid is two columns wide: one ArrowDown per row, down to Select's Primary slot.
  for (let i = 0; i < VBUTTONS.length + 2 && controlsActive() !== 'Select_0'; i += 1) {
    press('ArrowDown');
  }
  expect(controlsActive(), 'precondition: the cursor is on the Select Primary slot').toBe(
    'Select_0',
  );
  press('Enter'); // A starts the capture
  press('KeyZ'); // the next key is bound
  press('Escape'); // Start pops Controls and the menu
  expect(stackNames(), 'precondition: back on the bare world').toEqual(['world']);
}

describe('main.ts Help: what a stale or short-cut implementation gets wrong (round 2, ctl-14)', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('CTL14-1-BOOT-LIVE-REMAP: a Select remap made IN-SESSION through Options > Controls shows on the next open, after Help was already opened and closed once: All controls` Select row reads Z and not R, and This screen`s Select chip reads Z', async () => {
    // WRONG IMPL KILLED: All controls built from a binding snapshot taken at boot (the saved-table
    // boot test above cannot see it: only a remap AFTER boot can); a Help rendered only on its
    // first open (the first open here is the one that would freeze it); and a This-screen chip
    // keycap read from the boot table.
    await bootReady();
    batch();
    frame();
    press('KeyR');
    frame();
    expect(helpOpen(), 'precondition: the first open (before the remap)').toBe(true);
    press('KeyR');
    frame();
    expect(helpOpen(), 'precondition: closed again').toBe(false);

    remapSelectToZ();
    press('KeyZ');
    frame();
    expect(helpOpen(), 'the NEW Select key opens Help').toBe(true);
    const selectLabel = i18nT('controls.button.select');
    const row = rowTexts(CONTROLS_PANEL).find((text) => text.includes(selectLabel)) ?? '';
    expect(row, 'the Select row exists').not.toBe('');
    const keys = row.replace(selectLabel, '');
    expect(keys, 'All controls shows the live key').toContain('Z');
    expect(keys, 'not the boot-time primary').not.toContain('R');
    const chip = rowTexts(SCREEN_PANEL).find((text) => text.includes(i18nT('chrome.chip.help')));
    expect(chip, 'This screen lists the Select chip').toBeDefined();
    expect(chip, 'with the live keycap').toContain('Z');
    expect(chip, 'never the boot-time one').not.toContain('R');
  }, 120_000);

  it('a reopen re-reads the world: Help opened with nothing faced, closed, an NPC then in front, reopened: This screen gains the A chip', async () => {
    // WRONG IMPL KILLED: a Help rendered once (the second open shows the first open's two chips);
    // a This screen read from a cache of the last open instead of the world at this open.
    await bootReady();
    batch();
    frame();
    press('KeyR');
    frame();
    expect(rowTexts(SCREEN_PANEL), 'nothing faced: Start and Select').toHaveLength(2);
    press('KeyR');
    frame();
    expect(helpOpen(), 'precondition: closed').toBe(false);
    seedFacedNpc();
    frame();
    press('KeyR');
    frame();
    const rows = rowTexts(SCREEN_PANEL);
    expect(rows, 'A, Start, Select on the second open').toHaveLength(3);
    expect(rows[0], 'A with the faced target`s verb').toContain(i18nT('interact.verb.talk'));
  }, 120_000);

  it('over a bare battle, Select opens Help whose This screen is the BATTLE`s chips (OK, Menu, Help) and not the world`s; Select closes it again', async () => {
    // WRONG IMPL KILLED: an openHelp that hard-codes the world base when it reads the context
    // beneath (over a battle This screen would read Menu / Help only, or carry a faced target's
    // A chip the battle does not have).
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
    expect(helpOpen()).toBe(true);
    const rows = rowTexts(SCREEN_PANEL);
    expect(rows, 'the battle`s chips: OK, Menu, Help').toHaveLength(3);
    expect(rows[0], 'A is OK in a battle').toContain(i18nT('chrome.chip.ok'));
    expect(rows[1]).toContain(i18nT('chrome.chip.menu'));
    expect(rows[2]).toContain(i18nT('chrome.chip.help'));
    press('KeyR');
    frame();
    expect(stackNames(), 'Select closes it, the battle stays').toEqual(['battle']);
  }, 120_000);

  it('clicking the Select chip at the world opens the same Help as the key: This screen is the world`s two chips (no Close, Back or OK), All controls has 23 rows and Goals 3', async () => {
    // WRONG IMPL KILLED: a launcher path that shows Help before reading the chips (or reads the
    // stack WITH the help frame: Close / Back / OK); a launcher that never renders (empty panels).
    await bootReady();
    batch();
    frame();
    (document.getElementById('chip-select') as HTMLElement).click();
    frame();
    expect(helpOpen(), 'the click opened Help').toBe(true);
    const rows = rowTexts(SCREEN_PANEL);
    expect(rows, 'Start and Select').toHaveLength(2);
    for (const own of ['chrome.chip.close', 'chrome.chip.back', 'chrome.chip.ok'] as const) {
      expect(rows.join('|'), `Help's own chip ${own} is not on This screen`).not.toContain(
        i18nT(own),
      );
    }
    expect(rowTexts(CONTROLS_PANEL), 'All controls is populated').toHaveLength(23);
    expect(rowTexts(GOALS_PANEL), 'Goals is populated').toHaveLength(3);
  }, 120_000);

  it('clicking the Select chip while Help is open behaves like the Select key: Help closes and the stack returns to the base, and This screen is never re-rendered with Help`s own chips', async () => {
    // WRONG IMPL KILLED (reviewer M1): a launcher that calls openHelp() unconditionally, so a click
    // on an open Help re-renders This screen from the stack WITH the help frame (OK / Back / Close /
    // Help) and leaves Help open. Select and the chip are the SAME control.
    await bootReady();
    batch();
    frame();
    press('KeyR');
    frame();
    expect(stackNames(), 'precondition: Help is open').toEqual(['world', 'helpView']);
    const before = rowTexts(SCREEN_PANEL);
    expect(before, 'precondition: the world`s chips').toHaveLength(2);

    (document.getElementById('chip-select') as HTMLElement).click();
    frame();
    expect(helpOpen(), 'the click closed Help').toBe(false);
    expect(stackNames(), 'back to the base').toEqual(['world']);
    const after = rowTexts(SCREEN_PANEL).join('|');
    for (const own of ['chrome.chip.close', 'chrome.chip.back', 'chrome.chip.ok'] as const) {
      expect(after, `Help's own chip ${own} never reached This screen`).not.toContain(i18nT(own));
    }
    expect(rowTexts(SCREEN_PANEL), 'This screen is untouched').toEqual(before);
  }, 120_000);

  it('Select closes a Help opened over the menu (Options > How to play): only Help closes and the menu stays', async () => {
    // WRONG IMPL KILLED: a Select that is not a toggle over a menu (it would be swallowed, or close
    // the menu with Help, or open a second Help).
    await bootReady();
    batch();
    frame();
    press('Escape');
    menuTo('options');
    press('Enter');
    press('Enter');
    frame();
    expect(stackNames(), 'precondition: Help over the menu').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);
    press('KeyR');
    frame();
    expect(helpOpen(), 'Select closed Help').toBe(false);
    expect(stackNames(), 'and only Help').toEqual(['world', 'menuView']);
  }, 120_000);

  it('with an incoming trade request waiting and nothing faced, This screen lists the View (Y) and Dismiss (B) chips before Start and Select', async () => {
    // WRONG IMPL KILLED: an openHelp that passes no notices or no waiting-request flag to hintBar
    // (the Y / B chips the bar shows would be missing from the help).
    await bootReady();
    batch();
    frame();
    opts.store.upsertPlayer({
      identity: BOB,
      entityId: 8n,
      name: 'Bob',
      online: true,
      lastInputSeq: 0n,
    });
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    press('KeyR');
    frame();
    const rows = rowTexts(SCREEN_PANEL);
    expect(rows, 'Y, B, Start, Select').toHaveLength(4);
    expect(rows[0], 'Y views the request').toContain(i18nT('chrome.chip.view'));
    expect(rows[1], 'B dismisses its banner').toContain(i18nT('chrome.chip.dismiss'));
    expect(rows[2]).toContain(i18nT('chrome.chip.menu'));
    expect(rows[3]).toContain(i18nT('chrome.chip.help'));
  }, 120_000);
});
