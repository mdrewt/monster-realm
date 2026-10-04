// @vitest-environment happy-dom
/**
 * main.controls.test.ts: the booted Start / B / Select / typing-mode controls (ctl-6b, CTL6B.1 to
 * CTL6B.6).
 *
 * The adapters, the router rules, the pure stack rules and `typingKey` are proven in their own
 * pure suites. This file proves the SHELL: that a freshly imported main.ts sends real key events
 * through the router into the top frame's adapter and applies the command it gets back. Every case
 * dispatches real, bubbling KeyboardEvents at the real window listeners (or at the real focused
 * element, so the capture-phase Escape and the views' own stopPropagation are both in play) and
 * reads only what a player or a server can see: which overlays are shown, `defaultPrevented`,
 * which element holds focus, the intents sent to the (stubbed) enqueueMove reducer, the reducer
 * calls with their exact arguments, and the read-only `__game()` hook (`stack`, `navActive`).
 *
 * Harness: main.menu.test.ts's pattern, copied (vi.resetModules + a fresh import per test, recorded
 * window/document listeners detached in afterEach, one controllable clock, a controllable rAF, a
 * stubbed wasm pkg and SDK connection, the real client/index.html shell mounted first), with ONE
 * delta: every reducer call except enqueueMove is recorded WITH its arguments, so a test can assert
 * the exact reducer and payload a command reached. Battle and conversation fixtures are
 * main.input.test.ts's and main.dialogueDismiss.test.ts's.
 *
 * Escape means Start from this slice on: above a base it pops to the base, at the world base it
 * opens the main menu, on an Ongoing battle it opens the main menu over it (ctl-6c: the battle is
 * never hidden, B17), on a terminal outcome it continues. Backspace (B) pops exactly one frame.
 * Select (R, Slash, Shift+Slash) toggles help. The ctl-6c cases at the end of this file prove the
 * battle semantics: Start over a battle, A / B continuing an outcome, the battle-safe policy.
 * Inside a text field Escape stops typing and keeps the text; the next Escape acts as Start.
 *
 * Every key press is followed by its keyup: the keyboard source reads a second non-repeat keydown
 * of a code it holds as a lost keyup.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreMonsterPub,
  StoreTradeOffer,
} from './net/store';
// The test's own resolver instance (main.ts gets a fresh one per boot): both default to English, so
// `i18nT(id)` here is the text the shell paints for that id.
import { t as i18nT } from './ui/i18n/resolver';
import type { NavInput } from './ui/nav';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** The screen-adapter table main.ts's host reads: a mutable copy of the real one, re-made by the
   *  module mock below on every fresh import, so a ctl-7c case can swap ONE frame's adapter. */
  adapters: {} as Record<string, unknown>,
  /** ctl-10b: what the stubbed wasm `interact_candidates_coded` answers (the interaction RULE is
   *  the stub: `openFaceToFace` installs one that names the faced player). Reset by every boot. */
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
}));

// wasm pkg: every name main.ts imports. apply_move is a real one-tile step on an open grid.
// ctl-10b: named fixture change: the interact export is a stub driven by `H.interact` (the trade
// wizard is now opened face to face, through A, so the rule must be answerable here).
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

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once.
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

// The screen-adapter table: the real module with SCREEN_ADAPTERS replaced by a mutable copy of
// itself (every entry the same legacy adapter, so nothing changes until a case swaps one).
vi.mock('./ui/screens/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/screens/index')>();
  H.adapters = { ...actual.SCREEN_ADAPTERS };
  return { ...actual, SCREEN_ADAPTERS: H.adapters };
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
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.interact = () => [];
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
const OTHER_IDENTITY = 'cd'.repeat(32);
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
function tap(
  code: string,
  t: number,
  init?: KeyboardEventInit,
  target?: EventTarget,
): KeyboardEvent {
  const down = fire('keydown', code, t, { init, target });
  fire('keyup', code, t + 5, { init, target });
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
const shownById = (id: string): boolean => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return isShown(el);
};
const shownByTestId = (testId: string): boolean => {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`[data-testid="${testId}"] is not in the document`);
  return isShown(el);
};
const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};

const menuShown = (): boolean => shownById('menu-overlay');
const helpShown = (): boolean => shownById('help-overlay');
const renameShown = (): boolean => shownById('rename-overlay');
const proposeShown = (): boolean => shownById('tradepropose-overlay');
const tradeShown = (): boolean => shownById('trade-overlay');
const questLogShown = (): boolean => shownById('quest-log-overlay');
const rankingsShown = (): boolean => shownById('leaderboard-title');
const dialogueShown = (): boolean => shownById('dialogue-overlay');
const claimShown = (): boolean => shownById('claim-overlay');
const boxShown = (): boolean => shownByTestId('box-title');
const battleShown = (): boolean => shownByTestId('battle-title');

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
/** The stack as base-first names: the base kind, then each upper frame's overlay id. */
const stackNames = (): string[] =>
  stack().map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));
const navActive = (): string | null => game().navActive;

/** Every recorded reducer call of one name, in order. */
const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

/** Put `text` into a field the way a user does: set the value, then fire its input event. */
function typeInto(el: HTMLInputElement, text: string): void {
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const FACED_ENTITY = 99n;

/**
 * ctl-10b (named intentional change): O no longer opens the trade wizard. The one way in is face to
 * face: another online player, with a character row, stands on the faced tile; the stubbed wasm rule
 * names that player; A opens the picker (Trade, Challenge); A on the first row (Trade) opens the
 * wizard on Offer with that player pre-selected. Delivers one batch at `t` (the player and the
 * own character), then the two presses at `t + 10` and `t + 30` (each with its keyup 5 ms later).
 */
function openFaceToFace(t: number): void {
  H.interact = (...args: unknown[]) => {
    const entities = args[4] as ReadonlyArray<{ kind: string; id: string }>;
    const at = entities.findIndex((e) => e.kind === 'player' && e.id === FACED_ENTITY.toString());
    return at === -1 ? [] : [at];
  };
  opts.store.upsertPlayer({
    identity: OTHER_IDENTITY,
    entityId: FACED_ENTITY,
    name: 'Zed',
    online: true,
    lastInputSeq: 0n,
  });
  opts.store.upsertCharacter(
    {
      entityId: FACED_ENTITY,
      zoneId: 0,
      tileX: 3,
      tileY: 6,
      facing: 'West',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
  server(t);
  tap('Enter', t + 10);
  tap('Enter', t + 30);
}

/** Boot, join, open the menu with M and walk the cursor down `downs` entries. */
async function bootAtMenu(downs = 0): Promise<void> {
  await bootReady();
  server(1000);
  tap('KeyM', 1010);
  expect(menuShown(), 'precondition: M opened the menu').toBe(true);
  for (let i = 0; i < downs; i += 1) tap('ArrowDown', 1100 + i * 100);
}

describe('main.ts Start / B / Select / typing mode (runtime, ctl-6b)', { sequential: true }, () => {
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
  // CTL6B.1: one dispatch
  // ------------------------------------------------------------------------------------------

  it('CTL6B-1-MAIN-DISPATCH: view callbacks reach their reducers through the one dispatch with the exact arguments (trade accept vs reject, rename submit, dialogue choices), and a Backspace pop of the dialogue frame dismisses once', async () => {
    // WRONG IMPL KILLED: a dispatch arm wired to the wrong reducer (accept and reject share one
    // reducer and differ only by `accepted`: a swapped boolean accepts what the player rejected), an
    // arm that drops or reshapes an argument (the trade id, the trimmed name, the choice index), a
    // view callback that no longer reaches its reducer at all (the refactor to one dispatch is
    // behaviour-preserving, so every arm is pinned by its payload), and a command path (Backspace
    // over the dialogue frame: router -> pop command -> dispatch -> dismissDialogue) that never
    // reaches the reducer or reaches it twice.
    await bootReady();
    seedWorld(1000);

    // --- a same-shape pair: respond_trade accepted:true vs accepted:false --------------------
    const offer: StoreTradeOffer = {
      tradeId: 5n,
      initiator: OTHER_IDENTITY,
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
      createdAtMs: 0n,
    };
    opts.store.upsertTradeOffer(offer);
    server(1010);
    tap('KeyU', 1020);
    expect(tradeShown(), 'precondition: the trade overlay opened').toBe(true);
    const accept = document.querySelector('#trade-actions button[data-action="accept"]');
    const reject = document.querySelector('#trade-actions button[data-action="reject"]');
    expect(accept, 'precondition: the counterparty is offered Accept').not.toBeNull();
    expect(reject, 'precondition: and Reject').not.toBeNull();
    expect(callsOf('respondTrade'), 'precondition: nothing sent yet').toEqual([]);

    (accept as HTMLButtonElement).click();
    expect(callsOf('respondTrade'), 'Accept sends accepted:true for this trade').toEqual([
      { name: 'respondTrade', args: { tradeId: 5n, accepted: true } },
    ]);
    await flush();
    (reject as HTMLButtonElement).click();
    expect(callsOf('respondTrade'), 'Reject sends accepted:false for the same trade').toEqual([
      { name: 'respondTrade', args: { tradeId: 5n, accepted: true } },
      { name: 'respondTrade', args: { tradeId: 5n, accepted: false } },
    ]);
    await flush();
    tap('KeyU', 1100); // the same key closes it
    expect(tradeShown(), 'precondition: the trade overlay closed').toBe(false);

    // --- rename submit: set_profile_name with the trimmed draft ------------------------------
    tap('KeyN', 1200);
    expect(renameShown(), 'precondition: the rename overlay opened').toBe(true);
    typeInto(byId('rename-input') as HTMLInputElement, '  Zed  ');
    (byId('rename-submit') as HTMLButtonElement).click();
    expect(callsOf('setProfileName'), 'the trimmed name reaches set_profile_name once').toEqual([
      { name: 'setProfileName', args: { name: 'Zed' } },
    ]);
    await flush();
    tap('KeyN', 1300); // the same key closes it
    expect(renameShown(), 'precondition: the rename overlay closed').toBe(false);

    // --- dialogue: choice clicks (a pair) and the pop command's dismiss ------------------------
    startConversation(1400);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    for (const idx of ['2', '0']) {
      const choice = document.createElement('button');
      choice.dataset.choiceIdx = idx;
      document.body.appendChild(choice);
      choice.click();
      choice.remove();
    }
    expect(
      callsOf('advanceDialogue'),
      'each choice reaches advance_dialogue with its own index',
    ).toEqual([
      { name: 'advanceDialogue', args: { choiceIdx: 2 } },
      { name: 'advanceDialogue', args: { choiceIdx: 0 } },
    ]);
    expect(callsOf('dismissDialogue'), 'precondition: no dismiss yet').toEqual([]);
    const back = tap('Backspace', 1500);
    expect(back.defaultPrevented, 'the consumed B press is prevented').toBe(true);
    expect(callsOf('dismissDialogue'), 'popping the dialogue frame dismisses exactly once').toEqual(
      [{ name: 'dismissDialogue', args: {} }],
    );
  });

  // ------------------------------------------------------------------------------------------
  // CTL6B.2: Start (Escape or M)
  // ------------------------------------------------------------------------------------------

  it('CTL6B-2-MAIN-ESCAPE-POPS-TO-BASE: one Escape with a child over the menu closes both and returns to the world base, where the world walks again', async () => {
    // WRONG IMPL KILLED: an Escape that closes only the top frame (the old Escape stack: the menu
    // would stay up under the closed child), an Escape that is not prevented, a pop that closes the
    // overlays but leaves the stack mirroring them (movement stays dead), and a base that is not the
    // world after the pop.
    await bootAtMenu(2);
    expect(navActive(), 'precondition: the cursor is on Journal').toBe('journal');
    tap('Enter', 1400);
    expect(questLogShown(), 'precondition: the child is open above the menu').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView', 'questLogView']);

    const esc = tap('Escape', 1500);
    expect(esc.defaultPrevented, 'the consumed Start press is prevented').toBe(true);
    expect(questLogShown(), 'the child is closed').toBe(false);
    expect(menuShown(), 'and the menu with it').toBe(false);
    expect(stackNames(), 'the stack is the bare world').toEqual(['world']);
    expect(navActive(), 'a closed menu has no active entry').toBeNull();

    // The base is live: a fresh D-pad press at the world steps once.
    const before = H.sends.length;
    fire('keydown', 'KeyW', 1600);
    expect(H.sends.length, 'the world walks again').toBe(before + 1);
    fire('keyup', 'KeyW', 1605);
  });

  it('Escape from a menu sub-list child pops straight to the world: the leaderboard over Social > Rankings closes with the menu', async () => {
    // WRONG IMPL KILLED: a pop-to-base that stops at the menu's sub-list level, and one that closes
    // the child and leaves the menu painted.
    await bootAtMenu(3);
    expect(navActive(), 'precondition: the cursor is on Social').toBe('social');
    tap('Enter', 1500);
    expect(navActive(), 'precondition: the sub-list starts on Trades').toBe('trades');
    tap('ArrowDown', 1600);
    tap('ArrowDown', 1700);
    expect(navActive(), 'precondition: the cursor is on Rankings').toBe('rankings');
    tap('Enter', 1800);
    expect(rankingsShown(), 'precondition: the leaderboard opened').toBe(true);
    // ctl-8s (named intentional change, CTL8S.3): the leaderboard root is the Rankings panel of the
    // ONE Social frame, so the frame above the menu is `social`. Was: 'leaderboardView'.
    expect(stackNames()).toEqual(['world', 'menuView', 'social']);

    tap('Escape', 1900);
    expect(rankingsShown(), 'the leaderboard is closed').toBe(false);
    expect(menuShown(), 'and so is the menu').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('CTL6B-2-MAIN-START-OPENS-MENU: at the world base Escape and M open the main menu once joined, a second Escape closes it, and before joining Escape opens nothing', async () => {
    // WRONG IMPL KILLED: an Escape that still only closes (red today: the menu never opens), an
    // open that skips the join guard (the menu's screens read store state keyed by identity, which
    // is '' before join), a Start that toggles on the wrong frame, and an M that no longer opens.
    await boot();
    tap('Escape', 1010);
    expect(menuShown(), 'before joining, Escape opens no menu').toBe(false);
    expect(stackNames()).toEqual(['world']);
    // Anti-vacuity: the same press does open it once the player has joined.
    opts.onReady(H.identity);
    server(1100);
    const esc = tap('Escape', 1200);
    expect(menuShown(), 'joined: Escape at the world opens the menu').toBe(true);
    expect(esc.defaultPrevented, 'and is prevented').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView']);
    expect(navActive(), 'on the first entry').toBe('monsters');

    tap('Escape', 1300);
    expect(menuShown(), 'a second Escape (Start over a frame) closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);

    tap('KeyM', 1400);
    expect(menuShown(), 'M is Start too: it opens the menu').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView']);
    tap('KeyM', 1500);
    expect(menuShown(), 'and closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('CTL6B-2-MAIN-ONGOING-BATTLE: Escape and M on an Ongoing battle open the menu over it and close it again, Backspace stays inert, the battle is never hidden, W predicts no step, and the same Escape continues a terminal outcome', async () => {
    // INTENTIONAL CHANGE (ctl-6c, CTL6C.1): Escape and M used to leave an Ongoing battle exactly as it
    // was (B17); they now open the main menu over it, and the same key closes it again. Backspace
    // stays inert at the bare battle base.
    // WRONG IMPL KILLED (B17): an Escape that hides the Ongoing battle (the old bare hide: the
    // character then walks into a battle the server rejects), a Start that still does nothing at
    // the battle (the menu never opens: red today), a Start that opens the menu and HIDES the
    // battle under it, a second Start that does not close the menu, a B that pops the battle base or
    // hides it or opens the menu, a movement gate that opens with the overlay hidden, and a
    // control-less test: the terminal outcome below proves the key works.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the Ongoing battle is on screen').toBe(true);
    expect(stack(), 'precondition: the base is the battle').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    const sent = H.sends.length;

    for (const [i, code] of ['Escape', 'KeyM'].entries()) {
      const at = 1200 + i * 200;
      tap(code, at);
      expect(menuShown(), `${code}: Start over an Ongoing battle opens the menu`).toBe(true);
      expect(battleShown(), `${code}: the Ongoing battle stays up under the menu`).toBe(true);
      expect(stack(), `${code}: the battle base with the menu above it`).toEqual([
        { kind: 'battle', battleId: '101' },
        { kind: 'screen', id: 'menuView', overBattle: '101' },
      ]);
      tap(code, at + 100);
      expect(menuShown(), `${code}: a second Start closes the menu`).toBe(false);
      expect(battleShown(), `${code}: the battle is still up after the menu closes`).toBe(true);
      expect(stack(), `${code}: the bare battle base again`).toEqual([
        { kind: 'battle', battleId: '101' },
      ]);
    }
    tap('Backspace', 1600);
    expect(battleShown(), 'Backspace: the Ongoing battle stays up').toBe(true);
    expect(stack(), 'Backspace: still the bare battle base').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    expect(menuShown(), 'Backspace: B opens no menu over a battle').toBe(false);
    fire('keydown', 'KeyW', 1650);
    fire('keyup', 'KeyW', 1655);
    frame(1700);
    expect(H.sends.length, 'W predicts and sends no step over a battle base').toBe(sent);

    // Control: the SAME key on a terminal outcome continues it.
    putBattle(BATTLE_ID, 1800, 'SideAWins');
    expect(battleShown(), 'precondition: the outcome frame is up').toBe(true);
    expect(stack(), 'precondition: the outcome is a frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'battleView' },
    ]);
    tap('Escape', 1900);
    expect(battleShown(), 'control: Escape continues a terminal outcome').toBe(false);
    expect(stack()).toEqual([{ kind: 'world' }]);
  });

  it('CTL6B-2-MAIN-OUTCOME-CONTINUE: Escape continues a terminal outcome and it never re-pops; a second battle with a new id still shows and Backspace continues it too', async () => {
    // WRONG IMPL KILLED: a continue that hides the view without latching the dismissed id (the next
    // batch re-pops the outcome), one that latches an Ongoing battle's id, one that never latches the
    // NEWER terminal battle (a stale id would hide every later outcome), a B that does not continue,
    // and a pop-to-base that leaves the outcome frame on the stack.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the first battle is on screen').toBe(true);
    putBattle(BATTLE_ID, 1200, 'SideAWins');
    expect(battleShown(), 'precondition: its outcome is shown').toBe(true);
    expect(stackNames()).toEqual(['world', 'battleView']);

    tap('Escape', 1300);
    expect(battleShown(), 'Escape continues the outcome').toBe(false);
    expect(stackNames()).toEqual(['world']);
    // The next batches (and a frame) must not bring it back.
    server(1400);
    frame(1410);
    server(1500);
    expect(battleShown(), 'it never re-pops on a later batch').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // A second battle with a NEW id still shows its outcome, and Backspace continues it too.
    putBattle(102n, 1600);
    expect(battleShown(), 'precondition: the second battle is on screen').toBe(true);
    putBattle(102n, 1700, 'SideBWins');
    expect(battleShown(), 'the second outcome is not hidden by the first one`s latch').toBe(true);
    expect(stackNames()).toEqual(['world', 'battleView']);
    const back = tap('Backspace', 1800);
    expect(back.defaultPrevented, 'the consumed B press is prevented').toBe(true);
    expect(battleShown(), 'Backspace continues it').toBe(false);
    server(1900);
    server(2000);
    expect(battleShown(), 'and it does not re-pop either').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // The world walks again.
    const before = H.sends.length;
    fire('keydown', 'KeyW', 2100);
    expect(H.sends.length, 'a fresh press steps once').toBe(before + 1);
    fire('keyup', 'KeyW', 2105);
  });

  it('CTL6B-2-MAIN-DIALOGUE-DISMISS: Escape on a conversation sends dismissDialogue once while it is pending (Escape x2, Backspace), the overlay stays until the server removes it, and a new conversation dismisses again', async () => {
    // WRONG IMPL KILLED: a Start that hides the dialogue client-side (it strands the server
    // player_conversation row), one that sends no dismiss, one that sends one per press (the in-
    // flight guard is the shop-open step's), a dismiss emitted when the SERVER ends the conversation
    // (a stray reducer call), a B that does not dismiss, and a dismiss flag that is never cleared by
    // the no-conversation batch (the second conversation would be undismissable).
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    expect(stackNames()).toEqual(['world', 'dialogueView']);
    expect(callsOf('dismissDialogue'), 'precondition: nothing dismissed yet').toEqual([]);

    tap('Escape', 1100);
    expect(callsOf('dismissDialogue'), 'Escape dismisses once').toHaveLength(1);
    expect(dialogueShown(), 'the overlay is still up: only the server ends a conversation').toBe(
      true,
    );
    expect(stackNames(), 'and still mirrored on the stack').toEqual(['world', 'dialogueView']);
    tap('Escape', 1200);
    expect(callsOf('dismissDialogue'), 'a second Escape while pending sends nothing').toHaveLength(
      1,
    );
    tap('Backspace', 1300);
    expect(callsOf('dismissDialogue'), 'nor does Backspace').toHaveLength(1);
    expect(dialogueShown(), 'still up').toBe(true);

    // The server's batch removes the conversation: hidden, with no further dismiss.
    endConversation(1400);
    expect(dialogueShown(), 'hidden only after the no-conversation batch').toBe(false);
    expect(callsOf('dismissDialogue'), 'the server-side end sends no dismiss').toHaveLength(1);
    expect(stackNames()).toEqual(['world']);

    // A new conversation: Backspace dismisses it (the pending flag was cleared by that batch).
    startConversation(1500);
    expect(dialogueShown(), 'precondition: a second conversation opened').toBe(true);
    tap('Backspace', 1600);
    expect(callsOf('dismissDialogue'), 'the second conversation is dismissed').toHaveLength(2);
    expect(dialogueShown(), 'and stays until the server ends it').toBe(true);
    tap('Escape', 1700);
    expect(callsOf('dismissDialogue'), 'once while pending').toHaveLength(2);
    endConversation(1800);
    expect(dialogueShown()).toBe(false);
  });

  // ------------------------------------------------------------------------------------------
  // CTL6B.3: B pops exactly one frame
  // ------------------------------------------------------------------------------------------

  it('CTL6B-3-MAIN-BACKSPACE-ONE: Backspace closes only the top frame (the child over the menu, then the menu), backs a hotkey-opened leaf out into the menu one frame at a time, and is swallowed at the world base', async () => {
    // ctl-11a: a hotkey (J) now opens its leaf OVER the main menu, so Backspace from it returns to the
    // menu (one frame), not to the world; a second Backspace then closes the menu. Was: Q opened the
    // quest log with no menu under it and one Backspace closed it to the world.
    // WRONG IMPL KILLED: a B that pops to the base (the menu would close with its child), one that
    // pops nothing for a hotkey-opened leaf (red today: B is unrouted without the menu), one that
    // pops the base or opens the menu at the world, and a B at the world
    // base that falls through to the browser (Backspace navigates back).
    await bootAtMenu(2);
    tap('Enter', 1400);
    expect(questLogShown(), 'precondition: the child is open above the menu').toBe(true);
    const back = tap('Backspace', 1500);
    expect(back.defaultPrevented).toBe(true);
    expect(questLogShown(), 'the child closed').toBe(false);
    expect(menuShown(), 'the menu stays').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView']);
    tap('Backspace', 1600);
    expect(menuShown(), 'a second B closes the menu').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // At the world base B is swallowed and opens nothing.
    const atWorld = tap('Backspace', 1700);
    expect(atWorld.defaultPrevented, 'B at the world base never reaches the browser').toBe(true);
    expect(menuShown()).toBe(false);
    expect(stackNames()).toEqual(['world']);

    // A hotkey-opened leaf has the menu under it: B backs out into the menu, one frame at a time.
    tap('KeyJ', 1800);
    expect(questLogShown(), 'precondition: J opened the quest log').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView', 'questLogView']);
    const close = tap('Backspace', 1900);
    expect(close.defaultPrevented).toBe(true);
    expect(questLogShown(), 'Backspace closed the hotkey-opened leaf').toBe(false);
    expect(menuShown(), 'and left the menu it was opened over').toBe(true);
    expect(stackNames(), 'one frame: the menu, not the world').toEqual(['world', 'menuView']);
    tap('Backspace', 2000);
    expect(menuShown(), 'a second B closes the menu').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('CTL6B-3-MAIN-CLAIM: after C the claim overlay closes on Escape (with the menu it was opened over) and Backspace closes it back into that menu, and Escape does not also open the menu', async () => {
    // ctl-11a: C opens the claim overlay OVER the main menu (Profile > Account), so the stack gains
    // the menu, Escape (Start) closes both, and Backspace closes only the claim overlay and leaves
    // the menu. Was: [world, claimView] and Backspace returned straight to the world.
    // WRONG IMPL KILLED (B4): the claim overlay with no close path but its own toggle (the retired
    // Escape stack had no claim branch), a Start that closes it and then opens the menu in the same
    // press, and a B that is not routed for it.
    await bootReady();
    server(1000);
    tap('KeyC', 1010);
    expect(claimShown(), 'precondition: C opened the claim overlay').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView', 'claimView']);
    const esc = tap('Escape', 1100);
    expect(esc.defaultPrevented).toBe(true);
    expect(claimShown(), 'Escape closes the claim overlay').toBe(false);
    expect(menuShown(), 'and the menu beneath it, not re-opened in the same press').toBe(false);
    expect(stackNames()).toEqual(['world']);

    tap('KeyC', 1200);
    expect(claimShown(), 'precondition: C reopened it').toBe(true);
    tap('Backspace', 1300);
    expect(claimShown(), 'Backspace closes it too').toBe(false);
    expect(menuShown(), 'back into the menu it was opened over').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView']);
  });

  // ------------------------------------------------------------------------------------------
  // CTL6B.4: Select toggles help
  // ------------------------------------------------------------------------------------------

  it('CTL6B-4-MAIN-SELECT-HELP: Slash (bare or with Shift) and R each toggle help open and closed and are prevented; a "?" key on a non-Slash code does nothing', async () => {
    // WRONG IMPL KILLED (r2-016): a bare "/" that does nothing (the retired e.key === "?" branch),
    // a Shift+Slash that no longer works, an R that is unbound, a help that can only open (the
    // second press must close), a Select that is not prevented (Slash would trigger quick-find),
    // and a branch that still reads the typed glyph (a "?" on another code would open help).
    await bootReady();
    server(1000);
    expect(helpShown(), 'precondition: help starts closed').toBe(false);

    const bare = tap('Slash', 1010, { key: '/' });
    expect(bare.defaultPrevented, 'Slash is prevented').toBe(true);
    expect(helpShown(), 'a bare Slash opens help').toBe(true);
    expect(stackNames()).toEqual(['world', 'helpView']);

    const shifted = tap('Slash', 1100, { key: '?', shiftKey: true });
    expect(shifted.defaultPrevented, 'Shift+Slash is prevented').toBe(true);
    expect(helpShown(), 'Shift+Slash closes it (a toggle)').toBe(false);
    expect(stackNames()).toEqual(['world']);

    tap('Slash', 1200, { key: '?', shiftKey: true });
    expect(helpShown(), 'Shift+Slash opens it').toBe(true);
    tap('Slash', 1300, { key: '/' });
    expect(helpShown(), 'a bare Slash closes it').toBe(false);

    const r = tap('KeyR', 1400);
    expect(r.defaultPrevented, 'R is prevented').toBe(true);
    expect(helpShown(), 'R opens help').toBe(true);
    tap('KeyR', 1500);
    expect(helpShown(), 'R closes it').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // The glyph alone is not Select: a "?" typed on some other physical key does nothing.
    const stray = tap('Digit8', 1600, { key: '?', shiftKey: true });
    expect(helpShown(), 'a "?" on a non-Slash code opens nothing').toBe(false);
    expect(stray.defaultPrevented, 'and is left to the browser').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('Select works before joining: Slash and R open and close help while identity is still empty', async () => {
    // WRONG IMPL KILLED: an identity guard on help (help is display-only and has worked pre-join
    // since it shipped), while the menu keeps its guard.
    await boot();
    const slash = tap('Slash', 1010, { key: '/' });
    expect(slash.defaultPrevented).toBe(true);
    expect(helpShown(), 'a bare Slash opens help before join').toBe(true);
    tap('KeyR', 1100);
    expect(helpShown(), 'R closes it').toBe(false);
    tap('KeyR', 1200);
    expect(helpShown(), 'and opens it').toBe(true);
    tap('Slash', 1300, { key: '?', shiftKey: true });
    expect(helpShown(), 'Shift+Slash closes it').toBe(false);
  });

  // ------------------------------------------------------------------------------------------
  // CTL6B.5: typing mode
  // ------------------------------------------------------------------------------------------

  it('CTL6B-5-MAIN-RENAME-TYPING: Escape in the rename field stops typing and keeps the text, the next Escape closes, Escape on the focused submit closes, and letters typed in the field open no hotkey', async () => {
    // WRONG IMPL KILLED (B5): an Escape the view's own stopPropagation hides from the router (the
    // submit button case: nothing happened at all), an Escape in the field that closes the overlay
    // and wipes the draft, one that is not prevented (the field's own handler would then hide it),
    // one that leaves focus in the field (the second Escape would be typed into it), a typed letter
    // that fires a hotkey (typing "b" would open the box), and a stop that never lets the next
    // Escape act as Start.
    // ctl-11a: N opens the Name screen OVER the main menu (Profile > Name), so every stack here
    // carries `menuView` beneath it, and "no menu" becomes "no frame change": the menu that is
    // already there stays and no typed letter pops, replaces or adds a frame.
    await bootReady();
    server(1000);
    tap('KeyN', 1010);
    expect(renameShown(), 'precondition: N opened the rename overlay').toBe(true);
    const overlay = byId('rename-overlay');
    const input = byId('rename-input') as HTMLInputElement;
    const submit = byId('rename-submit') as HTMLButtonElement;
    input.focus();
    expect(document.activeElement, 'precondition: the field has focus').toBe(input);
    typeInto(input, 'Alice');
    expect(submit.disabled, 'precondition: a draft enables the submit button').toBe(false);

    // Letters typed in the field fire no hotkey and the draft survives.
    for (const [i, code] of ['KeyB', 'KeyI', 'KeyM', 'KeyR', 'Slash', 'KeyQ'].entries()) {
      fire('keydown', code, 1020 + i * 10, { target: input });
      fire('keyup', code, 1025 + i * 10, { target: input });
    }
    expect(boxShown(), 'typing b opens no box').toBe(false);
    expect(
      stackNames(),
      'typing m (Start) opens or closes no menu: the one beneath the Name screen stays',
    ).toEqual(['world', 'menuView', 'renameView']);
    expect(helpShown(), 'typing r or / opens no help').toBe(false);
    expect(questLogShown(), 'typing q opens no quest log').toBe(false);
    expect(renameShown(), 'the overlay is still up').toBe(true);
    expect(input.value, 'and the draft is intact').toBe('Alice');

    // Escape #1: stop typing, keep the text, keep the overlay.
    const esc1 = fire('keydown', 'Escape', 1100, { target: input });
    fire('keyup', 'Escape', 1105, { target: input });
    expect(esc1.defaultPrevented, 'the stop-typing press is prevented').toBe(true);
    expect(renameShown(), 'the overlay stays').toBe(true);
    expect(input.value, 'the text is kept').toBe('Alice');
    expect(document.activeElement, 'focus left the field').not.toBe(input);
    expect(
      overlay.contains(document.activeElement),
      'and moved inside the overlay, not to the page',
    ).toBe(true);
    expect(
      stackNames(),
      'stopping typing is not Start: the menu beneath the Name screen is not popped with it',
    ).toEqual(['world', 'menuView', 'renameView']);

    // Escape #2 acts as Start on whatever now has focus.
    const active = document.activeElement as HTMLElement;
    fire('keydown', 'Escape', 1200, { target: active });
    fire('keyup', 'Escape', 1205, { target: active });
    expect(renameShown(), 'the second Escape closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);
    expect(menuShown(), 'and the menu beneath it, which is not re-opened').toBe(false);

    // B5: Escape on the focused submit button closes (the view's own listener hides it from the
    // window's bubble phase).
    tap('KeyN', 1300);
    expect(renameShown(), 'precondition: reopened').toBe(true);
    typeInto(input, 'Bob');
    submit.focus();
    expect(document.activeElement, 'precondition: the submit button has focus').toBe(submit);
    fire('keydown', 'Escape', 1400, { target: submit });
    fire('keyup', 'Escape', 1405, { target: submit });
    expect(renameShown(), 'Escape on the focused submit closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('CTL6B-5-MAIN-ENTER-COMMITS: after Escape stops typing the text is kept, and Enter in the field commits it through set_profile_name exactly once', async () => {
    // WRONG IMPL KILLED: an Escape that wipes the draft (the later Enter would commit nothing), an
    // Enter that no longer reaches the owner's commit (the Command path), and an Enter that commits
    // twice (the router's A edge and the view's own listener both acting).
    await bootReady();
    server(1000);
    tap('KeyN', 1010);
    expect(renameShown(), 'precondition: the rename overlay opened').toBe(true);
    const input = byId('rename-input') as HTMLInputElement;
    input.focus();
    typeInto(input, 'Alice');

    fire('keydown', 'Escape', 1100, { target: input });
    fire('keyup', 'Escape', 1105, { target: input });
    expect(renameShown(), 'precondition: the overlay survived the first Escape').toBe(true);
    expect(input.value, 'precondition: the text was kept').toBe('Alice');
    expect(callsOf('setProfileName'), 'precondition: nothing committed yet').toEqual([]);

    input.focus();
    expect(document.activeElement, 'precondition: back in the field').toBe(input);
    fire('keydown', 'Enter', 1200, { target: input });
    fire('keyup', 'Enter', 1205, { target: input });
    expect(callsOf('setProfileName'), 'Enter commits the kept text once').toEqual([
      { name: 'setProfileName', args: { name: 'Alice' } },
    ]);
    expect(renameShown(), 'the overlay stays open on a commit').toBe(true);
  });

  it('Escape in a trade-propose currency input stops typing: the value is kept, focus moves inside the overlay, and the next Escape closes it', async () => {
    // WRONG IMPL KILLED: a typing rule that only knows the rename text box (the currency inputs are
    // type=number), an Escape that is hidden by the currency input's own stopPropagation, one that
    // closes the overlay and wipes the draft, and one that leaves focus in the field.
    // ctl-10b (named intentional change): the overlay is opened face to face (O is retired). The
    // faced player is pre-selected and the select disabled, so with a typed offer the first enabled
    // control stop-typing lands on is the (enabled, complete-draft) submit button: still inside the
    // overlay, which is all this case asserts.
    await bootReady();
    server(1000);
    openFaceToFace(1010);
    expect(proposeShown(), 'precondition: the face-to-face open showed the overlay').toBe(true);
    const overlay = byId('tradepropose-overlay');
    const offer = byId('tradepropose-offer-currency') as HTMLInputElement;
    offer.focus();
    expect(document.activeElement, 'precondition: the currency input has focus').toBe(offer);
    typeInto(offer, '25');
    expect(offer.value, 'precondition: the draft is in the field').toBe('25');

    const esc1 = fire('keydown', 'Escape', 1100, { target: offer });
    fire('keyup', 'Escape', 1105, { target: offer });
    expect(esc1.defaultPrevented, 'the stop-typing press is prevented').toBe(true);
    expect(proposeShown(), 'the overlay stays').toBe(true);
    expect(offer.value, 'the value is kept').toBe('25');
    expect(document.activeElement, 'focus left the field').not.toBe(offer);
    expect(overlay.contains(document.activeElement), 'and is inside the overlay').toBe(true);
    expect(stackNames()).toEqual(['world', 'tradeProposeView']);

    const active = document.activeElement as HTMLElement;
    fire('keydown', 'Escape', 1200, { target: active });
    fire('keyup', 'Escape', 1205, { target: active });
    expect(proposeShown(), 'the second Escape closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('Escape on the trade-propose Offer list and on a checkbox is Start: it closes the overlay directly, and the pre-selected target select is disabled', async () => {
    // INTENTIONAL CHANGE (ctl-10b): this case was "Escape on the trade-propose select". The
    // face-to-face open pre-selects the faced player and DISABLES the select (no retarget), so the
    // select can no longer hold focus; the case is retargeted to the Offer list the wizard now opens
    // on (the checkbox half is unchanged).
    // WRONG IMPL KILLED: a typing rule that treats every INPUT or SELECT as a text field (Escape on
    // a checkbox would only "stop typing" and the overlay would need a second press, or none), an
    // Escape hidden by a draft control's own stopPropagation, an Escape swallowed on the Offer
    // list, and a face-to-face open that leaves the select enabled (mouse or Tab could retarget).
    await bootReady();
    server(1000);
    openFaceToFace(1010);
    expect(proposeShown(), 'precondition: the overlay opened').toBe(true);
    const select = byId('tradepropose-target') as HTMLSelectElement;
    expect(select.value, 'the faced player is pre-selected').toBe(OTHER_IDENTITY);
    expect(select.disabled, 'and the select is locked').toBe(true);
    const list = byId('tradepropose-monsters');
    list.focus();
    expect(document.activeElement, 'precondition: the Offer list has focus').toBe(list);
    fire('keydown', 'Escape', 1100, { target: list });
    fire('keyup', 'Escape', 1105, { target: list });
    expect(proposeShown(), 'Escape on the Offer list closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);

    openFaceToFace(1200);
    expect(proposeShown(), 'precondition: reopened').toBe(true);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    byId('tradepropose-monsters').appendChild(checkbox);
    checkbox.focus();
    expect(document.activeElement, 'precondition: the checkbox has focus').toBe(checkbox);
    fire('keydown', 'Escape', 1300, { target: checkbox });
    fire('keyup', 'Escape', 1305, { target: checkbox });
    expect(proposeShown(), 'Escape on a checkbox closes the overlay').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('a composing Escape is the browser`s: it is not prevented, does not blur the field and opens nothing, while a plain Escape in the same field stops typing', async () => {
    // WRONG IMPL KILLED: a typing rule that ignores IME composition (Escape cancels the composition
    // in the browser; stopping typing too would blur the field and eat the keystroke), and an
    // Escape in a stray text field that falls through to Start (the menu would open under a typist).
    await bootReady();
    server(1000);
    const field = document.createElement('input');
    field.type = 'text';
    // ctl-11b (named intentional change): the stray field lives INSIDE #game-screen. Appended to
    // <body> it is outside the game screen, where every key is the browser's (no stop-typing, no
    // Start), so the plain-Escape control below would no longer be the game's to answer.
    byId('game-screen').appendChild(field);
    field.focus();
    field.value = 'abc';
    expect(document.activeElement, 'precondition: the field has focus').toBe(field);

    const composing = new KeyboardEvent('keydown', {
      code: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    expect(composing.isComposing, 'precondition: the harness carries isComposing').toBe(true);
    field.dispatchEvent(composing);
    expect(composing.defaultPrevented, 'a composing Escape is left alone').toBe(false);
    expect(document.activeElement, 'the field keeps focus').toBe(field);
    expect(field.value, 'and its text').toBe('abc');
    expect(menuShown(), 'and no menu opens').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // Control: a plain Escape in the very same field stops typing.
    const plain = fire('keydown', 'Escape', 1100, { target: field });
    fire('keyup', 'Escape', 1105, { target: field });
    expect(plain.defaultPrevented, 'a plain Escape is prevented').toBe(true);
    expect(document.activeElement, 'the field is blurred').not.toBe(field);
    expect(field.value, 'the text is kept').toBe('abc');
    expect(menuShown(), 'stopping typing opens no menu').toBe(false);
    expect(stackNames()).toEqual(['world']);

    // And the next Escape, now at the page, is Start.
    tap('Escape', 1200);
    expect(menuShown(), 'the next Escape opens the menu').toBe(true);
  });

  it('letters on a focused #rename-submit toggle nothing: the draft and the overlay survive N, B, I, M, R, Slash, Q and P', async () => {
    // WRONG IMPL KILLED (the A1 regression pin): a listener that sees every key in the capture
    // phase, so a focused submit button plus N toggle-closes the rename overlay and wipes the draft,
    // and B / I / M / R / Slash / Q / P open other screens under a typist's focus. Only Escape may
    // be heard from capture.
    await bootReady();
    server(1000);
    tap('KeyN', 1010);
    expect(renameShown(), 'precondition: the rename overlay opened').toBe(true);
    const input = byId('rename-input') as HTMLInputElement;
    const submit = byId('rename-submit') as HTMLButtonElement;
    typeInto(input, 'Alice');
    submit.focus();
    expect(document.activeElement, 'precondition: the submit button has focus').toBe(submit);

    for (const [i, code] of [
      'KeyN',
      'KeyB',
      'KeyI',
      'KeyM',
      'KeyR',
      'Slash',
      'KeyQ',
      'KeyP',
    ].entries()) {
      fire('keydown', code, 1100 + i * 10, { target: submit });
      fire('keyup', code, 1105 + i * 10, { target: submit });
    }
    expect(renameShown(), 'the rename overlay survives').toBe(true);
    expect(input.value, 'the draft survives').toBe('Alice');
    // ctl-11a: N opened the Name screen over the main menu, so the stack carries `menuView` beneath
    // it; "nothing else opened" is that same stack, unchanged (no pop, no replace, no extra frame).
    expect(stackNames(), 'nothing else opened').toEqual(['world', 'menuView', 'renameView']);
    expect(helpShown() || boxShown() || questLogShown()).toBe(false);
  });

  // ------------------------------------------------------------------------------------------
  // CTL6B.6: Q and E stay the ladder's
  // ------------------------------------------------------------------------------------------

  it('CTL6B-6-MAIN-Q-JOURNAL: Q at the world opens nothing (it is LB now) and J opens the quest log, while PageDown and PageUp open nothing and are left to the browser', async () => {
    // ctl-11a: Q is no longer the Journal hotkey (Q and E are LB and RB); the Journal accelerator is
    // J, which opens it over the main menu, and J pressed again acts as Start. Was: Q opened the
    // quest log at the world and a second Q closed it.
    // WRONG IMPL KILLED: a binding table that leaves Q on the old Journal hotkey, a Q that opens the
    // menu or any screen at the world, a PageDown / PageUp that is read as J, a J that does not
    // open the Journal, and a LB/RB that is consumed at the world (the browser's page scroll would be
    // eaten for nothing).
    await bootReady();
    server(1000);
    for (const [i, code] of ['PageDown', 'PageUp', 'KeyQ'].entries()) {
      const e = tap(code, 1010 + i * 100);
      expect(e.defaultPrevented, `${code} is left to the browser`).toBe(false);
      expect(questLogShown(), `${code} is not a J`).toBe(false);
      expect(menuShown() || helpShown() || boxShown(), `${code} opens nothing`).toBe(false);
      expect(stackNames()).toEqual(['world']);
    }

    const j = tap('KeyJ', 1300);
    expect(j.defaultPrevented, 'J is the Journal accelerator and is prevented').toBe(true);
    expect(questLogShown(), 'J opens the quest log').toBe(true);
    expect(stackNames(), 'over the main menu').toEqual(['world', 'menuView', 'questLogView']);

    // With the quest log up, PageDown still opens and closes nothing.
    tap('PageDown', 1400);
    expect(questLogShown(), 'PageDown does not close it').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView', 'questLogView']);
    tap('KeyJ', 1500);
    expect(questLogShown(), 'J over its own screen acts as Start and closes it').toBe(false);
    expect(menuShown(), 'with the menu').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  // ------------------------------------------------------------------------------------------
  // Review additions: IME, stale focus, close order, the world-focus guard, the stop-typing target
  // ------------------------------------------------------------------------------------------

  /** True when focus is on the page itself (happy-dom reports <body> or null for "nothing"). */
  const focusOnPage = (): boolean =>
    document.activeElement === document.body || document.activeElement === null;

  it('a composing Escape (isComposing, keyCode 229, or both) in #rename-input and in a trade-propose currency input is the IME`s: overlay, draft and focus survive, nothing is prevented, and a plain Escape in the same field then stops typing', async () => {
    // ctl-11a: the Name screen (opened by N) now sits over the main menu, so "still the one frame"
    // and "no menu" are read per case (`stack`, `menu`): the menu beneath it must neither close nor
    // re-open; the wizard still has none.
    // WRONG IMPL KILLED: a typing rule or composing check that reads only isComposing, or only the
    // legacy keyCode 229 (browsers differ on which they set), a composing Escape that still reaches
    // the field's own Escape listener (it hides the overlay and wipes the draft), one that is
    // prevented (the IME needs it to cancel the composition), one that blurs the field, and one that
    // falls through to Start (the menu would open under a typist). The plain Escape is the control.
    await bootReady();
    server(1000);
    const variants: ReadonlyArray<{ label: string; init: KeyboardEventInit }> = [
      { label: 'isComposing only', init: { isComposing: true } },
      { label: 'keyCode 229 only', init: { keyCode: 229 } },
      { label: 'isComposing and keyCode 229', init: { isComposing: true, keyCode: 229 } },
    ];
    const cases = [
      {
        name: 'rename',
        open: (at: number): void => void tap('KeyN', at),
        field: 'rename-input',
        draft: 'Alice',
        shown: renameShown,
        // ctl-11a: N opens the Name screen over the main menu, so its stack carries `menuView`
        // beneath it and that menu is shown; the face-to-face wizard has no menu under it.
        stack: ['world', 'menuView', 'renameView'],
        menu: true,
      },
      {
        name: 'trade-propose',
        // ctl-10b (named intentional change): face to face, O is retired.
        open: (at: number): void => openFaceToFace(at),
        field: 'tradepropose-offer-currency',
        draft: '25',
        shown: proposeShown,
        stack: ['world', 'tradeProposeView'],
        menu: false,
      },
    ] as const;
    let t = 1010;
    for (const c of cases) {
      c.open(t);
      t += 100;
      expect(c.shown(), `${c.name}: precondition: the overlay opened`).toBe(true);
      const input = byId(c.field) as HTMLInputElement;
      input.focus();
      typeInto(input, c.draft);
      expect(document.activeElement, `${c.name}: precondition: the field has focus`).toBe(input);

      for (const v of variants) {
        const e = fire('keydown', 'Escape', t, { target: input, init: v.init });
        fire('keyup', 'Escape', t + 5, { target: input });
        t += 100;
        expect(
          e.isComposing === true || e.keyCode === 229,
          `${c.name}/${v.label}: precondition: the harness event reads as composing`,
        ).toBe(true);
        expect(e.defaultPrevented, `${c.name}/${v.label}: left to the IME`).toBe(false);
        expect(c.shown(), `${c.name}/${v.label}: the overlay stays`).toBe(true);
        expect(input.value, `${c.name}/${v.label}: the draft survives`).toBe(c.draft);
        expect(document.activeElement, `${c.name}/${v.label}: focus stays`).toBe(input);
        expect(stackNames(), `${c.name}/${v.label}: still the same frames`).toEqual(c.stack);
        expect(menuShown(), `${c.name}/${v.label}: no menu opened or closed`).toBe(c.menu);
      }

      // Control: a plain Escape in the very same field stops typing (so the tests above were live).
      const plain = fire('keydown', 'Escape', t, { target: input });
      fire('keyup', 'Escape', t + 5, { target: input });
      t += 100;
      expect(plain.defaultPrevented, `${c.name}: a plain Escape is prevented`).toBe(true);
      expect(document.activeElement, `${c.name}: and leaves the field`).not.toBe(input);
      expect(c.shown(), `${c.name}: the overlay stays`).toBe(true);
      expect(input.value, `${c.name}: the draft is kept`).toBe(c.draft);

      // The next Escape (now outside a text field) closes it, so the next case starts clean.
      const away = document.activeElement as HTMLElement;
      fire('keydown', 'Escape', t, { target: away });
      fire('keyup', 'Escape', t + 5, { target: away });
      t += 100;
      expect(c.shown(), `${c.name}: the next Escape closes the overlay`).toBe(false);
      expect(stackNames()).toEqual(['world']);
    }
  });

  it('an Escape at a field of an overlay that has just closed is Start, not stop-typing: with the overlay hidden by its own N toggle and focus stale on its input, Escape at that input opens the main menu', async () => {
    // WRONG IMPL KILLED: a typing branch that trusts the event target alone (a real browser leaves
    // document.activeElement on the hidden input for a moment after a close, so the Escape would be
    // swallowed as "stop typing" on an overlay that is gone and the player would need a second
    // press), a typing branch whose `target === activeElement` guard is gone, and a keydown that no
    // longer heals focus out of a hidden subtree first (focus would still read the hidden input).
    // Either removal leaves the menu closed here. happy-dom blurs on close; the stale state a real
    // browser keeps is reproduced by re-focusing the hidden input.
    await bootReady();
    server(1000);
    tap('KeyN', 1010);
    expect(renameShown(), 'precondition: N opened the rename overlay').toBe(true);
    const input = byId('rename-input') as HTMLInputElement;
    input.focus();
    typeInto(input, 'Alice');
    tap('KeyN', 1100); // the overlay's own toggle-close path
    expect(renameShown(), 'precondition: N closed it').toBe(false);
    expect(stackNames(), 'precondition: the stack is the bare world').toEqual(['world']);
    input.focus();
    expect(document.activeElement, 'precondition: focus is stale on the hidden input').toBe(input);

    const esc = fire('keydown', 'Escape', 1200, { target: input });
    fire('keyup', 'Escape', 1205, { target: input });
    expect(menuShown(), 'Escape at the stale field acts as Start and opens the menu').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView']);
    expect(esc.defaultPrevented, 'the consumed Start press is prevented').toBe(true);
    expect(document.activeElement, 'focus is no longer on the hidden input').not.toBe(input);
  });

  it('one Escape over Menu then Journal hides the Journal before the menu, and leaves the bare world on the stack', async () => {
    // WRONG IMPL KILLED: a pop-to-base that closes frames bottom-first (the menu would drop out from
    // under a child that is still on screen, and the focus restore would land on the menu's anchor
    // instead of where the player was), a close that skips the child, and a stack that keeps either
    // frame after the pop.
    await bootAtMenu(2);
    tap('Enter', 1400);
    expect(stackNames(), 'precondition: Journal is open above the menu').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    const order: string[] = [];
    for (const [name, id] of [
      ['menu', 'menu-overlay'],
      ['quest', 'quest-log-overlay'],
    ] as const) {
      const style = byId(id).style;
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style), 'display');
      if (desc?.get === undefined || desc.set === undefined) {
        throw new Error('the style prototype has no display accessor to record through');
      }
      const { get, set } = desc;
      Object.defineProperty(style, 'display', {
        configurable: true,
        get() {
          return get.call(this);
        },
        set(value: string) {
          if (value === 'none') order.push(name);
          set.call(this, value);
        },
      });
    }

    tap('Escape', 1500);
    expect(order.indexOf('quest'), 'the Journal was hidden').toBeGreaterThanOrEqual(0);
    expect(order.indexOf('menu'), 'the menu was hidden').toBeGreaterThanOrEqual(0);
    expect(order.indexOf('quest'), 'the Journal is hidden before the menu').toBeLessThan(
      order.indexOf('menu'),
    );
    expect(questLogShown()).toBe(false);
    expect(menuShown()).toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('Start and Select are inert while focus sits on a foreign control, and work with focus on the page or the canvas', async () => {
    // WRONG IMPL KILLED: a world-focus guard that is gone on Start or on Select (M, Escape, R and
    // Slash would open the menu or help over a button the player is operating), a guard on only
    // some of them, and a guard that is always closed (the control below proves each key opens
    // with focus on <body> and on the canvas).
    await bootReady();
    server(1000);
    const foreign = document.createElement('button');
    document.body.appendChild(foreign);
    foreign.focus();
    expect(document.activeElement, 'precondition: a foreign button has focus').toBe(foreign);
    for (const [i, code] of ['KeyM', 'Escape', 'KeyR', 'Slash'].entries()) {
      tap(code, 1100 + i * 100, undefined, foreign);
      expect(menuShown(), `${code} at a foreign button opens no menu`).toBe(false);
      expect(helpShown(), `${code} at a foreign button opens no help`).toBe(false);
      expect(stackNames(), `${code} at a foreign button leaves the bare world`).toEqual(['world']);
    }

    // Control: with focus back on the page each key opens its screen.
    foreign.blur();
    foreign.remove();
    expect(focusOnPage(), 'precondition: focus is on the page').toBe(true);
    tap('KeyM', 1600);
    expect(menuShown(), 'M opens the menu with focus on the page').toBe(true);
    tap('Escape', 1700);
    expect(menuShown(), 'Escape closes it').toBe(false);
    tap('Escape', 1800);
    expect(menuShown(), 'Escape opens it again from the world').toBe(true);
    tap('Escape', 1900);
    tap('KeyR', 2000);
    expect(helpShown(), 'R opens help with focus on the page').toBe(true);
    tap('KeyR', 2100);
    expect(helpShown()).toBe(false);

    const canvas = document.querySelector('canvas');
    if (canvas === null) throw new Error('the renderer mock must mount a canvas');
    canvas.focus();
    expect(document.activeElement, 'precondition: the canvas has focus').toBe(canvas);
    tap('Slash', 2200, { key: '/' });
    expect(helpShown(), 'Slash opens help with focus on the canvas').toBe(true);
  });

  it('stop typing moves focus to the first enabled control that is not a text field: with the face-to-face wizard`s target select disabled that is the first monster checkbox, from either typing field', async () => {
    // INTENTIONAL CHANGE (ctl-10b): this case first expected the target select (opened by O), then
    // disabled the select by hand and expected the first checkbox. The face-to-face open now locks
    // the select itself (pre-selected, disabled), so the select is never the stop-typing target and
    // the first checkbox is the answer from the start; the hand-disabling step is retired.
    // WRONG IMPL KILLED: a stop-typing that blurs only (the frame's trap would have nothing to
    // keep), one that picks the LAST control (the submit button or the last checkbox), one that picks
    // the first control without skipping a disabled one (focus() on the locked select is a no-op, so
    // focus would end on the page), one that depends on which text field held focus, a face-to-face
    // open that leaves the select enabled (it would take the focus), and one that closes the overlay
    // or wipes a draft.
    await bootReady();
    const ownMonster = (id: bigint) =>
      ({
        monsterId: id,
        ownerIdentity: H.identity,
        speciesId: 1,
        nickname: `Mon${id}`,
        level: 5,
        xp: 0,
        currentHp: 20,
        statHp: 20,
        statAttack: 5,
        statDefense: 5,
        statSpeed: 5,
        statSpAttack: 5,
        statSpDefense: 5,
        partySlot: 255,
        tier: 0,
        essence: {},
        trustTier: 'Unknown',
        qualityTimeTier: 0,
        nutritionPct: 0,
      }) as never;
    opts.store.upsertMonster(ownMonster(31n));
    opts.store.upsertMonster(ownMonster(32n));
    opts.store.upsertPlayer({
      identity: OTHER_IDENTITY,
      entityId: 99n,
      name: 'Zed',
      online: true,
      lastInputSeq: 0n,
    });
    server(1000);
    openFaceToFace(1010);
    expect(proposeShown(), 'precondition: the face-to-face open showed the overlay').toBe(true);
    const select = byId('tradepropose-target') as HTMLSelectElement;
    expect(select.disabled, 'precondition: the face-to-face open locked the select').toBe(true);
    const offer = byId('tradepropose-offer-currency') as HTMLInputElement;
    const request = byId('tradepropose-request-currency') as HTMLInputElement;
    const submit = byId('tradepropose-submit') as HTMLButtonElement;
    const firstBox = document.querySelector(
      '#tradepropose-monsters input[data-monster-id="31"]',
    ) as HTMLInputElement | null;
    const secondBox = document.querySelector(
      '#tradepropose-monsters input[data-monster-id="32"]',
    ) as HTMLInputElement | null;
    expect(firstBox, 'precondition: the first own monster is offerable').not.toBeNull();
    expect(secondBox, 'precondition: the second own monster is offerable').not.toBeNull();

    // From the offer field: the locked select is skipped; the first checkbox, not the last control.
    offer.focus();
    typeInto(offer, '25');
    const esc1 = fire('keydown', 'Escape', 1100, { target: offer });
    fire('keyup', 'Escape', 1105, { target: offer });
    expect(esc1.defaultPrevented, 'the stop-typing press is prevented').toBe(true);
    expect(document.activeElement, 'focus lands on the first enabled control').toBe(firstBox);
    expect(document.activeElement, 'not the locked select').not.toBe(select);
    expect(offer.value, 'the draft is kept').toBe('25');

    // From the request field: the same target.
    request.focus();
    typeInto(request, '7');
    fire('keydown', 'Escape', 1200, { target: request });
    fire('keyup', 'Escape', 1205, { target: request });
    expect(document.activeElement, 'from the other text field the target is the same').toBe(
      firstBox,
    );
    expect(request.value, 'the draft is kept').toBe('7');
    expect(document.activeElement, 'not the later checkbox').not.toBe(secondBox);
    expect(document.activeElement, 'and not the submit button').not.toBe(submit);
    expect(proposeShown(), 'the overlay stays open throughout').toBe(true);
    expect(stackNames()).toEqual(['world', 'tradeProposeView']);
  });

  it('stop typing in the rename field lands on the enabled submit button when there is a draft, and on the page when the draft is empty and submit is disabled, with the overlay open both times', async () => {
    // WRONG IMPL KILLED: a stop-typing that leaves focus in the field (the second Escape would be
    // typed into it), one that focuses the disabled submit (a dead target), one that falls back to
    // closing the overlay when it finds no control, and one that picks the overlay root.
    await bootReady();
    server(1000);
    tap('KeyN', 1010);
    expect(renameShown(), 'precondition: N opened the rename overlay').toBe(true);
    const input = byId('rename-input') as HTMLInputElement;
    const submit = byId('rename-submit') as HTMLButtonElement;
    expect(submit.disabled, 'precondition: an empty draft disables submit').toBe(true);
    input.focus();
    expect(document.activeElement, 'precondition: the field has focus').toBe(input);

    const empty = fire('keydown', 'Escape', 1100, { target: input });
    fire('keyup', 'Escape', 1105, { target: input });
    expect(empty.defaultPrevented, 'the stop-typing press is prevented').toBe(true);
    expect(focusOnPage(), 'no enabled control: focus ends on the page').toBe(true);
    expect(renameShown(), 'the overlay stays open').toBe(true);
    expect(input.value, 'the (empty) draft is untouched').toBe('');
    // ctl-11a: N opened the Name screen over the main menu, so the stack carries `menuView` beneath
    // it; stopping typing is not Start, which would have popped both to the world.
    expect(stackNames()).toEqual(['world', 'menuView', 'renameView']);
    expect(menuShown(), 'stopping typing is not Start: the menu beneath stays').toBe(true);

    input.focus();
    typeInto(input, 'Bob');
    expect(submit.disabled, 'precondition: a draft enables submit').toBe(false);
    const typed = fire('keydown', 'Escape', 1200, { target: input });
    fire('keyup', 'Escape', 1205, { target: input });
    expect(typed.defaultPrevented).toBe(true);
    expect(document.activeElement, 'with a draft the enabled submit takes focus').toBe(submit);
    expect(input.value, 'the draft is kept').toBe('Bob');
    expect(renameShown(), 'the overlay stays open').toBe(true);
  });
});

// ==========================================================================================
// ctl-6c: battle semantics (CTL6C.1 to CTL6C.3)
// ==========================================================================================
//
// Start over an Ongoing battle opens the main menu above it (the battle stays shown and its
// a11y root resumes when the menu closes); A continues a terminal outcome after a 400 ms grace
// (B and Start already continue it); a command that is not battle-safe is refused at a battle base
// with its catalogued reason (on the status line and announced; the line clears when the base
// returns to the world), and the menu rows that would issue one are disabled, as are Journal and
// Rankings until ctl-7a anchors their shells (supervisor decision option-a).
//
// Time: the shell reads `performance.now()`, which this harness drives from `clock.t` (every
// `tap`, `fire`, `server` and `frame` sets it). The grace is measured from the batch or key whose
// sync first mirrored the outcome frame, so each case pins ages well clear of the 400 ms boundary
// (the pure suite pins 399 / 400).

const battleRoot = (): HTMLElement => {
  const title = document.querySelector('[data-testid="battle-title"]');
  const root = title?.parentElement;
  if (root === null || root === undefined) throw new Error('the battle overlay root is missing');
  return root;
};

/** The reason line the menu frame paints under its list. */
const menuFeedback = (): string | null =>
  byId('menu-overlay').querySelector('.mr-frame-feedback')?.textContent ?? null;

/** Click a dialogue choice button, as the dialogue renders one. */
function clickChoice(idx: string, t: number): void {
  const button = document.createElement('button');
  button.dataset.choiceIdx = idx;
  document.body.appendChild(button);
  clock.t = t;
  button.click();
  button.remove();
}

const statusText = (): string => byId('status').textContent ?? '';

/** What the one polite live region (`#a11y-live`, index.html) last painted. It may be adopted into
 *  an overlay root, so it is looked up by id, never by position. */
const liveText = (): string => byId('a11y-live').textContent ?? '';

/** One own monster, enough for the raising view to paint a Care button for it. */
const RAISED_MONSTER: StoreMonsterPub = {
  monsterId: 31n,
  ownerIdentity: H.identity,
  speciesId: 1,
  nickname: 'm31',
  level: 5,
  xp: 0,
  currentHp: 10,
  statHp: 10,
  statAttack: 5,
  statDefense: 5,
  statSpeed: 5,
  statSpAttack: 5,
  statSpDefense: 5,
  partySlot: 0,
  tier: 0,
  essence: { Fire: 0, Water: 0, Plant: 0, Electric: 0, Earth: 0, Wind: 0, Light: 0, Dark: 0 },
  trustTier: 'Neutral',
  qualityTimeTier: 0,
  nutritionPct: 0,
};

describe('main.ts battle semantics (runtime, ctl-6c)', { sequential: true }, () => {
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
  // CTL6C.1: Start over an Ongoing battle
  // ------------------------------------------------------------------------------------------

  it('CTL6C-1-MAIN-START-MENU-OVER-BATTLE: Escape and M at an Ongoing battle open the menu over it, the battle stays shown, the menu survives batches and frames, B at the menu root returns to the battle with its a11y root live and focus inside it, and a battle that ends closes the menu', async () => {
    // WRONG IMPL KILLED: a Start that does nothing at the battle (today: the menu never opens); an
    // open that gates on the world-focus predicate or on the overlay verdict (focus is IN the
    // battle overlay and the battle is EXCLUSIVE_TOP, so the menu would refuse to open: the
    // precondition below proves focus really sits in the battle); a menu that hides the battle
    // under it; a menu that the next batch or frame closes (reconcile drops every `drop` frame
    // while a battle is up: red today); a frame not stamped with the battle (the stack shape below);
    // a menu whose W / D-pad edge walks the character; a close that leaves the battle root inert or
    // aria-hidden (the dead overlay under an invisible menu) or focus on the page; an M that
    // cannot open it or an Escape that cannot close it; a stale stamp that outlives the battle
    // (the control: the row vanishes with no outcome shown); and a terminal outcome that leaves the
    // menu painted over it.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    await flush();
    expect(battleShown(), 'precondition: the Ongoing battle is on screen').toBe(true);
    expect(stack(), 'precondition: the base is the battle').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    expect(
      battleRoot().contains(document.activeElement),
      'precondition: focus sits inside the battle overlay, not on the world',
    ).toBe(true);
    const sent = H.sends.length;

    // --- Escape opens the menu over the battle --------------------------------------------
    const esc = tap('Escape', 1200);
    expect(esc.defaultPrevented, 'the consumed Start press is prevented').toBe(true);
    expect(menuShown(), 'Escape at an Ongoing battle opens the menu').toBe(true);
    expect(battleShown(), 'and the battle stays shown').toBe(true);
    expect(stack(), 'the battle base with the menu stamped above it').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);
    expect(navActive(), 'the menu is on its first entry').toBe('monsters');

    // It survives further batches and frames.
    server(1300);
    expect(menuShown(), 'the menu survives the next batch').toBe(true);
    expect(battleShown(), 'with the battle still shown').toBe(true);
    frame(1310);
    server(1400);
    expect(menuShown(), 'and a frame and another batch').toBe(true);
    expect(stack(), 'the stack is unchanged').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);

    // W moves the menu cursor and sends no step.
    fire('keydown', 'KeyW', 1500);
    fire('keyup', 'KeyW', 1505);
    frame(1510);
    expect(H.sends.length, 'W with the menu over a battle sends no step').toBe(sent);
    expect(menuShown(), 'the menu is still up after W').toBe(true);

    // --- B at the menu root returns to the battle -------------------------------------------
    const back = tap('Backspace', 1600);
    expect(back.defaultPrevented, 'the consumed B press is prevented').toBe(true);
    expect(menuShown(), 'Backspace at the menu root closes it').toBe(false);
    expect(battleShown(), 'the battle is still shown').toBe(true);
    expect(stack(), 'the bare battle base again').toEqual([{ kind: 'battle', battleId: '101' }]);
    const root = battleRoot();
    expect(root.hasAttribute('inert'), 'the battle root is not inert').toBe(false);
    expect(root.getAttribute('aria-hidden'), 'and not aria-hidden').toBeNull();
    expect(root.contains(document.activeElement), 'focus returned inside the battle overlay').toBe(
      true,
    );
    expect(H.sends.length, 'nothing walked').toBe(sent);

    // --- M opens it, Escape closes it -------------------------------------------------------
    tap('KeyM', 1700);
    expect(menuShown(), 'M at an Ongoing battle also opens the menu').toBe(true);
    expect(stackNames(), 'the same two frames').toEqual(['battle', 'menuView']);
    tap('Escape', 1800);
    expect(menuShown(), 'Escape (Start over a frame) closes it').toBe(false);
    expect(battleShown()).toBe(true);
    expect(stack()).toEqual([{ kind: 'battle', battleId: '101' }]);

    // --- the battle turning terminal closes the menu and shows the outcome --------------------
    tap('Escape', 1900);
    expect(menuShown(), 'precondition: the menu is open again').toBe(true);
    putBattle(BATTLE_ID, 2000, 'SideAWins');
    expect(menuShown(), 'a terminal outcome closes the menu').toBe(false);
    expect(battleShown(), 'and shows the outcome').toBe(true);
    expect(stack(), 'the outcome is a frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'battleView' },
    ]);
    tap('Backspace', 2100);
    expect(battleShown(), 'precondition: B continued the outcome').toBe(false);
    expect(stack()).toEqual([{ kind: 'world' }]);

    // --- control: the battle row vanishes with NO outcome shown -------------------------------
    putBattle(102n, 2200);
    await flush();
    expect(battleShown(), 'precondition: a second battle is on screen').toBe(true);
    tap('Escape', 2300);
    expect(menuShown(), 'precondition: the menu is open over the second battle').toBe(true);
    expect(stack()).toEqual([
      { kind: 'battle', battleId: '102' },
      { kind: 'screen', id: 'menuView', overBattle: '102' },
    ]);
    opts.store.removeBattle(102n);
    server(2400);
    expect(battleShown(), 'the battle is gone').toBe(false);
    expect(menuShown(), 'a stamped menu does not outlive its battle, outcome or not').toBe(false);
    expect(stack(), 'the bare world').toEqual([{ kind: 'world' }]);
  });

  it('a menu click-opened at the world, then a battle batch before any frame, is closed by the batch; a later Start at that battle opens a fresh one', async () => {
    // WRONG IMPL KILLED: a stamp that ignores which base the frame was first mirrored under. The
    // click path never syncs the stack, so the menu is first mirrored INSIDE the batch that brings
    // the battle in, by which time the base already reads as the battle: a stamp taken from the
    // post-flip base would keep a menu that was opened at the world (CTL3.2 says a battle closes
    // it). The follow-up Start proves the drop was this race, not "menus never survive".
    await bootReady();
    server(1000);
    const launcher = document.querySelector('[data-menu-launcher]');
    if (launcher === null) throw new Error('[data-menu-launcher] is not in the shell');
    clock.t = 1100;
    launcher.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(menuShown(), 'precondition: the click opened the menu at the world').toBe(true);

    putBattle(BATTLE_ID, 1200);
    expect(battleShown(), 'the battle is on screen').toBe(true);
    expect(menuShown(), 'the world-opened menu is closed by the battle (CTL3.2), not kept').toBe(
      false,
    );
    expect(stack(), 'only the battle base is left').toEqual([{ kind: 'battle', battleId: '101' }]);

    await flush();
    tap('Escape', 1300);
    expect(menuShown(), 'a Start at the battle opens a menu that stays').toBe(true);
    server(1400);
    expect(menuShown(), 'and that one survives the batch').toBe(true);
    expect(stack()).toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);
  });

  it('CTL6C-1-RECONNECT-DROPS-STAMPED: a link drop closes every frame opened over the battle, whether or not a frame has re-derived the base as the world before the reconnect runs, so the same battle re-delivered after it is the bare battle base again, live and holding focus, with no shown overlay left inert; help opened at the world survives a drop as it always has', async () => {
    // WRONG IMPL KILLED (red-team F1, measured): a reconnect that hides the menu (onReconnect's
    // menuView.hide()) and leaves help, which the menu opened above itself over the battle and
    // which is stamped with that battle: the re-delivered row keeps the stamped help (reconcile
    // keeps a battleSafe frame stamped with the base's battle), the battle re-shows over it, and
    // help stays displayed but inert and aria-hidden under the battle, focus on the battle beneath
    // it, a frame the stack still lists and Start, B and Select act on (red today); a fix that
    // closes help but leaves another stamped frame on the stack; one that leaves the battle root
    // inert or focus outside it; and an over-reach that also closes help the player opened at the
    // WORLD, which reads no store state, holds no lock and has always survived a drop (that arm
    // runs first, so the red run proves it holds today).
    // WRONG IMPL KILLED (review lens): a close keyed to the base still being the battle
    // (`contextStack[0].kind === 'battle' &&` added to onReconnect's stamped-frame loop, or a stamp
    // compared with the base's battleId). The frame loop keeps running while the link is down, so
    // in production the empty store has usually re-derived the base as the WORLD by the time
    // onReconnect runs, with the stamped menu and help still above it and the battle overlay
    // mirrored as an unstamped frame: such a close finds no battle base, keeps help, and the
    // re-delivered row keeps it, stamped, over the battle. Pass (a) runs a frame between the drop
    // and onReconnect and pins that shape as its precondition; pass (b) keeps the drop with no
    // frame between, where the base still reads as the battle.
    await bootReady();
    server(1000);

    // --- the world arm: help opened at the world survives a drop -------------------------------
    tap('KeyR', 1010);
    expect(helpShown(), 'world arm, precondition: R opened help at the world').toBe(true);
    expect(stack(), 'world arm, precondition: help over the world, unstamped').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'helpView' },
    ]);
    opts.store.reset(); // the drop edge
    opts.onReconnect(H.identity);
    opts.onHydrated();
    server(1100);
    await flush();
    expect(helpShown(), 'world arm: help opened at the world is still open').toBe(true);
    expect(stack(), 'world arm: and still on the stack').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'helpView' },
    ]);
    const help = byId('help-overlay');
    expect(help.hasAttribute('inert'), 'world arm: help is live, not inert').toBe(false);
    expect(help.getAttribute('aria-hidden'), 'world arm: nor aria-hidden').toBeNull();
    tap('KeyR', 1200);
    expect(helpShown(), 'world arm: Select still closes it').toBe(false);
    expect(stack(), 'world arm: the bare world').toEqual([{ kind: 'world' }]);

    // --- the battle arm: Options > How to play over the menu over the battle -----------------
    putBattle(BATTLE_ID, 1300);
    await flush();
    expect(battleShown(), 'precondition: the Ongoing battle is on screen').toBe(true);

    /** Start, then Options > How to play: help above the menu over the battle, both stamped. */
    const openHelpOverBattle = async (pass: string, t0: number): Promise<void> => {
      tap('Escape', t0);
      expect(menuShown(), `${pass}, precondition: Start opened the menu`).toBe(true);
      for (let i = 0; i < 8 && navActive() !== 'options'; i += 1) {
        tap('ArrowDown', t0 + 100 + i * 100);
      }
      expect(navActive(), `${pass}, precondition: the cursor is on Options`).toBe('options');
      tap('Enter', t0 + 1000);
      expect(navActive(), `${pass}, precondition: A entered Options`).toBe('help');
      tap('Enter', t0 + 1100);
      await flush();
      // Control: before the drop help really is up, above the menu, both stamped with the battle.
      expect(helpShown(), `${pass}, control: help is open over the battle`).toBe(true);
      expect(menuShown(), `${pass}, control: with the menu beneath it`).toBe(true);
      expect(battleShown(), `${pass}, control: and the battle under both`).toBe(true);
      expect(stack(), `${pass}, control: both frames are stamped with the battle`).toEqual([
        { kind: 'battle', battleId: '101' },
        { kind: 'screen', id: 'menuView', overBattle: '101' },
        { kind: 'screen', id: 'helpView', overBattle: '101' },
      ]);
    };

    /** The link comes back and the same Ongoing battle is re-delivered, in one batch at `t`. */
    const reconnectAndRedeliver = async (t: number): Promise<void> => {
      opts.onReconnect(H.identity);
      opts.onHydrated();
      opts.store.upsertBattle(battleRow(BATTLE_ID, 'Ongoing'));
      server(t);
      await flush();
    };

    /** After the drop: every frame opened over the battle is closed and the battle is live. */
    const expectBareBattle = (pass: string): void => {
      expect(helpShown(), `${pass}: the drop closes help opened over the battle`).toBe(false);
      expect(menuShown(), `${pass}: and the menu beneath it`).toBe(false);
      expect(battleShown(), `${pass}: the re-delivered battle is on screen`).toBe(true);
      expect(stack(), `${pass}: the stack is the bare battle base`).toEqual([
        { kind: 'battle', battleId: '101' },
      ]);
      const root = battleRoot();
      expect(root.hasAttribute('inert'), `${pass}: the battle root is not inert`).toBe(false);
      expect(root.getAttribute('aria-hidden'), `${pass}: and not aria-hidden`).toBeNull();
      const focused = root.contains(document.activeElement);
      expect(focused, `${pass}: focus is inside the battle overlay`).toBe(true);
      const overlays = [
        ['help', byId('help-overlay')],
        ['menu', byId('menu-overlay')],
        ['battle', root],
      ] as const;
      for (const [name, el] of overlays) {
        if (!isShown(el)) continue;
        const at = `${pass}, ${name}`;
        expect(el.hasAttribute('inert'), `${at}: a shown overlay root is never inert`).toBe(false);
        expect(el.getAttribute('aria-hidden'), `${at}: nor aria-hidden`).not.toBe('true');
      }
    };

    // --- (a) a frame runs between the drop and onReconnect -----------------------------------
    await openHelpOverBattle('frame first', 1400);
    opts.store.reset(); // the drop edge
    // The frame loop keeps running while the link is down: the empty store re-derives the base as
    // the world, the stamped menu and help stay above it, and the battle overlay, still on screen,
    // is mirrored as an unstamped frame (the shape of a terminal outcome over the world). This
    // precondition is what makes the pass discriminate: a close that waits for a battle base
    // finds none here.
    frame(2550);
    expect(stack(), 'frame first, precondition: a world base under the stamped frames').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
      { kind: 'screen', id: 'helpView', overBattle: '101' },
      { kind: 'screen', id: 'battleView' },
    ]);
    expect(helpShown(), 'frame first, precondition: help is still shown').toBe(true);
    expect(menuShown(), 'frame first, precondition: and so is the menu').toBe(true);
    expect(battleShown(), 'frame first, precondition: and the battle').toBe(true);
    await reconnectAndRedeliver(2600);
    expectBareBattle('frame first');

    // --- (b) no frame between the drop and onReconnect ---------------------------------------
    await openHelpOverBattle('no frame', 2700);
    opts.store.reset(); // the drop edge, and straight on to onReconnect
    expect(stack()[0], 'no frame, precondition: the base still reads as the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    await reconnectAndRedeliver(3900);
    expectBareBattle('no frame');
  });

  // ------------------------------------------------------------------------------------------
  // CTL6C.2: A and B continue a terminal outcome
  // ------------------------------------------------------------------------------------------

  it('CTL6C-2-MAIN-A-B-CONTINUE: Enter on a terminal outcome is swallowed for 400 ms after it first showed (a later batch or frame does not restart that), a repeat Enter never continues, a fresh Enter after the grace continues and the next batches never re-pop it; a second battle starts its own grace and Backspace continues at once', async () => {
    // WRONG IMPL KILLED: an A that is not handled on the outcome (today: only Esc and Backspace
    // continue); an A with no grace (an Enter mashed at the battle's last turn skips the result);
    // a grace stamped on every sync (the later key press, batch or frame would restart the clock
    // and Enter would never pass); a grace that is never reset for a SECOND battle (the second
    // outcome would continue on the first Enter); a repeat keydown that continues (a held Enter
    // skipping the result the instant the grace ends); an A that hides the outcome without
    // latching the dismissed id (the next batch would re-pop it); a B that now needs the grace;
    // and an A that does not return to the world (movement stays dead).
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    putBattle(BATTLE_ID, 1200, 'SideAWins'); // the outcome first shows at clock 1200
    expect(battleShown(), 'precondition: the outcome is on screen').toBe(true);
    expect(stackNames()).toEqual(['world', 'battleView']);

    // Inside the grace.
    const early = tap('Enter', 1300); // age 100
    expect(early.defaultPrevented, 'the early A is swallowed, not left to the page').toBe(true);
    expect(battleShown(), 'A inside the grace leaves the outcome up').toBe(true);
    expect(stackNames(), 'and the stack unchanged').toEqual(['world', 'battleView']);
    // A batch and a frame in between do not restart the grace clock.
    server(1400);
    frame(1410);
    tap('Enter', 1550); // age 350
    expect(battleShown(), 'A at age 350 is still inside the grace').toBe(true);

    // A repeat keydown never continues, even past the grace.
    fire('keydown', 'Enter', 1700, { init: { repeat: true } }); // age 500
    fire('keyup', 'Enter', 1705);
    expect(battleShown(), 'a repeat Enter past the grace does not continue').toBe(true);
    expect(stackNames()).toEqual(['world', 'battleView']);

    // A fresh press after the grace continues.
    const go = tap('Enter', 1710); // age 510
    expect(go.defaultPrevented, 'the consumed A press is prevented').toBe(true);
    expect(battleShown(), 'A after the grace continues the outcome').toBe(false);
    expect(stackNames(), 'and returns to the world').toEqual(['world']);
    // Latched: the next batches and a frame never bring it back.
    server(1800);
    frame(1810);
    server(1900);
    expect(battleShown(), 'it never re-pops on a later batch').toBe(false);
    expect(stackNames()).toEqual(['world']);
    const before = H.sends.length;
    fire('keydown', 'KeyW', 2000);
    expect(H.sends.length, 'the world walks again').toBe(before + 1);
    fire('keyup', 'KeyW', 2005);

    // A second battle: its own grace, and B continues it at once (the legacy pop).
    putBattle(102n, 2100);
    expect(battleShown(), 'precondition: the second battle is on screen').toBe(true);
    putBattle(102n, 2200, 'SideBWins'); // the second outcome first shows at clock 2200
    expect(battleShown(), 'precondition: its outcome shows').toBe(true);
    tap('Enter', 2300); // age 100 of the SECOND outcome
    expect(battleShown(), 'the second outcome has its own grace').toBe(true);
    const back = tap('Backspace', 2350);
    expect(back.defaultPrevented, 'the consumed B press is prevented').toBe(true);
    expect(battleShown(), 'Backspace continues the outcome with no grace').toBe(false);
    server(2400);
    server(2500);
    expect(battleShown(), 'and it does not re-pop either').toBe(false);
    expect(stackNames()).toEqual(['world']);
  });

  it('an outcome that arrives already terminal over a player frame open at the world starts its own A grace: with the box, then the menu, up for a second before it, Enter 100 ms after the outcome shows is swallowed and Enter 500 ms after continues', async () => {
    // WRONG IMPL KILLED (verifier v48, measured): an outcome clock started whenever ANY screen
    // frame tops the world base (syncStack's `top.id === 'battleView'` test dropped): the box or
    // the menu starts it when it opens, the outcome that closes that frame in its own batch
    // inherits the stamp, and the first Enter on the outcome skips the result the 400 ms grace
    // protects; and a clock never started for an outcome with no Ongoing batch before it (A would
    // never continue). The arrival shape: a row first seen already terminal shows only once a
    // battle has been seen this session (the very first one is pre-dismissed as historical), so
    // battle 101 runs to its end first.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    putBattle(BATTLE_ID, 1200, 'SideAWins');
    tap('Backspace', 1300);
    expect(battleShown(), 'precondition: the first outcome was continued').toBe(false);
    expect(stack(), 'precondition: the bare world').toEqual([{ kind: 'world' }]);

    // ctl-11a: B opens the box over the main menu (Monsters), so the box arm's frames are
    // [menuView, boxView]; the menu arm (M) is still the one frame. The outcome drops them all.
    const arms = [
      {
        name: 'box',
        key: 'KeyB',
        shown: boxShown,
        frames: ['menuView', 'boxView'],
        battleId: 102n,
        at: 1400,
      },
      {
        name: 'menu',
        key: 'KeyM',
        shown: menuShown,
        frames: ['menuView'],
        battleId: 103n,
        at: 3000,
      },
    ] as const;
    for (const arm of arms) {
      tap(arm.key, arm.at);
      expect(arm.shown(), `${arm.name}: precondition: it opened at the world`).toBe(true);
      expect(stackNames(), `${arm.name}: precondition: its frames over the world`).toEqual([
        'world',
        ...arm.frames,
      ]);
      // It stays up for a second, through batches and a frame.
      server(arm.at + 300);
      frame(arm.at + 400);
      server(arm.at + 800);
      expect(arm.shown(), `${arm.name}: precondition: still up`).toBe(true);

      // The next battle's first row is already terminal: the outcome first shows at `at + 1000`.
      putBattle(arm.battleId, arm.at + 1000, 'SideBWins');
      expect(battleShown(), `${arm.name}: the terminal row shows its outcome`).toBe(true);
      expect(arm.shown(), `${arm.name}: and the outcome closed the frame`).toBe(false);
      expect(stackNames(), `${arm.name}: the outcome frame over the world`).toEqual([
        'world',
        'battleView',
      ]);

      const early = tap('Enter', arm.at + 1100); // age 100 of the outcome, 1100 of the frame
      expect(early.defaultPrevented, `${arm.name}: the early A is swallowed`).toBe(true);
      expect(battleShown(), `${arm.name}: A at age 100 leaves the outcome up`).toBe(true);
      expect(stackNames()).toEqual(['world', 'battleView']);
      tap('Enter', arm.at + 1500); // age 500
      expect(battleShown(), `${arm.name}: A after the grace continues the outcome`).toBe(false);
      expect(stackNames(), `${arm.name}: back at the world`).toEqual(['world']);
    }
  });

  it('A on a terminal outcome over a suspended conversation pops only the outcome: the dialogue stays and no dismiss is sent', async () => {
    // WRONG IMPL KILLED: an A mapped to pop-to-base (it would dismiss the conversation the player
    // never asked to end: Start does that, A does not) and an A that is refused or inert whenever a
    // dialogue frame is below the outcome.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the dialogue is open').toBe(true);
    putBattle(BATTLE_ID, 1100);
    putBattle(BATTLE_ID, 1200, 'SideAWins');
    expect(battleShown(), 'precondition: the outcome is on screen').toBe(true);
    expect(stackNames(), 'precondition: the outcome sits above the suspended dialogue').toEqual([
      'world',
      'dialogueView',
      'battleView',
    ]);

    tap('Enter', 1300); // age 100
    expect(battleShown(), 'A inside the grace leaves the outcome').toBe(true);
    tap('Enter', 1700); // age 500
    expect(battleShown(), 'A after the grace continues the outcome').toBe(false);
    expect(stackNames(), 'the conversation is still on the stack').toEqual([
      'world',
      'dialogueView',
    ]);
    expect(dialogueShown(), 'and still shown').toBe(true);
    expect(callsOf('dismissDialogue'), 'A never ends the conversation').toEqual([]);
  });

  // ------------------------------------------------------------------------------------------
  // CTL6C.3: the battle-safe policy
  // ------------------------------------------------------------------------------------------

  it('CTL6C-3-MAIN-REFUSED-COMMAND: at a battle base a dialogue-choice click reaches no reducer and shows the catalogued reason on the status line; the same click at the world sends advance_dialogue; the battle`s own stack moves still work', async () => {
    // WRONG IMPL KILLED: a refusal that is a no-op (the policy is never consulted by dispatch, so
    // the click still sends advance_dialogue: RED today); a refusal that sends and then reports
    // (the reducer call must not exist); a refusal with no message (the player sees a dead
    // button); a message that is not the catalogued reason, or one frozen in the wrong locale; a
    // refusal reported as an ERROR (a policy is not a fault: no `[status]` console error); a
    // policy that refuses at the world (the control sends); one that refuses everything (Start
    // over the suspended dialogue still dismisses it: dismissDialogue is battle-safe); and a
    // stack read that is a frame stale (the dialogue is up before the battle row arrives).
    // The path is a REAL production one that bypasses the menu: the document-level click
    // delegation on `[data-choice-idx]` runs `dispatch({ kind: 'advanceDialogue' })`.
    // The same reason is also announced through the live region; CTL6C-3-ANNOUNCE-REFUSAL below
    // pumps the frame loop past the region's coalescing window and pins that.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the dialogue is open').toBe(true);
    expect(statusText(), 'precondition: the status line is empty').toBe('');

    // Control: at the world the click sends.
    clickChoice('1', 1020);
    expect(
      callsOf('advanceDialogue'),
      'control: at the world the choice reaches the reducer',
    ).toEqual([{ name: 'advanceDialogue', args: { choiceIdx: 1 } }]);
    expect(statusText(), 'control: nothing is reported at the world').toBe('');

    // The battle arrives; the conversation is suspended under it.
    putBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(stack()[0], 'precondition: the base is the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    clickChoice('2', 1200);
    expect(
      callsOf('advanceDialogue'),
      'at a battle base the click reaches no reducer: still the one world call',
    ).toEqual([{ name: 'advanceDialogue', args: { choiceIdx: 1 } }]);
    expect(statusText(), 'the status line shows the catalogued reason').toBe(
      i18nT('menu.disabled.inBattle'),
    );
    expect(statusText(), 'fixture: and it is real text').not.toBe('');
    clickChoice('0', 1210);
    expect(callsOf('advanceDialogue'), 'a second click is refused too').toHaveLength(1);
    expect(
      errorSpy.mock.calls.filter((c) => c[0] === '[status]'),
      'a refusal is a policy, not an error: nothing goes through the error path',
    ).toEqual([]);

    // The battle-safe command still runs: Start dismisses the suspended conversation.
    expect(stackNames(), 'precondition: the dialogue is suspended under the battle').toEqual([
      'battle',
      'dialogueView',
    ]);
    expect(callsOf('dismissDialogue'), 'precondition: nothing dismissed yet').toEqual([]);
    tap('Escape', 1300);
    expect(
      callsOf('dismissDialogue'),
      'Start over the suspended dialogue still dismisses it (dismissDialogue is battle-safe)',
    ).toHaveLength(1);
  });

  it('CTL6C-3-ANNOUNCE-REFUSAL: a refusal at a battle base is announced: once the frame loop has pumped the live region past its coalescing window, #a11y-live reads exactly the catalogued reason, which it did not carry before the refusal', async () => {
    // WRONG IMPL KILLED: a refusal that writes the status line but never announces it (a
    // screen-reader player hears nothing when the click is refused: the status line is not a live
    // region); an announcement of some other text (the command kind, an error line, the English
    // copy under another locale); and an announcement the frame loop's own overlay announcement
    // overwrites. The control proves the region is live in this harness (the frame loop already
    // painted the dialogue's announcement into it) and that it did not already hold the reason, so
    // the final read can pass neither on a dead region nor on a pre-filled one.
    // WRONG IMPL KILLED (verifier v30, measured): an announcement stamped with a clock of 0 (the
    // measured mutant), or one 200 ms or more stale, instead of the refusal's own
    // `performance.now()`: its coalescing window (liveRegion.ts, COALESCE_WINDOW_MS = 500) is then
    // over by the frame at age 10 or age 300, which paints the reason early; both must still show
    // the earlier announcement.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    putBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(stackNames(), 'precondition: the conversation is suspended under the battle').toEqual([
      'battle',
      'dialogueView',
    ]);
    const reason = i18nT('menu.disabled.inBattle');

    // Control: two frames, more than the coalescing window apart, paint the overlay announcement.
    frame(1110);
    frame(1700);
    const before = liveText();
    expect(before, 'control: the frame loop painted an overlay announcement').not.toBe('');
    expect(before, 'control: before any refusal the region does not carry the reason').not.toBe(
      reason,
    );

    clickChoice('2', 1800); // the refusal's coalescing window opens at clock 1800
    expect(callsOf('advanceDialogue'), 'precondition: the click was refused').toEqual([]);
    expect(statusText(), 'precondition: the status line shows the reason').toBe(reason);
    frame(1810); // age 10: inside the 500 ms window
    expect(liveText(), 'inside the window (age 10) the reason is not painted yet').toBe(before);
    frame(2100); // age 300: still inside it
    expect(liveText(), 'nor at age 300: the window runs from the refusal itself').toBe(before);
    frame(2400); // age 600: past it
    expect(liveText(), 'the live region announces exactly the catalogued reason').toBe(reason);
  });

  it('CTL6C-3-REFUSE-VIEW-CALLBACK: a second refused command kind, through a real view callback (ctl-11b: via the Monsters sheet and the Trade view): Care pressed on the Monsters sheet reaches care at the world, and a captured Trade Accept button clicked at a battle base reaches no reducer and shows the reason on the status line', async () => {
    // ctl-11b (named intentional change, residual R-ctl-8f-CTL8F.2): this case used to click the
    // raising view's monster-card Care button, a control the Bag work is retiring. Care is now
    // pressed where a player presses it, on the Monsters sheet (V, A on the monster, Down to Care,
    // A: the adapter's `care` command through `dispatch`). The CAPTURED-CALLBACK refusal arm cannot
    // follow it: the Monsters screen is a keyed adapter, not a DOM callback, and no frame of it can
    // be open over a battle (the batch that brings a battle closes it, and the menu's Monsters entry
    // is disabled over one), so there is no button to capture. The arm keeps its intent, "the
    // refusal is the dispatch-wide policy, not a guard on one path", on another command kind
    // through another real view's callback: the Trade view's Accept (`respondTrade`, refused by the
    // same policy). The refusal of `care` itself is the policy row `COMMAND_BATTLE_POLICY.care`
    // (contextStack.ts), driven through the raising card's onCare in main.dispatch.test.ts while the
    // card still exists (R-ctl-11b-RAISINGCARDS).
    // WRONG IMPL KILLED: a refusal narrowed to the one command the dialogue issues (`command.kind
    // === 'advanceDialogue'`: respondTrade would still reach its reducer at the battle base); a
    // refusal wired into the dialogue-choice click delegation instead of `dispatch` (a view callback
    // goes straight to dispatch and would bypass it); a refusal that sends and then reports; one
    // that refuses at the world too (the controls send, for Care through the sheet and for Accept);
    // and a Monsters-sheet Care that no longer reaches its reducer.
    // HONEST SCOPE: the refusal arm is not a player-reachable click. The battle's batch closes the
    // Social frame first (it is not battleSafe, CTL3.2), so the button is captured at the world and
    // clicked after that close: it drives the real view's real callback into the real `dispatch`.
    await bootReady();
    seedWorld(1000);
    opts.store.upsertMonster(RAISED_MONSTER);
    server(1010);

    // Control 1: Care on the Monsters sheet reaches the care reducer with the monster's id.
    tap('KeyV', 1020);
    expect(stackNames(), 'precondition: V opened Monsters over the menu').toEqual([
      'world',
      'menuView',
      'boxView',
    ]);
    tap('Enter', 1030); // A on the monster: its sheet, the cursor on Summary
    tap('ArrowDown', 1040); // Care
    expect(
      byId('monstersSheet-root-care').getAttribute('aria-selected'),
      'precondition: the sheet cursor is on Care',
    ).toBe('true');
    expect(callsOf('care'), 'precondition: nothing sent yet').toEqual([]);
    tap('Enter', 1050); // A on Care
    expect(callsOf('care'), 'control: at the world Care reaches the care reducer').toEqual([
      { name: 'care', args: { monsterId: 31n } },
    ]);
    expect(statusText(), 'control: nothing is reported at the world').toBe('');
    await flush();
    tap('Escape', 1060); // Start: back to the bare world
    expect(stackNames(), 'precondition: the bare world').toEqual(['world']);

    // Control 2: the captured callback reaches its reducer at the world.
    const offer: StoreTradeOffer = {
      tradeId: 5n,
      initiator: OTHER_IDENTITY,
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
      createdAtMs: 0n,
    };
    opts.store.upsertTradeOffer(offer);
    server(1100);
    tap('KeyU', 1110);
    expect(tradeShown(), 'precondition: U opened the trade panel').toBe(true);
    const accept = document.querySelector('#trade-actions button[data-action="accept"]');
    if (accept === null) throw new Error('the trade view painted no Accept button');
    expect(callsOf('respondTrade'), 'precondition: nothing sent yet').toEqual([]);
    clock.t = 1120;
    (accept as HTMLButtonElement).click();
    expect(callsOf('respondTrade'), 'control: at the world Accept reaches its reducer').toEqual([
      { name: 'respondTrade', args: { tradeId: 5n, accepted: true } },
    ]);
    expect(statusText(), 'control: nothing is reported at the world').toBe('');
    await flush(); // the promise settles and the view's in-flight lock releases
    expect((accept as HTMLButtonElement).disabled, 'precondition: Accept is enabled again').toBe(
      false,
    );

    // The battle arrives: its batch closes the Social frame.
    putBattle(BATTLE_ID, 1200);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(tradeShown(), 'precondition: the battle closed the trade panel').toBe(false);
    expect(stack(), 'precondition: the bare battle base').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);

    clock.t = 1300;
    (accept as HTMLButtonElement).click();
    expect(
      callsOf('respondTrade'),
      'at a battle base Accept reaches no reducer: still the one world call',
    ).toHaveLength(1);
    expect(statusText(), 'the status line shows the catalogued reason').toBe(
      i18nT('menu.disabled.inBattle'),
    );
    await flush();
    expect(callsOf('respondTrade'), 'nor later, once the refused promise settles').toHaveLength(1);
    expect(callsOf('care'), 'and the sheet`s one Care call is still the only one').toHaveLength(1);
  });

  it('CTL6C-3-STATUS-CLEARS: the refusal reason stays on the status line while the battle goes on and is cleared when the base returns to the world, whether the battle ends or its row vanishes; an error reported after the refusal is left on it', async () => {
    // WRONG IMPL KILLED: a refusal line that sticks until a reconnect (red today: the base returns
    // to the world and the player keeps reading "Not during a battle" at the world); a clear on
    // every batch or frame (the reason would vanish while the battle still goes on); a clear only
    // on a terminal outcome (a battle row that simply vanishes would leave the line); and a clear of
    // the whole status line on the base change (an error reported after the refusal, which the
    // player has not read yet, would be wiped with it).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    const reason = i18nT('menu.disabled.inBattle');

    // (a) The battle goes on: the reason stays. Then it ends: the reason is cleared.
    putBattle(BATTLE_ID, 1100);
    clickChoice('1', 1200);
    expect(callsOf('advanceDialogue'), 'precondition: the click was refused').toEqual([]);
    expect(statusText(), 'precondition: the refusal shows its reason').toBe(reason);
    server(1300);
    frame(1310);
    server(1400);
    expect(stack()[0], 'precondition: the base is still the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    expect(statusText(), 'while the battle goes on the reason stays').toBe(reason);
    putBattle(BATTLE_ID, 1500, 'SideAWins');
    expect(stack()[0], 'precondition: the base is the world again').toEqual({ kind: 'world' });
    expect(battleShown(), 'precondition: the outcome is shown').toBe(true);
    expect(statusText(), 'the battle ended: the stale reason is cleared').toBe('');
    tap('Backspace', 1600);
    expect(battleShown(), 'precondition: B continued the outcome').toBe(false);

    // (b) A second battle whose row vanishes with no outcome shown: cleared too.
    putBattle(102n, 1700);
    clickChoice('1', 1800);
    expect(statusText(), 'precondition: refused at the second battle').toBe(reason);
    opts.store.removeBattle(102n);
    server(1900);
    expect(stack()[0], 'precondition: the base is the world again').toEqual({ kind: 'world' });
    expect(statusText(), 'the battle row vanished: the stale reason is cleared').toBe('');

    // (c) An error reported after the refusal is not the refusal: the base change leaves it.
    putBattle(103n, 2000);
    clickChoice('1', 2100);
    expect(statusText(), 'precondition: refused at the third battle').toBe(reason);
    opts.onError('subscription', 'quota exceeded');
    const error = 'subscription: quota exceeded';
    expect(statusText(), 'precondition: the error replaced the reason').toBe(error);
    expect(
      errorSpy.mock.calls.filter((c) => c[0] === '[status]').map((c) => c[1]),
      'precondition: it went through the error path',
    ).toEqual([error]);
    opts.store.removeBattle(103n);
    server(2200);
    expect(stack()[0], 'precondition: the base is the world again').toEqual({ kind: 'world' });
    expect(statusText(), 'the error stays: only the refusal line is cleared').toBe(error);
    expect(callsOf('advanceDialogue'), 'no refused click ever reached the reducer').toEqual([]);
  });

  it('CTL6C-3-MAIN-MENU-DISABLED: over a battle every root row but Options and Close is aria-disabled; A or a click on Monsters, Bag or Journal opens nothing and shows the reason, A on the disabled Social group does not enter it, and Q and L open no Journal or Rankings either; Options > How to play opens help above the menu over the battle, it survives a batch and a frame, and Backspace closes just help', async () => {
    // WRONG IMPL KILLED: a menu opened over a battle with every row enabled (Monsters would open
    // the box over the battle); the pre-decision menu that disables only the non-battleSafe rows
    // (Journal and Social stay enabled: A on Journal opens the quest log, whose in-flow shell the
    // battle overlay paints over, so the player sees nothing while the keys go to it: red today);
    // a disabled row painted but still activatable (A or a click opens boxView, raisingView or the
    // quest log); a disabled group that A still enters; a disabled row with no reason on the
    // feedback line, the same reason for Bag as for Monsters, or Bag's text missing; a menu that
    // disables Options or Close too (help would be unreachable over the battle); a keyboard path
    // guarded but not the pointer path (the click is checked too); a legacy letter hotkey (Q, L)
    // that opens the Journal or the Rankings over the battle behind the menu's back; and a child
    // opened above the menu over the battle that the next batch closes (help is battleSafe and
    // stamped: it must survive).
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    await flush();
    tap('Escape', 1200);
    expect(menuShown(), 'precondition: the menu is open over the battle').toBe(true);
    expect(navActive(), 'precondition: the cursor is on Monsters').toBe('monsters');

    const aria = (key: string): string | null =>
      byId(`menu-root-${key}`).getAttribute('aria-disabled');
    expect(aria('monsters'), 'Monsters is aria-disabled over a battle').toBe('true');
    expect(aria('bag'), 'Bag is aria-disabled').toBe('true');
    expect(
      aria('profile'),
      'the Profile group (all three children disabled) is aria-disabled',
    ).toBe('true');
    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
    // battle until ctl-7a anchors their shells): Journal and Social were enabled here.
    expect(aria('journal'), 'Journal is aria-disabled over a battle').toBe('true');
    expect(
      aria('social'),
      'the Social group (Trades, Challenges and Rankings all disabled) is aria-disabled',
    ).toBe('true');
    for (const key of ['options', 'close']) {
      expect(aria(key), `${key} stays enabled`).toBeNull();
    }
    expect(menuFeedback(), 'precondition: no reason is shown yet').toBe('');

    // A on Monsters (the first entry).
    tap('Enter', 1300);
    expect(boxShown(), 'A on a disabled Monsters row does not show the box').toBe(false);
    expect(menuFeedback(), 'it shows the reason').toBe(i18nT('menu.disabled.inBattle'));
    expect(stackNames(), 'the menu is still the only frame').toEqual(['battle', 'menuView']);

    // A on Bag.
    tap('ArrowDown', 1400);
    expect(navActive(), 'precondition: the cursor is on Bag').toBe('bag');
    tap('Enter', 1500);
    expect(shownByTestId('raising-title'), 'A on a disabled Bag row does not show the bag').toBe(
      false,
    );
    expect(menuFeedback(), 'Bag shows its own reason').toBe(i18nT('menu.disabled.battleBag'));

    // A click on a disabled row is refused the same way.
    byId('menu-root-monsters').click();
    expect(boxShown(), 'a click on Monsters does not show the box').toBe(false);
    expect(menuFeedback(), 'a click shows the reason too').toBe(i18nT('menu.disabled.inBattle'));
    expect(navActive(), 'the click moved the cursor to Monsters').toBe('monsters');

    // INTENTIONAL CHANGE (ctl-6c, supervisor decision option-a: Journal/Rankings stay disabled over a
    // battle until ctl-7a anchors their shells): A on Journal opened the quest log above the menu
    // over the battle and it survived the next batch. It now opens nothing and shows the reason; the
    // surviving-child arm moves to Options > How to play below.
    tap('ArrowDown', 1600);
    tap('ArrowDown', 1700);
    expect(navActive(), 'precondition: the cursor is on Journal').toBe('journal');
    expect(menuFeedback(), 'precondition: the cursor move cleared the reason').toBe('');
    tap('Enter', 1800);
    expect(questLogShown(), 'A on a disabled Journal row does not show the quest log').toBe(false);
    expect(menuFeedback(), 'it shows the reason').toBe(i18nT('menu.disabled.inBattle'));
    expect(stackNames(), 'the menu is still the only frame').toEqual(['battle', 'menuView']);
    tap('ArrowDown', 1850);
    expect(navActive(), 'precondition: the cursor moved on to Social').toBe('social');
    expect(menuFeedback(), 'precondition: and the reason is cleared').toBe('');
    byId('menu-root-journal').click();
    expect(questLogShown(), 'a click on Journal does not show the quest log').toBe(false);
    expect(menuFeedback(), 'a click on Journal shows the reason').toBe(
      i18nT('menu.disabled.inBattle'),
    );
    expect(navActive(), 'the click moved the cursor to Journal').toBe('journal');
    expect(stackNames()).toEqual(['battle', 'menuView']);

    // The disabled Social group is not entered: the root rows stay painted.
    tap('ArrowDown', 1900);
    expect(navActive(), 'precondition: the cursor is on Social').toBe('social');
    expect(menuFeedback(), 'precondition: the reason is cleared').toBe('');
    tap('Enter', 1950);
    expect(navActive(), 'A on the disabled Social group leaves the cursor on it').toBe('social');
    expect(
      document.getElementById('menu-root-monsters'),
      'the root list is still painted: Social was not entered',
    ).not.toBeNull();
    expect(menuFeedback(), 'it shows the reason').toBe(i18nT('menu.disabled.inBattle'));

    // The legacy letter hotkeys cannot reach the Journal or the Rankings behind the menu's back.
    tap('KeyQ', 2000);
    expect(questLogShown(), 'Q with the menu over a battle opens no quest log').toBe(false);
    tap('KeyL', 2050);
    expect(rankingsShown(), 'L with the menu over a battle opens no leaderboard').toBe(false);
    expect(menuShown(), 'the menu is still open').toBe(true);
    expect(battleShown(), 'over the battle').toBe(true);
    expect(stack(), 'and the stack is unchanged').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);

    // Options is enabled: it enters, and How to play opens help above the menu over the battle.
    tap('ArrowDown', 2100);
    tap('ArrowDown', 2150);
    expect(navActive(), 'precondition: the cursor is on Options').toBe('options');
    expect(aria('options'), 'precondition: Options is enabled').toBeNull();
    tap('Enter', 2200);
    expect(navActive(), 'A on Options enters it, on How to play').toBe('help');
    expect(
      document.getElementById('menu-root-monsters'),
      'anti-vacuity: entering a sub-list repaints the rows',
    ).toBeNull();
    expect(
      byId('menuOptions-root-help').getAttribute('aria-disabled'),
      'How to play is enabled over a battle',
    ).toBeNull();
    expect(menuFeedback(), 'and no reason is shown').toBe('');
    tap('Enter', 2300);
    expect(helpShown(), 'A on How to play opens help above the menu').toBe(true);
    expect(battleShown(), 'the battle stays shown').toBe(true);
    expect(menuShown(), 'with the menu open beneath help').toBe(true);
    expect(stackNames(), 'help is a frame above the menu above the battle').toEqual([
      'battle',
      'menuView',
      'helpView',
    ]);
    expect(stack(), 'both frames are stamped with the battle').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
      { kind: 'screen', id: 'helpView', overBattle: '101' },
    ]);
    server(2400);
    expect(helpShown(), 'help survives the next batch').toBe(true);
    expect(menuShown(), 'with the menu still open beneath it').toBe(true);
    expect(battleShown(), 'and the battle still shown').toBe(true);
    frame(2410);
    expect(stackNames(), 'and a frame').toEqual(['battle', 'menuView', 'helpView']);

    // Backspace closes just help.
    tap('Backspace', 2500);
    expect(helpShown(), 'B closes help').toBe(false);
    expect(menuShown(), 'the menu is back on top').toBe(true);
    expect(battleShown(), 'over the battle').toBe(true);
    expect(stackNames()).toEqual(['battle', 'menuView']);
  });
});

// ==========================================================================================
// ctl-7c: the shell hosts each frame's adapter state and lends it the frame's view (CTL7C.2)
// ==========================================================================================
//
// The adapter table main.ts hands its screen host is the module mock's mutable copy (`H.adapters`),
// so a case swaps ONE frame's adapter for a recording stand-in and every other frame stays legacy.
// The subject is the quest log (J opens it at the world). The stand-in counts its own
// presses in its state and records every init, step and paint, so "the state threads" and "the
// shell paints the real view" are read off the stand-in, never off main.ts's internals (ctl-11a: J
// opens the quest log over the main menu and, over its own screen, closes it as Start). The real
// view class is imported AFTER the boot, so it is the very class main.ts constructed.

/** Swap one frame's adapter for this boot; afterEach (the `restorers` drain) puts it back. */
function swapAdapter(id: string, adapter: unknown): void {
  const previous = H.adapters[id];
  H.adapters[id] = adapter;
  restorers.push(() => {
    H.adapters[id] = previous;
  });
}

describe('main.ts screen-host state and paint (runtime, ctl-7c)', { sequential: true }, () => {
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

  it('CTL7C-2-BOOT-STATE: a nav-capable quest log starts from its init on its first press and each press sees the state the previous one returned, through frames and store batches; closing and reopening starts it again; each press paints the REAL quest log view once (none at open, none on a batch); the OS repeats of an A it consumed are prevented', async () => {
    // WRONG IMPL KILLED: a shell that keeps no adapter state (every press starts from init: a
    // cursor that can never move twice), one that re-inits on every frame or store batch (the
    // cursor jumps home while the player reads), one that never resets on reopen (a dialogue or a
    // shop reopened on its last node or confirm), an EAGER init or paint at open (the open's paint
    // is overwritten by the legacy render anyway, and init would read the store mid-batch), a
    // paint per batch, a paint into a stand-in or a freshly built view instead of the instance on
    // screen, a view-lending table whose quest log thunk names a sibling view, two paints per
    // press, a paint of the previous state, and a pre-ladder intercept that does not cover a nav
    // screen (the OS repeats of the consumed Enter would reach the page and activate the focused
    // control the press just opened).
    await bootReady();
    server(1000);
    const { QuestLogView } = await import('./ui/questLogView');
    interface Counter {
      readonly n: number;
    }
    const inits: Array<{ readonly vm: unknown; readonly state: Counter }> = [];
    const steps: Array<{
      readonly vm: unknown;
      readonly state: unknown;
      readonly next: Counter;
      readonly btn: NavInput;
    }> = [];
    const paints: Array<{ readonly view: unknown; readonly vm: unknown; readonly state: unknown }> =
      [];
    let vmSeq = 0;
    swapAdapter('questLogView', {
      nav: true,
      viewModel: () => {
        vmSeq += 1;
        return { vmSeq };
      },
      init: (vm: unknown) => {
        const state: Counter = { n: 0 };
        inits.push({ vm, state });
        return state;
      },
      onButton: (vm: unknown, state: unknown, btn: NavInput) => {
        const n = (state as Partial<Counter> | undefined)?.n;
        const next: Counter = { n: typeof n === 'number' ? n + 1 : -100 };
        steps.push({ vm, state, next, btn });
        // ctl-11a: J over its own screen is routed as Start to the top frame's adapter (it no longer
        // toggles the overlay behind the adapter's back), so the stand-in answers Start with the
        // stack move the real adapters give it (pop to the base); every other button is consumed.
        return { state: next, result: btn.button === 'Start' ? { kind: 'popToBase' } : 'consumed' };
      },
      paint: (view: unknown, vm: unknown, state: unknown) => {
        paints.push({ view, vm, state });
      },
    });

    // ctl-11a: the quest log is opened by J (Q is LB now) and sits over the main menu, and J over
    // its own screen acts as Start (closes both) instead of toggling it.
    tap('KeyJ', 1010);
    expect(questLogShown(), 'precondition: J opened the quest log').toBe(true);
    expect(stackNames()).toEqual(['world', 'menuView', 'questLogView']);
    expect(inits, 'opening runs no adapter code').toEqual([]);
    expect(paints, 'and paints nothing').toEqual([]);

    // Press 1, A: the first press starts from init, once, and paints the real view once.
    const enter = fire('keydown', 'Enter', 1100);
    expect(
      steps.map((s) => s.btn),
      'the A press reached the stand-in',
    ).toEqual([{ button: 'A', repeat: false }]);
    expect(inits, 'init ran once, on the first press').toHaveLength(1);
    expect(steps[0]?.state, 'the first press starts from the init state').toBe(inits[0]?.state);
    expect(enter.defaultPrevented, 'the A the stand-in consumed is prevented').toBe(true);
    // The OS repeats of that Enter are prevented until its keyup, and are no second press.
    const osRepeat = fire('keydown', 'Enter', 1130, { init: { repeat: true } });
    expect(osRepeat.defaultPrevented, 'the OS repeat of the consumed Enter is prevented').toBe(
      true,
    );
    expect(steps, 'an OS repeat is not a press').toHaveLength(1);
    fire('keyup', 'Enter', 1150);
    expect(paints, 'exactly one paint for one press').toHaveLength(1);
    const view = paints[0]?.view;
    expect(view, 'the shell lends the real quest log view').toBeInstanceOf(QuestLogView);
    expect((view as { visible?: unknown }).visible, 'the very instance on screen').toBe(true);
    expect(paints[0]?.vm, 'painted with the view model the press saw').toBe(steps[0]?.vm);
    expect(paints[0]?.state, 'and the state the press produced').toBe(steps[0]?.next);

    // A frame and a store batch in between reset nothing and paint nothing.
    frame(1200);
    server(1300);
    expect(questLogShown(), 'precondition: the quest log survives the batch').toBe(true);
    expect(inits, 'no re-init on a frame or a batch').toHaveLength(1);
    expect(paints, 'no paint on a frame or a batch').toHaveLength(1);

    // Presses 2 (Down) and 3 (LB), a frame and a batch between them: each resumes the last.
    tap('ArrowDown', 1400);
    frame(1500);
    server(1600);
    tap('PageUp', 1700);
    expect(
      steps.map((s) => s.btn.button),
      'three presses reached the stand-in',
    ).toEqual(['A', 'Down', 'LB']);
    expect(inits, 'still the one init').toHaveLength(1);
    expect(steps[1]?.state, 'press 2 resumes from press 1').toBe(steps[0]?.next);
    expect(steps[2]?.state, 'press 3 resumes from press 2').toBe(steps[1]?.next);
    expect(steps[2]?.next.n, 'the count threaded through all three').toBe(3);
    expect(paints, 'one paint per press').toHaveLength(3);
    for (const [i, p] of paints.entries()) {
      expect(p.view, `paint ${i}: the same view instance`).toBe(view);
      expect(p.vm, `paint ${i}: the view model press ${i} saw`).toBe(steps[i]?.vm);
      expect(p.state, `paint ${i}: the state press ${i} produced`).toBe(steps[i]?.next);
    }

    // Close it and reopen it: the reopened frame starts again from a fresh init. J over its own
    // screen is Start: the press reaches the stand-in (a fourth step, painted like any other) and
    // its popToBase closes the quest log and the menu beneath it.
    tap('KeyJ', 1800);
    expect(
      steps.map((s) => s.btn.button),
      'J reached the stand-in as Start',
    ).toEqual(['A', 'Down', 'LB', 'Start']);
    expect(steps[3]?.state, 'the Start resumes press 3`s state').toBe(steps[2]?.next);
    expect(paints, 'the Start paints once like any press').toHaveLength(4);
    expect(questLogShown(), 'precondition: J (its own Start) closed the quest log').toBe(false);
    expect(stackNames()).toEqual(['world']);
    tap('KeyJ', 1900);
    expect(questLogShown(), 'precondition: J reopened it').toBe(true);
    expect(stackNames(), 'precondition: over the main menu again').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    expect(inits, 'reopening runs no adapter code either').toHaveLength(1);
    expect(paints, 'and paints nothing').toHaveLength(4);
    tap('Enter', 2000);
    expect(steps, 'the reopened frame was pressed').toHaveLength(5);
    expect(inits, 'it was initialised afresh').toHaveLength(2);
    expect(steps[4]?.state, 'from the NEW init state').toBe(inits[1]?.state);
    expect(steps[4]?.next.n, 'the count starts over').toBe(1);
    expect(paints, 'one more paint').toHaveLength(5);
    expect(paints[4]?.view, 'into the same real view').toBe(view);
    expect(paints[4]?.state).toBe(steps[4]?.next);
  });
});

// ==========================================================================================
// ctl-7c round 2: repeats are full steps, and a view that cannot paint is reported (red-team)
// ==========================================================================================
//
// Same harness and stand-in pattern as above. The error overlay is the self-mounted
// `#mr-error-overlay` that main.frameErrorWiring.test.ts reads: one `.mr-error-row` per ring
// record, newest first, each carrying its `data-source` and the text `[<source>] <message>`.

/** Every rendered error-overlay row, in DOM order (newest first). */
const errorOverlayRows = (): Array<{ source: string | undefined; text: string }> =>
  Array.from(document.querySelectorAll<HTMLElement>('.mr-error-row')).map((el) => ({
    source: el.dataset.source,
    text: el.textContent ?? '',
  }));

describe('main.ts repeats and paint failures (runtime, ctl-7c)', { sequential: true }, () => {
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

  it('CTL7C-2-BOOT-REPEAT-STEPS: under a held arrow every synthesized repeat is a full step: it resumes the state the previous step returned and repaints the real view with the next one, exactly as the press does', async () => {
    // WRONG IMPL KILLED (X8, X9): a shell whose repeats skip the state store or the paint (a held
    // arrow would move a list cursor one row, then redraw nothing, or restart every repeat from
    // the press's state), and one that builds the repeat's step from a stale or fresh state.
    await bootReady();
    server(1000);
    const { QuestLogView } = await import('./ui/questLogView');
    const states: unknown[] = [];
    const inputs: NavInput[] = [];
    const paints: Array<{ readonly view: unknown; readonly state: unknown }> = [];
    swapAdapter('questLogView', {
      nav: true,
      viewModel: () => undefined,
      init: () => 0,
      onButton: (_vm: unknown, state: unknown, btn: NavInput) => {
        states.push(state);
        inputs.push(btn);
        return { state: typeof state === 'number' ? state + 1 : -100, result: 'consumed' };
      },
      paint: (view: unknown, _vm: unknown, state: unknown) => {
        paints.push({ view, state });
      },
    });
    // ctl-11a: the quest log is opened by J (Q is LB now), over the main menu.
    tap('KeyJ', 1010);
    expect(questLogShown(), 'precondition: J opened the quest log').toBe(true);
    expect(stackNames(), 'precondition: over the main menu').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);

    fire('keydown', 'ArrowDown', 1100);
    frame(1450);
    frame(1550);
    frame(1650);
    fire('keyup', 'ArrowDown', 1700);
    expect(inputs, 'the press and three synthesized repeats reached the stand-in').toEqual([
      { button: 'Down', repeat: false },
      { button: 'Down', repeat: true },
      { button: 'Down', repeat: true },
      { button: 'Down', repeat: true },
    ]);
    expect(states, 'each repeat resumes the state the step before it returned').toEqual([
      0, 1, 2, 3,
    ]);
    expect(
      paints.map((p) => p.state),
      'and each repaints with the state it produced',
    ).toEqual([1, 2, 3, 4]);
    for (const [i, p] of paints.entries()) {
      expect(p.view, `paint ${i}: the real quest log view`).toBeInstanceOf(QuestLogView);
      expect(p.view, `paint ${i}: the same instance every time`).toBe(paints[0]?.view);
    }

    // A fresh press after the repeats resumes from the last repeat's state.
    tap('PageUp', 1800);
    expect(states.at(-1), 'the next press starts where the last repeat left off').toBe(4);
    expect(paints.at(-1)?.state).toBe(5);
  });

  it('CTL7C-2-BOOT-PAINT-THROWS: a view whose paint throws never costs a key its result (B still pops the frame) and every failure is logged; it is also surfaced in the error overlay as an `uncaught` row `screen paint: <message>`, once per message', async () => {
    // WRONG IMPL KILLED (C3, C4): a paint failure that escapes the host (the key handler throws and
    // B can never close the frame whose view is broken), one that swallows the step's result, one
    // that is reported nowhere, and (the shell's report, NEW CONTRACT) one that stays in the
    // console only (a playtester sees a frozen screen with nothing on the error overlay and no
    // record in the F9 bundle), one pushed untagged or under another source, and one pushed on
    // every press (a list held down repaints at 10 Hz: one broken view would flood the 64-slot
    // ring the crash records need), while a DIFFERENT failure must still be recorded.
    await bootReady();
    server(1000);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let message = 'broken view';
    const asked: NavInput[] = [];
    swapAdapter('questLogView', {
      nav: true,
      viewModel: () => undefined,
      init: () => undefined,
      onButton: (_vm: unknown, state: unknown, btn: NavInput) => {
        asked.push(btn);
        return { state, result: btn.button === 'B' && !btn.repeat ? { kind: 'pop' } : 'consumed' };
      },
      paint: () => {
        throw new Error(message);
      },
    });
    const paintReports = (): unknown[][] =>
      errors.mock.calls.filter((c) => c[0] === '[screen] paint error');
    const screenPaintRows = (): Array<{ source: string | undefined; text: string }> =>
      errorOverlayRows().filter((r) => r.text.includes('screen paint:'));

    // ctl-11a: the quest log is opened by J (Q is LB now) over the main menu, so B pops it back to
    // the menu, not to the world.
    tap('KeyJ', 1010);
    expect(questLogShown(), 'precondition: J opened the quest log').toBe(true);
    const overlay = byId('mr-error-overlay');
    expect(overlay.style.display, 'precondition: the error overlay starts hidden').toBe('none');
    expect(errorOverlayRows(), 'precondition: no error row yet').toEqual([]);

    // Every observation is taken as it happens and asserted below, so the part that holds today
    // (B still pops, the console log) is checked before the overlay part.
    tap('ArrowDown', 1100); // the first throwing paint
    const shownAfterFirst = overlay.style.display !== 'none';
    const rowsAfterFirst = screenPaintRows();
    tap('PageUp', 1200); // the same message again
    const rowsAfterSame = screenPaintRows();
    message = 'broken differently';
    tap('PageUp', 1300); // a different message
    const rowsAfterDistinct = screenPaintRows();
    const back = tap('Backspace', 1400); // B: its paint throws the same message again
    const rowsAfterBack = screenPaintRows();

    // The result is never lost, and every failure is logged.
    expect(
      asked.map((b) => b.button),
      'every press reached the stand-in',
    ).toEqual(['Down', 'LB', 'LB', 'B']);
    expect(back.defaultPrevented, 'the B press was consumed').toBe(true);
    expect(questLogShown(), 'B still closes a frame whose paint throws').toBe(false);
    expect(stackNames(), 'one frame: back into the menu it was opened over').toEqual([
      'world',
      'menuView',
    ]);
    expect(
      paintReports().map((c) => (c[1] as Error | undefined)?.message),
      'each throwing paint is logged with the error it threw',
    ).toEqual(['broken view', 'broken view', 'broken differently', 'broken differently']);

    // NEW CONTRACT: surfaced like an uncaught frame error, deduped on the message.
    expect(shownAfterFirst, 'the first throwing paint shows the error overlay').toBe(true);
    expect(rowsAfterFirst, 'one tagged `uncaught` row').toEqual([
      { source: 'uncaught', text: '[uncaught] screen paint: broken view' },
    ]);
    expect(rowsAfterSame, 'the same message again adds no row').toEqual(rowsAfterFirst);
    expect(rowsAfterDistinct, 'a different message adds its own row, newest first').toEqual([
      { source: 'uncaught', text: '[uncaught] screen paint: broken differently' },
      { source: 'uncaught', text: '[uncaught] screen paint: broken view' },
    ]);
    expect(rowsAfterBack, 'B`s repeat of that message adds none').toEqual(rowsAfterDistinct);
  });
});
