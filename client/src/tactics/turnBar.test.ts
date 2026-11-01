// @vitest-environment happy-dom
// tactics/turnBar.test.ts — bt-10 RED tests for the turn-order bar (BT10.3): the frozen order with
// the current unit highlighted and acted units dimmed, KO'd chips dropped, the next round ghosted,
// a lock on OWN READY chips only, the round counter, the "Surge in N" (PvP round 7+) and
// "Retreat at N" (wild round 25+) badges, and the bar NEVER recentring on selection.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.3, the plan's API freeze (turnBar.ts stub) and REV 2 A5
// (turnIdx indexes the RAW initiative; classify first, then drop). turnBarVM is pure; the DOM tests
// paint hand-built TurnBarVMs, so they do not depend on turnBarVM.
//
// DOM CONTRACT PINNED HERE BEYOND THE FREEZE TEXT: every chip AND ghost is a `.tactics-chip`; a
// chip's state is the class `tactics-chip--current|acted|pending` (a ghost carries `--ghost` and no
// other state); `data-unit-id`; the chip text is the species name; the lock is a
// `.tactics-chip-lock` child with aria-label = tactics.turnbar.locked. The round counter and the
// badge are text inside the bar. Chips are written into one host element that is the SAME node on
// every render.
//
// RED REASON: turnBarVM / renderTurnBar throw `bt-10: not implemented`.
// Strings are asserted through CATALOG_EN. Do NOT edit these tests to match a buggy
// implementation; correct them from the spec only.

import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import type { TacticalUnit } from './boardModel';
import {
  RETREAT_BADGE_FROM_ROUND,
  renderTurnBar,
  SURGE_BADGE_FROM_ROUND,
  type TurnBadge,
  type TurnBarInput,
  type TurnBarVM,
  type TurnChipVM,
  turnBarVM,
} from './turnBar';

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

/** 1 own Sprigg, 2 foe Mossback, 3 own Cindertail, 4 foe Flameling, 5 own KO'd Kip, 6 own Zed. */
const UNITS: readonly TacticalUnit[] = [
  unit({ unitId: 1, speciesName: 'Sprigg' }),
  unit({ unitId: 2, speciesName: 'Mossback', side: 'B', mine: false }),
  unit({ unitId: 3, speciesName: 'Cindertail' }),
  unit({ unitId: 4, speciesName: 'Flameling', side: 'B', mine: false }),
  unit({ unitId: 5, speciesName: 'Kip', state: 'Fainted', curHp: 0 }),
  unit({ unitId: 6, speciesName: 'Zed' }),
];

function input(o: Partial<TurnBarInput> = {}): TurnBarInput {
  return {
    kind: 'wild',
    round: 1,
    initiative: [],
    turnIdx: 0,
    nextInitiative: [],
    units: UNITS,
    readyUnitIds: new Set<number>(),
    surgeStartRound: 9,
    wildRoundCap: 31,
    ...o,
  };
}

const states = (vm: TurnBarVM): [number, string][] => vm.chips.map((c) => [c.unitId, c.state]);

describe('turnBarVM: the chips (BT10.3, A5)', () => {
  it("BT10-3-BAR-ORDER: turnIdx indexes the RAW initiative — acted before it, current at it, pending after — and only then KO'd, unknown and repeated ids are dropped (first occurrence wins)", () => {
    // WRONG IMPL KILLED: dropping the KO'd chip BEFORE indexing (initiative [A, KO, B, C] with
    // turnIdx 2 would make C current instead of B); an index into the filtered list; a repeated id
    // classified by its LAST occurrence (a pending chip standing among the acted); an unknown id
    // rendered or throwing; chips reordered; a chip that loses its name or side.
    const vm = turnBarVM(input({ round: 4, initiative: [1, 5, 2, 3], turnIdx: 2 }));
    expect(states(vm), "A acted, B current, C pending; the KO'd chip is gone").toEqual([
      [1, 'acted'],
      [2, 'current'],
      [3, 'pending'],
    ]);
    expect(vm.round, 'round passes through').toBe(4);
    expect(vm.chips[0], 'chip fields').toMatchObject({
      unitId: 1,
      speciesName: 'Sprigg',
      mine: true,
    });
    expect(vm.chips[1], 'a foe chip is not mine').toMatchObject({
      unitId: 2,
      speciesName: 'Mossback',
      mine: false,
    });

    const dupAfter = turnBarVM(input({ initiative: [1, 2, 1, 3], turnIdx: 2 }));
    expect(states(dupAfter), 'the repeat at turnIdx is dropped; no current chip').toEqual([
      [1, 'acted'],
      [2, 'acted'],
      [3, 'pending'],
    ]);
    const dupFirst = turnBarVM(input({ initiative: [1, 2, 1, 3], turnIdx: 0 }));
    expect(states(dupFirst), 'first occurrence wins').toEqual([
      [1, 'current'],
      [2, 'pending'],
      [3, 'pending'],
    ]);

    const unknownBefore = turnBarVM(input({ initiative: [1, 99, 2], turnIdx: 1 }));
    expect(states(unknownBefore), 'an unknown id at turnIdx is dropped, nobody is current').toEqual(
      [
        [1, 'acted'],
        [2, 'pending'],
      ],
    );
    const unknownAfter = turnBarVM(input({ initiative: [1, 99, 2], turnIdx: 2 }));
    expect(states(unknownAfter), 'the raw index still counts the unknown id').toEqual([
      [1, 'acted'],
      [2, 'current'],
    ]);
  });

  it("BT10-3-BAR-EDGES: a KO'd unit at turnIdx leaves no current chip, turnIdx below 0 is all pending, turnIdx at or past the length is all acted, and an empty order is empty without throwing", () => {
    // WRONG IMPL KILLED: promoting the next live chip to current when the KO'd one holds the
    // turn; a negative turnIdx wrapping (-1 reads as the last chip); an out-of-range turnIdx
    // leaving the last chip current; an empty initiative throwing or inventing a chip.
    const ko = turnBarVM(input({ initiative: [1, 5, 2], turnIdx: 1 }));
    expect(states(ko), "KO'd at turnIdx: no current chip").toEqual([
      [1, 'acted'],
      [2, 'pending'],
    ]);
    const below = turnBarVM(input({ initiative: [1, 2, 3], turnIdx: -1 }));
    expect(states(below), 'turnIdx -1 -> all pending').toEqual([
      [1, 'pending'],
      [2, 'pending'],
      [3, 'pending'],
    ]);
    const atLen = turnBarVM(input({ initiative: [1, 2, 3], turnIdx: 3 }));
    expect(states(atLen), 'turnIdx == length -> all acted').toEqual([
      [1, 'acted'],
      [2, 'acted'],
      [3, 'acted'],
    ]);
    const past = turnBarVM(input({ initiative: [1, 2, 3], turnIdx: 99 }));
    expect(
      past.chips.every((c) => c.state === 'acted'),
      'turnIdx past the length -> all acted',
    ).toBe(true);
    expect(
      () => turnBarVM(input({ initiative: [], turnIdx: 0 })),
      'an empty order does not throw',
    ).not.toThrow();
    const empty = turnBarVM(input({ initiative: [], turnIdx: 0 }));
    expect(empty.chips, 'an empty order has no chips').toEqual([]);
    expect(empty.ghosts, 'and no ghosts').toEqual([]);
  });

  it('BT10-3-BAR-LOCK: a lock only on an OWN, READY chip that has not yet acted — never a foe, never an acted chip, never a ghost', () => {
    // WRONG IMPL KILLED: a lock on every READY chip (a foe's readiness is never known to the
    // client, and showing one would leak it); a lock on an acted chip; the current chip left
    // unlocked; a ghost locked because its unit is ready; the lock inferred from `mine` alone.
    const order = [1, 3, 4, 6, 2];
    const ready = new Set([1, 3, 4, 6, 2]);
    const vm = turnBarVM(
      input({ initiative: order, turnIdx: 1, readyUnitIds: ready, nextInitiative: [1, 4, 6] }),
    );
    expect(
      vm.chips.map((c) => [c.unitId, c.state, c.locked]),
      'ready everywhere: only own non-acted chips lock',
    ).toEqual([
      [1, 'acted', false],
      [3, 'current', true],
      [4, 'pending', false],
      [6, 'pending', true],
      [2, 'pending', false],
    ]);
    expect(
      vm.ghosts.map((g) => g.locked),
      'ghosts never lock, even for ready own units',
    ).toEqual([false, false, false]);

    const onlyCurrent = turnBarVM(
      input({ initiative: order, turnIdx: 1, readyUnitIds: new Set([3]) }),
    );
    expect(
      onlyCurrent.chips.filter((c) => c.locked).map((c) => c.unitId),
      'only the ready unit locks',
    ).toEqual([3]);
    const none = turnBarVM(input({ initiative: order, turnIdx: 1, readyUnitIds: new Set() }));
    expect(
      none.chips.some((c) => c.locked),
      'not ready -> not locked',
    ).toBe(false);
    const acted = turnBarVM(input({ initiative: order, turnIdx: 1, readyUnitIds: new Set([1]) }));
    expect(acted.chips[0].locked, 'an acted own chip is not locked even if its id is ready').toBe(
      false,
    );
  });

  it('BT10-3-BAR-GHOSTS: the next round is ghosted from nextInitiative in order, minus non-Active and unknown units, state ghost, never locked', () => {
    // WRONG IMPL KILLED: ghosts drawn from the current order; a KO'd unit ghosted into the next
    // round; ghost state 'pending'; the order re-sorted; an unknown id throwing.
    const vm = turnBarVM(
      input({
        initiative: [1, 2],
        turnIdx: 0,
        nextInitiative: [3, 5, 2, 99, 1],
        readyUnitIds: new Set([1, 3]),
      }),
    );
    expect(
      vm.ghosts.map((g) => [g.unitId, g.state, g.locked]),
      "next order minus the KO'd and unknown ids, all ghosts",
    ).toEqual([
      [3, 'ghost', false],
      [2, 'ghost', false],
      [1, 'ghost', false],
    ]);
    expect(vm.ghosts[0], 'a ghost carries the unit name and side').toMatchObject({
      speciesName: 'Cindertail',
      mine: true,
    });
    expect(vm.ghosts[1], 'a foe ghost').toMatchObject({ speciesName: 'Mossback', mine: false });
    expect(
      vm.chips.map((c) => c.unitId),
      'the live order is untouched',
    ).toEqual([1, 2]);
    expect(
      turnBarVM(input({ initiative: [1], nextInitiative: [] })).ghosts,
      'no next order, no ghosts',
    ).toEqual([]);
  });

  it('BT10-3-BAR-BADGE: the surge badge is PvP only (in N rounds, then active from the start round), the retreat badge is wild only from round 25 and names the cap, and neither appears before its round', () => {
    // WRONG IMPL KILLED: the thresholds off by one (round 6 already showing, round 7 not); the
    // retreat cap hard-coded to 30 (the fixture's cap is 31); a wild battle showing a surge
    // badge or a PvP battle a retreat badge; surgeIn counting from the wrong end; surge-active
    // flipping one round early or late; the badge appearing on wild round 24.
    expect(SURGE_BADGE_FROM_ROUND, 'surge badge threshold').toBe(7);
    expect(RETREAT_BADGE_FROM_ROUND, 'retreat badge threshold').toBe(25);
    const badge = (kind: 'wild' | 'pvp', round: number): TurnBadge =>
      turnBarVM(input({ kind, round, surgeStartRound: 9, wildRoundCap: 31 })).badge;

    expect(badge('pvp', 1), 'pvp r1').toBeNull();
    expect(badge('pvp', 6), 'pvp r6').toBeNull();
    expect(badge('pvp', 7), 'pvp r7: surge in 2').toEqual({ kind: 'surgeIn', n: 2 });
    expect(badge('pvp', 8), 'pvp r8: surge in 1').toEqual({ kind: 'surgeIn', n: 1 });
    expect(badge('pvp', 9), 'pvp r9: surge active').toEqual({ kind: 'surgeActive' });
    expect(badge('pvp', 12), 'pvp r12: surge active').toEqual({ kind: 'surgeActive' });
    expect(badge('pvp', 25), 'pvp r25 stays surge active, never a retreat').toEqual({
      kind: 'surgeActive',
    });
    expect(badge('pvp', 40), 'pvp r40').toEqual({ kind: 'surgeActive' });

    expect(badge('wild', 1), 'wild r1').toBeNull();
    expect(badge('wild', 7), 'wild r7 never surges').toBeNull();
    expect(badge('wild', 12), 'wild r12 never surges').toBeNull();
    expect(badge('wild', 24), 'wild r24').toBeNull();
    expect(badge('wild', 25), 'wild r25: retreat at the cap (31)').toEqual({
      kind: 'retreatAt',
      round: 31,
    });
    expect(badge('wild', 30), 'wild r30').toEqual({ kind: 'retreatAt', round: 31 });
    expect(badge('wild', 31), 'wild r31').toEqual({ kind: 'retreatAt', round: 31 });

    const otherStart = turnBarVM(input({ kind: 'pvp', round: 7, surgeStartRound: 12 }));
    expect(otherStart.badge, 'surgeIn counts to the supplied start round').toEqual({
      kind: 'surgeIn',
      n: 5,
    });
    const otherCap = turnBarVM(input({ kind: 'wild', round: 26, wildRoundCap: 40 }));
    expect(otherCap.badge, 'the cap is the supplied one').toEqual({ kind: 'retreatAt', round: 40 });
  });
});

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

function chip(o: Partial<TurnChipVM> & { readonly unitId: number }): TurnChipVM {
  return { speciesName: 'Sprigg', mine: true, state: 'pending', locked: false, ...o };
}

function barVM(o: Partial<TurnBarVM> = {}): TurnBarVM {
  return { round: 3, chips: [], ghosts: [], badge: null, ...o };
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

const chipStates = ['current', 'acted', 'pending', 'ghost'] as const;

const stateOf = (el: Element): string[] =>
  chipStates.filter((s) => el.classList.contains(`tactics-chip--${s}`));

afterEach(() => {
  document.body.replaceChildren();
});

describe('renderTurnBar: the DOM (BT10.3)', () => {
  it('BT10-3-BAR-DOM: chips then ghosts in order, one state class each, the lock element only on locked chips, the round counter and the badge from the catalog', () => {
    // WRONG IMPL KILLED: ghosts before chips or styled as pending; two state classes on a chip;
    // a lock element on every chip (or an unlabelled one: the aria-label comes from the catalog);
    // the round or the badge text hard-coded; a stale badge left after the badge clears; chips
    // appended on a second render instead of replaced.
    const parent = mount();
    renderTurnBar(
      parent,
      barVM({
        round: 3,
        chips: [
          chip({ unitId: 1, speciesName: 'Sprigg', state: 'acted' }),
          chip({ unitId: 3, speciesName: 'Cindertail', state: 'current', locked: true }),
          chip({ unitId: 2, speciesName: 'Mossback', mine: false, state: 'pending' }),
        ],
        ghosts: [chip({ unitId: 3, speciesName: 'Cindertail', state: 'ghost' })],
        badge: { kind: 'surgeIn', n: 2 },
      }),
    );
    const els = [...parent.querySelectorAll<HTMLElement>('.tactics-chip')];
    expect(
      els.map((e) => e.getAttribute('data-unit-id')),
      'chips then ghosts',
    ).toEqual(['1', '3', '2', '3']);
    expect(els.map(stateOf), 'one state class per chip, the ghost class on the ghost').toEqual([
      ['acted'],
      ['current'],
      ['pending'],
      ['ghost'],
    ]);
    expect(
      els.map((e) => e.textContent),
      'each chip shows exactly its species name (the lock adds no text)',
    ).toEqual(['Sprigg', 'Cindertail', 'Mossback', 'Cindertail']);

    const locks = [...parent.querySelectorAll<HTMLElement>('.tactics-chip-lock')];
    expect(locks, 'exactly one lock').toHaveLength(1);
    expect(
      locks[0].closest('.tactics-chip')?.getAttribute('data-unit-id'),
      'on the locked chip',
    ).toBe('3');
    expect(
      locks[0].closest('.tactics-chip')?.classList.contains('tactics-chip--ghost'),
      'not on the ghost',
    ).toBe(false);
    expect(locks[0].getAttribute('aria-label'), 'lock label from the catalog').toBe(
      en('tactics.turnbar.locked'),
    );

    const text = parent.textContent ?? '';
    expect(text.includes(en('tactics.turnbar.round', { round: 3 })), 'the round counter').toBe(
      true,
    );
    expect(text.includes(en('tactics.turnbar.surgeIn', { n: 2 })), 'the surge-in badge').toBe(true);

    // Badge kinds, one render each into a fresh bar.
    const badgeText = (badge: TurnBadge): string => {
      const p = mount();
      renderTurnBar(p, barVM({ round: 9, chips: [chip({ unitId: 1 })], badge }));
      return p.textContent ?? '';
    };
    expect(
      badgeText({ kind: 'surgeActive' }).includes(en('tactics.turnbar.surgeActive')),
      'surge active',
    ).toBe(true);
    expect(
      badgeText({ kind: 'retreatAt', round: 31 }).includes(
        en('tactics.turnbar.retreatAt', { round: 31 }),
      ),
      'retreat at',
    ).toBe(true);
    const clean = badgeText(null);
    for (const gone of [
      en('tactics.turnbar.surgeActive'),
      en('tactics.turnbar.surgeIn', { n: 2 }),
      en('tactics.turnbar.retreatAt', { round: 31 }),
    ]) {
      expect(clean.includes(gone), `no badge text "${gone}" without a badge`).toBe(false);
    }

    // A second render with a different vm replaces the first.
    renderTurnBar(
      parent,
      barVM({
        round: 4,
        chips: [chip({ unitId: 6, speciesName: 'Zed', state: 'current' })],
        badge: null,
      }),
    );
    expect(parent.querySelectorAll('.tactics-chip'), 'replaced, not appended').toHaveLength(1);
    expect(parent.querySelectorAll('.tactics-chip-lock'), 'the old lock is gone').toHaveLength(0);
    expect(
      (parent.textContent ?? '').includes(en('tactics.turnbar.surgeIn', { n: 2 })),
      'the old badge is gone',
    ).toBe(false);
    expect(
      (parent.textContent ?? '').includes(en('tactics.turnbar.round', { round: 4 })),
      'the new round',
    ).toBe(true);
  });

  it('BT10-3-BAR-SINK: a hostile species name is literal text, never an element', () => {
    // WRONG IMPL KILLED: a chip label written through innerHTML.
    const parent = mount();
    const hostile = '<img src=x onerror=alert(1)>';
    renderTurnBar(
      parent,
      barVM({
        chips: [chip({ unitId: 1, speciesName: hostile, state: 'current' })],
        ghosts: [chip({ unitId: 1, speciesName: hostile, state: 'ghost' })],
      }),
    );
    expect(parent.querySelectorAll('img'), 'no img element').toHaveLength(0);
    expect(parent.querySelectorAll('[onerror]'), 'no onerror attribute').toHaveLength(0);
    expect(q(parent, '.tactics-chip').textContent?.includes(hostile), 'literal text').toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Never recentre
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

describe('renderTurnBar: never recentres (BT10.3)', () => {
  it('BT10-3-BAR-NO-RECENTRE: re-rendering with a different current chip makes no scroll, focus or scrollLeft/scrollTop call and keeps the SAME chip host node', () => {
    // WRONG IMPL KILLED: scrollIntoView on the current chip (the bar jumps under the player's
    // finger on every selection); scrollLeft/scrollTop written to centre it; focus() moved onto
    // the current chip (steals the D-pad's place); the chip host rebuilt on every render (the
    // browser resets its scroll position, which is the same recentring by another road).
    const parent = mount();
    const wide = (current: number): TurnBarVM =>
      barVM({
        chips: [1, 2, 3, 4, 6].map((id, i) =>
          chip({
            unitId: id,
            speciesName: `U${id}`,
            state: i < current ? 'acted' : i === current ? 'current' : 'pending',
          }),
        ),
      });
    renderTurnBar(parent, wide(0));
    const hostBefore = q(parent, '.tactics-chip').parentElement;
    expect(hostBefore, 'chips have a host element').not.toBeNull();

    const probe = probeRecentring();
    try {
      renderTurnBar(parent, wide(3));
      renderTurnBar(parent, wide(4));
      renderTurnBar(parent, wide(1));
      expect(probe.calls, 'no scroll / focus / scrollLeft / scrollTop activity at all').toEqual([]);
    } finally {
      probe.restore();
    }
    expect(q(parent, '.tactics-chip').parentElement, 'the chip host is the same node').toBe(
      hostBefore,
    );
    expect(parent.querySelectorAll('.tactics-chip'), 'still five chips').toHaveLength(5);
    expect(
      [...parent.querySelectorAll('.tactics-chip')].map(stateOf),
      'and the highlight did move',
    ).toEqual([['acted'], ['current'], ['pending'], ['pending'], ['pending']]);
  });
});
