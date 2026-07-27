# 0159 — feel-polish: care-button success feedback + collision-aware NPC wander

**Status:** Accepted
**Date:** 2026-07-27
**Slice:** feel-polish (M-postgate-feel-polish — r2 playtest ledger items 087-090)
**Supersedes:** —
**Amends:** 0068
**Subsystems:** client-ui, movement-netcode
**Decision:** Care gets an in-overlay feedback line via the established showFeedback idiom (no toast subsystem); npc_decide becomes collision- and radius-aware and continues its facing while legal, eliminating wall-bumps and halving reversals.

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
`wander_radius`. When the NPC's current `facing` is still legal it **usually** continues that way;
once in every `NPC_CONTINUE_REROLL = 6` decisions it voluntarily re-rolls anyway, and whenever
`facing` is illegal it always re-picks. Concretely:

```
if facing ∈ L  &&  (h >> 33) % NPC_CONTINUE_REROLL != 0  ->  Some(facing)                  // continue
else                                                     ->  Some(L[(h >> 1) % L.len()])   // re-pick
```

The `(h >> 33)` slice is deliberately independent of the stay roll (`h % 5`) and of the pick
(`h >> 1`), so the three decisions do not correlate. The outside-radius `toward_home` branch, the
`wander_radius == 0` pin, the 1-in-5 stay rate, `NPC_DECIDE_SALT` and the splitmix64 avalanche are
all **unchanged** — `npc_hash(npc_id, tick)` is still called with the raw tick, so RT-NPC-01's
non-commutativity property and the salt/constant pin survive intact.

**The voluntary re-roll is not optional polish — without it the rule is an absorbing state.** The
first implementation continued `facing` whenever it was legal, with no re-roll. Review caught, and
an independent simulation confirmed, that this collapses the wander: at the shipped config the legal
region is **8** tiles, but the NPC reaches only **5** of them — the entire `y = 5` row — and never
visits `(4,4)`, `(5,4)`, `(6,4)`. Once `facing` is East or West it can never become anything else
(at every interior tile E/W is legal so continue always fires; the end tiles force the exact
reverse; a stay tick does not clear `facing` because `movement.rs` `continue`s without calling
`apply_move`). Per-`npc_id` coverage over 20 000 ticks was `[5,5,5,7,5,5,5,5]` — structural, not a
seed fluke. The NPC became a metronome. Any `K >= 2` restores full 8/8 coverage for every `npc_id`.

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

**Measured outcome (60 000 ticks, real `npc_hash`, real zone-0 grid, `elder_oak` home (5,5) r=2).**
"Reversal %" is the *immediate* reversal rate: consecutive MOVE ticks in opposite directions with no
intervening stay. "Tiles" is how many of the 8 legal tiles the NPC actually reaches.

| design | tiles | move % | wall-bump % | reversal % | mean run | worst standstill |
|---|---|---|---|---|---|---|
| status quo | 13\* | 68.1 | 14.3 | 32.3 | 1.14 | 12 ticks |
| **D2 shipped (K = 6)** | **8/8** | **79.7** | **0.0** | **24.1** | **1.84** | **8 ticks** |
| no re-roll (rejected — absorbing) | 5/8 | 79.7 | 0.0 | 20.0 | 2.48 | 8 ticks |
| tick-quantized N=3 (rejected) | — | 59.2 | 22.0 | 40.2 | 1.44 | 27 ticks |

\* status quo also stepped *outside* the radius and was yanked home, so it touched 13 tiles; those
excursions are the source of much of its reversal rate. D2 confines the NPC to its declared radius.

**`K` sweep** (all values `>= 2` give full 8/8 coverage for every `npc_id`; `K = 0` is the absorbing
bug): K=4 → 25.9 % reversals / 1.68 run · **K=6 → 24.1 % / 1.84** · K=8 → 23.2 % / 1.96 ·
K=16 → 21.8 % / 2.16. Larger `K` buys longer runs but trends back toward the degenerate pendulum, so
`K = 6` is chosen as the balance point: a clear "1-in-6 voluntary re-roll", a 8.2 pp reversal
improvement over the status quo, and 4 pp of margin under the gating threshold. A constant-free
alternative (weighting `facing` by appending it to the candidate list) was measured and **rejected**
— at 32.7 % reversals it is no better than the status quo. `K` is a feel constant fitted against
`wander_radius: 2`; at `wander_radius: 5` the same `K = 6` gives 14.1 % reversals over 29/29 tiles,
so it generalises rather than being over-fitted to the one shipped NPC.

**Netcode effect — stated precisely, because the intuitive version is wrong.** A *bump* wrote a
character row (`apply_move` stamps `move_started_at` on every call, `world.rs:369`); only a `None`
decision skips the write (`movement.rs` `continue`s). So eliminating bumps does **not** shorten the
gaps between row updates — it slightly lengthens them: no-write ticks go 17.6 % → 20.3 %, mean row
inter-arrival 242.6 ms → 251.1 ms, and the modelled adaptive interp delay rises ~285 ms → ~302 ms
(1.43 → 1.51 steps). The **worst unbroken no-write run is unchanged at 8 ticks** in both, as it must
be — the 1-in-5 stay roll is untouched and is the sole producer of no-write ticks. That +17 ms sits
far inside the 2.5-step / 500 ms clamp (`config.ts:41,47`); clamp saturation moves 0.26 % → 0.50 %
of arrivals. **No new stutter or rubberbanding risk**, but the earlier draft of this ADR claimed the
gaps got *shorter* and the delay did not inflate — that was wrong and is corrected here.

The real smoothness win is a **snapshot-content** effect, not a gap-timing one: previously **14.3 %
of NPC row updates carried zero displacement** (a bump rewrites facing/action/`move_started_at` with
the tile unchanged), so the interpolator was handed two snapshots at the same tile and rendered a
hard 200 ms stop mid-motion. That is now **0 %** — every row update is a real one-tile step.

## Alternatives considered

(A) Tick quantization `tick / N` — simulated and refuted above; worse on every metric, 5.4 s freezes.
(B) Collision-awareness *without* continue-facing — kills all bumps and cuts standstill to 20.3 %,
but reversals stay at 35.4 % and mean run at 1.13, so the "start/stop" half of the complaint is
untouched; the `facing` input is free (already on the row), so there was no reason to stop short.
(B2) Continue-facing with **no** voluntary re-roll — the first implementation. Rejected: absorbing
state, 5/8 tiles, the NPC degenerates into an E↔W metronome (evidence in the Decision section). Its
*better-looking* reversal number (20.0 % vs 24.1 %) is an artifact of the pendulum, not real
smoothness — which is exactly why the wander-coverage gating test now exists.
(B3) Constant-free persistence by weighting `facing` in the candidate list — measured 32.7 %
reversals, indistinguishable from the status quo. Too weak; rejected in favour of the explicit `K`.
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
7. The client jitter estimator (`store.ts:435-440`) counts "entity idle → no row update" as network
   jitter. D2 makes this marginally *worse*, not better (no-write ticks 17.6 % → 20.3 %, modelled
   delay +17 ms — see the netcode paragraph); it stays far inside the clamp, but the conflation is
   real and unaddressed. Named follow-up: exclude idle intervals from the jitter EWMA.
9. `K` is a feel constant coupled to `wander_radius`. It is measured at the shipped radius 2 and
   sanity-checked at radius 5; if content ever ships a much larger radius or a much more open map,
   re-run the sweep rather than assuming 6 still balances run-length against coverage.
10. NPC availability for dialogue changes. With the player at the spec's walk endpoint `(5,4)`,
   `elder_oak` is within `TALK_RANGE = 2` on 80.1 % of ticks, down from 87.3 % (the rejected
   absorbing variant was 75.1 %) — because the NPC now genuinely stays inside its radius instead of
   wandering out and being escorted back through the player's tile. `client/e2e/dialogue.spec.ts`
   uses bounded retry loops rather than fixed tick counts so it should still converge, but its
   in-file comment describing the old cadence is now imprecise and the retry budget is worth
   watching for flake.
8. Ledger items **088 (walk speed)** and **090 (walk animation)** are NOT delivered here — see the
   PR body and the slice handoff for the parked scope and its evidence.

## Proof of teeth

D1: `raisingView.test.ts` asserts `showFeedback` writes `textContent` into a node that is a
**descendant of the overlay root** (containment, not just text — the containment assertion is what
kills the actual shipped bug of writing to a node the z-index-100 overlay covers) and that markup in
a server-supplied error string stays escaped (no element children). `main.wiring.test.ts` scans that
`sendGuarded('care'` no longer appears and that the care call site reaches `showFeedback`.

D2: the gating suite pins (0) **wander-region coverage** — driving `npc_decide` + the real
`apply_move` from the real start state for tens of thousands of ticks must visit *every* walkable
tile within the radius, for several `npc_ids`. This is the tooth that catches the absorbing-state
class (the rejected no-re-roll variant reaches 5 of 8 and fails it); the expected tile set is
computed from the map and radius inside the test rather than hardcoded, so it stays honest if
content changes. Also (i) **no legal-direction result is ever a wall or outside the radius**,
for every reachable position on the real zone-0 grid — this is the tooth that bites the status quo
and any regression to unrestricted 4-way choice; (ii) **continue-facing**: when the current facing
stays legal the same direction is returned on the next tick; (iii) the outside-radius homing branch
still answers every tick (an NPC outside its radius can never stall); (iv) a re-derived known-answer
vector pinning the salt/splitmix constants; (v) a behavioural bound on the measured reversal rate
and bump count over a long simulated run, thresholds set strictly between the status-quo and
post-change measurements so the pre-change implementation fails.
