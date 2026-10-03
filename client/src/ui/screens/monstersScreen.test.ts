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
//
// ctl-8c (CTL8C.1): the sheet is Summary, Care, Feed…, Evolve…, Nickname, Move (design §5).
//   Care      A sends `care` for the sheet's monster; the sheet stays on Care.
//   Feed…     A opens the food list (the view model's `foods`) on its first food; A on a food sends
//             `train` at once (no confirm) and returns to the sheet; the "Fed {name}" line shows
//             only once a batch shows that food's count below what it was at the press, for a
//             monster still listed; the next button ends it. No food: Feed… is disabled.
//   Evolve…   A opens the list of every outgoing path (the evolution port's view model), the cursor
//             on the first choice (else the first path); only choices act. A on a choice opens a
//             Yes/No confirm defaulting to No; Yes sends `evolve` with that path's toSpecies. No
//             path at all: Evolve… is disabled (paths that are not met yet keep it enabled).
//   A repeat never acts; a confirm a batch just changed only paints.
//
// NAMED INTENTIONAL CHANGES (ctl-8c) to the ctl-8b cases below: the fake store also answers
// `ownInventory` / `itemDefs` (the default world holds a trainable Bait x3 and a non-food Potion);
// SPECIES gains Duskling (3) and Tidepup (4); SHEET_STEPS covers the six actions in the new order,
// and every ctl-8b route that reached Nickname with one Down now walks SHEET_STEPS.nickname (one
// Down now lands on Care, which sends a command); CTL8B-2-A-OPENS-SHEET pins the six-row order; the
// exact opening paint and the exact sheet paint gain `canFeed` / `canEvolve` / `feed` / `evolve` /
// `confirm`; the Move feedback is `{ kind }`; init is checked for `pendingFeed` / `shown`; the
// viewModel case passes the inventory items to the expected view model.
import { describe, expect, it } from 'vitest';
import { party_size, party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreEvolutionPath,
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../../net/store';
import type { BoxView } from '../boxView';
import {
  buildMonstersVm,
  findEvolution,
  findMonster,
  type MonstersVm,
  monsterKey,
  SHEET_ACTIONS,
  type SheetAction,
  STORAGE_COLS,
} from '../monstersModel';
import type { NavInput } from '../nav';
import { buildInventoryItems } from '../raisingModel';
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

const SPECIES: readonly StoreSpeciesRow[] = [
  species(1, 'Sproutle'),
  species(2, 'Emberfang'),
  // ctl-8c: evolution targets.
  species(3, 'Duskling'),
  species(4, 'Tidepup'),
];

/** One inventory row of the player's (or another identity's). */
function inv(invId: bigint, itemId: number, count: number, ownerIdentity = ME): StoreInventory {
  return { invId, ownerIdentity, itemId, count };
}

/** One item definition: a non-null `trainStat` is what makes it food. */
function itemDef(id: number, name: string, trainStat: string | null): StoreItemRow {
  return {
    id,
    name,
    description: '',
    recruitBonus: 0,
    trainStat,
    trainAmount: trainStat === null ? 0 : 1,
    sellPrice: 0n,
    cureStatus: null,
  };
}

/** Item ids are never list indexes: Bait is 7, Carrot 15, Glowberry 40; Potion (3) is no food. */
const BAIT = 7;
const CARROT = 15;
const GLOWBERRY = 40;
const POTION = 3;
const ITEM_DEFS: readonly StoreItemRow[] = [
  itemDef(BAIT, 'Bait', 'attack'),
  itemDef(POTION, 'Potion', null),
  itemDef(CARROT, 'Carrot', 'hp'),
  itemDef(GLOWBERRY, 'Glowberry', 'speed'),
];

/** Three foods in store order Glowberry, Bait, Carrot (by id: Bait 7, Carrot 15, Glowberry 40),
 *  plus the Potion. */
const FOODS3: readonly StoreInventory[] = [
  inv(4n, GLOWBERRY, 2),
  inv(1n, BAIT, 3),
  inv(5n, CARROT, 1),
  inv(2n, POTION, 2),
];

/** One authored edge with a single level gate: the level-5 fixture monsters meet minLevel 1. */
function edge(
  edgeId: number,
  fromSpecies: number,
  toSpecies: number,
  minLevel: number,
): StoreEvolutionPath {
  return {
    pathId: BigInt(edgeId * 1000),
    edgeId,
    fromSpecies,
    toSpecies,
    minLevel,
    essence: [],
    minTrustTier: null,
    minQualityTimeTier: null,
    minNutritionPct: null,
  };
}

/** Species 1 (Kip, 21, 23, 25) paths. Edge ids are never toSpecies ids. */
const NONE_MET = [edge(10, 1, 2, 50), edge(20, 1, 3, 60)];
const ONE_MET = [edge(10, 1, 2, 50), edge(20, 1, 3, 1)];
/** Edge 10 -> Tidepup unmet, 20 -> Duskling met, 30 -> Emberfang met: two choices, 20 and 30. */
const TWO_MET = [edge(10, 1, 4, 50), edge(20, 1, 3, 1), edge(30, 1, 2, 1)];

/** What the fake store holds; a case edits it between view models as a batch would. */
interface World {
  monsters: readonly StoreMonsterPub[];
  paths: readonly StoreEvolutionPath[];
  inventory: readonly StoreInventory[];
  itemDefs: readonly StoreItemRow[];
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
    // ctl-8c: one food (Bait x3) and one non-food (Potion), so Feed… is enabled by default.
    inventory: [inv(1n, BAIT, 3), inv(2n, POTION, 2)],
    itemDefs: ITEM_DEFS,
    ...over,
  };
}

/** The same world with item `itemId`'s stack at `count`. */
const withCount = (w: World, itemId: number, count: number): World => ({
  ...w,
  inventory: w.inventory.map((r) => (r.itemId === itemId ? { ...r, count } : r)),
});
/** The same world without item `itemId`'s row (the last one was eaten). */
const withoutItem = (w: World, itemId: number): World => ({
  ...w,
  inventory: w.inventory.filter((r) => r.itemId !== itemId),
});

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
    // ctl-8c: the player's own inventory rows and the item definitions, as the real store answers.
    ownInventory: (identity: string) =>
      identity === ME
        ? w.inventory.filter((r) => r.ownerIdentity === ME).map((r) => ({ ...r }))
        : [],
    itemDefs: () => new Map(w.itemDefs.map((d) => [d.id, d])),
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

/** The buttons that open the sheet on the cursor's monster and walk it to the action.
 *  ctl-8c (named intentional change): the six rows of the design §5 order, disabled rows included
 *  (the walk reaches them; only A on them is refused). */
const SHEET_STEPS: Readonly<Record<SheetAction, readonly Input[]>> = {
  summary: ['A'],
  care: ['A', 'Down'],
  feed: ['A', 'Down', 'Down'],
  evolve: ['A', 'Down', 'Down', 'Down'],
  nickname: ['A', 'Down', 'Down', 'Down', 'Down'],
  move: ['A', 'Down', 'Down', 'Down', 'Down', 'Down'],
};

/** Kip (party monster 11, the first Party card) on the sheet row `action`, from a fresh frame. */
const kipOn = (vm: MonstersVm, action: SheetAction): MonstersScreenState =>
  swallowed(vm, monstersScreen.init(vm), ['RB', ...SHEET_STEPS[action]]);

/** A sheet phase for `monsterId` on `action`. */
const sheetPhase = (monsterId: bigint, action: SheetAction) => ({
  kind: 'sheet' as const,
  monsterId,
  action,
});

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
    // ctl-8c (named intentional change): no pending feed on open, and the list phase's painted
    // signature is the empty one.
    expect(opened.pendingFeed, 'no pending feed on open').toBeNull();
    expect(typeof opened.shown, 'the painted signature is a string').toBe('string');
    expect(opened.shown, 'the list phase paints no sheet-derived data').toBe('');
    expect(paintOf(vm, opened), 'the opening paint').toEqual({
      tab: 'storage',
      activeKey: '21',
      sheet: null,
      feed: null,
      evolve: null,
      confirm: null,
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
    // ctl-8c: another identity's food row is not the player's.
    w.inventory = [...w.inventory, inv(9n, CARROT, 5, OTHER)];
    const vm = vmOf(w);
    // ctl-8c (named intentional change): the expected view model also takes the player's own
    // inventory items (the raising mapping over `ownInventory` + `itemDefs`).
    const expected = buildMonstersVm(
      w.monsters.filter((m) => m.ownerIdentity === ME),
      new Map(SPECIES.map((s) => [s.id, s])),
      PARTY_SIZE,
      NONE,
      edges,
      buildInventoryItems(
        w.inventory.filter((r) => r.ownerIdentity === ME),
        new Map(w.itemDefs.map((d) => [d.id, d])),
      ),
    );
    expect(vm).toEqual(expected);
    expect(vm.foods, 'the player`s Bait only: no Potion, no foreign Carrot').toEqual([
      { itemId: BAIT, name: 'Bait', count: 3 },
    ]);
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
  it('CTL8B-2-A-OPENS-SHEET: A on a monster opens its action sheet on Summary, for that monster (Storage or Party) and no command; Up and Down walk Summary, Care, Feed, Evolve, Nickname, Move and wrap both ways; a repeat A and A on an empty Storage open nothing', () => {
    // WRONG IMPL KILLED: an A that opens nothing, opens the sheet for another monster (the first
    // one, or the Party's), opens it on Move (a second A would then move the monster), issues a
    // command at once, a sheet whose action list is another order or length, a walk that does not
    // wrap, a repeat A (a held key) that opens the sheet, and an A on an empty Storage that opens
    // a sheet for nothing.
    // ctl-8c (named intentional change): the roster is the design §5 six-row order.
    expect(SHEET_ACTIONS, 'the sheet`s actions, in display order').toEqual([
      'summary',
      'care',
      'feed',
      'evolve',
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
    // The default world has no evolution path (Evolve… disabled): the walk still reaches it.
    expect(seen, 'Down walks the list and wraps back to Summary').toEqual([
      'summary',
      'care',
      'feed',
      'evolve',
      'nickname',
      'move',
      'summary',
    ]);
    expect(actionOf(swallowed(vm, a.state, ['Up'])), 'a fresh Up on Summary wraps to Move').toBe(
      'move',
    );
    expect(actionOf(swallowed(vm, a.state, ['Up', 'Up']))).toBe('nickname');
    expect(actionOf(swallowed(vm, a.state, ['Down', 'Up']))).toBe('summary');
    expect(actionOf(swallowed(vm, a.state, [rep('Up')])), 'a repeat Up on Summary stays').toBe(
      'summary',
    );
    expect(paintOf(vm, swallowed(vm, a.state, ['Down'])).sheet?.action).toBe('care');
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
    const onSheet = swallowed(vm, opened, ['Down', ...SHEET_STEPS.nickname]);
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
    const nickname = swallowed(vm, opened, [...SHEET_STEPS.nickname, 'A']);
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
    // ctl-8c (named intentional change): the feedback is a tagged `{ kind }` (the fed line names
    // its monster).
    expect(arrived.feedback).toEqual({ kind: 'movedToParty' });
    expect(paintOf(joined, arrived).feedback, 'painted').toEqual({ kind: 'movedToParty' });
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
    expect(arrivedInBox.feedback).toEqual({ kind: 'movedToBox' });
    expect(paintOf(boxed, arrivedInBox).feedback).toEqual({ kind: 'movedToBox' });
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
    const sheet = swallowed(vm, opened, SHEET_STEPS.nickname);

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
    const partyRow = swallowed(vm, second.state, [
      'B',
      'B',
      'RB',
      'Down',
      ...SHEET_STEPS.nickname,
      'A',
    ]);
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
    const row = swallowed(vm, opened, ['RB', ...SHEET_STEPS.nickname, 'A']);
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
    const plain = swallowed(vm, opened, [...SHEET_STEPS.nickname, 'A']);
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
    const row = swallowed(vm, opened, [...SHEET_STEPS.nickname, 'A']);
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

describe('monstersScreen — round 2 gaps (ctl-8b)', () => {
  it('ctl-8b gap: the sheet stays painted under the summary and under the typing row, on the same card, with the action that opened them', () => {
    // WRONG IMPL KILLED: a sheetOf that answers null in the summary or nickname phase (the pane
    // would draw under no sheet: the view hides the sheet, the name line and the row's frame
    // vanish, and the focus rescue sends Escape-then-Enter somewhere else), one that paints the
    // wrong action (the sheet's active row would not be the one A opened), and one that carries a
    // different card than the pane.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);

    const summary = swallowed(vm, opened, ['A', 'A']);
    expect(summary.phase.kind, 'fixture: the summary phase').toBe('summary');
    const summaryPaint = paintOf(vm, summary);
    expect(summaryPaint.sheet, 'the sheet is painted under the summary').not.toBeNull();
    expect(summaryPaint.sheet?.action).toBe('summary');
    expect(summaryPaint.sheet?.card, 'the same card as the summary').toEqual(cardOf(vm, 21n));
    expect(summaryPaint.summary).toEqual(cardOf(vm, 21n));

    const row = swallowed(vm, opened, [...SHEET_STEPS.nickname, 'A']);
    expect(row.phase.kind, 'fixture: the nickname phase').toBe('nickname');
    const rowPaint = paintOf(vm, row);
    expect(rowPaint.sheet, 'the sheet is painted under the typing row').not.toBeNull();
    expect(rowPaint.sheet?.action).toBe('nickname');
    expect(rowPaint.sheet?.card, 'the same card as the row').toEqual(cardOf(vm, 21n));
    expect(rowPaint.nickname?.card).toEqual(cardOf(vm, 21n));

    // A Party monster too.
    const partyRow = swallowed(vm, opened, ['RB', 'Down', ...SHEET_STEPS.nickname, 'A']);
    expect(partyRow.phase).toMatchObject({ kind: 'nickname', monsterId: 12n });
    // ctl-8c (named intentional change): the sheet paint also carries whether Feed… and Evolve…
    // are enabled (the default world holds Bait and no evolution path), exactly.
    expect(paintOf(vm, partyRow).sheet).toEqual({
      card: cardOf(vm, 12n),
      action: 'nickname',
      canFeed: true,
      canEvolve: false,
    });
  });

  it('ctl-8b gap: a repeat A in the nickname row commits nothing and leaves the row open; a fresh A does commit', () => {
    // WRONG IMPL KILLED: a commit that ignores the repeat flag (a held Enter in the field would
    // hand the view a token per key repeat, and the first one closes the row mid-word), and the
    // over-correction, an A that never commits (the control below).
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);
    const row = swallowed(vm, opened, [...SHEET_STEPS.nickname, 'A']);
    expect(row.phase.kind, 'fixture: the nickname phase').toBe('nickname');
    const editBefore = row.phase.kind === 'nickname' ? row.phase.edit : Number.NaN;

    const held = press(vm, row, rep('A'));
    expect(held.result, 'a repeat A is swallowed').toBe('consumed');
    expect(held.state.commit, 'a repeat A commits nothing').toBeNull();
    expect(held.state.phase, 'and the row stays open').toMatchObject({
      kind: 'nickname',
      monsterId: 21n,
      edit: editBefore,
    });
    expect(paintOf(vm, held.state).commit).toBeNull();

    const fresh = press(vm, row, 'A');
    expect(fresh.state.commit, 'CONTROL: a fresh A commits').toEqual({
      monsterId: 21n,
      current: '',
    });
    expect(fresh.state.phase.kind).toBe('sheet');
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
    const row = swallowed(vm, opened, [...SHEET_STEPS.nickname, 'A']);
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
      ['nickname', [...SHEET_STEPS.nickname, 'A']],
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

// =============================================================================
// ctl-8c (CTL8C.1): Care, Feed… and Evolve… on the sheet.
// =============================================================================

const feedPhase = (monsterId: bigint, item: string | null) => ({
  kind: 'feed' as const,
  monsterId,
  item,
});
const evolvePhase = (monsterId: bigint, path: string | null) => ({
  kind: 'evolve' as const,
  monsterId,
  path,
});
const confirmPhase = (monsterId: bigint, path: string, yes: boolean) => ({
  kind: 'evolveConfirm' as const,
  monsterId,
  path,
  yes,
});

describe('monstersScreen — Care and Feed (ctl-8c, CTL8C.1)', () => {
  it('CTL8C-1-CARE-COMMAND: A on Care sends care for the sheet`s monster (Storage and Party alike) and the sheet stays open on Care with nothing pending and no pane; a second fresh A sends again; B returns to the list on that monster', () => {
    // WRONG IMPL KILLED: a Care that does nothing or opens a pane or a confirm; one sent for
    // another monster (the cursor's index, the first monster, the Party's first); one that closes
    // the sheet or drops to the list (a second care needs the sheet reopened, and the cooldown
    // refusal shows nothing); one that leaves a pending feed or a feedback line behind.
    const vm = vmOf(world());
    const opened = monstersScreen.init(vm);

    const onCare = swallowed(vm, opened, SHEET_STEPS.care);
    expect(onCare.phase, 'one Down from Summary is Care').toEqual(sheetPhase(21n, 'care'));
    expect(paintOf(vm, onCare).sheet?.action).toBe('care');
    const cared = press(vm, onCare, 'A');
    expect(cared.result).toEqual({ kind: 'care', monsterId: 21n });
    expect(cared.state.phase, 'the sheet stays on Care').toEqual(sheetPhase(21n, 'care'));
    expect(cared.state.pendingFeed).toBeNull();
    expect(cared.state.feedback).toBeNull();
    expect(paintOf(vm, cared.state)).toMatchObject({
      sheet: { card: cardOf(vm, 21n), action: 'care' },
      feed: null,
      evolve: null,
      confirm: null,
      summary: null,
      nickname: null,
    });
    expect(press(vm, cared.state, 'A').result, 'a second fresh A cares again').toEqual({
      kind: 'care',
      monsterId: 21n,
    });

    // Another Storage monster, and both Party monsters.
    const third = swallowed(vm, opened, ['Right', 'Right', ...SHEET_STEPS.care]);
    expect(press(vm, third, 'A').result).toEqual({ kind: 'care', monsterId: 23n });
    expect(press(vm, kipOn(vm, 'care'), 'A').result).toEqual({ kind: 'care', monsterId: 11n });
    const second = swallowed(vm, opened, ['RB', 'Down', ...SHEET_STEPS.care]);
    expect(press(vm, second, 'A').result).toEqual({ kind: 'care', monsterId: 12n });

    const back = press(vm, cared.state, 'B');
    expect(back.result).toBe('consumed');
    expect(back.state.phase.kind).toBe('list');
    expect(cursorOf(back.state)).toEqual({ tab: 'storage', item: '21' });
  });

  it('CTL8C-1-FEED-LIST: A on Feed opens the food list on the first food by item id with no command, the sheet still painted on Feed under it; the paint carries the view model`s foods and the cursor`s key; Up and Down walk the foods and wrap (a repeat clamps); B returns to the sheet on Feed', () => {
    // WRONG IMPL KILLED: a Feed… that feeds at once (the first food, unasked), that opens nothing,
    // or that opens on the store's first row (Glowberry) instead of the first food by id; a list
    // painted without the foods or for another monster; a cursor keyed by index (a batch would
    // move it); a walk that does not wrap, or wraps on a held key; Left / Right that move it; a B
    // that drops to the list or pops the frame; the sheet hidden under the list.
    const w = world({ inventory: FOODS3 });
    const vm = vmOf(w);
    expect(
      vm.foods.map((f) => f.itemId),
      'fixture: three foods, by id',
    ).toEqual([BAIT, CARROT, GLOWBERRY]);

    const onFeed = kipOn(vm, 'feed');
    expect(onFeed.phase).toEqual(sheetPhase(11n, 'feed'));
    const opened = press(vm, onFeed, 'A');
    expect(opened.result, 'no command: the list is the screen`s').toBe('consumed');
    expect(opened.state.phase).toEqual(feedPhase(11n, '7'));
    expect(opened.state.pendingFeed).toBeNull();
    const painted = paintOf(vm, opened.state);
    expect(painted.feed).toEqual({ foods: vm.foods, activeKey: '7' });
    expect(painted.sheet, 'the sheet stays painted under the list').toEqual({
      card: cardOf(vm, 11n),
      action: 'feed',
      canFeed: true,
      canEvolve: false,
    });
    expect(painted).toMatchObject({
      tab: 'party',
      activeKey: '11',
      evolve: null,
      confirm: null,
      summary: null,
      nickname: null,
      feedback: null,
    });

    const itemAfter = (inputs: readonly Input[]): string | null => {
      const s = swallowed(vm, opened.state, inputs);
      return s.phase.kind === 'feed' ? s.phase.item : null;
    };
    expect(itemAfter(['Down'])).toBe('15');
    expect(itemAfter(['Down', 'Down'])).toBe('40');
    expect(itemAfter(['Down', 'Down', 'Down']), 'a fresh Down wraps').toBe('7');
    expect(itemAfter(['Up']), 'a fresh Up wraps').toBe('40');
    expect(itemAfter([rep('Up')]), 'a repeat Up at the top stays').toBe('7');
    expect(itemAfter(['Down', 'Down', rep('Down')]), 'a repeat Down at the end stays').toBe('40');
    expect(itemAfter(['Left', 'Right']), 'Left and Right move nothing').toBe('7');
    const onCarrot = swallowed(vm, opened.state, ['Down']);
    expect(onCarrot.phase).toEqual(feedPhase(11n, '15'));
    expect(paintOf(vm, onCarrot).feed).toEqual({ foods: vm.foods, activeKey: '15' });

    const back = press(vm, onCarrot, 'B');
    expect(back.result).toBe('consumed');
    expect(back.state.phase, 'B: the sheet, on Feed').toEqual(sheetPhase(11n, 'feed'));
    expect(paintOf(vm, back.state).feed).toBeNull();

    // A Storage monster's food list.
    const stored = swallowed(vm, monstersScreen.init(vm), [...SHEET_STEPS.feed, 'A']);
    expect(stored.phase).toEqual(feedPhase(21n, '7'));
  });

  it('CTL8C-1-FEED-NO-CONFIRM: A on a food sends train for the sheet`s monster with THAT food`s item id at once (no confirm step), returns to the sheet on Feed, and records the pending feed (monster, item, its count and the monster`s name at the press)', () => {
    // WRONG IMPL KILLED: a confirm before feeding (CTL8C.1: no confirm); a train sent with the
    // food's LIST INDEX (0, 1, 2) or its inventory row id instead of its item id; the first food
    // whatever the cursor; another monster; a list left open after feeding (a second A would feed
    // again); a pending feed with the wrong item or count or no name (the fed line could not name
    // the monster, or would resolve on the wrong stack).
    const vm = vmOf(world({ inventory: FOODS3 }));
    const onCarrot = swallowed(vm, kipOn(vm, 'feed'), ['A', 'Down']);
    expect(onCarrot.phase, 'fixture: the second food').toEqual(feedPhase(11n, '15'));
    const fed = press(vm, onCarrot, 'A');
    expect(fed.result, 'the second food (index 1) is item 15').toEqual({
      kind: 'train',
      monsterId: 11n,
      foodItemId: CARROT,
    });
    expect(fed.state.phase, 'back on the sheet, on Feed').toEqual(sheetPhase(11n, 'feed'));
    expect(fed.state.pendingFeed).toEqual({
      monsterId: 11n,
      itemId: CARROT,
      count: 1,
      name: 'Kip',
    });
    expect(fed.state.feedback, 'no line before a batch shows it').toBeNull();
    expect(paintOf(vm, fed.state)).toMatchObject({ feed: null, confirm: null, feedback: null });

    // The third food, reached by wrapping Up: item 40.
    const onGlowberry = swallowed(vm, kipOn(vm, 'feed'), ['A', 'Up']);
    expect(press(vm, onGlowberry, 'A').result).toEqual({
      kind: 'train',
      monsterId: 11n,
      foodItemId: GLOWBERRY,
    });

    // A Storage monster with no nickname: its species names the pending feed.
    const stored = swallowed(vm, monstersScreen.init(vm), [...SHEET_STEPS.feed, 'A']);
    const storedFed = press(vm, stored, 'A');
    expect(storedFed.result).toEqual({ kind: 'train', monsterId: 21n, foodItemId: BAIT });
    expect(storedFed.state.pendingFeed).toEqual({
      monsterId: 21n,
      itemId: BAIT,
      count: 3,
      name: 'Sproutle',
    });
  });

  it('CTL8C-1-FEED-FEEDBACK: once a batch shows the fed item`s count below its count at the press (or its row gone) for a monster still listed, observe answers a new state painting the fed line with the name taken at the press, keeps it (the same object) while nothing changes, and the next button clears it', () => {
    // WRONG IMPL KILLED: a fed line set when train is ISSUED (a refused feed would claim it); one
    // that never appears; one that misses the last food eaten (the row is deleted, not set to 0);
    // one that names the monster as a batch renamed it, or by the sheet's card, instead of as it
    // was when fed; a line re-created as a new object on every batch (the frame repaints at batch
    // rate); a pending feed left after it resolved (a second drop would re-announce it); a line
    // that survives the next button; an observe that changes the state it was given.
    const w = world();
    const vm = vmOf(w);
    const issued = press(vm, swallowed(vm, kipOn(vm, 'feed'), ['A']), 'A');
    expect(issued.result, 'fixture: Bait (x3) fed to Kip').toEqual({
      kind: 'train',
      monsterId: 11n,
      foodItemId: BAIT,
    });
    expect(issued.state.feedback).toBeNull();
    expect(observe(vmOf(w), issued.state), 'nothing changed yet: the same object').toBe(
      issued.state,
    );

    const ate = vmOf(withCount(w, BAIT, 2));
    const fed = observe(ate, issued.state);
    expect(fed, 'the feed landed: a new state').not.toBe(issued.state);
    expect(fed.feedback).toEqual({ kind: 'fed', name: 'Kip' });
    expect(fed.pendingFeed, 'resolved: nothing pending').toBeNull();
    expect(paintOf(ate, fed).feedback, 'painted').toEqual({ kind: 'fed', name: 'Kip' });
    expect(observe(vmOf(withCount(w, BAIT, 2)), fed), 'kept: the same object').toBe(fed);
    expect(issued.state.feedback, 'the old state was not changed in place').toBeNull();
    expect(issued.state.pendingFeed).not.toBeNull();

    const cleared = press(ate, fed, 'Down');
    expect(cleared.state.feedback, 'the next button clears the line').toBeNull();
    expect(paintOf(ate, cleared.state).feedback).toBeNull();

    const fedLine = { kind: 'fed', name: 'Kip' };
    expect(
      observe(vmOf(withoutItem(w, BAIT)), issued.state).feedback,
      'the last one eaten',
    ).toEqual(fedLine);
    expect(
      observe(vmOf(withCount(w, BAIT, 1)), issued.state).feedback,
      'two gone in one batch',
    ).toEqual(fedLine);
    expect(
      observe(vmOf(renamed(withCount(w, BAIT, 2), 11n, 'Zip')), issued.state).feedback,
      'renamed in the same batch: the name at the press',
    ).toEqual(fedLine);

    // A Storage monster with no nickname: its species names the line.
    const stored = press(
      vm,
      swallowed(vm, monstersScreen.init(vm), [...SHEET_STEPS.feed, 'A']),
      'A',
    );
    expect(observe(ate, stored.state).feedback).toEqual({ kind: 'fed', name: 'Sproutle' });
  });

  it('CTL8C-1-FEED-NEGATIVE: no fed line for a batch that leaves the count as it was (a refused feed), one where only ANOTHER food drops or runs out, one where the count rises, one where the monster is gone, or a drop that arrives after the next button; an unchanged batch keeps the feed pending', () => {
    // WRONG IMPL KILLED: a line resolved on any batch (the same count), on any inventory drop
    // (another food), on a count that merely changed (a rise: the player bought more), for a
    // monster that left (released or traded: "Fed Kip" for a monster that is not there); a pending
    // feed that outlives the next button (a later, unrelated drop would claim a feed the player
    // never saw land); and the over-correction, an unchanged batch that drops the pending feed (a
    // slow server would never show the line).
    const w = world({ inventory: FOODS3 });
    const vm = vmOf(w);
    const issued = press(vm, swallowed(vm, kipOn(vm, 'feed'), ['A']), 'A');
    expect(issued.result, 'fixture: Bait (x3) fed to Kip').toEqual({
      kind: 'train',
      monsterId: 11n,
      foodItemId: BAIT,
    });

    const lineAfter = (batch: World, state: MonstersScreenState = issued.state) =>
      observe(vmOf(batch), state).feedback;
    expect(lineAfter(w), 'the same count (refused)').toBeNull();
    expect(lineAfter(withCount(w, GLOWBERRY, 1)), 'another food`s drop').toBeNull();
    expect(lineAfter(withoutItem(w, CARROT)), 'another food eaten up').toBeNull();
    expect(lineAfter(withCount(w, BAIT, 4)), 'a rise').toBeNull();
    expect(lineAfter(without(withCount(w, BAIT, 2), 11n)), 'the monster is gone').toBeNull();

    // The next button ends the pending feed: a drop after it is not this feed's.
    const later = press(vm, issued.state, 'Down');
    expect(later.state.pendingFeed, 'the next button ends the pending feed').toBeNull();
    expect(lineAfter(withCount(w, BAIT, 2), later.state)).toBeNull();

    // CONTROL: an unchanged batch keeps the feed pending; the drop that follows shows the line.
    const waited = observe(vmOf(w), issued.state);
    expect(waited, 'an unchanged batch: the same object').toBe(issued.state);
    expect(observe(vmOf(withCount(w, BAIT, 2)), waited).feedback).toEqual({
      kind: 'fed',
      name: 'Kip',
    });
  });

  it('CTL8C-1-FEED-DISABLED: with no food (a non-food and a zero-count food, or no items at all) the sheet paints Feed disabled, the walk still reaches it, and A on it is swallowed: no list, no command, no pending feed; one food in stock enables it', () => {
    // WRONG IMPL KILLED: a Feed… that opens an empty list (nothing for the cursor to sit on); one
    // that sends train for a non-food or an empty stack; canFeed read from the inventory's size
    // instead of the foods (the Potion would enable it); a disabled row dropped from the walk
    // (Down would land on Nickname, not Evolve…); and the over-correction, Feed… disabled while a
    // food is in stock.
    const cases: ReadonlyArray<readonly [string, readonly StoreInventory[]]> = [
      ['a non-food and a zero-count food', [inv(2n, POTION, 2), inv(6n, CARROT, 0)]],
      ['no items at all', []],
    ];
    for (const [name, inventory] of cases) {
      const vm = vmOf(world({ inventory }));
      expect(vm.foods, `${name}: fixture`).toEqual([]);
      const onFeed = kipOn(vm, 'feed');
      expect(onFeed.phase, `${name}: the walk reaches Feed`).toEqual(sheetPhase(11n, 'feed'));
      expect(paintOf(vm, onFeed).sheet, `${name}: Feed painted disabled`).toMatchObject({
        action: 'feed',
        canFeed: false,
      });
      const a = press(vm, onFeed, 'A');
      expect(a.result, `${name}: A is swallowed`).toBe('consumed');
      expect(a.state.phase, `${name}: still the sheet on Feed`).toEqual(sheetPhase(11n, 'feed'));
      expect(a.state.pendingFeed, `${name}: nothing pending`).toBeNull();
      expect(paintOf(vm, a.state).feed, `${name}: no list`).toBeNull();
      expect(swallowed(vm, onFeed, ['Down']).phase, `${name}: Down from Feed is Evolve`).toEqual(
        sheetPhase(11n, 'evolve'),
      );
    }

    // CONTROL: Bait in stock.
    const stocked = vmOf(world());
    const onFeed = kipOn(stocked, 'feed');
    expect(paintOf(stocked, onFeed).sheet).toMatchObject({ action: 'feed', canFeed: true });
    expect(press(stocked, onFeed, 'A').state.phase).toEqual(feedPhase(11n, '7'));
  });
});

describe('monstersScreen — Evolve (ctl-8c, CTL8C.1)', () => {
  it('CTL8C-1-EVOLVE-LIST: A on Evolve opens the list of EVERY outgoing path (the evolution view model of that monster) with no command; the cursor sits on the first choice, else the first path; A on a path that is not a choice (unmet, or the single met path the server applies itself) is swallowed; with two met paths A on a choice opens its confirm; B returns to the sheet on Evolve', () => {
    // WRONG IMPL KILLED: a list of the met paths only (the player cannot see what the others need)
    // or of the choices only (empty at 0 or 1 met); a cursor on the first path when a choice
    // exists (the first A would be refused); a cursor keyed by index; an A on an unmet path, or on
    // the single auto-applied path, that opens a confirm (offering an evolution the server does
    // not offer); a painted `mon` that is not the view model's own; a B that drops to the list.
    const listFor = (paths: readonly StoreEvolutionPath[]) => {
      const vm = vmOf(world({ paths }));
      const onEvolve = kipOn(vm, 'evolve');
      expect(onEvolve.phase).toEqual(sheetPhase(11n, 'evolve'));
      const step = press(vm, onEvolve, 'A');
      expect(step.result, 'opening the list sends nothing').toBe('consumed');
      return { vm, list: step.state };
    };

    // No path met: both listed, the cursor on the first, A refused on each.
    {
      const { vm, list } = listFor(NONE_MET);
      const mon = findEvolution(vm, 11n);
      expect(
        mon?.paths.map((p) => p.edgeId),
        'fixture: two unmet paths',
      ).toEqual([10, 20]);
      expect(list.phase).toEqual(evolvePhase(11n, '10'));
      const painted = paintOf(vm, list);
      expect(painted.evolve).toEqual({ mon, activeKey: '10' });
      expect(painted.sheet).toMatchObject({ action: 'evolve', canEvolve: true });
      expect(painted.confirm).toBeNull();
      const refused = press(vm, list, 'A');
      expect(refused.result).toBe('consumed');
      expect(refused.state.phase, 'A on an unmet path: still the list').toEqual(list.phase);
      expect(paintOf(vm, refused.state).confirm).toBeNull();
      const onSecond = swallowed(vm, list, ['Down']);
      expect(onSecond.phase).toEqual(evolvePhase(11n, '20'));
      expect(paintOf(vm, onSecond).evolve?.activeKey).toBe('20');
      expect(press(vm, onSecond, 'A').state.phase).toEqual(onSecond.phase);
      expect(swallowed(vm, list, ['Down', 'Down']).phase, 'a fresh Down wraps').toEqual(list.phase);
    }

    // Exactly one met: no choice (the server applies it on the next action).
    {
      const { vm, list } = listFor(ONE_MET);
      const mon = findEvolution(vm, 11n);
      expect(mon?.eligibleCount, 'fixture: one met path').toBe(1);
      expect(mon?.choices, 'fixture: no choice').toEqual([]);
      expect(list.phase, 'no choice: the first path').toEqual(evolvePhase(11n, '10'));
      expect(paintOf(vm, list).evolve).toEqual({ mon, activeKey: '10' });
      const onMet = swallowed(vm, list, ['Down']);
      expect(onMet.phase).toEqual(evolvePhase(11n, '20'));
      const refused = press(vm, onMet, 'A');
      expect(refused.result).toBe('consumed');
      expect(refused.state.phase, 'the single met path is not offered').toEqual(onMet.phase);
    }

    // Two met: the cursor on the first CHOICE (edge 20), not on the unmet edge 10.
    {
      const { vm, list } = listFor(TWO_MET);
      const mon = findEvolution(vm, 11n);
      expect(mon?.paths.map((p) => p.edgeId)).toEqual([10, 20, 30]);
      expect(mon?.choices.map((p) => p.edgeId)).toEqual([20, 30]);
      expect(list.phase).toEqual(evolvePhase(11n, '20'));
      expect(paintOf(vm, list).evolve).toEqual({ mon, activeKey: '20' });
      expect(swallowed(vm, list, ['Up']).phase, 'the unmet path is reachable').toEqual(
        evolvePhase(11n, '10'),
      );
      const opened = press(vm, list, 'A');
      expect(opened.result).toBe('consumed');
      expect(opened.state.phase.kind, 'A on a choice opens its confirm').toBe('evolveConfirm');
      const back = press(vm, list, 'B');
      expect(back.result).toBe('consumed');
      expect(back.state.phase, 'B: the sheet, on Evolve').toEqual(sheetPhase(11n, 'evolve'));
      expect(paintOf(vm, back.state).evolve).toBeNull();
      const stored = swallowed(vm, monstersScreen.init(vm), [...SHEET_STEPS.evolve, 'A']);
      expect(stored.phase, 'a Storage monster`s list').toEqual(evolvePhase(21n, '20'));
    }
  });

  it('CTL8C-1-EVOLVE-DISABLED: a monster with no outgoing path paints Evolve disabled and A on it is swallowed (no list, no command); a monster whose paths are all unmet paints it ENABLED and A opens the list; the flag is per monster', () => {
    // WRONG IMPL KILLED: canEvolve read from the choices or the met paths (paths not met yet would
    // sit behind a disabled row: the player could never read what a path needs); an Evolve… that
    // opens an empty list for a monster with no path; a flag read from another monster (one
    // pathless monster disabling it for all, or the reverse); a disabled row that still acts.
    const bare = vmOf(world({ paths: [] }));
    const onBare = kipOn(bare, 'evolve');
    expect(onBare.phase).toEqual(sheetPhase(11n, 'evolve'));
    expect(paintOf(bare, onBare).sheet).toMatchObject({ action: 'evolve', canEvolve: false });
    const refused = press(bare, onBare, 'A');
    expect(refused.result, 'no path: A is swallowed').toBe('consumed');
    expect(refused.state.phase, 'still the sheet on Evolve').toEqual(sheetPhase(11n, 'evolve'));
    expect(paintOf(bare, refused.state).evolve).toBeNull();

    const unmet = vmOf(world({ paths: NONE_MET }));
    const onUnmet = kipOn(unmet, 'evolve');
    expect(paintOf(unmet, onUnmet).sheet, 'paths, none met: enabled').toMatchObject({
      action: 'evolve',
      canEvolve: true,
    });
    expect(press(unmet, onUnmet, 'A').state.phase).toEqual(evolvePhase(11n, '10'));

    // Per monster: in the same world Emberfang (12, species 2) has no path out.
    const ember = swallowed(unmet, monstersScreen.init(unmet), [
      'RB',
      'Down',
      ...SHEET_STEPS.evolve,
    ]);
    expect(ember.phase).toEqual(sheetPhase(12n, 'evolve'));
    expect(paintOf(unmet, ember).sheet).toMatchObject({ canEvolve: false });
    const emberA = press(unmet, ember, 'A');
    expect(emberA.result).toBe('consumed');
    expect(emberA.state.phase).toEqual(sheetPhase(12n, 'evolve'));
  });

  it('CTL8C-1-EVOLVE-CONFIRM-NO: A on a choice opens a confirm that defaults to No, painted with the monster`s name and that path`s target species under the sheet on Evolve, with no command; A on No and B both return to the list on that path with nothing sent; a fresh Up or Down toggles Yes and No', () => {
    // WRONG IMPL KILLED: a confirm that defaults to Yes (CTL8C.1: No; a double tap would evolve);
    // an evolution sent from the list at once; a confirm naming another path's species (the first
    // choice's, or the edge id read as a species) or the species instead of the nickname; A on No
    // that sends anyway; a No or B that drops to the sheet or the list (the player loses the path
    // they were reading); the sheet hidden under the confirm; Up / Down that do not toggle.
    const vm = vmOf(world({ paths: TWO_MET }));
    const list = swallowed(vm, kipOn(vm, 'evolve'), ['A']);
    expect(list.phase).toEqual(evolvePhase(11n, '20'));
    const opened = press(vm, list, 'A');
    expect(opened.result, 'the confirm sends nothing').toBe('consumed');
    expect(opened.state.phase).toEqual(confirmPhase(11n, '20', false));
    const painted = paintOf(vm, opened.state);
    expect(painted.confirm, 'No is the default').toEqual({
      name: 'Kip',
      species: 'Duskling',
      yes: false,
    });
    expect(painted.sheet, 'the sheet stays painted, on Evolve').toEqual({
      card: cardOf(vm, 11n),
      action: 'evolve',
      canFeed: true,
      canEvolve: true,
    });
    expect(painted.feed).toBeNull();

    const no = press(vm, opened.state, 'A');
    expect(no.result, 'A on No sends nothing').toBe('consumed');
    expect(no.state.phase, 'back on the list, on that path').toEqual(evolvePhase(11n, '20'));
    expect(paintOf(vm, no.state).confirm).toBeNull();

    const b = press(vm, swallowed(vm, opened.state, ['Down']), 'B');
    expect(b.result, 'B with Yes highlighted sends nothing').toBe('consumed');
    expect(b.state.phase).toEqual(evolvePhase(11n, '20'));

    const yesAfter = (inputs: readonly Input[]): boolean | null => {
      const s = swallowed(vm, opened.state, inputs);
      return s.phase.kind === 'evolveConfirm' ? s.phase.yes : null;
    };
    expect(yesAfter(['Down'])).toBe(true);
    expect(yesAfter(['Up'])).toBe(true);
    expect(yesAfter(['Down', 'Down'])).toBe(false);
    expect(yesAfter(['Down', 'Up'])).toBe(false);
    expect(paintOf(vm, swallowed(vm, opened.state, ['Down'])).confirm).toEqual({
      name: 'Kip',
      species: 'Duskling',
      yes: true,
    });

    // The second choice's confirm names its own target.
    const other = press(vm, swallowed(vm, list, ['Down']), 'A');
    expect(paintOf(vm, other.state).confirm).toEqual({
      name: 'Kip',
      species: 'Emberfang',
      yes: false,
    });
    // A Storage monster with no nickname is named by its species.
    const stored = swallowed(vm, monstersScreen.init(vm), [...SHEET_STEPS.evolve, 'A', 'A']);
    expect(paintOf(vm, stored).confirm).toEqual({
      name: 'Sproutle',
      species: 'Duskling',
      yes: false,
    });
  });

  it('CTL8C-1-EVOLVE-COMMAND: with two choices and the cursor moved to the SECOND, A, Down (Yes) and A send evolve for the sheet`s monster with that path`s toSpecies (not its edge id, not the first choice`s) and return to the sheet on Evolve', () => {
    // WRONG IMPL KILLED: an evolve sent with the edge id (30) instead of the target species (2),
    // with the first choice's species whatever the cursor, with the cursor's index, or for
    // another monster; a Yes that leaves the confirm open (a second A would send twice) or drops
    // to the list.
    const vm = vmOf(world({ paths: TWO_MET }));
    const onSecond = swallowed(vm, kipOn(vm, 'evolve'), ['A', 'Down']);
    expect(onSecond.phase, 'fixture: the second choice, edge 30 -> species 2').toEqual(
      evolvePhase(11n, '30'),
    );
    const yes = swallowed(vm, onSecond, ['A', 'Down']);
    expect(yes.phase).toEqual(confirmPhase(11n, '30', true));
    const sent = press(vm, yes, 'A');
    expect(sent.result).toEqual({ kind: 'evolve', monsterId: 11n, toSpecies: 2 });
    expect(sent.state.phase, 'back on the sheet, on Evolve').toEqual(sheetPhase(11n, 'evolve'));
    expect(paintOf(vm, sent.state)).toMatchObject({ confirm: null, evolve: null });

    // A Storage monster's first choice: edge 20 -> species 3.
    const stored = swallowed(vm, monstersScreen.init(vm), [...SHEET_STEPS.evolve, 'A', 'A', 'Up']);
    expect(stored.phase).toEqual(confirmPhase(21n, '20', true));
    expect(press(vm, stored, 'A').result).toEqual({ kind: 'evolve', monsterId: 21n, toSpecies: 3 });
  });

  it('CTL8C-1-CONFIRM-FALLBACK: when a batch makes the confirm`s path no longer a choice, or takes it away, the next A only paints the fallback (the Evolve list on that path, on the first choice if the path is gone, or the sheet on Evolve if no path is left) and sends nothing; observe falls back the same way; with nothing changed the same Yes sends', () => {
    // WRONG IMPL KILLED: a Yes that sends an evolve the server no longer offers (a raised gate, a
    // republished graph); a fallback acted on by the same press (the player's A would open a
    // confirm they never saw, for another path); a confirm left open over a path that is gone.
    const w = world({ paths: TWO_MET });
    const vm = vmOf(w);
    const yesOn30 = swallowed(vm, kipOn(vm, 'evolve'), ['A', 'Down', 'A', 'Down']);
    expect(yesOn30.phase).toEqual(confirmPhase(11n, '30', true));
    expect(press(vm, yesOn30, 'A').result, 'CONTROL: nothing changed, Yes sends').toEqual({
      kind: 'evolve',
      monsterId: 11n,
      toSpecies: 2,
    });

    // Edge 30 is still listed but no longer met.
    const raised = vmOf({
      ...w,
      paths: [edge(10, 1, 4, 50), edge(20, 1, 3, 1), edge(30, 1, 2, 50)],
    });
    const a1 = press(raised, yesOn30, 'A');
    expect(a1.result, 'no longer a choice: nothing sent').toBe('consumed');
    expect(a1.state.phase, 'the list, on that path').toEqual(evolvePhase(11n, '30'));
    expect(paintOf(raised, a1.state).confirm).toBeNull();
    expect(observe(raised, yesOn30).phase, 'observe falls back the same way').toEqual(
      evolvePhase(11n, '30'),
    );

    // Edge 30 is gone; edges 20 and 40 are choices.
    const swapped = vmOf({
      ...w,
      paths: [edge(10, 1, 4, 50), edge(20, 1, 3, 1), edge(40, 1, 2, 1)],
    });
    const a2 = press(swapped, yesOn30, 'A');
    expect(a2.result, 'the path is gone: nothing sent').toBe('consumed');
    expect(a2.state.phase, 'the list on the first choice, no confirm opened by this press').toEqual(
      evolvePhase(11n, '20'),
    );
    expect(
      press(swapped, a2.state, 'A').state.phase,
      'the NEXT A acts on what was painted: a fresh confirm, on No',
    ).toEqual(confirmPhase(11n, '20', false));

    // No path left at all.
    const bare = vmOf({ ...w, paths: [] });
    const a3 = press(bare, yesOn30, 'A');
    expect(a3.result).toBe('consumed');
    expect(a3.state.phase, 'no path: the sheet, on Evolve').toEqual(sheetPhase(11n, 'evolve'));
  });
});

describe('monstersScreen — settle and repeats (ctl-8c, CTL8C.1)', () => {
  it('CTL8C-1-OBSERVE-REPAINT: observe answers the SAME state while nothing it paints changed (list, sheet, food list, Evolve list, confirm), and a NEW one when a food count changes under the food list, when a path`s met flag or unmet reason changes under the Evolve list, or when Feed or Evolve becomes disabled under the sheet, then settles; the list phase ignores counts and paths', () => {
    // WRONG IMPL KILLED: ctl-8b's key-only settle (a count or a met flag changes no monster key:
    // the view refreshes cards only, so "Bait (x3)" would stay after one is eaten and a path that
    // became unmet would still read as ready); a signature without the unmet reason (a raised gate
    // keeps the old requirement on screen); an observe that answers a new object on every batch or
    // after it settled (the frame repaints at batch rate); one that repaints the list phase for
    // data the list does not paint.
    const w = world({ inventory: FOODS3, paths: TWO_MET });
    const vm = vmOf(w);
    const init = monstersScreen.init(vm);
    const sheet = kipOn(vm, 'feed');
    const feedList = swallowed(vm, sheet, ['A']);
    const evoList = swallowed(vm, kipOn(vm, 'evolve'), ['A']);
    const confirm = swallowed(vm, evoList, ['A']);
    const states = [
      ['list', init],
      ['sheet', sheet],
      ['food list', feedList],
      ['Evolve list', evoList],
      ['confirm', confirm],
    ] as const;
    for (const [name, s] of states) {
      expect(observe(vmOf(w), s), `${name}: nothing changed, the same object`).toBe(s);
    }

    // A count under the food list.
    const ate = withCount(w, BAIT, 2);
    const recount = observe(vmOf(ate), feedList);
    expect(recount, 'a count changed: a new state').not.toBe(feedList);
    expect(recount.phase, 'on the same food').toEqual(feedList.phase);
    expect(paintOf(vmOf(ate), recount).feed?.foods).toContainEqual({
      itemId: BAIT,
      name: 'Bait',
      count: 2,
    });
    expect(observe(vmOf(ate), recount), 'then settled').toBe(recount);

    // A met flag under the Evolve list: edge 30's gate rises.
    const raised: World = {
      ...w,
      paths: [edge(10, 1, 4, 50), edge(20, 1, 3, 1), edge(30, 1, 2, 50)],
    };
    const remet = observe(vmOf(raised), evoList);
    expect(remet, 'a met flag changed: a new state').not.toBe(evoList);
    expect(remet.phase, 'the cursor path is still there').toEqual(evoList.phase);
    expect(paintOf(vmOf(raised), remet).evolve?.mon).toEqual(findEvolution(vmOf(raised), 11n));
    expect(observe(vmOf(raised), remet), 'then settled').toBe(remet);

    // The unmet reason alone: edge 10 needs level 60, not 50 (unmet either way).
    const harder: World = {
      ...w,
      paths: [edge(10, 1, 4, 60), edge(20, 1, 3, 1), edge(30, 1, 2, 1)],
    };
    expect(
      findEvolution(vmOf(harder), 11n)?.paths[0]?.unmetReason,
      'fixture: the reason differs',
    ).not.toBe(findEvolution(vm, 11n)?.paths[0]?.unmetReason);
    const reason = observe(vmOf(harder), evoList);
    expect(reason, 'an unmet reason changed: a new state').not.toBe(evoList);
    expect(observe(vmOf(harder), reason), 'then settled').toBe(reason);

    // Feed / Evolve disabled under the sheet.
    const starved: World = { ...w, inventory: [] };
    const noFood = observe(vmOf(starved), sheet);
    expect(noFood, 'Feed became disabled: a new state').not.toBe(sheet);
    expect(paintOf(vmOf(starved), noFood).sheet).toMatchObject({ canFeed: false, canEvolve: true });
    expect(observe(vmOf(starved), noFood), 'then settled').toBe(noFood);
    const pathless: World = { ...w, paths: [] };
    const noPath = observe(vmOf(pathless), sheet);
    expect(noPath, 'Evolve became disabled: a new state').not.toBe(sheet);
    expect(paintOf(vmOf(pathless), noPath).sheet).toMatchObject({
      canFeed: true,
      canEvolve: false,
    });
    expect(observe(vmOf(pathless), noPath), 'then settled').toBe(noPath);

    // The list phase paints none of it.
    for (const batch of [ate, raised, harder, starved, pathless]) {
      expect(observe(vmOf(batch), init), 'the list: the same object').toBe(init);
    }
  });

  it('CTL8C-1-REPEAT-NEVER-ACTS: a repeat A never acts (Care sends nothing, Feed and Evolve open nothing, a food is not fed, a choice opens no confirm, Yes sends nothing) and a repeat Up or Down never moves the Yes / No cursor; the same presses made fresh do act', () => {
    // WRONG IMPL KILLED: any action that ignores the repeat flag (a held Enter would care once per
    // auto-repeat, feed a stack away, or run through the confirm and evolve: the very thing the No
    // default exists to stop), and a Yes / No cursor that a held arrow flips (it would land on
    // whichever answer the repeat rate leaves it on).
    const vm = vmOf(world({ paths: TWO_MET }));
    const careSheet = kipOn(vm, 'care');
    const feedSheet = kipOn(vm, 'feed');
    const evolveSheet = kipOn(vm, 'evolve');
    const foodList = swallowed(vm, feedSheet, ['A']);
    const pathList = swallowed(vm, evolveSheet, ['A']);
    const onNo = swallowed(vm, pathList, ['A']);
    const onYes = swallowed(vm, onNo, ['Down']);
    expect(onYes.phase, 'fixture: Yes on edge 20').toEqual(confirmPhase(11n, '20', true));

    const held: ReadonlyArray<readonly [string, MonstersScreenState, NavInput]> = [
      ['A on Care', careSheet, rep('A')],
      ['A on Feed', feedSheet, rep('A')],
      ['A on a food', foodList, rep('A')],
      ['A on Evolve', evolveSheet, rep('A')],
      ['A on a choice', pathList, rep('A')],
      ['A on Yes', onYes, rep('A')],
      ['Down on No', onNo, rep('Down')],
      ['Up on No', onNo, rep('Up')],
      ['Down on Yes', onYes, rep('Down')],
      ['Up on Yes', onYes, rep('Up')],
    ];
    for (const [name, state, input] of held) {
      const step = press(vm, state, input);
      expect(step.result, `a repeat ${name} is swallowed`).toBe('consumed');
      expect(step.state.phase, `a repeat ${name} changes no phase`).toEqual(state.phase);
      expect(step.state.pendingFeed, `a repeat ${name} feeds nothing`).toBeNull();
    }

    // CONTROL: fresh, each one acts.
    expect(press(vm, careSheet, 'A').result).toEqual({ kind: 'care', monsterId: 11n });
    expect(press(vm, feedSheet, 'A').state.phase).toEqual(feedPhase(11n, '7'));
    expect(press(vm, foodList, 'A').result).toEqual({
      kind: 'train',
      monsterId: 11n,
      foodItemId: BAIT,
    });
    expect(press(vm, evolveSheet, 'A').state.phase).toEqual(evolvePhase(11n, '20'));
    expect(press(vm, pathList, 'A').state.phase).toEqual(confirmPhase(11n, '20', false));
    expect(press(vm, onYes, 'A').result).toEqual({ kind: 'evolve', monsterId: 11n, toSpecies: 3 });
    expect(press(vm, onNo, 'Down').state.phase).toEqual(confirmPhase(11n, '20', true));
  });

  it('ctl-8c settle: a food list whose cursor food is gone moves to the first food, and one left with no food closes to the sheet on Feed; an Evolve list whose cursor path is gone moves to the first choice (else the first path), and one left with no path closes to the sheet on Evolve; a food list, an Evolve list or a confirm whose monster is gone closes to the list', () => {
    // WRONG IMPL KILLED: a cursor left on a food or a path that is gone (A would feed an item the
    // player no longer holds, or open a confirm for a path that does not exist); a re-seat onto
    // an unmet path while a choice exists; a list left open with nothing in it; a list or confirm
    // left open over a monster that left.
    const w = world({ inventory: FOODS3, paths: TWO_MET });
    const vm = vmOf(w);

    const onCarrot = swallowed(vm, kipOn(vm, 'feed'), ['A', 'Down']);
    expect(onCarrot.phase).toEqual(feedPhase(11n, '15'));
    expect(observe(vmOf(withoutItem(w, CARROT)), onCarrot).phase, 'the first food').toEqual(
      feedPhase(11n, '7'),
    );
    const starved: World = { ...w, inventory: [] };
    const closed = observe(vmOf(starved), onCarrot);
    expect(closed.phase, 'no food left: the sheet, on Feed').toEqual(sheetPhase(11n, 'feed'));
    expect(paintOf(vmOf(starved), closed).feed).toBeNull();

    const on30 = swallowed(vm, kipOn(vm, 'evolve'), ['A', 'Down']);
    expect(on30.phase).toEqual(evolvePhase(11n, '30'));
    const swapped: World = {
      ...w,
      paths: [edge(10, 1, 4, 50), edge(20, 1, 3, 1), edge(40, 1, 2, 1)],
    };
    expect(observe(vmOf(swapped), on30).phase, 'the first choice').toEqual(evolvePhase(11n, '20'));
    const single: World = { ...w, paths: [edge(10, 1, 4, 50), edge(20, 1, 3, 1)] };
    expect(observe(vmOf(single), on30).phase, 'no choice left: the first path').toEqual(
      evolvePhase(11n, '10'),
    );
    const pathless: World = { ...w, paths: [] };
    expect(observe(vmOf(pathless), on30).phase, 'no path left').toEqual(sheetPhase(11n, 'evolve'));

    const confirm = swallowed(vm, on30, ['A']);
    const gone = vmOf(without(w, 11n));
    for (const [name, s] of [
      ['food list', onCarrot],
      ['Evolve list', on30],
      ['confirm', confirm],
    ] as const) {
      const next = observe(gone, s);
      expect(next.phase.kind, `${name}: the monster is gone`).toBe('list');
      expect(paintOf(gone, next), `${name}: nothing of it painted`).toMatchObject({
        sheet: null,
        feed: null,
        evolve: null,
        confirm: null,
      });
    }
  });

  it('ctl-8c gap: Start pops to the base from the food list, the Evolve list and the confirm; LB and RB are swallowed there and switch no tab; Select toggles help from the food list', () => {
    // WRONG IMPL KILLED: a sub-phase that swallows Start (the frame could not be left from a list);
    // LB / RB that switch the tab under an open list (the list would belong to a monster the tabs
    // no longer show) or that leak to the page as unhandled (PageUp / PageDown would scroll).
    const vm = vmOf(world({ paths: TWO_MET }));
    const foodList = swallowed(vm, kipOn(vm, 'feed'), ['A']);
    const pathList = swallowed(vm, kipOn(vm, 'evolve'), ['A']);
    const confirm = swallowed(vm, pathList, ['A']);
    for (const [name, s] of [
      ['food list', foodList],
      ['Evolve list', pathList],
      ['confirm', confirm],
    ] as const) {
      expect(press(vm, s, 'Start').result, `Start in the ${name}`).toEqual(POP_TO_BASE);
      for (const button of ['LB', 'RB'] as const) {
        const step = press(vm, s, button);
        expect(step.result, `${button} in the ${name}`).toBe('consumed');
        expect(step.state.phase, `${button} leaves the ${name} open`).toEqual(s.phase);
        expect(cursorOf(step.state), `${button} switches no tab`).toEqual(cursorOf(s));
      }
    }
    expect(press(vm, foodList, 'Select').result).toEqual(TOGGLE_HELP);
  });
});
