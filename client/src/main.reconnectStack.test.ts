// @vitest-environment happy-dom
/**
 * main.reconnectStack.test.ts: a reconnect closes its frames through the context stack (so-1,
 * SO1.1 to SO1.4), and keeps the unconditional view-state resets.
 *
 * The pure sweep (`reconnectSweep`) and the closing roster (`RECONNECT_CLOSES`) are proven in
 * ui/contextStack.test.ts. This file proves the SHELL: that a freshly imported main.ts, with the
 * REAL views, answers `onReconnect` by closing every frame the roster names through each view's own
 * hide path, leaves the stack at once (before any frame, key or batch re-mirrors it) holding only
 * what survives, and still runs every protected view's reset when that view is neither visible nor
 * on the stack. Every case reads only what a player or the server can see: which overlays are shown,
 * the read-only `__game()` hook's `stack`, the status line, the session overlay, and the DOM state a
 * view's `hide()` clears.
 *
 * SO1.1: the menu with each Social panel, the bag and the rename form (the accelerator paths: the
 * menu stays beneath), the shop (the greet-then-shop open), and a menu shown by a click that no sync
 * has seen, are all closed, and `stack` is the bare world IMMEDIATELY after `onReconnect` returns.
 * Frames opened at the world that hold no lock (help, box, heal) stay shown and on the stack. The
 * shop cannot be open together with the menu or a Social panel through any production path (an
 * accelerator pops to the base first, and a deferred shop open is refused while any frame is up),
 * so those arms are separate boots; the stack core takes the mixed stacks (contextStack.test.ts).
 * SO1.2: for each of the nine protected views the reset runs while the view is neither shown nor on
 * the stack. HONEST SCOPE per view: a `vi.spyOn(<View>.prototype, 'hide')` call-count delta is the
 * observation for all nine (a real never-settling-reducer lock cannot be observed from outside the
 * view for the flag-held ones, and the lock flag of the display-held ones is private); where the
 * view's `hide()` also clears a DOM line that a test can dirty from outside (the feedback line of
 * the trade wizard, rename, shop, trade and pvp), that line is dirtied first and read back; and for
 * rename and trade the view is shown through the real accelerator, forced hidden WITHOUT `hide()`,
 * popped off the stack by the mirror, and only then reconnected. SO1.3: the dialogue is never
 * hidden or dropped. SO1.4: a frame stamped over a battle goes with the reset, the stale status line
 * is cleared and a session terminal overlay is cleared by `applySession({ kind: 'connected' })`.
 *
 * Harness: main.controls.test.ts's pattern, copied (vi.resetModules + a fresh import per test,
 * recorded window/document listeners detached in afterEach, one controllable clock, a controllable
 * rAF, a stubbed wasm pkg and SDK connection, the real client/index.html shell mounted first). The
 * battle and conversation fixtures are main.controls.test.ts's; the greet-then-shop click is
 * main.dialogueDismiss.test.ts's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { ConnectionOptions } from './net/connection';
import type { StoreBattle, StoreBattleMonster } from './net/store';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first, with the exact argument object it received. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What the stubbed wasm `interact_candidates_coded` answers (the heal case installs a rule that
   *  names a heal pad). Reset by every boot. */
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgWalkingMock({ interact: (...args: unknown[]) => H.interact(...args) }),
);

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once.
vi.mock('./net/connection', () => connectionRecordingMock(H));

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

async function bootReady(): Promise<void> {
  await boot();
  opts.onReady(H.identity);
}

const EID = 7n;
const NPC_ENTITY = 11n;
const WILD_IDENTITY = '0'.repeat(64);
const BATTLE_ID = 101n;

/** Deliver one authoritative batch: the own player + character at (2, 6). */
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

/** An Ongoing battle row arrives in one batch at clock `t`. */
function putBattle(battleId: bigint, t: number): void {
  opts.store.upsertBattle(battleRow(battleId, 'Ongoing'));
  server(t);
}

/** The server opens a conversation with the NPC, in one batch. */
function startConversation(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: NPC_ENTITY,
    currentNodeId: 'start',
  });
  server(t);
}

/** The server ends the conversation, in one batch. */
function endConversation(t: number): void {
  opts.store.removeConversation(H.identity);
  server(t);
}

/** Click a greet-then-shop button, as the dialogue renders one (main.dialogueDismiss.test.ts). */
function clickShop(t: number, shopId = '1'): void {
  const button = document.createElement('button');
  button.dataset.shopId = shopId;
  const host =
    document.getElementById('dialogue-overlay') ?? document.getElementById('game-screen');
  if (host === null) throw new Error('the shell must ship #dialogue-overlay inside #game-screen');
  host.appendChild(button);
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
}

/** A tap: keydown at `t`, keyup 5 ms later (the keyboard source reads a second keydown of a code
 *  it holds as a lost keyup). */
function tap(code: string, t: number): void {
  clock.t = t;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t = t + 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** Let queued microtasks and zero-delay timers run. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Put `text` into a field the way a user does: set the value, then fire its input event. */
function typeInto(el: HTMLInputElement, text: string): void {
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The link comes back: the connection layer's reconnect callback, with the same identity. */
function reconnect(): void {
  opts.onReconnect(H.identity);
}

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
const helpShown = (): boolean => shownById('help-overlay');
const renameShown = (): boolean => shownById('rename-overlay');
const tradeShown = (): boolean => shownById('trade-overlay');
const pvpShown = (): boolean => shownById('pvp-challenge-overlay');
const rankingsShown = (): boolean => shownById('leaderboard-overlay');
const shopShown = (): boolean => shownById('shop-overlay');
const healShown = (): boolean => shownById('heal-overlay');
const questLogShown = (): boolean => shownById('quest-log-overlay');
const claimShown = (): boolean => shownById('claim-overlay');
const privacyShown = (): boolean => shownById('privacy-overlay');
const controlsShown = (): boolean => shownById('controls-overlay');
const dialogueShown = (): boolean => shownById('dialogue-overlay');
const boxShown = (): boolean => shownByTestId('box-title');
const raisingShown = (): boolean => shownByTestId('raising-title');
const battleShown = (): boolean => shownByTestId('battle-title');

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
  readonly overBattle?: string;
  readonly [key: string]: unknown;
}
interface GameHook {
  readonly stack: FrameJson[];
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
/** The raw stack, base first. The hook only READS it: no sync happens here. */
const stack = (): FrameJson[] => game().stack;
/** The stack as base-first names: the base kind, then each upper frame's overlay id. */
const stackNames = (): string[] =>
  stack().map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

const WORLD_ONLY: FrameJson[] = [{ kind: 'world' }];
const callsOf = (name: string): Array<{ name: string; args: unknown }> =>
  H.calls.filter((c) => c.name === name);

describe('main.ts reconnect closes through the stack (runtime, so-1)', { sequential: true }, () => {
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

  // ------------------------------------------------------------------------------------------
  // SO1.1: the sweep closes every frame the roster names, and the stack is the bare world at once
  // ------------------------------------------------------------------------------------------

  const MENU_OVER_CASES = [
    { tag: 'TRADE', key: 'KeyU', frameId: 'social', shown: tradeShown },
    { tag: 'PVP', key: 'KeyP', frameId: 'social', shown: pvpShown },
    { tag: 'RANKINGS', key: 'KeyL', frameId: 'social', shown: rankingsShown },
    { tag: 'RENAME', key: 'KeyN', frameId: 'renameView', shown: renameShown },
    { tag: 'BAG', key: 'KeyI', frameId: 'raisingView', shown: raisingShown },
  ] as const;

  it.each(
    MENU_OVER_CASES,
  )('SO1-1-BOOT-MENU-OVER-$tag: with the menu and the frame its accelerator opened over it both up, onReconnect hides both through their own views and the stack read at once, before any frame, key or batch, is the bare world', async ({
    key,
    frameId,
    shown,
  }) => {
    // WRONG IMPL KILLED: a reconnect that runs the closes but never assigns the swept stack back
    // (the views are hidden and `stack` still lists [menu, frame] until the next sync: the old
    // block hid the views directly but left their frames on the stack); one that sweeps only the
    // menu, or only the top frame; one that closes the menu but not the Social frame or the
    // panel under it (the Social frame closes through its three panels); one that keeps a frame
    // whose view it hid; and, for the Social cases, one that hides the panels but leaves the
    // chrome-hosting root of the panel the player opened.
    await bootReady();
    server(1000);
    tap(key, 1010);
    expect(shown(), 'precondition: the accelerator opened the frame').toBe(true);
    expect(menuShown(), 'precondition: the menu stays open beneath it').toBe(true);
    expect(stackNames(), 'precondition: the frame is on the stack').toContain(frameId);
    expect(stackNames(), 'precondition: so is the menu').toContain('menuView');

    reconnect();

    expect(stack(), 'the stack, read at once, is the bare world').toEqual(WORLD_ONLY);
    expect(shown(), 'the frame is hidden').toBe(false);
    expect(menuShown(), 'and so is the menu').toBe(false);
  });

  it('SO1-1-BOOT-SHOP: a shop opened by the greet-then-shop click is hidden by onReconnect, and the stack read at once is the bare world', async () => {
    // WRONG IMPL KILLED: a sweep whose roster lacks the shop row (the stack would keep a frame the
    // old block hid but left listed), a reconnect that hides the shop but leaves the
    // frame, one that skips the close because the view was opened by a deferred open rather than a
    // key, and one that hides only what the menu opened.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    clickShop(1100);
    endConversation(1200);
    frame(1210);
    expect(shopShown(), 'precondition: the shop opened when the conversation ended').toBe(true);
    expect(stack(), 'precondition: the shop is the one frame over the world').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'shopView' },
    ]);

    reconnect();

    expect(stack(), 'the stack, read at once, is the bare world').toEqual(WORLD_ONLY);
    expect(shopShown(), 'the shop is hidden').toBe(false);
  });

  it('SO1-1-BOOT-CLICK-OPENED-RENAME: a rename form opened by clicking the menu`s Profile then Name rows, which no stack sync has mirrored yet, is closed by onReconnect with the menu, and the stack read at once is the bare world', async () => {
    // HONEST SCOPE. The only real show paths that leave a closing-set view off the stack are the
    // menu-row clicks: `handleMenuPointer` -> `applyMenuStep` -> `openMenuTarget('renameView')`
    // -> `openRename()` shows the form and no sync follows (the next key, frame or batch mirrors
    // it). Every other show path syncs: the launcher click and the key and pointer wrappers sync on
    // both sides, the accelerators and `seatOpened` sync, and a batch's last listener syncs.
    // `menuView` is the only closing-set view the unconditional reset pass does not also hide, and
    // it is always shown through a synced path, so the in-reconnect `syncStack()` is DEFENSIVE:
    // this case does not discriminate an implementation that omits it (the reset pass hides the
    // form either way). It guards the end state of the one real unsynced show.
    // WRONG IMPL KILLED: a reconnect that leaves the click-opened form shown or on the stack, one
    // that sweeps the frames the stack lists (the menu) but forgets the form the stack cannot yet
    // list, and one whose stack read is stale (the menu frame still listed). The precondition pins
    // the shape: the form is shown while the stack does not list it.
    await bootReady();
    server(1000);
    const launcher = document.querySelector('[data-menu-launcher]');
    if (launcher === null) throw new Error('[data-menu-launcher] is not in the shell');
    clock.t = 1100;
    launcher.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(menuShown(), 'precondition: the launcher click opened the menu').toBe(true);
    const clickRow = (key: string, t: number): void => {
      const row = document.querySelector(`#menu-rows [data-nav-key="${key}"]`);
      if (row === null) throw new Error(`no menu row [data-nav-key="${key}"]`);
      clock.t = t;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    clickRow('profile', 1200);
    clickRow('name', 1300);
    expect(renameShown(), 'precondition: the Name row opened the rename form').toBe(true);
    // so-2 (named intentional change): push-then-show lists the click-opened form at once
    // (SO2.1/SO2.4); was: not yet mirrored
    expect(stackNames(), 'precondition: push-then-show listed the form at once').toContain(
      'renameView',
    );

    reconnect();

    expect(renameShown(), 'the form is closed by the reconnect').toBe(false);
    expect(menuShown(), 'and so is the menu').toBe(false);
    expect(stack(), 'the stack, read at once, is the bare world').toEqual(WORLD_ONLY);
    frame(1400);
    expect(renameShown(), 'a frame afterwards does not bring the form back').toBe(false);
    expect(stack()).toEqual(WORLD_ONLY);
  });

  it('SO1-1-BOOT-SURVIVE-HELP: help opened at the world is still shown and still on the stack right after onReconnect, and after the next batch', async () => {
    // WRONG IMPL KILLED: a sweep that closes every upper frame (help reads no store state, holds no
    // lock and has always survived a drop: CTL6C-1 pins it), one whose roster has the help row
    // true, and one that closes it and leaves the frame (or keeps the frame and hides the view).
    await bootReady();
    server(1000);
    tap('KeyR', 1010);
    expect(helpShown(), 'precondition: Select opened help at the world').toBe(true);
    const helpOverWorld: FrameJson[] = [{ kind: 'world' }, { kind: 'screen', id: 'helpView' }];
    expect(stack(), 'precondition: help over the world, unstamped').toEqual(helpOverWorld);

    reconnect();

    expect(helpShown(), 'help is still shown').toBe(true);
    expect(stack(), 'and still on the stack, read at once').toEqual(helpOverWorld);
    opts.onHydrated();
    server(1100);
    await flush();
    expect(helpShown(), 'after the next batch it is still shown').toBe(true);
    expect(stack(), 'and still on the stack').toEqual(helpOverWorld);
  });

  it('SO1-1-BOOT-SURVIVE-BOX: the box opened at the world (over the menu) is still shown and on the stack right after onReconnect while the menu beneath it is closed', async () => {
    // WRONG IMPL KILLED: a sweep that clears every upper frame, or one that truncates the stack at
    // the first closing frame (the menu is the box's neighbour BELOW it: the accelerator opens the
    // box over the menu), a roster with the box row true, and a sweep that closes the menu but
    // reorders or loses the box.
    await bootReady();
    server(1000);
    tap('KeyB', 1010);
    expect(boxShown(), 'precondition: the accelerator opened the box').toBe(true);
    expect(stackNames(), 'precondition: the box is over the menu').toEqual([
      'world',
      'menuView',
      'boxView',
    ]);

    reconnect();

    expect(menuShown(), 'the menu beneath the box is closed').toBe(false);
    expect(boxShown(), 'the box is still shown').toBe(true);
    expect(stack(), 'and is the one frame left on the stack, read at once').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'boxView' },
    ]);
  });

  it('SO1-1-BOOT-SURVIVE-HEAL: the heal frame opened at a healer is still shown and on the stack right after onReconnect', async () => {
    // WRONG IMPL KILLED: a roster with the heal row true or a sweep that clears every upper frame
    // (CTL7D-1 pins the heal frame surviving a drop; it reads no store state a reset invalidates
    // that the next batch does not re-render).
    await bootReady();
    server(1000);
    H.interact = (...args: unknown[]) => {
      const entities = args[4] as ReadonlyArray<{ kind: string; id: string }>;
      const at = entities.findIndex((e) => e.kind === 'heal' && e.id === '7');
      return at === -1 ? [] : [at];
    };
    opts.store.upsertHealLocation({
      locationId: 7,
      zoneId: 0,
      tileX: 3,
      tileY: 6,
      costQty: 0,
      cooldownMs: 0,
      costCurrency: 0n,
    });
    server(1010);
    tap('Enter', 1020);
    expect(healShown(), 'precondition: A at the healer opened the heal frame').toBe(true);
    const healOverWorld: FrameJson[] = [{ kind: 'world' }, { kind: 'screen', id: 'healView' }];
    expect(stack(), 'precondition: the heal frame over the world').toEqual(healOverWorld);

    reconnect();

    expect(healShown(), 'the heal frame is still shown').toBe(true);
    expect(stack(), 'and still on the stack, read at once').toEqual(healOverWorld);
  });

  // The frames below are opened at the world by their real paths and hold no lock and read no
  // store state a drop invalidates: they stay in the roster's false rows, and they must stay OUT of
  // the unconditional reset pass too (a reset-pass `hide()` is as fatal to them as a sweep close).

  /** Click the launcher, then each menu row in turn (the pointer path, `handleMenuPointer`). */
  const openByMenuClicks = (rows: readonly string[], t0: number): void => {
    const launcher = document.querySelector('[data-menu-launcher]');
    if (launcher === null) throw new Error('[data-menu-launcher] is not in the shell');
    clock.t = t0;
    launcher.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    rows.forEach((key, i) => {
      const row = document.querySelector(`#menu-rows [data-nav-key="${key}"]`);
      if (row === null) throw new Error(`no menu row [data-nav-key="${key}"]`);
      clock.t = t0 + 100 * (i + 1);
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  it('SO1-1-BOOT-SURVIVE-QUESTLOG: the quest log opened by its accelerator is still shown and on the stack right after onReconnect while the menu beneath it is closed', async () => {
    // WRONG IMPL KILLED: a roster with the quest log row true, a sweep that clears every upper
    // frame, and a quest log added to the unconditional reset pass (RECONNECT_RESETS): the journal
    // reads no store state a drop invalidates beyond what the next batch re-renders, and has always
    // survived a drop, so a reset-pass hide would close it.
    await bootReady();
    server(1000);
    tap('KeyJ', 1010);
    expect(questLogShown(), 'precondition: the accelerator opened the journal').toBe(true);
    expect(stackNames(), 'precondition: the journal is over the menu').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);

    reconnect();

    expect(menuShown(), 'the menu beneath it is closed').toBe(false);
    expect(questLogShown(), 'the journal is still shown').toBe(true);
    expect(stack(), 'and is the one frame left on the stack, read at once').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'questLogView' },
    ]);
  });

  it('SO1-1-BOOT-SURVIVE-CLAIM: the claim view opened by its accelerator is still shown and on the stack right after onReconnect while the menu beneath it is closed', async () => {
    // WRONG IMPL KILLED: a roster with the claim row true, a sweep that clears every upper frame,
    // and the claim view added to the reset pass (the view is only ever hidden by the player or by
    // its own lifecycle).
    await bootReady();
    server(1000);
    tap('KeyC', 1010);
    expect(claimShown(), 'precondition: the accelerator opened the claim view').toBe(true);
    expect(stackNames(), 'precondition: the claim view is over the menu').toEqual([
      'world',
      'menuView',
      'claimView',
    ]);

    reconnect();

    expect(menuShown(), 'the menu beneath it is closed').toBe(false);
    expect(claimShown(), 'the claim view is still shown').toBe(true);
    expect(stack(), 'and is the one frame left on the stack, read at once').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'claimView' },
    ]);
  });

  it('SO1-1-BOOT-SURVIVE-CLAIM-PENDING: a claim prompt the connection layer just opened (onClaimPending, which fires right before onReconnect and shows the view with no stack sync) is still shown and listed on the stack right after onReconnect', async () => {
    // WRONG IMPL KILLED: the claim view added to the reset pass (it would close a claim prompt that
    // was opened a moment before, in the same reconnect: the player loses the prompt and the code
    // stays retained behind a veto); a roster with the claim row true; and a reconnect that sweeps
    // the stack as it stands without a sync first (the prompt is shown but the stack cannot yet
    // list it, so the read at once would be the bare world over a shown overlay).
    await bootReady();
    server(1000);
    const onClaimPending = opts.onClaimPending;
    if (onClaimPending === undefined) throw new Error('onClaimPending was not wired by main.ts');
    onClaimPending('claim-code');
    expect(claimShown(), 'precondition: the claim prompt is shown').toBe(true);
    // so-2 (named intentional change): push-then-show lists the claim prompt at once (SO2.1/SO2.4);
    // was: not yet mirrored
    expect(stackNames(), 'precondition: push-then-show listed it at once').toEqual([
      'world',
      'claimView',
    ]);

    reconnect();

    expect(claimShown(), 'the claim prompt is still shown').toBe(true);
    expect(stack(), 'and listed on the stack, read at once').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'claimView' },
    ]);
  });

  it('SO1-1-BOOT-SURVIVE-PRIVACY: the privacy surface opened from the menu (its row click, which no stack sync follows) is still shown and on the stack right after onReconnect while the menu beneath it is closed', async () => {
    // WRONG IMPL KILLED: a roster with the privacy row true, a sweep that clears every upper frame,
    // the privacy view added to the reset pass (its hide() runs onDismissed and disarms an armed
    // delete confirmation: a reconnect must not close a surface the player is reading), and a
    // reconnect that does not sync first (the surface is shown but not yet listed).
    await bootReady();
    server(1000);
    openByMenuClicks(['profile', 'privacy'], 1100);
    expect(privacyShown(), 'precondition: the Privacy row opened the surface').toBe(true);
    expect(menuShown(), 'precondition: the menu stays open beneath it').toBe(true);

    reconnect();

    expect(menuShown(), 'the menu beneath it is closed').toBe(false);
    expect(privacyShown(), 'the privacy surface is still shown').toBe(true);
    expect(stack(), 'and is the one frame left on the stack, read at once').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'privacyView' },
    ]);
  });

  it('SO1-1-BOOT-SURVIVE-CONTROLS: Options > Controls opened from the menu is still shown and on the stack right after onReconnect while the menu beneath it is closed', async () => {
    // WRONG IMPL KILLED: a roster with the controls row true, a sweep that clears every upper
    // frame, and the controls view added to the reset pass (its hide() ends a key capture in
    // progress; a reconnect must not eat the screen the player is remapping on).
    await bootReady();
    server(1000);
    openByMenuClicks(['options', 'controls'], 1100);
    expect(controlsShown(), 'precondition: the Controls row opened the screen').toBe(true);
    expect(stackNames(), 'precondition: the screen is over the menu').toEqual([
      'world',
      'menuView',
      'controlsView',
    ]);

    reconnect();

    expect(menuShown(), 'the menu beneath it is closed').toBe(false);
    expect(controlsShown(), 'the controls screen is still shown').toBe(true);
    expect(stack(), 'and is the one frame left on the stack, read at once').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'controlsView' },
    ]);
  });

  // The held-key reset (`inputRouter.resetRepeat()` when the sweep drops a frame) has no cheap
  // observation here: the router's auto-repeat state is private, and after the menu closes no nav
  // frame is left for a stale repeat to move unless another nav screen sits beneath it, a shape
  // the production open paths do not produce (the menu opens over the base or over a frame it
  // opened itself). It is left to the router's own unit suite.

  // ------------------------------------------------------------------------------------------
  // SO1.2: every protected view's reset runs, whatever the stack and the visibility
  // ------------------------------------------------------------------------------------------

  /** A view class as the spy needs it: its prototype's `hide`. */
  interface HideHost {
    readonly prototype: { hide: () => void };
  }
  interface ProtectedView {
    readonly id: string;
    readonly load: () => Promise<HideHost>;
    /** The id of a DOM line the view's `hide()` clears and a test can dirty from outside. */
    readonly stale?: string;
  }
  const PROTECTED_VIEWS: readonly ProtectedView[] = [
    {
      id: 'tradeProposeView',
      load: async () => (await import('./ui/tradeProposeView')).TradeProposeView,
      stale: 'tradepropose-feedback',
    },
    {
      id: 'renameView',
      load: async () => (await import('./ui/renameView')).RenameView,
      stale: 'rename-feedback',
    },
    {
      id: 'shopView',
      load: async () => (await import('./ui/shopView')).ShopView,
      stale: 'shop-feedback',
    },
    {
      id: 'tradeView',
      load: async () => (await import('./ui/tradeView')).TradeView,
      stale: 'trade-feedback',
    },
    {
      id: 'pvpView',
      load: async () => (await import('./ui/pvpView')).PvpView,
      stale: 'pvp-challenge-feedback',
    },
    { id: 'battleView', load: async () => (await import('./ui/battleView')).BattleView },
    { id: 'raisingView', load: async () => (await import('./ui/raisingView')).RaisingView },
    { id: 'evolutionView', load: async () => (await import('./ui/evolutionView')).EvolutionView },
    {
      id: 'leaderboardView',
      load: async () => (await import('./ui/leaderboardView')).LeaderboardView,
    },
  ];

  it.each(
    PROTECTED_VIEWS,
  )('SO1-2-BOOT-RESET-$id: onReconnect runs the view`s hide() (its lock and stale state reset) although nothing is open and the stack is the bare world', async ({
    load,
    stale,
  }) => {
    // Observation: a spy on the view class's prototype `hide` (call-count delta >= 1); for the
    // views that have one (trade wizard, rename, shop, trade, pvp) also a stale feedback line
    // written into the view's DOM before the reconnect and read back after it.
    // WRONG IMPL KILLED: a stack-driven close that is the ONLY reset (the view is neither shown
    // nor on the stack, so its frame never closes: the in-flight lock a dropped link never
    // settles would stay held forever, a dead button), a reset loop guarded by the view's
    // visibility probe, a roster of fewer than the nine protected views (each id here is its own
    // case, so a short roster fails exactly the id it leaves out), and a reset wired to a
    // sibling's view (`raisingView: () => boxView?.hide()`: the named view's own hide must run).
    await bootReady();
    server(1000);
    const host = await load();
    const hide = vi.spyOn(host.prototype, 'hide');
    expect(stackNames(), 'precondition: nothing is open: the bare world').toEqual(['world']);
    let line: HTMLElement | null = null;
    if (stale !== undefined) {
      line = byId(stale);
      line.textContent = 'stale line from before the drop';
      expect(line.textContent, 'precondition: the stale line is on screen').not.toBe('');
    }
    const before = hide.mock.calls.length;

    reconnect();

    expect(
      hide.mock.calls.length - before,
      'the view`s hide() ran at least once on the reconnect',
    ).toBeGreaterThanOrEqual(1);
    if (line !== null) expect(line.textContent, 'and cleared its stale line').toBe('');
    expect(stack(), 'the stack is still the bare world').toEqual(WORLD_ONLY);
  });

  it('SO1-2-BOOT-OFFSTACK-RENAME: a rename form with a half-typed draft and a stale line, forced hidden without hide() and popped off the stack by the mirror, is still reset by onReconnect', async () => {
    // WRONG IMPL KILLED: the naive "close only what the stack holds": the rename frame is gone from
    // the stack (the mirror popped it when the overlay was hidden behind the view's back) and the
    // view is not shown, so only the unconditional reset can clear the draft and the line the next
    // open would otherwise show; a reset that runs only for a visible view.
    await bootReady();
    server(1000);
    tap('KeyN', 1010);
    expect(renameShown(), 'precondition: the accelerator opened the rename form').toBe(true);
    const input = byId('rename-input') as HTMLInputElement;
    typeInto(input, 'half-typed draft');
    const line = byId('rename-feedback');
    line.textContent = 'stale line from before the drop';
    byId('rename-overlay').style.display = 'none';
    frame(1100);
    expect(stackNames(), 'precondition: the mirror popped the form, the menu stays').toEqual([
      'world',
      'menuView',
    ]);
    expect(input.value, 'precondition: the draft is still in the field').toBe('half-typed draft');

    reconnect();

    expect(input.value, 'the stale draft is cleared').toBe('');
    expect(line.textContent, 'and the stale line').toBe('');
    expect(menuShown(), 'the menu beneath it is closed by the sweep').toBe(false);
    expect(stack(), 'the stack is the bare world').toEqual(WORLD_ONLY);
  });

  it('SO1-2-BOOT-OFFSTACK-TRADE: a trade panel with a stale line, forced hidden without hide() and popped off the stack by the mirror, is still reset by onReconnect', async () => {
    // WRONG IMPL KILLED: as the rename case, for a Social panel: the Social frame is gone from the
    // stack and no panel is shown, so a close driven only by the stack never reaches the trade
    // view whose double-send lock and feedback line the reset clears.
    await bootReady();
    server(1000);
    tap('KeyU', 1010);
    expect(tradeShown(), 'precondition: the accelerator opened the trade panel').toBe(true);
    const line = byId('trade-feedback');
    line.textContent = 'stale line from before the drop';
    byId('trade-overlay').style.display = 'none';
    frame(1100);
    expect(stackNames(), 'precondition: the mirror popped Social, the menu stays').toEqual([
      'world',
      'menuView',
    ]);

    reconnect();

    expect(line.textContent, 'the stale line is cleared').toBe('');
    expect(menuShown(), 'the menu beneath it is closed by the sweep').toBe(false);
    expect(stack(), 'the stack is the bare world').toEqual(WORLD_ONLY);
  });

  // ------------------------------------------------------------------------------------------
  // SO1.3: a server conversation is never hidden or dropped by a reconnect
  // ------------------------------------------------------------------------------------------

  it('SO1-3-BOOT-WORLD: with a conversation row up, onReconnect leaves the dialogue shown and its frame on the stack, sends no dismiss, and the next batch keeps both', async () => {
    // WRONG IMPL KILLED: a roster with the dialogue row true whose close is a silent no-op (the
    // dialogue handle is the one undefined entry): the frame is popped while the conversation row
    // and the shown dialogue stay, so the stack and the screen disagree; a reconnect that hides the
    // dialogue; one that dismisses the conversation (the server's row deletion ends it, never the
    // client).
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    expect(dialogueShown(), 'precondition: the server opened the dialogue').toBe(true);
    const dialogueOverWorld: FrameJson[] = [
      { kind: 'world' },
      { kind: 'screen', id: 'dialogueView' },
    ];
    expect(stack(), 'precondition: the dialogue is the one frame').toEqual(dialogueOverWorld);

    reconnect();

    expect(dialogueShown(), 'the dialogue is still shown').toBe(true);
    expect(stack(), 'and its frame is still on the stack, read at once').toEqual(dialogueOverWorld);
    expect(callsOf('dismissDialogue'), 'nothing ended the conversation').toEqual([]);
    opts.onHydrated();
    server(1100);
    await flush();
    expect(dialogueShown(), 'after the next batch it is still shown').toBe(true);
    expect(stack(), 'and still on the stack').toEqual(dialogueOverWorld);
  });

  it('SO1-3-BOOT-SUSPENDED: a dialogue suspended under a battle stays shown and on the stack across onReconnect', async () => {
    // WRONG IMPL KILLED: a sweep that drops the frames under a battle base wholesale, or one that
    // reads the suspended dialogue as one of the frames a battle owns.
    await bootReady();
    seedWorld(1000);
    startConversation(1010);
    putBattle(BATTLE_ID, 1100);
    expect(battleShown(), 'precondition: the battle is on screen').toBe(true);
    expect(dialogueShown(), 'precondition: the dialogue is suspended beneath it').toBe(true);
    expect(stackNames(), 'precondition: the dialogue sits under the battle base').toEqual([
      'battle',
      'dialogueView',
    ]);

    reconnect();

    expect(dialogueShown(), 'the dialogue is still shown').toBe(true);
    expect(stackNames(), 'and still on the stack, read at once').toEqual([
      'battle',
      'dialogueView',
    ]);
    expect(callsOf('dismissDialogue'), 'nothing ended the conversation').toEqual([]);
  });

  it('SO1-3-BOOT-STAMPED: a dialogue that was first mirrored while a battle was already the base (so its frame is stamped overBattle) stays shown and on the stack, stamp intact, across onReconnect', async () => {
    // WRONG IMPL KILLED: a sweep whose stamped-screen clause runs BEFORE the dialogue exception:
    // it would pop the stamped dialogue frame (no close command can name it) while the dialogue,
    // whose row the server owns, stays on screen; and a reconnect that rewrites the stamp.
    await bootReady();
    seedWorld(1000);
    putBattle(BATTLE_ID, 1100);
    frame(1110);
    startConversation(1200);
    frame(1210);
    expect(dialogueShown(), 'precondition: the dialogue is shown over the battle').toBe(true);
    expect(stackNames(), 'precondition: the dialogue frame is above the battle base').toEqual([
      'battle',
      'dialogueView',
    ]);
    expect(
      stack()[1]?.overBattle,
      'precondition: the frame was mirrored while the battle was the base: stamped',
    ).toBe('101');

    reconnect();

    expect(dialogueShown(), 'the dialogue is still shown').toBe(true);
    expect(stackNames(), 'and its frame is still on the stack, read at once').toEqual([
      'battle',
      'dialogueView',
    ]);
    expect(stack()[1]?.overBattle, 'stamp intact').toBe('101');
    expect(callsOf('dismissDialogue'), 'nothing ended the conversation').toEqual([]);
  });

  // ------------------------------------------------------------------------------------------
  // SO1.4: the block's other guarantees survive (the reseed and i18n suites guard the rest)
  // ------------------------------------------------------------------------------------------

  it('SO1-4-BOOT-STAMPED: help opened over a battle (stamped, and not in the closing roster) goes with the reset, the stack read at once holds no upper frame, and the re-delivered battle shows with no frame left over it', async () => {
    // WRONG IMPL KILLED: a sweep with no overBattle clause (help is not in the roster, so it would
    // survive the drop: the re-delivered row keeps a stamped battleSafe frame and the battle shows
    // beneath an inert, still-listed help: the CTL6C-1 hazard), a stamped loop that was dropped
    // with the old `for` it replaces, and a stack left stale (the old loop hid help but never
    // removed its frame).
    await bootReady();
    server(1000);
    putBattle(BATTLE_ID, 1100);
    await flush();
    tap('KeyR', 1200);
    await flush();
    expect(helpShown(), 'precondition: Select opened help over the battle').toBe(true);
    expect(stack(), 'precondition: help is stamped with the battle').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'helpView', overBattle: '101' },
    ]);

    opts.store.reset(); // the drop edge
    reconnect();

    expect(helpShown(), 'help opened over the battle is closed').toBe(false);
    // The reconnect syncs the stack before it sweeps, and the store was just reset (the drop
    // edge): the battle row is gone, so the base is re-derived as the world. What this pins is that
    // no upper frame is left, read at once (a battle base here would only be a stale stack).
    expect(stack(), 'the stack, read at once, is the bare world: no frame left').toEqual(
      WORLD_ONLY,
    );
    expect(battleShown(), 'the battle overlay is reset until the row is re-delivered').toBe(false);

    opts.onHydrated();
    opts.store.upsertBattle(battleRow(BATTLE_ID, 'Ongoing'));
    server(1300);
    await flush();
    expect(battleShown(), 'the re-delivered battle shows').toBe(true);
    expect(helpShown(), 'with no help left over it').toBe(false);
    expect(stack(), 'and the stack is the bare battle base').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
  });

  it('SO1-4-BOOT-STATUS: onReconnect clears the stale connection-lost status line', async () => {
    // WRONG IMPL KILLED: a rewritten block that drops the clearStatus() call (the frozen-link line
    // would stay on screen after the link is back), or clears it before something rewrites it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await bootReady();
    server(1000);
    const onError = opts.onError;
    if (onError === undefined) throw new Error('onError was not wired by main.ts');
    onError('link', 'connection lost');
    const status = byId('status');
    expect(status.textContent, 'precondition: the link error is on the status line').not.toBe('');

    reconnect();

    expect(status.textContent, 'the status line is cleared').toBe('');
  });

  it('SO1-4-BOOT-SESSION: a session terminal overlay shown by an expired session is cleared by the connected event onReconnect applies', async () => {
    // WRONG IMPL KILLED: a rewritten block that drops applySession({ kind: 'connected' }) (the
    // session gate overlay would stay up over a live connection), or applies it before the overlay
    // is shown.
    await bootReady();
    server(1000);
    const expire = opts.onSessionExpired;
    if (expire === undefined) throw new Error('onSessionExpired was not wired by main.ts');
    expire();
    const overlay = byId('session-overlay');
    expect(overlay.style.display, 'precondition: the session terminal is shown').toBe('block');

    reconnect();

    expect(overlay.style.display, 'the session overlay is cleared').toBe('none');
  });
});
