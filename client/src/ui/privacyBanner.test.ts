// ui/privacyBanner.test.ts — PRV1-1's player-facing LABEL, the pure half (rb-51, residual
// R-m22-s8-X9; ADR-0231 Amendment A1).
//
// EARS COVERED (spec specs/monster-realm-v2/M22-privacy-compliance.spec.md §7.4)
//   PRV1-1 [UI surface] — WHEN the deletion grace window is live THE PLAYER SHALL see a
//   TICKING countdown to the reaper fire. "Ticking" is the load-bearing word: the label must
//   change at least once per second at EVERY magnitude, which is why the grammar below always
//   renders down to seconds instead of stopping at the two largest units.
//
// RED REASON AT AUTHORING TIME: `client/src/ui/privacyBanner.ts` DOES NOT EXIST. The import
// below fails to resolve, so every test in this file reds on a MISSING IMPLEMENTATION — not
// on a typo here.
//
// THE CONTRACT THE IMPLEMENTER BUILDS (do not invent variants):
//
//   import type { DeletionCountdown } from './privacyModel';
//   export function privacyBannerLabel(countdown: DeletionCountdown): string | null;
//
//   phase 'active' | 'unknown' | 'terminal'            -> null (nothing is rendered)
//   phase 'grace' AND remainingMs === undefined (DARK) -> 'Account deletion pending — time
//                                                          remaining unavailable'
//   phase 'due'                                        -> 'Account deletion is due now'
//   phase 'grace' with a computed remainingMs          -> 'Account deletion in ' + duration
//
//   `duration` ALWAYS renders down to SECONDS:
//     >= 1d  '6d 23h 59m 58s'   >= 1h  '23h 59m 58s'   >= 1m  '59m 58s'   else  '58s'
//   Single spaces between groups; units are CONTIGUOUS and DESCENDING; no LEADING zero-valued
//   group (so 3_600_000n renders '1h 0m 0s', never '0d 1h 0m 0s', and 0n renders '0s');
//   seconds TRUNCATE (999n -> '0s'); a negative remainingMs CLAMPS to 0.
//   The function is TOTAL (never throws) and CLOCK-FREE (it reads no clock and takes none).
//
// ★ WHY AN EXACT-STRING TABLE AND NEVER A SHAPE/REGEX MATCH: a "does it look like a duration"
//   assertion is passed by a formatter that renders the WRONG NUMBER — including one that
//   read a clock of its own instead of the `remainingMs` it was handed. The strings below are
//   the specification; a future copy change is corrected HERE, from the plan, never bent to
//   match an implementation.
//
// ★ NO REAL GRACE VALUE ANYWHERE IN THIS FILE — and no pure-numeric chain that FOLDS to one.
//   `evals/deletion-grace-wasm-ssot.eval.mjs` G5 scans all of `client/` RAW (comments and
//   test files included). Every fixture below is a synthetic remaining-time value.
//
// NO regex literal and no `new RegExp(...)` anywhere (Semgrep bans the latter repo-wide; the
// former blinds the repo's own comment strippers). String scanning is split/slice/indexOf only.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { privacyBannerLabel } from './privacyBanner';
import type { DeletionCountdown, PrivacyPhase } from './privacyModel';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** The three copy strings, spelled ONCE. */
const DARK_LABEL = 'Account deletion pending — time remaining unavailable';
const DUE_LABEL = 'Account deletion is due now';
const GRACE_PREFIX = 'Account deletion in ';

/** Countdowns are built as LITERALS, never by calling `deriveDeletionCountdown` — a broken
 *  derivation must red `privacyModel.test.ts`, never silently weaken this file. */
function countdownOf(overrides: Partial<DeletionCountdown> = {}): DeletionCountdown {
  return {
    phase: 'grace',
    deadlineAtMs: undefined,
    remainingMs: undefined,
    cancelPermitted: false,
    cancelPermanentlyRejected: false,
    deletePermitted: false,
    exportPermitted: false,
    ...overrides,
  };
}

/** The phases that must render NOTHING, whatever else the countdown carries. */
const SILENT_PHASES: readonly PrivacyPhase[] = ['active', 'unknown', 'terminal'];

const ALL_PHASES: readonly PrivacyPhase[] = ['unknown', 'active', 'grace', 'due', 'terminal'];

/** ★ THE SPEC TABLE. `remainingMs` -> the EXACT duration text that follows `GRACE_PREFIX`.
 *
 *  Chosen to cover every boundary the grammar has:
 *    0n / 999n     the truncation floor (sub-second remainders are NOT rounded up);
 *    1_000n        the first tick a player can see;
 *    59_999n       the last second-only label;
 *    60_000n       the minute boundary, WITH its zero-valued seconds group;
 *    3_600_000n    the hour boundary, with two zero-valued trailing groups;
 *    86_400_000n   the day boundary, with three;
 *    183_845_000n  ALL FOUR groups non-zero at once (2d 3h 4m 5s) — the one row a
 *                  "largest two units" formatter cannot fake;
 *    -5_000n       the clamp. */
const DURATION_TABLE: readonly (readonly [bigint, string])[] = [
  [0n, '0s'],
  [999n, '0s'],
  [1_000n, '1s'],
  [58_000n, '58s'],
  [59_999n, '59s'],
  [60_000n, '1m 0s'],
  [119_000n, '1m 59s'],
  [120_000n, '2m 0s'],
  [3_599_000n, '59m 59s'],
  [3_600_000n, '1h 0m 0s'],
  [3_661_000n, '1h 1m 1s'],
  [86_399_000n, '23h 59m 59s'],
  [86_400_000n, '1d 0h 0m 0s'],
  [183_845_000n, '2d 3h 4m 5s'],
  [-1n, '0s'],
  [-5_000n, '0s'],
];

// ---------------------------------------------------------------------------
// A round-trip parser for the property test. It is deliberately STRICTER than a
// "contains digits" check: it enforces the grammar's shape (descending, contiguous units
// ending at seconds, no leading zero group) as well as the arithmetic.
// ---------------------------------------------------------------------------

const UNIT_ORDER: readonly string[] = ['d', 'h', 'm', 's'];
const SECONDS_PER_UNIT: Readonly<Record<string, bigint>> = {
  d: 86_400n,
  h: 3_600n,
  m: 60n,
  s: 1n,
};

function isDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (const ch of text) {
    if ('0123456789'.indexOf(ch) === -1) return false;
  }
  return true;
}

/** Total seconds encoded by a duration string, or `undefined` if it does not satisfy the
 *  grammar. `undefined` is a FAILURE signal — every caller asserts it is not returned. */
function parseDurationSeconds(text: string): bigint | undefined {
  if (text.length === 0) return undefined;
  const parts = text.split(' ');
  if (parts.length > UNIT_ORDER.length) return undefined;
  let seconds = 0n;
  let expected = -1;
  for (const [index, part] of parts.entries()) {
    const unit = part.slice(-1);
    const digits = part.slice(0, -1);
    if (!isDigits(digits)) return undefined;
    const at = UNIT_ORDER.indexOf(unit);
    if (at === -1) return undefined;
    // Units must be CONTIGUOUS and DESCENDING: the first group fixes the start, every later
    // group must be exactly the next unit down. This is what rejects '2d 5s' and '5s 2d'.
    if (expected === -1) expected = at;
    if (at !== expected) return undefined;
    expected = at + 1;
    // No LEADING zero-valued group: '0h 0m 5s' must never be produced for 5_000n.
    if (index === 0 && parts.length > 1 && BigInt(digits) === 0n) return undefined;
    seconds += BigInt(digits) * (SECONDS_PER_UNIT[unit] ?? 0n);
  }
  // Must END on the seconds group — the whole point of the grammar is that the banner ticks.
  if (expected !== UNIT_ORDER.length) return undefined;
  return seconds;
}

// ===========================================================================
// PRV1-1 — the phases that render nothing at all.
// ===========================================================================

describe('privacyBannerLabel (PRV1-1): the silent phases', () => {
  it('★ RB51-LABEL-SILENT BITES: active / unknown / terminal render NOTHING, whatever remainingMs says', () => {
    // WRONG IMPL KILLED (1) ★ THE DANGEROUS ONE: keying the banner on `remainingMs !==
    // undefined` instead of on the PHASE. A terminal account (PRV1-4 — already permanently
    // deleted) or a plain Active one carrying a stale timestamp would then be shown a live
    // "your account is being deleted" countdown it can neither enter nor cancel from.
    // WRONG IMPL KILLED (2): a `default:`/fall-through arm that returns the DARK sentence for
    // any phase it does not recognise — an Active player would see a permanent
    // "deletion pending" banner. Asserting `null` STRICTLY (never toBeFalsy) is what sees it:
    // '' is falsy too, and an empty string still forces the shell's visible branch.
    for (const phase of SILENT_PHASES) {
      for (const remainingMs of [undefined, 0n, 1_000n, 183_845_000n, -5_000n]) {
        const label = privacyBannerLabel(countdownOf({ phase, remainingMs }));
        expect(
          label,
          `phase '${phase}' with remainingMs ${String(remainingMs)} must render NOTHING — the ` +
            'banner is a notification about a LIVE grace window and nothing else',
        ).toBeNull();
      }
    }
  });
});

// ===========================================================================
// PRV1-1 — the exact strings.
// ===========================================================================

describe('privacyBannerLabel (PRV1-1): the exact rendered strings', () => {
  it.each(
    DURATION_TABLE.map(([remainingMs, duration]) => ({
      remainingMs: String(remainingMs),
      ms: remainingMs,
      duration,
    })),
  )(
    '★ RB51-LABEL-GRACE BITES: remainingMs $remainingMs renders exactly "Account deletion in $duration"',
    ({ ms, duration }) => {
      // WRONG IMPL KILLED (1) ★ THE ONE THE PLAN NAMES: a formatter that stops at the two
      // largest units ('2d 3h'). It passes every "looks like a duration" shape check and every
      // minute-scale fixture, and it makes the banner STAND STILL for an hour at a time — the
      // exact opposite of PRV1-1's "ticking". Rows 86_400_000n and 183_845_000n kill it.
      // WRONG IMPL KILLED (2): rendering a leading zero-valued group ('0d 1h 0m 0s') or
      // dropping the trailing zero groups ('1h') — both are pinned by exact equality here.
      // WRONG IMPL KILLED (3): rounding instead of truncating (999n -> '1s'), which would show
      // "1s remaining" for a window that is already inside its final second.
      // WRONG IMPL KILLED (4): an unclamped negative (-5_000n -> '-5s' or '0d -1h ...'), the
      // classic symptom of subtracting in the wrong direction.
      // WRONG IMPL KILLED (5): a units-in-the-wrong-place transposition (minutes rendered where
      // hours belong) — 183_845_000n has four DISTINCT non-zero groups precisely so a swap
      // cannot survive it.
      expect(privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs: ms }))).toBe(
        GRACE_PREFIX + duration,
      );
    },
  );

  it('★ RB51-LABEL-DARK BITES: a DARK grace window says so in words, and never renders a fabricated 0', () => {
    // WRONG IMPL KILLED: `remainingMs ?? 0n` (or a `Number(undefined)` slip rendering 'NaNs').
    // A dark countdown means the client does not KNOW the remaining time (ADR-0154's
    // broke-vs-dark rule); telling the player "0s" claims the deadline has arrived, which is a
    // legally significant lie about an irreversible deletion.
    expect(privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs: undefined }))).toBe(
      DARK_LABEL,
    );
  });

  it('★ RB51-LABEL-DUE BITES: `due` says the deletion is due now — never a "0s remaining" countdown', () => {
    // WRONG IMPL KILLED: treating 'due' as just another grace value ('Account deletion in 0s').
    // `due` is reached ONLY from a COMPUTED zero (privacyModel.ts), so it is the one phase in
    // which the reaper may fire at any moment; it gets its own sentence rather than a number
    // that keeps counting nothing.
    for (const remainingMs of [undefined, 0n, 1_000n, -5_000n]) {
      expect(
        privacyBannerLabel(countdownOf({ phase: 'due', remainingMs })),
        `'due' must render the fixed sentence for remainingMs ${String(remainingMs)}`,
      ).toBe(DUE_LABEL);
    }
  });

  it('RB51-LABEL-ANTI-VACUITY: the three copy strings are distinct and none is empty', () => {
    // A stub returning the SAME string (or '') for everything would pass a suite whose
    // expectations were all built from one constant. They are not — but proving the three
    // constants really are three costs one assertion and removes the doubt.
    const rendered = new Set([DARK_LABEL, DUE_LABEL, GRACE_PREFIX + '1s']);
    expect(rendered.size, 'the three rendered forms must be three DISTINCT strings').toBe(3);
    for (const text of rendered) {
      expect(text.length, 'no rendered form may be empty').toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// PRV1-1 — totality and monotonicity (property tier).
// ===========================================================================

describe('privacyBannerLabel (PRV1-1): totality, round-trip and monotonicity', () => {
  /** Well-typed remaining times, plus the hostile values a wiring slip can deliver. The bound
   *  is 999_999_999n on purpose (≈ 11.5 days — deep into the four-group branch) and must NOT
   *  be the shipped grace window: `evals/deletion-grace-wasm-ssot.eval.mjs` G5 reads this file
   *  RAW, fast-check bounds and comments included. */
  const remainingArb = fc.oneof(
    fc.bigInt({ min: -999_999_999n, max: 999_999_999n }),
    fc.constantFrom(
      undefined as unknown as bigint,
      null as unknown as bigint,
      0 as unknown as bigint,
      1_234 as unknown as bigint,
      '5000' as unknown as bigint,
      Number.NaN as unknown as bigint,
    ),
  );
  const phaseArb = fc.constantFrom(...ALL_PHASES);

  it('★ RB51-LABEL-TOTAL BITES: never throws, and every well-typed grace value round-trips to floor(ms / 1000)', () => {
    // WRONG IMPL KILLED (1) ★: a throw on a hostile input. The banner is written from a
    // PER-FRAME rAF tick; a `TypeError: Cannot mix BigInt and other types` there does not just
    // break the banner, it takes the render loop down with it.
    // WRONG IMPL KILLED (2): arithmetic that is right at the table's 16 rows and wrong in
    // between — an off-by-one in the minute carry, a `%` that can go negative, an hours group
    // that keeps accumulating past 24 ('27h 4m 5s' instead of '1d 3h 4m 5s'). The round-trip
    // checks the value across the whole domain; the parser's grammar check (contiguous,
    // descending, ends at seconds, no leading zero group) checks the SHAPE across it too.
    // Block-bodied arrow — fast-check reads an expression-bodied matcher's return as a `false`
    // predicate and fails spuriously (repo convention, privacyModel.test.ts:432-434).
    fc.assert(
      fc.property(phaseArb, remainingArb, (phase, remainingMs) => {
        const countdown = countdownOf({ phase, remainingMs });
        let label: string | null = null;
        expect(
          () => {
            label = privacyBannerLabel(countdown);
          },
          `a throw on phase '${phase}' / remainingMs ${String(remainingMs)} kills the frame loop`,
        ).not.toThrow();
        expect(label === null || typeof label === 'string').toBe(true);

        if (SILENT_PHASES.indexOf(phase) !== -1) {
          expect(label).toBeNull();
          return;
        }
        if (phase === 'due') {
          expect(label).toBe(DUE_LABEL);
          return;
        }
        if (remainingMs === undefined) {
          expect(label).toBe(DARK_LABEL);
          return;
        }
        if (typeof remainingMs !== 'bigint') {
          // A hostile, non-bigint remaining time: TOTALITY is the whole contract here (asserted
          // above). Pinning an exact rendering for it would freeze an arbitrary degradation
          // choice the plan does not make — stated rather than silently asserted.
          return;
        }
        const text = label as unknown as string;
        expect(typeof text, 'a computable grace window must render a string').toBe('string');
        expect(text.startsWith(GRACE_PREFIX)).toBe(true);
        const seconds = parseDurationSeconds(text.slice(GRACE_PREFIX.length));
        expect(
          seconds,
          `"${text}" does not satisfy the duration grammar (descending contiguous unit groups, ` +
            'ending at seconds, no leading zero-valued group)',
        ).not.toBeUndefined();
        const clamped = remainingMs > 0n ? remainingMs : 0n;
        expect(seconds, `"${text}" must encode floor(${String(clamped)} / 1000) seconds`).toBe(
          clamped / 1_000n,
        );
      }),
      { numRuns: 400 },
    );
  });

  it('★ RB51-LABEL-MONOTONE BITES: as remainingMs falls the rendered time never rises', () => {
    // WRONG IMPL KILLED: a formatter whose group arithmetic is non-monotone across a carry
    // boundary — e.g. one that renders the remainder with `%` after having already rounded the
    // group above, so 3_599_999n reads LONGER than 3_600_000n. On screen that is a countdown
    // that jumps BACKWARD (upward) as the deadline approaches, which is worse than a frozen
    // one: it tells the player they have gained time they have not got.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 999_999_999n }),
        fc.bigInt({ min: 0n, max: 999_999_999n }),
        (a, b) => {
          const low = a < b ? a : b;
          const high = a < b ? b : a;
          const lowText = privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs: low }));
          const highText = privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs: high }));
          const lowSeconds = parseDurationSeconds(String(lowText).slice(GRACE_PREFIX.length));
          const highSeconds = parseDurationSeconds(String(highText).slice(GRACE_PREFIX.length));
          expect(lowSeconds).not.toBeUndefined();
          expect(highSeconds).not.toBeUndefined();
          expect(
            (lowSeconds ?? 0n) <= (highSeconds ?? 0n),
            `${String(low)}ms rendered "${String(lowText)}" but ${String(high)}ms rendered ` +
              `"${String(highText)}" — a smaller remaining time must never read as longer`,
          ).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});
