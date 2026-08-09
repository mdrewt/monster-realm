// pair.test.mjs — m20e T2 gate + G8 seeded-ambiguity fixture (TDD RED).
//
// Encodes OBS-42 (a duration ONLY from a matched enter/exit pair, never
// estimated or backfilled) and OBS-43 (pair and order by the host-populated
// `ts`, not by file-tail arrival order) against the NOT-YET-WRITTEN './pair.mjs'.
// RED today because that module does not exist.
//
// G8 (spec:663, ADR-0180:792) is the seeded-ambiguity proof-of-teeth: two
// interleaved zone-tick chains that must not cross-pollinate. A fixture that
// every implementation passes proves nothing, so this file also carries a
// DELIBERATELY BROKEN LIFO pairer and asserts the SAME fixture fails through it.
// That is the assertion that makes the fixture discriminating rather than
// decorative (anti-pattern 3).
//
// PINNED ORDERING CONTRACT (the implementer must satisfy exactly this):
//   crumbs are ordered by BigInt(ts) ascending; ties break `enter` before
//   `exit`, then by correlation key, then by reducer. The order is a function of
//   the crumbs alone and NEVER of their arrival order — which is what makes the
//   shuffle-invariance assertion below meaningful.
//   Pairing is FIFO within one EXACT (reducer, correlationKey) tuple.
//
// Discipline: no `new RegExp(`, no regex literals, no clock, no I/O. Every
// fixture is an inline literal built by the `crumb` helper.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairBreadcrumbs } from './pair.mjs';
import { correlationKey } from './parse.mjs';

// ---------------------------------------------------------------------------
// Fixture helper — the crumb shape parse.mjs's parseBreadcrumb produces.
// ---------------------------------------------------------------------------
function crumb(reducer, ts, phase, cause, sched = null) {
  return { reducer, ts, phase, cause, sched };
}

function schedOf(targetReducer, scheduledAt) {
  return { target_reducer: targetReducer, scheduled_at: scheduledAt };
}

/**
 * The DELIBERATELY BROKEN pairer: one global stack, last-enter-wins, key
 * ignored. This is the most natural wrong implementation of "pair enter/exit"
 * and it is what the G8 fixture exists to reject.
 */
function brokenLifoPair(crumbs) {
  const stack = [];
  const spans = [];
  for (const c of crumbs) {
    if (c.phase === 'enter') {
      stack.push(c);
      continue;
    }
    const open = stack.pop();
    if (open === undefined) continue;
    spans.push({
      key: correlationKey(open),
      reducer: open.reducer,
      startMicros: open.ts,
      endMicros: c.ts,
      durationMicros: String(BigInt(c.ts) - BigInt(open.ts)),
    });
  }
  return spans;
}

// Two interleaved zone-tick chains with DISTINCT cause keys, arriving
// enter(A), enter(B), exit(A), exit(B) — the classic interleave.
const INTERLEAVED = [
  crumb('zone_tick', '1782197246181000', 'enter', 'zone:a'),
  crumb('zone_tick', '1782197246182000', 'enter', 'zone:b'),
  crumb('zone_tick', '1782197246183000', 'exit', 'zone:a'),
  crumb('zone_tick', '1782197246184000', 'exit', 'zone:b'),
];

// ---------------------------------------------------------------------------
// 1. G8 — distinct keys never cross-pollinate
// ---------------------------------------------------------------------------

test('G8: two interleaved chains with distinct keys produce exactly two correctly-bounded spans', () => {
  const { spans, unpaired, counts } = pairBreadcrumbs(INTERLEAVED);
  assert.equal(spans.length, 2, 'exactly two spans');
  assert.equal(unpaired.length, 0, 'nothing is left over');
  assert.deepEqual(spans[0], {
    key: 'cause:zone:a',
    reducer: 'zone_tick',
    startMicros: '1782197246181000',
    endMicros: '1782197246183000',
    durationMicros: '2000',
  });
  assert.deepEqual(spans[1], {
    key: 'cause:zone:b',
    reducer: 'zone_tick',
    startMicros: '1782197246182000',
    endMicros: '1782197246184000',
    durationMicros: '2000',
  });
  assert.deepEqual(counts, { total: 4, paired: 2, unpaired: 0, skippedNoKey: 0 });
});

test('G8 PROOF-OF-TEETH: the same fixture through a LIFO pairer produces the WRONG pairing', () => {
  // The LIFO pairer matches each exit with the most recently opened enter,
  // ignoring the key: exit(A)@t3 pops B's enter@t2 and exit(B)@t4 pops A's
  // enter@t1. It therefore reports (t2,t3) labelled `zone:b` and (t1,t4)
  // labelled `zone:a` — both bounds and one duration wrong, on a fixture whose
  // span COUNT is still 2. If these expectations ever start matching the real
  // pairer's output, the G8 fixture has stopped discriminating.
  const wrong = brokenLifoPair(INTERLEAVED);
  assert.equal(wrong.length, 2, 'the broken pairer still emits two spans — count alone is no gate');
  assert.equal(wrong[0].startMicros, '1782197246182000', 'LIFO pairs B-enter with A-exit');
  assert.equal(wrong[0].endMicros, '1782197246183000');
  assert.equal(wrong[0].key, 'cause:zone:b', 'and mislabels the span with the wrong chain');
  assert.equal(wrong[1].startMicros, '1782197246181000');
  assert.equal(wrong[1].endMicros, '1782197246184000');
  assert.equal(wrong[1].durationMicros, '3000', 'inflating A from 2000us to 3000us');

  // Stated as the discrimination it is: the correct result and the broken one
  // must not coincide on this fixture.
  const { spans } = pairBreadcrumbs(INTERLEAVED);
  assert.notDeepEqual(spans, wrong, 'the G8 fixture must SEPARATE a keyed pairer from a LIFO one');
});

// ---------------------------------------------------------------------------
// 2. OBS-43 — ordering is by ts, not by arrival
// ---------------------------------------------------------------------------

test('OBS-43: reverse arrival and a rotation produce byte-identical output', () => {
  const canonical = JSON.stringify(pairBreadcrumbs(INTERLEAVED));
  const reversed = JSON.stringify(pairBreadcrumbs([...INTERLEAVED].reverse()));
  const rotated = JSON.stringify(
    pairBreadcrumbs([INTERLEAVED[2], INTERLEAVED[0], INTERLEAVED[3], INTERLEAVED[1]]),
  );
  assert.equal(reversed, canonical, 'reverse arrival must not change one byte of the result');
  assert.equal(rotated, canonical, 'a rotation must not change one byte of the result');
});

test('OBS-43: an exit that ARRIVES before its enter still pairs the right way round', () => {
  // The log-rotation / relay-restart case the criterion names explicitly.
  const outOfOrder = [
    crumb('sync_content', '1782197246189000', 'exit', 'zone:c'),
    crumb('sync_content', '1782197246187000', 'enter', 'zone:c'),
  ];
  const { spans, unpaired } = pairBreadcrumbs(outOfOrder);
  assert.equal(unpaired.length, 0);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startMicros, '1782197246187000', 'the EARLIER ts is the start');
  assert.equal(spans[0].endMicros, '1782197246189000');
  assert.equal(spans[0].durationMicros, '2000', 'never negative, never inverted');
});

test('AM6: mixed-digit-length ts values order numerically, not lexicographically', () => {
  // '999' sorts AFTER '1000000000000000' as a string and BEFORE it as a number.
  // A string-sorting pairer sees exit-then-enter here and reports two unpaired
  // crumbs and zero spans.
  const mixed = [
    crumb('sync_content', '999', 'enter', 'zone:d'),
    crumb('sync_content', '1000000000000000', 'exit', 'zone:d'),
  ];
  assert.ok('999' > '1000000000000000', 'FIXTURE: these must disagree lexicographically');
  assert.ok(BigInt('999') < BigInt('1000000000000000'), 'and agree numerically');

  const { spans, unpaired, counts } = pairBreadcrumbs(mixed);
  assert.equal(unpaired.length, 0, 'a lexicographic sort leaves both crumbs unpaired');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startMicros, '999');
  assert.equal(spans[0].endMicros, '1000000000000000');
  assert.equal(spans[0].durationMicros, '999999999999001');
  assert.equal(counts.paired, 1);
});

test('OBS-42: durations above 2^53 are exact — BigInt subtraction, never Number', () => {
  const big = [
    crumb('sync_content', '9007199254740993', 'enter', 'zone:e'),
    crumb('sync_content', '9007199254740995', 'exit', 'zone:e'),
  ];
  const { spans } = pairBreadcrumbs(big);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].durationMicros, '2', 'the true difference is 2 microseconds');
  // Independent oracle proving the tooth bites: the Number path reports 4.
  assert.equal(
    Number('9007199254740995') - Number('9007199254740993'),
    4,
    'FIXTURE: these values must be ones the double path corrupts',
  );
});

// ---------------------------------------------------------------------------
// 3. AM7 — seeded ambiguity: a REUSED key across two unrelated chains
// ---------------------------------------------------------------------------

test('AM7: a reused CAUSE key across two unrelated chains pairs FIFO by ts', () => {
  // The documented, D15-disclosed, imperfect behaviour: with the same cause
  // value there is nothing left to distinguish the chains, so the earliest open
  // enter takes the earliest exit. Pinned here so a future change is a visible
  // decision rather than a silent drift.
  const reused = [
    crumb('battle_tick', '1782197246191000', 'enter', 'battle:7'),
    crumb('battle_tick', '1782197246192000', 'enter', 'battle:7'),
    crumb('battle_tick', '1782197246193000', 'exit', 'battle:7'),
    crumb('battle_tick', '1782197246194000', 'exit', 'battle:7'),
  ];
  const { spans, unpaired, counts } = pairBreadcrumbs(reused);
  assert.equal(unpaired.length, 0);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].startMicros, '1782197246191000');
  assert.equal(spans[0].endMicros, '1782197246193000', 'FIFO: first enter takes the FIRST exit');
  assert.equal(spans[1].startMicros, '1782197246192000');
  assert.equal(spans[1].endMicros, '1782197246194000');
  assert.equal(counts.paired, 2);
  // A LIFO pairer would report (t2,t3) and (t1,t4) instead — the same two spans
  // with swapped bounds, so the durations are the discriminator.
  assert.equal(spans[0].durationMicros, '2000');
  assert.equal(spans[1].durationMicros, '2000');
});

test('AM7: a reused SCHED key behaves identically — the key is target_reducer + scheduled_at', () => {
  const sched = schedOf('sync_content', 1782197250000);
  const reused = [
    crumb('init', '1782197246191000', 'enter', null, sched),
    crumb('init', '1782197246192000', 'enter', null, sched),
    crumb('init', '1782197246193000', 'exit', null, sched),
    crumb('init', '1782197246194000', 'exit', null, sched),
  ];
  const { spans, unpaired } = pairBreadcrumbs(reused);
  assert.equal(unpaired.length, 0);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].key, 'sched:sync_content@1782197250000');
  assert.equal(spans[0].startMicros, '1782197246191000');
  assert.equal(spans[0].endMicros, '1782197246193000');
  assert.equal(spans[1].startMicros, '1782197246192000');
  assert.equal(spans[1].endMicros, '1782197246194000');
});

test('AM7: two DIFFERENT scheduled_at values are two different keys, not one', () => {
  const chains = [
    crumb('init', '1782197246191000', 'enter', null, schedOf('sync_content', 1782197250000)),
    crumb('init', '1782197246192000', 'enter', null, schedOf('sync_content', 1782197260000)),
    crumb('init', '1782197246193000', 'exit', null, schedOf('sync_content', 1782197250000)),
    crumb('init', '1782197246194000', 'exit', null, schedOf('sync_content', 1782197260000)),
  ];
  const { spans } = pairBreadcrumbs(chains);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].key, 'sched:sync_content@1782197250000');
  assert.equal(spans[0].endMicros, '1782197246193000');
  assert.equal(spans[1].key, 'sched:sync_content@1782197260000');
  assert.equal(spans[1].endMicros, '1782197246194000');
});

// ---------------------------------------------------------------------------
// 4. OBS-42 — unpaired crumbs are diagnostic-only, NEVER a span (AM9)
// ---------------------------------------------------------------------------

test('OBS-42/AM9: an exit with no open enter is unpaired — never cross-matched, never a span', () => {
  const orphanExit = [
    crumb('zone_tick', '1782197246181000', 'enter', 'zone:a'),
    crumb('zone_tick', '1782197246183000', 'exit', 'zone:zzz'),
  ];
  const { spans, unpaired, counts } = pairBreadcrumbs(orphanExit);
  assert.equal(spans.length, 0, 'a lone enter and a lone exit are NOT a pair');
  assert.equal(unpaired.length, 2);
  assert.deepEqual(unpaired[0], {
    key: 'cause:zone:a',
    reducer: 'zone_tick',
    ts: '1782197246181000',
    phase: 'enter',
  });
  assert.deepEqual(unpaired[1], {
    key: 'cause:zone:zzz',
    reducer: 'zone_tick',
    ts: '1782197246183000',
    phase: 'exit',
  });
  assert.deepEqual(counts, { total: 2, paired: 0, unpaired: 2, skippedNoKey: 0 });
});

test('OBS-42: the SAME key under a DIFFERENT reducer never matches — the tuple is (reducer, key)', () => {
  const crossReducer = [
    crumb('zone_tick', '1782197246181000', 'enter', 'zone:a'),
    crumb('battle_tick', '1782197246183000', 'exit', 'zone:a'),
  ];
  const { spans, unpaired, counts } = pairBreadcrumbs(crossReducer);
  assert.equal(spans.length, 0, 'a shared cause value across two reducers is not one call');
  assert.equal(unpaired.length, 2);
  assert.equal(counts.paired, 0);
  assert.equal(counts.unpaired, 2);
});

test('OBS-42: an enter with no exit is unpaired — no zero-duration span, no backfilled end', () => {
  const orphanEnter = [crumb('zone_tick', '1782197246181000', 'enter', 'zone:a')];
  const { spans, unpaired, counts } = pairBreadcrumbs(orphanEnter);
  assert.equal(spans.length, 0, 'emitting a zero-duration span here is the disguised estimate');
  assert.equal(unpaired.length, 1);
  assert.equal(unpaired[0].phase, 'enter');
  assert.deepEqual(counts, { total: 1, paired: 0, unpaired: 1, skippedNoKey: 0 });
});

test('OBS-42: a crumb with no correlation key is skippedNoKey — counted, never guessed', () => {
  const keyless = [
    crumb('sync_content', '1782197246181000', 'enter', null, null),
    crumb('sync_content', '1782197246183000', 'exit', null, null),
  ];
  const { spans, unpaired, counts } = pairBreadcrumbs(keyless);
  assert.equal(spans.length, 0, 'two keyless crumbs must not be paired on adjacency');
  assert.equal(unpaired.length, 0, 'keyless crumbs are NOT unpaired — they were never candidates');
  assert.deepEqual(counts, { total: 2, paired: 0, unpaired: 0, skippedNoKey: 2 });
});

// ---------------------------------------------------------------------------
// 5. Counts are a closed book
// ---------------------------------------------------------------------------

test('counts: total === paired*2 + unpaired + skippedNoKey over a mixed fixture', () => {
  const mixed = [
    ...INTERLEAVED,
    crumb('battle_tick', '1782197246185000', 'exit', 'battle:1'),
    crumb('sync_content', '1782197246186000', 'enter', null, null),
    crumb('init', '1782197246187000', 'enter', null, schedOf('sync_content', 1782197250000)),
    crumb('init', '1782197246188000', 'exit', null, schedOf('sync_content', 1782197250000)),
  ];
  const { spans, unpaired, counts } = pairBreadcrumbs(mixed);
  assert.equal(counts.total, 8);
  assert.equal(counts.paired, spans.length);
  assert.equal(counts.unpaired, unpaired.length);
  assert.equal(
    counts.total,
    counts.paired * 2 + counts.unpaired + counts.skippedNoKey,
    'every crumb is accounted for exactly once',
  );
  assert.equal(counts.paired, 3);
  assert.equal(counts.unpaired, 1);
  assert.equal(counts.skippedNoKey, 1);
});

test('pairBreadcrumbs: empty input is an empty, well-formed result — not a throw', () => {
  const r = pairBreadcrumbs([]);
  assert.deepEqual(r.spans, []);
  assert.deepEqual(r.unpaired, []);
  assert.deepEqual(r.counts, { total: 0, paired: 0, unpaired: 0, skippedNoKey: 0 });
});
