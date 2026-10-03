// @vitest-environment happy-dom
/**
 * battleScreen.boot.test.ts: the battle's command list and skill grid (ctl-8i) booted through
 * main.ts over the REAL client/index.html shell, the REAL BattleView and the REAL screen-adapter
 * table and host (`SCREEN_ADAPTERS` is whatever ui/screens/index.ts ships: no stand-in is swapped
 * in). An Ongoing wild PvE battle row is seeded into the store like main.battle-reseed.test.ts
 * seeds one, with four skill rows, so the real `refreshBattle` builds the view model.
 *
 * One case (its tag is the title's first word): at the battle the D-pad (dispatched on
 * `document.activeElement`, like a browser) reaches the view through the router, the host and the
 * battle adapter: the first press only seats the cursor, Enter on Fight opens the skill grid, a
 * move walks to the last cell. Escape opens the main menu OVER the battle and Backspace (then
 * Escape) closes it again: the stack is back to the bare battle, the same skill still carries
 * aria-current, and Enter (after at most one seating press) calls `submit_attack` once with THAT
 * skill's id.
 *
 * EVERY key is dispatched ON `document.activeElement` (bubbling, like a browser), and a focused
 * <button> is CLICKED on Enter's keydown when the page did not prevent it: happy-dom does not
 * synthesize that native activation, a browser does. The deferred overlay focus (one macrotask after
 * an open, from ui/overlayA11y.ts) is flushed before any assertion that reads focus.
 *
 * Harness: profileScreen.boot.test.ts's (the real shell mounted, main.ts imported fresh per boot,
 * only the wasm pkg, the connection, telemetry and the world renderer stubbed); every reducer call
 * is recorded with its arguments.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';
import type { StoreBattle, StoreBattleMonster, StoreSkillRow } from '../../net/store';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every reducer call except enqueueMove, oldest first, with the exact argument object. */
  calls: [] as Array<{ name: string; args: unknown }>,
}));

// wasm pkg: every name main.ts imports.
vi.mock('../../../../client-wasm/pkg/client_wasm.js', () => {
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

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once. sessionState() must be 'hidden' or the session gate
// swallows every key.
vi.mock('../../net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') return () => new Promise<void>(() => {});
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

vi.mock('../../observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: init appends a focusable canvas to the mount, so main.ts finds its world region.
vi.mock('../../render/world', () => {
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
  const htmlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'index.html',
  );
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
/** The test's own monotonic time: every key and batch moves it on by 100 ms. */
let tick = 1000;
let opts: ConnectionOptions;

/** Boot a fresh main.ts over the real shell and wait for it to connect. */
async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.calls = [];
  tick = 1000;
  clock.t = tick;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  vi.resetModules();
  await import('../../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  opts.onReady(H.identity);
}

function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

/** Let queued microtasks and zero-delay timers run (the deferred overlay focus), twice over. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  await flush();
  await flush();
};

const EID = 7n;

/** Deliver one authoritative batch: the own player + character. */
function server(): void {
  tick += 100;
  clock.t = tick;
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
    tick,
  );
  opts.store.flushBatch();
}

/** One key press, then its release. The keydown goes to `target` (default: the element that has
 *  focus, else the body); a focused <button> then clicks on Enter unless the page prevented the
 *  keydown, as a browser does (happy-dom does not). */
function press(code: string, target?: EventTarget): KeyboardEvent {
  tick += 100;
  clock.t = tick;
  const at: EventTarget = target ?? document.activeElement ?? document.body;
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  at.dispatchEvent(down);
  if (
    code === 'Enter' &&
    at instanceof HTMLButtonElement &&
    !down.defaultPrevented &&
    !at.disabled
  ) {
    at.click();
  }
  clock.t = tick + 5;
  const upAt: EventTarget = target ?? document.activeElement ?? document.body;
  upAt.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
  return down;
}

/** The whole context stack through the read-only `__game()` DEV hook, as base-first frame names. */
const stackNames = (): string[] =>
  (
    window as unknown as {
      __game: () => { stack: Array<{ kind: string; id?: string }> };
    }
  )
    .__game()
    .stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

// --- the seeded battle ---------------------------------------------------------------------
/** The all-zero wild opponent: no owned opponent party, so the battle is PvE and Recruit is live. */
const WILD_IDENTITY = '0'.repeat(64);
const BATTLE_ID = 301n;
const SKILL_IDS = [21, 22, 23, 24] as const;

const MONSTER: StoreBattleMonster = {
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
  knownSkillIds: [...SKILL_IDS],
  status: null,
};

const SKILL_ROWS: readonly StoreSkillRow[] = SKILL_IDS.map((id, i) => ({
  id,
  name: `Move-${id}`,
  affinity: 'Neutral',
  power: 30 + i,
  accuracy: 100 - i,
  pp: 20,
}));

/** Deliver the skill rows and an Ongoing wild battle for the own player in one batch. */
function seedBattle(): void {
  for (const row of SKILL_ROWS) opts.store.upsertSkill(row);
  const battle: StoreBattle = {
    battleId: BATTLE_ID,
    playerIdentity: H.identity,
    opponentIdentity: WILD_IDENTITY,
    outcome: 'Ongoing',
    turnNumber: 1,
    sideA: { active: 0, team: [MONSTER] },
    sideB: { active: 0, team: [MONSTER] },
    partyMonsterIds: [1n],
    // Empty by design: this is what makes the battle wild (isPvpBattle false, canRecruit true).
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
  opts.store.upsertBattle(battle);
  tick += 100;
  clock.t = tick;
  opts.store.flushBatch();
}

// --- the battle view's DOM ---------------------------------------------------------------
/** The battle view's root: the parent of its title anchor. */
function battleRoot(): HTMLElement {
  const title = document.querySelector('[data-testid="battle-title"]');
  const root = title?.parentElement;
  if (!(root instanceof HTMLElement)) throw new Error('the battle view must be in the document');
  return root;
}
const skillCells = (): HTMLElement[] => [
  ...battleRoot().querySelectorAll<HTMLElement>('[data-battle-list="skills"]'),
];
const cursorEls = (): HTMLElement[] => [
  ...battleRoot().querySelectorAll<HTMLElement>('[aria-current="true"]'),
];
function command(id: string): HTMLElement {
  const row = battleRoot().querySelector<HTMLElement>(`[data-testid="battle-command-${id}"]`);
  if (row === null) throw new Error(`the battle view has no battle-command-${id}`);
  return row;
}
/** Whether focus is on one of the battle view's cursor elements (a row of some list). */
const focusOnAList = (): boolean => {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    battleRoot().contains(active) &&
    active.hasAttribute('data-battle-list')
  );
};

/** Exactly one aria-current, on `el`, with focus on it too. */
function expectCursorOn(el: HTMLElement, label: string): void {
  expect(cursorEls(), `${label}: exactly one aria-current in the battle view`).toHaveLength(1);
  expect(cursorEls()[0], `${label}: the cursor element`).toBe(el);
  expect(document.activeElement, `${label}: focus is on it`).toBe(el);
}

describe('the battle booted through main.ts over the real view and adapter table (ctl-8i)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8I-3-BOOT-START-MENU-RETURN: the D-pad reaches the battle view (a first press only seats the cursor, Enter on Fight opens the grid, a move walks it); Escape opens the main menu over the battle and Backspace or Escape closes it; back on the bare battle the same skill still carries the cursor, and Enter (after at most one seating press) submits THAT skill once', async () => {
    // WRONG IMPL KILLED: a battle base the host answers with baseButton (the D-pad is swallowed or
    // left to the page and no cursor ever moves); an adapter not marked nav (the router keeps the
    // arrows for the page); a view that steps on the first press from the heading (a blind D-pad
    // press would move a cursor the player cannot see); a Start that does not open the menu over
    // the battle; a menu round trip that resets the grid cursor to Fight or drops it; a seating
    // press that STEPS (Left from the last cell would land on the third); a close that loses the
    // cursor so Enter attacks with the wrong skill (or the first one); and an attack sent twice.
    await bootReady();
    server();
    seedBattle();
    await settle();
    expect(stackNames(), 'the seeded Ongoing battle is the stack base').toEqual(['battle']);
    expect(skillCells(), 'the four skills are cells of the grid').toHaveLength(SKILL_IDS.length);
    expect(cursorEls(), 'one cursor at the open').toHaveLength(1);
    expect(cursorEls()[0], 'on Fight').toBe(command('fight'));

    // --- the D-pad reaches the view: from the heading, the first press only seats the cursor ---
    (document.querySelector('[data-testid="battle-title"]') as HTMLElement).focus();
    press('ArrowDown');
    expectCursorOn(command('fight'), 'ArrowDown from the heading only seats Fight');

    // --- Enter on Fight (a native click) opens the grid on the first skill ---
    press('Enter');
    expectCursorOn(skillCells()[0] as HTMLElement, 'Enter on Fight');
    expect(callsOf('submitAttack'), 'opening the grid attacks nothing').toEqual([]);

    // --- KeyD (Right), then KeyS (Down): the last cell of the 2x2 grid ---
    press('KeyD');
    expectCursorOn(skillCells()[1] as HTMLElement, 'KeyD steps right');
    press('KeyS');
    const last = skillCells()[3] as HTMLElement;
    expectCursorOn(last, 'KeyS steps down to the last cell');
    expect(callsOf('submitAttack'), 'walking the grid attacks nothing').toEqual([]);

    // --- Escape opens the main menu OVER the battle; Backspace closes it ---
    press('Escape');
    expect(stackNames(), 'Start opens the menu above the battle').toEqual(['battle', 'menuView']);
    await settle();
    expect(cursorEls()[0], 'the menu changed nothing in the battle view').toBe(last);
    press('Backspace');
    expect(stackNames(), 'Backspace closes the menu: the bare battle again').toEqual(['battle']);
    await settle();
    expect(cursorEls(), 'one cursor after the first round trip').toHaveLength(1);
    expect(cursorEls()[0], 'still on the last skill').toBe(skillCells()[3]);

    // --- a second round trip, closed with Escape (Start) this time ---
    if (!focusOnAList()) press('ArrowLeft'); // a seating press: it must not step
    expectCursorOn(
      skillCells()[3] as HTMLElement,
      'seated on the last skill before the second trip',
    );
    press('Escape');
    expect(stackNames(), 'the second Start opens it again').toEqual(['battle', 'menuView']);
    await settle();
    press('Escape');
    expect(stackNames(), 'Start closes the menu').toEqual(['battle']);
    await settle();
    expect(cursorEls(), 'one cursor after the second round trip').toHaveLength(1);
    expect(cursorEls()[0], 'still on the last skill').toBe(skillCells()[3]);
    expect(callsOf('submitAttack'), 'a menu round trip attacks nothing').toEqual([]);

    // --- at most one seating press, then Enter submits THAT skill, once ---
    if (!focusOnAList()) {
      press('ArrowLeft'); // Left from the last cell would step to the third: a seat must not
    }
    expectCursorOn(skillCells()[3] as HTMLElement, 'seated on the same skill');
    press('Enter');
    expect(callsOf('submitAttack'), 'Enter submits the remembered skill once').toEqual([
      { name: 'submitAttack', args: { battleId: BATTLE_ID, skillId: SKILL_IDS[3] } },
    ]);
    await settle();
    expect(callsOf('submitAttack'), 'and only once').toHaveLength(1);
  });
});
