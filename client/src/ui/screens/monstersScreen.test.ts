// ui/screens/monstersScreen.test.ts — ctl-8b (CTL8B.1-.4): the Monsters frame's pure adapter.
//
// Node env, no DOM. `monstersScreen` is driven only through `viewModel(ctx)`, `init(vm)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)` into a
// recording fake view. Claims about the tab, the cursor, the sheet, the summary, the typing row,
// the commit token and the feedback line are read off `state.nav` / `state.phase` / `state.commit` /
// `state.feedback` and off the one `MonstersPaint` a paint hands the view; the state is never
// deep-compared (it may hold fields the contract does not name).
//
// The game-core constants are the REAL wasm exports (`party_size()`, `party_slot_none()`), not
// literals: the fixtures place monsters in slots 0.. and in the sentinel slot through them, and
// the Move command is read against a view model built with ANOTHER sentinel (77), so an adapter
// that inlines the canonical value instead of using the one the view model carries fails.
//
// The fixture world (all the player's own, store order):
//   party    11 'Kip' (Sproutle, slot 0), 12 (Emberfang, slot 1)
//   storage  21, 22, 23, 24, 25 (Sproutle / Emberfang alternating; no nickname), a 3-wide grid:
//              21 22 23
//              24 25
//
// The contract (plan, "Functional core / imperative shell"):
//   list      opens on the STORAGE tab, first monster. D-pad / LB / RB move the nav kit (wrap on a
//             fresh press, clamp on a repeat; each tab keeps its cursor). A on a monster opens its
//             sheet (Summary first); B pops; Start pops to the base; Select toggles help.
//   sheet     Up / Down over SHEET_ACTIONS (wrap). A: Summary -> summary, Nickname -> nickname (a
//             fresh edit number), Move -> setPartySlot, back on the list. B -> the list with the
//             cursor on that monster.
//   summary   B (or A) -> the sheet.
//   nickname  A commits (a one-shot token carrying the monster id and its live nickname) and goes
//             back to the sheet; B goes back to the sheet; the rest is swallowed (Start still
//             pops to the base).
//   observe   re-seats the cursor against the new layout, drops a phase whose monster vanished,
//             resolves a pending Move to a feedback line when the monster shows in the target tab,
//             and answers the SAME state when nothing changed.
import { describe, expect, it } from 'vitest';
import { party_size, party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreEvolutionPath,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../../net/store';
import type { BoxView } from '../boxView';
import {
  buildMonstersVm,
  findMonster,
  type MonstersVm,
  monsterKey,
  SHEET_ACTIONS,
  STORAGE_COLS,
} from '../monstersModel';
import type { NavInput } from '../nav';
import { type MonstersPaint, type MonstersScreenState, monstersScreen } from './monstersScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const ME = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
/** game-core's party size and boxed sentinel: the wasm exports, never literals. */
const PARTY_SIZE = party_size();
const NONE = party_slot_none();

const ESSENCE_NAMES: readonly AffinityName[] = [
  'Fire',
  'Water',
  'Plant',
  'Electric',
  'Earth',
  'Wind',
  'Light',
  'Dark',
];

function mon(
  monsterId: bigint,
  partySlot: number,
  speciesId = 1,
  nickname = '',
  ownerIdentity = ME,
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity,
    speciesId,
    nickname,
    level: 5,
    xp: 0,
    currentHp: 30,
    statHp: 40,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot,
    tier: 0,
    essence: Object.fromEntries(ESSENCE_NAMES.map((n) => [n, 0])) as unknown as EssenceByAffinity,
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

function species(id: number, name: string): StoreSpeciesRow {
  return {
    id,
    name,
    baseHp: 45,
    baseAttack: 49,
    baseDefense: 49,
    baseSpeed: 45,
    baseSpAttack: 65,
    baseSpDefense: 65,
    affinity: 'Fire',
    learnableSkillIds: [],
  };
}

const SPECIES: readonly StoreSpeciesRow[] = [species(1, 'Sproutle'), species(2, 'Emberfang')];

/** What the fake store holds; a case edits it between view models as a batch would. */
interface World {
  monsters: readonly StoreMonsterPub[];
  paths: readonly StoreEvolutionPath[];
}

function world(over: Partial<World> = {}): World {
  return {
    monsters: [
      mon(11n, 0, 1, 'Kip'),
      mon(12n, 1, 2),
      mon(21n, NONE, 1),
      mon(22n, NONE, 2),
      mon(23n, NONE, 1),
      mon(24n, NONE, 2),
      mon(25n, NONE, 1),
    ],
    paths: [],
    ...over,
  };
}

/** The same world with one monster in `slot`. */
const placed = (w: World, id: bigint, slot: number): World => ({
  ...w,
  monsters: w.monsters.map((m) => (m.monsterId === id ? { ...m, partySlot: slot } : m)),
});
/** The same world without monster `id`. */
const without = (w: World, id: bigint): World => ({
  ...w,
  monsters: w.monsters.filter((m) => m.monsterId !== id),
});
/** The same world with monster `id` carrying `nickname`. */
const renamed = (w: World, id: bigint, nickname: string): World => ({
  ...w,
  monsters: w.monsters.map((m) => (m.monsterId === id ? { ...m, nickname } : m)),
});

function ctxOf(w: World): ScreenContext {
  const store = {
    // The player's own monsters only, as the real store filters by identity.
    ownMonsters: (identity: string) =>
      identity === ME
        ? w.monsters.filter((m) => m.ownerIdentity === ME).map((m) => ({ ...m }))
        : [],
    speciesMap: () => new Map(SPECIES.map((s) => [s.id, s])),
    evolutionPaths: () => w.paths.values(),
  };
  return {
    store,
    identity: ME,
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: null,
    healLocationId: null,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

const vmOf = (w: World): MonstersVm => monstersScreen.viewModel(ctxOf(w));

function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`fixture: no item ${i}`);
  return item;
}
const storageKey = (vm: MonstersVm, i: number): string => monsterKey(at(vm.storage, i).monsterId);
const partyKey = (vm: MonstersVm, i: number): string => monsterKey(at(vm.party, i).monsterId);
function cardOf(vm: MonstersVm, id: bigint) {
  const found = findMonster(vm, id);
  if (found === undefined) throw new Error(`fixture: monster ${id} is in neither list`);
  return found.card;
}

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (input: Input): NavInput =>
  typeof input === 'string' ? { button: input, repeat: false } : input;
const label = (input: Input): string =>
  typeof input === 'string' ? input : `${input.button}${input.repeat ? ' (repeat)' : ''}`;

const press = (
  vm: MonstersVm,
  state: MonstersScreenState,
  input: Input,
): ButtonStep<MonstersScreenState> => monstersScreen.onButton(vm, state, asInput(input));

/** Feed `inputs` in order, each answered 'consumed' (no command), and return the last state. */
function swallowed(
  vm: MonstersVm,
  state: MonstersScreenState,
  inputs: readonly Input[],
): MonstersScreenState {
  let s = state;
  for (const input of inputs) {
    const step = press(vm, s, input);
    expect(step.result, `${label(input)} is swallowed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

function observe(vm: MonstersVm, state: MonstersScreenState): MonstersScreenState {
  if (monstersScreen.observe === undefined) throw new Error('monstersScreen must define observe');
  return monstersScreen.observe(vm, state, 0);
}

/** The one paint `paint(view, vm, state)` hands the view. */
function paintOf(vm: MonstersVm, state: MonstersScreenState): MonstersPaint {
  const out: MonstersPaint[] = [];
  const view = {
    paint: (p: MonstersPaint) => {
      out.push(p);
    },
  } as unknown as BoxView;
  if (monstersScreen.paint === undefined) throw new Error('monstersScreen must define paint');
  monstersScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as MonstersPaint;
}

/** `{ tab, item }` of the nav state: where the cursor is. */
const cursorOf = (s: MonstersScreenState): { tab: string | null; item: string | null } => ({
  tab: s.nav.tab,
  item: s.nav.item,
});

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

/** The buttons that open the sheet on the cursor's monster and walk it to the action. */
const SHEET_STEPS: Readonly<Record<'summary' | 'nickname' | 'move', readonly Input[]>> = {
  summary: ['A'],
  nickname: ['A', 'Down'],
  move: ['A', 'Down', 'Down'],
};

describe('monstersScreen — opens on Storage (ctl-8b, CTL8B.4)', () => {
  it('CTL8B-4-INIT-STORAGE: init opens the frame on the Storage tab with the cursor on the first storage monster, the list phase, no commit and no feedback; with an empty Storage the tab is still Storage and no monster is under the cursor; the first paint is that opening', () => {
    // WRONG IMPL KILLED: a frame that opens on Party (the first tab: KeyB would show the party
    // first, against CTL8B.4), one with the cursor on the first PARTY monster or on no row, one
    // that opens in a sheet or with a commit token / feedback line left from the last visit, an
    // empty Storage that falls back to the Party tab (the player pressed KeyB for the box), a
    // cursor on a missing key (null must stand for "nothing"), and a first paint that is not the
    // opening (the view would draw the state the shell never opened).
    expect(monstersScreen.nav, 'the frame takes the D-pad').toBe(true);
    const w = world();
    const vm = vmOf(w);
    const opened = monstersScreen.init(vm);
    expect(opened.nav.tab, 'the Storage tab').toBe('storage');
    expect(opened.nav.item, 'the first storage monster').toBe(storageKey(vm, 0));
    expect(opened.nav.item).toBe('21');
    expect(opened.phase.kind).toBe('list');
    expect(opened.commit, 'no commit token on open').toBeNull();
    expect(opened.feedback, 'no feedback on open').toBeNull();
    expect(paintOf(vm, opened), 'the opening paint').toEqual({
      tab: 'storage',
      activeKey: '21',
      sheet: null,
      summary: null,
      nickname: null,
      commit: null,
      feedback: null,
    });

    // Empty Storage, a party of two: still the Storage tab, nothing under the cursor.
    const noBox = vmOf(world({ monsters: [mon(11n, 0), mon(12n, 1)] }));
    const emptyBox = monstersScreen.init(noBox);
    expect(emptyBox.nav.tab, 'still Storage').toBe('storage');
    expect(emptyBox.nav.item, 'no storage monster: no key').toBeNull();
    expect(paintOf(noBox, emptyBox)).toMatchObject({ tab: 'storage', activeKey: null });

    // No monsters at all.
    const nobody = vmOf(world({ monsters: [] }));
    const none = monstersScreen.init(nobody);
    expect(cursorOf(none)).toEqual({ tab: 'storage', item: null });
  });

  it('monstersScreen.viewModel builds the player`s own Party and Storage with the game-core party size and sentinel and the store`s evolution paths, and ignores every other identity`s monsters', () => {
    // WRONG IMPL KILLED: a view model built from another identity's rows (a store that held a
    // foreign monster would list it), one that drops the evolution paths (the badge never shows),
    // one built with a literal party size or sentinel, and one that carries the wrong sentinel.
    const edges: StoreEvolutionPath[] = [1, 2].map((i) => ({
      pathId: BigInt(i),
      edgeId: i,
      fromSpecies: 1,
      toSpecies: i + 1,
      minLevel: 1,
      essence: [],
      minTrustTier: null,
      minQualityTimeTier: null,
      minNutritionPct: null,
    }));
    const w = world({ paths: edges });
    w.monsters = [...w.monsters, mon(99n, NONE, 1, '', OTHER)];
    const vm = vmOf(w);
    const expected = buildMonstersVm(
      w.monsters.filter((m) => m.ownerIdentity === ME),
      new Map(SPECIES.map((s) => [s.id, s])),
      PARTY_SIZE,
      NONE,
      edges,
    );
    expect(vm).toEqual(expected);
    expect(vm.partySlotNone, 'the sentinel is game-core`s').toBe(NONE);
    expect(vm.party.map((c) => c.monsterId)).toEqual([11n, 12n]);
    expect(vm.storage.map((c) => c.monsterId)).toEqual([21n, 22n, 23n, 24n, 25n]);
    expect(
      vm.storage.some((c) => c.monsterId === 99n),
      'another identity`s monster is not listed',
    ).toBe(false);
    expect(vm.party[0]?.evolutionChoicePending, 'the paths reach the cards').toBe(true);
  });
});

describe('monstersScreen — tabs and cursor (ctl-8b, CTL8B.1)', () => {
  it('CTL8B-1-LBRB-SWITCH: RB and LB switch between Storage and Party, wrapping at the ends in both directions, each answered consumed with no command; a repeat clamps at the ends instead of wrapping', () => {
    // WRONG IMPL KILLED: RB / LB that do nothing, switch only one way (RB works, LB is stuck), do
    // not wrap (a fresh RB on the last tab goes nowhere: with two tabs the player could never get
    // back to Party by RB), wrap on a held repeat (a held PageDown would flicker between tabs),
    // are answered `unhandled` (the page keeps PageUp / PageDown and scrolls), or issue a command.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);

    const toParty = press(vm, opened, 'RB');
    expect(toParty.result, 'RB is swallowed').toBe('consumed');
    expect(toParty.state.nav.tab, 'RB on the last tab wraps to the first: Party').toBe('party');
    const back = press(vm, toParty.state, 'RB');
    expect(back.result).toBe('consumed');
    expect(back.state.nav.tab, 'RB on Party: Storage').toBe('storage');

    const lbFromStorage = press(vm, opened, 'LB');
    expect(lbFromStorage.result, 'LB is swallowed').toBe('consumed');
    expect(lbFromStorage.state.nav.tab, 'LB on Storage: Party').toBe('party');
    const lbFromParty = press(vm, lbFromStorage.state, 'LB');
    expect(lbFromParty.result).toBe('consumed');
    expect(lbFromParty.state.nav.tab, 'LB on the first tab wraps to the last: Storage').toBe(
      'storage',
    );

    // The paint follows the tab.
    expect(paintOf(vm, toParty.state).tab).toBe('party');
    expect(paintOf(vm, back.state).tab).toBe('storage');

    // A repeat clamps: RB on the last tab stays, LB moves on, and a repeat RB from Party moves.
    expect(swallowed(vm, opened, [rep('RB')]).nav.tab, 'a repeat RB on Storage stays').toBe(
      'storage',
    );
    expect(swallowed(vm, opened, [rep('LB')]).nav.tab, 'a repeat LB moves to Party').toBe('party');
    expect(
      swallowed(vm, toParty.state, [rep('LB')]).nav.tab,
      'a repeat LB on the first tab stays',
    ).toBe('party');
    expect(swallowed(vm, toParty.state, [rep('RB')]).nav.tab, 'a repeat RB moves to Storage').toBe(
      'storage',
    );
  });

  it('CTL8B-1-PER-TAB-MEMORY: the cursor each tab was left on is where it comes back: move in Storage, switch to Party, move there, switch back and the Storage cursor is restored, and the Party cursor is restored in turn; a tab never visited opens on its first monster', () => {
    // WRONG IMPL KILLED: a tab switch that resets the other tab's cursor to its first monster (the
    // player loses their place every time they glance at the Party), one that carries the
    // cursor's INDEX across (item 4 of Storage landing on item 4 of a 2-monster party), one that
    // remembers only one tab, one that shows the new tab's cursor in the paint but not in the
    // state (or the reverse), and a first visit that lands on no row.
    const vm = vmOf(world());
    let s = monstersScreen.init(vm);
    s = swallowed(vm, s, ['Down', 'Right']);
    expect(cursorOf(s), 'Storage: Down then Right = 25').toEqual({ tab: 'storage', item: '25' });

    s = swallowed(vm, s, ['RB']);
    expect(cursorOf(s), 'Party opens on its first monster').toEqual({
      tab: 'party',
      item: partyKey(vm, 0),
    });
    expect(paintOf(vm, s)).toMatchObject({ tab: 'party', activeKey: '11' });
    s = swallowed(vm, s, ['Down']);
    expect(cursorOf(s)).toEqual({ tab: 'party', item: '12' });

    s = swallowed(vm, s, ['LB']);
    expect(cursorOf(s), 'back on Storage: the cursor it was left on').toEqual({
      tab: 'storage',
      item: '25',
    });
    expect(paintOf(vm, s)).toMatchObject({ tab: 'storage', activeKey: '25' });
    s = swallowed(vm, s, ['RB']);
    expect(cursorOf(s), 'and Party keeps its own').toEqual({ tab: 'party', item: '12' });
    expect(paintOf(vm, s)).toMatchObject({ tab: 'party', activeKey: '12' });
    s = swallowed(vm, s, ['RB']);
    expect(cursorOf(s)).toEqual({ tab: 'storage', item: '25' });
  });

  it('CTL8B-1-STORAGE-GRID: in Storage, Down and Up move by STORAGE_COLS (one grid row) and Left and Right by one monster, wrapping on a fresh press and clamping on a repeat; in the Party list Down and Up move one monster and Left and Right do nothing, all swallowed', () => {
    // WRONG IMPL KILLED: a Storage that is a flat list (Down would walk the grid one monster at a
    // time and Left / Right do nothing), a column count other than the three the box draws, a
    // Right that jumps a row, no wrap (the cursor sticks at the last monster), a wrap on a repeat,
    // a Party that treats Left / Right as moves, and a D-pad press answered `unhandled`.
    expect(STORAGE_COLS, 'the three columns the box draws').toBe(3);
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);
    const itemAfter = (inputs: readonly Input[], from = opened): string | null =>
      swallowed(vm, from, inputs).nav.item;

    // 21 22 23 / 24 25
    expect(itemAfter(['Down']), 'Down: one grid row').toBe('24');
    expect(itemAfter(['Down', 'Up'])).toBe('21');
    expect(itemAfter(['Right']), 'Right: one monster').toBe('22');
    expect(itemAfter(['Right', 'Right'])).toBe('23');
    expect(itemAfter(['Right', 'Right', 'Right']), 'a fresh Right wraps the row').toBe('21');
    expect(itemAfter(['Left']), 'a fresh Left wraps the row').toBe('23');
    expect(itemAfter(['Right', 'Down']), 'column kept: 22 down is 25').toBe('25');
    expect(itemAfter(['Down', 'Down']), 'a fresh Down wraps the column').toBe('21');
    expect(itemAfter(['Down', 'Right']), 'the short last row wraps at 25').toBe('25');
    expect(itemAfter(['Down', 'Right', 'Right']), 'and returns to 24').toBe('24');
    expect(itemAfter([rep('Left')]), 'a repeat Left at the row start stays').toBe('21');
    expect(itemAfter(['Down', rep('Down')]), 'a repeat Down at the last row stays').toBe('24');
    expect(itemAfter(['Up']), 'a fresh Up wraps to the last row').toBe('24');
    expect(itemAfter([rep('Up')]), 'a repeat Up stays').toBe('21');
    expect(itemAfter(['Right', 'Down', 'Down']), 'Down past the bottom of column 2 wraps').toBe(
      '22',
    );

    // Party: a list. Up / Down by one, Left / Right nothing; everything swallowed.
    const inParty = swallowed(vm, opened, ['RB']);
    expect(inParty.nav.item).toBe('11');
    expect(itemAfter(['Down'], inParty), 'Down: the next monster').toBe('12');
    expect(itemAfter(['Down', 'Down'], inParty), 'a fresh Down wraps').toBe('11');
    expect(itemAfter(['Up'], inParty), 'a fresh Up wraps').toBe('12');
    expect(itemAfter([rep('Up')], inParty), 'a repeat Up stays').toBe('11');
    expect(itemAfter(['Down', rep('Down')], inParty), 'a repeat Down at the end stays').toBe('12');
    for (const input of ['Left', 'Right', rep('Left'), rep('Right')] as const) {
      const step = press(vm, inParty, input);
      expect(step.result, `${label(input)} in a list is swallowed`).toBe('consumed');
      expect(step.state.nav.item, `${label(input)} moves nothing in a list`).toBe('11');
    }
  });

  it('a D-pad press that moves nothing is still swallowed with the cursor unmoved: on an empty Storage and on a one-monster list; and Y and X in the list phase are not the screen`s', () => {
    // WRONG IMPL KILLED: a D-pad press with no row to move to that throws, is `unhandled` (the
    // world would walk under the open frame) or invents a cursor, and a Y or X that is swallowed
    // (Y belongs to the page / a later slice; the screen must not eat it).
    const empty = vmOf(world({ monsters: [mon(11n, 0)] }));
    const opened = monstersScreen.init(empty);
    for (const input of ['Up', 'Down', 'Left', 'Right'] as const) {
      const step = press(empty, opened, input);
      expect(step.result, `${input} on an empty Storage`).toBe('consumed');
      expect(step.state.nav.item, `${input}: still no monster`).toBeNull();
    }
    const party = swallowed(empty, opened, ['RB']);
    expect(party.nav.item).toBe('11');
    for (const input of ['Up', 'Down', 'Left', 'Right'] as const) {
      const step = press(empty, party, input);
      expect(step.result, `${input} on one monster`).toBe('consumed');
      expect(step.state.nav.item, `${input}: still on it`).toBe('11');
    }
    for (const input of ['Y', 'X'] as const) {
      expect(press(empty, opened, input).result, `${input} in the list phase`).toBe('unhandled');
    }
  });
});

describe('monstersScreen — the action sheet (ctl-8b, CTL8B.2)', () => {
  it('CTL8B-2-A-OPENS-SHEET: A on a monster opens its action sheet on Summary, for that monster (Storage or Party) and no command; Up and Down walk Summary, Nickname, Move and wrap both ways; a repeat A and A on an empty Storage open nothing', () => {
    // WRONG IMPL KILLED: an A that opens nothing, opens the sheet for another monster (the first
    // one, or the Party's), opens it on Move (a second A would then move the monster), issues a
    // command at once, a sheet whose action list is another order or length, a walk that does not
    // wrap, a repeat A (a held key) that opens the sheet, and an A on an empty Storage that opens
    // a sheet for nothing.
    expect(SHEET_ACTIONS, 'the sheet`s actions, in display order').toEqual([
      'summary',
      'nickname',
      'move',
    ]);
    const w = world();
    const vm = vmOf(w);
    const opened = monstersScreen.init(vm);

    const a = press(vm, opened, 'A');
    expect(a.result, 'no command: the sheet is the screen`s').toBe('consumed');
    expect(a.state.phase).toMatchObject({ kind: 'sheet', monsterId: 21n, action: 'summary' });
    expect(paintOf(vm, a.state)).toMatchObject({
      tab: 'storage',
      activeKey: '21',
      sheet: { card: cardOf(vm, 21n), action: 'summary' },
      summary: null,
      nickname: null,
    });

    // The sheet is for the monster under the cursor: the third storage monster, a party monster.
    const third = swallowed(vm, opened, ['Right', 'Right', 'A']);
    expect(third.phase).toMatchObject({ kind: 'sheet', monsterId: 23n, action: 'summary' });
    const party = swallowed(vm, opened, ['RB', 'Down', 'A']);
    expect(party.phase).toMatchObject({ kind: 'sheet', monsterId: 12n, action: 'summary' });
    expect(paintOf(vm, party)).toMatchObject({
      tab: 'party',
      activeKey: '12',
      sheet: { card: cardOf(vm, 12n), action: 'summary' },
    });

    // Up / Down walk the actions and wrap.
    const actionOf = (s: MonstersScreenState): string | null =>
      s.phase.kind === 'sheet' ? s.phase.action : null;
    let s = a.state;
    const seen: (string | null)[] = [actionOf(s)];
    for (let i = 0; i < SHEET_ACTIONS.length; i++) {
      s = swallowed(vm, s, ['Down']);
      seen.push(actionOf(s));
    }
    expect(seen, 'Down walks the list and wraps back to Summary').toEqual([
      'summary',
      'nickname',
      'move',
      'summary',
    ]);
    expect(actionOf(swallowed(vm, a.state, ['Up'])), 'a fresh Up on Summary wraps to Move').toBe(
      'move',
    );
    expect(actionOf(swallowed(vm, a.state, ['Down', 'Up']))).toBe('summary');
    expect(paintOf(vm, swallowed(vm, a.state, ['Down'])).sheet?.action).toBe('nickname');
    // The sheet stays on its monster however it is walked.
    expect(swallowed(vm, a.state, ['Down', 'Down', 'Down']).phase).toMatchObject({
      kind: 'sheet',
      monsterId: 21n,
    });

    // A repeat A and an empty Storage open nothing.
    const held = press(vm, opened, rep('A'));
    expect(typeof held.result, 'a repeat A answers no command').toBe('string');
    expect(held.state.phase.kind, 'a repeat A opens no sheet').toBe('list');
    const noBox = vmOf(world({ monsters: [mon(11n, 0)] }));
    const emptyOpened = monstersScreen.init(noBox);
    const nothing = press(noBox, emptyOpened, 'A');
    expect(typeof nothing.result, 'A on an empty Storage answers no command').toBe('string');
    expect(nothing.state.phase.kind, 'and opens no sheet').toBe('list');
    expect(paintOf(noBox, nothing.state).sheet).toBeNull();
  });

  it('CTL8B-2-B-RETURNS-CURSOR: B in the sheet returns to the list with the cursor still on that monster (Storage grid and Party list alike) and swallows the press; B in the list pops the frame; Start pops to the base from every phase; Select toggles help from the list, the sheet and the summary', () => {
    // WRONG IMPL KILLED: a B in the sheet that pops the whole frame (the player loses the list), a
    // list that resets its cursor to the first monster on return, one that returns to the other
    // tab, a B in the list that is swallowed (no way out: B is the only back), a Start that is
    // swallowed in a sub-phase (the frame could not be left from the sheet), and a Select that is
    // lost.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);

    // Storage: walk to 24 (Down), open its sheet, move to Nickname, B.
    const onSheet = swallowed(vm, opened, ['Down', 'A', 'Down']);
    expect(onSheet.phase.kind).toBe('sheet');
    const back = press(vm, onSheet, 'B');
    expect(back.result, 'B in the sheet is swallowed').toBe('consumed');
    expect(back.state.phase.kind, 'back on the list').toBe('list');
    expect(cursorOf(back.state), 'on the monster the sheet was for').toEqual({
      tab: 'storage',
      item: '24',
    });
    expect(paintOf(vm, back.state)).toMatchObject({
      tab: 'storage',
      activeKey: '24',
      sheet: null,
      summary: null,
      nickname: null,
    });

    // Party: the second monster.
    const partySheet = swallowed(vm, opened, ['RB', 'Down', 'A']);
    const partyBack = press(vm, partySheet, 'B');
    expect(partyBack.result).toBe('consumed');
    expect(partyBack.state.phase.kind).toBe('list');
    expect(cursorOf(partyBack.state)).toEqual({ tab: 'party', item: '12' });

    // B at the list pops, in Storage and in Party, and on an empty list.
    expect(press(vm, back.state, 'B').result, 'B at the Storage list').toEqual(POP);
    expect(press(vm, partyBack.state, 'B').result, 'B at the Party list').toEqual(POP);
    const emptyVm = vmOf(world({ monsters: [] }));
    expect(press(emptyVm, monstersScreen.init(emptyVm), 'B').result, 'B with no monsters').toEqual(
      POP,
    );

    // Start and Select, from each phase.
    const summary = swallowed(vm, opened, ['A', 'A']);
    const nickname = swallowed(vm, opened, ['A', 'Down', 'A']);
    expect(summary.phase.kind).toBe('summary');
    expect(nickname.phase.kind).toBe('nickname');
    const phases: ReadonlyArray<readonly [string, MonstersScreenState]> = [
      ['list', opened],
      ['sheet', onSheet],
      ['summary', summary],
      ['nickname', nickname],
    ];
    for (const [name, s] of phases) {
      expect(press(vm, s, 'Start').result, `Start in the ${name} phase`).toEqual(POP_TO_BASE);
    }
    for (const [name, s] of phases) {
      if (name === 'nickname') continue; // the field owns the keys while typing
      expect(press(vm, s, 'Select').result, `Select in the ${name} phase`).toEqual(TOGGLE_HELP);
    }
  });

  it('CTL8B-2-SUMMARY: A on Summary opens the summary of that monster (painted as the summary card, no command), B returns to the sheet on Summary with the cursor on the monster, and the summary is the Party monster`s too', () => {
    // WRONG IMPL KILLED: a Summary that does nothing, a summary of another monster, a B in the
    // summary that closes the frame or drops to the list (the sheet is one level up), a summary
    // painted with no card, one that leaves the sheet painted over it as the only content, and a
    // summary that issues a command.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);

    const a = press(vm, swallowed(vm, opened, ['A']), 'A');
    expect(a.result, 'Summary issues no command').toBe('consumed');
    expect(a.state.phase).toMatchObject({ kind: 'summary', monsterId: 21n });
    expect(paintOf(vm, a.state).summary, 'the summary card is the monster`s').toEqual(
      cardOf(vm, 21n),
    );
    expect(paintOf(vm, a.state).nickname, 'no typing row').toBeNull();

    const b = press(vm, a.state, 'B');
    expect(b.result, 'B in the summary is swallowed').toBe('consumed');
    expect(b.state.phase).toMatchObject({ kind: 'sheet', monsterId: 21n, action: 'summary' });
    expect(paintOf(vm, b.state)).toMatchObject({
      sheet: { card: cardOf(vm, 21n), action: 'summary' },
      summary: null,
    });
    expect(cursorOf(b.state)).toEqual({ tab: 'storage', item: '21' });
    // And from the sheet B goes on to the list.
    expect(press(vm, b.state, 'B').state.phase.kind).toBe('list');

    // A Party monster's summary.
    const partySummary = swallowed(vm, opened, ['RB', 'Down', 'A', 'A']);
    expect(partySummary.phase).toMatchObject({ kind: 'summary', monsterId: 12n });
    expect(paintOf(vm, partySummary).summary).toEqual(cardOf(vm, 12n));

    // A also leaves the summary for the sheet (nothing in it to act on).
    const viaA = press(vm, a.state, 'A');
    expect(viaA.result).toBe('consumed');
    expect(viaA.state.phase).toMatchObject({ kind: 'sheet', monsterId: 21n, action: 'summary' });
  });

  it('CTL8B-2-MOVE-COMMAND: Move on a Party monster issues setPartySlot to the sentinel the view model carries, Move on a Storage monster issues setPartySlot to -1 (the next free slot), each for that monster, and the frame returns to the list on the same monster; a repeat A on Move issues nothing', () => {
    // WRONG IMPL KILLED: a Move that sends the same slot from both tabs (a party monster sent to
    // "next free" stays put; a boxed one sent to the sentinel never joins the party), the wrong
    // monster (the first, or the cursor's index), a sentinel inlined as 255 instead of read from
    // the view model (the (77) view model below), a command issued by Summary or Nickname, a
    // frame left in the sheet (a second A would move the monster again), a cursor that jumps off
    // the monster, and a held A that moves a monster once per repeat.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);

    // Party monster 12 -> storage: the sentinel.
    const partyMove = swallowed(vm, opened, ['RB', 'Down', ...SHEET_STEPS.move]);
    expect(partyMove.phase).toMatchObject({ kind: 'sheet', monsterId: 12n, action: 'move' });
    const fromParty = press(vm, partyMove, 'A');
    expect(fromParty.result).toEqual({ kind: 'setPartySlot', monsterId: 12n, slot: NONE });
    expect(fromParty.state.phase.kind, 'back on the list').toBe('list');
    expect(cursorOf(fromParty.state), 'on the same monster').toEqual({
      tab: 'party',
      item: '12',
    });

    // Storage monster 21 -> party: -1.
    const boxMove = swallowed(vm, opened, SHEET_STEPS.move);
    expect(boxMove.phase).toMatchObject({ kind: 'sheet', monsterId: 21n, action: 'move' });
    const fromBox = press(vm, boxMove, 'A');
    expect(fromBox.result).toEqual({ kind: 'setPartySlot', monsterId: 21n, slot: -1 });
    expect(fromBox.state.phase.kind).toBe('list');
    expect(cursorOf(fromBox.state)).toEqual({ tab: 'storage', item: '21' });
    // Another monster, to prove the id comes from the cursor.
    const other = swallowed(vm, opened, ['Right', 'Right', ...SHEET_STEPS.move]);
    expect(press(vm, other, 'A').result).toEqual({
      kind: 'setPartySlot',
      monsterId: 23n,
      slot: -1,
    });

    // Summary and Nickname issue no command.
    for (const action of ['summary', 'nickname'] as const) {
      const step = press(vm, swallowed(vm, opened, SHEET_STEPS[action]), 'A');
      expect(typeof step.result, `${action} issues no command`).toBe('string');
    }

    // The sentinel is the view model's: a view model built with 77 sends 77.
    const odd = buildMonstersVm(
      world().monsters.map((m) => (m.partySlot === NONE ? { ...m, partySlot: 77 } : m)),
      new Map(SPECIES.map((s) => [s.id, s])),
      PARTY_SIZE,
      77,
    );
    expect(
      odd.storage.map((c) => c.monsterId),
      'fixture: 77 is the boxed slot',
    ).toEqual([21n, 22n, 23n, 24n, 25n]);
    const oddMove = swallowed(odd, monstersScreen.init(odd), ['RB', ...SHEET_STEPS.move]);
    expect(press(odd, oddMove, 'A').result, 'the sentinel the view model carries').toEqual({
      kind: 'setPartySlot',
      monsterId: 11n,
      slot: 77,
    });

    // A repeat A on Move acts on nothing and leaves the sheet where it was.
    const held = press(vm, boxMove, rep('A'));
    expect(typeof held.result, 'a repeat A issues no command').toBe('string');
    expect(held.state.phase).toMatchObject({ kind: 'sheet', monsterId: 21n, action: 'move' });
  });

  it('CTL8B-2-MOVE-FEEDBACK: once a Move has taken effect (observe sees the monster in the target tab) the frame paints "moved to party" or "moved to storage" and keeps it; observe answers the SAME state while nothing changed; the next button clears the line; a Move whose monster never arrives shows no line even if it arrives after a later button; the cursor is re-seated off the monster that left', () => {
    // WRONG IMPL KILLED: a feedback line set when the Move is ISSUED (a refused move would claim a
    // move that never happened: the party-full case), one that never appears, the wrong line for
    // the direction, a new state object on every batch (the view repaints at batch rate), a line
    // that survives the next button (stale text under a new action), a pending move that outlives
    // the next button (a later, unrelated arrival of the monster shows "Moved" for a move the
    // player forgot), no re-seat of the cursor (it would sit on a monster that is no longer in
    // the list), and an observe that mutates the state it was given.
    const w = world();
    const vm = vmOf(w);
    const opened = monstersScreen.init(vm);

    // Storage -> party: monster 21 joins the party in slot 2.
    const issued = press(vm, swallowed(vm, opened, SHEET_STEPS.move), 'A');
    expect(issued.result).toEqual({ kind: 'setPartySlot', monsterId: 21n, slot: -1 });
    expect(issued.state.feedback, 'no line before it happened').toBeNull();
    expect(paintOf(vm, issued.state).feedback).toBeNull();
    expect(observe(vm, issued.state), 'nothing changed: the same object').toBe(issued.state);
    expect(observe(vmOf(w), issued.state), 'a rebuilt, equal view model: the same object').toBe(
      issued.state,
    );

    const joined = vmOf(placed(w, 21n, 2));
    expect(
      joined.party.map((c) => c.monsterId),
      'fixture: 21 is in the party',
    ).toEqual([11n, 12n, 21n]);
    const arrived = observe(joined, issued.state);
    expect(arrived, 'the move took effect: a new state').not.toBe(issued.state);
    expect(arrived.feedback).toBe('movedToParty');
    expect(paintOf(joined, arrived).feedback, 'painted').toBe('movedToParty');
    expect(cursorOf(arrived), 'the cursor left the monster that left: the next one').toEqual({
      tab: 'storage',
      item: '22',
    });
    expect(paintOf(joined, arrived).activeKey).toBe('22');
    expect(observe(joined, arrived), 'and the line is kept: the same object').toBe(arrived);
    expect(observe(vmOf(placed(w, 21n, 2)), arrived), 'a rebuilt view model too').toBe(arrived);
    expect(issued.state.feedback, 'the old state was not changed in place').toBeNull();

    // The next button clears it.
    const cleared = press(joined, arrived, 'Down');
    expect(cleared.state.feedback, 'the next button clears the line').toBeNull();
    expect(paintOf(joined, cleared.state).feedback).toBeNull();

    // Party -> storage: monster 11 is boxed.
    const partyOpen = swallowed(vm, opened, ['RB']);
    const boxIssued = press(vm, swallowed(vm, partyOpen, SHEET_STEPS.move), 'A');
    expect(boxIssued.result).toEqual({ kind: 'setPartySlot', monsterId: 11n, slot: NONE });
    const boxed = vmOf(placed(w, 11n, NONE));
    const arrivedInBox = observe(boxed, boxIssued.state);
    expect(arrivedInBox.feedback).toBe('movedToBox');
    expect(paintOf(boxed, arrivedInBox).feedback).toBe('movedToBox');
    expect(cursorOf(arrivedInBox), 'Party re-seated on the monster that is left').toEqual({
      tab: 'party',
      item: '12',
    });

    // A Move that never arrives (refused): nothing was painted, and a later arrival is not its.
    const refused = issued.state;
    const next = press(vm, refused, 'Down'); // any later button
    expect(next.state.feedback).toBeNull();
    const late = observe(joined, next.state);
    expect(late.feedback, 'the pending move expired with the next button').toBeNull();

    // A monster arriving in the OTHER list, or vanishing, is not the move's arrival.
    const wrongWay = vmOf(without(w, 21n));
    expect(
      observe(wrongWay, issued.state).feedback,
      'the monster is gone, not in the party',
    ).toBeNull();
  });
});

describe('monstersScreen — the nickname row (ctl-8b, CTL8B.3)', () => {
  it('CTL8B-3-NICKNAME-PHASE: A on Nickname opens the typing row for that monster, painted with its card and a fresh edit number, and issues no command (there is no window.prompt in a pure screen); opening it again later takes a different edit number', () => {
    // WRONG IMPL KILLED: a Nickname that does nothing, one that issues a command or reads
    // `prompt` (the old path), a row for another monster, an edit number that never changes
    // (the view keys its prefill and focus on a NEW edit, so a second open would keep the stale
    // text and never refocus), a number that does not match the state's own, and a paint that
    // draws no row.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);
    const sheet = swallowed(vm, opened, ['A', 'Down']);

    const first = press(vm, sheet, 'A');
    expect(first.result, 'no command: the row is the view`s').toBe('consumed');
    expect(first.state.phase).toMatchObject({ kind: 'nickname', monsterId: 21n });
    const edit1 = first.state.phase.kind === 'nickname' ? first.state.phase.edit : Number.NaN;
    expect(typeof edit1).toBe('number');
    expect(Number.isNaN(edit1), 'the phase carries an edit number').toBe(false);
    expect(first.state.edit, 'the state records the last number it handed out').toBe(edit1);
    expect(edit1, 'fresher than the opening state`s').not.toBe(opened.edit);
    expect(paintOf(vm, first.state)).toMatchObject({
      nickname: { card: cardOf(vm, 21n), edit: edit1 },
      summary: null,
      commit: null,
    });

    // Leave the row and open it again: a different number.
    const closed = press(vm, first.state, 'B');
    expect(closed.state.phase).toMatchObject({ kind: 'sheet', action: 'nickname' });
    const second = press(vm, closed.state, 'A');
    expect(second.state.phase).toMatchObject({ kind: 'nickname', monsterId: 21n });
    const edit2 = second.state.phase.kind === 'nickname' ? second.state.phase.edit : Number.NaN;
    expect(edit2, 'a second open takes a different edit number').not.toBe(edit1);
    expect(paintOf(vm, second.state).nickname?.edit).toBe(edit2);

    // Another monster, another open, in the same visit: again a number nobody had. Back out of
    // the row and the sheet to the list (B, B), over to Party's second monster, and open its row.
    const partyRow = swallowed(vm, second.state, ['B', 'B', 'RB', 'Down', 'A', 'Down', 'A']);
    expect(partyRow.phase).toMatchObject({ kind: 'nickname', monsterId: 12n });
    const edit3 = partyRow.phase.kind === 'nickname' ? partyRow.phase.edit : Number.NaN;
    expect([edit1, edit2]).not.toContain(edit3);
    expect(paintOf(vm, partyRow).nickname).toMatchObject({ card: cardOf(vm, 12n), edit: edit3 });
  });

  it('CTL8B-3-A-COMMITS: A in the nickname row hands the view a one-shot commit token naming the monster and its LIVE nickname (empty when it has none) and returns to the sheet; the token is a new object each time and is gone after the next button; the token is painted by identity', () => {
    // WRONG IMPL KILLED: an A that issues setNickname itself (the adapter does not know the text:
    // it lives in the field), one that leaves the row open (a second A would commit twice), a
    // token with no monster id or with the nickname the row was OPENED with instead of the live
    // one (a batch renamed it: the view would skip a text equal to the stale value), the species
    // name standing in for an empty nickname (the view would skip typing the species name back),
    // a token reused across commits (identity is what the view dedups on: the second commit would
    // be skipped), a token that survives the next button (a repaint would replay it), and a
    // paint carrying a copy instead of the state's own token.
    const w = world();
    const vm = vmOf(w);
    const opened = monstersScreen.init(vm);

    // Monster 11 has the nickname 'Kip'.
    const row = swallowed(vm, opened, ['RB', 'A', 'Down', 'A']);
    expect(row.phase).toMatchObject({ kind: 'nickname', monsterId: 11n });
    const committed = press(vm, row, 'A');
    expect(committed.result, 'the commit goes through the view').toBe('consumed');
    expect(committed.state.commit).toEqual({ monsterId: 11n, current: 'Kip' });
    expect(committed.state.phase).toMatchObject({
      kind: 'sheet',
      monsterId: 11n,
      action: 'nickname',
    });
    const painted = paintOf(vm, committed.state);
    expect(painted.commit, 'the very token, not a copy').toBe(committed.state.commit);
    expect(painted.nickname, 'the row is closed in the same paint').toBeNull();

    // The next button drops it.
    const after = press(vm, committed.state, 'Down');
    expect(after.state.commit, 'the next button clears the token').toBeNull();
    expect(paintOf(vm, after.state).commit).toBeNull();

    // A monster with no nickname: current is '' (not the species name).
    const plain = swallowed(vm, opened, ['A', 'Down', 'A']);
    const plainCommit = press(vm, plain, 'A');
    expect(plainCommit.state.commit).toEqual({ monsterId: 21n, current: '' });

    // The LIVE nickname: a batch renames monster 11 while its row is open.
    const live = vmOf(renamed(w, 11n, 'Zip'));
    const liveCommit = press(live, row, 'A');
    expect(liveCommit.state.commit, 'the nickname now, not at open').toEqual({
      monsterId: 11n,
      current: 'Zip',
    });

    // A second commit is a NEW token even when it says the same thing.
    // The sheet is back on Nickname after the commit, so one A reopens the row.
    const reopened = swallowed(vm, committed.state, ['A']);
    expect(reopened.phase).toMatchObject({ kind: 'nickname', monsterId: 11n });
    const second = press(vm, reopened, 'A');
    expect(second.state.commit).toEqual(committed.state.commit);
    expect(second.state.commit, 'a new object').not.toBe(committed.state.commit);
  });

  it('CTL8B-3-B-CANCELS: B in the nickname row returns to the sheet with no commit token (the typed text is dropped by the view), every other button but Start is swallowed with the row still open, and Start pops to the base', () => {
    // WRONG IMPL KILLED: a B that commits (a cancel would rename the monster to a half-typed
    // text), one that closes the frame or drops to the list (the sheet is one level up), a
    // commit token left set, a row that Up / Down / LB / RB / Y / Select move or close (they
    // belong to the field while typing and none of them may reach the cursor or the sheet), and a
    // Start that is swallowed.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);
    const row = swallowed(vm, opened, ['A', 'Down', 'A']);
    expect(row.phase.kind).toBe('nickname');
    const editBefore = row.phase.kind === 'nickname' ? row.phase.edit : Number.NaN;

    const b = press(vm, row, 'B');
    expect(b.result, 'B is swallowed').toBe('consumed');
    expect(b.state.phase).toMatchObject({ kind: 'sheet', monsterId: 21n, action: 'nickname' });
    expect(b.state.commit, 'no commit on cancel').toBeNull();
    expect(paintOf(vm, b.state)).toMatchObject({ nickname: null, commit: null });

    for (const input of ['Up', 'Down', 'Left', 'Right', 'LB', 'RB', 'Y', 'Select'] as const) {
      const step = press(vm, row, input);
      expect(step.result, `${input} in the row is swallowed`).toBe('consumed');
      expect(step.state.phase, `${input} leaves the row open`).toMatchObject({
        kind: 'nickname',
        monsterId: 21n,
        edit: editBefore,
      });
      expect(step.state.commit, `${input} commits nothing`).toBeNull();
      expect(cursorOf(step.state), `${input} moves no cursor`).toEqual(cursorOf(row));
    }
    expect(press(vm, row, 'Start').result).toEqual(POP_TO_BASE);
  });
});

describe('monstersScreen — settle (ctl-8b, CTL8B.1-.3)', () => {
  it('observe answers the SAME state when nothing changed, in every phase, and re-seats the cursor on the nearest monster when its own leaves the list', () => {
    // WRONG IMPL KILLED: an observe that answers a new object every batch (the view repaints at
    // batch rate), one that never re-seats (the cursor on a monster that is gone, an A that opens
    // a sheet for nothing), and a re-seat to the first monster instead of the neighbour.
    const w = world();
    const vm = vmOf(w);
    const opened = monstersScreen.init(vm);
    expect(observe(vmOf(w), opened), 'the opening').toBe(opened);
    const sheet = swallowed(vm, opened, ['A', 'Down']);
    expect(observe(vmOf(w), sheet), 'a sheet').toBe(sheet);
    const summary = swallowed(vm, opened, ['A', 'A']);
    expect(observe(vmOf(w), summary), 'a summary').toBe(summary);
    const row = swallowed(vm, opened, ['A', 'Down', 'A']);
    expect(observe(vmOf(w), row), 'a nickname row').toBe(row);
    const party = swallowed(vm, opened, ['RB', 'Down']);
    expect(observe(vmOf(w), party), 'the party, a moved cursor').toBe(party);

    // The cursor's monster (22, second in Storage) leaves: the neighbour takes the cursor.
    const onSecond = swallowed(vm, opened, ['Right']);
    expect(onSecond.nav.item).toBe('22');
    const gone = vmOf(without(w, 22n));
    const reseated = observe(gone, onSecond);
    expect(reseated).not.toBe(onSecond);
    expect(cursorOf(reseated)).toEqual({ tab: 'storage', item: '23' });
    expect(paintOf(gone, reseated).activeKey).toBe('23');
    expect(observe(vmOf(without(w, 22n)), reseated), 'and settled: the same object').toBe(reseated);

    // Another monster leaving leaves the cursor where it is.
    const elsewhere = vmOf(without(w, 25n));
    expect(cursorOf(observe(elsewhere, onSecond)), 'not the cursor`s monster').toEqual({
      tab: 'storage',
      item: '22',
    });

    // A monster arriving in a tab that was empty seats the cursor on it.
    const bare = world({ monsters: [mon(11n, 0)] });
    const bareVm = vmOf(bare);
    const blind = monstersScreen.init(bareVm);
    expect(blind.nav.item).toBeNull();
    const withBox = vmOf({ ...bare, monsters: [...bare.monsters, mon(21n, NONE)] });
    const seated = observe(withBox, blind);
    expect(seated).not.toBe(blind);
    expect(cursorOf(seated)).toEqual({ tab: 'storage', item: '21' });
  });

  it('observe drops a sheet, a summary or a nickname row whose monster is gone back to the list (the typing row closed, no command); a monster that merely changed tab keeps its sheet', () => {
    // WRONG IMPL KILLED: a sheet left open over a monster that vanished (Move would send a command
    // for it), a typing row left open on a monster that is gone (the commit would name it), a
    // phase dropped by an unrelated batch, and a sheet closed because its monster changed list
    // (the player is mid-action on a monster that is still theirs).
    const w = world();
    const vm = vmOf(w);
    const opened = monstersScreen.init(vm);
    const phases: ReadonlyArray<readonly [string, readonly Input[]]> = [
      ['sheet', ['A', 'Down']],
      ['summary', ['A', 'A']],
      ['nickname', ['A', 'Down', 'A']],
    ];
    for (const [name, inputs] of phases) {
      const state = swallowed(vm, opened, inputs);
      expect(state.phase.kind, `fixture: ${name}`).toBe(name);
      const vanished = vmOf(without(w, 21n));
      const next = observe(vanished, state);
      expect(next.phase.kind, `${name}: the monster is gone`).toBe('list');
      expect(paintOf(vanished, next)).toMatchObject({
        sheet: null,
        summary: null,
        nickname: null,
      });
      expect(next.commit, `${name}: no commit`).toBeNull();

      // Another monster vanishing leaves the phase (and its monster) alone.
      const unrelated = observe(vmOf(without(w, 25n)), state);
      expect(unrelated.phase, `${name}: unrelated batch`).toEqual(state.phase);

      // The monster changed list: the phase stays on it.
      const moved = vmOf(placed(w, 21n, 2));
      const kept = observe(moved, state);
      expect(kept.phase.kind, `${name}: the monster is still the player's`).toBe(name);
    }
  });
});
