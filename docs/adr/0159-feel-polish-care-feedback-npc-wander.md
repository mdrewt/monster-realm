# 0159 — feel-polish: care-button success feedback + collision-aware NPC wander

**Status:** Accepted
**Date:** 2026-07-27
**Slice:** feel-polish (M-postgate-feel-polish — r2 playtest ledger items 087-090)
**Supersedes:** —
**Amends:** 0068
**Subsystems:** client-ui, movement-netcode
**Decision:** Care gets an in-overlay success/error feedback line via the established showFeedback idiom (no toast subsystem); npc_decide becomes collision- and radius-aware and continues its current facing while that stays legal, eliminating wall-bumps and halving direction reversals.

## Context

Four LIGHT feel items were bundled by the spec (ledger 087-090). Step-1 scope verification
established the terrain for all four; two ship here and two are parked with evidence.

**Item 087 — "Care button has no visible effect."** Confirmed NOT a server bug. `care`
(`server-module/src/raising.rs:69-108`) succeeds and dual-writes bond/`last_care_at_ms`/`evolves_to`
to both `monster` and `monster_pub`; it is reject-never-burns (no write precedes the success
block). Two client-side causes: (a) `onCare` (`main.ts:1827-1829`) routed through `sendGuarded`,
which attaches **only** a `.catch` — there is no success branch anywhere, so a successful care is
acknowledged by nothing except a single digit changing inside a compound string
(`raisingView.ts:107` `Lv{n} · Bond {n} · HP …`); and (b) `CARE_COOLDOWN_MS` is **6 hours**
(`game-core/src/raising/rules.rs:106`), so the first click succeeds and every repeat click for the
next 6 h is a legitimate rejection — meaning *most* clicks a playtester makes are rejections. Those
rejections did reach `statusEl` (`main.ts:228-233`), but `statusEl` is an unstyled `<div>` in normal
document flow while the raising overlay is `position:fixed; inset:0; z-index:100`
(`raisingView.ts:28-31`) — the overlay paints over the very message it raised. Both the success
silence and the covered rejection had to be fixed or click #2 looks identical to click #1.

**Item 089 — "NPC movement is jerky (abrupt stop/start bursts)."** The hypothesis that NPCs lack
client interpolation was **refuted**: NPCs are ordinary `character` rows and take the identical
ADR-0090 adaptive-EWMA interpolation path as remote players (`renderResolver.ts:101-121`). The real
cause is the decision rule. `npc_decide` (`npc/rules.rs:81-113`) draws a fresh, memoryless
`npc_hash(npc_id, tick)` every 200 ms tick (`movement.rs:287-289`) — 1-in-5 stay, else a **uniform
choice over all four compass directions with no regard for walls or the wander radius**. The only
shipped NPC (`elder_oak`, home (5,5), `wander_radius: 2`, `content/npcs/000-core.ron`) sits in a
walled pocket: (5,6) directly south is `#` and (5,3) is `#` (`content/zone_maps/000-core.ron`). So a
large fraction of draws are steps into a wall, which `apply_move` correctly turns into a no-op bump
(`world.rs:374-380`) — the NPC visibly stands still for that tick and then darts off in a new
random direction. Measured on the real shipped grid over 60 000 ticks: **14.3 % of all ticks were
wall-bumps, 31.9 % were standstills, 32.3 % of moves immediately reversed the previous move, and the
mean run in one direction was 1.14 tiles.** That is precisely "too-fast stop/start bursts".

## Decision

**D1 — care feedback (client-only).** `RaisingView` gains a `#raising-feedback` node built with
`document.createElement` in the constructor (matching `RaisingView`'s fully self-constructed DOM —
it has no markup in `index.html`) and a `showFeedback(message: string)` writing `textContent` only.
This is the idiom already shipped on five sibling overlays (`shopView`, `tradeView`,
`tradeProposeView`, `renameView`, `pvpView`). `onCare` is rewritten to the `onBuy`/`onSell` shape
(`main.ts:1849-1865`): frozen-link gate → `await conn.conn.reducers.care({ monsterId })` →
`showFeedback('Cared!')`; `catch` → `showFeedback(reduceErrorMessage(err, 'care'))`. The Care button
takes the `#pending`/`disabled` re-entrancy guard that `shopView`/`renameView` already use, so a
double-click cannot render "Cared!" immediately followed by "care cooldown not yet elapsed". The
await genuinely reflects the server outcome — verified in the SDK
(`node_modules/spacetimedb/src/sdk/db_connection_impl.ts:1092-1180`: the promise settles on the
keyed `TransactionUpdate`, not on socket send), so the confirmation can never lie.

**Explicitly NOT built: a toast/notification subsystem, and no per-monster bond-delta flash engine.**
An earlier plan proposed a `CareFeedbackState` diffing core (two maps, seed-on-first-sight,
injected-clock expiry, a new VM field, a new model param, a module-scope latch in `main.ts`). The
EARS criterion is an explicit OR — "toast, animation, **or** stat-delta feedback" — and the feedback
line discharges it entirely while also fixing the covered-rejection half. The flash engine was cut
as YAGNI; it would also have been the only Map-keyed diffing state in an otherwise scalar-latch
shell, and ADR-0085 D1 already recorded "no toast system" as deliberate.

**D2 — collision- and radius-aware NPC wander (game-core).** `npc_decide` gains two inputs the
caller already holds — `facing: Direction` (persisted on every character row; `apply_move` stamps it
on every step, `world.rs:373`) and `map: &TileMap` (already passed to `apply_move` one line later at
`movement.rs:322`) — and picks only among **legal** directions: walkable *and* still within
`wander_radius`. When the NPC's current `facing` is still legal it continues that way; otherwise it
re-picks from the legal set using the existing hash. The outside-radius `toward_home` branch, the
`wander_radius == 0` pin, the 1-in-5 stay rate, `NPC_DECIDE_SALT` and the splitmix64 avalanche are
all **unchanged** — `npc_hash(npc_id, tick)` is still called with the raw tick, so RT-NPC-01's
non-commutativity property and the salt/constant pin survive intact.

This amends ADR-0068, whose module header stated "Wall-collision is NOT handled here; `apply_move`
handles bumps." `apply_move` remains the sole authority and still no-ops a blocked step
(defence-in-depth is preserved); `npc_decide` simply stops *choosing* moves it knows are illegal.

**Why not tick quantization (the obvious one-liner).** The first design was
`npc_hash(npc_id, tick / NPC_DECIDE_PERIOD)` — hold one decision for N ticks. It was **empirically
refuted** before implementation by simulating the real hash against the real shipped grid. Holding a
direction in a walled pocket means holding it *into the wall*: at N=3 every metric got worse than
the status quo — reversals 32.3 %→40.2 %, bumps 14.3 %→22.0 %, standstill 31.9 %→40.8 %, and the
worst-case unbroken standstill went from 12 ticks (2.4 s) to 27 ticks (**5.4 s frozen**), while mean
run length barely moved (1.14→1.44). A slow-cadence variant (move only every Nth tick) left the NPC
standing still 61-74 % of the time. Legality-awareness is what actually mattered; direction
persistence is only safe *on top of* it.

**Measured outcome (60 000 ticks, real `npc_hash`, real zone-0 grid, `elder_oak` home (5,5) r=2):**

| design | move % | standstill % | wall-bump % | reversal % | mean run | worst standstill |
|---|---|---|---|---|---|---|
| status quo | 68.1 | 31.9 | 14.3 | 32.3 | 1.14 | 12 ticks |
| **D2 (shipped)** | **79.7** | **20.3** | **0.0** | **19.9** | **2.48** | **8 ticks** |
| tick-quantized N=3 (rejected) | 59.2 | 40.8 | 22.0 | 40.2 | 1.44 | 27 ticks |

Every axis improves, including the one that feeds client interpolation: the worst unbroken run of
ticks with **no** character-row write drops 12→8 (2.4 s→1.6 s), so the per-entity jitter EWMA
(`store.ts:435-440`) sees *shorter* idle gaps than before and adaptive interp delay does not inflate.
D2 also introduces **no tuning constant** — there is no N to justify, sweep, or re-derive when
content ships a different `wander_radius`. Re-run at `wander_radius: 5` it still improves
(reversals 11.0 %, bumps 0 %), so it generalises to future content rather than being fitted to the
one shipped NPC.

## Alternatives considered

(A) Tick quantization `tick / N` — simulated and refuted above; worse on every metric, 5.4 s freezes.
(B) Collision-awareness *without* continue-facing — kills all bumps and cuts standstill to 20.3 %,
but reversals stay at 35.4 % and mean run at 1.13, so the "start/stop" half of the complaint is
untouched; the `facing` input is free (already on the row), so there was no reason to stop short.
(C) Slow decide cadence (move only every Nth tick) — 61-74 % standstill; trades jerkiness for
lethargy and reads as periodic stutter under interpolation.
(D) Store a persisted `wander_dir` column on the NPC table — a schema change (fan-out-ineligible)
for information `character.facing` already carries.
(E) Fix it in the client renderer (smooth over the stop/start) — the entity genuinely is not moving;
smoothing a real standstill is a lie that would fight ADR-0013/0090 interpolation.
(F) Move `elder_oak`'s home off the wall — content-shaped, does not generalise to NPCs authors add
later, and leaves the rule buggy.
(G) For D1, a bond-delta flash engine / toast subsystem — cut as YAGNI (see D1).

## Consequences / residuals

1. `npc_decide`'s signature changes (two added params). It is exported from `game-core` and has
   exactly one production caller (`server-module/src/movement.rs:312-318`); the ~15 test call sites
   in `npc/m12a_gating_tests.rs` and `server-module/src/npc_tests.rs` are updated positionally, and
   the two known-answer vectors are **re-derived** rather than weakened.
2. `npc_decide` now depends on `TileMap`, so an NPC's wander is coupled to zone geometry. This is
   correct (the geometry is what makes a move legal) but means a future map edit can change an NPC's
   observed path — the gating tests therefore assert *properties* (no bump, bounded reversal rate)
   against the real grid, not a hardcoded route.
3. Care rejections no longer flow through `sendGuarded` → `reportError` → the F9 error ring, so a
   care failure will not appear in a bug bundle. This matches the pre-existing behaviour of
   `onBuy`/`onSell`/rename (which also bypass it) but is now asymmetric with `onTrain`, still on
   `sendGuarded`, inside the *same* overlay. Deliberate, recorded here; unifying the five overlay
   feedback paths with the error ring is a named follow-up.
4. No care-cooldown countdown is shown, so a rejected click still only explains itself in words.
   Showing "ready in 4 h 12 m" needs `last_care_at_ms` (or a derived `care_ready_at_ms`) exposed on
   the **public** `monster_pub` projection — an additive column plus
   `evals/baselines/table-schemas.json` and the `no-idle-accrual` allowlist. Parked.
5. `NPC_DECIDE_SALT`, the splitmix64 constants, the 1-in-5 stay rate and the `toward_home` tiebreak
   are untouched, so `.cargo/mutants.toml`'s `npc/rules.rs:61:15` line-pin (asserted as a literal
   ~8× in `evals/mutate-core-recipe-integrity.eval.mjs`) stays valid — `toward_home` must not move,
   which constrains where new items may be declared in the file.
6. All wandering NPCs still decide on the same global `tick_counter` (`movement.rs:289`), so they
   re-decide in lockstep. Invisible with one NPC; if a zone ever hosts ≥3, add a per-NPC phase
   offset. Named follow-up.
7. The client jitter estimator (`store.ts:435-440`) still counts "entity idle → no row update" as
   network jitter. D2 reduces the worst idle gap so the symptom shrinks, but the conflation remains.
   Named follow-up.
8. Ledger items **088 (walk speed)** and **090 (walk animation)** are NOT delivered here — see the
   PR body and the slice handoff for the parked scope and its evidence.

## Proof of teeth

D1: `raisingView.test.ts` asserts `showFeedback` writes `textContent` into a node that is a
**descendant of the overlay root** (containment, not just text — the containment assertion is what
kills the actual shipped bug of writing to a node the z-index-100 overlay covers) and that markup in
a server-supplied error string stays escaped (no element children). `main.wiring.test.ts` scans that
`sendGuarded('care'` no longer appears and that the care call site reaches `showFeedback`.

D2: the gating suite pins (i) **no legal-direction result is ever a wall or outside the radius**,
for every reachable position on the real zone-0 grid — this is the tooth that bites the status quo
and any regression to unrestricted 4-way choice; (ii) **continue-facing**: when the current facing
stays legal the same direction is returned on the next tick; (iii) the outside-radius homing branch
still answers every tick (an NPC outside its radius can never stall); (iv) a re-derived known-answer
vector pinning the salt/splitmix constants; (v) a behavioural bound on the measured reversal rate
and bump count over a long simulated run, thresholds set strictly between the status-quo and
post-change measurements so the pre-change implementation fails.
