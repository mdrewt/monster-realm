// @vitest-environment happy-dom
// tactics/hud.test.ts — bt-10 RED tests for the per-side info boxes (BT10.2): one compact row per
// unit (name / level / HP / type), the hovered-or-targeted unit's row expanded with its status,
// Guard, First-Stand, role and stance chips, and the ACTIVE unit's six AP pips with drafted spend
// blinking.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.2 and the plan's API freeze (hud.ts stub + DOM contract
// block). `infoBoxes` is pure; `renderInfoBoxes` paints a hand-built InfoBoxesVM, so the DOM tests
// do not depend on infoBoxes.
//
// DOM CONTRACT PINNED HERE BEYOND THE FREEZE TEXT: the AP count label (`tactics.hud.ap`, ap = the
// pips that are not spent, max = AP_PIPS) is reachable from the active unit's row as text or as an
// aria-label/title (InfoRowVM carries no ap number, so the renderer derives it from the pips).
//
// RED REASON: infoBoxes / renderInfoBoxes throw `bt-10: not implemented`.
// Strings are asserted through CATALOG_EN. Do NOT edit these tests to match a buggy
// implementation; correct them from the spec only.

import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import type { Stance, StatusTag, TacticalUnit } from './boardModel';
import {
  AP_PIPS,
  type InfoBoxesVM,
  type InfoRowVM,
  infoBoxes,
  type PipState,
  renderInfoBoxes,
} from './hud';

const EN = CATALOG_EN as unknown as Record<string, unknown>;

function en(key: string, params: Record<string, unknown> = {}): string {
  const value = EN[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

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

const foe = (o: Partial<TacticalUnit> & { readonly unitId: number }): TacticalUnit =>
  unit({ side: 'B', mine: false, ...o });

function focus(
  units: readonly TacticalUnit[],
  focusUnitId: number | null,
  activeUnitId = 1,
): InfoBoxesVM {
  return infoBoxes(units, { activeUnitId, focusUnitId, draftedAp: 0 });
}

function allRows(vm: InfoBoxesVM): InfoRowVM[] {
  return [...vm.own, ...vm.foe];
}

function pipsFor(ap: number, drafted: number): readonly PipState[] | null {
  const vm = infoBoxes([unit({ unitId: 1, ap })], {
    activeUnitId: 1,
    focusUnitId: null,
    draftedAp: drafted,
  });
  return vm.own[0].pips;
}

const rep = (state: PipState, n: number): PipState[] => Array.from({ length: n }, () => state);

describe('infoBoxes: the per-side rows (BT10.2)', () => {
  it('BT10-2-HUD-SPLIT: units split into own and foe boxes keeping input order within each, and a row carries name, level, hp, maxHp, affinity, mine and fainted', () => {
    // WRONG IMPL KILLED: one merged list; the foe list reversed or sorted by id; a row built
    // from the wrong unit when own and foe interleave; hp and maxHp swapped; a Fainted unit
    // dropped from its box (the roster of a KO'd team vanishes) or not flagged fainted.
    const units = [
      unit({ unitId: 5, speciesName: 'Sprigg', level: 7, curHp: 8, maxHp: 20, affinity: 'Plant' }),
      foe({ unitId: 2, speciesName: 'Mossback', level: 9, curHp: 3, maxHp: 9, affinity: 'Earth' }),
      unit({
        unitId: 3,
        speciesName: 'Cindertail',
        level: 4,
        curHp: 15,
        maxHp: 15,
        affinity: 'Fire',
      }),
      foe({ unitId: 8, speciesName: 'Flameling', level: 6, curHp: 1, maxHp: 30, affinity: 'Fire' }),
      unit({ unitId: 1, state: 'Fainted', curHp: 0, maxHp: 12, speciesName: 'Sprigg' }),
    ];
    const vm = focus(units, null);
    expect(
      vm.own.map((r) => r.unitId),
      'own box keeps input order',
    ).toEqual([5, 3, 1]);
    expect(
      vm.foe.map((r) => r.unitId),
      'foe box keeps input order (not sorted)',
    ).toEqual([2, 8]);
    expect(vm.own[0], 'row 5 fields').toMatchObject({
      unitId: 5,
      name: 'Sprigg',
      level: 7,
      hp: 8,
      maxHp: 20,
      affinity: 'Plant',
      mine: true,
      fainted: false,
    });
    expect(vm.foe[0], 'row 2 fields').toMatchObject({
      unitId: 2,
      name: 'Mossback',
      level: 9,
      hp: 3,
      maxHp: 9,
      affinity: 'Earth',
      mine: false,
      fainted: false,
    });
    expect(vm.own[2].fainted, 'the Fainted unit is listed and flagged').toBe(true);
    expect(vm.own[2].hp, 'its hp').toBe(0);
    expect(
      allRows(vm).every((r) => r.mine === vm.own.includes(r)),
      'mine matches the box',
    ).toBe(true);
  });

  it('BT10-2-HUD-EXPANDED: only the focus unit has an expanded row, focus null or unknown expands nothing (no throw), and the expansion carries status, guard, firstStand, role and stance', () => {
    // WRONG IMPL KILLED: expanding the ACTIVE unit instead of the focus (the fixture's active unit
    // is 1, the focus 2); expanding every row; throwing on an unknown focus id; losing a datum
    // (a guard flag always false, a stance dropped); expansion shared by reference between rows.
    const units = [
      unit({ unitId: 1, status: 'Burn', guard: true, role: 'Tank', stance: 'Skittish' }),
      foe({
        unitId: 2,
        status: 'Poison',
        guard: true,
        firstStand: true,
        role: 'Skirmisher',
        stance: 'Aggressive',
      }),
      foe({ unitId: 3 }),
    ];
    const vm = focus(units, 2, 1);
    const expanded = allRows(vm).filter((r) => r.expanded !== null);
    expect(
      expanded.map((r) => r.unitId),
      'only the focus unit is expanded',
    ).toEqual([2]);
    expect(expanded[0].expanded, 'the five data of unit 2').toEqual({
      status: 'Poison',
      guard: true,
      firstStand: true,
      role: 'Skirmisher',
      stance: 'Aggressive',
    });

    const own = focus(units, 1, 2);
    expect(
      allRows(own)
        .filter((r) => r.expanded !== null)
        .map((r) => r.unitId),
      'focusing an own unit expands that one',
    ).toEqual([1]);
    expect(own.own[0].expanded, 'unit 1 carries its own data, not unit 2s').toEqual({
      status: 'Burn',
      guard: true,
      firstStand: false,
      role: 'Tank',
      stance: 'Skittish',
    });

    expect(
      allRows(focus(units, null)).every((r) => r.expanded === null),
      'focus null expands nothing',
    ).toBe(true);
    expect(() => focus(units, 999), 'an unknown focus id does not throw').not.toThrow();
    expect(
      allRows(focus(units, 999)).every((r) => r.expanded === null),
      'an unknown focus id expands nothing',
    ).toBe(true);

    const bare = focus([unit({ unitId: 1 }), foe({ unitId: 2 })], 2, 1);
    expect(bare.foe[0].expanded, 'absent data stay absent').toEqual({
      status: null,
      guard: false,
      firstStand: false,
      role: null,
      stance: null,
    });
  });

  it('BT10-2-HUD-PIPS: the active unit shows six pips (full, then drafted, then spent), every other row none, and the edge cases clamp', () => {
    // WRONG IMPL KILLED: pip i < ap-drafted read as i <= ; drafted pips taken from the wrong end
    // (spent before full); a drafted count above ap leaving a negative full count (ap=3,d=9 must
    // read three drafted); a negative drafted count adding pips; ap above 6 growing the array;
    // ap 0 reading anything but spent; pips on the focus unit instead of the active one; pips on
    // a Fainted or unknown active unit.
    expect(AP_PIPS, 'six pips').toBe(6);
    expect(pipsFor(4, 2), 'ap 4, drafted 2').toEqual([
      ...rep('full', 2),
      ...rep('drafted', 2),
      ...rep('spent', 2),
    ]);
    expect(pipsFor(6, 0), 'a fresh turn').toEqual(rep('full', 6));
    expect(pipsFor(6, 6), 'everything drafted').toEqual(rep('drafted', 6));
    expect(pipsFor(3, 9), 'drafted clamps to ap').toEqual([
      ...rep('drafted', 3),
      ...rep('spent', 3),
    ]);
    expect(pipsFor(0, 0), 'ap 0').toEqual(rep('spent', 6));
    expect(pipsFor(0, 2), 'ap 0 with a drafted count').toEqual(rep('spent', 6));
    expect(pipsFor(4, -1), 'negative drafted counts as 0').toEqual([
      ...rep('full', 4),
      ...rep('spent', 2),
    ]);
    expect(pipsFor(8, 0), 'ap above 6: still six pips').toEqual(rep('full', 6));
    expect(pipsFor(8, 3), 'ap above 6 with drafted').toEqual([
      ...rep('full', 5),
      ...rep('drafted', 1),
    ]);
    expect(pipsFor(1, 1), 'one ap, drafted').toEqual([...rep('drafted', 1), ...rep('spent', 5)]);

    const units = [
      unit({ unitId: 1, ap: 4 }),
      foe({ unitId: 2, ap: 6 }),
      unit({ unitId: 3, ap: 5 }),
    ];
    const vm = infoBoxes(units, { activeUnitId: 3, focusUnitId: 1, draftedAp: 1 });
    expect(
      allRows(vm)
        .filter((r) => r.pips !== null)
        .map((r) => r.unitId),
      'pips only on the active unit (not the focus unit)',
    ).toEqual([3]);
    expect(vm.own[1].pips, 'unit 3 pips').toEqual([
      ...rep('full', 4),
      ...rep('drafted', 1),
      ...rep('spent', 1),
    ]);

    const fainted = infoBoxes([unit({ unitId: 1, state: 'Fainted', ap: 6 }), foe({ unitId: 2 })], {
      activeUnitId: 1,
      focusUnitId: null,
      draftedAp: 0,
    });
    expect(
      allRows(fainted).every((r) => r.pips === null),
      'a Fainted active unit gets no pips',
    ).toBe(true);
    const unknown = infoBoxes(units, { activeUnitId: 404, focusUnitId: null, draftedAp: 0 });
    expect(
      allRows(unknown).every((r) => r.pips === null),
      'an unknown active unit gets no pips',
    ).toBe(true);
    const none = infoBoxes(units, { activeUnitId: null, focusUnitId: null, draftedAp: 0 });
    expect(
      allRows(none).every((r) => r.pips === null),
      'no active unit, no pips',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

function rowVM(o: Partial<InfoRowVM> & { readonly unitId: number }): InfoRowVM {
  return {
    name: 'Sprigg',
    level: 5,
    hp: 10,
    maxHp: 10,
    affinity: 'Plant',
    mine: true,
    fainted: false,
    expanded: null,
    pips: null,
    ...o,
  };
}

function mount(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

function q<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (found === null) throw new Error(`no element matches ${selector}`);
  return found;
}

const ids = (root: ParentNode, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((e) => e.getAttribute('data-unit-id') ?? '');

afterEach(() => {
  document.body.replaceChildren();
});

describe('renderInfoBoxes: the DOM rows (BT10.2)', () => {
  it('BT10-2-HUD-DOM-ROWS: the own and foe boxes hold one compact row per unit showing name, level, hp and affinity through the catalog, and a second render repaints without duplicating', () => {
    // WRONG IMPL KILLED: both sides in one box (the green/red cue lost); a row per render
    // appended; the level or hp text hard-coded instead of the catalog's tactics.hud.level /
    // tactics.hud.hp; hp and max swapped in the text; the affinity omitted; the foe box
    // carrying own rows.
    const parent = mount();
    const vm: InfoBoxesVM = {
      own: [
        rowVM({ unitId: 1, name: 'Sprigg', level: 7, hp: 8, maxHp: 20, affinity: 'Plant' }),
        rowVM({ unitId: 3, name: 'Cindertail', level: 4, hp: 15, maxHp: 15, affinity: 'Fire' }),
      ],
      foe: [
        rowVM({
          unitId: 2,
          name: 'Mossback',
          level: 9,
          hp: 3,
          maxHp: 9,
          affinity: 'Earth',
          mine: false,
        }),
      ],
    };
    renderInfoBoxes(parent, vm);
    renderInfoBoxes(parent, vm);

    expect(parent.querySelectorAll('.tactics-info--own'), 'one own box').toHaveLength(1);
    expect(parent.querySelectorAll('.tactics-info--foe'), 'one foe box').toHaveLength(1);
    const own = q(parent, '.tactics-info--own');
    const foeBox = q(parent, '.tactics-info--foe');
    expect(ids(own, '.tactics-info-row'), 'own rows').toEqual(['1', '3']);
    expect(ids(foeBox, '.tactics-info-row'), 'foe rows').toEqual(['2']);
    expect(
      parent.querySelectorAll('.tactics-info-row'),
      'no duplicated rows after two renders',
    ).toHaveLength(3);

    const row1 = q(own, '.tactics-info-row[data-unit-id="1"]');
    const text = row1.textContent ?? '';
    expect(text.includes('Sprigg'), 'name').toBe(true);
    expect(text.includes(en('tactics.hud.level', { level: 7 })), 'level via the catalog').toBe(
      true,
    );
    expect(text.includes(en('tactics.hud.hp', { hp: 8, max: 20 })), 'hp via the catalog').toBe(
      true,
    );
    expect(text.includes('Plant'), 'affinity').toBe(true);
    const row2 = q(foeBox, '.tactics-info-row[data-unit-id="2"]');
    expect(row2.textContent?.includes(en('tactics.hud.hp', { hp: 3, max: 9 })), 'foe hp').toBe(
      true,
    );
    expect(row2.textContent?.includes('Earth'), 'foe affinity').toBe(true);
    expect(
      row2.textContent?.includes(en('tactics.hud.hp', { hp: 9, max: 3 })),
      'hp and max are not swapped',
    ).toBe(false);
    expect(
      parent.querySelectorAll('.tactics-info-row--expanded'),
      'compact rows are not expanded',
    ).toHaveLength(0);
    expect(
      parent.querySelectorAll('.tactics-chip--status, .tactics-chip--guard, .tactics-pip'),
    ).toHaveLength(0);
  });

  it('BT10-2-HUD-DOM-PIPS: the active row paints exactly six pips in state order, blink is on exactly the drafted ones, no other row has pips, and the AP label is reachable', () => {
    // WRONG IMPL KILLED: five or seven pips; pips on every row; blink on every pip or on none or
    // on the spent ones (the drafted spend must flash, nothing else); the state classes in the
    // wrong order; a pip with two state classes; no AP count for assistive tech or a tooltip.
    const parent = mount();
    const pips: PipState[] = ['full', 'full', 'drafted', 'drafted', 'spent', 'spent'];
    renderInfoBoxes(parent, {
      own: [rowVM({ unitId: 1, pips }), rowVM({ unitId: 3 })],
      foe: [rowVM({ unitId: 2, mine: false })],
    });
    expect(parent.querySelectorAll('.tactics-pip'), 'six pips in the whole tree').toHaveLength(6);
    const row = q(parent, '.tactics-info-row[data-unit-id="1"]');
    const els = [...row.querySelectorAll<HTMLElement>('.tactics-pip')];
    expect(els, 'six pips in the active row').toHaveLength(6);
    const states = els.map((e) =>
      (['full', 'drafted', 'spent'] as const).filter((s) =>
        e.classList.contains(`tactics-pip--${s}`),
      ),
    );
    expect(states, 'one state class per pip, in order').toEqual([
      ['full'],
      ['full'],
      ['drafted'],
      ['drafted'],
      ['spent'],
      ['spent'],
    ]);
    expect(
      els.map((e) => e.classList.contains('tactics-blink')),
      'blink on the drafted pips only',
    ).toEqual([false, false, true, true, false, false]);
    expect(
      q(parent, '.tactics-info-row[data-unit-id="3"]').querySelectorAll('.tactics-pip'),
    ).toHaveLength(0);

    const label = en('tactics.hud.ap', { ap: 4, max: AP_PIPS });
    const reachable =
      (row.textContent ?? '').includes(label) ||
      [row, ...row.querySelectorAll('[aria-label],[title]')].some(
        (e) => e.getAttribute('aria-label') === label || e.getAttribute('title') === label,
      );
    expect(
      reachable,
      `the AP label "${label}" (non-spent pips of ${AP_PIPS}) is on the active row`,
    ).toBe(true);

    // Re-render with different pips: repainted, not appended.
    renderInfoBoxes(parent, {
      own: [rowVM({ unitId: 1, pips: ['full', 'spent', 'spent', 'spent', 'spent', 'spent'] })],
      foe: [],
    });
    expect(parent.querySelectorAll('.tactics-pip'), 'still six after a re-render').toHaveLength(6);
    expect(parent.querySelectorAll('.tactics-blink'), 'no drafted pip, no blink').toHaveLength(0);
    expect(
      parent.querySelectorAll('.tactics-info-row'),
      'rows replaced, not appended',
    ).toHaveLength(1);
  });

  it('BT10-2-HUD-DOM-CHIPS: the expanded row carries exactly the chips whose datum is present (guard false -> no guard chip) with catalog text, and only that row is expanded', () => {
    // WRONG IMPL KILLED: a guard chip for guard=false; all five chips always rendered (empty
    // chips); status/stance text hard-coded or taken from the wrong enum member; the role chip
    // not carrying the role; expanded styling on the compact rows; a first-stand chip showing
    // the guard text.
    const parent = mount();
    const full = rowVM({
      unitId: 2,
      mine: false,
      expanded: {
        status: 'Poison',
        guard: true,
        firstStand: true,
        role: 'Tank',
        stance: 'Skittish',
      },
    });
    renderInfoBoxes(parent, { own: [rowVM({ unitId: 1 })], foe: [full] });
    expect(ids(parent, '.tactics-info-row--expanded'), 'only the focus row is expanded').toEqual([
      '2',
    ]);
    const row = q(parent, '.tactics-info-row[data-unit-id="2"]');
    expect(q(row, '.tactics-chip--status').textContent, 'status chip').toBe(
      en('tactics.status.poison'),
    );
    expect(q(row, '.tactics-chip--guard').textContent, 'guard chip').toBe(en('tactics.hud.guard'));
    expect(q(row, '.tactics-chip--first-stand').textContent, 'first-stand chip').toBe(
      en('tactics.hud.firstStand'),
    );
    expect(q(row, '.tactics-chip--role').textContent, 'role chip').toBe(
      en('tactics.hud.role', { role: 'Tank' }),
    );
    expect(q(row, '.tactics-chip--stance').textContent, 'stance chip').toBe(
      en('tactics.stance.skittish'),
    );

    // Absent data -> absent chips, one datum at a time.
    const only = (expanded: NonNullable<InfoRowVM['expanded']>): string[] => {
      const p = mount();
      renderInfoBoxes(p, { own: [], foe: [rowVM({ unitId: 7, mine: false, expanded })] });
      const r = q(p, '.tactics-info-row[data-unit-id="7"]');
      return ['status', 'guard', 'first-stand', 'role', 'stance'].filter(
        (c) => r.querySelector(`.tactics-chip--${c}`) !== null,
      );
    };
    const none = { status: null, guard: false, firstStand: false, role: null, stance: null };
    expect(only(none), 'nothing present -> no chip').toEqual([]);
    expect(only({ ...none, guard: true }), 'guard only').toEqual(['guard']);
    expect(only({ ...none, firstStand: true }), 'first stand only').toEqual(['first-stand']);
    expect(only({ ...none, status: 'Burn' }), 'status only').toEqual(['status']);
    expect(only({ ...none, role: 'Healer' }), 'role only').toEqual(['role']);
    expect(only({ ...none, stance: 'Aggressive' }), 'stance only').toEqual(['stance']);
    // The row is still expanded with no chip (the box opens on the focus regardless of data).
    const p2 = mount();
    renderInfoBoxes(p2, { own: [], foe: [rowVM({ unitId: 8, mine: false, expanded: none })] });
    expect(ids(p2, '.tactics-info-row--expanded'), 'expanded without chips').toEqual(['8']);

    // Every status and stance maps to its own catalog key.
    const statuses: readonly (readonly [StatusTag, string])[] = [
      ['Poison', 'tactics.status.poison'],
      ['Burn', 'tactics.status.burn'],
      ['Paralysis', 'tactics.status.paralysis'],
      ['Sleep', 'tactics.status.sleep'],
      ['Freeze', 'tactics.status.freeze'],
    ];
    for (const [status, key] of statuses) {
      const p = mount();
      renderInfoBoxes(p, {
        own: [],
        foe: [rowVM({ unitId: 9, mine: false, expanded: { ...none, status } })],
      });
      expect(q(p, '.tactics-chip--status').textContent, `${status} chip`).toBe(en(key));
    }
    const stances: readonly (readonly [Stance, string])[] = [
      ['Aggressive', 'tactics.stance.aggressive'],
      ['Territorial', 'tactics.stance.territorial'],
      ['Skittish', 'tactics.stance.skittish'],
    ];
    for (const [stance, key] of stances) {
      const p = mount();
      renderInfoBoxes(p, {
        own: [],
        foe: [rowVM({ unitId: 9, mine: false, expanded: { ...none, stance } })],
      });
      expect(q(p, '.tactics-chip--stance').textContent, `${stance} chip`).toBe(en(key));
    }
  });

  it('BT10-2-HUD-DOM-SINK: a hostile name or role never becomes an element and appears as literal text', () => {
    // WRONG IMPL KILLED: a name or role written through innerHTML (the <img onerror> below
    // becomes a live element).
    const parent = mount();
    const hostile = '<img src=x onerror=alert(1)>';
    renderInfoBoxes(parent, {
      own: [rowVM({ unitId: 1, name: hostile })],
      foe: [
        rowVM({
          unitId: 2,
          mine: false,
          name: '<b>bold</b>',
          expanded: { status: null, guard: false, firstStand: false, role: hostile, stance: null },
        }),
      ],
    });
    expect(parent.querySelectorAll('img'), 'no img element').toHaveLength(0);
    expect(parent.querySelectorAll('b'), 'no b element').toHaveLength(0);
    expect(parent.querySelectorAll('[onerror]'), 'no onerror attribute').toHaveLength(0);
    expect(
      q(parent, '.tactics-info-row[data-unit-id="1"]').textContent?.includes(hostile),
      'the name shows as literal text',
    ).toBe(true);
    expect(
      q(parent, '.tactics-chip--role').textContent,
      'the role shows as literal text inside the catalog line',
    ).toBe(en('tactics.hud.role', { role: hostile }));
  });
});
