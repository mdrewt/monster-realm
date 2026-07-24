# ADR-0090 — Adaptive remote-interpolation delay (M13.5e)

**Status:** Accepted
**Date:** 2026-07-10
**Slice:** m13.5e
**Supersedes:** ADR-0075 §12.5d-1
**Amends:** —
**Amended-by:** ADR-0142
**Subsystems:** client-ui, movement-netcode
**Decision:** Replace fixed interpolation delay with an adaptive EWMA jitter estimator per character and variable snapshot depth (max 4) to handle burst delivery without pops.


**Status:** Accepted  
**Date:** 2026-07-10  
**Milestone:** M13.5e  
**Supersedes:** ADR-0075 §12.5d-1 (the fixed 1.0×STEP_MS delay and 2-snapshot depth are replaced by this adaptive scheme; all other ADR-0075 decisions remain in force)

## Context

ADR-0075 fixed the 1.5× hold/jump stutter by reducing `INTERP_DELAY_STEPS` to 1.0 and pairing it with a 2-snapshot store depth. This is correct for a smooth network but breaks under **burst delivery**: when the SDK coalesces multiple server ticks into one flush (e.g., a brief 200 ms latency spike → two 200 ms ticks arrive in one WebSocket message), both authoritative snapshots for the same entity carry the same local `receivedAt`. The `interpolate` function cannot distinguish them (span = 0 → degenerate → immediate jump to latest), producing a 1-tile visual pop for every burst.

Evidence: `store.ts upsertCharacter` sets `receivedAt = performance.now()` at the SDK row callback, and the SDK delivers a burst's rows synchronously in one event-loop turn → consecutive calls are within microseconds of each other. With the fixed 2-snapshot depth, the pre-burst snapshot is overwritten by the first burst tick, removing the genuine earlier timestamp needed to bracket the render window.

The seventh-review (D-13.5-1, resolved 2026-07-04) mandated an **adaptive** scheme, not a fixed deepening, with mandatory what/why comments.

## Decision

### What: EWMA jitter estimator per character

Each `StoredCharacter` carries a `jitterEwma` field — the EWMA (exponentially-weighted moving average) of absolute deviation of the inter-arrival interval from the nominal `STEP_MS`.

**Why:** Jitter (arrival-timing variance) is the root cause of burst pops. Estimating it per-character rather than globally allows each remote entity's delay to adapt independently (e.g., NPCs on the server tick exactly, but a remote player's moves may cluster when the player holds a key).

**EWMA formula:** `jitter_new = α × |interval - STEP_MS| + (1-α) × jitter_old`  
α (`INTERP_JITTER_ALPHA = 0.125`) — small α = long memory, slow reaction; 0.125 is a common smoothing choice for network metrics (8-sample half-life).

On the first arrival for an entity, `jitterEwma` is initialized to 0 (no history → assume smooth).

### What: Adaptive delay target, bounded

`adaptiveInterpDelayMs(jitterMs, stepMs)`:

```
delay = clamp(stepMs + JITTER_COEFF × jitterMs, MIN_DELAY, MAX_DELAY)
```

where:
- Base = 1.0 × `stepMs` (same as ADR-0075 minimum — no added latency on a smooth network)
- `INTERP_JITTER_COEFF = 2.0` — each millisecond of estimated jitter adds 2 ms of delay headroom
- `INTERP_MIN_DELAY_STEPS = 0.5` — never go below 0.5×stepMs (avoids over-fitting to a brief smooth window)
- `INTERP_MAX_DELAY_STEPS = 2.5` — caps at 2.5×stepMs (at stepMs=200ms → 500 ms max; beyond this the latency cost exceeds the smoothness benefit; see Considered alternatives)

**Why the bounds:** The lower bound (0.5×) protects against jitter estimator underflow after a long smooth stretch followed by a sudden burst. The upper bound (2.5×) caps the perceptible remote-entity lag — on a catastrophically jittery connection, the player sees positional lag rather than pops, which is a better user experience (lag is expected on bad networks; pops are surprising).

### What: Variable snapshot depth, driven by delay target

`StoredCharacter.snapshots` is an array of up to `INTERP_MAX_DEPTH = 4` snapshots (newest last). The `latest` and `prev` fields are derived aliases (`snapshots[last]` and `snapshots[last-1]`) for backward compatibility with existing tests.

`upsertCharacter` maintains the ring buffer: new snapshot appended, oldest evicted when length exceeds `INTERP_MAX_DEPTH`. The ring always retains the genuine pre-burst snapshot (which has an earlier `receivedAt`), giving `interpolateHistory` a bracket that spans the render window even during a burst.

**Why depth 4:** With max delay 2.5×stepMs = 500 ms and arrivals every 200 ms, the render window needs snapshots reaching back 3 nominal steps (600 ms). Depth 4 provides one snapshot of headroom beyond that worst case. Depth beyond 4 adds memory and lookup cost for no measurable benefit.

**Burst detection + synthetic timestamps:** When `upsertCharacter` is called for an entity that already has a `latest` snapshot and `now` is within `BURST_EPSILON_MS = 20 ms` of `latest.receivedAt`, the new snapshot is a burst co-arrival. In this case, the STORE assigns the new snapshot `receivedAt = latest.receivedAt + STEP_MS` (a synthetic future timestamp — one step ahead of the previous arrival) **only when** `existing.latest.receivedAt + STEP_MS <= now + BURST_EPSILON_MS` (i.e., the synthetic time doesn't exceed wall-clock time). This preserves the logical order while creating a non-zero span for interpolation. The `jitterEwma` update uses `0` as the measured interval for a burst arrival (zero-interval deviation = STEP_MS jitter).

**B-2 guard constraint (known limitation):** For typical production `STEP_MS` values (≥ 100 ms), the guard `synthetic ≤ now + 20` is almost always false (synthetic = now + STEP_MS >> now + 20), so synthetic timestamps are not applied. Both burst snapshots retain their real wall-clock `receivedAt` values (typically within < 20 ms of each other rather than truly zero). The ring buffer's depth-4 history retains the genuine pre-burst snapshot as the oldest anchor, and `interpolateHistory` falls back to the `span ≤ 0` graceful-degradation path (HOLD at latest position) for any true-zero-span collisions. This is safe but does not provide the ideal temporal spread described above. The guard exists to prevent ring-buffer ordering violations: an uncapped synthetic can push `latest.receivedAt` into the future, causing the next genuine arrival (at wall-clock time) to sort BEFORE it in the ring — breaking `interpolateHistory`'s oldest-first invariant.

**Why synthetic timestamps only on the burst arrival, not retroactively:** Retroactively adjusting a previously committed snapshot would violate the store's immutable-row contract. The synthetic timestamp is applied to the INCOMING snapshot only, leaving the existing latest unchanged.

### What: `interpolateHistory(snapshots, renderTime)` for history-aware bracket

A new function that searches the snapshot array for the tightest bracket around `renderTime`:

1. Walk from oldest (index 0) to newest (last index).
2. Find the last snapshot with `receivedAt ≤ renderTime` (→ `prev`).
3. Find the first snapshot with `receivedAt > renderTime` (→ `next`).
4. If no `prev`: clamp to oldest.
5. If no `next`: HOLD at newest.
6. Otherwise: linear interpolate between `prev` and `next`.

**Why not reuse `interpolate(prev, latest, renderTime)`:** The 2-argument form can only bracket the last two snapshots. With a deeper history containing a pre-burst snapshot with a genuine earlier timestamp, we need to search across all snapshots to find the correct bracket.

**Tie-breaking (same receivedAt):** When multiple snapshots share `receivedAt` (the unrepaired burst case — should be rare with synthetic timestamps), the last matching snapshot is used as `prev`, which resolves to the latest position at that timestamp. Downstream this means a single-frame hold at the burst position, which is preferable to a position regression.

### What: `RenderResolver` uses adaptive delay per character

`RenderResolver.resolve()` now computes `renderTime = now - adaptiveInterpDelayMs(c.jitterEwma, this.#stepMs)` per character and calls `interpolateHistory(c.snapshots, renderTime)` instead of `interpolate(c.prev, c.latest, ...)`.

**Why per-character:** Different entities may have different jitter profiles. NPCs tick exactly at STEP_MS (server-authoritative) and converge to near-zero jitter → 1.0×stepMs delay (same as before). A burst-receiving remote player gets a higher delay only for themselves, not all entities.

## Consequences

- **Smooth burst delivery:** Two ticks arriving in one flush produce a smooth position ramp over 1–2 step windows rather than an instant pop. The proof-of-teeth test (`interpolation.test.ts`: "two-tick burst monotone") verifies this.
- **No added latency on smooth networks:** When `jitterEwma ≈ 0`, `adaptiveInterpDelayMs` returns exactly `1.0 × stepMs` — identical to the ADR-0075 baseline. The EWMA's long memory (α=0.125) prevents a single smooth stretch from masking a genuinely jittery connection.
- **Pre-burst snapshot preserved:** `INTERP_MAX_DEPTH = 4` ensures the genuine pre-burst snapshot (with an authentic earlier `receivedAt`) is never evicted during a burst, giving the interpolator a real anchor to bracket against.
- **Backward-compatible API:** `prev` and `latest` fields on `StoredCharacter` are kept as derived aliases. Existing `renderResolver.test.ts` fixtures that construct `{ prev, latest }` only need a `snapshots: []` addition (the resolver now calls `interpolateHistory(c.snapshots, ...)` but falls back to `interpolate(c.prev, c.latest, ...)` when snapshots is empty). Tests that use `store.upsertCharacter` automatically get the deeper history.
- **`AuthoritativeStore` takes `stepMs`:** Main.ts passes `STEP_MS` from the wasm export. Passing 0 (the default for tests that construct the store without stepMs) disables burst detection (BURST_EPSILON check → 0+20 > any interval, which is fine — no burst in tests that don't simulate one).
- **ADR-0075 §12.5d-1 superseded:** The fixed `INTERP_DELAY_STEPS = 1.0` constant stays in `config.ts` as the documentary BASE (not the operative value); the comment is updated. The variable `INTERP_DELAY_STEPS` is no longer used directly by `renderResolver` or `interpDelayMs` for the remote path. The `interpDelayMs` export is kept for the test-suite backward-compatibility check.

## Considered alternatives

**D-13.5-1 (Drew's decision, 2026-07-04):** Drew explicitly rejected: (a) deepening to 3 snapshots with the same fixed delay (insufficient — burst snapshots still share receivedAt); (b) keeping the fixed 1.0× scheme (burst pop is a verified user-visible defect). The adaptive scheme was mandated.

**Max delay cap at 3×STEP_MS:** Rejected — 600 ms remote lag is player-visible as "rubber remote". 2.5× (500 ms at 200 ms stepMs) is the boundary where the lag is noticeable but the network is already unusable; higher delays serve no player.

**Global jitter estimate (not per-character):** Rejected — NPCs and remote players have different arrival patterns. A global estimate would either over-buffer all entities on a busy server NPC tick, or under-buffer a specific player's bursty connection.

**EWMA α = 0.25 (4-sample half-life):** Higher α reacts faster to jitter but also over-fits to a single late packet. 0.125 provides a more stable estimate, important because the delay change affects the visual impression of ALL remote entities using the estimator.

**Re-stamping BOTH burst arrivals** (i.e., giving the first burst tick a synthetic `receivedAt = now - STEP_MS` retroactively): Rejected — the first tick was already committed to the ring buffer with `now` as its receivedAt; retroactive modification violates the immutable-record contract and creates a store where the same snapshot has two different timestamps in different parts of the code.

## Amendment (ptc5f, 2026-07-24 — Decision A, ADR-0142)

The M-playtest-c.5 eleventh review (Decision A, Drew-delegated 2026-07-20)
sharpened the §B-2 "known limitation" above from *"almost always false at
production STEP_MS"* into an **exact reachability bound**, and pinned it as a
gated fact (no behavior change).

**Bound.** The synthetic assignment `receivedAt = synthetic` fires only when,
letting `d = now − existing.latest.receivedAt` (the outer burst guard forces
`d < BURST_EPSILON_MS`):

```
synthetic ≤ now + BURST_EPSILON_MS
⟺ existing.latest.receivedAt + stepMs ≤ now + BURST_EPSILON_MS
⟺ stepMs ≤ BURST_EPSILON_MS + d < 2·BURST_EPSILON_MS
```

So the branch is reachable **iff `stepMs < 2·BURST_EPSILON_MS`** (= 40 ms at
`BURST_EPSILON_MS = 20`). At the production `STEP_MS = 200` it is **unreachable**
— not merely "almost always false". Burst smoothness is carried entirely by the
depth-4 ring buffer + the `interpolateHistory` `span ≤ 0` graceful path. A
negative `d` (a chained future synthetic) only shrinks the RHS, so it cannot
widen reachability. The bound is tight: at `stepMs = 39` a `d = 19` fires the
branch; at `stepMs = 40` no admissible `d` can.

**Pins (ptc5f).** A code comment at the branch site (`store.ts`) records the
`stepMs < 2·BURST_EPSILON_MS` bound; a proof-of-teeth test
(`store.test.ts`) asserts the branch is unreachable across the whole burst-gap
domain at the production `STEP_MS`, and BITES just below the bound — so a future
`STEP_MS` drop under 40 ms fails loud. The smoothing behavior is deliberately
**unchanged**: retuning the netcode path immediately before the fun-hypothesis
playtest is speculative (anti-YAGNI on a determinism-sensitive path); the actual
defect was doc drift, fixed here at zero behavior risk. Option (a) — retune so
burst-spread runs in production — is kept as a named YAGNI exception, revisited
only if playtest smoothness testing surfaces burst pops.
