// @vitest-environment happy-dom
/**
 * main.reconnectStack.test.ts: a reconnect closes its frames through the context stack (so-1,
 * SO1.1 to SO1.4), and keeps the unconditional view-state resets. uif-16b: the rename form, the
 * claim view and the privacy surface are the three sections of ONE Profile frame (`profileView`),
 * which a reconnect closes (rename's roster row wins); a claim lifecycle raised in the same cycle
 * re-opens it on Account after the sweep (the UIF16B.6 cases).
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
import type { StoreBattle, StoreBattleMonster, StoreMonsterPub } from './net/store';

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

// bt-17 (named fixture change, BT17.1): the 1v1 view is purged, so a battle the player can SEE is a
// tactical one (`putBattle` seeds a Deploying row; the deploy panel is the shown owner). Its slot
// count is read through the lazily bound tactics rules port, which refuses a pkg missing any of its
// exports: main.dispatch.test.ts's minimal shapes (three spawn cells, max_pack 3).
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
  tactics_plan: (start: unknown, entries: readonly unknown[]) => ({
    Ok: { costs: entries.map(() => 0), total: 0, remaining: start, guard_on_end: false },
  }),
  tactics_overlays: () => ({
    reach1: [],
    reach2: [],
    range: [],
    aoe: [],
    danger: [],
    shield: [],
    intents: [],
  }),
  tactics_tuning: () => ({ surge_start_round: 11, wild_round_cap: 37, max_pack: 3 }),
  tactics_next_initiative: () => [],
}));

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
      ackedSeq: BigInt(H.sends.length),
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
      ackedSeq: 0n,
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

/** An Ongoing battle row arrives in one batch at clock `t`.
 *  bt-17 (named fixture change, BT17.1): with the own party monster and a `Deploying` tactical row
 *  (main.dispatch.test.ts's field set), as the server now delivers a battle: an anchor with no
 *  tactical row shows no battle view after the purge, and the callers assert the battle on screen. */
function putBattle(battleId: bigint, t: number): void {
  const row = battleRow(battleId, 'Ongoing');
  row.partyMonsterIds.forEach((monsterId, partySlot) => {
    opts.store.upsertMonster({
      monsterId,
      ownerIdentity: H.identity,
      speciesId: 1,
      nickname: `m${monsterId}`,
      level: 5,
      xp: 0,
      currentHp: 20,
      statHp: 20,
      statAttack: 5,
      statDefense: 5,
      statSpeed: 5,
      statSpAttack: 5,
      statSpDefense: 5,
      partySlot,
      tier: 0,
      essence: {} as StoreMonsterPub['essence'],
      trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
      qualityTimeTier: 0,
      nutritionPct: 0,
      lastCareAtMs: 0n,
    });
  });
  opts.store.upsertBattle(row);
  opts.store.reconcileTacticalBattlesFromView([
    {
      battleId,
      kind: 'Wild',
      format: 1,
      mapId: 13,
      contentVersion: 1,
      phase: 'Deploying',
      round: 0,
      initiative: [],
      turnIdx: 0,
      turnState: { kind: 'NotActive' },
      tiePrioritySide: 'A',
      pendingPadMs: 0,
      attackDamageDealtA: 0,
      attackDamageDealtB: 0,
    },
  ]);
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
// bt-17 (named fixture change): the battle roots are lazy (several may exist, hidden), so "a battle
// is shown" is "some battle-title in the document is displayed", no longer the first one.
const battleShown = (): boolean =>
  [...document.querySelectorAll('[data-testid="battle-title"]')].some(isShown);

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
    // uif-16b (named intentional change): KeyN opens the one Profile frame (`profileView`, whose
    // RECONNECT_CLOSES row is rename's `true`); the Name section is shown inside it. Was: renameView.
    { tag: 'RENAME', key: 'KeyN', frameId: 'profileView', shown: renameShown },
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
    // uif-16b (named intentional change): Profile is a root leaf (no Name row beneath it), so ONE
    // click on the Profile row opens the one Profile frame, the Name section inside it. Was: the
    // Profile row, then the Name row, opened `renameView`.
    clickRow('profile', 1200);
    expect(renameShown(), 'precondition: the Profile row opened the frame, Name inside').toBe(true);
    // so-2 (named intentional change): push-then-show lists the click-opened form at once
    // (SO2.1/SO2.4); was: not yet mirrored
    expect(stackNames(), 'precondition: push-then-show listed the form at once').toContain(
      'profileView',
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

  // uif-16b (named intentional change): SO1-1-BOOT-SURVIVE-CLAIM, -SURVIVE-CLAIM-PENDING and
  // -SURVIVE-PRIVACY are REPLACED by the four UIF16B.6 cases below. The Account and Privacy
  // surfaces are sections of the ONE Profile frame, whose RECONNECT_CLOSES row is rename's `true`
  // (the strictest of the three wins), so a reconnect now CLOSES them; a claim lifecycle the same
  // reconnect cycle raised re-opens Profile on Account after the sweep instead of surviving it.
  // Was: claimView and privacyView were frames of their own whose rows were `false`.

  /** The three Profile sections and the frame root, shown or not, in one read. */
  const profileShown = (): Record<string, boolean> => ({
    frame: shownById('profile-overlay'),
    name: renameShown(),
    account: claimShown(),
    privacy: privacyShown(),
  });
  const ALL_SHOWN = { frame: true, name: true, account: true, privacy: true };
  const ALL_HIDDEN = { frame: false, name: false, account: false, privacy: false };

  it('UIF16B.6 Profile opened by KeyC (on Account, over the menu) or by the menu`s Profile row click is closed by onReconnect, all three sections with it, and the stack read at once is the bare world; a reconnect that raised no claim event re-opens nothing', async () => {
    // WRONG IMPL KILLED: a roster that kept claim's `false` for the merged frame (Profile survives
    // the drop with a draft or an armed confirm behind it); a sweep that closes the frame but leaves
    // a section shown (a section hid alone, or never); a reconnect tail that re-opens Profile with
    // no claim event raised (the deferred claim paint flushed unconditionally: every reconnect would
    // throw the Account section at the player); and a click-opened frame missing the sweep.
    await bootReady();
    server(1000);
    tap('KeyC', 1010);
    expect(profileShown(), 'precondition: KeyC opened the whole frame').toEqual(ALL_SHOWN);
    expect(stackNames(), 'precondition: over the menu').toEqual([
      'world',
      'menuView',
      'profileView',
    ]);

    reconnect();

    expect(profileShown(), 'every section is closed with the frame').toEqual(ALL_HIDDEN);
    expect(menuShown(), 'and so is the menu').toBe(false);
    expect(stack(), 'the stack, read at once, is the bare world').toEqual(WORLD_ONLY);
    frame(1100);
    expect(profileShown(), 'a frame afterwards re-opens nothing').toEqual(ALL_HIDDEN);
    expect(stack()).toEqual(WORLD_ONLY);

    openByMenuClicks(['profile'], 1200);
    expect(profileShown(), 'precondition: the Profile row click opened the frame').toEqual(
      ALL_SHOWN,
    );
    reconnect();
    expect(profileShown(), 'the click-opened frame is closed too').toEqual(ALL_HIDDEN);
    expect(stack(), 'the bare world').toEqual(WORLD_ONLY);
  });

  it.each([
    { label: 'onClaimPending', raise: (o: ConnectionOptions) => o.onClaimPending?.('claim-code') },
    {
      label: 'onClaimAwaitingAccount',
      raise: (o: ConnectionOptions) => o.onClaimAwaitingAccount?.(),
    },
  ])('UIF16B.6 a reconnect cycle that raised $label BEFORE onReconnect (connection.ts order) leaves Profile open on Account AFTER onReconnect returns: the frame alone on the world, every section shown, focus inside the Account section', async ({
    label,
    raise,
  }) => {
    // The claim callback opens Profile on Account at once; `RECONNECT_CLOSES.profileView` is true,
    // so the reconnect's sweep closes it, and `onReconnect` re-shows it at its tail because its own
    // cycle raised a claim event.
    // WRONG IMPL KILLED: a reconnect tail that never re-shows it (the prompt the player was just
    // shown is swept away and the code stays retained behind a veto with no UI); a re-show that
    // opens Profile on Name (focus left in the field, the claim prompt unread); and a callback
    // main.ts never wired.
    await bootReady();
    server(1000);
    expect(
      label === 'onClaimPending' ? opts.onClaimPending : opts.onClaimAwaitingAccount,
      `${label} must be wired by main.ts`,
    ).toBeTypeOf('function');
    raise(opts);
    reconnect();

    expect(profileShown(), `${label}: Profile is open after the reconnect`).toEqual(ALL_SHOWN);
    expect(stack(), `${label}: the frame alone over the world, read at once`).toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'profileView' },
    ]);
    const focused = document.activeElement as HTMLButtonElement | null;
    expect(
      focused !== null && byId('claim-overlay').contains(focused),
      `${label}: focus is inside the Account section`,
    ).toBe(true);
    expect(focused?.tagName, `${label}: on an Account row`).toBe('BUTTON');
    expect(focused?.disabled, `${label}: an enabled one`).toBe(false);
    expect(isShown(focused as Element), `${label}: that is on screen`).toBe(true);
    await flush();
    expect(
      byId('claim-overlay').contains(document.activeElement),
      `${label}: the deferred Name anchor does not pull focus out of Account`,
    ).toBe(true);
  });

  it('UIF16B.6 a claim raised on the FIRST connect (onClaimPending, then onReady) opens Profile on Account; once the player closes it, a later reconnect that raises no claim event leaves the bare world with #profile-overlay hidden', async () => {
    // WRONG IMPL KILLED: an onReady that does not clear the "this cycle raised a claim" mark, so
    // every later reconnect re-pops Profile on Account uninvited (the first connect's claim stays
    // marked forever); and a reconnect tail that re-shows Profile whenever the claim phase is merely
    // visible rather than raised in its own cycle.
    await boot();
    const pending = opts.onClaimPending;
    if (pending === undefined) throw new Error('onClaimPending was not wired by main.ts');
    pending('CODE');
    opts.onReady(H.identity);
    server(1000);
    expect(profileShown(), 'precondition: the first connect`s claim opened Profile').toEqual(
      ALL_SHOWN,
    );
    expect(byId('claim-overlay').contains(document.activeElement), 'precondition: on Account').toBe(
      true,
    );

    tap('Escape', 1100);
    expect(stack(), 'precondition: Start closed Profile to the bare world').toEqual(WORLD_ONLY);
    expect(profileShown(), 'precondition: every section closed').toEqual(ALL_HIDDEN);

    reconnect();

    expect(stack(), 'a claim-less reconnect leaves the bare world').toEqual(WORLD_ONLY);
    expect(shownById('profile-overlay'), 'and #profile-overlay hidden').toBe(false);
    frame(1200);
    expect(stack(), 'a frame afterwards changes nothing').toEqual(WORLD_ONLY);
    expect(shownById('profile-overlay')).toBe(false);
  });

  it('UIF16B.6 a battle arriving with Profile open closes it: all three sections hidden, the stack back to the bare battle base, and an armed decline is disarmed by the close (its Yes and No are painted away)', async () => {
    // WRONG IMPL KILLED: a battle policy row for the merged frame that is not PLAYER_DROP (Profile
    // left over the battle, or suspended beneath it); a force-hide that hides a section but not the
    // frame (or the frame but not its sections); and a close that leaves the claim decline armed
    // behind the hidden frame (one column makes the armed Yes reachable from the Name field the next
    // time Profile opens: plan review RT-1).
    await bootReady();
    server(1000);
    tap('KeyC', 1010);
    expect(profileShown(), 'precondition: Profile is open').toEqual(ALL_SHOWN);
    const decline = byId('claim-decline-btn');
    expect(isShown(decline), 'precondition: Decline is offered').toBe(true);
    decline.click();
    expect(isShown(byId('claim-decline-cancel-btn')), 'precondition: the decline is armed').toBe(
      true,
    );

    putBattle(BATTLE_ID, 1100);

    expect(battleShown(), 'the battle is on screen').toBe(true);
    expect(profileShown(), 'Profile and every section are closed').toEqual(ALL_HIDDEN);
    expect(stack(), 'the stack is the bare battle base').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    expect(
      byId('claim-decline-confirm-btn').style.display,
      'the armed Yes is painted away by the close',
    ).toBe('none');
    expect(byId('claim-decline-cancel-btn').style.display, 'and its No').toBe('none');
    expect(byId('claim-confirm').textContent, 'no confirm prompt is left').toBe('');
  });

  it('UIF16B.6 SO1-2 for the merged frame: onReconnect runs ProfileView`s own hide() (the owning view, which clears the Name draft through its section) although nothing is open and the stack is the bare world', async () => {
    // uif-16b (named intentional change): the rename row of RECONNECT_RESETS becomes the owning
    // frame's hide (a section never hides alone). The RenameView row of PROTECTED_VIEWS above still
    // holds (the frame's hide hides every section); this pins that the reset goes through the frame.
    // WRONG IMPL KILLED: a reset row that still calls `renameView.hide()` directly (the frame's own
    // close, and with it the privacy and decline disarm, never runs on a drop with nothing open).
    await bootReady();
    server(1000);
    const { ProfileView } = await import('./ui/profileView');
    const hide = vi.spyOn(ProfileView.prototype, 'hide');
    expect(stackNames(), 'precondition: nothing is open: the bare world').toEqual(['world']);
    const before = hide.mock.calls.length;

    reconnect();

    expect(
      hide.mock.calls.length - before,
      'ProfileView.hide() ran on the reconnect',
    ).toBeGreaterThanOrEqual(1);
    expect(stack(), 'the stack is still the bare world').toEqual(WORLD_ONLY);
  });

  it('SO1-1-BOOT-SURVIVE-CONTROLS: Options > Controls opened from the menu is still shown and on the stack right after onReconnect while the menu beneath it is closed', async () => {
    // WRONG IMPL KILLED: a roster with the controls row true, a sweep that clears every upper
    // frame, and the controls view added to the reset pass (its hide() ends a key capture in
    // progress; a reconnect must not eat the screen the player is remapping on).
    await bootReady();
    server(1000);
    // uif-15c (named intentional change, UIF15C.1): Controls is a root row (the title keeps its old
    // "Options > Controls" wording), so one click on it opens the screen. Was: clicks on 'options'
    // then 'controls'.
    openByMenuClicks(['controls'], 1100);
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
  // INTENTIONAL CHANGE (uif-4b, UIF4B.5): the five views that had a stale feedback line to dirty
  // (`tradepropose-feedback`, `rename-feedback`, `shop-feedback`, `trade-feedback`,
  // `pvp-challenge-feedback`) own no message line any more (the lines are retired or unwritten; every
  // message is a toast), so their `stale` entries are gone: there is no view line for hide() to clear.
  // The reset itself (the `hide()` call-count delta) is still pinned for all of them. Was: each of the
  // five carried a `stale` id that was dirtied before the reconnect and read back '' after it.
  // ts-3 (named intentional change, the Strangler rename): the wizard's row becomes the session
  // editor's in the same slot (`tradeProposeView` -> `tradeSessionView`, ui/tradeSessionView.ts):
  // the editor is reset on every reconnect as the wizard was. Was: TradeProposeView.
  const PROTECTED_VIEWS: readonly ProtectedView[] = [
    {
      id: 'tradeSessionView',
      load: async () => (await import('./ui/tradeSessionView')).TradeSessionView,
    },
    {
      id: 'renameView',
      load: async () => (await import('./ui/renameView')).RenameView,
    },
    {
      id: 'shopView',
      load: async () => (await import('./ui/shopView')).ShopView,
    },
    {
      id: 'tradeView',
      load: async () => (await import('./ui/tradeView')).TradeView,
    },
    {
      id: 'pvpView',
      load: async () => (await import('./ui/pvpView')).PvpView,
    },
    // bt-17 (named removal, BT17.1/BT17.2): the `battleView` row (the eager 1v1 BattleView's hide()
    // run by the reset pass) is deleted with the module; the tactical battle roots are built on first
    // need, so no battle view exists to reset on a boot that never met a battle. The ledger
    // (memory/projects/monster-realm-bt-17-deletions.md) names its survivor. The roster is now eight.
    { id: 'raisingView', load: async () => (await import('./ui/raisingView')).RaisingView },
    { id: 'evolutionView', load: async () => (await import('./ui/evolutionView')).EvolutionView },
    {
      id: 'leaderboardView',
      load: async () => (await import('./ui/leaderboardView')).LeaderboardView,
    },
  ];

  it.each(
    PROTECTED_VIEWS,
  )('UIF4B.5 SO1-2-BOOT-RESET-$id: onReconnect runs the view`s hide() (its lock and stale state reset) although nothing is open and the stack is the bare world', async ({
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

  it('UIF4B.5 SO1-2-BOOT-OFFSTACK-RENAME: a rename form with a half-typed draft, forced hidden without hide() and popped off the stack by the mirror, is still reset by onReconnect, and the retired #rename-feedback line is not in the shell', async () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.5): the "stale line" half is dropped: `#rename-feedback` is
    // retired from index.html (every rename message is a toast), so there is no line to dirty or to
    // clear. Was: a stale line written into #rename-feedback was read back '' after the reconnect.
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
    expect(
      document.getElementById('rename-feedback'),
      'the retired line is not in the shell',
    ).toBeNull();
    // uif-16b (named intentional change): the root forced hidden is the owning frame's
    // `#profile-overlay` (the Name section is no frame of its own: hiding only it pops nothing).
    // Was: `#rename-overlay`.
    byId('profile-overlay').style.display = 'none';
    frame(1100);
    expect(stackNames(), 'precondition: the mirror popped the form, the menu stays').toEqual([
      'world',
      'menuView',
    ]);
    expect(input.value, 'precondition: the draft is still in the field').toBe('half-typed draft');

    reconnect();

    expect(input.value, 'the stale draft is cleared').toBe('');
    expect(menuShown(), 'the menu beneath it is closed by the sweep').toBe(false);
    expect(stack(), 'the stack is the bare world').toEqual(WORLD_ONLY);
  });

  it('UIF4B.5 SO1-2-BOOT-OFFSTACK-TRADE: a trade panel forced hidden without hide() and popped off the stack by the mirror is still reset by onReconnect (the view`s hide() runs), and the reset writes nothing into the residual #trade-feedback node', async () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.5): the view owns no feedback line, so "the stale line is
    // cleared" becomes "the view's hide() ran" (a spy delta) and "a sentinel in the residual node is
    // left alone" (nothing reads or clears it). Was: a stale line in #trade-feedback was read back ''.
    // WRONG IMPL KILLED: as the rename case, for a Social panel: the Social frame is gone from the
    // stack and no panel is shown, so a close driven only by the stack never reaches the trade
    // view whose double-send lock and feedback line the reset clears.
    await bootReady();
    server(1000);
    tap('KeyU', 1010);
    expect(tradeShown(), 'precondition: the accelerator opened the trade panel').toBe(true);
    const { TradeView } = await import('./ui/tradeView');
    const hide = vi.spyOn(TradeView.prototype, 'hide');
    const line = byId('trade-feedback');
    line.textContent = 'sentinel the view must leave alone';
    byId('trade-overlay').style.display = 'none';
    frame(1100);
    const before = hide.mock.calls.length;
    expect(stackNames(), 'precondition: the mirror popped Social, the menu stays').toEqual([
      'world',
      'menuView',
    ]);

    reconnect();

    expect(
      hide.mock.calls.length - before,
      'the trade view`s hide() ran on the reconnect',
    ).toBeGreaterThanOrEqual(1);
    expect(line.textContent, 'the residual node is neither read nor cleared').toBe(
      'sentinel the view must leave alone',
    );
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
    // bt-17 (orchestrator re-seed, disclosed): the re-delivered battle arrives as the server now
    // delivers one — with its Deploying tactical row — or no view would show.
    putBattle(BATTLE_ID, 1300);
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
