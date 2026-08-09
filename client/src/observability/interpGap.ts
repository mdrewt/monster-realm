// observability/interpGap.ts — m20c (ADR-0180 body amendment), AM2.
//
// "How far in the past is the worst remote character being rendered right now." The value IS
// the renderer's own adaptive delay — imported, never re-derived, so the metric can always be
// reconciled with what is actually on screen (a copied formula drifts the moment the clamps in
// render/config.ts are retuned).
//
// MAX, not sum/mean: the question is "how stale is the worst thing on screen". A sum grows with
// zone population (a busy zone would page as a network incident); a mean hides the one
// badly-connected remote that is visible as stutter.
//
// Zero remotes ⇒ undefined (the caller skips the record call): 0 is a meaningful gap value and
// must not double as "nothing to report". Own-entity exclusion is the CALL SITE's job — main.ts
// passes remotes only.

import { adaptiveInterpDelayMs } from '../render/interpolation';

export function maxRemoteGapMs(
  remotes: Iterable<{ readonly jitterEwma: number }>,
  stepMs: number,
): number | undefined {
  let max: number | undefined;
  for (const remote of remotes) {
    const delay = adaptiveInterpDelayMs(remote.jitterEwma, stepMs);
    if (max === undefined || delay > max) max = delay;
  }
  return max;
}
