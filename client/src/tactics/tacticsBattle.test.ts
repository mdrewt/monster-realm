// @vitest-environment happy-dom
// tactics/tacticsBattle.test.ts — bt-10 RED tests for the tactical battle SHELL: the frame layout
// (BT10.1), event ingest / B-skip / reduced motion / the turn banner (BT10.5), the per-unit cursor
// memory, unit cycling and D-pad reachability (BT10.6), the never-recentring turn bar at the shell
// (BT10.3) and the danger toggle (BT10.4).
//
// SOURCE OF TRUTH: spec `### bt-10`; the plan's API freeze (tacticsBattle.ts stub + DOM block) and
// REV 2 A1 (cycleUnit/toggleDanger are public methods, applyBattleOp handles only move / activate /
// back), A8 (banner), A9 (precedence and edges), A10 (ingest pushes ticker lines immediately, the
// reduceMotion boolean is read live), A13.
//
// DOM CONTRACT PINNED HERE BEYOND THE FREEZE TEXT: the banner is "shown" when `.tactics-banner`
// exists, is not `hidden`, has no inline `display:none` and has text; any of those is "hidden". The
// banner's `{unit}` is `deps.names.unit(id)` or the unit's speciesName (either is accepted). The four
// region labels (`tactics.board/dock/ticker/turnbar.label`) are an aria-label, a title or text
// inside their region. `.tactics-unit--active`, `.tactics-hp--<band>` and the chip state classes are
// pinned in boardRender.test.ts / turnBar.test.ts.
//
// NOT OBSERVABLE WITHOUT A HOOK: whether a B tap really drains the Playback queue. The shell exposes
// no `playing` signal, so the B tests pin what IS observable (no cursor/danger/ticker change, no throw,
// DOM stable across a later tick) and the report asks for a hook if a stronger proof is wanted.
//
// RED REASON: the TacticsBattle constructor throws `bt-10: not implemented`.
// Strings are asserted through CATALOG_EN. Do NOT edit these tests to match a buggy implementation;
// correct them from the spec only.

import { afterEach, describe, expect, it } from 'vitest';
import type { EventPayload } from '../module_bindings/types';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { EMPTY_OVERLAYS, type OverlaySets, type Side, type TacticalUnit } from './boardModel';
import { TacticsBattle, type TacticsBattleVM } from './tacticsBattle';
import type { TickerNames } from './ticker';

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
  unit({ side: 'B', mine: false, ai: true, ...o });

/** 1 own (1,1), 2 own (3,2), 3 wild (5,1), 4 wild (5,3), 5 own KO'd (0,4). */
const UNITS: readonly TacticalUnit[] = [
  unit({ unitId: 1, x: 1, y: 1, speciesName: 'Sprigg' }),
  unit({ unitId: 2, x: 3, y: 2, speciesName: 'Cindertail' }),
  foe({ unitId: 3, x: 5, y: 1, speciesName: 'Mossback' }),
  foe({ unitId: 4, x: 5, y: 3, speciesName: 'Flameling' }),
  unit({ unitId: 5, x: 0, y: 4, speciesName: 'Kip', state: 'Fainted', curHp: 0 }),
];

function vmOf(o: Partial<TacticsBattleVM> = {}): TacticsBattleVM {
  return {
    battleId: 1n,
    kind: 'wild',
    width: 7,
    height: 5,
    units: UNITS,
    activeUnitId: 1,
    round: 1,
    initiative: [1, 3, 2, 4],
    turnIdx: 0,
    nextInitiative: [1, 3, 2, 4],
    readyUnitIds: new Set<number>(),
    surgeStartRound: 9,
    wildRoundCap: 31,
    overlays: EMPTY_OVERLAYS,
    draftedAp: 0,
    targetUnitId: null,
    ...o,
  };
}

function overlays(o: Partial<OverlaySets>): OverlaySets {
  return { ...EMPTY_OVERLAYS, ...o };
}

function makeNames(mySide: Side = 'A'): TickerNames {
  return {
    mySide,
    unit: (id) => `unit#${id}`,
    skill: (id) => `skill#${id}`,
    item: (id) => `item#${id}`,
  };
}

interface Kit {
  readonly parent: HTMLElement;
  readonly shell: TacticsBattle;
  readonly root: HTMLElement;
  readonly clock: { t: number };
  readonly motion: { reduce: boolean };
}

/** A constructed, shown shell on a fresh parent. */
function make(reduce = false, mySide: Side = 'A'): Kit {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const clock = { t: 0 };
  const motion = { reduce };
  const shell = new TacticsBattle(parent, {
    now: () => clock.t,
    reduceMotion: () => motion.reduce,
    names: makeNames(mySide),
  });
  shell.show();
  const root = parent.querySelector<HTMLElement>('.tactics-battle');
  if (root === null) throw new Error('the shell painted no .tactics-battle root');
  return { parent, shell, root, clock, motion };
}

function q<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (found === null) throw new Error(`no element matches ${selector}`);
  return found;
}

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const tickerTexts = (root: HTMLElement): (string | null)[] =>
  [...q(root, '.tactics-ticker').children].map((c) => c.textContent);

const cursorTiles = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.tactics-tile--cursor')].map(
    (t) => `${t.getAttribute('data-x')},${t.getAttribute('data-y')}`,
  );

const expandedIds = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.tactics-info-row--expanded')].map(
    (r) => r.getAttribute('data-unit-id') ?? '',
  );

/** True when `a` comes before `b` in document order (and neither contains the other). */
function before(a: Element, b: Element): boolean {
  return (
    !a.contains(b) &&
    !b.contains(a) &&
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------------------------
// BT10.1 — layout
// ---------------------------------------------------------------------------------------------

describe('TacticsBattle: the frame (BT10.1)', () => {
  it('BT10-1-SHELL-LAYOUT: the root wears the battle frame classes plus tactics-battle with the battle-title anchor; the turn bar is on top, the field holds the one shared background and the grid, the ticker sits above a last-placed dock, and the region labels come from the catalog', () => {
    // WRONG IMPL KILLED: a root that lacks mr-frame/mr-shell/mr-shell--top/mr-shell--battle (it
    // would not sit in the battle frame's z-order); no battle-title anchor (the overlay's initial
    // focus target); the dock above the ticker or above the field; the turn bar below the board;
    // the ticker or the info boxes missing; the grid outside the field; a hard-coded region
    // label.
    const k = make();
    k.shell.render(vmOf());
    const { root } = k;
    for (const cls of [
      'mr-frame',
      'mr-shell',
      'mr-shell--top',
      'mr-shell--battle',
      'tactics-battle',
    ]) {
      expect(root.classList.contains(cls), `root has class ${cls}`).toBe(true);
    }
    expect(root.classList.contains('tactics--reduced'), 'not reduced by default').toBe(false);
    expect(k.parent.querySelectorAll('.tactics-battle'), 'one root').toHaveLength(1);
    expect(
      root.querySelectorAll('[data-testid="battle-title"]'),
      'one battle-title anchor',
    ).toHaveLength(1);

    const turnbar = q(root, '.tactics-turnbar');
    const field = q(root, '.tactics-field');
    const ticker = q(root, '.tactics-ticker');
    const dock = q(root, '.tactics-dock');
    expect(before(turnbar, field), 'turn bar above the field').toBe(true);
    expect(before(field, ticker), 'field above the ticker').toBe(true);
    expect(before(ticker, dock), 'ticker above the dock').toBe(true);
    expect(root.lastElementChild, 'the dock is the last band of the frame').toBe(dock);
    expect(field.querySelectorAll('.tactics-bg'), 'one background inside the field').toHaveLength(
      1,
    );
    expect(field.querySelectorAll('.tactics-grid'), 'the grid inside the field').toHaveLength(1);
    expect(field.querySelectorAll('.tactics-tile'), '7x5 tiles inside the field').toHaveLength(35);
    expect(root.querySelectorAll('.tactics-info--own'), 'own info box').toHaveLength(1);
    expect(root.querySelectorAll('.tactics-info--foe'), 'foe info box').toHaveLength(1);
    expect(root.querySelectorAll('.tactics-banner'), 'the turn banner element').toHaveLength(1);
    expect(
      root.querySelectorAll('.tactics-turnbar .tactics-chip').length,
      'the bar is painted',
    ).toBeGreaterThan(0);

    const labelled = (region: Element, text: string): boolean =>
      [region, ...region.querySelectorAll('*')].some(
        (e) => e.getAttribute('aria-label') === text || e.getAttribute('title') === text,
      ) || (region.textContent ?? '').includes(text);
    expect(labelled(field, en('tactics.board.label')), 'board label (tactics.board.label)').toBe(
      true,
    );
    expect(labelled(dock, en('tactics.dock.label')), 'dock label (tactics.dock.label)').toBe(true);
    expect(
      labelled(ticker, en('tactics.ticker.label')),
      'ticker label (tactics.ticker.label)',
    ).toBe(true);
    expect(
      labelled(turnbar, en('tactics.turnbar.label')),
      'turn bar label (tactics.turnbar.label)',
    ).toBe(true);
  });

  it("BT10-1-SHELL-IDEMPOTENT: rendering again repaints in place — one of every region, the same tile and unit counts — and a KO'd unit leaves the board but keeps its tile", () => {
    // WRONG IMPL KILLED: a render that appends a second frame (two backgrounds, two docks, 70
    // tiles); only Active units drawn on the first render but all on later ones; the grid
    // shrinking when a unit faints; the info boxes or turn bar duplicated.
    const k = make();
    const regions = [
      '.tactics-bg',
      '.tactics-field',
      '.tactics-grid',
      '.tactics-turnbar',
      '.tactics-ticker',
      '.tactics-dock',
      '.tactics-info--own',
      '.tactics-info--foe',
      '[data-testid="battle-title"]',
    ];
    const count = (sel: string): number => k.root.querySelectorAll(sel).length;
    k.shell.render(vmOf());
    k.shell.render(vmOf());
    k.shell.render(vmOf({ round: 2, turnIdx: 1 }));
    for (const sel of regions) expect(count(sel), `exactly one ${sel}`).toBe(1);
    expect(
      count('.tactics-banner'),
      'at most one banner (hidden on a wild turn)',
    ).toBeLessThanOrEqual(1);
    expect(count('.tactics-tile'), '35 tiles').toBe(35);
    expect(count('.tactics-unit'), "four Active units (the KO'd one is not drawn)").toBe(4);
    expect(k.parent.querySelectorAll('.tactics-battle'), 'one root').toHaveLength(1);

    const ko = UNITS.map((u) =>
      u.unitId === 3 ? { ...u, state: 'Fainted' as const, curHp: 0 } : u,
    );
    k.shell.render(vmOf({ units: ko }));
    expect(count('.tactics-unit'), 'three Active units after a KO').toBe(3);
    expect(count('.tactics-tile'), 'the grid keeps all tiles').toBe(35);
    expect(
      k.root.querySelectorAll('.tactics-tile[data-x="5"][data-y="1"]'),
      "the KO'd unit's tile is still there",
    ).toHaveLength(1);
    for (const sel of regions) expect(count(sel), `still exactly one ${sel}`).toBe(1);
  });

  it('BT10-1-SHELL-SHOWHIDE: the shell starts hidden, show() and hide() flip visible and the root display, and both are idempotent', () => {
    // WRONG IMPL KILLED: a constructor that shows itself (it would cover the world before the
    // store says a tactical row exists); hide() leaving the root displayed; visible not following
    // the calls; a second show()/hide() throwing.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const shell = new TacticsBattle(parent, {
      now: () => 0,
      reduceMotion: () => false,
      names: makeNames(),
    });
    const root = q(parent, '.tactics-battle');
    expect(shell.visible, 'hidden after construction').toBe(false);
    shell.show();
    shell.show();
    expect(shell.visible, 'visible after show').toBe(true);
    expect(root.style.display === 'none', 'the root is displayed after show').toBe(false);
    shell.hide();
    shell.hide();
    expect(shell.visible, 'hidden after hide').toBe(false);
    expect(root.style.display, 'the root is not displayed after hide').toBe('none');
    shell.show();
    expect(shell.visible, 'show works again').toBe(true);
  });

  it('BT10-1-SHELL-POINTER: clicking a tile, or the sprite of a unit standing on a tile, moves the shell cursor there and leaves exactly one cursor tile', () => {
    // WRONG IMPL KILLED: a click handler only on tiles (the unit element above it swallows the
    // click); the cursor moved by a click but not painted; two cursor tiles after a click; the
    // click coordinates transposed.
    const k = make();
    k.shell.render(vmOf());
    click(q(k.root, '.tactics-tile[data-x="4"][data-y="4"]'));
    expect(k.shell.cursor, 'tile click moves the cursor').toEqual({ x: 4, y: 4 });
    expect(cursorTiles(k.root), 'one cursor tile, painted').toEqual(['4,4']);

    click(q(k.root, '.tactics-unit[data-unit-id="3"] .tactics-sprite'));
    expect(k.shell.cursor, 'a sprite click targets its unit tile').toEqual({ x: 5, y: 1 });
    expect(cursorTiles(k.root), 'still exactly one cursor tile').toEqual(['5,1']);

    click(q(k.root, '.tactics-tile[data-x="1"][data-y="3"]'));
    expect(k.shell.cursor, 'x=1,y=3 is not x=3,y=1').toEqual({ x: 1, y: 3 });
    expect(cursorTiles(k.root)).toEqual(['1,3']);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.6 — cursor memory, cycling, reachability, hover
// ---------------------------------------------------------------------------------------------

const move = (k: Kit, dir: 'Up' | 'Down' | 'Left' | 'Right'): void => {
  k.shell.applyBattleOp({ kind: 'move', dir });
};

describe('TacticsBattle: the cursor (BT10.6)', () => {
  it("BT10-6-CURSOR-MEMORY: the first own Active unit is selected on the first render with the cursor on its tile; D-pad moves are remembered PER unit and cycling restores each unit's own tile", () => {
    // WRONG IMPL KILLED: one shared cursor for every unit (cycling keeps the old position); the
    // cursor snapping back to the unit's tile on every cycle (the memory is lost); memory keyed by
    // slot instead of unitId; the first render not selecting anybody; a move op ignored until the
    // next render; the memory lost on a re-render.
    const k = make();
    k.shell.render(vmOf());
    expect(k.shell.selectedUnitId, 'the first own Active unit is selected').toBe(1);
    expect(k.shell.cursor, 'the cursor starts on that unit').toEqual({ x: 1, y: 1 });

    move(k, 'Right');
    move(k, 'Down');
    expect(k.shell.cursor, 'unit 1 moved to (2,2)').toEqual({ x: 2, y: 2 });
    expect(cursorTiles(k.root), 'the cursor is painted without a render call').toEqual(['2,2']);

    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'cycled to unit 2').toBe(2);
    expect(k.shell.cursor, 'unit 2 has no memory: its own tile').toEqual({ x: 3, y: 2 });
    move(k, 'Right');
    expect(k.shell.cursor, 'unit 2 moved to (4,2)').toEqual({ x: 4, y: 2 });

    k.shell.cycleUnit(-1);
    expect(k.shell.selectedUnitId, 'back to unit 1').toBe(1);
    expect(k.shell.cursor, 'unit 1 remembered (2,2)').toEqual({ x: 2, y: 2 });
    k.shell.cycleUnit(1);
    expect(k.shell.cursor, 'unit 2 remembered (4,2)').toEqual({ x: 4, y: 2 });

    k.shell.render(vmOf());
    expect(k.shell.cursor, 'a re-render keeps the memory').toEqual({ x: 4, y: 2 });
    expect(k.shell.selectedUnitId, 'and the selection').toBe(2);
    expect(cursorTiles(k.root)).toEqual(['4,2']);
  });

  it("BT10-6-CYCLE-RULES: cycling visits OWN Active units in input order, wraps both ways, skips foes and the KO'd, falls back to first/last when the selection is gone, and is a harmless no-op without an own Active unit", () => {
    // WRONG IMPL KILLED: a cycle that lands on a foe, a wild unit or a Fainted unit; no wrap (the
    // last unit is a dead end); the wrong direction on -1; a lost selection resolving to the
    // neighbour of the old index instead of the first (+1) / last (-1) own Active unit; a throw
    // or a selection change when nobody is eligible; the selection drifting on a plain
    // re-render.
    const three = [
      unit({ unitId: 1, x: 1, y: 1 }),
      foe({ unitId: 3, x: 5, y: 1 }),
      unit({ unitId: 5, x: 0, y: 4, state: 'Fainted', curHp: 0 }),
      unit({ unitId: 2, x: 3, y: 2 }),
      foe({ unitId: 4, x: 5, y: 3 }),
      unit({ unitId: 6, x: 6, y: 4 }),
    ];
    const k = make();
    k.shell.render(vmOf({ units: three, initiative: [1, 3, 2, 4, 6], nextInitiative: [] }));
    expect(k.shell.selectedUnitId, 'first own Active').toBe(1);
    const walk = (dir: 1 | -1, n: number): (number | null)[] => {
      const out: (number | null)[] = [];
      for (let i = 0; i < n; i++) {
        k.shell.cycleUnit(dir);
        out.push(k.shell.selectedUnitId);
      }
      return out;
    };
    expect(walk(1, 4), "+1 visits 2, 6, wraps to 1, then 2 — never a foe or the KO'd unit").toEqual(
      [2, 6, 1, 2],
    );
    expect(walk(-1, 4), '-1 goes back 1, wraps to 6, 2, 1').toEqual([1, 6, 2, 1]);

    k.shell.cycleUnit(1);
    k.shell.render(vmOf({ units: three, initiative: [1, 3, 2, 4, 6], nextInitiative: [] }));
    expect(k.shell.selectedUnitId, 'selection is stable across a render while alive').toBe(2);
    const reordered = [three[3], three[0], ...three.slice(1, 3), ...three.slice(4)];
    k.shell.render(vmOf({ units: reordered, initiative: [2, 1], nextInitiative: [] }));
    expect(k.shell.selectedUnitId, 'and across a reordered unit list').toBe(2);

    // The selected unit is gone: +1 -> first own Active, -1 -> last own Active (A9).
    const order = [
      unit({ unitId: 6, x: 6, y: 4 }),
      unit({ unitId: 1, x: 1, y: 1 }),
      unit({ unitId: 2, x: 3, y: 2 }),
    ];
    const gone = (dir: 1 | -1): number | null => {
      const g = make();
      g.shell.render(vmOf({ units: order, initiative: [6, 1, 2], nextInitiative: [] }));
      expect(g.shell.selectedUnitId, 'fixture: the first own Active is 6').toBe(6);
      g.shell.cycleUnit(1);
      expect(g.shell.selectedUnitId, 'fixture: cycled to unit 1').toBe(1);
      const ko = order.map((u) =>
        u.unitId === 1 ? { ...u, state: 'Fainted' as const, curHp: 0 } : u,
      );
      g.shell.render(vmOf({ units: ko, initiative: [6, 1, 2], nextInitiative: [] }));
      g.shell.cycleUnit(dir);
      return g.shell.selectedUnitId;
    };
    expect(gone(1), 'selection gone, +1 -> the first own Active (not the neighbour)').toBe(6);
    expect(gone(-1), 'selection gone, -1 -> the last own Active (not the neighbour)').toBe(2);

    // Nobody to select.
    const none = make();
    const allDown = UNITS.map((u) => (u.mine ? { ...u, state: 'Fainted' as const, curHp: 0 } : u));
    none.shell.render(
      vmOf({ units: allDown, activeUnitId: null, initiative: [3, 4], nextInitiative: [] }),
    );
    expect(none.shell.selectedUnitId, 'no own Active unit: nothing selected').toBeNull();
    const cursorBefore = none.shell.cursor;
    expect(() => none.shell.cycleUnit(1), 'cycle +1 with nobody does not throw').not.toThrow();
    expect(() => none.shell.cycleUnit(-1), 'cycle -1 with nobody does not throw').not.toThrow();
    expect(none.shell.selectedUnitId, 'still nothing selected').toBeNull();
    expect(none.shell.cursor, 'the cursor did not move').toEqual(cursorBefore);
  });

  it('BT10-6-REACH-DPAD: D-pad move presses alone reach every tile of a 7x5 board (and never leave it), each step is reversible, and the unit under the cursor gets the expanded info row', () => {
    // WRONG IMPL KILLED: a cursor that clamps at the wrong width/height (a column or a row
    // unreachable by keyboard); a cursor stuck on units; a clamp that is not symmetrical; the
    // hover reachable by the mouse only (the expanded row must follow the D-pad cursor); more
    // than one expanded row; an expansion left behind on a tile with nobody.
    const k = make();
    k.shell.render(vmOf());
    const seen = new Set<string>();
    const key = (t: { x: number; y: number }): string => `${t.x},${t.y}`;
    const here = (): { x: number; y: number } => {
      const c = k.shell.cursor;
      if (c === null) throw new Error('the cursor is null');
      return c;
    };
    const DIRS = [
      ['Right', 'Left'],
      ['Left', 'Right'],
      ['Down', 'Up'],
      ['Up', 'Down'],
    ] as const;
    const walk = (): void => {
      const origin = here();
      seen.add(key(origin));
      for (const [dir, back] of DIRS) {
        move(k, dir);
        const there = here();
        if (there.x === origin.x && there.y === origin.y) continue;
        expect(
          there.x >= 0 && there.x < 7 && there.y >= 0 && there.y < 5,
          `${key(there)} is on the board`,
        ).toBe(true);
        if (!seen.has(key(there))) walk();
        move(k, back);
        expect(here(), `${dir} then ${back} returns to ${key(origin)}`).toEqual(origin);
      }
    };
    walk();
    expect(seen.size, 'all 35 tiles reached by D-pad moves alone').toBe(35);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) {
        expect(seen.has(`${x},${y}`), `tile (${x},${y}) is reachable`).toBe(true);
      }
    }

    // Hover by D-pad: start (1,1) holds unit 1.
    const h = make();
    h.shell.render(vmOf());
    expect(expandedIds(h.root), 'the unit under the starting cursor is expanded').toEqual(['1']);
    for (let i = 0; i < 4; i++) move(h, 'Right');
    expect(h.shell.cursor, 'the cursor reached the wild at (5,1)').toEqual({ x: 5, y: 1 });
    expect(expandedIds(h.root), 'a foe is expanded by cursor hover alone').toEqual(['3']);
    move(h, 'Left');
    expect(expandedIds(h.root), '(4,1) holds nobody: nothing expanded').toEqual([]);
    move(h, 'Down');
    move(h, 'Left');
    expect(h.shell.cursor).toEqual({ x: 3, y: 2 });
    expect(expandedIds(h.root), 'an own unit is expanded too').toEqual(['2']);
  });

  it('BT10-6-HOVER-TARGET: an Active targetUnitId takes precedence over the unit under the cursor; a Fainted or unknown target falls back to the cursor unit', () => {
    // WRONG IMPL KILLED: the cursor unit winning over the target (aiming at a foe must show the
    // foe's box); the target honoured even when it names a Fainted or unknown unit (an empty
    // expansion, or a throw); both units expanded.
    const k = make();
    k.shell.render(vmOf());
    for (let i = 0; i < 4; i++) move(k, 'Right');
    expect(expandedIds(k.root), 'fixture: cursor on the wild 3').toEqual(['3']);
    k.shell.render(vmOf({ targetUnitId: 4 }));
    expect(expandedIds(k.root), 'target 4 beats the cursor unit 3').toEqual(['4']);
    k.shell.render(vmOf({ targetUnitId: 2 }));
    expect(expandedIds(k.root), 'an own target works too').toEqual(['2']);
    k.shell.render(vmOf({ targetUnitId: 5 }));
    expect(expandedIds(k.root), 'a Fainted target falls back to the cursor unit').toEqual(['3']);
    expect(
      () => k.shell.render(vmOf({ targetUnitId: 999 })),
      'an unknown target does not throw',
    ).not.toThrow();
    expect(expandedIds(k.root), 'an unknown target falls back to the cursor unit').toEqual(['3']);
    k.shell.render(vmOf({ targetUnitId: null }));
    expect(expandedIds(k.root), 'no target: the cursor unit').toEqual(['3']);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.3 — never recentre, at the shell
// ---------------------------------------------------------------------------------------------

interface RecentreProbe {
  readonly calls: string[];
  restore(): void;
}

/** Records every scrollIntoView / scrollTo / scrollBy / focus call and every scrollLeft /
 *  scrollTop write on ANY element, whichever prototype (Element, HTMLElement) defines it; a name
 *  the environment lacks is defined on Element.prototype so a write there is still seen. */
function probeRecentring(): RecentreProbe {
  const calls: string[] = [];
  const undo: (() => void)[] = [];
  const protos: object[] = [Element.prototype, HTMLElement.prototype];
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy', 'focus']) {
    let seen = false;
    for (const proto of protos) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc === undefined || typeof desc.value !== 'function') continue;
      seen = true;
      const original = desc.value as (...a: unknown[]) => unknown;
      Object.defineProperty(proto, name, {
        ...desc,
        value: function (this: unknown, ...args: unknown[]) {
          calls.push(name);
          return original.apply(this, args);
        },
      });
      undo.push(() => Object.defineProperty(proto, name, desc));
    }
    if (!seen) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value: () => {
          calls.push(name);
        },
      });
      undo.push(() => Reflect.deleteProperty(Element.prototype, name));
    }
  }
  for (const name of ['scrollLeft', 'scrollTop']) {
    let seen = false;
    for (const proto of protos) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc === undefined || desc.set === undefined) continue;
      seen = true;
      const set = desc.set;
      Object.defineProperty(proto, name, {
        ...desc,
        set(this: unknown, value: unknown) {
          calls.push(`${name}=`);
          set.call(this, value);
        },
      });
      undo.push(() => Object.defineProperty(proto, name, desc));
    }
    if (!seen) {
      const store = new WeakMap<object, number>();
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        get(this: object) {
          return store.get(this) ?? 0;
        },
        set(this: object, value: number) {
          calls.push(`${name}=`);
          store.set(this, value);
        },
      });
      undo.push(() => Reflect.deleteProperty(Element.prototype, name));
    }
  }
  return {
    calls,
    restore: () => {
      for (const fn of undo.reverse()) fn();
    },
  };
}

describe('TacticsBattle: the turn bar never recentres (BT10.3)', () => {
  it('BT10-3-SHELL-NO-RECENTRE: advancing the turn, cycling the selection and moving the cursor make no scroll/focus/scrollLeft/scrollTop call, and the turn bar chip host is the same node throughout', () => {
    // WRONG IMPL KILLED: the shell scrolling the new current chip into view on a turn change, or
    // the selected unit's chip on cycleUnit (selection must NOT recentre the bar); focus() pulled
    // onto the bar or the board on a repaint (the D-pad's place is lost); the bar rebuilt on every
    // render (its scroll position resets).
    const k = make();
    k.shell.render(vmOf({ turnIdx: 0 }));
    const host = q(k.root, '.tactics-turnbar .tactics-chip').parentElement;
    expect(host, 'the turn bar has a chip host').not.toBeNull();
    const currentOf = (): string[] =>
      [...k.root.querySelectorAll('.tactics-turnbar .tactics-chip--current')].map(
        (c) => c.getAttribute('data-unit-id') ?? '',
      );
    expect(currentOf(), 'fixture: unit 1 is current').toEqual(['1']);

    const probe = probeRecentring();
    try {
      k.shell.render(vmOf({ turnIdx: 1 }));
      k.shell.cycleUnit(1);
      move(k, 'Right');
      k.shell.render(vmOf({ turnIdx: 2, round: 2 }));
      k.shell.cycleUnit(-1);
      k.shell.toggleDanger();
      k.shell.render(vmOf({ turnIdx: 3 }));
      expect(probe.calls, 'no recentring activity at all').toEqual([]);
    } finally {
      probe.restore();
    }
    expect(
      q(k.root, '.tactics-turnbar .tactics-chip').parentElement,
      'the chip host is the same node after all of that',
    ).toBe(host);
    expect(currentOf(), 'the highlight did follow the turn (unit 4 at turnIdx 3)').toEqual(['4']);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.4 — the danger toggle
// ---------------------------------------------------------------------------------------------

describe('TacticsBattle: the danger toggle (BT10.4)', () => {
  it('BT10-4-SHELL-DANGER: toggleDanger flips dangerOn and repaints the de-duplicated danger union only while on; the toggle survives a re-render; activate changes nothing', () => {
    // WRONG IMPL KILLED: a toggle that flips the flag but never repaints (or repaints only on the
    // next render); danger painted while off; one danger tile per enemy overlap; the flag reset
    // by render(); activate (A) doing something in bt-10 (the command menu is bt-11).
    const k = make();
    const sets = overlays({
      danger: [
        [
          { x: 4, y: 0 },
          { x: 5, y: 0 },
        ],
        [
          { x: 5, y: 0 },
          { x: 6, y: 0 },
        ],
      ],
    });
    k.shell.render(vmOf({ overlays: sets }));
    const dangerTiles = (): string[] =>
      [...k.root.querySelectorAll('.tactics-tile--danger')].map(
        (t) => `${t.getAttribute('data-x')},${t.getAttribute('data-y')}`,
      );
    expect(k.shell.dangerOn, 'off by default').toBe(false);
    expect(dangerTiles(), 'nothing painted while off').toEqual([]);

    k.shell.toggleDanger();
    expect(k.shell.dangerOn, 'on after one toggle').toBe(true);
    expect(dangerTiles().sort(), 'the union of both enemy sets, once each').toEqual([
      '4,0',
      '5,0',
      '6,0',
    ]);

    k.shell.render(vmOf({ overlays: sets, round: 2 }));
    expect(k.shell.dangerOn, 'a render keeps the toggle').toBe(true);
    expect(dangerTiles().sort(), 'and keeps the paint').toEqual(['4,0', '5,0', '6,0']);

    const cursorBefore = k.shell.cursor;
    k.shell.applyBattleOp({ kind: 'activate' });
    expect(k.shell.dangerOn, 'activate does not toggle danger').toBe(true);
    expect(k.shell.cursor, 'activate does not move the cursor').toEqual(cursorBefore);

    k.shell.toggleDanger();
    expect(k.shell.dangerOn, 'off after a second toggle').toBe(false);
    expect(dangerTiles(), 'cleared again').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.5 — ingest, skip, reduced motion, banner
// ---------------------------------------------------------------------------------------------

const roundEnded = (round: number): EventPayload => ({ tag: 'RoundEnded', value: { round } });

describe('TacticsBattle: events, skip and motion (BT10.5)', () => {
  it("BT10-5-SHELL-INGEST: every ingested event is a ticker line IMMEDIATELY — before any playback tick, in both motion modes — built through the names dependency and the viewer's side; the list keeps the newest 50", () => {
    // WRONG IMPL KILLED: ticker lines released beat by beat with the playback (a player on
    // reduced motion, or one who skips, would see none); lines pushed only when motion is
    // reduced; the cap not applied (60 children); ids shown raw instead of through names; the
    // viewer's side ignored (a B player would read "won" on a loss); events dropped or reordered
    // across two ingests.
    for (const reduce of [false, true]) {
      const k = make(reduce);
      k.shell.render(vmOf());
      k.shell.ingest(Array.from({ length: 60 }, (_, i) => roundEnded(i + 1)));
      const texts = tickerTexts(k.root);
      expect(texts, `reduce=${reduce}: fifty lines right after ingest`).toHaveLength(50);
      expect(texts[0], `reduce=${reduce}: the oldest kept is round 11`).toBe(
        en('tactics.ticker.roundEnded', { round: 11 }),
      );
      expect(texts[49], `reduce=${reduce}: the newest is last`).toBe(
        en('tactics.ticker.roundEnded', { round: 60 }),
      );
    }

    const k = make(false);
    k.shell.render(vmOf());
    const executed: EventPayload = {
      tag: 'Executed',
      value: {
        attacker: 1,
        skillId: 7,
        results: [
          {
            unit: 3,
            hit: true,
            damage: 12,
            effectiveness: undefined,
            flank: false,
            guard: false,
            ko: false,
          },
        ],
      },
    };
    k.shell.ingest([executed]);
    k.shell.ingest([]);
    k.shell.ingest([{ tag: 'StoodGround', value: { unit: 3 } }]);
    const EM = String.fromCharCode(0x2014);
    expect(
      tickerTexts(k.root),
      'names resolve ids; two ingests keep their order; an empty ingest adds nothing',
    ).toEqual([
      [
        en('tactics.ticker.executed', { unit: 'unit#1', skill: 'skill#7' }),
        en('tactics.ticker.hit', { target: 'unit#3', damage: 12 }),
      ].join(` ${EM} `),
      en('tactics.ticker.stoodGround', { unit: 'unit#3' }),
    ]);

    const end = (side: Side): string | null => {
      const s = make(false, side);
      s.shell.render(vmOf());
      s.shell.ingest([
        {
          tag: 'BattleEnd',
          value: { outcome: { tag: 'SideBWins' }, how: { tag: 'SideEmpty' } },
        } as unknown as EventPayload,
      ]);
      return tickerTexts(s.root)[0];
    };
    expect(end('B'), 'side B player: B wins is a win').toBe(en('tactics.ticker.won'));
    expect(end('A'), 'side A player: B wins is a loss').toBe(en('tactics.ticker.lost'));
  });

  it('BT10-5-SHELL-SKIP: B while playback runs changes nothing observable (cursor, danger, ticker) and drains it (a later tick leaves the frame untouched); B while idle is a no-op; hide() drains too and the ticker persists', () => {
    // WRONG IMPL KILLED: B moving the cursor, toggling danger or clearing the ticker (it is the
    // SKIP key, not back-out in bt-10); B throwing when nothing plays; a tick after a skip
    // replaying beats into the frame; hide() wiping the ticker log; an ingest after a hide
    // being lost.
    const events: EventPayload[] = [
      { tag: 'BattleStarted', value: { round: 1 } },
      { tag: 'Executed', value: { attacker: 1, skillId: 7, results: [] } },
      roundEnded(1),
    ];
    const k = make(false);
    k.shell.render(vmOf());
    move(k, 'Right');
    k.shell.toggleDanger();
    k.shell.ingest(events);
    const textsBefore = tickerTexts(k.root);
    const cursorBefore = k.shell.cursor;
    expect(textsBefore, 'fixture: three lines').toHaveLength(3);

    k.shell.applyBattleOp({ kind: 'back' });
    expect(tickerTexts(k.root), 'B during playback: the ticker is untouched').toEqual(textsBefore);
    expect(k.shell.cursor, 'B during playback: the cursor is untouched').toEqual(cursorBefore);
    expect(k.shell.dangerOn, 'B during playback: danger is untouched').toBe(true);
    const frozen = k.root.innerHTML;
    k.clock.t = 1_000_000;
    expect(() => k.shell.tick(), 'a tick after a skip does not throw').not.toThrow();
    expect(k.root.innerHTML, 'a tick after a skip leaves the frame as it was').toBe(frozen);

    // Idle: everything has played; B is a no-op.
    const idleSnap = {
      cursor: k.shell.cursor,
      danger: k.shell.dangerOn,
      texts: tickerTexts(k.root),
      html: k.root.innerHTML,
    };
    expect(
      () => k.shell.applyBattleOp({ kind: 'back' }),
      'B while idle does not throw',
    ).not.toThrow();
    expect(k.shell.cursor, 'idle B: cursor').toEqual(idleSnap.cursor);
    expect(k.shell.dangerOn, 'idle B: danger').toBe(idleSnap.danger);
    expect(tickerTexts(k.root), 'idle B: ticker').toEqual(idleSnap.texts);
    expect(k.root.innerHTML, 'idle B: the frame').toBe(idleSnap.html);

    const fresh = make(false);
    fresh.shell.render(vmOf());
    const freshHtml = fresh.root.innerHTML;
    const freshCursor = fresh.shell.cursor;
    fresh.shell.applyBattleOp({ kind: 'back' });
    expect(fresh.shell.cursor, 'B on a fresh shell: cursor').toEqual(freshCursor);
    expect(fresh.shell.dangerOn, 'B on a fresh shell: danger').toBe(false);
    expect(fresh.root.innerHTML, 'B on a fresh shell: the frame').toBe(freshHtml);
    expect(() => fresh.shell.tick(), 'tick with nothing queued').not.toThrow();

    // hide() drains the queue and keeps the log.
    const h = make(false);
    h.shell.render(vmOf());
    h.shell.ingest(events);
    h.shell.hide();
    expect(h.shell.visible, 'hidden').toBe(false);
    expect(tickerTexts(h.root), 'the ticker persists through hide()').toHaveLength(3);
    h.clock.t = 1_000_000;
    expect(() => h.shell.tick(), 'tick after hide does not throw').not.toThrow();
    h.shell.show();
    expect(tickerTexts(h.root), 'and through show()').toHaveLength(3);
    h.shell.ingest([roundEnded(2)]);
    expect(tickerTexts(h.root), 'a later ingest appends').toHaveLength(4);
  });

  it('BT10-5-SHELL-REDUCED: the root wears tactics--reduced exactly when reduceMotion() is true at render time (read live, never cached), and ingest still fills the ticker in both states', () => {
    // WRONG IMPL KILLED: the flag read once in the constructor (a player who turns reduced motion
    // on mid-battle keeps the slides); the class left on after the preference is cleared; the
    // class on a shell whose reduceMotion() is false; ingest skipping the ticker when reduced.
    const k = make(false);
    k.shell.render(vmOf());
    expect(k.root.classList.contains('tactics--reduced'), 'off while the preference is off').toBe(
      false,
    );
    k.motion.reduce = true;
    k.shell.render(vmOf());
    expect(
      k.root.classList.contains('tactics--reduced'),
      'on after the preference flips and a render',
    ).toBe(true);
    k.shell.ingest([roundEnded(1)]);
    expect(tickerTexts(k.root), 'reduced ingest: the ticker line is there at once').toEqual([
      en('tactics.ticker.roundEnded', { round: 1 }),
    ]);
    k.motion.reduce = false;
    k.shell.render(vmOf());
    expect(
      k.root.classList.contains('tactics--reduced'),
      'off again after the preference clears',
    ).toBe(false);
    k.shell.ingest([roundEnded(2)]);
    expect(tickerTexts(k.root), 'non-reduced ingest: the next line too').toEqual([
      en('tactics.ticker.roundEnded', { round: 1 }),
      en('tactics.ticker.roundEnded', { round: 2 }),
    ]);

    const born = make(true);
    born.shell.render(vmOf());
    expect(
      born.root.classList.contains('tactics--reduced'),
      'a shell built under reduced motion',
    ).toBe(true);
  });

  it("BT10-5-SHELL-BANNER: the turn banner is shown (with the catalog text) for the current unit only when it is not READY and not AI — an own live turn or a human opponent's — and hidden for a READY unit, a wild AI unit, a KO'd unit or no current unit", () => {
    // WRONG IMPL KILLED: a banner on a READY turn or on a wild turn (the spec forbids both); a
    // banner reserved for own units (the human opponent's turn also gets one); the banner never
    // shown; a stale banner left after the turn moves on; the text hard-coded instead of
    // tactics.banner.turn; a banner for a turn index that names nobody.
    const bannerShown = (root: HTMLElement): boolean => {
      const el = root.querySelector<HTMLElement>('.tactics-banner');
      return (
        el !== null &&
        !el.hidden &&
        !el.hasAttribute('hidden') &&
        el.style.display !== 'none' &&
        (el.textContent ?? '') !== ''
      );
    };
    const bannerText = (root: HTMLElement): string => q(root, '.tactics-banner').textContent ?? '';
    const acceptable = (id: number, speciesName: string): string[] => [
      en('tactics.banner.turn', { unit: `unit#${id}` }),
      en('tactics.banner.turn', { unit: speciesName }),
    ];

    const k = make();
    k.shell.render(vmOf({ turnIdx: 0, activeUnitId: 1 }));
    expect(bannerShown(k.root), 'own, not READY: shown').toBe(true);
    expect(acceptable(1, 'Sprigg'), `banner text "${bannerText(k.root)}"`).toContain(
      bannerText(k.root),
    );

    k.shell.render(vmOf({ turnIdx: 0, readyUnitIds: new Set([1]) }));
    expect(bannerShown(k.root), 'own, READY: hidden').toBe(false);

    k.shell.render(vmOf({ turnIdx: 1, activeUnitId: 3 }));
    expect(bannerShown(k.root), 'wild AI unit (unit 3): hidden').toBe(false);

    k.shell.render(vmOf({ turnIdx: 2, activeUnitId: 2 }));
    expect(bannerShown(k.root), 'the next own unit, not READY: shown again (no stale hide)').toBe(
      true,
    );
    expect(acceptable(2, 'Cindertail'), `banner text "${bannerText(k.root)}"`).toContain(
      bannerText(k.root),
    );

    const humanFoe = UNITS.map((u) => (u.unitId === 3 ? { ...u, ai: false } : u));
    k.shell.render(vmOf({ units: humanFoe, turnIdx: 1, activeUnitId: 3 }));
    expect(bannerShown(k.root), 'a human opponent, not READY: shown').toBe(true);
    k.shell.render(
      vmOf({ units: humanFoe, turnIdx: 1, activeUnitId: 3, readyUnitIds: new Set([3]) }),
    );
    expect(bannerShown(k.root), 'a human opponent, READY: hidden').toBe(false);

    k.shell.render(vmOf({ turnIdx: -1 }));
    expect(bannerShown(k.root), 'no current unit (turnIdx -1): hidden').toBe(false);
    k.shell.render(vmOf({ turnIdx: 9 }));
    expect(bannerShown(k.root), 'turnIdx past the order: hidden').toBe(false);
    k.shell.render(vmOf({ initiative: [5, 1, 2], turnIdx: 0 }));
    expect(bannerShown(k.root), "the current unit is KO'd: hidden").toBe(false);
  });
});
