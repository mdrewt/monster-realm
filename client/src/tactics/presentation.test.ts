// tactics/presentation.test.ts — bt-10 RED tests for the presentation constitution (BT10.5): the
// playback caps (400 ms per action, 100 ms per tile up to 400, 1 000 ms per upkeep batch, 2 000 ms
// battle start, 3 000 ms results), the beat plan, the no-banner rule for READY and AI turns,
// reduced motion, and the `Playback` queue that a B tap skips.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.5; design §9.4; the Rust SSOT
// `game-core/src/tactics/events.rs` (`presentation_cap_ms` and the six `*_CAP_MS` consts) — REV 2
// A3 makes the TS table a MIRROR of it, so the first test PARSES the Rust and compares; A10 pins
// the playback timing. Pure: every clock is an injected function, never Date.now/performance.now.
//
// RED REASON: capMs / planBeats / showsTurnBanner / Playback throw `bt-10: not implemented`
// (CAPS is already a frozen literal in the stub, so only the Rust-parity test that also calls
// capMs reds on it).
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { EventPayload } from '../module_bindings/types';
import { type Beat, CAPS, capMs, Playback, planBeats, showsTurnBanner } from './presentation';

type Tag = EventPayload['tag'];

/** One sample event per EventPayload tag; the Record type makes a missing tag a compile error. */
const SAMPLE: Record<Tag, EventPayload> = {
  Executed: { tag: 'Executed', value: { attacker: 1, skillId: 2, results: [] } },
  Missed: { tag: 'Missed', value: { attacker: 1, target: 2 } },
  PlanHalted: {
    tag: 'PlanHalted',
    value: { unit: 1, idx: 0, reasonKind: { tag: 'TargetGone' } },
  },
  QueueVoided: { tag: 'QueueVoided', value: { unit: 1 } },
  AutoPass: { tag: 'AutoPass', value: { unit: 1, strike: 1 } },
  StoodGround: { tag: 'StoodGround', value: { unit: 1 } },
  Status: {
    tag: 'Status',
    value: { unit: 1, status: { tag: 'Poison' }, change: { tag: 'Tick' }, amount: 2 },
  },
  Surge: { tag: 'Surge', value: { round: 9, unit: 1, amount: 3 } },
  Ko: { tag: 'Ko', value: { unit: 1 } },
  RecruitResult: { tag: 'RecruitResult', value: { unit: 1, target: 2, success: true, pct: 50 } },
  Awards: { tag: 'Awards', value: { unit: 1, xp: 5, essence: 1, currency: 10n } },
  Moved: { tag: 'Moved', value: { unit: 1, fromX: 0, fromY: 0, toX: 3, toY: 0, tiles: 3 } },
  ItemUsed: { tag: 'ItemUsed', value: { unit: 1, itemId: 4, target: 2 } },
  TurnEnded: { tag: 'TurnEnded', value: { unit: 1, guard: false, committed: true } },
  RoundEnded: { tag: 'RoundEnded', value: { round: 1 } },
  BattleStarted: { tag: 'BattleStarted', value: { round: 1 } },
  BattleEnd: {
    tag: 'BattleEnd',
    value: { outcome: { tag: 'SideAWins' }, how: { tag: 'SideEmpty' } },
  },
} as Record<Tag, EventPayload>;

const ALL_TAGS = Object.keys(SAMPLE) as Tag[];

/** A fresh object per call (identity matters in the grouping tests). */
function fresh(tag: Tag): EventPayload {
  return structuredClone(SAMPLE[tag]);
}

/** A Moved event; the coordinates deliberately disagree with `tiles`. */
function moved(tiles: number): EventPayload {
  return {
    tag: 'Moved',
    value: { unit: 1, fromX: 0, fromY: 0, toX: 9, toY: 9, tiles },
  };
}

// ---------------------------------------------------------------------------------------------
// Parity with game-core/src/tactics/events.rs
// ---------------------------------------------------------------------------------------------

const EVENTS_RS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../game-core/src/tactics/events.rs',
);

/** The Rust source with `//` comments (doc comments included) removed line by line. */
function rustCode(): string {
  return readFileSync(EVENTS_RS, 'utf8')
    .split('\n')
    .map((l) => {
      const at = l.indexOf('//');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

const RUST_TO_CAPS: Readonly<Record<string, keyof typeof CAPS>> = {
  ACTION_CAP_MS: 'actionMs',
  TILE_CAP_MS: 'tileMs',
  MOVE_CAP_MS: 'moveMaxMs',
  UPKEEP_CAP_MS: 'upkeepMs',
  BATTLE_START_CAP_MS: 'startMs',
  RESULTS_CAP_MS: 'resultsMs',
};

/** `presentation_cap_ms`'s arms: tag -> the right-hand side text (`0`, `ACTION_CAP_MS`, ...). */
function parseCapArms(code: string): Map<string, string> {
  const fnAt = code.indexOf('fn presentation_cap_ms');
  if (fnAt === -1) throw new Error('presentation_cap_ms not found in events.rs');
  const matchAt = code.indexOf('match event', fnAt);
  const open = code.indexOf('{', matchAt);
  let depth = 1;
  let i = open + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') depth -= 1;
    i += 1;
  }
  const block = code.slice(open + 1, i - 1);
  const arms = new Map<string, string>();
  for (const m of block.matchAll(/EventPayload::(\w+)/g)) {
    const arrow = block.indexOf('=>', m.index);
    let j = arrow + 2;
    while (/\s/.test(block[j] ?? '')) j += 1;
    let rhsEnd = j;
    let d = 0;
    while (rhsEnd < block.length) {
      const c = block[rhsEnd];
      if (c === '(' || c === '{' || c === '[') d += 1;
      else if (c === ')' || c === '}' || c === ']') {
        d -= 1;
        // A `{ ... }` arm body ends at its closing brace (rustfmt writes no comma after it).
        if (d === 0 && c === '}' && block[j] === '{') {
          rhsEnd += 1;
          break;
        }
      } else if (c === ',' && d === 0) break;
      rhsEnd += 1;
    }
    arms.set(m[1], block.slice(j, rhsEnd).trim());
  }
  return arms;
}

describe('presentation caps: the mirror of the Rust SSOT (BT10.5, A3)', () => {
  it('BT10-5-CAPS-PARITY: CAPS equals the six *_CAP_MS consts parsed out of events.rs and capMs returns 0 for exactly the Rust zero-arm tags and the Rust value for the rest, over all 17 tags', () => {
    // WRONG IMPL KILLED: a cap edited in TS only (the server pad is the SUM of these caps, so a
    // drifted client table desynchronises playback from the server clock); a tag missing from
    // the table; a zero-cap tag given a duration (Ko, Awards and Status would each stall the
    // queue); a non-zero tag given 0 (RoundEnded, BattleEnd); Moved ignoring its tile count.
    const code = rustCode();
    const consts = new Map<string, number>();
    for (const m of code.matchAll(/pub const (\w+_CAP_MS): u32 = ([0-9_]+);/g)) {
      consts.set(m[1], Number.parseInt(m[2].replaceAll('_', ''), 10));
    }
    expect([...consts.keys()].sort(), 'exactly the six cap consts').toEqual(
      Object.keys(RUST_TO_CAPS).sort(),
    );
    for (const [rust, key] of Object.entries(RUST_TO_CAPS)) {
      expect(CAPS[key], `CAPS.${key} mirrors ${rust}`).toBe(consts.get(rust));
    }
    expect(Object.keys(CAPS).sort(), 'CAPS has exactly the six keys').toEqual(
      Object.values(RUST_TO_CAPS).sort(),
    );

    const arms = parseCapArms(code);
    expect([...arms.keys()].sort(), 'the Rust match names all 17 tags').toEqual(
      [...ALL_TAGS].sort(),
    );
    const zeroTags = [...arms]
      .filter(([, rhs]) => rhs === '0')
      .map(([tag]) => tag)
      .sort();
    expect(zeroTags, 'the Rust zero-arm tags (design 9.4: bookkeeping rides its batch)').toEqual(
      [
        'AutoPass',
        'Awards',
        'Ko',
        'Missed',
        'PlanHalted',
        'QueueVoided',
        'Status',
        'StoodGround',
        'Surge',
        'TurnEnded',
      ].sort(),
    );

    const rustValue = (tag: string): number => {
      const rhs = arms.get(tag) ?? '';
      if (rhs === '0') return 0;
      if (tag === 'Moved') return CAPS.tileMs * 3;
      const name = Object.keys(RUST_TO_CAPS).find((n) => rhs.includes(n));
      if (name === undefined) throw new Error(`cannot read the cap of ${tag}: ${rhs}`);
      return consts.get(name) ?? Number.NaN;
    };
    for (const tag of ALL_TAGS) {
      expect(capMs(SAMPLE[tag]), `capMs(${tag}) equals the Rust cap`).toBe(rustValue(tag));
    }
    expect(capMs(SAMPLE.Executed), 'Executed').toBe(400);
    expect(capMs(SAMPLE.ItemUsed), 'ItemUsed').toBe(400);
    expect(capMs(SAMPLE.RecruitResult), 'RecruitResult').toBe(400);
    expect(capMs(SAMPLE.RoundEnded), 'RoundEnded (the upkeep header)').toBe(1000);
    expect(capMs(SAMPLE.BattleStarted), 'BattleStarted').toBe(2000);
    expect(capMs(SAMPLE.BattleEnd), 'BattleEnd').toBe(3000);
  });

  it('BT10-5-CAPS-MOVED: a move takes 100 ms per tile up to 400, counted from `tiles` and never from the coordinates', () => {
    // WRONG IMPL KILLED: no ceiling (255 tiles = 25 500 ms); the ceiling applied to the tile
    // count instead of the time (4 tiles = 4 ms); the duration computed from |to - from| (the
    // fixture's coordinates disagree with `tiles` on purpose); 0 tiles given a minimum beat.
    const cases: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 100],
      [2, 200],
      [3, 300],
      [4, 400],
      [5, 400],
      [255, 400],
    ];
    for (const [tiles, ms] of cases) {
      expect(capMs(moved(tiles)), `${tiles} tiles`).toBe(ms);
    }
    expect(
      capMs({ tag: 'Moved', value: { unit: 1, fromX: 2, fromY: 2, toX: 2, toY: 2, tiles: 2 } }),
      'zero displacement but tiles 2',
    ).toBe(200);
    expect(
      capMs({ tag: 'Moved', value: { unit: 1, fromX: 0, fromY: 0, toX: 7, toY: 7, tiles: 1 } }),
      'a long displacement but tiles 1',
    ).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------
// planBeats
// ---------------------------------------------------------------------------------------------

describe('planBeats (BT10.5, A3)', () => {
  it('BT10-5-BEATS-PLAN: each non-zero-cap event opens a beat of its cap and every zero-cap event joins the open beat, in order, with the input objects untouched', () => {
    // WRONG IMPL KILLED: one beat per event (Missed/Ko/Status each stalling the queue); a
    // run-of-Status heuristic that starts the upkeep beat at Status instead of the RoundEnded
    // header (A3 supersedes the freeze text); the TurnEnded after the upkeep batch splitting
    // off or being dropped; Awards leaving the results beat; the durations not summing to the
    // server pad; events reordered, cloned or dropped.
    const started = fresh('BattleStarted');
    const mv = moved(3);
    const exec1 = fresh('Executed');
    const miss = fresh('Missed');
    const ko = fresh('Ko');
    const round = fresh('RoundEnded');
    const status1 = fresh('Status');
    const surge = fresh('Surge');
    const status2 = fresh('Status');
    const turnEnd = fresh('TurnEnded');
    const exec2 = fresh('Executed');
    const end = fresh('BattleEnd');
    const awards = fresh('Awards');
    const input = [
      started,
      mv,
      exec1,
      miss,
      ko,
      round,
      status1,
      surge,
      status2,
      turnEnd,
      exec2,
      end,
      awards,
    ];

    const beats = planBeats(input, { reduceMotion: false });
    const groups: readonly EventPayload[][] = [
      [started],
      [mv],
      [exec1, miss, ko],
      [round, status1, surge, status2, turnEnd],
      [exec2],
      [end, awards],
    ];
    expect(
      beats.map((b) => [b.kind, b.ms]),
      'kinds and durations',
    ).toEqual([
      ['start', 2000],
      ['move', 300],
      ['action', 400],
      ['upkeep', 1000],
      ['action', 400],
      ['results', 3000],
    ]);
    expect(beats, 'six beats').toHaveLength(6);
    for (const [i, group] of groups.entries()) {
      expect(beats[i].events, `beat ${i} has ${group.length} events`).toHaveLength(group.length);
      for (const [j, event] of group.entries()) {
        expect(beats[i].events[j], `beat ${i} event ${j} is the input object`).toBe(event);
      }
    }
    expect(
      beats.map((b) => b.motion),
      'every beat with time animates',
    ).toEqual([true, true, true, true, true, true]);
    expect(
      beats.reduce((n, b) => n + b.ms, 0),
      'the beat durations sum to the caps',
    ).toBe(input.reduce((n, e) => n + capMs(e), 0));
    expect(
      beats.reduce((n, b) => n + b.ms, 0),
      'and to 7100 for this fixture',
    ).toBe(7100);

    // Other openers: ItemUsed and RecruitResult are action beats; consecutive openers stay apart.
    const other = planBeats(
      [fresh('ItemUsed'), fresh('RecruitResult'), fresh('RoundEnded'), fresh('RoundEnded')],
      {
        reduceMotion: false,
      },
    );
    expect(
      other.map((b) => [b.kind, b.ms]),
      'each opener opens its own beat',
    ).toEqual([
      ['action', 400],
      ['action', 400],
      ['upkeep', 1000],
      ['upkeep', 1000],
    ]);
    expect(
      planBeats([moved(5)], { reduceMotion: false }).map((b) => [b.kind, b.ms]),
      'a long move is capped at 400',
    ).toEqual([['move', 400]]);
  });

  it('BT10-5-BEATS-EDGES: zero-cap events before any opener form ONE silent 0 ms beat, a zero-tile move joins the open beat, an empty input plans nothing, and a long mixed run keeps order, objects and the cap sum', () => {
    // WRONG IMPL KILLED: leading bookkeeping events dropped (the ticker line is separate, but a
    // beat must still carry them); one silent beat per leading event; a zero-tile Moved opening
    // a 0 ms 'move' beat; the silent beat marked as animating; a crash on []; any reorder,
    // clone or loss in a long run; Σ ms drifting from Σ capMs.
    const lead = [fresh('TurnEnded'), fresh('Status')];
    const exec = fresh('Executed');
    const beats = planBeats([...lead, exec], { reduceMotion: false });
    expect(
      beats.map((b) => [b.kind, b.ms, b.events.length, b.motion]),
      'silent then action',
    ).toEqual([
      ['silent', 0, 2, false],
      ['action', 400, 1, true],
    ]);
    expect(beats[0].events[0], 'silent beat keeps the first object').toBe(lead[0]);
    expect(beats[0].events[1], 'silent beat keeps the second object').toBe(lead[1]);

    const onlyZero = planBeats([fresh('Ko'), fresh('Awards'), fresh('Surge')], {
      reduceMotion: false,
    });
    expect(
      onlyZero.map((b) => [b.kind, b.ms, b.events.length]),
      'only zero-cap events: one silent beat',
    ).toEqual([['silent', 0, 3]]);
    expect(planBeats([], { reduceMotion: false }), 'nothing in, nothing out').toEqual([]);

    const zeroMove = planBeats([fresh('Executed'), moved(0)], { reduceMotion: false });
    expect(
      zeroMove.map((b) => [b.kind, b.ms, b.events.length]),
      'a zero-tile move joins the open action',
    ).toEqual([['action', 400, 2]]);
    expect(
      planBeats([moved(0)], { reduceMotion: false }).map((b) => [b.kind, b.ms]),
      'a leading zero-tile move is silent',
    ).toEqual([['silent', 0]]);

    // A long deterministic mixed run (a seeded LCG, no wall clock, no Math.random).
    let seed = 20261031;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (const length of [1, 17, 200]) {
      const run: EventPayload[] = [];
      for (let i = 0; i < length; i++) {
        const tag = ALL_TAGS[next() % ALL_TAGS.length];
        run.push(tag === 'Moved' ? moved(next() % 8) : fresh(tag));
      }
      const planned = planBeats(run, { reduceMotion: false });
      const flat = planned.flatMap((b) => [...b.events]);
      expect(flat, `length ${length}: same count`).toHaveLength(run.length);
      for (const [i, event] of run.entries()) {
        expect(flat[i], `length ${length}: event ${i} keeps its place and identity`).toBe(event);
      }
      expect(
        planned.reduce((n, b) => n + b.ms, 0),
        `length ${length}: Σ beat.ms == Σ capMs`,
      ).toBe(run.reduce((n, e) => n + capMs(e), 0));
      expect(
        planned.every((b) => b.motion === b.ms > 0),
        `length ${length}: motion is ms > 0`,
      ).toBe(true);
      expect(
        planned.filter((b) => b.kind === 'silent').length <= 1,
        `length ${length}: at most one silent beat`,
      ).toBe(true);
    }
  });

  it('BT10-5-BEATS-REDUCED: reduced motion keeps the grouping, the kinds and the order but every beat is 0 ms with motion false', () => {
    // WRONG IMPL KILLED: reduced motion dropping or merging beats (the ticker would lose its
    // per-event grouping); durations kept (the slide plays anyway); motion left true; the
    // flag read inverted; a different event order.
    const input = [
      fresh('BattleStarted'),
      moved(3),
      fresh('Executed'),
      fresh('Missed'),
      fresh('RoundEnded'),
      fresh('Status'),
      fresh('TurnEnded'),
      fresh('BattleEnd'),
      fresh('Awards'),
    ];
    const live = planBeats(input, { reduceMotion: false });
    const reduced = planBeats(input, { reduceMotion: true });
    expect(
      reduced.map((b) => [b.kind, b.events.length]),
      'same kinds and grouping',
    ).toEqual(live.map((b) => [b.kind, b.events.length]));
    expect(
      reduced.map((b) => b.ms),
      'every beat is instant',
    ).toEqual(reduced.map(() => 0));
    expect(
      reduced.every((b) => b.motion === false),
      'no beat animates',
    ).toBe(true);
    const flat = reduced.flatMap((b) => [...b.events]);
    for (const [i, event] of input.entries()) {
      expect(flat[i], `reduced: event ${i} keeps its place and identity`).toBe(event);
    }
    expect(
      live.some((b) => b.ms > 0 && b.motion),
      'control: the live plan does animate',
    ).toBe(true);
    expect(planBeats([], { reduceMotion: true }), 'reduced empty').toEqual([]);
  });
});

describe('showsTurnBanner (BT10.5)', () => {
  it('BT10-5-BANNER-TABLE: the banner shows exactly when the unit is not READY and not AI, for both values of mine', () => {
    // WRONG IMPL KILLED: a banner on a READY turn (the player already planned it) or on a wild
    // AI turn; the banner reserved for own units (a human opponent's non-READY turn also gets
    // one); the two conditions OR-ed instead of AND-ed; one row hard-coded.
    const rows: readonly (readonly [boolean, boolean, boolean, boolean])[] = [
      [true, false, false, true],
      [true, false, true, false],
      [true, true, false, false],
      [true, true, true, false],
      [false, false, false, true],
      [false, false, true, false],
      [false, true, false, false],
      [false, true, true, false],
    ];
    expect(rows, 'all eight rows').toHaveLength(8);
    for (const [mine, ready, ai, expected] of rows) {
      expect(showsTurnBanner({ mine, ready, ai }), `mine=${mine} ready=${ready} ai=${ai}`).toBe(
        expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

function beat(id: number, ms: number): Beat {
  return {
    kind: 'action',
    ms,
    events: [{ tag: 'Ko', value: { unit: id } }],
    motion: ms > 0,
  };
}

function clock(): { now: () => number; set(t: number): void } {
  let t = 0;
  return {
    now: () => t,
    set: (v) => {
      t = v;
    },
  };
}

const ids = (beats: readonly Beat[]): number[] =>
  beats.map((b) => {
    const e = b.events[0];
    return e.tag === 'Ko' ? e.value.unit : -1;
  });

describe('Playback: the injected-clock queue (BT10.5, A10)', () => {
  it('BT10-5-PLAY-SERIAL: queued beats play one after another — each completes only after its own duration from the previous end — and playing() is true until the last is returned', () => {
    // WRONG IMPL KILLED: beats started in parallel (b2 returned at t=100); a beat returned one
    // millisecond early or late (399 / 400 are the pins); a beat returned twice; playing() false
    // while beats are queued, or true after the last was returned.
    const c = clock();
    const pb = new Playback(c.now);
    expect(pb.playing(), 'idle at the start').toBe(false);
    pb.enqueue([beat(1, 400), beat(2, 100), beat(3, 1000)]);
    expect(pb.playing(), 'playing once queued').toBe(true);
    const at = (t: number): number[] => {
      c.set(t);
      return ids(pb.tick());
    };
    expect(at(0), 't=0').toEqual([]);
    expect(at(100), 't=100: b2 would be done if beats ran in parallel').toEqual([]);
    expect(at(399), 't=399').toEqual([]);
    expect(at(400), 't=400: b1 completes').toEqual([1]);
    expect(pb.playing(), 'still playing').toBe(true);
    expect(at(499), 't=499').toEqual([]);
    expect(at(500), 't=500: b2 completes').toEqual([2]);
    expect(at(1499), 't=1499').toEqual([]);
    expect(pb.playing(), 'b3 is still in flight').toBe(true);
    expect(at(1500), 't=1500: b3 completes').toEqual([3]);
    expect(pb.playing(), 'done').toBe(false);
    expect(at(9999), 'nothing is returned twice').toEqual([]);
  });

  it('BT10-5-PLAY-JUMP-ZERO: a long jump returns every elapsed beat once, in order; a 0 ms beat completes on the next tick (behind a long beat, on the tick that ends it)', () => {
    // WRONG IMPL KILLED: one beat per tick after a long frame (the queue lags the server); the
    // beats returned in the wrong order or again on the next tick; a 0 ms beat that never
    // completes (waiting for a nonzero duration) or completes before the beat in front of it.
    const c = clock();
    const pb = new Playback(c.now);
    pb.enqueue([beat(1, 400), beat(2, 100), beat(3, 1000)]);
    c.set(10_000);
    expect(ids(pb.tick()), 'one big tick returns all three, in order').toEqual([1, 2, 3]);
    expect(ids(pb.tick()), 'and none again').toEqual([]);
    expect(pb.playing(), 'idle after the jump').toBe(false);

    const z = new Playback(c.now);
    c.set(5);
    z.enqueue([beat(7, 0)]);
    expect(z.playing(), 'a queued 0 ms beat is playing').toBe(true);
    expect(ids(z.tick()), 'it completes on the next tick').toEqual([7]);
    expect(z.playing(), 'then idle').toBe(false);

    const behind = new Playback(c.now);
    c.set(0);
    behind.enqueue([beat(1, 400), beat(8, 0)]);
    c.set(399);
    expect(ids(behind.tick()), 'the 0 ms beat waits for the beat in front').toEqual([]);
    c.set(400);
    expect(ids(behind.tick()), 'both complete at 400, in order').toEqual([1, 8]);
  });

  it('BT10-5-PLAY-ENQUEUE: a beat enqueued while playing starts after the last queued beat ends, and one enqueued after an idle gap starts at the enqueue time', () => {
    // WRONG IMPL KILLED: a late beat starting at its enqueue time while another is in flight
    // (two beats at once); a beat after an idle gap starting at the OLD end time (it would be
    // returned immediately, as if it had played during the gap); enqueue replacing the queue.
    const c = clock();
    const pb = new Playback(c.now);
    pb.enqueue([beat(1, 400)]);
    c.set(100);
    pb.enqueue([beat(4, 200)]);
    c.set(399);
    expect(ids(pb.tick()), 't=399: neither').toEqual([]);
    c.set(400);
    expect(ids(pb.tick()), 't=400: b1').toEqual([1]);
    c.set(599);
    expect(ids(pb.tick()), 't=599: b4 starts at 400, not at its enqueue time 100').toEqual([]);
    c.set(600);
    expect(ids(pb.tick()), 't=600: b4').toEqual([4]);
    expect(pb.playing(), 'idle').toBe(false);

    c.set(5000);
    pb.enqueue([beat(5, 300)]);
    expect(pb.playing(), 'playing again').toBe(true);
    expect(ids(pb.tick()), 't=5000: nothing yet').toEqual([]);
    c.set(5299);
    expect(ids(pb.tick()), 't=5299: the beat starts at its enqueue time, not at 400').toEqual([]);
    c.set(5300);
    expect(ids(pb.tick()), 't=5300').toEqual([5]);
  });

  it('BT10-5-PLAY-SKIP: skip returns every beat not yet returned (the in-flight one included) in order, leaves playing() false, and later ticks return nothing', () => {
    // WRONG IMPL KILLED: skip dropping the in-flight beat (its events would never apply);
    // returning beats already returned by a tick; leaving the queue to replay on the next tick;
    // skip on an empty queue throwing or returning something; playing() true after a skip;
    // the queue unusable after a skip.
    const c = clock();
    const pb = new Playback(c.now);
    pb.enqueue([beat(1, 400), beat(2, 100), beat(3, 1000)]);
    c.set(450);
    expect(ids(pb.tick()), 'b1 completed at 400').toEqual([1]);
    expect(ids(pb.skip()), 'skip returns the in-flight b2 and the queued b3').toEqual([2, 3]);
    expect(pb.playing(), 'not playing after a skip').toBe(false);
    c.set(99_999);
    expect(ids(pb.tick()), 'a later tick returns nothing').toEqual([]);
    expect(ids(pb.skip()), 'a second skip returns nothing').toEqual([]);

    const early = new Playback(c.now);
    c.set(0);
    early.enqueue([beat(1, 400), beat(2, 100)]);
    c.set(100);
    expect(ids(early.skip()), 'skip mid first beat returns both, in order').toEqual([1, 2]);

    const empty = new Playback(c.now);
    expect(ids(empty.skip()), 'skip on an empty queue').toEqual([]);
    expect(empty.playing(), 'still idle').toBe(false);

    c.set(100_000);
    pb.enqueue([beat(6, 100)]);
    expect(pb.playing(), 'the queue works after a skip').toBe(true);
    c.set(100_100);
    expect(ids(pb.tick()), 'and plays from the new enqueue time').toEqual([6]);
  });

  it('BT10-5-PLAY-CLOCK: Playback reads only the injected clock — never Date.now, performance.now or a timer', () => {
    // WRONG IMPL KILLED: a Playback that stamps beats with Date.now() or performance.now()
    // (untestable, and a clock skew between the shell's injected `now` and the wall clock) or
    // schedules setTimeout to advance itself.
    const dateNow = vi.spyOn(Date, 'now');
    const perfNow = vi.spyOn(performance, 'now');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      const c = clock();
      const pb = new Playback(c.now);
      pb.enqueue([beat(1, 400), beat(2, 100)]);
      c.set(400);
      pb.tick();
      pb.enqueue([beat(3, 50)]);
      pb.skip();
      pb.playing();
      expect(dateNow, 'Date.now is never read').not.toHaveBeenCalled();
      expect(perfNow, 'performance.now is never read').not.toHaveBeenCalled();
      expect(timer, 'no timer is scheduled').not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      perfNow.mockRestore();
      timer.mockRestore();
    }
  });
});
