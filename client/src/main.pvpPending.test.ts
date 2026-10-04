// @vitest-environment happy-dom
/**
 * main.pvpPending.test.ts: the booted-app proof of the three decisions pgcc-d moved out of main.ts
 * into pure cores (M-postgate-client-coverage.spec.md, pgcc-d). The cores themselves are
 * unit-tested (battleModel.test.ts); this file proves main.ts's SHELLS call them with the right
 * inputs and honour what they return, which no unit test of a core can see.
 *
 * Harness: the real main.ts booted against the real client/index.html shell, the SDK connection
 * stubbed (its reducers record every call, its frozen flag is controllable, and the reducer's
 * promise is controllable), the real store driven directly (`upsertBattle` + `flushBatch`, what
 * connection.ts's batch flush does), and the eleven view classes replaced by the recording
 * stand-in main.dispatch.test.ts uses. The BattleView stand-in's `refresh(vm)` argument IS the
 * observation channel: `pvpPendingSubmit`, `baitOptions` and `cureItems` are read off the view
 * model main.ts hands the view, and the view callbacks (`onPvpAttack`, `onPvpSwap`) are invoked
 * the way the real view invokes them.
 *
 * Why a boot test: the full client suite measured every wiring mutant below as surviving, because
 * no other boot test drives a PvP battle. Each test names the mutant ids it kills (the pgcc-d
 * red-team numbering).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreBattle, StoreBattleMonster, StoreInventory, StoreItemRow } from './net/store';
import type { BattleViewModel } from './ui/battleModel';

const H = vi.hoisted(() => {
  interface StubView {
    visible: boolean;
    renders: unknown[];
  }
  const h = {
    identity: 'ab'.repeat(32),
    connectOpts: null as ConnectionOptions | null,
    /** Every non-movement reducer call, oldest first, with the exact argument object. */
    calls: [] as Array<{ name: string; args: unknown }>,
    /** The handler object each recorded view constructor received, keyed by view class name. */
    handlers: {} as Record<string, Record<string, unknown>>,
    /** The recorded view instances, keyed by view class name. */
    views: {} as Record<string, StubView>,
    /** The stubbed connection's link state. */
    frozen: false,
    /** What every non-movement reducer returns (a fresh promise per call). */
    reducer: (() => Promise.resolve()) as () => Promise<void>,
    makeStub: (name: string) =>
      class {
        visible = false;
        renders: unknown[] = [];
        constructor(...args: unknown[]) {
          h.handlers[name] = args[args.length - 1] as Record<string, unknown>;
          h.views[name] = this as unknown as StubView;
        }
        show(): void {
          this.visible = true;
        }
        hide(): void {
          this.visible = false;
        }
        toggle(): void {
          this.visible = !this.visible;
        }
        render(vm: unknown): void {
          this.renders.push(vm);
        }
        refresh(vm: unknown, forceVisible?: unknown): void {
          this.renders.push(vm);
          if (name === 'PvpView') this.visible = forceVisible === true;
        }
        hostChrome(): void {}
        showFeedback(): void {}
      },
  };
  return h;
});

vi.mock('./ui/boxView', () => ({ BoxView: H.makeStub('BoxView') }));
vi.mock('./ui/battleView', () => ({ BattleView: H.makeStub('BattleView') }));
vi.mock('./ui/raisingView', () => ({ RaisingView: H.makeStub('RaisingView') }));
vi.mock('./ui/evolutionView', () => ({ EvolutionView: H.makeStub('EvolutionView') }));
vi.mock('./ui/shopView', () => ({ ShopView: H.makeStub('ShopView') }));
vi.mock('./ui/tradeView', () => ({ TradeView: H.makeStub('TradeView') }));
vi.mock('./ui/pvpView', () => ({ PvpView: H.makeStub('PvpView') }));
vi.mock('./ui/claimView', () => ({ ClaimView: H.makeStub('ClaimView') }));
vi.mock('./ui/privacyView', () => ({ PrivacyView: H.makeStub('PrivacyView') }));
vi.mock('./ui/renameView', () => ({ RenameView: H.makeStub('RenameView') }));
vi.mock('./ui/tradeProposeView', () => ({ TradeProposeView: H.makeStub('TradeProposeView') }));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
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

vi.mock('./net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') {
          return () => new Promise<void>(() => {});
        }
        return (args: unknown) => {
          H.calls.push({ name: String(name), args });
          return H.reducer();
        };
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => H.frozen,
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

/** main.ts registers window/document listeners at MODULE scope: record each so afterEach can
 *  detach it, or a second import leaves a live handler from a dead module instance. */
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
let opts: ConnectionOptions;

async function bootReady(): Promise<void> {
  H.connectOpts = null;
  H.calls = [];
  H.handlers = {};
  H.views = {};
  H.frozen = false;
  H.reducer = () => Promise.resolve();
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
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

const EID = 7n;
const OTHER_IDENTITY = 'cd'.repeat(32);
const WILD_IDENTITY = '0'.repeat(64);
const BID = 301n;

/** One authoritative batch: the own player + character, flushed (battle rows already upserted
 *  ride the same flush, as one transaction burst does). */
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
    },
    t,
  );
  opts.store.flushBatch();
}

/** Upsert one battle row and flush a batch that carries it. */
function deliver(battle: StoreBattle): void {
  opts.store.upsertBattle(battle);
  server(clock.t + 100);
}

/** Let queued microtasks and zero-delay timers run (a settled reducer promise). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

/** A PvP battle row: the opponent is an owned, distinct player (opponentMonsterIds non-empty). */
function pvpBattle(turnNumber: number, outcome = 'Ongoing'): StoreBattle {
  return {
    battleId: BID,
    playerIdentity: H.identity,
    opponentIdentity: OTHER_IDENTITY,
    outcome,
    turnNumber,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [1n],
    opponentMonsterIds: [2n],
    createdAtMs: 0n,
    weather: null,
  };
}

/** A wild battle row: all-zero opponent identity and NO owned opponent party (canRecruit). */
function wildBattle(): StoreBattle {
  return {
    ...pvpBattle(1),
    opponentIdentity: WILD_IDENTITY,
    opponentMonsterIds: [],
  };
}

function battleViewRenders(): (BattleViewModel | null)[] {
  const view = H.views.BattleView;
  if (view === undefined) throw new Error('BattleView was never constructed by main.ts');
  return view.renders as (BattleViewModel | null)[];
}

/** The view model main.ts handed the BattleView most recently. */
function lastVm(): BattleViewModel {
  const all = battleViewRenders();
  const last = all[all.length - 1];
  if (last === undefined || last === null) throw new Error('no battle view model was rendered');
  return last;
}

function viewHandler(name: string): (...a: unknown[]) => Promise<void> {
  const handlers = H.handlers.BattleView;
  const fn = handlers?.[name];
  if (typeof fn !== 'function') throw new Error(`BattleView received no ${name} handler`);
  return (fn as (...a: unknown[]) => Promise<void>).bind(handlers);
}

const pvpAttack = (battleId: bigint, skillId: number): Promise<void> =>
  viewHandler('onPvpAttack')(battleId, skillId);

const pvpSwap = (battleId: bigint, teamIndex: number): Promise<void> =>
  viewHandler('onPvpSwap')(battleId, teamIndex);

/** Silence the status line's console.error (a frozen link and a rejection both report there). */
function muteConsoleError(): void {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('main.ts booted: the PvP pending submit and the battle item lists (pgcc-d)', () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    H.frozen = false;
    H.reducer = () => Promise.resolve();
    document.body.replaceChildren();
  });

  it('PGCCD-BOOT-PAINT [M8, M24]: a PvP attack paints the pending flag at once, before any batch, and sends the action', async () => {
    // WRONG IMPL KILLED: M8, the pre-send refreshBattle() dropped (the flag would paint only at
    // the next batch, and an unchanged row no longer notifies one: the player sees no feedback);
    // M24, pvpPendingSubmit forced false in the shell.
    await bootReady();
    deliver(pvpBattle(5));
    const baseline = lastVm();
    expect(baseline.isPvp, 'the fixture is a PvP battle').toBe(true);
    expect(baseline.pvpPendingSubmit, 'nothing is pending before a submit').toBe(false);

    const sent = pvpAttack(BID, 7);
    // Synchronous: no batch, no microtask has run since the click.
    expect(lastVm().pvpPendingSubmit, 'the pending flag is painted by the send itself').toBe(true);
    await sent;
    expect(H.calls).toEqual([
      { name: 'submitPvpAction', args: { battleId: BID, action: { tag: 'Attack', value: 7 } } },
    ]);
    expect(lastVm().pvpPendingSubmit, 'and it stays on after the reducer accepts').toBe(true);
  });

  it('PGCCD-BOOT-PAINT-SWAP [M8, M24]: a PvP swap shares the pending path and paints at once', async () => {
    // WRONG IMPL KILLED: a swap that sends without setting or painting the pending flag (the swap
    // and attack arms must both go through the one pending-submit shell).
    await bootReady();
    deliver(pvpBattle(5));
    expect(lastVm().pvpPendingSubmit).toBe(false);

    const sent = pvpSwap(BID, 2);
    expect(lastVm().pvpPendingSubmit, 'the swap paints the pending flag at once').toBe(true);
    await sent;
    expect(H.calls).toEqual([
      { name: 'submitPvpAction', args: { battleId: BID, action: { tag: 'Swap', value: 2 } } },
    ]);
  });

  it('PGCCD-BOOT-CLEAR-ON-TURN [M2]: the pending flag holds on an unchanged turn and clears when the turn advances', async () => {
    // WRONG IMPL KILLED: M2, the pvpPendingAfterBatch call dropped from refreshBattle (the flag
    // never clears after the turn advances: the player is stuck on "waiting for opponent"); and
    // the opposite cheat, a shell that clears the flag on every batch (the same-turn batch below
    // would paint false).
    await bootReady();
    deliver(pvpBattle(5));
    await pvpAttack(BID, 7);
    expect(lastVm().pvpPendingSubmit).toBe(true);

    // The row re-notifies with the SAME turn (the opponent has not acted): still waiting.
    deliver(pvpBattle(5));
    expect(lastVm().turnNumber).toBe(5);
    expect(lastVm().pvpPendingSubmit, 'an unchanged turn keeps the flag').toBe(true);

    // The turn resolves: the server advances it.
    deliver(pvpBattle(6));
    expect(lastVm().turnNumber, 'the advanced turn reached the view').toBe(6);
    expect(lastVm().pvpPendingSubmit, 'the advanced turn clears the flag').toBe(false);
  });

  it('PGCCD-BOOT-CLEAR-ON-FORFEIT [M3]: a battle that ends on an unchanged turn clears the pending flag', async () => {
    // WRONG IMPL KILLED: M3, `{...battle, outcome: 'Ongoing'}` passed into pvpPendingAfterBatch
    // (a forfeit skips advance_turn, so only the outcome shows the resolution; the flag would
    // stay on over a finished battle).
    await bootReady();
    deliver(pvpBattle(5));
    await pvpAttack(BID, 7);
    expect(lastVm().pvpPendingSubmit).toBe(true);

    deliver(pvpBattle(5, 'SideAWins'));
    expect(lastVm().outcome, 'the terminal row reached the view').toBe('SideAWins');
    expect(lastVm().turnNumber, 'the turn did not move').toBe(5);
    expect(lastVm().pvpPendingSubmit, 'a finished battle is not waiting on anyone').toBe(false);
  });

  it('PGCCD-BOOT-REJECT-RESTORES [M4, M6]: a rejected submit puts the prior value back and repaints', async () => {
    // WRONG IMPL KILLED: M4, the rejection arm setting `submit.pending` instead of `onReject`
    // (the flag stays on after a submit the server refused); M6, the restore skipped, or the
    // repaint after it dropped (the flag, or the stale painted view, stays on). The prior value
    // here is null, so the restore must read false.
    muteConsoleError();
    await bootReady();
    deliver(pvpBattle(5));
    let rejectSubmit: (e: Error) => void = () => undefined;
    H.reducer = () =>
      new Promise<void>((_resolve, reject) => {
        rejectSubmit = reject;
      });

    const sent = pvpAttack(BID, 7);
    expect(H.calls.length, 'the reducer was reached').toBe(1);
    expect(lastVm().pvpPendingSubmit, 'in flight, the flag is painted').toBe(true);

    rejectSubmit(new Error('already submitted this turn'));
    await sent;
    await flush();
    expect(lastVm().pvpPendingSubmit, 'the rejection repaints the restored value').toBe(false);

    // Not merely hidden by the repaint: the next batch on the same turn agrees.
    deliver(pvpBattle(5));
    expect(lastVm().pvpPendingSubmit, 'the flag is really off, not just unpainted').toBe(false);
  });

  it('PGCCD-BOOT-FROZEN-LINK [M7]: a submit on a frozen link sends nothing and never locks the pending flag', async () => {
    // WRONG IMPL KILLED: M7, pvpSubmitPending / the pending write moved OUTSIDE the sendGuarded
    // lambda (a dropped send never advances the turn, so the flag would lock on for good: the
    // repaint-moved-out variant paints true at once, the write-only variant surfaces at the next
    // batch, both asserted below).
    muteConsoleError();
    await bootReady();
    deliver(pvpBattle(5));
    expect(lastVm().pvpPendingSubmit).toBe(false);
    const rendersBefore = battleViewRenders().length;

    H.frozen = true;
    await pvpAttack(BID, 7);
    expect(H.calls, 'a frozen link calls no reducer').toEqual([]);
    expect(battleViewRenders().length, 'and repaints nothing').toBe(rendersBefore);
    expect(lastVm().pvpPendingSubmit, 'the flag is not painted on a dropped send').toBe(false);

    H.frozen = false;
    deliver(pvpBattle(5));
    expect(lastVm().pvpPendingSubmit, 'and was never set: the next batch reads it off').toBe(false);

    // Control: the same click on a live link does set it.
    await pvpAttack(BID, 7);
    expect(lastVm().pvpPendingSubmit).toBe(true);
  });

  it('PGCCD-BOOT-RECONNECT-RESET: a reconnect drops a pending submit (the old battle is gone)', async () => {
    // WRONG IMPL KILLED: a resetPredictionState that stops clearing the pending turn (the flag
    // would survive onto the re-delivered battle after the link came back).
    await bootReady();
    deliver(pvpBattle(5));
    await pvpAttack(BID, 7);
    expect(lastVm().pvpPendingSubmit).toBe(true);

    opts.store.reset();
    opts.onReconnect(H.identity);
    deliver(pvpBattle(5));
    expect(lastVm().turnNumber, 'the re-delivered battle reached the view').toBe(5);
    expect(lastVm().pvpPendingSubmit, 'a reconnect clears the pending submit').toBe(false);
  });

  it('PGCCD-BOOT-BAIT-CURE [M19, M20, M21, M22, M23]: the battle view model carries the bait list and the cure list built from the own inventory and the item defs', async () => {
    // WRONG IMPL KILLED: bait and cure lists swapped, either emptied, or built from an empty
    // inventory or an empty def map. The inventory holds one bait stack, one cure stack, one plain
    // stack (neither: it must appear in neither list) and one stack whose def is missing (dropped).
    await bootReady();
    server(1000);
    const def = (
      id: number,
      name: string,
      recruitBonus: number,
      cureStatus: string | null,
    ): StoreItemRow => ({
      id,
      name,
      description: '',
      recruitBonus,
      trainStat: null,
      trainAmount: 0,
      sellPrice: 0n,
      cureStatus,
    });
    opts.store.upsertItemDef(def(10, 'Sweet Bait', 5, null));
    opts.store.upsertItemDef(def(20, 'Antidote', 0, 'Poison'));
    opts.store.upsertItemDef(def(30, 'Plain Herb', 0, null));
    const stack = (invId: bigint, itemId: number, count: number): StoreInventory => ({
      invId,
      ownerIdentity: H.identity,
      itemId,
      count,
    });
    opts.store.reconcileInventoryFromView([
      stack(1n, 10, 3),
      stack(2n, 30, 4),
      stack(3n, 20, 2),
      stack(4n, 99, 1),
    ]);

    deliver(wildBattle());
    const vm = lastVm();
    expect(vm.canRecruit, 'a wild ongoing battle can recruit, so bait is offered').toBe(true);
    expect(vm.isPvp).toBe(false);
    expect(vm.pvpPendingSubmit, 'a PvE battle has no pending submit').toBe(false);
    expect(vm.baitOptions).toEqual([{ itemId: 10, name: 'Sweet Bait', recruitBonus: 5, count: 3 }]);
    expect(vm.cureItems).toEqual([
      { itemId: 20, name: 'Antidote', cureStatus: 'Poison', count: 2 },
    ]);
  });
});
