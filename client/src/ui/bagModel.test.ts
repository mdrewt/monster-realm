// ui/bagModel.test.ts — ctl-8f (CTL8F.1, CTL8F.2): the Bag's pure model.
//
// Node env, no DOM. `buildBagVm` / `pocketOf` / `actionLayout` / `bagLayout` / `pickerLayout` /
// `findItem` / `bagMonsters` are driven with fixtures and read off what they return.
//
// StoreItemRow has NO category field, so the pockets are DERIVED from an item definition's data:
// `trainStat != null` is food, else `cureStatus != null` is medicine, else `recruitBonus > 0` is bait,
// else (and an unknown definition) other. The tabs are the pockets the DATA holds (every definition,
// owned or not, plus an owned row whose definition is unknown), ordered by the LOWEST item id that
// falls in each pocket. Every fixture below that decides an order uses ids no content file ships
// (900+), so a table of ids or a fixed pocket list fails.
//
// Ambiguity resolved: an OWNED row with an unknown definition adds the `other` pocket, but whether its
// own id also counts toward `other`'s ordering is not pinned. Every fixture that has one puts that id
// ABOVE every definition id, so both readings give the same order.
import { describe, expect, it } from 'vitest';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../net/store';
import {
  actionLayout,
  BAG_BACK_KEY,
  type BagItemVm,
  type BagVm,
  bagLayout,
  bagMonsters,
  buildBagVm,
  findItem,
  infoLayout,
  isBagBackKey,
  type Pocket,
  pickerLayout,
  pocketOf,
} from './bagModel';
import { monsterKey } from './monstersModel';
import type { ItemLayout } from './nav';

const ME = 'ab'.repeat(32);

function def(id: number, over: Partial<StoreItemRow> = {}): StoreItemRow {
  return {
    id,
    name: `Item ${id}`,
    description: `About ${id}.`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
    ...over,
  };
}
const food = (id: number, name = `Food ${id}`): StoreItemRow =>
  def(id, { name, trainStat: 'attack', trainAmount: 1 });
const cure = (id: number, name = `Cure ${id}`): StoreItemRow =>
  def(id, { name, cureStatus: 'Poison' });
const bait = (id: number, name = `Bait ${id}`): StoreItemRow => def(id, { name, recruitBonus: 10 });
const plain = (id: number, name = `Plain ${id}`): StoreItemRow => def(id, { name });

const defsOf = (...rows: StoreItemRow[]): ReadonlyMap<number, StoreItemRow> =>
  new Map(rows.map((r) => [r.id, r]));
const inv = (invId: number, itemId: number, count: number): StoreInventory => ({
  invId: BigInt(invId),
  ownerIdentity: ME,
  itemId,
  count,
});
const pocketsOf = (vm: BagVm): Pocket[] => vm.pockets.map((p) => p.pocket);
const keysIn = (vm: BagVm, pocket: Pocket): string[] =>
  vm.pockets.find((p) => p.pocket === pocket)?.items.map((i) => i.key) ?? ['<no such pocket>'];

function at<T>(items: readonly T[], i: number): T {
  const found = items[i];
  if (found === undefined) throw new Error(`fixture: no item ${i}`);
  return found;
}

describe('pocketOf (ctl-8f, CTL8F.1)', () => {
  it('CTL8F-1-POCKET-OF: a definition with a trainStat is food, else one with a cureStatus is medicine, else one with a positive recruitBonus is bait, else (and an unknown definition) other; the precedence is food > medicine > bait and the answer reads the fields, never the id', () => {
    // WRONG IMPL KILLED: a classifier keyed on ids (the same fields under id 1 and id 900 must
    // agree), one that tests bait before medicine or food (the precedence rows), `recruitBonus !== 0`
    // or `>= 0` (a negative or zero bonus is NOT bait), a truthiness test on trainStat / cureStatus
    // (the empty string is a value: the shared `canTrain` rule is `trainStat != null`), and an
    // undefined definition that throws.
    const cases: ReadonlyArray<readonly [string, StoreItemRow | undefined, Pocket]> = [
      ['an unknown definition', undefined, 'other'],
      ['no effect fields', plain(1), 'other'],
      ['a trainStat', food(1), 'food'],
      ['a trainStat under another id', food(900), 'food'],
      ['a cureStatus', cure(1), 'medicine'],
      ['a cureStatus under another id', cure(900), 'medicine'],
      ['a positive recruitBonus', bait(1), 'bait'],
      ['a positive recruitBonus under another id', bait(900), 'bait'],
      ['recruitBonus 1', def(1, { recruitBonus: 1 }), 'bait'],
      ['recruitBonus 0', def(1, { recruitBonus: 0 }), 'other'],
      ['a negative recruitBonus', def(1, { recruitBonus: -5 }), 'other'],
      [
        'trainStat + cureStatus: food wins',
        def(1, { trainStat: 'speed', cureStatus: 'Sleep' }),
        'food',
      ],
      [
        'trainStat + recruitBonus: food wins',
        def(1, { trainStat: 'speed', recruitBonus: 9 }),
        'food',
      ],
      [
        'cureStatus + recruitBonus: medicine wins',
        def(1, { cureStatus: 'Sleep', recruitBonus: 9 }),
        'medicine',
      ],
      [
        'all three: food wins',
        def(1, { trainStat: 'hp', cureStatus: 'Sleep', recruitBonus: 9 }),
        'food',
      ],
      ['an empty-string trainStat is still a trainStat', def(1, { trainStat: '' }), 'food'],
      ['an empty-string cureStatus is still a cureStatus', def(1, { cureStatus: '' }), 'medicine'],
    ];
    for (const [label, d, want] of cases) {
      expect(pocketOf(d), label).toBe(want);
    }
  });
});

describe('buildBagVm — the pockets and the owned rows (ctl-8f, CTL8F.1)', () => {
  it('CTL8F-1-POCKETS-FROM-DATA: the tabs are the pockets the data holds, ordered by the lowest item id in each; a fixture of ids 900+ with only a food and a cure definition yields exactly food then medicine, swapping their effect fields swaps the order, and the shipped-shape content ids 1..5 give bait, food, medicine, other (that last order depends on those content ids)', () => {
    // WRONG IMPL KILLED: a hard-coded pocket list or order (bait, food, medicine, other) filtered by
    // presence: the swapped fixture would still say food first; a table of shipped ids; a tab for a
    // pocket nothing in the data holds (the exact `['food','medicine']`); an order that follows Map
    // insertion order or the inventory order instead of the lowest id (the scrambled fixtures); an
    // order by the HIGHEST id in a pocket (the extra definitions above the lowest ones).
    const none = [] as const;
    const food900 = buildBagVm(none, defsOf(food(900), cure(901)), []);
    expect(pocketsOf(food900), 'ids 900 food, 901 cure').toEqual(['food', 'medicine']);

    const swapped = buildBagVm(none, defsOf(cure(900), food(901)), []);
    expect(pocketsOf(swapped), 'the same ids with the effect fields swapped').toEqual([
      'medicine',
      'food',
    ]);

    // Map order and inventory order are both scrambled against the id order.
    const scrambled = defsOf(
      cure(950),
      food(902),
      plain(903),
      bait(901),
      cure(900),
      food(951),
      plain(960),
    );
    const owned = [inv(1, 951, 1), inv(2, 960, 1), inv(3, 950, 1), inv(4, 901, 1)];
    expect(
      pocketsOf(buildBagVm(owned, scrambled, [])),
      'lowest ids: medicine 900, bait 901, food 902, other 903',
    ).toEqual(['medicine', 'bait', 'food', 'other']);
    expect(
      pocketsOf(buildBagVm([], scrambled, [])),
      'the same tabs with nothing owned: a definition defines its pocket',
    ).toEqual(['medicine', 'bait', 'food', 'other']);

    // The shipped-shape content: 1 bait, 2 food, 3 medicine, 4 and 5 shards. This order depends on
    // those content ids (the lowest id of each pocket), not on a fixed list.
    const shipped = defsOf(
      def(1, { name: 'Lure Berry', recruitBonus: 20 }),
      def(2, { name: 'Power Root', trainStat: 'attack', trainAmount: 2 }),
      def(3, { name: 'Antidote', cureStatus: 'Poison' }),
      def(4, { name: 'Moon Shard' }),
      def(5, { name: 'Sun Shard' }),
    );
    expect(pocketsOf(buildBagVm([], shipped, []))).toEqual(['bait', 'food', 'medicine', 'other']);
    expect(
      pocketsOf(buildBagVm([inv(1, 5, 1)], shipped, [])),
      'ownership never reorders the tabs',
    ).toEqual(['bait', 'food', 'medicine', 'other']);

    // No definitions and nothing owned: no tabs at all.
    expect(pocketsOf(buildBagVm([], new Map(), []))).toEqual([]);
  });

  it('CTL8F-1-OWNED-QTY: only rows with count above zero list, rows of one item id merge into one line with their counts summed at the first occurrence`s place, an owned row with an unknown definition adds the other pocket as Unknown (#id), and a pocket only a definition holds is still a tab with zero items', () => {
    // WRONG IMPL KILLED: a list that shows count-0 or negative rows ("Bait (x0)"); one line per
    // ROW (two stacks of one item would list twice and the nav kit throws on the duplicate key);
    // merged counts that keep the first row's count only; a merged line placed at the LAST
    // occurrence or sorted by id (the inventory order is scrambled against the ids); an unknown
    // item dropped, or listed in a pocket that does not exist; an unknown item with count 0 that
    // still conjures the `other` tab; a pocket that vanishes when nothing in it is owned.
    const defs = defsOf(food(902), cure(903), food(904), food(905));

    // count > 0 only.
    const counts = buildBagVm([inv(1, 902, 3), inv(2, 904, 0), inv(3, 905, -1)], defs, []);
    expect(keysIn(counts, 'food'), 'count 0 and count -1 are not listed').toEqual(['902']);
    expect(at(counts.pockets, 0).items[0]?.count).toBe(3);

    // Merge, first occurrence wins the place, counts add.
    const merged = buildBagVm(
      [inv(1, 905, 1), inv(2, 902, 3), inv(3, 904, 2), inv(4, 902, 4), inv(5, 905, 10)],
      defs,
      [],
    );
    expect(keysIn(merged, 'food'), 'one line per item id, in first-occurrence order').toEqual([
      '905',
      '902',
      '904',
    ]);
    const foodItems = merged.pockets.find((p) => p.pocket === 'food')?.items ?? [];
    expect(
      foodItems.map((i) => [i.itemId, i.count]),
      'counts summed over the duplicate rows',
    ).toEqual([
      [905, 11],
      [902, 7],
      [904, 2],
    ]);
    // A duplicate row with count 0 adds nothing but the other row still lists.
    const withZero = buildBagVm([inv(1, 902, 0), inv(2, 902, 5)], defs, []);
    expect(keysIn(withZero, 'food')).toEqual(['902']);
    expect(withZero.pockets.find((p) => p.pocket === 'food')?.items[0]?.count).toBe(5);

    // An unknown definition, owned: the `other` pocket, named Unknown (#id), no description.
    const unknown = buildBagVm([inv(1, 902, 1), inv(2, 990, 2)], defsOf(food(902)), []);
    expect(pocketsOf(unknown), 'the owned unknown row adds `other` after food').toEqual([
      'food',
      'other',
    ]);
    const stray = unknown.pockets.find((p) => p.pocket === 'other')?.items[0];
    expect(stray).toEqual({
      key: '990',
      itemId: 990,
      name: 'Unknown (#990)',
      description: '',
      count: 2,
      canFeed: false,
      battleUse: false,
    });
    // ...but an unknown row with count 0 owns nothing, so no `other` tab appears.
    const ghost = buildBagVm([inv(1, 902, 1), inv(2, 991, 0)], defsOf(food(902)), []);
    expect(pocketsOf(ghost)).toEqual(['food']);

    // A pocket only a definition holds is a tab with no items.
    const stocked = buildBagVm([inv(1, 902, 4)], defsOf(food(902), cure(903)), []);
    expect(pocketsOf(stocked)).toEqual(['food', 'medicine']);
    expect(keysIn(stocked, 'food')).toEqual(['902']);
    expect(stocked.pockets.find((p) => p.pocket === 'medicine')?.items).toEqual([]);

    // Nothing owned at all: every defined pocket is a tab, every list is empty.
    const bare = buildBagVm([], defs, []);
    expect(pocketsOf(bare)).toEqual(['food', 'medicine']);
    for (const p of bare.pockets) expect(p.items, `${p.pocket} is empty`).toEqual([]);
  });

  it('buildBagVm: every owned line carries its key (the item id in decimal), the definition`s name and description, canFeed from the trainStat and battleUse from a cureStatus or a positive recruitBonus, independent of the pocket; the monsters pass through untouched', () => {
    // WRONG IMPL KILLED: a key that is not String(itemId) (two items collide or the nav key is a
    // list index), a canFeed read from the pocket instead of the trainStat (a food+cure item would
    // lose Feed or Use), a battleUse that forgets bait or cure, a description dropped, and monsters
    // that are filtered, reordered or rebuilt.
    const defs = defsOf(
      food(902, 'Root'),
      cure(903, 'Salve'),
      bait(904, 'Berry'),
      plain(905, 'Shard'),
      def(906, { name: 'Tonic', trainStat: 'hp', cureStatus: 'Sleep', description: 'Both.' }),
    );
    const monsters = [
      { key: '31', monsterId: 31n, name: 'Kip' },
      { key: '30', monsterId: 30n, name: 'Sprig' },
    ];
    const vm = buildBagVm(
      [inv(1, 902, 1), inv(2, 903, 2), inv(3, 904, 3), inv(4, 905, 4), inv(5, 906, 5)],
      defs,
      monsters,
    );
    const flat = vm.pockets.flatMap((p) => p.items);
    expect(
      flat.map((i) => [i.key, i.name, i.canFeed, i.battleUse]),
      'in pocket order, then inventory order',
    ).toEqual([
      ['902', 'Root', true, false],
      ['906', 'Tonic', true, true],
      ['903', 'Salve', false, true],
      ['904', 'Berry', false, true],
      ['905', 'Shard', false, false],
    ]);
    expect(vm.pockets.map((p) => p.pocket)).toEqual(['food', 'medicine', 'bait', 'other']);
    expect(findItem(vm, 906)?.description).toBe('Both.');
    expect(findItem(vm, 906)?.itemId).toBe(906);
    expect(vm.monsters, 'passed through').toEqual(monsters);
  });
});

describe('actionLayout (ctl-8f, CTL8F.2)', () => {
  const rows = (
    layout: ItemLayout,
  ): ReadonlyArray<readonly [string, boolean, string | undefined]> =>
    layout.items.map((i) => [i.key, i.enabled, i.reason] as const);

  function itemOf(d: StoreItemRow): BagItemVm {
    const vm = buildBagVm([inv(1, d.id, 1)], defsOf(d), []);
    const found = findItem(vm, d.id);
    if (found === undefined) throw new Error('fixture: the owned item is not in the view model');
    return found;
  }

  it('CTL8F-2-ACTIONS: a food is Feed then Info, a cure or a bait is Use (always disabled, reason battleOnly) then Info, a shard with no effect is Info alone, Feed is disabled with reason noMonsters when there is no monster, and an item that is both food and battle-usable lists Feed, Use, Info in that order', () => {
    // WRONG IMPL KILLED: a Use that is ever enabled (the Bag has no battle to use an item in); a
    // Use row on a shard (a dead row on every item), a missing Info, Feed on a non-food, an order
    // other than feed, use, info, a Feed enabled with nobody to feed (A would open an empty
    // picker), a noMonsters reason on Use, and a Feed row that disappears instead of disabling.
    // uif-8: every layout below now ENDS with an enabled `close` row (the ContextSheet's last Close
    // row, UIF8.2); the rows before it are unchanged.
    const enabled = true;
    const close = ['close', enabled, undefined] as const;
    expect(rows(actionLayout(itemOf(food(902)), true)), 'food, with monsters').toEqual([
      ['feed', enabled, undefined],
      ['info', enabled, undefined],
      close,
    ]);
    expect(rows(actionLayout(itemOf(cure(903)), true)), 'cure').toEqual([
      ['use', false, 'battleOnly'],
      ['info', enabled, undefined],
      close,
    ]);
    expect(rows(actionLayout(itemOf(bait(904)), true)), 'bait').toEqual([
      ['use', false, 'battleOnly'],
      ['info', enabled, undefined],
      close,
    ]);
    expect(rows(actionLayout(itemOf(plain(905)), true)), 'a shard').toEqual([
      ['info', enabled, undefined],
      close,
    ]);

    expect(rows(actionLayout(itemOf(food(902)), false)), 'food, no monsters').toEqual([
      ['feed', false, 'noMonsters'],
      ['info', enabled, undefined],
      close,
    ]);
    expect(rows(actionLayout(itemOf(cure(903)), false)), 'no monsters never touches Use').toEqual([
      ['use', false, 'battleOnly'],
      ['info', enabled, undefined],
      close,
    ]);
    expect(rows(actionLayout(itemOf(plain(905)), false)), 'no monsters never touches Info').toEqual(
      [['info', enabled, undefined], close],
    );

    const both = def(906, { trainStat: 'hp', cureStatus: 'Sleep' });
    expect(rows(actionLayout(itemOf(both), true)), 'food and cure').toEqual([
      ['feed', enabled, undefined],
      ['use', false, 'battleOnly'],
      ['info', enabled, undefined],
      close,
    ]);
    expect(rows(actionLayout(itemOf(both), false)), 'food and cure, no monsters').toEqual([
      ['feed', false, 'noMonsters'],
      ['use', false, 'battleOnly'],
      ['info', enabled, undefined],
      close,
    ]);
    expect(actionLayout(itemOf(food(902)), true).kind, 'a list').toBe('list');
  });

  it('UIF8.2 the item sheet layout ends with exactly one enabled close row, last, for food, battle and other items, with and without monsters', () => {
    // WRONG IMPL KILLED: no Close row at all (the sheet has no last row whose A acts like B); a
    // Close row placed first or before Info (A on the opening row would close); a Close that is
    // disabled (A would be refused with a reason); a Close added only for food, or only when there
    // are monsters; two Close rows.
    for (const [label, d] of [
      ['food', food(902)],
      ['cure', cure(903)],
      ['bait', bait(904)],
      ['shard', plain(905)],
      ['food and cure', def(906, { trainStat: 'hp', cureStatus: 'Sleep' })],
    ] as const) {
      const item = (() => {
        const vm = buildBagVm([inv(1, d.id, 1)], defsOf(d), []);
        const found = findItem(vm, d.id);
        if (found === undefined) throw new Error('fixture: no item');
        return found;
      })();
      for (const hasMonsters of [true, false]) {
        const items = actionLayout(item, hasMonsters).items;
        const where = `${label}, monsters=${hasMonsters}`;
        expect(items.at(-1), `${where}: the last row is close`).toEqual({
          key: 'close',
          enabled: true,
        });
        expect(
          items.filter((r) => r.key === 'close'),
          `${where}: exactly one close row`,
        ).toHaveLength(1);
        expect(items.length, `${where}: close follows at least one real action`).toBeGreaterThan(1);
        expect(items[0]?.key, `${where}: the first row is never close`).not.toBe('close');
      }
    }
  });
});

describe('the Bag layouts, findItem and bagMonsters (ctl-8f)', () => {
  const vm = buildBagVm(
    [inv(1, 905, 2), inv(2, 902, 3), inv(3, 903, 1)],
    defsOf(food(902), cure(903), bait(901), food(905)),
    [
      { key: '11', monsterId: 11n, name: 'Kip' },
      { key: '12', monsterId: 12n, name: 'Ember' },
    ],
  );

  it('bagLayout is one tab per pocket keyed by the pocket (the empty pocket included), each a list of its item keys, every row enabled', () => {
    // WRONG IMPL KILLED: tabs keyed by something else than the pocket, an empty pocket dropped (the
    // tab strip would change with the counts), items in id order instead of the view model's,
    // a disabled row (A would be refused as a disabled item), a grid.
    const layout = bagLayout(vm);
    if (layout.kind !== 'tabs') throw new Error(`expected tabs, got ${layout.kind}`);
    expect(layout.tabs.map((t) => t.key)).toEqual(['bait', 'food', 'medicine']);
    expect(layout.tabs.map((t) => [t.layout.kind, t.layout.items.map((i) => i.key)])).toEqual([
      ['list', []],
      ['list', ['905', '902']],
      ['list', ['903']],
    ]);
    for (const tab of layout.tabs) {
      for (const row of tab.layout.items) expect(row.enabled, `${tab.key}/${row.key}`).toBe(true);
    }
  });

  it('pickerLayout is a list of the monster keys in view-model order, all enabled; findItem finds an item in any pocket by its item id and answers undefined for one that is not listed', () => {
    // WRONG IMPL KILLED: a picker keyed by index or sorted, a disabled monster row, a findItem that
    // only searches the first pocket or matches the key's string against a number.
    const picker = pickerLayout(vm);
    expect(picker.kind).toBe('list');
    // uif-8: the picker now ENDS with an enabled `back` row after every monster (UIF8.2).
    expect(picker.items.map((i) => [i.key, i.enabled])).toEqual([
      ['11', true],
      ['12', true],
      [BAG_BACK_KEY, true],
    ]);
    expect(findItem(vm, 902)?.name).toBe('Food 902');
    expect(findItem(vm, 903)?.name, 'the third pocket').toBe('Cure 903');
    expect(findItem(vm, 901), 'a defined but unowned item').toBeUndefined();
    expect(findItem(vm, 12345)).toBeUndefined();
  });

  it('bagMonsters lists the party in slot order then the storage in store order, named by nickname else species name, keyed by the decimal id, with the party size and sentinel taken from its arguments', () => {
    // WRONG IMPL KILLED: store order for the party (slot 1 is stored before slot 0), storage before
    // party, a name that ignores the nickname or never falls back to the species, a key that is not
    // the decimal id, and a literal party size or sentinel (this case passes 3 and 200, never the
    // game-core values).
    const essence = Object.fromEntries(
      (
        ['Fire', 'Water', 'Plant', 'Electric', 'Earth', 'Wind', 'Light', 'Dark'] as AffinityName[]
      ).map((n) => [n, 0]),
    ) as unknown as EssenceByAffinity;
    const mon = (
      monsterId: bigint,
      partySlot: number,
      speciesId: number,
      nickname = '',
    ): StoreMonsterPub => ({
      monsterId,
      ownerIdentity: ME,
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
      essence,
      trustTier: 'Neutral',
      qualityTimeTier: 0,
      nutritionPct: 0,
      lastCareAtMs: 0n,
    });
    const species = (id: number, name: string): StoreSpeciesRow => ({
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
    });
    const speciesMap = new Map([
      [1, species(1, 'Sproutle')],
      [2, species(2, 'Emberfang')],
    ]);
    const NONE = 200;
    const monsters = [
      mon(22n, NONE, 2),
      mon(12n, 1, 2, 'Spark'),
      mon(21n, NONE, 1, 'Moss'),
      mon(11n, 0, 1),
      mon(23n, NONE, 1),
    ];
    const out = bagMonsters(monsters, speciesMap, 3, NONE);
    expect(out.map((m) => [m.key, m.monsterId, m.name])).toEqual([
      ['11', 11n, 'Sproutle'],
      ['12', 12n, 'Spark'],
      ['22', 22n, 'Emberfang'],
      ['21', 21n, 'Moss'],
      ['23', 23n, 'Sproutle'],
    ]);
    expect(bagMonsters([], speciesMap, 3, NONE)).toEqual([]);
  });

  it('a roster of nine monsters is listed whole: bagMonsters, the view model and the picker layout keep every one, in order', () => {
    // WRONG IMPL KILLED: a picker (or the roster feeding it) capped at a handful of monsters (a
    // `slice(0, 5)`): the sixth to ninth monster could never be fed.
    const essence = Object.fromEntries(
      (
        ['Fire', 'Water', 'Plant', 'Electric', 'Earth', 'Wind', 'Light', 'Dark'] as AffinityName[]
      ).map((n) => [n, 0]),
    ) as unknown as EssenceByAffinity;
    const NONE = 200;
    const mon = (id: number, partySlot: number): StoreMonsterPub => ({
      monsterId: BigInt(id),
      ownerIdentity: ME,
      speciesId: 1,
      nickname: `M${id}`,
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
      essence,
      trustTier: 'Neutral',
      qualityTimeTier: 0,
      nutritionPct: 0,
      lastCareAtMs: 0n,
    });
    // Six party slots (0..5, stored in reverse) and three boxed monsters.
    const monsters = [
      ...[5, 4, 3, 2, 1, 0].map((slot) => mon(10 + slot, slot)),
      mon(21, NONE),
      mon(22, NONE),
      mon(23, NONE),
    ];
    const roster = bagMonsters(monsters, new Map(), 6, NONE);
    const keys = ['10', '11', '12', '13', '14', '15', '21', '22', '23'];
    expect(
      roster.map((m) => m.key),
      'bagMonsters lists all nine',
    ).toEqual(keys);
    const vm = buildBagVm([inv(1, 902, 1)], defsOf(food(902)), roster);
    expect(
      vm.monsters.map((m) => m.key),
      'the view model keeps them',
    ).toEqual(keys);
    const picker = pickerLayout(vm);
    // uif-8: the nine monsters, then the one Back row (UIF8.2): ten rows in all.
    expect(
      picker.items.map((i) => i.key),
      'the picker lists them, then Back',
    ).toEqual([...keys, BAG_BACK_KEY]);
    expect(picker.items).toHaveLength(10);
  });

  it('UIF8.2 the picker layout ends with one enabled back row after every monster (also with none), the info layout is exactly one back row, and no monster key can be taken for the back key', () => {
    // WRONG IMPL KILLED: a picker with no Back row (the sheet has no last row whose A acts like B);
    // a Back row first or between monsters; a disabled Back; a Back key that a monster key can equal
    // (A on that monster would back out instead of feeding); an info page with no row (the detail
    // sheet has nothing to press) or with two; an isBagBackKey that matches every key or none.
    const monsters = [
      { key: monsterKey(11n), monsterId: 11n, name: 'Kip' },
      { key: monsterKey(12n), monsterId: 12n, name: 'Ember' },
    ];
    const withMonsters = buildBagVm([inv(1, 902, 1)], defsOf(food(902)), monsters);
    expect(pickerLayout(withMonsters).items, 'monsters, then one enabled back row').toEqual([
      { key: monsterKey(11n), enabled: true },
      { key: monsterKey(12n), enabled: true },
      { key: BAG_BACK_KEY, enabled: true },
    ]);
    const nobody = buildBagVm([inv(1, 902, 1)], defsOf(food(902)), []);
    expect(pickerLayout(nobody).items, 'with no monster: Back alone').toEqual([
      { key: BAG_BACK_KEY, enabled: true },
    ]);

    // The plan names `infoLayout` without saying whether it is a value or a zero-arg function: both
    // shapes are accepted, the layout read is the same.
    const rawInfo: unknown = infoLayout;
    const info = (typeof rawInfo === 'function' ? rawInfo() : rawInfo) as ItemLayout;
    expect(info.kind, 'a list').toBe('list');
    expect(info.items, 'exactly one enabled back row').toEqual([
      { key: BAG_BACK_KEY, enabled: true },
    ]);

    expect(isBagBackKey(BAG_BACK_KEY)).toBe(true);
    for (const other of ['11', 'feed', 'info', 'close', '', 'Back']) {
      expect(isBagBackKey(other), `"${other}" is not the back key`).toBe(false);
    }
    for (const id of [0n, 1n, 11n, 255n, 9_007_199_254_740_993n]) {
      expect(isBagBackKey(monsterKey(id)), `monster ${id}'s key is never the back key`).toBe(false);
    }
  });
});
