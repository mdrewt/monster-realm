// observability/interpGap.ts — AM2.
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
// Only the remotes in `zoneId` count: the store also holds the characters of a zone this client
// is still subscribed to but does not draw, and their jitter is not on screen.
//
// Zero remotes in the zone ⇒ undefined (the caller skips the record call): 0 is a meaningful gap
// value and must not double as "nothing to report". Own-entity exclusion is the CALL SITE's job —
// main.ts passes remotes only.

import { adaptiveInterpDelayMs } from '../render/interpolation';

export function maxRemoteGapMs(
  remotes: Iterable<{ readonly jitterEwma: number; readonly row: { readonly zoneId: number } }>,
  zoneId: number,
  stepMs: number,
): number | undefined {
  let max: number | undefined;
  for (const remote of remotes) {
    if (remote.row.zoneId !== zoneId) continue;
    const delay = adaptiveInterpDelayMs(remote.jitterEwma, stepMs);
    if (max === undefined || delay > max) max = delay;
  }
  return max;
}
