// @vitest-environment happy-dom
// shell/frames — the context stack, the overlay tables, the gates and the four owner functions,
// reached through the module. Each test imports it afresh (vi.resetModules + dynamic imports), with
// every shell module it reads loaded in the same registry, so the store, the views, the battle frame
// and the input devices are the instances the module reads. The hint host and the battle port are
// installed as the boot installs them. The real client-wasm rules answer every rules call.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  StoreBattle,
  StoreBattleEvent,
  StoreBattleMonster,
  StoreBattleUnit,
  StoreMonsterPub,
  StoreTacticalBattle,
} from '../net/store';
import type { FrameId, Stack } from '../ui/contextStack';
import type { FrameOpen } from './frames';
import type { ViewHandles } from './views';

type FramesModule = typeof import('./frames');

interface Loaded {
  readonly frames: FramesModule;
  readonly session: typeof import('./session');
  readonly views: typeof import('./views');
  readonly feedback: typeof import('./feedback');
  readonly inputState: typeof import('./inputState');
  readonly screenContext: typeof import('./screenContext');
  readonly bf: typeof import('./battleFrame');
  readonly cp: typeof import('./commandPort');
}

async function fresh(): Promise<Loaded> {
  vi.resetModules();
  const session = await import('./session');
  const views = await import('./views');
  const feedback = await import('./feedback');
  const inputState = await import('./inputState');
  const screenContext = await import('./screenContext');
  const bf = await import('./battleFrame');
  const cp = await import('./commandPort');
  const frames = await import('./frames');
  feedback.installHintHost({
    menuOnTop: () => frames.menuPlace() === 'top',
    repaintMenu: () => {},
  });
  return { frames, session, views, feedback, inputState, screenContext, bf, cp };
}

const EXPORTS = [
  'clearOutcomeEdge',
  'closeLeftFocusAdrift',
  'contextStack',
  'focusAdrift',
  'focusInsideHiddenSubtree',
  'frameOpenOf',
  'hideFrame',
  'inHiddenSubtree',
  'menuPlace',
  'movementGate',
  'openFrame',
  'openSeated',
  'outcomeShownAtMs',
  'overlayVerdict',
  'panelShown',
  'pumpCareReadiness',
  'reconcileStack',
  'screenHost',
  'shownOverlays',
  'socialPanelView',
  'sweepForReconnect',
  'syncStack',
  'takeResultsAutoContinue',
  'topOverlay',
  'topSocialFrame',
  'upperIds',
  'worldBaseLive',
  'worldIsBare',
];

const ME = 'a1'.repeat(32);
const PEER = 'b2'.repeat(32);
const WILD = '0'.repeat(64);
/** The own monster every fixture battle stages. */
const P = 7n;

const BATTLE_MONSTER: StoreBattleMonster = {
  speciesId: 1,
  affinity: 'Plant',
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

/** The battle anchor with ME as side A and `opponent` as side B, staging P. */
function anchor(battleId: bigint, outcome: string, opponent: string = PEER): StoreBattle {
  return {
    battleId,
    playerIdentity: ME,
    opponentIdentity: opponent,
    outcome,
    turnNumber: 1,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [P],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

function ownMonster(monsterId: bigint): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: ME,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 23,
    statHp: 29,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot: 0,
    tier: 0,
    essence: {} as StoreMonsterPub['essence'],
    trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
    qualityTimeTier: 0,
    nutritionPct: 0,
    lastCareAtMs: 0n,
  };
}

/** The tactical row on content map 1; Active waits on the own unit 61. */
function tactical(
  battleId: bigint,
  kind: StoreTacticalBattle['kind'],
  phase: StoreTacticalBattle['phase'],
): StoreTacticalBattle {
  const active = phase === 'Active';
  return {
    battleId,
    kind,
    format: 1,
    mapId: 1,
    contentVersion: 1,
    phase,
    round: phase === 'Deploying' ? 0 : 1,
    initiative: active ? [62, 61] : [],
    turnIdx: active ? 1 : 0,
    turnState: active ? { kind: 'Waiting', unitId: 61 } : { kind: 'NotActive' },
    tiePrioritySide: 'A',
    pendingPadMs: 0,
    attackDamageDealtA: 0,
    attackDamageDealtB: 0,
  };
}

const UNIT_STATS = { hp: 31, attack: 7, defense: 7, speed: 7, sp_attack: 7, sp_defense: 7 };

/** An Active species-1 unit: the own P on side A, or a wild on side B. */
function unit(
  battleId: bigint,
  unitId: number,
  own: boolean,
  x: number,
  y: number,
): StoreBattleUnit {
  return {
    unitId,
    battleId,
    owner: own ? ME : null,
    monsterId: own ? P : null,
    affinity: 'Plant',
    row: {
      id: unitId,
      side: own ? 'A' : 'B',
      slot: 0,
      species_id: 1,
      level: 5,
      stats: UNIT_STATS,
      pos: { x, y },
      cur_hp: 31,
      status: null,
      budget: { ap: 6, strides_used: 0, attacks: 0, last: null },
      guard: false,
      first_stand: false,
      state: 'Active',
      stance: own ? null : 'Aggressive',
      wild_index: own ? null : 0,
    },
  };
}

/** A RoundEnded transcript row: one ticker line each. */
function roundEvent(battleId: bigint, seq: number): StoreBattleEvent {
  return {
    eventId: battleId * 100n + BigInt(seq),
    battleId,
    seq,
    round: 1,
    payload: { tag: 'RoundEnded', value: { round: seq + 1 } },
  };
}

/** ME adopted, a no-op command port and the battle port as the boot installs it, the frame mounted. */
function boot(m: Loaded): void {
  m.cp.installCommandPort({ dispatch: () => Promise.resolve(), applyStack: () => {} });
  m.bf.installBattlePort({
    stack: () => m.frames.contextStack,
    clearOutcomeEdge: m.frames.clearOutcomeEdge,
  });
  m.session.adoptIdentity(ME);
  const el = document.createElement('div');
  document.body.append(el);
  m.bf.mountBattleFrame(el);
}

/** A PvP battle shows its deploy panel, then ends won by side A: the results panel takes the frame. */
function showResults(m: Loaded, battleId: bigint): void {
  m.session.store.upsertMonster(ownMonster(P));
  m.session.store.upsertBattle(anchor(battleId, 'Ongoing'));
  m.session.store.reconcileTacticalBattlesFromView([tactical(battleId, 'Pvp', 'Deploying')]);
  m.bf.refreshBattle();
  m.session.store.upsertBattle(anchor(battleId, 'SideAWins'));
  m.session.store.reconcileTacticalBattlesFromView([tactical(battleId, 'Pvp', 'Finished')]);
  m.bf.refreshBattle();
}

/** The results panel shows and the sync stamps the outcome edge at `edgeMs`. */
async function outcomeEdgeAt(edgeMs: number): Promise<Loaded> {
  const m = await fresh();
  boot(m);
  vi.spyOn(performance, 'now').mockReturnValue(edgeMs);
  showResults(m, 31n);
  expect(m.bf.resultsPanel?.visible, 'fixture: the results panel shows').toBe(true);
  m.frames.syncStack();
  expect(m.frames.outcomeShownAtMs, 'fixture: the sync stamps the edge').toBe(edgeMs);
  return m;
}

/** A player frame's open whose probe reads its own shown flag; each hide is counted, and the stack
 *  it sees when it runs is recorded. */
function playerFrame(m: Loaded) {
  const state = { shown: false, hides: 0, stacksAtHide: [] as Stack[] };
  const open: FrameOpen = {
    probe: () => state.shown,
    hide: () => {
      state.hides += 1;
      state.stacksAtHide.push(m.frames.contextStack);
      state.shown = false;
    },
    view: () => undefined,
  };
  const show = (): void => {
    state.shown = true;
  };
  return { state, open, show };
}

function openPlayer(m: Loaded, id: FrameId): ReturnType<typeof playerFrame> {
  const f = playerFrame(m);
  m.frames.openFrame(id, f.open, f.show);
  return f;
}

const WORLD: Stack = [{ kind: 'world' }];

describe('shell/frames', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    vi.resetModules();
  });

  it('exports exactly the twenty-eight runtime names, with the owner functions typed as contracted', async () => {
    // expectTypeOf is checked by tsc over the test files and does nothing at run time.
    expectTypeOf<keyof FramesModule>().toEqualTypeOf<
      | 'clearOutcomeEdge'
      | 'closeLeftFocusAdrift'
      | 'contextStack'
      | 'focusAdrift'
      | 'focusInsideHiddenSubtree'
      | 'frameOpenOf'
      | 'hideFrame'
      | 'inHiddenSubtree'
      | 'menuPlace'
      | 'movementGate'
      | 'openFrame'
      | 'openSeated'
      | 'outcomeShownAtMs'
      | 'overlayVerdict'
      | 'panelShown'
      | 'pumpCareReadiness'
      | 'reconcileStack'
      | 'screenHost'
      | 'shownOverlays'
      | 'socialPanelView'
      | 'sweepForReconnect'
      | 'syncStack'
      | 'takeResultsAutoContinue'
      | 'topOverlay'
      | 'topSocialFrame'
      | 'upperIds'
      | 'worldBaseLive'
      | 'worldIsBare'
    >();
    expectTypeOf<FrameOpen>().toEqualTypeOf<{
      readonly probe: () => boolean;
      readonly hide: () => void;
      readonly view: () => unknown;
    }>();
    expectTypeOf<FramesModule['clearOutcomeEdge']>().toEqualTypeOf<() => void>();
    expectTypeOf<FramesModule['takeResultsAutoContinue']>().toEqualTypeOf<
      (now: number) => boolean
    >();
    expectTypeOf<FramesModule['sweepForReconnect']>().toEqualTypeOf<() => void>();
    expectTypeOf<FramesModule['pumpCareReadiness']>().toEqualTypeOf<(now: number) => void>();
    expectTypeOf<FramesModule['contextStack']>().toEqualTypeOf<Stack>();
    expectTypeOf<FramesModule['outcomeShownAtMs']>().toEqualTypeOf<number | null>();
    expectTypeOf<FramesModule['closeLeftFocusAdrift']>().toEqualTypeOf<boolean>();
    const m = await fresh();
    expect(Object.keys(m.frames).sort()).toEqual(EXPORTS);
  });

  it('the two gates are exported under their own function names', async () => {
    const m = await fresh();
    expect(m.frames.movementGate.name).toBe('movementGate');
    expect(m.frames.worldBaseLive.name).toBe('worldBaseLive');
  });

  it('importing the module registers no store, window or document listener and writes nothing to the document', async () => {
    vi.resetModules();
    // Its shell neighbours load first, so the import below evaluates the module's own scope.
    const session = await import('./session');
    await import('./views');
    await import('./feedback');
    await import('./inputState');
    await import('./screenContext');
    await import('./battleFrame');
    await import('./commandPort');
    const onBatch = vi.spyOn(session.store, 'onBatchApplied');
    document.body.innerHTML = '<p id="sentinel">x</p>';
    const head = document.head.innerHTML;

    // Undone by assigning the saved function back: on the global `window`, addEventListener is an
    // own accessor, so restoring a property descriptor would leave this wrapper in place.
    const seen: string[] = [];
    type Adder = { addEventListener: EventTarget['addEventListener'] };
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
        seen.push(type);
        previous.call(target, type, handler, options);
      };
      undo.push(() => {
        if (hadOwn) (target as Adder).addEventListener = previous;
        else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
      });
    }
    try {
      const probe = (): void => undefined;
      window.addEventListener('mr-probe', probe);
      window.removeEventListener('mr-probe', probe);
      expect(seen, 'precondition: the listener observer sees a probe').toEqual(['mr-probe']);
      seen.length = 0;

      await import('./frames');
      expect(seen).toEqual([]);
      expect(onBatch).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe('<p id="sentinel">x</p>');
      expect(document.head.innerHTML).toBe(head);
    } finally {
      for (const u of undo) u();
    }
  });

  it('a fresh module holds the bare world stack, no outcome edge and no adrift close, and shows nothing', async () => {
    const m = await fresh();
    expect(m.frames.contextStack).toEqual([{ kind: 'world' }]);
    expect(m.frames.outcomeShownAtMs).toBeNull();
    expect(m.frames.closeLeftFocusAdrift).toBe(false);
    expect(m.frames.upperIds()).toEqual([]);
    expect(m.frames.menuPlace()).toBe('absent');
    expect(m.frames.topOverlay()).toBeNull();
    expect(m.frames.worldIsBare()).toBe(true);
  });

  describe('clearOutcomeEdge', () => {
    it('nulls the stamped outcome edge', async () => {
      const m = await outcomeEdgeAt(50_000);
      m.frames.clearOutcomeEdge();
      expect(m.frames.outcomeShownAtMs).toBeNull();
    });

    it('forgets the edge the auto-advance fired for: the same edge re-stamped fires again', async () => {
      const m = await outcomeEdgeAt(50_000);
      expect(m.frames.takeResultsAutoContinue(53_000), 'fixture: the edge fires').toBe(true);
      expect(m.frames.takeResultsAutoContinue(54_000), 'fixture: once per edge').toBe(false);
      m.frames.clearOutcomeEdge();
      m.frames.syncStack();
      expect(m.frames.outcomeShownAtMs, 'fixture: the sync re-stamps the same edge').toBe(50_000);
      expect(m.frames.takeResultsAutoContinue(53_000)).toBe(true);
    });

    it('through the battle port, a Finished batch whose results wait for the playback nulls the stamped edge', async () => {
      const m = await fresh();
      boot(m);
      vi.spyOn(performance, 'now').mockReturnValue(40_000);
      const store = m.session.store;
      store.upsertMonster(ownMonster(P));
      store.upsertBattle(anchor(71n, 'Ongoing', WILD));
      store.reconcileBattleUnitsFromView([unit(71n, 61, true, 1, 1), unit(71n, 62, false, 1, 5)]);
      store.reconcileTacticalBattlesFromView([tactical(71n, 'Wild', 'Active')]);
      store.reconcileBattleEventsFromView([roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      expect(m.bf.tacticsBattle?.visible, 'fixture: the shell shows battle 71').toBe(true);
      store.upsertBattle(anchor(71n, 'SideAWins', WILD));
      store.reconcileTacticalBattlesFromView([tactical(71n, 'Wild', 'Finished')]);
      store.reconcileBattleEventsFromView([roundEvent(71n, 0), roundEvent(71n, 1)]);
      // The batch syncs before it refreshes the battle, as the boot's batch listeners run.
      m.frames.syncStack();
      expect(m.frames.outcomeShownAtMs, 'fixture: the sync stamps the edge').toBe(40_000);
      m.bf.refreshBattle();
      expect(m.bf.resultsAwaitDrain, 'fixture: the results wait').toBe(71n);
      expect(m.frames.outcomeShownAtMs).toBeNull();
    });
  });

  describe('takeResultsAutoContinue', () => {
    it('is false while no outcome edge is stamped, the results panel shown', async () => {
      const m = await fresh();
      boot(m);
      vi.spyOn(performance, 'now').mockReturnValue(50_000);
      showResults(m, 31n);
      expect(m.bf.resultsPanel?.visible, 'fixture: the results panel shows').toBe(true);
      expect(m.frames.outcomeShownAtMs).toBeNull();
      expect(m.frames.takeResultsAutoContinue(90_000)).toBe(false);
    });

    it('is false 2999 ms after the edge, then true at 3000 ms', async () => {
      const m = await outcomeEdgeAt(50_000);
      expect(m.frames.takeResultsAutoContinue(50_000 + 2999)).toBe(false);
      expect(m.frames.takeResultsAutoContinue(50_000 + 3000)).toBe(true);
    });

    it('fires once per edge: a later call for the same edge is false', async () => {
      const m = await outcomeEdgeAt(50_000);
      expect(m.frames.takeResultsAutoContinue(53_000), 'fixture: the edge fires').toBe(true);
      expect(m.frames.takeResultsAutoContinue(53_000)).toBe(false);
      expect(m.frames.takeResultsAutoContinue(99_000)).toBe(false);
    });

    it('is false past the cap while the results panel is hidden, and true once it shows again', async () => {
      const m = await outcomeEdgeAt(50_000);
      m.bf.resultsPanel?.hide();
      expect(m.frames.takeResultsAutoContinue(60_000)).toBe(false);
      m.bf.resultsPanel?.show();
      expect(m.frames.takeResultsAutoContinue(60_000)).toBe(true);
    });

    it('fires again for a new edge: a frame over the outcome closes and the outcome is re-stamped', async () => {
      const m = await outcomeEdgeAt(50_000);
      expect(m.frames.takeResultsAutoContinue(53_000), 'fixture: the first edge fires').toBe(true);
      const help = openPlayer(m, 'helpView');
      expect(
        m.frames.outcomeShownAtMs,
        'fixture: a frame over the outcome nulls the edge',
      ).toBeNull();
      vi.spyOn(performance, 'now').mockReturnValue(70_000);
      help.state.shown = false;
      m.frames.syncStack();
      expect(m.frames.outcomeShownAtMs, 'fixture: the outcome is re-stamped').toBe(70_000);
      expect(m.frames.takeResultsAutoContinue(70_000 + 2999)).toBe(false);
      expect(m.frames.takeResultsAutoContinue(70_000 + 3000)).toBe(true);
    });
  });

  describe('sweepForReconnect', () => {
    it('pops a reconnect-closing frame and closes it through its own hide, once, on the swept stack', async () => {
      const m = await fresh();
      const menu = openPlayer(m, 'menuView');
      expect(m.frames.upperIds(), 'fixture: the menu is on the stack').toEqual(['menuView']);
      m.frames.sweepForReconnect();
      expect(m.frames.contextStack).toEqual(WORLD);
      expect(menu.state.hides).toBe(1);
      expect(menu.state.stacksAtHide).toEqual([WORLD]);
    });

    it('pops a frame opened over a battle, even one a reconnect otherwise keeps, and leaves the battle base', async () => {
      const m = await fresh();
      m.session.adoptIdentity(ME);
      m.session.store.upsertBattle(anchor(91n, 'Ongoing'));
      m.frames.syncStack();
      const help = openPlayer(m, 'helpView');
      expect(m.frames.contextStack, 'fixture: help is stamped with the battle').toEqual([
        { kind: 'battle', battleId: '91' },
        { kind: 'screen', id: 'helpView', overBattle: '91' },
      ]);
      m.frames.sweepForReconnect();
      expect(m.frames.contextStack).toEqual([{ kind: 'battle', battleId: '91' }]);
      expect(help.state.hides).toBe(1);
    });

    it('syncs first: a dialogue shown since the last sync is on the stack afterwards and is never hidden', async () => {
      const m = await fresh();
      const dialogue = { visible: false, hide: vi.fn(() => undefined) };
      m.views.mountViews({ dialogueView: dialogue as unknown as ViewHandles['dialogueView'] });
      dialogue.visible = true;
      m.frames.sweepForReconnect();
      expect(m.frames.contextStack).toEqual([
        { kind: 'world' },
        { kind: 'screen', id: 'dialogueView' },
      ]);
      expect(dialogue.hide).not.toHaveBeenCalled();
    });

    it('keeps the frames a reconnect keeps, unhidden, while it closes the menu above them', async () => {
      const m = await fresh();
      const box = openPlayer(m, 'boxView');
      const quests = openPlayer(m, 'questLogView');
      const help = openPlayer(m, 'helpView');
      const menu = openPlayer(m, 'menuView');
      m.frames.sweepForReconnect();
      expect(m.frames.upperIds()).toEqual(['boxView', 'questLogView', 'helpView']);
      expect(box.state.hides).toBe(0);
      expect(quests.state.hides).toBe(0);
      expect(help.state.hides).toBe(0);
      expect(menu.state.hides).toBe(1);
    });

    it('resets the input repeat once when the sweep shrinks the stack', async () => {
      const m = await fresh();
      openPlayer(m, 'menuView');
      const resetRepeat = vi.spyOn(m.inputState.inputRouter, 'resetRepeat');
      m.frames.sweepForReconnect();
      expect(resetRepeat).toHaveBeenCalledTimes(1);
    });

    it('does not reset the input repeat when nothing is swept', async () => {
      const m = await fresh();
      openPlayer(m, 'helpView');
      const resetRepeat = vi.spyOn(m.inputState.inputRouter, 'resetRepeat');
      m.frames.sweepForReconnect();
      expect(m.frames.upperIds(), 'fixture: nothing is swept').toEqual(['helpView']);
      expect(resetRepeat).not.toHaveBeenCalled();
    });
  });

  describe('pumpCareReadiness', () => {
    it('with the box open, observes the stack every 1000 ms of the frame clock passed in', async () => {
      const m = await fresh();
      vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
      openPlayer(m, 'boxView');
      const observe = vi.spyOn(m.frames.screenHost, 'observe').mockImplementation(() => undefined);
      m.frames.pumpCareReadiness(999);
      expect(observe).not.toHaveBeenCalled();
      m.frames.pumpCareReadiness(1000);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0]?.[0]).toBe(m.frames.contextStack);
      expect(observe.mock.calls[0]?.[1]).toBe(m.screenContext.screenCtx);
      m.frames.pumpCareReadiness(1999);
      expect(observe).toHaveBeenCalledTimes(1);
      m.frames.pumpCareReadiness(2000);
      expect(observe).toHaveBeenCalledTimes(2);
    });

    it('without the box open, observes nothing and keeps the clock: opening it then observes at once', async () => {
      const m = await fresh();
      vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
      const observe = vi.spyOn(m.frames.screenHost, 'observe').mockImplementation(() => undefined);
      m.frames.pumpCareReadiness(1500);
      expect(observe).not.toHaveBeenCalled();
      openPlayer(m, 'boxView');
      m.frames.pumpCareReadiness(1501);
      expect(observe).toHaveBeenCalledTimes(1);
    });
  });
});
