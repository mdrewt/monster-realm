// observability/interpGap.test.ts — AM2.
//
// SOURCE OF TRUTH: AM2 — "`maxRemoteGapMs` logic gets a named home … imports
// `adaptiveInterpDelayMs` from render/interpolation.ts:133 (NEVER copies it), reduces to max;
// own-entity exclusion is handled at the CALL SITE (main.ts passes remotes only); zero remotes ⇒
// no sample; max, not sum."
//
// WHAT THE SIGNAL MEANS: `mr_client_interp_gap_ms` is how far in the PAST the worst remote
// character is being rendered right now (ADR-0090's adaptive delay). It rises when the network
// jitters, which is precisely when players report "other people teleport". The number is only
// comparable across builds if it is the SAME number the renderer actually used — hence the
// import, not a re-derivation.
//
// WHY THE MAX AND NOT THE SUM/MEAN: the metric answers "how stale is the worst thing on screen".
// A sum has no physical meaning and grows with the number of players in the zone (so a busy zone
// would look like a network problem); a mean hides the one badly-connected remote that is
// actually visible as stutter.
//
// THE CALL-SITE HALF of AM2 (own entity excluded, sampled once per closed frame window) is
// pinned in main.wiring.test.ts's m20c block — it cannot be seen from here.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { adaptiveInterpDelayMs } from '../render/interpolation';
import { maxRemoteGapMs } from './interpGap';

/** The live server cadence (game-core `step_ms()`); main.ts passes the wasm-derived STEP_MS. */
const STEP_MS = 200;

/** The shape `maxRemoteGapMs` consumes — structurally satisfied by `StoredCharacter`,
 *  so main.ts can pass store rows straight through with no adapter. */
type Remote = { readonly jitterEwma: number; readonly row: { readonly zoneId: number } };
/** The zone main.ts is drawing in these tests. */
const ZONE = 3;
function remote(jitterEwma: number, zoneId: number = ZONE): Remote {
  return { jitterEwma, row: { zoneId } };
}

describe('maxRemoteGapMs (AM2): zero remotes produce NO sample', () => {
  it('AM2-empty: an empty list returns undefined — never 0, never NaN', () => {
    // WRONG IMPL KILLED (1): `Math.max(...[])` returns -Infinity, which would be recorded into
    //   the histogram and land below every boundary — a permanent fake "0ms gap" datapoint for
    //   every solo player, which is most of a playtest.
    // WRONG IMPL KILLED (2): a `0` fallback. Zero is a MEANINGFUL value here (it would mean "no
    //   interpolation delay at all"), so it cannot double as "nothing to report". `undefined`
    //   forces the caller to skip the record() call entirely.
    expect(maxRemoteGapMs([], ZONE, STEP_MS)).toBeUndefined();
    expect(maxRemoteGapMs(new Map<string, Remote>().values(), ZONE, STEP_MS)).toBeUndefined();
  });
});

describe('maxRemoteGapMs (AM2): the value IS adaptiveInterpDelayMs, imported not copied', () => {
  it('AM2-single: one remote yields exactly adaptiveInterpDelayMs(jitter, stepMs)', () => {
    // Compared against the IMPORTED function rather than a hand-written expected number, so the
    // two can never disagree: if ADR-0090's formula is retuned, this test retunes with it.
    for (const jitter of [0, 5, 25, 50, 120]) {
      expect(maxRemoteGapMs([remote(jitter)], ZONE, STEP_MS)).toBe(
        adaptiveInterpDelayMs(jitter, STEP_MS),
      );
    }
  });

  it('AM2-clamp: a huge jitter is CLAMPED exactly as the renderer clamps it (the copy-drift tooth)', () => {
    // THE TOOTH AM2 EXISTS FOR. A copied formula almost always copies the arithmetic
    // (`base + 2×jitter`) and drops the MIN/MAX clamps, because the clamp constants live in
    // render/config.ts and are easy to miss. With a 10s jitter estimate the copy reports
    // 20 200ms while the renderer actually used 500ms (2.5 × stepMs) — the metric would then be
    // a fabrication that no dashboard reader could ever reconcile with what they see on screen.
    const huge = 10_000;
    const expected = adaptiveInterpDelayMs(huge, STEP_MS);
    expect(maxRemoteGapMs([remote(huge)], ZONE, STEP_MS)).toBe(expected);
    // Sanity on the fixture itself: the clamp really is engaged here, so the assertion above is
    // discriminating rather than trivially true.
    expect(expected).toBeLessThan(STEP_MS + 2 * huge);
  });

  it('AM2-max-not-sum: the reduction is MAX over remotes', () => {
    // WRONG IMPL KILLED (1): a sum (or a `reduce((a, b) => a + b)` typo). With 8 remotes in a
    //   zone the reported gap would be ~8× the truth and would scale with population, so a busy
    //   zone would page as a network incident.
    // WRONG IMPL KILLED (2): a mean, which hides the single stuttering remote that is the whole
    //   reason to measure this.
    // WRONG IMPL KILLED (3): "first" or "last" (an unsorted `[0]` pick), which is right by luck
    //   in a two-element fixture — hence three remotes with the max in the MIDDLE.
    const jitters = [10, 120, 40];
    const expected = Math.max(...jitters.map((j) => adaptiveInterpDelayMs(j, STEP_MS)));
    const got = maxRemoteGapMs(
      jitters.map((j) => remote(j)),
      ZONE,
      STEP_MS,
    );

    expect(got).toBe(expected);
    // The fixture is discriminating: sum ≠ max ≠ first ≠ last ≠ mean.
    const mapped = jitters.map((j) => adaptiveInterpDelayMs(j, STEP_MS));
    const sum = mapped.reduce((a, b) => a + b, 0);
    expect(got).not.toBe(sum);
    expect(got).not.toBe(mapped[0]);
    expect(got).not.toBe(mapped[mapped.length - 1]);
    expect(got).not.toBe(sum / mapped.length);
  });

  it('AM2-property: for any non-empty remote set, the result is the max of the mapped delays', () => {
    // The rule, over arbitrary populations and cadences. Also proves TOTALITY: any finite
    // non-negative jitter and any positive stepMs produce a finite number, never NaN — a NaN
    // here would be recorded into the histogram and poison the +Inf bucket.
    const jitterArb = fc.double({ min: 0, max: 5_000, noNaN: true });
    fc.assert(
      fc.property(
        fc.array(jitterArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 50, max: 1_000 }),
        (jitters, stepMs) => {
          const expected = Math.max(...jitters.map((j) => adaptiveInterpDelayMs(j, stepMs)));
          const got = maxRemoteGapMs(
            jitters.map((j) => remote(j)),
            ZONE,
            stepMs,
          );
          expect(got).toBe(expected);
          expect(Number.isFinite(got as number)).toBe(true);
        },
      ),
      { seed: 20250809, numRuns: 300 },
    );
  });

  it('AM2-iterable: it accepts any iterable, and consumes it exactly once', () => {
    // main.ts hands it a filtered array today, but `store.characters()` may return an iterator
    // tomorrow. WRONG IMPL KILLED: an implementation that iterates twice (e.g. one pass for the
    // length check, one for the max) — the second pass over a spent generator sees nothing, so
    // the metric would silently become "the delay of the first remote".
    function* gen(): Generator<Remote> {
      yield remote(10);
      yield remote(90);
      yield remote(30);
    }
    const expected = Math.max(...[10, 90, 30].map((j) => adaptiveInterpDelayMs(j, STEP_MS)));
    expect(maxRemoteGapMs(gen(), ZONE, STEP_MS)).toBe(expected);
  });
});

describe('maxRemoteGapMs: only the zone on screen counts', () => {
  it('a remote in another zone is skipped, however large its jitter', () => {
    // WRONG IMPL KILLED: no zone filter. A character in a zone this client still holds but does
    // not draw would set the metric, so it would report stutter nobody can see.
    const here = remote(10);
    const elsewhere = remote(5_000, ZONE + 1);
    expect(maxRemoteGapMs([elsewhere, here, elsewhere], ZONE, STEP_MS)).toBe(
      adaptiveInterpDelayMs(10, STEP_MS),
    );
    expect(adaptiveInterpDelayMs(5_000, STEP_MS)).toBeGreaterThan(
      adaptiveInterpDelayMs(10, STEP_MS),
    );
  });

  it('remotes only in other zones produce no sample, zone 0 included', () => {
    // WRONG IMPL KILLED: a truthiness check on the zone id (zone 0 is the spawn zone).
    expect(maxRemoteGapMs([remote(40, 1), remote(90, 2)], 0, STEP_MS)).toBeUndefined();
    expect(maxRemoteGapMs([remote(40, 0), remote(90, 1)], 0, STEP_MS)).toBe(
      adaptiveInterpDelayMs(40, STEP_MS),
    );
  });

  it('for any mix of zones, the result is the max over the asked zone alone', () => {
    const remoteArb = fc.record({
      jitter: fc.double({ min: 0, max: 5_000, noNaN: true }),
      zone: fc.integer({ min: 0, max: 3 }),
    });
    fc.assert(
      fc.property(
        fc.array(remoteArb, { maxLength: 12 }),
        fc.integer({ min: 0, max: 3 }),
        (rs, zone) => {
          const inZone = rs.filter((r) => r.zone === zone);
          const expected =
            inZone.length === 0
              ? undefined
              : Math.max(...inZone.map((r) => adaptiveInterpDelayMs(r.jitter, STEP_MS)));
          expect(
            maxRemoteGapMs(
              rs.map((r) => remote(r.jitter, r.zone)),
              zone,
              STEP_MS,
            ),
          ).toBe(expected);
        },
      ),
      { seed: 20261112, numRuns: 300 },
    );
  });
});
