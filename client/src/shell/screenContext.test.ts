// @vitest-environment happy-dom
// shell/screenContext — what a screen adapter reads: the one motion preference, the five bindings
// the open paths set (the shop, the heal location, the Social tab, the Monsters tab, the trade
// session) and the context object every adapter is handed. A real boot of main.ts on the real
// index.html shell drives each open path, the reconnect, the join and the closed-session batch
// through the real views; the suite then reads the module back through `./screenContext` in the
// same module registry, so each flow is observed on the owner itself and never on a copy an adapter
// held. A second block imports the module on its own (no boot) and checks its owner functions, its
// live getters and what its import does.
// Harness: session.test.ts's pattern (vi.resetModules + a fresh import per boot, one controllable
// clock and rAF, a stubbed wasm pkg, SDK connection, telemetry and renderer). A `matchMedia` stub
// is installed before every import, so each query and change listener is counted.
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
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
} from '../../test-util/mainBootHarness';
import type { WasmMoveInput } from '../convert/convert';
import type { Bindings } from '../input/bindings';
import type { ConnectionOptions } from '../net/connection';
import type { AuthoritativeStore, StoreNpcRow, StoreTradeSession } from '../net/store';
import { REDUCED_MOTION_QUERY } from '../render/motionPreference';
import type { ScreenContext } from '../ui/screens/types';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
  /** The stubbed wasm interact rule: the indices of the marshalled entities A interacts with. */
  interact: ((..._args: unknown[]): unknown => []) as (...args: unknown[]) => unknown,
}));

// The 17 `tactics_*` exports the rules port binds (`bindTacticsRules` refuses a pkg missing any).
vi.mock('../../../client-wasm/pkg/client_wasm.js', () => ({
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
  tactics_tuning: () => ({ surge_start_round: 9, wild_round_cap: 30, autopass_forfeit: 4 }),
  tactics_next_initiative: () => [],
  tactics_deploy_slots: () => 3,
}));

vi.mock('../net/connection', () => connectionRecordingMock(H));

vi.mock('../observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('../observability/telemetry')>()),
);

vi.mock('../render/world', () => worldRendererMock());

type Owner = typeof import('./screenContext');
type Session = typeof import('./session');
type InputState = typeof import('./inputState');

// --- fixtures ----------------------------------------------------------------------------------
/** A second identity: the one a reconnect can mint. */
const IDENTITY_2 = 'cd'.repeat(32);
/** The faced player a Trade is opened with, and the entity of his character. */
const ZED = '12'.repeat(32);
const ZED_ENTITY = 31n;
const EID = 7n;
const GUIDE = 11n;
const HEALER_A = 21n;
const HEALER_B = 22n;
const SESSION = 95n;

const WORLD = { kind: 'world' } as const;
const screenFrame = (id: string): { kind: 'screen'; id: string } => ({ kind: 'screen', id });

type ChangeListener = (e: { readonly matches: boolean }) => void;

/** A `matchMedia` stand-in: ONE query object whose `.matches` stays at `initial` (the preference
 *  moves by its change event only), every query it is asked, and every listener added to it. */
function motionStub(initial: boolean) {
  const queries: string[] = [];
  const listeners: ChangeListener[] = [];
  const add = vi.fn((type: string, listener: ChangeListener): void => {
    if (type === 'change') listeners.push(listener);
  });
  const mql = {
    get matches(): boolean {
      return initial;
    },
    addEventListener: add,
  };
  const matchMedia = (query: string): typeof mql => {
    queries.push(query);
    return mql;
  };
  const fire = (matches: boolean): void => {
    for (const listener of listeners) listener({ matches });
  };
  return { matchMedia, queries, listeners, add, fire };
}
type MotionStub = ReturnType<typeof motionStub>;

/** Install `stub` as `window.matchMedia` and check it is what the page resolves (happy-dom ships
 *  a real one). */
function installMotion(stub: MotionStub): void {
  vi.stubGlobal('matchMedia', stub.matchMedia);
  expect(window.matchMedia, 'precondition: window.matchMedia is the stub').toBe(stub.matchMedia);
}

/** The five bindings on the owner, in a fixed order: shop, heal location, Social, Monsters, trade. */
const ownerFive = (o: Owner): unknown[] => [
  o.boundShopId,
  o.boundHealLocationId,
  o.boundSocialTab,
  o.boundMonstersTab,
  o.boundTradeSessionId,
];

/** The same five, as the context reads them. */
const ctxFive = (ctx: ScreenContext): unknown[] => [
  ctx.shopId,
  ctx.healLocationId,
  ctx.socialTab,
  ctx.monstersTab,
  ctx.tradeSessionId,
];

function expectFive(o: Owner, expected: readonly unknown[], label: string): void {
  expect(ownerFive(o), `${label}: the owner [shop, heal, Social, Monsters, trade]`).toEqual(
    expected,
  );
  expect(ctxFive(o.screenCtx), `${label}: the context reads the same five`).toEqual(expected);
}

const NONE = [null, null, null, null, null] as const;

/** The first entry of `list`, or a loud failure. */
function first<T>(list: readonly T[], what: string): T {
  const v = list[0];
  if (v === undefined) throw new Error(`${what}: nothing recorded`);
  return v;
}

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

type Adder = { addEventListener: EventTarget['addEventListener'] };

/** Record every listener added to `target`, undone by ASSIGNING the saved function back: on the
 *  global `window`, addEventListener is an own accessor, so restoring a property descriptor would
 *  leave the wrapper in place and wrappers would pile up across boots. */
function recordListeners(target: EventTarget): void {
  const hadOwn = Object.getOwnPropertyDescriptor(target, 'addEventListener') !== undefined;
  const previous = target.addEventListener;
  (target as Adder).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    recorded.push({ target, type, handler, options });
    previous.call(target, type, handler, options);
  };
  restorers.push(() => {
    if (hadOwn) (target as Adder).addEventListener = previous;
    else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
  });
}

let opts: ConnectionOptions;
/** The test clock: every frame, batch and press is at `T`, which only moves forward. */
let T = 1000;

/** Run one shell frame `ms` after the last instant. */
function advance(ms: number): void {
  T += ms;
  frame(T);
}

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  localStorage.clear();
  document.documentElement.style.removeProperty('--mr-text-step');
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
  vi.resetModules();
}

interface Booted {
  readonly sc: Owner;
  readonly s: Session;
  readonly input: InputState;
  readonly motion: MotionStub;
  /** The spy on every `onBatchApplied` registration of this registry's store class. */
  readonly onBatch: MockInstance<AuthoritativeStore['onBatchApplied']>;
}

/** Boot a fresh main.ts on the real shell up to the moment main() has opened the connection (no
 *  join yet), and answer the `./screenContext`, `./session` and `./inputState` modules it runs on. */
async function bootToConnect(initialMotion = false): Promise<Booted> {
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
  stubRaf();
  vi.resetModules();
  const motion = motionStub(initialMotion);
  installMotion(motion);
  // The store class main.ts builds its store from, so its batch-listener registrations are seen.
  const storeModule = await import('../net/store');
  const onBatch = vi.spyOn(storeModule.AuthoritativeStore.prototype, 'onBatchApplied');
  await import('../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  // Same registry, no reset: these are the module instances main.ts imported.
  const sc = await import('./screenContext');
  const s = await import('./session');
  const input = await import('./inputState');
  expect(s.store, 'precondition: the store main() handed to connect is the session module`s').toBe(
    opts.store,
  );
  return { sc, s, input, motion, onBatch };
}

/** Boot, report ready, deliver the own character, and let the frame loop run until the boot is
 *  quiet. */
async function boot(initialMotion = false): Promise<Booted> {
  const booted = await bootToConnect(initialMotion);
  opts.onReady(H.identity);
  server();
  for (let i = 0; i < 9; i += 1) advance(600);
  return booted;
}

/** One authoritative batch: the own player and character at (2, 6), every send acked. */
function server(): void {
  T += 10;
  clock.t = T;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    discriminator: 0,
    leadLevel: 0,
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
    T,
  );
  opts.store.flushBatch();
}

/** The connection drops and comes back: the store is emptied, then onReconnect reports `id`. */
function reconnect(id: string = H.identity): void {
  opts.store.reset();
  opts.onReconnect(id);
}

/** A keydown at the window and its keyup 5 ms later, 100 ms after the last instant. */
function press(code: string): void {
  T += 100;
  clock.t = T;
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  T += 5;
  clock.t = T;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

interface GameHook {
  readonly stack: unknown[];
  readonly navActive: string | null;
}
const gameHook = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
const stackNow = (): unknown[] => gameHook().stack;

/** Start (Escape) until the bare world is the one frame. */
function toWorld(label: string): void {
  for (let i = 0; i < 4 && stackNow().length > 1; i += 1) press('Escape');
  expect(stackNow(), `${label}: precondition: back at the bare world`).toEqual([WORLD]);
}

/** The wasm interact rule names exactly the marshalled entity of `kind` with entity id `id`. */
function ruleNaming(kind: 'npc' | 'player', id: bigint): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const entities = args[4];
    if (!Array.isArray(entities)) return [];
    const at = entities.findIndex(
      (e: { kind?: unknown; id?: unknown }) => e.kind === kind && e.id === id.toString(),
    );
    return at === -1 ? [] : [at];
  };
}

/** One NPC row and its character at (`tileX`, 6), with no flush. */
function placeNpc(
  entityId: bigint,
  npcId: string,
  tileX: number,
  interaction: StoreNpcRow['interaction'],
): void {
  opts.store.upsertNpc({
    entityId,
    npcId,
    zoneId: 0,
    homeX: tileX,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId: 'no-such-tree',
    interaction,
  });
  opts.store.upsertCharacter(
    {
      entityId,
      zoneId: 0,
      tileX,
      tileY: 6,
      facing: 'South',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
      ackedSeq: 0n,
    },
    T,
  );
}

/** The real greet-then-shop open of `shopId`: the server opens a conversation with its keeper, the
 *  player clicks the rendered Shop button past the text reveal, and the batch that ends the
 *  conversation opens the shop. */
function openShop(shopId: number, name = 'General Store'): void {
  placeNpc(GUIDE, 'guide', 4, { kind: 'shop', shopId });
  opts.store.upsertShop({ shopId, name });
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: GUIDE,
    currentNodeId: 'start',
  });
  server();
  expect(stackNow(), `shop ${shopId}: precondition: the conversation is the one frame`).toEqual([
    WORLD,
    screenFrame('dialogueView'),
  ]);
  T += 800;
  clock.t = T;
  const button = document.querySelector<HTMLElement>('#dialogue-choices [data-shop-id]');
  if (button === null) throw new Error('fixture: the dialogue rendered no Shop button');
  expect(button.dataset.shopId, 'fixture: the Shop button carries the keeper`s shop').toBe(
    String(shopId),
  );
  button.click();
  opts.store.removeConversation(H.identity);
  server();
  expect(stackNow(), `shop ${shopId}: precondition: the shop is the one frame`).toEqual([
    WORLD,
    screenFrame('shopView'),
  ]);
}

/** What the real shop view shows: its title and the stock rows of its buy list, by stock row id. */
function shopShows(): { title: string | null; stock: Array<string | null> } {
  const title = document.getElementById('shop-title');
  if (title === null) throw new Error('the shell must ship #shop-title');
  const rows = document.querySelectorAll('#shop-for-sale > li[data-nav-key]');
  return {
    title: title.textContent,
    stock: Array.from(rows, (row) => row.getAttribute('data-nav-key')),
  };
}

/** One stock row of `shopId`. */
function stockRow(shopItemId: bigint, shopId: number, itemId: number): void {
  opts.store.upsertShopItem({ shopItemId, shopId, itemId, buyPrice: 10n });
}

/** A at a healer NPC of `locationId` (entity `entityId`, on the player`s tile) opens the heal
 *  frame. */
function healAt(entityId: bigint, locationId: number): void {
  placeNpc(entityId, 'healer', 2, { kind: 'heal', locationId });
  H.interact = ruleNaming('npc', entityId);
  server();
  advance(16);
  press('Enter');
  expect(stackNow(), `heal ${locationId}: precondition: A opened the heal frame alone`).toEqual([
    WORLD,
    screenFrame('healView'),
  ]);
}

/** One `my_trade_session` row between the player and Zed, both sides empty. */
function tradeSession(sessionId: bigint): StoreTradeSession {
  return {
    sessionId,
    opener: H.identity,
    partner: ZED,
    openerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
    partnerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: 1n,
    createdAtMs: 900n,
  };
}

/** The editor root's session id, as the real TradeSessionView marks it. */
function editorSessionId(): string | null {
  const el = document.getElementById('tradepropose-overlay');
  if (el === null) throw new Error('the shell must ship #tradepropose-overlay');
  return el.getAttribute('data-session-id');
}

/** Zed faces the player with a session the two already share; A on him, then A on Trade, opens
 *  the editor on that session. */
function openEditor(sessionId: bigint): void {
  opts.store.upsertPlayer({
    identity: ZED,
    entityId: ZED_ENTITY,
    name: 'Zed',
    online: true,
    discriminator: 0,
    leadLevel: 0,
  });
  opts.store.upsertCharacter(
    {
      entityId: ZED_ENTITY,
      zoneId: 0,
      tileX: 3,
      tileY: 6,
      facing: 'West',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
      ackedSeq: 0n,
    },
    T,
  );
  opts.store.reconcileTradeSessionsFromView([tradeSession(sessionId)]);
  H.interact = ruleNaming('player', ZED_ENTITY);
  server();
  advance(50);
  press('Enter');
  press('Enter');
  expect(stackNow(), 'precondition: the editor is the one frame').toEqual([
    WORLD,
    screenFrame('tradeSessionView'),
  ]);
  expect(editorSessionId(), 'precondition: the editor shows that session').toBe(
    sessionId.toString(),
  );
}

/** Open Social with the main menu's Social row (M, Down to it, A): a plain open with no tab. */
function openSocialRow(): void {
  press('KeyM');
  expect(stackNow(), 'precondition: the menu is the one frame').toEqual([
    WORLD,
    screenFrame('menuView'),
  ]);
  for (let i = 0; i < 8 && gameHook().navActive !== 'social'; i += 1) press('ArrowDown');
  expect(gameHook().navActive, 'precondition: the menu cursor is on Social').toBe('social');
  press('Enter');
  expect(stackNow(), 'precondition: the Social row opened Social').toEqual([
    WORLD,
    screenFrame('menuView'),
    screenFrame('social'),
  ]);
}

/** An accelerator opens its leaf above the main menu. */
function accel(code: string, leaf: string): void {
  press(code);
  expect(stackNow(), `${code}: precondition: the menu, then ${leaf}`).toEqual([
    WORLD,
    screenFrame('menuView'),
    screenFrame(leaf),
  ]);
}

const BOUND_ALL = [3, 6, 'trades', 'storage', SESSION] as const;

/** Every open path binds once, each frame closing again: shop 3, heal location 6, Social on
 *  Trades (U), Monsters on Storage (B), the editor on the session. */
function bindAllFive(sc: Owner): void {
  openShop(3);
  toWorld('shop');
  healAt(HEALER_A, 6);
  toWorld('heal');
  accel('KeyU', 'social');
  toWorld('Social');
  accel('KeyB', 'boxView');
  toWorld('Monsters');
  openEditor(SESSION);
  toWorld('editor');
  expectFive(sc, BOUND_ALL, 'precondition: every open path bound its own value');
}

// --- the booted shell --------------------------------------------------------------------------
describe('the booted shell drives the screen context of shell/screenContext', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('the context the screens read holds the store main() handed to connect, follows the identity of the join and of a reconnect that mints a new one, reads the binding table applyBindings installs, and its clocks are the frame clock and the wall clock', async () => {
    const { sc, s, input } = await bootToConnect();
    const ctx = sc.screenCtx;
    expect(ctx.store, 'the store main() handed to connect').toBe(opts.store);
    expect(ctx.identity, 'no join yet: no identity').toBe('');

    opts.onReady(H.identity);
    expect(ctx.identity, 'the join`s identity').toBe(H.identity);
    server();
    advance(600);

    reconnect(IDENTITY_2);
    expect(s.identity, 'precondition: the reconnect adopted the new identity').toBe(IDENTITY_2);
    expect(ctx.identity, 'the reconnect`s new identity').toBe(IDENTITY_2);

    const before = input.bindings;
    expect(ctx.bindings, 'the input table every input path reads').toBe(before);
    const next: Bindings = { buttons: before.buttons, accels: before.accels };
    input.applyBindings(next);
    expect(input.bindings, 'precondition: applyBindings replaced the table').toBe(next);
    expect(ctx.bindings, 'the context reads the table applyBindings installed').toBe(next);

    T += 37;
    clock.t = T;
    expect(ctx.now(), 'now() is the frame clock').toBe(T);
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    expect(ctx.wallNowMs(), 'wallNowMs() is the wall clock').toBe(1_700_000_000_123);
  }, 60_000);

  it('a greet-then-shop open binds its shop on the owner and nothing else; the shop keeps its value after the shop closes and the next open rebinds it', async () => {
    const { sc } = await boot();
    expectFive(sc, NONE, 'after the boot');
    openShop(3);
    expectFive(sc, [3, null, null, null, null], 'the open of shop 3');
    toWorld('shop 3');
    expectFive(sc, [3, null, null, null, null], 'the shop closed');
    openShop(8);
    expectFive(sc, [8, null, null, null, null], 'the open of shop 8');
  }, 60_000);

  it('a batch while the shop shows renders the bound shop`s catalogue, not the first shop`s', async () => {
    const { sc } = await boot();
    // Two shops with different stock; shop 1 has the lowest id, so it is the first-row default.
    opts.store.upsertShop({ shopId: 1, name: 'Alpha' });
    opts.store.upsertShop({ shopId: 3, name: 'Gamma' });
    stockRow(101n, 1, 5);
    stockRow(303n, 3, 6);
    server();

    // Control: the two shops render differently in the real view.
    openShop(1, 'Alpha');
    expect(shopShows(), 'control: the open of shop 1 shows its own stock').toEqual({
      title: 'Alpha',
      stock: ['101'],
    });
    toWorld('shop 1');
    openShop(3, 'Gamma');
    expectFive(sc, [3, null, null, null, null], 'precondition: the open bound shop 3');
    expect(shopShows(), 'the open of shop 3 shows its own stock').toEqual({
      title: 'Gamma',
      stock: ['303'],
    });

    // A batch while the shop shows: the refresh re-renders it (the new row is the proof it ran).
    stockRow(304n, 3, 7);
    server();
    expect(stackNow(), 'precondition: the shop still shows').toEqual([
      WORLD,
      screenFrame('shopView'),
    ]);
    expect(shopShows(), 'the refresh renders the bound shop, new row included').toEqual({
      title: 'Gamma',
      stock: ['303', '304'],
    });
  }, 60_000);

  it('A at a healer binds its location on the owner and nothing else; location 0 is a location, and the binding keeps its value after the heal frame closes', async () => {
    const { sc } = await boot();
    expectFive(sc, NONE, 'after the boot');
    healAt(HEALER_A, 6);
    expectFive(sc, [null, 6, null, null, null], 'A at the healer of location 6');
    toWorld('heal 6');
    expectFive(sc, [null, 6, null, null, null], 'the heal frame closed');

    opts.store.removeNpc(HEALER_A);
    opts.store.removeCharacter(HEALER_A);
    healAt(HEALER_B, 0);
    expectFive(sc, [null, 0, null, null, null], 'A at the healer of location 0');
  }, 60_000);

  it('U opens Social bound to Trades on the owner and the menu`s Social row opens it with no tab, and the tab keeps its value after Social closes', async () => {
    const { sc } = await boot();
    expectFive(sc, NONE, 'after the boot');
    accel('KeyU', 'social');
    expectFive(sc, [null, null, 'trades', null, null], 'U');
    toWorld('U');
    expectFive(sc, [null, null, 'trades', null, null], 'Social closed');

    openSocialRow();
    expectFive(sc, NONE, 'the Social row: a plain open binds no tab');
  }, 60_000);

  it('V opens Monsters bound to Party on the owner and B bound to Storage, each open rebinding whatever the last one left', async () => {
    const { sc } = await boot();
    expectFive(sc, NONE, 'after the boot');
    accel('KeyV', 'boxView');
    expectFive(sc, [null, null, null, 'party', null], 'V');
    toWorld('V');
    accel('KeyB', 'boxView');
    expectFive(sc, [null, null, null, 'storage', null], 'B');
    toWorld('B');
    expectFive(sc, [null, null, null, 'storage', null], 'Monsters closed');
    accel('KeyV', 'boxView');
    expectFive(sc, [null, null, null, 'party', null], 'V again');
  }, 60_000);

  it('the trade editor opened on a session binds that session on the owner and nothing else, and the binding keeps its value after the editor closes', async () => {
    const { sc } = await boot();
    expectFive(sc, NONE, 'after the boot');
    openEditor(SESSION);
    expectFive(sc, [null, null, null, null, SESSION], 'the editor on the session');
    toWorld('editor');
    expectFive(sc, [null, null, null, null, SESSION], 'the editor closed');
  }, 60_000);

  it('a reconnect leaves the owner with no shop, no heal location, no Social tab, no Monsters tab and no trade session', async () => {
    const { sc } = await boot();
    bindAllFive(sc);
    reconnect();
    expectFive(sc, NONE, 'after the reconnect');
  }, 60_000);

  it('a batch in which the bound session is gone unbinds the trade session on the owner and leaves the other four bound', async () => {
    const { sc } = await boot();
    bindAllFive(sc);
    server();
    expectFive(sc, BOUND_ALL, 'control: a batch that still holds the session keeps it bound');

    opts.store.reconcileTradeSessionsFromView([]);
    server();
    expectFive(sc, [3, 6, 'trades', 'storage', null], 'the session closed');
  }, 60_000);

  it('a join unbinds the trade session on the owner and leaves the other four bound', async () => {
    const { sc } = await boot();
    bindAllFive(sc);
    opts.onReady(H.identity);
    expectFive(sc, [3, 6, 'trades', 'storage', null], 'after the join');
  }, 60_000);

  it.each([
    { initial: false },
    { initial: true },
  ])('the owner`s motion preference and the context follow each change event from an initial $initial, every frame renders with that same value, and the whole boot asks matchMedia once with one change listener', async ({
    initial,
  }) => {
    const { sc, motion } = await boot(initial);
    const pref = sc.motionPreference;
    expect(pref.reduceMotion, 'the initial value').toBe(initial);
    expect(sc.screenCtx.reduceMotion, 'the context reads it').toBe(initial);

    const world = await import('../render/world');
    const render = vi.spyOn(world.WorldRenderer.prototype, 'render');
    /** One frame, and the reduced-motion value that frame rendered with. */
    const frameMotion = (): unknown => {
      const before = render.mock.calls.length;
      advance(16);
      expect(render.mock.calls.length, 'precondition: the frame rendered once').toBe(before + 1);
      return render.mock.calls.at(-1)?.[3]?.reduceMotion;
    };
    expect(frameMotion(), 'a frame renders with the initial value').toBe(initial);

    expect(motion.listeners, 'precondition: one change listener').toHaveLength(1);
    motion.fire(!initial);
    expect(pref.reduceMotion, 'the change event`s value').toBe(!initial);
    expect(sc.screenCtx.reduceMotion, 'the context reads it').toBe(!initial);
    expect(frameMotion(), 'the next frame renders with it').toBe(!initial);

    motion.fire(initial);
    expect(pref.reduceMotion, 'the next change event`s value').toBe(initial);
    expect(sc.screenCtx.reduceMotion).toBe(initial);
    expect(frameMotion(), 'and the next frame renders with that').toBe(initial);

    expect(motion.queries, 'one matchMedia query in the whole boot').toEqual([
      REDUCED_MOTION_QUERY,
    ]);
    expect(motion.listeners, 'and one change listener').toHaveLength(1);
  }, 60_000);

  it('the media-query change listener is added before main.ts registers its first batch listener', async () => {
    const { motion, onBatch } = await bootToConnect();
    expect(
      motion.add.mock.calls.map((c) => c[0]),
      'one listener is on the media query: its change listener',
    ).toEqual(['change']);
    expect(onBatch.mock.calls.length, 'precondition: batch listeners registered').toBeGreaterThan(
      0,
    );
    const added = first(motion.add.mock.invocationCallOrder, 'the change listener');
    const firstBatch = first(onBatch.mock.invocationCallOrder, 'the first batch listener');
    expect(added, 'the change listener comes first').toBeLessThan(firstBatch);
  }, 60_000);
});

// --- the module on its own (no boot) --------------------------------------------------------
describe('shell/screenContext owner functions', { sequential: true }, () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.replaceChildren();
    vi.resetModules();
  });

  async function fresh(initialMotion = false): Promise<{ sc: Owner; motion: MotionStub }> {
    vi.resetModules();
    const motion = motionStub(initialMotion);
    installMotion(motion);
    const sc = await import('./screenContext');
    return { sc, motion };
  }

  it('importing the module asks the media query once and adds its one change listener at once, so a change before the first read is what the first read sees; it registers no batch listener and no window or document listener, and writes nothing to the document', async () => {
    vi.resetModules();
    const motion = motionStub(false);
    installMotion(motion);
    // Everything the module imports loads first, so the import below evaluates the module alone.
    await import('../render/motionPreference');
    await import('./inputState');
    const s = await import('./session');
    const storeModule = await import('../net/store');
    const onBatch = vi.spyOn(storeModule.AuthoritativeStore.prototype, 'onBatchApplied');
    expect(motion.queries, 'precondition: nothing has asked the query yet').toEqual([]);

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      mutations.push(...records);
    });
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    // An observer of this test's own, undone by assigning the saved function back (as
    // `recordListeners` does).
    const seen: Recorded[] = [];
    const undo: Array<() => void> = [];
    const targets: readonly EventTarget[] = [window, document];
    for (const target of targets) {
      const hadOwn = Object.getOwnPropertyDescriptor(target, 'addEventListener') !== undefined;
      const previous = target.addEventListener;
      (target as Adder).addEventListener = (
        type: string,
        handler: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        seen.push({ target, type, handler, options });
        previous.call(target, type, handler, options);
      };
      undo.push(() => {
        if (hadOwn) (target as Adder).addEventListener = previous;
        else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
      });
    }
    try {
      // The observers work: a probe listener, a probe write and a probe registration are each seen.
      const probe = (): void => undefined;
      window.addEventListener('mr-probe', probe);
      document.addEventListener('mr-probe', probe);
      expect(
        seen.map((r) => [r.target === window, r.target === document, r.type]),
        'precondition: the listener observer sees each target`s probe exactly once',
      ).toEqual([
        [true, false, 'mr-probe'],
        [false, true, 'mr-probe'],
      ]);
      window.removeEventListener('mr-probe', probe);
      document.removeEventListener('mr-probe', probe);
      seen.length = 0;

      document.documentElement.setAttribute('data-mr-probe', '1');
      document.documentElement.removeAttribute('data-mr-probe');
      mutations.push(...observer.takeRecords());
      expect(
        mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
        'precondition: the mutation observer reports the probe`s set and remove',
      ).toEqual(['attributes:data-mr-probe', 'attributes:data-mr-probe']);
      mutations.length = 0;

      const off = s.store.onBatchApplied(() => undefined);
      expect(
        onBatch,
        'precondition: the batch-listener spy sees a registration',
      ).toHaveBeenCalledTimes(1);
      off();
      onBatch.mockClear();

      const sc = await import('./screenContext');

      expect(motion.queries, 'the import asked the reduced-motion query once').toEqual([
        REDUCED_MOTION_QUERY,
      ]);
      expect(
        motion.add.mock.calls.map((c) => c[0]),
        'and added one change listener to it, before any read',
      ).toEqual(['change']);
      expect(
        seen.map((r) => [r.target === window, r.type]),
        'the import registered no listener on window or document',
      ).toEqual([]);
      mutations.push(...observer.takeRecords());
      expect(
        mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
        'the import wrote nothing to the document',
      ).toEqual([]);
      expect(onBatch, 'the import registered no batch listener').not.toHaveBeenCalled();
      expect(sc.screenCtx.store, 'the context holds the session module`s store').toBe(s.store);

      // The query object's `.matches` stays false: only the listener added at import sees this.
      motion.fire(true);
      expect(sc.motionPreference.reduceMotion, 'the first read sees the change').toBe(true);
      expect(sc.screenCtx.reduceMotion, 'and so does the context').toBe(true);
      expect(motion.queries, 'reading asks no second query').toHaveLength(1);
    } finally {
      observer.disconnect();
      for (const r of seen) r.target.removeEventListener(r.type, r.handler, r.options);
      while (undo.length > 0) undo.pop()?.();
    }
  });

  it('the five bindings start null, each bind sets its own binding and no other, and the context reads each one live', async () => {
    const { sc } = await fresh();
    expectFive(sc, NONE, 'at import');
    sc.bindShop(3);
    expectFive(sc, [3, null, null, null, null], 'bindShop(3)');
    sc.bindHealLocation(6);
    expectFive(sc, [3, 6, null, null, null], 'bindHealLocation(6)');
    sc.bindSocialTab('challenges');
    expectFive(sc, [3, 6, 'challenges', null, null], 'bindSocialTab(challenges)');
    sc.bindMonstersTab('storage');
    expectFive(sc, [3, 6, 'challenges', 'storage', null], 'bindMonstersTab(storage)');
    sc.bindTradeSession(SESSION);
    expectFive(sc, [3, 6, 'challenges', 'storage', SESSION], 'bindTradeSession');
  });

  it('0 is a shop id, 0 is a location id and 0n is a session id: each rebinds over a bound value and none reads as null', async () => {
    const { sc } = await fresh();
    sc.bindShop(3);
    sc.bindHealLocation(6);
    sc.bindTradeSession(SESSION);
    expectFive(sc, [3, 6, null, null, SESSION], 'precondition: three bound values');
    sc.bindShop(0);
    sc.bindHealLocation(0);
    sc.bindTradeSession(0n);
    expectFive(sc, [0, 0, null, null, 0n], 'the zero ids');
  });

  it('bindSocialTab(null) after a named tab reads null, and bindMonstersTab rebinds Party and Storage either way', async () => {
    const { sc } = await fresh();
    sc.bindSocialTab('rankings');
    sc.bindMonstersTab('party');
    expectFive(sc, [null, null, 'rankings', 'party', null], 'a named tab and Party');
    sc.bindSocialTab(null);
    sc.bindMonstersTab('storage');
    expectFive(sc, [null, null, null, 'storage', null], 'a plain Social open and Storage');
    sc.bindMonstersTab('party');
    expectFive(sc, [null, null, null, 'party', null], 'Party again');
  });

  it('unbindForReconnect clears the shop, the heal location, the Social tab and the Monsters tab and keeps the trade session; unbindTradeSession clears the trade session and keeps the other four', async () => {
    const { sc } = await fresh();
    const bindFour = (): void => {
      sc.bindShop(3);
      sc.bindHealLocation(6);
      sc.bindSocialTab('trades');
      sc.bindMonstersTab('party');
    };
    bindFour();
    sc.bindTradeSession(SESSION);
    expectFive(sc, [3, 6, 'trades', 'party', SESSION], 'precondition: all five bound');
    sc.unbindForReconnect();
    expectFive(sc, [null, null, null, null, SESSION], 'unbindForReconnect');

    bindFour();
    expectFive(sc, [3, 6, 'trades', 'party', SESSION], 'precondition: all five bound again');
    sc.unbindTradeSession();
    expectFive(sc, [3, 6, 'trades', 'party', null], 'unbindTradeSession');
  });

  it('unbindForReconnect clears whichever of the four is bound when it is bound alone, and when the shop alone is unbound', async () => {
    const { sc } = await fresh();
    const shapes: ReadonlyArray<{
      readonly label: string;
      readonly bind: () => void;
      readonly bound: readonly unknown[];
    }> = [
      { label: 'the shop alone', bind: () => sc.bindShop(3), bound: [3, null, null, null, null] },
      {
        label: 'the heal location alone',
        bind: () => sc.bindHealLocation(6),
        bound: [null, 6, null, null, null],
      },
      {
        label: 'the Social tab alone',
        bind: () => sc.bindSocialTab('trades'),
        bound: [null, null, 'trades', null, null],
      },
      {
        label: 'the Monsters tab alone',
        bind: () => sc.bindMonstersTab('storage'),
        bound: [null, null, null, 'storage', null],
      },
      {
        label: 'all but the shop',
        bind: () => {
          sc.bindHealLocation(6);
          sc.bindSocialTab('trades');
          sc.bindMonstersTab('storage');
        },
        bound: [null, 6, 'trades', 'storage', null],
      },
    ];
    for (const { label, bind, bound } of shapes) {
      bind();
      expectFive(sc, bound, `precondition: ${label} bound`);
      sc.unbindForReconnect();
      expectFive(sc, NONE, `unbindForReconnect from ${label}`);
    }
  });

  it('the context`s bindings are the input table applyBindings installs, not the one at import', async () => {
    const { sc } = await fresh();
    const input = await import('./inputState');
    const before = input.bindings;
    expect(sc.screenCtx.bindings, 'at import: the current table').toBe(before);
    const next: Bindings = { buttons: before.buttons, accels: before.accels };
    input.applyBindings(next);
    expect(input.bindings, 'precondition: applyBindings replaced the table').toBe(next);
    expect(sc.screenCtx.bindings, 'the context reads the new table').toBe(next);
  });

  it('now() reads performance.now() and wallNowMs() reads Date.now() at each call', async () => {
    const { sc } = await fresh();
    const perf = vi.spyOn(performance, 'now').mockReturnValue(4321);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    expect(sc.screenCtx.now()).toBe(4321);
    expect(sc.screenCtx.wallNowMs()).toBe(1_700_000_000_123);
    perf.mockReturnValue(4400);
    wall.mockReturnValue(1_700_000_000_456);
    expect(sc.screenCtx.now(), 'the next call reads the clock again').toBe(4400);
    expect(sc.screenCtx.wallNowMs()).toBe(1_700_000_000_456);
  });
});
