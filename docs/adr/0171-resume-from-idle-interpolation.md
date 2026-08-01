# 0171 — Resume-from-idle interpolation smoothness: idle-gap-gated jitter EWMA + re-anchored lerp bracket

**Status:** Accepted
**Date:** 2026-08-01
**Slice:** 11r-f (M-postgate-eleventh-review-residuals — resume-from-idle smoothness; EARS E1)
**Supersedes:** —
**Amends:** ADR-0090
**Subsystems:** movement-netcode, client-ui
**Decision:** Gate the per-character jitter EWMA to inter-arrival intervals <= 3x stepMs (idleness is not jitter) and re-anchor any interpolation bracket wider than 2x stepMs to [next-stepMs, next], holding at prev below it.

## Context

Two verified pure-core defects (eleventh multi-lens review @ `3063149`) made every
remote/NPC pause-resume ugly at production `STEP_MS = 200`:

1. **The jitter EWMA had no gap bound** (`store.ts` `upsertCharacter`). An idle remote's
   resume fed `deviation ≈ gap` into the estimator: one 5 s pause → `deviation ≈ 4800` →
   `ewma` jumps to `600` → raw delay `200 + 2×600 = 1400` → clamped to the 2.5-step max
   (500 ms) for ~10 samples (≈ 2.1 s of decay until `raw < 500`). A single pause bought
   two seconds of maximum remote lag. Idleness is not jitter.
2. **The bracket lerp spanned the whole gap** (`interpolateHistory`). After gap `G` the
   first resume frame lerps at `a ≈ (G−D)/G` — at `G = 5000, D = 500` that is `a ≈ 0.9`:
   a ~0.9-tile instant pop, then a crawl of the remaining ~0.1 tile over `D` ms.

EARS E1: a 1-tile step after a ≥ 5 s idle renders as one smooth ≤ `stepMs` slide —
no pop, no post-resume max-delay clamp. Pure-core, client-only.

## Decision

### D1 — EWMA idle-gap gate (`store.ts`, `JITTER_IDLE_GAP_STEPS = 3`)

Skip the EWMA update when `interval > JITTER_IDLE_GAP_STEPS × stepMs` (`<=` still
updates: at exactly `3×stepMs = 600 ms` the sample is admitted, deviation 400). The gate
is **one-sided** — burst co-arrivals (`interval ≈ 0`, deviation ≈ `stepMs`) still update:
small intervals are genuine delivery jitter; only large ones are idleness.

**K = 3 derivation.** Floor: `K > 2`, because a latency spike that coalesces two ticks
presents as one `interval ≈ 0` plus one `interval ≈ 2×stepMs` — the exact pattern
ADR-0090 exists to absorb, so `2×stepMs` must stay inside the gate. Ceiling: one
admitted sample moves the delay by `COEFF × α × deviation = 0.25×(K−1)×stepMs`; at
`K = 3` that caps the per-sample delay movement at `+0.5` steps, while `K ≥ 7` would let
a single sample saturate the 2.5-step clamp outright (`1 + 0.25(K−1) ≥ 2.5`). On the
scheduled-tick local deployment (ADR-0129), three missed steps is an idle character,
not a network event.

**Bookkeeping is deliberately NOT gated.** The `receivedAt: now` baseline write and the
ring append stay unconditional. Gating the baseline would freeze the estimator forever
for any character that ever idled (the next on-cadence arrival would measure
`G + stepMs`, be gated again, and so on); dropping the append would starve the
re-anchored bracket of its resume snapshot. The EWMA value is carried across the gap
unchanged — **not reset** — the pre-idle estimate is the best available prior (D-C).

### D2 — Bracket re-anchor (`interpolation.ts`, `REANCHOR_SPAN_STEPS = 2`)

In `interpolateHistory`, after the bracket scan and after the existing `span ≤ 0` guard
(which stays on the **raw** span — re-anchoring an inverted span would corrupt the
bracket), when `stepMs > 0 && rawSpan > REANCHOR_SPAN_STEPS × stepMs`:

- the lerp's lower edge becomes `lower = next.receivedAt − stepMs`;
- `renderTime ≤ lower` → **hold at `prev`'s position** (the "dead zone": the character
  genuinely stood there for the whole gap — ADR-0013's hold-don't-drift applied to the
  interior of a bracket);
- otherwise lerp over `[lower, next.receivedAt]` (an exactly-`stepMs` window).

**Threshold strictly `> 2×stepMs`.** Exactly `2×stepMs` is one dropped tick — a
legitimate two-step slide the adaptive delay is designed to bridge; re-anchoring it
would degrade a smooth 400 ms slide into hold-plus-200 ms. A threshold of 1 step would
re-anchor the very burst windows ADR-0090's depth-4 ring exists to smooth. The lower
edge is `next − stepMs`, never `prev + stepMs`: the slide must **end** when the new
authoritative position becomes current (front-anchoring would move the character at gap
start and freeze it for the rest of the gap). Outer HOLD (`renderTime ≥ newest`) and
oldest-clamp paths are untouched and evaluated first; multi-bracket rings re-anchor
per-bracket by construction.

**Continuity.** `D = clamp(stepMs + 2×jitter, 0.5×stepMs, 2.5×stepMs) ≥ stepMs` always
(base = `stepMs` makes the MIN clamp unreachable), so at the resume arrival `T1`,
`renderTime = T1 − D ≤ T1 − stepMs = lower`: the re-anchored window is always entered
from the dead-zone side at `a = 0` — an entry pop is impossible **under constant D**.
With per-frame adaptive D the same bounded wobble that ordinary brackets already
exhibit applies (see Consequences).

### D3 — API: `interpolateHistory(snapshots, renderTime, stepMs = 0)` + one-line consumer wiring

`stepMs` defaults to `0` = re-anchoring disabled = today's math byte-for-byte. The sole
production consumer (`RenderResolver.resolve`, verified by the union of both code
graphs) passes its existing `#stepMs` — a one-argument change declared as
`touches-delta` (the spec's literal touch-set omits the consumer, but without the
wiring the fix is inert and E1 is a rendering criterion). Kept optional rather than
required: 10 of the 11 existing call sites are the legacy-contract regression suite in
`interpolation.test.ts`, and keeping them unchanged preserves "no `stepMs` ⇒ old math"
as a tested property. The definition-site JSDoc warns that omitting `stepMs` disables
the ADR-0171 re-anchor.

### D4 — `JitterEstimator` gets a divergence note, not the gate

The class has **no production caller** (both graphs agree; the shipped estimator is the
inline EWMA in `store.ts`, duplicated because `net → render` imports are forbidden,
ADR-0014). Mirroring the gate into a class already queued for unification/deletion
(D-B) would grow pre-scheduled-for-removal logic; instead its JSDoc now names the
divergence and points here. A doc that names its divergence is not drift (ADR-0142
class); a silently-mirrored dead class is still dead.

### D5 — Constants file-local, single-consumer

`JITTER_IDLE_GAP_STEPS = 3` lives once in `store.ts`; `REANCHOR_SPAN_STEPS = 2` lives
once in `interpolation.ts`. The shared-constants modules (`shared/interpConfig.ts`,
`render/config.ts`) are outside this slice's touch-set, and with D4 there is no
duplication to consolidate — each constant has exactly one consumer file. Both are
exported and pinned by literal-value tests (an implementer cannot silently relax them).
Consolidation is deferral D-A. The two values are deliberately independent (different
files, different failure modes) — a future consolidation must not silently unify them.

## Considered alternatives

- **Store-side re-anchor** (rewrite the prior snapshot's `receivedAt` to `now − stepMs`
  on a gap append). Rejected: ADR-0090's own Considered-alternatives already rejected
  retroactive re-stamping ("violates the immutable-record contract"); it is incorrect
  for `D > stepMs` (the arrival frame's `renderTime` lands below the re-stamped edge
  and falls into the previous, un-re-anchored bracket — a backward nudge plus hitch);
  it puts render policy inside the net layer's data model; and it tests the wrong core
  (E1 is about the lerp). A store test pins snapshots staying un-mutated.
- **Splice helper** (`reanchorGaps(snapshots, stepMs)` pre-transform inserting a
  synthetic same-position sample at `next − stepMs`). Viable, but the dead-zone hold
  becomes implicit (same-position lerp), it adds a synthetic-sample concept for equal
  line count, and it makes the module shallower. Rejected.
- **Data-derived nominal step** (median ring inter-arrival instead of the `stepMs`
  param). Fails the spec's own case: an NPC stepping every 5 s has ring spacing 5000 —
  the re-anchor would never fire. The renderer already holds the true `stepMs`.
- **Module-level `setInterpStepMs()`**. Hidden mutable global in a pure core.
- **Required third parameter.** Would churn 10 legacy-contract call sites and lose the
  "no `stepMs` ⇒ old math" regression property; the compile-time-forcing benefit is
  small with a single production consumer pinned by a liveness test.
- **Resetting the EWMA across a gap.** No evidence for a reset prior; carried-forward
  is the best estimate of the connection's real jitter (D-C).

## Consequences

- E1 holds: after any idle gap, a 1-tile step renders as a hold at the old tile until
  the resume row arrives, then one `stepMs`-long slide ending `D` ms after arrival. With
  a clean estimator `D = stepMs = 200`; with genuine pre-idle jitter the slide starts
  later but is still exactly `stepMs` long — the E1 "no post-resume max-delay clamp"
  clause is scoped to *the resume interval itself must not cause the clamp* (genuine
  pre-idle jitter legitimately keeps `D` high; a test pins the EWMA crossing the gap
  bit-identical).
- **Bounded evolving-D wobble (accepted residual).** `RenderResolver` recomputes the
  delay every frame, so an EWMA bump from a post-resume arrival can move `renderTime`
  backward across frames — inside a re-anchored window that reads as a back-step of
  `min(a_before, ΔD/stepMs)` tiles, closed-form worst case **0.2 tile** (second arrival
  40 ms after the resume row), floored at `prev` by the dead zone. This is the same
  wobble class and bound ordinary `stepMs`-wide brackets already exhibit today when the
  EWMA moves (ADR-0090 accepted it); the re-anchor extends those semantics to gap
  brackets rather than introducing a new class. A deterministic test pins the bound.
  Delay smoothing (slew-limiting `D`) is out of scope (D-F).
- **Slow-cadence movers render hold-then-slide, deliberately.** An entity whose row
  updates arrive uniformly every `> 2×stepMs` (e.g. a slow-wander NPC) renders as rest →
  one `stepMs` slide per step — matching the own-player SlideClock motion language
  (slide `stepMs`, rest until the next step) instead of the pre-fix continuous crawl
  (1 tile per cadence of constant drift). Sustained *network* degradation does not
  produce this shape: WebSocket delivery of a stalled fast mover arrives as bursts
  (small intra-burst intervals still update the EWMA) or as multi-tile deltas
  (`shouldSnap` → teleport, M12.5d-2). At such cadences the gate also freezes the EWMA
  (every interval `> 3×stepMs`) — harmless by design: the re-anchor makes wide-bracket
  rendering independent of span, so no delay adaptation is needed there, and the delay
  stays at base instead of inflating toward the clamp. A sustained-cadence test pins
  this shape as intended.
- **Scope boundary: only 1-tile resumes are smoothed.** A ≥ 2-tile catch-up resume
  trips `shouldSnap` (ring reset → teleport), unchanged and intended — interpolating
  multi-tile jumps smears sprites through walls. Pinned by a test.
- Legacy 2-arg `interpolateHistory` behavior is preserved exactly and remains tested.

## Residuals / deferrals

- **D-A** — consolidate `JITTER_IDLE_GAP_STEPS` / `REANCHOR_SPAN_STEPS` into the shared
  interp-config modules (out of this slice's touch-set).
- **D-B** — `JitterEstimator` has no production caller: unify with the store's inline
  EWMA via a `shared/` pure core, or delete the class.
- **D-C** — idle-decay/reset policy for `jitterEwma` across long gaps (carried-forward
  is the current policy).
- **D-D** — genuinely irregular server cadences (NPC wander schedules) — no evidence of
  a problem yet; the sustained-cadence test documents the rendering shape.
- **D-E** — an e2e/visual smoothness proof (happy-dom does no layout; all teeth here
  are behavioral on the pure cores).
- **D-F** — per-frame delay recomputation wobble (slew-limit `D`) — pre-existing
  ADR-0090 class, bounded, documented above.
- **Pre-existing, untouched:** the store's burst synthetic-timestamp chain can invert
  ring ordering at `stepMs < 40` (unreachable at production 200; the B-2 guard comment
  overclaims prevention). Out of scope; the ptc5f-pinned comment block is not edited by
  this slice.
