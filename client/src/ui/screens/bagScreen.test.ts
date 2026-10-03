// ui/screens/bagScreen.test.ts — ctl-8f (CTL8F.1, CTL8F.2): the Bag frame's pure adapter.
//
// Node env, no DOM. `bagScreen` is driven only through `viewModel(ctx)`, `init(vm)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)` into a
// recording fake view. Claims about the pocket, the cursor, the phase and the status line are read
// off `state.nav` / `state.phase` / `state.status` and off the one paint a `paint` hands the view;
// the state is never deep-compared (it may hold private fields).
//
// The game-core constants are the REAL wasm exports (`party_size()`, `party_slot_none()`).
//
// The fixture world (all the player's own, store order; item ids are never list indexes):
//   pockets   bait      3 Lure Berry x4
//             food      9 Glow Berry x2, 5 Power Root x3   (inventory order: 9 before 5)
//             medicine  12 Antidote x1
//             other     20 Moon Shard x6 (no description)
//   monsters  party 11 'Kip' (slot 0), 12 Emberfang (slot 1); storage 21 Sproutle, 22 Emberfang
//   plus another identity's food stack and monster, which must never show.
//
// The contract (plan + dispositions):
//   list    opens on the FIRST pocket's first item. D-pad / LB / RB move the nav kit (wrap fresh, clamp
//           on a repeat, per-pocket memory); A (not a repeat) on an item opens its sheet on the first
//           action; B pops; Start pops to the base; Select toggles help; X / Y are `unhandled`.
//   sheet   Up / Down over the actions (Feed, Use, Info as the item allows). A: Feed opens the picker
//           (disabled with no monster: status noMonsters), Use is always refused (status battleOnly),
//           Info opens the description. B returns to the list on that item.
//   info    A or B return to the sheet on Info.
//   picker  Up / Down over the monsters; A sends `train` at once (no confirm) and closes the picker,
//           the cursor on the item; B returns to the sheet on Feed.
//   sheet / info / picker swallow every other button.
//   A repeat never acts; every button ends the last status.
//   observe the FIRST observe after init answers a new state (the host paints on the first batch);
//           afterwards the SAME object when nothing painted changed.
import { describe, expect, it } from 'vitest';
import { party_size, party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../../net/store';
import { type BagVm, bagMonsters, buildBagVm } from '../bagModel';
import type { NavInput } from '../nav';
import type { RaisingView } from '../raisingView';
import { type BagScreenState, bagScreen } from './bagScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const ME = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const PARTY_SIZE = party_size();
const NONE = party_slot_none();

const LURE = 3;
const ROOT = 5;
const GLOW = 9;
const ANTIDOTE = 12;
const SHARD = 20;

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

const inv = (invId: bigint, itemId: number, count: number, ownerIdentity = ME): StoreInventory => ({
  invId,
  ownerIdentity,
  itemId,
  count,
});

function def(
  id: number,
  name: string,
  description: string,
  over: Partial<StoreItemRow>,
): StoreItemRow {
  return {
    id,
    name,
    description,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
    ...over,
  };
}
const ITEM_DEFS: readonly StoreItemRow[] = [
  def(LURE, 'Lure Berry', 'Lures a wild monster.', { recruitBonus: 10 }),
  def(ROOT, 'Power Root', 'Raises attack.', { trainStat: 'attack', trainAmount: 2 }),
  def(GLOW, 'Glow Berry', 'Raises speed.', { trainStat: 'speed', trainAmount: 1 }),
  def(ANTIDOTE, 'Antidote', 'Cures poison.', { cureStatus: 'Poison' }),
  def(SHARD, 'Moon Shard', '', {}),
];

interface World {
  monsters: readonly StoreMonsterPub[];
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
      mon(99n, NONE, 1, '', OTHER),
    ],
    inventory: [
      inv(1n, GLOW, 2),
      inv(2n, LURE, 4),
      inv(3n, ROOT, 3),
      inv(4n, ANTIDOTE, 1),
      inv(5n, SHARD, 6),
      inv(9n, ROOT, 99, OTHER),
    ],
    itemDefs: ITEM_DEFS,
    ...over,
  };
}

const withCount = (w: World, itemId: number, count: number): World => ({
  ...w,
  inventory: w.inventory.map((r) =>
    r.itemId === itemId && r.ownerIdentity === ME ? { ...r, count } : r,
  ),
});
const withoutItem = (w: World, itemId: number): World => ({
  ...w,
  inventory: w.inventory.filter((r) => !(r.itemId === itemId && r.ownerIdentity === ME)),
});
const withoutMonster = (w: World, id: bigint): World => ({
  ...w,
  monsters: w.monsters.filter((m) => m.monsterId !== id),
});
const renamedMonster = (w: World, id: bigint, nickname: string): World => ({
  ...w,
  monsters: w.monsters.map((m) => (m.monsterId === id ? { ...m, nickname } : m)),
});
const withDef = (w: World, itemId: number, over: Partial<StoreItemRow>): World => ({
  ...w,
  itemDefs: w.itemDefs.map((d) => (d.id === itemId ? { ...d, ...over } : d)),
});

function ctxOf(w: World): ScreenContext {
  const store = {
    ownMonsters: (identity: string) =>
      identity === ME
        ? w.monsters.filter((m) => m.ownerIdentity === ME).map((m) => ({ ...m }))
        : [],
    speciesMap: () => new Map(SPECIES.map((s) => [s.id, s])),
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

const vmOf = (w: World): BagVm => bagScreen.viewModel(ctxOf(w));

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (input: Input): NavInput =>
  typeof input === 'string' ? { button: input, repeat: false } : input;
const label = (input: Input): string =>
  typeof input === 'string' ? input : `${input.button}${input.repeat ? ' (repeat)' : ''}`;

const press = (vm: BagVm, state: BagScreenState, input: Input): ButtonStep<BagScreenState> =>
  bagScreen.onButton(vm, state, asInput(input));

/** Feed `inputs` in order, each answered 'consumed', and return the last state. */
function swallowed(vm: BagVm, state: BagScreenState, inputs: readonly Input[]): BagScreenState {
  let s = state;
  for (const input of inputs) {
    const step = press(vm, s, input);
    expect(step.result, `${label(input)} is swallowed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

function observe(vm: BagVm, state: BagScreenState): BagScreenState {
  if (bagScreen.observe === undefined) throw new Error('bagScreen must define observe');
  return bagScreen.observe(vm, state, 0);
}

/** What `view.paint(p)` is handed (the type is derived from the view, never imported by path). */
type BagPaintLike = Parameters<RaisingView['paint']>[0];

function paintOf(vm: BagVm, state: BagScreenState): BagPaintLike {
  const out: BagPaintLike[] = [];
  const view = {
    paint: (p: BagPaintLike) => {
      out.push(p);
    },
  } as unknown as RaisingView;
  if (bagScreen.paint === undefined) throw new Error('bagScreen must define paint');
  bagScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as BagPaintLike;
}

const where = (s: BagScreenState): { tab: string | null; item: string | null } => ({
  tab: s.nav.tab,
  item: s.nav.item,
});

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

/** Buttons that walk a fresh frame to a phase, each answered 'consumed'. */
const TO = {
  /** The Glow Berry (first food) sheet, on Feed. */
  glowSheet: ['RB', 'A'],
  /** The Power Root (second food) sheet, on Feed. */
  rootSheet: ['RB', 'Down', 'A'],
  /** The Lure Berry (bait) sheet, on Use. */
  lureSheet: ['A'],
  /** The Antidote sheet, on Use. */
  antidoteSheet: ['RB', 'RB', 'A'],
  /** The Moon Shard sheet, on Info. */
  shardSheet: ['RB', 'RB', 'RB', 'A'],
  glowPicker: ['RB', 'A', 'A'],
  rootPicker: ['RB', 'Down', 'A', 'A'],
  /** Glow Berry's Info, opened. */
  glowInfo: ['RB', 'A', 'Down', 'A'],
  shardInfo: ['RB', 'RB', 'RB', 'A', 'A'],
} as const satisfies Record<string, readonly Input[]>;

const fresh = (vm: BagVm): BagScreenState => bagScreen.init(vm);
const walk = (vm: BagVm, steps: readonly Input[]): BagScreenState =>
  swallowed(vm, fresh(vm), steps);

describe('bagScreen — opens on the first pocket (ctl-8f, CTL8F.1)', () => {
  it('CTL8F-1-OPEN-FIRST-POCKET: the view model is the player`s own inventory over every definition with the real party size and sentinel; init opens the list on the FIRST pocket`s first item with no status, even when that pocket is empty, and with no pockets at all; the first paint is that opening', () => {
    // WRONG IMPL KILLED: a view model built from another identity's rows (the foreign x99 stack),
    // from a literal party size / sentinel, or without the item definitions; an init that opens on
    // a later pocket (the "Food" of the design flow) or in a sheet, with a leftover status, or on
    // no row while the first pocket holds one; a first pocket chosen by position of the first OWNED
    // item (an empty bait pocket must still open first); and a first paint that is not the opening.
    expect(bagScreen.nav, 'the frame takes the D-pad').toBe(true);
    const w = world();
    const vm = vmOf(w);
    const expected = buildBagVm(
      w.inventory.filter((r) => r.ownerIdentity === ME),
      new Map(w.itemDefs.map((d) => [d.id, d])),
      bagMonsters(
        w.monsters.filter((m) => m.ownerIdentity === ME),
        new Map(SPECIES.map((s) => [s.id, s])),
        PARTY_SIZE,
        NONE,
      ),
    );
    expect(vm).toEqual(expected);
    expect(vm.pockets.map((p) => p.pocket)).toEqual(['bait', 'food', 'medicine', 'other']);
    expect(
      vm.pockets.flatMap((p) => p.items).find((i) => i.itemId === ROOT)?.count,
      'the player`s Power Root x3, not the foreign x99',
    ).toBe(3);
    expect(vm.monsters.map((m) => m.key)).toEqual(['11', '12', '21', '22']);

    const opened = fresh(vm);
    expect(where(opened), 'the first pocket, its first item').toEqual({ tab: 'bait', item: '3' });
    expect(opened.phase).toEqual({ kind: 'list' });
    expect(opened.status, 'no status on open').toBeNull();
    const p = paintOf(vm, opened);
    expect(p.vm, 'the paint carries the view model').toEqual(vm);
    expect(p.nav).toEqual(opened.nav);
    expect(p.phase).toEqual({ kind: 'list' });
    expect(p.status).toBeNull();

    // The first pocket is empty (owned nothing of it): still the first pocket, no row under the
    // cursor; A does nothing; RB lands on the second pocket's first item.
    const w2 = world({ inventory: [inv(3n, ROOT, 3)] });
    const vm2 = vmOf(w2);
    expect(vm2.pockets.map((p2) => p2.pocket)).toEqual(['bait', 'food', 'medicine', 'other']);
    const emptyFirst = fresh(vm2);
    expect(where(emptyFirst)).toEqual({ tab: 'bait', item: null });
    const nothing = press(vm2, emptyFirst, 'A');
    expect(typeof nothing.result, 'A on an empty pocket answers no command').toBe('string');
    expect(nothing.state.phase, 'and opens no sheet').toEqual({ kind: 'list' });
    expect(where(swallowed(vm2, emptyFirst, ['RB']))).toEqual({ tab: 'food', item: '5' });

    // No definitions and nothing owned: no pockets, no cursor, B still pops.
    const vm3 = vmOf(world({ inventory: [], itemDefs: [] }));
    expect(vm3.pockets).toEqual([]);
    const bare = fresh(vm3);
    expect(where(bare)).toEqual({ tab: null, item: null });
    expect(typeof press(vm3, bare, 'A').result).toBe('string');
    expect(press(vm3, bare, 'B').result).toEqual(POP);
  });

  it('CTL8F-1-LBRB: RB and LB switch pockets, wrapping at the ends on a fresh press and clamping on a repeat, each pocket remembering its own cursor; the D-pad moves within the pocket (Up and Down wrap fresh and clamp on a repeat, Left and Right move nothing in a list); all swallowed, no command', () => {
    // WRONG IMPL KILLED: LB / RB that do nothing or work one way only, no wrap (the last pocket
    // would be a dead end), a wrap on a held repeat (a held PageDown would flicker between
    // pockets), a switch that resets the other pocket's cursor to its first item, one that carries
    // the cursor's INDEX across, an `unhandled` answer (the page would scroll), a Left / Right that
    // moves a list cursor, and a paint that lags the state.
    const vm = vmOf(world());
    const opened = fresh(vm);

    const rb = press(vm, opened, 'RB');
    expect(rb.result).toBe('consumed');
    expect(where(rb.state), 'RB: Food, its first item (inventory order: Glow Berry)').toEqual({
      tab: 'food',
      item: '9',
    });
    expect(paintOf(vm, rb.state).nav.tab, 'the paint follows').toBe('food');
    const seen: Array<string | null> = [rb.state.nav.tab];
    let s = rb.state;
    for (let i = 0; i < 4; i++) {
      s = swallowed(vm, s, ['RB']);
      seen.push(s.nav.tab);
    }
    expect(seen, 'RB walks the four pockets and wraps back to bait').toEqual([
      'food',
      'medicine',
      'other',
      'bait',
      'food',
    ]);
    const lb = press(vm, opened, 'LB');
    expect(lb.result).toBe('consumed');
    expect(where(lb.state), 'LB on the first pocket wraps to the last').toEqual({
      tab: 'other',
      item: '20',
    });
    expect(where(swallowed(vm, opened, ['LB', 'LB'])).tab).toBe('medicine');

    // A repeat clamps.
    expect(swallowed(vm, opened, [rep('LB')]).nav.tab, 'repeat LB on the first pocket stays').toBe(
      'bait',
    );
    expect(swallowed(vm, opened, [rep('RB')]).nav.tab, 'repeat RB moves on').toBe('food');
    const last = walk(vm, ['RB', 'RB', 'RB']);
    expect(last.nav.tab).toBe('other');
    expect(swallowed(vm, last, [rep('RB')]).nav.tab, 'repeat RB on the last pocket stays').toBe(
      'other',
    );
    expect(swallowed(vm, last, [rep('LB')]).nav.tab, 'repeat LB moves back').toBe('medicine');

    // Per-pocket memory.
    let m = walk(vm, ['RB', 'Down']);
    expect(where(m), 'Food: Down is Power Root').toEqual({ tab: 'food', item: '5' });
    m = swallowed(vm, m, ['RB']);
    expect(where(m), 'Medicine opens on its first item').toEqual({ tab: 'medicine', item: '12' });
    m = swallowed(vm, m, ['LB']);
    expect(where(m), 'back on Food, the cursor it was left on').toEqual({ tab: 'food', item: '5' });
    expect(paintOf(vm, m).nav).toEqual(m.nav);
    m = swallowed(vm, m, ['LB']);
    expect(where(m), 'Bait still on its own item').toEqual({ tab: 'bait', item: '3' });

    // D-pad inside Food [9, 5].
    const food = walk(vm, ['RB']);
    const itemAfter = (inputs: readonly Input[]): string | null =>
      swallowed(vm, food, inputs).nav.item;
    expect(itemAfter(['Down'])).toBe('5');
    expect(itemAfter(['Down', 'Down']), 'a fresh Down wraps').toBe('9');
    expect(itemAfter(['Up']), 'a fresh Up wraps').toBe('5');
    expect(itemAfter([rep('Up')]), 'a repeat Up at the top stays').toBe('9');
    expect(itemAfter(['Down', rep('Down')]), 'a repeat Down at the bottom stays').toBe('5');
    for (const input of ['Left', 'Right', rep('Left'), rep('Right')] as const) {
      const step = press(vm, food, input);
      expect(step.result, `${label(input)} is swallowed`).toBe('consumed');
      expect(step.state.nav.item, `${label(input)} moves nothing in a list`).toBe('9');
    }
    // A pocket of one item and an empty one: swallowed, cursor unmoved.
    const bait = fresh(vm);
    expect(swallowed(vm, bait, ['Down', 'Up', 'Left']).nav.item).toBe('3');
  });
});

describe('bagScreen — the item sheet (ctl-8f, CTL8F.2)', () => {
  it('CTL8F-2-SHEET: A on an item opens its sheet on the first action it offers (Feed for a food, Use for a bait or cure, Info for a shard) for THAT item, with no command; Up and Down walk the actions (wrapping fresh, clamping on a repeat, disabled rows reachable); a repeat A and A on an empty pocket open nothing; Feed is still the first row with no monsters', () => {
    // WRONG IMPL KILLED: an A that opens nothing, opens the first item's sheet instead of the
    // cursor item's, starts on the wrong action (a first row that skips a disabled Use), issues a
    // command at once, a walk that does not wrap or that skips the disabled Use, a held A that opens
    // the sheet, and a sheet whose first row depends on whether monsters exist.
    const vm = vmOf(world());
    const cases: ReadonlyArray<
      readonly [string, readonly Input[], { itemId: number; action: string }]
    > = [
      ['bait', TO.lureSheet.slice(0, 1), { itemId: LURE, action: 'use' }],
      ['the first food', ['RB', 'A'], { itemId: GLOW, action: 'feed' }],
      ['the second food, not the first', ['RB', 'Down', 'A'], { itemId: ROOT, action: 'feed' }],
      ['a cure', ['RB', 'RB', 'A'], { itemId: ANTIDOTE, action: 'use' }],
      ['a shard', ['RB', 'RB', 'RB', 'A'], { itemId: SHARD, action: 'info' }],
    ];
    for (const [name, inputs, want] of cases) {
      const step = press(vm, walk(vm, inputs.slice(0, -1)), 'A');
      expect(step.result, `${name}: the sheet is the screen's own`).toBe('consumed');
      expect(step.state.phase, `${name}: the sheet`).toEqual({ kind: 'sheet', ...want });
      expect(paintOf(vm, step.state).phase, `${name}: painted`).toEqual({ kind: 'sheet', ...want });
    }

    const actionOf = (s: BagScreenState): string | null =>
      s.phase.kind === 'sheet' ? s.phase.action : null;
    // Food [feed, info]: Down, Down wrap; Up wraps from the top.
    const glow = walk(vm, TO.glowSheet);
    expect(actionOf(glow)).toBe('feed');
    expect(actionOf(swallowed(vm, glow, ['Down']))).toBe('info');
    expect(actionOf(swallowed(vm, glow, ['Down', 'Down'])), 'a fresh Down wraps').toBe('feed');
    expect(actionOf(swallowed(vm, glow, ['Up'])), 'a fresh Up wraps').toBe('info');
    expect(actionOf(swallowed(vm, glow, [rep('Up')])), 'a repeat Up at the top stays').toBe('feed');
    expect(
      actionOf(swallowed(vm, glow, ['Down', rep('Down')])),
      'a repeat Down at the end stays',
    ).toBe('info');
    expect(swallowed(vm, glow, ['Down']).phase, 'the sheet stays on its item').toMatchObject({
      kind: 'sheet',
      itemId: GLOW,
    });
    // Bait [use (disabled), info]: the disabled row is reachable.
    const lure = walk(vm, TO.lureSheet);
    expect(actionOf(lure)).toBe('use');
    expect(actionOf(swallowed(vm, lure, ['Down'])), 'Use is reachable and Down leaves it').toBe(
      'info',
    );
    expect(actionOf(swallowed(vm, lure, ['Up'])), 'Up from Use wraps to Info').toBe('info');
    // A shard has Info only: every walk stays on it.
    const shard = walk(vm, TO.shardSheet);
    expect(actionOf(swallowed(vm, shard, ['Down', 'Up', rep('Down')]))).toBe('info');

    // A repeat A and an empty pocket open nothing; a repeat A in the sheet opens nothing either.
    const held = press(vm, fresh(vm), rep('A'));
    expect(typeof held.result, 'a repeat A answers no command').toBe('string');
    expect(held.state.phase, 'and opens no sheet').toEqual({ kind: 'list' });
    const heldInSheet = press(vm, shard, rep('A'));
    expect(typeof heldInSheet.result).toBe('string');
    expect(heldInSheet.state.phase, 'a repeat A on Info does not open it').toEqual({
      kind: 'sheet',
      itemId: SHARD,
      action: 'info',
    });

    // No monsters: Feed is still the first row (disabled, reachable).
    const lonely = vmOf(world({ monsters: [] }));
    const lonelySheet = walk(lonely, ['RB', 'A']);
    expect(lonelySheet.phase).toEqual({ kind: 'sheet', itemId: GLOW, action: 'feed' });
  });

  it('CTL8F-2-FEED-PICKER: A on Feed opens the monster picker on the first monster (party then storage); Up and Down walk it; A on a monster answers exactly the train command for that monster and item, with the picker closed, the list phase and the cursor back on the item (no confirm); a held A sends nothing; with no monster Feed is refused with the noMonsters status', () => {
    // WRONG IMPL KILLED: a Feed that never opens the picker or opens it on the last monster; a
    // picker in store order or sorted by name (party slot order, then storage); a walk that does
    // not wrap; an A that sends a command with the wrong monster id, the wrong item id (the cursor
    // index instead of the item id) or an extra field; a confirm step in between (the contract has
    // none); a picker left open, or a cursor left on the first item or on another pocket after the
    // send; a held A (a held Enter) that feeds again; and a Feed on an empty roster that opens an
    // empty picker or says nothing.
    const vm = vmOf(world());
    const picker = walk(vm, TO.glowPicker);
    expect(picker.phase, 'the picker opens on the first monster').toEqual({
      kind: 'picker',
      itemId: GLOW,
      monster: '11',
    });
    expect(paintOf(vm, picker).phase).toEqual({ kind: 'picker', itemId: GLOW, monster: '11' });
    const monsterOf = (s: BagScreenState): string | null =>
      s.phase.kind === 'picker' ? s.phase.monster : null;
    const seen: Array<string | null> = [monsterOf(picker)];
    let s = picker;
    for (let i = 0; i < 4; i++) {
      s = swallowed(vm, s, ['Down']);
      seen.push(monsterOf(s));
    }
    expect(seen, 'party in slot order, then storage; Down wraps').toEqual([
      '11',
      '12',
      '21',
      '22',
      '11',
    ]);
    expect(monsterOf(swallowed(vm, picker, ['Up'])), 'a fresh Up wraps').toBe('22');
    expect(monsterOf(swallowed(vm, picker, [rep('Up')])), 'a repeat Up at the top stays').toBe(
      '11',
    );
    expect(
      monsterOf(swallowed(vm, picker, ['Down', 'Down', 'Down', rep('Down')])),
      'a repeat Down at the end stays',
    ).toBe('22');

    // A on the second monster of Glow Berry, then on the third monster of Power Root.
    const sendGlow = press(vm, swallowed(vm, picker, ['Down']), 'A');
    expect(sendGlow.result, 'exactly the train command').toEqual({
      kind: 'train',
      monsterId: 12n,
      foodItemId: GLOW,
    });
    expect(sendGlow.state.phase, 'the picker is closed: the list, no confirm phase').toEqual({
      kind: 'list',
    });
    expect(where(sendGlow.state), 'the cursor is back on the item').toEqual({
      tab: 'food',
      item: '9',
    });
    expect(sendGlow.state.status, 'nothing is claimed before a batch shows the food go').toBeNull();
    expect(paintOf(vm, sendGlow.state).phase).toEqual({ kind: 'list' });

    const rootPicker = walk(vm, TO.rootPicker);
    expect(rootPicker.phase).toEqual({ kind: 'picker', itemId: ROOT, monster: '11' });
    const sendRoot = press(vm, swallowed(vm, rootPicker, ['Down', 'Down']), 'A');
    expect(sendRoot.result).toEqual({ kind: 'train', monsterId: 21n, foodItemId: ROOT });
    expect(where(sendRoot.state), 'on Power Root, the second food').toEqual({
      tab: 'food',
      item: '5',
    });
    expect(sendRoot.state.phase.kind).toBe('list');
    // The first monster straight away.
    expect(press(vm, picker, 'A').result).toEqual({
      kind: 'train',
      monsterId: 11n,
      foodItemId: GLOW,
    });

    // A held A sends nothing, anywhere on the way.
    const heldPicker = press(vm, swallowed(vm, picker, ['Down']), rep('A'));
    expect(typeof heldPicker.result, 'a repeat A in the picker sends no command').toBe('string');
    expect(heldPicker.state.phase, 'and the picker stays where it was').toEqual({
      kind: 'picker',
      itemId: GLOW,
      monster: '12',
    });
    const heldFeed = press(vm, walk(vm, TO.glowSheet), rep('A'));
    expect(typeof heldFeed.result).toBe('string');
    expect(heldFeed.state.phase.kind, 'a repeat A on Feed opens no picker').toBe('sheet');

    // No monsters: A on the disabled Feed says why and changes nothing.
    const lonely = vmOf(world({ monsters: [] }));
    const lonelySheet = walk(lonely, ['RB', 'A']);
    const refused = press(lonely, lonelySheet, 'A');
    expect(refused.result, 'swallowed, no command').toBe('consumed');
    expect(refused.state.phase, 'the sheet stays').toEqual({
      kind: 'sheet',
      itemId: GLOW,
      action: 'feed',
    });
    expect(refused.state.status).toEqual({ kind: 'noMonsters' });
    expect(paintOf(lonely, refused.state).status, 'painted').toEqual({ kind: 'noMonsters' });
  });

  it('CTL8F-2-USE-DISABLED: A on Use is swallowed with no command, the sheet stays, and the battleOnly status is set; a repeat A sets nothing; the next button clears the status; the same for a cure and a bait', () => {
    // WRONG IMPL KILLED: a Use that sends a command (a `useItem` outside a battle would be refused
    // by the server or, worse, accepted), one that closes the sheet or opens Info, a status that is
    // never set or never cleared (the line would stick for the whole visit), a status set by a held
    // key, and a status painted for only one of the two disabled kinds.
    const vm = vmOf(world());
    for (const [name, steps, itemId] of [
      ['bait', TO.lureSheet, LURE],
      ['cure', TO.antidoteSheet, ANTIDOTE],
    ] as const) {
      const sheet = walk(vm, steps);
      expect(sheet.phase, `${name}: precondition`).toEqual({
        kind: 'sheet',
        itemId,
        action: 'use',
      });
      expect(sheet.status, `${name}: no status yet`).toBeNull();

      const held = press(vm, sheet, rep('A'));
      expect(typeof held.result, `${name}: a repeat A sends nothing`).toBe('string');
      expect(held.state.status, `${name}: a repeat A sets no status`).toBeNull();

      const a = press(vm, sheet, 'A');
      expect(a.result, `${name}: swallowed, no command`).toBe('consumed');
      expect(a.state.phase, `${name}: the sheet stays on Use`).toEqual({
        kind: 'sheet',
        itemId,
        action: 'use',
      });
      expect(a.state.status, `${name}: the battleOnly line`).toEqual({ kind: 'battleOnly' });
      expect(paintOf(vm, a.state).status, `${name}: painted`).toEqual({ kind: 'battleOnly' });

      // The next button ends the line, whichever it is.
      for (const next of ['Down', 'Up', 'X', 'Left'] as const) {
        const step = press(vm, a.state, next);
        expect(step.state.status, `${name}: ${next} clears the status`).toBeNull();
      }
      // A again sets it again; B clears it and leaves the sheet.
      const again = press(vm, press(vm, a.state, 'Down').state, 'Up');
      expect(press(vm, again.state, 'A').state.status).toEqual({ kind: 'battleOnly' });
      const back = press(vm, a.state, 'B');
      expect(back.state.status, `${name}: B clears it`).toBeNull();
      expect(back.state.phase).toEqual({ kind: 'list' });
      expect(where(back.state)).toEqual(where(sheet));
    }
  });

  it('CTL8F-2-INFO: A on Info opens that item`s description phase with no command, A or B there returns to the sheet on Info, and Info works for a food (reached by Down), a bait and a shard alike', () => {
    // WRONG IMPL KILLED: an Info that sends a command or does nothing, an info phase for another
    // item, an A in the description that acts on whatever the sheet row was (a Feed from Info), a B
    // that skips the sheet and drops to the list, and a return to the sheet's FIRST row (the cursor
    // must stay on Info).
    const vm = vmOf(world());
    const cases: ReadonlyArray<readonly [string, readonly Input[], number]> = [
      ['a food', TO.glowInfo.slice(0, -1), GLOW],
      ['a shard', TO.shardInfo.slice(0, -1), SHARD],
      ['a bait', ['A', 'Down'], LURE],
    ];
    for (const [name, steps, itemId] of cases) {
      const sheet = walk(vm, steps);
      expect(sheet.phase, `${name}: precondition`).toMatchObject({
        kind: 'sheet',
        itemId,
        action: 'info',
      });
      const opened = press(vm, sheet, 'A');
      expect(opened.result, `${name}: no command`).toBe('consumed');
      expect(opened.state.phase, `${name}: the description`).toEqual({ kind: 'info', itemId });
      expect(paintOf(vm, opened.state).phase, `${name}: painted`).toEqual({ kind: 'info', itemId });
      for (const key of ['A', 'B'] as const) {
        const back = press(vm, opened.state, key);
        expect(back.result, `${name}: ${key} is swallowed`).toBe('consumed');
        expect(back.state.phase, `${name}: ${key} returns to the sheet on Info`).toEqual({
          kind: 'sheet',
          itemId,
          action: 'info',
        });
      }
      // A repeat A in the description does nothing.
      const held = press(vm, opened.state, rep('A'));
      expect(held.state.phase, `${name}: a repeat A stays`).toEqual({ kind: 'info', itemId });
    }
  });

  it('CTL8F-2-B-BACK: B backs out one level at a time (picker to the sheet on Feed, sheet to the list on that item whichever pocket it is in, list pops); Start pops to the base and Select toggles help from every phase; X and Y are the page`s in the list and swallowed in the other phases, as are LB, RB, Left and Right there', () => {
    // WRONG IMPL KILLED: a B that pops the whole frame from a sheet (the player loses the list), a
    // list that resets to the first item or first pocket on return, a picker B that skips the
    // sheet, a Start swallowed in a sub-phase (the frame could not be left from the sheet), a Select
    // that is lost, an X / Y swallowed in the list (they belong to the page / a later slice), an
    // X / Y / LB / RB that leaks out of a sheet, info or picker (the world would walk, or a pocket
    // switch would change the item under an open sheet), and a Left / Right that moves a picker
    // cursor.
    const vm = vmOf(world());

    // Picker (Power Root, second food) -> sheet(feed) -> list on Power Root -> pop.
    const picker = walk(vm, TO.rootPicker);
    const toSheet = press(vm, picker, 'B');
    expect(toSheet.result).toBe('consumed');
    expect(toSheet.state.phase, 'B in the picker: the sheet on Feed').toEqual({
      kind: 'sheet',
      itemId: ROOT,
      action: 'feed',
    });
    const toList = press(vm, toSheet.state, 'B');
    expect(toList.result).toBe('consumed');
    expect(toList.state.phase).toEqual({ kind: 'list' });
    expect(where(toList.state), 'the cursor is on the item the sheet was for').toEqual({
      tab: 'food',
      item: '5',
    });
    expect(paintOf(vm, toList.state).nav).toEqual(toList.state.nav);
    expect(press(vm, toList.state, 'B').result, 'B in the list pops').toEqual(POP);

    // Another pocket: the Antidote's sheet returns to Medicine, its item.
    const medicine = press(vm, walk(vm, TO.antidoteSheet), 'B');
    expect(medicine.state.phase).toEqual({ kind: 'list' });
    expect(where(medicine.state)).toEqual({ tab: 'medicine', item: '12' });

    // Start and Select from every phase.
    const phases: ReadonlyArray<readonly [string, BagScreenState]> = [
      ['list', fresh(vm)],
      ['sheet', walk(vm, TO.glowSheet)],
      ['info', walk(vm, TO.glowInfo)],
      ['picker', picker],
      ['sheet with a status', press(vm, walk(vm, TO.lureSheet), 'A').state],
    ];
    for (const [name, s] of phases) {
      expect(press(vm, s, 'Start').result, `Start in the ${name} phase`).toEqual(POP_TO_BASE);
      expect(press(vm, s, 'Select').result, `Select in the ${name} phase`).toEqual(TOGGLE_HELP);
    }
    expect(phases[2]?.[1].phase.kind, 'ANTI-VACUITY: the info phase was reached').toBe('info');
    expect(phases[3]?.[1].phase.kind, 'ANTI-VACUITY: the picker phase was reached').toBe('picker');

    // The button table. List phase.
    const list = fresh(vm);
    for (const button of ['Up', 'Down', 'Left', 'Right', 'LB', 'RB'] as const) {
      expect(press(vm, list, button).result, `list ${button}`).toBe('consumed');
      expect(press(vm, list, rep(button)).result, `list ${button} (repeat)`).toBe('consumed');
    }
    for (const button of ['X', 'Y'] as const) {
      expect(press(vm, list, button).result, `list ${button}`).toBe('unhandled');
      expect(press(vm, list, rep(button)).result, `list ${button} (repeat)`).toBe('unhandled');
    }
    // Sheet, info and picker swallow X, Y, LB, RB, Left, Right and leave the phase as it was.
    for (const [name, s] of phases.slice(1, 4)) {
      for (const button of ['X', 'Y', 'LB', 'RB', 'Left', 'Right'] as const) {
        const step = press(vm, s, button);
        expect(step.result, `${name} ${button}`).toBe('consumed');
        expect(step.state.phase, `${name} ${button}: the phase is unchanged`).toEqual(s.phase);
        expect(where(step.state), `${name} ${button}: the cursor is unchanged`).toEqual(where(s));
      }
    }
    // Info also swallows Up and Down without changing anything.
    const info = phases[2]?.[1] as BagScreenState;
    for (const button of ['Up', 'Down'] as const) {
      const step = press(vm, info, button);
      expect(step.result, `info ${button}`).toBe('consumed');
      expect(step.state.phase).toEqual(info.phase);
    }
  });
});

describe('bagScreen — the fed feedback (ctl-8f, CTL8F.2)', () => {
  it('CTL8F-2-FED-FEEDBACK: after a train the Fed line shows only once a batch shows that item`s live count below its count at the press (a vanished item or a count of zero reads as fed), with the monster`s name taken at the press; a batch that leaves the count, raises it or drops another item shows nothing; the next button clears the line', () => {
    // WRONG IMPL KILLED: a Fed line claimed at the press (a refused train would still say Fed); one
    // that waits for a count of zero; one that never counts a vanished stack as fed (the last Glow
    // Berry eaten deletes the row); one that compares the wrong item (a drop in ANOTHER stack shows
    // Fed); one that fires on a count that rose; a name read at the batch (the monster renamed by
    // the same batch would show its new name); a line that sticks past the next button; and the
    // species fallback lost (an unnamed monster).
    const w0 = world();
    const vm0 = vmOf(w0);
    const feedTo = (steps: readonly Input[], itemSteps: readonly Input[]) => {
      const picker = walk(vm0, itemSteps);
      const sent = press(vm0, swallowed(vm0, picker, steps), 'A');
      expect(typeof sent.result, 'precondition: the train command, not a string').toBe('object');
      return sent.state;
    };

    // Monster 12 (Emberfang, no nickname), Glow Berry x2. The first observe after any open paints
    // (see the observe case below), so settle once before asserting that an unchanged batch
    // repaints nothing.
    const pressed = feedTo(['Down'], TO.glowPicker);
    expect(pressed.status, 'nothing at the press').toBeNull();
    const pending = observe(vm0, pressed);
    expect(pending.status, 'a batch that changed nothing shows no Fed line').toBeNull();
    expect(observe(vm0, pending), 'and a second one repaints nothing').toBe(pending);

    // The count drops 2 -> 1: fed, with the name taken at the press.
    const w1 = withCount(w0, GLOW, 1);
    const vm1 = vmOf(w1);
    const fed = observe(vm1, pending);
    expect(fed, 'the fed line is a change: a new state, painted once').not.toBe(pending);
    expect(fed.status).toEqual({ kind: 'fed', name: 'Emberfang' });
    expect(paintOf(vm1, fed).status, 'painted').toEqual({ kind: 'fed', name: 'Emberfang' });
    expect(observe(vm1, fed), 'the line stays until a button').toBe(fed);
    expect(observe(vm1, fed).status).toEqual({ kind: 'fed', name: 'Emberfang' });
    for (const next of ['Down', 'Up', 'RB', 'X', 'A'] as const) {
      expect(press(vm1, fed, next).state.status, `${next} clears the Fed line`).toBeNull();
    }

    // The name is the press-time name even when the very batch renames the monster.
    const renamedBatch = renamedMonster(w1, 12n, 'Zed');
    expect(observe(vmOf(renamedBatch), pending).status).toEqual({ kind: 'fed', name: 'Emberfang' });
    // A nickname and the species fallback, by monster.
    const byMonster: ReadonlyArray<readonly [readonly Input[], string]> = [
      [[], 'Kip'],
      [['Down'], 'Emberfang'],
      [['Down', 'Down'], 'Sproutle'],
    ];
    for (const [steps, name] of byMonster) {
      const s = feedTo(steps, TO.glowPicker);
      expect(observe(vm1, s).status, `monster after ${steps.join('+') || 'nothing'}`).toEqual({
        kind: 'fed',
        name,
      });
    }

    // A vanished item and a count of zero both read as 0: fed. Power Root x3 (the second food).
    const rootPending = feedTo([], TO.rootPicker);
    expect(
      observe(vmOf(withoutItem(w0, ROOT)), rootPending).status,
      'the stack was deleted',
    ).toEqual({
      kind: 'fed',
      name: 'Kip',
    });
    expect(observe(vmOf(withCount(w0, ROOT, 0)), rootPending).status, 'a count-0 row').toEqual({
      kind: 'fed',
      name: 'Kip',
    });
    expect(observe(vmOf(withCount(w0, ROOT, 2)), rootPending).status, 'x3 -> x2').toEqual({
      kind: 'fed',
      name: 'Kip',
    });

    // Not fed: the count is unchanged, higher, or only ANOTHER item changed.
    const quiet: ReadonlyArray<readonly [string, World]> = [
      ['the same count, a monster renamed', renamedMonster(w0, 12n, 'Zed')],
      ['the count rose', withCount(w0, GLOW, 5)],
      ['another food dropped', withCount(w0, ROOT, 1)],
      ['a different pocket dropped', withCount(w0, LURE, 1)],
      ['another food vanished', withoutItem(w0, ROOT)],
    ];
    for (const [name, w] of quiet) {
      expect(observe(vmOf(w), pending).status, name).toBeNull();
    }
  });
});

describe('bagScreen — observe (ctl-8f, CTL8F.2)', () => {
  it('CTL8F-2-OBSERVE: the first observe after init answers a NEW state so the host paints on the first batch, an equal batch after that answers the SAME object, a count or name change of a listed item or a description change on an open Info answers a new state, a status survives an observe, a cursor whose item vanished is re-seated (an emptied pocket stays a tab), a sheet, info or picker whose item vanished closes to the list, and a picker whose monster vanished never sends for it', () => {
    // WRONG IMPL KILLED: an init whose `shown` already matches (the first batch would paint
    // nothing and the Bag would stay hidden until a button); an observe that always answers a new
    // state (a repaint on every batch: the view rebuilds under the player); one that never does
    // (the counts stay stale after a feed); one that ignores a def rename or an Info description
    // change; an observe that clears the status line (it is only a button's to clear); a cursor
    // left on a vanished key (A would open a sheet for nothing); an emptied pocket that loses its
    // tab (the tab strip would jump); a sheet / info / picker kept open for an item that is gone
    // (a train for a spent food); and a picker whose cursor monster vanished still sending it.
    const w0 = world();
    const vm0 = vmOf(w0);
    const initial = fresh(vm0);

    // The first observe is a change; the next equal batch is not.
    const first = observe(vm0, initial);
    expect(first, 'the first observe after init answers a new state').not.toBe(initial);
    expect(paintOf(vm0, first).phase, 'it paints').toEqual({ kind: 'list' });
    expect(
      observe(vmOf(world()), first),
      'an equal batch (a fresh view model): the same object',
    ).toBe(first);
    expect(observe(vm0, first)).toBe(first);

    // Counts, names and descriptions painted.
    const food = walk(vm0, ['RB']);
    const settledFood = observe(vm0, food);
    expect(observe(vm0, settledFood), 'settled: equal batch, same object').toBe(settledFood);
    const counted = observe(vmOf(withCount(w0, ROOT, 2)), settledFood);
    expect(counted, 'a count change of a listed item').not.toBe(settledFood);
    const paintedCount = paintOf(vmOf(withCount(w0, ROOT, 2)), counted)
      .vm.pockets.flatMap((p) => p.items)
      .find((i) => i.itemId === ROOT)?.count;
    expect(paintedCount).toBe(2);
    expect(observe(vmOf(withCount(w0, ROOT, 2)), counted), 'and then equal again').toBe(counted);
    expect(
      observe(vmOf(withDef(w0, GLOW, { name: 'Glow Fruit' })), settledFood),
      'a definition renamed',
    ).not.toBe(settledFood);

    const shardInfo = walk(vm0, TO.shardInfo);
    const settledInfo = observe(vm0, shardInfo);
    expect(observe(vm0, settledInfo)).toBe(settledInfo);
    expect(
      observe(vmOf(withDef(w0, SHARD, { description: 'It glows.' })), settledInfo),
      'the open description changed',
    ).not.toBe(settledInfo);

    // A status survives an observe.
    const useRefused = press(vm0, walk(vm0, TO.lureSheet), 'A').state;
    expect(useRefused.status).toEqual({ kind: 'battleOnly' });
    const settledUse = observe(vm0, useRefused);
    expect(settledUse.status, 'observe never clears the status').toEqual({ kind: 'battleOnly' });
    expect(observe(vm0, settledUse), 'and an equal batch leaves it be').toBe(settledUse);

    // Re-seating. Food [9, 5]: the cursor on 9 vanishes -> 5; the cursor on 5 vanishes -> 9.
    const onGlow = observe(vmOf(withoutItem(w0, GLOW)), food);
    expect(where(onGlow), 'the cursor moves to the nearest item').toEqual({
      tab: 'food',
      item: '5',
    });
    const onRoot = walk(vm0, ['RB', 'Down']);
    const afterRoot = observe(vmOf(withoutItem(w0, ROOT)), onRoot);
    expect(where(afterRoot)).toEqual({ tab: 'food', item: '9' });
    expect(
      paintOf(vmOf(withoutItem(w0, ROOT)), afterRoot).nav,
      'the paint carries the re-seated cursor',
    ).toEqual(afterRoot.nav);

    // The only Medicine item vanishes: the pocket stays a tab (a definition holds it), no item.
    const medicine = walk(vm0, ['RB', 'RB']);
    const emptied = observe(vmOf(withoutItem(w0, ANTIDOTE)), medicine);
    expect(
      where(emptied),
      'Medicine is still the active tab, with nothing under the cursor',
    ).toEqual({
      tab: 'medicine',
      item: null,
    });
    expect(
      vmOf(withoutItem(w0, ANTIDOTE)).pockets.map((p) => p.pocket),
      'precondition: all four tabs remain',
    ).toEqual(['bait', 'food', 'medicine', 'other']);

    // A phase whose item vanished closes to the list.
    const sheet = walk(vm0, TO.antidoteSheet);
    const closedSheet = observe(vmOf(withoutItem(w0, ANTIDOTE)), sheet);
    expect(closedSheet.phase, 'the sheet closes').toEqual({ kind: 'list' });
    expect(where(closedSheet)).toEqual({ tab: 'medicine', item: null });
    const closedInfo = observe(vmOf(withoutItem(w0, SHARD)), walk(vm0, TO.shardInfo));
    expect(closedInfo.phase, 'the description closes').toEqual({ kind: 'list' });
    expect(where(closedInfo)).toEqual({ tab: 'other', item: null });
    const closedPicker = observe(vmOf(withoutItem(w0, GLOW)), walk(vm0, TO.glowPicker));
    expect(closedPicker.phase, 'the picker closes').toEqual({ kind: 'list' });
    expect(where(closedPicker)).toEqual({ tab: 'food', item: '5' });
    // A sheet whose item survived stays open.
    const keptSheet = observe(vmOf(withoutItem(w0, ROOT)), walk(vm0, TO.glowSheet));
    expect(keptSheet.phase).toEqual({ kind: 'sheet', itemId: GLOW, action: 'feed' });

    // The picker's monster vanishes under the cursor: A never trains the monster that is gone.
    const onSecond = walk(vm0, [...TO.glowPicker, 'Down']);
    expect(onSecond.phase).toMatchObject({ kind: 'picker', monster: '12' });
    const vmGone = vmOf(withoutMonster(w0, 12n));
    const reseated = observe(vmGone, onSecond);
    const sent = press(vmGone, reseated, 'A');
    if (typeof sent.result === 'string') {
      expect(sent.result, 'swallowed, never a stale command').toBe('consumed');
    } else {
      expect(sent.result.kind).toBe('train');
      expect(
        [11n, 21n, 22n].includes((sent.result as { monsterId: bigint }).monsterId),
        'a monster that is still listed',
      ).toBe(true);
    }
  });
});
