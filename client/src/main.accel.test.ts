// @vitest-environment happy-dom
/**
 * main.accel.test.ts: the booted accelerators (ctl-11a, CTL11A.1 to CTL11A.3).
 *
 * The pure pieces (`ACCEL_PATHS`, `accelDecision`, `acceleratorsDenied`, `accelForCode`) are proven
 * in their own suites. This file proves the SHELL: that a freshly imported main.ts decides each
 * accelerator keydown through them, pops to the base, opens the main menu and picks the path's menu
 * keys one by one (so the menu sits beneath the leaf's frame with its cursor on the leaf), acts as
 * Start on an accelerator's own screen, denies the keys over a dialogue, a typing field and the
 * session gate, and hands Q and E to the tabbed screens as LB and RB. Every case dispatches real,
 * bubbling KeyboardEvents at the real window listeners and reads only what a player or a server can
 * see: the shown roots, `defaultPrevented`, the menu view's own paint (its nav container's
 * `aria-activedescendant`, its title and breadcrumb, its feedback line), the tab strips, the intents
 * and reducer calls the stubbed connection recorded, and the read-only `__game()` hook (`stack`,
 * `navActive`).
 *
 * Two cases at the end close residuals the slice carries with it: Select opens and closes Help over
 * a bare battle (R-ctl-8j-SELECTINERT), and Monsters picked in the menu opens on Party
 * (R-ctl-8b-CTL8B.4).
 *
 * The menu's level and cursor are read off what the menu view paints: a root cursor is the id
 * `menu-root-<key>`, a Social cursor `menuSocial-root-<key>` and a Profile cursor
 * `menuProfile-root-<key>`, under the matching frame title (and the translated `Menu` crumb).
 *
 * Harness: main.controls.test.ts's pattern, copied (vi.resetModules + a fresh import per test,
 * recorded window / document listeners detached in afterEach, one controllable clock, a controllable
 * rAF, a stubbed wasm pkg and SDK connection, the real client/index.html shell mounted first), with
 * ONE delta: the connection's `sessionState()` reads `H.session`, so a case can raise the session
 * gate. The adapter table is the real one. Every press is a keydown and its keyup 5 ms later: the
 * keyboard source reads a second non-repeat keydown of a code it holds as a lost keyup.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreBattle, StoreBattleMonster, StoreMonsterPub } from './net/store';
import { t as i18nT } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What the stubbed connection's `sessionState()` answers: `hidden` is the ordinary case, any
   *  other value is the session terminal (it blocks every input path). Reset by every boot. */
  session: 'hidden' as string,
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open grid;
// the interaction rule answers no candidates (nothing here is faced).
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
    interact_candidates_coded: () => [],
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

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once; sessionState() reads H.session.
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
/** The clock of the next `press`: every press moves it on by 100 ms. */
let pressAt = 2000;

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.session = 'hidden';
  pressAt = 2000;
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
const NPC_ENTITY = 11n;
const WILD_IDENTITY = '0'.repeat(64);
const BATTLE_ID = 101n;

/** Deliver one authoritative batch: the own player + character at (2, 6), every send acked. */
function server(t: number): void {
  clock.t = t;
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
    t,
  );
  opts.store.flushBatch();
}

/** The world plus one dialogue NPC one tile east of the player, in one batch. */
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
  server(t);
}

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

/** A wild battle row for the booted player. */
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

/** A battle row arrives (Ongoing by default), in one batch at clock `t`. */
function putBattle(battleId: bigint, t: number, outcome = 'Ongoing'): void {
  opts.store.upsertBattle(battleRow(battleId, outcome));
  server(t);
}

function startConversation(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: NPC_ENTITY,
    currentNodeId: 'start',
  });
  server(t);
}
function endConversation(t: number): void {
  opts.store.removeConversation(H.identity);
  server(t);
}

/** One own monster: in the party slot `partySlot`, or boxed with the sentinel 255. */
function monster(monsterId: bigint, partySlot: number): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 10,
    statHp: 10,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot,
    tier: 0,
    essence: { Fire: 0, Water: 0, Plant: 0, Electric: 0, Earth: 0, Wind: 0, Light: 0, Dark: 0 },
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
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
function tap(code: string, t: number, target?: EventTarget): KeyboardEvent {
  const down = fire('keydown', code, t, { target });
  fire('keyup', code, t + 5, { target });
  return down;
}

/** A tap on the running press clock (100 ms after the last one). */
function press(code: string, target?: EventTarget): KeyboardEvent {
  const down = tap(code, pressAt, target);
  pressAt += 100;
  return down;
}

/** Let queued microtasks and zero-delay timers run (a settled reducer promise, a deferred focus). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Display of the element and every ancestor: shown unless some inline `display` is `none`. */
const isShown = (el: Element): boolean => {
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
};
const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};
const shownById = (id: string): boolean => isShown(byId(id));
const shownByTestId = (testId: string): boolean => {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`[data-testid="${testId}"] is not in the document`);
  return isShown(el);
};

const menuShown = (): boolean => shownById('menu-overlay');
const questLogShown = (): boolean => shownById('quest-log-overlay');
const battleShown = (): boolean => shownByTestId('battle-title');

/** The leaf roots an accelerator can open, by name. Exactly the expected ones may be shown. */
const LEAF_ROOTS: ReadonlyArray<readonly [string, () => boolean]> = [
  ['box', () => shownByTestId('box-title')],
  ['raising', () => shownByTestId('raising-title')],
  ['questLog', questLogShown],
  ['trade', () => shownById('trade-overlay')],
  ['pvp', () => shownById('pvp-challenge-overlay')],
  ['leaderboard', () => shownById('leaderboard-overlay')],
  ['rename', () => shownById('rename-overlay')],
  ['claim', () => shownById('claim-overlay')],
  ['help', () => shownById('help-overlay')],
];
const openRoots = (): string[] => LEAF_ROOTS.filter(([, shown]) => shown()).map(([name]) => name);

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}
interface GameHook {
  readonly stack: FrameJson[];
  readonly navActive: string | null;
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
/** The raw stack, base first (a base is `{kind:'world'}` or `{kind:'battle', battleId}`). */
const stack = (): FrameJson[] => game().stack;
/** The stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = (): string[] =>
  stack().map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));
const navActive = (): string | null => game().navActive;

/** What the menu view paints: its nav container's cursor, its title, crumbs and feedback line. */
const menuCursor = (): string | null => byId('menu-rows').getAttribute('aria-activedescendant');
const menuTitle = (): string =>
  document.querySelector('#menu-overlay .mr-frame-title')?.textContent ?? '';
const menuCrumbs = (): string[] =>
  Array.from(document.querySelectorAll('#menu-overlay .mr-frame-crumb')).map(
    (c) => c.textContent ?? '',
  );
const menuFeedback = (): string =>
  byId('menu-overlay').querySelector('.mr-frame-feedback')?.textContent ?? '';

type Level = 'root' | 'social' | 'profile';
const CURSOR_PREFIX: Readonly<Record<Level, string>> = {
  root: 'menu',
  social: 'menuSocial',
  profile: 'menuProfile',
};
const levelTitle = (level: Level): string =>
  level === 'root'
    ? i18nT('menu.title')
    : level === 'social'
      ? i18nT('menu.social.title')
      : i18nT('menu.profile.title');

/** One accelerator and where its canonical path lands (spelled out here, never read from the
 *  module under test). */
interface Row {
  readonly accel: string;
  readonly code: string;
  /** The frame id the leaf puts on the stack, above the menu. */
  readonly frame: string;
  /** The leaf root that is the one thing shown (a `LEAF_ROOTS` name). */
  readonly root: string;
  /** The menu key the cursor ends on, and the level it is on. */
  readonly key: string;
  readonly level: Level;
}
const ROWS: readonly Row[] = [
  { accel: 'B', code: 'KeyB', frame: 'boxView', root: 'box', key: 'monsters', level: 'root' },
  { accel: 'I', code: 'KeyI', frame: 'raisingView', root: 'raising', key: 'bag', level: 'root' },
  { accel: 'V', code: 'KeyV', frame: 'boxView', root: 'box', key: 'monsters', level: 'root' },
  {
    accel: 'J',
    code: 'KeyJ',
    frame: 'questLogView',
    root: 'questLog',
    key: 'journal',
    level: 'root',
  },
  { accel: 'U', code: 'KeyU', frame: 'social', root: 'trade', key: 'trades', level: 'social' },
  { accel: 'P', code: 'KeyP', frame: 'social', root: 'pvp', key: 'challenges', level: 'social' },
  {
    accel: 'L',
    code: 'KeyL',
    frame: 'social',
    root: 'leaderboard',
    key: 'rankings',
    level: 'social',
  },
  { accel: 'N', code: 'KeyN', frame: 'renameView', root: 'rename', key: 'name', level: 'profile' },
  {
    accel: 'C',
    code: 'KeyC',
    frame: 'claimView',
    root: 'claim',
    key: 'account',
    level: 'profile',
  },
];
const ROW = (accel: string): Row => {
  const row = ROWS.find((r) => r.accel === accel);
  if (row === undefined) throw new Error(`no row for accelerator ${accel}`);
  return row;
};

/** The accelerator's path is open: the menu beneath the leaf's frame, on the leaf's level with
 *  its cursor on the leaf, and nothing but the leaf's root shown. */
function expectLeafOpen(row: Row, label: string): void {
  expect(stackNames(), `${label}: the menu, then the leaf`).toEqual([
    'world',
    'menuView',
    row.frame,
  ]);
  expect(openRoots(), `${label}: the leaf's root alone is shown`).toEqual([row.root]);
  expect(menuShown(), `${label}: the menu is open beneath it`).toBe(true);
  expect(navActive(), `${label}: the menu cursor is on ${row.key}`).toBe(row.key);
  expect(menuCursor(), `${label}: the menu paints its cursor on the leaf`).toBe(
    `${CURSOR_PREFIX[row.level]}-root-${row.key}`,
  );
  expect(menuTitle(), `${label}: the menu is on its ${row.level} level`).toBe(
    levelTitle(row.level),
  );
  expect(menuCrumbs(), `${label}: and its crumb`).toEqual(
    row.level === 'root' ? [] : [i18nT('menu.title')],
  );
}

/** Nothing is open: the bare world, no menu, no leaf, no active menu entry. */
function expectBareWorld(label: string): void {
  expect(stackNames(), `${label}: the bare world`).toEqual(['world']);
  expect(openRoots(), `${label}: no leaf root is shown`).toEqual([]);
  expect(menuShown(), `${label}: no menu`).toBe(false);
  expect(navActive(), `${label}: a closed menu has no active entry`).toBeNull();
}

/** Every recorded reducer call of one name, in order. */
const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

describe('main.ts accelerators over the real shell (runtime, ctl-11a)', {
  sequential: true,
}, () => {
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

  // ------------------------------------------------------------------------------------------
  // CTL11A.1: pop to the base, push the canonical path, the cursor on the leaf
  // ------------------------------------------------------------------------------------------

  it('CTL11A-1-BOOT-PATHS: each of B, I, V, J, U, P, L, N and C pressed at the world is consumed and leaves the stack the world, the menu, then that leaf, with exactly the leaf`s root shown and the menu painted on the leaf`s level with its cursor on the leaf', async () => {
    // WRONG IMPL KILLED: today's ladder (J and V are not keys at all; B, I, N, C, U, P and L open
    // the bare overlay with no menu beneath it, so Backspace could never back out into it), a
    // path that opens the leaf's frame but not the menu (the stack lacks `menuView`), a menu opened
    // on the first entry (the cursor is not on the leaf), a cursor remembered from the previous
    // accelerator instead of picked (the nine run in one session, so the memory is stale each time),
    // a menu opened at the group's sub-level but with the root painted (U, P, L, N and C: the title,
    // crumb and cursor id name the level), a picked group that is not entered (the cursor stays on
    // Social), a swapped pair of leaves (P opens Rankings, L Challenges), a leaf that is not the one
    // shown alone (a stale root left up), and a key that is not prevented (the opening `n` would be
    // typed into the Name field).
    await bootReady();
    server(1000);
    for (const row of ROWS) {
      expectBareWorld(`${row.accel}: precondition`);
      const e = press(row.code);
      expect(e.defaultPrevented, `${row.accel}: the consumed accelerator is prevented`).toBe(true);
      expectLeafOpen(row, row.accel);
      press('Escape'); // Start pops everything to the world for the next accelerator
    }
    expect(H.sends, 'no accelerator walks the character').toHaveLength(0);
    expect(H.calls, 'no accelerator sends a reducer call').toEqual([]);
  });

  it('CTL11A-1-BOOT-REPLACE: an accelerator replaces whatever screen is open (U closes Journal and J closes Social, B then I, each leaving one menu above the base), and with the menu already open at a sub-level J closes it and re-opens the menu fresh on the Journal', async () => {
    // WRONG IMPL KILLED: today's mutual-exclusivity guards (a second overlay key is refused while
    // one is up), an accelerator that opens its leaf on top of the open one (two leaves stacked), a
    // pop that leaves the old leaf's root displayed (two roots shown), a second `menuView` pushed
    // over the first (the stack lists the menu twice), a menu that is reused as it stands (opened at
    // the Social sub-level, so picking the Journal on that level is a no-op and the cursor stays on
    // Trades), and a popToBase that runs only when the key's own screen is up.
    await bootReady();
    server(1000);

    // U, then J: Social is replaced by the Journal.
    press('KeyU');
    expectLeafOpen(ROW('U'), 'U');
    press('KeyJ');
    expectLeafOpen(ROW('J'), 'J over Social');
    expect(
      ['trade-overlay', 'pvp-challenge-overlay', 'leaderboard-overlay'].filter(shownById),
      'J over Social: every Social panel is closed',
    ).toEqual([]);

    // The Journal is open, then U: the Journal is replaced by Social, on Trades.
    press('KeyU');
    expectLeafOpen(ROW('U'), 'U over the Journal');
    expect(questLogShown(), 'U over the Journal: the Journal is closed').toBe(false);

    // B, then I: the Monsters frame is replaced by Bag.
    press('Escape');
    press('KeyB');
    expectLeafOpen(ROW('B'), 'B');
    press('KeyI');
    expectLeafOpen(ROW('I'), 'I over Monsters');
    expect(shownByTestId('box-title'), 'I over Monsters: the Monsters frame is closed').toBe(false);

    // The menu opened by hand and left at a sub-level: the accelerator starts the menu over.
    press('Escape');
    expectBareWorld('after Start');
    press('KeyM');
    expect(stackNames(), 'precondition: M opened the menu').toEqual(['world', 'menuView']);
    for (let i = 0; i < 8 && navActive() !== 'social'; i += 1) press('ArrowDown');
    expect(navActive(), 'precondition: the cursor is on Social').toBe('social');
    press('Enter');
    expect(menuTitle(), 'precondition: A entered the Social sub-level').toBe(levelTitle('social'));
    press('KeyJ');
    expectLeafOpen(ROW('J'), 'J from a menu left on the Social level');
  });

  it('CTL11A-1-BOOT-OWN-START: an accelerator pressed while its own screen is on top acts as Start and returns the stack to the bare world, for all nine, and for the accelerators that share a frame (B with V, U with P with L)', async () => {
    // WRONG IMPL KILLED: a toggle that closes only the leaf and leaves the menu open beneath it
    // (the stack ends [world, menuView]: Start pops everything), a press that re-opens the same
    // path (the Journal rebuilt, nothing closes), a `start` keyed to the key instead of the frame
    // (V with Monsters up re-opens Party; P with Social up opens Challenges), and a leaf root left
    // shown after the stack is the world.
    await bootReady();
    server(1000);
    for (const row of ROWS) {
      press(row.code);
      expectLeafOpen(row, `${row.accel}: precondition`);
      press(row.code);
      expectBareWorld(`${row.accel} twice`);
    }

    const mates: ReadonlyArray<readonly [string, string]> = [
      ['B', 'V'],
      ['V', 'B'],
      ['U', 'P'],
      ['P', 'L'],
      ['L', 'U'],
    ];
    for (const [first, second] of mates) {
      press(ROW(first).code);
      expectLeafOpen(ROW(first), `${first}: precondition`);
      press(ROW(second).code);
      expectBareWorld(`${first} then ${second}`);
    }
  });

  it('CTL11A-1-BOOT-MONSTERS-TAB: V opens Monsters with the Party tab selected and B with the Storage tab selected, each time whatever tab was last shown, and a store batch and a frame leave the tab where it was', async () => {
    // WRONG IMPL KILLED: the legacy box open that always paints Storage (V would open Storage like
    // B), a tab remembered from the last open (B after V would open Party), a tab painted once
    // and reset by the next batch's observe or refresh, a V that opens Party but marks the Storage
    // tab selected (the strip and the panel disagree), and two tabs selected at once.
    await bootReady();
    seedWorld(1000);
    opts.store.upsertMonster(monster(31n, 0));
    opts.store.upsertMonster(monster(32n, 255));
    server(1010);
    const tabs = (): { selected: string[]; active: string[] } => {
      const all = ['party', 'storage'];
      return {
        selected: all.filter(
          (t) => byId(`monsters-tab-${t}`).getAttribute('aria-selected') === 'true',
        ),
        active: all.filter((t) => byId(`monsters-tab-${t}`).classList.contains('is-active')),
      };
    };

    press('KeyV');
    expectLeafOpen(ROW('V'), 'V');
    expect(tabs(), 'V: the Party tab alone is selected').toEqual({
      selected: ['party'],
      active: ['party'],
    });
    server(pressAt);
    frame(pressAt + 10);
    expect(tabs(), 'V: a batch and a frame leave Party selected').toEqual({
      selected: ['party'],
      active: ['party'],
    });

    press('Escape');
    press('KeyB');
    expectLeafOpen(ROW('B'), 'B');
    expect(tabs(), 'B: the Storage tab alone is selected').toEqual({
      selected: ['storage'],
      active: ['storage'],
    });
    server(pressAt);
    frame(pressAt + 10);
    expect(tabs(), 'B: a batch and a frame leave Storage selected').toEqual({
      selected: ['storage'],
      active: ['storage'],
    });

    press('Escape');
    press('KeyV');
    expect(tabs(), 'V again: Party, not the tab B left').toEqual({
      selected: ['party'],
      active: ['party'],
    });
  });

  it('CTL11A-1-BOOT-BATTLE: over an Ongoing battle each accelerator opens the menu read-only above the battle (stamped with it), opens no screen, puts the cursor on the disabled root entry its path starts with and shows that entry`s reason on the feedback line; pressed again with the menu open it rebuilds the same state', async () => {
    // WRONG IMPL KILLED: an accelerator gated on the world-focus predicate (focus sits INSIDE the
    // battle overlay here, so the menu would never open), one that opens the leaf over the battle
    // regardless of the CTL6C.3 policy (the Journal, the box or the bag over a battle: their shells
    // paint under it), one that opens the menu but not read-only (the entries enabled: A would open
    // the box over the battle), one that opens no menu at all (the key dead), a disabled path whose
    // reason is dropped (a dead key with no word), Bag's own reason replaced by the generic one, a
    // menu pushed twice by a second press, a menu not stamped with the battle (the next batch would
    // close it), and a hidden battle.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    await flush();
    const BATTLE_BASE = { kind: 'battle', battleId: '101' };
    expect(stack(), 'precondition: the base is the battle').toEqual([BATTLE_BASE]);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    const sent = H.sends.length;

    // The root entry each accelerator's path starts on, and why it is disabled over a battle.
    const inBattle = i18nT('menu.disabled.inBattle');
    const battleBag = i18nT('menu.disabled.battleBag');
    expect(inBattle, 'fixture: the two reasons differ').not.toBe(battleBag);
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['KeyJ', 'journal', inBattle],
      ['KeyI', 'bag', battleBag],
      ['KeyB', 'monsters', inBattle],
      ['KeyV', 'monsters', inBattle],
      ['KeyU', 'social', inBattle],
      ['KeyP', 'social', inBattle],
      ['KeyL', 'social', inBattle],
      ['KeyN', 'profile', inBattle],
      ['KeyC', 'profile', inBattle],
    ];
    const expectReadOnlyMenu = (label: string, key: string, reason: string): void => {
      expect(stack(), `${label}: the battle base, the menu stamped with it`).toEqual([
        BATTLE_BASE,
        { kind: 'screen', id: 'menuView', overBattle: '101' },
      ]);
      expect(menuShown(), `${label}: the menu is open`).toBe(true);
      expect(openRoots(), `${label}: no screen opened over the battle`).toEqual([]);
      expect(battleShown(), `${label}: the battle stays shown`).toBe(true);
      expect(navActive(), `${label}: the cursor is on ${key}`).toBe(key);
      expect(menuCursor(), `${label}: and the menu paints it`).toBe(`menu-root-${key}`);
      expect(menuTitle(), `${label}: on the root level (a disabled group is not entered)`).toBe(
        levelTitle('root'),
      );
      expect(menuFeedback(), `${label}: the feedback line shows the reason`).toBe(reason);
    };
    for (const [code, key, reason] of cases) {
      const e = press(code);
      expect(e.defaultPrevented, `${code}: the consumed accelerator is prevented`).toBe(true);
      expectReadOnlyMenu(code, key, reason);
      if (code === 'KeyJ') {
        // Pressed again with the menu already open: the same read-only menu, never a second one.
        press(code);
        expectReadOnlyMenu(`${code} again`, key, reason);
      }
      press('Escape');
      expect(stack(), `${code}: Start returns to the bare battle`).toEqual([BATTLE_BASE]);
      expect(battleShown(), `${code}: the battle is still shown after the menu closes`).toBe(true);
    }
    expect(H.sends.length, 'nothing walked over the battle').toBe(sent);
    expect(H.calls, 'no reducer call was made').toEqual([]);
  });

  // ------------------------------------------------------------------------------------------
  // CTL11A.2: denied over server-owned frames, typing fields and the session gate
  // ------------------------------------------------------------------------------------------

  it('CTL11A-2-BOOT-DIALOGUE: with a conversation open (at the world, and suspended under a battle) none of the nine accelerators changes anything or sends a dismiss; once the conversation ends J opens the Journal', async () => {
    // WRONG IMPL KILLED: an accelerator that pops to the base over a dialogue (the server
    // conversation row is stranded: it would send dismissDialogue or leave a hidden dialogue the
    // server still holds), one that opens the menu over the dialogue (a player frame over a
    // conversation: reconcile drops it on the next batch, leaving a flicker), one that opens a leaf
    // behind the dialogue, a denial that covers the world dialogue but not the one suspended under
    // a battle, and a denial that never lifts (the control: J opens once the conversation is gone).
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(stackNames(), 'precondition: the conversation is up').toEqual(['world', 'dialogueView']);
    expect(shownById('dialogue-overlay'), 'precondition: the dialogue is shown').toBe(true);

    for (const row of ROWS) {
      press(row.code);
      expect(stackNames(), `${row.accel} over the dialogue: nothing changes`).toEqual([
        'world',
        'dialogueView',
      ]);
      expect(menuShown(), `${row.accel} over the dialogue: no menu`).toBe(false);
      expect(openRoots(), `${row.accel} over the dialogue: no leaf`).toEqual([]);
      expect(shownById('dialogue-overlay'), `${row.accel}: the dialogue stays`).toBe(true);
    }
    expect(H.calls, 'no dismiss and no other reducer call').toEqual([]);

    // Control: with the conversation gone the same key opens the Journal.
    endConversation(pressAt);
    expect(stackNames(), 'precondition: the conversation ended').toEqual(['world']);
    press('KeyJ');
    expectLeafOpen(ROW('J'), 'J after the conversation');
    press('Escape');
    expectBareWorld('after Start');

    // A conversation suspended under a battle denies too (the dialogue is the top frame there).
    startConversation(pressAt + 500);
    putBattle(BATTLE_ID, pressAt + 600);
    expect(stackNames(), 'precondition: the dialogue is suspended under the battle').toEqual([
      'battle',
      'dialogueView',
    ]);
    for (const row of ROWS) {
      press(row.code);
      expect(stackNames(), `${row.accel} over the suspended dialogue: nothing changes`).toEqual([
        'battle',
        'dialogueView',
      ]);
      expect(menuShown(), `${row.accel} over the suspended dialogue: no menu`).toBe(false);
    }
    expect(callsOf('dismissDialogue'), 'no accelerator dismissed the conversation').toEqual([]);
  });

  it('CTL11A-2-BOOT-TEXT-ENTRY: with the Name field focused every accelerator letter is typed into the field, not taken as an accelerator: nothing is prevented, the stack and the open screen stay; with focus back on the page J replaces the Name screen with the Journal', async () => {
    // WRONG IMPL KILLED: an accelerator check that runs before the native-key ownership test (J
    // typed into the Name field closes the field and opens the Journal: the player cannot type a
    // name containing j, v, b, i, u, p, l, n or c), one that is prevented while the field owns the
    // key (the letter never reaches the field), a denial that covers some letters but not all nine
    // (a per-key exemption), a rename screen the typed N closes as its own Start (N is the key that
    // opened it), and a denial that never lifts (the control: J replaces the Name screen once focus
    // is back on the page).
    await bootReady();
    server(1000);
    press('KeyN');
    expectLeafOpen(ROW('N'), 'N');
    const input = byId('rename-input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement, 'precondition: the Name field has focus').toBe(input);

    for (const row of ROWS) {
      const down = tap(row.code, pressAt, input);
      pressAt += 100;
      expect(down.defaultPrevented, `${row.accel} typed in the field is left to the field`).toBe(
        false,
      );
      expect(stackNames(), `${row.accel} typed in the field: the stack is unchanged`).toEqual([
        'world',
        'menuView',
        'renameView',
      ]);
      expect(openRoots(), `${row.accel} typed in the field: the Name screen stays alone`).toEqual([
        'rename',
      ]);
      expect(document.activeElement, `${row.accel}: the field keeps focus`).toBe(input);
    }

    // Control: with focus on the page the accelerator works (and replaces the Name screen).
    input.blur();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    press('KeyJ');
    expectLeafOpen(ROW('J'), 'J once focus left the field');
  });

  it('CTL11A-2-BOOT-SESSION-GATE: while the session gate blocks, none of the nine accelerators does anything at the world, and with the Journal open neither J (its own Start) nor U (a replace) does; once the gate clears they work again', async () => {
    // WRONG IMPL KILLED: an accelerator decided before the session gate (the session terminal owns
    // the screen: a menu or a leaf would open behind it), a gate that is checked on `open` but not
    // on `start` (J over the Journal would still pop to the world beneath the terminal), one that
    // covers the world but not an open screen (U would replace the Journal), and a gate that never
    // lifts (the controls: J opens at the end).
    await bootReady();
    server(1000);
    H.session = 'expired';
    for (const row of ROWS) {
      press(row.code);
      expectBareWorld(`${row.accel} while the gate blocks`);
    }
    expect(H.calls, 'the blocked keys sent nothing').toEqual([]);

    H.session = 'hidden';
    press('KeyJ');
    expectLeafOpen(ROW('J'), 'J once the gate cleared');

    H.session = 'expired';
    press('KeyJ');
    expect(stackNames(), 'J (its own Start) does nothing while the gate blocks').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    press('KeyU');
    expect(stackNames(), 'U (a replace) does nothing while the gate blocks').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    expect(openRoots(), 'the Journal is still the screen open').toEqual(['questLog']);

    H.session = 'hidden';
    press('KeyJ');
    expectBareWorld('J once the gate cleared again acts as Start');
  });

  // ------------------------------------------------------------------------------------------
  // CTL11A.3: Q and E are LB and RB
  // ------------------------------------------------------------------------------------------

  it('CTL11A-3-BOOT-TABS-WRAP: on Social (opened on Trades by U) E and Q switch to the next and previous tab of Players, Trades, Challenges, Rankings, wrapping from Rankings to Players with E and from Players to Rankings with Q, and PageDown and PageUp do the same; on Monsters (opened by V) they switch Party and Storage with a wrap both ways', async () => {
    // WRONG IMPL KILLED: today's ladder (E toggles Evolution and Q the Journal instead of paging
    // tabs), Q and E bound to the wrong buttons (the directions reversed), a tab switch that stops
    // at the ends, a wrap to the wrong end, a switch that selects a tab but leaves the previous
    // panel shown, a Social frame that is left (the stack changes) by a bumper press, Q and E wired
    // for Social only (the Monsters tabs would stay dead), and PageUp and PageDown dropped when Q and
    // E are added.
    await bootReady();
    seedWorld(1000);
    opts.store.upsertMonster(monster(31n, 0));
    opts.store.upsertMonster(monster(32n, 255));
    server(1010);

    const TABS = ['players', 'trades', 'challenges', 'rankings'] as const;
    const ROOT_OF: Readonly<Record<(typeof TABS)[number], string>> = {
      players: 'leaderboard-overlay',
      trades: 'trade-overlay',
      challenges: 'pvp-challenge-overlay',
      rankings: 'leaderboard-overlay',
    };
    const SOCIAL_ROOTS = ['trade-overlay', 'pvp-challenge-overlay', 'leaderboard-overlay'];
    const expectSocialOn = (label: string, tab: (typeof TABS)[number]): void => {
      expect(stackNames(), `${label}: still the menu, then Social`).toEqual([
        'world',
        'menuView',
        'social',
      ]);
      expect(
        TABS.filter((t) => byId(`social-tab-${t}`).getAttribute('aria-selected') === 'true'),
        `${label}: ${tab} alone is selected`,
      ).toEqual([tab]);
      expect(SOCIAL_ROOTS.filter(shownById), `${label}: the ${tab} panel's root alone`).toEqual([
        ROOT_OF[tab],
      ]);
    };

    press('KeyU');
    expectSocialOn('U', 'trades');
    press('KeyE');
    expectSocialOn('E from Trades', 'challenges');
    press('KeyQ');
    expectSocialOn('Q from Challenges', 'trades');
    press('KeyQ');
    expectSocialOn('Q from Trades', 'players');
    press('KeyQ');
    expectSocialOn('Q from Players wraps', 'rankings');
    press('KeyE');
    expectSocialOn('E from Rankings wraps', 'players');
    press('KeyE');
    expectSocialOn('E from Players', 'trades');
    press('PageDown');
    expectSocialOn('PageDown from Trades', 'challenges');
    press('PageUp');
    expectSocialOn('PageUp from Challenges', 'trades');

    // Monsters, on its two tabs (Party first, then Storage).
    press('Escape');
    expectBareWorld('after Start');
    const monstersTab = (): string[] =>
      ['party', 'storage'].filter(
        (t) => byId(`monsters-tab-${t}`).getAttribute('aria-selected') === 'true',
      );
    press('KeyV');
    expect(monstersTab(), 'V: Party').toEqual(['party']);
    press('KeyE');
    expect(monstersTab(), 'E from Party').toEqual(['storage']);
    press('KeyE');
    expect(monstersTab(), 'E from Storage wraps').toEqual(['party']);
    press('KeyQ');
    expect(monstersTab(), 'Q from Party wraps').toEqual(['storage']);
    press('KeyQ');
    expect(monstersTab(), 'Q from Storage').toEqual(['party']);
    expect(stackNames(), 'the bumpers never left Monsters').toEqual([
      'world',
      'menuView',
      'boxView',
    ]);
  });

  it('CTL11A-3-BOOT-WORLD-NOOP: Q, E, PageUp and PageDown at the world do nothing: no Journal, no Evolution, no menu, no walk and no reducer call, through a batch and a frame', async () => {
    // WRONG IMPL KILLED: today's ladder (Q opens the Journal, E the Evolution screen), a Q or E
    // that opens the menu or a leaf at the world, a world LB/RB that walks, jumps or sends an
    // intent, and a world press that leaves the stack changed after a batch or a frame (a screen
    // opened and mirrored later). The W control proves the recorders are live.
    await bootReady();
    seedWorld(1000);
    const sent = H.sends.length;
    for (const code of ['KeyQ', 'KeyE', 'PageUp', 'PageDown']) {
      press(code);
      expect(stackNames(), `${code} at the world: the stack is the bare world`).toEqual(['world']);
      expect(questLogShown(), `${code} opens no Journal`).toBe(false);
      expect(openRoots(), `${code} opens no leaf`).toEqual([]);
      expect(menuShown(), `${code} opens no menu`).toBe(false);
    }
    server(pressAt);
    frame(pressAt + 10);
    expect(stackNames(), 'and a batch and a frame change nothing').toEqual(['world']);
    expect(H.sends.length, 'no intent was sent').toBe(sent);
    expect(H.calls, 'no reducer call was made').toEqual([]);

    // Control: the same session does walk on W, so the recorders above are not deaf.
    fire('keydown', 'KeyW', pressAt + 100);
    fire('keyup', 'KeyW', pressAt + 105);
    expect(H.sends.length, 'control: W sends one step').toBe(sent + 1);
  });

  // ------------------------------------------------------------------------------------------
  // Residuals closed with ctl-11a: Select over a battle, and Monsters opened from the menu
  // ------------------------------------------------------------------------------------------

  it('CTL11A-SELECT-HELP-OVER-BATTLE: at a bare battle base Select (KeyR) opens Help over the battle, stamped with it and kept through a batch, and a second Select closes it, the battle base, the battle view and the intents untouched throughout; and at the world Select still toggles Help the same way', async () => {
    // WRONG IMPL KILLED (residual R-ctl-8j-SELECTINERT): today's toggleHelp arm, which opens only
    // when the world has focus (`overlayVerdict('helpView')` allow AND `worldHasFocus()`): the
    // battle overlay holds focus here (asserted below), so Select over a battle does nothing and
    // the first stack check reads the bare battle; a fix that opens Help but not through the stack
    // mirror (the shown root with no frame: Start and B could not close it); one that opens it
    // unstamped, or over a policy that drops it (the next batch pops it: the batch below); a second
    // Select that cannot close it (Help stuck over the battle); a Help that hides the battle view
    // or changes the base; one that sends an intent or a reducer call; and a battle fix that breaks
    // the world arm (the control: Select at the world opens and closes Help).
    await bootReady();
    seedWorld(1000);

    // Control: Select at the world toggles Help.
    expectBareWorld('precondition');
    press('KeyR');
    expect(stackNames(), 'Select at the world opens Help').toEqual(['world', 'helpView']);
    expect(openRoots(), 'and shows its root alone').toEqual(['help']);
    press('KeyR');
    expectBareWorld('a second Select at the world closes Help');

    // The battle: a bare base, the battle overlay holding focus.
    putBattle(BATTLE_ID, pressAt + 50);
    await flush();
    const BATTLE_BASE = { kind: 'battle', battleId: '101' };
    const HELP_OVER_BATTLE = { kind: 'screen', id: 'helpView', overBattle: '101' };
    expect(stack(), 'precondition: the bare battle').toEqual([BATTLE_BASE]);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(
      ['BODY', 'CANVAS'],
      'precondition: focus is inside the battle overlay, not on the world',
    ).not.toContain(document.activeElement?.tagName);
    const sent = H.sends.length;

    for (const round of ['first', 'second']) {
      press('KeyR');
      expect(stack(), `${round}: Select opens Help over the battle, stamped with it`).toEqual([
        BATTLE_BASE,
        HELP_OVER_BATTLE,
      ]);
      expect(openRoots(), `${round}: Help's root alone is the screen shown`).toEqual(['help']);
      expect(battleShown(), `${round}: the battle view stays shown beneath it`).toBe(true);

      // A batch while Help is up keeps it (it is battle-safe and belongs to this battle).
      server(pressAt);
      pressAt += 100;
      expect(stack(), `${round}: a batch leaves Help over the battle`).toEqual([
        BATTLE_BASE,
        HELP_OVER_BATTLE,
      ]);
      expect(openRoots(), `${round}: and still shown`).toEqual(['help']);

      press('KeyR');
      expect(stack(), `${round}: a second Select closes Help`).toEqual([BATTLE_BASE]);
      expect(openRoots(), `${round}: no screen is left open`).toEqual([]);
      expect(battleShown(), `${round}: the battle view is still shown`).toBe(true);
    }
    expect(H.sends.length, 'nothing walked over the battle').toBe(sent);
    expect(H.calls, 'no reducer call was made').toEqual([]);
  });

  it('CTL11A-MENU-MONSTERS-PARTY: picking Monsters in the main menu (Start, A on Monsters; and a click on its row) opens it with the Party tab alone selected and the Party panel the one shown, each time, whatever tab an RB, a B or a V left behind and through a batch and a frame; B still opens Storage', async () => {
    // WRONG IMPL KILLED (residual R-ctl-8b-CTL8B.4): today's menu path, which opens the box through
    // its legacy open and paints Storage (only the V accelerator reaches Party, by an extra LB after
    // its menu path); a tab remembered from the last open (an RB to Storage, Start, then the pick
    // would reopen on Storage; so would a pick after B); a Party tab opened by the accelerator's
    // extra LB but not by the pick itself (the click path and the key path are the two picks of one
    // entry: both run it); a strip that says Party while the Storage panel is the one shown (or the
    // reverse), two tabs selected at once; a tab painted once and reset by the next batch or frame;
    // and a fix that moves B onto Party as well (B opens Storage, as the V and B case above pins).
    // The click path is read after a frame: a pointer pick raises no keydown, so the stack is
    // mirrored at the next frame's sync, as it is for every screen the pointer opens.
    await bootReady();
    seedWorld(1000);
    opts.store.upsertMonster(monster(31n, 0));
    opts.store.upsertMonster(monster(32n, 255));
    server(1010);

    const monstersTabs = (): { selected: string[]; active: string[] } => {
      const all = ['party', 'storage'];
      return {
        selected: all.filter(
          (t) => byId(`monsters-tab-${t}`).getAttribute('aria-selected') === 'true',
        ),
        active: all.filter((t) => byId(`monsters-tab-${t}`).classList.contains('is-active')),
      };
    };
    /** Which of the Monsters frame's two panels show: each is a section heading and the grid after
     *  it (the frame root is the title's grandparent, the chain the e2e helpers resolve). */
    const panels = (): { party: boolean[]; storage: boolean[] } => {
      const title = document.querySelector('[data-testid="box-title"]');
      const root = title?.parentElement?.parentElement;
      if (!(root instanceof HTMLElement))
        throw new Error('the Monsters frame is not in the document');
      const section = (heading: string): boolean[] => {
        const h = Array.from(root.querySelectorAll('h3')).find((el) => el.textContent === heading);
        const grid = h?.nextElementSibling;
        if (h === undefined || grid === null || grid === undefined) {
          throw new Error(`no "${heading}" section in the Monsters frame`);
        }
        return [isShown(h), isShown(grid)];
      };
      return {
        party: section(i18nT('box.section.party')),
        storage: section(i18nT('box.section.box')),
      };
    };
    const expectTab = (label: string, tab: 'party' | 'storage'): void => {
      expect(monstersTabs(), `${label}: the ${tab} tab alone is selected`).toEqual({
        selected: [tab],
        active: [tab],
      });
      expect(panels(), `${label}: the ${tab} panel is the one shown`).toEqual({
        party: tab === 'party' ? [true, true] : [false, false],
        storage: tab === 'storage' ? [true, true] : [false, false],
      });
    };
    /** Monsters picked in the menu by keys: Start, the cursor to Monsters, A. */
    const pickByKeys = (): void => {
      press('KeyM');
      expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
      for (let i = 0; i < 8 && navActive() !== 'monsters'; i += 1) press('ArrowDown');
      expect(navActive(), 'precondition: the cursor is on Monsters').toBe('monsters');
      press('Enter');
    };
    /** Monsters picked by a click on its menu row (the pointer pick path). */
    const pickByClick = (): void => {
      press('KeyM');
      expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
      byId('menu-root-monsters').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      frame(pressAt + 10);
      pressAt += 100;
    };

    // Picked by keys.
    pickByKeys();
    expectLeafOpen(ROW('V'), 'A on Monsters');
    expectTab('A on Monsters', 'party');
    server(pressAt);
    frame(pressAt + 10);
    pressAt += 100;
    expectTab('A on Monsters, a batch and a frame later', 'party');

    // A tab left behind by an RB is not remembered.
    press('KeyE');
    expectTab('RB to Storage', 'storage');
    press('Escape');
    expectBareWorld('after Start');
    pickByKeys();
    expectTab('A on Monsters after an RB left Storage', 'party');

    // B opens Storage (unchanged); a pick after it still opens Party, here by the click path.
    press('Escape');
    press('KeyB');
    expectLeafOpen(ROW('B'), 'B');
    expectTab('B', 'storage');
    press('Escape');
    expectBareWorld('after Start, again');
    pickByClick();
    expectLeafOpen(ROW('V'), 'a click on Monsters after B');
    expectTab('a click on Monsters after B', 'party');

    // And once more by click, after an RB left Storage (the tab is no leftover of either path).
    press('KeyE');
    expectTab('RB to Storage, again', 'storage');
    press('Escape');
    pickByClick();
    expectTab('a click on Monsters after an RB left Storage', 'party');
  });

  // The four tests below are the red-team lens's probes of this slice, ported as it wrote them.

  it('CTL11A-PREJOIN-CLAIM: after a failed first sign-in (no identity yet) C closes the claim overlay and C opens it again, with no menu', async () => {
    // WRONG IMPL KILLED: an accelerator path that returns before join for every key, which leaves
    // the claim overlay with no way back once it is closed (the retired KeyC branch opened it
    // before join on purpose).
    await boot();
    opts.onSignInFailed?.('boom' as never);
    await flush();
    frame(pressAt);
    expect(shownById('claim-overlay'), 'precondition: the claim overlay is up').toBe(true);
    press('KeyC');
    await flush();
    expect(shownById('claim-overlay'), 'C closes it').toBe(false);
    press('KeyC');
    await flush();
    expect(shownById('claim-overlay'), 'C opens it again').toBe(true);
    expect(menuShown(), 'no menu before join').toBe(false);
  });

  it('CTL11A-PREJOIN-INERT: before join no accelerator but C opens the menu or a leaf', async () => {
    // WRONG IMPL KILLED: an accelerator path with no identity guard, which opens the menu before
    // join (the Start path refuses that).
    await boot(); // no onReady: identity is ''
    for (const row of ROWS.filter((r) => r.accel !== 'C')) {
      press(row.code);
      expect(stackNames(), `${row.accel} before join`).toEqual(['world']);
      expect(menuShown(), `${row.accel} before join: no menu`).toBe(false);
    }
  });

  it('CTL11A-ACCEL-REPEAT-IGNORED: an OS key-repeat of an accelerator is ignored, so a held key leaves its leaf open, for all nine', async () => {
    // WRONG IMPL KILLED: a repeat guard that lets accelerator codes through, where a held J opens,
    // closes (its own screen: Start) and reopens the Journal on every OS repeat.
    await bootReady();
    server(1000);
    for (const row of ROWS) {
      fire('keydown', row.code, pressAt);
      expectLeafOpen(row, `${row.accel} first press`);
      for (let i = 1; i <= 3; i += 1) {
        fire('keydown', row.code, pressAt + 40 * i, { init: { repeat: true } });
        expectLeafOpen(row, `${row.accel} repeat ${i}`);
      }
      fire('keyup', row.code, pressAt + 200);
      pressAt += 300;
      press('Escape');
    }
  });

  it('CTL11A-SELECT-HELP-NOT-OVER-FRAMES: Select with the read-only menu above a battle opens no Help', async () => {
    // WRONG IMPL KILLED: a Help arm keyed on the battle base alone, which opens Help over whatever
    // sits above the battle.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    await flush();
    press('KeyM');
    expect(stackNames()).toEqual(['battle', 'menuView']);
    press('KeyR');
    expect(stackNames(), 'Select over the menu over a battle').toEqual(['battle', 'menuView']);
    expect(shownById('help-overlay')).toBe(false);
  });

  // ------------------------------------------------------------------------------------------
  // ctl-11b: residual R-ctl-11a-POPGUARD
  // ------------------------------------------------------------------------------------------

  it('POPGUARD-CLOSE-SURFACES-FRAME: with the privacy screen open over Profile and a claim paint deferred behind it, an accelerator pops to the base, the privacy dismissal flushes the claim paint so the claim screen surfaces, and the menu does NOT open over it: no menu, no Journal, the stack is the world with the claim frame; Start then closes the claim and the same accelerator opens its path as usual', async () => {
    // WRONG IMPL KILLED (R-ctl-11a-POPGUARD, the line `if (contextStack.length > 1) return;` in
    // openAccelPath): an accelerator that opens the menu and picks its path right after the pop,
    // whatever the pop left. Privacy's dismissal (`onDismissed`) flushes the claim paint it deferred
    // while it owned the screen (`claimRenderPending`), and `popToBase` closes frames top first, so
    // the claim screen is shown by the time the pop is done and `applyStack`'s re-mirror puts it on
    // the stack. Without the guard the menu opens over that claim frame and the Journal over the
    // menu (this test's stack would read world, claimView, menuView, questLogView and the menu and
    // the Journal would be shown). The surfaced frame must instead be left to the player, who
    // closes it with Start: the control after it proves the same key opens its path from the bare
    // world, so the refusal above is the guard's and not a dead accelerator.
    await bootReady();
    server(1000);

    // Profile > Privacy by keys: Start, down to Profile, A, down to Privacy, A.
    press('KeyM');
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    for (let i = 0; i < 8 && navActive() !== 'profile'; i += 1) press('ArrowDown');
    expect(navActive(), 'precondition: the cursor is on Profile').toBe('profile');
    press('Enter');
    expect(menuTitle(), 'precondition: A entered the Profile level').toBe(levelTitle('profile'));
    for (let i = 0; i < 4 && navActive() !== 'privacy'; i += 1) press('ArrowDown');
    expect(navActive(), 'precondition: the cursor is on Privacy & data').toBe('privacy');
    press('Enter');
    expect(stackNames(), 'precondition: the privacy screen is open over the menu').toEqual([
      'world',
      'menuView',
      'privacyView',
    ]);

    // A claim paint arrives while privacy owns the screen: it is deferred, nothing shows yet.
    opts.onClaimPending?.('claim-code-1');
    expect(shownById('claim-overlay'), 'precondition: the claim paint is deferred').toBe(false);
    expect(stackNames(), 'precondition: the stack is unchanged').toEqual([
      'world',
      'menuView',
      'privacyView',
    ]);

    // The accelerator: pops to the base; the pop surfaces the claim screen.
    const e = press('KeyJ');
    expect(e.defaultPrevented, 'the accelerator press is consumed').toBe(true);
    expect(shownById('claim-overlay'), 'the privacy dismissal flushed the claim paint').toBe(true);
    expect(menuShown(), 'the menu is not opened over the surfaced claim screen').toBe(false);
    expect(questLogShown(), 'and the accelerator`s own screen is not opened over it').toBe(false);
    expect(
      stackNames(),
      'the stack is the world and the surfaced claim frame, nothing more',
    ).toEqual(['world', 'claimView']);

    // Control: Start closes the claim; the same key then opens its path from the bare world.
    press('Escape');
    expectBareWorld('after Start');
    press('KeyJ');
    expectLeafOpen(ROW('J'), 'J from the bare world');
  });
});
