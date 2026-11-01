// @vitest-environment happy-dom
// tactics/ticker.test.ts — bt-10 RED tests for the battle-event ticker (BT10.5): every one of the
// 17 `EventPayload` variants renders as ONE i18n line (waste with its reason, miss, auto-pass,
// StoodGround, Surge, status tick, award, ...), and the `Ticker` list keeps the newest 50 lines in a
// plain visible list with NO live region.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.5; the plan's i18n key table + REV 2 A4 (status line per
// change; TurnEnded guard; Executed per-hit with ko); A12 (no live region outside
// ui/liveRegion.ts). The event shapes are the generated bindings in module_bindings/types.ts.
//
// HOW THE EXPECTED LINES ARE BUILT: from CATALOG_EN through the key and params the plan names
// (`en('tactics.ticker.hit', { target, damage })`), with a `names` stub that returns a DISTINCT
// string per id and kind (`unit#7`, `skill#7`, `item#7`) and records every call. A line therefore
// proves which id went to which name lookup and which param slot. The Executed separator is the
// plan's " — " (space, U+2014, space), built by code point.
//
// RED REASON: tickerLine and the Ticker constructor throw `bt-10: not implemented`.
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { afterEach, describe, expect, it } from 'vitest';
import type { EventPayload, TargetHit } from '../module_bindings/types';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import type { Side } from './boardModel';
import { TICKER_CAP, Ticker, type TickerNames, tickerLine } from './ticker';

const EN = CATALOG_EN as unknown as Record<string, unknown>;

function en(key: string, params: Record<string, unknown> = {}): string {
  const value = EN[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

const EM_DASH = String.fromCharCode(0x2014);
const SEP = ` ${EM_DASH} `;

interface NamesKit {
  readonly names: TickerNames;
  readonly calls: string[];
}

function makeNames(mySide: Side = 'A'): NamesKit {
  const calls: string[] = [];
  const names: TickerNames = {
    mySide,
    unit: (id) => {
      calls.push(`unit:${id}`);
      return `unit#${id}`;
    },
    skill: (id) => {
      calls.push(`skill:${id}`);
      return `skill#${id}`;
    },
    item: (id) => {
      calls.push(`item:${id}`);
      return `item#${id}`;
    },
  };
  return { names, calls };
}

const line = (ev: EventPayload, side: Side = 'A'): string => tickerLine(ev, makeNames(side).names);

function target(o: Partial<TargetHit> & { readonly unit: number }): TargetHit {
  return {
    hit: true,
    damage: 0,
    effectiveness: undefined,
    flank: false,
    guard: false,
    ko: false,
    ...o,
  };
}

describe('tickerLine: Executed (BT10.5, A4)', () => {
  it('BT10-5-TICKER-EXECUTED: one line = the executed text, then each HIT target as hit text, joined by " — "; misses and ko flags add nothing (they have their own events); zero hits give the executed text alone', () => {
    // WRONG IMPL KILLED: one ticker line per target (the batch must be ONE line); the ko text
    // dropped, or glued to the wrong target, or emitted for a miss; a miss narrated with the
    // target as the subject (missed takes the ATTACKER first); the damage of the first target
    // reused for every hit; a trailing " — " after the last segment or with zero targets; a
    // different separator (a hyphen, a bare space); the skill or a target resolved through the
    // wrong names lookup.
    const kit = makeNames('A');
    const ev: EventPayload = {
      tag: 'Executed',
      value: {
        attacker: 1,
        skillId: 7,
        results: [
          target({ unit: 2, hit: true, damage: 12, ko: true }),
          target({ unit: 3, hit: false, damage: 0 }),
          target({ unit: 4, hit: true, damage: 7 }),
        ],
      },
    };
    // ROUND 2 (R1): the server emits a standalone `Missed` per missed target and a standalone `Ko`
    // from the KO sweep, so the Executed line carries ONLY the executed text and the HIT clauses.
    const expected = [
      en('tactics.ticker.executed', { unit: 'unit#1', skill: 'skill#7' }),
      en('tactics.ticker.hit', { target: 'unit#2', damage: 12 }),
      en('tactics.ticker.hit', { target: 'unit#4', damage: 7 }),
    ].join(SEP);
    const got = tickerLine(ev, kit.names);
    expect(got, 'the exact composed line: executed, then the hits only').toBe(expected);
    expect(got.includes('\n'), 'one line').toBe(false);
    expect(
      got.includes('unit#3'),
      'the missed target is not named (its own Missed event says so)',
    ).toBe(false);
    expect(
      got.includes(en('tactics.ticker.ko', { unit: 'unit#2' })),
      'no ko text (its own Ko event says so)',
    ).toBe(false);
    expect(
      got.includes(en('tactics.ticker.missed', { unit: 'unit#1', target: 'unit#3' })),
      'no missed text',
    ).toBe(false);
    expect(kit.calls, 'unit names looked up by the right ids').toEqual(
      expect.arrayContaining(['unit:1', 'unit:2', 'unit:4', 'skill:7']),
    );
    expect(
      kit.calls.some((c) => c.startsWith('item:')),
      'no item lookup for an attack',
    ).toBe(false);

    const bare: EventPayload = {
      tag: 'Executed',
      value: { attacker: 5, skillId: 9, results: [] },
    };
    const bareLine = line(bare);
    expect(bareLine, 'zero targets: the executed text alone').toBe(
      en('tactics.ticker.executed', { unit: 'unit#5', skill: 'skill#9' }),
    );
    expect(bareLine.endsWith(SEP), 'no trailing separator').toBe(false);
    expect(bareLine.includes(EM_DASH), 'no separator at all').toBe(false);

    const oneMiss: EventPayload = {
      tag: 'Executed',
      value: { attacker: 5, skillId: 9, results: [target({ unit: 6, hit: false })] },
    };
    expect(line(oneMiss), 'one miss adds nothing: the executed text alone').toBe(
      en('tactics.ticker.executed', { unit: 'unit#5', skill: 'skill#9' }),
    );
    const koFirst: EventPayload = {
      tag: 'Executed',
      value: { attacker: 5, skillId: 9, results: [target({ unit: 6, damage: 30, ko: true })] },
    };
    expect(line(koFirst), 'a single ko hit: the hit clause, no ko clause').toBe(
      [
        en('tactics.ticker.executed', { unit: 'unit#5', skill: 'skill#9' }),
        en('tactics.ticker.hit', { target: 'unit#6', damage: 30 }),
      ].join(SEP),
    );
    const missThenHit: EventPayload = {
      tag: 'Executed',
      value: {
        attacker: 5,
        skillId: 9,
        results: [target({ unit: 6, hit: false }), target({ unit: 8, damage: 4 })],
      },
    };
    expect(line(missThenHit), 'a leading miss does not leave a stray separator').toBe(
      [
        en('tactics.ticker.executed', { unit: 'unit#5', skill: 'skill#9' }),
        en('tactics.ticker.hit', { target: 'unit#8', damage: 4 }),
      ].join(SEP),
    );
  });
});

describe('tickerLine: the other variants (BT10.5, A4)', () => {
  it('BT10-5-TICKER-SIMPLE: Missed, QueueVoided, AutoPass, StoodGround, Surge, Ko, RecruitResult, Awards, Moved, ItemUsed, RoundEnded and BattleStarted each render their catalog line from the right fields', () => {
    // WRONG IMPL KILLED: a variant sharing another's key; a param read from the wrong field (the
    // moved tile count taken from the coordinates, the auto-pass strike from the unit id, the
    // recruit target from the actor); recruit success and failure collapsed into one line; the
    // failure percentage dropped; the ids not passed through the names lookups (a raw number in
    // the line); the item and its target swapped; BattleStarted not a plain catalog line.
    const cases: readonly (readonly [string, EventPayload, string])[] = [
      [
        'Missed',
        { tag: 'Missed', value: { attacker: 11, target: 12 } },
        en('tactics.ticker.missed', { unit: 'unit#11', target: 'unit#12' }),
      ],
      [
        'QueueVoided',
        { tag: 'QueueVoided', value: { unit: 13 } },
        en('tactics.ticker.voided', { unit: 'unit#13' }),
      ],
      [
        'AutoPass strike 2',
        { tag: 'AutoPass', value: { unit: 14, strike: 2 } },
        en('tactics.ticker.autoPass', { unit: 'unit#14', strike: 2 }),
      ],
      [
        'AutoPass strike 3',
        { tag: 'AutoPass', value: { unit: 14, strike: 3 } },
        en('tactics.ticker.autoPass', { unit: 'unit#14', strike: 3 }),
      ],
      [
        'StoodGround',
        { tag: 'StoodGround', value: { unit: 15 } },
        en('tactics.ticker.stoodGround', { unit: 'unit#15' }),
      ],
      [
        'Surge',
        { tag: 'Surge', value: { round: 9, unit: 16, amount: 3 } },
        en('tactics.ticker.surge', { unit: 'unit#16', amount: 3 }),
      ],
      ['Ko', { tag: 'Ko', value: { unit: 17 } }, en('tactics.ticker.ko', { unit: 'unit#17' })],
      [
        'RecruitResult success',
        { tag: 'RecruitResult', value: { unit: 18, target: 19, success: true, pct: 42 } },
        en('tactics.ticker.recruitOk', { target: 'unit#19' }),
      ],
      [
        'RecruitResult failure',
        { tag: 'RecruitResult', value: { unit: 18, target: 19, success: false, pct: 37 } },
        en('tactics.ticker.recruitFail', { target: 'unit#19', pct: 37 }),
      ],
      [
        'Awards',
        { tag: 'Awards', value: { unit: 20, xp: 55, essence: 6, currency: 123n } },
        en('tactics.ticker.awards', { unit: 'unit#20', xp: 55, essence: 6, currency: 123n }),
      ],
      [
        'Moved',
        { tag: 'Moved', value: { unit: 21, fromX: 0, fromY: 0, toX: 1, toY: 0, tiles: 3 } },
        en('tactics.ticker.moved', { unit: 'unit#21', tiles: 3 }),
      ],
      [
        'ItemUsed',
        { tag: 'ItemUsed', value: { unit: 22, itemId: 5, target: 23 } },
        en('tactics.ticker.itemUsed', { unit: 'unit#22', item: 'item#5', target: 'unit#23' }),
      ],
      [
        'RoundEnded',
        { tag: 'RoundEnded', value: { round: 8 } },
        en('tactics.ticker.roundEnded', { round: 8 }),
      ],
      [
        'BattleStarted',
        { tag: 'BattleStarted', value: { round: 1 } },
        en('tactics.ticker.battleStarted'),
      ],
    ];
    const seen = new Set<string>();
    for (const [label, ev, expected] of cases) {
      const got = line(ev);
      expect(got, label).toBe(expected);
      expect(got.length > 0, `${label}: non-empty`).toBe(true);
      seen.add(got);
    }
    expect(seen.size, 'every case renders a different line').toBe(cases.length);
    expect(
      line({ tag: 'Moved', value: { unit: 21, fromX: 5, fromY: 5, toX: 5, toY: 5, tiles: 1 } }),
      'the moved count is the tiles field, not the coordinates',
    ).toBe(en('tactics.ticker.moved', { unit: 'unit#21', tiles: 1 }));
  });

  it('BT10-5-TICKER-HALT: all 14 HaltKinds render the halted line with their mapped reason (Unreachable is not TargetGone)', () => {
    // WRONG IMPL KILLED: one generic reason for every kind; Unreachable folded into TargetGone
    // (the plan separates "the target left" from "out of reach"); a kind falling through to
    // notAllowed by a default branch; the reason text hard-coded instead of the catalog's
    // tactics.halt.* line; the unit not resolved through the names lookup.
    const map: readonly (readonly [string, string])[] = [
      ['TargetGone', 'targetGone'],
      ['Unreachable', 'outOfReach'],
      ['TooFar', 'outOfReach'],
      ['Geometry', 'outOfReach'],
      ['NotAdjacent', 'outOfReach'],
      ['CannotAct', 'cannotAct'],
      ['BadState', 'cannotAct'],
      ['ItemNotHeld', 'itemNotHeld'],
      ['Unaffordable', 'unaffordable'],
      ['NoHeadroom', 'partyFull'],
      ['NotWild', 'notAllowed'],
      ['NotAllowed', 'notAllowed'],
      ['BadShape', 'notAllowed'],
      ['UnknownSkill', 'notAllowed'],
    ];
    expect(map, 'all 14 HaltKinds are covered').toHaveLength(14);
    const lines = new Map<string, string>();
    for (const [kind, reason] of map) {
      const ev = {
        tag: 'PlanHalted',
        value: { unit: 30, idx: 1, reasonKind: { tag: kind } },
      } as unknown as EventPayload;
      const got = line(ev);
      expect(got, `${kind}`).toBe(
        en('tactics.ticker.halted', { unit: 'unit#30', reason: en(`tactics.halt.${reason}`) }),
      );
      lines.set(kind, got);
    }
    expect(lines.get('Unreachable'), 'Unreachable reads differently from TargetGone').not.toBe(
      lines.get('TargetGone'),
    );
    expect(lines.get('NoHeadroom'), 'party full reads differently from not allowed').not.toBe(
      lines.get('NotAllowed'),
    );
    expect(new Set(lines.values()).size, 'the seven reasons give seven distinct lines').toBe(7);
  });

  it('BT10-5-TICKER-STATUS: each status change has its own line, a Tick names the amount, and every status is named through tactics.status.*', () => {
    // WRONG IMPL KILLED: the four changes sharing one line (the plan replaced the single status
    // key with four); a tick that drops its amount (two different amounts must differ); the
    // amount leaking into the other three changes; the status name hard-coded or taken from the
    // wrong enum member; Sleep (whose variant carries a payload) failing to resolve.
    const status = (
      unit: number,
      s: { tag: string; value?: number },
      change: string,
      amount: number,
    ): EventPayload =>
      ({
        tag: 'Status',
        value: { unit, status: s, change: { tag: change }, amount },
      }) as unknown as EventPayload;
    const label = (key: string): string => en(`tactics.status.${key}`);

    expect(line(status(31, { tag: 'Poison' }, 'Applied', 7))).toBe(
      en('tactics.ticker.statusApplied', { unit: 'unit#31', status: label('poison') }),
    );
    expect(line(status(31, { tag: 'Burn' }, 'Tick', 5))).toBe(
      en('tactics.ticker.statusTick', { unit: 'unit#31', status: label('burn'), amount: 5 }),
    );
    expect(line(status(31, { tag: 'Burn' }, 'Tick', 9))).toBe(
      en('tactics.ticker.statusTick', { unit: 'unit#31', status: label('burn'), amount: 9 }),
    );
    expect(line(status(31, { tag: 'Burn' }, 'Tick', 5)), 'the tick amount is in the line').not.toBe(
      line(status(31, { tag: 'Burn' }, 'Tick', 9)),
    );
    expect(line(status(32, { tag: 'Paralysis' }, 'Cured', 3))).toBe(
      en('tactics.ticker.statusCured', { unit: 'unit#32', status: label('paralysis') }),
    );
    expect(line(status(33, { tag: 'Sleep', value: 2 }, 'Blocked', 4))).toBe(
      en('tactics.ticker.statusBlocked', { unit: 'unit#33', status: label('sleep') }),
    );
    expect(line(status(34, { tag: 'Freeze' }, 'Applied', 0))).toBe(
      en('tactics.ticker.statusApplied', { unit: 'unit#34', status: label('freeze') }),
    );

    const four = ['Applied', 'Tick', 'Cured', 'Blocked'].map((c) =>
      line(status(31, { tag: 'Poison' }, c, 5)),
    );
    expect(new Set(four).size, 'four changes, four different lines').toBe(4);
    const five = ['Poison', 'Burn', 'Paralysis', 'Sleep', 'Freeze'].map((s) =>
      line(status(31, { tag: s }, 'Applied', 1)),
    );
    expect(new Set(five).size, 'five statuses, five different lines').toBe(5);
  });

  it('BT10-5-TICKER-TURNEND: a guarding turn end reads guarded, any other reads turnEnded, whatever `committed` says', () => {
    // WRONG IMPL KILLED: the two collapsed into one line; the flags swapped; `committed` used as
    // the discriminator (the plan says it is ignored).
    const ended = (guard: boolean, committed: boolean): string =>
      line({ tag: 'TurnEnded', value: { unit: 40, guard, committed } });
    const guarded = en('tactics.ticker.guarded', { unit: 'unit#40' });
    const plain = en('tactics.ticker.turnEnded', { unit: 'unit#40' });
    expect(ended(true, false), 'guard, not committed').toBe(guarded);
    expect(ended(true, true), 'guard, committed').toBe(guarded);
    expect(ended(false, true), 'no guard, committed').toBe(plain);
    expect(ended(false, false), 'no guard, not committed').toBe(plain);
    expect(guarded, 'the two lines differ').not.toBe(plain);
  });

  it("BT10-5-TICKER-BATTLEEND: the end line is won, lost, fled or battleEnded by outcome and the viewer's side", () => {
    // WRONG IMPL KILLED: the outcome read as absolute (side A always "won": the B player sees the
    // wrong banner); won/lost swapped; Fled reported as a loss; Ongoing crashing or reading as a
    // win; the `how` field changing the line.
    const end = (outcome: string, how: string, side: Side): string =>
      line(
        {
          tag: 'BattleEnd',
          value: { outcome: { tag: outcome }, how: { tag: how } },
        } as unknown as EventPayload,
        side,
      );
    const won = en('tactics.ticker.won');
    const lost = en('tactics.ticker.lost');
    expect(end('SideAWins', 'SideEmpty', 'A'), 'A wins, I am A').toBe(won);
    expect(end('SideAWins', 'SideEmpty', 'B'), 'A wins, I am B').toBe(lost);
    expect(end('SideBWins', 'SideEmpty', 'B'), 'B wins, I am B').toBe(won);
    expect(end('SideBWins', 'RoundCap', 'A'), 'B wins, I am A').toBe(lost);
    expect(end('SideAWins', 'RoundCap', 'A'), 'the how does not matter').toBe(won);
    expect(end('Fled', 'Fled', 'A'), 'fled, side A').toBe(en('tactics.ticker.fled'));
    expect(end('Fled', 'AutoFlee', 'B'), 'fled, side B').toBe(en('tactics.ticker.fled'));
    expect(end('Ongoing', 'SideEmpty', 'A'), 'ongoing').toBe(en('tactics.ticker.battleEnded'));
    expect(
      new Set([won, lost, en('tactics.ticker.fled'), en('tactics.ticker.battleEnded')]).size,
    ).toBe(4);
  });

  it('BT10-5-TICKER-FORGED: an unknown event tag throws instead of inventing a generic line', () => {
    // WRONG IMPL KILLED: a default branch returning '' or a JSON dump (the exhaustive `satisfies
    // never` is the contract: a new variant is a compile error, a forged one a loud failure).
    const forged = { tag: 'Bogus', value: { unit: 1 } } as unknown as EventPayload;
    expect(() => tickerLine(forged, makeNames().names)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The Ticker list
// ---------------------------------------------------------------------------------------------

function mount(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

/** The `.tactics-ticker` list: the parent itself or the element the Ticker created inside it. */
function tickerEl(parent: HTMLElement): HTMLElement {
  if (parent.matches('.tactics-ticker')) return parent;
  const found = parent.querySelector<HTMLElement>('.tactics-ticker');
  if (found === null) throw new Error('no .tactics-ticker element');
  return found;
}

const texts = (el: HTMLElement): (string | null)[] => [...el.children].map((c) => c.textContent);

afterEach(() => {
  document.body.replaceChildren();
});

describe('Ticker: the capped log (BT10.5)', () => {
  it('BT10-5-TICKER-CAP: pushing 120 lines keeps the newest 50 in order (oldest dropped), and the cap is exactly 50', () => {
    // WRONG IMPL KILLED: no cap (120 lines); a cap of 49 or 51 (the boundary pushes below);
    // dropping the NEWEST instead of the oldest; keeping the cap but reversing the order; a
    // lines() that is not the same sequence the list shows.
    expect(TICKER_CAP, 'the cap').toBe(50);
    const ticker = new Ticker(mount());
    expect(ticker.lines(), 'starts empty').toEqual([]);
    for (let i = 1; i <= 50; i++) ticker.push(`line ${i}`);
    expect(ticker.lines(), 'exactly 50 fit').toHaveLength(50);
    expect(ticker.lines()[0], 'nothing dropped yet').toBe('line 1');
    ticker.push('line 51');
    expect(ticker.lines(), 'the 51st push keeps 50').toHaveLength(50);
    expect(ticker.lines()[0], 'the oldest went').toBe('line 2');
    expect(ticker.lines()[49], 'the newest is last').toBe('line 51');

    const many = new Ticker(mount());
    for (let i = 1; i <= 120; i++) many.push(`line ${i}`);
    const lines = many.lines();
    expect(lines, 'still 50 after 120 pushes').toHaveLength(50);
    expect(lines[0], 'first is line #71').toBe('line 71');
    expect(lines[49], 'last is the newest').toBe('line 120');
    expect(lines, 'consecutive and in order').toEqual(
      Array.from({ length: 50 }, (_, i) => `line ${71 + i}`),
    );
  });

  it('BT10-5-TICKER-DOM: the .tactics-ticker list shows the same 50 lines in order, as plain children with no aria-live or role, and a hostile line stays text', () => {
    // WRONG IMPL KILLED: a list that grows without bound (120 children); children appended in
    // reverse; an aria-live / role=log|status region (A11Y-05b bans live regions outside
    // ui/liveRegion.ts); a line written through innerHTML (the <img onerror> below).
    const parent = mount();
    const ticker = new Ticker(parent);
    for (let i = 1; i <= 120; i++) ticker.push(`line ${i}`);
    const el = tickerEl(parent);
    expect(el.children, 'fifty children').toHaveLength(50);
    expect(texts(el), 'in order, oldest first').toEqual(
      Array.from({ length: 50 }, (_, i) => `line ${71 + i}`),
    );
    expect(texts(el), 'the DOM and lines() agree').toEqual([...ticker.lines()]);

    const live = ['aria-live', 'role', 'aria-atomic', 'aria-relevant'];
    for (const node of [parent, el, ...el.querySelectorAll('*')]) {
      for (const attr of live) {
        expect(node.hasAttribute(attr), `no ${attr} on <${node.tagName.toLowerCase()}>`).toBe(
          false,
        );
      }
    }
    expect(parent.querySelectorAll('[aria-live],[role]'), 'no live region anywhere').toHaveLength(
      0,
    );

    const hostile = '<img src=x onerror=alert(1)>';
    ticker.push(hostile);
    expect(parent.querySelectorAll('img'), 'no img element').toHaveLength(0);
    expect(parent.querySelectorAll('[onerror]'), 'no onerror attribute').toHaveLength(0);
    expect(el.lastElementChild?.textContent, 'literal text').toBe(hostile);
    expect(el.children, 'still fifty').toHaveLength(50);
    expect(el.firstElementChild?.textContent, 'the oldest dropped from the DOM too').toBe(
      'line 72',
    );
  });

  it('BT10-5-TICKER-AT: the list is a keyboard-focusable, labelled scroller (tabindex 0, aria-label = tactics.ticker.label) that keeps the newest line in view by scrolling ITSELF to the bottom', () => {
    // WRONG IMPL KILLED (ROUND 2, R12): a scrollable log a keyboard user cannot reach (no
    // tabindex) or that has no accessible name; a list that grows past its box and never
    // follows the newest line (scrollTop never written); the scroll written to another element
    // (the turn bar must never scroll: BT10-3-*-NO-RECENTRE) instead of the ticker's own.
    const parent = mount();
    const ticker = new Ticker(parent);
    const el = tickerEl(parent);
    expect(el.getAttribute('tabindex'), 'focusable by keyboard').toBe('0');
    expect(el.getAttribute('aria-label'), 'named from the catalog').toBe(
      en('tactics.ticker.label'),
    );
    for (const attr of ['aria-live', 'role']) {
      expect(el.hasAttribute(attr), `still no ${attr}`).toBe(false);
    }

    // happy-dom lays nothing out: give THIS element a scrollHeight and record scrollTop writes.
    const writes: number[] = [];
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 777 });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => writes.at(-1) ?? 0,
      set: (v: number) => {
        writes.push(v);
      },
    });
    for (let i = 1; i <= 60; i++) ticker.push(`line ${i}`);
    expect(writes.length > 0, 'scrollTop was written while pushing').toBe(true);
    expect(writes.at(-1), 'the last write is the list scrollHeight (the newest line in view)').toBe(
      777,
    );
    const before = writes.length;
    ticker.push('one more');
    expect(writes.length > before, 'every push follows the newest line').toBe(true);
    expect(writes.at(-1), 'and lands on the bottom').toBe(777);
  });
});
