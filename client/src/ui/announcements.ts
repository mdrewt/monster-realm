// ui/announcements.ts — the pure state-delta → announcements reducer (m23-s1, M23 §2.4, A11Y-8).
//
// FUNCTIONAL CORE (ADR-0014), and the purity is MECHANICALLY gated rather than reviewed: its test
// file carries no `@vitest-environment` line, so it runs under vitest's NODE environment where
// `document` and `window` do not exist and any DOM reference would throw at the point of use. No
// DOM, no clock, no module state, no IO — same output for the same two arguments, forever.
//
// WHY THE SPLIT FROM `liveRegion.ts` (plan finding F5). §2.4 describes coalescing and transition
// detection in one breath, but a pure reducer cannot coalesce: coalescing is a function of TIME,
// and this module has none. So this module owns A11Y-8 (identical STATES produce zero messages) and
// `ui/liveRegion.ts` owns A11Y-9 (a burst of MESSAGES inside 500 ms collapses to the most recent).
//
// EQUALITY IS FIELD-BY-FIELD, NEVER `prev === next`. The caller builds a fresh snapshot object each
// frame, so two structurally-equal snapshots are never reference-equal; a `prev === next` shortcut
// would announce the same overlay on every single frame it stays open.
//
// COPY IS ALWAYS DERIVED, NEVER A LITERAL. The overlay's accessible name comes from
// `t(OVERLAY_A11Y[id].labelKey)` — the ADR-0205 D5 seam. A literal here would break §2.8's M24
// i18n seam and A11Y-3/4's derived-copy discipline, and it would silently drift from what the
// overlay's own `aria-label` says (`ui/overlayA11y.ts` resolves the SAME key).
//
// `message` IS A PASS-THROUGH CHANNEL, NOT COPY THIS MODULE RESOLVES. It is a caller-resolved
// string that is ALREADY ON SCREEN — never `#status`/`reportError` text (that carries generic
// reducer-failure wording, far outside §2.4's deliberately minimal four transitions), never a
// catalog key. It exists so §2.4(3) (battle turn outcome) and §2.4(4) (NPC prompt / zone change)
// can be wired by the slice that grows their producers, without breaking this frozen API.
//
// THE DECLARED COPY GAP, AND WHO OWNS IT (plan adjudication A4/A11). §2.4(2)/A11Y-22 want "the world
// region is now focused" announced when the last overlay closes. That needs an `a11y.world.region`
// entry, `ui/a11yCopy.ts` is in NO post-S0 slice's `touches:`, and `t()` throws on a miss — so
// topOverlay → null emits NOTHING here rather than inventing a key or faking a literal. Escalated
// to the supervisor as a residual; the slice that adds the key must wire this consumer in the same
// change (A11Y-4's orphan rule).

import { t } from './a11yCopy';
import { OVERLAY_A11Y, type OverlayId } from './overlayRegistry';

/**
 * The two pieces of app state M23 announces. `topOverlay` is the frontmost mutual-exclusion overlay
 * (`visibleIds(probes)[0]` — ui/overlayRegistry.ts), or `null` when the world has focus. `message`
 * is the pass-through channel described in the module header; `''` means nothing is showing.
 */
export interface A11ySnapshot {
  readonly topOverlay: OverlayId | null;
  readonly message: string;
}

/**
 * What should be announced for the transition `prev → next`, in the order it should be spoken:
 * overlay first, then message (§2.4). Total and pure; returns a fresh array (never a shared
 * constant a caller could mutate). An unchanged snapshot yields `[]` (A11Y-8).
 */
export function announcementsFor(prev: A11ySnapshot, next: A11ySnapshot): readonly string[] {
  const out: string[] = [];
  // Rule 1: an overlay came to the top. Rule 2 (top → null) deliberately emits nothing — the
  // declared `a11y.world.region` copy gap in the module header.
  if (next.topOverlay !== prev.topOverlay && next.topOverlay !== null) {
    out.push(t(OVERLAY_A11Y[next.topOverlay].labelKey));
  }
  // Rule 3: a new, non-empty message. Clearing a message to '' announces nothing — silence is not
  // an event a screen-reader user needs read aloud.
  if (next.message !== prev.message && next.message !== '') {
    out.push(next.message);
  }
  return out;
}
