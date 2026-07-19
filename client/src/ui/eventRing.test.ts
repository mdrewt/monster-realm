// ui/eventRing.test.ts — RED gating tests for pt-b1 EARS U-1, U-3 + HP/SEQ invariants.
//
// Slice: pt-b1 · Source-of-truth: M-playtest-b F9 bug-bundle event ring.
//
// RED REASON: eventRing.ts does not exist yet. Every test below fails with
//   "Failed to resolve import './eventRing'" (module-not-found).
//
// WRONG-IMPL-KILLED list (one per bite):
//   - "unbounded ring / evicts newest"       → T-CAP-1 catches it (keeps NEWEST, FIFO)
//   - "tSeq resets/reuses after eviction"     → T-SEQ catches it (monotonic, never reused)
//   - "tMs from Date.now not injected clock"  → T-SEQ catches it (fake clock stamps)
//   - "payload leaks a name/PII field"        → T-NOPII-1 catches it (14 variants, no name keys)
//   - "disconnect carries an identity"        → T-NOPII-1 catches it (disconnect has no identity)
//   - "hpPermille wrong scale / no clamp / div0 throws" → T-HP-1 catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.

import { describe, expect, it } from 'vitest';
import {
  EVENT_RING_CAP,
  EventRing,
  makeBattleEnd,
  makeBattleStart,
  makeBoxOpen,
  makeConnect,
  makeDisconnect,
  makeMonsterRelease,
  makePreRecruitHp,
  makeRankedMatch,
  makeReCatch,
  makeRecruitAttempt,
  makeRecruitResult,
  makeTradeConfirm,
  makeTradePropose,
  makeZoneChange,
  type PlaytestEvent,
  type PlaytestEventPayload,
} from './eventRing';

// A deterministic clock: returns a caller-controlled sequence of millis. Injected so
// tMs is provably from the clock, never Date.now() (netcode-determinism precedent).
function seqClock(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i] ?? values[values.length - 1] ?? 0;
    i += 1;
    return v;
  };
}

// ---------------------------------------------------------------------------
// T-CAP-1 (EARS U-1): bounded ring evicts OLDEST, keeps NEWEST in FIFO order.
// ---------------------------------------------------------------------------

describe('eventRing T-CAP-1 (U-1): cap overflow evicts oldest, keeps newest FIFO', () => {
  it('T-CAP-1 BITES: push 7 into cap-4 ring → newest 4 in FIFO order, 3 oldest gone', () => {
    // WRONG IMPL KILLED: an unbounded ring (length 7), or one that drops the NEWEST
    // instead of the oldest, or that reverses FIFO order. We push 7 zoneChange payloads
    // whose toZone distinguishes them (10..16) and assert the EXACT post-burst contents.
    const ring = new EventRing(seqClock([100, 200, 300, 400, 500, 600, 700]), 4);
    for (let z = 10; z <= 16; z += 1) {
      ring.push(makeZoneChange(0, z));
    }
    const snap = ring.snapshot();

    // Exactly the cap remains.
    expect(snap).toHaveLength(4);

    // The 4 remaining are the NEWEST (toZone 13,14,15,16) in FIFO (oldest→newest) order.
    const zones = snap.map((e) => (e.kind === 'zoneChange' ? e.toZone : -1));
    expect(zones).toEqual([13, 14, 15, 16]);

    // The 3 oldest (toZone 10,11,12) are GONE — assert absence, not just length.
    expect(zones).not.toContain(10);
    expect(zones).not.toContain(11);
    expect(zones).not.toContain(12);

    // tSeq strictly increasing across the retained window.
    for (let i = 1; i < snap.length; i += 1) {
      expect(snap[i]!.tSeq).toBeGreaterThan(snap[i - 1]!.tSeq);
    }
    // The 3 evicted tSeqs (1,2,3) must NOT reappear — retained window starts at 4.
    expect(snap[0]!.tSeq).toBe(4);
    expect(snap[3]!.tSeq).toBe(7);
  });

  it('T-CAP-DEFAULT: default cap is EVENT_RING_CAP (256) — kills a hardcoded smaller cap', () => {
    // WRONG IMPL KILLED: a ctor that ignores the exported cap constant.
    expect(EVENT_RING_CAP).toBe(256);
    const ring = new EventRing(seqClock([1]));
    // Push cap+5 and assert it caps at exactly EVENT_RING_CAP.
    for (let i = 0; i < EVENT_RING_CAP + 5; i += 1) ring.push(makeBoxOpen());
    expect(ring.snapshot()).toHaveLength(EVENT_RING_CAP);
  });

  it('T-CLEAR: clear() empties the ring but tSeq keeps climbing (never reused)', () => {
    // WRONG IMPL KILLED: a clear() that resets tSeq to 1 (would reuse a stamp).
    const ring = new EventRing(seqClock([10, 20, 30]));
    ring.push(makeBoxOpen());
    ring.push(makeBoxOpen());
    expect(ring.snapshot()).toHaveLength(2);
    ring.clear();
    expect(ring.snapshot()).toHaveLength(0);
    ring.push(makeBoxOpen());
    // tSeq must continue from 3 (never restart at 1) — monotonic across clear.
    expect(ring.snapshot()[0]!.tSeq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T-SEQ: tSeq starts at 1, +1 per push, never reused; tMs comes from the clock.
// ---------------------------------------------------------------------------

describe('eventRing T-SEQ: monotonic tSeq + injected clock tMs', () => {
  it('T-SEQ BITES: tSeq is 1,2,3… and tMs mirrors the injected clock values', () => {
    // WRONG IMPL KILLED: tSeq starting at 0 or 5; tMs from Date.now() (would not equal
    // the fake clock's 100/200/300). The fake clock returns exactly 100,200,300.
    const ring = new EventRing(seqClock([100, 200, 300]));
    ring.push(makeBoxOpen());
    ring.push(makeBoxOpen());
    ring.push(makeBoxOpen());
    const snap = ring.snapshot();
    expect(snap.map((e) => e.tSeq)).toEqual([1, 2, 3]);
    expect(snap.map((e) => e.tMs)).toEqual([100, 200, 300]);
  });

  it('T-SEQ-NO-REUSE: after eviction, the retained tSeqs never repeat an evicted stamp', () => {
    // WRONG IMPL KILLED: a ring that recycles slot indices as tSeq (would reuse 1..3).
    const ring = new EventRing(seqClock([1, 2, 3, 4, 5]), 2);
    for (let i = 0; i < 5; i += 1) ring.push(makeBoxOpen());
    const seqs = ring.snapshot().map((e) => e.tSeq);
    // Cap 2, 5 pushes → last two tSeqs are 4 and 5; nothing ≤ 3 survives.
    expect(seqs).toEqual([4, 5]);
  });
});

// ---------------------------------------------------------------------------
// T-NOPII-1 (U-3): NO name-ish keys anywhere; disconnect has no identity;
//                   identity-hex only appears where legal (connect).
// ---------------------------------------------------------------------------

describe('eventRing T-NOPII-1 (U-3): payloads carry no PII / name fields', () => {
  const NAME_KEYS = ['name', 'displayName', 'nickname', 'playerName'];
  const CANARY_IDENTITY = '0xCANARYNAME';

  // Build one of EVERY 14 variant. identity-hex is passed ONLY where legal (connect).
  const allPayloads: PlaytestEventPayload[] = [
    makeConnect(CANARY_IDENTITY),
    makeDisconnect(),
    makeZoneChange(1, 2),
    makeBattleStart('b1', true),
    makeBattleEnd('b1', 'sideAWins', 7),
    makePreRecruitHp('b1', 30, 60),
    makeRecruitAttempt('b1', 42),
    makeRecruitResult('b1', true),
    makeBoxOpen(),
    makeMonsterRelease(9),
    makeReCatch(9),
    makeTradePropose('t1'),
    makeTradeConfirm('t1'),
    makeRankedMatch('b1', 24),
  ];

  it('T-NOPII-COUNT: exactly 14 discriminated variants exist (kills a dropped constructor)', () => {
    // WRONG IMPL KILLED: a constructor set missing a variant would leave undefined in the
    // array; assert all 14 produced defined objects with a `kind`.
    expect(allPayloads).toHaveLength(14);
    for (const p of allPayloads) {
      expect(typeof p.kind).toBe('string');
    }
  });

  it('T-NOPII-1 BITES: no payload JSON contains a name-ish key or a free-text name value', () => {
    // WRONG IMPL KILLED: a constructor that smuggles a player name field into a payload.
    for (const payload of allPayloads) {
      const keys = Object.keys(payload as Record<string, unknown>);
      for (const bad of NAME_KEYS) {
        expect(keys, `variant ${payload.kind} must not carry key "${bad}"`).not.toContain(bad);
      }
    }
  });

  it('T-NOPII-DISCONNECT BITES: disconnect payload has NO identity key', () => {
    // WRONG IMPL KILLED: makeDisconnect that copies the connect identity (leaks a hex to
    // an event that must be bare). disconnect is the identity-free variant.
    const d = makeDisconnect();
    expect(Object.keys(d as Record<string, unknown>)).toEqual(['kind']);
    expect((d as Record<string, unknown>).identity).toBeUndefined();
  });

  it('T-NOPII-CONNECT: connect carries the identity-hex (allowed) and nothing else', () => {
    // WRONG IMPL KILLED: makeConnect that drops the identity, OR that adds a name field.
    const c = makeConnect(CANARY_IDENTITY);
    expect(c).toEqual({ kind: 'connect', identity: CANARY_IDENTITY });
  });

  it('T-NOPII-STAMP: the ring adds ONLY tSeq/tMs to the payload (no extra fields)', () => {
    // WRONG IMPL KILLED: a push() that decorates the record with a name/identity field.
    const ring = new EventRing(seqClock([500]));
    ring.push(makeZoneChange(3, 4));
    const [e] = ring.snapshot() as [PlaytestEvent];
    // Envelope = payload + exactly tSeq + tMs.
    expect(e).toEqual({ kind: 'zoneChange', fromZone: 3, toZone: 4, tSeq: 1, tMs: 500 });
  });
});

// ---------------------------------------------------------------------------
// T-HP-1: makePreRecruitHp permille = clamp(round(cur/max*1000),0,1000); max<=0 => 0.
// ---------------------------------------------------------------------------

describe('eventRing T-HP-1: makePreRecruitHp permille scaling / clamp / div0', () => {
  function permille(cur: number, max: number): number {
    const p = makePreRecruitHp('b1', cur, max);
    // Narrow to the preRecruitHp variant to read hpPermille.
    if (p.kind !== 'preRecruitHp') throw new Error('expected preRecruitHp payload');
    return p.hpPermille;
  }

  it('T-HP-1 BITES: (50,100)->500, (100,100)->1000, (0,100)->0 — kills wrong-scale impl', () => {
    // WRONG IMPL KILLED: a permille that uses percent (would give 50/100/0) or fraction.
    expect(permille(50, 100)).toBe(500);
    expect(permille(100, 100)).toBe(1000);
    expect(permille(0, 100)).toBe(0);
  });

  it('T-HP-CLAMP BITES: (150,100)->1000 (upper clamp), negative cur clamps to 0', () => {
    // WRONG IMPL KILLED: a permille without clamp — overheal would exceed 1000.
    expect(permille(150, 100)).toBe(1000);
    expect(permille(-5, 100)).toBe(0);
  });

  it('T-HP-DIV0 BITES: (10,0)->0 (max<=0 div-safe), (10,-3)->0 — kills NaN/Infinity leak', () => {
    // WRONG IMPL KILLED: a naive cur/max that yields Infinity/NaN when max<=0.
    expect(permille(10, 0)).toBe(0);
    expect(permille(10, -3)).toBe(0);
  });

  it('T-HP-ROUND BITES: (1,3)->333 (round, not floor/ceil) — kills truncation impl', () => {
    // 1/3*1000 = 333.33 → round → 333. A ceil impl gives 334; floor gives 333 here, so
    // also pin (2,3)->667 where round≠floor (666.67 → 667, floor would give 666).
    expect(permille(1, 3)).toBe(333);
    expect(permille(2, 3)).toBe(667);
  });
});
