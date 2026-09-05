// ui/privacyBanner.ts — the PURE copy layer for the deletion-grace countdown (rb-51, PRV1-1).
//
// FUNCTIONAL CORE (ADR-0014). No DOM, no SDK, no store, NO CLOCK: the only input is the
// `DeletionCountdown` that `ui/privacyModel.ts` already derived. `main.ts` owns the element and
// the frame tick; this module owns what the player reads. Splitting it this way is what makes the
// wording exact-string testable — `main.ts` is excluded from the coverage denominator
// (`vite.config.ts`), so copy composed inline in the frame body would be untested by construction.
//
// WHY THE GRACE WINDOW IS NOWHERE IN THIS FILE. The window's single source of truth is
// `game_core::DELETION_GRACE_MS_DEFAULT`, reached from the client through the
// `deletion_grace_ms_default()` wasm accessor (ADR-0212). This module never sees it: it formats
// the `remainingMs` it is handed. A hard-coded duration here — "7 days" in prose just as much as
// a number — would desync the moment an operator retunes the real constant, which is precisely
// the drift `evals/deletion-grace-wasm-ssot.eval.mjs` exists to catch (its own header names this
// slice's positive tooth: "its countdown label must be FORMATTED FROM this accessor, never
// authored as a literal duration").
//
// WHY THE LABEL ALWAYS RUNS DOWN TO SECONDS. PRV1-1 asks for a TICKING countdown. A formatter
// that renders the two largest units ("6d 23h") stands still for an hour at a time at the top of
// a week-long window, which reads as a broken clock rather than a deadline.
//
// THREE OUTCOMES, THREE SENTENCES — the broke-vs-dark discipline (ADR-0154) the model is built
// around. A COMPUTED remaining time gets the countdown; a computed ZERO gets `due` (the reaper may
// fire at any moment, so a number that keeps counting nothing would be misleading); a DARK window
// — pending, but the remaining time is unknown — says so in words. Fabricating "0s" there would
// claim an irreversible deadline had arrived.

import type { DeletionCountdown } from './privacyModel';

/** The player-facing copy, spelled once. Authored here rather than in `ui/a11yCopy.ts`: that
 *  catalog is the ACCESSIBLE-NAME catalog for the sixteen overlays (ADR-0205 D4/D5), and this banner is
 *  deliberately not an overlay. */
const DARK_LABEL = 'Account deletion pending — time remaining unavailable';
const DUE_LABEL = 'Account deletion is due now';
const GRACE_PREFIX = 'Account deletion in ';

// Unit sizes are DERIVED from each other rather than written out. Every constant below is a small
// ratio, so no expression in this file is a numeric duplicate of any tunable window.
const MS_PER_SECOND = 1_000n;
const SECONDS_PER_MINUTE = 60n;
const MINUTES_PER_HOUR = 60n;
const HOURS_PER_DAY = 24n;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

/**
 * `remainingMs` as `Xd Yh Zm Ws`, truncated to whole seconds and starting at the largest
 * non-zero unit. Every group from that unit down to seconds is present even when zero, so the
 * seconds group — the one that moves every tick — is never dropped.
 *
 * Truncation, never rounding: inside the final second the honest reading is `0s`, not `1s`.
 */
function formatDuration(remainingMs: bigint): string {
  // Clamped rather than signed. The model already clamps at `0n`, so a negative here means a
  // wiring slip subtracted in the wrong direction — rendering `-5s` would advertise the bug to
  // the player instead of degrading to the last honest value.
  const clamped = remainingMs > 0n ? remainingMs : 0n;
  const totalSeconds = clamped / MS_PER_SECOND;
  const days = totalSeconds / SECONDS_PER_DAY;
  const hours = (totalSeconds / SECONDS_PER_HOUR) % HOURS_PER_DAY;
  const minutes = (totalSeconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const groups: string[] = [];
  if (days > 0n) groups.push(`${days}d`);
  if (groups.length > 0 || hours > 0n) groups.push(`${hours}h`);
  if (groups.length > 0 || minutes > 0n) groups.push(`${minutes}m`);
  groups.push(`${seconds}s`);
  return groups.join(' ');
}

/**
 * What the countdown banner should say, or `null` when there is nothing to say.
 *
 * TOTAL: never throws, for any input. The caller writes this from a per-frame rAF tick, so a
 * throw here would not merely blank the banner — it would take the render loop's whole frame body
 * down with it.
 *
 * KEYED ON THE PHASE, never on `remainingMs` alone: an `active` account carrying a stale
 * timestamp, and a `terminal` one that is already permanently deleted, must both stay silent.
 */
export function privacyBannerLabel(countdown: DeletionCountdown): string | null {
  switch (countdown.phase) {
    case 'active':
    case 'unknown':
    case 'terminal':
      return null;
    case 'due':
      return DUE_LABEL;
    case 'grace':
      // A non-bigint reaches here only from a wiring slip (the model degrades the NUMBER, never
      // the phase — `privacyModel.ts`). Dark is the honest reading of "we cannot compute it".
      return typeof countdown.remainingMs === 'bigint'
        ? GRACE_PREFIX + formatDuration(countdown.remainingMs)
        : DARK_LABEL;
  }
}
