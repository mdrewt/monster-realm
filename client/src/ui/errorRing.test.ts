// ui/errorRing.test.ts — RED gating tests for pt-b1 EARS U-2 + normalizeError totality.
//
// Slice: pt-b1 · Source-of-truth: M-playtest-b F9 bug-bundle error ring.
//
// RED REASON: errorRing.ts does not exist yet. Every test fails with
//   "Failed to resolve import './errorRing'" (module-not-found).
//
// WRONG-IMPL-KILLED list:
//   - "unbounded error ring / evicts newest"  → T-ECAP-1 catches it
//   - "normalizeError throws on odd input"     → T-NORM-1 catches it (totality)
//   - "message not truncated"                  → T-NORM-1 catches it (maxLen)
//   - "source dropped/overwritten"             → T-NORM-1 / T-ERING-PUSH catch it
//   - "push does not normalize / no stamp"     → T-ERING-PUSH catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.

import { describe, expect, it } from 'vitest';
import {
  ERROR_MSG_MAX_LEN,
  ERROR_RING_CAP,
  type ErrorRecord,
  ErrorRing,
  normalizeError,
} from './errorRing';

function seqClock(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i] ?? values[values.length - 1] ?? 0;
    i += 1;
    return v;
  };
}

// ---------------------------------------------------------------------------
// T-ECAP-1 (U-2): bounded error ring evicts oldest, keeps newest, FIFO.
// ---------------------------------------------------------------------------

describe('errorRing T-ECAP-1 (U-2): cap overflow evicts oldest, keeps newest FIFO', () => {
  it('T-ECAP-1 BITES: push 5 into cap-3 ring → newest 3 in FIFO order, 2 oldest gone', () => {
    // WRONG IMPL KILLED: unbounded ring (length 5), or one that drops newest, or reverses
    // FIFO. Distinguish records by their message body (m0..m4); assert EXACT contents.
    const ring = new ErrorRing(seqClock([100, 200, 300, 400, 500]), 3);
    for (let i = 0; i < 5; i += 1) ring.push('reducer', new Error(`m${i}`));
    const snap = ring.snapshot();

    expect(snap).toHaveLength(3);
    // Newest 3 (m2,m3,m4) in FIFO (oldest→newest).
    expect(snap.map((r) => r.message)).toEqual(['m2', 'm3', 'm4']);
    // The 2 oldest gone.
    expect(snap.map((r) => r.message)).not.toContain('m0');
    expect(snap.map((r) => r.message)).not.toContain('m1');
    // tSeq strictly increasing; the surviving window starts at 3 (evicted 1,2 not reused).
    expect(snap[0]!.tSeq).toBe(3);
    expect(snap[2]!.tSeq).toBe(5);
    for (let i = 1; i < snap.length; i += 1) {
      expect(snap[i]!.tSeq).toBeGreaterThan(snap[i - 1]!.tSeq);
    }
  });

  it('T-ECAP-DEFAULT: default cap is ERROR_RING_CAP (64) — kills a hardcoded smaller cap', () => {
    // WRONG IMPL KILLED: a ctor ignoring the exported constant.
    expect(ERROR_RING_CAP).toBe(64);
    const ring = new ErrorRing(seqClock([1]));
    for (let i = 0; i < ERROR_RING_CAP + 3; i += 1) ring.push('uncaught', 'x');
    expect(ring.snapshot()).toHaveLength(ERROR_RING_CAP);
  });

  it('T-ECLEAR: clear() empties but tSeq keeps climbing (never reused)', () => {
    // WRONG IMPL KILLED: clear() that resets tSeq to 1.
    const ring = new ErrorRing(seqClock([10, 20, 30]));
    ring.push('uncaught', 'a');
    ring.push('uncaught', 'b');
    ring.clear();
    expect(ring.snapshot()).toHaveLength(0);
    ring.push('uncaught', 'c');
    expect(ring.snapshot()[0]!.tSeq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T-NORM-1: normalizeError is TOTAL and preserves source; truncates to maxLen.
// ---------------------------------------------------------------------------

describe('errorRing T-NORM-1: normalizeError totality + shaping', () => {
  it('T-NORM-ERROR: Error -> its .message; source preserved', () => {
    // WRONG IMPL KILLED: an impl that String()s the whole Error ("Error: boom") instead of
    // taking .message, or that hardcodes the source.
    const out = normalizeError('reducer', new Error('boom'));
    expect(out.message).toBe('boom');
    expect(out.source).toBe('reducer');
  });

  it('T-NORM-STRING: a plain string -> itself', () => {
    // WRONG IMPL KILLED: an impl that wraps strings in quotes / JSON.stringify.
    expect(normalizeError('uncaught', 'plain text').message).toBe('plain text');
  });

  it('T-NORM-OTHER: number / object / null / undefined -> String(raw), never throws', () => {
    // WRONG IMPL KILLED: an impl that assumes .message exists (throws on number/null).
    expect(normalizeError('uncaught', 42).message).toBe('42');
    expect(normalizeError('uncaught', { a: 1 }).message).toBe(String({ a: 1 })); // "[object Object]"
    expect(normalizeError('uncaught', null).message).toBe('null');
    expect(normalizeError('uncaught', undefined).message).toBe('undefined');
  });

  it('T-NORM-TRUNC BITES: message longer than maxLen is truncated to EXACTLY maxLen', () => {
    // WRONG IMPL KILLED: an impl that never truncates (bundle bloat / OOM risk) or that
    // truncates to maxLen-1/maxLen+1. Use maxLen=10 on a 50-char message.
    const long = 'x'.repeat(50);
    const out = normalizeError('unhandledrejection', long, 10);
    expect(out.message.length).toBe(10);
    expect(out.message).toBe('x'.repeat(10));
  });

  it('T-NORM-DEFAULT-MAXLEN: default maxLen is ERROR_MSG_MAX_LEN (512)', () => {
    // WRONG IMPL KILLED: a default that differs from the exported constant.
    expect(ERROR_MSG_MAX_LEN).toBe(512);
    const long = 'y'.repeat(ERROR_MSG_MAX_LEN + 100);
    expect(normalizeError('reducer', long).message.length).toBe(ERROR_MSG_MAX_LEN);
  });

  it('T-NORM-TOTAL BITES: never throws for a batch of weird inputs (fuzz-ish)', () => {
    // Encodes the contract's headline "Pure, TOTAL (never throws)" clause: even the
    // fallback `String(raw)` must be try/caught, because String() itself THROWS on a
    // hostile toString or a null-prototype object. A literal `String(raw)` with no guard
    // is thus a spec violation this test bites.
    // WRONG IMPL KILLED: any input shape that trips an unguarded .message / .toString / String().
    const weird: unknown[] = [
      0,
      -0,
      Number.NaN,
      Infinity,
      false,
      true,
      Symbol('s'),
      [],
      [1, 2, 3],
      {
        toString() {
          throw new Error('nope');
        },
      }, // hostile toString
      Object.create(null), // no prototype -> String() must still be safe
      10n, // bigint
      () => 1, // function
    ];
    for (const raw of weird) {
      expect(() => normalizeError('uncaught', raw)).not.toThrow();
      // And the result is always a { source, message } with a string message.
      const out = normalizeError('reducer', raw);
      expect(out.source).toBe('reducer');
      expect(typeof out.message).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// T-ERING-PUSH: ring.push normalizes + stamps tSeq/tMs and records source.
// ---------------------------------------------------------------------------

describe('errorRing T-ERING-PUSH: push normalizes + stamps', () => {
  it('T-ERING-PUSH BITES: push("reducer", Error("x")) -> record{source,message,tSeq,tMs}', () => {
    // WRONG IMPL KILLED: a push() that stores the raw Error object (not normalized),
    // or that omits tSeq/tMs, or that hardcodes source.
    const ring = new ErrorRing(seqClock([777]));
    ring.push('reducer', new Error('x'));
    const [rec] = ring.snapshot() as [ErrorRecord];
    expect(rec.source).toBe('reducer');
    expect(rec.message).toBe('x'); // normalized to .message, not "Error: x"
    expect(rec.tSeq).toBe(1);
    expect(rec.tMs).toBe(777);
  });

  it('T-ERING-PUSH-SEQ: successive pushes increment tSeq and stamp the clock', () => {
    // WRONG IMPL KILLED: a push that reuses tSeq or ignores the injected clock.
    const ring = new ErrorRing(seqClock([1, 2, 3]));
    ring.push('uncaught', 'a');
    ring.push('unhandledrejection', 'b');
    ring.push('reducer', 'c');
    const snap = ring.snapshot();
    expect(snap.map((r) => r.tSeq)).toEqual([1, 2, 3]);
    expect(snap.map((r) => r.tMs)).toEqual([1, 2, 3]);
    expect(snap.map((r) => r.source)).toEqual(['uncaught', 'unhandledrejection', 'reducer']);
  });
});
