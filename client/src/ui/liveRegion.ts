// ui/liveRegion.ts — the 500 ms-coalescing, textContent-only sink for the ARIA live region
// (m23-s1, M23 §2.4, A11Y-9).
//
// WHY TIME IS AN ARGUMENT AND NEVER A CLOCK. There is not one fake timer in `client/src`; the house
// pattern is an INJECTED clock (`new ErrorRing(() => Date.now())`, `new EventRing(...)`,
// `createFrameWindow(performance.now())` in main.ts). This module goes one step further and takes
// `nowMs` per CALL, so it holds no clock at all: no `Date.now`, no `performance.now`, no
// `setTimeout`. Every test drives the whole state machine with plain numbers, and the coalescing
// logic is a pure reducer with a one-line DOM sink bolted on.
//
// THE OBLIGATION THAT CREATES, AND IT IS A CLIFF S1-S4 CANNOT CATCH. Because there is no internal
// timer, a message pending at the trailing edge only lands when somebody CALLS `flush(now)`. That
// pump belongs to S5: `flush(performance.now())` once per rAF frame in main.ts's loop. If S5 never
// wires it, the live region is permanently silent and NOTHING in S1-S4 reds — every test here
// passes because every test here calls `flush` itself. Named in the S1 handoff for S5/S10.
//
// TRAILING EDGE, NOT LEADING EDGE. A11Y-9 says "WHEN more than one announcement is produced within
// 500 ms THE SYSTEM SHALL emit only the MOST RECENT", and §2.4 says "later ones replacing earlier".
// A leading-edge throttle emits the FIRST one, which fails the criterion verbatim. The cost is that
// a lone announcement is delayed up to 500 ms; that is a spec-mandated consequence, flagged to M23's
// owner as a UX question rather than silently redesigned here (plan adjudication A9).
//
// THE DEDUP COMPARES AGAINST `#pending ?? #lastWritten`, NOT `#lastWritten` ALONE, and that is a
// measured bug fix (plan adjudication A1). Deduping against what was last PAINTED drops a
// legitimate re-announcement forever: `announce('Box', 0); flush(520); announce('Raising &
// Inventory', 550); announce('Box', 600); flush(1200)` would see the second 'Box' as "unchanged"
// (because `#lastWritten` is still the stale 'Box') and discard it, leaving 'Raising & Inventory'
// as the region's final announcement. Comparing against the value that will ACTUALLY be emitted
// next — the pending slot when one is open, otherwise the painted one — is the correct invariant.
//
// THE PUMP MUST PASS A MONOTONIC CLOCK, AND THAT IS A CALLER CONTRACT, NOT A DEFENSIVE CHECK. The
// window boundary is the plain comparison `nowMs - windowOpenedAtMs >= 500`, so a clock that steps
// BACKWARDS stalls the pending message until it climbs back past the boundary. Measured:
// `announce(m, 2_000_000); flush(100); flush(500_000)` stays silent until `flush(2_000_600)`. S5's
// pump must therefore use `performance.now()` (monotonic since page load) and NEVER `Date.now()`,
// which can step backwards across an NTP correction or a manual clock change. A clamp is
// DELIBERATELY not added: clamping would silently paper over a caller passing the wrong clock, and
// a stalled live region is a bug we want to be able to see and attribute.
//
// `announce` SELF-DRAINS before recording, so a burst never depends on the pump's cadence to make
// room for itself, and `announce`/`flush` share one emit path (`#maybeEmit`) rather than two
// near-identical copies.
//
// THE NODE IS RESOLVED ON EVERY WRITE AND CACHED NEVER — neither a null result nor a non-null one.
// Slice S2 ships `<div id="a11y-live">` in `client/index.html`; it does not exist yet, so S1 must be
// inert-but-correct without it: a missing node returns silently and KEEPS the pending message so it
// lands the moment the node appears. A non-null cache is just as wrong — the element can be
// detached and replaced, and a stale reference would write to a node nobody can read.
//
// `node.textContent = msg` IS THE ONLY DOM WRITE THIS MODULE EVER MAKES. Not `innerHTML` (an
// announced string is player-influenced data — a monster nickname, a trade partner's name — and an
// HTML-parsing sink would be an injection surface), not `setAttribute`, not `appendChild`. The
// `aria-live`/`aria-atomic`/`role` attributes belong to S2's markup, not to a runtime write.

/** The id this module looks the live-region element up by, resolved fresh on every write and never
 *  cached. NOT a contract S2 imports: S2 ships `<div id="a11y-live">` as a hardcoded literal in
 *  `client/index.html`, which cannot import a TS constant. The export exists so this module and its
 *  tests agree on one spelling of the id instead of two — nothing mechanically ties either to the
 *  HTML, so an id typo in `index.html` is caught by S2's own markup gate, not by this constant. */
export const LIVE_REGION_ID = 'a11y-live';

/** The coalescing window (A11Y-9). Exported because it is the contract S5's pump reasons about. */
export const COALESCE_WINDOW_MS = 500;

/**
 * A trailing-edge coalescing announcer. One instance per app (S5 owns the singleton); a class
 * rather than module state so each test gets a fresh, isolated machine with no reset hook.
 *
 * State is exactly three fields: the single pending slot (last write wins inside a window), the
 * timestamp the current window opened at, and the last string actually painted. The window is open
 * iff `#pending !== null`.
 */
export class LiveRegion {
  #pending: string | null = null;
  #windowOpenedAtMs = 0;
  #lastWritten: string | null = null;

  /**
   * Record `message` as the next thing to announce. Drains any already-due message first, then
   * dedups against `#pending ?? #lastWritten` (header) and opens a new 500 ms window only if one is
   * not already open — a burst coalesces into the window the FIRST message opened.
   */
  announce(message: string, nowMs: number): void {
    this.#maybeEmit(nowMs);
    if (message === (this.#pending ?? this.#lastWritten)) return;
    if (this.#pending === null) this.#windowOpenedAtMs = nowMs;
    this.#pending = message;
  }

  /** The pump (S5, once per rAF frame): paint the pending message if its window has elapsed.
   *  `nowMs` must come from a MONOTONIC clock — see the header; a backwards step stalls the
   *  pending message rather than being clamped away. */
  flush(nowMs: number): void {
    this.#maybeEmit(nowMs);
  }

  #maybeEmit(nowMs: number): void {
    const pending = this.#pending;
    if (pending === null) return;
    if (nowMs - this.#windowOpenedAtMs < COALESCE_WINDOW_MS) return;
    const node = document.getElementById(LIVE_REGION_ID);
    // No node yet (S2 has not landed) — keep `#pending` so the message lands once it exists.
    if (node === null) return;
    node.textContent = pending;
    this.#lastWritten = pending;
    this.#pending = null;
  }
}
