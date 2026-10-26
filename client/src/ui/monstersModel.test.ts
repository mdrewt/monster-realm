// ui/monstersModel.test.ts — ctl-8b (CTL8B.1): the Monsters frame's pure model.
//
// Node env, no DOM. `buildMonstersVm(monsters, speciesMap, partySize, partySlotNone, paths)` splits
// the player's monsters into the Party list (the occupied slots, in slot order, at most the party
// size) and the Storage grid (the monsters whose slot IS the "boxed" sentinel, in store order);
// `monstersLayout(vm)` is the two-tab nav layout over them, every item keyed by `monsterKey` (the
// monster id in decimal). The party size and the sentinel are PARAMETERS (game-core's wasm
// exports, handed in by the screen), so every case that matters runs against a non-canonical pair
// as well as the canonical (6, 255): a model that re-inlines either literal fails the second.
//
// ctl-8c (CTL8C.1): the sheet gains Care, Feed… and Evolve… (design §5 order: Summary, Care,
// Feed…, Evolve…, Nickname, Move) through `sheetLayout(canFeed, canEvolve)`; the view model gains
// `foods` (the data-driven trainable items with stock, by item id) and `evolution` (the evolution
// port's per-monster view model, never re-derived); `canEvolve` / `isChoice` / `pathLayout` /
// `firstPathKey` / `foodLayout` / `foodKey` / `pathKey` are the helpers the screen walks them with.
//
// qf-3 (QF3.3, QF3.4): the Care row follows the monster's care cooldown. The view model carries
// `careRemainingMs` (monsterKey -> the remaining cooldown the screen read through the wasm export,
// 0n = ready), handed in as `buildMonstersVm`'s seventh parameter (default: an empty map);
// `careRemaining(vm, id)` reads one monster's entry (a missing key is READY: the server's own check
// stays the authority); `sheetLayout(canFeed, canEvolve, canCare)` disables Care exactly when
// `canCare` is false; `careCooldownParts(ms)` is the hint's hours and minutes, rounded UP to the
// minute. NAMED INTENTIONAL CHANGE: CTL8C-1-SHEET-ORDER calls the three-argument `sheetLayout`.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreEvolutionPath,
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../net/store';
import { buildEvolutionViewModel, type EvolutionMonsterViewModel } from './evolutionModel';
import {
  buildMonstersVm,
  canEvolve,
  careCooldownParts,
  careRemaining,
  findEvolution,
  findMonster,
  firstPathKey,
  foodKey,
  foodLayout,
  isChoice,
  type MonstersVm,
  monsterKey,
  monstersLayout,
  pathKey,
  pathLayout,
  SHEET_ACTIONS,
  STORAGE_COLS,
  sheetLayout,
} from './monstersModel';
import { buildInventoryItems, buildRaisingViewModel } from './raisingModel';

function essence(): EssenceByAffinity {
  const names: readonly AffinityName[] = [
    'Fire',
    'Water',
    'Plant',
    'Electric',
    'Earth',
    'Wind',
    'Light',
    'Dark',
  ];
  return Object.fromEntries(names.map((n) => [n, 0])) as unknown as EssenceByAffinity;
}

function monster(
  monsterId: bigint,
  speciesId: number,
  partySlot: number,
  overrides: Partial<StoreMonsterPub> = {},
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: 'player',
    speciesId,
    nickname: '',
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
    essence: essence(),
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
    lastCareAtMs: 0n,
    ...overrides,
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

const SPECIES: ReadonlyMap<number, StoreSpeciesRow> = new Map([
  [1, species(1, 'Sproutle')],
  [2, species(2, 'Emberfang')],
  [3, species(3, 'Duskling')],
  // ctl-8c: a fourth species, the "exactly one path met" monster's.
  [4, species(4, 'Tidepup')],
]);

/** N fully-permissive edges out of species 1: a species-1 monster has all N eligible. */
function eligibleEdges(n: number): StoreEvolutionPath[] {
  return Array.from({ length: n }, (_, i) => ({
    pathId: BigInt(i + 1),
    edgeId: i + 1,
    fromSpecies: 1,
    toSpecies: i + 2,
    minLevel: 1,
    essence: [],
    minTrustTier: null,
    minQualityTimeTier: null,
    minNutritionPct: null,
  }));
}

const ids = (cards: readonly { readonly monsterId: bigint }[]): bigint[] =>
  cards.map((c) => c.monsterId);

/** The canonical game-core pair, written here only as a fixture (the model never owns it). */
const SIX = 6;
const BOXED = 255;

/** Store order is deliberately NOT slot order: 13 (slot 3) before 11 (slot 0), boxed monsters
 *  interleaved, and 41 sits in slot 7: neither a party slot (>= 6) nor the boxed sentinel. */
function mixed(): StoreMonsterPub[] {
  return [
    monster(31n, 1, BOXED),
    monster(13n, 2, 3),
    monster(11n, 1, 0, { nickname: 'Kip' }),
    monster(41n, 3, 7),
    monster(12n, 1, 1),
    monster(32n, 2, BOXED),
    monster(33n, 3, BOXED),
  ];
}

describe('buildMonstersVm (ctl-8b, CTL8B.1)', () => {
  it('CTL8B-1-MODEL-PARTY-STORAGE: the party is the occupied party slots in SLOT order (not store order, gaps dropped, at most the party size), the storage is exactly the monsters whose slot is the boxed sentinel in store order, a monster in neither is in neither, the sentinel is carried on the view model, the party size and the sentinel are the parameters, and the input array is not reordered', () => {
    // WRONG IMPL KILLED: a party in store order (13 listed before 11); a party with its empty slots
    // kept as nulls (the Party list would have holes the cursor cannot land on) or the monster in
    // slot 3 shifted down; a storage defined as "not in the party" (the slot-7 monster would show
    // in Storage and A on it would offer a Move for a monster that is nowhere); a party size or a
    // sentinel re-inlined as 6 / 255 (the (3, 9) pair below); a partySlotNone that is not carried
    // (the screen's Move-to-storage command needs it); an in-place sort of the caller's array.
    const input = mixed();
    const before = ids(input);
    const vm = buildMonstersVm(input, SPECIES, SIX, BOXED);
    expect(ids(vm.party), 'slot order, gaps dropped').toEqual([11n, 12n, 13n]);
    expect(ids(vm.storage), 'the boxed monsters, store order').toEqual([31n, 32n, 33n]);
    expect(vm.partySlotNone).toBe(BOXED);
    expect(ids(input), 'the caller`s array is left as it was').toEqual(before);
    expect(
      [...ids(vm.party), ...ids(vm.storage)].includes(41n),
      'a monster in slot 7 is in neither list',
    ).toBe(false);

    // A whole card, field by field: the same card model the legacy box draws.
    expect(vm.party[0]).toEqual({
      monsterId: 11n,
      speciesName: 'Sproutle',
      nickname: 'Kip',
      level: 5,
      currentHp: 30,
      statHp: 40,
      hpPercent: 75,
      partySlot: 0,
      evolutionChoicePending: false,
    });
    expect(vm.storage[1]?.speciesName).toBe('Emberfang');
    expect(vm.storage[1]?.partySlot).toBe(BOXED);

    // A full party of six, shuffled: all six, in slot order.
    const six = [5, 2, 0, 4, 1, 3].map((slot) => monster(BigInt(100 + slot), 1, slot));
    expect(ids(buildMonstersVm(six, SPECIES, SIX, BOXED).party)).toEqual([
      100n,
      101n,
      102n,
      103n,
      104n,
      105n,
    ]);

    // A non-canonical pair (party size 3, sentinel 9): slots 3 and 4 are not party slots here, the
    // monster in slot 255 is not boxed here, and the sentinel carried is 9.
    const odd = [
      monster(1n, 1, 2),
      monster(2n, 1, 0),
      monster(3n, 2, 9),
      monster(4n, 2, 3),
      monster(5n, 3, BOXED),
      monster(6n, 3, 1),
      monster(7n, 3, 9),
    ];
    const small = buildMonstersVm(odd, SPECIES, 3, 9);
    expect(ids(small.party), 'party size 3: slots 0..2 only').toEqual([2n, 6n, 1n]);
    expect(ids(small.storage), 'sentinel 9: only slot 9').toEqual([3n, 7n]);
    expect(small.partySlotNone).toBe(9);

    // No monsters at all: two empty lists.
    const none = buildMonstersVm([], SPECIES, SIX, BOXED);
    expect(none.party).toEqual([]);
    expect(none.storage).toEqual([]);
    expect(none.partySlotNone).toBe(BOXED);
  });

  it('buildMonstersVm threads the evolution paths into both lists, defaults them to none, and names an unknown species', () => {
    // WRONG IMPL KILLED: paths dropped (the badge never shows on the Monsters frame), threaded to
    // the party only, a required fifth parameter (the frame opens before evolution_path arrives),
    // and an unknown species id that throws instead of the legacy "Unknown (#id)" name.
    const input = [monster(1n, 1, 0), monster(2n, 1, BOXED), monster(3n, 2, BOXED)];
    const withPaths = buildMonstersVm(input, SPECIES, SIX, BOXED, eligibleEdges(2));
    expect(withPaths.party[0]?.evolutionChoicePending, 'party card').toBe(true);
    expect(withPaths.storage[0]?.evolutionChoicePending, 'storage card').toBe(true);
    expect(withPaths.storage[1]?.evolutionChoicePending, 'species 2 has no edge out').toBe(false);
    const without = buildMonstersVm(input, SPECIES, SIX, BOXED);
    expect(without.party[0]?.evolutionChoicePending).toBe(false);
    expect(without.storage[0]?.evolutionChoicePending).toBe(false);

    const ghost = buildMonstersVm([monster(9n, 77, BOXED)], SPECIES, SIX, BOXED);
    expect(ghost.storage[0]?.speciesName).toBe('Unknown (#77)');
  });
});

describe('monsterKey and findMonster (ctl-8b, CTL8B.1)', () => {
  it('monsterKey is the id in decimal, exact past 2^53', () => {
    // WRONG IMPL KILLED: a key through Number() (two ids past 2^53 collide and the nav kit throws
    // on a duplicate key), a hex or padded key, and a key that is not a string.
    expect(monsterKey(12n)).toBe('12');
    expect(monsterKey(0n)).toBe('0');
    expect(monsterKey(18_446_744_073_709_551_615n)).toBe('18446744073709551615');
    expect(monsterKey(9_007_199_254_740_993n)).not.toBe(monsterKey(9_007_199_254_740_992n));
    expect(monsterKey(9_007_199_254_740_993n)).toBe('9007199254740993');
  });

  it('findMonster says which list a monster is in, by identity of the card, and undefined for a monster in neither', () => {
    // WRONG IMPL KILLED: a lookup that only searches the party (a storage monster would open no
    // sheet), one that returns a copy (the paint would draw a card the list does not hold), one
    // that reports the wrong tab, and one that invents a card for an unknown id.
    const vm = buildMonstersVm(mixed(), SPECIES, SIX, BOXED);
    const inParty = findMonster(vm, 13n);
    expect(inParty?.tab).toBe('party');
    expect(inParty?.card).toBe(vm.party[2]);
    const inStorage = findMonster(vm, 33n);
    expect(inStorage?.tab).toBe('storage');
    expect(inStorage?.card).toBe(vm.storage[2]);
    expect(findMonster(vm, 41n), 'slot 7: in neither').toBeUndefined();
    expect(findMonster(vm, 999n)).toBeUndefined();
  });
});

describe('monstersLayout (ctl-8b, CTL8B.1)', () => {
  it('CTL8B-1-LAYOUT-TABS: the layout is the tabs party then storage, the party tab a list and the storage tab a grid of STORAGE_COLS columns, every item keyed by the decimal monster id, in the view model`s order, all enabled; with no monsters both tabs are still there and empty', () => {
    // WRONG IMPL KILLED: tabs in the other order (LB/RB and the opening tab would swap), a storage
    // list instead of a grid (Down would move one monster, not a row), another column count than
    // the three boxView draws, items keyed by index or by slot (a re-seat after a Move would land
    // on the wrong monster), disabled items (A would be refused on every monster), a layout that
    // drops an empty tab (the cursor could not switch to an empty Storage), and keys built through
    // Number().
    expect(STORAGE_COLS, 'the three columns the box draws').toBe(3);
    const vm = buildMonstersVm(mixed(), SPECIES, SIX, BOXED);
    const layout = monstersLayout(vm);
    if (layout.kind !== 'tabs') throw new Error('the Monsters layout must be a tabs layout');
    expect(
      layout.tabs.map((t) => t.key),
      'party first, then storage',
    ).toEqual(['party', 'storage']);

    const [party, storage] = layout.tabs;
    expect(party?.layout.kind).toBe('list');
    expect(storage?.layout.kind).toBe('grid');
    if (storage?.layout.kind !== 'grid') throw new Error('storage must be a grid');
    expect(storage.layout.cols).toBe(STORAGE_COLS);
    expect(party?.layout.items.map((i) => i.key)).toEqual(['11', '12', '13']);
    expect(storage.layout.items.map((i) => i.key)).toEqual(['31', '32', '33']);
    for (const item of [...(party?.layout.items ?? []), ...storage.layout.items]) {
      expect(item.enabled, `${item.key} is enabled`).toBe(true);
    }
    // The keys are exactly monsterKey of each card, so a screen can seat the cursor by monster.
    expect(party?.layout.items.map((i) => i.key)).toEqual(
      vm.party.map((c) => monsterKey(c.monsterId)),
    );
    expect(storage.layout.items.map((i) => i.key)).toEqual(
      vm.storage.map((c) => monsterKey(c.monsterId)),
    );

    // Past 2^53, two ids stay two keys.
    const big = buildMonstersVm(
      [monster(9_007_199_254_740_993n, 1, BOXED), monster(9_007_199_254_740_992n, 1, BOXED)],
      SPECIES,
      SIX,
      BOXED,
    );
    const bigLayout = monstersLayout(big);
    if (bigLayout.kind !== 'tabs') throw new Error('tabs expected');
    expect(bigLayout.tabs[1]?.layout.items.map((i) => i.key)).toEqual([
      '9007199254740993',
      '9007199254740992',
    ]);

    // No monsters: both tabs exist with no items.
    const empty: MonstersVm = buildMonstersVm([], SPECIES, SIX, BOXED);
    const emptyLayout = monstersLayout(empty);
    if (emptyLayout.kind !== 'tabs') throw new Error('tabs expected');
    expect(emptyLayout.tabs.map((t) => t.key)).toEqual(['party', 'storage']);
    expect(emptyLayout.tabs.map((t) => t.layout.items.length)).toEqual([0, 0]);
    expect(emptyLayout.tabs[1]?.layout.kind).toBe('grid');
  });
});

// =============================================================================
// ctl-8c (CTL8C.1): Care, Feed… and Evolve… on the sheet; the foods and the evolution paths.
// =============================================================================

/** The design §5 sheet order (Summary, Care, Feed…, Evolve…, Nickname, Move). */
const C8C_SHEET_ORDER = ['summary', 'care', 'feed', 'evolve', 'nickname', 'move'];

describe('the sheet layout (ctl-8c, CTL8C.1)', () => {
  it('CTL8C-1-SHEET-ORDER: sheetLayout is a list of Summary, Care, Feed, Evolve, Nickname, Move in that order for every (canFeed, canEvolve) pair; Feed is disabled exactly when canFeed is false and Evolve exactly when canEvolve is false (both stay in the list, reachable), every other row enabled; SHEET_ACTIONS is the same order', () => {
    // WRONG IMPL KILLED: Care / Feed… / Evolve… appended after Move (the ctl-8b order plus three:
    // design §5 puts them between Summary and Nickname), Feed and Evolve swapped, a layout that
    // DROPS a disabled row instead of disabling it (the player could not see why Feed… is
    // missing, and SHEET_STEPS-style walks would land on the wrong action), canFeed wired to the
    // Evolve row (or the reverse), a layout that ignores both flags (every row enabled), one that
    // disables Care or Nickname with them, a grid instead of a list (Left / Right would move), and
    // a SHEET_ACTIONS constant that disagrees with the layout the screen walks.
    const pairs: ReadonlyArray<readonly [boolean, boolean]> = [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ];
    for (const [canFeed, canEvolve] of pairs) {
      const label = `canFeed=${canFeed} canEvolve=${canEvolve}`;
      // qf-3 (named intentional change): `sheetLayout` takes a third, required `canCare` flag; this
      // ctl-8c case holds it at true (Care ready) and so pins exactly what it pinned before. The
      // Care flag itself is pinned over all eight triples by QF3-3-SHEET-CARE-ROW below.
      const layout = sheetLayout(canFeed, canEvolve, true);
      expect(layout.kind, `${label}: a list`).toBe('list');
      expect(
        layout.items.map((item) => item.key),
        `${label}: every row, in the design order`,
      ).toEqual(C8C_SHEET_ORDER);
      expect(
        Object.fromEntries(layout.items.map((item) => [item.key, item.enabled])),
        `${label}: only Feed and Evolve follow their flags`,
      ).toEqual({
        summary: true,
        care: true,
        feed: canFeed,
        evolve: canEvolve,
        nickname: true,
        move: true,
      });
    }
    expect([...SHEET_ACTIONS], 'SHEET_ACTIONS is the layout`s order').toEqual(C8C_SHEET_ORDER);
  });
});

// =============================================================================
// qf-3 (QF3.3, QF3.4): the Care row follows the care cooldown.
// =============================================================================

describe('the Care row and the cooldown hint (qf-3, QF3.3, QF3.4)', () => {
  it('sheetLayout over all eight (canFeed, canEvolve, canCare) triples keeps the six rows in the design order, disables Care exactly when canCare is false (still listed, reachable), and leaves Feed and Evolve on their own flags [QF3-3-SHEET-CARE-ROW] [QF3-4-SHEET-CARE-ROW]', () => {
    // WRONG IMPL KILLED: a two-flag layout that ignores canCare (Care always enabled: A on a
    // cooling Care would be offered as an action); a Care row DROPPED while cooling instead of
    // disabled (the player could not read the remaining time, and the Down walk would land on
    // Feed); canCare wired to the Feed or Evolve row (or canFeed to Care); a cooling Care that also
    // disables Summary / Nickname / Move; and a layout whose order moves when Care is disabled.
    const bools = [true, false] as const;
    let seen = 0;
    for (const canFeed of bools) {
      for (const canEvolve of bools) {
        for (const canCare of bools) {
          const label = `canFeed=${canFeed} canEvolve=${canEvolve} canCare=${canCare}`;
          const layout = sheetLayout(canFeed, canEvolve, canCare);
          expect(layout.kind, `${label}: a list`).toBe('list');
          expect(
            layout.items.map((item) => item.key),
            `${label}: every row, in the design order`,
          ).toEqual(C8C_SHEET_ORDER);
          expect(
            Object.fromEntries(layout.items.map((item) => [item.key, item.enabled])),
            `${label}: Care, Feed and Evolve each follow their own flag`,
          ).toEqual({
            summary: true,
            care: canCare,
            feed: canFeed,
            evolve: canEvolve,
            nickname: true,
            move: true,
          });
          seen += 1;
        }
      }
    }
    expect(seen, 'ANTI-VACUITY: all eight triples were laid out').toBe(8);
  });

  it('careCooldownParts rounds the remaining milliseconds UP to the whole minute and splits it into hours and minutes (as numbers); zero and a negative remaining read 0h 0m [QF3-3-COOLDOWN-PARTS]', () => {
    // WRONG IMPL KILLED: a hint rounded DOWN or to the nearest minute (1 ms left would read "0h 0m"
    // on a disabled row, and 59.999 s "0h 0m" too); a rounding that adds a minute on an exact
    // minute (60 000 ms reading "0h 2m"); minutes not taken modulo 60 (5h 59m reading "5h 359m");
    // hours rounded up instead of carried from the minutes (3 600 001 ms reading "2h 1m"); bigint
    // parts where the catalog's params are numbers (toEqual tells 6n from 6); and a negative
    // remaining (a skewed clock) leaking a negative hint.
    const table: ReadonlyArray<readonly [bigint, number, number]> = [
      [1n, 0, 1],
      [59_999n, 0, 1],
      [60_000n, 0, 1],
      [60_001n, 0, 2],
      [3_600_000n, 1, 0],
      [3_600_001n, 1, 1],
      [21_540_000n, 5, 59],
      [21_540_001n, 6, 0],
      [0n, 0, 0],
      [-1n, 0, 0],
    ];
    for (const [ms, hours, minutes] of table) {
      expect(careCooldownParts(ms), `${ms} ms`).toEqual({ hours, minutes });
    }
  });

  it('careRemaining reads the monster`s own entry of the care map: a present key answers its value, a missing key answers 0n (ready, so the server`s own check decides), another monster`s entry never leaks, and ids past 2^53 stay distinct [QF3-4-CARE-REMAINING] [QF3-3-CARE-REMAINING]', () => {
    // WRONG IMPL KILLED: a missing key read as cooling (a monster the screen did not map would show
    // Care disabled forever, with nothing to clear it); a lookup by Number(id) (two ids past 2^53
    // collide: one monster's cooldown disables the other's Care); a lookup that answers ANY entry
    // of the map (the first one, or the largest: one cared monster would disable every Care); an
    // entry dropped by buildMonstersVm (the map not carried on the view model); and undefined in
    // place of 0n (the screen's `!== 0n` readiness test would read undefined as cooling).
    const BIG = 9_007_199_254_740_993n;
    const BIG_NEIGHBOUR = 9_007_199_254_740_992n;
    const input = [...mixed(), monster(BIG, 1, BOXED), monster(BIG_NEIGHBOUR, 1, BOXED)];
    const map = new Map<string, bigint>([
      [monsterKey(11n), 5n],
      [monsterKey(13n), 21_540_001n],
      [monsterKey(31n), 0n],
      [monsterKey(BIG), 7n],
    ]);
    const vm = buildMonstersVm(input, SPECIES, SIX, BOXED, [], [], map);
    expect(vm.careRemainingMs.get(monsterKey(11n)), 'the map rides on the view model').toBe(5n);
    expect(careRemaining(vm, 11n), 'a present key: its value').toBe(5n);
    expect(careRemaining(vm, 13n)).toBe(21_540_001n);
    expect(careRemaining(vm, 31n), 'a present 0n: ready').toBe(0n);
    expect(careRemaining(vm, 12n), 'a monster with no entry: ready, never 11`s 5n').toBe(0n);
    expect(careRemaining(vm, 32n), 'another unmapped monster: ready').toBe(0n);
    expect(careRemaining(vm, 999n), 'a monster in neither list: ready').toBe(0n);
    expect(careRemaining(vm, BIG), 'past 2^53: its own entry').toBe(7n);
    expect(careRemaining(vm, BIG_NEIGHBOUR), 'past 2^53: the neighbour is not it').toBe(0n);
  });

  it('buildMonstersVm`s care map defaults to EMPTY: a view model built without one reads every monster ready [QF3-4-DEFAULT-MAP]', () => {
    // WRONG IMPL KILLED: no `careRemainingMs` on the view model at all (the screen and the view
    // would read undefined); a default that fabricates entries (a whole cooldown per monster: every
    // Care disabled in a frame opened before the screen computed anything); a required seventh
    // parameter (every existing caller, paths and items defaulted, would stop compiling).
    const vm = buildMonstersVm(mixed(), SPECIES, SIX, BOXED);
    expect(vm.careRemainingMs.size, 'no entry by default').toBe(0);
    expect(careRemaining(vm, 11n), 'and so a party monster is ready').toBe(0n);
    expect(careRemaining(vm, 31n), 'and a stored one').toBe(0n);
    const withPaths = buildMonstersVm(mixed(), SPECIES, SIX, BOXED, [], []);
    expect(withPaths.careRemainingMs.size, 'paths and items given, the map still defaults').toBe(0);
  });
});

/** One owned inventory row. */
function c8cInv(invId: bigint, itemId: number, count: number): StoreInventory {
  return { invId, ownerIdentity: 'player', itemId, count };
}

/** One item definition; a non-null `trainStat` is what makes it food (data, never an id list). */
function c8cItem(id: number, name: string, trainStat: string | null): StoreItemRow {
  return {
    id,
    name,
    description: `${name} description`,
    recruitBonus: 0,
    trainStat,
    trainAmount: trainStat === null ? 0 : 2,
    sellPrice: 0n,
    cureStatus: null,
  };
}

/** One authored edge with a single level gate (minLevel 1 is met by a level-5 monster). */
function c8cEdge(
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

function c8cEvo(vm: MonstersVm, monsterId: bigint): EvolutionMonsterViewModel {
  const found = findEvolution(vm, monsterId);
  if (found === undefined || found === null) {
    throw new Error(`fixture: no evolution view model for monster ${monsterId}`);
  }
  return found;
}

describe('the Monsters view model: foods and evolution (ctl-8c, CTL8C.1)', () => {
  it('CTL8C-1-MODEL-FOODS-EVO: foods are the trainable items with stock (a zero-count food, a non-food and an undefined item dropped), one per item id (the first row wins), sorted by NUMERIC item id; buildInventoryItems is the raising mapping; evolution is the evolution port`s per-monster view model; canEvolve reads the paths (not the choices), only choices are enabled path rows, firstPathKey prefers the first choice; the keys are decimal ids', () => {
    // WRONG IMPL KILLED: foods that keep a zero-count stack (Feed… would offer food the player has
    // none of), a non-food (an item with no trainStat: train would be refused) or an item with no
    // definition; a dedupe that keeps the LAST row (count 99 instead of 3) or none (the nav kit
    // throws on the duplicate key and the view model starves the host); foods in store order, or
    // sorted as STRINGS ('4000' before '7'); food decided by an id list instead of the item's
    // trainStat; an evolution view model re-derived here (a second eligibility source) or built
    // for the party only; canEvolve = choices.length > 0 (paths-but-none-met and exactly-one-met
    // would be disabled: the player could not see what a path needs); a path row enabled when it
    // is met but not a choice (the single eligible path is auto-applied by the server: offering
    // it offers nothing); firstPathKey on the first PATH when a choice exists (edge 10 is unmet);
    // keys through Number() or padded.
    const DEFS: ReadonlyMap<number, StoreItemRow> = new Map([
      [2, c8cItem(2, 'Carrot', 'hp')],
      [5, c8cItem(5, 'Potion', null)],
      [7, c8cItem(7, 'Protein', 'attack')],
      [9, c8cItem(9, 'Iron', 'defense')],
      [4000, c8cItem(4000, 'Glowberry', 'speed')],
    ]);
    const INVENTORY: readonly StoreInventory[] = [
      c8cInv(1n, 4000, 2), // a food with an unusual id, listed first
      c8cInv(2n, 7, 3), // a food
      c8cInv(3n, 9, 0), // a food with none left
      c8cInv(4n, 5, 4), // not a food: no trainStat
      c8cInv(5n, 7, 99), // a second row for item 7: the first row wins
      c8cInv(6n, 12, 1), // an item with no definition: not a food
      c8cInv(7n, 2, 1), // the lowest id, listed last
    ];

    // buildInventoryItems is the raising screen's own per-item mapping (one SSOT for "food").
    const items = buildInventoryItems(INVENTORY, DEFS);
    expect(items, 'the raising mapping, row for row').toEqual(
      buildRaisingViewModel([], INVENTORY, DEFS).items,
    );
    expect(items, 'every row, unfiltered').toHaveLength(INVENTORY.length);
    expect(items[5], 'an undefined item is not trainable').toMatchObject({
      itemId: 12,
      canTrain: false,
    });

    const monsters = [
      monster(1n, 1, 0, { nickname: 'Kip' }), // two paths met, one not: a choice
      monster(2n, 2, BOXED), // one path, not met
      monster(3n, 3, BOXED), // no path at all
      monster(4n, 4, 1), // exactly one path met (auto-applied), one not
    ];
    const PATHS = [
      c8cEdge(30, 1, 2, 1), // species 1: met
      c8cEdge(10, 1, 4, 50), // species 1: unmet, the lowest edge id
      c8cEdge(20, 1, 3, 1), // species 1: met
      c8cEdge(40, 2, 3, 50), // species 2: unmet
      c8cEdge(60, 4, 2, 50), // species 4: unmet
      c8cEdge(50, 4, 1, 1), // species 4: met
    ];
    const vm = buildMonstersVm(monsters, SPECIES, SIX, BOXED, PATHS, items);

    expect(vm.foods, 'trainable, in stock, one per id, by numeric id').toEqual([
      { itemId: 2, name: 'Carrot', count: 1 },
      { itemId: 7, name: 'Protein', count: 3 },
      { itemId: 4000, name: 'Glowberry', count: 2 },
    ]);
    const foods = foodLayout(vm);
    expect(foods.kind).toBe('list');
    expect(
      foods.items.map((item) => [item.key, item.enabled]),
      'one enabled row per food, keyed by the decimal item id',
    ).toEqual([
      ['2', true],
      ['7', true],
      ['4000', true],
    ]);
    expect(foodKey(4000)).toBe('4000');
    expect(foodKey(7)).toBe('7');
    expect(pathKey(20)).toBe('20');
    expect(pathKey(0)).toBe('0');

    // Evolution: the port's own view model, one per monster, in order.
    expect(vm.evolution, 'the evolution port`s view model, never re-derived').toEqual(
      buildEvolutionViewModel(monsters, SPECIES, PATHS).monsters,
    );
    expect(vm.evolution.map((m) => m.monsterId)).toEqual([1n, 2n, 3n, 4n]);
    expect(findEvolution(vm, 3n), 'findEvolution answers the vm`s own entry').toBe(vm.evolution[2]);
    expect(findEvolution(vm, 999n) ?? null, 'an unknown monster has none').toBeNull();

    const twoMet = c8cEvo(vm, 1n);
    const noneMet = c8cEvo(vm, 2n);
    const noPath = c8cEvo(vm, 3n);
    const oneMet = c8cEvo(vm, 4n);
    expect(
      twoMet.choices.map((p) => p.edgeId),
      'fixture: species 1 has two choices',
    ).toEqual([20, 30]);
    expect(oneMet.eligibleCount, 'fixture: species 4 has exactly one met path').toBe(1);
    expect(oneMet.choices, 'fixture: and so no choice').toEqual([]);

    expect(
      [twoMet, noneMet, noPath, oneMet].map(canEvolve),
      'canEvolve: any path at all, met or not',
    ).toEqual([true, true, false, true]);

    expect(
      ['10', '20', '30', '99'].map((key) => isChoice(twoMet, key)),
      'isChoice: the met paths of a 2+ choice only',
    ).toEqual([false, true, true, false]);
    expect(isChoice(oneMet, '50'), 'exactly one met: auto-applied, never a choice').toBe(false);

    const rows = (mon: EvolutionMonsterViewModel) => {
      const layout = pathLayout(mon);
      expect(layout.kind, 'a path list').toBe('list');
      return layout.items.map((item) => [item.key, item.enabled]);
    };
    expect(rows(twoMet), 'every outgoing path by edge id, only the choices enabled').toEqual([
      ['10', false],
      ['20', true],
      ['30', true],
    ]);
    expect(rows(noneMet)).toEqual([['40', false]]);
    expect(rows(noPath)).toEqual([]);
    expect(rows(oneMet), 'the single met path is listed, not offered').toEqual([
      ['50', false],
      ['60', false],
    ]);

    expect(firstPathKey(twoMet), 'the first CHOICE, not the first path').toBe('20');
    expect(firstPathKey(noneMet), 'no choice: the first path').toBe('40');
    expect(firstPathKey(oneMet)).toBe('50');
    expect(firstPathKey(noPath), 'no path: none').toBeNull();

    // Defaults: no paths, no items.
    const bare = buildMonstersVm(monsters, SPECIES, SIX, BOXED);
    expect(bare.foods).toEqual([]);
    expect(foodLayout(bare).items).toEqual([]);
    expect(bare.evolution.map((m) => m.paths.length)).toEqual([0, 0, 0, 0]);
    expect(bare.evolution.map(canEvolve)).toEqual([false, false, false, false]);
  });
});

// =============================================================================
// The care cooldown, read through the client-wasm export `care_remaining_ms(lastCareAtMs, nowMs)`
// from the BUILT pkg (the value the live client gets): game-core's `is_cooldown_ready` decides
// readiness and `CARE_COOLDOWN_MS` is the length, so this file never spells the cooldown. Every
// expected value below is derived from the export's own full-cooldown answer `full`.
// =============================================================================

let careRemainingExport: unknown;

/** The export, or a failure naming the rebuild (never a skip). */
function careRemainingMs(lastCareAtMs: bigint, nowMs: bigint): unknown {
  expect(
    typeof careRemainingExport,
    'client-wasm must export care_remaining_ms(last_care_at_ms: i64, now_ms: i64) -> i64; if it ' +
      'does and this still reads undefined, the pkg is stale: run `just wasm`',
  ).toBe('function');
  return (careRemainingExport as (last: bigint, now: bigint) => unknown)(lastCareAtMs, nowMs);
}

describe('the care_remaining_ms wasm export', () => {
  // Scoped to this describe so the pure-model cases above never depend on the built pkg.
  beforeAll(async () => {
    const pkg = await loadWasmPkg();
    careRemainingExport = pkg.care_remaining_ms;
  });

  it('the built pkg exports care_remaining_ms as a bigint-in, bigint-out function whose fresh-anchor answer is a positive full cooldown', () => {
    // WRONG IMPL KILLED: no export at all; an export returning a JS number (a u32 or f64 return
    // type: the screen's `=== 0n` readiness test would never be true); an export that returns 0
    // for a monster cared this very millisecond (Care would never be disabled).
    const full = careRemainingMs(0n, 0n);
    expect(typeof full, 'an i64 return crosses as a BigInt').toBe('bigint');
    expect((full as bigint) > 0n, 'cared just now: a whole cooldown remains').toBe(true);
  });

  it('care_remaining_ms counts down to exactly 1n one millisecond before the cooldown and is 0n from the cooldown on', () => {
    // WRONG IMPL KILLED: a strict `>` boundary (0n one millisecond late: Care stays disabled at the
    // instant the server would accept it); a remaining time that is not `full - elapsed` (the
    // one-millisecond-in row); a last millisecond rounded to "ready" (1n must stay 1n, never 0n);
    // and an ignored anchor (the 5n-anchored rows are shifted by 5 against the 0n-anchored one).
    const full = careRemainingMs(0n, 0n) as bigint;
    expect(careRemainingMs(0n, full), 'exactly the cooldown elapsed: ready').toBe(0n);
    expect(careRemainingMs(5n, 5n + full - 1n), 'one millisecond short: 1n').toBe(1n);
    expect(careRemainingMs(5n, 5n + full), 'anchored at 5: ready at 5 + full').toBe(0n);
    expect(careRemainingMs(5n, 5n + full + 1n), 'past it: still ready, never negative').toBe(0n);
    expect(careRemainingMs(5n, 5n + 1n), 'one millisecond in: full - 1').toBe(full - 1n);
  });

  it('a never-cared anchor (0n) is ready at a realistic wall clock, and a wall clock behind the anchor reads one full cooldown, never more', () => {
    // WRONG IMPL KILLED: a 0n anchor treated as "unknown, assume cooling" (every never-cared
    // monster would show Care disabled forever); an unclamped skew (a client clock behind the
    // server reads `full + skew`, a hint of years); a wrapped or negative answer for a clock behind
    // the anchor; and swapped arguments (f(now, last) reads the realistic pair as a skew).
    const full = careRemainingMs(0n, 0n) as bigint;
    expect(careRemainingMs(0n, 1_750_000_000_000n), 'never cared: ready').toBe(0n);
    expect(
      careRemainingMs(1_750_000_000_000n, 0n),
      'clock behind the anchor: one full cooldown',
    ).toBe(full);
    expect(
      careRemainingMs(1_750_000_000_000n, 1_750_000_000_000n - 1n),
      'one millisecond behind: still one full cooldown',
    ).toBe(full);
  });
});
