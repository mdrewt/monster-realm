// @vitest-environment happy-dom
// tactics/clock.test.ts — bt-15 increment B RED tests for the PvP turn clock (BT15.2): the pure
// `clockVM` (the radial ring of the waiting unit and each player's strike pips, read off the
// `battle_clock` rows and the WALL clock) and its DOM writer `renderClock`.
//
// SOURCE OF TRUTH: spec `M-battle-tactics.spec.md` §bt-15 BT15.2 ("WHILE a PvP battle waits on a
// unit, A radial clock ring on that unit's portrait SHALL be visible to both players, refill on
// every accepted submit, turn amber at 10 s and red at 5 s, and strike pips (0–4) SHALL sit by each
// player's name"); plan memory/projects/monster-realm-bt-15-plan.md REV 3 §1 BT15.2 as amended by
// §8 REV 3.1 (fraction rounded to 2 decimals, `data-fraction` 0..100); the tester brief's API freeze
// (client/src/tactics/clock.ts); ts-6b-4.3 (the pip count is the input's `strikesMax` — the loaded
// tuning's `autopass_forfeit` — carried on every StrikesVM; no client constant).
//
// DOM CONTRACT PINNED HERE (the freeze): the ring is the ONE child
// `span.tactics-clock-ring[role=img][data-band][data-fraction=<round(fraction*100)>]` of the one
// `.tactics-chip:not(.tactics-chip--ghost)[data-unit-id=<ring.unitId>]` inside the turn bar, with
// `style --clock-fraction = String(fraction)`, aria-label `tactics.clock.ring {s}` and NO text;
// every other ring under the bar is removed. The players element is `role=group` labelled
// `tactics.players.label`, holding one `span.tactics-player[data-side][data-mine]` per player, each
// `span.tactics-player-name` + `span.tactics-strikes[role=img]` (aria-label `tactics.clock.strikes
// {name, n, max}`) with exactly `strikesMax` `span.tactics-strike`, the first n `--hit`; null or no
// players empties it and sets `hidden`. An unchanged players VM leaves the same child nodes.
//
// FIXTURES (no monoculture): the local player is side B; A's player is "Marrow", B's "Quill"; A-
// waiting and B-waiting units (11 / 13 on A, 17 / 19 on B), an open and a closed window, two window
// lengths (30 s, 20 s), strikes 0 / 1 / 3 / 4 / 9 (clamped); the turn bar holds the chips 11, 17,
// 13, 19 then GHOSTS of the same ids (and a ghost-only 31), so a ring painted on a ghost or on the
// first chip shows.
//
// RED REASON: client/src/tactics/clock.ts does not exist (the import fails to resolve), and the
// three catalog keys `tactics.players.label` / `tactics.clock.ring` / `tactics.clock.strikes` are
// absent from both catalogs.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { afterEach, describe, expect, it } from 'vitest';
import type { StoreBattleClock } from '../net/store';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';
import { setLocale } from '../ui/i18n/resolver';
import {
  CLOCK_AMBER_MS,
  CLOCK_RED_MS,
  type ClockInput,
  type ClockVM,
  clockVM,
  renderClock,
} from './clock';
import type { RuleSide } from './wasm';

type Catalog = Record<string, unknown>;
const EN = CATALOG_EN as unknown as Catalog;
const FR = CATALOG_FR as unknown as Catalog;

/** A catalog value (a closure called with `params`); a missing key fails loudly by name. */
function cat(catalog: Catalog, key: string, params: Record<string, unknown> = {}): string {
  const value = catalog[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

/** The local player (side B) and the rival (side A), hex identities. */
const ME = 'ab'.repeat(32);
const RIVAL = 'cd'.repeat(32);
const NAMES: ReadonlyMap<string, string> = new Map([
  [ME, 'Quill'],
  [RIVAL, 'Marrow'],
]);
const playerName = (identity: string): string => NAMES.get(identity) ?? `?${identity.slice(0, 4)}`;

/** A wall-clock epoch instant (ms); every deadline below is relative to it. */
const W = 1_750_000_000_000;

/** Units 11 and 13 on side A, 17 and 19 on side B, 31 (ghost-only in the bar) on side B; listed out
 *  of side order on purpose. */
const UNITS: readonly { readonly unitId: number; readonly side: RuleSide }[] = [
  { unitId: 17, side: 'B' },
  { unitId: 11, side: 'A' },
  { unitId: 19, side: 'B' },
  { unitId: 13, side: 'A' },
  { unitId: 31, side: 'B' },
];

type ClockRow = Pick<
  StoreBattleClock,
  'side' | 'player' | 'windowOpenMs' | 'deadlineMs' | 'autopassCount'
>;

/** One `battle_clock` row: `open` / `deadline` are wall-clock offsets from W (null: none). */
function row(
  side: RuleSide,
  player: string,
  open: number | null,
  deadline: number | null,
  autopassCount: number,
): ClockRow {
  return {
    side,
    player,
    windowOpenMs: open === null ? null : BigInt(W + open),
    deadlineMs: deadline === null ? null : BigInt(W + deadline),
    autopassCount,
  };
}

/** A PvP input: B's 30 s window open [W, W + 30 s] and A's closed, unit 19 (side B) waiting, the
 *  wall clock at `now` ms after W, four strike pips (the shipped `autopass_forfeit`) unless
 *  `strikesMax` says otherwise. Rows listed B first (the output is sorted A then B). */
function input(o: Partial<ClockInput> & { readonly now?: number } = {}): ClockInput {
  const { now, ...rest } = o;
  return {
    kind: 'pvp',
    clocks: [row('B', ME, 0, 30_000, 3), row('A', RIVAL, null, null, 1)],
    activeUnitId: 19,
    units: UNITS,
    mySide: 'B',
    playerName,
    nowMs: W + (now ?? 1_000),
    strikesMax: 4,
    ...rest,
  };
}

const must = (vm: ClockVM | null, label: string): ClockVM => {
  if (vm === null) throw new Error(`${label}: clockVM returned null for a PvP battle`);
  return vm;
};

/** A turn bar: the chips 11, 17, 13, 19 (pending / current / acted), then the ghosts 19, 13, 11,
 *  17 and 31. */
function turnBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'tactics-turnbar';
  const chips = document.createElement('div');
  chips.className = 'tactics-turnbar-chips';
  const states = ['acted', 'current', 'pending', 'pending'];
  for (const [i, id] of [11, 17, 13, 19].entries()) {
    const chip = document.createElement('span');
    chip.className = `tactics-chip tactics-chip--${states[i] ?? 'pending'}`;
    chip.setAttribute('data-unit-id', String(id));
    chip.textContent = `unit ${id}`;
    chips.appendChild(chip);
  }
  for (const id of [19, 13, 11, 17, 31]) {
    const ghost = document.createElement('span');
    ghost.className = 'tactics-chip tactics-chip--ghost';
    ghost.setAttribute('data-unit-id', String(id));
    ghost.textContent = `unit ${id}`;
    chips.appendChild(ghost);
  }
  bar.appendChild(chips);
  document.body.appendChild(bar);
  return bar;
}

function strip(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tactics-players';
  document.body.appendChild(el);
  return el;
}

const rings = (bar: ParentNode): HTMLElement[] => [
  ...bar.querySelectorAll<HTMLElement>('.tactics-clock-ring'),
];
/** Where each ring under `bar` sits: its chip's unit id, `ghost:<id>` on a ghost, `loose` elsewhere. */
const ringHomes = (bar: ParentNode): string[] =>
  rings(bar).map((r) => {
    const chip = r.parentElement;
    if (chip === null || !chip.classList.contains('tactics-chip')) return 'loose';
    const id = chip.getAttribute('data-unit-id') ?? '?';
    return chip.classList.contains('tactics-chip--ghost') ? `ghost:${id}` : id;
  });

afterEach(() => {
  document.body.replaceChildren();
  setLocale('en');
});

describe('clock: the view model (bt-15 B, BT15.2)', () => {
  it('a wild battle has no clock view at all, whatever its clock rows say, and the display thresholds are 10 s and 5 s with four pips [BT15-2]', () => {
    // WRONG IMPL KILLED: a ring or a strike strip painted over a PvE battle (PvE shows only the
    // "Still there?" countdown: plan §1); thresholds or a pip count read off anything else.
    expect(clockVM(input({ kind: 'wild' })), 'wild: null').toBeNull();
    expect(
      clockVM(input({ kind: 'wild', activeUnitId: null, clocks: [] })),
      'wild, empty',
    ).toBeNull();
    expect([CLOCK_AMBER_MS, CLOCK_RED_MS], 'the frozen display constants').toEqual([10_000, 5_000]);
    expect(
      must(clockVM(input()), 'pvp').players.map((p) => p.strikesMax),
      'four pips per player, given strikesMax: 4',
    ).toEqual([4, 4]);
  });

  it('the ring is the waiting unit`s and reads its SIDE`s open window: whole seconds rounded up, the share of the window left to 2 decimals, ok above 10 s, amber from 10 s, red from 5 s, and 0 s / 0 / red once the deadline has passed [BT15-2]', () => {
    // WRONG IMPL KILLED: the ring keyed by the unit's own row instead of its side's (one clock row
    // per SIDE); `<` instead of `<=` at either threshold (10 000 / 5 000 ms are the boundaries,
    // 10 001 / 5 001 the controls); seconds floored (4 200 ms reads 4, the ring would say 4 s while
    // 4.2 s remain) or a 0..1 fraction of a fixed 30 s instead of the row's own window length (the
    // 20 s window below); an expired window read as a negative fraction or a negative second; a
    // fraction left unrounded (every frame a new number: plan REV 3.1 M).
    const cases: ReadonlyArray<readonly [number, number, number, 'ok' | 'amber' | 'red']> = [
      // [remaining ms, secondsLeft, fraction, band] of B's 30 s window.
      [29_000, 29, 0.97, 'ok'],
      [10_001, 11, 0.33, 'ok'],
      [10_000, 10, 0.33, 'amber'],
      [5_001, 6, 0.17, 'amber'],
      [5_000, 5, 0.17, 'red'],
      [4_200, 5, 0.14, 'red'],
      [0, 0, 0, 'red'],
      [-2_000, 0, 0, 'red'],
    ];
    for (const [remaining, secondsLeft, fraction, band] of cases) {
      const vm = must(clockVM(input({ now: 30_000 - remaining })), `${remaining} ms`);
      expect(vm.ring, `${remaining} ms left in B's window: unit 19's ring`).toEqual({
        unitId: 19,
        side: 'B',
        secondsLeft,
        fraction,
        band,
      });
    }

    // A-waiting, a 20 s window opened at W: 5 s in, 15 s and three quarters are left.
    const a = must(
      clockVM(
        input({
          clocks: [row('A', RIVAL, 0, 20_000, 1), row('B', ME, null, null, 3)],
          activeUnitId: 13,
          now: 5_000,
        }),
      ),
      'A waiting',
    );
    expect(a.ring, 'unit 13 waits on side A`s own 20 s window').toEqual({
      unitId: 13,
      side: 'A',
      secondsLeft: 15,
      fraction: 0.75,
      band: 'ok',
    });
  });

  it('the ring refills when the server opens a new window after an accepted submit: a later open and deadline put the fraction back to 1 [BT15-2]', () => {
    // WRONG IMPL KILLED: a client-side refill rule (a timer the client restarts, a fraction latched
    // at its lowest); the fraction measured from the FIRST window's open (it would stay at 0.4).
    const before = must(clockVM(input({ now: 18_000 })), 'before the submit');
    expect(before.ring, 'fixture: 12 s of 30 left').toEqual({
      unitId: 19,
      side: 'B',
      secondsLeft: 12,
      fraction: 0.4,
      band: 'ok',
    });
    const refilled = [row('B', ME, 18_000, 48_000, 3), row('A', RIVAL, null, null, 1)];
    const after = must(clockVM(input({ clocks: refilled, now: 18_000 })), 'after the submit');
    expect(after.ring, 'the new window is full').toEqual({
      unitId: 19,
      side: 'B',
      secondsLeft: 30,
      fraction: 1,
      band: 'ok',
    });
    const later = must(clockVM(input({ clocks: refilled, now: 18_500 })), 'half a second on');
    expect([later.ring?.secondsLeft, later.ring?.fraction], 'and runs down again').toEqual([
      30, 0.98,
    ]);
  });

  it('there is no ring when the waiting side`s window is closed (no open or no deadline), when only the OTHER side`s window is open, when no unit waits or when the waiting unit`s side has no clock row — and the players are still listed [BT15-2]', () => {
    // WRONG IMPL KILLED: the ring drawn from whichever row has a deadline (B's closed window below
    // still carries one), or from the only open row (A's) onto B's waiting unit; a ring for a null
    // active unit (initiative[0] or the first unit); a throw when the side has no row; the strip
    // dropped together with the ring (strikes are shown whenever the battle is PvP).
    const cases: ReadonlyArray<readonly [string, Partial<ClockInput>, number]> = [
      [
        'B waits, B`s window closed though a deadline stands, A`s open',
        {
          clocks: [row('B', ME, null, 30_000, 3), row('A', RIVAL, 0, 30_000, 1)],
        },
        2,
      ],
      [
        'B waits, B`s window open but no deadline',
        { clocks: [row('B', ME, 0, null, 3), row('A', RIVAL, null, null, 1)] },
        2,
      ],
      ['no unit waits', { activeUnitId: null }, 2],
      ['B waits but only side A has a clock row', { clocks: [row('A', RIVAL, 0, 30_000, 1)] }, 1],
      ['the waiting unit is unknown', { activeUnitId: 97 }, 2],
    ];
    for (const [label, o, players] of cases) {
      const vm = must(clockVM(input(o)), label);
      expect(vm.ring, `${label}: no ring`).toBeNull();
      expect(vm.players.length, `${label}: the players are still listed`).toBe(players);
    }
  });

  it('the strike pips are one entry per clock row in side order A then B, mine on the local player`s side (B here), named by playerName of THAT row`s player, the strikes the row`s autopassCount clamped to 0..4; in Practice both rows name the same player and only my side is mine [BT15-2]', () => {
    // WRONG IMPL KILLED: entries in row order (B arrives first); `mine` hard-coded to side A or read
    // from the active unit; the names swapped, read from the active player, or both the local
    // player's; strikes unclamped (9 pips), or clamped to 3; a strike count read off the other row.
    const vm = must(clockVM(input()), 'A 1, B 3');
    expect(vm.players, 'A (Marrow, 1 strike) then B (Quill, mine, 3 strikes)').toEqual([
      { side: 'A', mine: false, name: 'Marrow', strikes: 1, strikesMax: 4 },
      { side: 'B', mine: true, name: 'Quill', strikes: 3, strikesMax: 4 },
    ]);
    const clamped = must(
      clockVM(input({ clocks: [row('B', ME, 0, 30_000, 0), row('A', RIVAL, null, null, 9)] })),
      'A 9, B 0',
    );
    expect(
      clamped.players.map((p) => [p.side, p.strikes]),
      '9 strikes clamp to 4, 0 stays 0',
    ).toEqual([
      ['A', 4],
      ['B', 0],
    ]);
    const four = must(
      clockVM(input({ clocks: [row('A', RIVAL, null, null, 4), row('B', ME, 0, 30_000, 2)] })),
      'A 4, B 2',
    );
    expect(
      four.players.map((p) => p.strikes),
      'exactly 4 is 4',
    ).toEqual([4, 2]);

    const asked: string[] = [];
    const practice = must(
      clockVM(
        input({
          clocks: [row('B', ME, 0, 30_000, 2), row('A', ME, null, null, 0)],
          mySide: 'A',
          playerName: (id) => {
            asked.push(id);
            return playerName(id);
          },
        }),
      ),
      'Practice',
    );
    expect(practice.players, 'Practice: the same name twice, mine on side A only').toEqual([
      { side: 'A', mine: true, name: 'Quill', strikes: 0, strikesMax: 4 },
      { side: 'B', mine: false, name: 'Quill', strikes: 2, strikesMax: 4 },
    ]);
    expect(
      asked.every((id) => id === ME),
      'every name asked by a row`s own player',
    ).toBe(true);
  });
});

describe('clock: the DOM (bt-15 B, BT15.2)', () => {
  it('renderClock puts exactly one ring on the waiting unit`s own chip — never its ghost, never the first chip — an image with its band, the fraction as a 0..100 integer and as --clock-fraction, named "N s left" from the catalog in English then French, with no text; a second call adds none, a moved ring leaves none behind, and a null view or ring removes it [BT15-2]', () => {
    // WRONG IMPL KILLED: the ring appended on every frame (two rings after two calls); painted on
    // the first chip or on the ghost of the same unit (the ghost comes later in the bar); left on
    // the previous chip when the turn moves; a ring with a text node or a hard-coded English
    // aria-label; the fraction written only as a style (the tested attribute is data-fraction) or
    // as a 0..1 string there; a ring on a ghost-only unit; a null view that leaves it up.
    const bar = turnBar();
    const players = strip();
    const amber = must(clockVM(input({ now: 20_000 })), '10 s left');
    expect(amber.ring?.band, 'fixture: amber at 10 s').toBe('amber');
    renderClock(bar, players, amber);
    expect(ringHomes(bar), 'one ring, on unit 19`s chip (not its ghost)').toEqual(['19']);
    const ring = rings(bar)[0] as HTMLElement;
    expect(ring.tagName, 'a span').toBe('SPAN');
    expect(ring.getAttribute('role'), 'an image').toBe('img');
    expect(ring.getAttribute('data-band'), 'amber').toBe('amber');
    expect(ring.getAttribute('data-fraction'), '0.33 as 33').toBe('33');
    expect(ring.style.getPropertyValue('--clock-fraction'), 'the painted property').toBe('0.33');
    expect(ring.getAttribute('aria-label'), 'tactics.clock.ring {s: 10}').toBe(
      cat(EN, 'tactics.clock.ring', { s: 10 }),
    );
    expect(ring.textContent, 'no text').toBe('');
    expect(
      ring.parentElement?.textContent,
      'the chip`s own label is untouched (the ring adds no text)',
    ).toBe('unit 19');

    renderClock(bar, players, amber);
    expect(ringHomes(bar), 'a second call: still one ring').toEqual(['19']);

    setLocale('fr');
    const red = must(clockVM(input({ now: 25_800 })), '4.2 s left');
    renderClock(bar, players, red);
    const frRing = rings(bar)[0] as HTMLElement;
    expect(ringHomes(bar), 'fr: one ring').toEqual(['19']);
    expect(frRing.getAttribute('aria-label'), 'fr: the French catalog line for 5 s').toBe(
      cat(FR, 'tactics.clock.ring', { s: 5 }),
    );
    expect(cat(FR, 'tactics.clock.ring', { s: 5 }), 'fixture: French differs').not.toBe(
      cat(EN, 'tactics.clock.ring', { s: 5 }),
    );
    expect(
      [frRing.getAttribute('data-band'), frRing.getAttribute('data-fraction')],
      'red, 14',
    ).toEqual(['red', '14']);
    setLocale('en');

    const moved = must(
      clockVM(
        input({
          clocks: [row('A', RIVAL, 0, 20_000, 1), row('B', ME, null, null, 3)],
          activeUnitId: 13,
          now: 0,
        }),
      ),
      'A waits',
    );
    renderClock(bar, players, moved);
    expect(ringHomes(bar), 'the ring moved to unit 13, none left on 19').toEqual(['13']);
    expect((rings(bar)[0] as HTMLElement).getAttribute('data-fraction'), 'a full window').toBe(
      '100',
    );
    expect((rings(bar)[0] as HTMLElement).style.getPropertyValue('--clock-fraction')).toBe('1');

    const expired = must(clockVM(input({ now: 32_000 })), 'expired');
    renderClock(bar, players, expired);
    expect(
      [ringHomes(bar), rings(bar)[0]?.getAttribute('data-fraction')],
      'expired: unit 19, 0',
    ).toEqual([['19'], '0']);

    const ghostOnly = must(
      clockVM(
        input({
          clocks: [row('B', ME, 0, 30_000, 3), row('A', RIVAL, null, null, 1)],
          activeUnitId: 31,
        }),
      ),
      'ghost-only unit',
    );
    expect(ghostOnly.ring?.unitId, 'fixture: a ring for unit 31').toBe(31);
    renderClock(bar, players, ghostOnly);
    expect(ringHomes(bar), 'unit 31 has only a ghost chip: no ring anywhere').toEqual([]);

    renderClock(bar, players, amber);
    expect(ringHomes(bar), 'fixture: back on 19').toEqual(['19']);
    renderClock(bar, players, { ...amber, ring: null });
    expect(ringHomes(bar), 'a null ring removes it').toEqual([]);
    renderClock(bar, players, amber);
    renderClock(bar, players, null);
    expect(ringHomes(bar), 'a null view removes it').toEqual([]);
  });

  it('renderClock fills the players strip: a group labelled from the catalog, one entry per player in side order with its name and four strike pips, the first n hit, each pip set named "<name>: n of 4 strikes" in English and in French; null or no players empties and hides it; an unchanged players view keeps the very same nodes [BT15-2]', () => {
    // WRONG IMPL KILLED: pips counted per strike (1 and 3 elements instead of 4 each); the hit pips
    // at the end or all hit; data-side / data-mine swapped or missing; a strikes label with the
    // literal English or the wrong name; a strip rebuilt on every frame (the pump runs per frame:
    // the nodes must survive an equal view); null leaving the stale players up or visible.
    const bar = turnBar();
    const players = strip();
    const vm = must(clockVM(input()), 'A 1, B 3');
    renderClock(bar, players, vm);
    expect(players.getAttribute('role'), 'a group').toBe('group');
    expect(players.getAttribute('aria-label'), 'tactics.players.label').toBe(
      cat(EN, 'tactics.players.label'),
    );
    expect(players.hidden, 'shown').toBe(false);
    const entries = [...players.children] as HTMLElement[];
    expect(
      entries.map((e) => [
        e.matches('span.tactics-player'),
        e.getAttribute('data-side'),
        e.getAttribute('data-mine'),
      ]),
      'two players, A then B, mine on B',
    ).toEqual([
      [true, 'A', 'false'],
      [true, 'B', 'true'],
    ]);
    const WANT: ReadonlyArray<readonly [string, string, number]> = [
      ['A', 'Marrow', 1],
      ['B', 'Quill', 3],
    ];
    for (const [side, name, n] of WANT) {
      const entry = players.querySelector(`.tactics-player[data-side="${side}"]`) as HTMLElement;
      expect(entry.querySelector('.tactics-player-name')?.textContent, `${side}: the name`).toBe(
        name,
      );
      const pips = entry.querySelector('.tactics-strikes') as HTMLElement;
      expect(pips.getAttribute('role'), `${side}: the pips are an image`).toBe('img');
      expect(pips.getAttribute('aria-label'), `${side}: tactics.clock.strikes`).toBe(
        cat(EN, 'tactics.clock.strikes', { name, n, max: 4 }),
      );
      const each = [...pips.querySelectorAll('.tactics-strike')];
      expect(each.length, `${side}: four pips (strikesMax: 4)`).toBe(4);
      expect(
        each.map((p) => p.classList.contains('tactics-strike--hit')),
        `${side}: the first ${n} hit`,
      ).toEqual([0, 1, 2, 3].map((i) => i < n));
    }

    const first = players.children[0];
    const second = players.children[1];
    const later = must(clockVM(input({ now: 7_000 })), 'the next frame');
    expect(later.players, 'fixture: the same players, another ring').toEqual(vm.players);
    renderClock(bar, players, later);
    expect(
      [players.children[0] === first, players.children[1] === second],
      'an unchanged players view keeps the same nodes',
    ).toEqual([true, true]);
    expect(rings(bar)[0]?.getAttribute('data-fraction'), 'while the ring follows the clock').toBe(
      '77',
    );

    const struck = must(
      clockVM(input({ clocks: [row('B', ME, 0, 30_000, 4), row('A', RIVAL, null, null, 0)] })),
      'A 0, B 4',
    );
    renderClock(bar, players, struck);
    expect(
      [...players.querySelectorAll('.tactics-player')].map(
        (e) => e.querySelectorAll('.tactics-strike--hit').length,
      ),
      'a changed view repaints: A 0, B 4',
    ).toEqual([0, 4]);

    renderClock(bar, players, null);
    expect([players.children.length, players.hidden], 'null: emptied and hidden').toEqual([
      0,
      true,
    ]);
    renderClock(bar, players, vm);
    expect([players.children.length, players.hidden], 'back: two players, shown').toEqual([
      2,
      false,
    ]);
    renderClock(bar, players, must(clockVM(input({ clocks: [] })), 'no rows'));
    expect([players.children.length, players.hidden], 'no players: emptied and hidden').toEqual([
      0,
      true,
    ]);

    setLocale('fr');
    const frStrip = strip();
    renderClock(turnBar(), frStrip, vm);
    expect(frStrip.getAttribute('aria-label'), 'fr: tactics.players.label').toBe(
      cat(FR, 'tactics.players.label'),
    );
    expect(
      frStrip
        .querySelector('.tactics-player[data-side="B"] .tactics-strikes')
        ?.getAttribute('aria-label'),
      'fr: the French strikes line for Quill',
    ).toBe(cat(FR, 'tactics.clock.strikes', { name: 'Quill', n: 3, max: 4 }));
    expect(
      cat(FR, 'tactics.clock.strikes', { name: 'Quill', n: 3, max: 4 }),
      'fixture: French differs',
    ).not.toBe(cat(EN, 'tactics.clock.strikes', { name: 'Quill', n: 3, max: 4 }));
  });

  it('the strike pips number the input`s strikesMax: seven pips per player at strikesMax 7 (9 auto-passes clamp to seven hit, 5 hit five), three at strikesMax 3, a hand-built view painted at its own max, and a repaint of the same players at another max shows the new count [ts-6b-4.3]', () => {
    // WRONG IMPL KILLED: a painter or clamp that keeps a literal 4 (STRIKES_MAX); the clamp at the
    // input's max but the painter at another (or the reverse: 9 strikes painted 9 hit of 7); a
    // painter that reads the max from module state set by clockVM instead of the view it paints
    // (the hand-built view below never went through clockVM); a label with the old max; a strip
    // memoised on the players' names and strikes alone (the same players at a new max kept at 7).
    const paintedPips = (
      host: HTMLElement,
    ): Array<[string | null, number, number, string | null]> =>
      [...host.querySelectorAll<HTMLElement>('.tactics-player')].map((e) => {
        const pips = e.querySelector('.tactics-strikes');
        return [
          e.getAttribute('data-side'),
          e.querySelectorAll('.tactics-strike').length,
          e.querySelectorAll('.tactics-strike--hit').length,
          pips === null ? null : pips.getAttribute('aria-label'),
        ];
      });
    const hitOrder = (host: HTMLElement): boolean[][] =>
      [...host.querySelectorAll<HTMLElement>('.tactics-strikes')].map((p) =>
        [...p.querySelectorAll('.tactics-strike')].map((pip) =>
          pip.classList.contains('tactics-strike--hit'),
        ),
      );

    // strikesMax 7: A has 9 auto-passes (clamped to 7), B has 5 (below the max).
    const seven = must(
      clockVM(
        input({
          clocks: [row('B', ME, 0, 30_000, 5), row('A', RIVAL, null, null, 9)],
          strikesMax: 7,
        }),
      ),
      'max 7',
    );
    expect(seven.players, 'the view carries the input max and clamps to it').toEqual([
      { side: 'A', mine: false, name: 'Marrow', strikes: 7, strikesMax: 7 },
      { side: 'B', mine: true, name: 'Quill', strikes: 5, strikesMax: 7 },
    ]);
    const s7 = strip();
    renderClock(turnBar(), s7, seven);
    expect(paintedPips(s7), 'seven pips each: A all seven hit, B five').toEqual([
      ['A', 7, 7, cat(EN, 'tactics.clock.strikes', { name: 'Marrow', n: 7, max: 7 })],
      ['B', 7, 5, cat(EN, 'tactics.clock.strikes', { name: 'Quill', n: 5, max: 7 })],
    ]);
    expect(hitOrder(s7), 'the hit pips come first').toEqual([
      [true, true, true, true, true, true, true],
      [true, true, true, true, true, false, false],
    ]);
    expect(
      cat(EN, 'tactics.clock.strikes', { name: 'Marrow', n: 7, max: 7 }),
      'fixture: the label names the max',
    ).not.toBe(cat(EN, 'tactics.clock.strikes', { name: 'Marrow', n: 7, max: 4 }));

    // strikesMax 3: the same 9 / 5 clamp to 3 / 3; a 2 stays 2.
    const three = must(
      clockVM(
        input({
          clocks: [row('B', ME, 0, 30_000, 2), row('A', RIVAL, null, null, 9)],
          strikesMax: 3,
        }),
      ),
      'max 3',
    );
    expect(
      three.players.map((p) => [p.strikes, p.strikesMax]),
      'clamped to 3, max 3',
    ).toEqual([
      [3, 3],
      [2, 3],
    ]);
    const s3 = strip();
    renderClock(turnBar(), s3, three);
    expect(paintedPips(s3), 'three pips each').toEqual([
      ['A', 3, 3, cat(EN, 'tactics.clock.strikes', { name: 'Marrow', n: 3, max: 3 })],
      ['B', 3, 2, cat(EN, 'tactics.clock.strikes', { name: 'Quill', n: 2, max: 3 })],
    ]);

    // A hand-built view (never through clockVM): the painter reads each row's own max.
    const hand: ClockVM = {
      ring: null,
      players: [
        { side: 'A', mine: false, name: 'Marrow', strikes: 2, strikesMax: 5 },
        { side: 'B', mine: true, name: 'Quill', strikes: 0, strikesMax: 5 },
      ],
    };
    const sh = strip();
    renderClock(turnBar(), sh, hand);
    expect(paintedPips(sh), 'five pips each from the view itself').toEqual([
      ['A', 5, 2, cat(EN, 'tactics.clock.strikes', { name: 'Marrow', n: 2, max: 5 })],
      ['B', 5, 0, cat(EN, 'tactics.clock.strikes', { name: 'Quill', n: 0, max: 5 })],
    ]);

    // The same players and strikes, repainted into the SAME strip at another max.
    const clocks = [row('B', ME, 0, 30_000, 2), row('A', RIVAL, null, null, 1)];
    const atSeven = must(clockVM(input({ clocks, strikesMax: 7 })), 'A 1, B 2 at 7');
    const atThree = must(clockVM(input({ clocks, strikesMax: 3 })), 'A 1, B 2 at 3');
    expect(
      atThree.players.map((p) => [p.name, p.strikes]),
      'fixture: the same names and strikes at either max',
    ).toEqual(atSeven.players.map((p) => [p.name, p.strikes]));
    const same = strip();
    const bar = turnBar();
    renderClock(bar, same, atSeven);
    expect(
      paintedPips(same).map(([side, pips, hit]) => [side, pips, hit]),
      'first paint: seven pips each',
    ).toEqual([
      ['A', 7, 1],
      ['B', 7, 2],
    ]);
    renderClock(bar, same, atThree);
    expect(paintedPips(same), 'repainted at 3: three pips each, the label at max 3').toEqual([
      ['A', 3, 1, cat(EN, 'tactics.clock.strikes', { name: 'Marrow', n: 1, max: 3 })],
      ['B', 3, 2, cat(EN, 'tactics.clock.strikes', { name: 'Quill', n: 2, max: 3 })],
    ]);
  });
});
