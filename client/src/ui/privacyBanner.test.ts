// ui/privacyBanner.test.ts — the deletion countdown's player-facing LABEL, the pure half
// (rb-51; ADR-0231 Amendment A1).
//
// ★ SOURCE OF TRUTH — the PROMOTED RESIDUAL, quoted verbatim. Section `rb-51` of
// `specs/monster-realm-v2/M-residual-backlog.spec.md` (source slice m22-s8, residual
// R-m22-s8-X9):
//   "[PRV1-1 UI surface] WHEN the deletion grace window is live THE PLAYER SHALL see a ticking
//    countdown to the reaper fire in a rendered surface (DOM shell + main.ts frame tick + the
//    deletion_grace_ms_default() wasm read)"
//
// ATTRIBUTION CORRECTION (rb-51 review): this header previously cited "spec §7.4 PRV1-1".
// M22 §7.4's PRV1-1 is the SERVER criterion — `delete_account` transitions the account status —
// and is gated in `server-module`. The UI criterion is the residual above. Pointing a reader at
// §7.4 for this file sends them to a criterion it does not and structurally cannot test.
//
// "Ticking" is the load-bearing word: the label must change at least once per second at EVERY
// magnitude, which is why the grammar below always renders down to seconds instead of stopping
// at the two largest units.
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
// rb-52 (ADR-0231 A2-D7): the M22 section 9 pseudonymization sentence is pinned against a SECOND
// SOURCE, never a second hand-typed literal — one bad transcription copied into both the pin and
// the implementation is exactly what a hand-typed pin cannot see. Precedent for a `.ts` spec
// importing a `.mjs` eval: `client/src/indexShell.test.ts` imports `stripCssComments` from
// `evals/a11y-static-shell.eval.mjs`. VERIFIED BEFORE ADOPTING: `evals/account-e2e.eval.mjs` has
// NO top-level side effects (its live phase runs only inside the exported `run()`), and neither do
// the three modules it imports (`scripts/playtest-report.mjs` is main-guarded via `pathToFileURL`;
// `deletion-grace-wasm-ssot.eval.mjs` and `e2e-desync-teeth.eval.mjs` end in exported functions).
import { PIN_PSEUDONYMIZATION } from '../../../evals/account-e2e.eval.mjs';
import {
  buildPrivacyViewModel,
  PRIVACY_PSEUDONYMIZATION_DISCLOSURE,
  PRIVACY_TERMINAL_NOTICE,
  privacyBannerLabel,
} from './privacyBanner';
import {
  type DeletionCountdown,
  deriveDeletionCountdown,
  PRIVACY_INITIAL,
  type PrivacyEffect,
  type PrivacyEvent,
  type PrivacyModelState,
  type PrivacyPhase,
  privacyStep,
  SERVER_ALREADY_DELETED_MESSAGE,
} from './privacyModel';

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

  it('★ RB51-LABEL-ASCII BITES: the duration is built from ASCII digits and unit letters ONLY — no locale formatter, at any magnitude', () => {
    // ★ THE LOCALE MUTANT, and it is not exotic: `${days}d` written as
    // `${days.toLocaleString()}d` (or `Number(days).toLocaleString()`) is the shape a
    // "make the big number readable" edit takes. It survives EVERY other tooth in this file on
    // a machine whose default locale is `en-US`, because `toLocaleString` is a NO-OP there for
    // values under 1000 — which is every hours/minutes/seconds group and every days count these
    // fixtures reach. It then ships:
    //   * `de-DE` — a GROUPING SEPARATOR ('1.157d'), so the exact-string table reds only for a
    //     tester who happens to run in that locale, i.e. never in this repo's CI;
    //   * `ar-EG` / any `ar-*` default — ARABIC-INDIC digits (U+0660..U+0669 in place of ASCII
    //     0-9), a label whose numerals the exact-string table cannot even spell. The code
    //     points are named rather than pasted, so this file stays ASCII apart from its prose
    //     dashes.
    //   The player-facing consequence is the same in both: a legally significant deadline
    //   rendered in characters the rest of this suite has never seen.
    // This tooth is locale-INDEPENDENT by construction: it pins the ALPHABET, not the value, so
    // it reds under en-US too — the mutant's `toLocaleString()` on a 4-digit day count emits a
    // separator on the CI machine as well (row 100_000_000_000n below is 1157 days precisely so
    // that the grouping case is reachable without depending on the ambient locale).
    //
    // WRONG IMPL KILLED (2): a thousands separator hand-written into the formatter
    // ("1,157d") — same clause, same failure.
    // WRONG IMPL KILLED (3): a NON-BREAKING space or a narrow no-break space between groups
    // (what several locales' list/number formats emit) — U+00A0 is not U+0020 and is not in the
    // alphabet, and the exact-string table's `===` would red with an invisible diff a reader
    // could stare past for an hour. Here the failure message names the offending code point.
    //
    // indexOf-based membership only: NO `new RegExp` (Semgrep-banned repo-wide) and no regex
    // literal at all (a `/[0-9]/`-shaped literal containing `/` or `*` is the exact construct
    // main.wiring.test.ts's W-14RC-BRACE-REGEX-STAR-CEILING bans across client/src).
    const GRACE_ALPHABET = '0123456789dhms ';
    for (const remainingMs of [
      0n,
      58_000n,
      183_845_000n,
      86_400_000n,
      // 1157 days — four digits in the LEADING group, which is where every grouping-separator
      // formatter first becomes visible. Synthetic, and not a duplicate of any shipped window.
      100_000_000_000n,
    ]) {
      const label = privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs }));
      expect(
        String(label).startsWith(GRACE_PREFIX),
        `remainingMs ${String(remainingMs)} must render the grace sentence, got ${String(label)}`,
      ).toBe(true);
      const duration = String(label).slice(GRACE_PREFIX.length);
      expect(
        duration.length,
        `remainingMs ${String(remainingMs)}: the duration must be non-empty`,
      ).toBeGreaterThan(0);
      for (const ch of duration) {
        expect(
          GRACE_ALPHABET.indexOf(ch),
          `remainingMs ${String(remainingMs)} rendered "${duration}", which contains the ` +
            `character ${JSON.stringify(ch)} (code point ${ch.codePointAt(0)}). A duration may ` +
            `use ONLY ${JSON.stringify(GRACE_ALPHABET)} — ASCII digits, the four unit letters ` +
            'and a plain U+0020 space. A separator, a non-ASCII digit or a non-breaking space ' +
            'means the formatter went through the host locale instead of composing the string ' +
            'itself, and the countdown then reads differently for every player.',
        ).not.toBe(-1);
      }
    }
  });

  it('★ RB51-LABEL-ANTI-VACUITY BITES: the three rendered forms are three DISTINCT, NON-EMPTY strings PRODUCED BY privacyBannerLabel', () => {
    // ★ REWRITTEN IN THE rb-51 REVIEW, AND WHY — the previous version of this test was itself
    // vacuous, which is the worst thing an anti-vacuity tooth can be. It built
    // `new Set([DARK_LABEL, DUE_LABEL, GRACE_PREFIX + '1s'])` out of three string LITERALS
    // declared in THIS file and never called `privacyBannerLabel` at all. MEASURED: an
    // implementation whose entire body is `return '';` passed it, because the Set it inspected
    // was made of the test file's own constants. It asserted that three constants this file
    // spells differently are spelled differently.
    //
    // WRONG IMPL KILLED (1) ★ THE MEASURED SURVIVOR: `privacyBannerLabel` stubbed to
    // `return '';`. Every value below now comes OUT of the function, and every one is asserted
    // non-empty, so the stub reds three times over.
    // WRONG IMPL KILLED (2): a stub returning ONE constant sentence for every phase (the
    // classic "make the suite compile" placeholder). The distinctness check sees it: three
    // calls, three different phases, three required-different answers.
    // WRONG IMPL KILLED (3): a `grace` arm that quietly falls through to the DARK or DUE
    // sentence for a COMPUTED remaining time — the grace value would then equal one of the
    // other two and the Set collapses to 2.
    // WRONG IMPL KILLED (4): a label that renders `null`/`undefined` stringified ('null') — the
    // typeof assertion plus the null-distinctness clause below both catch it.
    //
    // This tooth deliberately does NOT re-assert the exact wording: RB51-LABEL-GRACE /
    // RB51-LABEL-DARK / RB51-LABEL-DUE own that. What it owns is the property those three
    // cannot state on their own — that the function is a real discriminator over the phases and
    // not a constant.
    const darkLabel = privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs: undefined }));
    const dueLabel = privacyBannerLabel(countdownOf({ phase: 'due', remainingMs: 0n }));
    const graceLabel = privacyBannerLabel(countdownOf({ phase: 'grace', remainingMs: 1_000n }));
    const produced = [
      ['a DARK grace window', darkLabel],
      ['the `due` phase', dueLabel],
      ['a computed grace window', graceLabel],
    ] as const;

    for (const [where, label] of produced) {
      expect(typeof label, `${where}: privacyBannerLabel must return a string here`).toBe('string');
      expect(
        (label ?? '').length,
        `${where}: the rendered form must be NON-EMPTY. An empty string is not "render nothing" ` +
          "— null is; an empty string still forces the banner shell's visible branch, so a " +
          "`return '';` stub ships a blank box that no exact-string table would notice",
      ).toBeGreaterThan(0);
    }

    expect(
      new Set(produced.map(([, label]) => label)).size,
      'privacyBannerLabel must render THREE DISTINCT strings for dark / due / computed-grace — ' +
        `got ${JSON.stringify(produced.map(([, label]) => label))}. Equal values mean the ` +
        'function is a constant (or one arm falls through to another), which every ' +
        "expectation built from this file's own copy constants would happily agree with",
    ).toBe(3);

    // ...and none of the three may collide with the SILENT answer, which is `null` and nothing
    // else. Stated separately so a future "return the dark sentence instead of null" mutation
    // reds here as well as in RB51-LABEL-SILENT.
    for (const [where, label] of produced) {
      expect(
        label,
        `${where}: a rendered form must never be the silent phases' null`,
      ).not.toBeNull();
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

// ###########################################################################
// rb-52 (PRV1-3 / PRV1-4) — the privacy SURFACE's copy layer.
// ###########################################################################
//
// ★ SOURCE OF TRUTH — the PROMOTED RESIDUAL, quoted verbatim. Section `rb-52` of
// `specs/monster-realm-v2/M-residual-backlog.spec.md` (source slice m22-s8, residual
// R-m22-s8-X10):
//   "[PRV1-3/PRV1-4 UI surface] WHEN the player opens the privacy surface THE CLIENT SHALL
//    expose reachable delete/cancel controls wired to `conn.reducers` and render the distinct
//    terminal notice once `terminal_at_ms` is `Some`."
//
// Design record: `docs/adr/0231-client-privacy-cores-request-wide-chunk-assembly.md`,
// Amendment A2 (A2-D6 the ROW route, A2-D7 the pinned disclosure, A2-D8 non-delivery).
//
// RED REASON AT AUTHORING TIME: `client/src/ui/privacyBanner.ts` exports ONLY
// `privacyBannerLabel`. `buildPrivacyViewModel`, `PRIVACY_PSEUDONYMIZATION_DISCLOSURE` and
// `PRIVACY_TERMINAL_NOTICE` DO NOT EXIST, so the import at the top of this file fails to
// resolve those names and every test below reds on a MISSING IMPLEMENTATION — not on a typo
// here. (The rb-51 header's own "privacyBanner.ts DOES NOT EXIST" line is a DATED record of
// that slice's fork and is deliberately left as written.)
//
// THE CONTRACT THE IMPLEMENTER BUILDS (do not invent variants):
//
//   export const PRIVACY_PSEUDONYMIZATION_DISCLOSURE: string;  // M22 section 9 residual 1
//   export const PRIVACY_TERMINAL_NOTICE: string;              // PRV1-4's distinct copy
//   export interface PrivacyViewModel {
//     readonly statusLabel: string;
//     readonly deleteLabel: string;  readonly cancelLabel: string;  readonly exportLabel: string;
//     readonly deleteEnabled: boolean;
//     readonly cancelEnabled: boolean;
//     readonly exportEnabled: boolean;
//     readonly confirmPrompt: string | undefined;
//     readonly noticeKind:
//       'none' | 'disconnected' | 'permanently-deleted' | 'request-rejected' | 'terminal-row';
//     readonly noticeLabel: string | undefined;
//   }
//   export function buildPrivacyViewModel(state: PrivacyModelState): PrivacyViewModel;
//
// ★ ON THE BACKTICKS AROUND Identity — DECIDED AND STATED (the brief asks for this explicitly).
//   The shipped UI string KEEPS them: M22 section 9 requires the sentence "to be used verbatim
//   in the ADR, commit messages and any UI copy", and ADR-0231 A2-D7 says the constant is
//   "asserted equal to PIN_PSEUDONYMIZATION". So the assertion below is a plain
//   `toBe(PIN_PSEUDONYMIZATION)` — byte-identical, no transform. Nothing here COMPUTES a
//   stripped variant, because nothing is allowed to strip.
//
// ★ WHY THESE FIXTURES CALL `deriveDeletionCountdown`/`privacyStep`, UNLIKE THE rb-51 BLOCK
//   ABOVE (whose `countdownOf` builds literals on purpose). The criterion under test is about a
//   state the MODEL can actually reach: A2-D6's whole point is that `account-changed` never
//   writes `notice`, so a hand-built `{ notice: 'permanently-deleted' }` literal would test a
//   state the row route never produces and would leave the real defect — a VM that renders
//   NOTHING when the player opens the surface on an already-erased account — completely
//   invisible. The fixtures are therefore RUN, not written.
//
// NO regex literal and no `new RegExp(...)` anywhere below; scanning is indexOf/split only.
// NO numeric duplicate of the grace window: every value here is a small synthetic one.

// ---------------------------------------------------------------------------
// rb-52 fixtures.
// ---------------------------------------------------------------------------

/** A SYNTHETIC grace window. Nothing in this file may spell the real one (G5 of
 *  `evals/deletion-grace-wasm-ssot.eval.mjs` reads `client/**` RAW, tests included). */
const RB52_GRACE_MS = 90_000n;
/** Two DIFFERENT injection points inside that window, so the countdown sentence has two
 *  different remaining times to render (the tooth that kills an authored duration). */
const RB52_NOW_EARLY_MS = 30_000n;
const RB52_NOW_LATE_MS = 60_000n;
const RB52_NOW_DUE_MS = 90_000n;

/** The verbatim shape `ui/statusModel.ts`'s `reduceErrorMessage` composes before the model ever
 *  sees it: `${where}: ${message}`. Spelled as a literal because that is what the shell really
 *  delivers, and cross-checked against the model's own constant immediately below. */
const RB52_TERMINAL_REJECT_MESSAGE =
  'cancel-account-deletion: this account has already been permanently deleted';
/** A plain, NON-terminal rejection — the `request-rejected` route's verbatim server text. */
const RB52_PLAIN_REJECT_MESSAGE = 'request-data-export: export is rate limited, try later';

function rb52Countdown(
  status: string | undefined,
  requestedAtMs: bigint | undefined,
  terminalAtMs: bigint | undefined,
  nowMs: bigint,
): DeletionCountdown {
  return deriveDeletionCountdown({
    status,
    deletionRequestedAtMs: requestedAtMs,
    terminalAtMs,
    nowMs,
    graceMs: RB52_GRACE_MS,
  });
}

const RB52_ACTIVE = rb52Countdown('Active', undefined, undefined, RB52_NOW_EARLY_MS);
const RB52_GRACE_EARLY = rb52Countdown('PendingDeletion', 0n, undefined, RB52_NOW_EARLY_MS);
const RB52_GRACE_LATE = rb52Countdown('PendingDeletion', 0n, undefined, RB52_NOW_LATE_MS);
const RB52_DUE = rb52Countdown('PendingDeletion', 0n, undefined, RB52_NOW_DUE_MS);
/** ★ `terminalAtMs: 0n` SPECIFICALLY. `0n` is a VALID `Option<i64>` marker, and a
 *  truthiness-keyed implementation (`if (terminalAtMs)`) inverts PRV1-4 on exactly this value —
 *  it would offer a Cancel button for an account that is already permanently erased. */
const RB52_TERMINAL = rb52Countdown('PendingDeletion', 0n, 0n, RB52_NOW_LATE_MS);

/** Run a real event sequence through the real reducer. Returns BOTH the state and every effect,
 *  so an effect census (the double-submit tooth) reads the same run the state came from. */
function rb52Run(events: readonly PrivacyEvent[]): {
  readonly state: PrivacyModelState;
  readonly effects: readonly PrivacyEffect[];
} {
  let state: PrivacyModelState = PRIVACY_INITIAL;
  const effects: PrivacyEffect[] = [];
  for (const event of events) {
    const step = privacyStep(state, event);
    state = step.next;
    effects.push(step.effect);
  }
  return { state, effects };
}

function rb52State(events: readonly PrivacyEvent[]): PrivacyModelState {
  return rb52Run(events).state;
}

/** Every reachable (phase x notice x confirm) shape, each REACHED by running events. The
 *  labels are diagnostic only — the assertions read the states. */
const RB52_MATRIX: ReadonlyArray<readonly [string, PrivacyModelState]> = [
  ['dark: no account row yet', PRIVACY_INITIAL],
  ['active', rb52State([{ kind: 'account-changed', countdown: RB52_ACTIVE }])],
  ['grace (early)', rb52State([{ kind: 'account-changed', countdown: RB52_GRACE_EARLY }])],
  ['grace (late)', rb52State([{ kind: 'account-changed', countdown: RB52_GRACE_LATE }])],
  ['due', rb52State([{ kind: 'account-changed', countdown: RB52_DUE }])],
  ['terminal, from the ROW', rb52State([{ kind: 'account-changed', countdown: RB52_TERMINAL }])],
  [
    'active + delete armed',
    rb52State([{ kind: 'account-changed', countdown: RB52_ACTIVE }, { kind: 'delete-requested' }]),
  ],
  [
    'active + armed + disconnected',
    rb52State([
      { kind: 'account-changed', countdown: RB52_ACTIVE },
      { kind: 'delete-requested' },
      { kind: 'delete-confirmed', hasLiveConnection: false },
    ]),
  ],
  [
    'grace + a plain server rejection',
    rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE_EARLY },
      { kind: 'export-requested', hasLiveConnection: true },
      { kind: 'request-failed', which: 'export', message: RB52_PLAIN_REJECT_MESSAGE },
    ]),
  ],
  [
    'grace + a REJECTED cancel (the second route to terminal)',
    rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE_EARLY },
      { kind: 'cancel-deletion-requested', hasLiveConnection: true },
      { kind: 'request-failed', which: 'cancel', message: RB52_TERMINAL_REJECT_MESSAGE },
    ]),
  ],
];

/** Occurrences of `needle` in `haystack`. indexOf only — no regex literal, no `new RegExp`. */
function rb52Count(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Every player-facing string a VM can put on screen, in one array. */
function rb52VmStrings(state: PrivacyModelState): string[] {
  const vm = buildPrivacyViewModel(state);
  const out = [vm.statusLabel, vm.deleteLabel, vm.cancelLabel, vm.exportLabel];
  if (vm.confirmPrompt !== undefined) out.push(vm.confirmPrompt);
  if (vm.noticeLabel !== undefined) out.push(vm.noticeLabel);
  return out;
}

// ===========================================================================
// PRV1-3/PRV1-4 — the M22 section 9 disclosure, pinned against a SECOND SOURCE.
// ===========================================================================

describe('rb-52 privacy copy: the section 9 pseudonymization disclosure', () => {
  it('★ RB52C-DISCLOSURE-PIN BITES: the shipped disclosure is BYTE-IDENTICAL to evals/account-e2e.eval.mjs PIN_PSEUDONYMIZATION', () => {
    // WRONG IMPL KILLED (1) ★ THE ONE A HAND-TYPED PIN CANNOT SEE: a transcription slip
    // (a dropped "not", a "de-identification" for "pseudonymization", a curly apostrophe)
    // copied into BOTH the implementation and a second literal in this file. Because the
    // expectation is IMPORTED from the gate that already owns the sentence, the only way to
    // make this pass is to ship the sentence the runbook gate itself enforces.
    // WRONG IMPL KILLED (2): a "cleaned up" UI variant that strips the backticks around
    // Identity, or re-wraps the sentence. M22 section 9 requires the language VERBATIM in any
    // UI copy; `toBe` admits no transform (see the header's explicit decision on this).
    // WRONG IMPL KILLED (3): an empty or placeholder const — the anti-vacuity block below
    // fires FIRST, so a hollowed-out PIN_PSEUDONYMIZATION could never make this pass for free.
    expect(typeof PIN_PSEUDONYMIZATION, 'ANTI-VACUITY: the imported pin must be a string').toBe(
      'string',
    );
    expect(
      PIN_PSEUDONYMIZATION.length,
      'ANTI-VACUITY: the imported pin must be the real, long section 9 sentence — if this is ' +
        'small the eval export has been hollowed out and the equality below proves nothing',
    ).toBeGreaterThan(200);
    for (const fragment of [
      'severed on deletion',
      'pseudonymization limitation',
      'not erasure.',
      '`Identity`',
    ]) {
      expect(
        PIN_PSEUDONYMIZATION.indexOf(fragment),
        `ANTI-VACUITY: the imported pin must still contain ${JSON.stringify(fragment)}`,
      ).not.toBe(-1);
    }

    expect(
      PRIVACY_PSEUDONYMIZATION_DISCLOSURE,
      'the shipped disclosure must equal evals/account-e2e.eval.mjs PIN_PSEUDONYMIZATION ' +
        'byte for byte — M22 section 9 residual 1 requires this language VERBATIM in any UI copy',
    ).toBe(PIN_PSEUDONYMIZATION);
  });

  it('★ RB52C-ERASURE-CENSUS BITES: the word "erasure" occurs EXACTLY ONCE across all privacy copy, and that occurrence is inside the disclosure', () => {
    // ⚠ THE OBVIOUS GATE IS THE WRONG ONE. A "the copy must not contain the word erasure" scan
    // FAILS CORRECT CODE: the mandated sentence itself ENDS in "not erasure." (ADR-0231 A2-D7
    // records this trap by name). The real invariant is a CENSUS — exactly one occurrence, and
    // it lies inside the disclosure literal's span.
    // WRONG IMPL KILLED (1) ★: a terminal notice that promises "permanent erasure of your
    // data" — legally false on this server, whose own manifest anonymizes rather than erases
    // the Identity key. It is invisible to an exact-string test of the disclosure alone,
    // because the disclosure would still be correct.
    // WRONG IMPL KILLED (2): a status/confirm sentence that reuses the word to sound final
    // ("this begins erasure") anywhere in the matrix.
    // WRONG IMPL KILLED (3): a disclosure that quotes the sentence TWICE (a copy-paste into
    // both a heading and a body line) — the count would be 2 inside the span.
    expect(
      rb52Count(PRIVACY_PSEUDONYMIZATION_DISCLOSURE, 'erasure'),
      'the disclosure must contain the word exactly once — it is the last word of the ' +
        'mandated sentence, and nothing else in that sentence may repeat it',
    ).toBe(1);

    const elsewhere: string[] = [PRIVACY_TERMINAL_NOTICE];
    for (const [, state] of RB52_MATRIX) elsewhere.push(...rb52VmStrings(state));
    expect(
      elsewhere.length,
      'ANTI-VACUITY: the non-disclosure copy corpus must be non-empty, or the zero-count ' +
        'assertion below is satisfied by measuring nothing',
    ).toBeGreaterThan(RB52_MATRIX.length);
    for (const text of elsewhere) {
      expect(
        rb52Count(text, 'erasure'),
        `${JSON.stringify(text)} uses the word "erasure". Only the section 9 disclosure may — ` +
          'this server anonymizes the Identity key rather than erasing it, so any other ' +
          'sentence promising erasure is a legally significant false claim',
      ).toBe(0);
    }
  });
});

// ===========================================================================
// PRV1-4 — the distinct terminal notice, from BOTH routes.
// ===========================================================================

describe('rb-52 privacy view model: PRV1-4 the distinct terminal notice', () => {
  it('★ RB52C-TERMINAL-ROW BITES: an already-erased account renders PRIVACY_TERMINAL_NOTICE on OPEN, with no click and no `notice` write', () => {
    // ★ THE CRITERION'S OWN WORDS: "render the distinct terminal notice ONCE terminal_at_ms IS
    // Some" — i.e. on OPEN, with no interaction at all.
    // WRONG IMPL KILLED (1) ★ THE MEASURED DEFECT (ADR-0231 A2-D6): a view model keyed on
    // `state.notice` ALONE. `privacyStep`'s `account-changed` arm writes `countdown`, `confirm`
    // and `inFlight` and NEVER `notice`, so such a VM renders NOTHING when the player opens the
    // surface on an already-erased account — E1 failing while every click-driven test passes.
    // The `state.notice === 'none'` assertion below is what makes that failure visible HERE
    // rather than only in a browser.
    // WRONG IMPL KILLED (2): a truthiness-keyed terminal test upstream. `terminalAtMs` is `0n`
    // in this fixture, a VALID marker; `if (terminalAtMs)` reads it as absent and this state
    // would arrive as `grace`/`due` with a live Cancel button on an erased account.
    const state = rb52State([{ kind: 'account-changed', countdown: RB52_TERMINAL }]);
    expect(
      state.countdown.phase,
      'ANTI-VACUITY: the fixture must really be the terminal phase — if `0n` was read as ' +
        '"no marker" the whole test below would be measuring a grace window',
    ).toBe('terminal');
    expect(
      state.notice,
      'ANTI-VACUITY + THE POINT: `account-changed` must NOT have written a notice code. If ' +
        'this is anything but `none`, the ROW route is not what the VM below is being asked to ' +
        'derive from and this test no longer kills the state.notice-keyed VM',
    ).toBe('none');

    const vm = buildPrivacyViewModel(state);
    expect(vm.noticeKind, 'the ROW route reports its own code').toBe('terminal-row');
    expect(vm.noticeLabel).toBe(PRIVACY_TERMINAL_NOTICE);
    expect(
      (PRIVACY_TERMINAL_NOTICE ?? '').length,
      'the terminal notice must be NON-EMPTY — an empty string is not a distinct notice, it is ' +
        'a blank line the player reads as "nothing is wrong"',
    ).toBeGreaterThan(0);
  });

  it('★ RB52C-TERMINAL-REJECT BITES: a rejected cancel reaches the SAME PRIVACY_TERMINAL_NOTICE string, through the second route', () => {
    // WRONG IMPL KILLED (1): a VM that keys the terminal copy on `countdown.phase` ALONE. The
    // row can still read `grace` when the server has already erased the account (the client's
    // subscription has not caught up), and this rejection is then the ONLY signal the player
    // gets. ADR-0231 gates BOTH routes independently for exactly this reason.
    // WRONG IMPL KILLED (2): rendering the raw server sentence here instead of the distinct
    // notice — the player would be shown a reducer error string where PRV1-4 asks for a
    // deliberate, non-generic terminal state.
    // WRONG IMPL KILLED (3): keying on `which === 'cancel'` alone (any transient cancel failure
    // would then tell the player their account is permanently gone). Not killed HERE — the
    // model owns it — but RB52C-REJECT-DISTINCT below shows the non-terminal cancel arm.
    expect(
      RB52_TERMINAL_REJECT_MESSAGE.endsWith(SERVER_ALREADY_DELETED_MESSAGE),
      'ANTI-DRIFT: the composed `${where}: ${message}` fixture must still end in the model`s ' +
        'own SERVER_ALREADY_DELETED_MESSAGE, or this fixture is testing a message the shell ' +
        'never produces',
    ).toBe(true);
    const state = rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE_EARLY },
      { kind: 'cancel-deletion-requested', hasLiveConnection: true },
      { kind: 'request-failed', which: 'cancel', message: RB52_TERMINAL_REJECT_MESSAGE },
    ]);
    expect(
      state.notice,
      'ANTI-VACUITY: the model must have classified this rejection as the terminal outcome',
    ).toBe('permanently-deleted');

    const vm = buildPrivacyViewModel(state);
    expect(vm.noticeKind).toBe('permanently-deleted');
    expect(
      vm.noticeLabel,
      'BOTH routes must render the SAME distinct sentence — two different wordings for one ' +
        'outcome is two copies of PRV1-4',
    ).toBe(PRIVACY_TERMINAL_NOTICE);
  });

  it('★ RB52C-REJECT-DISTINCT BITES: an ordinary rejection renders the VERBATIM server message, and it is a DIFFERENT string from the terminal notice', () => {
    // WRONG IMPL KILLED (1) ★: collapsing every notice code onto one generic sentence
    // ("something went wrong"). PRV1-4's whole substance is that the permanently-deleted state
    // is DISTINCT; a shared string satisfies "a notice was rendered" and fails the criterion.
    // WRONG IMPL KILLED (2): classifying/normalising the server text before rendering it —
    // ADR-0231 freezes the wiring to hand the model the RAW message, and the player is entitled
    // to the reason the server actually gave.
    const state = rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE_EARLY },
      { kind: 'export-requested', hasLiveConnection: true },
      { kind: 'request-failed', which: 'export', message: RB52_PLAIN_REJECT_MESSAGE },
    ]);
    const vm = buildPrivacyViewModel(state);
    expect(vm.noticeKind).toBe('request-rejected');
    expect(vm.noticeLabel, 'the server message is rendered VERBATIM').toBe(
      RB52_PLAIN_REJECT_MESSAGE,
    );
    expect(
      vm.noticeLabel,
      'a rejection notice must never be the permanently-deleted sentence — that would tell a ' +
        'player with a live, cancellable grace window that their account is already gone',
    ).not.toBe(PRIVACY_TERMINAL_NOTICE);
    expect(
      PRIVACY_TERMINAL_NOTICE,
      'and the two must be different strings in the first place',
    ).not.toBe(RB52_PLAIN_REJECT_MESSAGE);
  });

  it('★ RB52C-NOTICE-CODES BITES: every reachable state maps to exactly one code, and `none` renders NO label', () => {
    // WRONG IMPL KILLED (1): a VM that always sets a `noticeLabel` (e.g. `?? ''`). The shell
    // keys the notice element's visibility on `noticeLabel === undefined`, so an empty-string
    // label ships a permanently visible blank notice box.
    // WRONG IMPL KILLED (2): a code/label pair that disagrees — e.g. `noticeKind: 'none'` with
    // a label, or a non-`none` code with no label. Pinning BOTH fields together (rather than
    // the label alone) is what makes the shell's branch and the copy provably consistent.
    // WRONG IMPL KILLED (3): a fabricated code outside the union.
    const legal = [
      'none',
      'disconnected',
      'permanently-deleted',
      'request-rejected',
      'terminal-row',
    ];
    let sawNone = 0;
    let sawLabelled = 0;
    for (const [where, state] of RB52_MATRIX) {
      const vm = buildPrivacyViewModel(state);
      expect(
        legal.indexOf(vm.noticeKind),
        `${where}: '${vm.noticeKind}' is not a legal code`,
      ).not.toBe(-1);
      if (vm.noticeKind === 'none') {
        sawNone += 1;
        expect(vm.noticeLabel, `${where}: code 'none' must render NO label at all`).toBeUndefined();
      } else {
        sawLabelled += 1;
        expect(
          (vm.noticeLabel ?? '').length,
          `${where}: code '${vm.noticeKind}' must carry a NON-EMPTY label`,
        ).toBeGreaterThan(0);
      }
    }
    expect(sawNone, 'ANTI-VACUITY: the matrix must exercise the silent arm').toBeGreaterThan(0);
    expect(sawLabelled, 'ANTI-VACUITY: the matrix must exercise the notice arm').toBeGreaterThan(2);
  });

  it('★ RB52C-DISCONNECTED-VISIBLE BITES: a click that could not be delivered produces its OWN notice, distinct from every other', () => {
    // WRONG IMPL KILLED (ADR-0231 A2-D8) ★: a surface that says NOTHING when the link is
    // absent. `sendGuarded` cannot observe `conn.live()` returning undefined
    // (`undefined?.catch()` is silent), so the player clicks Cancel during a live grace window
    // and nothing happens, ever, with no message. The model already routes this to
    // `disconnected`; the VM must give it copy, and copy that is not the terminal sentence.
    const state = rb52State([
      { kind: 'account-changed', countdown: RB52_GRACE_EARLY },
      { kind: 'cancel-deletion-requested', hasLiveConnection: false },
    ]);
    expect(state.notice, 'ANTI-VACUITY: the model must have taken the non-delivery path').toBe(
      'disconnected',
    );
    const vm = buildPrivacyViewModel(state);
    expect(vm.noticeKind).toBe('disconnected');
    expect((vm.noticeLabel ?? '').length).toBeGreaterThan(0);
    expect(
      vm.noticeLabel,
      'a disconnected link must never read as "your account is permanently deleted"',
    ).not.toBe(PRIVACY_TERMINAL_NOTICE);
    expect(
      state.countdown.cancelPermitted,
      'and the permission is NOT spent by a click that delivered nothing — the control stays ' +
        'usable so the player can retry',
    ).toBe(true);
  });
});

// ===========================================================================
// PRV1-1/PRV1-3 — the status line is FORMATTED, the controls mirror the permissions.
// ===========================================================================

describe('rb-52 privacy view model: status line, labels and enabled state', () => {
  it('★ RB52C-STATUS-FORMATTED BITES: two different injected remaining times render two DIFFERENT status lines, both from privacyBannerLabel', () => {
    // WRONG IMPL KILLED (1) ★ THE ONE THE PLAN NAMES: an AUTHORED duration in the surface's
    // copy — "Your account will be deleted in 7 days". It is invisible to
    // `evals/deletion-grace-wasm-ssot.eval.mjs` G5, which catches only NUMERIC duplicates, and
    // it desyncs silently the moment an operator retunes the real constant. Two different
    // injected windows producing two different sentences is the positive tooth that closes it.
    // WRONG IMPL KILLED (2): a SECOND copy source for the grace phase — a sentence composed
    // inside `buildPrivacyViewModel` instead of delegating to `privacyBannerLabel`. The two
    // would then drift, and the HUD banner and the modal would disagree about the same
    // deadline. Asserting equality with `privacyBannerLabel(countdown)` is what forbids it.
    const early = buildPrivacyViewModel(
      rb52State([{ kind: 'account-changed', countdown: RB52_GRACE_EARLY }]),
    );
    const late = buildPrivacyViewModel(
      rb52State([{ kind: 'account-changed', countdown: RB52_GRACE_LATE }]),
    );
    expect(
      RB52_GRACE_EARLY.remainingMs,
      'ANTI-VACUITY: the two fixtures must really carry different remaining times',
    ).not.toBe(RB52_GRACE_LATE.remainingMs);
    expect(early.statusLabel.length, 'the status line must be non-empty').toBeGreaterThan(0);
    expect(
      early.statusLabel,
      'the same sentence for two different remaining times means the duration was AUTHORED, ' +
        'not formatted from the injected window',
    ).not.toBe(late.statusLabel);
    expect(early.statusLabel).toBe(privacyBannerLabel(RB52_GRACE_EARLY));
    expect(late.statusLabel).toBe(privacyBannerLabel(RB52_GRACE_LATE));
    expect(
      buildPrivacyViewModel(rb52State([{ kind: 'account-changed', countdown: RB52_DUE }]))
        .statusLabel,
    ).toBe(privacyBannerLabel(RB52_DUE));
  });

  it('★ RB52C-STATUS-NEVER-BLANK BITES: every reachable state has a NON-EMPTY status line, including the phases privacyBannerLabel is silent for', () => {
    // WRONG IMPL KILLED ★: `statusLabel: privacyBannerLabel(countdown) ?? ''`. The banner is
    // deliberately SILENT for `active`, `unknown` and `terminal` (it is an ambient HUD warning),
    // so a VM that just forwards it ships a modal whose whole status area is blank in exactly
    // the three states a player is most likely to open it in — including the terminal one,
    // where the surface is the only place the outcome is explained.
    const seen = new Set<string>();
    for (const [where, state] of RB52_MATRIX) {
      const vm = buildPrivacyViewModel(state);
      expect(
        vm.statusLabel.length,
        `${where}: the status line must never be blank (phase '${state.countdown.phase}')`,
      ).toBeGreaterThan(0);
      seen.add(vm.statusLabel);
    }
    expect(
      seen.size,
      'ANTI-VACUITY: one constant sentence for every state would satisfy the loop above — the ' +
        'status line must genuinely discriminate between the phases',
    ).toBeGreaterThan(2);
  });

  it('★ RB52C-ENABLED-MIRRORS-PERMISSIONS BITES: each control is enabled exactly when the model permits it, and all three flags are exercised in both polarities', () => {
    // WRONG IMPL KILLED (1) ★: `deleteEnabled: true` (or any constant). A live Delete button on
    // a `PendingDeletion` account, and a live Cancel button on a `terminal` one, are precisely
    // the "button that silently does nothing" the repo's own claimModel comment bans — and on
    // the terminal row it actively misleads the player into thinking a cancel is still possible.
    // WRONG IMPL KILLED (2): a transposition (delete reading `cancelPermitted`). Both polarities
    // of all three flags are asserted below, so a swap cannot survive.
    // DELIBERATELY NOT PINNED: what an IN-FLIGHT request does to these flags. The contract does
    // not decide it, and inventing a rule here would freeze a choice the plan does not make —
    // every state below has `inFlight === 'none'`, which is stated rather than assumed.
    const polarity = {
      deleteEnabled: new Set<boolean>(),
      cancelEnabled: new Set<boolean>(),
      exportEnabled: new Set<boolean>(),
    };
    for (const [where, state] of RB52_MATRIX) {
      if (state.inFlight !== 'none') continue;
      const vm = buildPrivacyViewModel(state);
      expect(vm.deleteEnabled, `${where}: delete`).toBe(state.countdown.deletePermitted);
      expect(vm.cancelEnabled, `${where}: cancel`).toBe(state.countdown.cancelPermitted);
      expect(vm.exportEnabled, `${where}: export`).toBe(state.countdown.exportPermitted);
      polarity.deleteEnabled.add(vm.deleteEnabled);
      polarity.cancelEnabled.add(vm.cancelEnabled);
      polarity.exportEnabled.add(vm.exportEnabled);
    }
    for (const key of ['deleteEnabled', 'cancelEnabled', 'exportEnabled'] as const) {
      expect(
        polarity[key].size,
        `ANTI-VACUITY: ${key} was ${JSON.stringify([...polarity[key]])} across the whole ` +
          'matrix — a flag that is never both true and false makes its equality assertion a ' +
          'tautology against a constant implementation',
      ).toBe(2);
    }
  });

  it('★ RB52C-LABELS-DISTINCT BITES: the three control labels are non-empty, distinct, and STABLE across every state', () => {
    // WRONG IMPL KILLED (1): one shared label for all three controls ("OK"), or an empty label
    // — a blank <button> is unreachable for every user, sighted or not.
    // WRONG IMPL KILLED (2): labels that change with the phase, so a screen-reader user's
    // remembered control name moves under them between renders.
    const first = buildPrivacyViewModel(PRIVACY_INITIAL);
    for (const label of [first.deleteLabel, first.cancelLabel, first.exportLabel]) {
      expect(label.length, 'every control label must be non-empty').toBeGreaterThan(0);
    }
    expect(
      new Set([first.deleteLabel, first.cancelLabel, first.exportLabel]).size,
      'the three controls must have three DISTINCT names',
    ).toBe(3);
    for (const [where, state] of RB52_MATRIX) {
      const vm = buildPrivacyViewModel(state);
      expect(vm.deleteLabel, `${where}: delete label must not drift`).toBe(first.deleteLabel);
      expect(vm.cancelLabel, `${where}: cancel label must not drift`).toBe(first.cancelLabel);
      expect(vm.exportLabel, `${where}: export label must not drift`).toBe(first.exportLabel);
    }
  });

  it('★ RB52C-CONFIRM-PROMPT BITES: the two-step prompt exists exactly while the confirmation is armed', () => {
    // WRONG IMPL KILLED (1) ★: `confirmPrompt` always defined. The shell keys step two's
    // buttons on it, so an always-present prompt ships a bare "Confirm deletion" beside
    // "Delete my account" at all times — the two-step gate for an irreversible action collapses
    // into a one-click delete.
    // WRONG IMPL KILLED (2): a prompt that is `''` rather than `undefined` when disarmed — the
    // shell's `=== undefined` branch would keep the confirm row painted and blank.
    const disarmed = buildPrivacyViewModel(
      rb52State([{ kind: 'account-changed', countdown: RB52_ACTIVE }]),
    );
    expect(disarmed.confirmPrompt, 'no prompt before step one').toBeUndefined();

    const armedState = rb52State([
      { kind: 'account-changed', countdown: RB52_ACTIVE },
      { kind: 'delete-requested' },
    ]);
    expect(armedState.confirm, 'ANTI-VACUITY: step one must really have armed the model').toBe(
      'delete-armed',
    );
    const armed = buildPrivacyViewModel(armedState);
    expect(
      (armed.confirmPrompt ?? '').length,
      'the armed prompt must be non-empty',
    ).toBeGreaterThan(0);
    expect(armed.confirmPrompt, 'the prompt must not be the status line').not.toBe(
      armed.statusLabel,
    );

    // TRANSITION back, never a static: cancelling step one must REMOVE the prompt again.
    const cancelled = buildPrivacyViewModel(
      rb52State([
        { kind: 'account-changed', countdown: RB52_ACTIVE },
        { kind: 'delete-requested' },
        { kind: 'confirm-cancelled' },
      ]),
    );
    expect(cancelled.confirmPrompt, 'cancelling step one must disarm the prompt').toBeUndefined();
  });
});

// ===========================================================================
// PRV1-1 — the double-submit guard (pure model tier).
// ===========================================================================

describe('rb-52 privacy model: the double-submit guard survives an account refresh', () => {
  it('★ RB52C-DOUBLE-SUBMIT BITES: two delete-confirmed events separated by an account-changed emit exactly ONE call-delete-account', () => {
    // ★ WHY THIS SEQUENCE AND NOT A BARE DOUBLE CLICK. `account-changed` writes
    // `inFlight: 'none'` UNCONDITIONALLY, and `inFlight !== 'none'` is `begin`'s only
    // double-submit guard. ADR-0231 A2-D9 therefore forbids pumping that event from the rAF
    // tick: at ~60Hz the guard would have a ~16 ms lifetime and a double-click would issue TWO
    // `delete_account` calls for one irreversible action. This test encodes the property the
    // change-detected dispatch must preserve — the SECOND confirm must emit nothing even after
    // the refresh has cleared `inFlight`, because delivering step two SPENDS the armed
    // confirmation.
    // WRONG IMPL KILLED (1) ★: a `confirmOnDelivery` that leaves the confirmation ARMED on the
    // delivered path. The effect census below would read two `call-delete-account`.
    // WRONG IMPL KILLED (2): an `account-changed` arm that preserves `confirm` across a
    // phase change (it must disarm whenever the account leaves `active`) — the third-to-last
    // assertion pins the disarm directly.
    const run = rb52Run([
      { kind: 'account-changed', countdown: RB52_ACTIVE },
      { kind: 'delete-requested' },
      { kind: 'delete-confirmed', hasLiveConnection: true },
      // The refresh a real client performs the instant the server echoes the row back.
      { kind: 'account-changed', countdown: RB52_ACTIVE },
      // The second half of a double-click, arriving after that refresh.
      { kind: 'delete-confirmed', hasLiveConnection: true },
    ]);
    expect(
      run.effects.indexOf('call-delete-account'),
      'ANTI-VACUITY: the sequence must actually have emitted the call at least once — a model ' +
        'that emits NOTHING would satisfy a bare "not more than one" count',
    ).not.toBe(-1);
    const calls = run.effects.filter((effect) => effect === 'call-delete-account');
    expect(
      calls.length,
      `exactly ONE delete_account call may be emitted; got ${calls.length} from effects ` +
        `${JSON.stringify(run.effects)}. Two calls for one irreversible action is the defect ` +
        'ADR-0231 A2-D9 exists to prevent',
    ).toBe(1);
    expect(run.state.confirm, 'the armed confirmation is SPENT by the delivered step two').toBe(
      'none',
    );
    expect(
      run.state.inFlight,
      'and the refresh cleared the in-flight marker, which is why the guard had to be the ' +
        'confirmation rather than the marker',
    ).toBe('none');
  });
});
