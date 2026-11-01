// tactics/boardModel.test.ts — bt-10 RED tests for the pure board view-model: BT10.1 (grid, unit
// view-models, health fractions, sprite slugs), BT10.4 (the overlay layer fed by an injected
// OverlaySets) and the cursor memory half of BT10.6.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md `### bt-10` (BT10.1, BT10.4,
// BT10.6) and the plan's API freeze (memory/projects/monster-realm-bt-10-plan.md, REV 2 amendments
// A5/A9/A13). The stubs in boardModel.ts ARE the contract: every call below goes through the
// exported names and shapes there.
//
// RED REASON: every stub in boardModel.ts throws `bt-10: not implemented`, so each test reds on the
// first call into it.
//
// NOT HERE: the DOM paint (boardRender.test.ts) and the shell's cursor/cycle flow
// (tacticsBattle.test.ts). boardModel never derives a tile set: the overlay sets are INPUTS (the
// rules port is bt-11), so every geometry below is an arbitrary fixture, not a game rule.
//
// WRONG IMPL KILLED notes sit next to each assertion group. Do NOT edit these tests to match a
// buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
import {
  type BoardInput,
  buildBoard,
  type CursorMemory,
  cursorFor,
  type Dir,
  EMPTY_OVERLAYS,
  moveCursor,
  OVERLAY_ORDER,
  type OverlayKind,
  type OverlaySets,
  spriteSlug,
  type TacticalUnit,
  type Tile,
  unitAt,
} from './boardModel';

function unit(o: Partial<TacticalUnit> & { readonly unitId: number }): TacticalUnit {
  return {
    side: 'A',
    mine: true,
    ai: false,
    speciesId: 1,
    speciesName: 'Sprigg',
    level: 5,
    affinity: 'Plant',
    x: 0,
    y: 0,
    curHp: 10,
    maxHp: 10,
    status: null,
    ap: 6,
    guard: false,
    firstStand: false,
    role: null,
    stance: null,
    state: 'Active',
    ...o,
  };
}

function board(o: Partial<BoardInput> = {}): BoardInput {
  return {
    width: 7,
    height: 5,
    units: [],
    activeUnitId: null,
    cursor: null,
    overlays: EMPTY_OVERLAYS,
    dangerOn: false,
    ...o,
  };
}

function overlays(o: Partial<OverlaySets>): OverlaySets {
  return { ...EMPTY_OVERLAYS, ...o };
}

const T = (x: number, y: number): Tile => ({ x, y });

/** The VM tile at (x, y), read through the row-major contract `tiles[y * width + x]`. */
function tileAt(vm: ReturnType<typeof buildBoard>, x: number, y: number) {
  return vm.tiles[y * vm.width + x];
}

/** Build a one-unit board and return that unit's view-model. */
function onlyUnit(curHp: number, maxHp: number) {
  const vm = buildBoard(board({ units: [unit({ unitId: 1, curHp, maxHp })] }));
  return vm.units[0];
}

describe('boardModel: the grid and the unit view-models (BT10.1)', () => {
  it('BT10-1-BOARD-GEOMETRY: a non-square board lists width*height tiles row-major, a unit keeps its own x and y, and exactly the cursor tile carries the cursor flag', () => {
    // WRONG IMPL KILLED: x/y swapped when indexing or when copying a unit (the 7x5 board with a
    // unit at x=5,y=1 puts it at (1,5) or in a tile that does not exist); tiles in column-major
    // order; a width*width or height*height tile count (a square assumption); a cursor flag on
    // every tile, on none, or on the transposed tile.
    const vm = buildBoard(
      board({ width: 7, height: 5, units: [unit({ unitId: 1, x: 5, y: 1 })], cursor: T(2, 3) }),
    );
    expect(vm.width, 'width').toBe(7);
    expect(vm.height, 'height').toBe(5);
    expect(vm.tiles, 'tile count is width*height').toHaveLength(35);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) {
        const tile = tileAt(vm, x, y);
        expect(tile.x, `tiles[${y * 7 + x}].x`).toBe(x);
        expect(tile.y, `tiles[${y * 7 + x}].y`).toBe(y);
      }
    }
    expect(vm.units, 'one unit').toHaveLength(1);
    expect(vm.units[0].x, 'unit x is kept (not swapped with y)').toBe(5);
    expect(vm.units[0].y, 'unit y is kept (not swapped with x)').toBe(1);
    const cursorTiles = vm.tiles.filter((t) => t.cursor);
    expect(cursorTiles, 'exactly one cursor tile').toHaveLength(1);
    expect({ x: cursorTiles[0].x, y: cursorTiles[0].y }, 'the cursor tile is (2,3)').toEqual(
      T(2, 3),
    );

    const tall = buildBoard(board({ width: 4, height: 6 }));
    expect(tall.tiles, 'a 4x6 board has 24 tiles').toHaveLength(24);
    expect(
      { x: tall.tiles[23].x, y: tall.tiles[23].y },
      'the last tile of a 4x6 board is (3,5)',
    ).toEqual(T(3, 5));
    expect(
      buildBoard(board({ cursor: null })).tiles.some((t) => t.cursor),
      'no cursor, no flag',
    ).toBe(false);
  });

  it('BT10-1-BOARD-HP: hpPermille is floor(cur*1000/max), 0 for a zero max and capped at 1000, and the band is high above 500, mid above 200, else low', () => {
    // WRONG IMPL KILLED: Math.round (2/3 reads 667, 1/3 reads 333 either way, so 2/3 is the
    // discriminator); a percent (0..100) scale; a divide-by-zero NaN/Infinity for maxHp 0; no cap
    // when curHp exceeds maxHp; band edges shifted by one (>= 500, > 200 read as >= 200 or > 201).
    expect(onlyUnit(2, 3).hpPermille, '2/3 floors to 666').toBe(666);
    expect(onlyUnit(1, 3).hpPermille, '1/3 floors to 333').toBe(333);
    expect(onlyUnit(999, 1000).hpPermille, '999/1000').toBe(999);
    expect(onlyUnit(10, 10).hpPermille, 'full').toBe(1000);
    expect(onlyUnit(0, 10).hpPermille, 'empty').toBe(0);
    expect(onlyUnit(0, 0).hpPermille, 'maxHp 0 is 0, not NaN').toBe(0);
    expect(onlyUnit(5, 0).hpPermille, 'maxHp 0 with hp is still 0').toBe(0);
    expect(onlyUnit(15, 10).hpPermille, 'curHp above maxHp is capped at 1000').toBe(1000);

    expect(onlyUnit(501, 1000).hpBand, '501 is high').toBe('high');
    expect(onlyUnit(500, 1000).hpBand, '500 is mid').toBe('mid');
    expect(onlyUnit(201, 1000).hpBand, '201 is mid').toBe('mid');
    expect(onlyUnit(200, 1000).hpBand, '200 is low').toBe('low');
    expect(onlyUnit(0, 10).hpBand, 'empty is low').toBe('low');
    expect(onlyUnit(10, 10).hpBand, 'full is high').toBe('high');
    expect(onlyUnit(2, 3).hpBand, '666 is high').toBe('high');
    expect(onlyUnit(1, 3).hpBand, '333 is mid').toBe('mid');
    expect(onlyUnit(0, 0).hpBand, 'a zero max reads low').toBe('low');
  });

  it('BT10-1-BOARD-ACTIVE-ONLY: only Active units get a view-model (input order kept), a Fainted or Recruited unit still leaves its tile in the grid, and only an Active activeUnitId is highlighted', () => {
    // WRONG IMPL KILLED: a filter on the wrong state or none (a Fainted sprite still standing on
    // the board); the grid shrinking around a KO; the highlight following an activeUnitId that
    // names a Fainted or an unknown unit (A9); every unit highlighted; the order sorted by id.
    const units = [
      unit({ unitId: 9, x: 0, y: 0 }),
      unit({ unitId: 2, x: 2, y: 2, state: 'Fainted', curHp: 0 }),
      unit({ unitId: 3, x: 3, y: 3, state: 'Recruited' }),
      unit({ unitId: 4, x: 4, y: 1, side: 'B', mine: false, speciesName: 'Mossback' }),
    ];
    const vm = buildBoard(board({ units, activeUnitId: 4 }));
    expect(
      vm.units.map((u) => u.unitId),
      'Active units only, in input order',
    ).toEqual([9, 4]);
    expect(vm.tiles, 'the grid keeps every tile').toHaveLength(35);
    expect(
      { x: tileAt(vm, 2, 2).x, y: tileAt(vm, 2, 2).y },
      'a Fainted unit still leaves its tile',
    ).toEqual(T(2, 2));
    expect(
      vm.units.map((u) => u.active),
      'only unit 4 is the active unit',
    ).toEqual([false, true]);
    expect(vm.units[1].side, 'side is copied').toBe('B');
    expect(vm.units[1].mine, 'mine is copied').toBe(false);
    expect(vm.units[1].speciesName, 'speciesName is copied verbatim').toBe('Mossback');

    const faintedActive = buildBoard(board({ units, activeUnitId: 2 }));
    expect(
      faintedActive.units.some((u) => u.active),
      'activeUnitId naming a Fainted unit highlights nobody',
    ).toBe(false);
    const unknownActive = buildBoard(board({ units, activeUnitId: 999 }));
    expect(
      unknownActive.units.some((u) => u.active),
      'activeUnitId naming no unit highlights nobody',
    ).toBe(false);
    const noActive = buildBoard(board({ units, activeUnitId: null }));
    expect(
      noActive.units.some((u) => u.active),
      'activeUnitId null highlights nobody',
    ).toBe(false);
  });

  it('BT10-1-BOARD-SLUG: spriteSlug lower-cases a [A-Za-z]+ species name and refuses everything else, and a unit view-model carries that slug', () => {
    // WRONG IMPL KILLED: a slug that keeps digits, dots, slashes or spaces (a path-traversal or a
    // broken asset name: `monster-../x.png`); a case-insensitive test of the INPUT that lets a
    // non-ASCII letter through (the dotless i U+0131, an e acute); no lower-casing; a slug for the
    // empty name; the slug computed once and shared by every unit.
    const E_ACUTE = String.fromCharCode(0x00e9);
    const DOTLESS_I = String.fromCharCode(0x0131);
    expect(spriteSlug('Sprigg'), 'Sprigg').toBe('sprigg');
    expect(spriteSlug('MossBack'), 'mixed case').toBe('mossback');
    expect(spriteSlug('flameling'), 'already lower').toBe('flameling');
    for (const bad of [
      '../x',
      'a b',
      'Mon2',
      '',
      E_ACUTE,
      `Caf${E_ACUTE}`,
      'a.png',
      DOTLESS_I,
      `Sprigg${DOTLESS_I}`,
      'Sprigg ',
      ' Sprigg',
      'a-b',
      'a_b',
      'a/b',
      'a\\b',
    ]) {
      expect(spriteSlug(bad), `${JSON.stringify(bad)} has no sprite`).toBeNull();
    }
    const vm = buildBoard(
      board({
        units: [
          unit({ unitId: 1, x: 0, y: 0, speciesName: 'Sprigg' }),
          unit({ unitId: 2, x: 1, y: 0, speciesName: 'Mon2' }),
          unit({ unitId: 3, x: 2, y: 0, speciesName: 'Cindertail' }),
        ],
      }),
    );
    expect(
      vm.units.map((u) => u.spriteSlug),
      'each unit view-model carries its own slug, null when refused',
    ).toEqual(['sprigg', null, 'cindertail']);
  });

  it('BT10-2-BOARD-UNITAT: unitAt returns the ACTIVE unit on a tile, never a Fainted or Recruited one standing there, and null on an empty tile', () => {
    // WRONG IMPL KILLED: a first-match scan that returns the Fainted unit listed before the live
    // one on the same tile (the hover would expand a corpse); a scan that ignores state; x/y
    // swapped in the comparison; a non-null answer for an empty tile.
    const units = [
      unit({ unitId: 1, x: 2, y: 2 }),
      unit({ unitId: 2, x: 3, y: 3, state: 'Fainted' }),
      unit({ unitId: 3, x: 3, y: 3 }),
      unit({ unitId: 4, x: 4, y: 1, state: 'Recruited' }),
      unit({ unitId: 5, x: 5, y: 1 }),
    ];
    expect(unitAt(units, T(2, 2))?.unitId, '(2,2)').toBe(1);
    expect(
      unitAt(units, T(3, 3))?.unitId,
      'the live unit wins over the Fainted one listed first',
    ).toBe(3);
    expect(unitAt(units, T(4, 1)), 'only a Recruited unit stands there').toBeNull();
    expect(unitAt(units, T(5, 1))?.unitId, '(5,1) is x=5,y=1').toBe(5);
    expect(unitAt(units, T(1, 5)), '(1,5) is the transposed tile: empty').toBeNull();
    expect(unitAt(units, T(0, 0)), 'an empty tile').toBeNull();
    expect(unitAt([], T(0, 0)), 'no units').toBeNull();
  });
});

describe('boardModel: the overlay layer (BT10.4, deferred gate — the tests still ship)', () => {
  it('BT10-4-OVERLAY-ORDER: the overlays on a tile follow OVERLAY_ORDER whatever order the sets were supplied in', () => {
    // WRONG IMPL KILLED: overlays listed in input-object key order (the fixture below supplies
    // shield first and reach1 last); an unstable order between renders; a missing kind.
    expect(OVERLAY_ORDER, 'the fixed order').toEqual([
      'reach1',
      'reach2',
      'range',
      'aoe',
      'danger',
      'shield',
    ]);
    const shuffled = overlays({
      shield: [T(1, 1)],
      aoe: [T(1, 1)],
      danger: [[T(1, 1)]],
      range: [T(1, 1)],
      reach1: [T(1, 1)],
    });
    const vm = buildBoard(board({ width: 6, height: 6, overlays: shuffled, dangerOn: true }));
    expect(tileAt(vm, 1, 1).overlays, 'fixed order, shield first in the input').toEqual([
      'reach1',
      'range',
      'aoe',
      'danger',
      'shield',
    ]);
    expect(tileAt(vm, 0, 0).overlays, 'an untouched tile carries nothing').toEqual([]);
    expect(tileAt(vm, 1, 0).overlays, 'a neighbour carries nothing (x/y not swapped)').toEqual([]);
    expect(tileAt(vm, 0, 1).overlays, 'a neighbour carries nothing (x/y not swapped)').toEqual([]);

    // Every kind on its own tile is present under its own name.
    const kinds: readonly OverlayKind[] = ['reach1', 'reach2', 'range', 'aoe', 'shield'];
    for (const [i, kind] of kinds.entries()) {
      const set = overlays({ [kind]: [T(i, 2)] } as unknown as Partial<OverlaySets>);
      const one = buildBoard(board({ width: 6, height: 6, overlays: set }));
      expect(tileAt(one, i, 2).overlays, `${kind} alone`).toEqual([kind]);
    }
  });

  it('BT10-4-OVERLAY-PRECEDENCE: a tile in both reach sets carries only reach1; reach2 and range stack in order; a repeated tile is listed once', () => {
    // WRONG IMPL KILLED: both reach kinds on one tile (the light blue paints over the blue); reach1
    // dropped instead of reach2; range swallowed by the reach collapse; a tile repeated in one set
    // listed twice (a class added per occurrence).
    const set = overlays({
      reach1: [T(0, 0), T(0, 0), T(1, 0), T(2, 0)],
      reach2: [T(0, 0), T(3, 0), T(4, 0)],
      range: [T(1, 0), T(3, 0), T(4, 1)],
    });
    const vm = buildBoard(board({ overlays: set }));
    expect(
      tileAt(vm, 0, 0).overlays,
      'reach1 and reach2 -> reach1 only (repeat listed once)',
    ).toEqual(['reach1']);
    expect(tileAt(vm, 1, 0).overlays, 'reach1 and range').toEqual(['reach1', 'range']);
    expect(tileAt(vm, 2, 0).overlays, 'reach1 alone').toEqual(['reach1']);
    expect(tileAt(vm, 3, 0).overlays, 'reach2 and range').toEqual(['reach2', 'range']);
    expect(tileAt(vm, 4, 0).overlays, 'reach2 alone').toEqual(['reach2']);
    expect(tileAt(vm, 4, 1).overlays, 'range alone').toEqual(['range']);

    const triple = buildBoard(
      board({ overlays: overlays({ reach1: [T(2, 2)], reach2: [T(2, 2)], range: [T(2, 2)] }) }),
    );
    expect(tileAt(triple, 2, 2).overlays, 'all three -> reach1 and range').toEqual([
      'reach1',
      'range',
    ]);
  });

  it('BT10-4-OVERLAY-DANGER: the danger tiles are the de-duplicated union of every enemy set, present only while dangerOn', () => {
    // WRONG IMPL KILLED: only the first enemy's set painted; one 'danger' per enemy overlapping on
    // a tile (a doubled class entry); danger painted while the toggle is off; the toggle ignored
    // when the sets are empty.
    const set = overlays({
      danger: [
        [T(1, 1), T(2, 2)],
        [T(2, 2), T(3, 3)],
      ],
    });
    const on = buildBoard(board({ overlays: set, dangerOn: true }));
    expect(tileAt(on, 1, 1).overlays, 'first set only').toEqual(['danger']);
    expect(tileAt(on, 2, 2).overlays, 'both sets overlap -> ONE danger').toEqual(['danger']);
    expect(tileAt(on, 3, 3).overlays, 'second set only').toEqual(['danger']);
    expect(
      on.tiles.filter((t) => t.overlays.includes('danger')),
      'exactly the union',
    ).toHaveLength(3);

    const off = buildBoard(board({ overlays: set, dangerOn: false }));
    expect(
      off.tiles.some((t) => t.overlays.includes('danger')),
      'dangerOn false -> no danger anywhere',
    ).toBe(false);

    const none = buildBoard(board({ overlays: overlays({ danger: [] }), dangerOn: true }));
    expect(
      none.tiles.some((t) => t.overlays.length > 0),
      'dangerOn with no enemy set paints nothing',
    ).toBe(false);
  });

  it('BT10-4-OVERLAY-BOUNDS: tiles outside the board are ignored (the grid stays width*height), and an aoe tile under the caster is kept', () => {
    // WRONG IMPL KILLED: an out-of-bounds tile appended to the grid or wrapped to the next row
    // ((7,0) landing on (0,1)); a negative index writing tiles[-1]; the AoE ghost dropped from the
    // caster's own tile (the spec keeps it: the caster is hit by its own blast).
    const set = overlays({
      reach1: [T(-1, 0), T(7, 0), T(0, 5), T(0, -1), T(6, 4)],
      aoe: [T(2, 2), T(3, 2)],
    });
    const vm = buildBoard(
      board({
        width: 7,
        height: 5,
        overlays: set,
        units: [unit({ unitId: 1, x: 2, y: 2 })],
        activeUnitId: 1,
      }),
    );
    expect(vm.tiles, 'out-of-bounds tiles do not grow the grid').toHaveLength(35);
    expect(tileAt(vm, 0, 1).overlays, '(7,0) did not wrap onto (0,1)').toEqual([]);
    expect(tileAt(vm, 0, 0).overlays, '(-1,0) and (0,-1) did not land on (0,0)').toEqual([]);
    expect(tileAt(vm, 6, 4).overlays, 'the in-bounds corner is painted').toEqual(['reach1']);
    expect(
      vm.tiles.filter((t) => t.overlays.includes('reach1')),
      'only the in-bounds reach tile survives',
    ).toHaveLength(1);
    expect(tileAt(vm, 2, 2).overlays, "the caster's own tile keeps its aoe").toEqual(['aoe']);
    expect(tileAt(vm, 3, 2).overlays, 'a neighbour aoe tile').toEqual(['aoe']);
  });

  it('BT10-4-OVERLAY-INTENTS: an Active unit shows the intent the rules port reported (hold included), an unknown or non-Active unit is ignored, and a unit with no entry has none', () => {
    // WRONG IMPL KILLED: 'hold' treated as "no intent" (the wild's wait is the most informative
    // chip); an intent for a Fainted unit rendered; an unknown unitId throwing; the last entry for
    // a unit not winning; an intent leaking onto every unit.
    const units = [
      unit({ unitId: 1, x: 0, y: 0 }),
      unit({ unitId: 2, x: 1, y: 0, side: 'B', mine: false }),
      unit({ unitId: 3, x: 2, y: 0, side: 'B', mine: false }),
      unit({ unitId: 4, x: 3, y: 0, side: 'B', mine: false }),
      unit({ unitId: 5, x: 4, y: 0, side: 'B', mine: false, state: 'Fainted' }),
    ];
    const set = overlays({
      intents: [
        { unitId: 2, kind: 'hold' },
        { unitId: 3, kind: 'attack' },
        { unitId: 5, kind: 'move' },
        { unitId: 99, kind: 'attack' },
      ],
    });
    const vm = buildBoard(board({ units, overlays: set }));
    const byId = new Map(vm.units.map((u) => [u.unitId, u.intent]));
    expect(byId.get(1), 'no entry -> null').toBeNull();
    expect(byId.get(2), 'hold is kept').toBe('hold');
    expect(byId.get(3), 'attack').toBe('attack');
    expect(byId.get(4), 'no entry -> null').toBeNull();
    expect(byId.has(5), 'the Fainted unit has no view-model at all').toBe(false);
    expect(vm.units, 'the unknown unit 99 added nothing').toHaveLength(4);

    const twice = buildBoard(
      board({
        units: [unit({ unitId: 7, x: 0, y: 0, side: 'B', mine: false })],
        overlays: overlays({
          intents: [
            { unitId: 7, kind: 'move' },
            { unitId: 7, kind: 'attack' },
          ],
        }),
      }),
    );
    expect(twice.units[0].intent, 'the later entry for a unit wins').toBe('attack');
  });
});

describe('boardModel: the cursor memory (BT10.6)', () => {
  it('BT10-6-CURSOR-MOVE: moveCursor steps one tile per direction, clamps at every edge of a non-square board, returns a NEW map and keeps the other units entries', () => {
    // WRONG IMPL KILLED: Up/Down on x and Left/Right on y; Up adding to y (screen y grows
    // downward); no clamp (the cursor walks off the board); clamping against width on both axes
    // (a 7x5 board lets y reach 6); mutating the input map in place (the previous render's
    // memory changes under it); dropping the other units' remembered tiles; writing the new tile
    // under the wrong unit.
    const mem: CursorMemory = new Map([
      [1, T(3, 2)],
      [2, T(6, 4)],
    ]);
    const before = [...mem.entries()];
    const right = moveCursor(mem, 1, T(3, 2), 'Right', 7, 5);
    expect(right, 'a new map').not.toBe(mem);
    expect(right.get(1), 'Right is x+1').toEqual(T(4, 2));
    expect(right.get(2), "another unit's entry is kept").toEqual(T(6, 4));
    expect([...mem.entries()], 'the input map is not mutated').toEqual(before);
    expect(moveCursor(mem, 1, T(3, 2), 'Left', 7, 5).get(1), 'Left is x-1').toEqual(T(2, 2));
    expect(moveCursor(mem, 1, T(3, 2), 'Up', 7, 5).get(1), 'Up is y-1').toEqual(T(3, 1));
    expect(moveCursor(mem, 1, T(3, 2), 'Down', 7, 5).get(1), 'Down is y+1').toEqual(T(3, 3));

    const edge = (from: Tile, dir: Dir): Tile | undefined =>
      moveCursor(new Map(), 9, from, dir, 7, 5).get(9);
    expect(edge(T(0, 2), 'Left'), 'clamped at x=0').toEqual(T(0, 2));
    expect(edge(T(0, 0), 'Up'), 'clamped at y=0').toEqual(T(0, 0));
    expect(edge(T(6, 2), 'Right'), 'clamped at x=width-1').toEqual(T(6, 2));
    expect(edge(T(3, 4), 'Down'), 'clamped at y=height-1 (not width-1)').toEqual(T(3, 4));
    expect(edge(T(6, 4), 'Down'), 'the far corner stays').toEqual(T(6, 4));
    expect(edge(T(6, 3), 'Down'), 'y may still grow up to height-1').toEqual(T(6, 4));
    expect(edge(T(5, 0), 'Right'), 'x may still grow up to width-1').toEqual(T(6, 0));
    expect(
      moveCursor(new Map(), 4, T(1, 1), 'Right', 7, 5).has(4),
      'the entry is written under the moved unit',
    ).toBe(true);
  });

  it("BT10-6-CURSOR-FOR: cursorFor returns the remembered tile when there is one, else the unit's CURRENT tile, and clamps a remembered tile into the board", () => {
    // WRONG IMPL KILLED: ignoring the memory (the cursor snaps back to the unit on every cycle);
    // reading another unit's memory; falling back to (0,0) instead of the unit's tile; a stale
    // remembered tile off a smaller board (a 4x4 board with a remembered (6,6) would index past
    // the grid); clamping only one axis.
    const u = unit({ unitId: 5, x: 3, y: 1 });
    expect(cursorFor(new Map(), u, 7, 5), 'no memory: the unit tile').toEqual(T(3, 1));
    expect(cursorFor(new Map([[5, T(2, 4)]]), u, 7, 5), 'remembered wins').toEqual(T(2, 4));
    expect(
      cursorFor(new Map([[6, T(2, 4)]]), u, 7, 5),
      'a different unit memory is not used',
    ).toEqual(T(3, 1));
    expect(cursorFor(new Map([[5, T(6, 6)]]), u, 4, 4), 'both axes clamped').toEqual(T(3, 3));
    expect(cursorFor(new Map([[5, T(6, 2)]]), u, 4, 4), 'x clamped, y kept').toEqual(T(3, 2));
    expect(cursorFor(new Map([[5, T(1, 9)]]), u, 4, 4), 'y clamped, x kept').toEqual(T(1, 3));
    expect(
      cursorFor(new Map([[5, T(0, 0)]]), u, 4, 4),
      'a remembered origin is a memory, not "none"',
    ).toEqual(T(0, 0));
    const moved = unit({ unitId: 5, x: 6, y: 4 });
    expect(cursorFor(new Map(), moved, 7, 5), "the unit's CURRENT tile after it moved").toEqual(
      T(6, 4),
    );
  });
});
