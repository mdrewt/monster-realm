# 0141 — ptc5g position-divergence render snap: own-render snaps on a > 1-tile (Chebyshev) authoritative target jump via the existing `snapped` path

**Status:** Accepted
**Date:** 2026-07-24
**Slice:** ptc5g (M-playtest-c.5 pre-gate residuals — position-divergence render snap; resolves M10.5 D-render-snap, EARS ptc5g-1..3)
**Supersedes:** —
**Amends:** —
**Subsystems:** movement-netcode, client-ui
**Decision:** The own-render snaps (does not slide) when the new authoritative own-target is more than one tile (Chebyshev distance) from the slide clock's current target, folded into the existing `snapped` branch — so a zone warp / respawn / server correction / dropped-update catch-up jumps instead of gliding multiple tiles over one `STEP_MS`.

## Context

`RenderResolver` (client/src/render/renderResolver.ts) animates the own character on a local `SlideClock` keyed to the predicted target tile (ADR-0013). It snaps (jumps rather than animates) only on the predictor's `snapped` flag, which is produced from a large *local time* gap since the last frame drain (`predictor.ts` `SNAP_GAP_STEPS = 4` → 800 ms at `STEP_MS = 200`).

M10.5 (fifth-review residual **D-render-snap**) flagged that this covers a *time* gap but not a large *authoritative position* jump: a server correction, a respawn, or a dropped-update catch-up moves the predicted target several tiles at once, and with `snapped = false` the resolver called `setTarget`, gliding those tiles smoothly over a single `STEP_MS` — a visible rubber-band. M10.5 deferred the fix "until a teleport/warp feature exists." That trigger **fired at M11**, which added zone warps; the review re-verified on master that `renderResolver.ts` still had no position-divergence branch, making every large authoritative own jump a potential glide — directly playtest-visible feel. Drew delegated the pre-gate fix as slice **ptc5g**.

### Manifestation analysis (builder note: `#ownClock` lifecycle across a warp)

The builder note required confirming *where* the glide actually manifests, so the fix targets the real case and does not double-handle a case already covered by a reset:

- **Zone warp** (`switchZone`, main.ts:326) and **reconnect** (`onReconnect`, main.ts:1977) both call `resetPredictionState()` → `resolver.reset()`, which drops `#ownClock`. On the next frame the lazy `#ownClock ??= new SlideClock(…, tile, now)` re-seeds **at the new tile** — the render is already at the destination, no glide. These paths are **reset-covered**.
- The glide's **real manifestation** is therefore a large authoritative jump that does *not* reset the predictor: a **server correction** (a reconcile that sets `#predicted` more than one tile from the pre-reconcile tile), a **dropped-update catch-up** (the predictor's paced drain applies up to `MOVE_QUEUE_CAP = 2` due moves in one frame after a 400–799 ms hitch — below the 800 ms time-gap `snapped` threshold), and a **same-zone respawn**.

The Chebyshev check covers all of these uniformly through the one existing snap path, and does **not** double-handle the reset-covered warps: after `reset()` the clock is re-seeded *at* the new tile in the same `resolve` call, so the distance is 0 and no snap fires (seeding and snapping to the seed tile are visually identical anyway).

## Decision

In `RenderResolver.resolve`, own-path only, extend the **existing** snap decision (no parallel mechanism, per EARS ptc5g-1):

```ts
const tile = { x: predicted.pos.x, y: predicted.pos.y };
this.#ownClock ??= new SlideClock(this.#stepMs, tile, now);
const targetGapTiles = chebyshev(tile, this.#ownClock.target);
if (snapped || targetGapTiles > SNAP_DIVERGENCE_TILES) this.#ownClock.snapTo(tile, now);
else this.#ownClock.setTarget(tile, now);
```

with a module-private pure helper `chebyshev(a, b) = Math.max(|a.x−b.x|, |a.y−b.y|)` and a named `const SNAP_DIVERGENCE_TILES = 1` (parallels `SNAP_GAP_STEPS`, keeps the EARS threshold greppable). The predictor and `SlideClock` are untouched.

Three sub-decisions, each a "why a future maintainer would ask":

1. **Compare against `#ownClock.target`, not `positionAt(now)`.** The spec's referent is "the slide clock's current target." `target` is the last-commanded destination tile — a discrete, frame-timing-independent value, so the snap decision is deterministic and unit-testable. Comparing against the animated `positionAt(now)` would make the boundary sensitive to *when in the slide* the update lands, and could *under*-trigger a snap right at slide start (`positionAt ≈ origin`). `.target` is both the spec's wording and the more robust reference.
2. **Chebyshev, not Manhattan or Euclidean.** Chebyshev = "how many tiles in the furthest single axis," a direct proxy for the largest visible per-axis jump. Under Chebyshev a hypothetical 1-tile diagonal (`+1,+1`) is distance 1 → still slides (a smooth short diagonal); Manhattan would score it 2 and wrongly snap. This asymmetry is intentional (see Consequences).
3. **Threshold `> 1`.** A normal single-axis step is exactly Chebyshev 1 and must still slide (the anti-stutter core, ADR-0013); anything strictly greater is a jump. This is the spec author's chosen threshold (EARS ptc5g-1).

## Consequences

- Zone warps, respawns, server corrections, and multi-tile catch-ups now snap the own render to the destination instead of gliding — the M10.5 D-render-snap defect is closed before the playtest.
- **A same-axis 2-tile catch-up now snaps where it previously fast-glided (documented, intended).** After a 400–799 ms main-thread/network hitch the paced drain can apply both queued moves in one frame (`MOVE_QUEUE_CAP = 2`), advancing the target 2 tiles in one axis (Chebyshev 2) with `snapped = false` (the gap is under the 800 ms `SNAP_GAP_STEPS` threshold). This is exactly the "dropped-update catch-up" ptc5g-1 names, so it snaps by design rather than gliding at ~2× walk speed. The boundary is deliberately **direction-dependent**: an *orthogonal* 2-move catch-up (e.g. North-then-East, net `+1,+1`) is Chebyshev 1 and still slides — a single-tile-per-axis diagonal is a small, acceptable glide, whereas a straight-line 2-tile jump reads as a fast teleport-glide that is cleaner to snap. Recorded here as a visible gated fact (per the milestone's Decision-A "amend + pin, don't silently surprise" discipline) rather than left as an implicit side effect.
- **The "chain of ≤ 1-tile hops smuggles a large net divergence" concern (raised at review) is not reachable.** `resolve()` runs once per rAF frame and reads `predictor.predicted` once (main.ts:2058), while reconciles are batch-driven and decoupled; multiple between-frame reconciles collapse into a single net jump that the Chebyshev check *does* catch. The server also cannot sustain more than one tile of own authoritative movement per `STEP_MS` (ADR-0052), so a genuine burst arrives as one multi-tile reconcile (→ snap), never as many individually-rendered 1-tile hops. Each 1-tile hop that *is* rendered on its own frame is a genuine single-tile move and gliding it is correct. The proof-of-teeth (large-jump-snaps) exercises the collapse path.
- Non-finite input is unreachable: own tile coordinates are `i32` server columns parsed at the convert boundary (parse-don't-validate), never fractional/`NaN`; and `Math.max(NaN, …) > 1` is `false`, so the helper fails *safe* (slide) even if that invariant were ever violated — no guard added (YAGNI).

### ptc5g-3 residuals disposition (accepted with evidence — no code change in this slice)

- **(a) Reconcile-internal-drain swallowing a real time-gap snap — already resolved (M12.5d-3), not re-implemented.** The M10.5 note cited an old version where reconcile's drain reset the snap-gap timer. In current code `#lastFrameDrainAt` is written **only** in the frame-loop `drain()` (predictor.ts:281); reconcile's step-4 `#stepForward` (predictor.ts:246) never touches it, so a reconcile drain between frames cannot mask a real inter-frame time-gap snap. This is pinned by a live proof-of-teeth: `predictor.test.ts:1526` — "BITES: reconcile drain between frame drains does NOT reset the snap gap timer" (M12.5d-3, three cases incl. triple-reconcile). This ptc5g position-divergence check is *complementary* to that time-gap fix (it catches position jumps that carry no large time gap), so residual (a) is genuinely retired, not deferred.
- **(b) ~1.5-step remote sprite pose/position skew (cosmetic) — accepted by design.** Remote entities HOLD-not-extrapolate through the interpolation buffer (ADR-0013), so they render ~one render-delay behind authority by construction. The skew was already tightened from 1.5→1.0 step at M12.5d-1 (`interpDelayMs`) and made per-entity adaptive via EWMA jitter at ADR-0090. It lives entirely on the remote interpolation path, outside this slice's own-path blast radius. Retuning a determinism-sensitive smoothing constant immediately before a fun-hypothesis playtest is speculative with no evidence it hurts — the same anti-YAGNI reasoning the milestone applied in Decisions A and E. Accepted; revisit only if playtest smoothness testing shows remote pops.

## Alternatives considered

- **Compare against the animated `positionAt(now)`** — rejected: frame-timing-sensitive and can under-trigger at slide start (sub-decision 1).
- **A cumulative/windowed lag accumulator** — rejected: adds state and defeats determinism for a scenario that is unreachable given once-per-frame `resolve` and the `STEP_MS` server cadence; the spec asks for a single target-to-target comparison.
- **A new parallel snap flag/field** — rejected: EARS ptc5g-1 explicitly requires extending the existing `snapped` path.
- **Fix residual (a) here / retune residual (b)** — rejected: (a) is already fixed and guarded; (b) is speculative pre-gate tuning (see disposition above).
